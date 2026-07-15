import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.js';

/** A minimal pre-#389 record, exactly as an old runs.json holds it — no
 *  titleSummary, no diffStat. Loading it must keep working (additive proof). */
const LEGACY_RUN = {
  id: 'legacy-1',
  title: 'fix the login bug',
  workflow: 'quick-task',
  task: 'fix the login bug',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
};

describe('RunStore — titleSummary + diffStat (#389)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips the new fields through runs.json', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 'fix the login bug',
      workflow: 'quick-task',
      task: 'fix the login bug',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateRun(run.id, {
      titleSummary: 'Catch AuthError in the login handler',
      diffStat: { adds: 10, dels: 2, files: 3 },
    });
    store.flush();

    const reopened = RunStore.open(dataDir);
    const loaded = reopened.getRun(run.id);
    expect(loaded?.titleSummary).toBe('Catch AuthError in the login handler');
    expect(loaded?.diffStat).toEqual({ adds: 10, dels: 2, files: 3 });
  });

  it('still loads an old runs.json that predates the fields', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    const store = RunStore.open(dataDir);
    const run = store.getRun('legacy-1');
    expect(run).toBeDefined();
    expect(run?.title).toBe('fix the login bug');
    expect(run?.titleSummary).toBeUndefined();
    expect(run?.diffStat).toBeUndefined();
  });

  it('updateRun fans the new fields out on the run channel (the SSE feed)', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const seen: Array<{ titleSummary?: string }> = [];
    store.on('run', (r: { titleSummary?: string }) => seen.push({ titleSummary: r.titleSummary }));
    store.updateRun(run.id, { titleSummary: 'A real summary of the turn' });
    expect(seen.at(-1)?.titleSummary).toBe('A real summary of the turn');
  });
});

describe('RunStore — PR auto-link only on real creation (#fake-pr)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const freshRun = () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    return { store, run };
  };

  it('does NOT adopt a PR URL the agent merely reviewed/referenced', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewed https://github.com/open-mercato/cezar/pull/1 — looks good, no changes needed.',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBeUndefined();
  });

  it('adopts a PR URL when the agent actually created one', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/42');
  });

  it('recognizes the raw `gh pr create` output form', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: '$ gh pr create --draft\nhttps://github.com/open-mercato/cezar/pull/7',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/7');
  });
});
