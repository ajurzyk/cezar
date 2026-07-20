import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { autosaveCommit } from '../../git-worktree.js';
import type {
  DraftPrInput,
  DraftPrOutcome,
  ForgeAvailability,
  ForgeComment,
  ForgeCommentsData,
  ForgeDriver,
  ForgeItem,
  ForgePrStatus,
  ForgeRefKind,
} from './types.js';

/**
 * The GitHub forge driver — all `gh`-CLI logic in one place, moved here from
 * `src/server/github.ts` (tab listing) and `src/server/pr.ts` (draft PRs)
 * behind the `ForgeDriver` seam. Those modules remain as thin delegates.
 * `/api/github`'s response shape is this driver's serialization and is
 * protected by BACKWARD_COMPATIBILITY.md — additive changes only.
 */

const exec = promisify(execFile);

/** One GitHub issue or pull request, flattened for the cockpit's GitHub tab. */
export type GithubItem = ForgeItem;

export interface GithubData {
  available: boolean;
  /** Human-readable hint when unavailable (`gh` missing, no remote, offline…). */
  reason?: string;
  /** owner/name, when known. */
  repo?: string;
  syncedAt?: string;
  issues: GithubItem[];
  prs: GithubItem[];
  /** Repo-wide map of label name → 6-hex color (no `#`), so the UI can tint chips like GitHub
   *  does. Additive (BACKWARD_COMPATIBILITY): absent on old payloads, chips fall back to neutral. */
  labelColors?: Record<string, string>;
}

// `gh … --json` output — validated at the boundary, extras stripped.
const ghAuthor = z.object({ login: z.string() }).nullish();
// `color` is the 6-hex GitHub label color (no `#`), '' when gh omits it.
const ghLabel = z.object({ name: z.string(), color: z.string().default('') });
const ghIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: ghAuthor,
  createdAt: z.string(),
  labels: z.array(ghLabel).default([]),
  body: z.string().nullish(),
  url: z.string(),
});
// One check run's `gh --json statusCheckRollup` entry — every field optional/nullish because
// gh's shape varies by check provider (exported so #400's unit tests can build fixtures).
export const ghCheckRunSchema = z.object({
  state: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
});
const ghStatusCheckRollup = z.array(ghCheckRunSchema).nullish();

const ghPrSchema = ghIssueSchema.extend({
  isDraft: z.boolean().default(false),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  statusCheckRollup: ghStatusCheckRollup,
});
const ghPrViewSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string().default('OPEN'),
  isDraft: z.boolean().default(false),
  statusCheckRollup: ghStatusCheckRollup,
});

/** Exported for unit tests (#400) — collapses a zod-validated `statusCheckRollup` array down to
 *  the single enum the GitHub tab (list rows + detail badge) renders. */
