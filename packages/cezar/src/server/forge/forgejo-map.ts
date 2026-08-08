import { z } from 'zod';
import type { ForgeItem, ForgeMergeMethod, ForgePrChange, ForgePrCheck, ForgePrMergeState } from './types.ts';

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
 * Lives here rather than in `forgejo.ts` (where it was first written, before this module existed)
 * because both mappers below need it and `forgejo-map.ts` must not import from `forgejo.ts` — that
 * direction would create
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
  /** Used only by `normalizeForgejoMergeState` — absent from every list/prStatus row this schema
   *  also validates, hence `.nullish()`, never required. `false` here does NOT mean "conflict"
   *  (Gitea collapses four distinct statuses — Checking/Conflict/Error/WIP — into this one boolean;
   *  see `normalizeForgejoMergeState`'s own doc comment) — only `normalizeForgejoMergeState` is
   *  allowed to read this field. */
  mergeable: z.boolean().nullish(),
  /** Merge-state only, same reasoning as `mergeable` above — list/prStatus rows never read it. */
  base: z.object({ ref: z.string() }).nullish(),
  /** `mergePR`-only: the merge POST's own 200 response is empty on a live instance, so the merge
   *  commit sha is read back through a SEPARATE, follow-up `GET /pulls/{n}` that reuses this same
   *  schema. `.nullish()` because every other caller of this schema (list rows, prStatus rows, the
   *  pre-merge preflight read) either omits the field or doesn't care about it. */
  merge_commit_sha: z.string().nullish(),
});
export type ForgejoPull = z.infer<typeof forgejoPullSchema>;

/** `statuses` is `null` (not `[]`) on the live instance when a repository has no CI configured at
 *  all — a schema without `.nullish()` here throws on that exact, common shape. `combinedStatusToChecks`
 *  below only reads `status`; `context`/`target_url` are read one layer up, by
 *  `normalizeForgejoMergeState`'s per-check breakdown (`ForgePrCheck[]`) — the object's own
 *  top-level `state` rollup is measured unreliable and neither function trusts it. */
export const forgejoCombinedStatusSchema = z.object({
  statuses: z
    .array(
      z.object({
        status: z.string(),
        /** Check name shown in the UI. Default `''` rather than throwing — a status row missing its
         *  own context is still worth showing, just unlabeled. */
        context: z.string().default(''),
        target_url: z.string().nullish(),
      }),
    )
    .nullish(),
});

/** Classifies ONE raw Forgejo `CommitStatusState` value (`pending|success|error|failure|warning|""`,
 *  or any other unrecognized string) — the single source `combinedStatusToChecks` (the aggregate
 *  rollup, below) and `combinedStatusToPrChecks` (the per-check breakdown, further down) both build
 *  on, replacing what used to be two independently hand-written copies of this same mapping.
 *  `warning` counts as failing (a build that produced a warning-level status is not clean); `""`
 *  and any other unrecognized value classify as `'unknown'` — `combinedStatusToChecks` folds
 *  `'unknown'` into its `'pending'` rollup bucket (parity with `github.ts`'s `rollupToChecks`,
 *  which maps its own equivalent `''` to `'pending'` too — see that function's own doc comment for
 *  why a status this driver cannot classify must never render as a green badge), while
 *  `combinedStatusToPrChecks` surfaces `'unknown'` to the UI as its own distinct per-check state
 *  instead of folding it into anything. */
function classifyCommitStatus(status: string): 'passing' | 'failing' | 'pending' | 'unknown' {
  if (status === 'success') return 'passing';
  if (status === 'failure' || status === 'error' || status === 'warning') return 'failing';
  if (status === 'pending') return 'pending';
  return 'unknown';
}

/**
 * `null`/empty `statuses` (no CI configured) maps to `null`, never `'pending'` — `'pending'` would
 * spin the UI's CI indicator forever for a repository that has no CI at all. A non-empty `statuses`
 * array containing an unrecognized/empty entry rolls up to `'pending'`, not `'passing'` — this is
 * the list-row badge (`ForgePrStatus.checks`, `pullRowToStatus` in `forgejo.ts`), so a status this
 * driver could not read must never render as a green checkmark for a build that might genuinely be
 * red; parity with `github.ts`'s `rollupToChecks`, which maps its own `''` state to `'pending'` for
 * the identical reason.
 */
