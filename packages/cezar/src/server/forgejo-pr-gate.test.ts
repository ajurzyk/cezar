import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `POST /runs/:id/pr` still runs the GitHub-only `createDraftPr`, which pushes the branch BEFORE
 * calling `gh pr create`. Since `resolveForge` now answers with a real Forgejo driver, the route
 * has to refuse a non-GitHub forge itself — otherwise the push lands and the create fails, with
 * nothing rolled back. This pins the refusal, and pins that the GitHub path is untouched.
 */
describe('the draft-PR route on a non-GitHub forge', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });

  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fjpr-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A repo config names a forge only where the host table is silent, so a Forgejo repo has to
   *  carry a self-hosted remote — on `github.com` the table answers 'github' and the config
   *  declaration is inert (`forge/index.ts` → `classifyForgeKind`). */
  function setRemote(url: string): void {
    execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: repoRoot });
  }

  function declareForge(kind: 'github' | 'forgejo'): void {
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify(
        kind === 'forgejo'
          ? { forge: { kind: 'forgejo', apiUrl: 'http://forgejo:3000', webUrl: 'https://forge.example.com' } }
          : { forge: { kind: 'github' } },
      ),
      'utf8',
    );
  }

  /** A run the route will accept: a real on-disk worktree dir plus a branch. */
  function seedRun(): string {
    const worktreePath = join(repoRoot, '.ai/cezar/worktrees/run1');
    mkdirSync(worktreePath, { recursive: true });
    const run = store.createRun({ title: 'demo', workflow: 'quick-task', task: 'demo', steps: [] });
    store.updateRun(run.id, { worktreePath, branch: 'cez/run1', status: 'review' });
    return run.id;
  }

  const publish = (id: string) =>
    apiRequest(app, `/api/v1/runs/${id}/pr`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });

  it('refuses with 409 instead of pushing the branch and failing on gh pr create', async () => {
    setRemote('https://forge.example.com/acme/demo.git');
    declareForge('forgejo');
    const id = seedRun();

    const res = await publish(id);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('not supported for this forge yet');
    expect(store.getRun(id)?.pullRequestUrl).toBeUndefined();
  });

  it('still creates the draft PR for a github forge', async () => {
    declareForge('github');
    const id = seedRun();

    const res = await publish(id);

    expect(res.status).toBe(201);
    expect(store.getRun(id)?.pullRequestUrl).toBeDefined();
  });
});
