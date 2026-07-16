/**
 * Pure claude stream-json → protocol-v2 mapper. `mapClaudeMessage` folds one
 * parsed NDJSON stdout line into `UiEvent`s plus the next mapper state; the
 * runner calls it ALONGSIDE the v1 path (v1 events keep flowing unchanged).
 *
 * Contract: `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §1
 * (wire format) and §7.1 "Claude (stream-json)" (the mapping). Golden
 * fixtures replaying real wire shapes live in `__fixtures__/claude/`.
 *
 * Robustness rule: input is untrusted wire data — the mapper never throws;
 * unknown message/block types map to zero events.
 *
 * State is explicit and treated as immutable: callers thread the returned
 * `state` into the next call. Item ids are deterministic — tool items reuse
 * the wire `tool_use` id; text/thinking blocks (which have no wire id) get
 * sequential `item_<n>` ids, turns get `turn_<n>` — so replaying a stored
 * transcript reproduces the exact event sequence.
 */

import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  StopReason,
  TokenUsage,
  ToolLocation,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiSessionStartedEvent,
  UiToolItem,
  UiTurnCompletedEvent,
  UiUsageUpdatedEvent,
} from './ui-events.js';
import { toolDisplay } from './tool-display.js';

export interface ClaudeUiMapperState {
  /** Used when `system/init` lacks `session_id` (the dry-run mock does). */
  readonly fallbackSessionId?: string;
  /** True once `system/init` produced `session.started`. */
  readonly sessionStarted: boolean;
  /** Turns begun before init arrived — their `turn.started` is queued so
   *  `session.started` stays the first event on the wire. */
  readonly pendingTurnIds: readonly string[];
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  readonly itemSeq: number;
  /** `tool_use` items awaiting their `tool_result`, keyed by tool_use id. */
  readonly openTools: ReadonlyMap<string, UiToolItem>;
  /** The running plan built incrementally by Claude's task tools, keyed by
   *  the sequential task ids used by TaskUpdate. */
  readonly tasks: ReadonlyMap<string, PlanEntry>;
}

export interface ClaudeUiMapping {
  events: UiEvent[];
  state: ClaudeUiMapperState;
}

export function createClaudeUiState(opts: { fallbackSessionId?: string } = {}): ClaudeUiMapperState {
  return {
    fallbackSessionId: opts.fallbackSessionId,
    sessionStarted: false,
    pendingTurnIds: [],
    turnSeq: 0,
    currentTurnId: null,
    itemSeq: 0,
    openTools: new Map(),
    tasks: new Map(),
  };
}

/**
 * Claude has no wire-level turn-start — the runner writing a user message to
 * stdin IS the turn boundary, so the runner calls this on each send. Until
 * `init` arrives the event is queued (the seed message is written before the
 * first stdout line is read).
 */
export function claudeTurnStarted(state: ClaudeUiMapperState): ClaudeUiMapping {
  const turnId = `turn_${state.turnSeq + 1}`;
  const next = { ...state, turnSeq: state.turnSeq + 1, currentTurnId: turnId };
  if (!state.sessionStarted) {
    return { events: [], state: { ...next, pendingTurnIds: [...state.pendingTurnIds, turnId] } };
  }
  return { events: [{ type: 'turn.started', turnId }], state: next };
}

/** Fold one parsed stream-json message into v2 events. Never throws. */
export function mapClaudeMessage(msg: unknown, state: ClaudeUiMapperState): ClaudeUiMapping {
  if (!isRecord(msg)) return { events: [], state };
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' ? mapInit(msg, state) : { events: [], state };
    case 'assistant':
      return mapAssistant(msg, state);
    case 'user':
      return mapToolResults(msg, state);
    case 'result':
      return mapResult(msg, state);
    default:
      // stream_event, control_request, … — nothing to render yet.
      return { events: [], state };
  }
}

// ---- system/init → session.started ----------------------------------------

function mapInit(msg: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  const event: UiSessionStartedEvent = {
    type: 'session.started',
    sessionId: str(msg.session_id) ?? state.fallbackSessionId ?? '',
    backend: 'claude',
  };
  const model = str(msg.model);
  if (model !== undefined) event.model = model;
  const cwd = str(msg.cwd);
  if (cwd !== undefined) event.cwd = cwd;
  if (Array.isArray(msg.tools)) {
    event.tools = msg.tools.filter((tool): tool is string => typeof tool === 'string');
  }
  const events: UiEvent[] = [event];
  // Flush turns that began before init (the seeded first user message).
  for (const turnId of state.pendingTurnIds) events.push({ type: 'turn.started', turnId });
  return { events, state: { ...state, sessionStarted: true, pendingTurnIds: [] } };
}

// ---- assistant blocks → message/reasoning/tool items -----------------------

