import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunEvent, RunStatus } from '@/api/types'

import { TaskThreadRoute, ThreadView } from './task-thread'
import { reduceThread } from './thread-state'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** ThreadView now hosts the run header, whose hooks need a query client (mutations, the runs
 *  list) and a router (tabs, delete-navigates-home). Data assertions still drive the reduced
 *  fixture states directly — the providers are plumbing, not fixtures. */
function renderView(ui: ReactElement) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  )
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'do the thing plz',
    titleSummary: 'Do the thing',
    workflow: 'quick-task',
    task: 'Summarize what this project does.',
    status,
    createdAt: '2026-07-14T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }) as ApiRun

const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: '2026-07-14T12:00:00.000Z', type, ...rest }) as RunEvent

/** A small real-shaped transcript: dim lines, a v2 message, a tool, a v1 user reply. */
const EVENTS: RunEvent[] = [
  line(1, 'lifecycle', { message: 'run started — workflow "quick-task" (runner: claude)' }),
  line(2, 'note', { message: 'worktree ready — branch cez/r1 (base main)' }),
  line(3, 'turn.started', { turnId: 'turn_1' }),
  line(4, 'item.completed', {
    item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'It is a **cockpit** for agents.' },
  }),
  line(5, 'item.completed', {
    item: { kind: 'tool', id: 'toolu_1', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'completed', output: 'ok' },
  }),
  line(6, 'item.completed', { item: { kind: 'reasoning', id: 'item_2', text: 'Considering the layout…' } }),
  line(7, 'user-message', { text: 'Thanks!', imageCount: 2 }),
]

