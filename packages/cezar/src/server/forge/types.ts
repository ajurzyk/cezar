import { z } from 'zod';
import type { RunRecord } from '../../runs/store.ts';

/**
 * Forge-driver seam (cockpit-ui redesign spec §"Forge-driver seam"): every
 * code-forge integration (GitHub today, GitLab later) implements `ForgeDriver`.
 * The interface is shaped strictly around what the cockpit already does via
 * `gh` — issue/PR listing for the GitHub tab, draft-PR creation for the review
 * gate, a per-branch PR probe, and web-URL building. Adding a forge = one new
 * driver file behind `resolveForge`, no route or UI changes.
 */

/** The forge kinds `resolveForge` can recognize. The one list on the cezar side of the seam —
 *  `config.ts` builds its `z.enum` from this, so adding a forge here propagates to the config
 *  schema in one place. The `packages/contract` copies stay literal (the contract cannot import
 *  from the service — the dependency direction is the other way); `contract-parity*.test.ts`
 *  catches drift between the two lists. */
export const FORGE_KINDS = ['github', 'forgejo'] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/**
 * Canonical shape of the `forge` key in `.ai/cezar/config.json`, declared ONCE here as a zod
 * object: `config.ts` composes this schema instead of re-declaring the fields, so adding or
 * retyping a field cannot drift between the parser and the type the drivers consume.
 *
 * A self-hosted forge has three independent addresses — the git remote, the REST API as
 * reachable from the cezar process (e.g. a docker-network hostname), and the web link base for
 * a human — and none of them can be derived from the others, which is why `apiUrl`/`webUrl` are
 * separate fields rather than one URL.
 *
 * Lives here (not in `config.ts`) because `types.ts` is a leaf: its only other import
 * (`RunRecord`) is type-only, so `config.ts` can pull this in without creating an import cycle.
 */
