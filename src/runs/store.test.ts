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

  it('spots creation reported through a v2 tool item (nested under `item`)', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        toolKind: 'execute',
        title: 'Ran gh pr create',
        status: 'completed',
        input: { command: 'gh pr create --draft --title "fix"' },
        output: 'https://github.com/open-mercato/cezar/pull/9',
      },
    });
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/9');
  });
});

describe('RunStore — referenced-PR discovery (#407, spec 2026-07-16-pr-autodiscovery)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const freshRun = (task = 'task') => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    return { store, run };
  };

  it('adopts the referenced tier for a reviewed PR — without touching the created tier', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewed https://github.com/open-mercato/cezar/pull/1 — looks good.',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBeUndefined();
    expect(loaded?.referencedPullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/1');
  });

  it('sees PR URLs nested in v2 message items', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        text: 'Working on https://github.com/open-mercato/cezar/pull/4170 now.',
      },
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/4170',
    );
  });

  it('ignores reasoning items — thinking text speculates about PRs it never touches', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'reasoning',
        id: 'r1',
        text: 'Maybe similar to https://github.com/open-mercato/cezar/pull/99?',
      },
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('clears the referenced tier when a second distinct PR makes the subject ambiguous', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/1',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/1',
    );
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Also related: https://github.com/open-mercato/cezar/pull/2',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('disambiguates several referenced PRs by the number named in the task prompt', () => {
    const { store, run } = freshRun('om-auto-review-pr 4170');
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Reviewing https://github.com/open-mercato/cezar/pull/4170; it supersedes https://github.com/open-mercato/cezar/pull/12.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/4170',
    );
  });

  it('disambiguates by a PR number the prompt names as a pasted URL, not just a bare number', () => {
    const { store, run } = freshRun('review https://github.com/open-mercato/cezar/pull/3777 please');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'It supersedes https://github.com/open-mercato/cezar/pull/12.',
    });
    // Two candidates now (3777 seeded from the prompt, 12 from the event); the
    // prompt names 3777 even though it only appears inside the URL path.
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/3777',
    );
  });

  it('does not treat a substring of a longer number as a prompt match', () => {
    const { store, run } = freshRun('om-auto-review-pr 4170');
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'https://github.com/open-mercato/cezar/pull/170 and https://github.com/open-mercato/cezar/pull/70',
    });
    // Neither 170 nor 70 is named (only "4170" is in the prompt) → ambiguous.
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('the created tier still wins and stops discovery', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42',
    });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Compare with https://github.com/open-mercato/cezar/pull/50',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/42');
    expect(loaded?.referencedPullRequestUrl).toBeUndefined();
  });

  it('seeds the referenced tier from a PR URL pasted into the task prompt', () => {
    const { store, run } = freshRun('review https://github.com/open-mercato/cezar/pull/3777 please');
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/3777',
    );
  });

  it('round-trips the new fields through runs.json and keeps loading old files', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/1',
    });
    store.flush();
    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/1',
    );
    expect(reopened.getRun(run.id)?.referencedPrCandidates).toEqual([
      'https://github.com/open-mercato/cezar/pull/1',
    ]);
    // legacy record without the fields still parses (see LEGACY_RUN above)
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    const legacyStore = RunStore.open(dataDir);
    expect(legacyStore.getRun('legacy-1')?.referencedPullRequestUrl).toBeUndefined();
  });
});