export function rollupToChecks(rollup: z.infer<typeof ghStatusCheckRollup>): GithubItem['checks'] {
  if (!rollup || rollup.length === 0) return null;
  const states = rollup.map((r) => (r.conclusion || r.state || r.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'failing';
  if (states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', ''].includes(s))) return 'pending';
  return 'passing';
}

async function gh(repoRoot: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await exec('gh', args, {
    cwd: repoRoot,
    timeout,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

// ---- comment counts (#499 Phase 1) -----------------------------------------
// `gh … --json comments` is off the table for the list calls — it ships every
// comment body for every row (the reason `comments` was hard-coded to 0). Real
// counts come from one lightweight GraphQL query per kind returning only
// `number → totalCount`, run in parallel with the list calls. This whole seam
// degrades to empty maps on any failure, so the tab renders exactly as before
// when the counts call fails (plan rule: counts never break the tab).

/** Runs a GraphQL query with String variables — injected so pagination is unit-testable
 *  without shelling to `gh`. */
export type GraphqlRunner = (query: string, variables: Record<string, string>) => Promise<string>;

/** GraphQL's max page size; pagination is capped at 10 pages/kind (1000 rows — the GUI's full
 *  background shot). Rows past the window keep `comments: 0`, which the UI reads as "no badge". */
export const GH_COUNTS_MAX_PAGES = 10;

const countsQuery = (root: 'issues' | 'pullRequests'): string => `
query ($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    ${root}(first: 100, after: $endCursor, states: OPEN,
           orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number comments { totalCount } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ghCountsPageSchema = z.object({
  nodes: z.array(z.object({ number: z.number(), comments: z.object({ totalCount: z.number() }) })),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
});

/** Validate + flatten one gh GraphQL counts response into a `number → count` map plus the page
 *  cursor. Exported for unit tests (the zod boundary + shape). Throws on a malformed envelope. */
export function parseCountsPage(
  out: string,
  root: 'issues' | 'pullRequests',
): { counts: Record<number, number>; hasNextPage: boolean; endCursor: string | null } {
  const parsed = JSON.parse(out) as { data?: { repository?: Record<string, unknown> | null } };
  const page = ghCountsPageSchema.parse(parsed?.data?.repository?.[root]);
  const counts: Record<number, number> = {};
  for (const node of page.nodes) counts[node.number] = node.comments.totalCount;
  return { counts, hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor ?? null };
}

async function paginateCounts(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  root: 'issues' | 'pullRequests',
  maxPages: number,
): Promise<Record<number, number>> {
  const counts: Record<number, number> = {};
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const variables: Record<string, string> = { owner, name };
    if (cursor) variables.endCursor = cursor;
    const res = parseCountsPage(await runGraphql(countsQuery(root), variables), root);
    Object.assign(counts, res.counts);
    if (!res.hasNextPage || !res.endCursor) break;
    cursor = res.endCursor;
  }
  return counts;
}

/** Comment counts for open issues and PRs as `number → count` maps. Two independent paginated
 *  queries (issues and PRs need separate cursors) run in parallel; any failure degrades the whole
 *  thing to empty maps so the tab is never held up by counts. Exported for unit tests. */
export async function fetchCommentCounts(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  maxPages = GH_COUNTS_MAX_PAGES,
): Promise<{ issues: Record<number, number>; prs: Record<number, number> }> {
  try {
    const [issues, prs] = await Promise.all([
      paginateCounts(runGraphql, owner, name, 'issues', maxPages),
      paginateCounts(runGraphql, owner, name, 'pullRequests', maxPages),
    ]);
    return { issues, prs };
  } catch {
    return { issues: {}, prs: {} };
  }
}

/** `owner/name` → `{ owner, name }`, or null when the handle isn't a clean two-part slug. */
export function parseOwnerName(nameWithOwner: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = nameWithOwner.trim().split('/');
  return owner && name && rest.length === 0 ? { owner, name } : null;
}

/* Reads degrade to `available: false` with a hint — never an error (plan rule
   7): no `gh`, no remote, offline all land on the same quiet path. A short
   cache keeps tab switches from hammering the GitHub API; a cached fetch with
   a bigger limit than asked serves fine (it's a superset). Keyed by `repoRoot`
   (multi-project workspace, step 2.6): one project's — possibly private —
   issues/PRs must never be served under another project's scope. Bounded like
   `commentsCache` so an unbounded workspace can't grow it without limit. */
const listCache = new Map<string, { at: number; limit: number; data: GithubData }>();
const LIST_CACHE_MAX = 50;
const CACHE_MS = 60_000;
export const GH_MAX_LIMIT = 1000;

export async function fetchGithub(repoRoot: string, refresh = false, limit = 30): Promise<GithubData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithub();
  const capped = Math.min(Math.max(limit, 1), GH_MAX_LIMIT);
  const hit = listCache.get(repoRoot);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS && hit.limit >= capped) {
    return hit.data;
  }
  try {
    // No `comments` field — `gh … --json comments` ships full comment bodies.
    // Big fetches (the GUI's follow-up "give me everything" shot) get a
    // longer wall clock — statusCheckRollup on hundreds of PRs is slow.
    const timeout = capped > 100 ? 60_000 : 15_000;
    const fields = 'number,title,author,createdAt,labels,body,url';
    // The repo handle first (cheap) so the counts GraphQL query — which needs owner/name —
    // can run parallel to the two expensive list calls below.
    const repoOut = await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], timeout);
    const ownerName = parseOwnerName(repoOut);
    const runGraphql: GraphqlRunner = (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
      return gh(repoRoot, args, timeout);
    };
    // Bound the counts pagination to the rows actually being fetched: a page is 100, so
    // `ceil(capped / 100)` pages (still capped at GH_COUNTS_MAX_PAGES) cover exactly the visible
    // window and no more — the default 30-item load pays ONE counts round-trip, not ten. Rows
    // beyond the window keep `comments: 0`, which the UI reads as "no badge" (same as before).
    const countsMaxPages = Math.min(GH_COUNTS_MAX_PAGES, Math.max(1, Math.ceil(capped / 100)));
    const [issuesOut, prsOut, counts] = await Promise.all([
      gh(repoRoot, ['issue', 'list', '--limit', String(capped), '--json', fields], timeout),
      gh(repoRoot, ['pr', 'list', '--limit', String(capped), '--json', `${fields},isDraft,additions,deletions,statusCheckRollup`], timeout),
      // Real comment counts (#499). Degrades to empty maps on its own — a failure here leaves
      // every count at 0, never fails the tab. Skipped entirely if the handle isn't parseable.
      ownerName
        ? fetchCommentCounts(runGraphql, ownerName.owner, ownerName.name, countsMaxPages)
        : Promise.resolve<{ issues: Record<number, number>; prs: Record<number, number> }>({ issues: {}, prs: {} }),
    ]);
    // One repo-wide label→color map, filled as we flatten each item's labels.
    const labelColors: Record<string, string> = {};
    const recordColor = (l: { name: string; color: string }) => {
      if (l.color && !labelColors[l.name]) labelColors[l.name] = l.color;
    };
    const issues = z.array(ghIssueSchema).parse(JSON.parse(issuesOut)).map(
      (i): GithubItem => {
        i.labels.forEach(recordColor);
        return {
          kind: 'issue',
          number: i.number,
          title: i.title,
          author: i.author?.login ?? '?',
          createdAt: i.createdAt,
          labels: i.labels.map((l) => l.name),
          body: (i.body ?? '').slice(0, 8_000),
          url: i.url,
          comments: counts.issues[i.number] ?? 0,
        };
      },
    );
    const prs = z.array(ghPrSchema).parse(JSON.parse(prsOut)).map(
      (p): GithubItem => {
        p.labels.forEach(recordColor);
        return {
          kind: 'pr',
          number: p.number,
          title: p.title,
          author: p.author?.login ?? '?',
          createdAt: p.createdAt,
          labels: [...p.labels.map((l) => l.name), ...(p.isDraft ? ['draft'] : [])],
          body: (p.body ?? '').slice(0, 8_000),
          url: p.url,
          comments: counts.prs[p.number] ?? 0,
          isDraft: p.isDraft,
          additions: p.additions,
          deletions: p.deletions,
          checks: rollupToChecks(p.statusCheckRollup),
        };
      },
    );
    const data: GithubData = {
      available: true,
      repo: repoOut.trim() || undefined,
      syncedAt: new Date().toISOString(),
      issues,
      prs,
      labelColors,
    };
    listCache.delete(repoRoot); // re-insert so this key becomes the newest
    listCache.set(repoRoot, { at: Date.now(), limit: capped, data });
    while (listCache.size > LIST_CACHE_MAX) {
      const oldest = listCache.keys().next().value;
      if (oldest === undefined) break;
      listCache.delete(oldest);
    }
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /ENOENT/.test(message)
      ? 'gh CLI not found — install it and run `gh auth login`'
      : firstLine(message);
    return { available: false, reason, issues: [], prs: [] };
  }
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'gh failed';
}

/** CEZ_DRY_RUN=1 — a small fixed catalog so the GitHub tab is demoable offline. */
function mockGithub(): GithubData {
  const mk = (over: Partial<GithubItem> & Pick<GithubItem, 'kind' | 'number' | 'title' | 'body'>): GithubItem => ({
    author: 'mock',
    createdAt: new Date(Date.now() - over.number * 3_600_000).toISOString(),
    labels: [],
    url: `https://github.com/mock/repo/${over.kind === 'pr' ? 'pull' : 'issues'}/${over.number}`,
    comments: 0,
    ...over,
  });
  return {
    available: true,
    repo: 'mock/repo',
    syncedAt: new Date().toISOString(),
    issues: [
      mk({ kind: 'issue', number: 142, title: 'Login form drops session on refresh', labels: ['bug', 'auth'], comments: 3, body: 'Repro: log in, hit reload — you land back on /login. The session cookie is set correctly, but the client store rehydrates before the cookie check resolves, so the auth guard redirects.' }),
      mk({ kind: 'issue', number: 139, title: 'Add --json flag to cez CLI output', labels: ['enhancement', 'cli'], comments: 1, body: 'For scripting it would help if `cez list` and `cez status` could emit machine-readable JSON instead of the table view.' }),
      mk({ kind: 'issue', number: 135, title: 'Flaky e2e: worktree cleanup race on cancel', labels: ['bug', 'flaky-test'], comments: 6, body: 'Cancelling a run while the agent holds a file lock leaves a dangling worktree. The next run on the same branch then fails with "worktree already exists".' }),
    ],
    prs: [
      mk({ kind: 'pr', number: 128, title: 'Fix flaky auth test in CI', labels: ['tests'], checks: 'passing', additions: 6, deletions: 3, body: 'Loosens the timing assertion in refresh.test.ts to a realistic budget.' }),
      mk({ kind: 'pr', number: 124, title: 'Rate limit /api/runs', labels: ['server', 'draft'], isDraft: true, checks: 'failing', additions: 118, deletions: 7, comments: 4, body: 'Draft: token-bucket middleware on the runs router. Still needs the config surface and README docs before review.' }),
    ],
    labelColors: {
      bug: 'd73a4a',
      auth: '5319e7',
      enhancement: 'a2eeef',
      cli: '0e8a16',
      'flaky-test': 'fbca04',
      tests: 'c5def5',
      server: '1d76db',
      draft: '6a737d',
    },
  };
}

// ---- comment threads (#499 Phase 2) ----------------------------------------
// A lazy per-thread fetch behind `GET /api/github/comments/:kind/:number`: the
// conversation comments (issues endpoint — GitHub serves PR conversation
// comments there too), plus submitted reviews for PRs, normalized into one
// chronological `ForgeComment[]`. Its own bounded 60 s cache keeps an open
// detail view from re-fetching on every focus. Degrades to `available: false`
// exactly like the list fetch — never a 5xx.

const ghCommentUser = z.object({ login: z.string(), avatar_url: z.string().nullish() }).nullish();
const ghIssueCommentSchema = z.object({
  id: z.number(),
  user: ghCommentUser,
  created_at: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
});
const ghReviewSchema = z.object({
  id: z.number(),
  user: ghCommentUser,
  body: z.string().nullish(),
  state: z.string(),
  submitted_at: z.string().nullish(),
  html_url: z.string(),
});

const REVIEW_STATE: Record<string, ForgeComment['reviewState']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** First 200 thread entries, then `truncated`; each body sliced to 8 000 chars (same cap as
 *  item bodies). */
export const THREAD_ENTRY_CAP = 200;
const COMMENT_BODY_CAP = 8_000;

/** `gh api …/issues/{n}/comments` JSON → `ForgeComment[]`. Exported for unit tests. */
export function normalizeComments(raw: unknown): ForgeComment[] {
  return z.array(ghIssueCommentSchema).parse(raw).map((c) => ({
    id: c.id,
    author: c.user?.login ?? '?',
    avatarUrl: c.user?.avatar_url ?? undefined,
    createdAt: c.created_at,
    body: (c.body ?? '').slice(0, COMMENT_BODY_CAP),
    kind: 'comment' as const,
    url: c.html_url,
  }));
}

/** `gh api …/pulls/{n}/reviews` JSON → `ForgeComment[]`. Reviews with an empty body AND state
 *  COMMENTED/PENDING carry no signal in a flat thread and are dropped; the rest map to
 *  `kind: 'review'` (Q4). Exported for unit tests. */
export function normalizeReviews(raw: unknown): ForgeComment[] {
  return z
    .array(ghReviewSchema)
    .parse(raw)
    .filter((r) => {
      const state = r.state.toUpperCase();
      const emptyBody = (r.body ?? '').trim().length === 0;
      return !(emptyBody && (state === 'COMMENTED' || state === 'PENDING'));
    })
    .map((r) => ({
      id: r.id,
      author: r.user?.login ?? '?',
      avatarUrl: r.user?.avatar_url ?? undefined,
      createdAt: r.submitted_at ?? '',
      body: (r.body ?? '').slice(0, COMMENT_BODY_CAP),
      kind: 'review' as const,
      reviewState: REVIEW_STATE[r.state.toUpperCase()],
      url: r.html_url,
    }));
}

/** Merge comment/review lists chronologically (oldest first) and apply the entry cap. Exported
 *  for unit tests. */
export function mergeThread(
  parts: ForgeComment[][],
  cap = THREAD_ENTRY_CAP,
): { comments: ForgeComment[]; truncated: boolean } {
  const all = parts.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const truncated = all.length > cap;
  return { comments: truncated ? all.slice(0, cap) : all, truncated };
}

// Per-thread cache: keyed `repoRoot␀kind#number` (the root scopes the key — two projects each
// having a PR #42 must not collide; step 2.6), same 60 s TTL as the list cache but BOUNDED — a
// long browsing session can't grow it without limit (Map preserves insertion order → oldest
// first).
const commentsCache = new Map<string, { at: number; data: ForgeCommentsData }>();
const COMMENTS_CACHE_MAX = 50;

function cacheComments(key: string, data: ForgeCommentsData): void {
  commentsCache.delete(key); // re-insert so this key becomes the newest
  commentsCache.set(key, { at: Date.now(), data });
  while (commentsCache.size > COMMENTS_CACHE_MAX) {
    const oldest = commentsCache.keys().next().value;
    if (oldest === undefined) break;
    commentsCache.delete(oldest);
  }
}

/** Test-only: drop the per-thread cache so cases don't leak state into each other. */
export function __clearCommentsCacheForTests(): void {
  commentsCache.clear();
}

/**
 * The conversation thread for one issue/PR, lazily. `{owner}`/`{repo}` in the gh api paths are
 * filled from the worktree's remote by gh itself, so no extra handle lookup. Everything degrades:
 * gh missing/offline → `{ available: false, reason }`, a 404 → a "not found" hint — never a throw.
 */
export async function fetchGithubComments(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  refresh = false,
): Promise<ForgeCommentsData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithubComments(kind);
  // NUL separator: cannot appear in a filesystem path, so roots can never alias.
  const key = `${repoRoot}\0${kind}#${number}`;
  const hit = commentsCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    // PR conversation comments live on the issues endpoint too — always use it for the body thread.
    const commentsOut = await gh(repoRoot, ['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--paginate']);
    const parts: ForgeComment[][] = [normalizeComments(JSON.parse(commentsOut))];
    if (kind === 'pr') {
      const reviewsOut = await gh(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--paginate']);
      parts.push(normalizeReviews(JSON.parse(reviewsOut)));
    }
    const { comments, truncated } = mergeThread(parts);
    const data: ForgeCommentsData = { available: true, comments, truncated: truncated || undefined };
    cacheComments(key, data);
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /ENOENT/.test(message)
      ? 'gh CLI not found — install it and run `gh auth login`'
      : /404|not found/i.test(message)
        ? 'not found on GitHub — it may be closed or deleted'
        : firstLine(message);
    return { available: false, reason, comments: [] };
  }
}

/** CEZ_DRY_RUN=1 — a small fixed thread (one image-bearing comment, plus a review for PRs) so
 *  the whole feature is demoable and e2e-testable offline. */
function mockGithubComments(kind: 'issue' | 'pr'): ForgeCommentsData {
  const base = Date.now() - 3_600_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  const comments: ForgeComment[] = [
    {
      id: 1,
      author: 'ada',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      createdAt: at(0),
      body: 'Thanks for the report — I can reproduce. Which browser were you on?\n\n```\nchrome 126, macOS\n```',
      kind: 'comment',
      url: 'https://github.com/mock/repo/issues/1#issuecomment-1',
    },
    {
      id: 2,
      author: 'lin',
      createdAt: at(600_000),
      body: 'Here is the failing screen:\n\n![failure](https://avatars.githubusercontent.com/u/2?v=4)',
      kind: 'comment',
      url: 'https://github.com/mock/repo/issues/1#issuecomment-2',
    },
  ];
  if (kind === 'pr') {
    comments.push({
      id: 3,
      author: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_200_000),
      body: 'Looks good overall — please add a regression test before this lands.',
      kind: 'review',
      reviewState: 'changes_requested',
      url: 'https://github.com/mock/repo/pull/1#pullrequestreview-3',
    });
  }
  return { available: true, comments };
}

// ---- draft-PR creation (review gate, spec 009) ------------------------------
// Final autosave-commit → `git push -u origin cez/<id8>` → `gh pr create
// --draft`, all executed in the task worktree (gh picks the repo up from the
// worktree's remote). Every failure maps to a one-line human error — the GUI
// shows it as a toast plus the manual `git merge <branch>` fallback. Never throws.

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const PUSH_TIMEOUT_MS = 60_000;
const PROGRESS_LINES_MAX = 10;

export async function createDraftPr(input: DraftPrInput): Promise<DraftPrOutcome> {
  const { run } = input;
  const worktree = run.worktreePath;
  const branch = run.branch;
  if (!worktree || !branch) {
    return { ok: false, error: 'this task has no worktree/branch to publish' };
  }

  // Final autosave: the branch must hold everything before it leaves the box.
  await autosaveCommit(worktree);

  // DRY-RUN (CEZ_DRY_RUN=1): no push, no gh — simulate success with a fake PR
  // URL so the whole review → PR flow is testable without GitHub.
  if (process.env.CEZ_DRY_RUN === '1') {
    return { ok: true, url: 'https://github.com/open-mercato/demo/pull/777', dryRun: true };
  }

  const remote = await execTool(['remote', 'get-url', 'origin'], worktree, 'git');
  if (!remote.ok || !remote.stdout.trim()) {
    return { ok: false, error: 'no git remote — add one (git remote add origin <url>) or merge the branch locally' };
  }

  const push = await execTool(['push', '-u', 'origin', branch], worktree, 'git', PUSH_TIMEOUT_MS);
  if (!push.ok) {
    return { ok: false, error: `git push failed — ${tail(push.stderr) || 'unknown error'}` };
  }

  const body = buildPrBody(input.handoffText, run.task);
  // Target the branch the worktree forked from (config `baseBranch`) — without
  // --base, gh aims at the repo default (main) even when work started on
  // develop. `origin/x` normalizes to `x`; a raw sha (detached-HEAD fork
  // point) can't be a PR base, so gh falls back to the default branch.
  const prBase = run.baseBranch?.replace(/^origin\//, '');
  const baseArgs = prBase && !/^[0-9a-f]{7,40}$/i.test(prBase) ? ['--base', prBase] : [];
  const pr = await execTool(
    ['pr', 'create', '--draft', '--head', branch, ...baseArgs, '--title', run.title, '--body', body],
    worktree,
    'gh',
    PUSH_TIMEOUT_MS,
  );
  if (!pr.ok) {
    if (pr.notFound) {
      return { ok: false, error: 'gh not found — install the GitHub CLI and run `gh auth login`, or merge the branch locally' };
    }
    const hint = /auth|log ?in|credential/i.test(pr.stderr) ? ' (try `gh auth login`)' : '';
    return { ok: false, error: `gh pr create failed — ${tail(pr.stderr) || 'unknown error'}${hint}` };
  }

  // gh prints the PR URL on stdout; some versions echo it to stderr instead.
  const match = PR_URL_RE.exec(`${pr.stdout}\n${pr.stderr}`);
  if (!match) {
    return { ok: false, error: 'gh pr create returned no PR URL — check `gh pr list` manually' };
  }
  return { ok: true, url: match[0], dryRun: false };
}

/**
 * PR body from the handoff journal: the "## Goal" section (task text as
 * fallback) + the first ~10 lines of "## Progress log" (newest first) +
 * the cezar footer.
 */
export function buildPrBody(handoffText: string, task: string): string {
  const goal = section(handoffText, '## Goal') || task.trim();
  const progress = section(handoffText, '## Progress log')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, PROGRESS_LINES_MAX)
    .join('\n');
  const parts = ['## Goal', '', goal];
  if (progress) parts.push('', '## Progress log', '', progress);
  parts.push('', '---', '', '🤖 made with cezar');
  return parts.join('\n');
}

/** Text of one `## Header` section, up to the next `## ` header. */
function section(text: string, header: string): string {
  const start = text.indexOf(`${header}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + header.length + 1);
  const next = rest.indexOf('\n## ');
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** Last 3 stderr lines, pipe-joined — enough context, toast-sized. */
function tail(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the binary itself is missing (ENOENT). */
  notFound: boolean;
}

function execTool(args: string[], cwd: string, bin: string, timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          notFound: err?.code === 'ENOENT',
        }),
    );
  });
}

// ---- the driver -------------------------------------------------------------

/** Cached availability probe so `GET /api/health` never pays a full listing. */
let detectCache: { at: number; repoRoot: string; result: ForgeAvailability } | null = null;

async function detectGithub(repoRoot: string): Promise<ForgeAvailability> {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  if (detectCache && detectCache.repoRoot === repoRoot && Date.now() - detectCache.at < CACHE_MS) {
    return detectCache.result;
  }
  let result: ForgeAvailability;
  try {
    await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner'], 5_000);
    result = { available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
  detectCache = { at: Date.now(), repoRoot, result };
  return result;
}

/**
 * Non-blocking availability for `GET /api/health` (#major-health-latency): serves the last-known
 * probe immediately (stale-while-revalidate) and only returns `null` on a cold start, before the
 * first probe has ever warmed the cache. It NEVER shells out to `gh` on the request that reads it,
 * so health stays under the bookmarklet's 800 ms port budget (a `gh repo view` round-trip is
 * ~500–650 ms on its own). `null` is contract-safe — the whole `forge` field is additive, so
 * "unknown until warm" is a valid answer.
 *
 * Serving the stale value while revalidating is what keeps the GitHub nav item from flickering:
 * without it, every time the 60 s cache expired this returned `null` for one 5 s health poll,
 * dropping `forge.available` and blinking the sidebar item out until the background probe warmed.
 */
export function detectGithubCached(repoRoot: string): ForgeAvailability | null {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  const cached =
    detectCache && detectCache.repoRoot === repoRoot ? detectCache.result : null;
  const fresh =
    detectCache && detectCache.repoRoot === repoRoot && Date.now() - detectCache.at < CACHE_MS;
  if (!fresh) {
    void detectGithub(repoRoot).catch(() => {}); // revalidate off the request path
  }
  return cached; // last-known value while revalidating; null only until the first probe warms
}

/** owner/repo parsed out of the origin remote — feeds `viewUrl`. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

const GH_PR_STATES: Record<string, ForgePrStatus['state']> = {
  MERGED: 'merged',
  CLOSED: 'closed',
};

export function createGithubDriver(repoRoot: string, repoRef: GithubRepoRef | null): ForgeDriver {
  return {
    kind: 'github',

    detect: () => detectGithub(repoRoot),
    detectCached: () => detectGithubCached(repoRoot),

    listIssues: async (opts) => (await fetchGithub(repoRoot, opts?.refresh, opts?.limit)).issues,

    listPRs: async (opts) => (await fetchGithub(repoRoot, opts?.refresh, opts?.limit)).prs,

    createPR: (input) => createDraftPr(input),

    // Null covers everything from "no PR yet" to "gh missing" — the callers
    // (Create PR → View PR flip) treat all of it as "nothing to link".
    prStatus: async (branch) => {
      if (process.env.CEZ_DRY_RUN === '1') return null;
      try {
        const out = await gh(repoRoot, ['pr', 'view', branch, '--json', 'number,url,state,isDraft,statusCheckRollup']);
        const pr = ghPrViewSchema.parse(JSON.parse(out));
        return {
          number: pr.number,
          url: pr.url,
          state: GH_PR_STATES[pr.state.toUpperCase()] ?? 'open',
          isDraft: pr.isDraft,
          checks: rollupToChecks(pr.statusCheckRollup) ?? null,
        };
      } catch {
        return null;
      }
    },

    viewUrl: (kind: ForgeRefKind, ref: string | number): string | null => {
      if (!repoRef) return null;
      const base = `https://github.com/${repoRef.owner}/${repoRef.repo}`;
      // Branch names may contain '/' — encode per segment, keep the slashes.
      const path = String(ref).split('/').map(encodeURIComponent).join('/');
      switch (kind) {
        case 'repo':
          return base;
        case 'issue':
          return `${base}/issues/${path}`;
        case 'pr':
          return `${base}/pull/${path}`;
        case 'branch':
          return `${base}/tree/${path}`;
        case 'commit':
          return `${base}/commit/${path}`;
      }
    },
  };
}
