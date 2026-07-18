import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { UiState } from '@/api/types'
import { SkillsBanner } from './skills-banner'

/**
 * The banner's wiring: ui-state gating + the dismiss-once persistence (#391). Mirrors
 * run-notifications.test.tsx's pattern — seed the cache directly rather than mocking fetch,
 * since the query is what the component actually reads and writes through.
 */

let clients: QueryClient[] = []

function makeClient(uiState: UiState | undefined): QueryClient {
  const client = createQueryClient()
  if (uiState !== undefined) client.setQueryData(queryKeys.uiState, uiState)
  clients.push(client)
  return client
}

function mount(uiState: UiState | undefined, fetchImpl?: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl ?? vi.fn(() => new Promise<never>(() => {})))
  const client = makeClient(uiState)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SkillsBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { client }
}

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const banner = () => document.querySelector('[data-slot="banner"]')

describe('SkillsBanner', () => {
  it('renders nothing before ui-state has resolved — no flash before the dismissal truth loads', () => {
    mount(undefined)
    expect(banner()).toBeNull()
  })

  it('shows the promo once ui-state resolves with no dismissal recorded', () => {
    mount({})
    expect(banner()).not.toBeNull()
    expect(banner()?.textContent).toContain('open-mercato/skills')
    expect(banner()?.textContent).toContain("npx skills add open-mercato/skills --skill '*'")
  })

  it('says why to install skills cezar already loads, and points at Skills for the in-app refresh', () => {
    mount({})
    expect(banner()?.textContent).toContain('cezar already loads them')
    expect(banner()?.textContent).toContain('outside cezar')
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('href')).toBe('/skills')
  })

  it('stays hidden once dismissedSkillsBanner is already true', () => {
    mount({ dismissedSkillsBanner: true })
    expect(banner()).toBeNull()
  })

  it('dismissing hides it immediately and PUTs the flag to /api/ui-state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('/api/ui-state')
      expect(init?.method).toBe('PUT')
      expect(JSON.parse(String(init?.body))).toEqual({ dismissedSkillsBanner: true })
      return new Response(JSON.stringify({ dismissedSkillsBanner: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    mount({}, fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /dismiss the open-mercato\/skills banner/i }))

    // Optimistic hide: gone without waiting on the PUT's round trip.
    await vi.waitFor(() => expect(banner()).toBeNull())
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('a failed dismiss toasts and re-syncs, rather than silently claiming a save that never happened', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch')
    })
    const { client } = mount({}, fetchMock)
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    fireEvent.click(screen.getByRole('button', { name: /dismiss the open-mercato\/skills banner/i }))

    await vi.waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.uiState }))
  })
})
