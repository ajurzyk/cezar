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
  __clearRepoHandleCacheForTests,
  resolveRepoHandle,
  detectGithubCached,
  fetchGithubComments,
  fetchTimelinePages,
  fetchCommentCounts,
  fetchCommitChecks,
  ghCheckRunSchema,
  ghTimelineEventSchema,
  mergeThread,
  normalizeComments,
  normalizeEvents,
  normalizeReviews,
  parseCountsPage,
  parseOwnerName,
  rollupToChecks,
  THREAD_ENTRY_CAP,
  TIMELINE_BUDGET_MS,
  TIMELINE_EVENT_CAP,
  TIMELINE_EVENT_KINDS,
  TIMELINE_MAX_PAGES,
  TIMELINE_MIN_PAGE_MS,
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

// ---- timeline events (#525) -------------------------------------------------

describe('ghTimelineEventSchema (#525)', () => {
  it('parses an unknown event type instead of throwing, so the allowlist can drop it', () => {
    // `event` is deliberately a loose z.string(): a new GitHub event type must never fail the
    // parse of the whole page. It parses here and gets dropped downstream by TIMELINE_EVENT_KINDS.
    const row = { event: 'convert_to_draft', id: 1, created_at: '2026-01-01T00:00:00Z' };
    expect(() => ghTimelineEventSchema.parse(row)).not.toThrow();
    expect(ghTimelineEventSchema.parse(row).event).toBe('convert_to_draft');
  });

  it('strips extras — the git author email must never reach the wire type', () => {
    const parsed = ghTimelineEventSchema.parse({
      event: 'committed',
      sha: 'a'.repeat(40),
      author: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
      verification: { verified: true },
    });
    expect(parsed.author).toEqual({ name: 'Ada', date: '2026-01-01T00:00:00Z' });
    expect(parsed.author).not.toHaveProperty('email');
    expect(parsed).not.toHaveProperty('verification');
  });

  it('tolerates the null identity and timestamp fields real rows carry', () => {
    // Verified against a real timeline: `committed` omits `id` entirely and returns
    // `created_at: null`; `cross-referenced` returns null for BOTH `id` and `node_id`.
    expect(() =>
      ghTimelineEventSchema.parse({ event: 'committed', created_at: null, sha: 'b'.repeat(40) }),
    ).not.toThrow();
    expect(() =>
      ghTimelineEventSchema.parse({ event: 'cross-referenced', id: null, node_id: null }),
    ).not.toThrow();
  });
});

describe('TIMELINE_EVENT_KINDS (#525)', () => {
  it('excludes `reviewed` so reviews are not rendered twice', () => {
    // Timeline `reviewed` rows do carry a body and would work — but /pulls/{n}/reviews is already
    // normalized, chipped and empty-body-filtered, so sourcing both would duplicate every review.
    expect(TIMELINE_EVENT_KINDS.has('reviewed' as never)).toBe(false);
  });

  it('excludes the noise github.com itself does not surface', () => {
    for (const noise of ['subscribed', 'mentioned', 'review_requested', 'referenced']) {
      expect(TIMELINE_EVENT_KINDS.has(noise as never)).toBe(false);
    }
  });

  it('covers exactly the 11 kinds the wire type declares', () => {
    expect([...TIMELINE_EVENT_KINDS].sort()).toEqual(
      [
        'assigned',
        'closed',
        'committed',
        'cross-referenced',
        'head_ref_force_pushed',
        'labeled',
        'merged',
        'renamed',
        'reopened',
        'unassigned',
        'unlabeled',
      ],
    );
  });
});

describe('timeline fetch bounds (#525)', () => {
  it('shares one budget across pages rather than one per page', () => {
    // The trap this guards: gh()'s timeout is PER INVOCATION, so TIMELINE_MAX_PAGES pages at the
    // 15 s default would put the loop's ceiling at 150 s — an order of magnitude worse than the
    // single --paginate spawn it replaces. The budget is a total, not a per-page allowance.
    expect(TIMELINE_BUDGET_MS).toBe(15_000);
    expect(TIMELINE_MAX_PAGES * TIMELINE_BUDGET_MS).toBeGreaterThan(TIMELINE_BUDGET_MS);
  });

  it('keeps a floor large enough that a spawned page can actually finish', () => {
    expect(TIMELINE_MIN_PAGE_MS).toBeGreaterThan(0);
    expect(TIMELINE_MIN_PAGE_MS).toBeLessThan(TIMELINE_BUDGET_MS);
  });

  it('caps events independently of the comment stream', () => {
    // Not "they happen to be equal" — they must be SEPARATE knobs. A combined cap would let event
    // volume shorten comments[], which is a §2-protected response field.
    expect(TIMELINE_EVENT_CAP).toBe(200);
    expect(THREAD_ENTRY_CAP).toBe(200);
  });
});

