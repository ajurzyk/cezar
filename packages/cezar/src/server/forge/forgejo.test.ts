import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../runs/store.ts';
import type { ForgeSettings } from './types.ts';
import {
  __clearForgejoCachesForTests,
  createForgejoDriver,
  FJ_PR_DIFF_FILE_CAP,
  FJ_PR_DIFF_JSON_CAP,
  FJ_PR_PATCH_CAP,
  type ForgejoDriverCtx,
} from './forgejo.ts';

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
 * `server.ts:1511`/`:3214`), `viewUrl`, `listIssues`, `listPRs`, `prStatus`,
 * `createPR`, `prMergeState`, `mergePR` and `prDiff` are all real. `fetch` is injected via
 * `deps.fetch`; nothing here touches the network. `rebaseToWebUrl` itself is `forgejo-map.ts`'s
 * (imported there from `./forgejo-map.ts`, not re-exported here) — its own tests live in
 * `forgejo-map.test.ts`.
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

  it('a malformed combined-status body degrades checks alone to null, not the whole PR status', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) return Promise.resolve(jsonResponse([pullRow()], { headers: { 'x-total-count': '1' } }));
      // `status` must be a string per `forgejoCombinedStatusSchema` — this fails that zod parse.
      if (s.includes('/commits/')) return Promise.resolve(jsonResponse({ statuses: [{ status: 123 }] }));
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toEqual({
      number: 5,
      url: 'https://forge.example.com/acme/demo/pulls/5',
      state: 'open',
      isDraft: false,
      checks: null,
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

  it('a network/HTTP failure on the initial walk degrades to null and is NOT cached — a later call retries instead of serving a stale "no PR"', async () => {
    let walkCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        walkCalls += 1;
        return Promise.reject(new Error('network down'));
      }
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toBeNull();
    expect(walkCalls).toBe(1);

    await expect(driver.prStatus('feat/x')).resolves.toBeNull();
    expect(walkCalls).toBe(2); // a failed read must not poison the 60s cache with "no PR"
  });

  it('a matched row with a non-absolute html_url degrades to null instead of throwing (rebaseToWebUrl cannot parse it)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        return Promise.resolve(jsonResponse([pullRow({ html_url: 'not-a-url' })], { headers: { 'x-total-count': '1' } }));
      }
      return Promise.resolve(jsonResponse({ statuses: null }));
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toBeNull();
  });

  it('a /pulls/{base}/{head} fallback match with a non-absolute html_url degrades to null instead of throwing', async () => {
    const walkRow = pullRow({ number: 7, state: 'closed', merged: true, head: { ref: 'refs/pull/7/head', sha: 'c'.repeat(40) } });
    const fallbackRow = pullRow({
      number: 7,
      html_url: 'not-a-url',
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
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/skipped-branch')).resolves.toBeNull();
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

  it('a successful 201 create evicts prStatusCache so a stale "no PR" reading is not served right after publish', async () => {
    mockPush({ ok: true });
    let walkCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        walkCalls += 1;
        return Promise.resolve(jsonResponse([], { headers: { 'x-total-count': '0' } }));
      }
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(pullRow({ number: 42, html_url: 'http://forgejo:3000/acme/demo/pulls/42' }), { status: 201 }),
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toBeNull(); // warms the 60s cache with "no PR"
    expect(walkCalls).toBe(1);

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result.ok).toBe(true);

    await driver.prStatus('feat/x');
    expect(walkCalls).toBe(2); // eviction forced a fresh walk instead of serving the stale cached null
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

  it('a 409-idempotent open-match create also evicts prStatusCache, same as a fresh 201', async () => {
    mockPush({ ok: true });
    let walkCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.includes('/pulls?state=all')) {
        walkCalls += 1;
        return Promise.resolve(jsonResponse([], { headers: { 'x-total-count': '0' } }));
      }
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'PR already exists' }, { status: 409 }));
      }
      if (s.includes('/pulls/main/feat/x')) {
        return Promise.resolve(jsonResponse(pullRow({ number: 11, html_url: 'http://forgejo:3000/acme/demo/pulls/11' })));
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    await expect(driver.prStatus('feat/x')).resolves.toBeNull(); // warms the 60s cache with "no PR"
    expect(walkCalls).toBe(1);

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result.ok).toBe(true);

    await driver.prStatus('feat/x');
    expect(walkCalls).toBe(2); // eviction forced a fresh walk instead of serving the stale cached null
  });

  it('a 201 response with a non-absolute html_url degrades to a best-effort success (repo pulls link), never throws', async () => {
    // `rebaseToWebUrl` calls `new URL(html_url)`, which throws a `TypeError` on a non-absolute
    // string — the PR was genuinely created server-side by this point, so that must degrade to a
    // best-effort URL instead of turning a real success into an unhandled rejection.
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(pullRow({ html_url: 'not-a-url' }), { status: 201 }));
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result).toEqual({ ok: true, url: 'https://forge.example.com/acme/demo/pulls', dryRun: false });
  });

  it('409 fallback that resolves to a MERGED pull request is not treated as success — surfaces the 409 message instead', async () => {
    // GET pulls/{base}/{head} has no "give me the open one" semantics — it can hand back a
    // terminal PR sharing this exact head/base pair. Reporting {ok:true} with that PR's URL would
    // silently point the caller at a defunct pull request instead of the conflict Forgejo reported.
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo/pulls') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'PR already exists' }, { status: 409 }));
      }
      if (s.includes('/pulls/main/feat/x')) {
        return Promise.resolve(
          jsonResponse(pullRow({ number: 11, html_url: 'http://forgejo:3000/acme/demo/pulls/11', state: 'closed', merged: true })),
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('PR already exists');
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

  it('an empty error body on an other-status response falls back to this action\'s own message, not a generic one', async () => {
    mockPush({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 400, headers: { 'content-type': 'text/plain' } }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.createPR(input({ baseBranch: 'main' }));
    expect(result).toEqual({ ok: false, error: 'pull request creation failed (HTTP 400)' });
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

  it('a failed GET commits/{sha}/status reports checks-unknown, never reads as "no CI configured" (ready)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/commits/')) return Promise.resolve(jsonResponse({ message: 'server error' }, { status: 500 }));
      return router()(url);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available).toBe(true);
    expect(result?.available && result.mergeState.eligibility).toBe('unknown');
    expect(result?.available && result.mergeState.blockers).toEqual([{ code: 'checks-unknown', message: expect.any(String) }]);
    // Contrast with the happy-path test above: a SUCCESSFUL read reporting `{statuses: null}` (no CI
    // configured) stays 'ready' — only a failed read (this test) must block.
  });

  it('a failed GET /pulls/{n}/reviews reports reviews-unknown, never silently reads as "no reviews" (ready)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/pulls/9/reviews')) return Promise.resolve(jsonResponse({ message: 'server error' }, { status: 500 }));
      return router()(url);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available).toBe(true);
    expect(result?.available && result.mergeState.eligibility).toBe('unknown');
    expect(result?.available && result.mergeState.blockers).toEqual([{ code: 'reviews-unknown', message: expect.any(String) }]);
  });

  it('assembles reviewDecision from a real REQUEST_CHANGES review and blocks with code:"reviews" (fetchForgejoReviews -> reviewsRaw -> computeReviewDecision is actually wired)', async () => {
    const fetchMock = router({ reviews: [{ state: 'REQUEST_CHANGES', official: true, user: { login: 'a' } }] });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prMergeState?.(9);
    expect(result?.available).toBe(true);
    expect(result?.available && result.mergeState.reviewDecision).toBe('changes-requested');
    expect(result?.available && result.mergeState.eligibility).toBe('blocked');
    expect(result?.available && result.mergeState.blockers).toEqual([{ code: 'reviews', message: expect.any(String) }]);
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
    expect(pullCalls).toBe(2); // one probe, one retry — a wrong first "Checking" read would otherwise close canOverride
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

  it('without a token, user_can_merge:false is unknown/ready, never unauthorized (anonymous reads read it as false too)', async () => {
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

describe('mergePR', () => {
  const repoRoot = '/repo/merge-pr';

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

  /** A PR #9 in the 'ready to merge' state: open, non-draft, mergeable, on an unprotected branch
   *  with a passing check — the baseline every status-mapping/preflight test below starts from and
   *  overrides only the one field it's testing. */
  function readyPullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...pullRow(), mergeable: true, base: { ref: 'main' }, ...overrides };
  }

  /** Routes every request the preflight (`prMergeState(refresh:true)`) issues for PR #9, PLUS the
   *  merge POST itself and the post-merge `GET pulls/9` used for `mergeCommitSha`. `mergeResponse`
   *  lets a status-mapping test swap in exactly the response under test; `secondPullResponse` lets
   *  the mergeCommitSha-readback tests distinguish the preflight GET from the post-merge one. */
  function router(
    overrides: Partial<{
      pull: unknown;
      status: unknown;
      branch: unknown;
      reviews: unknown;
      repo: unknown;
      mergeResponse: Response;
      secondPullResponse: Response;
    }> = {},
  ) {
    let pullGetCalls = 0;
    return vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9/merge')) return Promise.resolve(overrides.mergeResponse ?? jsonResponse(null, { status: 200 }));
      if (s.endsWith('/pulls/9')) {
        pullGetCalls += 1;
        if (pullGetCalls === 2 && overrides.secondPullResponse) return Promise.resolve(overrides.secondPullResponse);
        return Promise.resolve(jsonResponse(overrides.pull ?? readyPullRow()));
      }
      if (s.includes('/commits/')) return Promise.resolve(jsonResponse(overrides.status ?? { statuses: [{ status: 'success' }] }));
      if (s.includes('/branches/main')) return Promise.resolve(jsonResponse(overrides.branch ?? branchRow()));
      if (s.includes('/pulls/9/reviews')) return Promise.resolve(jsonResponse(overrides.reviews ?? [], { headers: { 'x-total-count': '0' } }));
      if (s.endsWith('/repos/acme/demo'))
        return Promise.resolve(jsonResponse(overrides.repo ?? { default_branch: 'main', allow_merge_commits: true, allow_squash_merge: true }));
      throw new Error(`unexpected url ${s}`);
    });
  }

  it('the mergeInflight mutex rejects a concurrent call on the same key with 409/concurrent', async () => {
    const fetchMock = router();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    // Deliberately NOT awaited yet: `mergeInflight.add(key)` happens synchronously before the first
    // `await` inside `mergePR`, so the mutex is already held by the time this line returns control.
    const firstCall = driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
    const secondResult = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
    expect(secondResult).toEqual({ merged: false, status: 409, error: expect.any(String), code: 'concurrent' });

    const firstResult = await firstCall;
    expect(firstResult?.merged).toBe(true);
  });

  it('preflight: a head-sha mismatch against the fresh prMergeState maps to 409/stale-head with current', async () => {
    const fetchMock = router();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'f'.repeat(40) });
    expect(result).toMatchObject({ merged: false, status: 409, code: 'stale-head' });
    expect(result && !result.merged && result.current).toBeDefined();
  });

  it('preflight: a method absent from current.methods maps to 409/disabled-method with current', async () => {
    // Repository only enables `merge` — `squash` is not in `current.methods`.
    const fetchMock = router({ repo: { default_branch: 'main', allow_merge_commits: true } });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    const result = await driver.mergePR?.(9, { method: 'squash', expectedHeadSha: 'a'.repeat(40) });
    expect(result).toMatchObject({ merged: false, status: 409, code: 'disabled-method' });
    expect(result && !result.merged && result.current).toBeDefined();
  });

  it('preflight: mergePreflightAllowed rejection maps to 409 with code=eligibility and current', async () => {
    const fetchMock = router({ status: { statuses: [{ status: 'failure', context: 'ci' }] } });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
    // `current.eligibility` here is 'blocked' (the ladder's coarse state), NOT the finer-grained
    // blocker code 'checks-failing' — `mergePreflightAllowed`'s failure branch reuses `eligibility`
    // verbatim as `code`, mirroring github.ts:1787.
    expect(result).toMatchObject({ merged: false, status: 409, code: 'blocked' });
    expect(result && !result.merged && result.current).toBeDefined();
  });

  it('preflight: overrideRules:true lets a checks-failing (non-conflict) block through to the merge POST', async () => {
    const fetchMock = router({ status: { statuses: [{ status: 'failure', context: 'ci' }] } });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40), overrideRules: true });
    expect(result?.merged).toBe(true);
  });

  it('CEZ_DRY_RUN=1 (after preflight) returns merged:true without ever calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    // Matches the DRY_RUN merge-state fixture's own head sha and enabled methods — see
    // `DRY_RUN_MERGE_STATE_FIXTURE` in `forgejo.ts`.
    const result = await driver.mergePR?.(777, { method: 'merge', expectedHeadSha: '0'.repeat(40) });
    expect(result).toMatchObject({ merged: true, number: 777, method: 'merge' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends head_commit_id, force_merge, and both explicit-false flags in the merge POST body', async () => {
    const fetchMock = router();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40), overrideRules: true });

    const mergeCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/pulls/9/merge'));
    expect(mergeCall).toBeDefined();
    const body = JSON.parse((mergeCall![1] as RequestInit).body as string);
    expect(body).toEqual({
      Do: 'merge',
      head_commit_id: 'a'.repeat(40),
      force_merge: true,
      merge_when_checks_succeed: false,
      delete_branch_after_merge: false,
    });
  });

  it('force_merge is false when overrideRules is not set', async () => {
    const fetchMock = router();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });

    const mergeCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/pulls/9/merge'));
    const body = JSON.parse((mergeCall![1] as RequestInit).body as string);
    expect(body.force_merge).toBe(false);
  });

  describe('merge-POST status-code mapping', () => {
    it.each([
      [401, 403, undefined],
      [403, 403, undefined],
      [404, 404, undefined],
      [405, 409, 'forgejo-blocked'],
      [409, 409, 'conflicts'],
      [423, 409, 'archived'],
      [413, 409, 'quota'],
      [500, 502, undefined],
    ] as const)('HTTP %d from the merge POST -> {status:%d, code:%s}', async (httpStatus, expectedStatus, expectedCode) => {
      const fetchMock = router({ mergeResponse: jsonResponse({ message: 'nope' }, { status: httpStatus }) });
      const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

      const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
      if (!result || result.merged) throw new Error('expected a merged:false result');
      expect(result.status).toBe(expectedStatus);
      expect(result.code).toBe(expectedCode);
      if (expectedStatus === 409) expect(result.current).toBeDefined();
      else expect(result.current).toBeUndefined();
    });

    it('a network error from the merge POST maps to 502', async () => {
      const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
        const s = String(url);
        if (s.endsWith('/pulls/9/merge')) return Promise.reject(new Error('connection reset'));
        return router()(url);
      });
      const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

      const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
      expect(result).toEqual({ merged: false, status: 502, error: expect.any(String) });
    });
  });

  it('200 success reads mergeCommitSha from a follow-up GET /pulls/9', async () => {
    const fetchMock = router({ pull: readyPullRow({ merge_commit_sha: 'c'.repeat(40) }) });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
    expect(result).toMatchObject({ merged: true, number: 9, mergeCommitSha: 'c'.repeat(40) });
  });

  it('200 success with a failed mergeCommitSha readback still reports merged:true, just omits the field', async () => {
    const fetchMock = router({ secondPullResponse: jsonResponse({ message: 'gone' }, { status: 500 }) });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    const result = await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });
    expect(result?.merged).toBe(true);
    expect(result && result.merged && 'mergeCommitSha' in result).toBe(false);
  });

  it('a successful merge evicts listCache, prStatusCache, mergeStateCache, and prDiffCache for the whole project', async () => {
    // PR #42 is deliberately a DIFFERENT pull than the one merged below — proves the eviction is
    // project-wide (keyed on repoRoot+apiBase), not scoped to the merged PR's own number.
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/issues?')) return Promise.resolve(jsonResponse([], { headers: { 'x-total-count': '0' } }));
      if (s.includes('/pulls?state=all')) return Promise.resolve(jsonResponse([], { headers: { 'x-total-count': '0' } }));
      if (s.includes('/pulls/main/')) return Promise.resolve(jsonResponse({ message: 'not found' }, { status: 404 }));
      if (s.includes('/pulls/42/files')) return Promise.resolve(jsonResponse([], { headers: { 'x-total-count': '0' } }));
      if (s.endsWith('/pulls/42.diff')) return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
      if (s.endsWith('/pulls/42')) return Promise.resolve(jsonResponse(readyPullRow({ number: 42 })));
      if (s.endsWith('/pulls/9/merge')) return Promise.resolve(jsonResponse(null, { status: 200 }));
      if (s.endsWith('/pulls/9')) return Promise.resolve(jsonResponse(readyPullRow()));
      if (s.includes('/commits/')) return Promise.resolve(jsonResponse({ statuses: [{ status: 'success' }] }));
      if (s.includes('/branches/main')) return Promise.resolve(jsonResponse(branchRow()));
      if (s.includes('/reviews')) return Promise.resolve(jsonResponse([], { headers: { 'x-total-count': '0' } }));
      if (s.endsWith('/repos/acme/demo')) return Promise.resolve(jsonResponse({ default_branch: 'main', allow_merge_commits: true }));
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null, sleep: async () => {} });

    await driver.listIssues();
    await driver.prStatus('feat/x');
    await driver.prMergeState?.(42);
    await driver.prDiff?.(42);

    const callCount = (pathIncludes: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(pathIncludes)).length;
    const issuesBefore = callCount('/issues?');
    const prStatusBefore = callCount('/pulls?state=all');
    const pull42Before = callCount('/pulls/42');
    const diff42FilesBefore = callCount('/pulls/42/files');

    // Warm caches must be free right now — proves they really were cached before the merge.
    await driver.listIssues();
    await driver.prStatus('feat/x');
    await driver.prMergeState?.(42);
    await driver.prDiff?.(42);
    expect(callCount('/issues?')).toBe(issuesBefore);
    expect(callCount('/pulls?state=all')).toBe(prStatusBefore);
    // `/pulls/42` itself is always re-read by `prDiff` (it needs the current `headSha` to build its
    // cache key) — only the `/files` walk this warm assertion actually cares about must stay flat.
    expect(callCount('/pulls/42/files')).toBe(diff42FilesBefore);

    await driver.mergePR?.(9, { method: 'merge', expectedHeadSha: 'a'.repeat(40) });

    await driver.listIssues();
    await driver.prStatus('feat/x');
    await driver.prMergeState?.(42);
    await driver.prDiff?.(42);
    expect(callCount('/issues?')).toBeGreaterThan(issuesBefore);
    expect(callCount('/pulls?state=all')).toBeGreaterThan(prStatusBefore);
    expect(callCount('/pulls/42')).toBeGreaterThan(pull42Before);
    expect(callCount('/pulls/42/files')).toBeGreaterThan(diff42FilesBefore);
  });
});