export function combinedStatusToChecks(raw: unknown): 'passing' | 'failing' | 'pending' | null {
  const { statuses } = forgejoCombinedStatusSchema.parse(raw);
  if (!statuses || statuses.length === 0) return null;
  const classified = statuses.map((s) => classifyCommitStatus(s.status));
  if (classified.includes('failing')) return 'failing';
  if (classified.includes('pending') || classified.includes('unknown')) return 'pending';
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

/** `GET /pulls/{n}/files` row. `status` is read as a plain string, not a `z.enum(...)` — an
 *  unrecognized value must degrade through `mapChangedFileStatus`'s own `default: 'changed'`
 *  branch, not throw and take the whole diff response down with it. `additions`/`deletions`
 *  default to 0 for the same reason `forgejoPullSchema`'s do: a row that's otherwise readable
 *  should never be discarded over one missing counter. `filename` is the join key `prDiff` uses
 *  to match this row against `splitUnifiedDiff`'s parsed patches (`forgejo-diff.ts`) — never `id`,
 *  this endpoint doesn't even carry one. */
export const forgejoChangedFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().nullish(),
  status: z.string(),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});
export type ForgejoChangedFile = z.infer<typeof forgejoChangedFileSchema>;

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
 * never adds a method — not because fast-forward-only isn't a real Forgejo merge style (its merge
 * API accepts `fast-forward-only` as a `Do` value exactly like `merge`/`squash`/`rebase` are), but
 * because cezar's own `ForgeMergeMethod` type has no value representing it, so there is nothing for
 * the flag to map onto. It IS a valid `default_merge_style` value though, handled below as
 * "whichever method survived the flags, first" since there's still no direct `ForgeMergeMethod` for it.
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
  // `allow_rebase` and `allow_rebase_explicit` are two Forgejo spellings of the SAME UI button
  // ('rebase'), but only the second one records `doFor.rebase = 'rebase-merge'`. When both flags
  // are set (Gitea's own default) `allow_rebase` wins the else-if above, so a repo whose
  // `default_merge_style` is the OTHER spelling matches nothing in the loop — even though the
  // method it names is plainly present. Both spellings therefore resolve to the same method here.
  if (defaultMethod === null && repo.default_merge_style === 'rebase-merge' && methods.includes('rebase')) {
    defaultMethod = 'rebase';
  }
  if (defaultMethod === null && repo.default_merge_style === 'fast-forward-only') {
    defaultMethod = methods[0] ?? null;
  }

  return { methods, defaultMethod, doFor };
}

/** `GET /repos/{o}/{r}/branches/{ref}` — every field is optional/defaulted (a live payload with a
 *  missing field must never itself be why `computeReviewDecision`/`normalizeForgejoMergeState`
 *  degrade). `branch_protections` is a DIFFERENT, separate endpoint that 401s without a token — it
 *  is deliberately never used; every field below is readable anonymously (measured). */
export const forgejoBranchSchema = z.object({
  protected: z.boolean().default(false),
  required_approvals: z.number().int().default(0),
  enable_status_check: z.boolean().default(false),
  status_check_contexts: z.array(z.string()).default([]),
  user_can_merge: z.boolean().default(false),
});

/**
 * The one piece of `GET /branches/{base}` this driver ever needs, pre-shaped into the discriminated
 * union `computeReviewDecision`/`normalizeForgejoMergeState` actually branch on. `readable: false`
 * is the ONLY trigger for the `rules-unknown` blocker (a deliberate divergence from
 * `github.ts:1651` — see `normalizeForgejoMergeState`'s doc comment) — it must be set by the caller
 * (`forgejo.ts`) exactly when the branch GET itself failed, never derived from field contents here.
 */
export type ForgejoBranchInfo =
  | { readable: false }
  | {
      readable: true;
      protected: boolean;
      requiredApprovals: number;
      enableStatusCheck: boolean;
      statusCheckContexts: string[];
      userCanMerge: boolean;
    };

