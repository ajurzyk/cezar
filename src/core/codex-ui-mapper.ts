/**
 * Pure codex app-server JSON-RPC → protocol-v2 mapper. `mapCodexNotification`
 * folds one parsed JSONL frame into `UiEvent`s plus the next mapper state;
 * the runner calls it ALONGSIDE the v1 path (v1 events keep flowing
 * unchanged).
 *
 * Contract: `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §3
 * (wire format) and §7.1 "Codex (app-server)" (the mapping). Golden fixtures
 * replaying wire-faithful frame sequences live in `__fixtures__/codex/`.
 *
 * Robustness rule: input is untrusted wire data — the mapper never throws;
 * responses, server→client requests (approval prompts — reserved for the
 * `permission.*` events later) and unknown methods map to zero events.
 *
 * State is explicit and treated as immutable: callers thread the returned
 * `state` into the next call. Ids are deterministic — codex items and turns
 * carry stable wire ids which are reused verbatim (`turn_<n>` is minted only
 * when a turn frame arrives without one) — so replaying a stored transcript
 * reproduces the exact event sequence.
 *
 * Status map (§7.1, kills v1's regex-on-status hack): `inProgress→running`,
 * `completed→completed`, `failed→failed`, `declined→declined`.
 */

import type {
  FileDiff,
  PlanEntry,
  StopReason,
  TokenUsage,
  ToolLocation,
  ToolStatus,
  UiEvent,
  UiItem,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.js';
import { toolDisplay } from './tool-display.js';

export interface CodexUiMapperState {
  /** True once `session.started` was emitted (thread/started notification or
   *  the runner's `codexSessionStarted` after the thread/start result —
   *  whichever lands first wins; the other is deduplicated). */
  readonly sessionStarted: boolean;
  /** Fallback counter for turn frames that arrive without a wire turn id. */
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  /** Item ids already introduced — a delta for an unknown id synthesizes an
   *  `item.started` first so consumers always have something to upsert. */
  readonly knownItems: ReadonlySet<string>;
  /** Accumulated `outputDelta` text per commandExecution item, attached to
   *  the final snapshot when the wire `item/completed` carries no output. */
  readonly outputs: ReadonlyMap<string, string>;
}

export interface CodexUiMapping {
  events: UiEvent[];
  state: CodexUiMapperState;
}

export function createCodexUiState(): CodexUiMapperState {
  return {
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    knownItems: new Set(),
    outputs: new Map(),
  };
}

/**
 * Codex confirms the thread via the `thread/start`/`thread/resume` RESULT
 * (a response frame the mapper cannot attribute), so the runner calls this
 * once the thread id is known. Deduplicated against the `thread/started`
 * notification — whichever arrives first emits `session.started`.
 */
export function codexSessionStarted(threadId: string, state: CodexUiMapperState): CodexUiMapping {
  if (state.sessionStarted || threadId === '') return { events: [], state };
  return {
    events: [{ type: 'session.started', sessionId: threadId, backend: 'codex' }],
    state: { ...state, sessionStarted: true },
  };
}

/** Fold one parsed JSON-RPC frame into v2 events. Never throws. */
export function mapCodexNotification(frame: unknown, state: CodexUiMapperState): CodexUiMapping {
  if (!isRecord(frame) || typeof frame.method !== 'string') return { events: [], state };
  // A frame with both `method` and `id` is a server→client REQUEST (the
  // approval prompts) — reserved for `permission.requested` later.
  if (frame.id !== undefined) return { events: [], state };
  const params = isRecord(frame.params) ? frame.params : {};
  switch (frame.method) {
    case 'thread/started':
      return codexSessionStarted(threadIdOf(params) ?? '', state);
    case 'turn/started':
      return mapTurnStarted(params, state);
    case 'turn/completed':
      return mapTurnEnd(params, state, /* failed */ false);
    case 'turn/failed':
      return mapTurnEnd(params, state, /* failed */ true);
    case 'item/started':
      return mapItemLifecycle(params, state, 'item.started');
    case 'item/updated':
      return mapItemLifecycle(params, state, 'item.updated');
    case 'item/completed':
      return mapItemLifecycle(params, state, 'item.completed');
    case 'item/agentMessage/delta':
      return mapDelta(params, state, 'text');
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryDelta':
    case 'item/reasoning/summaryTextDelta':
      return mapDelta(params, state, 'reasoning');
    case 'item/commandExecution/outputDelta':
      return mapDelta(params, state, 'output');
    case 'thread/tokenUsage/updated':
      return mapTokenUsage(params, state);
    default:
      // thread/status/changed, thread/closed, … — nothing to render yet.
      return { events: [], state };
  }
}

// ---- turn lifecycle ---------------------------------------------------------

function mapTurnStarted(params: Record<string, unknown>, state: CodexUiMapperState): CodexUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = turnIdOf(params) ?? `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: { ...state, turnSeq, currentTurnId: turnId },
  };
}

function mapTurnEnd(
  params: Record<string, unknown>,
  state: CodexUiMapperState,
  failed: boolean,
): CodexUiMapping {
  let turnSeq = state.turnSeq;
  const turnId = turnIdOf(params) ?? state.currentTurnId ?? `turn_${++turnSeq}`;
  return {
    events: [{ type: 'turn.completed', turnId, stopReason: turnStopReason(params, failed) }],
    state: { ...state, turnSeq, currentTurnId: null },
  };
}

/** §7.1: turn/completed→end_turn, turn/failed→error — except an interrupted
 *  turn (turn.status `interrupted`, or an interrupt-shaped error message,
 *  the only wire signals codex gives us) → cancelled. */
function turnStopReason(params: Record<string, unknown>, failed: boolean): StopReason {
  const turn = isRecord(params.turn) ? params.turn : {};
  if (turn.status === 'interrupted') return 'cancelled';
  if (!failed) return 'end_turn';
  return /interrupt/i.test(errorMessage(params.error) ?? '') ? 'cancelled' : 'error';
}

// ---- item lifecycle ---------------------------------------------------------

type ItemEventType = 'item.started' | 'item.updated' | 'item.completed';

function mapItemLifecycle(
  params: Record<string, unknown>,
  state: CodexUiMapperState,
  eventType: ItemEventType,
): CodexUiMapping {
  const raw = isRecord(params.item) ? params.item : undefined;
  if (!raw || typeof raw.type !== 'string') return { events: [], state };
  const type = raw.type;

  // todoList / plan items never render as items — they ARE the plan
  // (full-replacement semantics on every lifecycle phase, §7.1).
  if (type === 'todoList' || type === 'plan') {
    const entries = planEntriesOf(raw);
    if (!entries) return { events: [], state };
    return { events: [{ type: 'plan.updated', entries }], state };
  }

  // The user's own message echoed back — the client already rendered what it
  // sent, so it maps to zero events (matching the claude mapper).
  if (type === 'userMessage') return { events: [], state };

  const id = str(raw.id);
  if (id === undefined) return { events: [], state };

  const item =
    type === 'agentMessage'
      ? messageItem(raw, id)
      : type === 'reasoning'
        ? reasoningItem(raw, id)
        : toolItem(raw, id, type, eventType, state);
  const events: UiEvent[] = [{ type: eventType, item }];

  // Track live ids (for delta synthesis) and drop bookkeeping on completion.
  if (eventType === 'item.completed') {
    if (!state.knownItems.has(id) && !state.outputs.has(id)) return { events, state };
    const knownItems = new Set(state.knownItems);
    knownItems.delete(id);
    const outputs = new Map(state.outputs);
    outputs.delete(id);
    return { events, state: { ...state, knownItems, outputs } };
  }
  if (state.knownItems.has(id)) return { events, state };
  return { events, state: { ...state, knownItems: new Set(state.knownItems).add(id) } };
}

/** `agentMessage` → message item; `phase` commentary|final_answer→'commentary'|'final'. */
function messageItem(raw: Record<string, unknown>, id: string): UiMessageItem {
  const item: UiMessageItem = {
    kind: 'message',
    id,
    role: 'assistant',
    text: typeof raw.text === 'string' ? raw.text : '',
  };
  if (raw.phase === 'commentary') item.phase = 'commentary';
  else if (raw.phase === 'final_answer') item.phase = 'final';
  return item;
}

/** `reasoning` → reasoning item — full `content` when present, else the summary. */
function reasoningItem(raw: Record<string, unknown>, id: string): UiReasoningItem {
  return { kind: 'reasoning', id, text: str(raw.content) ?? str(raw.summary) ?? '' };
}

/** The §7.1 status map — the wire word wins; an item without one derives its
 *  status from the lifecycle phase it arrived in. */
const STATUS_MAP: Readonly<Record<string, ToolStatus>> = {
  inProgress: 'running',
  completed: 'completed',
  failed: 'failed',
  declined: 'declined',
};

function toolStatus(raw: Record<string, unknown>, eventType: ItemEventType): ToolStatus {
  const mapped = typeof raw.status === 'string' ? STATUS_MAP[raw.status] : undefined;
  return mapped ?? (eventType === 'item.completed' ? 'completed' : 'running');
}

function toolItem(
  raw: Record<string, unknown>,
  id: string,
  type: string,
  eventType: ItemEventType,
  state: CodexUiMapperState,
): UiToolItem {
  const status = toolStatus(raw, eventType);
  let item: UiToolItem;

  switch (type) {
    case 'commandExecution': {
      const display = toolDisplay('commandExecution', raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status };
      if (raw.command !== undefined) item.input = { command: raw.command };
      // Wire output wins; else the final snapshot carries what outputDelta streamed.
      const output =
        str(raw.aggregatedOutput) ??
        str(raw.output) ??
        (eventType === 'item.completed' ? state.outputs.get(id) : undefined);
      if (output !== undefined) item.output = output;
      const exitCode = num(raw.exitCode);
      if (exitCode !== undefined) item.exitCode = exitCode;
      break;
    }
    case 'fileChange': {
      const display = toolDisplay('fileChange', raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status };
      const artifacts = changeArtifacts(raw.changes);
      if (artifacts) {
        item.diffs = artifacts.diffs;
        item.locations = artifacts.locations;
      }
      break;
    }
    case 'mcpToolCall': {
      const server = str(raw.server);
      const tool = str(raw.tool);
      const display = toolDisplay('mcpToolCall', raw);
      item = {
        kind: 'tool',
        id,
        // §7.1: the item is named after what it called, `server.tool`.
        name: server && tool ? `${server}.${tool}` : type,
        toolKind: display.toolKind,
        title: display.title,
        status,
      };
      if (raw.arguments !== undefined) item.input = raw.arguments;
      const result = raw.result;
      if (typeof result === 'string') item.output = result;
      else if (result !== undefined) item.output = safeStringify(result);
      break;
    }
    case 'webSearch': {
      const display = toolDisplay('webSearch', raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status };
      break;
    }
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      // §7.1: review-mode items → tool(kind task).
      item = {
        kind: 'tool',
        id,
        name: type,
        toolKind: 'task',
        title: type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode',
        status,
      };
      break;
    default: {
      // Unknown item types stay visible as generic tool cards (v1 parity —
      // a future codex tool must not silently vanish from the thread).
      const display = toolDisplay(type, raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status, input: raw };
    }
  }

  const error = errorMessage(raw.error);
  if (error !== undefined) item.error = error;
  return item;
}

/** `fileChange.changes[]` `{path, kind, diff}` → `diffs[]` (unified) + locations. */
function changeArtifacts(changes: unknown): { diffs: FileDiff[]; locations: ToolLocation[] } | undefined {
  if (!Array.isArray(changes)) return undefined;
  const diffs: FileDiff[] = [];
  const locations: ToolLocation[] = [];
  for (const change of changes) {
    if (!isRecord(change) || typeof change.path !== 'string' || change.path === '') continue;
    // Codex sends unified diffs only — the old text is unknown, not "empty".
    const diff: FileDiff = { path: change.path, oldText: null };
    const unified = str(change.diff);
    if (unified !== undefined) diff.unified = unified;
    diffs.push(diff);
    locations.push({ path: change.path });
  }
  if (diffs.length === 0) return undefined;
  return { diffs, locations };
}

/** `todoList` items `{text, completed}` (and plan step arrays) → plan entries;
 *  a text-only `plan` item becomes the single entry the agent is executing. */
function planEntriesOf(raw: Record<string, unknown>): PlanEntry[] | undefined {
  const list = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.plan) ? raw.plan : undefined;
  if (list) {
    const entries: PlanEntry[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const content = str(entry.text) ?? str(entry.step) ?? str(entry.content);
      if (content === undefined) continue;
      if (typeof entry.completed === 'boolean') {
        entries.push({ content, status: entry.completed ? 'completed' : 'pending' });
      } else if (entry.status === 'pending' || entry.status === 'completed') {
        entries.push({ content, status: entry.status });
      } else if (entry.status === 'inProgress' || entry.status === 'in_progress') {
        entries.push({ content, status: 'in_progress' });
      } else {
        entries.push({ content, status: 'pending' });
      }
    }
    return entries;
  }
  const text = str(raw.text);
  if (text === undefined) return undefined;
  return [{ content: text, status: 'in_progress' }];
}

// ---- streaming deltas -------------------------------------------------------

/** Minimal item synthesized when a delta outruns its `item/started` — gives
 *  consumers a valid target to upsert; the completed snapshot reconciles. */
function synthesizedItem(itemId: string, field: 'text' | 'reasoning' | 'output'): UiItem {
  if (field === 'text') return { kind: 'message', id: itemId, role: 'assistant', text: '' };
  if (field === 'reasoning') return { kind: 'reasoning', id: itemId, text: '' };
  const display = toolDisplay('commandExecution');
  return { kind: 'tool', id: itemId, name: 'commandExecution', toolKind: display.toolKind, title: display.title, status: 'running' };
}

function mapDelta(
  params: Record<string, unknown>,
  state: CodexUiMapperState,
  field: 'text' | 'reasoning' | 'output',
): CodexUiMapping {
  const itemId = str(params.itemId);
  const delta = typeof params.delta === 'string' ? params.delta : '';
  if (itemId === undefined || delta === '') return { events: [], state };

  const events: UiEvent[] = [];
  let knownItems: ReadonlySet<string> = state.knownItems;
  if (!knownItems.has(itemId)) {
    events.push({ type: 'item.started', item: synthesizedItem(itemId, field) });
    knownItems = new Set(knownItems).add(itemId);
  }
  events.push({ type: 'item.delta', itemId, field, delta });

  let outputs: ReadonlyMap<string, string> = state.outputs;
  if (field === 'output') {
    const next = new Map(state.outputs);
    next.set(itemId, (next.get(itemId) ?? '') + delta);
    outputs = next;
  }
  return { events, state: { ...state, knownItems, outputs } };
}

// ---- telemetry ---------------------------------------------------------------

/** `thread/tokenUsage/updated` → usage.updated. Raw CUMULATIVE totals from
 *  `tokenUsage.total`; codex reports no USD cost, so none is ever fabricated. */
function mapTokenUsage(params: Record<string, unknown>, state: CodexUiMapperState): CodexUiMapping {
  if (!isRecord(params.tokenUsage)) return { events: [], state };
  const tokenUsage = params.tokenUsage;
  const total = isRecord(tokenUsage.total) ? tokenUsage.total : undefined;
  if (!total) return { events: [], state };
  const input = num(total.inputTokens) ?? 0;
  const output = num(total.outputTokens) ?? 0;
  const cacheRead = num(total.cachedInputTokens);
  const reasoning = num(total.reasoningOutputTokens);
  const usage: TokenUsage = {
    input,
    output,
    total: num(total.totalTokens) ?? input + output,
  };
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  const contextWindow = num(tokenUsage.modelContextWindow);
  if (contextWindow !== undefined) usage.contextWindow = contextWindow;
  return { events: [{ type: 'usage.updated', usage }], state };
}

// ---- tiny guards --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function turnIdOf(params: Record<string, unknown>): string | undefined {
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return (turn && str(turn.id)) ?? str(params.turnId);
}

function threadIdOf(params: Record<string, unknown>): string | undefined {
  const thread = isRecord(params.thread) ? params.thread : undefined;
  return (thread && str(thread.id)) ?? str(params.threadId);
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return str(error);
  if (isRecord(error)) return str(error.message);
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
