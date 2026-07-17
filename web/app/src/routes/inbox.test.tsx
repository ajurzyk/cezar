import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RunRecord, TodoItem } from '@/api/types'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { InboxRoute, isTodoRunnable, visibleTodos } from './inbox'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

/** The full meta row: age, action, live source task, PR link, suggested skill. */
const TODO_FULL: TodoItem = {
  id: 't1',
  ts: '2026-07-15T08:00:00.000Z',
  taskId: 'run-1',
  summary: 'Open a follow-up PR for the flaky retry test',
  action: 'follow-up',
  prUrl: 'https://github.com/acme/demo/pull/7',
  suggestedSkill: 'om-fix',
}

/** Its source task is NOT in `/api/runs` — the legacy "source task deleted" case. */
const TODO_ORPHAN: TodoItem = {
  id: 't2',
  taskId: 'run-gone',
  summary: 'Rerun the failed checks',
}

/** Already turned into a task: stays in todos.json as the audit trail, never rendered. */
const TODO_STARTED: TodoItem = {
  id: 't3',
  summary: 'Ship the release notes',
  startedTaskId: 'run-5',
}

const TODOS: TodoItem[] = [TODO_FULL, TODO_ORPHAN, TODO_STARTED]

const RUN_1: RunRecord = {
  id: 'run-1',
  title: 'Fix the retry test',
  workflow: 'quick-task',
  task: 'fix it',
  status: 'done',
  createdAt: '2026-07-15T07:00:00.000Z',
  tokensUsed: 10,
  archived: false,
  steps: [],
}

const STARTED_RUN: RunRecord = {
  ...RUN_1,
  id: 'run-9',
  title: 'Follow-up from the inbox',
  status: 'queued',
}

interface SentRequest {
  path: string
  method: string
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (github.test.tsx): records requests, serves the fixtures,
 *  and lets a test override specific `METHOD path` keys. Stateful like the real server: a
 *  DELETE really removes the entry, so the invalidation refetch answers without it. */
function stubFetch(
  overrides: Record<string, () => Response> = {},
  todos: TodoItem[] = TODOS,
): SentRequest[] {
  const sent: SentRequest[] = []
  let inbox = [...todos]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/todos') return jsonResponse(inbox)
      if (method === 'GET' && path === '/api/runs') return jsonResponse([RUN_1])
      if (method === 'DELETE' && path === '/api/todos/t1') {
        inbox = inbox.filter((item) => item.id !== 't1')
        return jsonResponse({ removed: true })
      }
      if (method === 'DELETE' && path === '/api/todos/t2') {
        inbox = inbox.filter((item) => item.id !== 't2')
        return jsonResponse({ removed: true })
      }
      if (method === 'POST' && path === '/api/todos/t1/start') {
        inbox = inbox.map((item) =>
          item.id === 't1' ? { ...item, startedTaskId: STARTED_RUN.id } : item,
        )
        return jsonResponse({ run: STARTED_RUN }, 201)
      }
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderInbox() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<InboxRoute />} />
          {/* Navigation probe: where Run's success is supposed to land (legacy selectRun hop). */}
          <Route path="/tasks/:id" element={<div data-slot="thread-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="todo-card"]')]

// ---- the visibility rule ----------------------------------------------------------------------

describe('visibleTodos', () => {
  it('hides entries already turned into a task (the legacy audit-trail rule)', () => {
    expect(visibleTodos(TODOS).map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('isTodoRunnable', () => {
  it('infers legacy entries from their executable suggestion', () => {
    expect(isTodoRunnable(TODO_FULL)).toBe(true)
    expect(isTodoRunnable(TODO_ORPHAN)).toBe(false)
  })

  it('lets explicit intent override inference in either direction', () => {
    expect(isTodoRunnable({ ...TODO_FULL, runnable: false })).toBe(false)
    expect(isTodoRunnable({ ...TODO_ORPHAN, runnable: true })).toBe(true)
  })
})

// ---- cards ------------------------------------------------------------------------------------

describe('the inbox card list', () => {
  it('renders one card per visible entry, started entries excluded', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(cards().map((card) => card.dataset.id)).toEqual(['t1', 't2'])
    expect(screen.queryByText('Ship the release notes')).toBeNull()
  })

  it('a full card carries summary, meta, PR link, skill and a live source-task link', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    expect(card.querySelector('[data-slot="todo-summary"]')?.textContent).toBe(TODO_FULL.summary)
    expect(card.querySelector('[data-slot="todo-meta"]')?.textContent).toContain('follow-up')
    expect(card.querySelector('[data-slot="todo-skill"]')?.textContent).toBe('skill: om-fix')
    const pr = card.querySelector<HTMLAnchorElement>('[data-slot="todo-pr"]')
    expect(pr?.getAttribute('href')).toBe(TODO_FULL.prUrl)
    expect(pr?.getAttribute('rel')).toContain('noopener')
    // run-1 exists in /api/runs → a real link into the thread.
    expect(card.querySelector('[data-slot="todo-source"]')?.getAttribute('href')).toBe('/tasks/run-1')
  })

  it('says "source task deleted" when the source run is gone (legacy honesty rule)', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[1]!
    expect(card.querySelector('[data-slot="todo-source"]')).toBeNull()
    expect(card.querySelector('[data-slot="todo-source-gone"]')?.textContent).toBe(
      'source task deleted',
    )
  })

  it('every card wears the attention grammar\'s "needs you" dot — amber, pulsing', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    for (const card of cards()) {
      const dot = card.querySelector<HTMLElement>('[data-slot="status-dot"]')
      expect(dot?.dataset.tone).toBe('pending')
      expect(dot?.className).toContain('animate-pulse')
      expect(dot?.getAttribute('title')).toBe('needs you')
    }
  })
})

// ---- Run --------------------------------------------------------------------------------------

describe('Run', () => {
  it('POSTs the legacy start endpoint and navigates to the new task', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="thread-probe"]')).not.toBeNull(),
    )
    expect(sent).toContainEqual({ path: '/api/todos/t1/start', method: 'POST' })
  })

  it('surfaces a start failure as a toast and stays on the inbox', async () => {
    stubFetch({
      'POST /api/todos/t1/start': () => jsonResponse({ error: 'already started' }, 409),
    })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)

    // The server's own words, verbatim (ApiError rule).
    expect(await screen.findByText('already started')).not.toBeNull()
    expect(document.querySelector('[data-slot="thread-probe"]')).toBeNull()
    expect(cards()).toHaveLength(2)
  })
})

