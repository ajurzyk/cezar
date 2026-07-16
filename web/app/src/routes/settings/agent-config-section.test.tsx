import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AgentConfigFile, AgentConfigListing } from '@/api/types'
import { Toaster } from '@/components/ui/toaster'
import { AgentConfigSection } from './agent-config-section'

/**
 * Settings → Agent config (#404): the SURFACE honoring the API contract (pinned
 * server-side in src/server/agent-config-api.test.ts). Covers runner grouping,
 * the vendor precedence string, the read-only hosted render, and a save round-trip.
 */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id' | 'label'>): AgentConfigFile {
  return {
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    precedence: 'Overrides user settings key by key.',
    docsUrl: 'https://code.claude.com/docs/en/settings',
    path: `/repo/${over.label}`,
    exists: true,
    size: 10,
    version: 'v1',
    writable: true,
    ...over,
  }
}

const HEALTH = {
  version: '0.0.0',
  repoRoot: '/repo',
  repo: null,
  checks: [{ name: 'claude', available: true }],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true },
}

function serve(listing: AgentConfigListing, fileContent = '{"a":1}') {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/health')) return json(HEALTH)
      if (url.endsWith('/api/agent-config')) return json(listing)
      if (url.includes('/api/agent-config/') && method === 'GET') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: fileContent, version: 'v1' })
      }
      if (url.includes('/api/agent-config/') && method === 'PUT') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: '{"a":2}', version: 'v2' })
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

function renderSection() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AgentConfigSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentConfigSection', () => {
  it('groups files by runner and shows the vendor precedence when a file is selected', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('Claude')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByText(/Overrides user settings key by key/)).toBeTruthy())
  })

  it('renders read-only in hosted mode — no Save button', async () => {
    serve({
      editable: false,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json', writable: false })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText(/Read-only/)).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('saves an edited file', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('Claude')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy())
  })
})
