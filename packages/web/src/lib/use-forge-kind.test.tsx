import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HealthResponse, ProjectListEntry, ProjectsResponse } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import { useForgeKind } from './use-forge-kind'

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

/** Only the two fields this hook reads — the rest of `/health` is irrelevant here and a full
 *  fixture would go stale for no benefit. */
function health(forge: HealthResponse['forge']): HealthResponse {
  return { forge } as HealthResponse
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

function projects(entries: ProjectListEntry[]): ProjectsResponse {
  return { projects: entries, bootProject: entries[0]?.id ?? 'cezar', projectsDir: '/srv/dev' }
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
})