/**
 * `GET /pulls/{n}/reviews` row. `state` is deliberately `z.string()`, NOT a `z.enum` of the known
 * `ReviewStateType` values — an unrecognized value must survive parsing as itself so
 * `computeReviewDecision`'s rule 0 can see it and refuse to silently drop it (an enum + `.catch('')`
 * would erase the exact signal that rule exists to catch). `dismissed`/`official`/`stale` are
 * siblings of `state`, not members of it — Forgejo has no `DISMISSED` review state on the wire:
 * a dismissed review keeps whatever `state` it was submitted with, and `dismissed` flags it
 * separately.
 */
export const forgejoReviewSchema = z.object({
  state: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  dismissed: z.boolean().default(false),
  official: z.boolean().default(false),
  stale: z.boolean().default(false),
  submitted_at: z.string().nullish(),
  user: z.object({ login: z.string() }).nullish(),
});
type ForgejoReview = z.infer<typeof forgejoReviewSchema>;

/** Every `ReviewStateType` value the live Gitea source is known to emit, PLUS `''` (no signal —
 *  this dictionary is read from source, not measured on the wire). Deliberately does NOT include
 *  GitHub's `CHANGES_REQUESTED`/`COMMENTED`/`DISMISSED` — those never appear on a Forgejo payload
 *  (Forgejo has no `DISMISSED` review state on the wire at all, see `forgejoReviewSchema`'s doc
 *  comment above), and treating them as "known" here would silently swallow the exact class of
 *  surprise rule 0 below exists to catch. */
const KNOWN_REVIEW_STATES = new Set(['APPROVED', 'PENDING', 'COMMENT', 'REQUEST_CHANGES', 'REQUEST_REVIEW', '']);

/** Return shape of `computeReviewDecision` — `decision` alone collapses two DIFFERENT reasons for
 *  landing on `'review-required'` into one indistinguishable value: "nobody has approved yet" and
 *  "a review row's `state` is something this driver cannot interpret" (rule 0, below). Both must
 *  block the merge identically, but they must NOT share a user-facing message — "a required review
 *  is missing" is false when a review plainly exists and simply couldn't be read.
 *  `normalizeForgejoMergeState` reads `unrecognized` to pick between the two blockers
 *  (`reviews-unrecognized` vs `reviews`); `unrecognized` is `false` for every other `decision`. */
export interface ReviewDecisionResult {
  decision: ForgePrMergeState['reviewDecision'];
  unrecognized: boolean;
}

/**
 * Forgejo has no `reviewDecision` field — this reconstructs GitHub's equivalent from
 * `GET /pulls/{n}/reviews` + the branch's protection settings:
 *
 *   0. FIRST, before anything else: any row with an unrecognized non-empty `state` forces
 *      'review-required' immediately — ahead of the official-only filter, ahead of the per-user
 *      collapse, and ahead of the `protected:false` shortcut to 'unknown'. Reasoning: 'unknown' is
 *      not a blocking `eligibility` value in `normalizeForgejoMergeState`'s ladder (only
 *      `rules-unknown`, gated on the branch fetch itself failing, is) — returning 'unknown' here
 *      would let a review this driver cannot interpret sail through to 'ready'. 'review-required'
 *      blocks the merge AND leaves `canOverride` open, so a human still has an escape hatch; it can
 *      never be mistaken for an approval. `unrecognized: true` on the return value is what lets
 *      `normalizeForgejoMergeState` say so honestly (`reviews-unrecognized`) instead of claiming a
 *      review is simply missing.
 *   1. drop `dismissed`, `PENDING`, `REQUEST_REVIEW` rows — none of them is a standing verdict.
 *   2. once any row is `official`, keep only official rows (Forgejo's own "counts toward the
 *      requirement" flag).
 *   3. collapse to the latest row per `user.login` by `submitted_at` — a reviewer's own later
 *      review supersedes their earlier one. This includes `COMMENT`: a reviewer's later `COMMENT`
 *      supersedes an earlier `APPROVED` from the SAME reviewer, dropping their approval from the
 *      count below. Intentional, not an oversight — `COMMENT` is still that reviewer's most recent
 *      standing input, and it is neither an approval nor a rejection; treating "latest row wins"
 *      uniformly (rather than special-casing `COMMENT` to be ignored) keeps the collapse a single
 *      rule with no state-dependent exception. This is a conservative choice about Forgejo/Gitea's
 *      OWN semantics, NOT verified against a live instance (no measurement exists for whether Gitea's
 *      own approval count treats a later `COMMENT` as superseding an earlier `APPROVED` the same way);
 *      it stands until such evidence says otherwise. A DIFFERENT reviewer's `COMMENT` never touches
 *      this one's approval — the collapse is per-`user.login`.
 *   4. any surviving `REQUEST_CHANGES` → 'changes-requested'. This does NOT depend on branch
 *      readability — a review that plainly asked for changes blocks regardless of whether the
 *      branch-protection GET succeeded.
 *   5/6. otherwise, only a branch with an ACTUAL requirement (`protected && requiredApprovals > 0`)
 *      can produce 'approved'/'review-required' — an unprotected branch, a protected branch with
 *      `requiredApprovals: 0`, or an unreadable branch are all "no requirements", which is
 *      'unknown', never 'approved' (parity: GitHub's `reviewDecision: null` maps to 'unknown' too,
 *      `github.ts`'s `normalizeMergeState`) — counting approvals against a threshold that doesn't
 *      exist would report certainty this driver does not have.
 */