describe('ThreadView', () => {
  it('renders the task as the leading user bubble and the v1 reply as another', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const bubbles = document.querySelectorAll('[data-slot="user-bubble"]')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]!.textContent).toContain('Summarize what this project does.')
    expect(bubbles[1]!.textContent).toContain('Thanks!')
    expect(bubbles[1]!.textContent).toContain('2 images attached')
  })

  it('renders assistant messages as markdown, not raw text', async () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    // The ** marks became a strong element (Streamdown spells it as a data-tagged span) —
    // the renderer parsed, it didn't echo.
    await waitFor(() => {
      const strong = document.querySelector('[data-slot="assistant-message"] [data-streamdown="strong"]')
      expect(strong?.textContent).toBe('cockpit')
    })
    expect(document.querySelector('[data-slot="assistant-message"]')?.textContent).not.toContain('**')
  })

  it('dims lifecycle lines and shows the tool card + folded reasoning', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const notes = [...document.querySelectorAll('[data-slot="note-line"]')]
    expect(notes.map((n) => n.getAttribute('data-tone'))).toEqual(['dim', 'dim'])
    expect(notes[1]!.textContent).toContain('worktree ready')

    const toolCard = document.querySelector('[data-slot="tool-card"]')
    expect(toolCard?.textContent).toContain('Ran')
    expect(toolCard?.textContent).toContain('npm test')
    expect(toolCard?.getAttribute('data-status')).toBe('completed')

    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('Thinking — Considering the layout…')
  })

  it('shows the header title (auto-summary, never the raw title) and the status pill', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('needs you')
  })

  it('waiting → the paused hint (pulsing dot) in the dock, right above an ENABLED composer', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const hint = document.querySelector('[data-slot="thread-dock"] [data-slot="paused-hint"]')
    expect(hint?.textContent).toContain('The agent is paused, waiting for your reply')
    expect(hint?.querySelector('[data-slot="status-dot"]')).not.toBeNull()
    // No body footer for waiting — the dock owns that state now.
    expect(document.querySelector('[data-slot="thread-footer"]')).toBeNull()
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Reply — / for skills, @ for files…')
  })

  it('running → the composer stays enabled with the "message" placeholder, no paused hint', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="paused-hint"]')).toBeNull()
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the agent — / for skills, @ for files…')
  })

  it('monitoring → no paused hint, "message" placeholder, and a "monitoring" pill (#490)', () => {
    renderView(<ThreadView run={run('running', { activity: 'monitoring' })} thread={reduceThread(EVENTS)} />)
    // Still working on downstream work, not on you: never the "paused, waiting for your reply" banner.
    expect(document.querySelector('[data-slot="paused-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('monitoring')
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the agent — / for skills, @ for files…')
  })

  it('closed → the composer is disabled with the legacy reason and the Continue way out', () => {
    renderView(
      <ThreadView
        run={run('done', {
          steps: [
            { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
          ],
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Session closed — Continue to reopen.')
    // The way out, only because this run HAS a session to resume.
    expect(
      document.querySelector('[data-slot="composer-disabled-action"]')?.textContent,
    ).toContain('Continue')
  })

  /** #472 — a queued run has not started, so its prompt is still authorable. */
  it('queued → the composer is ENABLED with its own placeholder and hint, and no Continue', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread(EVENTS)} />)
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Add to the prompt — sent when the run starts…')
    expect(document.querySelector('[data-slot="queued-hint"]')?.textContent).toContain(
      'folded into the prompt before the run starts',
    )
    // Continue is meaningless for a run that has not run.
    expect(document.querySelector('[data-slot="composer-disabled-action"]')).toBeNull()
  })

  /**
   * The scope boundary: the queued branch is `queued` ONLY. Every other closed
   * status keeps the legacy copy — including the string `composer.e2e.ts` asserts.
   */
  it('done keeps the legacy disabled copy and shows no queued hint', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Session closed — Continue to reopen.')
    expect(document.querySelector('[data-slot="queued-hint"]')).toBeNull()
  })

  it('closed with no resumable session → disabled composer, and no Continue button invented', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    expect((screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement).disabled).toBe(true)
    expect(document.querySelector('[data-slot="composer-disabled-action"]')?.textContent ?? '').not.toContain(
      'Continue',
    )
  })

  it('done → the closed footer; failed → the danger footer carrying the run error', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="thread-footer"]')?.textContent).toBe('Session closed')
    cleanup()

    renderView(<ThreadView run={run('failed', { error: 'checks failed' })} thread={reduceThread(EVENTS)} />)
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.textContent).toBe('Session failed — checks failed')
    expect(footer?.className).toContain('text-danger')
  })

  it('running → no footer (the stream itself is the status), and no invented empty state', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="thread-footer"]')).toBeNull()
    expect(document.querySelector('[data-slot="thread-empty"]')).toBeNull()
  })

  it('an eventless run says so instead of rendering blank space', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread([])} />)
    expect(document.querySelector('[data-slot="thread-empty"]')?.textContent).toBe('No session events yet.')
  })

  it('an eventless QUEUED run gets the queued placeholder, not the generic empty line (#351)', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread([])} />)
    const placeholder = document.querySelector('[data-slot="queued-state"]')
    expect(placeholder?.textContent).toContain('Waiting for a free agent slot')
    expect(placeholder?.textContent).toContain('quick-task · starts automatically')
    expect(document.querySelector('[data-slot="thread-empty"]')).toBeNull()
  })

  it('the first real event replaces the queued placeholder', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread([line(1, 'lifecycle', { message: 'cezar restarted — task re-queued' })])} />)
    expect(document.querySelector('[data-slot="queued-state"]')).toBeNull()
    expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('re-queued')
  })

  it('no plan → no dock, no header mirror; steps present → the rail renders in the header', () => {
    renderView(
      <ThreadView
        run={run('running', {
          steps: [
            { id: 'task', name: 'Do the task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 },
            { id: 'verify', name: 'Verify', kind: 'check', status: 'pending', iterations: 1, tokensUsed: 0 },
          ],
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    expect(document.querySelector('[data-slot="plan-dock"]')).toBeNull()
    expect(document.querySelector('[data-slot="plan-mirror"]')).toBeNull()
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['active', 'pending'])
    expect(rows[0]!.textContent).toContain('Do the task')
  })

  it('a plan in the stream → the dock above the composer area + the compact header mirror', () => {
    const withPlan: RunEvent[] = [
      ...EVENTS,
      line(8, 'plan.updated', {
        entries: [
          { content: 'Read the docs', status: 'completed' },
          { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
          { content: 'Reply', status: 'pending' },
        ],
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(withPlan)} />)
    expect(document.querySelector('[data-slot="plan-dock"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="plan-count"]')?.textContent).toBe('· 1/3')
    expect(document.querySelector('[data-slot="plan-mirror"]')?.textContent).toBe('Plan 1/3')
    // No steps on this run — the rail knows to stay away.
    expect(document.querySelector('[data-slot="step-rail"]')).toBeNull()
  })

  it('plan-kind tool cards stay out of the thread — the dock is their surface (#382)', () => {
    const todoInput = {
      todos: [
        { content: 'Read the docs', status: 'completed', activeForm: 'Reading the docs' },
        { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
      ],
    }
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', {
        item: { kind: 'tool', id: 'toolu_todo', name: 'TodoWrite', toolKind: 'plan', title: 'Update plan', status: 'running', input: todoInput },
      }),
      line(3, 'plan.updated', { entries: todoInput.todos }),
      line(4, 'item.completed', {
        item: { kind: 'tool', id: 'toolu_todo', name: 'TodoWrite', toolKind: 'plan', title: 'Update plan', status: 'completed', input: todoInput },
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(events)} />)
    expect(document.querySelector('[data-slot="tool-card"]')).toBeNull()
    expect(document.querySelector('[data-slot="plan-dock"]')).not.toBeNull()
  })
})

/** Route-level: loading and 404 — driven through the real fetch boundary. jsdom has no
 *  EventSource, which `useRunEvents` treats as "no stream" — honest for these states. */
function renderRoute(id: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskThreadRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('TaskThreadRoute', () => {
  it('is honestly loading while /api/runs/:id has not answered', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    renderRoute('r1')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Loading task…')
    expect(document.querySelector('[data-route="task-thread"]')).not.toBeNull()
  })

  it('unknown run id → the 404-style CenteredState with a way home', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })),
      ),
    )
    renderRoute('nope')
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Task not found')
    })
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/')
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
  })
})
