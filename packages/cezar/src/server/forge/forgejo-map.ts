import { z } from 'zod';
import type { ForgeItem, ForgeMergeMethod, ForgePrChange } from './types.ts';

/**
 * Pure Forgejo REST → cockpit shape mappers, plus the zod schemas that validate the wire payloads
 * they read. Zero I/O — every function here takes an already-fetched `unknown` body (or a plain
 * value) and returns a value or throws a `ZodError`. `forgejo.ts` is the only caller, and it is
 * the only place that touches `fetch`; this module must stay a leaf (no import from `forgejo.ts`
 * or `forgejo-http.ts`) so `forgejo.ts` can safely import it without an import cycle.
 */

/** Same cap as `github.ts`'s own issue/PR body slice — kept as its own constant here (not shared
 *  with `github.ts`, which is out of scope for this driver) so a future divergence is a one-line
 *  edit, not a hunt through call sites. */
export const FJ_BODY_CAP = 8_000;

/**
 * `html_url` (and every other Forgejo-served link) points at whatever host issued the API
 * response — measured to differ from `apiUrl`'s host on a live instance (a docker-network
 * hostname like `forgejo:3000` vs. the browser-reachable `forge.example.com`). Every URL leaving
 * the driver funnels through here: take only path+query+hash from `htmlUrl` and rebase it onto
 * `webUrl`, the address a human's browser can actually reach.
 *
 * Lives here rather than in `forgejo.ts` (where it was first written and is still re-exported for
 * backward compatibility with existing imports/tests) because both mappers below need it and
 * `forgejo-map.ts` must not import from `forgejo.ts` — that direction would create
 * `forgejo.ts` -> `forgejo-map.ts` -> `forgejo.ts`, an import cycle.
 */
export function rebaseToWebUrl(htmlUrl: string, webUrl: string): string {
  const src = new URL(htmlUrl);
  const dst = new URL(webUrl);
  return `${dst.origin}${src.pathname}${src.search}${src.hash}`;
}

/**
 * Forgejo timestamps arrive with a numeric offset (`+02:00`), never `Z` — sorting the raw strings
 * with `localeCompare` (as `mergeThread` does for GitHub's already-`Z` timestamps, github.ts:792)
 * would silently misorder rows around any offset boundary. Route everything through
 * `Date#toISOString()` so every timestamp this driver emits is directly comparable.
 *
 * Two sentinels the live instance is known to emit for "no such timestamp" (a closed_at/merged_at
 * field on a still-open issue, for example): `0001-01-01T00:00:00Z` and, once its `+01:00` offset
 * is applied, `1970-01-01T01:00:00+01:00` -> `1970-01-01T00:00:00.000Z`. Both land in 1970 or
 * earlier, so `year < 1971` catches both with one gate instead of two hardcoded string literals
 * that would silently stop matching if the server ever emitted a slightly different sentinel.
 */
export function normalizeForgejoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() < 1971) return null;
  return parsed.toISOString();
}

const WIP_PREFIX_RE = /^(?:\[wip\]|wip:)\s*/i;

/**
 * Forgejo has no `draft` flag on the wire for *display purposes* the way GitHub's UI does — draft
 * status is real (`draft: true` on the PR resource) but Forgejo's own web UI additionally prefixes
 * the title with "WIP:" or "[WIP]" (measured on a live instance: `title: "WIP: fix thing"`,
 * `draft: true`, both present together). Strip the prefix for display since `ForgeItem.isDraft`
 * already carries the same information as a proper field — but ONLY when `draft` is actually true:
 * a non-draft PR whose author literally typed "WIP:" in their title keeps it, because there's
 * nothing in the data proving it's not deliberate title text on a ready PR.
 */
export function stripWipTitle(title: string, isDraft: boolean): string {
  if (!isDraft) return title;
  return title.replace(WIP_PREFIX_RE, '');
}

const forgejoUserSchema = z.object({ login: z.string() });

/** `/issues` on a live instance also returns pull-request rows (measured: 3 rows returned, all 3
 *  were PRs) — Forgejo does not separate the two resources the way GitHub's REST API does. Each PR
 *  row carries a non-null `pull_request`; a genuine issue row carries `null` (or omits the field
 *  entirely on older servers, hence `.nullish()`). The `?type=issues` query param filters most of
 *  these server-side (driver-level, not this schema's job) — `mapForgejoIssue` below is the second,
 *  belt-and-braces layer that never trusts the query param alone. */
