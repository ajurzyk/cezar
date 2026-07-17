import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import { RunManager } from './run.js';

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