export function computeReviewDecision(reviewsRaw: unknown, branch: ForgejoBranchInfo): ReviewDecisionResult {
  const rows = z.array(forgejoReviewSchema).parse(reviewsRaw);

  if (rows.some((r) => r.state !== '' && !KNOWN_REVIEW_STATES.has(r.state))) return { decision: 'review-required', unrecognized: true };

  const active = rows.filter((r) => !r.dismissed && r.state !== 'PENDING' && r.state !== 'REQUEST_REVIEW');
  const officialRows = active.filter((r) => r.official);
  const scoped = officialRows.length > 0 ? officialRows : active;

  const latestByUser = new Map<string, ForgejoReview>();
  for (const row of scoped) {
    const login = row.user?.login ?? '';
    const prev = latestByUser.get(login);
    // Compare NORMALIZED timestamps, not the raw wire strings: two Forgejo timestamps with
    // different numeric offsets (`+02:00` vs `+01:00`) do not string-compare in chronological
    // order, so a stale review submitted in one offset can outrank a later one submitted in
    // another — silently overturning e.g. a REQUEST_CHANGES with an out-of-date APPROVED.
    if (
      !prev ||
      (normalizeForgejoTimestamp(row.submitted_at) ?? '') >= (normalizeForgejoTimestamp(prev.submitted_at) ?? '')
    )
      latestByUser.set(login, row);
  }
  const collapsed = [...latestByUser.values()];

  if (collapsed.some((r) => r.state === 'REQUEST_CHANGES')) return { decision: 'changes-requested', unrecognized: false };

  if (!branch.readable || !branch.protected || branch.requiredApprovals <= 0) return { decision: 'unknown', unrecognized: false };

  const required = Math.max(1, branch.requiredApprovals);
  const approvals = collapsed.filter((r) => r.state === 'APPROVED' && !r.stale).length;
  return { decision: approvals >= required ? 'approved' : 'review-required', unrecognized: false };
}

/** `target_url` names a third-party CI system (a different host than both `apiUrl` and `webUrl` —
 *  a deliberate, documented exception to this driver's usual same-origin link rebasing) — filtered
 *  to http(s) but never rebased. Anything else (empty, `null`, a bare host, `javascript:` etc.) is
 *  dropped rather than surfaced as a link. */
function checkUrl(targetUrl: string | null | undefined): string | undefined {
  return targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) ? targetUrl : undefined;
}

/** Builds the per-check breakdown (`ForgePrCheck[]`) from a `CombinedStatus` body — `null`/empty
 *  `statuses` (no CI configured) becomes `[]`, never a single synthetic "unknown" entry: a repo
 *  with no CI has nothing to list, which is a different, calmer state than "a check exists whose
 *  state we can't read". */
