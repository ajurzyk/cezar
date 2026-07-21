import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, ProjectsResponse, WorkspaceConfigResponse } from '@/api/types'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Projects (multi-project spec, step 4.4; mockup `settings-global.html`).
 *
 * The two contracts the spec names for this pane, plus the one the CODE promises:
 *
 * - the checkout-root field renders the server's own 400 reason INLINE (the step-2.7 writability
 *   probe is the only thing that can decide this, so a client-side paraphrase would be a
 *   guess presented as a fact);
 * - a project with running tasks is refused with a 409 whose message reaches the user;
 * - "Remove" deregisters and says so — the confirm copy must never let a reader believe the
 *   folder is about to be deleted. The server-side half of that guarantee (no file on disk is
 *   touched) is pinned in src/server/projects-api.test.ts.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'cezar',
    name: 'cezar',
    root: '/home/piotr/Projects/cezar',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'local',
    status: 'ok',
    branch: 'main',
  },
  {
    id: 'shop-backend',
    name: 'shop-backend',
    root: '/home/piotr/cezar/projects/shop-backend',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'checkout',
    status: 'ok',
  },
  {
    id: 'old-spike',
    name: 'old-spike',
    root: '/home/piotr/tmp/old-spike',
    addedAt: '2026-06-02T09:00:00.000Z',
    lastOpenedAt: '2026-06-02T09:00:00.000Z',
    source: 'local',
    status: 'missing',
  },
]

type Answers = {
  /** What `PUT /api/workspace/config` answers — a 400 stands in for the writability probe. */
  putConfig?: { status: number; payload: unknown }
  /** What `DELETE /api/projects/:id` answers. */
  del?: { status: number; payload: unknown }
}

function serve(answers: Answers = {}) {
  requests = []
  const registry: ProjectsResponse = {
    projects: PROJECTS,
    bootProject: 'cezar',
    projectsDir: '~/cezar/projects',
  }
  const config: WorkspaceConfigResponse = {
    projectsDir: '~/cezar/projects',
    resources: { maxParallel: 2, memoryLimitMb: null, worktreeRetentionDefault: 10 },
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/projects' && method === 'GET') return json(registry)
      if (url === '/api/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/workspace/config' && method === 'PUT') {
        if (answers.putConfig) return json(answers.putConfig.payload, answers.putConfig.status)
        config.projectsDir = String(body?.projectsDir ?? config.projectsDir)
        return json(config)
      }
      if (url.startsWith('/api/projects/') && method === 'DELETE') {
        const answer = answers.del ?? { status: 200, payload: { removed: true, id: url.split('/').pop() } }
        if (answer.status === 200) {
          registry.projects = registry.projects.filter((p) => !url.endsWith(`/${p.id}`))
        }
        return json(answer.payload, answer.status)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates so the (unscoped) global settings shell renders immediately. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'cezar' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: PROJECTS,
    bootProject: 'cezar',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderProjects() {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <MemoryRouter initialEntries={['/settings/global/projects']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => document.querySelectorAll('[data-slot="project-row"]')
const row = (id: string) => document.querySelector<HTMLElement>(`[data-slot="project-row"][data-project="${id}"]`)
const removeButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[data-action="project-remove"]')
const rootInput = () => document.querySelector<HTMLInputElement>('[data-slot="projects-checkout-root"]')
const saveRoot = () => document.querySelector<HTMLButtonElement>('[data-action="projects-save-checkout-root"]')
const inlineError = () => document.querySelector<HTMLElement>('[data-slot="projects-checkout-root-error"]')
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-action="projects-confirm-remove"]')
const deletes = () => requests.filter((r) => r.method === 'DELETE')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Projects', () => {
  it('lists every registered project with its status, source and path', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(row('shop-backend')?.textContent).toContain('/home/piotr/cezar/projects/shop-backend')
    expect(row('shop-backend')?.textContent).toContain('checkout')
    // The `missing` row (step 3.3 greys it out in the sidebar) is actionable HERE.
    expect(row('old-spike')?.textContent).toContain('folder not found')
    expect(removeButton('old-spike')?.disabled).toBe(false)
  })

  it('renders the 400 reason from the writability probe INLINE, verbatim', async () => {
    // The exact shape `PUT /api/workspace/config` answers with when the probe fails (step 2.7).
    const reason = 'not writable: EACCES: permission denied, mkdir \'/opt/checkouts\''
    serve({ putConfig: { status: 400, payload: { error: reason } } })
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    fireEvent.change(rootInput()!, { target: { value: '/opt/checkouts' } })
    fireEvent.click(saveRoot()!)

    await waitFor(() => expect(inlineError()).not.toBeNull())
    // Verbatim — no paraphrase, no generic "invalid path": the server's sentence is the only
    // one that tells the user what to fix.
    expect(inlineError()!.textContent).toContain(reason)
    expect(inlineError()!.textContent).toContain('setting unchanged')
    // Inline, NOT a toast that scrolls away from the field it is about.
    expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('not writable')
    // The field keeps what the user typed, and the input is flagged for assistive tech.
    expect(rootInput()!.value).toBe('/opt/checkouts')
    expect(rootInput()!.getAttribute('aria-invalid')).toBe('true')
  })

  it('clears the inline error as soon as the value changes again', async () => {
    serve({ putConfig: { status: 400, payload: { error: 'not writable: /opt/checkouts' } } })
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    fireEvent.change(rootInput()!, { target: { value: '/opt/checkouts' } })
    fireEvent.click(saveRoot()!)
    await waitFor(() => expect(inlineError()).not.toBeNull())
    // The message names a path that is no longer in the field — leaving it up would be a lie.
    fireEvent.change(rootInput()!, { target: { value: '~/code' } })
    await waitFor(() => expect(inlineError()).toBeNull())
  })

  it('saves a valid checkout root through PUT /api/workspace/config', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    expect(saveRoot()!.disabled).toBe(true) // unchanged
    fireEvent.change(rootInput()!, { target: { value: '~/code' } })
    fireEvent.click(saveRoot()!)
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'PUT' && r.url === '/api/workspace/config')).toEqual([
        { method: 'PUT', url: '/api/workspace/config', body: { projectsDir: '~/code' } },
      ]),
    )
    expect(inlineError()).toBeNull()
  })

  it('removes a project only after a confirm that promises no files are deleted', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('shop-backend')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())

    // The copy is the guarantee: a user must not be able to read this as "delete my repo".
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('only unregisters')
    expect(dialog.textContent).toContain('nothing on disk is deleted')
    expect(confirmButton()!.textContent).toContain('Remove from list')
    expect(deletes()).toEqual([])

    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(deletes().map((r) => r.url)).toEqual(['/api/projects/shop-backend']))
    await waitFor(() => expect(row('shop-backend')).toBeNull())
  })

  it('dismissing the confirm never calls the route', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('old-spike')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(screen.getByText('Keep it'))
    await waitFor(() => expect(confirmButton()).toBeNull())
    expect(deletes()).toEqual([])
  })

  it('surfaces the running-tasks 409 and keeps the project', async () => {
    const error = 'shop-backend has 2 running tasks — cancel or finish them before removing the project'
    serve({ del: { status: 409, payload: { error, runningTasks: 2 } } })
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('shop-backend')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(error))
    // Refused means untouched — the row is still there.
    expect(row('shop-backend')).not.toBeNull()
  })

  it('disables Remove for the project cezar is serving', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    // The server refuses it too (it re-registers at every start); disabling explains it first.
    expect(removeButton('cezar')?.disabled).toBe(true)
    expect(removeButton('cezar')?.title).toContain('re-registers')
  })
})