describe('normalizeEvents (#525)', () => {
  const SHA = 'a'.repeat(40);
  const commitRow = (over: Record<string, unknown> = {}) => ({
    event: 'committed',
    // Verified against a real timeline: `committed` omits `id` and returns `created_at: null`.
    created_at: null,
    sha: SHA,
    message: 'fix(forge): bound the timeline page loop',
    author: { name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-01-02T03:04:05Z' },
    html_url: `https://github.com/o/r/commit/${SHA}`,
    ...over,
  });

  it('resolves a committed timestamp from author.date, never leaving it null', () => {
    // THE trap this whole function exists to avoid: `created_at` is null on commits, and mapping
    // it naively yields createdAt: null, which string-sorts to the top and reorders the thread.
    const { events } = normalizeEvents([commitRow()]);
    expect(events).toHaveLength(1);
    expect(events[0]!.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(events[0]!.createdAt).not.toBeNull();
  });

  it('normalizes a non-UTC author.date to UTC so the string sort stays correct', () => {
    // author.date arrives with a numeric offset. Left alone, '2026-01-02T09:00:00+09:00' sorts
    // AFTER '2026-01-02T03:00:00Z' by string compare, when it is actually a minute earlier.
    const { events } = normalizeEvents([
      commitRow({ author: { name: 'Ada', date: '2026-01-02T09:00:00+09:00' } }),
    ]);
    expect(events[0]!.createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect(events[0]!.createdAt.endsWith('Z')).toBe(true);
  });

  it('uses the git author name for commits and the actor login for everything else', () => {
    // A `committed` row carries a git author (name/email), not a GitHub actor — no login, no
    // avatar, and the email must never reach the wire type.
    const { events } = normalizeEvents([
      commitRow(),
      {
        event: 'labeled',
        id: 7,
        created_at: '2026-01-03T00:00:00Z',
        actor: { login: 'octocat', avatar_url: 'https://avatars/1' },
        label: { name: 'bug', color: 'd73a4a' },
      },
    ]);
    expect(events[0]!.actor).toBe('Ada Lovelace');
    expect(events[0]!.avatarUrl).toBeUndefined();
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com');
    expect(events[1]!.actor).toBe('octocat');
    expect(events[1]!.avatarUrl).toBe('https://avatars/1');
  });

  it('drops unknown event types rather than throwing', () => {
    const { events } = normalizeEvents([
      { event: 'subscribed', id: 1, created_at: '2026-01-01T00:00:00Z' },
      { event: 'mentioned', id: 2, created_at: '2026-01-01T00:00:00Z' },
      { event: 'review_requested', id: 3, created_at: '2026-01-01T00:00:00Z' },
      { event: 'some_future_event', id: 4, created_at: '2026-01-01T00:00:00Z' },
      { event: 'closed', id: 5, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['closed']);
  });

  it('drops `reviewed` so reviews are not rendered twice', () => {
    const { events } = normalizeEvents([
      { event: 'reviewed', id: 9, submitted_at: '2026-01-01T00:00:00Z', body: 'LGTM' },
    ]);
    expect(events).toEqual([]);
  });

  it('drops an event with no resolvable timestamp instead of sorting it arbitrarily', () => {
    const { events } = normalizeEvents([
      { event: 'closed', id: 1, created_at: null, actor: { login: 'a' } },
      commitRow({ author: { name: 'Ada', date: null } }),
      { event: 'labeled', id: 2, created_at: 'not-a-date', label: { name: 'x' } },
    ]);
    expect(events).toEqual([]);
  });

  it('maps each kind onto its own fields', () => {
    const { events } = normalizeEvents([
      { event: 'labeled', id: 1, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' }, label: { name: 'bug', color: 'd73a4a' } },
      { event: 'unlabeled', id: 2, created_at: '2026-01-01T00:00:01Z', actor: { login: 'a' }, label: { name: 'wip' } },
      { event: 'assigned', id: 3, created_at: '2026-01-01T00:00:02Z', actor: { login: 'a' }, assignee: { login: 'bob' } },
      { event: 'unassigned', id: 4, created_at: '2026-01-01T00:00:03Z', actor: { login: 'a' }, assignee: { login: 'bob' } },
      { event: 'renamed', id: 5, created_at: '2026-01-01T00:00:04Z', actor: { login: 'a' }, rename: { from: 'old', to: 'new title' } },
      { event: 'merged', id: 6, created_at: '2026-01-01T00:00:05Z', actor: { login: 'a' } },
      { event: 'closed', id: 7, created_at: '2026-01-01T00:00:06Z', actor: { login: 'a' } },
      { event: 'reopened', id: 8, created_at: '2026-01-01T00:00:07Z', actor: { login: 'a' } },
      { event: 'head_ref_force_pushed', id: 10, created_at: '2026-01-01T00:00:08Z', actor: { login: 'a' } },
      {
        event: 'cross-referenced',
        id: null,
        node_id: null,
        created_at: '2026-01-01T00:00:09Z',
        actor: { login: 'a' },
        source: { issue: { number: 520, title: 'Sibling work', html_url: 'https://github.com/o/r/pull/520', pull_request: {} } },
      },
      commitRow({ author: { name: 'Ada', date: '2026-01-01T00:00:10Z' } }),
    ]);

    expect(events.map((e) => e.kind)).toEqual([
      'labeled', 'unlabeled', 'assigned', 'unassigned', 'renamed',
      'merged', 'closed', 'reopened', 'head_ref_force_pushed', 'cross-referenced', 'committed',
    ]);
    expect(events[0]!.label).toEqual({ name: 'bug', color: 'd73a4a' });
    expect(events[1]!.label).toEqual({ name: 'wip' }); // color omitted, not null
    expect(events[2]!.subject).toBe('bob');
    expect(events[4]!.subject).toBe('new title');
    expect(events[9]!).toMatchObject({ refNumber: 520, refTitle: 'Sibling work', refIsPr: true });
    expect(events[10]!).toMatchObject({ sha: SHA, message: 'fix(forge): bound the timeline page loop' });
  });

  it('caps the commit message at its first line and 120 chars', () => {
    const { events } = normalizeEvents([
      commitRow({ message: `${'x'.repeat(200)}\n\nA long body paragraph that must not appear.` }),
    ]);
    expect(events[0]!.message).toBe('x'.repeat(120));
    expect(events[0]!.message).not.toContain('body paragraph');
  });

  it('resolves ids through id → sha → node_id → index, sha ahead of node_id', () => {
    const { events } = normalizeEvents([
      { event: 'labeled', id: 42, node_id: 'LA_x', created_at: '2026-01-01T00:00:00Z', label: { name: 'a' } },
      commitRow({ node_id: 'C_kwDOopaque' }), // carries BOTH sha and node_id → sha wins
      { event: 'cross-referenced', id: null, node_id: null, created_at: '2026-01-01T00:00:02Z', source: { issue: { number: 1 } } },
    ]);
    expect(events.map((e) => e.id)).toEqual([`evt-42`, `evt-${SHA}`, 'evt-2']);
    expect(events[1]!.id).not.toContain('C_kwDOopaque');
  });

  it('keeps ids stable across a refetch that prepends an event', () => {
    // The reason a bare index is not acceptable as the general scheme: the id becomes the React
    // key, so an index over the post-sort array shifts for every row below an insertion, and each
    // 60 s refetch would remount them — collapsing any commit group the user had expanded.
    const rows = [
      { event: 'labeled', id: 42, created_at: '2026-01-02T00:00:00Z', label: { name: 'a' } },
      commitRow(),
    ];
    const before = normalizeEvents(rows).events.map((e) => e.id);
    const after = normalizeEvents([
      { event: 'closed', id: 7, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' } },
      ...rows,
    ]).events.map((e) => e.id);
    expect(after.slice(1)).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
  });

  it('keeps the NEWEST window when the cap fires — the opposite of mergeThread', () => {
    // The timeline arrives oldest-first. slice(0, cap) would retain 200 stale day-one `labeled`
    // rows and discard the merge and the recent commits — the exact rows #525 asks for.
    const rows = Array.from({ length: 250 }, (_, i) => ({
      event: 'labeled',
      id: i,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      actor: { login: 'a' },
      label: { name: `l${i}` },
    }));
    const { events, truncated } = normalizeEvents(rows, 200);

    expect(truncated).toBe(true);
    expect(events).toHaveLength(200);
    expect(events[events.length - 1]!.id).toBe('evt-249'); // newest retained
    expect(events[0]!.id).toBe('evt-50'); // oldest 50 dropped
    expect(events.map((e) => e.createdAt)).toEqual([...events.map((e) => e.createdAt)].sort());
  });

  it('reports truncated=false at exactly the cap — the ambiguity the return shape exists for', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      event: 'closed', id: i, created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), actor: { login: 'a' },
    }));
    const { events, truncated } = normalizeEvents(rows, 200);
    expect(events).toHaveLength(200);
    expect(truncated).toBe(false);
  });
});

describe('fetchTimelinePages (#525)', () => {
  const full = (n = 100) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ event: 'closed', id: i })));

  it('stops on a short page without flagging stoppedShort — that is the timeline ending', async () => {
    const run = vi.fn(async () => full(40));
    const { rows, stoppedShort } = await fetchTimelinePages(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(40);
    expect(stoppedShort).toBe(false);
  });

  it('walks up to the page cap, then flags stoppedShort', async () => {
    const run = vi.fn(async () => full(100)); // every page full → never a natural end
    const { rows, stoppedShort } = await fetchTimelinePages(run, { maxPages: 10 });
    expect(run).toHaveBeenCalledTimes(10);
    expect(rows).toHaveLength(1000);
    expect(stoppedShort).toBe(true);
  });

  it('shares ONE budget across pages instead of granting each the full timeout', async () => {
    // The regression this guards: gh()'s timeout is per invocation, so passing the default to each
    // page would make the loop's ceiling maxPages * budget (150 s), not budget (15 s).
    let clock = 0;
    const now = () => clock;
    const handed: number[] = [];
    const run = vi.fn(async (_page: number, timeoutMs: number) => {
      handed.push(timeoutMs);
      clock += 4_000; // each page burns 4 s of the shared 15 s
      return full(100);
    });

    const { stoppedShort } = await fetchTimelinePages(run, { budgetMs: 15_000, minPageMs: 2_000, now });

    // Each page is handed strictly LESS than the previous one — a shared, draining budget.
    expect(handed).toEqual([15_000, 11_000, 7_000, 3_000]);
    // 4 pages fit; the 5th would have 15_000 - 16_000 < 0 left, so the loop stops instead.
    expect(run).toHaveBeenCalledTimes(4);
    expect(stoppedShort).toBe(true);
    expect(clock).toBeLessThanOrEqual(16_000); // NOT 10 * 15_000
  });

  it('never spawns a page that cannot finish — the min-page floor', async () => {
    // Without the floor, 300 ms left spawns gh with a 300 ms timeout, which throws and looks
    // exactly like a real endpoint failure.
    let clock = 0;
    const now = () => clock;
    const run = vi.fn(async () => {
      clock += 14_000; // leaves 1 s — under the 2 s floor
      return full(100);
    });
    const { stoppedShort } = await fetchTimelinePages(run, { budgetMs: 15_000, minPageMs: 2_000, now });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stoppedShort).toBe(true);
  });

  it('rethrows a page-1 failure so the caller can decide whether substitution helps', async () => {
    const run = vi.fn(async () => { throw new Error('HTTP 404'); });
    await expect(fetchTimelinePages(run)).rejects.toThrow('HTTP 404');
  });

  it('keeps pages already fetched when a later page fails, rather than discarding them', async () => {
    // Falling back here would trade real events for a comments-only thread — strictly worse than
    // what the loop already holds.
    const run = vi.fn(async (page: number) => {
      if (page === 5) throw new Error('HTTP 502');
      return full(100);
    });
    const { rows, stoppedShort } = await fetchTimelinePages(run);
    expect(rows).toHaveLength(400); // pages 1-4 kept
    expect(stoppedShort).toBe(true);
  });
});

