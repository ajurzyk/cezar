import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'
import { SETTINGS_SECTIONS, visibleSettingsSections } from './registry'

/**
 * The Settings shell + Appearance section (R6 Step 1.3): registry rendering and hidden
 * gating, the appearance round-trip against a stubbed ui-state API, and boot application
 * of persisted values. The URL map itself (including hidden sections 404ing) lives in
 * routes.test.tsx.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** GET/PUT /api/ui-state answer; everything else the routes fetch stays honestly pending. */
function serve(uiState: Record<string, unknown> = {}) {
  requests = []
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      return new Promise<never>(() => {})
    }),
  )
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <AppRoutes />
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  document.documentElement.classList.remove('light')
})

describe('the section registry', () => {
  it('declares the spec §Settings sections, later ones hidden', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))
    for (const id of ['bookmarklets', 'appearance', 'agents', 'agent-config', 'resources', 'mcp', 'notifications']) {
      expect(byId.get(id as never)?.hidden).toBeUndefined()
    }
    // Listed in the registry but hidden until implemented (later phase).
    for (const id of ['keyboard']) {
      expect(byId.get(id as never)?.hidden).toBe(true)
    }
    expect(visibleSettingsSections().map((s) => s.id)).toEqual([
      'bookmarklets',
      'appearance',
      'agents',
      'agent-config',
      'resources',
      'mcp',
      'notifications',
    ])
  })
})

describe('the settings shell', () => {
  it('renders the section nav from the registry — visible sections only', () => {
    renderAt('/settings/appearance')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    const ids = [...nav.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(['bookmarklets', 'appearance', 'agents', 'agent-config', 'resources', 'mcp', 'notifications'])
    // The active section is marked for assistive tech, not just by color.
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('appearance')
    // The mobile pill row renders through the same registry — the two can never disagree.
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect([...pills.querySelectorAll('[data-section]')].length).toBe(7)
  })

  it('/settings is the registry as an index — one card per visible section', () => {
    renderAt('/settings')
    const index = document.querySelector('[data-slot="settings-index"]')!
    const ids = [...index.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(['bookmarklets', 'appearance', 'agents', 'agent-config', 'resources', 'mcp', 'notifications'])
    expect(index.querySelector('[data-section="bookmarklets"]')?.getAttribute('href')).toBe(
      '/settings/bookmarklets',
    )
    expect(index.querySelector('[data-section="appearance"]')?.getAttribute('href')).toBe(
      '/settings/appearance',
    )
  })

  it('unfinished sections say so through the shared CenteredState template', () => {
    // Hidden sections are not routed (their URLs 404) — render the registry component
    // directly to pin the placeholder contract itself. (keyboard is the last hidden one;
    // mcp shipped with the agent-config feature #404.)
    const Keyboard = SETTINGS_SECTIONS.find((s) => s.id === 'keyboard')!.component
    render(<Keyboard />)
    const state = document.querySelector('[data-slot="centered-state"]')
    expect(state?.textContent).toContain('later phase')
  })
})

describe('the appearance section', () => {
  it('persisted values apply at boot: server ui-state stamps the root and the controls', async () => {
    serve({ appearance: { accent: 'violet', density: 'compact' } })
    renderAt('/settings/appearance')

    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('violet')
    })
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    // The mirror follows the server, so the next cold load pre-paints the truth.
    expect(localStorage.getItem('cez-accent')).toBe('violet')
    expect(localStorage.getItem('cez-density')).toBe('compact')
  })

  it('accent round-trip: apply immediately, PUT the FULL appearance object', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))
    expect(document.documentElement.dataset.accent).toBe('violet')

    // The whole object, not a partial — the server's ui-state merge is shallow, so a bare
    // `{ accent }` would silently drop the stored density.
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'compact' },
      })
    })
    expect(localStorage.getItem('cez-accent')).toBe('violet')
  })

  it('density flips back to the default and the attribute comes OFF the root', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/appearance')
    await waitFor(() => {
      expect(document.documentElement.dataset.density).toBe('compact')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }))
    expect(document.documentElement.hasAttribute('data-density')).toBe(false)
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/ui-state')?.body).toEqual({
        appearance: { accent: 'lime', density: 'comfortable' },
      })
    })
  })

  it('theme rides the existing theme system: class + localStorage, no ui-state write', async () => {
    renderAt('/settings/appearance')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(localStorage.getItem('cez-theme')).toBe('light')
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(localStorage.getItem('cez-theme')).toBe('dark')

    // Theme is per-browser by design (pre-paint) — it must never leak into ui-state.json.
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/ui-state' && r.method === 'GET')).toBe(true)
    })
    expect(requests.some((r) => r.url === '/api/ui-state' && r.method === 'PUT')).toBe(false)
  })
})
