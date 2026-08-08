import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeSettings } from './types.ts';
import { __clearForgejoCachesForTests, createForgejoDriver, rebaseToWebUrl, type ForgejoDriverCtx } from './forgejo.ts';

/**
 * The Forgejo driver skeleton: `kind`, `detect`/`detectCached` (the two call sites that already
 * exist, `server.ts:1511`/`:3214`), `viewUrl`, `rebaseToWebUrl`, and the degraded stub for every
 * other `ForgeDriver` method (their real bodies land as follow-up changes). `fetch` is injected via
 * `deps.fetch`; nothing here touches the network.
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

describe('stubbed methods (real bodies land as follow-up changes) never touch the network', () => {
  const repoRoot = '/repo/stubs';

  it('listIssues/listPRs degrade to []', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.listIssues()).resolves.toEqual([]);
    await expect(driver.listPRs()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prStatus degrades to null', async () => {
    const fetchMock = vi.fn();
    const driver = createForgejoDriver(makeCtx(repoRoot), { fetch: fetchMock, token: null });
    await expect(driver.prStatus('feat/x')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