describe('fetchGithubComments timeline integration (#525)', () => {
  const repoRoot = '/tmp/repo';
  const SHA = 'c'.repeat(40);

  /** Route each `gh` invocation by the api path in its args. */
  const routeGh = (handlers: {
    timeline?: (page: number) => unknown;
    comments?: () => unknown;
    reviews?: () => unknown;
  }) =>
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      const path = argv.find((a) => a.includes('repos/{owner}/{repo}')) ?? '';
      const ok = (v: unknown) => cb(null, { stdout: JSON.stringify(v), stderr: '' });
      try {
        if (path.includes('/timeline')) {
          if (!handlers.timeline) return cb(new Error('HTTP 404'), null);
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
          return ok(handlers.timeline(page));
        }
        if (path.includes('/comments')) {
          if (!handlers.comments) return cb(new Error('HTTP 500'), null);
          return ok(handlers.comments());
        }
        if (path.includes('/reviews')) return ok(handlers.reviews ? handlers.reviews() : []);
      } catch (err) {
        return cb(err, null);
      }
      return cb(new Error(`unexpected gh call: ${argv.join(' ')}`), null);
    });

  const comment = (id: number) => ({
    id,
    user: { login: 'octocat', avatar_url: 'https://avatars/1' },
    created_at: `2026-01-0${id}T00:00:00Z`,
    body: `comment ${id}`,
    html_url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
  });
  const commented = (id: number) => ({ event: 'commented', ...comment(id) });

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
    __clearCommentsCacheForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('splits the timeline into unchanged comments and normalized events', async () => {
    routeGh({
      timeline: () => [
        commented(1),
        { event: 'labeled', id: 90, created_at: '2026-01-01T12:00:00Z', actor: { login: 'octocat' }, label: { name: 'bug', color: 'd73a4a' } },
        { event: 'committed', created_at: null, sha: SHA, message: 'do the thing', author: { name: 'Ada', date: '2026-01-01T13:00:00Z' } },
        commented(2),
      ],
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(true);
    expect(data.comments.map((c) => c.id)).toEqual([1, 2]);
    expect(data.comments.every((c) => c.kind === 'comment')).toBe(true);
    expect(data.events?.map((e) => e.kind)).toEqual(['labeled', 'committed']);
    expect(data.events?.[1]).toMatchObject({ sha: SHA, actor: 'Ada' });
  });

  it('returns comments[] byte-identical to the pre-#525 output for the same rows (§2)', async () => {
    // THE backward-compatibility guarantee. The timeline's `commented` rows are shape-identical to
    // the legacy endpoint's, and they go through the SAME normalizeComments — so the array a
    // consumer sees must not move by a single field.
    const raw = [comment(1), comment(2), comment(3)];
    const expected = normalizeComments(raw);

    routeGh({ timeline: () => raw.map((c) => ({ event: 'commented', ...c })) });
    const viaTimeline = await fetchGithubComments(repoRoot, 'issue', 1);

    __clearCommentsCacheForTests();
    routeGh({ timeline: undefined, comments: () => raw }); // force the legacy path
    const viaLegacy = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(viaTimeline.comments).toEqual(expected);
    expect(viaTimeline.comments).toEqual(viaLegacy.comments);
  });

  it('falls back to the comments endpoint on a timeline 404, still populating comments[]', async () => {
    // The outer catch's /404|not found/i branch would otherwise turn this into an empty thread —
    // which is exactly why the timeline's catch is scoped INSIDE it.
    routeGh({ timeline: undefined, comments: () => [comment(1), comment(2)] });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(true);
    expect(data.comments).toHaveLength(2);
    expect(data.events).toBeUndefined();
    expect(data.reason).toBeUndefined();
  });

  it('does not attempt the fallback when gh is missing (ENOENT)', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(new Error('spawn gh ENOENT'), null);
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(false);
    expect(data.reason).toMatch(/gh CLI not found/);
    expect(execFileMock).toHaveBeenCalledTimes(1); // no second spawn
  });

  it('tops up comments[] when the fetch stopped short on a comment-poor prefix', async () => {
    // A page-capped, event-heavy timeline: the 10-page budget holds only 3 comments, but the
    // thread really has 250. Without the top-up, comments[] silently returns 3.
    const legacy = Array.from({ length: 250 }, (_, i) => comment(i + 1));
    const labels = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        event: 'labeled', id: page * 100 + i, created_at: '2026-01-01T00:00:00Z',
        actor: { login: 'a' }, label: { name: `l${page}-${i}` },
      }));
    routeGh({
      // Every page is full, so the walk runs to the page cap → stoppedShort. Only page 1 carries
      // comments, so the prefix holds 3 of the thread's real 250.
      timeline: (page) => (page === 1 ? [...labels(1).slice(0, 97), commented(1), commented(2), commented(3)] : labels(page)),
      comments: () => legacy,
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.comments).toHaveLength(THREAD_ENTRY_CAP); // repaired, not 3
    expect(data.truncated).toBe(true);
    expect(data.events?.length).toBeGreaterThan(0); // events survived the top-up
  });

  it('swallows a throwing top-up and keeps the timeline commented rows', async () => {
    // The one stated exception to the §2 guarantee — comments[] may be short here. It must NOT
    // fall through to the fallback (the same call) or the outer catch (which empties the thread).
    const labels = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        event: 'labeled', id: page * 100 + i, created_at: '2026-01-01T00:00:00Z',
        actor: { login: 'a' }, label: { name: `l${page}-${i}` },
      }));
    routeGh({
      timeline: (page) => (page === 1 ? [...labels(1).slice(0, 99), commented(1)] : labels(page)),
      comments: undefined, // top-up throws
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(true); // NOT the empty-thread path
    expect(data.comments.map((c) => c.id)).toEqual([1]);
    expect(data.truncated).toBe(true);
  });

  it('sets truncated when only the event stream was capped', async () => {
    routeGh({
      timeline: () => Array.from({ length: 250 }, (_, i) => ({
        event: 'labeled', id: i,
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        actor: { login: 'a' }, label: { name: `l${i}` },
      })),
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.events).toHaveLength(TIMELINE_EVENT_CAP);
    expect(data.truncated).toBe(true);
    expect(data.comments).toEqual([]); // comments untouched by event volume
  });

  it('still fetches PR reviews alongside the timeline', async () => {
    routeGh({
      timeline: () => [commented(1)],
      reviews: () => [{
        id: 500, user: { login: 'rev' }, body: 'LGTM', state: 'APPROVED',
        submitted_at: '2026-01-05T00:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-500',
      }],
    });

    const data = await fetchGithubComments(repoRoot, 'pr', 1);

    expect(data.comments.map((c) => c.kind)).toEqual(['comment', 'review']);
  });
});

