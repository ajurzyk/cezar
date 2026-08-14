import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HealthResponse, ProjectListEntry, ProjectsResponse } from '@open-mercato/cezar-api-client'

import { useHealth } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { useForgeKind, useForgeKindStatus } from './use-forge-kind'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function project(over: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'cezar',
    name: 'cezar',
    root: '/srv/dev/cezar',
    addedAt: '2026-07-19T00:00:00.000Z',
    lastOpenedAt: '2026-07-20T00:00:00.000Z',
    source: 'local',
    status: 'ok',
    ...over,
  }
}

/** Only the fields this hook reads — the forge, and the boot project that forge describes. The
 *  rest of `/health` is irrelevant here and a full fixture would go stale for no benefit. */
function health(forge: HealthResponse['forge'], bootProject = 'cezar'): HealthResponse {
  return { forge, bootProject } as HealthResponse
}

/** Serve `/api/v1/projects` and `/api/v1/health` from fixtures; 404 anything else so an
 *  unexpected request fails loudly instead of hanging. */
function serve(payloads: { projects?: ProjectsResponse; health?: HealthResponse }) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    const body =
      url.includes('/api/v1/projects') ? payloads.projects
        : url.includes('/api/v1/health') ? payloads.health
          : undefined
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function projects(entries: ProjectListEntry[], bootProject?: string): ProjectsResponse {
  return {
    projects: entries,
    bootProject: bootProject ?? entries[0]?.id ?? 'cezar',
    projectsDir: '/srv/dev',
  }
}

function wrapper(pathname: string) {
  const client = createQueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[pathname]}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
}

/**
 * Which forge the SCREEN is looking at. `/api/v1/health` cannot answer this on a multi-project
 * workspace: it describes the boot folder only, and on the live instance the boot folder is a
 * repo with no forge at all — so a screen that trusted health would call a Forgejo backlog
 * "GitHub", or show nothing.
 */
describe('useForgeKind', () => {
  it('reads the forge of the project in the URL, not the boot project', async () => {
    serve({
      projects: projects([project(), project({ id: 'orakton', name: 'orakton', forge: 'forgejo' })]),
      health: health(null),
    })
    const { result } = renderHook(() => useForgeKind(), { wrapper: wrapper('/p/orakton/github') })
    await waitFor(() => expect(result.current).toBe('forgejo'))
  })

  it('prefers the URL project even when health names a different forge', async () => {
    serve({
      projects: projects([project({ id: 'orakton', name: 'orakton', forge: 'forgejo' })]),
      health: health({ kind: 'github', available: true }),
    })
    const { result } = renderHook(() => useForgeKind(), { wrapper: wrapper('/p/orakton/github') })
    await waitFor(() => expect(result.current).toBe('forgejo'))
  })

  // Single-project mode mounts the routes unscoped, so there is no `/p/<id>` to read — and there
  // health IS the answer, because the boot folder is the only project.
  it('falls back to health when the URL carries no project scope', async () => {
    serve({ projects: projects([project()]), health: health({ kind: 'forgejo', available: true }) })
    const { result } = renderHook(() => useForgeKind(), { wrapper: wrapper('/github') })
    await waitFor(() => expect(result.current).toBe('forgejo'))
  })

  it('answers undefined for a project the registry says has no forge', async () => {
    serve({
      projects: projects([project({ id: 'cezar-lab', name: 'cezar-lab' })]),
      health: health({ kind: 'forgejo', available: true }),
    })
    const { result } = renderHook(() => useForgeKind(), { wrapper: wrapper('/p/cezar-lab/github') })
    // The registry entry is the authority once it has loaded; health describes someone else.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(result.current).toBeUndefined())
  })

  it('answers undefined before anything has loaded — nothing is claimed early', () => {
    serve({ projects: projects([project({ forge: 'forgejo' })]), health: health(null) })
    const { result } = renderHook(() => useForgeKind(), { wrapper: wrapper('/p/cezar/github') })
    expect(result.current).toBeUndefined()
  })

  // `/api/v1/health` is WORKSPACE-level — it describes the boot folder alone (the same rule
  // `useProjectRepoBase` enforces before it synthesizes a repo link). Borrowing its forge for a
  // scoped project labels a Forgejo backlog "GitHub" for as long as the registry is in flight —
  // and since an errored registry degrades to `[]` on purpose, "as long as" can mean forever.
  it('does not borrow the boot project’s forge while the registry is still loading', async () => {
    let releaseRegistry!: () => void
    const registryArrived = new Promise<void>((resolve) => { releaseRegistry = resolve })
    fetchMock.mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/v1/health')) {
        return json(health({ kind: 'github', available: true }, 'cezar-lab'))
      }
      if (url.includes('/api/v1/projects')) {
        await registryArrived
        return json(projects([project({ id: 'orakton', name: 'orakton', forge: 'forgejo' })], 'cezar-lab'))
      }
      return new Response('not found', { status: 404 })
    })
    // Health rides along in the same hook so the assertion below can wait for it to have LANDED
    // — waiting on `fetch` alone would assert before the answer reached the cache and pass for
    // the wrong reason.
    const { result } = renderHook(
      () => ({ kind: useForgeKind(), health: useHealth().data }),
      { wrapper: wrapper('/p/orakton/github') },
    )

    // Health has answered "github" — about the BOOT folder. The URL project is someone else.
    await waitFor(() => expect(result.current.health).toBeDefined())
    expect(result.current.kind).toBeUndefined()
    releaseRegistry()
    await waitFor(() => expect(result.current.kind).toBe('forgejo'))
  })
})

/**
 * `settled` answers a question `kind` cannot: has the AUTHORITY for this surface spoken? The
 * hand-off box corrects its pre-filled prompt exactly once, and a correction spent on whatever
 * source answered first is a correction not available when the registry finally answers.
 */
describe('useForgeKindStatus', () => {
  it('is unsettled until the authority for the surface has answered', async () => {
    serve({
      projects: projects([project({ id: 'orakton', name: 'orakton', forge: 'forgejo' })], 'cezar-lab'),
      health: health({ kind: 'github', available: true }, 'cezar-lab'),
    })
    const { result } = renderHook(() => useForgeKindStatus(), { wrapper: wrapper('/p/orakton/github') })

    expect(result.current).toEqual({ kind: undefined, settled: false })
    await waitFor(() => expect(result.current).toEqual({ kind: 'forgejo', settled: true }))
  })

  // A registry that has answered and names no forge for this project IS an answer: the screen
  // keeps the "GitHub" default, and nothing may correct it later.
  it('settles on a registry entry that names no forge', async () => {
    serve({
      projects: projects([project({ id: 'cezar-lab', name: 'cezar-lab' })]),
      health: health({ kind: 'forgejo', available: true }, 'cezar-lab'),
    })
    const { result } = renderHook(() => useForgeKindStatus(), { wrapper: wrapper('/p/cezar-lab/github') })
    await waitFor(() => expect(result.current).toEqual({ kind: undefined, settled: true }))
  })
})
