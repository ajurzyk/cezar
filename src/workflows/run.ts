import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentSession } from '../core/claude-cli-runner.js';
import { onUsage, registerRunProcess, unregisterRunProcess, type ProcessUsage } from '../core/process-usage.js';
import { createRunner } from '../core/runner-factory.js';
import type { RunnerId } from '../core/agent-runner.js';
import {
  HANDOFF_ONLY_INSTRUCTIONS,
  HANDOFF_INSTRUCTIONS,
  appendHandoffHeartbeat,
  handoffPath,
  seedHandoffFile,
} from '../handoff.js';
import { todosPath } from '../todos.js';
import type { AgentEvent, ContentBlock } from '../core/agent-runner.js';
import { discoverSkills, type Skill } from '../skills.js';
import { materializeSkillDir } from '../skills-remote.js';
import { loadConfig } from '../config.js';
import { autosaveCommit, createWorktree, resolveBaseRef, worktreeDiff, worktreeShortstat } from '../git-worktree.js';
import { getRepoInfo } from '../server/git.js';
import { loadWorkflows } from './load.js';
import type { RunRecord, RunStore } from '../runs/store.js';
import { extractTaskRefs, refineTaskRefs, titleRefNumber } from '../runs/task-refs.js';
import { autoNamingActive, generateRunName, liveTitleUpdatesEnabled } from '../runs/auto-name.js';
import { UiEventSink } from '../runs/ui-event-sink.js';
import { chainStepNote, DEFAULT_ALLOWED_TOOLS, stepKind, type WorkflowDef, type WorkflowStepDef } from './types.js';

const CHECK_OUTPUT_CAP = 20_000;
/** An interactive session that hears nothing from the user closes itself. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;
/**
 * Task-completion marker from the agent contract (HANDOFF_INSTRUCTIONS): a
 * turn whose text ends with `CEZ:DONE` means "goal achieved, nothing to ask" —
 * the session is closed right away instead of parking at `waiting` (#347).
 * Detection runs on the accumulated turn text so delta-streaming backends
 * (codex, opencode) can't split the marker across text events.
 */
const DONE_MARKER_RE = /CEZ:DONE\s*$/;
/** Strip a trailing marker from one text event so transcripts stay free of
 *  protocol noise. Delta backends may split the marker across events — then
 *  it stays visible; detection above is unaffected. */
function stripDoneMarker(text: string): string {
  return text.replace(/\s*CEZ:DONE\s*$/, '');
}
/** Periodic "cezar autosave" commit in the task worktree (spec 006). */
export const AUTOSAVE_INTERVAL_MS = 90_000;

/** The periodic autosave timer is opt-in (#471): off, a task branch carries only the
 *  agent's own commits plus the turn-end/pre-PR flushes — no mid-run "cezar autosave"
 *  noise interleaving PR history. The flushes (`autosaveCommit` at turn end and before
 *  a draft PR) are NOT gated: the branch must still end holding the finished state. */
export function periodicAutosaveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTOSAVE === '1';
}

interface ActiveRun {
  cancelled: boolean;
  interrupt: () => void;
  /** Where this run's steps execute: the task worktree, or the repo root. */
  cwd: string;
  /** Live claude session of the currently running agent step, if any. */
  session?: AgentSession;
  currentStepId?: string;
  idleTimer?: NodeJS.Timeout;
  autosaveTimer?: NodeJS.Timeout;
  /** Running counter for persisted agent screenshots (`screenshot-<n>.png`). */
  imageSeq?: number;
  /** Autonomous mode (#autonomous): never park at `waiting` — auto-nudge the agent to keep
   *  going until it signals done or the safety cap is hit. */
  autonomous?: boolean;
  autoContinues?: number;
  /** Release for exclusive execution in the user's repository working tree.
   *  Worktree-backed runs never need it; every degradation/opt-out path does. */
  releaseRepoRoot?: () => void;
}

/** Safety cap on autonomous auto-continues per run — stops a stuck agent from nudging forever. */
const MAX_AUTO_CONTINUES = 40;
const AUTONOMOUS_NUDGE =
  'Continue working autonomously until the task is fully complete. Do not ask me for confirmation or clarification — make reasonable assumptions and proceed. When everything is done, end the session with your done signal.';

export interface StartRunInput {
  task: string;
  model?: string;
  /** Agent backend chosen for this task (GUI). Unset = the config default. */
  runner?: RunnerId;
  /** Screenshots pasted into the new-task form — delivered once, with the
   *  first agent step's opening message. */
  images?: ContentBlock[];
  /** Per-run system-prompt override (`POST /api/runs`, programmatic callers).
   *  Replaces the `config.json` default for this run — see
   *  `resolveExtraSystemPrompt` for the precedence contract. */
  systemPrompt?: string;
  /** Composer opt-out (#worktree-toggle): `false` runs the task in the repo
   *  working tree instead of an isolated worktree — for read-only skills that
   *  don't need a branch. Undefined/`true` keeps the default per-task worktree.
   *  Ignored for variants (they always isolate). */
  worktree?: boolean;
  /** Autonomous mode (#autonomous): the run never parks at `waiting` for the
   *  user — turn-ends auto-continue until the agent signals done or the safety
   *  cap is hit. No "needs you" is ever raised. */
  autonomous?: boolean;
  /** Follow-up inbox generation (spec 007, #444). Omitted means enabled for
   *  compatibility; the handoff journal runs either way. */
  generateFollowups?: boolean;
}

/**
 * The effective "extra" system prompt for a run (spec §protocol v2, R2 2.3):
 * the per-run override (`POST /api/runs` `systemPrompt`) REPLACES the
 * `config.json` default — they are the same knob at two scopes, so the more
 * specific one wins outright; they never concatenate. Whichever wins is
 * ADDITIVE to the skill body and the handoff contract, which always ride
 * along (see `composeSystemPrompt`). Blank strings count as unset.
 */
export function resolveExtraSystemPrompt(
  override: string | undefined,
  configDefault: string | undefined,
): string | undefined {
  return override?.trim() || configDefault?.trim() || undefined;
}

/**
 * Joins the parts of one agent step's system prompt in fixed order — skill
 * body (most task-specific), then the run's extra prompt (user guidance, can
 * amend the skill), then the handoff contract (always last, never optional in
 * practice). Blank parts drop out; survivors join with the same `\n\n---\n\n`
 * divider the skill+handoff composition has always used.
 */
export function composeSystemPrompt(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join('\n\n---\n\n');
}

/** Variant letters + the fixed diversification hints (spec 010). A runs the
 *  task verbatim; B/C get one constant sentence each — zero configuration. */
export const VARIANT_LETTERS = ['A', 'B', 'C'] as const;
const VARIANT_HINTS: Record<string, string | undefined> = {
  A: undefined,
  B: 'Approach hint: prefer the minimal, surgical change.',
  C: 'Approach hint: prefer a thorough, structural approach.',
};

