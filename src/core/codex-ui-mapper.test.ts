/**
 * Golden tests for the codex app-server → v2 mapper: each fixture in
 * `__fixtures__/codex/` is a JSONL frame transcript (shapes from
 * `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §3); its
 * `.expected.json` is the EXACT `UiEvent` sequence the mapper must produce.
 * All are wire-faithful except `todo-list`, which pins the tolerance arm for
 * codex's non-app-server transports — see the note on GOLDEN_FIXTURES.
 * Plus edge cases (never-throw, status map, state carry-over, no fabricated
 * cost) and a live wiring test through the real runner against the bundled
 * mock app-server.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.js';
import type { UiEvent, UiItem } from './ui-events.js';
import { codexSessionStarted, createCodexUiState, mapCodexNotification } from './codex-ui-mapper.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'codex');

/** Replay a fixture exactly as the runner drives the mapper: every parsed
 *  JSONL frame is folded in order, unparseable lines are skipped. (The
 *  fixtures carry the `thread/started` notification the real server sends,
 *  so the runner's result-path `codexSessionStarted` call is a dedup no-op.) */
function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createCodexUiState();
  const events: UiEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // mirrors the runner: malformed lines are skipped
    }
    const mapped = mapCodexNotification(msg, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return events;
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

const GOLDEN_FIXTURES = [
  'text-turn',
  'command-lifecycle',
  'file-change-and-mcp',
  // NOT app-server wire truth: codex has no `todoList` item and no `item/updated`
  // method. It pins the mapper's tolerance arm for codex's other transports only.
  // `turn-plan-updated` is the real app-server plan channel.
  'todo-list',
  'turn-plan-updated',
  'turn-failed',
  'review-mode',
] as const;

describe('codex → v2 golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      // Round-trip through JSON so stray `undefined` properties fail loudly —
      // these events get persisted as NDJSON in step 2.1.
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(expectedEvents(fixture));
    });
  }
});

