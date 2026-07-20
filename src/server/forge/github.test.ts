import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so `execFileMock` exists before the (hoisted) vi.mock factory runs. `gh()` builds
// its subprocess runner from `promisify(execFile)` at module load, so the availability-probe tests
// below drive `gh repo view` entirely through this mock — no real `gh` on the box. Everything else
// in this file is pure and never touches child_process, so the default passthrough is harmless.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  execFileMock.mockImplementation((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  __clearCommentsCacheForTests,
  detectGithubCached,
  fetchCommentCounts,
  fetchGithub,
  fetchGithubComments,
  ghCheckRunSchema,
  mergeThread,
  normalizeComments,
  normalizeReviews,
  parseCountsPage,
  parseOwnerName,
  rollupToChecks,
  THREAD_ENTRY_CAP,
} from './github.js';
import type { ForgeComment } from './types.js';

/** `rollupToChecks` collapses a `gh … --json statusCheckRollup` array — already zod-validated
 *  via `ghCheckRunSchema` at the call site — down to the single enum the GitHub tab renders,
 *  both on PR rows (#400) and in the detail pane's `ChecksBadge`. */

describe('ghCheckRunSchema', () => {
  it('accepts a real gh rollup entry (conclusion + status, no state)', () => {
    expect(ghCheckRunSchema.parse({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toEqual({
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      state: undefined,
    });
  });

  it('accepts a check-context style entry (state, no status/conclusion)', () => {
    expect(ghCheckRunSchema.parse({ state: 'PENDING' })).toEqual({
      state: 'PENDING',
      status: undefined,
      conclusion: undefined,
    });
  });

  it('accepts nulls for every field — gh omits fields depending on the check provider', () => {
    expect(ghCheckRunSchema.parse({ state: null, status: null, conclusion: null })).toEqual({
      state: null,
      status: null,
      conclusion: null,
    });
  });

  it('rejects a non-object entry', () => {
    expect(() => ghCheckRunSchema.parse('SUCCESS')).toThrow();
  });
});

describe('rollupToChecks', () => {
  it('returns null when the rollup is absent, null, or empty', () => {
    expect(rollupToChecks(undefined)).toBeNull();
    expect(rollupToChecks(null)).toBeNull();
    expect(rollupToChecks([])).toBeNull();
  });

  it('returns "passing" when every entry concluded SUCCESS', () => {
    expect(
      rollupToChecks([
        { conclusion: 'SUCCESS', status: 'COMPLETED', state: null },
        { conclusion: 'SUCCESS', status: 'COMPLETED', state: null },
      ]),
    ).toBe('passing');
  });

  it.each(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'returns "failing" when any entry concluded %s, even alongside passing ones',
    (conclusion) => {
      expect(
        rollupToChecks([
          { conclusion: 'SUCCESS', status: null, state: null },
          { conclusion, status: null, state: null },
        ]),
      ).toBe('failing');
    },
  );

  it.each(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'])(
    'returns "pending" when any entry is still %s and none have failed',
    (status) => {
      expect(
        rollupToChecks([
          { conclusion: 'SUCCESS', status: null, state: null },
          { conclusion: null, status, state: null },
        ]),
      ).toBe('pending');
    },
  );

  it('failing wins over pending when both are present', () => {
    expect(
      rollupToChecks([
        { conclusion: null, status: 'IN_PROGRESS', state: null },
        { conclusion: 'FAILURE', status: null, state: null },
      ]),
    ).toBe('failing');
  });

  it('falls back through conclusion → state → status, then treats a blank as pending', () => {
    expect(rollupToChecks([{ conclusion: null, status: null, state: 'FAILURE' }])).toBe('failing');
    expect(rollupToChecks([{ conclusion: null, status: null, state: null }])).toBe('pending');
  });
});

/** Comment counts (#499 Phase 1): the GraphQL seam that replaces the hard-coded `comments: 0`.
 *  The `gh`-shelling is injected as a `GraphqlRunner`, so pagination, accumulation, the page cap,
 *  and the degrade-to-empty contract are all unit-testable without a real `gh`. */

const page = (
  root: 'issues' | 'pullRequests',
  nodes: Array<{ number: number; count: number }>,
  next: string | null,
): string =>
  JSON.stringify({
    data: {
      repository: {
        [root]: {
          nodes: nodes.map((n) => ({ number: n.number, comments: { totalCount: n.count } })),
          pageInfo: { hasNextPage: next !== null, endCursor: next },
        },
      },
    },
  });

describe('parseOwnerName', () => {
  it('splits a clean owner/name handle', () => {
    expect(parseOwnerName('open-mercato/cezar')).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(parseOwnerName('  open-mercato/cezar\n')).toEqual({ owner: 'open-mercato', name: 'cezar' });
  });

  it('returns null for anything that is not exactly two parts', () => {
    expect(parseOwnerName('')).toBeNull();
    expect(parseOwnerName('cezar')).toBeNull();
    expect(parseOwnerName('a/b/c')).toBeNull();
  });
});

describe('parseCountsPage', () => {
  it('flattens nodes into a number→count map and surfaces the cursor', () => {
    expect(parseCountsPage(page('issues', [{ number: 7, count: 3 }, { number: 9, count: 0 }], 'CUR'), 'issues')).toEqual({
      counts: { 7: 3, 9: 0 },
      hasNextPage: true,
      endCursor: 'CUR',
    });
  });

  it('normalizes a missing endCursor to null', () => {
    expect(parseCountsPage(page('pullRequests', [{ number: 1, count: 2 }], null), 'pullRequests')).toEqual({
      counts: { 1: 2 },
      hasNextPage: false,
      endCursor: null,
    });
  });

  it('throws on a malformed envelope (zod boundary)', () => {
    expect(() => parseCountsPage('{"data":{"repository":{"issues":{"nodes":"nope"}}}}', 'issues')).toThrow();
  });
});

describe('fetchCommentCounts', () => {
  it('returns per-kind maps for a single page each', async () => {
    // Distinguish issues vs PRs by the query text (contains `issues(` or `pullRequests(`).
    const runGraphql = vi.fn(async (q: string) =>
      q.includes('pullRequests(')
        ? page('pullRequests', [{ number: 10, count: 4 }], null)
        : page('issues', [{ number: 1, count: 2 }], null),
    );
    const counts = await fetchCommentCounts(runGraphql, 'o', 'n');
    expect(counts).toEqual({ issues: { 1: 2 }, prs: { 10: 4 } });
  });

  it('accumulates across pages and passes the endCursor forward', async () => {
    const issuePages = [page('issues', [{ number: 1, count: 1 }], 'C1'), page('issues', [{ number: 2, count: 2 }], null)];
    let issueCall = 0;
    const runGraphql = vi.fn(async (q: string, vars: Record<string, string>) => {
      if (q.includes('pullRequests(')) return page('pullRequests', [], null);
      // Page 1 must not carry a cursor; page 2 must forward 'C1'.
      if (issueCall === 0) expect(vars.endCursor).toBeUndefined();
      else expect(vars.endCursor).toBe('C1');
      return issuePages[issueCall++]!;
    });
    const counts = await fetchCommentCounts(runGraphql, 'o', 'n');
    expect(counts.issues).toEqual({ 1: 1, 2: 2 });
  });

  it('stops at the page cap even when hasNextPage never goes false', async () => {
    const runGraphql = vi.fn(async (q: string) =>
      q.includes('pullRequests(') ? page('pullRequests', [], null) : page('issues', [{ number: 1, count: 1 }], 'MORE'),
    );
    await fetchCommentCounts(runGraphql, 'o', 'n', 3);
    // 3 issue pages + 1 PR page (PR stops immediately with no next).
    const issueCalls = runGraphql.mock.calls.filter(([q]) => !q.includes('pullRequests(')).length;
    expect(issueCalls).toBe(3);
  });

  it('degrades to empty maps when the runner throws (never fails the tab)', async () => {
    const runGraphql = vi.fn(async () => {
      throw new Error('rate limited');
    });
    expect(await fetchCommentCounts(runGraphql, 'o', 'n')).toEqual({ issues: {}, prs: {} });
  });
});

/** Comment threads (#499 Phase 2): the pure normalize/merge seam behind
 *  `GET /api/github/comments/:kind/:number`. The `gh`-shelling in `fetchGithubComments` isn't
 *  unit-tested (it degrades on any failure and is covered by the route + component tests); the
 *  transforms below carry the real logic — review filtering, chronological merge, and caps. */

describe('normalizeComments', () => {
  it('maps gh issue-comment JSON into ForgeComment, capping the body and defaulting the author', () => {
    const [c] = normalizeComments([
      {
        id: 7,
        user: { login: 'ada', avatar_url: 'https://a/1.png' },
        created_at: '2026-07-01T00:00:00Z',
        body: 'hi',
        html_url: 'https://gh/1',
      },
    ]);
    expect(c).toEqual({
      id: 7,
      author: 'ada',
      avatarUrl: 'https://a/1.png',
      createdAt: '2026-07-01T00:00:00Z',
      body: 'hi',
      kind: 'comment',
      url: 'https://gh/1',
    });
  });

  it('falls back to "?" when gh omits the user and to "" for a null body', () => {
    const [c] = normalizeComments([{ id: 1, user: null, created_at: 't', body: null, html_url: 'u' }]);
    expect(c?.author).toBe('?');
    expect(c?.body).toBe('');
    expect(c?.avatarUrl).toBeUndefined();
  });

  it('slices an over-long body to 8 000 chars', () => {
    const [c] = normalizeComments([
      { id: 1, user: { login: 'x' }, created_at: 't', body: 'a'.repeat(9_000), html_url: 'u' },
    ]);
    expect(c?.body).toHaveLength(8_000);
  });
});

describe('normalizeReviews', () => {
  const review = (state: string, body: string | null) => ({
    id: 1,
    user: { login: 'rev' },
    body,
    state,
    submitted_at: '2026-07-02T00:00:00Z',
    html_url: 'https://gh/r',
  });

  it('keeps APPROVED / CHANGES_REQUESTED even with an empty body (the state is the signal)', () => {
    expect(normalizeReviews([review('APPROVED', '')])).toHaveLength(1);
    expect(normalizeReviews([review('CHANGES_REQUESTED', null)])).toHaveLength(1);
    expect(normalizeReviews([review('APPROVED', '')])[0]).toMatchObject({
      kind: 'review',
      reviewState: 'approved',
    });
  });

  it('drops empty-body COMMENTED and PENDING reviews (no signal in a flat thread)', () => {
    expect(normalizeReviews([review('COMMENTED', '  ')])).toHaveLength(0);
    expect(normalizeReviews([review('PENDING', '')])).toHaveLength(0);
  });

  it('keeps a COMMENTED review that carries a body', () => {
    const out = normalizeReviews([review('COMMENTED', 'a note')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'review', reviewState: 'commented', body: 'a note' });
  });
});

describe('mergeThread', () => {
  const at = (iso: string, over: Partial<ForgeComment> = {}): ForgeComment => ({
    id: 1,
    author: 'a',
    createdAt: iso,
    body: '',
    kind: 'comment',
    url: 'u',
    ...over,
  });

  it('merges lists and sorts oldest-first by createdAt', () => {
    const { comments, truncated } = mergeThread([
      [at('2026-07-03T00:00:00Z', { id: 3 })],
      [at('2026-07-01T00:00:00Z', { id: 1 }), at('2026-07-02T00:00:00Z', { id: 2 })],
    ]);
    expect(comments.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
  });

  it('caps at the entry limit and flags truncation', () => {
    const many = Array.from({ length: THREAD_ENTRY_CAP + 5 }, (_, i) =>
      at(`2026-07-01T00:00:${String(i).padStart(2, '0')}Z`, { id: i }),
    );
    const { comments, truncated } = mergeThread([many], THREAD_ENTRY_CAP);
    expect(comments).toHaveLength(THREAD_ENTRY_CAP);
    expect(truncated).toBe(true);
  });
});

/** Per-project cache isolation (multi-project workspace, step 2.6). Both in-process caches in
 *  this module — the 60 s list cache behind `fetchGithub` and the per-thread comments cache
 *  behind `fetchGithubComments` — used to be keyed process-globally, so within one TTL window
 *  project B was served project A's (possibly private) GitHub data. These regression tests drive
 *  `gh` entirely through `execFileMock`, answering by the subprocess `cwd` (= `repoRoot`), and
 *  assert one project's payload is NEVER served under another project's scope. */

/** Route every mocked `gh` invocation by argv + cwd. */
const ghByCwd = () =>
  execFileMock.mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const opts = args[2] as { cwd?: string } | undefined;
    const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
    const who = opts?.cwd?.includes('proj-b') ? 'b' : 'a';
    let stdout = '';
    if (argv[0] === 'repo') stdout = `owner/${who}\n`;
    else if (argv[0] === 'issue')
      stdout = JSON.stringify([
        {
          number: 1,
          title: `${who}-issue`,
          author: { login: who },
          createdAt: '2026-07-01T00:00:00Z',
          labels: [],
          body: `${who} body`,
          url: `https://github.com/owner/${who}/issues/1`,
        },
      ]);
    else if (argv[0] === 'pr') stdout = '[]';
    else if (argv[1]?.includes('/comments'))
      stdout = JSON.stringify([
        {
          id: 1,
          user: { login: `${who}-commenter` },
          created_at: '2026-07-01T00:00:00Z',
          body: `${who} says hi`,
          html_url: `https://github.com/owner/${who}/pull/42#c1`,
        },
      ]);
    else if (argv[1]?.includes('/reviews')) stdout = '[]';
    else stdout = '{}'; // graphql counts — malformed page degrades to empty maps
    cb(null, { stdout, stderr: '' });
  });

describe('fetchGithub per-project list-cache isolation (step 2.6)', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the cache path we're testing
    execFileMock.mockReset();
    ghByCwd();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never serves project A\'s issues/PRs to project B inside the TTL window', async () => {
    const a = await fetchGithub('/repo/list-iso/proj-a');
    expect(a.repo).toBe('owner/a');
    expect(a.issues[0]?.title).toBe('a-issue');

    // Within A's 60 s TTL: B must trigger its own fetch, not read A's entry.
    const b = await fetchGithub('/repo/list-iso/proj-b');
    expect(b.repo).toBe('owner/b');
    expect(b.issues[0]?.title).toBe('b-issue');

    // Per-key TTL semantics survive the scoping: A is still served from cache…
    const calls = execFileMock.mock.calls.length;
    const a2 = await fetchGithub('/repo/list-iso/proj-a');
    expect(a2).toBe(a); // same cached object, no new gh calls
    expect(execFileMock.mock.calls.length).toBe(calls);
    // …and it is A's data, not B's (B's fetch didn't overwrite A's key).
    expect(a2.issues[0]?.title).toBe('a-issue');
  });
});