function combinedStatusToPrChecks(statusRaw: unknown | null, branch: ForgejoBranchInfo): ForgePrCheck[] {
  if (statusRaw == null) return [];
  const { statuses } = forgejoCombinedStatusSchema.parse(statusRaw);
  if (!statuses) return [];
  return statuses.map((s): ForgePrCheck => {
    const state: ForgePrCheck['state'] = classifyCommitStatus(s.status);
    // Unreadable branch: we don't know which contexts are required, so `required` is `null`
    // ("we don't know"), not `false` ("known not required") — the two must stay distinguishable in
    // the UI. Readable + no status-check gate configured: every check is genuinely optional (`false`).
    const required = !branch.readable ? null : branch.enableStatusCheck ? branch.statusCheckContexts.includes(s.context) : false;
    const url = checkUrl(s.target_url);
    return { name: s.context, state, required, ...(url ? { url } : {}) };
  });
}

/**
 * Assembles `ForgePrMergeState` from the five raw payloads `prMergeState` fetches
 * (`GET /pulls/{n}`, the combined commit status, the branch, the paginated review list, and the
 * repository body `detectCache` already carries) — `reviewsRaw` is threaded straight through to
 * `computeReviewDecision`, the only way `reviewDecision` (part of this function's own return type)
 * can be produced. Pure — all I/O (including the `mergeable:false` retry described below) happens
 * one layer up, in `forgejo.ts`.
 *
 * Eligibility ladder (mirrors `github.ts:1636-1667`'s structure; two deliberate divergences, each
 * cited where it happens): `terminal` (not open) → `blocked/draft` → `blocked/conflicts` →
 * `blocked/checks-failing` (`warning` counts as failing) → `unknown/checks-unknown` (ONLY when the
 * combined-status fetch itself failed, `statusReadable:false` — never fires for a genuine "no CI
 * configured" read) → `unknown/reviews-unknown` (same contract, for a failed
 * `GET /pulls/{n}/reviews`) → `blocked/reviews-unrecognized` (a review row's `state` is something
 * this driver cannot interpret, via `computeReviewDecision`'s own rule 0 — NEVER worded as "review
 * missing", a review plainly exists) → `blocked/reviews` (a genuine "changes requested" or "not
 * enough approvals yet") → `unknown/rules-unknown`
 * (ONLY when the branch GET failed — divergence 1) → `unauthorized/unauthorized` (ONLY with a token
 * present — divergence 2) → `pending/pending` → `unknown/unknown` (mergeable still unresolved, or
 * no merge method available — the ladder's own closing rung, github.ts:1660-1667) → `ready`.
 */