export const forgejoIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  user: forgejoUserSchema.nullish(),
  created_at: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  body: z.string().nullish(),
  comments: z.number().int().default(0),
  pull_request: z.unknown().nullish(),
});

/** Covers both list rows (`/pulls`) and the `prStatus` walk (`/pulls?state=all` + the
 *  `/pulls/{base}/{head}` fallback) — one shape, since both endpoints return the same PR resource.
 *  `state`/`merged`/`head` are unused by `mapForgejoPull` (list rows) but load-bearing for
 *  `prStatus` in `forgejo.ts`. */
export const forgejoPullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  user: forgejoUserSchema.nullish(),
  created_at: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  body: z.string().nullish(),
  comments: z.number().int().default(0),
  draft: z.boolean().default(false),
  additions: z.number().int().nullish(),
  deletions: z.number().int().nullish(),
  state: z.enum(['open', 'closed']).default('open'),
  merged: z.boolean().default(false),
  head: z.object({ ref: z.string(), sha: z.string() }).nullish(),
});
export type ForgejoPull = z.infer<typeof forgejoPullSchema>;

/** `statuses` is `null` (not `[]`) on the live instance when a repository has no CI configured at
 *  all — a schema without `.nullish()` here throws on that exact, common shape. Only the array
 *  entries' `status` field is read; the object's own top-level `state` is a rollup GitHub-style
 *  drivers might trust, but Forgejo's is measured unreliable and `combinedStatusToChecks` below
 *  never reads it. */
export const forgejoCombinedStatusSchema = z.object({
  statuses: z.array(z.object({ status: z.string() })).nullish(),
});

/**
 * `CommitStatusState` on the wire is `pending|success|error|failure|warning|""`. `warning` counts
 * as failing (a build that produced a warning-level status is not clean); `""` and any other
 * unrecognized value count as neither failing nor pending, so a single stray/unknown entry cannot
 * flip an otherwise-green build to a spinner or a red X. `null`/empty `statuses` (no CI configured)
 * maps to `null`, never `'pending'` — `'pending'` would spin the UI's CI indicator forever for a
 * repository that has no CI at all.
 */
export function combinedStatusToChecks(raw: unknown): 'passing' | 'failing' | 'pending' | null {
  const { statuses } = forgejoCombinedStatusSchema.parse(raw);
  if (!statuses || statuses.length === 0) return null;
  const states = statuses.map((s) => s.status);
  if (states.some((s) => s === 'failure' || s === 'error' || s === 'warning')) return 'failing';
  if (states.some((s) => s === 'pending')) return 'pending';
  return 'passing';
}

/** Forgejo's changed-file `status` enum (`added|deleted|renamed|copied|changed|unchanged`) maps
 *  onto `ForgePrChange['status']` (`added|modified|removed|renamed|copied|changed`) — the two
 *  enums are close but not identical: Forgejo's `deleted` is `removed` on our side, and BOTH
 *  Forgejo's `changed` (content changed) and `unchanged` (mode-only change with no content diff)
 *  collapse onto our generic `changed`/`modified`. Any unrecognized value degrades to `changed`
 *  rather than throwing — a changed-files row the UI can't precisely shade is still worth showing. */
export function mapChangedFileStatus(status: string): ForgePrChange['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'deleted':
      return 'removed';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    case 'changed':
      return 'modified';
    case 'unchanged':
      return 'changed';
    default:
      return 'changed';
  }
}

/**
 * Maps a raw `/issues` row to `ForgeItem`, or `null` when the row is actually a pull request (see
 * `forgejoIssueSchema`'s comment). `number`, never `id`: Forgejo's `id` is a global identifier
 * across the whole instance (PR #1 in one repo can have `id: 11`), but every user-facing surface
 * and URL path segment uses the per-repo `number` instead.
 */
export function mapForgejoIssue(raw: unknown, webUrl: string): ForgeItem | null {
  const parsed = forgejoIssueSchema.parse(raw);
  if (parsed.pull_request != null) return null;
  return {
    kind: 'issue',
    number: parsed.number,
    title: parsed.title,
    author: parsed.user?.login ?? '?',
    createdAt: normalizeForgejoTimestamp(parsed.created_at) ?? parsed.created_at,
    labels: parsed.labels.map((l) => l.name),
    body: (parsed.body ?? '').slice(0, FJ_BODY_CAP),
    url: rebaseToWebUrl(parsed.html_url, webUrl),
    comments: parsed.comments,
  };
}

