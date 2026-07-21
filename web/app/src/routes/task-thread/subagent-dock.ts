import type { ToolStatus, UiToolItem } from '@/protocol/ui-events'

import { splitToolTitle } from './thread-groups'
import type { ThreadEntry, ThreadTurn } from './thread-state'

/**
 * The Agents dock's data (spec `.ai/specs/2026-07-20-grouped-subagent-display.md` §Collector,
 * issue #474): pure derivation of "which sub-agents belong to the current fan-out, and what is
 * each one doing" from the reduced turns the thread already renders.
 *
 * A sub-agent is any **parent-less** `toolKind: 'task'` item (spec Q3) — claude `Task`/`Agent`,
 * opencode `subtask`, codex review mode. A task item that itself carries a `parentItemId` is a
 * sub-agent's own spawn, one level down; it is never a dock row. No backend name reaches this
 * module: parity comes from the protocol seam (`AGENT_PROTOCOL.md`), not from per-backend code.
 *
 * Pure and total, like `groupThreadItems` — it keys on the same `parentItemId` relation the
 * thread's nesting pass uses, so the dock and the transcript can never disagree about who owns
 * what.
 */

/** Longest activity line the dock will carry; the row truncates visually on top of this. */
const ACTIVITY_MAX = 120

export interface SubagentSummary {
  /** The task tool item's id — also the sheet's selection key. */
  id: string
  /** "Review the store layer" — the detail half of "Task: …", else the whole title. */
  title: string
  /** claude `subagent_type`/`subagentType`, opencode `agent`; absent for codex. */
  agentType?: string
  status: ToolStatus
  /** Children of kind `tool` — what the row's "N tools" count shows. */
  toolCalls: number
  /** One-line readout from the most recent child; `undefined` ⇒ the row renders "starting…". */
  activity?: string
}

/** A settled agent is done moving: the dock stops treating the fan-out as live (spec Q6). */
const isSettled = (status: ToolStatus): boolean => status !== 'pending' && status !== 'running'

const isTaskItem = (entry: ThreadEntry): entry is UiToolItem =>
  entry.kind === 'tool' && entry.toolKind === 'task'

/** Dock rows are the parent-less task items only — a nested spawn belongs to its parent's sheet. */
const isRootTaskItem = (entry: ThreadEntry): entry is UiToolItem =>
  isTaskItem(entry) && entry.parentItemId === undefined

/**
 * The agent's declared type, from whichever key the backend used. Read defensively: `input` is
 * raw backend JSON that may still be arriving incrementally, so anything non-string is dropped
 * rather than rendered.
 */
function agentTypeOf(item: UiToolItem): string | undefined {
  const input = item.input
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ['subagent_type', 'subagentType', 'agent']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Collapse a child entry to the single line the dock shows as "what this agent is doing now". */
function activityOf(child: ThreadEntry): string | undefined {
  if (child.kind === 'tool') return truncate(child.title)
  if (child.kind === 'message' || child.kind === 'reasoning') {
    // The LAST non-empty line: streamed text grows at the tail, so the newest line is the
    // honest "right now" — the first line froze several deltas ago.
    const lines = child.text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim()
      if (line !== '') return truncate(line)
    }
  }
  return undefined
}

function truncate(text: string): string {
  return text.length > ACTIVITY_MAX ? `${text.slice(0, ACTIVITY_MAX - 1).trimEnd()}…` : text
}

/**
 * The dock's rows, in stream order — or `[]` when there is nothing to dock.
 *
 * The **anchor** is the most recent turn holding parent-less task items. It yields rows only
 * while it is the latest turn *or* any of its agents is still unsettled (spec Q6): a steering
 * message mid-fan-out opens a new turn, and the dock must not vanish while agents still run.
 * Once every agent settles and a newer turn exists, the dock yields to the transcript.
 *
 * Children are gathered across the anchor turn **and every later turn** for the same reason —
 * output produced after a steering message still belongs to the agent that produced it.
 */
