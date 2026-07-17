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
 * `POST /api/runs` `systemPrompt` (R2 2.3) — the programmatic per-run
 * override (bookmarklets, scripts; deliberately no composer-UI control).
 * Validation contract: trimmed, blank degrades to absent, 20k cap.
 */
describe('POST /api/runs systemPrompt', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    // The route hands the parsed input straight to the manager — a capturing
    // stub is all the harness needs (the patch-run.test.ts pattern).
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('passes a trimmed systemPrompt through to the manager', async () => {
    const res = await post({ ...base, systemPrompt: '  Answer in bullet points.  ' });
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toBe('Answer in bullet points.');
  });

  it('an absent systemPrompt stays absent', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toBeUndefined();
  });

  it('forwards an explicit generateFollowups=false choice', async () => {
    const res = await post({ ...base, generateFollowups: false });
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBe(false);
  });

  it('keeps generateFollowups absent for old clients (enabled by default)', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBeUndefined();
  });

  it('a whitespace-only systemPrompt degrades to absent (not a 400, not an empty string)', async () => {
    const res = await post({ ...base, systemPrompt: '   ' });
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toBeUndefined();
  });

  it('accepts exactly 20k characters', async () => {
    const res = await post({ ...base, systemPrompt: 'x'.repeat(20_000) });
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toHaveLength(20_000);
  });

  it('rejects an over-cap systemPrompt with a 400', async () => {
    const res = await post({ ...base, systemPrompt: 'x'.repeat(20_001) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('systemPrompt');
    expect(captured).toBeUndefined();
  });

  it('rejects a non-string systemPrompt with a 400', async () => {
    const res = await post({ ...base, systemPrompt: 42 });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });
});
