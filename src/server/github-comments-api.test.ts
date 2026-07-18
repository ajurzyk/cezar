import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import type { ForgeCommentsData } from './github.js';
import { createApp } from './server.js';

/**
 * `GET /api/github/comments/:kind/:number` (#499 Phase 2). The contract under test: zod-validated
 * params (400 on garbage, never a throw), and — driven through `CEZ_DRY_RUN=1` so no `gh` is
 * touched — a `ForgeCommentsData` payload for a valid issue/PR request. The gh-shelling and the
 * degrade paths live in the driver; here we prove the route wiring and the param gate.
 */
describe('the github comments API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (prevDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = prevDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghcomments-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns a dry-run thread for a valid issue request', async () => {
    const res = await app.request('/api/github/comments/issue/142');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeCommentsData;
    expect(body.available).toBe(true);
    expect(body.comments.length).toBeGreaterThan(0);
    // Chronological, oldest first.
    for (let i = 1; i < body.comments.length; i++) {
      expect(body.comments[i - 1]!.createdAt <= body.comments[i]!.createdAt).toBe(true);
    }
  });

  it('includes a PR review summary for a valid pr request', async () => {
    const res = await app.request('/api/github/comments/pr/137');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeCommentsData;
    expect(body.comments.some((c) => c.kind === 'review')).toBe(true);
  });

  it('rejects an unknown kind with 400 and an { error } body, not a throw', async () => {
    const res = await app.request('/api/github/comments/banana/1');
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('rejects a non-numeric / non-positive number with 400', async () => {
    expect((await app.request('/api/github/comments/issue/abc')).status).toBe(400);
    expect((await app.request('/api/github/comments/issue/0')).status).toBe(400);
    expect((await app.request('/api/github/comments/issue/-3')).status).toBe(400);
  });
});
