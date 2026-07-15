import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HANDOFF_INSTRUCTIONS } from '../handoff.js';
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
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sysprompt-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
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

  async function runToEnd(input: { task: string; systemPrompt?: string }): Promise<string> {
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

  function capturedSystemPrompt(): string {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const argv = JSON.parse(lines[0] as string) as string[];
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
});