// ---- Acknowledge ------------------------------------------------------------------------------

describe('Acknowledge', () => {
  it('replaces Run for a note and DELETEs it without starting a task', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const note = cards()[1]!
    expect(note.querySelector('[data-action="todo-run"]')).toBeNull()
    expect(note.querySelector('[data-action="todo-dismiss"]')).toBeNull()
    expect(note.querySelector('[data-action="todo-acknowledge"]')?.textContent).toContain(
      'Acknowledge',
    )

    fireEvent.click(note.querySelector('[data-action="todo-acknowledge"]')!)

    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(sent).toContainEqual({ path: '/api/todos/t2', method: 'DELETE' })
    expect(sent).not.toContainEqual({ path: '/api/todos/t2/start', method: 'POST' })
  })
})

// ---- Dismiss ----------------------------------------------------------------------------------

describe('Dismiss', () => {
  it('DELETEs the entry and drops the card without waiting for SSE', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-dismiss"]')!)

    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(cards()[0]!.dataset.id).toBe('t2')
    expect(sent).toContainEqual({ path: '/api/todos/t1', method: 'DELETE' })
  })

  it('surfaces a dismiss failure as a toast and keeps the card', async () => {
    stubFetch({ 'DELETE /api/todos/t1': () => jsonResponse({ error: 'not found' }, 404) })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-dismiss"]')!)

    expect(await screen.findByText('not found')).not.toBeNull()
    expect(cards()).toHaveLength(2)
  })
})

// ---- empty & error ----------------------------------------------------------------------------

