import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HANDOFF_INSTRUCTIONS, HANDOFF_ONLY_INSTRUCTIONS } from '../handoff.js';
import { RunStore } from '../runs/store.js';
import type { WorkflowDef } from './types.js';
import { RunManager, composeSystemPrompt, resolveExtraSystemPrompt } from './run.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Precedence table (R2 2.3): per-run override REPLACES the config default. */
describe('resolveExtraSystemPrompt', () => {
  it.each([
    ['neither set', undefined, undefined, undefined],
    ['config only', undefined, 'Config prompt', 'Config prompt'],
    ['override only', 'Override prompt', undefined, 'Override prompt'],
    ['both set — override wins outright', 'Override prompt', 'Config prompt', 'Override prompt'],
    ['blank override does not shadow the config default', '   ', 'Config prompt', 'Config prompt'],
    ['override is trimmed', '  Override prompt  ', undefined, 'Override prompt'],
    ['both blank', '', '   ', undefined],
  ] as const)('%s', (_name, override, configDefault, expected) => {
    expect(resolveExtraSystemPrompt(override, configDefault)).toBe(expected);
  });
});

/** Fixed part order: skill body → extra prompt → handoff contract. */
describe('composeSystemPrompt', () => {
  const H = 'HANDOFF CONTRACT';
  it.each([
    ['contract only', [undefined, undefined, H], H],
    ['skill + contract (the pre-2.3 composition, unchanged)', ['SKILL BODY', undefined, H], `SKILL BODY\n\n---\n\n${H}`],
    ['extra + contract', [undefined, 'EXTRA', H], `EXTRA\n\n---\n\n${H}`],
    ['skill + extra + contract', ['SKILL BODY', 'EXTRA', H], `SKILL BODY\n\n---\n\nEXTRA\n\n---\n\n${H}`],
    ['blank parts drop out', ['', '   ', H], H],
  ] as const)('%s', (_name, parts, expected) => {
    expect(composeSystemPrompt(...parts)).toBe(expected);
  });
});

/**
 * End-to-end through the real engine with CEZ_DRY_RUN=1: the config default
 * and the per-run override must reach the claude CLI's argv verbatim
 * (`--append-system-prompt`, captured via the mock's CEZ_MOCK_ARGS_FILE hook)
 * and be echoed on the RunRecord.
 */