/**
 * The mini workflow engine: executes a `WorkflowDef` against a repo, one step
 * at a time, persisting every event to the RunStore (which the SSE endpoints
 * relay live to the GUI). No GitHub choreography — agent steps and shell
 * checks with bounded retry loops, plus live sessions: the last agent step
 * stays open for follow-ups (`waiting`) until "finish", idle timeout, or
 * cancel. Runs queue behind `maxParallel` slots and each run executes in its
 * own git worktree on a `cez/<id8>` branch (spec 006), autosave-committed at
 * turn end and before a draft PR — plus every 90 s when opted in via
 * CEZ_AUTOSAVE=1 (#471). The user's working tree is never touched.
 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  // Queue + `starting` set (spec 006, janitor's pump() pattern): `starting`
  // covers the window between shifting a run off the queue and the run
  // registering in `active`, so parallel-slot counting is never racy.
  private readonly queue: string[] = [];
  private readonly starting = new Set<string>();
  // Runs parked at `waiting` (open session, ball in the user's court). They
  // don't consume a `maxParallel` slot (#347) — an idle claude process costs
  // memory but no tokens, queued work progressing matters more, and the idle
  // timeout already bounds how long a session can sit open. Invariant:
  // `waiting ⊆ active` — always cleared together via dropActive().
  private readonly waiting = new Set<string>();
  private readonly pendingJobs = new Map<string, { workflow: WorkflowDef; input: StartRunInput }>();
  private pumping = false;
  /**
   * Runs normally isolate in worktrees and may execute in parallel. When that
   * isolation is unavailable (or explicitly disabled), serialize access to
   * `repoRoot` so two agents can never edit/revert the same files (#438).
   */
  private repoRootTail: Promise<void> = Promise.resolve();

  /** `.ai/cezar` — where the per-task handoff files and todos.json live. */
  private readonly dataDir: string;

  /** Runs currently being paused by the memory guard — dedupes the ~2 s samples so one breach
   *  triggers one pause, not a burst. Cleared in dropActive when the run leaves the registry. */
  private readonly memoryPausing = new Set<string>();

  constructor(
    private readonly store: RunStore,
    private readonly repoRoot: string,
  ) {
    this.dataDir = join(repoRoot, '.ai/cezar');
    // Memory guard (#memory-guard): the shared process-tree sampler already ticks ~every 2 s for
    // the runs table; piggyback on it to enforce the per-task memory ceiling.
    onUsage((snapshot) => void this.enforceMemoryLimit(snapshot));
  }

  /**
   * Pause any active run whose whole process tree exceeds `config.memoryLimitMb`, freeing its
   * slot so the queue advances (#memory-guard). "Pause" closes the session — freeing the tree's
   * memory — and leaves the run resumable via Continue; a loud warning explains why. No-op when
   * no limit is set or the sampler has no data (e.g. `ps`/PowerShell unavailable).
   */
  private async enforceMemoryLimit(snapshot: Record<string, ProcessUsage>): Promise<void> {
    const runIds = Object.keys(snapshot);
    if (runIds.length === 0) return;
    const limitMb = (await loadConfig(this.repoRoot)).memoryLimitMb;
    if (!limitMb || limitMb <= 0) return;
    const limitBytes = limitMb * 1024 * 1024;
    for (const runId of runIds) {
      const usage = snapshot[runId];
      if (!usage || usage.rssBytes <= limitBytes) continue;
      if (this.memoryPausing.has(runId)) continue;
      const state = this.active.get(runId);
      if (!state?.session?.open || state.cancelled) continue;
      this.memoryPausing.add(runId);
      const usedMb = Math.round(usage.rssBytes / (1024 * 1024));
      this.store.appendEvent(runId, {
        type: 'note',
        message: `⚠ memory limit exceeded — this task's process tree is using ${usedMb} MiB (limit ${limitMb} MiB). Pausing it and letting the next queued task run; resume it with Continue.`,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: `paused — memory limit exceeded (${usedMb} MiB > ${limitMb} MiB)`,
      });
      // Closing the session frees the tree and lets the normal exit path settle the run and
      // pump the queue. Suppress autonomous auto-continue so the pause actually holds.
      state.autonomous = false;
      this.clearIdleTimer(state);
      state.session.end();
    }
  }

  /** Env the spawned claude gets so the agent can find its handoff file and
   *  the global inbox (spec 007; the inbox only when the run opted in).
   *
   *  `CEZ_TODOS_FILE` is set to `''` rather than omitted when follow-ups are
   *  off: runners spawn with `{ ...process.env, ...spec.env }`, so omitting the
   *  key would let a value inherited from *this* process through — a nested
   *  cezar (an agent running `cez serve`/`cez run`/the test suite) would then
   *  write follow-ups into the parent's inbox despite the opt-out. Empty is the
   *  established "absent" spelling — consumers guard with `if (todosFile)`. */
  private agentEnv(runId: string, generateFollowups = true): Record<string, string> {
    return {
      CEZ_HANDOFF_FILE: handoffPath(this.dataDir, runId),
      CEZ_TASK_ID: runId,
      CEZ_TODOS_FILE: generateFollowups ? todosPath(this.dataDir) : '',
    };
  }

  startRun(
    workflow: WorkflowDef,
    input: StartRunInput,
    group?: { groupId: string; variant: string },
  ): RunRecord {
    const run = this.store.createRun({
      title: makeRunTitle(input.task, workflow) + (group ? ` (${group.variant})` : ''),
      workflow: workflow.name,
      task: input.task,
      model: input.model,
      runner: input.runner,
      generateFollowups: input.generateFollowups,
      groupId: group?.groupId,
      variant: group?.variant,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: stepKind(s) })),
    });
    // Persist the full definition so a queued run survives a restart (#367) —
    // ad-hoc "(planned)" chains exist nowhere else to re-resolve from.
    this.store.updateRun(run.id, { workflowDef: workflow as unknown as Record<string, unknown> });
    // Step-0 reference extraction (task auto-naming spec): the regex layer's
    // numbers persist immediately; the namer may add the kind it verified later.
    const skillHint = workflow.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(input.task), skillHint);
    if (refs.prNumber !== undefined || refs.issueNumber !== undefined) {
      this.store.updateRun(run.id, {
        ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
        ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
      });
    }
    // Fire-and-forget LLM naming (task auto-naming spec): the heuristic title
    // above shows instantly; the namer's short title replaces it when (and if)
    // the model answers. Never awaited, never fails the run.
    void this.autoNameRun(run.id, skillHint, input.task);
    this.pendingJobs.set(run.id, { workflow, input });
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * Parallel variants (spec 010): N runs of the same workflow on the same
   * task, sharing a groupId. Variant A gets the task verbatim; B and C get a
   * fixed one-line approach hint appended to the *task input* (not the step
   * template), so diversification works with any workflow. The normal queue
   * applies — with maxParallel=2 a third variant simply waits.
   */
  startVariants(workflow: WorkflowDef, input: StartRunInput, count: number): RunRecord[] {
    const groupId = randomUUID();
    return VARIANT_LETTERS.slice(0, Math.min(Math.max(count, 1), VARIANT_LETTERS.length)).map(
      (variant) => {
        const hint = VARIANT_HINTS[variant];
        const task = hint ? `${input.task}\n\n${hint}` : input.task;
        return this.startRun(workflow, { ...input, task }, { groupId, variant });
      },
    );
  }

  /**
   * Start queued runs while parallel slots are free. `maxParallel` comes from
   * `.ai/cezar/config.json` (default 2); a non-git directory degrades to 1
   * sequential run in the repo root (spec 006 degradation rule).
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const repo = await getRepoInfo(this.repoRoot);
      const maxParallel = repo ? (await loadConfig(this.repoRoot)).maxParallel : 1;
      // `waiting` runs don't hold a slot (#347). A message into a waiting run
      // resumes it even when that momentarily exceeds maxParallel — resumed
      // conversations must never be blocked by the queue.
      const busy = () => this.active.size + this.starting.size - this.waiting.size;
      while (this.queue.length > 0 && busy() < maxParallel) {
        const runId = this.queue.shift();
        if (!runId) break;
        const job = this.pendingJobs.get(runId);
        this.pendingJobs.delete(runId);
        if (!job) continue;
        this.starting.add(runId);
        void this.execute(runId, job.workflow, job.input).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.store.updateRun(runId, {
            status: 'failed',
            error: `engine crashed: ${message}`,
            finishedAt: new Date().toISOString(),
          });
          const state = this.active.get(runId);
          if (state) {
            this.clearIdleTimer(state);
            this.clearAutosaveTimer(state);
          }
          this.starting.delete(runId);
          this.dropActive(runId);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Startup recovery (#367) — re-adopt runs that were live when the previous
   * cezar process exited (requires the store opened with `keepLive`):
   *  - `queued`  → back into the queue (FIFO by createdAt), from the persisted
   *    workflowDef (or the catalog by name for older records);
   *  - `waiting` → the turn was over and the ball was in the user's court —
   *    settle exactly like a closed session (review/done, Continue still works);
   *  - `running` → mark interrupted, then immediately resume the last agent
   *    session via the Continue path, pointing the agent at its handoff file.
   * Call once, before the server starts taking requests.
   */
  async recover(): Promise<void> {
    const live = this.store
      .listRuns()
      .filter((r) => ['queued', 'waiting', 'running'].includes(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const run of live) {
      if (run.status === 'queued') {
        const workflow = await this.reviveWorkflow(run);
        if (workflow) {
          this.pendingJobs.set(run.id, {
            workflow,
            input: {
              task: run.task,
              model: run.model,
              runner: run.runner,
              generateFollowups: run.generateFollowups,
            },
          });
          this.queue.push(run.id);
          this.store.appendEvent(run.id, { type: 'lifecycle', message: 'cezar restarted — task re-queued' });
        } else {
          this.store.updateRun(run.id, {
            status: 'failed',
            error: 'interrupted — workflow definition not recoverable after a restart',
            finishedAt: new Date().toISOString(),
          });
          this.store.appendEvent(run.id, {
            type: 'lifecycle',
            message: 'cezar restarted — workflow definition not recoverable, task failed',
          });
        }
        continue;
      }
      if (run.status === 'waiting') {
        for (const step of run.steps) {
          if (step.status === 'waiting' || step.status === 'running') {
            this.store.updateStep(run.id, step.id, { status: 'done', finishedAt: new Date().toISOString() });
          }
        }
        this.store.appendEvent(run.id, {
          type: 'lifecycle',
          message: 'cezar restarted — the open session was settled',
        });
        await this.settleSuccess(run.id);
        continue;
      }
      // `running`: the process died mid-turn. Mark it interrupted (the state
      // continueRun expects), then pick the work back up from the last session.
      const finishedAt = new Date().toISOString();
      for (const step of run.steps) {
        if (step.status === 'running' || step.status === 'waiting') {
          this.store.updateStep(run.id, step.id, { status: 'failed', finishedAt });
        }
      }
      this.store.updateRun(run.id, {
        status: 'failed',
        error: 'interrupted — cezar process exited during the run',
        finishedAt,
        currentStepId: undefined,
      });
      const resumed = this.continueRun(
        run.id,
        'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.',
      );
      this.store.appendEvent(run.id, {
        type: 'lifecycle',
        message: resumed.ok
          ? 'cezar restarted — resuming the interrupted task from its last session'
          : `cezar restarted — could not resume the interrupted task (${resumed.error ?? 'unknown'})`,
      });
    }
    void this.pump();
  }

  /** The persisted definition when it looks sane, else the catalog by name. */
  private async reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null> {
    const def = run.workflowDef;
    if (def && Array.isArray((def as { steps?: unknown }).steps)) {
      return def as unknown as WorkflowDef;
    }
    const { workflows } = await loadWorkflows(this.repoRoot);
    return workflows.find((w) => w.name === run.workflow) ?? null;
  }

  /** Remove a run from the live registries — keeps `waiting ⊆ active`. */
  private dropActive(runId: string): void {
    const state = this.active.get(runId);
    state?.releaseRepoRoot?.();
    if (state) state.releaseRepoRoot = undefined;
    this.waiting.delete(runId);
    this.active.delete(runId);
    this.memoryPausing.delete(runId);
    this.lastNamerKey.delete(runId);
  }

  /** Last live-refresh namer inputs per run — unchanged inputs skip the call. */
  private lastNamerKey = new Map<string, string>();

  /**
   * Acquire the one-at-a-time lease for runs executing in `repoRoot`.
   *
   * A lease waiter is idle, so it parks in `waiting` and gives its
   * `maxParallel` slot back (the #347 rule): isolated worktrees keep using
   * every configured slot while root runs line up. The store status stays
   * `running` — only the queue's busy count changes, so the GUI never shows a
   * lease-blocked run as awaiting user input.
   *
   * The lease is held for the run's whole lifetime, including the idle
   * `waiting` parks between agent turns. A parked session is still live and
   * writes to the working tree the moment it resumes, so handing the tree to
   * another run there would reintroduce the concurrent-edit bug (#438) this
   * lease exists to prevent.
   *
   * Returns false when the run was cancelled while waiting: the lease was
   * never granted and the caller must not touch the working tree.
   */
  private async acquireRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    // `cancel()` can land between the run going `running` and reaching here,
    // while `interrupt` is still the default no-op — never enter the chain.
    if (state.cancelled) return false;
    const previous = this.repoRootTail;
    let release: () => void = () => undefined;
    this.repoRootTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Until `previous` resolves this run does not own the tree yet, so a drop
    // during the wait must not hand the tree to the next waiter — chain our
    // release behind `previous` instead of resolving the tail early.
    state.releaseRepoRoot = () => {
      void previous.then(release);
    };
    let abort: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve;
    });
    const parked = state.interrupt;
    state.interrupt = () => {
      parked();
      abort();
    };
    this.waiting.add(runId);
    void this.pump();
    try {
      await Promise.race([previous, cancelled]);
    } finally {
      state.interrupt = parked;
      this.waiting.delete(runId);
    }
    if (state.cancelled) return false;
    state.releaseRepoRoot = release;
    return true;
  }

  cancel(runId: string): boolean {
    // Still waiting in the queue: just drop it there.
    const queuedAt = this.queue.indexOf(runId);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      this.pendingJobs.delete(runId);
      this.store.updateRun(runId, { status: 'cancelled', finishedAt: new Date().toISOString() });
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
      return true;
    }
    const state = this.active.get(runId);
    if (!state) return false;
    state.cancelled = true;
    this.clearIdleTimer(state);
    state.interrupt();
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId) || this.starting.has(runId) || this.queue.includes(runId);
  }

  /**
   * Deliver a user message into the run's live claude session (mid-turn or
   * while `waiting`). Returns false when there is no open session — the GUI
   * then offers "Continue" instead.
   */
  sendMessage(runId: string, content: ContentBlock[]): boolean {
    const state = this.active.get(runId);
    if (!state?.session?.open || state.cancelled) return false;

    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Persist the attached images so the thread can render them (not just count them) — the same
    // on-disk store + `/images/` route the agent's own screenshots use.
    const images = content
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, state, b.source.media_type, b.source.data))
      .filter((saved): saved is { name: string; url: string } => saved !== null)
      .map((saved) => saved.url);
    this.store.appendEvent(runId, {
      type: 'user-message',
      stepId: state.currentStepId,
      text,
      imageCount: content.filter((b) => b.type === 'image').length,
      images,
    });

    const delivered = state.session.sendMessage(content);
    if (delivered) {
      this.clearIdleTimer(state);
      this.waiting.delete(runId); // resumed — the run counts against slots again
      this.store.updateRun(runId, { status: 'running' });
      if (state.currentStepId) {
        this.store.updateStep(runId, state.currentStepId, { status: 'running' });
      }
    }
    return delivered;
  }

  /** Close the open session gracefully — the run then completes as `done`
   *  (or rests at `review` when the worktree holds changes, spec 009).
   *  On a run already resting at `review` (no session — the engine loop is
   *  over), "Finish" is the third review exit: accept the changes without a
   *  PR and flip straight to `done`. */
  finish(runId: string): boolean {
    const state = this.active.get(runId);
    if (state?.session?.open) {
      this.clearIdleTimer(state);
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'session closed by user' });
      state.session.end();
      return true;
    }
    const run = this.store.getRun(runId);
    if (run?.status === 'review' && !this.isActive(runId)) {
      this.store.updateRun(runId, { status: 'done' });
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'review accepted — finished without a PR' });
      return true;
    }
    return false;
  }

  /**
   * "Continue" (spec 003): reopen a finished run's claude session in-process
   * (`claude --resume <sessionId>`) as a new synthetic step. The session then
   * behaves exactly like an interactive step: `waiting` after each turn,
   * messages via sendMessage, closed by finish/idle/cancel.
   */
  continueRun(runId: string, text?: string): { ok: boolean; error?: string } {
    if (this.active.has(runId)) return { ok: false, error: 'run is still active' };
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    // `review` is continuable too — that's the "Send back" path (spec 009).
    if (!['done', 'failed', 'cancelled', 'review'].includes(run.status)) {
      return { ok: false, error: `cannot continue a ${run.status} run` };
    }
    const sessionId = [...run.steps].reverse().find((s) => s.sessionId)?.sessionId;
    if (!sessionId) return { ok: false, error: 'no agent session to resume' };

    const continuations = run.steps.filter((s) => s.id.startsWith('continue-')).length;
    const stepId = `continue-${continuations + 1}`;
    this.store.addStep(runId, { id: stepId, name: 'Continue', kind: 'agent' });
    void this.runContinuation(runId, stepId, sessionId, text?.trim() || 'Continue.').catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.store.updateRun(runId, {
          status: 'failed',
          error: `continue crashed: ${message}`,
          finishedAt: new Date().toISOString(),
        });
        this.dropActive(runId);
        void this.pump();
      },
    );
    return { ok: true };
  }

  private async runContinuation(
    runId: string,
    stepId: string,
    sessionId: string,
    prompt: string,
  ): Promise<void> {
    // Continuation runs in the task's worktree when it still exists (spec
    // 006) — the resumed session sees exactly what the original run left.
    const record = this.store.getRun(runId);
    const generateFollowups = record?.generateFollowups !== false;
    const cwd =
      record?.worktreePath && existsSync(record.worktreePath)
        ? record.worktreePath
        : this.repoRoot;
    const state: ActiveRun = { cancelled: false, interrupt: () => undefined, cwd };
    this.active.set(runId, state);
    if (state.cwd === this.repoRoot) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: 'waiting for exclusive access to the repository working tree',
      });
      if (!(await this.acquireRepoRoot(runId, state))) {
        this.store.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          currentStepId: undefined,
        });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
        this.dropActive(runId);
        void this.pump();
        return;
      }
    }
    this.armAutosave(state);
    if (record) seedHandoffFile(this.dataDir, record); // idempotent — normally already there

    this.store.updateRun(runId, {
      status: 'running',
      error: undefined,
      finishedAt: undefined,
      currentStepId: stepId,
    });
    this.store.updateStep(runId, stepId, {
      status: 'running',
      iterations: 1,
      startedAt: new Date().toISOString(),
      sessionId,
    });
    this.store.appendEvent(runId, { type: 'step-start', stepId, name: 'Continue', kind: 'agent', iteration: 1 });
    this.store.appendEvent(runId, { type: 'user-message', stepId, text: prompt, imageCount: 0 });

    let stepCost = 0;
    let turnText = '';
    const sink = this.makeUiSink(runId, stepId);
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'image') {
        const saved = this.persistImage(runId, state, event.mediaType, event.data);
        if (saved) this.store.appendEvent(runId, { type: 'image', stepId, ...saved });
        return;
      }
      if (event.type === 'text') {
        turnText += event.text;
        const text = stripDoneMarker(event.text);
        if (text) this.store.appendEvent(runId, { type: 'text', text, stepId });
        return;
      }
      this.store.appendEvent(runId, { ...event, stepId });
      if (event.type === 'session') {
        this.store.updateStep(runId, stepId, { sessionId: event.sessionId });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, stepId, { tokensUsed: event.tokensUsed });
      }
      if (event.type === 'cost') {
        stepCost += event.usd;
        this.store.updateStep(runId, stepId, { costUsd: stepCost });
      }
      if (event.type === 'turn-end') {
        // Belt-and-braces: v2 `turn.completed` already flushed the delta
        // coalescers; the v1 turn boundary flushes again (idempotent) so no
        // buffered delta can outlive its turn.
        sink.flushAll();
        void this.recordTurnEnd(runId, turnText); // titleSummary + diffStat (#389)
        const sessionOpen = !state.cancelled && state.session?.open;
        const done = sessionOpen && DONE_MARKER_RE.test(turnText.trimEnd());
        turnText = '';
        if (done) {
          // Goal achieved (agent contract, #347) — same as in runAgentStep.
          this.store.appendEvent(runId, { type: 'lifecycle', message: 'goal achieved — session closed' });
          appendHandoffHeartbeat(this.dataDir, runId, 'turn complete — goal achieved, session closed');
          state.session?.end();
          return;
        }
        if (sessionOpen) {
          // Autonomous (#autonomous): never hand the ball back to the user. Nudge the agent to
          // keep going (bounded by MAX_AUTO_CONTINUES) instead of parking at `waiting`.
          const autoContinued =
            state.autonomous &&
            (state.autoContinues ?? 0) < MAX_AUTO_CONTINUES &&
            !state.cancelled &&
            (() => {
              const sent = state.session?.sendMessage([{ type: 'text', text: AUTONOMOUS_NUDGE }]);
              if (!sent) return false;
              state.autoContinues = (state.autoContinues ?? 0) + 1;
              this.store.appendEvent(runId, {
                type: 'note',
                message: `autonomous — continuing without pausing (${state.autoContinues}/${MAX_AUTO_CONTINUES})`,
              });
              return true;
            })();
          if (!autoContinued) {
            this.store.updateRun(runId, { status: 'waiting' });
            this.store.updateStep(runId, stepId, { status: 'waiting' });
            this.waiting.add(runId);
            this.armIdleTimer(runId, state);
            void this.pump();
          }
        }
        appendHandoffHeartbeat(this.dataDir, runId, `turn complete — status=${sessionOpen ? 'waiting' : 'running'}`);
      }
    };

    const runner = createRunner(record?.runner ?? 'claude');
    const session = runner.startSession(
      {
        // The Continue step is a fresh agent session on the same run — the
        // run's extra system prompt (already resolved at execute time and
        // echoed on the record) rides along with the handoff contract.
        systemPrompt: composeSystemPrompt(
          record?.systemPrompt,
          generateFollowups ? HANDOFF_INSTRUCTIONS : HANDOFF_ONLY_INSTRUCTIONS,
        ),
        userPrompt: prompt,
        cwd: state.cwd,
        allowedTools: DEFAULT_ALLOWED_TOOLS,
        additionalDirectories: [join(this.dataDir, 'runs')],
        env: this.agentEnv(runId, generateFollowups),
        sessionId,
        resume: true,
        timeoutMs: 0,
      },
      onEvent,
      { onUiEvent: (event) => sink.handle(event) },
    );
    state.session = session;
    state.currentStepId = stepId;
    state.interrupt = () => session.interrupt();
    if (session.pid !== undefined) registerRunProcess(runId, session.pid);

    const finishedAt = () => new Date().toISOString();
    try {
      await session.result;
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      if (state.cancelled) {
        this.store.updateStep(runId, stepId, { status: 'cancelled', finishedAt: finishedAt() });
        this.store.updateRun(runId, { status: 'cancelled', finishedAt: finishedAt(), currentStepId: undefined });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=cancelled`);
      } else {
        this.store.updateStep(runId, stepId, { status: 'done', finishedAt: finishedAt() });
        this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'done' });
        await this.settleSuccess(runId);
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=done`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink.sessionEnded('error', message);
      this.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt: finishedAt() });
      appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=failed`);
      this.store.updateRun(runId, {
        status: 'failed',
        error: `continue failed: ${message}`,
        finishedAt: finishedAt(),
        currentStepId: undefined,
      });
      this.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${message}` });
    } finally {
      this.recordUsagePeaks(runId);
      this.clearIdleTimer(state);
      this.clearAutosaveTimer(state);
      if (state.cwd !== this.repoRoot) await autosaveCommit(state.cwd);
      this.dropActive(runId);
      void this.pump();
    }
  }

  // ---- execution -----------------------------------------------------------

  private async execute(runId: string, workflow: WorkflowDef, input: StartRunInput): Promise<void> {
    const state: ActiveRun = {
      cancelled: false,
      interrupt: () => undefined,
      cwd: this.repoRoot,
      autonomous: input.autonomous === true,
      autoContinues: 0,
    };
    this.active.set(runId, state);
    this.starting.delete(runId);
    const emit = (event: { type: string; stepId?: string; [k: string]: unknown }) =>
      this.store.appendEvent(runId, event);

    // Resolve the agent backend for this run: the task choice (GUI) wins over
    // the config default. Per-step `runner` can still override it below.
    const config = await loadConfig(this.repoRoot);
    const taskBackend: RunnerId = input.runner ?? config.defaultRunner;
    // Extra system prompt (R2 2.3): POST override > config default; echoed on
    // the record so the UI/API can show what the run actually used.
    const extraSystemPrompt = resolveExtraSystemPrompt(input.systemPrompt, config.systemPrompt);
    this.store.updateRun(runId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      runner: taskBackend,
      systemPrompt: extraSystemPrompt,
    });
    emit({ type: 'lifecycle', message: `run started — workflow "${workflow.name}" (runner: ${taskBackend})` });

    // Worktree per task (spec 006): the agent works on its own branch in
    // `.ai/cezar/worktrees/<id>`, never in the user's working tree. A Git task
    // that requests isolation fails closed if the worktree cannot be
    // established; only explicit opt-out and non-Git modes run in place.
    const repo = await getRepoInfo(this.repoRoot);
    if (repo && input.worktree === false) {
      // Composer opt-out: run in the repo working tree, no branch/worktree
      // (read-only skills — review, summarize — that never need isolation).
      emit({ type: 'note', message: 'worktree off — running in the repo working tree' });
    } else if (repo) {
      // Fork from the configured base branch (config.json `baseBranch`, e.g.
      // `develop`) — also the target of the eventual draft PR. Unresolvable
      // (typo, not fetched) → note + the currently checked-out branch.
      //
      // A task that already recorded a fork point keeps it: its worktree is
      // reused as-is, and re-resolving against a since-changed config would
      // silently re-anchor the `merge-base` every diff/shortstat is measured
      // from, shifting "what did this task change" under an existing task.
      const recorded = this.store.getRun(runId)?.baseBranch;
      let base = recorded ?? repo.branch;
      const configured = recorded ? undefined : config.baseBranch;
      if (configured) {
        const resolved = await resolveBaseRef(this.repoRoot, configured);
        if (resolved) {
          base = resolved;
        } else {
          emit({
            type: 'note',
            message: `configured base branch "${configured}" not found (locally or on origin) — using "${repo.branch}"`,
          });
        }
      }
      try {
        const wt = await createWorktree(this.repoRoot, runId, base);
        state.cwd = wt.path;
        this.store.updateRun(runId, {
          worktreePath: wt.path,
          branch: wt.branch,
          baseBranch: wt.baseBranch,
        });
        emit({ type: 'note', message: `worktree ready — branch ${wt.branch} (base ${wt.baseBranch})` });
        this.armAutosave(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const error = `worktree creation failed: ${message}`;
        emit({ type: 'note', message: `${error} — task stopped before workflow execution` });
        this.store.updateRun(runId, {
          status: 'failed',
          error,
          finishedAt: new Date().toISOString(),
          currentStepId: undefined,
        });
        emit({ type: 'lifecycle', message: `run failed — ${error}` });
        this.dropActive(runId);
        void this.pump();
        return;
      }
    } else {
      emit({ type: 'note', message: 'not a git repository — running in place, one task at a time' });
    }

    if (state.cwd === this.repoRoot) {
      emit({
        type: 'note',
        message: 'waiting for exclusive access to the repository working tree',
      });
      // A cancel during the wait leaves the lease ungranted; the step loop
      // below breaks on `cancelled` before touching the tree and settles the
      // run through the usual path.
      await this.acquireRepoRoot(runId, state);
    }

    // Handoff journal (spec 007) — seeded after the worktree exists so the
    // header can name the branch. Idempotent: an existing file stays as-is.
    const seeded = this.store.getRun(runId);
    if (seeded) seedHandoffFile(this.dataDir, seeded);

    const skills = await discoverSkills(this.repoRoot);
    const retriesUsed = new Map<string, number>();
    let checkFailure: string | null = null;
    let runError: string | null = null;
    // Persist the task's attached images so the thread's initial bubble can render them
    // (#image-display); they still ride the first agent step's opening message below.
    if (input.images?.length) {
      const urls = input.images
        .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
        .map((b) => this.persistImage(runId, state, b.source.media_type, b.source.data))
        .filter((saved): saved is { name: string; url: string } => saved !== null)
        .map((saved) => saved.url);
      if (urls.length) this.store.updateRun(runId, { taskImages: urls });
    }
    // Task screenshots go with the FIRST agent step's opening message only —
    // later steps and retry loops run in fresh sessions without them.
    let startImages = input.images;

    const lastAgentIdx = findLastAgentStepIndex(workflow);

    let i = 0;
    while (i < workflow.steps.length) {
      if (state.cancelled) break;
      const step = workflow.steps[i] as WorkflowStepDef;
      const kind = stepKind(step);
      const record = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
      const iteration = (record?.iterations ?? 0) + 1;

      this.store.updateRun(runId, { currentStepId: step.id });
      this.store.updateStep(runId, step.id, {
        status: 'running',
        iterations: iteration,
        startedAt: new Date().toISOString(),
        error: undefined,
      });
      emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });

      if (kind === 'agent') {
        // The last agent step of the workflow is interactive: after its turn
        // the session stays open for follow-ups until finish/idle/cancel.
        const interactive = i === lastAgentIdx && i === workflow.steps.length - 1;
        const failure = await this.runAgentStep(
          runId,
          state,
          step,
          input,
          skills,
          checkFailure,
          interactive,
          emit,
          startImages,
          taskBackend,
          extraSystemPrompt,
          chainStepNote(workflow.steps, i),
        );
        startImages = undefined;
        checkFailure = null;
        if (state.cancelled) break;
        if (failure) {
          this.finishStep(runId, step.id, 'failed', failure, emit);
          runError = `step "${step.id}" failed: ${failure}`;
          break;
        }
        this.finishStep(runId, step.id, 'done', undefined, emit);
        i++;
        continue;
      }

      const { ok, output } = await this.runCheckStep(state, step, emit);
      if (state.cancelled) break;
      if (ok) {
        this.finishStep(runId, step.id, 'done', undefined, emit);
        i++;
        continue;
      }

      const used = retriesUsed.get(step.id) ?? 0;
      if (step.onFail && used < step.onFail.max) {
        retriesUsed.set(step.id, used + 1);
        checkFailure = output;
        this.finishStep(runId, step.id, 'failed', 'check failed — looping back', emit);
        const retryIdx = workflow.steps.findIndex((s) => s.id === step.onFail?.retry);
        emit({
          type: 'note',
          stepId: step.id,
          message: `check failed — retrying from "${step.onFail.retry}" (attempt ${used + 1}/${step.onFail.max})`,
        });
        // Steps we're about to re-run go back to pending so the GUI rail
        // reads top-to-bottom truthfully.
        for (const s of workflow.steps.slice(retryIdx, i + 1)) {
          this.store.updateStep(runId, s.id, { status: 'pending' });
        }
        i = retryIdx;
        continue;
      }

      this.finishStep(runId, step.id, 'failed', `\`${step.command}\` exited non-zero`, emit);
      runError = `check "${step.id}" failed${step.onFail ? ` after ${used + 1} attempts` : ''}`;
      break;
    }

    // Final autosave: the branch always ends holding the finished state.
    this.clearAutosaveTimer(state);
    if (state.cwd !== this.repoRoot) await autosaveCommit(state.cwd);

    const finishedAt = new Date().toISOString();
    if (state.cancelled) {
      const run = this.store.getRun(runId);
      for (const s of run?.steps ?? []) {
        if (s.status === 'running' || s.status === 'waiting') {
          this.store.updateStep(runId, s.id, { status: 'cancelled' });
        }
      }
      this.store.updateRun(runId, { status: 'cancelled', finishedAt, currentStepId: undefined });
      emit({ type: 'lifecycle', message: 'run cancelled' });
    } else if (runError) {
      this.store.updateRun(runId, { status: 'failed', error: runError, finishedAt, currentStepId: undefined });
      emit({ type: 'lifecycle', message: `run failed — ${runError}` });
    } else {
      await this.settleSuccess(runId);
    }
    this.clearIdleTimer(state);
    this.dropActive(runId);
    void this.pump();
  }

  /** Returns an error message, or null on success. */
  private async runAgentStep(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    input: StartRunInput,
    skills: Skill[],
    checkFailure: string | null,
    interactive: boolean,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    images: ContentBlock[] | undefined,
    taskBackend: RunnerId,
    extraSystemPrompt: string | undefined,
    /** The chain-boundary note for this step (#410), or undefined when the
     *  workflow has a single agent step and there is no boundary to explain. */
    chainNote: string | undefined,
  ): Promise<string | null> {
    let systemPrompt: string | undefined;
    if (step.skill) {
      const skill = skills.find((s) => s.name === step.skill);
      if (skill) {
        // The body alone often does not identify the selected skill. Keep its
        // name and catalog description in the normalized runner payload so a
        // numeric task such as "432" still gives the model enough context to
        // describe the work — and therefore derive a useful title (#432).
        systemPrompt = skillSystemPrompt(skill);
        // Directory team skills (SKILL.md + references/) get materialized
        // into <cwd>/.claude/skills/<name>/ — the run's worktree when there
        // is one — so claude sees the companion files on disk; the shared
        // info/exclude keeps them out of git (and out of autosave commits).
        if (skill.source === 'team' && skill.team?.dir) {
          const seeded = await materializeSkillDir(state.cwd, skill).catch(() => false);
          if (seeded) {
            emit({
              type: 'note',
              stepId: step.id,
              message: `team skill "${skill.name}" materialized to .claude/skills/${skill.name}/`,
            });
          }
        }
      } else {
        emit({
          type: 'note',
          stepId: step.id,
          message: `skill "${step.skill}" not found in .ai/cezar/skills, .ai/skills or the team skills repo — running with the plain prompt`,
        });
      }
    }

    let userPrompt = applyTemplate(step.prompt ?? '{{task}}', input.task);
    if (chainNote) userPrompt = `${chainNote}\n\n---\n\n${userPrompt}`;
    if (checkFailure) {
      userPrompt += `\n\nA verification command failed after the previous attempt. Fix the cause. Failing output:\n\n${checkFailure}`;
    }
    if (images?.length) {
      emit({
        type: 'note',
        stepId: step.id,
        message: `${images.length} screenshot${images.length > 1 ? 's' : ''} attached to the task`,
      });
    }

    const sessionId = randomUUID();
    this.store.updateStep(runId, step.id, { sessionId });

    const stepRecord = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
    const startTokens = stepRecord?.tokensUsed ?? 0;
    let stepCost = stepRecord?.costUsd ?? 0;
    let turnText = '';
    const sink = this.makeUiSink(runId, step.id);
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'image') {
        const saved = this.persistImage(runId, state, event.mediaType, event.data);
        if (saved) emit({ type: 'image', stepId: step.id, ...saved });
        return;
      }
      if (event.type === 'text') {
        turnText += event.text;
        const text = stripDoneMarker(event.text);
        if (text) emit({ type: 'text', text, stepId: step.id });
        return;
      }
      emit({ ...event, stepId: step.id });
      if (event.type === 'session') {
        // Codex/OpenCode mint their own session id — persist it so resume works.
        this.store.updateStep(runId, step.id, { sessionId: event.sessionId });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, step.id, { tokensUsed: startTokens + event.tokensUsed });
      }
      if (event.type === 'cost') {
        stepCost += event.usd;
        this.store.updateStep(runId, step.id, { costUsd: stepCost });
      }
      if (event.type === 'turn-end') {
        // v2 `turn.completed` already flushed the coalescers; the v1 turn
        // boundary flushes again (idempotent) as a backstop.
        sink.flushAll();
        void this.recordTurnEnd(runId, turnText); // titleSummary + diffStat (#389)
        const sessionOpen = !state.cancelled && state.session?.open;
        const done = interactive && sessionOpen && DONE_MARKER_RE.test(turnText.trimEnd());
        turnText = '';
        if (done) {
          // Goal achieved (agent contract, #347): close the session instead
          // of parking at `waiting` — the run completes and frees its slot.
          emit({ type: 'lifecycle', message: 'goal achieved — session closed' });
          appendHandoffHeartbeat(this.dataDir, runId, 'turn complete — goal achieved, session closed');
          state.session?.end();
          return;
        }
        const waiting = interactive && sessionOpen;
        if (waiting) {
          // Turn over, session open: the ball is in the user's court.
          this.store.updateRun(runId, { status: 'waiting' });
          this.store.updateStep(runId, step.id, { status: 'waiting' });
          this.waiting.add(runId);
          this.armIdleTimer(runId, state);
          void this.pump(); // the freed slot can start a queued run right away
        }
        // Cez's own heartbeat — the handoff stays current even when the
        // agent forgets to write (spec 007).
        appendHandoffHeartbeat(this.dataDir, runId, `turn complete — status=${waiting ? 'waiting' : 'running'}`);
      }
    };

    const runner = createRunner(step.runner ?? taskBackend);
    let session: AgentSession;
    try {
      session = runner.startSession(
        {
          // Skill body, then the run's extra prompt (POST override or config
          // default), then the handoff/todos contract — every agent step.
          systemPrompt: composeSystemPrompt(
            systemPrompt,
            extraSystemPrompt,
            input.generateFollowups === false ? HANDOFF_ONLY_INSTRUCTIONS : HANDOFF_INSTRUCTIONS,
          ),
          userPrompt,
          images,
          cwd: state.cwd,
          allowedTools: step.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
          bashAllowlist: step.bashAllowlist,
          // The handoff file lives outside the worktree — grant access.
          additionalDirectories: [join(this.dataDir, 'runs')],
          env: this.agentEnv(runId, input.generateFollowups !== false),
          model: step.model ?? input.model,
          sessionId,
          // Interactive sessions have no wall clock — the idle timer rules.
          timeoutMs: interactive ? 0 : undefined,
        },
        onEvent,
        { autoEndAfterFirstTurn: !interactive, onUiEvent: (event) => sink.handle(event) },
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    state.session = session;
    state.currentStepId = step.id;
    state.interrupt = () => session.interrupt();
    if (session.pid !== undefined) registerRunProcess(runId, session.pid);

    try {
      const result = await session.result;
      // v2 counterpart of v1's `done` (spec: the mappers leave session-close
      // events to the RunManager — only it knows how the session settled).
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      this.store.updateStep(runId, step.id, { tokensUsed: startTokens + result.tokensUsed });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink.sessionEnded('error', message); // alongside v1's fatal `error`
      return message;
    } finally {
      this.recordUsagePeaks(runId);
      this.clearIdleTimer(state);
      state.session = undefined;
      state.currentStepId = undefined;
      state.interrupt = () => undefined;
    }
  }

  /**
   * Protocol-v2 sink for one agent session (R2 step 2.1): the runner's
   * `onUiEvent` stream flows through here. Persisted snapshots ride the same
   * NDJSON file as v1 (the store stamps `seq`/`ts`, `appendEvent` fans them
   * out live too); coalesced `item.delta` flushes go out live-only via
   * `emitEphemeral` — raw deltas never hit disk (spec §performance
   * guardrails). One sink per session: cumulative usage dedup and the
   * item-shape cache are session-scoped, like the mapper state feeding them.
   */
  private makeUiSink(runId: string, stepId: string): UiEventSink {
    return new UiEventSink({
      persist: (event) => this.store.appendEvent(runId, { ...event, stepId }),
      emitLive: (event) => this.store.emitEphemeral(runId, { ...event, stepId }),
    });
  }

  /**
   * Turn-end bookkeeping (#389), shared by `runAgentStep` and
   * `runContinuation` — called (fire-and-forget) from every `turn-end` event:
   *
   *  - `titleSummary`: derived from the turn's text, set ONCE — only while the
   *    record has none. A user's inline edit also lands in `titleSummary`
   *    (see `PATCH /api/runs/:id`), so an edit is never overwritten either.
   *  - `diffStat`: cheap `git diff --shortstat` vs the base, refreshed every
   *    turn. Async and best-effort — a git failure becomes at most a `note`
   *    event, NEVER a run failure. `updateRun` fans the record out over SSE,
   *    so the list views pick both up with no extra wiring.
   *
   * Not `private` so the integration tests can drive a turn-end directly —
   * a real agent session is the only other way to reach this path.
   */
  /**
   * The namer's apply path (task auto-naming spec). Fire-and-forget: called
   * without await from `startRun` (creation) and `recordTurnEnd` (live
   * refresh). A user-owned title (`titleOrigin: 'user'`) is never overwritten;
   * namer-owned titles may be replaced by fresher namer results.
   */
  private async autoNameRun(
    runId: string,
    skillName: string | undefined,
    task: string,
    live?: { turnText?: string; diffStat?: string },
  ): Promise<void> {
    // CEZ_AUTONAME=0 kills all LLM naming; dry-run skips it too unless
    // CEZ_AUTONAME=1 forces the mock path — see autoNamingActive.
    if (!autoNamingActive()) return;
    try {
      let skillDescription: string | undefined;
      if (skillName) {
        const skills = await discoverSkills(this.repoRoot).catch(() => [] as Skill[]);
        skillDescription = skills.find((s) => s.name === skillName)?.description;
      }
      const result = await generateRunName(this.repoRoot, { task, skillName, skillDescription, ...live });
      if (!result) return;
      const run = this.store.getRun(runId);
      if (!run || run.titleOrigin === 'user') return;
      this.store.updateRun(runId, {
        titleSummary: result.titleSummary,
        titleOrigin: 'auto',
        ...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
        ...(result.issueNumber !== undefined ? { issueNumber: result.issueNumber } : {}),
      });
    } catch {
      // Naming is best-effort — nothing here may disturb the run.
    }
  }

  async recordTurnEnd(runId: string, turnText: string): Promise<void> {
    try {
      const run = this.store.getRun(runId);
      if (!run) return;
      // Titles are the namer's job (task auto-naming spec) — turn text is
      // deliberately NEVER a title source; see maybeRefreshTitle below.
      if (run.worktreePath && existsSync(run.worktreePath)) {
        const stat = await worktreeShortstat(run.worktreePath, run.baseBranch ?? 'HEAD');
        if (stat) this.store.updateRun(runId, { diffStat: stat });
        else this.store.appendEvent(runId, { type: 'note', message: 'diff stat unavailable — git diff --shortstat failed in the worktree' });
      }
      await this.maybeRefreshTitle(runId, turnText);
    } catch {
      // Bookkeeping only — nothing here may disturb the run.
    }
  }

  /**
   * Live title refresh (task auto-naming spec, step 3): re-run the namer with
   * the turn's context. Skips: toggle off (`liveTitleUpdates` config over
   * `CEZ_TITLE_UPDATES` env, default ON), user-owned title, dry-run mocks
   * (canned answers add nothing), empty turn text, unchanged namer inputs.
   */
  private async maybeRefreshTitle(runId: string, turnText: string): Promise<void> {
    if (!autoNamingActive()) return;
    if (!turnText.trim()) return;
    const config = await loadConfig(this.repoRoot);
    if (!liveTitleUpdatesEnabled(config)) return;
    const run = this.store.getRun(runId);
    if (!run || run.titleOrigin === 'user') return;
    const statText = run.diffStat ? `${run.diffStat.files} files, +${run.diffStat.adds} -${run.diffStat.dels}` : undefined;
    const key = `${turnText.slice(0, 200)}|${statText ?? ''}`;
    if (this.lastNamerKey.get(runId) === key) return;
    this.lastNamerKey.set(runId, key);
    const workflow = await this.reviveWorkflow(run);
    const skillName = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    void this.autoNameRun(runId, skillName, run.task, { turnText, diffStat: statText });
  }

  /**
   * End-of-session telemetry (#348): stop sampling the run's process tree and
   * fold the session's peaks into the run record. `max` with existing values —
   * a run can hold several sessions (multiple agent steps, Continue) and the
   * record keeps the highest water mark across all of them.
   */
  private recordUsagePeaks(runId: string): void {
    const peaks = unregisterRunProcess(runId);
    if (!peaks) return;
    const run = this.store.getRun(runId);
    this.store.updateRun(runId, {
      peakRssBytes: Math.max(run?.peakRssBytes ?? 0, peaks.peakRssBytes),
      peakProcCount: Math.max(run?.peakProcCount ?? 0, peaks.peakProcCount),
    });
  }

  /**
   * Diff-first review gate (spec 009), shared by `execute` and
   * `runContinuation`: a *successful* run whose worktree holds changes rests
   * at `review` instead of `done` — the user inspects the diff first, then
   * sends feedback back, opens a draft PR, or just finishes. Failed/cancelled
   * runs never enter review; no worktree or an empty diff means plain `done`.
   */
  private async settleSuccess(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    let review = false;
    if (run?.worktreePath && existsSync(run.worktreePath)) {
      const diff = await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD');
      review = diff.trim().length > 0 && !diff.startsWith('(diff failed');
    }
    this.store.updateRun(runId, {
      status: review ? 'review' : 'done',
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
    });
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: review
        ? 'changes ready for review — send feedback, open a draft PR, or finish'
        : 'run finished',
    });
  }

  /**
   * Agent screenshot (an image block inside a tool result): the base64 data
   * never enters the NDJSON event log — it lands as a file under
   * `.ai/cezar/runs/<id>-images/` and the transcript event carries only the
   * name + serving URL. Best effort: on failure the screenshot is dropped,
   * the transcript still shows the tool result's `[screenshot]` placeholder.
   */
  private persistImage(
    runId: string,
    state: ActiveRun,
    mediaType: string,
    data: string,
  ): { name: string; url: string } | null {
    try {
      const ext =
        /png/.test(mediaType) ? 'png'
        : /jpe?g/.test(mediaType) ? 'jpg'
        : /webp/.test(mediaType) ? 'webp'
        : /gif/.test(mediaType) ? 'gif'
        : 'img';
      state.imageSeq = (state.imageSeq ?? 0) + 1;
      const name = `screenshot-${state.imageSeq}.${ext}`;
      const dir = join(this.dataDir, 'runs', `${runId}-images`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
      return { name, url: `/api/runs/${runId}/images/${name}` };
    } catch {
      return null;
    }
  }

  private armIdleTimer(runId: string, state: ActiveRun): void {
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      if (state.session?.open && !state.cancelled) {
        this.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `session closed after ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m of inactivity`,
        });
        state.session.end();
      }
    }, IDLE_TIMEOUT_MS);
    state.idleTimer.unref?.();
  }

  private clearIdleTimer(state: ActiveRun): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  /** Autosave-commit the worktree every 90 s while the run lives (spec 006).
   *  Opt-in via CEZ_AUTOSAVE=1 (#471) — see periodicAutosaveEnabled. */
  private armAutosave(state: ActiveRun): void {
    if (!periodicAutosaveEnabled()) return;
    if (state.cwd === this.repoRoot || state.autosaveTimer) return;
    state.autosaveTimer = setInterval(() => {
      void autosaveCommit(state.cwd);
    }, AUTOSAVE_INTERVAL_MS);
    state.autosaveTimer.unref?.();
  }

  private clearAutosaveTimer(state: ActiveRun): void {
    if (state.autosaveTimer) {
      clearInterval(state.autosaveTimer);
      state.autosaveTimer = undefined;
    }
  }

  private runCheckStep(
    state: ActiveRun,
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<{ ok: boolean; output: string }> {
    const command = step.command as string;
    emit({ type: 'note', stepId: step.id, message: `$ ${command}` });
    return new Promise((resolve) => {
      // Check steps run in the same cwd as the agent steps — the worktree.
      const child = spawn('bash', ['-lc', command], { cwd: state.cwd, env: process.env });
      state.interrupt = () => child.kill('SIGTERM');

      let output = '';
      const collect = (chunk: Buffer) => {
        if (output.length < CHECK_OUTPUT_CAP) {
          output += chunk.toString('utf8');
          if (output.length >= CHECK_OUTPUT_CAP) output += '\n… (output truncated)';
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (err) => {
        state.interrupt = () => undefined;
        const message = `failed to spawn: ${err.message}`;
        emit({ type: 'check-output', stepId: step.id, command, text: message, exitCode: -1 });
        resolve({ ok: false, output: message });
      });
      child.on('close', (code) => {
        state.interrupt = () => undefined;
        const trimmed = output.trim() || '(no output)';
        emit({ type: 'check-output', stepId: step.id, command, text: trimmed, exitCode: code ?? -1 });
        resolve({ ok: code === 0, output: trimmed });
      });
    });
  }

  private finishStep(
    runId: string,
    stepId: string,
    status: 'done' | 'failed',
    error: string | undefined,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): void {
    this.store.updateStep(runId, stepId, {
      status,
      error,
      finishedAt: new Date().toISOString(),
    });
    emit({ type: 'step-end', stepId, status, ...(error ? { error } : {}) });
    appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=${status}`);
  }
}

function findLastAgentStepIndex(workflow: WorkflowDef): number {
  for (let i = workflow.steps.length - 1; i >= 0; i--) {
    const step = workflow.steps[i];
    if (step && stepKind(step) === 'agent') return i;
  }
  return -1;
}

function applyTemplate(template: string, task: string): string {
  return template.replaceAll('{{task}}', task);
}

/**
 * Immediate title shown while a run is queued. The namer's `titleSummary`
 * replaces it once the model answers; this is the honest, permanent fallback
 * when no model is available (#432, spec 2026-07-17-task-auto-naming). When
 * the task references a PR/issue, the number leads: `469: /om-auto-review-pr`.
 */
export function makeRunTitle(task: string, workflow: WorkflowDef): string {
  const firstLine = task.trim().split('\n')[0] ?? '';
  const skill = workflow.steps.find((step) => stepKind(step) === 'agent' && step.skill)?.skill?.trim();
  const contextual = skill && !firstLine.startsWith(`/${skill}`)
    ? `/${skill}${firstLine ? ` ${firstLine}` : ''}`
    : firstLine;
  const refNumber = titleRefNumber(refineTaskRefs(extractTaskRefs(task), skill));
  // `469` or `/om-auto-review-pr 469` reads as `469: /om-auto-review-pr` — the
  // number leads so it survives the tasks table's narrow truncation.
  const skillArg = skill && contextual.startsWith(`/${skill}`) ? contextual.slice(skill.length + 1).trim() : null;
  const body = refNumber !== undefined && skill && (skillArg === '' || /^#?\d+$/.test(skillArg ?? ''))
    ? `/${skill}`
    : contextual;
  const prefixed =
    refNumber !== undefined && !body.trimStart().replace(/^#/, '').startsWith(String(refNumber))
      ? `${refNumber}: ${body}`
      : body;
  const chars = [...(prefixed || '(untitled task)')];
  return chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : chars.join('');
}

/** Skill identity is context, while the Markdown body remains instructions. */
export function skillSystemPrompt(skill: Pick<Skill, 'name' | 'description' | 'body'>): string {
  return [
    `Selected skill: /${skill.name}`,
    ...(skill.description ? [`Description: ${skill.description}`] : []),
    '',
    'Skill instructions:',
    skill.body.trim(),
  ].join('\n');
}
