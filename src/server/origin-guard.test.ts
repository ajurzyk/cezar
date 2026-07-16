import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { createApp } from './server.js';

/**
 * Request-origin guard (#426). The server executes agents with shell access,
 * so "bind 127.0.0.1 + same-origin" is not a perimeter on its own: a Host
 * allowlist kills DNS rebinding and an Origin match kills blind CSRF. Both are
 * zero-config and must leave the cockpit's own same-origin traffic, the SSE
 * reads and the intentionally-open /api/health probe untouched.
 */
describe('request-origin guard (#426)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-guard-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1'; // keeps the /api/health probe off the network
    // Capturing stub (the start-run.test.ts pattern) — the guard runs before
    // the handler, so a real run only needs to prove the request got through.
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const LOOPBACK = '127.0.0.1:4321';
  const startBody = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

  const postRuns = (headers: Record<string, string>) =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(startBody),
    });

  // ---- CSRF: cross-origin writes ------------------------------------------

  it('rejects a cross-origin mutating request (blind CSRF) with 403', async () => {
    const res = await postRuns({ host: LOOPBACK, origin: 'https://evil.tld' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('cross-origin');
    expect(store.listRuns()).toHaveLength(0); // never reached the manager
  });

  it('rejects a request carrying Sec-Fetch-Site: cross-site with 403', async () => {
    const res = await postRuns({ host: LOOPBACK, 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects an opaque "null" Origin (sandboxed iframe) with 403', async () => {
    const res = await postRuns({ host: LOOPBACK, origin: 'null' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  // ---- DNS rebinding: foreign Host ----------------------------------------

  it('rejects a mutating request with a foreign Host header (DNS rebinding) with 403', async () => {
    const res = await postRuns({ host: 'evil.tld', origin: 'http://evil.tld' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('Host');
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects even a READ with a foreign Host header (rebinding exfiltration) with 403', async () => {
    const res = await app.request('/api/runs', { headers: { host: 'evil.tld' } });
    expect(res.status).toBe(403);
  });

  // ---- the cockpit's own same-origin traffic passes -----------------------

  it('allows the cockpit same-origin write (Origin === Host, loopback) → 201', async () => {
    const res = await postRuns({ host: LOOPBACK, origin: 'http://127.0.0.1:4321' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('allows a same-origin write with no Origin header (non-browser caller) → 201', async () => {
    const res = await postRuns({ host: LOOPBACK });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('allows the dev-proxy write where a loopback Origin differs from a loopback Host → 201', async () => {
    // `npm run dev`: Vite (localhost:5173) proxies to the cockpit with
    // changeOrigin, so Host becomes 127.0.0.1 while the Origin stays localhost.
    const res = await postRuns({ host: '127.0.0.1:4321', origin: 'http://localhost:5173' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('allows an IPv6 loopback same-origin write ([::1]) → 201', async () => {
    const res = await postRuns({ host: '[::1]:4321', origin: 'http://[::1]:4321' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  // ---- reads and the SSE / health surfaces stay unaffected ----------------

  it('leaves loopback reads unaffected (GET /api/runs) → 200', async () => {
    const res = await app.request('/api/runs', { headers: { host: LOOPBACK } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('lets a loopback SSE read through to its route (unknown id → 404, not a 403)', async () => {
    const res = await app.request('/api/runs/nope/events', { headers: { host: LOOPBACK } });
    expect(res.status).toBe(404); // the route's own answer — the guard let it pass
  });

  it('still guards the SSE route against a foreign Host → 403', async () => {
    const res = await app.request('/api/runs/nope/events', { headers: { host: 'evil.tld' } });
    expect(res.status).toBe(403);
  });

  it('leaves /api/health open cross-origin (the bookmarklet discovery probe) → 200', async () => {
    const res = await app.request('/api/health', {
      headers: { host: 'evil.tld', origin: 'https://github.com' },
    });
    expect(res.status).toBe(200);
  });

  it('answers the /api/health CORS preflight regardless of Host → 204', async () => {
    const res = await app.request('/api/health', {
      method: 'OPTIONS',
      headers: { host: 'evil.tld', origin: 'https://github.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

/**
 * Hosted mode (CEZ_REMOTE=1 — spec §"Deployment modes"): cezar binds loopback
 * behind a reverse proxy that forwards the real public Host, so the loopback
 * allowlist must stand down there. CSRF protection stays on — Origin still has
 * to match the served Host.
 */
describe('request-origin guard — hosted mode (#426)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-guard-hosted-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_REMOTE = '1';
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const startBody = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };
  const postRuns = (headers: Record<string, string>) =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(startBody),
    });

  it('allows the public-domain same-origin write (Origin === forwarded Host) → 201', async () => {
    const res = await postRuns({ host: 'cez.example.com', origin: 'https://cez.example.com' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('still rejects a cross-origin write in hosted mode → 403', async () => {
    const res = await postRuns({ host: 'cez.example.com', origin: 'https://evil.tld' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });
});
