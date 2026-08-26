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
 * `POST /api/v1/forge/labels` — the cockpit action behind #47.
 *
 * The route exists so a Forgejo project's pipeline labels can be put in place BEFORE a run tries to
 * signal on them; without them every `apply_label` degrades to a logged skip and the claim protocol
 * stops working while each step still reports success.
 *
 * These cases are about the ROUTE's own guards, not about provisioning — the provisioning
 * behaviour is pinned hermetically in `forge/forgejo-labels.test.ts`. Everything here runs under
 * `CEZ_DRY_RUN=1`, so no case can reach the network.
 *
 * The resolver is `resolveForge`, deliberately NOT `resolveForgeOrGithub`. That fallback builds
 * `createGithubDriver(repoRoot, null)`, and a `repoRef` of `null` means "let `gh` pick the
 * repository" — the exact hazard PR #16 (`381fb10e`) closed for the GitHub path, where `gh` prefers
 * an `upstream` remote over `origin` and answers with the PARENT of a fork. A label write is the
 * last mutation that should inherit that. A repo this resolver cannot answer for gets a 400.
 */
describe('the label-provisioning route', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fjlabels-'));
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

  function setRemote(url: string): void {
    execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: repoRoot });
  }

  function declareForgejo(): void {
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ forge: { kind: 'forgejo', apiUrl: 'http://forgejo:3000', webUrl: 'https://forge.example.com' } }),
    );
  }

  const sync = (body: unknown) =>
    apiRequest(app, '/api/v1/forge/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify(body),
    });

  it('provisions through the Forgejo driver when the target matches', async () => {
    setRemote('https://forge.example.com/acme/demo.git');
    declareForgejo();

    const res = await sync({ target: 'acme/demo' });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { target: string; dryRun: boolean; complete: boolean; present: string[] };
    expect(payload.target).toBe('acme/demo');
    expect(payload.dryRun).toBe(true);
    expect(payload.complete).toBe(true);
    expect(payload.present).toHaveLength(27);
  });

  it('passes checkOnly through', async () => {
    setRemote('https://forge.example.com/acme/demo.git');
    declareForgejo();

    const res = await sync({ target: 'acme/demo', checkOnly: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checkOnly: boolean }).checkOnly).toBe(true);
  });

  it('refuses a target the project`s own remote does not resolve to', async () => {
    setRemote('https://forge.example.com/acme/demo.git');
    declareForgejo();

    const res = await sync({ target: 'someone-else/victim' });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('someone-else/victim');
    expect(error).toContain('acme/demo');
  });

  it('rejects a request that names no target at all', async () => {
    // The target is REQUIRED, not defaulted. A default would be the implicit target #16 removed.
    setRemote('https://forge.example.com/acme/demo.git');
    declareForgejo();

    expect((await sync({})).status).toBe(400);
  });

  it('refuses a repo whose forge cannot provision labels, rather than falling back to gh', async () => {
    // A github.com remote resolves to the GitHub driver, which has no `ensureLabels` — the GitHub
    // path keeps `.ai/scripts/labels-sync.sh`, byte for byte. The route says so instead of
    // pretending, and above all does not reach for `gh` with an unnamed repository.
    const res = await sync({ target: 'acme/demo' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/labels-sync\.sh/);
  });

  it('refuses a repo with no recognised forge at all', async () => {
    setRemote('https://gitlab.example.com/acme/demo.git');
    const res = await sync({ target: 'acme/demo' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/forge/i);
  });
});
