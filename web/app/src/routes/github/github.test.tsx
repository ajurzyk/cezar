import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubData, GithubItem, Skill, WorkflowsResponse } from '@/api/types'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { GithubRoute } from './github'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // Radix popovers position with floating-ui, which needs a ResizeObserver; jsdom has none.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const ISSUE_142: GithubItem = {
  kind: 'issue',
  number: 142,
  title: 'Login form drops session on refresh',
  author: 'ada',
  createdAt: '2026-07-09T08:00:00.000Z',
  labels: ['bug', 'auth'],
  body: 'Repro: log in, hit reload — you land back on /login.',
  url: 'https://github.com/acme/demo/issues/142',
  comments: 3,
}

const ISSUE_139: GithubItem = {
  kind: 'issue',
  number: 139,
  title: 'Add --json flag to the CLI',
  author: 'lin',
  createdAt: '2026-07-10T08:00:00.000Z',
  labels: [],
  body: '',
  url: 'https://github.com/acme/demo/issues/139',
  comments: 0,
}

const PR_137: GithubItem = {
  kind: 'pr',
  number: 137,
  title: 'Stream tokens over SSE',
  author: 'grace',
  createdAt: '2026-07-11T08:00:00.000Z',
  labels: ['perf'],
  body: 'Replaces polling with a single SSE stream.',
  url: 'https://github.com/acme/demo/pull/137',
  comments: 1,
  additions: 120,
  deletions: 30,
  checks: 'failing',
}

const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  syncedAt: '2026-07-15T08:00:00.000Z',
  issues: [ISSUE_142, ISSUE_139],
  prs: [PR_137],
}

const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    { name: 'quick-task', description: 'one step', steps: [], source: 'built-in' },
    { name: 'ship-it', description: 'plan, build, review', steps: [], source: 'file' },
  ],
  issues: [],
}

// Server order is global-first ON PURPOSE: the dropdown must reorder project-first (#377).
const SKILLS: Skill[] = [
  { name: 'g-review', description: 'global review', body: '', path: '/g/g-review.md', source: 'global' },
  { name: 'om-fix', description: 'project fixer', body: '', path: '/p/om-fix.md', source: 'ai' },
  { name: 'team-x', description: 'team skill', body: '', path: '/t/team-x.md', source: 'team' },
]

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (repo-git.test.tsx): records requests, serves the fixtures,
 *  and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/github') return jsonResponse(GITHUB)
      if (method === 'GET' && path === '/api/github?limit=1000') return jsonResponse(GITHUB)
      if (method === 'GET' && path === '/api/workflows') return jsonResponse(WORKFLOWS)
      if (method === 'GET' && path === '/api/skills') return jsonResponse(SKILLS)
      if (method === 'POST' && path === '/api/runs') {
        return jsonResponse({
          id: 'run-1',
          title: 'queued',
          workflow: 'quick-task',
          task: 't',
          status: 'queued',
          createdAt: '2026-07-15T08:00:00.000Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

/** Cold-load the tab at a URL, with the same route map routes.tsx registers. */
function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/github" element={<GithubRoute view="issues" />} />
          <Route path="/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/github/prs/:n" element={<GithubRoute view="prs" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-row"]')]
const detail = () => document.querySelector('[data-slot="gh-detail-inner"]')

// ---- lists + detail ---------------------------------------------------------------------------

describe('the GitHub tab lists', () => {
  it('/github renders the header, both count tabs, the issue rows, and the first issue’s detail', async () => {
    stubFetch()
    renderAt('/github')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-header"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('GitHub')
    expect(document.querySelector('[data-slot="gh-repo"]')?.textContent).toBe('acme/demo')

    const tabs = [...document.querySelectorAll('[data-slot="gh-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Issues · 2', href: '/github', current: 'page' },
      { text: 'Pull requests · 1', href: '/github/prs', current: null },
    ])

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139'])
    // Rows are deep links, not click handlers.
    expect(rows()[0]?.getAttribute('href')).toBe('/github/issues/142')

    // No URL selection → the first item's detail renders (legacy parity), marked current.
    expect(rows()[0]?.getAttribute('aria-current')).toBe('page')
    await waitFor(() => expect(detail()?.textContent).toContain('Login form drops session'))
  })

  it('/github/prs lists pull requests', async () => {
    stubFetch()
    renderAt('/github/prs')

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/prs/137')
  })

  it('counts at the fast-batch cap render as 30+ until the full fetch lands', async () => {
    const many: GithubData = {
      ...GITHUB,
      issues: Array.from({ length: 30 }, (_, i) => ({ ...ISSUE_142, number: i + 1, url: `u${i}` })),
    }
    stubFetch({
      'GET /api/github': () => jsonResponse(many),
      // The background full fetch never answers — the fast batch must stand, with its "+".
      'GET /api/github?limit=1000': () => new Response(null, { status: 500 }),
    })
    renderAt('/github')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-tabs"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="gh-tabs"] a')?.textContent).toBe('Issues · 30+')
  })

  it('a row deep link selects that item and renders its detail', async () => {
    stubFetch()
    renderAt('/github/issues/139')

    await waitFor(() => expect(detail()?.textContent).toContain('Add --json flag'))
    expect(document.querySelector('[data-slot="gh-row"][data-number="139"]')?.getAttribute('aria-current')).toBe('page')
    // A blank body renders the honest placeholder, not an empty markdown shell.
    expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('(no description)')
  })

  it('an unknown number renders the honest not-in-list state, not a crash', async () => {
    stubFetch()
    renderAt('/github/issues/9999')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Not in the open list' })).toBeTruthy(),
    )
  })

  it('dragging a row carries the hand-to-agent prompt as text/plain', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows()).toHaveLength(2))

    const setData = vi.fn()
    fireEvent.dragStart(rows()[0]!, { dataTransfer: { setData, effectAllowed: 'none' } })
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      expect.stringContaining('Fix GitHub issue #142: Login form drops session on refresh'),
    )
    expect(setData.mock.calls[0]?.[1]).toContain(ISSUE_142.url)
  })
})

