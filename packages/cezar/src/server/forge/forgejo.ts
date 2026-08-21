import { execFile } from 'node:child_process';
import { z } from 'zod';
import { autosaveCommit } from '../../git-worktree.ts';
import { splitUnifiedDiff, type ForgejoDiffEntry } from './forgejo-diff.ts';
import {
  createForgejoHttp,
  firstLine,
  FJ_FILES_MAX_PAGES,
  FJ_LIST_MAX_PAGES,
  FJ_PAGE_LIMIT,
  ForgejoHttpError,
  messageFromBody,
  type ForgejoHttp,
  type ForgejoHttpDeps,
  type ForgejoPage,
} from './forgejo-http.ts';
import {
  combinedStatusToChecks,
  forgejoBranchSchema,
  forgejoChangedFileSchema,
  forgejoPullSchema,
  forgejoRepositorySchema,
  forgejoReviewSchema,
  mapChangedFileStatus,
  mapForgejoComment,
  mapForgejoIssue,
  mapForgejoPull,
  mapForgejoReview,
  mergeMethodsFromRepository,
  normalizeForgejoMergeState,
  rebaseToWebUrl,
  type ForgejoBranchInfo,
  type ForgejoChangedFile,
  type ForgejoLabelListener,
  type ForgejoPull,
  type ForgejoRepository,
} from './forgejo-map.ts';
// `buildPrBody` and `mergePreflightAllowed` are the two things this driver reuses FROM `github.ts`
// (explicitly sanctioned — see the module doc below): the PR body format has no forge-specific
// content, and the merge-eligibility formula (`canMerge || (overrideRules && canOverride)`) is
// pure and forge-agnostic — both `ForgePrMergeState` fields it reads are already computed by
// `normalizeForgejoMergeState` above. Neither import touches `github.ts`'s own driver logic.
import { buildPrBody, mergePreflightAllowed } from './github.ts';
import type {
  DraftPrInput,
  DraftPrOutcome,
  ForgeAvailability,
  ForgeChecksResult,
  ForgeComment,
  ForgeCommentsData,
  ForgeDriver,
  ForgeItem,
  ForgeListOptions,
  ForgeListResult,
  ForgeMergeInput,
  ForgeMergeResult,
  ForgePrChange,
  ForgePrDiffResult,
  ForgePrMergeStateResult,
  ForgePrStatus,
  ForgePrStatusResult,
  ForgeRefKind,
  ForgeSettings,
} from './types.ts';

/**
 * The Forgejo forge driver (cockpit-ui redesign spec §"Forge-driver seam") — structurally mirrors
 * `github.ts`, but speaks REST directly through `forgejo-http.ts` instead of shelling out to a
 * CLI. Every method of `ForgeDriver` is real: `kind`, `detect`/`detectCached` (`server.ts:1511`
 * health and `:3214` automations-availability), `viewUrl`, `listIssues`, `listPRs`, `prStatus`,
 * `createPR`, `prMergeState`, `mergePR`, `prDiff`, `listComments` and `listChecks` — the whole
 * `/api/v1/github*` route family now reaches this driver through `resolveForgeOrGithub`
 * (`forge/index.ts`), the same seam `github.ts`'s own `createGithubDriver` answers through for a
 * GitHub-hosted or unplaceable repo.
 * This driver deliberately reuses a few things straight from `github.ts` rather than re-deriving
 * them: `buildPrBody` (the PR body format has no forge-specific content), `mergePreflightAllowed`
 * (the eligibility formula is pure and forge-agnostic), and, transitively through
 * `git-worktree.ts`, `autosaveCommit` (the pre-publish flush is identical git plumbing regardless
 * of which forge the branch is headed to). None of these imports touch `github.ts`'s own driver
 * logic (`fetchPrMergeState`/`mergePullRequest`/`createDraftPr` themselves are never imported).
 */

export interface ForgejoDriverCtx {
  repoRoot: string;
  owner: string;
  repo: string;
  settings: ForgeSettings;
}

const CACHE_MS = 60_000;
const DETECT_CACHE_MAX = 50;

/** `prDiff` limits — sizes copied verbatim from `github.ts`'s own `GH_PR_PATCH_CAP`/
 *  `GH_PR_DIFF_JSON_CAP`/`GH_PR_DIFF_FILE_CAP` so both drivers' payloads stay comparable in shape
 *  and cost, not because either forge measured differently. Exported so `forgejo.test.ts` builds
 *  its over-cap fixtures against the real numbers instead of a magic literal that could drift. */
export const FJ_PR_PATCH_CAP = 512 * 1024;
export const FJ_PR_DIFF_JSON_CAP = 4 * 1024 * 1024;
export const FJ_PR_DIFF_FILE_CAP = 300;

/** `FJ_LIST_MAX_PAGES * FJ_PAGE_LIMIT` — the walk budget the `prStatus` full-history search uses
 *  as its `want`, parity with `github.ts`'s `GH_MAX_LIMIT` (1000). Also the ceiling `listIssues`/
 *  `listPRs` clamp a caller-supplied `limit` to. */
const FJ_MAX_LIST_LIMIT = FJ_LIST_MAX_PAGES * FJ_PAGE_LIMIT;

interface DetectCacheEntry {
  at: number;
  result: ForgeAvailability;
  /** `Repository` body from the probe, validated through `forgejoRepositorySchema` (every field
   *  optional/defaulted, so a successful HTTP probe is never turned into `available:false` by a
   *  schema mismatch). Read by `resolveDefaultBranch` below to avoid a second request when
   *  `prStatus`'s `/pulls/{base}/{head}` fallback needs the repo's default branch. */
  repository: ForgejoRepository | null;
}

/** Module-level, shared across every driver instance — same shape as `github.ts`'s caches: key
 *  carries `apiBase` (not just `repoRoot`), because two registered projects can point the same
 *  `repoRoot` concept at different Forgejo instances only in theory, but a stale cache surviving a
 *  config edit (apiUrl changed) is a real, observed failure mode worth keying against. */
const detectCache = new Map<string, DetectCacheEntry>();

interface ListCacheEntry {
  at: number;
  limit: number;
  items: ForgeItem[];
  labelColors: Record<string, string>;
  /** Captured at fetch time, NOT recomputed on a cache hit — mirrors `github.ts`'s own
   *  `listCache`, where `syncedAt` lives inside the cached `GithubData` rather than being derived
   *  from `at` on read. A `syncedAt` that moved on every cache hit would misreport a stale answer
   *  as freshly synced. */
  syncedAt: string;
}

/** Keyed `repoRoot\0apiBase\0issues|prs` — same TTL/bound as `detectCache`, one entry per
 *  (project, list kind) pair. A cached fetch with a bigger `limit` than the current ask serves
 *  fine (it is a superset); `listForgejo` below re-slices to the caller's own `limit`. */
const listCache = new Map<string, ListCacheEntry>();
const LIST_CACHE_MAX = 50;

interface PrStatusCacheEntry {
  at: number;
  data: ForgePrStatusResult;
  /** This entry's own TTL — `CACHE_MS` (60s) for a resolved answer (`available:true`, a found PR or
   *  a PROVEN "no PR"), `PR_STATUS_UNRESOLVED_CACHE_MS` (much shorter) for the one `available:false`
   *  flavor worth caching at all (a persistent read — see `ForgejoPrStatusResolution`'s own doc
   *  comment). Per-entry rather than a single module constant so the two flavors can share one
   *  cache/read path without a second lookup table. */
  ttlMs: number;
}

/** Keyed `repoRoot\0apiBase\0branch` — one entry per branch probed, so one worktree's PR status
 *  can never answer for a different branch in the same project. */
const prStatusCache = new Map<string, PrStatusCacheEntry>();
const PR_STATUS_CACHE_MAX = 50;
/** TTL for a `persistent` unresolved `ForgejoPrStatusResolution` read — short enough that a repo whose walk
 *  hits its own page/row ceiling self-heals quickly if the underlying data ever changes (a PR
 *  closes, history shrinks), long enough to absorb rapid repeat calls for the same branch (multiple
 *  UI panels, a user refreshing) without repeating the full, expensive walk every time. Deliberately
 *  much shorter than `CACHE_MS` (60s) — that TTL is reserved for answers this driver has actually
 *  proven, never for "I don't know". */
const PR_STATUS_UNRESOLVED_CACHE_MS = 5_000;

interface MergeStateCacheEntry {
  at: number;
  value: ForgePrMergeStateResult;
}

/** Keyed `repoRoot\0apiBase\0number` — a SHORTER TTL (15s, not the 60s every other cache in this
 *  module uses) because a merge-state read feeds a merge DECISION: a human staring at "ready to
 *  merge" for a stale minute is a worse failure mode than one every-15s extra round-trip. Mirrors
 *  `github.ts`'s own `mergeStateCache`/`MERGE_CACHE_MS`. */
const mergeStateCache = new Map<string, MergeStateCacheEntry>();
const MERGE_STATE_CACHE_MS = 15_000;
const MERGE_STATE_CACHE_MAX = 500;

/** Mutex for `mergePR` — keyed IDENTICALLY to `mergeStateCache` (same `mergeStateCacheKey`
 *  function), so "a merge for this exact PR is already running" and "the cached merge-state for
 *  this exact PR" share one notion of identity. Holds no data, just membership: a key present means
 *  a merge is in flight. Mirrors `github.ts`'s own `mergeInflight` (github.ts:1579). */
const mergeInflight = new Set<string>();

interface PrDiffCacheEntry {
  at: number;
  data: ForgePrDiffResult;
}

/** Keyed `repoRoot\0apiBase\0number\0headSha` — the `headSha` component (unlike every other cache
 *  in this module) means a cache entry auto-invalidates the instant the PR's head commit moves,
 *  with no eviction needed for that case specifically; `evictForgejoProjectCaches` still clears it
 *  after a merge (below) because a merge can rewrite `head.sha` to the merge commit itself, which
 *  would otherwise mint a "new" key that silently coexists with the stale pre-merge one forever.
 *  Same 60s TTL as `listCache`/`prStatusCache` — a diff view refreshing a minute late is a much
 *  smaller cost than a merge-state view doing the same (contrast `MERGE_STATE_CACHE_MS`). */
const prDiffCache = new Map<string, PrDiffCacheEntry>();
const PR_DIFF_CACHE_MAX = 50;

interface CommentsCacheEntry {
  at: number;
  data: ForgeCommentsData;
}

/** Keyed `repoRoot\0apiBase\0kind#number` — same shape as `github.ts`'s own `commentsCache` key.
 *  Same 60s TTL as `listCache`/`prStatusCache`/`prDiffCache`; a thread view refreshing a minute
 *  late is a low-stakes staleness, same reasoning `prDiffCache`'s own doc comment gives. */
const forgejoCommentsCache = new Map<string, CommentsCacheEntry>();
const FORGEJO_COMMENTS_CACHE_MAX = 50;

/** `listComments`'s own entry cap — parity with `github.ts`'s `THREAD_ENTRY_CAP` (200), the same
 *  number for the same reason (a thread view is not a full-history export). */
const FJ_THREAD_ENTRY_CAP = 200;

interface ChecksCacheEntry {
  at: number;
  glyph: 'passing' | 'failing' | 'pending' | null;
}

/** Keyed `repoRoot\0apiBase\0number` — one glyph per PR, mirrors `github.ts`'s own `checksCache`
 *  key shape. Unlike that one, this IS a member of `PROJECT_CACHES` below: a merge rewrites the
 *  PR's `head.sha` to the merge commit, so a cached glyph for the PR NUMBER would otherwise answer
 *  from the pre-merge commit's status for up to `CACHE_MS` after the merge — the same staleness
 *  `prDiffCache`'s own doc comment gives for why IT is a member. */
const forgejoChecksCache = new Map<string, ChecksCacheEntry>();
const FORGEJO_CHECKS_CACHE_MAX = 500;

/** Bounds how many `commits/{sha}/status` reads `forgejoListChecks` fires at once — a request
 *  list of up to `GH_CHECKS_MAX` (100, `github.ts`) misses would otherwise open 100 simultaneous
 *  connections to the same instance. A conservative, unmeasured number: no live Forgejo Actions
 *  run exists on any instance this driver has been tried against, so there is no real traffic
 *  pattern to size it from — see `forgejoListChecks`'s own doc comment. */
const FJ_CHECKS_CONCURRENCY = 8;

/** Every cache in this module keyed `repoRoot\0apiBase\0...` — the ONE list both
 *  `evictForgejoProjectCaches` (prefix-deletes per project after a merge) and
 *  `__clearForgejoCachesForTests` (full-clears everything between tests) iterate, so a future
 *  cache addition can't be silently missed from one of the two call sites the way `prDiffCache`
 *  itself once was. `detectCache` is deliberately NOT a member — see `evictForgejoProjectCaches`'s
 *  own doc comment for why a merge must never evict it (`__clearForgejoCachesForTests` still clears
 *  it separately, alongside the `mergeInflight` `Set`, which isn't keyed the same way either).
 *  `Map<string, unknown>[]` (not a bespoke interface): each cache below has a different entry value
 *  type, but `evictOldest` below already types its own parameter as `Map<string, unknown>` and every
 *  one of this module's caches (these six, plus `detectCache`) is assignable to it as-is —
 *  TypeScript's structural typing has no variance fight to sidestep here. */
const PROJECT_CACHES: Map<string, unknown>[] = [
  listCache,
  prStatusCache,
  mergeStateCache,
  prDiffCache,
  forgejoCommentsCache,
  forgejoChecksCache,
];

function cacheKey(repoRoot: string, apiBase: string): string {
  return `${repoRoot}\0${apiBase}`;
}

function listCacheKey(repoRoot: string, apiBase: string, listKind: 'issues' | 'prs'): string {
  return `${repoRoot}\0${apiBase}\0${listKind}`;
}

function prStatusCacheKey(repoRoot: string, apiBase: string, branch: string): string {
  return `${repoRoot}\0${apiBase}\0${branch}`;
}

