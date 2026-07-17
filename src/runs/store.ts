import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: z.enum(['pending', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled', 'skipped']),
  iterations: z.number(),
  tokensUsed: z.number(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Latest claude session id — the user can `claude --resume <id>` with it. */
  sessionId: z.string().optional(),
  /** Dollar cost reported by the claude CLI for this step's turns. */
  costUsd: z.number().optional(),
});

const runRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display title (#389): the auto-derived summary of the first agent turn,
   *  or the user's inline edit (`PATCH /api/runs/:id` sets it together with
   *  `title` so edits always win). The UI shows `titleSummary ?? title`. */
  titleSummary: z.string().optional(),
  /** `git diff --shortstat` of the worktree vs its base, refreshed on every
   *  turn-end (#389) — what the quick list / table shows without a git call. */
  diffStat: z
    .object({ adds: z.number(), dels: z.number(), files: z.number() })
    .optional(),
  workflow: z.string(),
  task: z.string(),
  /** URLs of images attached to the initial task prompt, for the thread's first bubble
   *  (#image-display) — persisted like agent screenshots, served from `/images/`. */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Agent backend this run used — drives "open in CLI" resume command. */
  runner: z.enum(['claude', 'codex', 'opencode']).optional(),
  /** Echo of the extra system prompt this run actually used (R2): the
   *  `POST /api/runs` override, or the `config.json` default it fell back to.
   *  Deliberately NOT the full composed prompt — skill bodies and the handoff
   *  contract are derivable from the persisted workflow and would bloat the
   *  index. Resolved at execute time (a queued run picks up config edits). */
  systemPrompt: z.string().optional(),
  /** Per-task follow-up inbox contract (spec 007, #444). Missing on old runs
   *  means enabled — the historical behavior. */
  generateFollowups: z.boolean().optional(),
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  costUsd: z.number().optional(),
  /** First GitHub PR URL spotted in the transcript (the janitor trick). */
  pullRequestUrl: z.string().optional(),
  /** The PR this task is ABOUT (#407, spec 2026-07-16-pr-autodiscovery):
   *  auto-discovered from conversation references for tasks that work on an
   *  existing PR (review/continue/merge). Display-only tier — `pullRequestUrl`
   *  (the PR this task CREATED) always wins, and action gates ignore this. */
  referencedPullRequestUrl: z.string().optional(),
  /** The PR/issue number this task is ABOUT (spec 2026-07-17-task-auto-naming):
   *  regex-extracted from the task prompt, upgradable by the namer's
   *  cross-checked output. Display tier — never gates actions. */
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  /** Who owns the display title: `user` (PATCH rename — never auto-overwritten)
   *  or `auto` (namer-owned — a later namer result may replace it). Missing on
   *  old runs = legacy behavior (auto fills only an unset titleSummary). */
  titleOrigin: z.enum(['user', 'auto']).optional(),
  /** Distinct PR URLs spotted so far — the referenced tier's working set,
   *  persisted so a resumed run keeps disambiguating against the full history
   *  instead of re-adopting the next URL as "the only one". Capped. */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** Task worktree (spec 006) — absent when the run executed in the repo root. */
  worktreePath: z.string().optional(),
  /** The task's own branch (`cez/<id8>`), created off `baseBranch`. */
  branch: z.string().optional(),
  /** Branch (or commit, when HEAD was detached) the worktree was forked from. */
  baseBranch: z.string().optional(),
  /** Parallel variants (spec 010): tasks sharing a groupId are one group. */
  groupId: z.string().optional(),
  /** Variant letter within the group — 'A' | 'B' | 'C' (kept as a string). */
  variant: z.string().optional(),
  /** Peak resident memory (bytes) / process count observed across the run's
   *  agent process trees (#348) — written when a session's telemetry ends.
   *  Optional: old runs.json files and `ps`-less platforms have neither. */
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  archived: z.boolean().default(false),
  archivedAt: z.string().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
  /** Full workflow definition, persisted so a `queued` run can be re-enqueued
   *  after a restart (#367) — including ad-hoc "(planned)" chains that exist
   *  nowhere else. Kept loose here to avoid an upward import; the run manager
   *  validates the shape before reviving it. */
  workflowDef: z.record(z.string(), z.unknown()).optional(),
});