describe('mergeThread is unaffected by events (#525)', () => {
  // mergeThread is deliberately left UNCHANGED by #525: it still caps comments+reviews at 200 and
  // still head-slices. Events are returned as their own array and interleaved client-side — there
  // is no server-side merge. These tests pin that separation so a later refactor cannot quietly
  // introduce a combined cap, which is the §2 defect the spec's review caught in its first draft.
  const comment = (id: number, at: string): ForgeComment => ({
    id, author: 'a', createdAt: at, body: '', kind: 'comment', url: `u${id}`,
  });

  it('takes only ForgeComment lists — events have no way in', () => {
    const comments = Array.from({ length: 250 }, (_, i) =>
      comment(i, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()),
    );
    const { comments: out, truncated } = mergeThread([comments]);
    expect(out).toHaveLength(THREAD_ENTRY_CAP);
    expect(truncated).toBe(true);
    // Still the OLDEST 200 — the pre-existing head-slice, deliberately not switched to slice(-cap)
    // like normalizeEvents. It is pre-existing behavior on a §2-frozen surface.
    expect(out[0]!.id).toBe(0);
    expect(out[out.length - 1]!.id).toBe(199);
  });

  it('produces the same output regardless of how many events the same fetch carried', () => {
    const comments = [comment(1, '2026-01-01T00:00:00Z'), comment(2, '2026-01-02T00:00:00Z')];
    const before = mergeThread([comments]);
    // Normalizing 250 events alongside must not touch the comment stream in any way.
    normalizeEvents(
      Array.from({ length: 250 }, (_, i) => ({
        event: 'labeled', id: i,
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        actor: { login: 'a' }, label: { name: `l${i}` },
      })),
    );
    expect(mergeThread([comments])).toEqual(before);
    expect(before.truncated).toBe(false);
  });
});

