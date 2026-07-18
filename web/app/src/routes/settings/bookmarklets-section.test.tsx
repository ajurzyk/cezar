import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, Skill } from '@/api/types'
import { BookmarkletPanel } from './bookmarklets-section'

/**
 * #422: the bookmark's visible label (what a browser stamps as the bookmark's name when it is
 * dragged to the bookmarks bar) must include the current repo name so a person with several
 * cezar cockpits open can tell their bookmarks apart.
 */

const fetchMock = vi.fn<typeof fetch>()

const HEALTH: HealthResponse = {
  version: '0.1.5',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, followups: false },
}

const SKILLS: Skill[] = [
  { name: 'om-fix', body: '', path: '.ai/skills/om-fix.md', source: 'ai' },
]

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

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function renderPanel(skills: readonly Skill[] = SKILLS) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <BookmarkletPanel skills={skills} />
    </QueryClientProvider>,
  )
}

const label = (text: string) =>
  [...document.querySelectorAll('[data-slot="bm-link"]')].find((el) => el.textContent?.trim() === text)

describe('BookmarkletPanel repo-name labels (#422)', () => {
  it('stamps the repo name (the sidebar chip basename) into the generic and per-skill labels', async () => {
    serve({ '/api/health': HEALTH, '/api/launch-key': { key: 'sekret' } })
    renderPanel()

    await waitFor(() => expect(label('cezar (cezar): this PR/issue')).toBeTruthy())
    expect(label('/om-fix (cezar)')).toBeTruthy()
  })

  it('falls back to the plain, repo-less label while health is unknown', () => {
    // A never-resolving fetch: health stays pending, so the repo name is not yet known.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderPanel()

    expect(label('cezar: this PR/issue')).toBeTruthy()
    expect(label('/om-fix')).toBeTruthy()
    expect(label('/om-fix (cezar)')).toBeFalsy()
  })

  it('falls back to the plain label outside a git repository', async () => {
    serve({ '/api/health': { ...HEALTH, repo: null }, '/api/launch-key': { key: 'sekret' } })
    renderPanel()

    await waitFor(() => expect(label('cezar: this PR/issue')).toBeTruthy())
    expect(label('/om-fix')).toBeTruthy()
  })
})
