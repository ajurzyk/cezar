import { describe, expect, it } from 'vitest';
import {
  combinedStatusToChecks,
  computeReviewDecision,
  FJ_BODY_CAP,
  forgejoRepositorySchema,
  mapChangedFileStatus,
  mapForgejoIssue,
  mapForgejoPull,
  mergeMethodsFromRepository,
  normalizeForgejoMergeState,
  normalizeForgejoTimestamp,
  rebaseToWebUrl,
  stripWipTitle,
  type ForgejoBranchInfo,
  type ForgejoRepository,
} from './forgejo-map.ts';

/**
 * Pure mappers + zod schemas that turn raw Forgejo REST payloads into `ForgeItem`/checks/merge-
 * method shapes. Zero I/O — every fixture here is a hand-built JSON object, no `fetch` involved.
 */

const webUrl = 'https://forge.example.com';

describe('normalizeForgejoTimestamp', () => {
  it('normalizes a numeric-offset timestamp to Z', () => {
    // The live instance answers "+02:00", never "Z" — a raw string sort would put these later
    // than a UTC "Z" timestamp from the same instant, reversing chronological order.
    expect(normalizeForgejoTimestamp('2026-08-07T10:00:00+02:00')).toBe('2026-08-07T08:00:00.000Z');
  });

  it('maps the zero-value sentinel to null', () => {
    expect(normalizeForgejoTimestamp('0001-01-01T00:00:00Z')).toBeNull();
  });

  it('maps the epoch-with-offset sentinel to null', () => {
    // Parses to 1970-01-01T00:00:00.000Z once the +01:00 offset is applied — year 1970, caught by
    // the `year < 1971` gate alongside the year-1 sentinel above.
    expect(normalizeForgejoTimestamp('1970-01-01T01:00:00+01:00')).toBeNull();
  });

  it('maps an unparseable string to null', () => {
    expect(normalizeForgejoTimestamp('not-a-date')).toBeNull();
  });

  it('maps null/undefined to null', () => {
    expect(normalizeForgejoTimestamp(null)).toBeNull();
    expect(normalizeForgejoTimestamp(undefined)).toBeNull();
  });
});

describe('stripWipTitle', () => {
  it('strips a "WIP: " prefix when the PR is a draft', () => {
    expect(stripWipTitle('WIP: cezar: add driver', true)).toBe('cezar: add driver');
  });

  it('strips a "[wip] " prefix case-insensitively', () => {
    expect(stripWipTitle('[WIP] add driver', true)).toBe('add driver');
  });

  it('leaves the title untouched when the PR is not a draft, even with a WIP prefix', () => {
    expect(stripWipTitle('WIP: add driver', false)).toBe('WIP: add driver');
  });

  it('leaves a draft title untouched when it carries no WIP prefix', () => {
    expect(stripWipTitle('add driver', true)).toBe('add driver');
  });
});

describe('combinedStatusToChecks', () => {
  it('maps a null statuses array (no CI configured) to null, not pending', () => {
    // Measured on the live instance: a repo with no CI returns `statuses: null`. A schema without
    // `.nullish()` here throws on this exact, common shape — and mapping it to 'pending' would
    // spin the UI's CI indicator forever for every repo that has no CI at all.
    expect(combinedStatusToChecks({ state: '', total_count: 0, statuses: null })).toBeNull();
  });

  it('maps an empty statuses array to null too', () => {
    expect(combinedStatusToChecks({ state: '', total_count: 0, statuses: [] })).toBeNull();
  });

  it('maps any failure/error/warning status to failing', () => {
    expect(combinedStatusToChecks({ statuses: [{ status: 'success' }, { status: 'warning' }] })).toBe('failing');
    expect(combinedStatusToChecks({ statuses: [{ status: 'error' }] })).toBe('failing');
    expect(combinedStatusToChecks({ statuses: [{ status: 'failure' }] })).toBe('failing');
  });

  it('maps pending (with no failing status present) to pending', () => {
    expect(combinedStatusToChecks({ statuses: [{ status: 'success' }, { status: 'pending' }] })).toBe('pending');
  });

  it('maps all-success to passing', () => {
    expect(combinedStatusToChecks({ statuses: [{ status: 'success' }, { status: 'success' }] })).toBe('passing');
  });

  it('ignores an empty-string status entry (never seen alone, but must not count as failing/pending)', () => {
    expect(combinedStatusToChecks({ statuses: [{ status: 'success' }, { status: '' }] })).toBe('passing');
  });
});