describe('mapCodexNotification edge cases', () => {
  const state = createCodexUiState();

  it('malformed frames produce no events and never throw', () => {
    const frames: unknown[] = [
      null,
      undefined,
      42,
      'turn/started',
      [],
      {},
      { method: 5 },
      { id: 1, result: { thread: { id: 'th_1' } } }, // response — attributed by the runner, not the mapper
      { id: 2, error: { code: -32600, message: 'bad' } },
      // server→client REQUEST (approval prompt) — reserved for permission.*
      { id: 3, method: 'item/commandExecution/requestApproval', params: { itemId: 'x' } },
      { method: 'thread/status/changed', params: { status: 'active' } }, // unknown method
      { method: 'item/started' }, // no params
      { method: 'item/started', params: { item: 'oops' } },
      { method: 'item/started', params: { item: {} } }, // no type
      { method: 'item/started', params: { item: { type: 'commandExecution' } } }, // no id
      { method: 'item/agentMessage/delta', params: { delta: 'x' } }, // no itemId
      { method: 'item/agentMessage/delta', params: { itemId: 'a', delta: '' } }, // empty delta
      { method: 'thread/tokenUsage/updated', params: {} }, // no tokenUsage.total
      { method: 'thread/started', params: {} }, // no thread id
      // A garbled plan frame must not wipe a good plan — no `plan` array at all,
      // or one that is not an array, maps to zero events (not an empty plan).
      { method: 'turn/plan/updated', params: {} },
      { method: 'turn/plan/updated', params: { plan: 'oops' } },
      { method: 'turn/plan/updated', params: { plan: null } },
    ];
    for (const frame of frames) {
      const mapped = mapCodexNotification(frame, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('maps wire item statuses per the §7.1 table (no regex-on-status)', () => {
    const cases: Array<[string | undefined, string, string]> = [
      // [wire status, lifecycle phase, expected v2 status]
      ['inProgress', 'item/started', 'running'],
      ['inProgress', 'item/updated', 'running'],
      ['completed', 'item/completed', 'completed'],
      ['failed', 'item/completed', 'failed'],
      ['declined', 'item/completed', 'declined'],
      // no/unknown wire status → derived from the lifecycle phase
      [undefined, 'item/started', 'running'],
      [undefined, 'item/updated', 'running'],
      [undefined, 'item/completed', 'completed'],
      ['somethingNew', 'item/started', 'running'],
      ['somethingNew', 'item/completed', 'completed'],
    ];
    for (const [status, method, expected] of cases) {
      const item: Record<string, unknown> = { type: 'commandExecution', id: 'item_s', command: 'ls' };
      if (status !== undefined) item.status = status;
      const [event] = mapCodexNotification({ method, params: { item } }, state).events;
      expect(event).toMatchObject({ item: { status: expected } });
    }
  });

  it('a status word containing "error" in command output never marks the tool failed', () => {
    // The v1 path guessed failure by regexing the serialized item; v2 must
    // trust the status field only.
    const [event] = mapCodexNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            id: 'item_e',
            command: 'npm test',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'error TS2304 mentioned in a passing grep\n',
          },
        },
      },
      state,
    ).events;
    expect(event).toMatchObject({ type: 'item.completed', item: { status: 'completed', exitCode: 0 } });
  });

  it('a delta before item/started synthesizes a minimal item.started to upsert into', () => {
    const text = mapCodexNotification(
      { method: 'item/agentMessage/delta', params: { itemId: 'item_a', delta: 'hi' } },
      state,
    );
    expect(text.events).toEqual([
      { type: 'item.started', item: { kind: 'message', id: 'item_a', role: 'assistant', text: '' } },
      { type: 'item.delta', itemId: 'item_a', field: 'text', delta: 'hi' },
    ]);
    // The synthesized start is minted once; the next delta rides alone.
    const next = mapCodexNotification(
      { method: 'item/agentMessage/delta', params: { itemId: 'item_a', delta: ' there' } },
      text.state,
    );
    expect(next.events).toEqual([{ type: 'item.delta', itemId: 'item_a', field: 'text', delta: ' there' }]);
    // …without mutating the previous state (explicit-state contract).
    expect(state.knownItems.has('item_a')).toBe(false);

    const reasoning = mapCodexNotification(
      { method: 'item/reasoning/textDelta', params: { itemId: 'item_r', delta: 'because' } },
      state,
    );
    expect(reasoning.events[0]).toEqual({
      type: 'item.started',
      item: { kind: 'reasoning', id: 'item_r', text: '' },
    });

    const output = mapCodexNotification(
      { method: 'item/commandExecution/outputDelta', params: { itemId: 'item_c', delta: '$ ls\n' } },
      state,
    );
    expect(output.events).toEqual([
      {
        type: 'item.started',
        item: { kind: 'tool', id: 'item_c', name: 'commandExecution', toolKind: 'execute', title: 'Ran', status: 'running' },
      },
      { type: 'item.delta', itemId: 'item_c', field: 'output', delta: '$ ls\n' },
    ]);
  });

  it('accumulated outputDelta text becomes the final snapshot output when the wire item has none', () => {
    let s = createCodexUiState();
    for (const delta of ['line 1\n', 'line 2\n']) {
      s = mapCodexNotification(
        { method: 'item/commandExecution/outputDelta', params: { itemId: 'item_c1', delta } },
        s,
      ).state;
    }
    const done = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_c1', command: 'ls', status: 'completed', exitCode: 0 } } },
      s,
    );
    expect(done.events[0]).toMatchObject({ item: { output: 'line 1\nline 2\n', exitCode: 0 } });
    // Bookkeeping is dropped once the item completes.
    expect(done.state.outputs.has('item_c1')).toBe(false);
    expect(done.state.knownItems.has('item_c1')).toBe(false);

    // A wire-carried output always wins over the accumulator.
    const wireWins = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_c1', command: 'ls', status: 'completed', aggregatedOutput: 'authoritative' } } },
      s,
    );
    expect(wireWins.events[0]).toMatchObject({ item: { output: 'authoritative' } });
  });

  it('item/completed for an item that never started still completes a full snapshot', () => {
    const mapped = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_ghost', command: 'pwd', status: 'completed', exitCode: 0 } } },
      state,
    );
    expect(mapped.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'item_ghost',
          name: 'commandExecution',
          toolKind: 'execute',
          title: 'Ran pwd',
          status: 'completed',
          input: { command: 'pwd' },
          exitCode: 0,
        },
      },
    ]);
  });

  it('maps turn frames onto stop reasons per §7.1', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } }, 'end_turn'],
      [{ method: 'turn/completed', params: { turn: { id: 't1', status: 'interrupted' } } }, 'cancelled'],
      [{ method: 'turn/failed', params: { turn: { id: 't1', status: 'failed' }, error: { message: 'boom' } } }, 'error'],
      [{ method: 'turn/failed', params: { turn: { id: 't1', status: 'failed' }, error: { message: 'Turn interrupted' } } }, 'cancelled'],
      [{ method: 'turn/failed', params: { turn: { id: 't1', status: 'interrupted' } } }, 'cancelled'],
      [{ method: 'turn/failed', params: { turn: { id: 't1' } } }, 'error'],
    ];
    for (const [frame, stopReason] of cases) {
      const [event] = mapCodexNotification(frame, state).events;
      expect(event).toEqual({ type: 'turn.completed', turnId: 't1', stopReason });
    }
  });

  it('mints deterministic fallback turn ids when frames carry none', () => {
    let s = createCodexUiState();
    const started = mapCodexNotification({ method: 'turn/started', params: {} }, s);
    expect(started.events).toEqual([{ type: 'turn.started', turnId: 'turn_1' }]);
    s = started.state;
    // The close pairs with the open it tracked.
    const done = mapCodexNotification({ method: 'turn/completed', params: {} }, s);
    expect(done.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
  });

  it('never fabricates a cost: codex usage and turn events carry no costUsd', () => {
    const [usage] = mapCodexNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total: { totalTokens: 10, inputTokens: 6, outputTokens: 4 }, last: {} } },
      },
      state,
    ).events;
    expect(usage).toEqual({ type: 'usage.updated', usage: { input: 6, output: 4, total: 10 } });
    expect(usage && 'costUsd' in usage).toBe(false);

    const [turn] = mapCodexNotification(
      { method: 'turn/completed', params: { turn: { id: 't9', status: 'completed' } } },
      state,
    ).events;
    expect(turn && 'costUsd' in turn).toBe(false);
    expect(turn && 'usage' in turn).toBe(false);
  });

  it('sums the parts when the wire total is missing', () => {
    const [event] = mapCodexNotification(
      { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 7, outputTokens: 2 } } } },
      state,
    ).events;
    expect(event).toEqual({ type: 'usage.updated', usage: { input: 7, output: 2, total: 9 } });
  });

  it('session.started is emitted once whichever path lands first', () => {
    let s = createCodexUiState();
    const viaNotification = mapCodexNotification(
      { method: 'thread/started', params: { thread: { id: 'th_1' } } },
      s,
    );
    expect(viaNotification.events).toEqual([{ type: 'session.started', sessionId: 'th_1', backend: 'codex' }]);
    // The runner's result-path call afterwards is a no-op…
    expect(codexSessionStarted('th_1', viaNotification.state).events).toEqual([]);
    // …and so is a duplicate notification after the result path.
    s = codexSessionStarted('th_2', createCodexUiState()).state;
    expect(mapCodexNotification({ method: 'thread/started', params: { thread: { id: 'th_2' } } }, s).events).toEqual([]);
  });

  it('todoList entries with malformed rows are filtered; a text-only plan item becomes one in-progress entry', () => {
    const [plan] = mapCodexNotification(
      {
        method: 'item/updated',
        params: {
          item: {
            type: 'todoList',
            id: 'item_t',
            items: [{ text: 'ok', completed: true }, { completed: false }, 'junk', { text: 'later', completed: false }],
          },
        },
      },
      state,
    ).events;
    expect(plan).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'ok', status: 'completed' },
        { content: 'later', status: 'pending' },
      ],
    });

    const [textPlan] = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Fix the redirect, then add tests' } } },
      state,
    ).events;
    expect(textPlan).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'Fix the redirect, then add tests', status: 'in_progress' }],
    });
  });

  it('review-mode items map to task tools; unknown item types stay visible as generic tools', () => {
    const [review] = mapCodexNotification(
      { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'item_rv' } } },
      state,
    ).events;
    expect(review).toEqual({
      type: 'item.started',
      item: { kind: 'tool', id: 'item_rv', name: 'enteredReviewMode', toolKind: 'task', title: 'Entered review mode', status: 'running' },
    });

    const [unknown] = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'item_cc' } } },
      state,
    ).events;
    expect(unknown).toMatchObject({
      type: 'item.completed',
      item: { kind: 'tool', id: 'item_cc', name: 'contextCompaction', toolKind: 'other', status: 'completed' },
    });
  });

  it("the user's own echoed message maps to zero events", () => {
    const mapped = mapCodexNotification(
      { method: 'item/started', params: { item: { type: 'userMessage', id: 'item_u', content: [{ type: 'text', text: 'hi' }] } } },
      state,
    );
    expect(mapped.events).toEqual([]);
  });

  // `turn/plan/updated` is the ONLY channel codex's `update_plan` reaches the
  // client on: the app-server v2 `ThreadItem` union has no todo variant, so a
  // plan that is not read off this notification never renders at all.
  describe('turn/plan/updated (the real update_plan channel)', () => {
    const planFrame = (plan: unknown) => ({
      method: 'turn/plan/updated',
      params: { threadId: 'th_1', turnId: 'turn_1', explanation: null, plan },
    });

    it('normalizes the wire status vocabulary, which is camelCase on app-server', () => {
      // `inProgress` is what the app-server layer re-serializes to, even though
      // codex's core protocol type spells it `in_progress` — accept both.
      const events = mapCodexNotification(
        planFrame([
          { step: 'a', status: 'pending' },
          { step: 'b', status: 'inProgress' },
          { step: 'c', status: 'in_progress' },
          { step: 'd', status: 'completed' },
        ]),
        state,
      ).events;
      expect(events).toEqual([
        {
          type: 'plan.updated',
          entries: [
            { content: 'a', status: 'pending' },
            { content: 'b', status: 'in_progress' },
            { content: 'c', status: 'in_progress' },
            { content: 'd', status: 'completed' },
          ],
        },
      ]);
    });

    it('treats an unknown or missing status as pending rather than dropping the step', () => {
      const events = mapCodexNotification(
        planFrame([{ step: 'a', status: 'sideways' }, { step: 'b' }]),
        state,
      ).events;
      expect(events).toEqual([
        { type: 'plan.updated', entries: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] },
      ]);
    });

    it('filters malformed steps but keeps the good ones', () => {
      const events = mapCodexNotification(
        planFrame(['oops', null, 42, { status: 'pending' }, { step: 5 }, { step: 'real', status: 'pending' }]),
        state,
      ).events;
      expect(events).toEqual([{ type: 'plan.updated', entries: [{ content: 'real', status: 'pending' }] }]);
    });

    it('emits an empty plan for an empty list — a cleared plan is a real snapshot', () => {
      expect(mapCodexNotification(planFrame([]), state).events).toEqual([{ type: 'plan.updated', entries: [] }]);
    });

    // "the agent cleared its plan" and "we could not parse the steps" both end up
    // as `[]` downstream, where the dock unmounts — so only the former may emit.
    it('a list whose every row is unreadable emits nothing rather than wiping the plan', () => {
      // e.g. a wire revision that renamed `step`, which would otherwise blank the dock.
      for (const plan of [[{ text: 'a' }, { text: 'b' }], ['junk'], [null], [{ step: 5 }], [{}]]) {
        expect(mapCodexNotification(planFrame(plan), state).events).toEqual([]);
      }
    });

    it('is full-replacement: the frame is the whole plan, with no entries accumulated', () => {
      // Contrast claude's id-keyed task map: nothing from the first frame may
      // survive into the second. The only state kept is the precedence latch.
      const first = mapCodexNotification(planFrame([{ step: 'a', status: 'completed' }]), state);
      const second = mapCodexNotification(planFrame([{ step: 'b', status: 'pending' }]), first.state);
      expect(second.events).toEqual([{ type: 'plan.updated', entries: [{ content: 'b', status: 'pending' }] }]);
      expect({ ...second.state, planFromNotification: false }).toEqual(state);

      // The latch settles after the first frame rather than churning state.
      const third = mapCodexNotification(planFrame([{ step: 'c', status: 'pending' }]), second.state);
      expect(third.state).toBe(second.state);
    });

    // Both this notification and the `plan`/`todoList` item arm write plan.updated.
    // Without precedence the last frame wins, flattening a real checklist into the
    // single prose entry the plan-MODE item carries.
    it('outranks the prose plan item: once it has spoken, the item arm stands down', () => {
      const afterPlan = mapCodexNotification(
        planFrame([{ step: 'one', status: 'completed' }, { step: 'two', status: 'inProgress' }]),
        state,
      );
      expect(afterPlan.state.planFromNotification).toBe(true);

      const prose = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Here is my prose plan…' } } },
        afterPlan.state,
      );
      expect(prose.events).toEqual([]);

      // …and a stray todoList snapshot is ignored for the same reason.
      const stray = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'todoList', id: 'item_t', items: [{ text: 'x', completed: false }] } } },
        afterPlan.state,
      );
      expect(stray.events).toEqual([]);
    });

    // The latch is turn-scoped. If it outlived its turn it would gag the item arm
    // for the rest of the session, stranding the dock on the previous turn's plan.
    it('re-opens the item arm on the next turn', () => {
      const latched = mapCodexNotification(planFrame([{ step: 'turn one', status: 'completed' }]), state);
      expect(latched.state.planFromNotification).toBe(true);

      const nextTurn = mapCodexNotification(
        { method: 'turn/started', params: { turn: { id: 'turn_2', status: 'inProgress' } } },
        latched.state,
      );
      expect(nextTurn.state.planFromNotification).toBe(false);

      const prose = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Turn two plan' } } },
        nextTurn.state,
      );
      expect(prose.events).toEqual([
        { type: 'plan.updated', entries: [{ content: 'Turn two plan', status: 'in_progress' }] },
      ]);
    });

    it('leaves the item arm alone until the notification actually arrives', () => {
      // The tolerance arm still works for transports that never send the notification.
      const prose = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Prose plan' } } },
        state,
      );
      expect(prose.events).toEqual([{ type: 'plan.updated', entries: [{ content: 'Prose plan', status: 'in_progress' }] }]);
    });

    it('ignores the explanation prose (the dock renders entries only)', () => {
      const events = mapCodexNotification(
        { method: 'turn/plan/updated', params: { threadId: 'th_1', turnId: 'turn_1', explanation: 'why', plan: [{ step: 'a', status: 'pending' }] } },
        state,
      ).events;
      expect(events).toEqual([{ type: 'plan.updated', entries: [{ content: 'a', status: 'pending' }] }]);
    });
  });
});

