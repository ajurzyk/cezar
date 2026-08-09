import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { ForgeChecksResult, ForgeCommentsData } from './forge/types.ts';
import { fetchGithub, fetchGithubChecks } from './github.ts';
import type { ForgePrDiffResult, GithubData, GithubItem } from './github.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * Route-level coverage for the shared forge seam (`resolveForgeOrGithub`, `forge/index.ts`) that
 * the `/api/v1/github*` route family is repointed at, one route at a time. Covers
 * `GET /github/prs/:number/changes`, `GET /github`, `GET /github/comments/:kind/:number` and
 * `GET /github/checks` — every route in the family now goes through the seam.
 */

/** A self-hosted remote + repo-config `forge` declaration — the only way a config can name a
 *  forge the host table can't reveal (mirrors `github-merge-api.test.ts`'s self-hosted setup).
 *  Shared by every describe block below: each repoints a different route through the same seam,
 *  so each needs its own throwaway Forgejo-configured repo. */
function initForgejoRepo(): { repoRoot: string; store: RunStore } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-forge-seam-'));
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
  execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@forge.internal:2222/acme/demo.git'], { cwd: repoRoot });
  writeFileSync(
    join(repoRoot, '.ai/cezar', 'config.json'),
    JSON.stringify({ forge: { kind: 'forgejo', apiUrl: 'http://forge.internal', webUrl: 'http://forge.internal' } }),
    'utf8',
  );
  return { repoRoot, store: RunStore.open(join(repoRoot, '.ai/cezar')) };
}

/** A fresh `Response` per call — mirrors the same pattern/comment in `forge/forgejo.test.ts`'s own
 *  `jsonResponse`/`pageOf` helpers (a shared mock `Response`'s body stream can only be read once). */
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** Registers the `beforeEach`/`afterEach` every describe block below needs: reset `CEZ_DRY_RUN`
 *  before each test, flush/remove the throwaway repo and unstub `fetch` after. `get` reads via a
 *  closure rather than taking `repoRoot`/`store` directly — each describe block's own `let`
 *  bindings are reassigned per test (`initForgejoRepo()`, or the no-remote dry-run setup), and
 *  `afterEach` must see whichever assignment the JUST-FINISHED test made. */
function registerForgeSeamLifecycle(get: () => { repoRoot: string; store: RunStore }): void {
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  afterEach(() => {
    const { repoRoot, store } = get();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });
}

