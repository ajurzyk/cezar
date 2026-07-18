import { describe, expect, it, vi } from 'vitest';
import {
  fetchCommentCounts,
  ghCheckRunSchema,
  parseCountsPage,
  parseOwnerName,
  rollupToChecks,
} from './github.js';

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