describe('empty and error states', () => {
  it('an empty inbox renders the shared CenteredState template', async () => {
    stubFetch({}, [])
    renderInbox()

    const state = await waitFor(() => {
      const found = document.querySelector('[data-slot="centered-state"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(state.getAttribute('data-tone')).toBe('neutral')
    expect(state.textContent).toContain('Inbox empty')
    expect(state.textContent).toContain('follow-up suggestions')
  })

  it('an all-started inbox is an empty inbox — the audit trail is not a card list', async () => {
    stubFetch({}, [TODO_STARTED])
    renderInbox()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="centered-state"]')).not.toBeNull(),
    )
    expect(cards()).toHaveLength(0)
  })

  it('a failed todos fetch renders the danger state with the server error', async () => {
    // 4xx: the client's retry policy treats it as a considered answer, so the state is
    // immediate — no exponential-backoff retry for the test to wait out.
    stubFetch({ 'GET /api/todos': () => jsonResponse({ error: 'disk exploded' }, 400) })
    renderInbox()

    const state = await waitFor(() => {
      const found = document.querySelector('[data-slot="centered-state"][data-tone="danger"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(state.textContent).toContain('disk exploded')
  })
})

// ---- Add instructions (#413) -------------------------------------------------------------------

describe('Add instructions', () => {
  beforeEach(() => {
    // Radix's DropdownMenu (the template menu) positions with floating-ui, which needs a
    // ResizeObserver; jsdom has none (same stub as github.test.tsx / tools-menu.test.tsx).
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  interface CapturedRequest {
    path: string
    method: string
    body?: unknown
  }

  /** A dedicated stub (rather than extending `stubFetch`/`SentRequest`) so capturing the POST
   *  body here can't change the shape the OTHER describe blocks assert with `toContainEqual`. */
  function stubFetchCapturingBody(uiState: Record<string, unknown> = {}): CapturedRequest[] {
    const captured: CapturedRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
        captured.push({ path, method, body })
        if (method === 'GET' && path === '/api/todos') return jsonResponse(TODOS)
        if (method === 'GET' && path === '/api/runs') return jsonResponse([RUN_1])
        if (method === 'GET' && path === '/api/ui-state') return jsonResponse(uiState)
        if (method === 'POST' && path === '/api/todos/t1/start') return jsonResponse({ run: STARTED_RUN }, 201)
        return jsonResponse({ error: 'not found' }, 404)
      }),
    )
    return captured
  }

  async function openInstructions() {
    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')!)
  }

  it('is collapsed by default — no textarea until "+ Add instructions" is clicked', async () => {
    stubFetchCapturingBody()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-input"]')).toBeNull()
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')?.textContent).toContain(
      'Add instructions',
    )

    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')!)
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-input"]')).not.toBeNull()
  })

  it('typed instructions are appended as `prompt` on Run', async () => {
    const sent = stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    const input = cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')!
    fireEvent.change(input, { target: { value: 'Also add a regression test.' } })

    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="thread-probe"]')).not.toBeNull())

    const posted = sent.find((r) => r.method === 'POST' && r.path === '/api/todos/t1/start')
    expect(posted?.body).toEqual({ prompt: 'Also add a regression test.' })
  })

  it('leaving the instructions box empty sends no body at all — the pre-#413 call shape', async () => {
    const sent = stubFetchCapturingBody()
    renderInbox()
    await waitFor(() => expect(cards()).toHaveLength(2))

    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="thread-probe"]')).not.toBeNull())

    const posted = sent.find((r) => r.method === 'POST' && r.path === '/api/todos/t1/start')
    expect(posted?.body).toBeUndefined()
  })

  it('an opened composer can be collapsed again, keeping the draft', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    const input = cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')!
    fireEvent.change(input, { target: { value: 'Keep me.' } })

    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-hide"]')!)
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-input"]')).toBeNull()
    // A collapsed-but-non-empty composer says so — Run still carries the draft.
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')?.textContent).toContain(
      'added',
    )

    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')!)
    expect(
      cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')?.value,
    ).toBe('Keep me.')
  })

  it('the instructions box caps at the 20k the server enforces on `prompt`', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    expect(
      cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')?.maxLength,
    ).toBe(20_000)
  })

  it('the template menu inserts a built-in snippet into the instructions box', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    fireEvent.pointerDown(cards()[0]!.querySelector('[data-slot="prompt-template-trigger"]')!)
    const menu = await screen.findByRole('menu')
    fireEvent.click(menu.querySelector('[data-template="add-tests"]')!)

    await waitFor(() =>
      expect(
        cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')?.value,
      ).toBe('Also add or update tests covering this change.'),
    )
  })
})
