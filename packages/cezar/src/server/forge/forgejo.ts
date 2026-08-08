import { createForgejoHttp, firstLine, ForgejoHttpError, type ForgejoHttp, type ForgejoHttpDeps } from './forgejo-http.ts';
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
 * CLI. This file ships the skeleton every later addition grows on: `kind`, `detect`/`detectCached`
 * (the two call sites that already exist, `server.ts:1511` health and `:3214`
 * automations-availability), `viewUrl`, `rebaseToWebUrl`, and a degraded stub for the remaining 7
 * `ForgeDriver` methods. A stub with no caller yet is expected shape here, not a defect: `github.ts`
 * itself implements every optional method even though several of its own call sites were wired up
 * separately, over time.
 */

export interface ForgejoDriverCtx {
  repoRoot: string;
  owner: string;
  repo: string;
  settings: ForgeSettings;
}

const CACHE_MS = 60_000;
const DETECT_CACHE_MAX = 50;

interface DetectCacheEntry {
  at: number;
  result: ForgeAvailability;
  /** Raw `Repository` body from the probe. Stored now, not yet read: a later change validates it
   *  through `forgejoRepositorySchema` and reads `default_branch`/merge-method flags from it
   *  instead of paying a second request. */
  repository: unknown | null;
}

/** Module-level, shared across every driver instance — same shape as `github.ts`'s caches: key
 *  carries `apiBase` (not just `repoRoot`), because two registered projects can point the same
 *  `repoRoot` concept at different Forgejo instances only in theory, but a stale cache surviving a
 *  config edit (apiUrl changed) is a real, observed failure mode worth keying against. */
const detectCache = new Map<string, DetectCacheEntry>();

function cacheKey(repoRoot: string, apiBase: string): string {
  return `${repoRoot}\0${apiBase}`;
}

function evictOldest(cache: Map<string, unknown>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Clears every cache this module owns. Grows as more caches are added alongside new methods
 *  (`listCache`/`prStatusCache`/`mergeStateCache`/`prDiffCache`) — tests call this in `beforeEach`
 *  so one test's warm cache can never leak into the next. */
export function __clearForgejoCachesForTests(): void {
  detectCache.clear();
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
  let repository: unknown | null = null;
  try {
    // Dynamic segments through encodeURIComponent even though owner/repo are gate-validated by
    // `parseRemote` upstream — defense in depth, and the same precedent this module's other path
    // builder (`forgejoViewUrl` below) follows for every dynamic segment.
    const body = await http.getJson(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      timeoutMs: 5_000,
    });
    repository = body;
    result = { available: true };
  } catch (err) {
    result = { available: false, reason: describeError(err) };
  }
  detectCache.set(key, { at: Date.now(), result, repository });
  evictOldest(detectCache, DETECT_CACHE_MAX);
  return result;
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

/**
 * `html_url` (and every other Forgejo-served link) points at whatever host issued the API
 * response — measured to differ from `apiUrl`'s host on a live instance (a docker-network hostname
 * like `forgejo:3000` vs. the browser-reachable `forge.example.com`). Take only path+query+hash
 * from it and rebase onto `webUrl`, the address a human's browser can actually reach.
 */
export function rebaseToWebUrl(htmlUrl: string, webUrl: string): string {
  const src = new URL(htmlUrl);
  const dst = new URL(webUrl);
  return `${dst.origin}${src.pathname}${src.search}${src.hash}`;
}

function forgejoViewUrl(webUrl: string, owner: string, repo: string, kind: ForgeRefKind, ref: string | number): string {
  const base = `${webUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  // Branch names may contain '/' — encode per segment, keep the slashes (mirrors github.ts:1867).
  const path = String(ref).split('/').map(encodeURIComponent).join('/');
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

export function createForgejoDriver(ctx: ForgejoDriverCtx, deps?: ForgejoHttpDeps): ForgeDriver {
  const { repoRoot, owner, repo, settings } = ctx;
  const http = createForgejoHttp(settings.apiUrl, deps);
  const webUrl = settings.webUrl;

  return {
    kind: 'forgejo',

    detect: () => detectForgejo(repoRoot, http, owner, repo),
    detectCached: () => detectForgejoCached(repoRoot, http, owner, repo),

    // Every method below is a degraded stub — real bodies land as follow-up changes, each with
    // its own tests. None of them call `http`, which is exactly what `forgejo.test.ts` pins down
    // (fetch is never invoked by any stub).
    listIssues: async (_opts?: ForgeListOptions): Promise<ForgeItem[]> => [],
    listPRs: async (_opts?: ForgeListOptions): Promise<ForgeItem[]> => [],
    prStatus: async (_branch: string): Promise<ForgePrStatus | null> => null,

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