describe('CodexAppServerRunner v2 wiring (against the bundled mock app-server)', () => {
  const mockBin = join(FIXTURES, 'mock-codex-app-server.mjs');

  it('emits v2 events through opts.onUiEvent while v1 events keep flowing', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => v1.push(e),
      { autoEndAfterFirstTurn: true, onUiEvent: (e) => v2.push(e) },
    );
    await session.result;

    // v1 stays intact (old NDJSON recordings must keep replaying).
    const v1Types = v1.map((e) => e.type);
    expect(v1Types).toContain('session');
    expect(v1Types).toContain('text');
    expect(v1Types).toContain('tool-call');
    expect(v1Types).toContain('tool-result');
    expect(v1Types).toContain('token-usage');
    expect(v1Types).toContain('turn-end');
    expect(v1Types).toContain('done');

    // v2 rides alongside: session.started exactly once and first (the
    // thread/started notification and the thread/start result path dedup).
    expect(v2[0]).toEqual({ type: 'session.started', sessionId: 'th_mock_1', backend: 'codex' });
    expect(v2.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(v2.some((e) => e.type === 'turn.started' && e.turnId === 'turn_mock_1')).toBe(true);
    expect(v2).toContainEqual({ type: 'item.delta', itemId: 'item_c1', field: 'output', delta: ' M src/example.ts\n' });
    const cmdDone = v2.find(
      (e): e is Extract<UiEvent, { type: 'item.completed' }> =>
        e.type === 'item.completed' && e.item.kind === 'tool' && e.item.id === 'item_c1',
    );
    expect(cmdDone?.item).toMatchObject({
      toolKind: 'execute',
      title: 'Ran bash -lc git status --short',
      status: 'completed',
      output: ' M src/example.ts\n',
      exitCode: 0,
    });
    expect(v2).toContainEqual({ type: 'usage.updated', usage: { input: 1200, output: 300, total: 1500 } });
    expect(v2).toContainEqual({ type: 'turn.completed', turnId: 'turn_mock_1', stopReason: 'end_turn' });
  }, 30_000);
});