describe('resolveRepoHandle (#525 Phase 2)', () => {
  const repoRoot = '/tmp/repo';

  beforeEach(() => {
    execFileMock.mockReset();
    __clearRepoHandleCacheForTests();
  });

  const ghReturns = (slug: string) =>
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: slug, stderr: '' });
    });

  it('parses the handle and serves the second call from the memo', async () => {
    ghReturns('open-mercato/cezar');
    expect(await resolveRepoHandle(repoRoot)).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(await resolveRepoHandle(repoRoot)).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(execFileMock).toHaveBeenCalledTimes(1); // no second subprocess
  });

  it('memoizes a malformed slug as a permanent negative and does not retry it', async () => {
    ghReturns('not-a-clean-handle/with/too/many/parts');
    expect(await resolveRepoHandle(repoRoot)).toBeNull();
    expect(await resolveRepoHandle(repoRoot)).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1); // retrying cannot help
  });

  it('does NOT cache a thrown gh failure — one blip must not disable glyphs until restart', async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(new Error('network is unreachable'), null);
    });
    expect(await resolveRepoHandle(repoRoot)).toBeNull();

    ghReturns('open-mercato/cezar'); // the blip passes
    expect(await resolveRepoHandle(repoRoot)).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(execFileMock).toHaveBeenCalledTimes(2); // it DID retry
  });

  it('keys the memo per repoRoot', async () => {
    ghReturns('o/one');
    expect(await resolveRepoHandle('/tmp/a')).toEqual({ owner: 'o', name: 'one' });
    ghReturns('o/two');
    expect(await resolveRepoHandle('/tmp/b')).toEqual({ owner: 'o', name: 'two' });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchCommitChecks (#525 Phase 2)', () => {
  const sha = (n: number) => String(n).padStart(40, '0');
  const reply = (states: Array<string | null | 'missing'>) =>
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          states.map((state, i) => [
            `c${i}`,
            state === 'missing' ? null : { statusCheckRollup: state === null ? null : { state } },
          ]),
        ),
      },
    });

  it('maps each alias back to its SHA', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'FAILURE', 'PENDING']));
    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1), sha(2), sha(3)]);
    expect(checks).toEqual({ [sha(1)]: 'passing', [sha(2)]: 'failing', [sha(3)]: 'pending' });
  });

  it('leaves an unknown SHA absent rather than null — the alias resolved null', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'missing']));
    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1), sha(2)]);
    expect(checks[sha(1)]).toBe('passing');
    expect(sha(2) in checks).toBe(false);
  });

  it('distinguishes "no CI configured" (null) from "not looked up" (absent)', async () => {
    const runGraphql = vi.fn(async () => reply([null]));
    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1)]);
    expect(sha(1) in checks).toBe(true);
    expect(checks[sha(1)]).toBeNull();
  });

  it('chunks at 50 SHAs, and a failed chunk costs only its own glyphs', async () => {
    const runGraphql = vi.fn(async (q: string) => {
      // Chunk 2 fails; chunk 1 must survive it.
      if (q.includes(sha(60))) throw new Error('HTTP 502');
      return reply(Array.from({ length: 50 }, () => 'SUCCESS'));
    });
    const shas = Array.from({ length: 70 }, (_, i) => sha(i + 1));

    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', shas);

    expect(runGraphql).toHaveBeenCalledTimes(2); // 70 → 50 + 20
    expect(Object.keys(checks)).toHaveLength(50);
    expect(checks[sha(1)]).toBe('passing');
    expect(sha(60) in checks).toBe(false);
  });

  it('degrades to an empty map when every chunk fails, never throwing', async () => {
    const runGraphql = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchCommitChecks(runGraphql, 'o', 'n', [sha(1)])).resolves.toEqual({});
  });

  it('spawns nothing for an empty SHA list', async () => {
    const runGraphql = vi.fn();
    expect(await fetchCommitChecks(runGraphql, 'o', 'n', [])).toEqual({});
    expect(runGraphql).not.toHaveBeenCalled();
  });

  it('embeds full 40-char SHAs — oid rejects abbreviated ones', async () => {
    let sent = '';
    const runGraphql = vi.fn(async (q: string) => { sent = q; return reply(['SUCCESS']); });
    await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1)]);
    expect(sent).toContain(`object(oid: "${sha(1)}")`);
    expect(sha(1)).toHaveLength(40);
  });
});
