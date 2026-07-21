import { describe, expect, it } from 'vitest'

import type { ToolStatus, UiToolItem } from '@/protocol/ui-events'

import {
  activeSubagent,
  collectSubagents,
  subagentChildren,
  subagentCounts,
} from './subagent-dock'
import type { ThreadEntry, ThreadTurn } from './thread-state'

/** A `Task` spawn in the shape the claude mapper emits (title precomputed by `toolDisplay`). */
const task = (id: string, status: ToolStatus, extra: Partial<UiToolItem> = {}): UiToolItem => ({
  kind: 'tool',
  id,
  name: 'Task',
  toolKind: 'task',
  title: `Task: review ${id}`,
  status,
  ...extra,
})

const childTool = (id: string, parentItemId: string, title: string): UiToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  toolKind: 'execute',
  title,
  status: 'completed',
  parentItemId,
})

const childText = (id: string, parentItemId: string, text: string): ThreadEntry => ({
  kind: 'message',
  id,
  role: 'assistant',
  text,
  parentItemId,
})

const turn = (id: string, items: ThreadEntry[]): ThreadTurn => ({ id, items })

describe('collectSubagents — which items become rows', () => {
  it('collects parent-less task items in stream order', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'running'), task('b', 'running')])])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b'])
    // "Task: review a" → the detail half; the verb is the card's, not the row's.
    expect(agents[0]!.title).toBe('review a')
  })

  it('excludes nested task items — a sub-agent spawning its own sub-agent is not a dock row', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), task('nested', 'running', { parentItemId: 'a' })]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a'])
    // The nested spawn still counts as its parent's tool call.
    expect(agents[0]!.toolCalls).toBe(1)
  })

  it('returns [] for a turn with no task items', () => {
    const read: UiToolItem = {
      kind: 'tool',
      id: 'r',
      name: 'Read',
      toolKind: 'read',
      title: 'Read /repo/a.ts',
      status: 'completed',
    }
    expect(collectSubagents([turn('turn-1', [read])])).toEqual([])
  })

  it('returns [] for no turns at all', () => {
    expect(collectSubagents([])).toEqual([])
  })

  it('anchors on the MOST RECENT turn holding task items', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('old', 'completed')]),
      turn('turn-2', [task('new', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['new'])
  })
})

describe('collectSubagents — Q6 visibility', () => {
  it('hides a settled fan-out once a newer turn exists', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'failed')]),
      turn('turn-2', [childText('m', 'nobody', 'a later assistant message')]),
    ])
    expect(agents).toEqual([])
  })

  it('keeps the dock through mid-run steering while any agent is unsettled', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running')]),
      turn('turn-2', []), // the steering message opened a new turn
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b'])
  })

  it('shows a fully settled fan-out while it is still the latest turn', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'completed')])])
    expect(agents).toHaveLength(1)
  })
})

describe('collectSubagents — children', () => {
  it('counts tool children across LATER turns (the steering scenario)', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test')]),
      turn('turn-2', [childTool('c2', 'a', 'Ran npm run build')]),
    ])
    expect(agents[0]!.toolCalls).toBe(2)
    expect(agents[0]!.activity).toBe('Ran npm run build')
  })

  it('ignores an orphaned parentItemId, exactly as the thread renders it top-level', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'ghost', 'Ran npm test')]),
    ])
    expect(agents[0]!.toolCalls).toBe(0)
    expect(agents[0]!.activity).toBeUndefined()
  })

  it('never counts a self-referential parentItemId as its own child', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'running', { parentItemId: undefined })])])
    expect(agents[0]!.toolCalls).toBe(0)
  })

  it('leaves activity undefined when the agent has no children yet', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'running')])])
    expect(agents[0]!.activity).toBeUndefined()
  })
})

describe('collectSubagents — activity line', () => {
  it('uses a tool child title verbatim', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test')]),
    ])
    expect(agents[0]!.activity).toBe('Ran npm test')
  })

  it('uses the LAST non-empty line of a text child', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childText('c1', 'a', 'first line\nsecond line\n\n')]),
    ])
    expect(agents[0]!.activity).toBe('second line')
  })

  it('truncates a long line to a single ellipsised readout', () => {
    const long = 'x'.repeat(400)
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childText('c1', 'a', long)]),
    ])
    expect(agents[0]!.activity).toHaveLength(120)
    expect(agents[0]!.activity!.endsWith('…')).toBe(true)
  })

  it('falls back to an older child when the newest one carries no line', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test'), childText('c2', 'a', '   ')]),
    ])
    expect(agents[0]!.activity).toBe('Ran npm test')
  })
})

describe('collectSubagents — agentType', () => {
  it.each([
    ['subagent_type', 'code-reviewer'],
    ['subagentType', 'explorer'],
    ['agent', 'build'],
  ])('reads %s from the spawn input', (key, value) => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running', { input: { [key]: value } })]),
    ])
    expect(agents[0]!.agentType).toBe(value)
  })

  it('is undefined when the input carries no type (codex) or a non-string one', () => {
    expect(collectSubagents([turn('turn-1', [task('a', 'running')])])[0]!.agentType).toBeUndefined()
    expect(
      collectSubagents([turn('turn-1', [task('a', 'running', { input: { subagent_type: 42 } })])])[0]!.agentType,
    ).toBeUndefined()
    expect(
      collectSubagents([turn('turn-1', [task('a', 'running', { input: 'not-an-object' })])])[0]!.agentType,
    ).toBeUndefined()
  })
})

describe('subagentCounts', () => {
  it('counts completed over all agents', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running'), task('c', 'completed')]),
    ])
    expect(subagentCounts(agents)).toEqual({ done: 2, total: 3 })
  })

  it('keeps a failed agent in the denominator but never in the numerator', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'completed'), task('b', 'failed')])])
    expect(subagentCounts(agents)).toEqual({ done: 1, total: 2 })
  })

  it('is 0/0 for no agents', () => {
    expect(subagentCounts([])).toEqual({ done: 0, total: 0 })
  })
})

describe('activeSubagent', () => {
  it('names the first still-working agent', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running'), task('c', 'pending')]),
    ])
    expect(activeSubagent(agents)!.id).toBe('b')
  })

  it('falls back to the first row when every agent settled', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'completed'), task('b', 'completed')])])
    expect(activeSubagent(agents)!.id).toBe('a')
  })

  it('is undefined with no agents', () => {
    expect(activeSubagent([])).toBeUndefined()
  })
})

describe('subagentChildren', () => {
  it('returns one agent’s children in stream order, across later turns', () => {
    const turns = [
      turn('turn-1', [task('a', 'running'), task('b', 'running'), childTool('c1', 'a', 'Ran one')]),
      turn('turn-2', [childTool('c2', 'b', 'Ran other'), childTool('c3', 'a', 'Ran two')]),
    ]
    expect(subagentChildren(turns, 'a').map((child) => child.id)).toEqual(['c1', 'c3'])
    expect(subagentChildren(turns, 'b').map((child) => child.id)).toEqual(['c2'])
  })

  it('is empty for an unknown or childless parent', () => {
    const turns = [turn('turn-1', [task('a', 'running')])]
    expect(subagentChildren(turns, 'a')).toEqual([])
    expect(subagentChildren(turns, 'ghost')).toEqual([])
  })
})
