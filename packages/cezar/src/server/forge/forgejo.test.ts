import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../runs/store.ts';
import type { ForgeSettings } from './types.ts';
import { __clearForgejoCachesForTests, createForgejoDriver, rebaseToWebUrl, type ForgejoDriverCtx } from './forgejo.ts';

// `vi.hoisted` so `execFileMock` exists before the (hoisted) vi.mock factory runs — same pattern
// as `github.test.ts`. Default behavior delegates every call to the REAL `execFile`: `createPR`'s
// autosave and `remote get-url` steps run against a real temp git repo (fast, local, no network —
// same approach `draft-pr-autosave.test.ts` uses for `createDraftPr`). Only `git push` ever gets
// overridden (via `mockPush` below, per test that needs it) — that is the one git subcommand this
// suite must never let touch the network. `realExecFileRef` captures the actual implementation so
// `mockPush` can still delegate every non-push call to it after overriding.
const execFileMock = vi.hoisted(() => vi.fn());
const realExecFileRef: { current?: typeof import('node:child_process').execFile } = vi.hoisted(() => ({}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  realExecFileRef.current = actual.execFile;
  execFileMock.mockImplementation((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args));
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

// Test-setup helper (git init/commit for temp repos below) — resolves through the mock's default
// passthrough, exactly like importing `execFile` directly in `draft-pr-autosave.test.ts` does.
const runGit = promisify(execFile);

/** Intercepts only `git push …` (argv[0] === 'push'); every other git invocation — status, add,
 *  commit, remote get-url — still runs for real against the temp repo each test sets up. Always
 *  installs a FRESH implementation (never chains onto a previous test's override), so test order
 *  can never leak one test's push behavior into the next. */
function mockPush(result: { ok: boolean; stderr?: string }): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (err: unknown, stdout: string, stderr: string) => void;
    if (argv[0] === 'push') {
      if (result.ok) cb(null, '', '');
      else cb(new Error('git push failed'), '', result.stderr ?? 'permission denied (publickey)');
      return undefined;
    }
    return (realExecFileRef.current as (...a: unknown[]) => unknown)(...args);
  });
}

/**
 * The Forgejo driver: `kind`, `detect`/`detectCached` (the two call sites that already exist,
 * `server.ts:1511`/`:3214`), `viewUrl`, `rebaseToWebUrl`, `listIssues`, `listPRs`, `prStatus`,
 * `createPR` and `prMergeState` are real; `mergePR`/`prDiff` remain degraded stubs whose real
 * bodies land as follow-up changes. `fetch` is injected via `deps.fetch`; nothing here touches the
 * network.
 */

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const settings: ForgeSettings = {
  kind: 'forgejo',
  apiUrl: 'http://forgejo:3000',
  webUrl: 'https://forge.example.com',
};

function makeCtx(repoRoot: string, overrides: Partial<ForgejoDriverCtx> = {}): ForgejoDriverCtx {
  return { repoRoot, owner: 'acme', repo: 'demo', settings, ...overrides };
}

beforeEach(() => {
  __clearForgejoCachesForTests();
});

describe('kind', () => {
  it('is "forgejo"', () => {
    const driver = createForgejoDriver(makeCtx('/repo/kind'), { fetch: vi.fn(), token: null });
    expect(driver.kind).toBe('forgejo');
  });
});

