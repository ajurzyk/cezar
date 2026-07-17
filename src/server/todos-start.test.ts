import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { WorkflowDef } from '../workflows/types.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';

/**
 * `POST /api/todos/:id/start` runner/model override (#401) — the Inbox card's pills pick which
 * backend runs the follow-up. Contract: the parsed override reaches `startRun` verbatim; a
 * bodyless POST (every client before the pills) omits both, so the run starts on the host's
 * `defaultRunner` exactly as it always did; a bad runner is a 400. Capturing stub, per the
 * continue-run/start-run pattern.
 *
 * Unlike `/continue`, this is a START path: an omitted field means "host default", not "keep the
 * run's current backend" — there is no prior backend to keep.
 */
describe('POST /api/todos/:id/start override', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: { opts: { task?: string; runner?: string; model?: string } } | undefined;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  const writeTodos = (items: unknown[]) => {
    const dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(items));
  };

  beforeEach(() => {
    // #471: the inbox is opt-in, and this route 409s without it — these assertions are about
    // the override, so the capability is switched on explicitly rather than left to the box.
    process.env.CEZ_FOLLOWUPS = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todo-start-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const manager = {
      startRun: (_workflow: WorkflowDef, opts: { task?: string; runner?: string; model?: string }) => {
        captured = { opts };
        return store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body?: unknown) =>
    app.request(
      '/api/todos/todo-1/start',
      body === undefined
        ? { method: 'POST' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );

  it('plumbs a runner + model override through to startRun', async () => {
    const res = await post({ runner: 'codex', model: 'gpt-5.1-codex' });
    expect(res.status).toBe(201);
    expect(captured?.opts.runner).toBe('codex');
    expect(captured?.opts.model).toBe('gpt-5.1-codex');
    // The follow-up's own prompt still drives the task — the override only picks the engine.
    expect(captured?.opts.task).toBe('Do the thing');
  });

  it('a bodyless POST omits both — the host default runs it, exactly as before #401', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(captured?.opts.runner).toBeUndefined();
    expect(captured?.opts.model).toBeUndefined();
  });

  it('an empty JSON body omits both too', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(captured?.opts.runner).toBeUndefined();
    expect(captured?.opts.model).toBeUndefined();
  });

  it('accepts a model on its own (single-backend host sends no runner)', async () => {
    const res = await post({ model: 'opus' });
    expect(res.status).toBe(201);
    expect(captured?.opts.model).toBe('opus');
    expect(captured?.opts.runner).toBeUndefined();
  });

  it('rejects an unknown runner with a 400 and never starts a run', async () => {
    const res = await post({ runner: 'gemini' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('404s for an unknown todo before validating the body', async () => {
    const res = await app.request('/api/todos/missing/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'gemini' }),
    });
    expect(res.status).toBe(404);
    expect(captured).toBeUndefined();
  });

  it('409s an already-started entry, override or not', async () => {
    writeTodos([
      { id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing', startedTaskId: 'run-9' },
    ]);
    const res = await post({ runner: 'codex' });
    expect(res.status).toBe(409);
    expect(captured).toBeUndefined();
  });
});