/**
 * #528 — reasoning text must survive into the persisted `item.completed`
 * snapshot. `item.delta`s are live-only (`UiEventSink` never writes them), so
 * a completed reasoning item that carries no `content` would replay empty.
 */
describe('codex reasoning text survives replay (#528)', () => {
  const THREAD = 'th_1';
  const TURN = 'turn_1';

  function fold(frames: unknown[]): UiEvent[] {
    let state = createCodexUiState();
    const events: UiEvent[] = [];
    for (const frame of frames) {
      const mapped = mapCodexNotification(frame, state);
      state = mapped.state;
      events.push(...mapped.events);
    }
    return events;
  }

  function completedReasoning(events: UiEvent[], id: string): UiItem | undefined {
    return events.find(
      (e): e is Extract<UiEvent, { type: 'item.completed' }> =>
        e.type === 'item.completed' && e.item.kind === 'reasoning' && e.item.id === id,
    )?.item;
  }

  const started = {
    method: 'item/started',
    params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1', summary: 'Tracing it' } },
  };
  const textDelta = (delta: string) => ({
    method: 'item/reasoning/textDelta',
    params: { threadId: THREAD, turnId: TURN, itemId: 'item_rsn_1', delta },
  });

  it('falls back to the accumulated deltas when item/completed carries no content', () => {
    const events = fold([
      started,
      textDelta('The session cookie '),
      textDelta('is dropped on refresh.'),
      // The real app-server may close a reasoning item with the summary only.
      {
        method: 'item/completed',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1', summary: 'Tracing it' } },
      },
    ]);
    expect(completedReasoning(events, 'item_rsn_1')).toEqual({
      kind: 'reasoning',
      id: 'item_rsn_1',
      text: 'The session cookie is dropped on refresh.',
    });
  });

  it('accumulates summaryDelta and summaryTextDelta on the same item', () => {
    const events = fold([
      started,
      { method: 'item/reasoning/summaryDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'item_rsn_1', delta: 'a' } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'item_rsn_1', delta: 'b' } },
      {
        method: 'item/completed',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1' } },
      },
    ]);
    expect(completedReasoning(events, 'item_rsn_1')).toMatchObject({ text: 'ab' });
  });

  it('wire content still wins over the accumulator', () => {
    const events = fold([
      started,
      textDelta('streamed'),
      {
        method: 'item/completed',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1', content: 'authoritative' } },
      },
    ]);
    expect(completedReasoning(events, 'item_rsn_1')).toMatchObject({ text: 'authoritative' });
  });

  it('does not leak one item’s reasoning into the next', () => {
    const events = fold([
      started,
      textDelta('first'),
      { method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1' } } },
      {
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_2', summary: 'Next' } },
      },
      { method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_2', summary: 'Next' } } },
    ]);
    expect(completedReasoning(events, 'item_rsn_2')).toMatchObject({ text: 'Next' });
  });
});