describe('prDiff', () => {
  const repoRoot = '/repo/pr-diff';

  afterEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  function textResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  }

  /** Routes the three requests a happy-path `prDiff(9)` issues: the PR itself (for `headSha`), the
   *  paginated `/files` listing, and the single `.diff` text fetch. `filesRows`/`diffText` let each
   *  test swap in exactly the fixture under test. */
  function router(overrides: Partial<{ pull: unknown; filesRows: unknown[]; filesTotal: number; diffText: string; diffFails: boolean }> = {}) {
    return vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9')) return Promise.resolve(jsonResponse(overrides.pull ?? pullRow({ number: 9 })));
      if (s.includes('/pulls/9/files')) {
        const rows = overrides.filesRows ?? [];
        return Promise.resolve(jsonResponse(rows, { headers: { 'x-total-count': String(overrides.filesTotal ?? rows.length) } }));
      }
      if (s.endsWith('/pulls/9.diff')) {
        if (overrides.diffFails) return Promise.reject(new Error('connection reset'));
        return Promise.resolve(textResponse(overrides.diffText ?? ''));
      }
      throw new Error(`unexpected url ${s}`);
    });
  }

  it('CEZ_DRY_RUN=1 returns a mock ForgePrDiffResult without calling fetch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.prDiff?.(777);
    expect(result).toMatchObject({ available: true, files: expect.any(Array) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins /files rows with the parsed .diff by filename: a matched file gets its patch, a rename carries previousPath, a file absent from the diff degrades to not-provided', async () => {
    const filesRows = [
      { filename: 'src/a.ts', status: 'changed', additions: 2, deletions: 1 },
      { filename: 'src/new-name.ts', previous_filename: 'src/old-name.ts', status: 'renamed', additions: 0, deletions: 0 },
      { filename: 'src/untouched-in-diff.ts', status: 'changed', additions: 1, deletions: 0 },
    ];
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new a',
      ' context',
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n');
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: router({ filesRows, diffText }), token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-old\n+new a\n context' },
      {
        path: 'src/new-name.ts',
        previousPath: 'src/old-name.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        patchUnavailableReason: 'not-provided',
      },
      { path: 'src/untouched-in-diff.ts', status: 'modified', additions: 1, deletions: 0, patchUnavailableReason: 'not-provided' },
    ]);
  });

  it('a malformed /files row (missing filename) is skipped, not fatal to the whole response', async () => {
    const filesRows = [{ status: 'changed', additions: 1, deletions: 0 }, { filename: 'src/ok.ts', status: 'changed', additions: 1, deletions: 0 }];
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: router({ filesRows }), token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files).toEqual([{ path: 'src/ok.ts', status: 'modified', additions: 1, deletions: 0, patchUnavailableReason: 'not-provided' }]);
  });

  it('a binary entry in the diff maps to patchUnavailableReason:"binary", never a patch', async () => {
    const filesRows = [{ filename: 'assets/logo.png', status: 'changed', additions: 0, deletions: 0 }];
    const diffText = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 12',
      'garbage',
    ].join('\n');
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: router({ filesRows, diffText }), token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files).toEqual([{ path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' }]);
  });

  it('a patch over FJ_PR_PATCH_CAP is dropped with patchUnavailableReason:"too-large" and marks the result truncated', async () => {
    const bigPatch = `@@ -1 +1 @@\n+${'x'.repeat(FJ_PR_PATCH_CAP + 10)}`;
    const filesRows = [{ filename: 'src/big.ts', status: 'changed', additions: 1, deletions: 0 }];
    const diffText = ['diff --git a/src/big.ts b/src/big.ts', '--- a/src/big.ts', '+++ b/src/big.ts', bigPatch].join('\n');
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: router({ filesRows, diffText }), token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files[0]).toMatchObject({ path: 'src/big.ts', patchUnavailableReason: 'too-large', truncated: true });
    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it('caps the file list at FJ_PR_DIFF_FILE_CAP and marks the result truncated, with the cap in the reason', async () => {
    const allRows = Array.from({ length: FJ_PR_DIFF_FILE_CAP + 1 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: 'changed',
      additions: 1,
      deletions: 0,
    }));
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9')) return Promise.resolve(jsonResponse(pullRow({ number: 9 })));
      if (s.includes('/pulls/9/files')) {
        const page = Number(new URL(s).searchParams.get('page'));
        const limit = Number(new URL(s).searchParams.get('limit'));
        const start = (page - 1) * limit;
        return Promise.resolve(
          jsonResponse(allRows.slice(start, start + limit), { headers: { 'x-total-count': String(allRows.length) } }),
        );
      }
      if (s.endsWith('/pulls/9.diff')) return Promise.resolve(textResponse(''));
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files).toHaveLength(FJ_PR_DIFF_FILE_CAP);
    expect(result.truncated).toBe(true);
    expect(result.reason).toContain(String(FJ_PR_DIFF_FILE_CAP));
  });

  it('a /files walk that stops short (a later page failed) marks the result truncated even when the file count never reached FJ_PR_DIFF_FILE_CAP', async () => {
    // Reproduces a 250-file PR: page 1 (50 rows, matching x-total-count:250) succeeds, page 2 500s.
    // `paginate` reports `stoppedShort:true` for exactly this shape (forgejo-http.ts) — the walk
    // proved nothing about the other 200 files, so serving 50 rows as "the whole diff" would be a lie.
    const page1 = Array.from({ length: 50 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'changed', additions: 1, deletions: 0 }));
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/pulls/9')) return Promise.resolve(jsonResponse(pullRow({ number: 9 })));
      if (s.includes('/pulls/9/files')) {
        const page = Number(new URL(s).searchParams.get('page'));
        if (page === 1) return Promise.resolve(jsonResponse(page1, { headers: { 'x-total-count': '250' } }));
        return Promise.resolve(jsonResponse({ message: 'server error' }, { status: 500 }));
      }
      if (s.endsWith('/pulls/9.diff')) return Promise.resolve(textResponse(''));
      throw new Error(`unexpected url ${s}`);
    });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files).toHaveLength(50); // the 200 files past the failed page must NOT be silently dropped as "complete"
    expect(result.truncated).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('the WHOLE response over FJ_PR_DIFF_JSON_CAP drops files from the tail and marks the reason, even when no single patch is over FJ_PR_PATCH_CAP', async () => {
    // 10 files at ~460KB of patch each: none individually crosses FJ_PR_PATCH_CAP (512KB), so this
    // isolates the OTHER cap — the whole-response JSON size — from the per-file one already covered
    // above. `Math.ceil(FJ_PR_DIFF_JSON_CAP / 460_000) + 1` files guarantees the total crosses
    // FJ_PR_DIFF_JSON_CAP regardless of the cap's exact value.
    const perPatchBytes = 460_000;
    const fileCount = Math.ceil(FJ_PR_DIFF_JSON_CAP / perPatchBytes) + 1;
    const filesRows = Array.from({ length: fileCount }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: 'changed',
      additions: 1,
      deletions: 0,
    }));
    const diffText = filesRows
      .map(
        (row) =>
          `diff --git a/${row.filename} b/${row.filename}\n--- a/${row.filename}\n+++ b/${row.filename}\n@@ -1 +1 @@\n+${'x'.repeat(perPatchBytes)}`,
      )
      .join('\n');
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: router({ filesRows, diffText }), token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files.length).toBeLessThan(fileCount); // some files dropped from the tail
    expect(result.files.every((f) => f.patchUnavailableReason !== 'too-large')).toBe(true); // not the per-file cap
    expect(result.truncated).toBe(true);
    expect(result.reason).toContain('response size limit');
  });

  it('a failed .diff request degrades to a files-only list, still available:true, every file not-provided', async () => {
    const filesRows = [{ filename: 'src/a.ts', status: 'changed', additions: 1, deletions: 0 }];
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: router({ filesRows, diffFails: true }), token: null });

    const result = await driver.prDiff?.(9);
    if (!result?.available) throw new Error('expected available:true');
    expect(result.files).toEqual([{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patchUnavailableReason: 'not-provided' }]);
  });

  it('a 404 on GET pulls/{n} degrades to {available:false, reason}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'not found' }, { status: 404 }));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prDiff?.(999);
    expect(result).toEqual({ available: false, reason: expect.any(String) });
  });

  it('a PR with no head commit yet (head.sha absent) degrades to {available:false, reason}, never a missing-headSha crash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pullRow({ number: 9, head: null })));
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });

    const result = await driver.prDiff?.(9);
    expect(result).toEqual({ available: false, reason: expect.stringContaining('head commit') });
  });

  it('caches for 60s keyed by headSha; refresh:true bypasses the cache', async () => {
    const filesRows = [{ filename: 'src/a.ts', status: 'changed', additions: 1, deletions: 0 }];
    const fetchMock = router({ filesRows });
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const callCount = (pathIncludes: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(pathIncludes)).length;

    await driver.prDiff?.(9);
    const filesAfterFirst = callCount('/files');
    const diffAfterFirst = callCount('.diff');

    await driver.prDiff?.(9); // warm cache — headSha is still re-read (needed to build the key), files/.diff are not
    expect(callCount('/files')).toBe(filesAfterFirst);
    expect(callCount('.diff')).toBe(diffAfterFirst);

    await driver.prDiff?.(9, { refresh: true });
    expect(callCount('/files')).toBeGreaterThan(filesAfterFirst);
    expect(callCount('.diff')).toBeGreaterThan(diffAfterFirst);
  });
});
