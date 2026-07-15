/**
 * Golden tests for the claude stream-json → v2 mapper: each fixture in
 * `__fixtures__/claude/` is a wire-faithful NDJSON stdout transcript
 * (shapes from `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md`
 * §1 and the dry-run mock `scripts/mock-claude.mjs`); its `.expected.json`
 * is the EXACT `UiEvent` sequence the mapper must produce. Plus edge cases
 * (never-throw, state carry-over) and a live wiring test through the real
 * runner against the bundled mock CLI.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.js';
import type { UiEvent } from './ui-events.js';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  type ClaudeUiMapperState,
  type ClaudeUiMapping,
} from './claude-ui-mapper.js';
import { ClaudeCliRunner } from './claude-cli-runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'claude');

/** Replay a fixture exactly as the runner drives the mapper: the seed user
 *  message is sent (turn start) BEFORE the first stdout line is read, and
 *  unparseable lines are skipped. */
function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createClaudeUiState();
  const events: UiEvent[] = [];
  const push = (mapped: ClaudeUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(claudeTurnStarted(state));
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // mirrors the runner: malformed lines are skipped
    }
    push(mapClaudeMessage(msg, state));
  }
  return events;
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

const GOLDEN_FIXTURES = [
  'text-turn',
  'bash-and-screenshot',
  'thinking-edit-write-todo',
  'subagent-task',
  'failed-and-denied',
] as const;

describe('claude → v2 golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      // Round-trip through JSON so stray `undefined` properties fail loudly —
      // these events get persisted as NDJSON in step 2.1.
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(expectedEvents(fixture));
    });
  }
});

describe('mapClaudeMessage edge cases', () => {
  const state = createClaudeUiState();

  it('non-object and unknown message types produce no events and never throw', () => {
    for (const msg of [null, undefined, 42, 'assistant', [], {}, { type: 'stream_event', event: {} }, { type: 'control_request' }]) {
      const mapped = mapClaudeMessage(msg, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('unknown content block types inside an assistant message are ignored', () => {
    const mapped = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'x' },
            'not-a-block',
            { type: 'tool_use' }, // missing id/name → skipped
            { type: 'text', text: 'still works' },
          ],
        },
      },
      state,
    );
    expect(mapped.events.map((e) => e.type)).toEqual(['item.started', 'item.completed']);
  });

  it('malformed message envelopes (content not an array, message missing) are safe', () => {
    expect(mapClaudeMessage({ type: 'assistant', message: { content: 'oops' } }, state).events).toEqual([]);
    expect(mapClaudeMessage({ type: 'assistant' }, state).events).toEqual([]);
    expect(mapClaudeMessage({ type: 'user', message: { content: [{ type: 'tool_result' }] } }, state).events).toEqual([]);
  });

  it('state carries across messages: a tool opened earlier is completed by a later result', () => {
    let s = createClaudeUiState();
    s = mapClaudeMessage({ type: 'system', subtype: 'init', session_id: 's1' }, s).state;
    const start = mapClaudeMessage(
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] },
      },
      s,
    );
    s = start.state;
    // An unrelated message in between must not disturb the open tool.
    s = mapClaudeMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hm' }] } }, s).state;
    const done = mapClaudeMessage(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'a b c' }] } },
      s,
    );
    expect(done.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'toolu_x',
          name: 'Bash',
          toolKind: 'execute',
          title: 'Ran ls',
          status: 'completed',
          input: { command: 'ls' },
          output: 'a b c',
        },
      },
    ]);
    // The open-tool map is consumed…
    expect(done.state.openTools.has('toolu_x')).toBe(false);
    // …without mutating the previous state (explicit-state contract).
    expect(s.openTools.has('toolu_x')).toBe(true);
  });

  it('a tool_result for an id that never started still completes an item', () => {
    const mapped = mapClaudeMessage(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: 'late', is_error: true }] } },
      state,
    );
    expect(mapped.events).toEqual([
      {
        type: 'item.completed',
        item: { kind: 'tool', id: 'toolu_ghost', name: 'unknown', toolKind: 'other', title: 'Tool', status: 'failed', error: 'late' },
      },
    ]);
  });

  it('maps result subtypes onto stop reasons per §7.1', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'result', subtype: 'success' }, 'end_turn'],
      [{ type: 'result', subtype: 'error_max_turns', is_error: true }, 'max_tokens'],
      [{ type: 'result', subtype: 'error_during_execution', is_error: true }, 'error'],
      [{ type: 'result', subtype: 'something_new', is_error: true }, 'error'],
      [{ type: 'result' }, 'end_turn'],
    ];
    for (const [msg, stopReason] of cases) {
      const [event] = mapClaudeMessage(msg, state).events;
      expect(event).toMatchObject({ type: 'turn.completed', stopReason });
    }
  });

  it('result without usage emits turn.completed but no usage.updated', () => {
    const mapped = mapClaudeMessage({ type: 'result', subtype: 'success' }, state);
    expect(mapped.events.map((e) => e.type)).toEqual(['turn.completed']);
  });

  it('TodoWrite with malformed todos filters bad entries; non-array todos emit no plan', () => {
    const good = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_t',
              name: 'TodoWrite',
              input: { todos: [{ content: 'ok', status: 'pending' }, { content: 'bad status', status: 'later' }, { status: 'pending' }, 'junk'] },
            },
          ],
        },
      },
      state,
    );
    expect(good.events.at(-1)).toEqual({ type: 'plan.updated', entries: [{ content: 'ok', status: 'pending' }] });

    const bad = mapClaudeMessage(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_t2', name: 'TodoWrite', input: { todos: 'nope' } }] } },
      state,
    );
    expect(bad.events.map((e) => e.type)).toEqual(['item.started']);
  });

  it('init without session_id falls back to the state fallback (dry-run mock shape)', () => {
    const s = createClaudeUiState({ fallbackSessionId: 'spec-session' });
    const [event] = mapClaudeMessage({ type: 'system', subtype: 'init' }, s).events;
    expect(event).toEqual({ type: 'session.started', sessionId: 'spec-session', backend: 'claude' });
  });

  it('turn.started minted before init is flushed right after session.started', () => {
    let s = createClaudeUiState();
    const first = claudeTurnStarted(s);
    expect(first.events).toEqual([]); // queued — session.started must be first
    s = first.state;
    const init = mapClaudeMessage({ type: 'system', subtype: 'init', session_id: 's1' }, s);
    expect(init.events.map((e) => e.type)).toEqual(['session.started', 'turn.started']);
    s = init.state;
    const second = claudeTurnStarted(s);
    expect(second.events).toEqual([{ type: 'turn.started', turnId: 'turn_2' }]);
  });
});