describe('systemPrompt end-to-end (dry run)', () => {
  const CONFIG_PROMPT = 'CONFIG-DEFAULT: always write tests first.';
  const OVERRIDE_PROMPT = 'PER-RUN OVERRIDE: answer in bullet points.';
  let repoRoot: string;
  let argsFile: string;
  let inheritedTodos: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sysprompt-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    inheritedTodos = join(repoRoot, 'inherited-todos.json');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_TODOS_FILE = process.env.CEZ_TODOS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    process.env.CEZ_DRY_RUN = '1';
    // The global inbox is opt-in (#471). These assertions are about prompt composition and the
    // per-run opt-out, so they run on an inbox-enabled server; the gate itself is covered by
    // the suite below.
    process.env.CEZ_FOLLOWUPS = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    // Simulate a nested cezar (an agent running `cez serve` / the test suite):
    // the parent process already carries CEZ_TODOS_FILE. Runners spawn with
    // `{ ...process.env, ...spec.env }`, so `agentEnv` must *shadow* this for
    // every run — never merely omit the key — or an opted-out agent writes
    // follow-ups into the parent's inbox. Asserted per test below.
    process.env.CEZ_TODOS_FILE = inheritedTodos;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ systemPrompt: CONFIG_PROMPT, maxParallel: 1 }),
      'utf8',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Agent step + trailing check so the agent step is non-interactive — the
  // session auto-ends after the mock's turn and the run reaches a terminal
  // status instead of parking at `waiting`.
  const workflow: WorkflowDef = {
    name: 'sysprompt-test',
    source: 'built-in',
    steps: [
      { id: 'work', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  async function runToEnd(input: {
    task: string;
    systemPrompt?: string;
    generateFollowups?: boolean;
  }): Promise<string> {
    writeFileSync(argsFile, '', 'utf8'); // fresh capture per run
    const record = manager.startRun(workflow, input);
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  function capturedSystemPrompt(index = 0): string {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(index);
    const argv = JSON.parse(lines[index] as string) as string[];
    const idx = argv.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    return argv[idx + 1] as string;
  }

  it('no override: the config default reaches the CLI and is echoed on the record', async () => {
    const id = await runToEnd({ task: 'do the thing' });
    const record = store.getRun(id);
    expect(record?.status).toMatch(/^(done|review)$/);
    expect(record?.systemPrompt).toBe(CONFIG_PROMPT);
    const prompt = capturedSystemPrompt();
    // Composition: extra prompt first (no skill on this step), contract last.
    expect(prompt).toBe(composeSystemPrompt(CONFIG_PROMPT, HANDOFF_INSTRUCTIONS));
  }, 30_000);

  it('override: replaces the config default in argv and in the record echo', async () => {
    const id = await runToEnd({ task: 'do the thing', systemPrompt: OVERRIDE_PROMPT });
    const record = store.getRun(id);
    expect(record?.systemPrompt).toBe(OVERRIDE_PROMPT);
    const prompt = capturedSystemPrompt();
    expect(prompt).toBe(composeSystemPrompt(OVERRIDE_PROMPT, HANDOFF_INSTRUCTIONS));
    expect(prompt).not.toContain(CONFIG_PROMPT);
  }, 30_000);

  // The positive control for the opt-out test below: without this, mistyping the `!== false`
  // guard would stop every run from producing inbox entries with the whole suite still green.
  it('on an inbox-enabled server the agent gets the run own inbox, never an inherited one', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    rmSync(inheritedTodos, { force: true });
    await runToEnd({ task: 'do the thing with follow-ups' });
    expect(capturedSystemPrompt()).toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(true);
    expect(existsSync(inheritedTodos)).toBe(false);
  }, 30_000);

  it('explicit opt-out keeps handoff behavior but removes inbox prompt and environment', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    rmSync(inheritedTodos, { force: true });
    const id = await runToEnd({ task: 'do the thing quietly', generateFollowups: false });
    const record = store.getRun(id);
    expect(record?.generateFollowups).toBe(false);
    expect(capturedSystemPrompt()).toBe(composeSystemPrompt(CONFIG_PROMPT, HANDOFF_ONLY_INSTRUCTIONS));
    expect(capturedSystemPrompt()).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    // The opt-out must survive an inherited CEZ_TODOS_FILE (nested cezar):
    // omitting the key instead of shadowing it leaks into the parent's inbox.
    expect(existsSync(inheritedTodos)).toBe(false);
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.handoff.md`), 'utf8')).toContain(
      'mock: implemented the change',
    );

    expect(manager.continueRun(id, 'continue without generating follow-ups')).toEqual({ ok: true });
    const deadline = Date.now() + 20_000;
    while (readFileSync(argsFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('continuation did not start in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(capturedSystemPrompt(1)).toBe(
      composeSystemPrompt(CONFIG_PROMPT, HANDOFF_ONLY_INSTRUCTIONS),
    );
    expect(capturedSystemPrompt(1)).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    expect(existsSync(inheritedTodos)).toBe(false);
  }, 30_000);
});

/**
 * The global inbox gate, end-to-end through the real engine (#471).
 *
 * This drives `RunManager` directly — the same door `cezar run` and the inbox's own "▶ Run" use,
 * and the reason the ceiling lives in the manager rather than in the HTTP route. A route-level
 * gate would leave every one of those callers writing todos.json on a server that has the inbox
 * off.
 */
describe('the global follow-up gate (dry run)', () => {
  const CONFIG_PROMPT = 'CONFIG-DEFAULT: always write tests first.';
  let repoRoot: string;
  let argsFile: string;
  let inheritedTodos: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-followup-gate-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    inheritedTodos = join(repoRoot, 'inherited-todos.json');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_TODOS_FILE = process.env.CEZ_TODOS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    // A parent cezar's inbox, as in the suite above: the gate must not leak into it either.
    process.env.CEZ_TODOS_FILE = inheritedTodos;
    delete process.env.CEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ systemPrompt: CONFIG_PROMPT, maxParallel: 1 }),
      'utf8',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const workflow: WorkflowDef = {
    name: 'gate-probe',
    description: 'one step, no skill',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  async function runToEnd(input: { task: string; generateFollowups?: boolean }): Promise<string> {
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(workflow, input);
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  const capturedSystemPrompt = (index = 0): string => {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    const argv = JSON.parse(lines[index] as string) as string[];
    return argv[argv.indexOf('--append-system-prompt') + 1] as string;
  };

  it('without CEZ_FOLLOWUPS the agent is never told about the inbox', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    rmSync(inheritedTodos, { force: true });

    const id = await runToEnd({ task: 'do the thing mock:done' });

    expect(capturedSystemPrompt()).toBe(composeSystemPrompt(CONFIG_PROMPT, HANDOFF_ONLY_INSTRUCTIONS));
    expect(capturedSystemPrompt()).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    // …and nothing leaked into the parent cezar's inbox either.
    expect(existsSync(inheritedTodos)).toBe(false);
    // The record agrees, so a later continuation reads the same answer.
    expect(store.getRun(id)?.generateFollowups).toBe(false);
  }, 30_000);

  it('keeps the per-task handoff journal — #471 turns off the inbox, not the notes', async () => {
    const id = await runToEnd({ task: 'do the thing mock:done' });
    expect(capturedSystemPrompt()).toContain('CEZ_HANDOFF_FILE');
    expect(capturedSystemPrompt()).toContain('CEZ:DONE');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.handoff.md`), 'utf8')).toContain(
      'mock: implemented the change',
    );
  }, 30_000);

  it('a client asking for follow-ups cannot override the gate', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    const id = await runToEnd({ task: 'do the thing mock:done', generateFollowups: true });
    expect(capturedSystemPrompt()).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    expect(store.getRun(id)?.generateFollowups).toBe(false);
  }, 30_000);

  it('turning the flag on restores the inbox for a new run', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    process.env.CEZ_FOLLOWUPS = '1';
    try {
      await runToEnd({ task: 'do the thing with follow-ups mock:done' });
      expect(capturedSystemPrompt()).toContain('CEZ_TODOS_FILE');
      expect(existsSync(todosFile)).toBe(true);
    } finally {
      delete process.env.CEZ_FOLLOWUPS;
    }
  }, 30_000);
});
