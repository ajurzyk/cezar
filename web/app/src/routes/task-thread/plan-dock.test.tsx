import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PlanEntry } from '@/protocol/ui-events'

import thinkingEditWriteTodo from '../../../../../src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import { PlanDock, planActiveEntry, planCounts } from './plan-dock'

afterEach(cleanup)

/** The golden claude `plan.updated` snapshot (thinking-edit-write-todo) — the exact entry
 *  shapes the R2 mapper is pinned to: completed / in_progress / pending, each with an
 *  `activeForm`. Never hand-invented. */
const GOLDEN: PlanEntry[] = (thinkingEditWriteTodo as Array<{ type: string; entries?: PlanEntry[] }>).find(
  (event) => event.type === 'plan.updated',
)!.entries!

const dock = () => document.querySelector('[data-slot="plan-dock"]')!
const head = () => document.querySelector<HTMLButtonElement>('[data-slot="plan-dock"] button')!

describe('planCounts / planActiveEntry — the odometer math', () => {
  it('counts completed over total (the golden snapshot is 1/3)', () => {
    expect(planCounts(GOLDEN)).toEqual({ done: 1, total: 3 })
  })

  it.each<[string, PlanEntry[], string | undefined]>([
    ['the in-progress entry wins', GOLDEN, 'Run tests'],
    [
      'no in-progress → the next pending one',
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
      'b',
    ],
    ['fully completed → none', [{ content: 'a', status: 'completed' }], undefined],
  ])('%s', (_name, entries, expected) => {
    expect(planActiveEntry(entries)?.content).toBe(expected)
  })
})

describe('PlanDock', () => {
  it('renders nothing for an emptied plan (full replacement can clear it)', () => {
    render(<PlanDock runId="dock-empty" entries={[]} />)
    expect(document.querySelector('[data-slot="plan-dock"]')).toBeNull()
  })

  it('expanded by default (jsdom counts as desktop): N/M head + the three row states', () => {
    render(<PlanDock runId="dock-states" entries={GOLDEN} />)
    expect(dock().getAttribute('data-state')).toBe('open')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-slot="plan-count"]')?.textContent).toBe('· 1/3')

    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows.map((row) => row.textContent)).toEqual([
      'Patch middleware redirect',
      'Run testsin progress', // content + the "in progress" tag
      'Update changelog',
    ])
    expect(rows[0]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')?.textContent).toBe('in progress')
    expect(rows[1]!.querySelector('svg')?.getAttribute('class')).toContain('animate-pulse')
    expect(rows[2]!.querySelector('[data-slot="plan-tag"]')).toBeNull()
    // Expanded: the current-item line belongs to the collapsed head only.
    expect(document.querySelector('[data-slot="plan-current"]')).toBeNull()
  })

  it('collapsing folds the list to "Plan · N/M — {activeForm of the current item}"', () => {
    render(<PlanDock runId="dock-collapse" entries={GOLDEN} />)
    fireEvent.click(head())
    expect(dock().getAttribute('data-state')).toBe('collapsed')
    expect(document.querySelector('[data-slot="plan-list"]')).toBeNull()
    // The in-progress entry, spelled with its present-continuous activeForm.
    expect(document.querySelector('[data-slot="plan-current"]')?.textContent).toBe('— Running tests')
  })

  it('falls back to the entry content when the current item has no activeForm', () => {
    render(
      <PlanDock
        runId="dock-no-activeform"
        entries={[
          { content: 'Ship it', status: 'in_progress' },
          { content: 'Later', status: 'pending' },
        ]}
      />,
    )
    fireEvent.click(head())
    expect(document.querySelector('[data-slot="plan-current"]')?.textContent).toBe('— Ship it')
  })

  it('remembers the collapse per run id across unmounts (the module-level cache)', () => {
    const { unmount } = render(<PlanDock runId="dock-memory" entries={GOLDEN} />)
    fireEvent.click(head())
    expect(dock().getAttribute('data-state')).toBe('collapsed')
    unmount()

    // Same run: reopens collapsed. Another run: fresh default (expanded).
    const second = render(<PlanDock runId="dock-memory" entries={GOLDEN} />)
    expect(dock().getAttribute('data-state')).toBe('collapsed')
    second.unmount()
    render(<PlanDock runId="dock-memory-other" entries={GOLDEN} />)
    expect(dock().getAttribute('data-state')).toBe('open')
  })
})
