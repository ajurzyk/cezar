import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeSettings } from './types.ts';
import { __clearForgejoCachesForTests, createForgejoDriver, rebaseToWebUrl, type ForgejoDriverCtx } from './forgejo.ts';

/**
 * The Forgejo driver: `kind`, `detect`/`detectCached` (the two call sites that already exist,
 * `server.ts:1511`/`:3214`), `viewUrl`, `rebaseToWebUrl`, `listIssues`, `listPRs` and `prStatus`
 * are real; `createPR`/`prMergeState`/`mergePR`/`prDiff` remain degraded stubs whose real bodies
 * land as follow-up changes. `fetch` is injected via `deps.fetch`; nothing here touches the
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

describe('stubbed methods (real bodies land as follow-up changes) never touch the network', () => {
  const repoRoot = '/repo/stubs';

  it('createPR degrades to {ok:false, error}', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.createPR({ repoRoot, run: {} as never, handoffText: '' });
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prMergeState degrades to {available:false, reason}', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    const result = await driver.prMergeState?.(1);
    expect(result).toEqual({ available: false, reason: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