export type StepState = z.infer<typeof stepStateSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

/** One persisted event line; `type` mirrors AgentEvent plus engine lifecycle. */
export interface RunEvent {
  seq: number;
  ts: string;
  stepId?: string;
  type: string;
  [key: string]: unknown;
}

const MAX_RUNS_KEPT = 300;
const MAX_ARCHIVED_KEPT = 500;

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
// The transcript auto-link is convenience only (the cockpit's own `gh pr create` path sets the
// URL authoritatively). Adopt a PR URL ONLY when the agent actually CREATED one — a task that
// reviews or merely references an existing PR must not get mislabeled with its number (#fake-pr).
const CREATED_PR_RE =
  /\b(?:gh\s+pr\s+create|pull\s*request\s+created|created\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull\s*request)|opened\s+(?:a\s+)?(?:draft\s+)?pull\s*request)\b/i;

/** Referenced-tier working-set cap (spec 2026-07-16-pr-autodiscovery): past
 *  this many distinct PRs the conversation is a survey, not a subject. */
const MAX_PR_CANDIDATES = 8;

/**
 * Every scannable string of one persisted event: the v1 top-level fields plus
 * the protocol-v2 `item.*` content (nested — the reason v2 streams were
 * invisible to the janitor, #407). Reasoning items are skipped: thinking text
 * speculates about PRs the task never touches.
 */
function eventTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result', 'message'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object' && (item as Record<string, unknown>).kind !== 'reasoning') {
    const it = item as Record<string, unknown>;
    for (const key of ['text', 'title', 'output'] as const) {
      const value = it[key];
      if (typeof value === 'string') fragments.push(value);
    }
    if (typeof it.input === 'string') {
      fragments.push(it.input);
    } else if (it.input !== undefined) {
      try {
        fragments.push(JSON.stringify(it.input));
      } catch {
        // circular input — skip it
      }
    }
  }
  return fragments;
}

/**
 * The referenced tier's resolution rule: one distinct URL is the subject;
 * among several, the one whose PR number the task prompt names (and only when
 * exactly one matches); otherwise ambiguous — no chip beats a wrong chip.
 */
function resolveReferencedPr(candidates: string[], task: string): string | undefined {
  if (candidates.length === 1) return candidates[0];
  const named = candidates.filter((url) => {
    const num = url.split('/').pop() ?? '';
    // `\d` boundaries only: they reject `170` inside `4170` yet still match a
    // number written as `#4170`, ` 4170`, or inside a pasted `…/pull/4170`.
    return num !== '' && new RegExp(`(?<!\\d)#?${num}(?!\\d)`).test(task);
  });
  return named.length === 1 ? named[0] : undefined;
}

/**
 * File-backed run store: `runs.json` index (atomic tmp+rename writes, the
 * pattern from @cezar/core's IssueStore) plus one append-only NDJSON event
 * file per run. Also the in-process event bus the SSE endpoints subscribe to:
 * emits `('run', RunRecord)` and `('event', { runId, event: RunEvent })`.
 */
