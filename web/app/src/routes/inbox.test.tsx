import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

// ---- the inbox gate (#471) --------------------------------------------------------------------

/** The health payload the route reads `capabilities.followups` from. Only the fields the route
 *  touches — this is a fixture, not a mirror of the real response. */
const healthResponse = (followups: boolean) =>
  jsonResponse({
    version: '0.0.0-test',
    repoRoot: '/repo',
    repo: null,
    checks: [],
    forge: null,
    capabilities: { localHandoff: true, followups },
  })

describe('the inbox gate (#471)', () => {
  it('says the inbox is off — not "empty" — when the server has it disabled', async () => {
    const sent = stubFetch({ 'GET /api/health': () => healthResponse(false) })
    renderInbox()

    expect(await screen.findByText('The follow-up inbox is off')).toBeTruthy()
    // The distinction matters: "Inbox empty" would blame the agents for a switched-off feature.
    expect(screen.queryByText('Inbox empty')).toBeNull()
    // And it tells the user how to get it back.
    expect(screen.getByText(/CEZ_FOLLOWUPS=1/)).toBeTruthy()
    expect(cards()).toHaveLength(0)

    // Parked, not polled: the endpoint could only answer [] anyway.
    await waitFor(() => expect(sent.some((r) => r.path === '/api/health')).toBe(true))
    expect(sent.filter((r) => r.path === '/api/todos')).toHaveLength(0)
  })

  it('renders the real inbox once the server reports the capability', async () => {
    stubFetch({ 'GET /api/health': () => healthResponse(true) })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(screen.queryByText('The follow-up inbox is off')).toBeNull()
  })

  it('does not park the list while health is still unknown', async () => {
    // health never answers 200 here (the stub 404s it) — an enabled server must not have its
    // inbox held hostage by a request the list does not depend on.
    stubFetch()
    renderInbox()
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(screen.queryByText('The follow-up inbox is off')).toBeNull()
  })
})