/** Maps a raw `/pulls` row to `ForgeItem`. `checks: null` — parity with `github.ts`'s own list
 *  mapping (#664): a list of 30 rows never pays for 30 CI-status round-trips, only the row a user
 *  actually opens gets one (via `prStatus`/a future detail fetch). */
export function mapForgejoPull(raw: unknown, webUrl: string): ForgeItem {
  const parsed = forgejoPullSchema.parse(raw);
  return {
    kind: 'pr',
    number: parsed.number,
    title: stripWipTitle(parsed.title, parsed.draft),
    author: parsed.user?.login ?? '?',
    createdAt: normalizeForgejoTimestamp(parsed.created_at) ?? parsed.created_at,
    labels: [...parsed.labels.map((l) => l.name), ...(parsed.draft ? ['draft'] : [])],
    body: (parsed.body ?? '').slice(0, FJ_BODY_CAP),
    url: rebaseToWebUrl(parsed.html_url, webUrl),
    comments: parsed.comments,
    isDraft: parsed.draft,
    additions: parsed.additions ?? 0,
    deletions: parsed.deletions ?? 0,
    checks: null,
  };
}

/** All fields optional/defaulted: this schema validates whatever a live `Repository` body hands
 *  back, and must never itself be the reason `detect()` reports `available:false` for an otherwise
 *  healthy probe. */
export const forgejoRepositorySchema = z.object({
  default_branch: z.string().default('main'),
  allow_merge_commits: z.boolean().default(false),
  allow_squash_merge: z.boolean().default(false),
  allow_rebase: z.boolean().default(false),
  allow_rebase_explicit: z.boolean().default(false),
  allow_fast_forward_only_merge: z.boolean().default(false),
  default_merge_style: z.string().nullish(),
  has_pull_requests: z.boolean().default(true),
  archived: z.boolean().default(false),
  permissions: z
    .object({ admin: z.boolean().optional(), push: z.boolean().optional(), pull: z.boolean().optional() })
    .optional(),
});
export type ForgejoRepository = z.infer<typeof forgejoRepositorySchema>;

/**
 * Flattens a `ForgejoRepository`'s four independent merge-method flags into the ordered list the
 * merge-state UI renders, plus a `doFor` lookup a future `mergePR` implementation uses to pick the
 * Forgejo API merge-style string for a chosen `ForgeMergeMethod`. `allow_fast_forward_only_merge`
 * never adds a method — fast-forward-only is a *constraint* on how `merge` behaves, not a fourth
 * selectable method — but it IS a valid `default_merge_style` value, handled below as "whichever
 * method survived the flags, first" since there's no direct `ForgeMergeMethod` it maps onto.
 *
 * `allow_rebase` and `allow_rebase_explicit` both produce the SAME `methods` entry (`'rebase'`) —
 * Forgejo exposes them as two different merge-style API values ('rebase' merges the true history,
 * 'rebase-merge' additionally creates a merge commit) for what the cockpit UI shows as one button.
 * `allow_rebase` wins when both are set, matching Forgejo's own default UI's own preference order.
 */
export function mergeMethodsFromRepository(repo: ForgejoRepository): {
  methods: ForgeMergeMethod[];
  defaultMethod: ForgeMergeMethod | null;
  doFor: Partial<Record<ForgeMergeMethod, 'merge' | 'squash' | 'rebase' | 'rebase-merge'>>;
} {
  const methods: ForgeMergeMethod[] = [];
  const doFor: Partial<Record<ForgeMergeMethod, 'merge' | 'squash' | 'rebase' | 'rebase-merge'>> = {};

  if (repo.allow_merge_commits) {
    methods.push('merge');
    doFor.merge = 'merge';
  }
  if (repo.allow_squash_merge) {
    methods.push('squash');
    doFor.squash = 'squash';
  }
  if (repo.allow_rebase) {
    methods.push('rebase');
    doFor.rebase = 'rebase';
  } else if (repo.allow_rebase_explicit) {
    methods.push('rebase');
    doFor.rebase = 'rebase-merge';
  }

  let defaultMethod: ForgeMergeMethod | null = null;
  for (const method of methods) {
    if (doFor[method] === repo.default_merge_style) {
      defaultMethod = method;
      break;
    }
  }
  if (defaultMethod === null && repo.default_merge_style === 'fast-forward-only') {
    defaultMethod = methods[0] ?? null;
  }

  return { methods, defaultMethod, doFor };
}
