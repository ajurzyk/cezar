import { execFile } from 'node:child_process';
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
  mapChangedFileStatus,
  mapForgejoIssue,
  mapForgejoPull,
  mergeMethodsFromRepository,
  normalizeForgejoMergeState,
  rebaseToWebUrl,
  type ForgejoBranchInfo,
  type ForgejoChangedFile,
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
  ForgeDriver,
  ForgeItem,
  ForgeListOptions,
  ForgeMergeInput,
  ForgeMergeResult,
  ForgePrChange,
  ForgePrDiffResult,
  ForgePrMergeStateResult,
  ForgePrStatus,
  ForgeRefKind,
  ForgeSettings,
} from './types.ts';

/**
 * The Forgejo forge driver (cockpit-ui redesign spec §"Forge-driver seam") — structurally mirrors
 * `github.ts`, but speaks REST directly through `forgejo-http.ts` instead of shelling out to a
 * CLI. Every method of `ForgeDriver` (`kind`, `detect`/`detectCached` — the two call sites that
 * already exist, `server.ts:1511` health and `:3214` automations-availability — `viewUrl`,
 * `listIssues`, `listPRs`, `prStatus`, `createPR`, `prMergeState`, `mergePR`,
 * `prDiff`) is real. Several of these have no production call site yet (`server.ts`'s list/diff
 * routes still call `fetchGithub*` directly, bypassing `resolveForge` — that seam lands in a
 * later stage): a fully-implemented method with no caller yet is expected shape here, not a
 * defect — `github.ts` itself implements every optional method even though several of its own
 * call sites were wired up separately, over time.
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
  data: ForgeItem[];
}

/** Keyed `repoRoot\0apiBase\0issues|prs` — same TTL/bound as `detectCache`, one entry per
 *  (project, list kind) pair. A cached fetch with a bigger `limit` than the current ask serves
 *  fine (it is a superset); `listForgejo` below re-slices to the caller's own `limit`. */
const listCache = new Map<string, ListCacheEntry>();
const LIST_CACHE_MAX = 50;

interface PrStatusCacheEntry {
  at: number;
  data: ForgePrStatus | null;
}

/** Keyed `repoRoot\0apiBase\0branch` — one entry per branch probed, so one worktree's PR status
 *  can never answer for a different branch in the same project. */
const prStatusCache = new Map<string, PrStatusCacheEntry>();
const PR_STATUS_CACHE_MAX = 50;

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

/** Every cache in this module keyed `repoRoot\0apiBase\0...` — the ONE list both
 *  `evictForgejoProjectCaches` (prefix-deletes per project after a merge) and
 *  `__clearForgejoCachesForTests` (full-clears everything between tests) iterate, so a future
 *  cache addition can't be silently missed from one of the two call sites the way `prDiffCache`
 *  itself once was. `detectCache` is deliberately NOT a member — see `evictForgejoProjectCaches`'s
 *  own doc comment for why a merge must never evict it (`__clearForgejoCachesForTests` still clears
 *  it separately, alongside the `mergeInflight` `Set`, which isn't keyed the same way either).
 *  `Map<string, unknown>[]` (not a bespoke interface): each cache below has a different entry value
 *  type, but `evictOldest` below already types its own parameter as `Map<string, unknown>` and every
 *  one of this module's five caches (these four, plus `detectCache`) is assignable to it as-is —
 *  TypeScript's structural typing has no variance fight to sidestep here. */
const PROJECT_CACHES: Map<string, unknown>[] = [listCache, prStatusCache, mergeStateCache, prDiffCache];

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

/**
 * `listIssues`/`listPRs` share this walk: paginate the matching endpoint up to the caller's
 * (capped) `limit`, map each row, drop rows the mapper rejects (`mapForgejoIssue` returns `null`
 * for the PR rows `/issues` also serves — never happens for `/pulls`, but sharing one function
 * keeps that filter written exactly once), and re-slice to `limit` since `paginate`'s own `want`
 * is a stop heuristic, not a hard cap (a full first page can overshoot a small `limit`).
 */
