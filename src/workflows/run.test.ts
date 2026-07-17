import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import { RunManager } from './run.js';
import type { WorkflowDef } from './types.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const TURN_TEXT =
  "I'll catch the AuthError in the login handler so wrong passwords answer 401.\n\nDetails follow.";

/**
 * Turn-end bookkeeping (#389, task auto-naming spec) against a REAL fixture
 * repo: `recordTurnEnd` is the exact method both agent-event paths fire on
 * `turn-end`, driven directly here because a live agent session is the only
 * other way to reach it. CEZ_AUTONAME=0 keeps the namer (an LLM call) out of
 * these fixtures — titles are ONLY ever namer-owned or user-owned now, never
 * derived from turn text.
 */
describe('RunManager.recordTurnEnd', () => {
  const savedAutoname = process.env.CEZ_AUTONAME;
  beforeAll(() => {
    process.env.CEZ_AUTONAME = '0';
  });
  afterAll(() => {
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });
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

  it('computes a real diffStat and never derives a title from turn text', async () => {
    const record = await makeWorktreeRun();
    await manager.recordTurnEnd(record.id, TURN_TEXT);

    const after = store.getRun(record.id);
    // The agent's words are not a title source (they produced "Reading the
    // handoff…"-class titles) — naming is the namer's job, or the user's.
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });

    // Second turn: the diff stat keeps refreshing.
    writeFileSync(join(store.getRun(record.id)!.worktreePath!, 'more.txt'), 'z\n');
    await manager.recordTurnEnd(record.id, 'Now I rewrote everything from scratch with a different approach.');
    const later = store.getRun(record.id);
    expect(later?.titleSummary).toBeUndefined();
    expect(later?.diffStat).toEqual({ adds: 4, dels: 1, files: 3 });
  });

  it('never overwrites a user-edited title (PATCH sets titleSummary too)', async () => {
    const record = await makeWorktreeRun();
    // What PATCH /api/runs/:id does on a rename:
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await manager.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.titleSummary).toBe('My name');
  });

  it('skips diffStat for a worktree-less run, and never throws', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'do the thing', steps: [] });
    await expect(manager.recordTurnEnd(record.id, TURN_TEXT)).resolves.toBeUndefined();
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toBeUndefined();
  });

  it('is a quiet no-op for an unknown run', async () => {
    await expect(manager.recordTurnEnd('nope', TURN_TEXT)).resolves.toBeUndefined();
  });
});

/**
 * `continueRun` runner/model override (#401): the follow-up composer can pick which backend and
 * model reopen the session. The override is persisted as the run's current backend BEFORE the
 * continuation is scheduled (so `runContinuation` reads it off the record); omitted fields
 * preserve the run's current choice. We stub the private continuation so no live session
 * starts — the assertion is only the synchronous record persistence.
 */
describe('RunManager.continueRun override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    // No live agent — we only assert the synchronous persistence continueRun does before it
    // hands off to the (stubbed) continuation.
    (manager as unknown as { runContinuation: () => Promise<void> }).runContinuation = async () => {};
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a resumable session on the `claude`/`sonnet` backend. */
  function resumableRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'sonnet',
      steps: [{ id: 's1', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    return record.id;
  }

  it('persists a runner + model override as the run current backend', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { runner: 'codex', model: 'gpt-5.1-codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBe('gpt-5.1-codex');
  });

  it('an omitted override preserves the run current backend/model (backward compat)', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('claude');
    expect(after?.model).toBe('sonnet');
  });

  it("an empty model clears the pin so the runner picks the model (auto)", () => {
    const id = resumableRun();
    manager.continueRun(id, { model: '' });
    expect(store.getRun(id)?.model).toBeUndefined();
    // Runner untouched → the run keeps its backend.
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it("rejects a model that is recognizably another runner's preset (no corruption persisted)", () => {
    const id = resumableRun();
    // The review's corruption case (#401): a codex preset landing on a claude continuation.
    const result = manager.continueRun(id, { model: 'gpt-5.1-codex' });
    expect(result).toEqual({ ok: false, error: "model 'gpt-5.1-codex' is not a claude model" });
    expect(store.getRun(id)?.model).toBe('sonnet');
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it('guards legacy records too — no persisted runner resolves to claude, like runContinuation', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 's1', name: 'Work', kind: 'agent' }] });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    const result = manager.continueRun(record.id, { model: 'gpt-5.1-codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.model).toBeUndefined();
  });

  it('keeps free-form model ids working — only cross-runner presets are rejected', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { model: 'my-custom-alias' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('my-custom-alias');
  });

  it('refuses to continue a run with no resumable session (no override persisted)', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [] });
    store.updateRun(record.id, { status: 'done' });
    const result = manager.continueRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.runner).toBe('claude');
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
    // ran, in order, holding the head of that step's userText.
    //
    // Assert only on the note's opening sentence: it proves the guard reached
    // the right step's prompt with the right numbering, and stays inside the
    // mock's fixed userText slice however the wording grows later. The note's
    // full text is pinned in `test/unit/workflow-types.test.ts`.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('you are running step 1 of 2');
    expect(notes[1]).toContain('you are running step 2 of 2');
  }, 30_000);
});

/**
 * The other half of #410's contract: the note exists to explain a step
 * boundary, so a workflow with only ONE agent step must not get it — its
 * prompt stays exactly what the author wrote. Check steps are shell commands,
 * not sessions, so they don't make a chain no matter how many surround the
 * agent step. This is the README's canonical `implement` + `verify` shape, the
 * one most user workflows are built from, and the note's first cut fired on
 * all of them (`steps.length` counted the check) — telling a lone step that
 * "an earlier step" may have reported its work done, when there was none.
 */
describe('a single agent step plus a check step gets NO chain note (#410)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-410-single-'));
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

  it("leaves the lone agent step's prompt untouched", async () => {
    // README.md's documented workflow, with a check that passes so the run
    // reaches a terminal state without looping back.
    const workflow: WorkflowDef = {
      name: 'implement-verify',
      source: 'file',
      steps: [
        { id: 'implement', skill: 'project-conventions', prompt: '{{task}}' },
        { id: 'verify', command: 'true', onFail: { retry: 'implement', max: 2 } },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done fix the login bug', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(store.getRun(record.id)?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'implement', status: 'done' },
      { id: 'verify', status: 'done' },
    ]);

    // One session ran, and its userText is the task text alone — no chain
    // note, no "an earlier step" premise, no skill named as the step's goal.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('mock:done fix the login bug');
    expect(notes[0]).not.toContain('chain of');
    expect(notes[0]).not.toContain('earlier step');
    expect(notes[0]).not.toContain('project-conventions');
  }, 30_000);
});
