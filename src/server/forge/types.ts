import type { RunRecord } from '../../runs/store.js';

/**
 * Forge-driver seam (cockpit-ui redesign spec §"Forge-driver seam"): every
 * code-forge integration (GitHub today, GitLab later) implements `ForgeDriver`.
 * The interface is shaped strictly around what the cockpit already does via
 * `gh` — issue/PR listing for the GitHub tab, draft-PR creation for the review
 * gate, a per-branch PR probe, and web-URL building. Adding a forge = one new
 * driver file behind `resolveForge`, no route or UI changes.
 */

export type ForgeKind = 'github';

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

export interface ForgeListOptions {
  /** Bypass the driver's short cache. */
  refresh?: boolean;
  /** Max items to fetch (driver-capped). */
  limit?: number;
}

/** Where an existing branch's PR stands — feeds the Create PR → View PR flip. */
export interface ForgePrStatus {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  checks: 'passing' | 'failing' | 'pending' | null;
}

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
  listIssues(opts?: ForgeListOptions): Promise<ForgeItem[]>;
  listPRs(opts?: ForgeListOptions): Promise<ForgeItem[]>;
  /** Draft-PR creation for the review gate (spec 009). Never throws. */
  createPR(input: DraftPrInput): Promise<DraftPrOutcome>;
  /** The branch's open/merged PR, or null when none (or the forge is down). */
  prStatus(branch: string): Promise<ForgePrStatus | null>;
  /** Web URL for a ref on the forge, or null when the remote isn't parseable. */
  viewUrl(kind: ForgeRefKind, ref: string | number): string | null;
}
