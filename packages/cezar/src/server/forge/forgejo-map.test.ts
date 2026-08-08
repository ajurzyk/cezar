import { describe, expect, it } from 'vitest';
import {
  combinedStatusToChecks,
  FJ_BODY_CAP,
  forgejoRepositorySchema,
  mapChangedFileStatus,
  mapForgejoIssue,
  mapForgejoPull,
  mergeMethodsFromRepository,
  normalizeForgejoTimestamp,
  rebaseToWebUrl,
  stripWipTitle,
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
  // Implemented here (both mappers above call it directly) and re-exported from forgejo.ts, which
  // must import it FROM forgejo-map.ts rather than the reverse — forgejo-map.ts stays a leaf
  // module, avoiding a forgejo.ts <-> forgejo-map.ts import cycle. forgejo.test.ts already covers
  // the full behavior in detail; this is a single smoke check that the module wiring is correct,
  // not a duplicate of that coverage.
  it('rebases host+path+query onto webUrl, path/query from html_url', () => {
    expect(rebaseToWebUrl('http://forgejo:3000/acme/demo/pulls/1?tab=files', webUrl)).toBe(
      'https://forge.example.com/acme/demo/pulls/1?tab=files',
    );
  });
});
