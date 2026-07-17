import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import type { TodoItem } from '../todos.js';
import { createApp } from './server.js';

/**
 * `POST /api/todos/:id/start` (spec 007, extended by #413): the "▶ Run" flow that turns an
 * inbox entry into a task. #413 adds an OPTIONAL `prompt` body field — extra instructions (e.g.
 * a prompt template inserted in the Inbox composer) appended to the suggested/summary task text.
 * A request with no body at all (the pre-#413 client) must behave exactly as before — that is
 * this file's main contract; 404/409 are pinned too since nothing else covered this route.
 */
describe('POST /api/todos/:id/start', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
  };

  beforeEach(() => {
    // #471 (merged from main): the follow-up inbox is opt-in and this route 409s without the
    // capability. These assertions are about the #413 prompt field, so it is switched on
    // explicitly rather than inherited from whatever the dev box exports.
    process.env.CEZ_FOLLOWUPS = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todos-start-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
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

  const start = (id: string, body?: unknown) =>
    app.request(`/api/todos/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  it('404s an unknown id', async () => {
    writeTodos([]);
    const res = await start('nope');
    expect(res.status).toBe(404);
    expect(captured).toBeUndefined();
  });

  it('409s an already-started entry', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', startedTaskId: 'run-9' }]);
    const res = await start('t1');
    expect(res.status).toBe(409);
    expect(captured).toBeUndefined();
  });

  it('a request with no body at all keeps the pre-#413 task exactly (backward compat)', async () => {
    writeTodos([
      { id: 't1', summary: 'Ship it', suggestedPrompt: 'Ship the release notes', suggestedArgs: '--dry-run' },
    ]);
    const res = await start('t1');
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship the release notes\n\nArguments: --dry-run');
  });

  it('an extra prompt is appended after suggestedArgs, separated by a blank line', async () => {
    writeTodos([
      { id: 't1', summary: 'Ship it', suggestedPrompt: 'Ship the release notes', suggestedArgs: '--dry-run' },
    ]);
    const res = await start('t1', { prompt: 'Also update the changelog.' });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe(
      'Ship the release notes\n\nArguments: --dry-run\n\nAlso update the changelog.',
    );
  });

  it('an entry with neither suggestedPrompt nor suggestedArgs still takes the extra prompt', async () => {
    writeTodos([{ id: 't1', summary: 'Rerun the failed checks' }]);
    const res = await start('t1', { prompt: 'Focus on the flaky one.' });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Rerun the failed checks\n\nFocus on the flaky one.');
  });

  it('a whitespace-only prompt degrades to absent — not appended, not a 400', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: '   ' });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it');
  });

  it('an empty body object behaves exactly like no body', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', {});
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it');
  });

  it('accepts exactly 20k prompt characters', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: 'x'.repeat(20_000) });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe(`Ship it\n\n${'x'.repeat(20_000)}`);
  });

  it('rejects an over-cap prompt with a 400, and never starts a run', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: 'x'.repeat(20_001) });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
    // The entry must still be startable afterwards — a rejected body must not half-consume it.
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a malformed JSON body with a 400 — it must not pass as "no body"', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await app.request('/api/todos/t1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt": "unterminated',
    });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
    expect(store.listRuns()).toHaveLength(0);
  });

  it('a zero-length body is still the body-less case, not a 400', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await app.request('/api/todos/t1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it');
  });

  it('rejects a non-string prompt with a 400', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: 42 });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('the suggested skill still becomes the one-off workflow when the prompt is extended', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', suggestedSkill: 'nonexistent-skill' }]);
    const res = await start('t1', { prompt: 'Extra note.' });
    // No such skill on disk in this scratch repo → falls back to quick-task, same as before #413.
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it\n\nExtra note.');
  });
});