function mapAssistant(msg: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  const content = messageContent(msg);
  const parentItemId = str(msg.parent_tool_use_id);
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let openTools: Map<string, UiToolItem> | null = null;
  let tasks = state.tasks;

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'text' && typeof raw.text === 'string') {
      // Whole blocks per API round-trip — claude sends no deltas in this
      // mode, so we never fake `item.delta`s: started + completed.
      const item: UiMessageItem = { kind: 'message', id: `item_${++itemSeq}`, role: 'assistant', text: raw.text };
      if (parentItemId !== undefined) item.parentItemId = parentItemId;
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
    } else if (raw.type === 'thinking' && typeof raw.thinking === 'string') {
      const item: UiReasoningItem = { kind: 'reasoning', id: `item_${++itemSeq}`, text: raw.thinking };
      if (parentItemId !== undefined) item.parentItemId = parentItemId;
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
    } else if (raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string') {
      const display = toolDisplay(raw.name, raw.input);
      const item: UiToolItem = {
        kind: 'tool',
        id: raw.id,
        name: raw.name,
        toolKind: display.toolKind,
        title: display.title,
        // claude has no pending phase — a tool_use is already executing.
        status: 'running',
      };
      if (raw.input !== undefined) item.input = raw.input;
      const edit = editArtifacts(raw.name, raw.input);
      if (edit) {
        if (edit.diffs) item.diffs = edit.diffs;
        item.locations = edit.locations;
      }
      if (parentItemId !== undefined) item.parentItemId = parentItemId;
      events.push({ type: 'item.started', item });
      if (raw.name === 'TodoWrite') {
        const entries = planEntries(raw.input);
        if (entries) events.push({ type: 'plan.updated', entries });
      } else {
        const nextTasks = applyTaskTool(raw.name, raw.input, tasks);
        if (nextTasks) {
          tasks = nextTasks;
          events.push({ type: 'plan.updated', entries: [...tasks.values()] });
        }
      }
      openTools ??= new Map(state.openTools);
      openTools.set(raw.id, item);
    }
    // Unknown block types (redacted_thinking, server_tool_use, …): ignored.
  }

  if (events.length === 0) return { events, state };
  return { events, state: { ...state, itemSeq, openTools: openTools ?? state.openTools, tasks } };
}

/** claude `Edit`/`Write` inputs carry the diff inline (§7.1). */
function editArtifacts(
  name: string,
  input: unknown,
): { diffs?: FileDiff[]; locations: ToolLocation[] } | undefined {
  const key = name.toLowerCase();
  if (key !== 'edit' && key !== 'write') return undefined;
  if (!isRecord(input) || typeof input.file_path !== 'string' || input.file_path === '') return undefined;
  const path = input.file_path;
  const locations: ToolLocation[] = [{ path }];
  if (key === 'edit') {
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return { diffs: [{ path, oldText: input.old_string, newText: input.new_string }], locations };
    }
    return { locations };
  }
  // Write: a created (or fully replaced) file — `oldText: null` per FileDiff.
  const diff: FileDiff = { path, oldText: null };
  if (typeof input.content === 'string') diff.newText = input.content;
  return { diffs: [diff], locations };
}

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed'];

/** TaskUpdate also uses `running` for an active task. */
function normalizePlanStatus(value: unknown): PlanStatus | undefined {
  if (value === 'running') return 'in_progress';
  return PLAN_STATUSES.find((status) => status === value);
}

/** Fold one Claude task-tool call into the session's incremental plan. */
function applyTaskTool(
  name: string,
  input: unknown,
  tasks: ReadonlyMap<string, PlanEntry>,
): Map<string, PlanEntry> | undefined {
  const key = name.toLowerCase();
  if (key === 'taskcreate') {
    if (!isRecord(input) || typeof input.subject !== 'string' || input.subject.trim() === '') return undefined;
    const next = new Map(tasks);
    const entry: PlanEntry = { content: input.subject, status: 'pending' };
    if (typeof input.activeForm === 'string') entry.activeForm = input.activeForm;
    next.set(String(next.size + 1), entry);
    return next;
  }
  if (key === 'taskupdate') {
    if (!isRecord(input)) return undefined;
    const id =
      typeof input.taskId === 'string'
        ? input.taskId
        : typeof input.taskId === 'number'
          ? String(input.taskId)
          : undefined;
    if (id === undefined) return undefined;
    const existing = tasks.get(id);
    const status = normalizePlanStatus(input.status);
    if (existing === undefined || status === undefined || status === existing.status) return undefined;
    const next = new Map(tasks);
    next.set(id, { ...existing, status });
    return next;
  }
  return undefined;
}

/** TodoWrite input `{todos:[{content,status,activeForm}]}` → plan entries
 *  (full-replacement semantics — an empty list is a valid plan). */
function planEntries(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') continue;
    const status = PLAN_STATUSES.find((s) => s === todo.status);
    if (status === undefined) continue;
    const entry: PlanEntry = { content: todo.content, status };
    if (typeof todo.activeForm === 'string') entry.activeForm = todo.activeForm;
    entries.push(entry);
  }
  return entries;
}

// ---- user tool_result blocks → item.completed (+ image events) -------------

