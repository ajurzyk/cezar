import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import {
  buildClaudeArgs,
  ClaudeCliRunner,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import type { UiEvent } from './ui-events.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Extra rules.\n\n---\n\nContract.');
  });

  it('omits the flag entirely when no systemPrompt is set', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--append-system-prompt');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

/** A stand-in `claude` whose streams and signals the test drives by hand.
 *  Module scope because two suites need it: the escalation cases below (fake
 *  timers, no result awaited) and the timeout-diagnostics cases at the end of
 *  the file (real timers, result awaited). */
function signallableChild(): {
  child: ChildProcessWithoutNullStreams;
  signals: NodeJS.Signals[];
  exit: (code: number) => void;
} {
  const signals: NodeJS.Signals[] = [];
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    pid: 4242,
    // Node's semantics: delivery flips `killed`; a CLI with its own handler
    // keeps running with `exitCode` still null.
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      Object.assign(child, { killed: true });
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  const exit = (code: number) => {
    Object.assign(child, { exitCode: code });
    emitter.emit('exit', code, null);
  };
  return { child, signals, exit };
}

/**
 * #844 — the watchdogs used to ask `!child.killed` before escalating, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * SIGKILL that exists for exactly that case was never sent — one leaked CLI per
 * teardown. The escalation now follows real termination instead.
 */
describe('SIGTERM→SIGKILL escalation for a CLI that survives SIGTERM', () => {
  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('escalates after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

/**
 * #48 — what a wall-clock kill leaves behind.
 *
 * `handleClaudeMessage` returns 0 for every assistant frame on purpose
 * (upstream #716: the terminal `result` frame already aggregates them), so the
 * `if (delta > 0)` branch never fires before that frame and no `token-usage`
 * event is ever emitted. A killed step therefore reports `tokensUsed: 0` and no
 * cost — byte-identical to a step that did nothing. Measured on the run that
 * prompted this: 30 minutes, 198 tool calls, `grep -c '"type":"token-usage"'`
 * → 0.
 *
 * The runner already knows better — `sawUsage` is false and it emits a note for
 * exactly this — but the timeout path returns before that line is reachable.
 *
 * These cases drive the fake child on REAL timers with a short cap, because
 * unlike the escalation suite above they await `session.result`, which means
 * the NDJSON reader and `waitForExit` both have to make real progress.
 */
describe('what a wall-clock timeout reports (#48)', () => {
  const TIMEOUT_MS = 400;
  const LOST_ACCOUNTING = 'token accounting lost — the step was killed before its result frame';

  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Feed `frames` to the child, wait for `consumed` to prove they were read
   *  BEFORE the wall clock fires, then let the clock fire and the child exit. */
  async function eventsFromTimedOutSession(
    frames: unknown[],
    consumed: (events: AgentEvent[]) => boolean,
  ): Promise<AgentEvent[]> {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    const events: AgentEvent[] = [];
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: TIMEOUT_MS }).startSession(
        { userPrompt: 'do it', cwd: process.cwd() },
        (event) => events.push(event),
      );
      for (const frame of frames) fake.child.stdout.write(`${JSON.stringify(frame)}\n`);
      // A frame still unread when the clock fires would silently weaken the
      // assertion below, so prove it landed first rather than hoping it did.
      await waitUntil(() => consumed(events), 'the seeded frames to be consumed');
      await waitUntil(() => fake.signals.includes('SIGTERM'), 'the wall clock to fire');
      // claude installs its own SIGTERM handler and exits 143 rather than dying
      // from the signal — the same shape `isSignalTerminationExit` covers.
      fake.exit(143);
      await session.result;
    } finally {
      spawnHook.override = null;
    }
    return events;
  }

  const assistantWithToolCalls = (n: number) => ({
    type: 'assistant',
    message: {
      content: Array.from({ length: n }, (_, i) => ({
        type: 'tool_use',
        id: `toolu_${i}`,
        name: 'Bash',
        input: { command: 'true' },
      })),
    },
  });

  it('a timed-out session reports that its accounting was lost', async () => {
    const events = await eventsFromTimedOutSession(
      [assistantWithToolCalls(1)],
      (e) => e.some((event) => event.type === 'tool-call'),
    );

    expect(events.some((e) => e.type === 'error' && e.message.includes('timed out after'))).toBe(true);
    // Exact text, so the note and this assertion cannot drift apart.
    expect(events.some((e) => e.type === 'note' && e.message === LOST_ACCOUNTING)).toBe(true);
    expect(events.some((e) => e.type === 'token-usage')).toBe(false);
  }, 15_000);

  it('a timeout after a result frame does not claim the accounting was lost', async () => {
    // A multi-turn session whose FIRST turn settled normally: the result frame
    // carried the aggregate usage, so nothing was lost when the clock later
    // killed the session mid-second-turn. Claiming otherwise would be a lie in
    // exactly the path the note is least able to be checked by hand.
    const events = await eventsFromTimedOutSession(
      [
        {
          type: 'result',
          subtype: 'success',
          result: 'first turn done',
          usage: { input_tokens: 1_270, output_tokens: 185 },
        },
      ],
      (e) => e.some((event) => event.type === 'turn-end'),
    );

    expect(events.some((e) => e.type === 'token-usage')).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.message.includes('timed out after'))).toBe(true);
    expect(events.some((e) => e.type === 'note' && e.message === LOST_ACCOUNTING)).toBe(false);
  }, 15_000);

  it('the timeout message names how many tool calls were observed', async () => {
    // The whole point: `timed out after 30m and was killed` cannot tell a hung
    // agent (0 tool calls) from a busy one (198) — the two need opposite fixes.
    const events = await eventsFromTimedOutSession(
      [assistantWithToolCalls(3)],
      (e) => e.filter((event) => event.type === 'tool-call').length === 3,
    );

    const error = events.find((e) => e.type === 'error');
    expect(error?.message).toContain('(3 tool calls observed)');
  }, 15_000);

  it('says "1 tool call" rather than "1 tool calls"', async () => {
    const events = await eventsFromTimedOutSession(
      [assistantWithToolCalls(1)],
      (e) => e.some((event) => event.type === 'tool-call'),
    );

    expect(events.find((e) => e.type === 'error')?.message).toContain('(1 tool call observed)');
  }, 15_000);
});
