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
  detectGithubCached,
  fetchCommentCounts,
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
    expect(events[0].createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(events[0].createdAt).not.toBeNull();
  });

  it('normalizes a non-UTC author.date to UTC so the string sort stays correct', () => {
    // author.date arrives with a numeric offset. Left alone, '2026-01-02T09:00:00+09:00' sorts
    // AFTER '2026-01-02T03:00:00Z' by string compare, when it is actually a minute earlier.
    const { events } = normalizeEvents([
      commitRow({ author: { name: 'Ada', date: '2026-01-02T09:00:00+09:00' } }),
    ]);
    expect(events[0].createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect(events[0].createdAt.endsWith('Z')).toBe(true);
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
    expect(events[0].actor).toBe('Ada Lovelace');
    expect(events[0].avatarUrl).toBeUndefined();
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com');
    expect(events[1].actor).toBe('octocat');
    expect(events[1].avatarUrl).toBe('https://avatars/1');
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
    expect(events[0].label).toEqual({ name: 'bug', color: 'd73a4a' });
    expect(events[1].label).toEqual({ name: 'wip' }); // color omitted, not null
    expect(events[2].subject).toBe('bob');
    expect(events[4].subject).toBe('new title');
    expect(events[9]).toMatchObject({ refNumber: 520, refTitle: 'Sibling work', refIsPr: true });
    expect(events[10]).toMatchObject({ sha: SHA, message: 'fix(forge): bound the timeline page loop' });
  });

  it('caps the commit message at its first line and 120 chars', () => {
    const { events } = normalizeEvents([
      commitRow({ message: `${'x'.repeat(200)}\n\nA long body paragraph that must not appear.` }),
    ]);
    expect(events[0].message).toBe('x'.repeat(120));
    expect(events[0].message).not.toContain('body paragraph');
  });

  it('resolves ids through id → sha → node_id → index, sha ahead of node_id', () => {
    const { events } = normalizeEvents([
      { event: 'labeled', id: 42, node_id: 'LA_x', created_at: '2026-01-01T00:00:00Z', label: { name: 'a' } },
      commitRow({ node_id: 'C_kwDOopaque' }), // carries BOTH sha and node_id → sha wins
      { event: 'cross-referenced', id: null, node_id: null, created_at: '2026-01-01T00:00:02Z', source: { issue: { number: 1 } } },
    ]);
    expect(events.map((e) => e.id)).toEqual([`evt-42`, `evt-${SHA}`, 'evt-2']);
    expect(events[1].id).not.toContain('C_kwDOopaque');
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
    expect(events[events.length - 1].id).toBe('evt-249'); // newest retained
    expect(events[0].id).toBe('evt-50'); // oldest 50 dropped
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