function mapToolResults(msg: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  const content = messageContent(msg);
  const parentItemId = str(msg.parent_tool_use_id);
  const events: UiEvent[] = [];
  let openTools: Map<string, UiToolItem> | null = null;

  for (const raw of content) {
    if (!isRecord(raw) || raw.type !== 'tool_result' || typeof raw.tool_use_id !== 'string') continue;
    const open = (openTools ?? state.openTools).get(raw.tool_use_id);
    // A result for a tool we never saw start (state loss) still completes an
    // item — consumers upsert by id, so a lone snapshot renders fine.
    const item: UiToolItem = open
      ? { ...open }
      : { kind: 'tool', id: raw.tool_use_id, name: 'unknown', toolKind: 'other', title: 'Tool', status: 'running' };
    if (!open && parentItemId !== undefined) item.parentItemId = parentItemId;
    const text = stringifyToolResultContent(raw.content);
    if (raw.is_error === true) {
      item.status = 'failed';
      item.error = text;
    } else {
      item.status = 'completed';
      item.output = text;
    }
    events.push({ type: 'item.completed', item });
    for (const img of toolResultImageBlocks(raw.content)) {
      events.push({ type: 'image', itemId: raw.tool_use_id, mediaType: img.media_type, data: img.data });
    }
    openTools ??= new Map(state.openTools);
    openTools.delete(raw.tool_use_id);
  }

  if (events.length === 0) return { events, state };
  return { events, state: { ...state, openTools: openTools ?? state.openTools } };
}

// ---- result → declined tools + turn.completed + usage.updated --------------

function mapResult(msg: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let turnSeq = state.turnSeq;
  let openTools: Map<string, UiToolItem> | null = null;

  if (Array.isArray(msg.permission_denials)) {
    for (const raw of msg.permission_denials) {
      if (!isRecord(raw) || typeof raw.tool_name !== 'string') continue;
      const id = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : `item_${++itemSeq}`;
      const open = (openTools ?? state.openTools).get(id);
      let item: UiToolItem;
      if (open) {
        item = { ...open, status: 'declined' };
        openTools ??= new Map(state.openTools);
        openTools.delete(id);
      } else {
        const display = toolDisplay(raw.tool_name, raw.tool_input);
        item = {
          kind: 'tool',
          id,
          name: raw.tool_name,
          toolKind: display.toolKind,
          title: display.title,
          status: 'declined',
        };
        if (raw.tool_input !== undefined) item.input = raw.tool_input;
      }
      events.push({ type: 'item.completed', item });
    }
  }

  const turnId = state.currentTurnId ?? `turn_${++turnSeq}`;
  const usage = rawTokenUsage(msg.usage);
  const costUsd =
    typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd)
      ? msg.total_cost_usd
      : undefined;
  const turnEvent: UiTurnCompletedEvent = { type: 'turn.completed', turnId, stopReason: resultStopReason(msg) };
  if (usage) turnEvent.usage = usage;
  if (costUsd !== undefined) turnEvent.costUsd = costUsd;
  events.push(turnEvent);
  if (usage) {
    const usageEvent: UiUsageUpdatedEvent = { type: 'usage.updated', usage };
    if (costUsd !== undefined) usageEvent.costUsd = costUsd;
    events.push(usageEvent);
  }

  return {
    events,
    state: { ...state, itemSeq, turnSeq, currentTurnId: null, openTools: openTools ?? state.openTools },
  };
}

/** §7.1: success→end_turn, error_max_turns→max_tokens,
 *  error_during_execution→error; unknown subtypes fall back on `is_error`. */
function resultStopReason(msg: Record<string, unknown>): StopReason {
  switch (msg.subtype) {
    case 'success':
      return 'end_turn';
    case 'error_max_turns':
      return 'max_tokens';
    case 'error_during_execution':
      return 'error';
    default:
      return msg.is_error === true ? 'error' : 'end_turn';
  }
}

/** Raw counts straight off the wire — never cost-weighted (that stays a
 *  presentation concern; v1's `token-usage` keeps the weighted number). */
function rawTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const input = num(usage.input_tokens) ?? 0;
  const output = num(usage.output_tokens) ?? 0;
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const result: TokenUsage = {
    input,
    output,
    total: input + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
  return result;
}

// ---- shared wire helpers (also used by the v1 path in the runner) ----------

/** Flatten a `tool_result.content` (string or block array) to display text.
 *  Image blocks become a placeholder — they ride as their own events. */
export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image') return '[screenshot]'; // emitted as its own image event
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** base64 image blocks inside a tool_result's content, if any. */
export function toolResultImageBlocks(content: unknown): Array<{ media_type: string; data: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ media_type: string; data: string }> = [];
  for (const c of content) {
    const b = c as { type?: string; source?: { type?: string; media_type?: string; data?: string } };
    if (b.type === 'image' && b.source?.type === 'base64' && b.source.media_type && b.source.data) {
      out.push({ media_type: b.source.media_type, data: b.source.data });
    }
  }
  return out;
}

// ---- tiny guards ------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageContent(msg: Record<string, unknown>): unknown[] {
  const message = isRecord(msg.message) ? msg.message : undefined;
  return message && Array.isArray(message.content) ? message.content : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