describe('the GitHub detail pane', () => {
  it('a PR renders the meta line, ± stat, label chips and the checks badge', async () => {
    stubFetch()
    renderAt('/github/prs/137')

    await waitFor(() => expect(detail()).not.toBeNull())
    const meta = document.querySelector('[data-slot="gh-meta"]')?.textContent ?? ''
    expect(meta).toContain('#137')
    expect(meta).toContain('pull request')
    expect(meta).toContain('opened by grace')
    expect(meta).toContain('1 comments')
    expect(document.querySelector('[data-slot="gh-diffstat"]')?.textContent).toBe('+120 −30')
    expect(document.querySelector('[data-slot="gh-open-link"]')?.getAttribute('href')).toBe(PR_137.url)

    expect(document.querySelector('[data-slot="gh-label"]')?.textContent).toBe('perf')
    const checks = document.querySelector('[data-slot="gh-checks"]')
    expect(checks?.getAttribute('data-checks')).toBe('failing')
    expect(checks?.textContent).toContain('checks failing')
  })

  it('the checks badge links to the PR checks tab on GitHub, open in a new tab (#415)', async () => {
    stubFetch()
    renderAt('/github/prs/137')

    await waitFor(() => expect(detail()).not.toBeNull())
    const checks = document.querySelector('[data-slot="gh-checks"]')
    expect(checks?.tagName).toBe('A')
    expect(checks?.getAttribute('href')).toBe(`${PR_137.url}/checks`)
    expect(checks?.getAttribute('target')).toBe('_blank')
    expect(checks?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders the issue body through the markdown pipeline', async () => {
    stubFetch()
    renderAt('/github/issues/142')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain(
        'Repro: log in, hit reload',
      ),
    )
  })
})

// ---- forge gating -----------------------------------------------------------------------------

describe('the unavailable forge state', () => {
  it('renders the server reason and the gh hint, and Try again refetches with refresh=1', async () => {
    const unavailable: GithubData = { available: false, reason: 'gh not installed', issues: [], prs: [] }
    const sent = stubFetch({
      'GET /api/github': () => jsonResponse(unavailable),
      'GET /api/github?refresh=1': () => jsonResponse(unavailable),
    })
    renderAt('/github')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'GitHub is unavailable here' })).toBeTruthy(),
    )
    expect(screen.getByText('gh not installed')).toBeTruthy()
    // The full fetch must NOT fire against an unreachable forge (two-shot rule).
    expect(sent.some((request) => request.path === '/api/github?limit=1000')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(sent.some((request) => request.path === '/api/github?refresh=1')).toBe(true),
    )
  })
})

// ---- hand to agent ----------------------------------------------------------------------------

async function openDetail(entry = '/github/issues/142') {
  renderAt(entry)
  await waitFor(() => expect(document.querySelector('[data-slot="gh-hand"]')).not.toBeNull())
}