async function listForgejo(
  listKind: 'issues' | 'prs',
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  opts: ForgeListOptions | undefined,
): Promise<ForgeItem[]> {
  if (process.env.CEZ_DRY_RUN === '1') return [];
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), FJ_MAX_LIST_LIMIT);
  const key = listCacheKey(repoRoot, http.apiBase, listKind);
  if (!opts?.refresh) {
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS && hit.limit >= limit) return hit.data.slice(0, limit);
  }

  const repoPrefix = repoPath(owner, repo);
  // `/issues` on a live instance also returns PR rows (measured: 3/3 rows returned were PRs) —
  // `type=issues` filters most of them server-side; `mapForgejoIssue`'s own `pull_request` check
  // is the second, belt-and-braces layer for whatever slips through.
  const query = listKind === 'issues' ? 'state=open&type=issues' : 'state=open';
  const segment = listKind === 'issues' ? 'issues' : 'pulls';
  const mapRow: (raw: unknown, webUrl: string) => ForgeItem | null = listKind === 'issues' ? mapForgejoIssue : mapForgejoPull;

  try {
    const page = await http.paginate((p, l) => `${repoPrefix}/${segment}?${query}&page=${p}&limit=${l}`, { want: limit });
    const items: ForgeItem[] = [];
    for (const row of page.rows) {
      const item = mapRow(row, webUrl);
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
    listCache.set(key, { at: Date.now(), limit, data: items });
    evictOldest(listCache, LIST_CACHE_MAX);
    return items;
  } catch {
    // Never throw from a read — HTTP failure, timeout, or a malformed row that fails
    // `forgejoIssueSchema`/`forgejoPullSchema` all degrade to an empty list here.
    return [];
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
  // both paths hit the identical `commits/{sha}/status` endpoint and degrade to `null` on failure.
  // `combinedStatusToChecks` itself is a zod `.parse()` that `fetchForgejoCombinedStatus` does NOT
  // cover (that function only try/catches the GET) — a malformed-but-syntactically-valid body must
  // degrade `checks` alone to `null`, not throw past this function and blank the whole `ForgePrStatus`
  // the caller already has (number/url/state/isDraft), so the parse is try/caught right here.
  let checks: ForgePrStatus['checks'] = null;
  if (pull.head?.sha) {
    const raw = await fetchForgejoCombinedStatus(http, owner, repo, pull.head.sha);
    try {
      checks = raw == null ? null : combinedStatusToChecks(raw);
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
 * the state=all walk exists to avoid. Two residual gaps, both accepted as known limitations:
 * (a) a PR merged into a NON-default base with a deleted branch still returns `null` (the fallback
 * only tries the repo's `default_branch` as `base`); (b) with two terminal (closed/merged) PRs
 * sharing the same head, the fallback endpoint picks an arbitrary one, so `merged` vs `closed`
 * might describe the wrong one of the two.
 */
async function resolveForgejoPrStatus(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  branch: string,
): Promise<ForgePrStatus | null> {
  const repoPrefix = repoPath(owner, repo);

  let page: ForgejoPage;
  try {
    page = await http.paginate((p, l) => `${repoPrefix}/pulls?state=all&page=${p}&limit=${l}`, {
      want: FJ_MAX_LIST_LIMIT,
    });
  } catch {
    // Page 1 is the only page `paginate` can fail on without having collected anything (a later
    // page's failure keeps what was gathered and marks `stoppedShort`, see forgejo-http.ts) — either
    // way there is nothing here proving completeness, so the fallback below must not run.
    return null;
  }

  let openMatch: ForgejoPull | null = null;
  let anyMatch: ForgejoPull | null = null;
  for (const row of page.rows) {
    let parsed: ForgejoPull;
    try {
      parsed = forgejoPullSchema.parse(row);
    } catch {
      continue; // a malformed row must not abort the whole walk
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
    try {
      return await pullRowToStatus(http, owner, repo, webUrl, found);
    } catch {
      return null;
    }
  }
  if (page.stoppedShort) return null; // walk unproven — the fallback could shadow an open PR

  const base = await resolveDefaultBranch(repoRoot, http, owner, repo);
  if (!base) return null;
  try {
    const raw = await http.getJson(`${repoPrefix}/pulls/${encodeRefSegments(base)}/${encodeRefSegments(branch)}`);
    // `await` here is load-bearing: without it, this `try` returns the pending promise itself and
    // resolves/rejects OUTSIDE this frame, so a `pullRowToStatus` rejection (a non-absolute
    // `html_url`, see the comment above) skips this `catch` entirely instead of degrading to `null`.
    return await pullRowToStatus(http, owner, repo, webUrl, forgejoPullSchema.parse(raw));
  } catch {
    return null;
  }
}

async function forgejoPrStatus(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
  webUrl: string,
  branch: string,
): Promise<ForgePrStatus | null> {
  if (process.env.CEZ_DRY_RUN === '1') return null;
  const key = prStatusCacheKey(repoRoot, http.apiBase, branch);
  const hit = prStatusCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await resolveForgejoPrStatus(repoRoot, http, owner, repo, webUrl, branch);
  prStatusCache.set(key, { at: Date.now(), data });
  evictOldest(prStatusCache, PR_STATUS_CACHE_MAX);
  return data;
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

/** `GET /repos/{o}/{r}/commits/{sha}/status` — `null` on ANY failure (never thrown further), which
 *  `normalizeForgejoMergeState`/`combinedStatusToPrChecks` already treat identically to "no CI
 *  configured" (an empty `checks[]`, not a blocker). A CI probe that failed to answer must degrade
 *  the same way as a repo that has no CI at all — neither should ever fail the whole merge-state
 *  read the way `GET /pulls/{n}` failing does. */
async function fetchForgejoCombinedStatus(http: ForgejoHttp, owner: string, repo: string, sha: string): Promise<unknown | null> {
  try {
    return await http.getJson(`${repoPath(owner, repo)}/commits/${encodeRefSegments(sha)}/status`);
  } catch {
    return null;
  }
}

/** Walks `GET /pulls/{n}/reviews`, capped the same way every other list walk in this driver is
 *  (`FJ_MAX_LIST_LIMIT`, parity with `GH_MAX_LIMIT`). Degrades to `[]` on any failure — an unreadable
 *  review list must not fail the whole merge-state read; `computeReviewDecision([], ...)` already
 *  produces a safe `'unknown'`/`'review-required'` answer for an empty list, never a false approval. */
async function fetchForgejoReviews(http: ForgejoHttp, owner: string, repo: string, number: number): Promise<unknown[]> {
  const repoPrefix = repoPath(owner, repo);
  try {
    const page = await http.paginate((p, l) => `${repoPrefix}/pulls/${number}/reviews?page=${p}&limit=${l}`, {
      want: FJ_MAX_LIST_LIMIT,
    });
    return page.rows;
  } catch {
    return [];
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

const DRY_RUN_MERGE_STATE_FIXTURE = {
  pullRaw: {
    number: 777,
    title: 'Dry-run pull request',
    html_url: 'http://forgejo:3000/mock/repo/pulls/777',
    created_at: '2026-01-01T00:00:00Z',
    draft: false,
    additions: 1,
    deletions: 1,
    state: 'open',
    merged: false,
    mergeable: true,
    head: { ref: 'feat/dry-run', sha: '0'.repeat(40) },
    base: { ref: 'main' },
  },
  statusRaw: { statuses: [{ status: 'success', context: 'ci/build' }] },
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
      mergeState: normalizeForgejoMergeState({ ...DRY_RUN_MERGE_STATE_FIXTURE, webUrl, hasToken: http.hasToken() }),
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

    const [statusRaw, branch, reviewsRaw, repository] = await Promise.all([
      pull.head?.sha ? fetchForgejoCombinedStatus(http, owner, repo, pull.head.sha) : Promise.resolve(null),
      pull.base?.ref ? fetchForgejoBranchInfo(http, owner, repo, pull.base.ref) : Promise.resolve<ForgejoBranchInfo>({ readable: false }),
      fetchForgejoReviews(http, owner, repo, number),
      resolveRepository(repoRoot, http, owner, repo),
    ]);

    const mergeState = normalizeForgejoMergeState({
      pullRaw,
      statusRaw,
      branch,
      repository,
      webUrl,
      hasToken: http.hasToken(),
      reviewsRaw,
    });
    const value: ForgePrMergeStateResult = { available: true, mergeState };
    mergeStateCache.set(key, { at: Date.now(), value });
    evictOldest(mergeStateCache, MERGE_STATE_CACHE_MAX);
    return value;
  } catch (err) {
    // `GET pulls/{n}` failing (404 — bad PR number, network, timeout) is the one failure this
    // method cannot degrade past: without the PR body there is no `ForgePrMergeState` to build.
    // Every OTHER read above (status/branch/reviews/repository) already degrades to its own safe
    // default instead of throwing, exactly so a CI hiccup can never take down the whole method.
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
  // display in `mapForgejoPull`.
  const title = `WIP: ${run.title}`;

  const res = await http.send('POST', `${repoPrefix}/pulls`, { head: branch, base, title, body });

  if (res.status === 201) {
    // The PR was genuinely created server-side by the time we get here — a malformed response body
    // (fails `forgejoPullSchema`) or a non-absolute `html_url` (`rebaseToWebUrl` throws a
    // `TypeError`) must not turn a real success into an unhandled throw; it degrades to a
    // best-effort success without a clickable link instead, same reasoning as `mergePR`'s own
    // best-effort `mergeCommitSha` read-back.
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
      if (pull.state === 'open') return { ok: true, url: rebaseToWebUrl(pull.html_url, webUrl), dryRun: false };
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

/** Clears every cache entry that belongs to one project (`repoRoot`+`apiBase` pair) after a
 *  successful merge — a merge changes list membership (the merged PR should stop showing as open
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
 *  `CEZ_DRY_RUN=1` short-circuit below; `number`/`headSha` are overwritten per-call by the caller
 *  (dry-run still echoes back whatever PR number was asked for), everything else is fixed. */
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

    const rowsCapped = rows.slice(0, FJ_PR_DIFF_FILE_CAP);
    // `rows.length` (not `filesPage.stoppedShort`) mirrors `fetchGithubPrDiff` exactly: a full cap
    // worth of rows is conservatively called partial even though the walk itself might, in
    // principle, have landed exactly on the true total.
    let responseTruncated = rows.length >= FJ_PR_DIFF_FILE_CAP;
    const reasons: string[] = responseTruncated ? [`Only the first ${FJ_PR_DIFF_FILE_CAP} files are shown.`] : [];

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

    viewUrl: (kind: ForgeRefKind, ref: string | number): string => forgejoViewUrl(webUrl, owner, repo, kind, ref),
  };
}
