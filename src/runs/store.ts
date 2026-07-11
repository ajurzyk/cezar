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
  workflow: z.string(),
  task: z.string(),
  model: z.string().optional(),
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  costUsd: z.number().optional(),
  /** First GitHub PR URL spotted in the transcript (the janitor trick). */
  pullRequestUrl: z.string().optional(),
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
  archived: z.boolean().default(false),
  archivedAt: z.string().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
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

  static open(dataDir: string): RunStore {
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
              run.status === 'running' ||
              run.status === 'queued' ||
              run.status === 'waiting'
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
    // first one spotted in the transcript becomes the run's PR link.
    if (!run.pullRequestUrl) {
      const haystack = [full.text, full.result, full.message]
        .filter((s): s is string => typeof s === 'string')
        .join(' ');
      const match = PR_URL_RE.exec(haystack);
      if (match) this.updateRun(runId, { pullRequestUrl: match[0] });
    }
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
    const next = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, next);
    return next;
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