describe('the hand-to-agent pickers (#385)', () => {
  it('the workflow dropdown lists, filters, selects — and re-selecting deselects', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-workflow-option"]')).toHaveLength(2),
    )

    // cmdk filtering: a query narrows the list.
    fireEvent.change(screen.getByPlaceholderText('search workflows…'), { target: { value: 'ship' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-workflow-option"]')).toHaveLength(1),
    )

    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain('ship-it'),
    )

    // Click the selected workflow again → deselected (legacy chip parity).
    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).not.toContain('ship-it'),
    )
  })

  it('the skills dropdown is project-first with bold project rows (#377), and keeps selection visible as chips', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    // Server order was global-first; the menu reorders project skills first, emphasized.
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    expect(options.map((option) => option.dataset.skill)).toEqual(['om-fix', 'g-review', 'team-x'])
    expect(options[0]?.querySelector('.font-semibold')).not.toBeNull()
    expect(options[1]?.querySelector('.font-semibold')).toBeNull()

    // Multi-select: toggling keeps the menu open; the chip row mirrors the selection.
    fireEvent.click(options[0]!)
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)
    await waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map(
          (chip) => chip.dataset.skill,
        ),
      ).toEqual(['om-fix', 'g-review']),
    )
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).toContain('· 2')

    // The filter narrows the list but can never hide the selection — the chips live outside.
    fireEvent.change(screen.getByPlaceholderText('search skills…'), { target: { value: 'team' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(1),
    )
    expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(2)

    // A chip's × deselects without the dropdown.
    fireEvent.click(document.querySelector('[data-slot="gh-skill-chip"][data-skill="om-fix"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1),
    )
  })

  it('the eye opens the read-only skill preview (shared detail component) without toggling the row', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    fireEvent.click(
      document.querySelector('[data-slot="gh-skill-option"][data-skill="om-fix"] [data-slot="gh-skill-view"]')!,
    )
    // The Settings catalog's detail component, as a dialog — name, source tag, path.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="skill-preview"] [data-slot="skill-detail"]')).not.toBeNull(),
    )
    const preview = document.querySelector('[data-slot="skill-preview"]')!
    expect(preview.textContent).toContain('om-fix')
    expect(preview.textContent).toContain('project fixer')
    expect(preview.querySelector('[data-slot="skill-path"]')?.textContent).toContain('/p/om-fix.md')
    // Viewing is read-only: nothing got selected (no chip, no count on the trigger).
    expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(0)
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).not.toContain('·')
    // The escape hatch into the browsable Skills catalog.
    expect(
      preview.querySelector('[data-slot="skill-preview-manage"]')?.getAttribute('href'),
    ).toBe('/skills?skill=om-fix')
  })

  it('multi-keyword search: "fix project" narrows the skills list to matches (#411)', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    // "fix project" should match om-fix (name splits "om","fix" + description "project fixer")
    fireEvent.change(screen.getByPlaceholderText('search skills…'), { target: { value: 'fix project' } })
    await waitFor(() => {
      const visible = [...document.querySelectorAll('[data-slot="gh-skill-option"]')]
      expect(visible).toHaveLength(1)
      expect(visible[0]?.getAttribute('data-skill')).toBe('om-fix')
    })
  })
})

describe('the hand-to-agent run (legacy three-way body)', () => {
  it('nothing selected → quick-task, and the queued affordance links the new run', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/runs')
    expect(posted?.body).toMatchObject({ workflow: 'quick-task' })
    expect((posted?.body as { task: string }).task).toContain('Fix GitHub issue #142')
    expect((posted?.body as { task: string }).task).toContain(ISSUE_142.url)

    expect(document.querySelector('[data-slot="gh-view-run"]')?.getAttribute('href')).toBe('/tasks/run-1')
    // The list row grows the queued flag.
    expect(document.querySelector('[data-slot="gh-queued-flag"]')).not.toBeNull()
  })

  it('a selected workflow rides the POST, with toggled skills as a prompt hint', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-skill="om-fix"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="om-fix"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/runs')).toBe(true),
    )
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/runs')
    expect(posted?.body).toMatchObject({ workflow: 'ship-it' })
    expect((posted?.body as { task: string }).task).toContain('Use these skills where relevant: om-fix.')
  })

  it('skills without a workflow become the steps chain (spec 008)', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-skill="om-fix"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="om-fix"]')!)
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/runs')).toBe(true),
    )
    const body = sent.find((request) => request.method === 'POST' && request.path === '/api/runs')
      ?.body as { workflow?: string; steps?: Array<{ id: string; skill: string; prompt: string }> }
    expect(body.workflow).toBeUndefined()
    expect(body.steps).toEqual([
      { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
      { id: 'g-review', name: 'g-review', skill: 'g-review', prompt: '{{task}}' },
    ])
  })

  it('a server refusal surfaces as a danger toast and no queued flag', async () => {
    stubFetch({
      'POST /api/runs': () => jsonResponse({ error: 'a task is already running' }, 409),
    })
    await openDetail()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(screen.getByText('a task is already running')).toBeTruthy())
    expect(document.querySelector('[data-slot="gh-queued"]')).toBeNull()
  })
})