describe('viewUrl', () => {
  const driver = createForgejoDriver(makeCtx('/repo/viewurl'), { fetch: vi.fn(), token: null });

  it.each([
    ['repo', 'x', 'https://forge.example.com/acme/demo'],
    ['issue', 142, 'https://forge.example.com/acme/demo/issues/142'],
    ['pr', 128, 'https://forge.example.com/acme/demo/pulls/128'], // NOT /pull/ — confirmed from html_url
    ['branch', 'feat/cockpit ui', 'https://forge.example.com/acme/demo/src/branch/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://forge.example.com/acme/demo/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});

describe('rebaseToWebUrl', () => {
  it('rebases host+path+query+hash from html_url onto the webUrl origin', () => {
    expect(
      rebaseToWebUrl('http://q7010-dev.local:8929/ajr/x/pulls/1?tab=files', 'http://q7010-dev:8929'),
    ).toBe('http://q7010-dev:8929/ajr/x/pulls/1?tab=files');
  });

  it('preserves a hash fragment too', () => {
    expect(rebaseToWebUrl('http://a.local/o/r/pulls/1#comment-9', 'http://b.local:8929')).toBe(
      'http://b.local:8929/o/r/pulls/1#comment-9',
    );
  });
});

describe('detect', () => {
  const repoRoot = '/repo/detect';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CEZ_DRY_RUN;
  });

  it('CEZ_DRY_RUN=1 short-circuits to available:true without calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.detect()).resolves.toEqual({ available: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 200 with a Repository body resolves available:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ full_name: 'acme/demo', default_branch: 'main' }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.detect()).resolves.toEqual({ available: true });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://forgejo:3000/api/v1/repos/acme/demo');
  });

  it('a 401 degrades to available:false with a CEZ_FORGEJO_TOKEN hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'token is required' }, { status: 401 }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.detect();
    expect(result.available).toBe(false);
    expect(result.reason).toContain('CEZ_FORGEJO_TOKEN');
  });

  it('a network error degrades to available:false with a one-line reason', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed\nEXTRA STACK NOISE'));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.detect();
    expect(result.available).toBe(false);
    expect(result.reason).toBe('fetch failed');
  });

  it('caches a successful result for 60s, then re-probes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ full_name: 'acme/demo' }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await driver.detect();
    await driver.detect();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(60_001);
    await driver.detect();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('detectCached', () => {
  const repoRoot = '/repo/detect-swr';
  const CACHE_MS = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CEZ_DRY_RUN;
  });

  it('CEZ_DRY_RUN=1 always answers available:true without calling fetch', () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    expect(driver.detectCached()).toEqual({ available: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stale-while-revalidate: null cold, cached warm, stale value + background reprobe once expired', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ full_name: 'acme/demo' }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    // Cold start — nothing cached yet.
    expect(driver.detectCached()).toBeNull();
    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget probe settle
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Warm — served from cache, no new probe.
    expect(driver.detectCached()).toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Stale — still serves the last-known value, but kicks off a background reprobe.
    vi.setSystemTime(CACHE_MS + 1);
    expect(driver.detectCached()).toEqual({ available: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function issueRow(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `http://forgejo:3000/acme/demo/issues/${number}`,
    user: { login: 'ajr' },
    created_at: '2026-08-07T10:00:00Z',
    labels: [],
    body: 'body',
    comments: 0,
    pull_request: null,
    ...overrides,
  };
}

function pullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 5,
    title: 'add x',
    html_url: 'http://forgejo:3000/acme/demo/pulls/5',
    user: { login: 'ajr' },
    created_at: '2026-08-07T10:00:00Z',
    labels: [],
    body: '',
    comments: 0,
    draft: false,
    additions: 1,
    deletions: 1,
    state: 'open',
    merged: false,
    head: { ref: 'feat/x', sha: 'a'.repeat(40) },
    ...overrides,
  };
}

/** A fresh `Response` per call — a shared mock `Response`'s body stream can only be read once
 *  (mirrors the same comment/pattern in `forgejo-http.test.ts`'s `maxPages` test). Every list/walk
 *  fixture below uses this instead of `mockResolvedValue` so a second (or cache-miss re-)page
 *  never silently reads an already-consumed body. */
function pageOf(rows: unknown[], total?: number): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse(rows, total === undefined ? {} : { headers: { 'x-total-count': String(total) } }));
}

describe('listIssues', () => {
  const repoRoot = '/repo/list-issues';

  afterEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  it('requests state=open&type=issues, drops PR rows, and rebases urls onto webUrl', async () => {
    const rows = [issueRow(1), issueRow(2, { pull_request: { merged: false, merged_at: null } })];
    const fetchMock = vi.fn().mockImplementation(pageOf(rows, rows.length));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const items = await driver.listIssues();

    expect(items).toEqual([
      expect.objectContaining({ kind: 'issue', number: 1, url: 'https://forge.example.com/acme/demo/issues/1' }),
    ]);
    const requestedUrl = String(fetchMock.mock.calls[0]![0]);
    expect(requestedUrl).toContain('state=open');
    expect(requestedUrl).toContain('type=issues');
  });

  it('caches for 60s; refresh:true bypasses the cache', async () => {
    const fetchMock = vi.fn().mockImplementation(pageOf([issueRow(1)], 1));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await driver.listIssues();
    await driver.listIssues();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await driver.listIssues({ refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('respects a smaller limit than the server page size', async () => {
    // No x-total-count here on purpose: a full first page (50 == pageLimit) already satisfies
    // `want=10` on its own ("want reached" branch), independent of whether the walk is provably
    // exhausted — proving the driver-level `limit` re-slice runs, not `paginate`'s own stop logic.
    const fetchMock = vi.fn().mockImplementation(pageOf(Array.from({ length: 50 }, (_, i) => issueRow(i + 1))));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const items = await driver.listIssues({ limit: 10 });
    expect(items).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one full page already satisfies want=10
  });

  it('degrades to [] on an HTTP error, never throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, { status: 500 }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.listIssues()).resolves.toEqual([]);
  });

  it('CEZ_DRY_RUN=1 short-circuits to [] without calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.listIssues()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listPRs', () => {
  const repoRoot = '/repo/list-prs';

  afterEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  it('requests state=open (no type filter) and maps drafts with a stripped title + draft label', async () => {
    const rows = [pullRow({ number: 9, title: 'WIP: add y', draft: true })];
    const fetchMock = vi.fn().mockImplementation(pageOf(rows, rows.length));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const items = await driver.listPRs();

    expect(items).toEqual([
      expect.objectContaining({ kind: 'pr', number: 9, title: 'add y', isDraft: true, labels: ['draft'], checks: null }),
    ]);
    const requestedUrl = String(fetchMock.mock.calls[0]![0]);
    expect(requestedUrl).toContain('state=open');
    expect(requestedUrl).not.toContain('type=issues');
  });

  it('CEZ_DRY_RUN=1 short-circuits to [] without calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.listPRs()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('prStatus', () => {
  const repoRoot = '/repo/pr-status';

  afterEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  it('walks pulls?state=all, finds the branch, and reports checks from head.sha (never the branch name)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) return Promise.resolve(jsonResponse([pullRow()], { headers: { 'x-total-count': '1' } }));
      if (s.includes('/commits/')) {
        expect(s).toContain(`/commits/${'a'.repeat(40)}/status`); // head.sha, never "feat/x"
        return Promise.resolve(jsonResponse({ statuses: [{ status: 'success' }] }));
      }
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toEqual({
      number: 5,
      url: 'https://forge.example.com/acme/demo/pulls/5',
      state: 'open',
      isDraft: false,
      checks: 'passing',
    });
  });

  it('reports state:"merged" for a merged PR, never a bare state:"closed"', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        return Promise.resolve(jsonResponse([pullRow({ state: 'closed', merged: true })], { headers: { 'x-total-count': '1' } }));
      }
      return Promise.resolve(jsonResponse({ statuses: null }));
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const status = await driver.prStatus('feat/x');
    expect(status?.state).toBe('merged');
  });

  it('prefers an open match over an earlier closed match with the same head.ref', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        return Promise.resolve(
          jsonResponse([pullRow({ number: 3, state: 'closed', merged: false }), pullRow({ number: 5, state: 'open' })], {
            headers: { 'x-total-count': '2' },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ statuses: null }));
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const status = await driver.prStatus('feat/x');
    expect(status?.number).toBe(5);
    expect(status?.state).toBe('open');
  });

  it('an exhausted walk (stoppedShort:false) with no match falls back to /pulls/{base}/{head}', async () => {
    // A merged PR with a deleted branch reports head.ref as "refs/pull/7/head" — the walk can
    // never match it against the real branch name, so a match-by-head.ref alone would report
    // "no PR" for a PR that plainly exists. `page.stoppedShort:false` (short page + a matching
    // X-Total-Count) proves the walk was exhaustive, which is what makes the fallback lookup safe.
    const walkRow = pullRow({ number: 7, state: 'closed', merged: true, head: { ref: 'refs/pull/7/head', sha: 'c'.repeat(40) } });
    const fallbackRow = pullRow({
      number: 7,
      html_url: 'http://forgejo:3000/acme/demo/pulls/7',
      state: 'closed',
      merged: true,
      head: { ref: 'refs/pull/7/head', sha: 'c'.repeat(40) },
    });
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        return Promise.resolve(jsonResponse([walkRow], { headers: { 'x-total-count': '1' } }));
      }
      if (s.includes('/pulls/main/')) return Promise.resolve(jsonResponse(fallbackRow));
      if (s.endsWith('/repos/acme/demo')) return Promise.resolve(jsonResponse({ default_branch: 'main' }));
      if (s.includes('/status')) return Promise.resolve(jsonResponse({ statuses: null }));
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/skipped-branch')).resolves.toEqual({
      number: 7,
      url: 'https://forge.example.com/acme/demo/pulls/7',
      state: 'merged',
      isDraft: false,
      checks: null,
    });
  });

  it('an unfinished walk (stoppedShort:true) returns null WITHOUT ever calling the base/head fallback', async () => {
    let now = 0;
    const fetchMock = vi.fn().mockImplementation((_url: URL | string) => {
      now += 14_000; // leaves < minPageMs (2s) of the default 15s budget after one page
      return Promise.resolve(jsonResponse([pullRow({ head: { ref: 'refs/pull/9/head', sha: 'b'.repeat(40) } })]));
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, now: () => now, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/pulls?state=all');
  });

  it('caches for 60s', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) return Promise.resolve(jsonResponse([pullRow()], { headers: { 'x-total-count': '1' } }));
      return Promise.resolve(jsonResponse({ statuses: null }));
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await driver.prStatus('feat/x');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await driver.prStatus('feat/x');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('CEZ_DRY_RUN=1 short-circuits to null without calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.prStatus('feat/x')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('createPR', () => {
  const repoRoot = '/repo/create-pr'; // detectCache/prStatusCache key namespace — unrelated to the git temp dir below
  let repo: string;

  const input = (overrides: { baseBranch?: string; worktreePath?: string; branch?: string } = {}) => ({
    repoRoot,
    handoffText: '# Goal\n\nship it\n',
    run: {
      // `in` (not `!== undefined`) so a test can explicitly pass `worktreePath: undefined` to
      // exercise the "no worktree" guard — a `!==` check would treat that as "not overridden" and
      // silently fall back to the real temp repo, which is exactly the case that guard test needs
      // to NOT happen.
      worktreePath: 'worktreePath' in overrides ? overrides.worktreePath : repo,
      branch: 'branch' in overrides ? overrides.branch : 'feat/x',
      baseBranch: overrides.baseBranch,
      title: 'ship it',
      task: 'do the thing',
    } as RunRecord,
  });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-forgejo-pr-'));
    await runGit('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await runGit('git', ['remote', 'add', 'origin', 'ssh://git@q7010-dev.local:2222/acme/demo.git'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await runGit('git', ['add', '-A'], { cwd: repo });
    await runGit('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
  });

  afterEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => (realExecFileRef.current as (...a: unknown[]) => unknown)(...args));
    delete process.env.CEZ_DRY_RUN;
    rmSync(repo, { recursive: true, force: true });
  });

  it('with no worktree/branch to publish, degrades to {ok:false, error} without touching git or fetch', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR(input({ worktreePath: undefined, branch: undefined }));
    // Exact message, parity with `createDraftPr` (github.ts:1405-1407) — `expect.any(String)` here
    // would also pass against the old degraded-stub message, defeating the point of this guard test.
    expect(result).toEqual({ ok: false, error: 'this task has no worktree/branch to publish' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to publish a worktree holding conflict markers (reuses autosaveCommit\'s guard)', async () => {
    writeFileSync(
      join(repo, 'a.txt'),
      ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', ''].join('\n'),
    );
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR(input());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('unresolved merge conflicts');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CEZ_DRY_RUN=1 returns a fake PR URL after the autosave, without pushing or calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    writeFileSync(join(repo, 'a.txt'), 'finished work\n');
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR(input());
    expect(result).toEqual({ ok: true, url: 'https://forge.example.com/acme/demo/pulls/777', dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.some((c) => (c[1] as string[])[0] === 'push')).toBe(false);
  });

  it('with no git remote configured, degrades to {ok:false, error} without pushing or calling fetch', async () => {
    await runGit('git', ['remote', 'remove', 'origin'], { cwd: repo });
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR(input());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('no git remote');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.some((c) => (c[1] as string[])[0] === 'push')).toBe(false);
  });

  it('when the base branch cannot be resolved (no baseBranch, and the default-branch lookup fails), degrades to {ok:false, error}', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR(input());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('base branch');
  });

  it('a failed push reports a git/SSH error, never mentions the token', async () => {
    mockPush({ ok: false, stderr: 'Permission denied (publickey).\nfatal: Could not read from remote repository.' });
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR(input());
    expect(result.ok).toBe(false);
    const message = result.ok === false ? result.error : '';
    expect(message).toContain('git push failed');
    expect(message.toLowerCase()).not.toContain('cez_forgejo_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts head/base/draft-prefixed title/body and returns the webUrl-rebased link on 201', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(pullRow({ number: 42, html_url: 'http://forgejo:3000/acme/demo/pulls/42' }), { status: 201 }),
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'origin/main' }));

    expect(result).toEqual({ ok: true, url: 'https://forge.example.com/acme/demo/pulls/42', dryRun: false });
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.head).toBe('feat/x'); // bare branch name, "origin/" never leaks in
    expect(sentBody.base).toBe('main'); // "origin/" prefix stripped
    expect(sentBody.title).toBe('WIP: ship it'); // draft expressed as a title prefix
    expect(typeof sentBody.body).toBe('string');
    expect(sentBody.labels).toBeUndefined(); // label IDs, not names — omitted entirely
  });

  it('a base that looks like a sha is rejected and falls back to Repository.default_branch', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo') && init?.method === 'GET') return Promise.resolve(jsonResponse({ default_branch: 'develop' }));
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        const sent = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(sent.base).toBe('develop');
        return Promise.resolve(
          jsonResponse(pullRow({ number: 9, html_url: 'http://forgejo:3000/acme/demo/pulls/9' }), { status: 201 }),
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'a'.repeat(40) }));
    expect(result.ok).toBe(true);
  });

  it('with no baseBranch at all, falls back to Repository.default_branch the same way', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo') && init?.method === 'GET') return Promise.resolve(jsonResponse({ default_branch: 'develop' }));
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        const sent = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(sent.base).toBe('develop');
        return Promise.resolve(
          jsonResponse(pullRow({ number: 9, html_url: 'http://forgejo:3000/acme/demo/pulls/9' }), { status: 201 }),
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input());
    expect(result.ok).toBe(true);
  });

  it('409 (PR already exists) idempotently returns the existing PR\'s URL via GET pulls/{base}/{head}', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'PR already exists' }, { status: 409 }));
      }
      if (s.includes('/pulls/main/feat/x')) {
        return Promise.resolve(jsonResponse(pullRow({ number: 11, html_url: 'http://forgejo:3000/acme/demo/pulls/11' })));
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result).toEqual({ ok: true, url: 'https://forge.example.com/acme/demo/pulls/11', dryRun: false });
  });

  it('404 (pull requests disabled) gets its own message, not a generic "not found"', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'not found' }, { status: 404 }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('disabled');
  });

  it('423 (archived repository) gets its own message', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'repo is archived' }, { status: 423 }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('archived');
  });

  it('any other error status surfaces the response message, never throws', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'internal error' }, { status: 500 }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result).toEqual({ ok: false, error: 'internal error' });
  });
});

