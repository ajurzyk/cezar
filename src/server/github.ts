import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);

/** One GitHub issue or pull request, flattened for the cockpit's GitHub tab. */
export interface GithubItem {
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

export interface GithubData {
  available: boolean;
  /** Human-readable hint when unavailable (`gh` missing, no remote, offline…). */
  reason?: string;
  /** owner/name, when known. */
  repo?: string;
  syncedAt?: string;
  issues: GithubItem[];
  prs: GithubItem[];
}

// `gh … --json` output — validated at the boundary, extras stripped.
const ghAuthor = z.object({ login: z.string() }).nullish();
const ghLabel = z.object({ name: z.string() });
const ghIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: ghAuthor,
  createdAt: z.string(),
  labels: z.array(ghLabel).default([]),
  body: z.string().nullish(),
  url: z.string(),
});
const ghPrSchema = ghIssueSchema.extend({
  isDraft: z.boolean().default(false),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  statusCheckRollup: z
    .array(z.object({ state: z.string().nullish(), status: z.string().nullish(), conclusion: z.string().nullish() }))
    .nullish(),
});

function rollupToChecks(rollup: Array<{ state?: string | null; status?: string | null; conclusion?: string | null }> | null | undefined): GithubItem['checks'] {
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

/* Reads degrade to `available: false` with a hint — never an error (plan rule
   7): no `gh`, no remote, offline all land on the same quiet path. A short
   cache keeps tab switches from hammering the GitHub API; a cached fetch with
   a bigger limit than asked serves fine (it's a superset). */
let cache: { at: number; limit: number; data: GithubData } | null = null;
const CACHE_MS = 60_000;
export const GH_MAX_LIMIT = 1000;

export async function fetchGithub(repoRoot: string, refresh = false, limit = 30): Promise<GithubData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGithub();
  const capped = Math.min(Math.max(limit, 1), GH_MAX_LIMIT);
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS && cache.limit >= capped) {
    return cache.data;
  }
  try {
    // No `comments` field — `gh … --json comments` ships full comment bodies.
    // Big fetches (the GUI's follow-up "give me everything" shot) get a
    // longer wall clock — statusCheckRollup on hundreds of PRs is slow.
    const timeout = capped > 100 ? 60_000 : 15_000;
    const fields = 'number,title,author,createdAt,labels,body,url';
    const [repoOut, issuesOut, prsOut] = await Promise.all([
      gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], timeout),
      gh(repoRoot, ['issue', 'list', '--limit', String(capped), '--json', fields], timeout),
      gh(repoRoot, ['pr', 'list', '--limit', String(capped), '--json', `${fields},isDraft,additions,deletions,statusCheckRollup`], timeout),
    ]);
    const issues = z.array(ghIssueSchema).parse(JSON.parse(issuesOut)).map(
      (i): GithubItem => ({
        kind: 'issue',
        number: i.number,
        title: i.title,
        author: i.author?.login ?? '?',
        createdAt: i.createdAt,
        labels: i.labels.map((l) => l.name),
        body: (i.body ?? '').slice(0, 8_000),
        url: i.url,
        comments: 0,
      }),
    );
    const prs = z.array(ghPrSchema).parse(JSON.parse(prsOut)).map(
      (p): GithubItem => ({
        kind: 'pr',
        number: p.number,
        title: p.title,
        author: p.author?.login ?? '?',
        createdAt: p.createdAt,
        labels: [...p.labels.map((l) => l.name), ...(p.isDraft ? ['draft'] : [])],
        body: (p.body ?? '').slice(0, 8_000),
        url: p.url,
        comments: 0,
        isDraft: p.isDraft,
        additions: p.additions,
        deletions: p.deletions,
        checks: rollupToChecks(p.statusCheckRollup),
      }),
    );
    const data: GithubData = {
      available: true,
      repo: repoOut.trim() || undefined,
      syncedAt: new Date().toISOString(),
      issues,
      prs,
    };
    cache = { at: Date.now(), limit: capped, data };
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
  };
}
