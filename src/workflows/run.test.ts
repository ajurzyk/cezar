import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import { RunManager } from './run.js';
import type { WorkflowDef } from './types.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const TURN_TEXT =
  "I'll catch the AuthError in the login handler so wrong passwords answer 401.\n\nDetails follow.";

/**
 * Turn-end bookkeeping (#389) against a REAL fixture repo: `recordTurnEnd` is
 * the exact method both agent-event paths fire on `turn-end`, driven directly
 * here because a live agent session is the only other way to reach it.
 */
describe('RunManager.recordTurnEnd', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-turnend-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run with a real worktree forked off main, holding an edit + a new file. */
  async function makeWorktreeRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 'fix the login bug', workflow: 'quick-task', task: 'fix the login bug', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n'); // 1 add, 1 del
    writeFileSync(join(wt.path, 'new.txt'), 'x\ny\n'); // 2 adds, untracked
    return store.getRun(record.id) as RunRecord;
  }

  it('sets titleSummary once and computes a real diffStat', async () => {
    const record = await makeWorktreeRun();
    await manager.recordTurnEnd(record.id, TURN_TEXT);

    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('Catch the AuthError in the login handler so wrong passwords answer 401');
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });

    // Second turn: the summary is set ONCE; the diff stat keeps refreshing.
    writeFileSync(join(store.getRun(record.id)!.worktreePath!, 'more.txt'), 'z\n');
    await manager.recordTurnEnd(record.id, 'Now I rewrote everything from scratch with a different approach.');
    const later = store.getRun(record.id);
    expect(later?.titleSummary).toBe('Catch the AuthError in the login handler so wrong passwords answer 401');
    expect(later?.diffStat).toEqual({ adds: 4, dels: 1, files: 3 });
  });

  it('never overwrites a user-edited title (PATCH sets titleSummary too)', async () => {
    const record = await makeWorktreeRun();
    // What PATCH /api/runs/:id does on a rename:
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name' });
    await manager.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.titleSummary).toBe('My name');
  });

  it('leaves titleSummary unset when the turn text is uninformative', async () => {
    const record = await makeWorktreeRun();
    await manager.recordTurnEnd(record.id, 'Done.');
    expect(store.getRun(record.id)?.titleSummary).toBeUndefined();
    // …so a later, better turn can still claim it.
    await manager.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.titleSummary).toBe('Catch the AuthError in the login handler so wrong passwords answer 401');
  });

  it('skips diffStat (but not titleSummary) for a worktree-less run, and never throws', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'do the thing', steps: [] });
    await expect(manager.recordTurnEnd(record.id, TURN_TEXT)).resolves.toBeUndefined();
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('Catch the AuthError in the login handler so wrong passwords answer 401');
    expect(after?.diffStat).toBeUndefined();
  });

  it('is a quiet no-op for an unknown run', async () => {
    await expect(manager.recordTurnEnd('nope', TURN_TEXT)).resolves.toBeUndefined();
  });
});

/**
 * Regression for #410: the GitHub tab's "Hand over" panel lets a user select
 * several skills at once, which become one agent step per skill (spec 008 —
 * `skillChainSteps` / `skillsToSteps`) in a single run. The reported bug was
 * that only the FIRST selected skill actually did anything — the run finished
 * right after it, with the second skill's step marked `done` despite never
 * doing real work. It wasn't dropped when the step list was built (both steps
 * are present and the engine's loop does iterate over both, proven below);
 * the root cause was that every step got the identical task text and shared
 * one run-level handoff journal, so the LAST step's fresh session — the only
 * one that honors `CEZ:DONE` as an early-completion signal — could read an
 * earlier step's own "done" report and conclude the whole run was already
 * finished, ending its first turn with the marker before doing its own
 * step's work. The fix (`chainStepNote`, `workflows/types.ts`) tells every
 * step of a chain which position it holds and that an earlier step's
 * completion isn't its own — this end-to-end run proves both effects: both
 * steps really execute (their mock sessions both leave a trace in the
 * worktree), and the note text actually reaches the second step's prompt.
 */
describe('a chain of 2 selected skills runs BOTH steps, in order (#410)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-410-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('runs both skill steps to completion, and the second step\'s prompt carries the chain guard', async () => {
    // Exactly the shape `githubRunBody` / `skillChainSteps` build for 2
    // selected skills: one agent step per skill, every step's prompt just
    // `{{task}}` — no per-step differentiation from the GUI side.
    const workflow: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [
        { id: 'om-auto-review-pr', name: 'om-auto-review-pr', skill: 'om-auto-review-pr', prompt: '{{task}}' },
        { id: 'om-auto-verify-pr-ui', name: 'om-auto-verify-pr-ui', skill: 'om-auto-verify-pr-ui', prompt: '{{task}}' },
      ],
    };
    // `mock:done` makes the mock's turn end with CEZ:DONE — needed so the
    // last (interactive) step closes itself and the run reaches a terminal
    // status instead of parking at `waiting` for a real reply.
    const record = manager.startRun(workflow, { task: 'mock:done fix the PR', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }

    const finished = store.getRun(record.id);
    // Neither step failed or was skipped — the reported bug looked exactly
    // like this from the RunRecord's point of view (both `done`) while the
    // second step's session had done nothing; the assertion below on
    // `notes.md` is what actually distinguishes a real run from a no-op one.
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'om-auto-review-pr', status: 'done' },
      { id: 'om-auto-verify-pr-ui', status: 'done' },
    ]);

    // The mock leaves a `notes.md` trace on its first turn, once per spawned
    // session (`scripts/mock-claude.mjs`) — one line per step that actually
    // ran, in order, first 100 chars of that step's userText.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('step 1 of 2');
    expect(notes[0]).toContain('om-auto-review-pr');
    expect(notes[1]).toContain('step 2 of 2');
    expect(notes[1]).toContain('om-auto-verify-pr-ui');
    // The whole point of the fix: the second step's prompt explicitly says an
    // earlier step's own completion doesn't cover this step's work.
    expect(notes[1]).toContain("An earlier step's completion does not mean your step's work is done");
  }, 30_000);
});
