import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import { RunManager } from './run.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery vs the inbox ceiling (#471).
 *
 * `recover()` re-queues runs that were `queued` when the process died, rebuilding their
 * StartRunInput straight from the persisted record — the one path into the engine that does NOT
 * go through `startRun`. A run queued while `CEZ_FOLLOWUPS=1` and recovered after the flag was
 * dropped must not come back claiming it generates follow-ups: `execute()` gates the agent at
 * spawn time regardless, so the behavior was always safe, but the record would have kept
 * echoing `generateFollowups: true` for a run that produces none.
 *
 * These tests only exercise `recover()`'s bookkeeping — `maxParallel: 0` keeps the queue from
 * actually dispatching, so nothing spawns.
 */
describe('recover() and the follow-up ceiling (#471)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // maxParallel: 0 — recover() re-queues, the queue never drains, no agent is spawned.
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ maxParallel: 0 }),
      'utf8',
    );
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  /** A run left `queued` by a crash, with follow-ups on — what a pre-#471 install looks like. */
  const queuedRunWithFollowups = (): string =>
    store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      generateFollowups: true,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      workflowDef: {
        name: 'quick-task',
        description: 'x',
        source: 'built-in',
        steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
      },
    }).id;

  it('normalizes a recovered record to false when the inbox is off', async () => {
    delete process.env.CEZ_FOLLOWUPS;
    const id = queuedRunWithFollowups();
    expect(store.getRun(id)?.generateFollowups).toBe(true); // the pre-restart truth

    await new RunManager(store, repoRoot).recover();

    // The record must not keep claiming follow-ups it will never produce.
    expect(store.getRun(id)?.generateFollowups).toBe(false);
    expect(store.getRun(id)?.status).toBe('queued'); // still recovered, just honest
  });

  it('leaves the record alone when the inbox is on', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const id = queuedRunWithFollowups();

    await new RunManager(store, repoRoot).recover();

    expect(store.getRun(id)?.generateFollowups).toBe(true);
  });

  it('does not resurrect an explicit per-run opt-out', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const id = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it quietly',
      generateFollowups: false,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      workflowDef: {
        name: 'quick-task',
        description: 'x',
        source: 'built-in',
        steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
      },
    }).id;

    await new RunManager(store, repoRoot).recover();

    expect(store.getRun(id)?.generateFollowups).toBe(false);
  });
});
