import { execFile } from 'node:child_process';
import { autosaveCommit } from '../../git-worktree.ts';
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
// `buildPrBody` is the one function this driver reuses FROM `github.ts` (explicitly sanctioned —
// see the module doc below): the PR body format (goal + progress skim + footer) has no
// forge-specific content, so re-deriving it here would just be a second copy to keep in sync.
import { buildPrBody } from './github.ts';
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
 * `listPRs`, `prStatus` and `createPR` are real; `prMergeState`, `mergePR` and `prDiff` remain
 * degraded stubs whose real bodies land as follow-up changes, each with its own tests. A stub with
 * no caller yet is expected shape here, not a defect: `github.ts` itself implements every optional
 * method even though several of its own call sites were wired up separately, over time.
 * `createPR` deliberately reuses two things straight from `github.ts` rather than re-deriving them:
 * `buildPrBody` (the PR body format has no forge-specific content) and, transitively through
 * `git-worktree.ts`, `autosaveCommit` (the pre-publish flush is identical git plumbing regardless
 * of which forge the branch is headed to). Neither import touches `github.ts`'s own driver logic.
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
 *  `getJson`/`getText`), so this is the createPR-local equivalent of `forgejo-http.ts`'s internal
 *  error-body reader — that one works off a raw `Response`, this one off the already-drained
 *  `{status, json, text}` shape `send` hands back, hence the small, deliberate duplication instead
 *  of a shared helper across the module boundary. */
function sendErrorMessage(res: { status: number; json: unknown; text: string }): string {
  if (res.json && typeof res.json === 'object' && 'message' in res.json) {
    const m = (res.json as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return firstLine(res.text) || `pull request creation failed (HTTP ${res.status})`;
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
    return { ok: true, url: `${webUrl}/${owner}/${repo}/pulls/777`, dryRun: true };
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

  const encOwner = encodeURIComponent(owner);
  const encRepo = encodeURIComponent(repo);

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

  const res = await http.send('POST', `repos/${encOwner}/${encRepo}/pulls`, { head: branch, base, title, body });

  if (res.status === 201) {
    const pull = forgejoPullSchema.parse(res.json);
    return { ok: true, url: rebaseToWebUrl(pull.html_url, webUrl), dryRun: false };
  }
  if (res.status === 409) {
    // "a PR from this head to this base already exists" — treat re-publishing as idempotent:
    // fetch the existing PR and hand its URL back instead of surfacing a conflict. Safe here
    // (unlike `prStatus`'s `/pulls/{base}/{head}` shortcut — pułapka 13) because this 409 came from
    // the exact head/base pair just POSTed, so there is no ambiguity about which PR it names.
    try {
      const raw = await http.getJson(`repos/${encOwner}/${encRepo}/pulls/${encodeRefSegments(base)}/${encodeRefSegments(branch)}`);
      const pull = forgejoPullSchema.parse(raw);
      return { ok: true, url: rebaseToWebUrl(pull.html_url, webUrl), dryRun: false };
    } catch (err) {
      return { ok: false, error: describeError(err) };
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
  return { ok: false, error: sendErrorMessage(res) };
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

    createPR: (input: DraftPrInput) => createForgejoPr(repoRoot, http, owner, repo, webUrl, input),

    // Every method below is still a degraded stub — real bodies land as follow-up changes, each
    // with its own tests. None of them call `http`, which is exactly what `forgejo.test.ts` pins
    // down (fetch is never invoked by any stub).
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
