import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse } from '@/api/types'
import { AppShellContainer, repoChipOf } from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the shell's breakpoint effect and the theme toggle need one.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  )
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const HEALTH: HealthResponse = {
  version: '0.1.3',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true },
}

const TODOS = [
  { id: 't1', summary: 'Review the PR' },
  { id: 't2', summary: 'Rebase the branch' },
]

/** Answer each endpoint the shell reads; anything else 404s loudly rather than silently
 *  resolving to `{}` and making a broken wiring look fine. */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderShell() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const repoChip = () => document.querySelector('[data-slot="repo-chip"]')
const versionChip = () => document.querySelector('[data-slot="version-chip"]')
const navBadge = () => document.querySelector('[data-slot="nav-badge"]')

describe('repoChipOf', () => {
  it.each([
    { name: 'a plain root', root: '/home/me/Projects/cezar', expected: 'cezar' },
    { name: 'a trailing slash', root: '/home/me/cezar/', expected: 'cezar' },
    { name: 'a windows path', root: 'C:\\Users\\me\\cezar', expected: 'cezar' },
    { name: 'the filesystem root as a repo', root: '/', expected: null },
  ])('takes the basename of $name', ({ root, expected }) => {
    const chip = repoChipOf({ ...HEALTH, repo: { root, branch: 'main' } })
    expect(chip?.name ?? null).toBe(expected)
  })

  it('is null while health is unknown, and outside a git repo', () => {
    expect(repoChipOf(undefined)).toBeNull()
    expect(repoChipOf({ ...HEALTH, repo: null })).toBeNull()
  })
})

describe('sidebar wiring', () => {
  it('renders the repo and version chips from /api/health', async () => {
    serve({ '/api/health': HEALTH, '/api/todos': [] })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    // Basename of the root, then the branch — not the whole path.
    expect(repoChip()?.textContent).toBe('cezar / feat/cockpit')
    expect(versionChip()?.textContent).toBe('v0.1.3')
  })

  it('renders the inbox badge from /api/todos', async () => {
    serve({ '/api/health': HEALTH, '/api/todos': TODOS })
    renderShell()

    await waitFor(() => expect(navBadge()).not.toBeNull())
    expect(navBadge()?.textContent).toBe('2')
    expect(screen.getByRole('link', { name: /Inbox/ })).toBeTruthy()
  })

  it('renders no badge for an empty inbox', async () => {
    serve({ '/api/health': HEALTH, '/api/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // Zero follow-ups is not "0 follow-ups" — a badge reading 0 is noise the spec's chrome
    // rules do not want.
    expect(navBadge()).toBeNull()
  })

  it('shows no chips at all while health has not answered', () => {
    // A never-resolving fetch: the pending state, held.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderShell()

    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(navBadge()).toBeNull()
    // …and the app itself is up. The chips being empty is not a loading screen.
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  })

  it('shows no chips when the server is unreachable, and still renders the app', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderShell()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The honest empty state: cezar cannot answer what repo it is on, so it says nothing.
    // It does not invent one, and it does not take the whole cockpit down with it.
    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(screen.getByText('route content')).toBeTruthy()
  })

  it('shows the version chip even outside a git repo', async () => {
    serve({ '/api/health': { ...HEALTH, repo: null }, '/api/todos': [] })
    renderShell()

    // Running cezar outside a repo is supported: no repo chip, but the rest of the chrome is
    // real and must not vanish with it.
    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(versionChip()?.textContent).toBe('v0.1.3')
    expect(repoChip()).toBeNull()
  })
})
