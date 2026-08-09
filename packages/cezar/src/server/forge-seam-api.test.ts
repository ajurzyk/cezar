import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { ForgePrDiffResult } from './github.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * Route-level coverage for the shared forge seam (`resolveForgeOrGithub`, `forge/index.ts`) that
 * the `/api/v1/github*` route family is repointed at, one route at a time. This file covers only
 * `GET /github/prs/:number/changes` so far — the sibling routes (`/github`, `/github/comments`,
 * `/github/checks`) grow their own `describe` blocks here as they are repointed too.
 */
describe('the forge seam — GET /github/prs/:number/changes', () => {
  let repoRoot: string;
  let store: RunStore;
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  /** A self-hosted remote + repo-config `forge` declaration — the only way a config can name a
   *  forge the host table can't reveal (mirrors `github-merge-api.test.ts`'s self-hosted setup). */
  function initForgejoRepo(): void {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-forge-seam-'));
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
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  }

  it('routes a Forgejo repo through resolveForge and maps the changes with the Forgejo driver', async () => {
    initForgejoRepo();
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
    initForgejoRepo();
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
