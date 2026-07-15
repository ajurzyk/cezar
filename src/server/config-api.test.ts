import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';

/**
 * `GET/PUT /api/config` (R6 Step 1.5 — Settings → Agents). The contract under
 * test: GET answers every Settings-editable knob in one shape; PUT merges into
 * the RAW config.json (user keys survive, defaults never materialize); the R6
 * keys (`systemPrompt`, `defaultModels`) are additive — `null`/`''` clears,
 * per-runner model writes merge instead of clobbering; and the pre-R6 answer
 * fields (`baseBranch`, `defaultRunner`) stay exactly as they were
 * (BACKWARD_COMPATIBILITY.md §2 — additive only).
 */
describe('the config API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-configapi-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // The config routes never touch the manager — an empty stub is honest.
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const configPath = () => join(repoRoot, '.ai/cezar', 'config.json');
  const rawFile = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

  const get = () => app.request('/api/config');
  const getBody = async () => (await (await get()).json()) as Record<string, unknown>;
  const put = (body: unknown) =>
    app.request('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET answers the zero-config defaults when no file exists', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      baseBranch: null,
      defaultRunner: 'claude',
      systemPrompt: null,
      defaultModels: {},
      maxParallel: 2,
      memoryLimitMb: null,
    });
  });

  it('PUT systemPrompt trims, persists, and round-trips through GET', async () => {
    const res = await put({ systemPrompt: '  Answer in bullet points.  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ systemPrompt: 'Answer in bullet points.' });
    expect((await getBody()).systemPrompt).toBe('Answer in bullet points.');
  });

  it('PUT systemPrompt null and "" both clear the raw key', async () => {
    await put({ systemPrompt: 'Be brief.' });
    expect(rawFile().systemPrompt).toBe('Be brief.');
    await put({ systemPrompt: null });
    expect(rawFile().systemPrompt).toBeUndefined();
    await put({ systemPrompt: 'Be brief.' });
    await put({ systemPrompt: '' });
    expect(rawFile().systemPrompt).toBeUndefined();
    expect((await getBody()).systemPrompt).toBeNull();
  });

  it('PUT defaultModels merges per runner instead of clobbering', async () => {
    await put({ defaultModels: { claude: 'opus' } });
    await put({ defaultModels: { codex: 'gpt-5.1-codex' } });
    expect((await getBody()).defaultModels).toEqual({
      claude: 'opus',
      codex: 'gpt-5.1-codex',
    });
    // Clearing one runner leaves the other; clearing the last drops the key.
    await put({ defaultModels: { codex: null } });
    expect(rawFile().defaultModels).toEqual({ claude: 'opus' });
    await put({ defaultModels: { claude: '' } });
    expect(rawFile().defaultModels).toBeUndefined();
  });

  it('PUT merges into the raw file — user keys survive, defaults never materialize', async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ skillsRepos: [{ repo: 'me/skills' }], maxParallel: 5 }),
      'utf8',
    );
    await put({ systemPrompt: 'Be brief.', defaultModels: { claude: 'opus' }, baseBranch: 'develop' });
    const raw = rawFile();
    expect(raw.skillsRepos).toEqual([{ repo: 'me/skills' }]);
    expect(raw.maxParallel).toBe(5);
    // No schema defaults leaked into the user's file.
    expect(raw.defaultRunner).toBeUndefined();
    expect(raw.plannerModel).toBeUndefined();
    expect(await (await get()).json()).toEqual({
      baseBranch: 'develop',
      defaultRunner: 'claude',
      systemPrompt: 'Be brief.',
      defaultModels: { claude: 'opus' },
      maxParallel: 5,
      memoryLimitMb: null,
    });
  });

  it('PUT keeps the pre-R6 answer fields (protected shape) alongside the additive ones', async () => {
    const res = await put({ baseBranch: 'develop', defaultRunner: 'codex' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.baseBranch).toBe('develop');
    expect(body.defaultRunner).toBe('codex');
  });

  it('rejects an over-limit systemPrompt and a malformed defaultModels with 400 + reason', async () => {
    const tooLong = await put({ systemPrompt: 'x'.repeat(20_001) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toContain('20000');
    const badModels = await put({ defaultModels: { claude: 42 } });
    expect(badModels.status).toBe(400);
  });
});