export function normalizeForgejoMergeState(input: {
  pullRaw: unknown;
  statusRaw: unknown | null;
  /** Optional, defaults `true` (every existing call site — real and test — omits it and keeps
   *  today's behavior unchanged). Set to `false` ONLY when the combined-status fetch itself failed
   *  (network/HTTP error) — distinguishes that from `statusRaw: null` on a SUCCESSFUL read, which
   *  means "no CI configured" and stays 'ready'. Caller-supplied (`forgejo.ts`), never derived from
   *  `statusRaw`'s own shape here — this function has no way to tell the two apart from the body
   *  alone (a JSON `null` body vs. a `{statuses: null}` body both already collapse before they get
   *  here; the fetch's own success/failure is the only place that distinction still exists). */
  statusReadable?: boolean;
  branch: ForgejoBranchInfo;
  repository: ForgejoRepository | null;
  webUrl: string;
  hasToken: boolean;
  reviewsRaw: unknown;
  /** Same contract as `statusReadable`, for `GET /pulls/{n}/reviews`: `false` ONLY when that fetch
   *  itself failed, never derived from an empty `reviewsRaw` (a PR with genuinely zero reviews is
   *  the routine case). Without this, a failed reviews read silently degrades to `reviewsRaw: []`
   *  one layer up (`forgejo.ts`'s `fetchForgejoReviews`) — indistinguishable from "no reviews exist"
   *  — which could hide an active `REQUEST_CHANGES` behind a passing `reviewDecision`. */
  reviewsReadable?: boolean;
}): ForgePrMergeState {
  const pull = forgejoPullSchema.parse(input.pullRaw);

  // `state` alone never means "merged" — a merged PR reports `state:'closed', merged:true`.
  const state: ForgePrMergeState['state'] = pull.merged ? 'merged' : pull.state;

  // Gitea's `mergeable:false` collapses four distinct statuses (Checking/Conflict/Error/WIP) into
  // one boolean — it is NEVER trusted for a terminal or draft PR (both already measured to report
  // `false` while genuinely conflict-free). The retry this ambiguity demands (one re-fetch ~1.5s
  // after a `false` reading, on the `refresh:true` path) is I/O and lives in `forgejo.ts`, one layer
  // up — by the time `pullRaw` reaches this function, its `mergeable` value is already the retried
  // one.
  const mergeable: ForgePrMergeState['mergeable'] =
    state !== 'open' || pull.draft ? 'unknown' : pull.mergeable === true ? 'mergeable' : pull.mergeable === false ? 'conflicting' : 'unknown';

  const checks = combinedStatusToPrChecks(input.statusRaw, input.branch);
  const { decision: reviewDecision, unrecognized: reviewStateUnrecognized } = computeReviewDecision(input.reviewsRaw, input.branch);
  const statusReadable = input.statusReadable ?? true;
  const reviewsReadable = input.reviewsReadable ?? true;
  const { methods, defaultMethod } = input.repository
    ? mergeMethodsFromRepository(input.repository)
    : { methods: [] as ForgeMergeMethod[], defaultMethod: null };

  const blockers: ForgePrMergeState['blockers'] = [];
  let eligibility: ForgePrMergeState['eligibility'] = 'ready';
  if (state !== 'open') {
    eligibility = 'terminal';
    blockers.push({ code: 'terminal', message: state === 'merged' ? 'This pull request is merged.' : 'This pull request is closed.' });
  } else if (pull.draft) {
    eligibility = 'blocked';
    blockers.push({ code: 'draft', message: 'Mark the pull request ready for review before merging.' });
  } else if (mergeable === 'conflicting') {
    eligibility = 'blocked';
    blockers.push({ code: 'conflicts', message: 'Conflicts must be resolved before merging.' });
  } else if (checks.some((c) => c.state === 'failing')) {
    eligibility = 'blocked';
    blockers.push({ code: 'checks-failing', message: 'One or more checks are failing.' });
  } else if (!statusReadable) {
    // The combined-status fetch itself failed (network/HTTP error) — NOT the same thing as
    // `statusRaw: null` on a successful read (which means "no CI configured" and stays 'ready').
    // `checks` above is `[]` in both cases (`combinedStatusToPrChecks` has no way to tell them
    // apart from the body alone), so an unreadable read must block here explicitly, or it would
    // fall through this whole ladder exactly like a repo with no CI at all — a red build read as
    // green because the read that would have proven it red never landed.
    eligibility = 'unknown';
    blockers.push({ code: 'checks-unknown', message: 'Forgejo could not confirm CI status.' });
  } else if (!reviewsReadable) {
    // Same reasoning as `!statusReadable` above, for `GET /pulls/{n}/reviews`: a failed fetch
    // degrades to `reviewsRaw: []` one layer up, indistinguishable from a PR with genuinely zero
    // reviews — which `reviewDecision` below cannot tell apart from "we don't know" either.
    eligibility = 'unknown';
    blockers.push({ code: 'reviews-unknown', message: 'Forgejo could not confirm review status.' });
  } else if (reviewStateUnrecognized) {
    // A review WAS read successfully (`reviewsReadable` above is true) but at least one row's
    // `state` is a value `computeReviewDecision`'s rule 0 does not recognize — this is NOT "no
    // review exists"; a `reviews`-coded "required review is missing" message would misdescribe it.
    // `eligibility` still blocks (never 'unknown' — see rule 0's own doc comment for why), it just
    // gets its own honest code/message instead of borrowing the "missing" one.
    eligibility = 'blocked';
    blockers.push({ code: 'reviews-unrecognized', message: 'Forgejo returned a review state cezar cannot interpret.' });
  } else if (reviewDecision === 'changes-requested' || reviewDecision === 'review-required') {
    eligibility = 'blocked';
    blockers.push({
      code: 'reviews',
      message: reviewDecision === 'changes-requested' ? 'Changes were requested.' : 'A required review is missing.',
    });
  } else if (!input.branch.readable) {
    // Divergence 1 from github.ts:1651 (deliberate): github.ts fires this
    // blocker whenever `reviewDecision === 'unknown'`, but on Forgejo `reviewDecision:'unknown'` is
    // the ROUTINE answer for an unprotected branch (no requirements configured — see
    // `computeReviewDecision`'s doc comment). Firing `rules-unknown` on that would paint every
    // unprotected-branch PR yellow. `rules-unknown` means exactly one thing here: the
    // `GET /branches/{base}` call itself failed, so branch-protection state is genuinely unknown —
    // not that Forgejo has no requirements configured.
    eligibility = 'unknown';
    blockers.push({ code: 'rules-unknown', message: 'Forgejo could not confirm branch-protection requirements.' });
  } else if (input.hasToken && !input.branch.userCanMerge) {
    // Divergence 2: `Branch.user_can_merge` (and `Repository.permissions`) read as `false` for an
    // ANONYMOUS request too — indistinguishable from "authenticated but forbidden"
    // without gating on `hasToken`. `github.ts` has no `unauthorized` eligibility at all; Forgejo
    // needs one because, unlike `gh`, this driver can legitimately talk to a public repo with zero
    // credentials, where "false" carries no permission information whatsoever.
    eligibility = 'unauthorized';
    blockers.push({ code: 'unauthorized', message: 'You do not have permission to merge this pull request.' });
  } else if (checks.some((c) => c.state === 'pending')) {
    eligibility = 'pending';
    blockers.push({ code: 'pending', message: 'Checks are still pending.' });
  } else if (mergeable !== 'mergeable') {
    // Closing rung of the ladder, mirroring github.ts:1660-1667: everything above only rules OUT
    // known blockers — it never confirms merge is actually possible. Without this rung, a PR whose
    // `mergeable` reading is still 'unknown' (Gitea hasn't finished computing it) would fall through
    // to the default `eligibility = 'ready'` above, reporting a green, mergeable-looking PR that
    // `mergePR` would then reject.
    eligibility = 'unknown';
    blockers.push({ code: 'unknown', message: 'Forgejo could not confirm every merge requirement.' });
  } else if (methods.length === 0) {
    // Same closing rung, split from the `mergeable !== 'mergeable'` branch above so a READABLE
    // repository confirmed to expose zero usable merge methods (e.g. one flagging only
    // `allow_fast_forward_only_merge` — a real Forgejo merge style cezar's own `ForgeMergeMethod`
    // has no value for, see `mergeMethodsFromRepository`'s own doc comment) gets an honest, specific
    // message instead of the vague "could not confirm" one. `input.repository` is `null` only when
    // the repository body itself could not be fetched/parsed — that case keeps the original vague wording, since THAT
    // one genuinely is an unread state, not a confirmed one.
    eligibility = 'unknown';
    blockers.push(
      input.repository
        ? { code: 'no-merge-method', message: 'This repository has no merge method enabled that cezar supports.' }
        : { code: 'unknown', message: 'Forgejo could not confirm every merge requirement.' },
    );
  }

  const canMerge = eligibility === 'ready';
  // Same formula as github.ts:1668-1674 — override is only ever offered for a genuinely open,
  // non-draft, non-conflicting PR with at least one usable merge method; a conflict is the one
  // blocker that closes this door entirely (merging unresolved conflicts is not an override, it's
  // data loss).
  const canOverride = !canMerge && state === 'open' && !pull.draft && mergeable !== 'conflicting' && methods.length > 0;

  return {
    number: pull.number,
    title: stripWipTitle(pull.title, pull.draft),
    url: rebaseToWebUrl(pull.html_url, input.webUrl),
    state,
    isDraft: pull.draft,
    headRef: pull.head?.ref ?? '',
    baseRef: pull.base?.ref ?? '',
    headSha: pull.head?.sha ?? '',
    mergeable,
    reviewDecision,
    checks,
    methods,
    defaultMethod,
    eligibility,
    blockers,
    canMerge,
    canOverride,
  };
}