describe('mapChangedFileStatus', () => {
  it.each([
    ['added', 'added'],
    ['deleted', 'removed'],
    ['renamed', 'renamed'],
    ['copied', 'copied'],
    ['changed', 'modified'],
    ['unchanged', 'changed'],
    ['something-unrecognized', 'changed'],
  ] as const)('%s -> %s', (input, expected) => {
    expect(mapChangedFileStatus(input)).toBe(expected);
  });
});

describe('mapForgejoIssue', () => {
  const raw = {
    id: 999, // global id — must NOT leak into `number`
    number: 42,
    title: 'Something broke',
    html_url: 'http://forgejo:3000/acme/demo/issues/42',
    user: { login: 'ajr' },
    created_at: '2026-08-07T10:00:00+02:00',
    labels: [{ name: 'bug' }, { name: 'p1' }],
    body: 'x'.repeat(FJ_BODY_CAP + 500),
    comments: 3,
    pull_request: null,
  };

  it('maps every field, rebasing the url onto webUrl and using `number` (never `id`)', () => {
    const item = mapForgejoIssue(raw, webUrl);
    expect(item).toEqual({
      kind: 'issue',
      number: 42,
      title: 'Something broke',
      author: 'ajr',
      createdAt: '2026-08-07T08:00:00.000Z',
      labels: ['bug', 'p1'],
      body: 'x'.repeat(FJ_BODY_CAP),
      url: 'https://forge.example.com/acme/demo/issues/42',
      comments: 3,
    });
  });

  it('caps the body at FJ_BODY_CAP', () => {
    expect(mapForgejoIssue(raw, webUrl)!.body).toHaveLength(FJ_BODY_CAP);
  });

  it('returns null for a row that is actually a pull request (/issues also serves PRs)', () => {
    // Measured on the live instance: `/issues` without `?type=issues` returns PR rows too, each
    // carrying a non-null `pull_request`. `?type=issues` is the primary filter (driver-level,
    // outside this pure mapper) — this null-return is the belt-and-braces second layer.
    const prRow = { ...raw, pull_request: { merged: false, merged_at: null } };
    expect(mapForgejoIssue(prRow, webUrl)).toBeNull();
  });

  it('falls back to "?" when the author user is absent', () => {
    expect(mapForgejoIssue({ ...raw, user: null }, webUrl)!.author).toBe('?');
  });
});

describe('mapForgejoPull', () => {
  const raw = {
    id: 11, // global id, different from `number` — same trap as issues
    number: 1,
    title: 'WIP: cezar: add driver',
    html_url: 'http://forgejo:3000/acme/demo/pulls/1',
    user: { login: 'ajr' },
    created_at: '2026-08-07T10:00:00+02:00',
    labels: [{ name: 'enhancement' }],
    body: 'desc',
    comments: 2,
    draft: true,
    additions: 40,
    deletions: 5,
    state: 'open',
    merged: false,
  };

  it('maps a draft PR: WIP-strips the title, appends the draft label, sets checks:null', () => {
    const item = mapForgejoPull(raw, webUrl);
    expect(item).toEqual({
      kind: 'pr',
      number: 1,
      title: 'cezar: add driver',
      author: 'ajr',
      createdAt: '2026-08-07T08:00:00.000Z',
      labels: ['enhancement', 'draft'],
      body: 'desc',
      url: 'https://forge.example.com/acme/demo/pulls/1',
      comments: 2,
      isDraft: true,
      additions: 40,
      deletions: 5,
      // The list never pays for the CI rollup of every open PR — parity with github.ts's own
      // list mapping (#664), which lazily hydrates checks for on-screen rows instead.
      checks: null,
    });
  });

  it('leaves a non-draft PR title untouched even with a WIP prefix, and does not add the draft label', () => {
    const item = mapForgejoPull({ ...raw, draft: false, title: 'WIP: add driver' }, webUrl);
    expect(item.title).toBe('WIP: add driver');
    expect(item.labels).toEqual(['enhancement']);
    expect(item.isDraft).toBe(false);
  });

  it('falls back to "?" when the author user is absent', () => {
    expect(mapForgejoPull({ ...raw, user: null }, webUrl).author).toBe('?');
  });
});

