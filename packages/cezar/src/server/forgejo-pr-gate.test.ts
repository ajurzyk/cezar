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
 * `POST /runs/:id/pr` resolves a `ForgeDriver` and publishes through `forge.createPR` — it no
 * longer imports the GitHub-only `createDraftPr` directly, so a Forgejo repo publishes through the
 * Forgejo driver instead of being refused before the mutation.
 *
 * These cases pin the seam by the URL each driver hands back, not by a status code alone: under
 * `CEZ_DRY_RUN=1` the Forgejo driver answers `<webUrl>/<owner>/<repo>/pulls/777` and the GitHub one
 * answers `https://github.com/open-mercato/demo/pull/777`, so a handler that silently kept the old
 * path would still return 201 and still fail here.
 *
 * The resolver is `resolveForgeOrGithub`, not `resolveForge`: the GitHub driver's `createPR` IS
 * `createDraftPr`, so a repo the resolver cannot answer for (no remote, an unrecognized host) keeps
 * today's behaviour with no second branch to express it. The third case is what proves that.
 */
describe('the draft-PR route resolves a forge driver', () => {
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

  it('creates the pull request through the Forgejo driver instead of refusing before the push', async () => {
    setRemote('https://forge.example.com/acme/demo.git');
    declareForge('forgejo');
    const id = seedRun();

    const res = await publish(id);

    expect(res.status).toBe(201);
    // The Forgejo driver's own dry-run URL — plural `/pulls/`, and the repo's configured `webUrl`
    // as the base. `createDraftPr` could not produce this string.
    expect((await res.json()) as unknown).toMatchObject({
      url: 'https://forge.example.com/acme/demo/pulls/777',
      dryRun: true,
    });
    // The route's post-create bookkeeping is driver-agnostic and still runs.
    expect(store.getRun(id)?.pullRequestUrl).toBe('https://forge.example.com/acme/demo/pulls/777');
    expect(store.getRun(id)?.status).toBe('done');
  });

  it('still creates the draft PR for a github forge', async () => {
    declareForge('github');
    const id = seedRun();

    const res = await publish(id);

    expect(res.status).toBe(201);
    expect(store.getRun(id)?.pullRequestUrl).toBeDefined();
  });

  /** `resolveForge` answers `null` for a repo with no remote, so the route falls back to the GitHub
   *  driver — which is the pre-seam behaviour byte for byte, since its `createPR` IS `createDraftPr`. */
  it('falls back to the GitHub path for a repo no forge can be resolved for', async () => {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: repoRoot });
    const id = seedRun();

    const res = await publish(id);

    expect(res.status).toBe(201);
    expect(store.getRun(id)?.pullRequestUrl).toBe('https://github.com/open-mercato/demo/pull/777');
  });
});