function mergeStateCacheKey(repoRoot: string, apiBase: string, number: number): string {
  return `${repoRoot}\0${apiBase}\0${number}`;
}

function prDiffCacheKey(repoRoot: string, apiBase: string, number: number, headSha: string): string {
  return `${repoRoot}\0${apiBase}\0${number}\0${headSha}`;
}

function commentsCacheKey(repoRoot: string, apiBase: string, kind: 'issue' | 'pr', number: number): string {
  return `${repoRoot}\0${apiBase}\0${kind}#${number}`;
}

function checksCacheKey(repoRoot: string, apiBase: string, number: number): string {
  return `${repoRoot}\0${apiBase}\0${number}`;
}

function evictOldest(cache: Map<string, unknown>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Clears every cache (and the merge mutex) this module owns — tests call this in `beforeEach` so
 *  one test's warm cache, or a mutex left held by a test that never reached its `finally`, can
 *  never leak into the next. */
export function __clearForgejoCachesForTests(): void {
  detectCache.clear();
  mergeInflight.clear();
  for (const cache of PROJECT_CACHES) cache.clear();
}

function describeError(err: unknown): string {
  if (err instanceof ForgejoHttpError) return err.message;
  // zod v4's `ZodError#message` is a pretty-printed JSON array (one issue object per line) — piping
  // it through `firstLine` below hands back a bare `"["`, which is worse than useless as a
  // human-facing reason (measured: `new Error()`'s subclass check here is load-bearing, `ZodError`
  // IS an `Error`, so without this branch it would silently fall through to the generic path below).
  // Every call site this function feeds (`detectForgejo`, `forgejoPrMergeState`, `forgejoMergePR`,
  // `forgejoPrDiff`) can only reach a `ZodError` from a response body this driver's own schemas
  // rejected — "the shape Forgejo sent back doesn't match what we expected" is the one honest,
  // readable summary for all of them, regardless of which field actually failed.
  if (err instanceof z.ZodError) return 'unexpected response from Forgejo';
  const message = err instanceof Error ? err.message : String(err);
  return firstLine(message);
}

async function detectForgejo(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
): Promise<ForgeAvailability> {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  const key = cacheKey(repoRoot, http.apiBase);
  const hit = detectCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  let result: ForgeAvailability;
  let repository: ForgejoRepository | null = null;
  try {
    // Dynamic segments through encodeURIComponent — `forge/index.ts` only checks owner/repo for
    // non-emptiness upstream, nothing rejects e.g. `..`, so encoding here is the ONLY thing standing
    // between a crafted remote and a traversed path, not a defense-in-depth belt-and-braces layer on
    // top of an upstream gate. Same reasoning `forgejoViewUrl` below and `repoPath` apply.
    const body = await http.getJson(repoPath(owner, repo), { timeoutMs: 5_000 });
    repository = forgejoRepositorySchema.parse(body);
    result = { available: true };
  } catch (err) {
    result = { available: false, reason: describeError(err) };
  }
  detectCache.set(key, { at: Date.now(), result, repository });
  evictOldest(detectCache, DETECT_CACHE_MAX);
  return result;
}

/** `Repository`, read from the warm `detectCache` entry when one exists (avoids a second request)
 *  and falling back to one fresh `GET repos/{owner}/{repo}` when the cache is cold. Shared by
 *  `resolveDefaultBranch` (`createPR`'s base-branch fallback, `prStatus`'s `/pulls/{base}/{head}`
 *  fallback) and `prMergeState` (needs the whole body for `methods`/`defaultMethod`, not just
 *  `default_branch`) — one fetch-or-cache path instead of two copies that could drift. */
async function resolveRepository(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
): Promise<ForgejoRepository | null> {
  const hit = detectCache.get(cacheKey(repoRoot, http.apiBase));
  if (hit?.repository) return hit.repository;
  try {
    const raw = await http.getJson(repoPath(owner, repo));
    return forgejoRepositorySchema.parse(raw);
  } catch {
    return null;
  }
}

/** Used only by `prStatus`'s `/pulls/{base}/{head}` fallback and `createPR`'s base-branch fallback,
 *  which both need `base` before they can even build the request path. */
async function resolveDefaultBranch(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
): Promise<string | null> {
  const repository = await resolveRepository(repoRoot, http, owner, repo);
  return repository?.default_branch ?? null;
}

/**
 * Non-blocking availability for `GET /api/v1/health` — never shells out on the read, serves the
 * last-known probe (stale-while-revalidate) and only answers `null` before the first probe has
 * ever warmed the cache. Mirrors `detectGithubCached` (github.ts:1566-1576) exactly, including the
 * reason: a `null` here would blink the sidebar's forge indicator out on every cache expiry if it
 * blocked instead of serving stale.
 */
function detectForgejoCached(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
): ForgeAvailability | null {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  const key = cacheKey(repoRoot, http.apiBase);
  const hit = detectCache.get(key);
  const fresh = hit !== undefined && Date.now() - hit.at < CACHE_MS;
  if (!fresh) {
    void detectForgejo(repoRoot, http, owner, repo).catch(() => {}); // revalidate off the request path
  }
  return hit ? hit.result : null;
}

/** Dynamic path segments that may legitimately contain '/' (a git branch name like
 *  `feat/cockpit-ui`) are encoded per-segment, never as one blob — `encodeURIComponent` on the
 *  whole string would turn the separating '/' into a literal `%2F`, breaking the multi-segment
 *  route Forgejo expects for e.g. `pulls/{base}/{head}` (mirrors github.ts:1867's identical
 *  pattern). Used by both `forgejoViewUrl` below (branch/issue/commit refs) and every
 *  branch/sha-bearing request path in `resolveForgejoPrStatus`/`pullRowToStatus`. Still runs every
 *  segment through `encodeURIComponent` — a legal-in-git `#` in a branch name would otherwise be
 *  read as a URL fragment and silently truncate the request path (`:`, `?`, `..` are already
 *  forbidden by git's own refname rules, so path traversal is not a concern here). */
function encodeRefSegments(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/** `repos/{owner}/{repo}` — the API-path prefix every endpoint in this module hangs off of.
 *  Computed once per call site instead of the `encodeURIComponent(owner)`/`encodeURIComponent(repo)`
 *  pair being repeated ad hoc across the file (same reasoning `detectForgejo`'s own comment gives:
 *  `forge/index.ts` only checks `owner`/`repo` for non-emptiness, so `encodeURIComponent` here is the
 *  ONLY thing preventing a traversed path, not a redundant extra layer). NOT the same thing as
 *  `forgejoViewUrl`'s own `base` above — that one is a full web URL for a human, this one is a
 *  relative API path for `http`. */
function repoPath(owner: string, repo: string): string {
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** `GET repos/{o}/{r}/pulls/{n}`, parsed — the one request repeated across `forgejoPrMergeState`
 *  (the initial read and its own mergeable:false retry), `forgejoMergePR` (the post-merge
 *  commit-sha read-back) and `forgejoPrDiff` (for `headSha`). Returns both the parsed `pull` AND
 *  the raw JSON — `normalizeForgejoMergeState` takes the raw body itself (it re-parses internally),
 *  so callers that feed it (`forgejoPrMergeState`) need `raw`; callers that only read typed fields
 *  (`forgejoMergePR`, `forgejoPrDiff`) just use `pull` and ignore `raw`. */
async function fetchPull(http: ForgejoHttp, owner: string, repo: string, number: number): Promise<{ raw: unknown; pull: ForgejoPull }> {
  const raw = await http.getJson(`${repoPath(owner, repo)}/pulls/${number}`);
  return { raw, pull: forgejoPullSchema.parse(raw) };
}

function forgejoViewUrl(webUrl: string, owner: string, repo: string, kind: ForgeRefKind, ref: string | number): string {
  const base = `${webUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  // Branch names may contain '/' — encode per segment, keep the slashes (mirrors github.ts:1867).
  const path = encodeRefSegments(String(ref));
  switch (kind) {
    case 'repo':
      return base;
    case 'issue':
      return `${base}/issues/${path}`;
    case 'pr':
      // Forgejo's own web UI uses `/pulls/{n}` (plural) — confirmed from a live `html_url`, unlike
      // GitHub's singular `/pull/{n}`.
      return `${base}/pulls/${path}`;
    case 'branch':
      return `${base}/src/branch/${path}`;
    case 'commit':
      return `${base}/commit/${path}`;
  }
}

// ---- CEZ_DRY_RUN=1 fixtures (#26) -------------------------------------------
// The read side's offline catalog — the Forgejo twin of `github.ts`'s `mockGithub()`, and the one
// source every dry-run READ path in this file answers from (`listForgejo`, `forgejoPrStatus`,
// `forgejoListChecks`).
//
// Why it has to exist at all: the probe already reports the forge AVAILABLE under dry-run, so a
// Forgejo project's GitHub tab rendered as healthy-and-empty — no row to click, therefore no item
// detail page, therefore no "Hand this to the agent" panel, therefore no browser-level coverage of
// any Forgejo behaviour. `{available:true, items:[]}` is also precisely the silent-failure shape
// `listForgejo`'s own all-rows-failed gate exists to refuse; the dry-run branch was producing it by
// hand. Every other dry-run path here (merge state, create PR) already carried a real fixture.
//
// The values are chosen to be DISJOINT from `mockGithub()`'s — numbers, titles, authors, labels and
// label colours all differ — so an assertion about Forgejo cannot be satisfied by GitHub fixtures
// that happen to be in front of it. `dry-run-fixtures.test.ts` pins that as an invariant rather
// than a convention, since both catalogs are hand-maintained.

/** One catalog row. `branch` is Forgejo-only bookkeeping (`ForgeItem` has no head-branch field) and
 *  is what lets `forgejoPrStatus` answer for the branch a fixture PR actually heads. */
interface DryRunForgejoRow {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author: string;
  labels: string[];
  body: string;
  /** Always `0`, and pinned as such by `dry-run-fixtures.test.ts`: `forgejoListComments`'s dry-run
   *  branch serves no thread (seeding one is a non-goal of #26), so any other count would send a QA
   *  click from "5 comments" to an empty pane — the same "looks healthy, holds nothing" shape this
   *  catalog exists to remove. Kept as a field rather than dropped so seeding threads later is a
   *  fixture edit, not a shape change. */
  comments: number;
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  checks?: 'passing' | 'failing' | 'pending' | null;
  branch?: string;
}

const DRY_RUN_FORGEJO_ROWS: readonly DryRunForgejoRow[] = [
  {
    kind: 'issue',
    number: 24,
    title: 'Webhook retries hammer the mirror after a 502',
    author: 'aurelia',
    labels: ['ci', 'mirror'],
    comments: 0,
    body: 'The delivery queue retries with no backoff, so one 502 from the mirror turns into a few hundred requests a minute until the endpoint is disabled by hand.',
  },
  {
    kind: 'issue',
    number: 18,
    title: 'Package registry rejects a scoped tag on push',
    author: 'kestrel',
    labels: ['registry'],
    comments: 0,
    body: 'Pushing `@acme/tool@1.4.0` answers 422 with an empty body. An unscoped name on the same repository is accepted, so the scope separator looks like the part that is not being decoded.',
  },
  {
    kind: 'issue',
    number: 11,
    title: 'Wiki search misses pages behind a redirect',
    author: 'bo',
    labels: ['wiki', 'needs-triage'],
    comments: 0,
    body: 'A renamed wiki page keeps serving under its old slug, but the search index only ever holds the new one — so the redirect works and the search result never appears.',
  },
  {
    kind: 'pr',
    // 777 deliberately: `createForgejoPr`'s dry-run branch hands back `…/pulls/777` and
    // `DRY_RUN_MERGE_STATE_FIXTURE` describes that same number. Those two were unreachable while
    // the list was empty; a clickable list makes them reachable, so the catalog agrees with them
    // instead of inventing a PR they know nothing about.
    number: 777,
    title: 'Dry-run pull request',
    author: 'aurelia',
    labels: ['ready-to-merge'],
    comments: 0,
    isDraft: false,
    additions: 1,
    deletions: 1,
    checks: 'passing',
    branch: 'feat/dry-run',
    body: 'The pull request every dry-run PR path in this driver already answers for — `createPR` hands back this number and the merge-state fixture describes it.',
  },
  {
    kind: 'pr',
    number: 764,
    title: 'Mirror the release tarball to the package registry',
    author: 'kestrel',
    labels: ['registry', 'packaging'],
    comments: 0,
    isDraft: true,
    additions: 96,
    deletions: 12,
    checks: 'pending',
    branch: 'feat/mirror-tarball',
    body: 'Draft: publishes the signed tarball as a generic package on release. The signature check still runs after the upload rather than before it, so this is not ready for review yet.',
  },
];

/** Colours for every label the catalog uses. Disjoint from `mockGithub()`'s palette, same as the
 *  label names themselves. */
const DRY_RUN_FORGEJO_LABEL_COLORS: Record<string, string> = {
  ci: '2f6f4e',
  mirror: 'b45f06',
  registry: '7b1fa2',
  wiki: '00838f',
  packaging: 'ad1457',
  'needs-triage': 'ef6c00',
  'ready-to-merge': '1b5e20',
};

/** A catalog row as the cockpit consumes it. The URL is composed through `forgejoViewUrl`, never
 *  written out literally, so it lands on the CONFIGURED `webUrl` host by construction — the one
 *  property #26 turns on ("never `github.com`") cannot drift out of a hand-written string. */
function dryRunForgejoItem(row: DryRunForgejoRow, owner: string, repo: string, webUrl: string): ForgeItem {
  return {
    kind: row.kind,
    number: row.number,
    title: row.title,
    author: row.author,
    // Ages relative to now, exactly as `mockGithub` does it — a fixed timestamp would render as
    // "2 years ago" in a demo a year from now.
    createdAt: new Date(Date.now() - row.number * 3_600_000).toISOString(),
    labels: row.labels,
    body: row.body,
    url: forgejoViewUrl(webUrl, owner, repo, row.kind === 'pr' ? 'pr' : 'issue', row.number),
    comments: row.comments,
    ...(row.kind === 'pr'
      ? { isDraft: row.isDraft ?? false, additions: row.additions, deletions: row.deletions, checks: row.checks ?? null }
      : {}),
  };
}

/** The dry-run answer for one list walk. `repo`/`syncedAt`/`labelColors` are filled exactly as the
 *  live walk fills them, so `/api/github` composes an identical payload shape either way. */
function dryRunForgejoList(
  listKind: 'issues' | 'prs',
  owner: string,
  repo: string,
  webUrl: string,
  limit: number,
): ForgeListResult {
  const wanted = listKind === 'issues' ? 'issue' : 'pr';
  const items = DRY_RUN_FORGEJO_ROWS.filter((row) => row.kind === wanted)
    .slice(0, limit)
    .map((row) => dryRunForgejoItem(row, owner, repo, webUrl));
  return {
    available: true,
    items,
    repo: `${owner}/${repo}`,
    syncedAt: new Date().toISOString(),
    // Copied, not handed out by reference: the live walk (`listForgejo`) builds a fresh map per
    // call, and a driver read that leaks a shared module-level object is one `Object.assign` away
    // from a cross-request bug that only ever reproduces under dry-run.
    labelColors: { ...DRY_RUN_FORGEJO_LABEL_COLORS },
  };
}

/** The dry-run `prStatus` answer: the fixture PR that heads `branch`, or `null` when none does. */
function dryRunForgejoPrStatus(owner: string, repo: string, webUrl: string, branch: string): ForgePrStatus | null {
  const row = DRY_RUN_FORGEJO_ROWS.find((candidate) => candidate.kind === 'pr' && candidate.branch === branch);
  if (!row) return null;
  return {
    number: row.number,
    url: forgejoViewUrl(webUrl, owner, repo, 'pr', row.number),
    // Every catalog PR is open: a merged or closed one would have no business in a list the live
    // walk builds from `state=open`.
    state: 'open',
    isDraft: row.isDraft ?? false,
    checks: row.checks ?? null,
  };
}

/** The dry-run `listChecks` answer. A number outside the catalog resolves to `null` — no CI, NOT a
 *  failed read — which is the same distinction `mockGithubChecks` draws. */
function dryRunForgejoChecks(numbers: number[]): ForgeChecksResult {
  const byNumber = new Map(
    DRY_RUN_FORGEJO_ROWS.filter((row) => row.kind === 'pr').map((row) => [row.number, row.checks ?? null] as const),
  );
  const checks: Record<number, 'passing' | 'failing' | 'pending' | null> = {};
  for (const n of numbers) checks[n] = byNumber.get(n) ?? null;
  return { available: true, checks };
}

/**
 * `listIssues`/`listPRs` share this walk: paginate the matching endpoint up to the caller's
 * (capped) `limit`, map each row, drop rows the mapper rejects (`mapForgejoIssue` returns `null`
 * for the PR rows `/issues` also serves — never happens for `/pulls`, but sharing one function
 * keeps that filter written exactly once), and re-slice to `limit` since `paginate`'s own `want`
 * is a stop heuristic, not a hard cap (a full first page can overshoot a small `limit`).
 *
 * Returns `ForgeListResult` rather than a bare `ForgeItem[]`: a forge the driver could
 * not reach must report `available:false` + a `reason`, never an empty list standing in for an
 * unreported failure — the ambiguity `fetchGithub`'s equivalent (`github.ts`) never had, because a
 * `gh` failure there always had somewhere to put a reason. `repo`/`syncedAt`/`labelColors` mirror
 * `githubDataSchema`'s own optional meta fields, so the `/api/github` route (`server.ts`'s
 * `githubRoutes.get('/github', ...)`) composes one `GithubData`-shaped response from
 * `listIssues`+`listPRs` without reshaping either.
 *
 * The same "never an empty list standing in for a failure" rule applies one level down, per row:
 * a non-empty page where EVERY row fails to parse also degrades to `available:false`, not the same
 * silent `{available:true, items:[]}` a single dropped row would produce — same per-stream gate
 * `forgejoListComments` below applies to its own comment/review walks. That gate counts rows that
 * survived the parser, not rows that produced an `ForgeItem`: `mapForgejoIssue` legitimately
 * returns `null` for a `/issues` row that parsed fine but turned out to be a PR row, which must
 * never itself trip the gate.
 */
async function listForgejo(
  listKind: 'issues' | 'prs',
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  opts: ForgeListOptions | undefined,
): Promise<ForgeListResult> {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), FJ_MAX_LIST_LIMIT);
  // Ahead of the cache, same as before — but AFTER `limit`, so the fixture walk honours the
  // caller's cap exactly like the live one does.
  if (process.env.CEZ_DRY_RUN === '1') return dryRunForgejoList(listKind, owner, repo, webUrl, limit);
  const key = listCacheKey(repoRoot, http.apiBase, listKind);
  const repoHandle = `${owner}/${repo}`;
  if (!opts?.refresh) {
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS && hit.limit >= limit) {
      return { available: true, items: hit.items.slice(0, limit), repo: repoHandle, syncedAt: hit.syncedAt, labelColors: hit.labelColors };
    }
  }

  const repoPrefix = repoPath(owner, repo);
  // `/issues` on a live instance also returns PR rows (measured: 3/3 rows returned were PRs) —
  // `type=issues` filters most of them server-side; `mapForgejoIssue`'s own `pull_request` check
  // is the second, belt-and-braces layer for whatever slips through.
  const query = listKind === 'issues' ? 'state=open&type=issues' : 'state=open';
  const segment = listKind === 'issues' ? 'issues' : 'pulls';
  const mapRow: (raw: unknown, webUrl: string, onLabel?: ForgejoLabelListener) => ForgeItem | null =
    listKind === 'issues' ? mapForgejoIssue : mapForgejoPull;

  try {
    const page = await http.paginate((p, l) => `${repoPrefix}/${segment}?${query}&page=${p}&limit=${l}`, { want: limit });
    const items: ForgeItem[] = [];
    // One repo-wide label→color map, filled as each row is mapped — parity with `fetchGithub`'s
    // own `recordColor` (`github.ts:420`): first color wins, a label with no color contributes
    // nothing.
    const labelColors: Record<string, string> = {};
    const recordColor: ForgejoLabelListener = (l) => {
      if (l.color && !labelColors[l.name]) labelColors[l.name] = l.color;
    };
    // Rows that survived the parser (`forgejoIssueSchema`/`forgejoPullSchema` AND
    // `rebaseToWebUrl`), counted separately from `items.length`/`mapRow`'s return: `mapForgejoIssue`
    // LEGITIMATELY returns `null` for a row it parsed fine but that turned out to be a PR row
    // (`/issues` also serves those — measured live: 3/3 rows). That is a content filter, not a
    // parse failure, so it must still count as "survived" below — otherwise a `/issues` response
    // that is entirely, legitimately PR rows would trip the all-rows-failed gate and report a false
    // `available:false` for a repo that genuinely has zero open issues.
    let survivedRows = 0;
    for (const row of page.rows) {
      // Per-row, not per-walk: one row that fails `forgejoIssueSchema`/`forgejoPullSchema` (or
      // whose `html_url` is not absolute, which makes `rebaseToWebUrl` throw a `TypeError`) must
      // cost that ONE row, not the whole list — "29 of 30 issues" is a dropped row the user can
      // still work from, whereas `[]` is a false "there is nothing here". Same policy
      // `resolveForgejoPrStatus` and `forgejoPrDiff` already apply to their own walks.
      let item: ForgeItem | null;
      try {
        item = mapRow(row, webUrl, recordColor);
        survivedRows++;
      } catch {
        continue;
      }
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
    if (page.rows.length > 0 && survivedRows === 0) {
      // The "29 of 30" comment above covers ONE bad row; this covers the OTHER end of that same
      // invariant — a non-empty page where every single row failed to even parse means the response
      // shape drifted out from under this driver's schemas, not "this repo has nothing open". Same
      // per-stream gate `forgejoListComments` already applies (`commentsUnmappable`/
      // `reviewsUnmappable`, this file's `forgejoListComments`) — collapsing "all rows drifted" into
      // a quiet `available:true, items:[]` would be exactly the silent-failure shape this driver is
      // built to avoid. Deliberately NOT cached, same reasoning as the catch block below: a
      // drifted read must not pin a false "there is nothing here" for the 60s TTL.
      return {
        available: false,
        reason:
          listKind === 'issues'
            ? 'the issue list response did not match the expected shape'
            : 'the pull request list response did not match the expected shape',
        items: [],
      };
    }
    const syncedAt = new Date().toISOString();
    listCache.set(key, { at: Date.now(), limit, items, labelColors, syncedAt });
    evictOldest(listCache, LIST_CACHE_MAX);
    return { available: true, items: items.slice(0, limit), repo: repoHandle, syncedAt, labelColors };
  } catch (err) {
    // Never throw from a read — an HTTP failure or a timeout degrades to `available:false` + a
    // reason here (previously a silent `[]`, indistinguishable from "no items"). (A malformed
    // individual ROW no longer reaches this catch: it is skipped in the loop above.) Deliberately
    // NOT cached: a transient forge outage must not pin a failure answer for the TTL.
    return { available: false, reason: describeError(err), items: [] };
  }
}

/** Fetches the combined commit status for a matched PR's `head.sha` (never the branch name — a
 *  branch can move past the commit a PR was opened against) and assembles the `ForgePrStatus`. */
async function pullRowToStatus(
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  pull: ForgejoPull,
): Promise<ForgePrStatus> {
  // Reuses `fetchForgejoCombinedStatus` rather than re-issuing the same GET+try/catch inline —
  // both paths hit the identical `commits/{sha}/status` endpoint. `ForgePrStatus.checks` (unlike
  // `forgejoPrMergeState`'s per-check breakdown) has no "the read itself failed" state to report —
  // it is a list-row badge, not a merge-decision gate — so both a failed fetch and a genuine "no CI
  // configured" read collapse to the same `null` here, same as before. `combinedStatusToChecks`
  // itself is a zod `.parse()` that `fetchForgejoCombinedStatus` does NOT cover (that function only
  // try/catches the GET) — a malformed-but-syntactically-valid body must degrade `checks` alone to
  // `null`, not throw past this function and blank the whole `ForgePrStatus` the caller already has
  // (number/url/state/isDraft), so the parse is try/caught right here.
  let checks: ForgePrStatus['checks'] = null;
  if (pull.head?.sha) {
    const status = await fetchForgejoCombinedStatus(http, owner, repo, pull.head.sha);
    try {
      checks = status.ok ? combinedStatusToChecks(status.value) : null;
    } catch {
      checks = null;
    }
  }
  return {
    number: pull.number,
    url: rebaseToWebUrl(pull.html_url, webUrl),
    // `state` alone never means "merged" — a merged PR reports `state:'closed', merged:true`.
    state: pull.merged ? 'merged' : pull.state,
    isDraft: pull.draft,
    checks,
  };
}

/** Distinguishes a resolved answer (a real PR, or a PROVEN "no PR") from an UNRESOLVED read — every
 *  place `resolveForgejoPrStatus` below cannot tell "no PR exists" apart from "the read that would
 *  have proven it failed" returns `{ kind: 'unresolved', ... }` instead of a resolved `null`: a
 *  page-1 throw (nothing collected), a later page failing (`stoppedShort`, rows kept but the walk
 *  unproven — the fallback below could shadow a match on the unread remainder), an unparseable row
 *  (this driver never learned whether it was the match), an unresolvable default branch (the
 *  fallback could not even be attempted), a non-404 failure on the fallback lookup itself, and a
 *  matched row that failed to RENDER (`pullRowToStatus` throwing on an already-proven match).
 *  `forgejoPrStatus` below reads this to skip `prStatusCache.set` for exactly these cases — the SAME
 *  reasoning `listForgejo`'s own `catch` already applies (that function's `catch` never touches
 *  `listCache` either): a transient forge outage must not pin "no PR" onto a branch for the next
 *  `CACHE_MS`.
 *
 *  `persistent: true` marks the ONE unresolved route that is a stable trait of the repo/branch
 *  rather than a one-off hiccup: the primary `pulls?state=all` walk hitting its own fixed ceiling
 *  (`ForgejoPage.stopReason:'limit'` — ran out of pages/rows before it could prove "no match", not
 *  because a request failed or the time budget ran out). A repo whose open+closed PR history is
 *  larger than that walk's own ceiling hits this on EVERY call, forever, so `forgejoPrStatus` caches
 *  THIS flavor under a short negative TTL (`PR_STATUS_UNRESOLVED_CACHE_MS`) instead of repeating the
 *  full, expensive walk on every single call — a real, measured cost against an already-loaded
 *  instance. Every OTHER unresolved route above is `persistent: false` and must never be cached,
 *  even briefly: none of them are a stable trait of the repo, and caching them would risk exactly
 *  the false "no PR" this whole mechanism exists to prevent. Caching the ANSWER "I don't know"
 *  briefly is safe; caching "there is no PR" ever, from an unproven read, is the defect this whole
 *  mechanism exists to prevent — the short TTL narrows the window this trades away completeness
 *  for, it does not remove the invariant. */
type ForgejoPrStatusResolution =
  | { kind: 'resolved'; status: ForgePrStatus | null }
  | { kind: 'unresolved'; persistent: boolean; reason: string };

/**
 * Walks `repos/{o}/{r}/pulls?state=all` (NOT the `GET pulls/{base}/{head}` shortcut as the primary
 * path — that endpoint returns closed/merged PRs too and picks an arbitrary one when several share
 * a head, which on a live instance returned a merged PR for a branch with an open one). An open
 * match wins over any earlier closed/merged match with the same `head.ref`, since an open PR is
 * always the strongest possible answer.
 *
 * The `/pulls/{base}/{head}` fallback only runs once the walk is PROVEN exhaustive
 * (`page.stoppedShort === false`): a merged PR whose branch was deleted reports
 * `head.ref: "refs/pull/N/head"`, so it can never match by branch name in the walk, and the
 * fallback exists to still find it. But firing the fallback after an UNFINISHED walk would let it
 * shadow a genuinely open PR sitting on a page the walk never reached — resurrecting the exact bug
 * the state=all walk exists to avoid. Three residual gaps, all accepted as known limitations:
 * (a) a PR merged into a NON-default base with a deleted branch still returns `null` (the fallback
 * only tries the repo's `default_branch` as `base`); (b) with two terminal (closed/merged) PRs
 * sharing the same head, the fallback endpoint picks an arbitrary one, so `merged` vs `closed`
 * might describe the wrong one of the two; (c) the walk's own `found` check below runs BEFORE the
 * `stoppedShort` gate, so a terminal (closed/merged) match seen on an unfinished walk is still
 * returned and cached as proven — a genuinely open PR for the same branch sitting on a page the
 * walk never reached never gets the chance to overtake it.
 */
async function resolveForgejoPrStatus(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  branch: string,
): Promise<ForgejoPrStatusResolution> {
  const repoPrefix = repoPath(owner, repo);

  let page: ForgejoPage;
  try {
    page = await http.paginate((p, l) => `${repoPrefix}/pulls?state=all&page=${p}&limit=${l}`, {
      want: FJ_MAX_LIST_LIMIT,
    });
  } catch (err) {
    // Page 1 is the only page `paginate` can fail on without having collected anything (a later
    // page's failure keeps what was gathered and marks `stoppedShort`, see forgejo-http.ts) — either
    // way there is nothing here proving completeness, so the fallback below must not run. Unlike
    // every OTHER unresolved route, this one carries the raw transport error as its reason.
    return { kind: 'unresolved', persistent: false, reason: describeError(err) };
  }

  let openMatch: ForgejoPull | null = null;
  let anyMatch: ForgejoPull | null = null;
  // A row that fails `forgejoPullSchema.parse` can never be checked against `branch` — this driver
  // has no way to know whether the row it just skipped WAS the match. Tracked separately from
  // `page.stoppedShort` (a property of the HTTP walk itself) because this is a DIFFERENT reason the
  // walk cannot be trusted: the walk can complete perfectly (short page, matching X-Total-Count) and
  // still contain a row this schema cannot read.
  let unparseableRowSeen = false;
  for (const row of page.rows) {
    let parsed: ForgejoPull;
    try {
      parsed = forgejoPullSchema.parse(row);
    } catch {
      unparseableRowSeen = true; // a malformed row must not abort the whole walk, but it also can't be ruled out as the match
      continue;
    }
    if (parsed.head?.ref !== branch) continue;
    anyMatch ??= parsed;
    if (parsed.state === 'open') {
      openMatch = parsed;
      break; // an open PR beats anything later in the walk — nothing left to search for
    }
  }
  const found = openMatch ?? anyMatch;
  if (found) {
    // `pullRowToStatus` itself already degrades its OWN I/O (the combined-status fetch) to
    // `checks: null` on failure, but `rebaseToWebUrl` inside it can still throw a `TypeError` on a
    // non-absolute `html_url` — a read must never throw past this function. The `/pulls/{base}/{head}`
    // fallback just below needs the SAME protection for the SAME reason; both `try`s must `await`
    // the `pullRowToStatus` call, not just wrap it, or the rejection skips the `catch` entirely.
    // UNRESOLVED, never a resolved `null`: `found` means the PR's EXISTENCE is already proven by this
    // walk — the throw only means it could not be fully rendered, so caching this as "no PR" would
    // pin a wrong answer onto a branch that plainly has one.
    try {
      return { kind: 'resolved', status: await pullRowToStatus(http, owner, repo, webUrl, found) };
    } catch {
      return { kind: 'unresolved', persistent: false, reason: 'the matched pull request could not be fully read' };
    }
  }
  // walk unproven (a later page errored/hit budget/hit the page cap) — the fallback below could
  // shadow an open PR sitting on the page never reached, so this must be UNRESOLVED, not a proven
  // "no PR": same reasoning as the page-1 throw above, just reached through the OTHER signal
  // `paginate` uses for "didn't finish" (see forgejo-http.ts).
  if (page.stoppedShort) {
    // A deterministic ceiling hit (`stopReason:'limit'` — the walk always needs more pages/rows
    // than its own fixed budget allows) is a PERSISTENT trait of this repo/branch, unlike a one-off
    // 'budget'/'error' stop — see `ForgejoPrStatusResolution`'s own doc comment for why only that
    // one flavor is worth a short negative cache.
    return page.stopReason === 'limit'
      ? { kind: 'unresolved', persistent: true, reason: 'the pull request history is larger than the search budget' }
      : { kind: 'unresolved', persistent: false, reason: 'the pull request search did not finish' };
  }
  // A row this schema could not parse can never be checked against `branch` — the walk otherwise
  // LOOKS complete (short page, matching X-Total-Count), but this driver cannot rule out that the
  // skipped row was the match, so this must stay UNRESOLVED too, never a proven "no PR". A one-off
  // malformed row (not a repo-wide trait), so this is never `persistent`.
  if (unparseableRowSeen) {
    return { kind: 'unresolved', persistent: false, reason: 'a pull request row could not be parsed' };
  }

  const base = await resolveDefaultBranch(repoRoot, http, owner, repo);
  // `resolveDefaultBranch` collapses BOTH "the repo GET failed" and "resolveRepository never learned
  // a default_branch" to `null` — there is no way to tell those apart here, but neither is a proven
  // "no PR": the fallback simply could not be attempted, so this is UNRESOLVED too.
  if (!base) {
    return { kind: 'unresolved', persistent: false, reason: 'the repository default branch could not be resolved' };
  }
  try {
    const raw = await http.getJson(`${repoPrefix}/pulls/${encodeRefSegments(base)}/${encodeRefSegments(branch)}`);
    // `await` here is load-bearing: without it, this `try` returns the pending promise itself and
    // resolves/rejects OUTSIDE this frame, so a `pullRowToStatus` rejection (a non-absolute
    // `html_url`, see the comment above) skips this `catch` entirely instead of degrading correctly.
    return { kind: 'resolved', status: await pullRowToStatus(http, owner, repo, webUrl, forgejoPullSchema.parse(raw)) };
  } catch (err) {
    // A 404 here is the API's own proven answer: no PR exists for this exact base/head pair — a
    // genuine "no PR", safe to cache. Any OTHER failure (network, 5xx, a malformed body that fails
    // `forgejoPullSchema.parse`, or `pullRowToStatus`'s own degrade path above) means this read
    // taught us nothing, so it must stay UNRESOLVED rather than pin a "no PR" reading onto a branch
    // that might genuinely have one.
    if (err instanceof ForgejoHttpError && err.status === 404) return { kind: 'resolved', status: null };
    return { kind: 'unresolved', persistent: false, reason: describeError(err) };
  }
}

async function forgejoPrStatus(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  branch: string,
): Promise<ForgePrStatusResult> {
  // Dry-run answers from the same catalog the lists serve (#26), keyed on the branch a fixture PR
  // actually heads. Deliberately NOT "a status for every branch": this feeds the Create PR → View
  // PR flip, and handing a task branch someone else's PR would make the button lie about what it
  // opens. A branch no fixture PR heads is a PROVEN absence — `{available:true, status:null}`,
  // byte-identical to what this returned before.
  if (process.env.CEZ_DRY_RUN === '1') {
    return { available: true, status: dryRunForgejoPrStatus(owner, repo, webUrl, branch) };
  }
  const key = prStatusCacheKey(repoRoot, http.apiBase, branch);
  const hit = prStatusCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttlMs) return hit.data;
  const resolution = await resolveForgejoPrStatus(repoRoot, http, owner, repo, webUrl, branch);
  if (resolution.kind === 'unresolved') {
    const result: ForgePrStatusResult = { available: false, reason: resolution.reason };
    // Only the PERSISTENT flavor (the walk's own deterministic ceiling — a repo/branch trait) is
    // worth a SHORT negative cache so rapid repeat calls don't each re-pay the full, expensive walk.
    // Never the 60s `CACHE_MS` used for resolved answers below — this is "don't know", not "no PR",
    // and must self-heal quickly. Every other unresolved reason is a one-off, plausibly transient
    // read and must never be cached — the next call retries from scratch.
    if (resolution.persistent) {
      prStatusCache.set(key, { at: Date.now(), data: result, ttlMs: PR_STATUS_UNRESOLVED_CACHE_MS });
      evictOldest(prStatusCache, PR_STATUS_CACHE_MAX);
    }
    return result;
  }
  const result: ForgePrStatusResult = { available: true, status: resolution.status };
  prStatusCache.set(key, { at: Date.now(), data: result, ttlMs: CACHE_MS });
  evictOldest(prStatusCache, PR_STATUS_CACHE_MAX);
  return result;
}

/** `GET /repos/{o}/{r}/branches/{ref}` — every field here is readable anonymously (measured); the
 * SEPARATE `branch_protections` endpoint 401s without a token and is deliberately never called.
 * `readable: false` on ANY failure (404, network, malformed body) is the sole signal
 * `normalizeForgejoMergeState` uses to raise the `rules-unknown` blocker — this function must never
 * synthesize `readable: true` from a partial/defaulted parse just because `forgejoBranchSchema`'s
 * fields are all individually optional. */
async function fetchForgejoBranchInfo(http: ForgejoHttp, owner: string, repo: string, ref: string): Promise<ForgejoBranchInfo> {
  try {
    const raw = await http.getJson(`${repoPath(owner, repo)}/branches/${encodeRefSegments(ref)}`);
    const b = forgejoBranchSchema.parse(raw);
    return {
      readable: true,
      protected: b.protected,
      requiredApprovals: b.required_approvals,
      enableStatusCheck: b.enable_status_check,
      statusCheckContexts: b.status_check_contexts,
      userCanMerge: b.user_can_merge,
    };
  } catch {
    return { readable: false };
  }
}

/** Discriminates "the fetch itself failed" from "the fetch succeeded and returned this body" — the
 *  distinction `forgejoPrMergeState`'s `statusReadable`/`reviewsReadable` need (see
 *  `normalizeForgejoMergeState`'s own doc comment for why): a body of literal `null`/`[]` is a
 *  legitimate, common SUCCESSFUL answer ("no CI configured" / "no reviews yet"), and must never be
 *  conflated with "we don't know because the read failed". */
type ForgejoFetchResult<T> = { ok: true; value: T } | { ok: false };

/** `GET /repos/{o}/{r}/commits/{sha}/status` — `{ok:false}` on ANY failure (never thrown further).
 *  `pullRowToStatus` (list/prStatus rows, not a merge decision) still collapses that to `checks:
 *  null`, same as "no CI configured" — see its own doc comment for why that stays unchanged.
 *  `forgejoPrMergeState` does NOT collapse the two: it threads `ok` through to
 *  `normalizeForgejoMergeState`'s `statusReadable`, which blocks the merge (`checks-unknown`)
 *  instead of silently reading a failed CI probe as "no CI at all". */
async function fetchForgejoCombinedStatus(
  http: ForgejoHttp,
  owner: string,
  repo: string,
  sha: string,
): Promise<ForgejoFetchResult<unknown>> {
  try {
    return { ok: true, value: await http.getJson(`${repoPath(owner, repo)}/commits/${encodeRefSegments(sha)}/status`) };
  } catch {
    return { ok: false };
  }
}

/** Walks `GET /pulls/{n}/reviews`, capped the same way every other list walk in this driver is
 *  (`FJ_MAX_LIST_LIMIT`, parity with `GH_MAX_LIMIT`). `{ok:false}` on any failure — an unreadable
 *  review list must not fail the whole merge-state read; `forgejoPrMergeState` still feeds
 *  `computeReviewDecision` an empty `[]` in that case (a safe `'unknown'`/`'review-required'`
 *  answer, never a false approval), but ALSO threads `ok` through to
 *  `normalizeForgejoMergeState`'s `reviewsReadable`, which blocks the merge (`reviews-unknown`)
 *  instead of letting a failed read masquerade as "this PR genuinely has zero reviews". A page 1
 *  throw is the only case `paginate` can fail on without collecting anything (see forgejo-http.ts);
 *  a LATER page failing instead sets `page.stoppedShort` and keeps the rows already gathered —
 *  that partial page must ALSO be `{ok:false}`, not `{ok:true}`: a REQUEST_CHANGES review sitting on
 *  the unread remainder would otherwise be silently absent from `reviewsRaw`, letting
 *  `computeReviewDecision` read a partial walk as "no changes requested" (mirrors `forgejoPrDiff`'s
 *  own `filesPage.stoppedShort` handling for the file walk). */
async function fetchForgejoReviews(http: ForgejoHttp, owner: string, repo: string, number: number): Promise<ForgejoFetchResult<unknown[]>> {
  const repoPrefix = repoPath(owner, repo);
  try {
    const page = await http.paginate((p, l) => `${repoPrefix}/pulls/${number}/reviews?page=${p}&limit=${l}`, {
      want: FJ_MAX_LIST_LIMIT,
    });
    if (page.stoppedShort) return { ok: false };
    return { ok: true, value: page.rows };
  } catch {
    return { ok: false };
  }
}

/** ~1.5s, matching the measured window for Gitea's async mergeability check to settle
 *  (`mergeable:false` can mean the check is still "Checking", not a real conflict). Only worth paying on the
 *  `refresh:true` path — `mergePR`'s own preflight always calls with `refresh:true`, which is
 *  exactly the one call site where a false "conflicting" reading has a real cost (it flips
 *  `canOverride` to `false`, closing the user's only escape hatch). */
const MERGE_STATE_RETRY_DELAY_MS = 1_500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The catalog row the merge-state fixture describes. Not optional: `dryRunMergeStateFixture` below
 *  is only correct as long as the catalog still carries 777 (see its doc comment), so a catalog edit
 *  that drops the row fails loudly rather than quietly answering for a PR nobody lists.
 *
 *  Resolved on call, NOT at module load: an eager top-level throw would take the whole driver — every
 *  live, non-dry-run path in this file included — down at import time over a fixture that only
 *  `CEZ_DRY_RUN=1` ever reads. Lazily it reaches exactly the caller that depends on it, and the unit
 *  tests exercise that caller, so the loudness is kept and the blast radius is not. */
function dryRunMergeStateRow(): DryRunForgejoRow {
  const row = DRY_RUN_FORGEJO_ROWS.find((candidate) => candidate.kind === 'pr' && candidate.number === 777);
  if (!row) throw new Error('DRY_RUN_FORGEJO_ROWS must carry PR 777 — the dry-run merge-state fixture describes it');
  return row;
}

/** Forgejo's combined-status vocabulary for the glyph a catalog row carries — the merge panel's
 *  check list and the list row's chip are the same claim about the same PR, so neither is written
 *  out by hand. */
const DRY_RUN_STATUS_FOR_GLYPH = { passing: 'success', failing: 'failure', pending: 'pending' } as const;

/**
 * The dry-run `prMergeState` answer for PR 777, composed from the catalog row rather than restated.
 *
 * It used to be a module constant with every field written out, including
 * `html_url: 'http://forgejo:3000/mock/repo/pulls/777'`. That hardcoded path survived
 * `rebaseToWebUrl` (`forgejo-map.ts:29`) — which replaces the ORIGIN and keeps `src.pathname` — so
 * the merge panel pointed at `{webUrl}/mock/repo/pulls/777` while the very row the user clicked to
 * get there listed as `{webUrl}/{owner}/{repo}/pulls/777`. Harmless while the dry-run list was
 * empty and nothing was clickable; #26 is what makes that click possible, so every field the two
 * fixtures both describe — number, title, draft, diffstat, head branch, check glyph and the URL —
 * now comes from the one catalog row, and none of them can drift apart again by hand.
 */
function dryRunMergeStateFixture(owner: string, repo: string, webUrl: string) {
  const row = dryRunMergeStateRow();
  const glyph = row.checks ?? null;
  return {
    pullRaw: {
      number: row.number,
      title: row.title,
      html_url: forgejoViewUrl(webUrl, owner, repo, 'pr', row.number),
      created_at: '2026-01-01T00:00:00Z',
      draft: row.isDraft ?? false,
      additions: row.additions,
      deletions: row.deletions,
      state: 'open',
      merged: false,
      mergeable: true,
      head: { ref: row.branch ?? 'feat/dry-run', sha: '0'.repeat(40) },
      base: { ref: 'main' },
    },
    statusRaw: glyph ? { statuses: [{ status: DRY_RUN_STATUS_FOR_GLYPH[glyph], context: 'ci/build' }] } : null,
    branch: { readable: true, protected: false, requiredApprovals: 0, enableStatusCheck: false, statusCheckContexts: [], userCanMerge: true } as ForgejoBranchInfo,
    // A real (not `null`) repository: `mergePR`'s own CEZ_DRY_RUN path runs its preflight through
    // THIS fixture (via `prMergeState`), and a preflight that reports `methods: []` would 409 every
    // dry-run merge attempt with `disabled-method` before it ever reaches the dry-run success branch.
    // `allow_merge_commits`/`allow_squash_merge`/`allow_rebase` all `true` so every `ForgeMergeMethod`
    // a caller might exercise in dry-run mode is actually enabled.
    repository: {
      default_branch: 'main',
      allow_merge_commits: true,
      allow_squash_merge: true,
      allow_rebase: true,
      allow_rebase_explicit: false,
      allow_fast_forward_only_merge: false,
      default_merge_style: 'merge',
      has_pull_requests: true,
      archived: false,
    } as ForgejoRepository,
    reviewsRaw: [] as unknown[],
  };
}

/**
 * Assembles `ForgePrMergeState` from four independent reads (`GET pulls/{n}`, the combined commit
 * status, the branch, and the paginated review list) plus the repository body `resolveRepository`
 * either serves from `detectCache` or fetches fresh — mirrors `fetchPrMergeState`
 * (github.ts:1698-1748) structurally; all forge-specific mapping lives in
 * `normalizeForgejoMergeState`/`computeReviewDecision` (`forgejo-map.ts`), this function is I/O
 * only. `sleep` defaults to a real timer (`defaultSleep`) but is threaded through from `deps` so
 * the `mergeable:false` retry below (see `MERGE_STATE_RETRY_DELAY_MS`'s doc comment) is testable
 * with zero real wall-clock wait.
 */
async function forgejoPrMergeState(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  number: number,
  opts: { refresh?: boolean } | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<ForgePrMergeStateResult> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return {
      available: true,
      mergeState: normalizeForgejoMergeState({ ...dryRunMergeStateFixture(owner, repo, webUrl), webUrl, hasToken: http.hasToken() }),
    };
  }

  const key = mergeStateCacheKey(repoRoot, http.apiBase, number);
  if (!opts?.refresh) {
    const hit = mergeStateCache.get(key);
    if (hit && Date.now() - hit.at < MERGE_STATE_CACHE_MS) return hit.value;
  }

  try {
    let { raw: pullRaw, pull } = await fetchPull(http, owner, repo, number);

    // The mergeable:false retry: only on the refresh path (mergePR's preflight always refreshes),
    // and only when the FIRST read looks like a genuine "Checking -> false" ambiguity — a terminal
    // or draft PR's `mergeable:false` is already known-meaningless (normalizeForgejoMergeState maps
    // it to 'unknown' regardless), so retrying there would just burn a request for nothing.
    if (opts?.refresh && pull.state === 'open' && !pull.draft && pull.mergeable === false) {
      await sleep(MERGE_STATE_RETRY_DELAY_MS);
      ({ raw: pullRaw, pull } = await fetchPull(http, owner, repo, number));
    }

    const [statusFetch, branch, reviewsFetch, repository] = await Promise.all([
      // No `head.sha` at all (never observed on a live instance, but the schema allows it) means
      // there is genuinely nothing to probe — NOT a failed read, so this stays `ok:true` with a
      // `null` value, same as "no CI configured".
      pull.head?.sha
        ? fetchForgejoCombinedStatus(http, owner, repo, pull.head.sha)
        : Promise.resolve<ForgejoFetchResult<unknown>>({ ok: true, value: null }),
      pull.base?.ref ? fetchForgejoBranchInfo(http, owner, repo, pull.base.ref) : Promise.resolve<ForgejoBranchInfo>({ readable: false }),
      fetchForgejoReviews(http, owner, repo, number),
      resolveRepository(repoRoot, http, owner, repo),
    ]);

    const mergeState = normalizeForgejoMergeState({
      pullRaw,
      statusRaw: statusFetch.ok ? statusFetch.value : null,
      statusReadable: statusFetch.ok,
      branch,
      repository,
      webUrl,
      hasToken: http.hasToken(),
      reviewsRaw: reviewsFetch.ok ? reviewsFetch.value : [],
      reviewsReadable: reviewsFetch.ok,
    });
    const value: ForgePrMergeStateResult = { available: true, mergeState };
    mergeStateCache.set(key, { at: Date.now(), value });
    evictOldest(mergeStateCache, MERGE_STATE_CACHE_MAX);
    return value;
  } catch (err) {
    // `GET pulls/{n}` failing (404 — bad PR number, network, timeout) is the one failure this
    // method cannot degrade past: without the PR body there is no `ForgePrMergeState` to build.
    // Every OTHER read above degrades instead of throwing — the status/branch/reviews/repository
    // FETCHES to their own `ok:false`/`readable:false`, and (since a 200 can still carry a body
    // this driver cannot parse) the status and review PARSES to the same unreadable signal, inside
    // `normalizeForgejoMergeState`. So a CI hiccup or a malformed CI body can never take down the
    // whole method; only the PR read itself can.
    return { available: false, reason: describeError(err) };
  }
}

const PR_PUSH_TIMEOUT_MS = 60_000;

/** Same guard as `github.ts`'s own base-branch handling (github.ts:1447): a raw sha (a
 *  detached-HEAD fork point) can never be a valid PR base. `gh pr create` silently falls back to
 *  the repo default in that case; Forgejo's API has no such fallback (base is a required field), so
 *  `createForgejoPr` below must reject it itself and fall through to `Repository.default_branch`. */
const BASE_LOOKS_LIKE_SHA_RE = /^[0-9a-f]{7,40}$/i;

interface ForgejoExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Own local git runner for `createPR`'s push step. Deliberately NOT a shared import from
 *  `github.ts`'s `execTool` (that function is module-private there — importing it would also
 *  couple this driver to `github.ts` internals the plan explicitly keeps out of scope). Mirrors its
 *  shape (github.ts:1510-1525) for parity, not by reference. */
function execGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<ForgejoExecResult> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolveResult({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** Last 3 stderr lines, pipe-joined — toast-sized error context (mirrors github.ts's own `tail`). */
function tailLines(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}

/** Extracts a human message from a `send()` result that didn't 2xx. `send` never throws (unlike
 *  `getJson`/`getText`), so this reads off the already-drained `{status, json, text}` shape `send`
 *  hands back, rather than a live `Response` — the extraction itself (JSON `message` field, else
 *  first non-blank line of text, else the empty string) is shared with `forgejo-http.ts`'s own
 *  `describeErrorBody` via `messageFromBody`; only the draining differs. `fallback` is the
 *  action-specific default for the genuinely-reachable case of an empty error body (a live instance
 *  answers some failures, e.g. a 502 from a proxy in front of it, with no body at all) — each of
 *  this function's 6 call sites gets its own wording instead of one generic message. */
function sendErrorMessage(res: { status: number; json: unknown; text: string }, fallback: string): string {
  return messageFromBody(res.json, res.text) || `${fallback} (HTTP ${res.status})`;
}

/**
 * Publishes the run's branch as a draft PR: `autosaveCommit` (final flush) → `git push` (over the
 * worktree's own SSH key / credential helper — the remote is `ssh://git@<host>:<port>/…`, a
 * DIFFERENT host AND port than `apiUrl`, measured — so `CEZ_FORGEJO_TOKEN` plays no role in the
 * push, and a failed push must say so, not point at the token) → `POST repos/{o}/{r}/pulls`.
 * Mirrors `createDraftPr` (github.ts:1401-1468) structurally; the two diverge only where Forgejo's
 * API differs from `gh pr create` — see the comments at each divergence below.
 */
async function createForgejoPr(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  input: DraftPrInput,
): Promise<DraftPrOutcome> {
  const { run } = input;
  const worktree = run.worktreePath;
  const branch = run.branch;
  if (!worktree || !branch) {
    return { ok: false, error: 'this task has no worktree/branch to publish' };
  }

  // Final autosave: the branch must hold everything before it leaves the box — this is the LAST
  // flush, so a refusal (conflicted tree) or a failed commit has to stop the publish instead of
  // silently opening a PR from a branch missing the run's final state (parity github.ts:1409-1423).
  const saved = await autosaveCommit(worktree, 'pre-PR');
  if (saved === 'refused') {
    return { ok: false, error: 'worktree has unresolved merge conflicts — resolve them, then publish again' };
  }
  if (saved === 'failed') {
    return { ok: false, error: 'could not commit the final changes — check git status in the worktree' };
  }

  // DRY-RUN: no push, no HTTP — simulate success with a fake PR URL (parity github.ts:1425-1429).
  if (process.env.CEZ_DRY_RUN === '1') {
    return { ok: true, url: forgejoViewUrl(webUrl, owner, repo, 'pr', 777), dryRun: true };
  }

  const remote = await execGit(['remote', 'get-url', 'origin'], worktree);
  if (!remote.ok || !remote.stdout.trim()) {
    return { ok: false, error: 'no git remote — add one (git remote add origin <url>) or merge the branch locally' };
  }

  const push = await execGit(['push', '-u', 'origin', branch], worktree, PR_PUSH_TIMEOUT_MS);
  if (!push.ok) {
    // Deliberately no mention of CEZ_FORGEJO_TOKEN anywhere in this message — the push runs on the
    // worktree's own SSH key / credential helper (see the docstring above for why), and a message
    // that named the token here would send the user chasing the wrong fix.
    return { ok: false, error: `git push failed — ${tailLines(push.stderr) || 'unknown error'}` };
  }

  const repoPrefix = repoPath(owner, repo);

  // Forgejo requires `base` — unlike `gh pr create`, there is no repo-default fallback on its own
  // side. `origin/x` normalizes to `x`; a raw sha can't be a base either — both cases fall through
  // to `Repository.default_branch` (from the warm `detectCache`, or one fresh GET when cold).
  const rawBase = run.baseBranch?.replace(/^origin\//, '');
  const base = rawBase && !BASE_LOOKS_LIKE_SHA_RE.test(rawBase) ? rawBase : await resolveDefaultBranch(repoRoot, http, owner, repo);
  if (!base) {
    return { ok: false, error: 'could not determine a base branch — set baseBranch or check the repository default' };
  }

  const body = buildPrBody(input.handoffText, run.task);
  // `CreatePullRequestOption` has no `draft` field — Forgejo derives draft state from a "WIP:"/
  // "[WIP]" title prefix instead (measured on a live instance: `title:"WIP: …", draft:true`
  // together), so createPR must add the prefix itself; `stripWipTitle` strips it back off for
  // display in `mapForgejoPull`. That prefix recognition is itself governed by the target
  // instance's OWN `WORK_IN_PROGRESS_PREFIXES` config (a Gitea/Forgejo `app.ini` setting, not
  // something this driver can read or override) — the "WIP:" spelling sent here matches Forgejo's
  // documented default list, but an instance that has customized that setting to exclude it would
  // silently create a non-draft, immediately-mergeable-looking PR instead. This function does NOT
  // check `pull.draft` on the 201 response below to detect that mismatch: the field IS present
  // there (same schema, same measurement cited above) and reading it is cheap, but `DraftPrOutcome`
  // (this function's own return type) has no field to carry a "created, but not actually a draft"
  // warning to a caller — the route/UI wiring that would need to display one is out of scope for
  // this driver (README's own "Closing these routing gaps is later work"). Documented here rather
  // than silently assumed.
  const title = `WIP: ${run.title}`;

  // The branch is already pushed by this point, so a transport failure here is the ONE place this
  // function can leave the remote ahead of the PR. It still must not throw — `ForgeDriver.createPR`
  // is documented "Never throws" (types.ts:265) and `github.ts`'s sibling honours that by routing
  // every call through `execTool`, which returns instead of rejecting. `http.send` has no such
  // guarantee (it never try/catches `fetchImpl`, so a DNS failure, a refused connection or the
  // request timeout all reject), so the guard lives here.
  let res: Awaited<ReturnType<typeof http.send>>;
  try {
    res = await http.send('POST', `${repoPrefix}/pulls`, { head: branch, base, title, body });
  } catch (err) {
    return { ok: false, error: `pull request creation failed — ${describeError(err)}` };
  }

  if (res.status === 201) {
    // The PR was genuinely created server-side by the time we get here — evict this project's
    // caches BEFORE the parse below, so even a malformed body (which still degrades to a
    // best-effort success, see the try/catch below) doesn't leave a stale pre-publish
    // `prStatusCache` entry (`null`/"no PR") answering for up to 60s after a real PR now exists.
    // A malformed response body (fails `forgejoPullSchema`) or a non-absolute `html_url`
    // (`rebaseToWebUrl` throws a `TypeError`) must not turn a real success into an unhandled throw;
    // it degrades to a best-effort success without a clickable link instead, same reasoning as
    // `mergePR`'s own best-effort `mergeCommitSha` read-back.
    evictForgejoProjectCaches(repoRoot, http.apiBase);
    try {
      const pull = forgejoPullSchema.parse(res.json);
      return { ok: true, url: rebaseToWebUrl(pull.html_url, webUrl), dryRun: false };
    } catch {
      // No PR number to link to a specific pull — the repo's pull list is the best-effort fallback.
      return { ok: true, url: `${forgejoViewUrl(webUrl, owner, repo, 'repo', '')}/pulls`, dryRun: false };
    }
  }
  if (res.status === 409) {
    // "a PR from this head to this base already exists" — treat re-publishing as idempotent: fetch
    // the existing PR and hand its URL back instead of surfacing a conflict. But `GET
    // pulls/{base}/{head}` has no "give me the open one" semantics — it can return a MERGED/closed
    // PR sharing this exact head/base pair too (same caveat `resolveForgejoPrStatus`'s own fallback
    // documents), so only an OPEN match actually proves "a PR already exists to re-publish onto";
    // anything else falls through to the original 409's own error message instead of quietly
    // handing back a defunct PR's URL as if it were a success.
    try {
      const raw = await http.getJson(`${repoPrefix}/pulls/${encodeRefSegments(base)}/${encodeRefSegments(branch)}`);
      const pull = forgejoPullSchema.parse(raw);
      if (pull.state === 'open') {
        // Same reasoning as the 201 branch above: a genuinely open PR was just proven to exist for
        // this head/base — a stale pre-publish `prStatusCache` "no PR" entry must not survive it.
        evictForgejoProjectCaches(repoRoot, http.apiBase);
        return { ok: true, url: rebaseToWebUrl(pull.html_url, webUrl), dryRun: false };
      }
    } catch {
      // fall through to the 409's own message below
    }
  }
  if (res.status === 404) {
    // A repo with `has_pull_requests:false` answers 404 here, not a permissions error — a plain
    // "not found" would mislead a user staring at a repository that plainly exists.
    return { ok: false, error: 'pull requests are disabled for this repository' };
  }
  if (res.status === 423) {
    return { ok: false, error: 'this repository is archived and cannot receive pull requests' };
  }
  return { ok: false, error: sendErrorMessage(res, 'pull request creation failed') };
}

/** Clears every cache entry that belongs to one project (`repoRoot`+`apiBase` pair) after a write
 *  this driver just proved landed server-side. Two callers: `mergePR` after a successful merge, and
 *  `createPR` after a 201 (and after a 409 whose lookup proves an OPEN PR already exists) — there
 *  the stale entry to kill is `prStatusCache`'s pre-publish "no PR", which would otherwise answer
 *  for up to 60s after a real PR exists. The merge case is the broader one and sets the scope: a
 *  merge changes list membership (the merged PR should stop showing as open
 *  in `listIssues`/`listPRs`), the merged PR's own merge-state (now `terminal`), every OTHER open
 *  PR's merge-state too (their `head`/`base` didn't move, but a merge can flip branch-protection-
 *  derived fields that are shared across the whole repo — same reasoning `github.ts`'s
 *  `evictGithubProjectCaches` applies at repo scope, not PR scope), and every cached diff (a merge
 *  can rewrite the merged PR's `head.sha` to the merge commit, which `prDiffCache`'s own headSha-
 *  keyed TTL would not otherwise catch — see that cache's own doc comment). Mirrors
 *  `evictGithubProjectCaches` (github.ts:1757-1765); unlike GitHub's version this one also needs the
 *  `apiBase` half of the key, since every cache in this module is keyed `repoRoot\0apiBase\0...`.
 *  `detectCache` is deliberately NOT cleared here — a merge doesn't change the repository's own
 *  merge-method flags or default branch, which is all that cache holds. */
function evictForgejoProjectCaches(repoRoot: string, apiBase: string): void {
  const prefix = `${repoRoot}\0${apiBase}\0`;
  for (const cache of PROJECT_CACHES) {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }
}

/** Fixed, obviously-fake sha for the `CEZ_DRY_RUN=1` merge success path — mirrors `github.ts`'s own
 *  dry-run `mergeCommitSha` (github.ts:1791): a dry run never talks to Forgejo, so there is no real
 *  commit to report, but the field's presence still exercises whatever UI renders it. */
const DRY_RUN_MERGE_COMMIT_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

/**
 * Merges a pull request: mutex → preflight → (dry-run short-circuit) → `POST .../merge` → status
 * mapping. Mirrors `mergePullRequest` (github.ts:1767-1809) structurally; body/response shape is
 * Forgejo-specific (see the inline comments at each divergence).
 *
 * The mutex and the preflight are two INDEPENDENT layers of protection against the same race (two
 * merge clicks landing on the same PR near-simultaneously), not redundant: the mutex catches two
 * calls from THIS process; `head_commit_id` in the POST body (below) catches a merge that happened
 * from anywhere else (another cezar instance, the Forgejo web UI, a script) between the preflight
 * read and this POST landing. Removing either layer re-opens a real race window, not a redundancy.
 */
async function forgejoMergePR(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  number: number,
  input: ForgeMergeInput,
  sleep: (ms: number) => Promise<void>,
): Promise<ForgeMergeResult> {
  const key = mergeStateCacheKey(repoRoot, http.apiBase, number);
  if (mergeInflight.has(key)) {
    return { merged: false, status: 409, error: 'A merge is already in progress for this pull request.', code: 'concurrent' };
  }
  mergeInflight.add(key);
  try {
    // Always `refresh: true` — a merge decision must never be made off a stale cached mergeState,
    // and this call is also what re-populates `mergeStateCache` with the fresh read every OTHER
    // reader (the merge-state panel refreshing after this call) will see.
    const fresh = await forgejoPrMergeState(repoRoot, http, owner, repo, webUrl, number, { refresh: true }, sleep);
    if (!fresh.available) return { merged: false, status: 502, error: fresh.reason };
    const current = fresh.mergeState;

    if (current.headSha !== input.expectedHeadSha) {
      return {
        merged: false,
        status: 409,
        error: 'The pull request head changed. Review the new commits before merging.',
        code: 'stale-head',
        current,
      };
    }
    if (!current.methods.includes(input.method)) {
      return { merged: false, status: 409, error: 'That merge method is no longer enabled.', code: 'disabled-method', current };
    }
    if (!mergePreflightAllowed(current, input.overrideRules)) {
      return {
        merged: false,
        status: 409,
        error: current.blockers[0]?.message ?? 'The pull request is not eligible to merge.',
        code: current.eligibility,
        current,
      };
    }

    // DRY-RUN, checked AFTER every preflight gate above (parity github.ts:1789) — a dry run still
    // exercises the full eligibility ladder against the fixture `prMergeState` served under
    // CEZ_DRY_RUN, it just never issues the real POST.
    if (process.env.CEZ_DRY_RUN === '1') {
      evictForgejoProjectCaches(repoRoot, http.apiBase);
      return { merged: true, number, url: current.url, method: input.method, mergeCommitSha: DRY_RUN_MERGE_COMMIT_SHA };
    }

    // `current.methods` (checked above) is derived from the SAME repository body this resolves —
    // `resolveRepository` serves the warm `detectCache` entry `forgejoPrMergeState` just populated,
    // so this is never a second network request in practice.
    const repository = await resolveRepository(repoRoot, http, owner, repo);
    const doValue = repository ? mergeMethodsFromRepository(repository).doFor[input.method] : undefined;
    if (!doValue) {
      // Defensive only — should be unreachable given the `current.methods.includes` check above
      // (both derive from the same repository body). Kept as a typed guard, not a non-null
      // assertion, so a future drift between the two derivations degrades instead of sending
      // `Do: undefined` to the wire.
      return { merged: false, status: 409, error: 'That merge method is no longer enabled.', code: 'disabled-method', current };
    }

    const repoPrefix = repoPath(owner, repo);
    let res: { status: number; json: unknown; text: string };
    try {
      res = await http.send('POST', `${repoPrefix}/pulls/${number}/merge`, {
        Do: doValue,
        // Native optimistic-concurrency check on Forgejo's own side — ALWAYS sent, never made
        // conditional on the preflight compare above. See this function's own doc comment for why
        // the two are independent layers, not a redundant pair.
        head_commit_id: input.expectedHeadSha,
        force_merge: input.overrideRules === true,
        // Explicitly false — omitting this (or sending `true`) makes Forgejo SCHEDULE the merge for
        // once checks pass instead of merging now, and this function would still return
        // `merged:true` for a merge that has not actually happened yet. Do not drop this field to
        // "simplify"; it is not a default worth inheriting.
        merge_when_checks_succeed: false,
        // Explicitly false — do NOT inherit `Repository.default_delete_branch_after_merge`. Deleting
        // the run's own branch out from under it, from the merge button, is destructive, and
        // `github.ts`'s `mergePullRequest` does not do this either. Do not drop this field either.
        delete_branch_after_merge: false,
      });
    } catch (err) {
      // Network failure / timeout from the merge POST itself — nothing was necessarily mutated
      // server-side (or it was, and the response just never arrived); either way this function has
      // no way to know which, so it reports the one honest thing it can: the call failed.
      return { merged: false, status: 502, error: describeError(err) };
    }

    if (res.status === 200) {
      evictForgejoProjectCaches(repoRoot, http.apiBase);
      // The 200 response body is empty on a live instance — `merge_commit_sha` is only obtainable
      // through a SEPARATE, follow-up `GET /pulls/{n}`. Best-effort: the merge already happened, so
      // a failure reading it back must never turn a real success into an error — it just omits the
      // field (`ForgeMergeResult.mergeCommitSha` is optional for exactly this reason).
      let mergeCommitSha: string | undefined;
      try {
        mergeCommitSha = (await fetchPull(http, owner, repo, number)).pull.merge_commit_sha ?? undefined;
      } catch {
        mergeCommitSha = undefined;
      }
      return { merged: true, number, url: current.url, method: input.method, ...(mergeCommitSha ? { mergeCommitSha } : {}) };
    }
    if (res.status === 401 || res.status === 403) {
      return { merged: false, status: 403, error: sendErrorMessage(res, 'Forgejo denied the merge') };
    }
    if (res.status === 404) {
      return { merged: false, status: 404, error: sendErrorMessage(res, 'pull request or repository not found') };
    }
    if (res.status === 405) {
      // Forgejo answers 405 for a request its own server-side rules refuse outright (distinct from
      // a 409 conflict) — the contract's `ForgeMergeResult` union has no dedicated status for this,
      // so it collapses onto 409 like the other three "forge said no, try something else" codes
      // below; the `code` is what lets a caller tell them apart.
      return { merged: false, status: 409, error: sendErrorMessage(res, 'Forgejo refused the merge'), code: 'forgejo-blocked', current };
    }
    if (res.status === 409) {
      return { merged: false, status: 409, error: sendErrorMessage(res, 'the pull request has conflicts'), code: 'conflicts', current };
    }
    if (res.status === 423) {
      return {
        merged: false,
        status: 409,
        error: 'this repository is archived and cannot be merged into',
        code: 'archived',
        current,
      };
    }
    if (res.status === 413) {
      return { merged: false, status: 409, error: 'the repository has exceeded its storage quota', code: 'quota', current };
    }
    // Any other status (5xx, or anything this switch didn't anticipate) — Forgejo could not
    // complete the merge and this driver has no more specific mapping to offer.
    return { merged: false, status: 502, error: sendErrorMessage(res, 'Forgejo could not complete the merge') };
  } finally {
    mergeInflight.delete(key);
  }
}

/** `ChangedFile` on the wire has no `patch` field at all — `forgejo-diff.ts`'s `splitUnifiedDiff`
 *  is what supplies it, parsed from a SEPARATE `GET /pulls/{n}.diff` request. Used only by the
 *  `CEZ_DRY_RUN=1` short-circuit below, which wraps this file list in a result object whose
 *  `number` echoes back whatever PR was asked for; `headSha` there is a fixed all-zero sha, and
 *  this fixture itself (a `ForgePrChange[]`, which carries neither field) never varies. */
const DRY_RUN_PR_DIFF_FIXTURE: ForgePrChange[] = [
  { path: 'src/example.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-old\n+new\n context' },
  { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 0, deletions: 0 },
];

/**
 * Bounded, read-only file changes for a pull request: `GET pulls/{n}` (for `headSha` and to prove
 * the PR exists) → cache-check (keyed on that `headSha`, see `prDiffCache`'s own doc comment) →
 * paginated `GET pulls/{n}/files` (the AUTHORITY for `path`/`status`/`additions`/`deletions`) run
 * in parallel with one `GET pulls/{n}.diff` (`text/plain`) split by `splitUnifiedDiff` — the diff
 * contributes ONLY `patch` (and a fallback `previousPath` for renames `/files` didn't itself
 * report one for). The join key is `filename` — never row order, never a re-derived `diff --git`
 * header path: a misparsed header would silently hand one file's patch to a different file, which
 * is exactly why `splitUnifiedDiff` itself keys its map by the parsed `+++ b/…` path rather than
 * handing back an ordered list. Sizing/truncation algorithm mirrors `fetchGithubPrDiff`
 * (github.ts:67-140) file-for-file.
 */
async function forgejoPrDiff(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  number: number,
  opts: { refresh?: boolean } | undefined,
): Promise<ForgePrDiffResult> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return {
      available: true,
      number,
      headSha: '0'.repeat(40),
      files: DRY_RUN_PR_DIFF_FIXTURE,
      additions: 3,
      deletions: 1,
      truncated: false,
    };
  }

  const repoPrefix = repoPath(owner, repo);
  try {
    const { pull } = await fetchPull(http, owner, repo, number);
    const headSha = pull.head?.sha;
    if (!headSha) return { available: false, reason: 'this pull request has no head commit yet' };

    const key = prDiffCacheKey(repoRoot, http.apiBase, number, headSha);
    if (!opts?.refresh) {
      const hit = prDiffCache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    }

    // The `/files` walk and the `.diff` fetch are independent reads of the same PR — run them
    // concurrently. Only the `.diff` side has its own local `.catch`: the WHOLE `.diff` request
    // failing (network/HTTP) degrades to a files-only list rather than failing the method
    // outright — a filename+status+counts list with `not-provided` patches still beats
    // `{available:false}`, and every row below finds no `diffMap` entry and degrades per-file,
    // exactly as if the diff had come back empty. A `/files` failure has no such soft landing (no
    // rows means nothing to report) and is left to propagate to this function's own outer `catch`.
    const [filesPage, diffMap] = await Promise.all([
      http.paginate((p, l) => `${repoPrefix}/pulls/${number}/files?page=${p}&limit=${l}`, {
        want: FJ_PR_DIFF_FILE_CAP,
        maxPages: FJ_FILES_MAX_PAGES,
      }),
      http
        .getText(`${repoPrefix}/pulls/${number}.diff`, { accept: 'text/plain' })
        .then(splitUnifiedDiff)
        .catch((): Map<string, ForgejoDiffEntry> => new Map()),
    ]);
    const rows: ForgejoChangedFile[] = [];
    for (const row of filesPage.rows) {
      try {
        rows.push(forgejoChangedFileSchema.parse(row));
      } catch {
        // A malformed row must not abort the whole diff — same policy `resolveForgejoPrStatus`
        // applies to a malformed list row: skip it, keep the rest.
      }
    }
    if (filesPage.rows.length > 0 && rows.length === 0) {
      // Same gate `listForgejo` applies to its own walk (`forgejo.ts`'s `listForgejo` doc comment):
      // a non-empty `/files` page where every row fails `forgejoChangedFileSchema` means the
      // response shape drifted, not "this PR has no changes" — left unchecked this would render a
      // real PR as a false "+0 −0, no changes". Returned before the `prDiffCache.set` below, so a
      // drifted read is never pinned for the 60s TTL, same reasoning as this function's own outer
      // `catch`.
      return { available: false, reason: 'the file list response did not match the expected shape' };
    }

    const rowsCapped = rows.slice(0, FJ_PR_DIFF_FILE_CAP);
    // Two independent reasons the file list can be incomplete: a full cap worth of rows (`rows.length`
    // conservatively called partial even though the walk might, in principle, have landed exactly on
    // the true total), OR the `/files` walk itself proving nothing beyond what it collected
    // (`filesPage.stoppedShort` — a later page errored, hit the walk budget, or hit `maxPages`). Either
    // on its own means the response below must not be served as a complete diff.
    let responseTruncated = rows.length >= FJ_PR_DIFF_FILE_CAP || filesPage.stoppedShort;
    const reasons: string[] = [];
    if (rows.length >= FJ_PR_DIFF_FILE_CAP) reasons.push(`Only the first ${FJ_PR_DIFF_FILE_CAP} files are shown.`);
    if (filesPage.stoppedShort) reasons.push('The file list could not be fully retrieved.');

    const files: ForgePrChange[] = rowsCapped.map((row) => {
      const diffEntry = diffMap.get(row.filename);
      let patch = diffEntry?.patch;
      let truncated = false;
      let patchUnavailableReason: 'binary' | 'too-large' | 'not-provided' | undefined;
      if (!diffEntry || diffEntry.binary) {
        patchUnavailableReason = diffEntry?.binary ? 'binary' : 'not-provided';
      } else if (patch === undefined) {
        // A block the splitter found but with no hunks at all (a pure rename or a mode-only
        // change) — there is genuinely no patch to show, same as a file `/files` reported but the
        // diff never mentioned.
        patchUnavailableReason = 'not-provided';
      } else if (Buffer.byteLength(patch, 'utf8') > FJ_PR_PATCH_CAP) {
        patch = undefined;
        truncated = true;
        patchUnavailableReason = 'too-large';
        responseTruncated = true;
      }
      // `/files`' own `previous_filename` is the primary source (it is the authority for this
      // row); the diff's `previousPath` only fills in when `/files` didn't report one — a rename
      // `/files` recognizes but the diff, for whatever reason, folded into a same-path block.
      const previousPath = row.previous_filename ?? diffEntry?.previousPath;
      return {
        path: row.filename,
        ...(previousPath ? { previousPath } : {}),
        status: mapChangedFileStatus(row.status),
        additions: row.additions,
        deletions: row.deletions,
        ...(patch !== undefined ? { patch } : {}),
        ...(patchUnavailableReason ? { patchUnavailableReason } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    });

    let kept = files;
    while (
      kept.length > 0 &&
      Buffer.byteLength(JSON.stringify({ available: true, number, headSha, files: kept }), 'utf8') > FJ_PR_DIFF_JSON_CAP
    ) {
      kept = kept.slice(0, -1);
      responseTruncated = true;
    }
    if (kept.length < files.length) reasons.push('The response size limit omitted some files.');
    if (files.some((file) => file.truncated)) reasons.push('One or more patches exceeded the per-file limit.');

    const data: ForgePrDiffResult = {
      available: true,
      number,
      headSha,
      files: kept,
      additions: rows.reduce((sum, row) => sum + row.additions, 0),
      deletions: rows.reduce((sum, row) => sum + row.deletions, 0),
      truncated: responseTruncated,
      ...(reasons.length ? { reason: reasons.join(' ') } : {}),
    };
    prDiffCache.set(key, { at: Date.now(), data });
    evictOldest(prDiffCache, PR_DIFF_CACHE_MAX);
    return data;
  } catch (err) {
    // Two reads this method cannot degrade past land here: `GET pulls/{n}` (404 — bad PR number,
    // network, timeout — without the PR body there is no `headSha` to key anything on) and the
    // `/files` walk's own first page failing (`paginate` rethrows on page 1, see forgejo-http.ts —
    // with zero rows collected there is nothing to report). Every OTHER read in this function
    // (`.diff`, individual malformed `/files` rows) already degrades to its own safe default above
    // instead of throwing, exactly so neither can take the whole response down with it.
    return { available: false, reason: describeError(err) };
  }
}

/**
 * The comment/review thread for one issue or pull request (#499). `events` (the timeline axis,
 * #525) is out of scope here, so this always answers with `events` absent, which the contract
 * already treats as a degrade to comments-only, not a defect.
 *
 * `kind === 'pr'` walks TWO independent endpoints (`issues/{n}/comments` for the conversation body
 * — the same endpoint `kind === 'issue'` uses, measured to also serve a PR's conversation comments
 * — and `pulls/{n}/reviews` for the review summaries) and merges them chronologically; every row
 * that fails its schema is dropped individually (the per-row policy `listForgejo` and
 * `resolveForgejoPrStatus` already apply to their own walks), never the whole thread.
 *
 * A stream (comments or reviews) that received rows but mapped/parsed NONE of them signals a
 * schema drift on THAT stream (`commentsUnmappable` / `reviewsUnmappable` below). A drift on one
 * stream alone must not blank a thread whose OTHER stream still produced comments — same "don't
 * blank what already worked" instinct as the rest of this driver, so the thread stays visible with
 * a `reason` as long as the MERGED result carries something. Only when the merged result across
 * BOTH streams comes back genuinely empty does a drift get to degrade the whole response to
 * `available:false` — a genuinely comment-less thread and a Forgejo response whose shape drifted
 * out from under this driver's schemas must never collapse to the same `{available:true,
 * comments:[]}`. This is distinct from `mapForgejoReview`'s own content-based drops (an empty-body
 * COMMENT/PENDING review carries no signal, which is a legitimate zero, not a schema mismatch): a
 * review row that PARSED but was then content-filtered away never counts as "unmappable" on its
 * own, so a thread whose reviews are entirely (legitimate) empty-body filters and whose comments
 * are genuinely absent still reads as a real empty thread, `available:true`. It only stops being
 * legitimate once the OTHER stream (or this same one) shows an actual schema drift AND the merged
 * result is empty — that combination is what degrades. A payload carrying a partial-drift `reason`
 * is never cached (below), same as the fully-degraded case, since the drift may be transient.
 */
async function forgejoListComments(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  kind: 'issue' | 'pr',
  number: number,
  opts: { refresh?: boolean } | undefined,
): Promise<ForgeCommentsData> {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true, comments: [] };
  const key = commentsCacheKey(repoRoot, http.apiBase, kind, number);
  if (!opts?.refresh) {
    const hit = forgejoCommentsCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }

  const repoPrefix = repoPath(owner, repo);
  try {
    const commentsPage = await http.paginate((p, l) => `${repoPrefix}/issues/${number}/comments?page=${p}&limit=${l}`, {
      want: FJ_THREAD_ENTRY_CAP,
    });
    const collected: ForgeComment[] = [];
    let mappedCommentsCount = 0;
    for (const row of commentsPage.rows) {
      // Per-row, not per-thread: a row whose `html_url` is not absolute makes `rebaseToWebUrl`
      // throw a `TypeError` — that must cost this ONE row, not degrade the whole thread to
      // `available:false`, same per-row policy `listForgejo` already applies to its own walk
      // (`:510`).
      let mapped: ForgeComment | null;
      try {
        mapped = mapForgejoComment(row, webUrl);
      } catch {
        continue;
      }
      if (mapped) {
        collected.push(mapped);
        mappedCommentsCount++;
      }
    }
    // Every comment row that parses is kept (no content filter on this side, unlike reviews below)
    // — so a null from `mapForgejoComment` on every row is always a genuine schema mismatch.
    const commentsUnmappable = commentsPage.rows.length > 0 && mappedCommentsCount === 0;

    let reviewsStoppedShort = false;
    let reviewsRawCount = 0;
    let reviewsStructurallyValidCount = 0;
    if (kind === 'pr') {
      const reviewsPage = await http.paginate((p, l) => `${repoPrefix}/pulls/${number}/reviews?page=${p}&limit=${l}`, {
        want: FJ_THREAD_ENTRY_CAP,
      });
      reviewsStoppedShort = reviewsPage.stoppedShort;
      reviewsRawCount = reviewsPage.rows.length;
      for (const row of reviewsPage.rows) {
        let parsed;
        try {
          parsed = forgejoReviewSchema.parse(row);
        } catch {
          continue; // unparseable row — not the whole walk (same per-row policy as everywhere else)
        }
        if (parsed.id == null || parsed.html_url == null) {
          // A structural gap, not a content filter: `forgejoReviewSchema` keeps both `.nullish()`
          // for `computeReviewDecision`'s older fixtures, so a row can PARSE fine and still lack
          // what a `ForgeComment` requires. `mapForgejoReview` would also return `null` here, but
          // for a reason this gate must count as schema drift below, distinct from its legitimate
          // empty-body content filter (which only ever fires on a row that DOES carry id/html_url).
          continue;
        }
        reviewsStructurallyValidCount++;
        // Same per-row policy as the comments loop above — a non-absolute `html_url` must drop
        // only this row, not the whole thread.
        let mapped: ForgeComment | null;
        try {
          mapped = mapForgejoReview(parsed, webUrl);
        } catch {
          continue;
        }
        if (mapped) collected.push(mapped);
      }
    }
    // Distinct from a null `mapForgejoReview` return on a structurally valid row: THAT can be a
    // legitimate content filter (an empty-body COMMENT/PENDING/REQUEST_REVIEW review), never a
    // schema mismatch on its own. Only "every row failed to even parse, or parsed but without the
    // id/html_url a `ForgeComment` requires" signals a schema drift on the reviews side.
    const reviewsUnmappable = reviewsRawCount > 0 && reviewsStructurallyValidCount === 0;

    // The schema-drift gate degrades to `available:false` only when a stream actually drifted
    // (`commentsUnmappable` or `reviewsUnmappable` — rows arrived but none of them mapped/parsed)
    // AND the thread's merged result is empty. `reviewsStructurallyValidCount` alone is NOT
    // "signal" for this gate — a review row that parsed fine, carried id/html_url, but was then
    // legitimately content-filtered away (empty-body COMMENT/PENDING/REQUEST_REVIEW,
    // `mapForgejoReview`'s own filter) never lands in `collected`, so checking `collected.length`
    // (not `reviewsStructurallyValidCount`) is what keeps that legitimate filter from masking a
    // genuine drift on the comments side (regression fixed here —
    // a comments-side drift next to an all-filtered reviews page must NOT read as a quiet
    // `{available:true, comments:[]}`). A drift on one stream next to a healthy other stream that
    // still produced comments stays visible (`collected.length > 0`) with a `reason` below.
    if ((commentsUnmappable || reviewsUnmappable) && collected.length === 0) {
      // Deliberately NOT cached, same reasoning `listForgejo`'s own catch gives: a response shape
      // that just drifted is exactly the kind of thing that must not pin a failure for the TTL.
      return { available: false, reason: 'the comment thread response did not match the expected shape', comments: [] };
    }

    collected.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cappedByLength = collected.length > FJ_THREAD_ENTRY_CAP;
    const comments = cappedByLength ? collected.slice(0, FJ_THREAD_ENTRY_CAP) : collected;
    const truncated = cappedByLength || commentsPage.stoppedShort || reviewsStoppedShort;

    // The thread is visible past this point. When exactly one stream individually drifted while
    // the OTHER stream carried the whole thread's signal, surface that in `reason` rather than
    // gating the payload on it — `ForgeCommentsData.reason` is legal at `available:true` (mirrors
    // `ForgeListResult`'s own doc: "never an error — a hint"), unlike `ForgeChecksResult`'s
    // `available:true` branch, which carries no such field at all.
    const reason = commentsUnmappable
      ? 'the comment stream response did not match the expected shape — showing reviews only'
      : reviewsUnmappable
        ? 'the review stream response did not match the expected shape — showing comments only'
        : undefined;

    const data: ForgeCommentsData = { available: true, comments, ...(truncated ? { truncated: true } : {}), ...(reason ? { reason } : {}) };
    // A partial-stream drift (`reason` set) is never cached — same instinct as the `available:false`
    // branch above: pinning a drifted read for the full TTL would keep re-serving a degraded thread
    // even after the forge recovers. Only a fully clean read (no `reason`) is worth memoizing.
    if (!reason) {
      forgejoCommentsCache.set(key, { at: Date.now(), data });
      evictOldest(forgejoCommentsCache, FORGEJO_COMMENTS_CACHE_MAX);
    }
    return data;
  } catch (err) {
    // A transport failure (network, non-404 HTTP) on either walk — page 1 of `paginate` rethrows
    // with nothing collected (forgejo-http.ts), so there is nothing here to salvage. Never cached,
    // same policy as every other read failure in this module.
    return { available: false, reason: describeError(err), comments: [] };
  }
}

/**
 * Batched CI-status glyphs for the given PR numbers (`GET /github/checks`, #664's lazy hydration
 * ported to the Forgejo driver). A naive per-number fan-out (a lookup PLUS a status read for each
 * of up to `GH_CHECKS_MAX` (100) numbers) would cost up to 200 serial round-trips for one call
 * against one open-PR-only response GitHub answers in one batch — instead this walks
 * `pulls?state=open` ONCE to build a `number -> head.sha` map (the dominant case: every visible PR
 * row is open) and only falls back to a per-number `GET pulls/{n}` for a number the walk didn't
 * cover (closed/merged, or beyond the walk's own page budget).
 *
 * `fetchForgejoCombinedStatus` swallows EVERY failure into `{ok:false}` — the same collapse
 * `pullRowToStatus` above relies on to fold "the read failed" and "no CI configured" into one
 * `null` glyph for a SINGLE list-row badge, where that ambiguity is cheap. Reusing that collapse
 * unconditionally here would let a Forgejo outage that strikes AFTER a successful open-PR walk
 * render as a quiet, all-null glyph map — indistinguishable from "nobody configured CI on any of
 * these PRs", the exact silent-failure shape a caller must be able to tell apart from a genuine
 * "no CI configured anywhere" reading. So this function counts the combined-status reads it
 * resolves for itself: if NONE of the requested numbers end up with an answer (no cache hit, no
 * proven-absent 404, no successful status read), the whole response degrades to `available:false`
 * + a reason — never a `checks` map full of `null`s standing in for an unreported failure. A
 * PARTIAL failure (some numbers resolved, some didn't) stays `available:true` with the numbers
 * that DID resolve intact — same "don't blank what already worked" instinct `/github`'s own list
 * composition uses (`server.ts`'s `/github` handler), but with no `reason` to spend on it:
 * `ForgeChecksResult`'s `available:true` branch mirrors `githubChecksDataSchema`
 * (`packages/contract/src/github.ts:65`), which has never carried one, so a per-item failure here
 * collapses silently to a `null` glyph — the same degrade `fetchPrChecks`/`fetchCommitChecks`
 * (`github.ts`) already apply to their own per-chunk failures. The threshold is deliberately "zero
 * resolved", not "any failure": a single flaky status read must not blank a batch of 99 healthy
 * ones.
 */
async function forgejoListChecks(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  numbers: number[],
): Promise<ForgeChecksResult> {
  // Glyphs straight from the catalog (#26) — parity with `mockGithubChecks`. The dry-run rows carry
  // their glyph inline already (`dryRunForgejoItem`), so unlike the live tier — where
  // `mapForgejoPull` ships `checks: null` and the chip is hydrated lazily from this call (#664) —
  // this answer is not what paints the list. It still has to agree with the row it describes, and
  // it is the only answer the cockpit gets for a number the list never carried.
  if (process.env.CEZ_DRY_RUN === '1') return dryRunForgejoChecks(numbers);
  const checks: Record<number, 'passing' | 'failing' | 'pending' | null> = {};
  const misses: number[] = [];
  const now = Date.now();
  for (const n of numbers) {
    const hit = forgejoChecksCache.get(checksCacheKey(repoRoot, http.apiBase, n));
    if (hit && now - hit.at < CACHE_MS) checks[n] = hit.glyph;
    else misses.push(n);
  }
  if (misses.length === 0) return { available: true, checks };

  const repoPrefix = repoPath(owner, repo);
  const openShaByNumber = new Map<number, string>();
  try {
    const page = await http.paginate((p, l) => `${repoPrefix}/pulls?state=open&page=${p}&limit=${l}`, { want: FJ_MAX_LIST_LIMIT });
    for (const row of page.rows) {
      let parsed: ForgejoPull;
      try {
        parsed = forgejoPullSchema.parse(row);
      } catch {
        continue; // an unparseable row simply never joins the map — its number, if it was a miss, falls to the per-number fallback below
      }
      if (parsed.head?.sha) openShaByNumber.set(parsed.number, parsed.head.sha);
    }
  } catch (err) {
    // Page 1 of `paginate` is the only page that can fail with nothing collected — never throw
    // from a read, degrade the whole response instead (same policy `listForgejo`'s own catch
    // applies to its own walk).
    return { available: false, reason: describeError(err) };
  }

  // A number the open-PR walk didn't cover (closed/merged, or beyond its own page budget) needs
  // its own `GET pulls/{n}`. A 404 there is the API's own proven answer ("no such PR") — a genuine
  // `null` glyph, not a transport failure. Any OTHER failure means this read taught the driver
  // nothing about THIS number's sha — it degrades only THIS number to a failed-read glyph (folded
  // into `null` below, alongside `failedNumbers`, same as a failed combined-status read), never
  // aborting numbers the open-PR walk or the cache already resolved. The response as a whole still
  // degrades to `available:false` if NOTHING resolves (the gate below), same as before.
  //
  // A non-404 failure additionally means the fallback TRANSPORT itself is unhealthy (network,
  // timeout, 5xx) — issuing one more `GET pulls/{n}` per remaining miss would serialize up to
  // `misses.length` more `FJ_TIMEOUT_MS` waits (up to `GH_CHECKS_MAX` = 100) for a single call, with
  // no retry budget. So the first non-404 stops the fallback loop outright: every miss from that
  // point on is resolved from `openShaByNumber` if the walk already covered it (never re-fetched —
  // same "numbers the walk resolved never disappear" guarantee as above) and otherwise folded into
  // `failedNumbers` without another network round-trip.
  const shaByNumber = new Map<number, string | null>();
  const failedNumbers: number[] = [];
  for (const [i, n] of misses.entries()) {
    const sha = openShaByNumber.get(n);
    if (sha) {
      shaByNumber.set(n, sha);
      continue;
    }
    try {
      const { pull } = await fetchPull(http, owner, repo, n);
      shaByNumber.set(n, pull.head?.sha ?? null);
    } catch (err) {
      if (err instanceof ForgejoHttpError && err.status === 404) {
        shaByNumber.set(n, null);
        continue;
      }
      for (const remaining of misses.slice(i)) {
        const walkedSha = openShaByNumber.get(remaining);
        if (walkedSha) shaByNumber.set(remaining, walkedSha);
        else failedNumbers.push(remaining);
      }
      break;
    }
  }

  const toFetch: Array<[number, string]> = [];
  for (const [n, sha] of shaByNumber) {
    if (sha) {
      toFetch.push([n, sha]);
    } else {
      // A proven-absent PR (404 on the fallback) — a resolved `null`, cached like any other
      // resolved answer, unlike the failed-read `null`s below.
      checks[n] = null;
      forgejoChecksCache.set(checksCacheKey(repoRoot, http.apiBase, n), { at: now, glyph: null });
    }
  }

  for (let i = 0; i < toFetch.length; i += FJ_CHECKS_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + FJ_CHECKS_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async ([n, sha]) => ({ n, status: await fetchForgejoCombinedStatus(http, owner, repo, sha) })),
    );
    for (const { n, status } of results) {
      if (!status.ok) {
        // Deliberately NOT written into `checks` yet — the "did anything resolve at all" gate
        // below needs to tell a failed read apart from a resolved `null`.
        failedNumbers.push(n);
        continue;
      }
      let glyph: 'passing' | 'failing' | 'pending' | null;
      try {
        glyph = combinedStatusToChecks(status.value);
      } catch {
        glyph = null; // a malformed-but-syntactically-valid body degrades this ONE glyph, same as `pullRowToStatus` above
      }
      checks[n] = glyph;
      forgejoChecksCache.set(checksCacheKey(repoRoot, http.apiBase, n), { at: now, glyph });
    }
    // A chunk where EVERY read failed is the same "transport is unhealthy" signal the per-number
    // fallback loop above already acts on (a lone flaky read is expected and cheap — see this
    // function's own doc comment — but a whole batch failing together is not). Serializing every
    // remaining chunk against a hung forge (up to `FJ_TIMEOUT_MS` per number) would multiply the
    // wait for nothing, so this stops here: every number this stage hasn't visited yet folds into
    // `failedNumbers` (unresolved) without another round-trip, same "never fetched" treatment the
    // fallback loop's own salvage-then-break gives its own leftovers.
    if (results.every((r) => !r.status.ok)) {
      for (const [n] of toFetch.slice(i + FJ_CHECKS_CONCURRENCY)) failedNumbers.push(n);
      break;
    }
  }

  if (Object.keys(checks).length === 0) {
    // Nothing resolved at all — every miss's status read failed and none were a proven-absent PR
    // (see this function's own doc comment above). A `checks` map with every value forced to
    // `null` would be indistinguishable from a real "no CI anywhere" reading, so this reports the
    // read itself failed instead.
    return { available: false, reason: 'checks status could not be read from the forge' };
  }
  evictOldest(forgejoChecksCache, FORGEJO_CHECKS_CACHE_MAX);
  // `ForgeChecksResult`'s `available:true` branch carries no `reason` field — unlike
  // `ForgeListResult` (`githubDataSchema` is flat, a `reason` is legal at `available:true` there),
  // `ForgeChecksResult` mirrors `githubChecksDataSchema`'s discriminated union, whose `true` branch
  // has never carried one (`packages/contract/src/github.ts:65`). A per-item failed read here
  // collapses to a `null` glyph with no separate signal — the SAME degrade `fetchPrChecks`/
  // `fetchCommitChecks` (`github.ts`) already apply to their own per-chunk failures, for the
  // identical reason: a batched, best-effort read where losing one item's badge is expected and
  // cheap, unlike `/github`'s own list composition, which has a `reason` field to spend on it.
  for (const n of failedNumbers) checks[n] = null; // never cached — see the loop above
  return { available: true, checks };
}

export function createForgejoDriver(ctx: ForgejoDriverCtx, deps?: ForgejoHttpDeps): ForgeDriver {
  const { repoRoot, owner, repo, settings } = ctx;
  const http = createForgejoHttp(settings.apiUrl, deps);
  const webUrl = settings.webUrl;
  const sleep = deps?.sleep ?? defaultSleep;

  return {
    kind: 'forgejo',

    detect: () => detectForgejo(repoRoot, http, owner, repo),
    detectCached: () => detectForgejoCached(repoRoot, http, owner, repo),

    listIssues: (opts?: ForgeListOptions) => listForgejo('issues', repoRoot, http, owner, repo, webUrl, opts),
    listPRs: (opts?: ForgeListOptions) => listForgejo('prs', repoRoot, http, owner, repo, webUrl, opts),
    prStatus: (branch: string) => forgejoPrStatus(repoRoot, http, owner, repo, webUrl, branch),

    createPR: (input: DraftPrInput) => createForgejoPr(repoRoot, http, owner, repo, webUrl, input),

    prMergeState: (number: number, opts?: { refresh?: boolean }) =>
      forgejoPrMergeState(repoRoot, http, owner, repo, webUrl, number, opts, sleep),

    mergePR: (number: number, input: ForgeMergeInput) => forgejoMergePR(repoRoot, http, owner, repo, webUrl, number, input, sleep),

    prDiff: (number: number, opts?: { refresh?: boolean }) => forgejoPrDiff(repoRoot, http, owner, repo, number, opts),

    listComments: (kind: 'issue' | 'pr', number: number, opts?: { refresh?: boolean }) =>
      forgejoListComments(repoRoot, http, owner, repo, webUrl, kind, number, opts),

    listChecks: (numbers: number[]) => forgejoListChecks(repoRoot, http, owner, repo, numbers),

    viewUrl: (kind: ForgeRefKind, ref: string | number): string => forgejoViewUrl(webUrl, owner, repo, kind, ref),
  };
}