describe('ClaudeCliRunner v2 wiring (against the bundled mock CLI)', () => {
  const mockBin = join(HERE, '..', '..', 'scripts', 'mock-claude.mjs');

  it('emits v2 events through opts.onUiEvent while v1 events keep flowing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cez-ui-mapper-'));
    try {
      const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
      const v1: AgentEvent[] = [];
      const v2: UiEvent[] = [];
      const session = runner.startSession(
        { userPrompt: 'fix the login redirect', cwd, sessionId: 'sess-mock-1' },
        (e) => v1.push(e),
        { autoEndAfterFirstTurn: true, onUiEvent: (e) => v2.push(e) },
      );
      await session.result;

      // v1 stays intact (old NDJSON recordings must keep replaying).
      const v1Types = v1.map((e) => e.type);
      expect(v1Types).toContain('text');
      expect(v1Types).toContain('tool-call');
      expect(v1Types).toContain('tool-result');
      expect(v1Types).toContain('turn-end');
      expect(v1Types).toContain('done');

      // v2 rides alongside: session.started first (mock init has no
      // session_id → spec.sessionId fallback), then the queued turn.started.
      expect(v2[0]).toEqual({ type: 'session.started', sessionId: 'sess-mock-1', backend: 'claude' });
      expect(v2[1]).toEqual({ type: 'turn.started', turnId: 'turn_1' });
      const bashStart = v2.find(
        (e): e is Extract<UiEvent, { type: 'item.started' }> =>
          e.type === 'item.started' && e.item.kind === 'tool' && e.item.name === 'Bash',
      );
      expect(bashStart?.item).toMatchObject({ toolKind: 'execute', title: 'Ran git status --short', status: 'running' });
      const bashDone = v2.find(
        (e): e is Extract<UiEvent, { type: 'item.completed' }> =>
          e.type === 'item.completed' && e.item.kind === 'tool' && e.item.name === 'Bash',
      );
      expect(bashDone?.item).toMatchObject({ status: 'completed', output: ' M src/example.ts' });
      expect(v2.some((e) => e.type === 'image' && e.itemId !== undefined)).toBe(true);
      const turnDone = v2.find((e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
      expect(turnDone).toMatchObject({
        turnId: 'turn_1',
        stopReason: 'end_turn',
        usage: { input: 1270, output: 185, total: 1455 },
        costUsd: 0.0342,
      });
      expect(v2.at(-1)?.type).toBe('usage.updated');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