export function collectSubagents(turns: ThreadTurn[]): SubagentSummary[] {
  const anchorIndex = findLastIndex(turns, (turn) => turn.items.some(isRootTaskItem))
  if (anchorIndex === -1) return []

  const anchor = turns[anchorIndex]!
  const roots = anchor.items.filter(isRootTaskItem)
  const isLatestTurn = anchorIndex === turns.length - 1
  if (!isLatestTurn && roots.every((item) => isSettled(item.status))) return []

  // Children by parent id, across the anchor and everything after it. An id that names no root
  // is ignored — exactly as `groupThreadItems` renders such an orphan at top level.
  const rootIds = new Set(roots.map((item) => item.id))
  const childrenOf = new Map<string, ThreadEntry[]>()
  for (let i = anchorIndex; i < turns.length; i += 1) {
    for (const entry of turns[i]!.items) {
      if (entry.kind !== 'message' && entry.kind !== 'reasoning' && entry.kind !== 'tool') continue
      const parentId = entry.parentItemId
      if (parentId === undefined || parentId === entry.id || !rootIds.has(parentId)) continue
      const siblings = childrenOf.get(parentId)
      if (siblings) siblings.push(entry)
      else childrenOf.set(parentId, [entry])
    }
  }

  return roots.map((item) => {
    const children = childrenOf.get(item.id) ?? []
    const summary: SubagentSummary = {
      id: item.id,
      title: splitToolTitle(item.title).detail ?? item.title,
      status: item.status,
      toolCalls: children.filter((child) => child.kind === 'tool').length,
    }
    const agentType = agentTypeOf(item)
    if (agentType !== undefined) summary.agentType = agentType
    // Walk back from the newest child: a child that carries no line (an image, a blank
    // message) must not blank the row when an older child still has something to say.
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const activity = activityOf(children[i]!)
      if (activity !== undefined) {
        summary.activity = activity
        break
      }
    }
    return summary
  })
}

/**
 * The collapsed head's "N/M" odometer. `failed`/`declined` agents count toward the denominator
 * but never the numerator — a fan-out that lost an agent must not read as fully done, and the
 * row keeps its danger glyph either way (spec §Edge Cases).
 */
export function subagentCounts(agents: SubagentSummary[]): { done: number; total: number } {
  return {
    done: agents.filter((agent) => agent.status === 'completed').length,
    total: agents.length,
  }
}

/** What the collapsed head names: the first agent still working, else the first row. */
export function activeSubagent(agents: SubagentSummary[]): SubagentSummary | undefined {
  return agents.find((agent) => !isSettled(agent.status)) ?? agents[0]
}

/** `Array.prototype.findLastIndex` needs a newer lib target than the cockpit's tsconfig sets. */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i
  }
  return -1
}

/**
 * One agent by id, WITHOUT the dock's visibility rule.
 *
 * The sheet must outlive the dock: a user who opens a drill-down and then sends a message
 * opens a new turn, which can hide the dock (Q6) — and reading the open panel out from under
 * them because a *different* surface decided to yield would be inexcusable. So the sheet
 * resolves its agent from the turns directly, and closes only when the user closes it.
 */
export function findSubagent(turns: ThreadTurn[], id: string): SubagentSummary | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const item = turns[i]!.items.find((entry) => entry.id === id && isRootTaskItem(entry))
    if (item === undefined || item.kind !== 'tool') continue
    const children = subagentChildren(turns, id)
    const summary: SubagentSummary = {
      id: item.id,
      title: splitToolTitle(item.title).detail ?? item.title,
      status: item.status,
      toolCalls: children.filter((child) => child.kind === 'tool').length,
    }
    const agentType = agentTypeOf(item)
    if (agentType !== undefined) summary.agentType = agentType
    return summary
  }
  return undefined
}

/**
 * The children the sheet renders for one agent — the same cross-turn relation the dock counts,
 * exposed so the drill-down and the row count can never drift apart.
 */
export function subagentChildren(turns: ThreadTurn[], parentId: string): ThreadEntry[] {
  const anchorIndex = findLastIndex(turns, (turn) => turn.items.some((entry) => entry.id === parentId && isRootTaskItem(entry)))
  if (anchorIndex === -1) return []
  const children: ThreadEntry[] = []
  for (let i = anchorIndex; i < turns.length; i += 1) {
    for (const entry of turns[i]!.items) {
      if (entry.kind !== 'message' && entry.kind !== 'reasoning' && entry.kind !== 'tool') continue
      if (entry.parentItemId === parentId && entry.id !== parentId) children.push(entry)
    }
  }
  return children
}