describe('the forge seam — GET /github/prs/:number/changes', () => {
  let repoRoot: string;
  let store: RunStore;
  registerForgeSeamLifecycle(() => ({ repoRoot, store }));

  it('routes a Forgejo repo through resolveForge and maps the changes with the Forgejo driver', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.endsWith('/repos/acme/demo/pulls/5')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 5,
              title: 'add x',
              html_url: 'http://forge.internal/acme/demo/pulls/5',
              created_at: '2026-08-07T10:00:00Z',
              head: { ref: 'feat/x', sha: 'a'.repeat(40) },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (s.includes('/repos/acme/demo/pulls/5/files')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([{ filename: 'src/a.ts', status: 'changed', additions: 2, deletions: 1 }]),
            { status: 200, headers: { 'content-type': 'application/json', 'x-total-count': '1' } },
          ),
        );
      }
      if (s.endsWith('/repos/acme/demo/pulls/5.diff')) {
        return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
      }
      throw new Error(`unexpected url ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/prs/5/changes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgePrDiffResult;
    expect(body.available).toBe(true);
    if (body.available) {
      // Forgejo's `/files` row (`status: 'changed'`) maps through `mapChangedFileStatus` to
      // `'modified'` — a value `gh`'s own vocabulary never produces this way, so this being present
      // proves the request went through the Forgejo driver, not a GitHub fallback.
      expect(body.files).toEqual([
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patchUnavailableReason: 'not-provided' },
      ]);
    }
    expect(fetchMock).toHaveBeenCalled();
  });

  it('degrades to available:false with a non-empty reason when the Forgejo transport is unreachable', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/prs/5/changes');
    // A driver-reported failure is an in-payload degrade, never a 5xx (matches the guard's own
    // `available:false` shape for a missing `prDiff`).
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgePrDiffResult;
    expect(body.available).toBe(false);
    if (!body.available) expect(body.reason).toBeTruthy();
    // Proves the route actually reached the Forgejo transport (and failed there) instead of
    // silently falling through to `gh` — the failure mode this test exists to pin.
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to the GitHub driver for a repo resolveForge cannot place (no remote, dry-run) — payload unchanged', async () => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-forge-seam-noremote-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/prs/128/changes');
    expect(res.status).toBe(200);
    // Same fixture `github-pr-changes-api.test.ts` pins for the pre-seam `fetchGithubPrDiff` path —
    // `resolveForgeOrGithub`'s fallback must reach it byte for byte for a repo `resolveForge` can't
    // place (no remote at all here, on top of the dry-run short-circuit).
    const body = (await res.json()) as ForgePrDiffResult;
    expect(body.available).toBe(true);
    if (body.available) {
      expect(body.files.some((file) => file.status === 'renamed' && file.previousPath)).toBe(true);
      expect(body.files.some((file) => file.patchUnavailableReason === 'binary')).toBe(true);
      expect(body.truncated).toBe(true);
    }
  });
});

describe('the forge seam — GET /github', () => {
  let repoRoot: string;
  let store: RunStore;
  registerForgeSeamLifecycle(() => ({ repoRoot, store }));

  /** Drops the fields `mockGithub()` (`forge/github.ts`) recomputes from `Date.now()` on every
   *  call. The composed route awaits `listIssues`+`listPRs` in parallel; under `CEZ_DRY_RUN` each
   *  independently short-circuits to its OWN `mockGithub()` snapshot, so the two calls can carry
   *  different timestamps for what is otherwise the exact same static catalog — comparing
   *  structure needs them stripped; their presence/format is asserted separately. */
  function stripDryRunTimestamps(data: Pick<GithubData, 'syncedAt' | 'issues' | 'prs'>) {
    const stripItem = ({ createdAt: _createdAt, ...item }: GithubItem) => item;
    const { syncedAt: _syncedAt, ...rest } = data;
    return { ...rest, issues: data.issues.map(stripItem), prs: data.prs.map(stripItem) };
  }

  it('a repo resolveForge cannot place (no remote, dry-run) reproduces the mock payload byte for byte, timestamps aside', async () => {
    // Byte-for-byte parity with the pre-seam `fetchGithub` response is the whole point of this
    // route: `contract-parity.github.test.ts` only proves the TYPES stay assignable, it can't
    // catch a dropped `repo`/`syncedAt`/`labelColors` at runtime. Calling `fetchGithub` directly
    // gives the canonical static catalog (`mockGithub`, `forge/github.ts`) the composed route must
    // still reproduce — one list at a time — without hand-transcribing that catalog into this test.
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-forge-seam-noremote-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const expected = await fetchGithub(repoRoot);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubData;

    expect(stripDryRunTimestamps(body)).toEqual(stripDryRunTimestamps(expected));
    // Timestamps are stripped above for the structural compare — assert their presence and ISO
    // shape here instead of just dropping the coverage silently.
    expect(() => new Date(body.syncedAt as string).toISOString()).not.toThrow();
    for (const item of [...body.issues, ...body.prs]) {
      expect(() => new Date(item.createdAt).toISOString()).not.toThrow();
    }
  });

  it('composes listIssues + listPRs into one available:true payload for a Forgejo repo', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/repos/acme/demo/issues?')) {
        return Promise.resolve(
          jsonResponse(
            [
              {
                number: 1,
                title: 'Issue 1',
                html_url: 'http://forge.internal/acme/demo/issues/1',
                user: { login: 'ajr' },
                created_at: '2026-08-07T10:00:00Z',
                labels: [{ name: 'bug', color: 'd73a4a' }],
                body: 'body',
                comments: 0,
                pull_request: null,
              },
            ],
            { headers: { 'x-total-count': '1' } },
          ),
        );
      }
      if (s.includes('/repos/acme/demo/pulls?')) {
        return Promise.resolve(
          jsonResponse(
            [
              {
                number: 5,
                title: 'add x',
                html_url: 'http://forge.internal/acme/demo/pulls/5',
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
              },
            ],
            { headers: { 'x-total-count': '1' } },
          ),
        );
      }
      throw new Error(`unexpected url ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubData;
    expect(body.available).toBe(true);
    expect(body.repo).toBe('acme/demo');
    expect(body.issues).toEqual([expect.objectContaining({ kind: 'issue', number: 1 })]);
    expect(body.prs).toEqual([expect.objectContaining({ kind: 'pr', number: 5 })]);
  });

  it('a failed PR list does not blank the tab — issues stay available, prs degrade with a reason', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/repos/acme/demo/issues?')) {
        return Promise.resolve(
          jsonResponse(
            [
              {
                number: 1,
                title: 'Issue 1',
                html_url: 'http://forge.internal/acme/demo/issues/1',
                user: { login: 'ajr' },
                created_at: '2026-08-07T10:00:00Z',
                labels: [],
                body: 'body',
                comments: 0,
                pull_request: null,
              },
            ],
            { headers: { 'x-total-count': '1' } },
          ),
        );
      }
      if (s.includes('/repos/acme/demo/pulls?')) {
        return Promise.resolve(jsonResponse({ message: 'internal error' }, { status: 500 }));
      }
      throw new Error(`unexpected url ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubData;
    // The cockpit (`packages/web/src/routes/github/github.tsx:270`) rejects the WHOLE payload at
    // available:false — a failed PR list must not blank out the issues that DID come back.
    expect(body.available).toBe(true);
    expect(body.reason).toBeTruthy();
    expect(body.issues).toEqual([expect.objectContaining({ kind: 'issue', number: 1 })]);
    expect(body.prs).toEqual([]);
  });

  it('both lists failing degrades the whole payload to available:false with a reason', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubData;
    expect(body.available).toBe(false);
    expect(body.reason).toBeTruthy();
    expect(body.issues).toEqual([]);
    expect(body.prs).toEqual([]);
  });
});

describe('the forge seam — GET /github/comments/:kind/:number', () => {
  let repoRoot: string;
  let store: RunStore;
  registerForgeSeamLifecycle(() => ({ repoRoot, store }));

  it('routes a Forgejo repo through the seam and maps the thread with the Forgejo driver', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/repos/acme/demo/issues/7/comments')) {
        return Promise.resolve(
          jsonResponse(
            [
              {
                id: 1,
                user: { login: 'ajr' },
                created_at: '2026-08-09T10:00:00Z',
                body: 'hello from forgejo',
                html_url: 'http://forge.internal/acme/demo/issues/7#issuecomment-1',
              },
            ],
            { headers: { 'x-total-count': '1' } },
          ),
        );
      }
      throw new Error(`unexpected url ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/comments/issue/7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeCommentsData;
    expect(body.available).toBe(true);
    // The rebased url (forge.internal, not github.com) proves the request went through the
    // Forgejo driver, not a GitHub fallback.
    expect(body.comments).toEqual([
      expect.objectContaining({ id: 1, kind: 'comment', url: 'http://forge.internal/acme/demo/issues/7#issuecomment-1' }),
    ]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('degrades to available:false with a non-empty reason when the Forgejo transport is unreachable', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/comments/issue/7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeCommentsData;
    expect(body.available).toBe(false);
    expect(body.reason).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('the forge seam — GET /github/checks', () => {
  let repoRoot: string;
  let store: RunStore;
  registerForgeSeamLifecycle(() => ({ repoRoot, store }));

  it('routes a Forgejo repo through the seam and maps the glyphs with the Forgejo driver', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const sha = 'a'.repeat(40);
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const s = String(url);
      if (s.includes('/repos/acme/demo/pulls?state=open')) {
        return Promise.resolve(
          jsonResponse(
            [
              {
                number: 5,
                title: 'add x',
                html_url: 'http://forge.internal/acme/demo/pulls/5',
                created_at: '2026-08-09T10:00:00Z',
                head: { ref: 'feat/x', sha },
              },
            ],
            { headers: { 'x-total-count': '1' } },
          ),
        );
      }
      if (s.endsWith(`/repos/acme/demo/commits/${sha}/status`)) {
        return Promise.resolve(jsonResponse({ statuses: [{ status: 'success' }] }));
      }
      throw new Error(`unexpected url ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/checks?prs=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeChecksResult;
    expect(body.available).toBe(true);
    // A glyph sourced from `commits/{sha}/status` (not a gh graphql call) proves the request went
    // through the Forgejo driver, not a GitHub fallback.
    if (body.available) expect(body.checks[5]).toBe('passing');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('degrades to available:false with a non-empty reason when the Forgejo transport is unreachable', async () => {
    ({ repoRoot, store } = initForgejoRepo());
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/checks?prs=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeChecksResult;
    expect(body.available).toBe(false);
    if (!body.available) expect(body.reason).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to the GitHub driver for a repo resolveForge cannot place (no remote, dry-run) — payload unchanged', async () => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-forge-seam-noremote-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const expected = await fetchGithubChecks(repoRoot, [128, 124]);

    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/github/checks?prs=128,124');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeChecksResult;
    expect(body).toEqual(expected);
  });
});