export class RunStore extends EventEmitter {
  private runs = new Map<string, RunRecord>();
  private saveTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly dataDir: string) {
    super();
    this.setMaxListeners(100);
  }

  /**
   * `keepLive` (#367): leave `queued`/`running`/`waiting` statuses untouched
   * so the caller can recover them (RunManager.recover re-queues queued runs,
   * resumes interrupted ones). Without it — one-shot CLI paths that never
   * recover — live-looking runs are marked failed so no ghost stays behind.
   */
  static open(dataDir: string, opts?: { keepLive?: boolean }): RunStore {
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const store = new RunStore(dataDir);
    const indexPath = join(dataDir, 'runs.json');
    if (existsSync(indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
        const parsed = z.array(runRecordSchema).safeParse(raw);
        if (parsed.success) {
          for (const run of parsed.data) {
            // A run that was live when the previous process exited can never
            // finish — surface that instead of a forever-"running" ghost.
            // `review` survives restarts on purpose: the gate is pure data
            // (worktree + branch + record) with no live process, so the diff
            // panel, Send back (resume) and Draft PR all still work.
            if (
              !opts?.keepLive &&
              (run.status === 'running' ||
                run.status === 'queued' ||
                run.status === 'waiting')
            ) {
              run.status = 'failed';
              run.error = 'interrupted — cezar process exited during the run';
              run.finishedAt = run.finishedAt ?? new Date().toISOString();
              for (const step of run.steps) {
                if (step.status === 'running' || step.status === 'waiting') step.status = 'failed';
              }
            }
            store.runs.set(run.id, run);
          }
        }
      } catch {
        // corrupt index — start fresh; event files stay on disk untouched
      }
    }
    return store;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  createRun(input: {
    title: string;
    workflow: string;
    task: string;
    model?: string;
    runner?: 'claude' | 'codex' | 'opencode';
    generateFollowups?: boolean;
    groupId?: string;
    variant?: string;
    steps: Array<Pick<StepState, 'id' | 'name' | 'kind'>>;
  }): RunRecord {
    const run: RunRecord = {
      id: randomUUID(),
      title: input.title,
      workflow: input.workflow,
      task: input.task,
      model: input.model,
      runner: input.runner,
      generateFollowups: input.generateFollowups,
      groupId: input.groupId,
      variant: input.variant,
      status: 'queued',
      createdAt: new Date().toISOString(),
      tokensUsed: 0,
      archived: false,
      steps: input.steps.map((s) => ({
        ...s,
        status: 'pending',
        iterations: 0,
        tokensUsed: 0,
      })),
    };
    // A prompt that pastes a PR URL is already about that PR — seed the
    // referenced tier so the chip exists before the first event (#407).
    this.trackReferencedPrs(run, input.task);
    this.runs.set(run.id, run);
    this.pruneOldRuns();
    this.touch(run);
    return run;
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'steps'>>): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    Object.assign(run, patch);
    this.touch(run);
    return run;
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind'>): void {
    const run = this.runs.get(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    run.steps.push({ ...step, status: 'pending', iterations: 0, tokensUsed: 0 });
    this.touch(run);
  }

  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.runs.get(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    Object.assign(step, patch);
    run.tokensUsed = run.steps.reduce((sum, s) => sum + s.tokensUsed, 0);
    const cost = run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    run.costUsd = cost > 0 ? cost : undefined;
    this.touch(run);
  }

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.archived = archived;
    run.archivedAt = archived ? new Date().toISOString() : undefined;
    this.touch(run);
    return run;
  }

  /** Bulk-archive every finished run; returns how many were archived. */
  archiveFinished(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!run.archived && ['done', 'failed', 'cancelled'].includes(run.status)) {
        run.archived = true;
        run.archivedAt = new Date().toISOString();
        this.touch(run);
        count++;
      }
    }
    return count;
  }

  appendEvent(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const seq = this.nextSeq(runId);
    const full: RunEvent = { ...event, seq, ts: new Date().toISOString() };
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    appendFileSync(this.eventsPath(runId), `${JSON.stringify(full)}\n`, 'utf8');
    this.emit('event', { runId, event: full });

    // The janitor trick: agents print the PR URL after `gh pr create` — the
    // first one spotted in the transcript becomes the run's PR link. Scans v1
    // fields AND nested v2 `item.*` content (#407). A URL without the created
    // phrasing still feeds the referenced tier (the PR the task is about).
    if (!run.pullRequestUrl) {
      const haystack = eventTextFragments(full).join(' ');
      if (haystack.length > 0) {
        const match = PR_URL_RE.exec(haystack);
        if (match && CREATED_PR_RE.test(haystack)) {
          this.updateRun(runId, { pullRequestUrl: match[0] });
        } else if (match && this.trackReferencedPrs(run, haystack)) {
          this.touch(run);
        }
      }
    }
    return full;
  }

  /**
   * Fold every PR URL in `haystack` into the run's referenced-tier working
   * set and re-resolve `referencedPullRequestUrl` (spec
   * 2026-07-16-pr-autodiscovery). Mutates the record in place — the caller
   * owns persistence/fan-out — and reports whether anything changed.
   */
  private trackReferencedPrs(run: RunRecord, haystack: string): boolean {
    const seen = new Set(run.referencedPrCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    if (seen.size === before) return false;
    run.referencedPrCandidates = [...seen];
    run.referencedPullRequestUrl = resolveReferencedPr(run.referencedPrCandidates, run.task);
    return true;
  }

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis; the seq simply never appears in a replay
   * (gaps are fine — dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const full: RunEvent = { ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() };
    this.emit('event', { runId, event: full });
    return full;
  }

  readEvents(runId: string): RunEvent[] {
    try {
      const raw = readFileSync(this.eventsPath(runId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as RunEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is RunEvent => e !== null);
    } catch {
      return [];
    }
  }

  deleteRun(id: string): boolean {
    const existed = this.runs.delete(id);
    if (existed) {
      try {
        rmSync(this.eventsPath(id), { force: true });
        rmSync(this.handoffPath(id), { force: true }); // spec 007: the journal goes with the task
        rmSync(this.imagesDir(id), { recursive: true, force: true }); // agent screenshots
      } catch {
        // best effort — the index is authoritative
      }
      this.seqs.delete(id);
      this.scheduleSave();
      this.emit('deleted', id);
    }
    return existed;
  }

  /** Write the index out now (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? this.rehydrateSeq(runId)) + 1;
    this.seqs.set(runId, next);
    return next;
  }

  /** After a restart the in-memory counter is empty while the run's NDJSON file
   *  keeps the history. Restarting from 1 would collide with the seqs a client
   *  already replayed — its `seq > maxSeq` dedup then silently drops every
   *  resumed event, even across a reload (the frozen-transcript symptom class
   *  of #424). One file read on the first post-restart append per run. */
  private rehydrateSeq(runId: string): number {
    let max = 0;
    for (const event of this.readEvents(runId)) {
      if (typeof event.seq === 'number' && event.seq > max) max = event.seq;
    }
    return max;
  }

  private eventsPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.ndjson`);
  }

  /** Same location `handoffPath()` in handoff.ts produces — inlined to keep
   *  the store free of upward imports. */
  private handoffPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.handoff.md`);
  }

  /** Agent screenshots persisted by the run manager (see persistImage). */
  private imagesDir(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}-images`);
  }

  private touch(run: RunRecord): void {
    this.scheduleSave();
    this.emit('run', run);
  }

  private pruneOldRuns(): void {
    const all = this.listRuns();
    const stalePool = [
      ...all.filter((r) => !r.archived).slice(MAX_RUNS_KEPT),
      ...all.filter((r) => r.archived).slice(MAX_ARCHIVED_KEPT),
    ];
    for (const stale of stalePool) {
      this.runs.delete(stale.id);
      try {
        rmSync(this.eventsPath(stale.id), { force: true });
        rmSync(this.handoffPath(stale.id), { force: true });
        rmSync(this.imagesDir(stale.id), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  /** Debounced so token-usage updates don't rewrite the index per event. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    const indexPath = join(this.dataDir, 'runs.json');
    const tmpPath = `${indexPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.listRuns(), null, 2), 'utf8');
      renameSync(tmpPath, indexPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cez] failed to save runs.json: ${message}`);
    }
  }
}