describe('fetchGithubComments per-project cache isolation (step 2.6)', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
    ghByCwd();
    __clearCommentsCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not collide two projects that both have a PR #42', async () => {
    const a = await fetchGithubComments('/repo/thread-iso/proj-a', 'pr', 42);
    expect(a.comments[0]?.author).toBe('a-commenter');

    // Old key was `pr#42` — B would have been served A's thread from cache.
    const b = await fetchGithubComments('/repo/thread-iso/proj-b', 'pr', 42);
    expect(b.comments[0]?.author).toBe('b-commenter');
    expect(b.comments[0]?.body).toBe('b says hi');

    // A's entry survives B's write and still serves from cache (no new gh calls).
    const calls = execFileMock.mock.calls.length;
    const a2 = await fetchGithubComments('/repo/thread-iso/proj-a', 'pr', 42);
    expect(a2).toBe(a);
    expect(execFileMock.mock.calls.length).toBe(calls);
  });
});

/** `detectGithubCached` backs `GET /api/health`'s `forge.available`, which gates the GitHub nav
 *  item. The sidebar flicker bug was this returning `null` (→ item hidden) for one 5 s health poll
 *  every time the 60 s probe cache expired; the fix is stale-while-revalidate — keep serving the
 *  last-known answer while a background probe refreshes it, so the item never blinks out. */
describe('detectGithubCached', () => {
  const CACHE_MS = 60_000; // mirrors the constant in github.ts
  const repoRoot = '/repo/detect-swr'; // distinct root so the module-level cache is isolated

  /** Resolve `gh repo view` as if it succeeded — promisify(execFile) resolves with our value. */
  const ghOk = () =>
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: '{"nameWithOwner":"o/r"}', stderr: '' });
    });

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the cache path we're testing
    vi.useFakeTimers();
    vi.setSystemTime(0);
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('serves the last-known availability instead of null once the cache goes stale', async () => {
    ghOk();

    // Cold start: nothing cached yet → null (contract-safe "unknown"), and it fires one probe.
    expect(detectGithubCached(repoRoot)).toBeNull();
    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget probe settle
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Warm: within the 60 s window the cached result is served with no new probe.
    expect(detectGithubCached(repoRoot)).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Cache expires. The bug returned null here (item vanishes); the fix returns the stale value.
    vi.setSystemTime(CACHE_MS + 1);
    expect(detectGithubCached(repoRoot)).toEqual({ available: true });

    // …and a background revalidate was kicked off exactly once for the stale read.
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
