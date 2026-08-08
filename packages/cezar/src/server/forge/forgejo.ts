import {
  createForgejoHttp,
  firstLine,
  FJ_LIST_MAX_PAGES,
  FJ_PAGE_LIMIT,
  ForgejoHttpError,
  type ForgejoHttp,
  type ForgejoHttpDeps,
  type ForgejoPage,
} from './forgejo-http.ts';
import {
  combinedStatusToChecks,
  forgejoPullSchema,
  forgejoRepositorySchema,
  mapForgejoIssue,
  mapForgejoPull,
  rebaseToWebUrl,
  type ForgejoPull,
  type ForgejoRepository,
} from './forgejo-map.ts';
import type {
  DraftPrInput,
  DraftPrOutcome,
  ForgeAvailability,
  ForgeDriver,
  ForgeItem,
  ForgeListOptions,
  ForgeMergeInput,
  ForgeMergeResult,
  ForgePrDiffResult,
  ForgePrMergeStateResult,
  ForgePrStatus,
  ForgeRefKind,
  ForgeSettings,
} from './types.ts';

/**
 * The Forgejo forge driver (cockpit-ui redesign spec §"Forge-driver seam") — structurally mirrors
 * `github.ts`, but speaks REST directly through `forgejo-http.ts` instead of shelling out to a
 * CLI. `kind`, `detect`/`detectCached` (the two call sites that already exist, `server.ts:1511`
 * health and `:3214` automations-availability), `viewUrl`, `rebaseToWebUrl`, `listIssues`,
 * `listPRs` and `prStatus` are real; `createPR`, `prMergeState`, `mergePR` and `prDiff` remain
 * degraded stubs whose real bodies land as follow-up changes, each with its own tests. A stub with
 * no caller yet is expected shape here, not a defect: `github.ts` itself implements every optional
 * method even though several of its own call sites were wired up separately, over time.
 */

export interface ForgejoDriverCtx {
  repoRoot: string;
  owner: string;
  repo: string;
  settings: ForgeSettings;
}

const CACHE_MS = 60_000;
const DETECT_CACHE_MAX = 50;

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

function cacheKey(repoRoot: string, apiBase: string): string {
  return `${repoRoot}\0${apiBase}`;
}

function listCacheKey(repoRoot: string, apiBase: string, listKind: 'issues' | 'prs'): string {
  return `${repoRoot}\0${apiBase}\0${listKind}`;
}

function prStatusCacheKey(repoRoot: string, apiBase: string, branch: string): string {
  return `${repoRoot}\0${apiBase}\0${branch}`;
}

function evictOldest(cache: Map<string, unknown>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Clears every cache this module owns. Grows as more caches are added alongside new methods
 *  (`mergeStateCache`/`prDiffCache`) — tests call this in `beforeEach` so one test's warm cache
 *  can never leak into the next. */
export function __clearForgejoCachesForTests(): void {
  detectCache.clear();
  listCache.clear();
  prStatusCache.clear();
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
    // Dynamic segments through encodeURIComponent even though owner/repo are gate-validated by
    // `parseRemote` upstream — defense in depth, and the same precedent this module's other path
    // builder (`forgejoViewUrl` below) follows for every dynamic segment.
    const body = await http.getJson(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      timeoutMs: 5_000,
    });
    repository = forgejoRepositorySchema.parse(body);
    result = { available: true };
  } catch (err) {
    result = { available: false, reason: describeError(err) };
  }
  detectCache.set(key, { at: Date.now(), result, repository });
  evictOldest(detectCache, DETECT_CACHE_MAX);
  return result;
}

/** `Repository.default_branch`, read from the warm `detectCache` entry when one exists (avoids a
 *  second request) and falling back to one fresh `GET repos/{owner}/{repo}` when the cache is
 *  cold. Used only by `prStatus`'s `/pulls/{base}/{head}` fallback, which needs `base` before it
 *  can even build the request path. */