describe('mergeMethodsFromRepository', () => {
  function repo(overrides: Partial<ForgejoRepository> = {}): ForgejoRepository {
    return forgejoRepositorySchema.parse({ default_branch: 'main', ...overrides });
  }

  it('collects every allowed method and maps default_merge_style to the surviving method', () => {
    const result = mergeMethodsFromRepository(
      repo({ allow_merge_commits: true, allow_squash_merge: true, allow_rebase: true, default_merge_style: 'rebase' }),
    );
    expect(result.methods).toEqual(['merge', 'squash', 'rebase']);
    expect(result.doFor).toEqual({ merge: 'merge', squash: 'squash', rebase: 'rebase' });
    expect(result.defaultMethod).toBe('rebase');
  });

  it('prefers allow_rebase ("rebase") over allow_rebase_explicit ("rebase-merge") when both are set', () => {
    const result = mergeMethodsFromRepository(repo({ allow_rebase: true, allow_rebase_explicit: true }));
    expect(result.methods).toEqual(['rebase']);
    expect(result.doFor).toEqual({ rebase: 'rebase' });
  });

  it('falls back to allow_rebase_explicit ("rebase-merge") only when allow_rebase is false', () => {
    const result = mergeMethodsFromRepository(
      repo({ allow_rebase: false, allow_rebase_explicit: true, default_merge_style: 'rebase-merge' }),
    );
    expect(result.methods).toEqual(['rebase']);
    expect(result.doFor).toEqual({ rebase: 'rebase-merge' });
    expect(result.defaultMethod).toBe('rebase');
  });

  it('ignores allow_fast_forward_only_merge as a method, but uses fast-forward-only as a default-method signal', () => {
    const result = mergeMethodsFromRepository(
      repo({ allow_merge_commits: true, allow_squash_merge: true, allow_fast_forward_only_merge: true, default_merge_style: 'fast-forward-only' }),
    );
    expect(result.methods).toEqual(['merge', 'squash']);
    expect(result.defaultMethod).toBe('merge'); // methods[0]
  });

  it('defaultMethod is null when fast-forward-only is selected but no method survived the flags', () => {
    const result = mergeMethodsFromRepository(repo({ default_merge_style: 'fast-forward-only' }));
    expect(result.methods).toEqual([]);
    expect(result.defaultMethod).toBeNull();
  });

  it('defaultMethod is null when default_merge_style names a method that did not survive the flags', () => {
    const result = mergeMethodsFromRepository(repo({ allow_merge_commits: true, default_merge_style: 'squash' }));
    expect(result.methods).toEqual(['merge']);
    expect(result.defaultMethod).toBeNull();
  });
});

describe('rebaseToWebUrl', () => {
  // Implemented here (both mappers above call it directly) — `forgejo.ts` imports this straight
  // from `forgejo-map.ts` (no re-export), since `forgejo-map.ts` must stay a leaf module (avoiding
  // a `forgejo.ts` <-> `forgejo-map.ts` import cycle). This is the sole test home; there is no
  // duplicate copy of this coverage in `forgejo.test.ts`.
  it('rebases host+path+query onto webUrl, path/query from html_url', () => {
    expect(rebaseToWebUrl('http://forgejo:3000/acme/demo/pulls/1?tab=files', webUrl)).toBe(
      'https://forge.example.com/acme/demo/pulls/1?tab=files',
    );
  });

  it('preserves a hash fragment too', () => {
    expect(rebaseToWebUrl('http://a.local/o/r/pulls/1#comment-9', 'http://b.local:8929')).toBe(
      'http://b.local:8929/o/r/pulls/1#comment-9',
    );
  });
});

function reviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'APPROVED',
    dismissed: false,
    official: true,
    stale: false,
    submitted_at: '2026-08-01T00:00:00Z',
    user: { login: 'reviewer1' },
    ...overrides,
  };
}

const unreadableBranch: ForgejoBranchInfo = { readable: false };
const unprotectedBranch: ForgejoBranchInfo = {
  readable: true,
  protected: false,
  requiredApprovals: 0,
  enableStatusCheck: false,
  statusCheckContexts: [],
  userCanMerge: true,
};
function protectedBranch(overrides: Partial<Extract<ForgejoBranchInfo, { readable: true }>> = {}): ForgejoBranchInfo {
  return {
    readable: true,
    protected: true,
    requiredApprovals: 1,
    enableStatusCheck: false,
    statusCheckContexts: [],
    userCanMerge: true,
    ...overrides,
  };
}

describe('computeReviewDecision', () => {
  // Rule 0: an unrecognized, non-empty review state must win over EVERY other rule below,
  // including the protected:false shortcut to 'unknown' — 'unknown' is not a blocking eligibility
  // state, so silently dropping a review we can't interpret would let a
  // request-changes-shaped-but-misspelled review through to 'ready'.
  it('an unrecognized non-empty state forces review-required, even alongside an APPROVED and even at protected:false', () => {
    const reviews = [reviewRow({ state: 'APPROVED' }), reviewRow({ state: 'FUTURE_STATE', user: { login: 'reviewer2' } })];
    expect(computeReviewDecision(reviews, unprotectedBranch)).toBe('review-required');
  });

  it('an unrecognized state still wins when the branch is unreadable', () => {
    expect(computeReviewDecision([reviewRow({ state: 'SOMETHING_NEW' })], unreadableBranch)).toBe('review-required');
  });

  it('the empty string state is a known "no signal" value, not an unrecognized one', () => {
    expect(computeReviewDecision([reviewRow({ state: '' })], unprotectedBranch)).toBe('unknown');
  });

  it('drops a dismissed review entirely', () => {
    const reviews = [reviewRow({ state: 'REQUEST_CHANGES', dismissed: true })];
    expect(computeReviewDecision(reviews, protectedBranch())).toBe('review-required'); // no active review at all
  });

  it('drops PENDING and REQUEST_REVIEW rows (not yet a real verdict)', () => {
    const reviews = [reviewRow({ state: 'PENDING' }), reviewRow({ state: 'REQUEST_REVIEW', user: { login: 'r2' } })];
    expect(computeReviewDecision(reviews, protectedBranch())).toBe('review-required');
  });

  it('keeps only official reviews once at least one official row exists', () => {
    const reviews = [
      reviewRow({ state: 'REQUEST_CHANGES', official: false, user: { login: 'drive-by' } }),
      reviewRow({ state: 'APPROVED', official: true }),
    ];
    expect(computeReviewDecision(reviews, protectedBranch())).toBe('approved');
  });

  it('collapses to the latest row per reviewer by submitted_at — a later APPROVED supersedes an earlier REQUEST_CHANGES', () => {
    const reviews = [
      reviewRow({ state: 'REQUEST_CHANGES', submitted_at: '2026-08-01T00:00:00Z' }),
      reviewRow({ state: 'APPROVED', submitted_at: '2026-08-02T00:00:00Z' }),
    ];
    expect(computeReviewDecision(reviews, protectedBranch())).toBe('approved');
  });

  it('any REQUEST_CHANGES after collapsing blocks with changes-requested', () => {
    const reviews = [reviewRow({ state: 'APPROVED', user: { login: 'r1' } }), reviewRow({ state: 'REQUEST_CHANGES', user: { login: 'r2' } })];
    expect(computeReviewDecision(reviews, protectedBranch())).toBe('changes-requested');
  });

  it('REQUEST_CHANGES blocks even when the branch is unreadable — it needs no branch-protection info', () => {
    expect(computeReviewDecision([reviewRow({ state: 'REQUEST_CHANGES' })], unreadableBranch)).toBe('changes-requested');
  });

  it('an unprotected branch is "no requirements" — always unknown, never approved, regardless of approvals', () => {
    expect(computeReviewDecision([reviewRow({ state: 'APPROVED' })], unprotectedBranch)).toBe('unknown');
  });

  it('a protected branch requiring 0 approvals is also "no requirements" — unknown, not approved', () => {
    expect(computeReviewDecision([reviewRow({ state: 'APPROVED' })], protectedBranch({ requiredApprovals: 0 }))).toBe('unknown');
  });

  it('an unreadable branch (no requirements info at all) is unknown', () => {
    expect(computeReviewDecision([reviewRow({ state: 'APPROVED' })], unreadableBranch)).toBe('unknown');
  });

  it('enough non-stale approvals on a protected branch requiring them satisfies review-required into approved', () => {
    const reviews = [reviewRow({ state: 'APPROVED', user: { login: 'r1' } }), reviewRow({ state: 'APPROVED', user: { login: 'r2' } })];
    expect(computeReviewDecision(reviews, protectedBranch({ requiredApprovals: 2 }))).toBe('approved');
  });

  it('a stale approval does not count toward the required_approvals threshold', () => {
    const reviews = [reviewRow({ state: 'APPROVED', stale: true })];
    expect(computeReviewDecision(reviews, protectedBranch({ requiredApprovals: 1 }))).toBe('review-required');
  });

  it('not enough approvals on a protected branch with a real requirement is review-required', () => {
    expect(computeReviewDecision([], protectedBranch({ requiredApprovals: 1 }))).toBe('review-required');
  });

  it('a later COMMENT from the same reviewer supersedes (drops) their earlier APPROVED — pinned, intentional behavior, see the doc comment above', () => {
    const reviews = [
      reviewRow({ state: 'APPROVED', submitted_at: '2026-08-01T00:00:00Z' }),
      reviewRow({ state: 'COMMENT', submitted_at: '2026-08-02T00:00:00Z' }),
    ];
    // Only one reviewer, and their standing review is now COMMENT — not enough to satisfy a
    // required approval, but also not a REQUEST_CHANGES, so this is 'review-required', not
    // 'changes-requested'.
    expect(computeReviewDecision(reviews, protectedBranch({ requiredApprovals: 1 }))).toBe('review-required');
  });

  it('a DIFFERENT reviewer\'s COMMENT never touches another reviewer\'s standing APPROVED', () => {
    const reviews = [
      reviewRow({ state: 'APPROVED', user: { login: 'r1' } }),
      reviewRow({ state: 'COMMENT', user: { login: 'r2' } }),
    ];
    expect(computeReviewDecision(reviews, protectedBranch({ requiredApprovals: 1 }))).toBe('approved');
  });

  it('collapses by NORMALIZED submitted_at, not the raw offset string — a later UTC instant with a smaller numeric offset still wins', () => {
    // 2026-10-25T02:30:00+02:00 is 00:30 UTC; 2026-10-25T02:10:00+01:00 is 01:10 UTC — the second
    // is chronologically LATER despite string-sorting earlier (raw "+01:00" < "+02:00" lexically
    // loses to the hour digits, but the two clocks straddle a DST fold where a smaller offset means
    // a later wall-clock hour). A stale REQUEST_CHANGES must not be resurrected by an earlier
    // APPROVED that merely strings-compares as "later".
    const reviews = [
      reviewRow({ state: 'REQUEST_CHANGES', submitted_at: '2026-10-25T02:10:00+01:00' }),
      reviewRow({ state: 'APPROVED', submitted_at: '2026-10-25T02:30:00+02:00' }),
    ];
    expect(computeReviewDecision(reviews, protectedBranch())).toBe('changes-requested');
  });
});

function mergePullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 9,
    title: 'add thing',
    html_url: 'http://forgejo:3000/acme/demo/pulls/9',
    user: { login: 'ajr' },
    created_at: '2026-08-07T10:00:00Z',
    labels: [],
    body: '',
    comments: 0,
    draft: false,
    additions: 3,
    deletions: 1,
    state: 'open',
    merged: false,
    mergeable: true,
    head: { ref: 'feat/x', sha: 'a'.repeat(40) },
    base: { ref: 'main' },
    ...overrides,
  };
}

const mergeStateRepo: ForgejoRepository = forgejoRepositorySchema.parse({
  default_branch: 'main',
  allow_merge_commits: true,
  allow_squash_merge: true,
});

describe('normalizeForgejoMergeState', () => {
  it('mergeable:false on a draft PR maps to mergeable:"unknown", never "conflicting" (drafts always report false)', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow({ draft: true, mergeable: false }),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.mergeable).toBe('unknown');
    expect(state.eligibility).toBe('blocked');
    expect(state.blockers).toEqual([{ code: 'draft', message: expect.any(String) }]);
  });

  it('a null/absent wire mergeable on an open, non-draft PR (Gitea still "Checking") maps to "unknown", not "conflicting"', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow({ mergeable: null }),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.mergeable).toBe('unknown');
    // Not "conflicting" — the ladder only special-cases `mergeable === 'conflicting'`. But it also
    // must not fall all the way through to 'ready': a "Checking"-shaped unknown is NOT a confirmed
    // mergeable PR, so the closing rung catches it and reports 'unknown' instead of a false-green
    // merge button.
    expect(state.eligibility).toBe('unknown');
    expect(state.blockers[0]?.code).toBe('unknown');
  });

  it('a real conflict (open, non-draft, mergeable:false) maps to conflicting and blocks merging without override', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow({ mergeable: false }),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.mergeable).toBe('conflicting');
    expect(state.eligibility).toBe('blocked');
    expect(state.blockers[0]?.code).toBe('conflicts');
    expect(state.canOverride).toBe(false); // conflicts is the one blocker that closes the override door
  });

  it('an unprotected branch reports reviewDecision:"unknown" WITHOUT a rules-unknown blocker — the rules are known: there are none', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.reviewDecision).toBe('unknown');
    expect(state.blockers.some((b) => b.code === 'rules-unknown')).toBe(false);
  });

  it('rules-unknown fires ONLY when the branch fetch itself failed (branch.readable:false) — a deliberate divergence from github.ts', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch: unreadableBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.eligibility).toBe('unknown');
    expect(state.blockers).toEqual([{ code: 'rules-unknown', message: expect.any(String) }]);
  });

  it('an unrecognized review state blocks with reviews/review-required even on an unprotected branch', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [reviewRow({ state: 'SOME_NEW_STATE' })],
    });
    expect(state.reviewDecision).toBe('review-required');
    expect(state.eligibility).toBe('blocked');
    expect(state.blockers[0]?.code).toBe('reviews');
  });

  it('statuses:null (no CI configured) maps to an empty checks array, not a failing/pending one', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { state: '', total_count: 0, statuses: null },
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks).toEqual([]);
    expect(state.eligibility).toBe('ready');
  });

  it('a "warning" status counts as failing and blocks with checks-failing', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'warning', context: 'ci/build', target_url: 'https://ci.example/1' }] },
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks).toEqual([{ name: 'ci/build', state: 'failing', required: false, url: 'https://ci.example/1' }]);
    expect(state.blockers[0]?.code).toBe('checks-failing');
  });

  it('a check url (target_url) is used as-is, filtered to http(s), and NOT rebased onto webUrl — it names a third-party CI host', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'success', context: 'ci/build', target_url: 'http://ci.internal:9000/run/1' }] },
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks[0]?.url).toBe('http://ci.internal:9000/run/1');
  });

  it('a non-http(s) target_url (e.g. "javascript:") is dropped, never surfaced as a check url', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'success', context: 'ci/build', target_url: 'javascript:alert(1)' }] },
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks[0]?.url).toBeUndefined();
  });

  it('a check\'s required field is null ("we don\'t know") on an unreadable branch, never false ("known not required")', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'success', context: 'ci/build' }] },
      branch: unreadableBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks[0]?.required).toBeNull();
  });

  it('a check\'s context matching status_check_contexts on a readable, status-check-gated branch is required:true', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'success', context: 'ci/build' }] },
      branch: protectedBranch({ enableStatusCheck: true, statusCheckContexts: ['ci/build'] }),
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks[0]?.required).toBe(true);
  });

  it('a check\'s context NOT in status_check_contexts on a readable, status-check-gated branch is required:false', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'success', context: 'ci/lint' }] },
      branch: protectedBranch({ enableStatusCheck: true, statusCheckContexts: ['ci/build'] }),
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.checks[0]?.required).toBe(false);
  });

  it('a pending check maps to eligibility:pending when nothing else blocks', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'pending', context: 'ci/build' }] },
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.eligibility).toBe('pending');
  });

  it('a merged PR reports state:"merged" and eligibility:terminal, never a bare "closed"', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow({ state: 'closed', merged: true }),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.state).toBe('merged');
    expect(state.eligibility).toBe('terminal');
    expect(state.blockers[0]?.code).toBe('terminal');
  });

  it('a genuinely closed (not merged) PR reports state:"closed"', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow({ state: 'closed', merged: false }),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.state).toBe('closed');
  });

  it('userCanMerge:false is read as unauthorized only when a token is present — without a token it is unreadable-by-design', () => {
    const branch = protectedBranch({ protected: false, requiredApprovals: 0, userCanMerge: false });
    const withoutToken = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(withoutToken.eligibility).not.toBe('unauthorized');
    expect(withoutToken.eligibility).toBe('ready');

    const withToken = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: true,
      reviewsRaw: [],
    });
    expect(withToken.eligibility).toBe('unauthorized');
    expect(withToken.blockers[0]?.code).toBe('unauthorized');
  });

  it('a fully clean PR is ready, and canMerge/canOverride follow eligibility:ready', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: { statuses: [{ status: 'success', context: 'ci/build' }] },
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.eligibility).toBe('ready');
    expect(state.canMerge).toBe(true);
    expect(state.canOverride).toBe(false); // nothing to override when already mergeable
  });

  it('rebases title (WIP-stripped) and url onto webUrl; carries head/base refs and sha, and methods/defaultMethod from the repository', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow({ draft: true, mergeable: false, title: 'WIP: add thing' }),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: mergeStateRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.title).toBe('add thing');
    expect(state.url).toBe('https://forge.example.com/acme/demo/pulls/9');
    expect(state.headRef).toBe('feat/x');
    expect(state.baseRef).toBe('main');
    expect(state.headSha).toBe('a'.repeat(40));
    expect(state.methods).toEqual(['merge', 'squash']);
    expect(state.defaultMethod).toBeNull();
  });

  it('a repository:null still returns a mergeState — just with no merge methods available', () => {
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: null,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.methods).toEqual([]);
    expect(state.defaultMethod).toBeNull();
  });

  it('methods:[] (a repository with every merge-method flag off) closes the ladder at unknown, not a false ready', () => {
    const noMethodsRepo: ForgejoRepository = forgejoRepositorySchema.parse({ default_branch: 'main' });
    const state = normalizeForgejoMergeState({
      pullRaw: mergePullRow(),
      statusRaw: null,
      branch: unprotectedBranch,
      repository: noMethodsRepo,
      webUrl,
      hasToken: false,
      reviewsRaw: [],
    });
    expect(state.methods).toEqual([]);
    expect(state.eligibility).toBe('unknown');
    expect(state.blockers).toEqual([{ code: 'unknown', message: expect.any(String) }]);
    // The one blocker that closes the override door is a conflict — methods:[] is not that, but
    // canOverride still requires methods.length > 0, so there is nothing to override onto either.
    expect(state.canOverride).toBe(false);
  });
});