describe('prMergeState', () => {
  const repoRoot = '/repo/merge-state';

  afterEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  function branchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protected: false,
      required_approvals: 0,
      enable_status_check: false,
      status_check_contexts: [],
      user_can_merge: true,
      ...overrides,
    };
  }

  function mergePullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    // `overrides` spread LAST — `pullRow()` and the `mergeable`/`base` defaults below must not be
    // able to shadow a caller's override (e.g. `mergePullRow({ mergeable: false })`).
    return { ...pullRow(), mergeable: true, base: { ref: 'main' }, ...overrides };
  }

  /** Routes every request this method can issue: `GET pulls/9`, the combined commit status, the
   *  branch, the paginated reviews walk, and (cold `detectCache`) `GET repos/acme/demo` for merge
   *  methods. One shared router keeps every test below to its actual point of difference. */
  function router(overrides: Partial<{ pull: unknown; status: unknown; branch: unknown; reviews: unknown; repo: unknown }> = {}) {
    return vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9')) return Promise.resolve(jsonResponse(overrides.pull ?? mergePullRow()));
      if (s.includes('/commits/')) return Promise.resolve(jsonResponse(overrides.status ?? { statuses: null }));
      if (s.includes('/branches/main')) return Promise.resolve(jsonResponse(overrides.branch ?? branchRow()));
      if (s.includes('/pulls/9/reviews')) return Promise.resolve(jsonResponse(overrides.reviews ?? [], { headers: { 'x-total-count': '0' } }));
      if (s.endsWith('/repos/acme/demo')) return Promise.resolve(jsonResponse(overrides.repo ?? { default_branch: 'main', allow_merge_commits: true }));
      throw new Error(`unexpected url ${s}`);
    });
  }

  it('CEZ_DRY_RUN=1 returns a mock, available mergeState without calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path assembles a ready mergeState from pull + status + branch + reviews + repository', async () => {
    const fetchMock = router();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available).toBe(true);
    expect(result?.available && result.mergeState.eligibility).toBe('ready');
    expect(result?.available && result.mergeState.methods).toEqual(['merge']);
    expect(result?.available && result.mergeState.number).toBe(5);
  });

  it('a failed GET /branches/{base} reports branch.readable:false -> rules-unknown, never throws', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/branches/main')) return Promise.resolve(jsonResponse({ message: 'not found' }, { status: 404 }));
      return router()(url);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available).toBe(true);
    expect(result?.available && result.mergeState.eligibility).toBe('unknown');
    expect(result?.available && result.mergeState.blockers).toEqual([{ code: 'rules-unknown', message: expect.any(String) }]);
  });

  it('retries mergeable:false exactly once on the refresh:true path before reporting conflicting', async () => {
    let pullCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9')) {
        pullCalls += 1;
        return Promise.resolve(jsonResponse(mergePullRow({ mergeable: false })));
      }
      return router()(url);
    });
    let slept = 0;
    const driver = createForgejoDriver(makeCtx(repoRoot), {
      fetch: fetchMock,
      token: null,
      sleep: async (ms: number) => {
        slept = ms;
      },
    });

    const result = await driver.prMergeState?.(9, { refresh: true });
    expect(pullCalls).toBe(2); // one probe, one retry — pułapka 5: a wrong first read closes canOverride
    expect(slept).toBeGreaterThan(0);
    expect(result?.available && result.mergeState.mergeable).toBe('conflicting');
  });

  it('does NOT retry outside the refresh:true path', async () => {
    let pullCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9')) {
        pullCalls += 1;
        return Promise.resolve(jsonResponse(mergePullRow({ mergeable: false })));
      }
      return router()(url);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await driver.prMergeState?.(9);
    expect(pullCalls).toBe(1);
  });

  it('caches for 15s; refresh:true bypasses the cache', async () => {
    const fetchMock = router();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await driver.prMergeState?.(9);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await driver.prMergeState?.(9);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    await driver.prMergeState?.(9, { refresh: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('a network/HTTP failure degrades to {available:false, reason}, never throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prMergeState?.(9)).resolves.toEqual({ available: false, reason: expect.any(String) });
  });

  it('without a token, user_can_merge:false is unknown/ready, never unauthorized (pułapka 12)', async () => {
    const fetchMock = router({ branch: branchRow({ user_can_merge: false }) });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available && result.mergeState.eligibility).not.toBe('unauthorized');
  });

  it('with a token, user_can_merge:false is unauthorized', async () => {
    const fetchMock = router({ branch: branchRow({ user_can_merge: false }) });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: 'secret-token' });

    const result = await driver.prMergeState?.(9);
    expect(result?.available && result.mergeState.eligibility).toBe('unauthorized');
  });
});

describe('stubbed methods (real bodies land as follow-up changes) never touch the network', () => {
  const repoRoot = '/repo/stubs';

  it('mergePR degrades to a 502 merged:false result', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.mergePR?.(1, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
    expect(result).toEqual({ merged: false, status: 502, error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prDiff degrades to {available:false, reason}', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.prDiff?.(1);
    expect(result).toEqual({ available: false, reason: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