async function resolveDefaultBranch(
  repoRoot: string,
  http: ForgejoHttp,
  owner: string,
  repo: string,
): Promise<string | null> {
  const hit = detectCache.get(cacheKey(repoRoot, http.apiBase));
  if (hit?.repository) return hit.repository.default_branch;
  try {
    const raw = await http.getJson(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return forgejoRepositorySchema.parse(raw).default_branch;
  } catch {
    return null;
  }
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

/** Re-exported: `forgejo-map.ts` now owns the implementation (both its mappers call it directly,
 *  and `forgejo-map.ts` must stay a leaf module — importing it FROM `forgejo.ts`, rather than the
 *  reverse, avoids a `forgejo.ts` <-> `forgejo-map.ts` import cycle). Kept as a re-export, not just
 *  an internal import, because existing callers/tests import it from this module. */
export { rebaseToWebUrl };

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

  const encOwner = encodeURIComponent(owner);
  const encRepo = encodeURIComponent(repo);
  // `/issues` on a live instance also returns PR rows (measured: 3/3 rows returned were PRs) —
  // `type=issues` filters most of them server-side; `mapForgejoIssue`'s own `pull_request` check
  // is the second, belt-and-braces layer for whatever slips through.
  const query = listKind === 'issues' ? 'state=open&type=issues' : 'state=open';
  const segment = listKind === 'issues' ? 'issues' : 'pulls';
  const mapRow: (raw: unknown, webUrl: string) => ForgeItem | null = listKind === 'issues' ? mapForgejoIssue : mapForgejoPull;

  try {
    const page = await http.paginate(
      (p, l) => `repos/${encOwner}/${encRepo}/${segment}?${query}&page=${p}&limit=${l}`,
      { want: limit },
    );
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
  let checks: ForgePrStatus['checks'] = null;
  if (pull.head?.sha) {
    try {
      const raw = await http.getJson(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeRefSegments(pull.head.sha)}/status`,
      );
      checks = combinedStatusToChecks(raw);
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
  const encOwner = encodeURIComponent(owner);
  const encRepo = encodeURIComponent(repo);

  let page: ForgejoPage;
  try {
    page = await http.paginate((p, l) => `repos/${encOwner}/${encRepo}/pulls?state=all&page=${p}&limit=${l}`, {
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
  if (found) return pullRowToStatus(http, owner, repo, webUrl, found);
  if (page.stoppedShort) return null; // walk unproven — the fallback could shadow an open PR

  const base = await resolveDefaultBranch(repoRoot, http, owner, repo);
  if (!base) return null;
  try {
    const raw = await http.getJson(`repos/${encOwner}/${encRepo}/pulls/${encodeRefSegments(base)}/${encodeRefSegments(branch)}`);
    return pullRowToStatus(http, owner, repo, webUrl, forgejoPullSchema.parse(raw));
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

export function createForgejoDriver(ctx: ForgejoDriverCtx, deps?: ForgejoHttpDeps): ForgeDriver {
  const { repoRoot, owner, repo, settings } = ctx;
  const http = createForgejoHttp(settings.apiUrl, deps);
  const webUrl = settings.webUrl;

  return {
    kind: 'forgejo',

    detect: () => detectForgejo(repoRoot, http, owner, repo),
    detectCached: () => detectForgejoCached(repoRoot, http, owner, repo),

    listIssues: (opts?: ForgeListOptions) => listForgejo('issues', repoRoot, http, owner, repo, webUrl, opts),
    listPRs: (opts?: ForgeListOptions) => listForgejo('prs', repoRoot, http, owner, repo, webUrl, opts),
    prStatus: (branch: string) => forgejoPrStatus(repoRoot, http, owner, repo, webUrl, branch),

    // Every method below is a degraded stub — real bodies land as follow-up changes, each with
    // its own tests. None of them call `http`, which is exactly what `forgejo.test.ts` pins down
    // (fetch is never invoked by any stub).
    createPR: async (_input: DraftPrInput): Promise<DraftPrOutcome> => ({
      ok: false,
      error: 'Forgejo pull-request creation is not implemented yet.',
    }),

    prMergeState: async (_number: number, _opts?: { refresh?: boolean }): Promise<ForgePrMergeStateResult> => ({
      available: false,
      reason: 'Forgejo merge-state reporting is not implemented yet.',
    }),

    mergePR: async (_number: number, _input: ForgeMergeInput): Promise<ForgeMergeResult> => ({
      merged: false,
      status: 502,
      error: 'Forgejo merging is not implemented yet.',
    }),

    prDiff: async (_number: number, _opts?: { refresh?: boolean }): Promise<ForgePrDiffResult> => ({
      available: false,
      reason: 'Forgejo PR diffs are not implemented yet.',
    }),

    viewUrl: (kind: ForgeRefKind, ref: string | number): string => forgejoViewUrl(webUrl, owner, repo, kind, ref),
  };
}