export const forgeSettingsSchema = z.object({
  kind: z.enum(FORGE_KINDS),
  // `.url()` alone accepts any scheme a `new URL()` parses — `javascript:`, `file:`, `data:`
  // included. Both fields become driver-facing addresses (a REST base and a link base), so pin
  // them to http/https rather than let a resource-owned config carry a scheme no consumer of
  // this key was ever meant to receive.
  apiUrl: z.string().url().refine((value) => /^https?:\/\//i.test(value)),
  webUrl: z.string().url().refine((value) => /^https?:\/\//i.test(value)),
});

export type ForgeSettings = z.infer<typeof forgeSettingsSchema>;

/** Availability probe result — mirrors the tab's quiet degradation contract:
 *  no CLI, no remote, offline all land on `available:false` + a human hint. */
export interface ForgeAvailability {
  available: boolean;
  /** Human-readable hint when unavailable (`gh` missing, no remote, offline…). */
  reason?: string;
}

/** One issue or pull request, flattened for the cockpit. `/api/github` serves
 *  exactly this shape (BACKWARD_COMPATIBILITY.md §2 — do not reshape). */
export interface ForgeItem {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author: string;
  createdAt: string;
  labels: string[];
  body: string;
  url: string;
  comments: number;
  /** PRs only. */
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  checks?: 'passing' | 'failing' | 'pending' | null;
}

/** One comment (or PR review summary) in an issue/PR conversation thread (#499). Served by the
 *  new `GET /api/github/comments/:kind/:number` endpoint; additive, no impact on `ForgeItem`. */
export interface ForgeComment {
  id: number;
  /** Author login, `'?'` fallback when gh omits the user. */
  author: string;
  /** https://avatars.githubusercontent.com/…, when known. */
  avatarUrl?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Markdown body, sliced to the same 8 000-char cap as item bodies. */
  body: string;
  /** `review` = a submitted PR review summary; `comment` = a conversation comment. */
  kind: 'comment' | 'review';
  /** For reviews only — drives the state chip. */
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  /** html_url deep link back to the comment/review on GitHub. */
  url: string;
}

/** The timeline event kinds the thread renders (#525). An allowlist, not a denylist: a new
 *  GitHub event type is dropped rather than rendered, so it can never crash or clutter the
 *  thread. `reviewed` is deliberately absent — reviews stay sourced from `/pulls/{n}/reviews`,
 *  which is already normalized and chipped; sourcing both would render each review twice. */
export type ForgeTimelineEventKind =
  | 'committed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'head_ref_force_pushed'
  | 'cross-referenced'
  | 'renamed';

/** One non-comment row in an issue/PR timeline (#525) — a commit, label change, assignment,
 *  merge, force-push, cross-reference or rename. Additive: `ForgeComment` is untouched and its
 *  `kind` deliberately does NOT widen to cover these (widening breaks client narrowing). */
export interface ForgeTimelineEvent {
  /** `evt-${id ?? sha ?? node_id ?? index}`. Prefixed so it cannot collide with the thread's
   *  `${kind}-${id}` comment keys. `sha` sits ahead of `node_id` because `committed` rows carry
   *  both and the SHA is the natural, debuggable identifier — it is also the rollup key. */
  id: string;
  kind: ForgeTimelineEventKind;
  /** Login — or the git author name for `committed`, which carries no GitHub actor. */
  actor: string;
  /** Absent for `committed` (a git author has no avatar). */
  avatarUrl?: string;
  /** ISO-8601. Resolved per kind: `committed` reads `author.date`, everything else
   *  `created_at` — `committed` rows return `created_at: null`, and mapping it naively
   *  string-sorts every commit to the top of the thread. */
  createdAt: string;
  url?: string;
  /** `committed` — full 40-char SHA (the rollup query rejects abbreviated ones). */
  sha?: string;
  /** `committed` — first line of the message, capped at 120 chars. */
  message?: string;
  /** `committed` — rolled-up CI state. **Absent** (query failed or skipped) and **`null`** (no CI
   *  configured) both render no glyph but stay distinct values for diagnosis. */
  checks?: 'passing' | 'failing' | 'pending' | null;
  /** `labeled` / `unlabeled`. */
  label?: { name: string; color?: string };
  /** `assigned`/`unassigned` login, or the new title for `renamed`. */
  subject?: string;
  /** `cross-referenced`. */
  refNumber?: number;
  refTitle?: string;
  refIsPr?: boolean;
}

/** The `GET /api/github/comments/:kind/:number` payload — mirrors the tab's quiet-degrade
 *  contract (`available: false` + a hint, never a 5xx). */
export interface ForgeCommentsData {
  available: boolean;
  /** Human-readable hint when unavailable. */
  reason?: string;
  /** Chronological, oldest first. */
  comments: ForgeComment[];
  /** True when either stream hit its cap, or the timeline fetch stopped short. Means "not
   *  showing you everything" — not specifically "comments were cut". */
  truncated?: boolean;
  /** Timeline events (#525) — additive and optional; absent when the timeline fetch degraded to
   *  the legacy comments-only call. Capped independently of `comments`, which keeps its exact
   *  pre-#525 shape, contents and cap (BACKWARD_COMPATIBILITY.md §2). */
  events?: ForgeTimelineEvent[];
}

export interface ForgeListOptions {
  /** Bypass the driver's short cache. */
  refresh?: boolean;
  /** Max items to fetch (driver-capped). */
  limit?: number;
}

/** Result of `listIssues`/`listPRs` — flat, mirroring `githubDataSchema`
 *  (`packages/contract/src/github.ts`, deliberately flat rather than a discriminated union) so the
 *  `/api/github` route can compose one from the other without reshaping. A forge that cannot be
 *  reached carries `available: false` + a human `reason` and STILL returns `items: []` — never an
 *  empty list standing in for an unreported failure (a real "no issues" repo and a down forge used
 *  to both serve `[]`, indistinguishably). The meta fields (`repo`/`syncedAt`/
 *  `labelColors`) are optional so a route composing a byte-identical `GithubData` from this shape
 *  can spread them conditionally without ever widening an absent key to `undefined` on the wire. */
export interface ForgeListResult {
  available: boolean;
  /** Human-readable hint. Present on failure; the field itself is legal at `available:true` too
   *  (`githubDataSchema`'s own doc: "never an error — a hint"), which a future `/api/github` route
   *  composing `listIssues`+`listPRs` can use to surface "one of the two lists failed" without
   *  gating the whole payload on it. */
  reason?: string;
  items: ForgeItem[];
  /** owner/name, when known. */
  repo?: string;
  syncedAt?: string;
  labelColors?: Record<string, string>;
}

/** Where an existing branch's PR stands — feeds the Create PR → View PR flip. */
export interface ForgePrStatus {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  checks: 'passing' | 'failing' | 'pending' | null;
}

/** Result of `prStatus` — a discriminated union (precedent: `ForgePrDiffResult`,
 *  `ForgePrMergeStateResult` below), unlike `ForgeListResult`'s flat shape: there is no
 *  `GithubData`-style route composing this back into a bigger payload, so nothing needs the meta
 *  fields spreadable. `status: null` at `available:true` is a proven "no PR for this
 *  branch" — the driver actually read enough to know. `available:false` means the read that would
 *  have proven either answer failed (forge down, bad token, transport error, or the driver's own
 *  search walk running out of budget before it could prove "no match") — the caller (Create PR →
 *  View PR flip) must not treat that the same as a genuinely absent PR. */
export type ForgePrStatusResult =
  | { available: true; status: ForgePrStatus | null }
  | { available: false; reason: string };

/** Result of `listChecks` — a discriminated union (same precedent as `ForgePrStatusResult`/
 *  `ForgePrDiffResult`), mirroring `githubChecksDataSchema` (`packages/contract/src/github.ts:65`,
 *  itself a `z.discriminatedUnion('available', …)`) rather than `ForgeListResult`'s flat shape:
 *  there is no bigger payload this composes into, so nothing needs spreadable meta fields. */
export type ForgeChecksResult =
  | { available: true; checks: Record<number, 'passing' | 'failing' | 'pending' | null> }
  | { available: false; reason: string };

export type ForgeMergeMethod = 'merge' | 'squash' | 'rebase';

export interface ForgePrCheck {
  name: string;
  state: 'passing' | 'failing' | 'pending' | 'unknown';
  required: boolean | null;
  url?: string;
}

export interface ForgePrMergeState {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'unknown';
  checks: ForgePrCheck[];
  methods: ForgeMergeMethod[];
  defaultMethod: ForgeMergeMethod | null;
  eligibility: 'ready' | 'blocked' | 'pending' | 'unauthorized' | 'terminal' | 'unknown';
  blockers: Array<{ code: string; message: string }>;
  canMerge: boolean;
  canOverride: boolean;
}

export type ForgePrMergeStateResult =
  | { available: true; mergeState: ForgePrMergeState }
  | { available: false; reason: string };

export interface ForgeMergeInput {
  method: ForgeMergeMethod;
  expectedHeadSha: string;
  overrideRules?: boolean;
}

export type ForgeMergeResult =
  | {
      merged: true;
      number: number;
      url: string;
      method: ForgeMergeMethod;
      mergeCommitSha?: string;
    }
  | {
      merged: false;
      status: 403 | 404 | 409 | 502;
      error: string;
      code?: string;
      current?: ForgePrMergeState;
    };

export interface ForgePrChange {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  patch?: string;
  patchUnavailableReason?: 'binary' | 'too-large' | 'not-provided';
  truncated?: boolean;
}

export type ForgePrDiffResult =
  | {
      available: true;
      number: number;
      headSha: string;
      files: ForgePrChange[];
      additions: number;
      deletions: number;
      truncated: boolean;
      reason?: string;
    }
  | { available: false; reason: string };
export type ForgeRefKind = 'repo' | 'issue' | 'pr' | 'branch' | 'commit';

export type DraftPrOutcome =
  | { ok: true; url: string; dryRun: boolean }
  | { ok: false; error: string };

export interface DraftPrInput {
  repoRoot: string;
  run: RunRecord;
  /** The task's handoff.md — becomes the PR body (goal + progress skim). */
  handoffText: string;
}

export interface ForgeDriver {
  readonly kind: ForgeKind;
  /** Cheap, cached availability probe. May shell out (used by the GitHub tab). */
  detect(): Promise<ForgeAvailability>;
  /** Non-blocking availability for the health path: cached result, or null while warming — never
   *  shells out on the read (keeps /api/health under the bookmarklet's latency budget). */
  detectCached(): ForgeAvailability | null;
  listIssues(opts?: ForgeListOptions): Promise<ForgeListResult>;
  listPRs(opts?: ForgeListOptions): Promise<ForgeListResult>;
  /** Draft-PR creation for the review gate (spec 009). Never throws. */
  createPR(input: DraftPrInput): Promise<DraftPrOutcome>;
  /** The branch's open/merged PR, `status: null` when none — see `ForgePrStatusResult`'s own doc
   *  comment for the availability split. */
  prStatus(branch: string): Promise<ForgePrStatusResult>;
  prMergeState?(number: number, opts?: { refresh?: boolean }): Promise<ForgePrMergeStateResult>;
  mergePR?(number: number, input: ForgeMergeInput): Promise<ForgeMergeResult>;
  /** Bounded, read-only file changes for a pull request. */
  prDiff?(number: number, opts?: { refresh?: boolean }): Promise<ForgePrDiffResult>;
  /** The full comment/review thread for one issue or pull request (#499). `events` (the timeline
   *  axis, #525) is out of scope for this method — a forge implementing it without a timeline read
   *  simply never sets `ForgeCommentsData.events`, which the contract already treats as a
   *  comments-only degradation, not a defect. */
  listComments?(kind: 'issue' | 'pr', number: number, opts?: { refresh?: boolean }): Promise<ForgeCommentsData>;
  /** Batched CI-status glyphs for the given PR numbers (lazy hydration for on-screen rows, #664). */
  listChecks?(numbers: number[]): Promise<ForgeChecksResult>;
  /** Web URL for a ref on the forge, or null when the remote isn't parseable. */
  viewUrl(kind: ForgeRefKind, ref: string | number): string | null;
}
