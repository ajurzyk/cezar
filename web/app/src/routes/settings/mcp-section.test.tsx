import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AgentConfigFile, AgentConfigListing } from '@/api/types'
import { Toaster } from '@/components/ui/toaster'
import { McpSection } from './mcp-section'

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id' | 'label' | 'runners'>): AgentConfigFile {
  return {
    kind: 'mcp',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: true,
    precedence: 'Project-scoped MCP servers.',
    docsUrl: 'https://code.claude.com/docs/en/mcp',
    path: `/repo/${over.label}`,
    exists: true,
    size: 10,
    version: 'v1',
    writable: true,
    ...over,
  }
}

function serve(listing: AgentConfigListing) {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/agent-config')) return json(listing)
      if (url.includes('/api/agent-config/')) {
        return json({ id: 'x', path: '/repo/x', exists: true, content: '{}', version: 'v1' })
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

function renderSection() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <McpSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('McpSection', () => {
  it('shows only MCP-holding files, and names where each runner keeps servers', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.mcp', label: '.mcp.json', runners: ['claude'] }),
        fileOf({ id: 'codex.user.config', label: '~/.codex/config.toml', runners: ['codex'], format: 'toml' }),
        // a non-MCP file must NOT appear
        fileOf({ id: 'claude.project.memory', label: 'CLAUDE.md', runners: ['claude'], holdsMcp: false, kind: 'memory' }),
      ],
      userMcp: { path: '~/.claude.json', servers: ['github', 'memory'], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.mcp.json')).toBeTruthy())
    expect(screen.getByText('~/.codex/config.toml')).toBeTruthy()
    expect(screen.queryByText('CLAUDE.md')).toBeNull()
    expect(screen.getByText(/\[mcp_servers/)).toBeTruthy()
  })

  it('lists Claude’s user-scope servers read-only from ~/.claude.json', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.mcp', label: '.mcp.json', runners: ['claude'] })],
      userMcp: { path: '~/.claude.json', servers: ['github'], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('github')).toBeTruthy())
    expect(screen.getByText(/cezar does not edit/)).toBeTruthy()
  })
})
