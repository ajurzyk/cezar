import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from './api/query-client'
import { AppearanceProvider } from './components/appearance-provider'
import { ListViewProvider } from './components/list-view'
import { ThemeProvider } from './components/theme-provider'
import { AppRoutes } from './routes'
import { resetDraft } from './routes/new-task-draft'

// The `/` overview fetches `/api/runs` on mount. A never-answering fetch keeps every route
// honestly in its loading state — this file is about the URL map, not about data.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  // The /new draft store is a module singleton by design — isolate it per test.
  resetDraft()
})

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Cold-load the router at a URL, exactly as a pasted deep link would — under the same providers
 *  the app shell supplies (the overview at `/` needs the query cache and the shared list view;
 *  the Settings appearance section reads the theme and appearance contexts). */
function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <ListViewProvider>
              <AppRoutes />
            </ListViewProvider>
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

function routeName(): string | null {
  return document.querySelector('[data-route]')?.getAttribute('data-route') ?? null
}

/** The URL contract from the spec's "Routing — every surface is a URL" section.
 *  These paths are pasteable links; changing one breaks a teammate's bookmark,
 *  so the map is asserted URL-by-URL rather than through the (future) nav. */
describe('route map', () => {
  const cases: Array<[url: string, route: string, title: string]> = [
    ['/', 'tasks', 'Tasks'],
    // The real full-screen composer (R4 Step 1.1): the hero title is the page heading.
    ['/new', 'new', 'What should the agent work on?'],
    // The real thread view (Step R3.1): with fetch never answering it is honestly loading.
    ['/tasks/abc123', 'task-thread', 'Loading task…'],
    // The real R5 tab routes: with fetch never answering they are honestly loading.
    ['/tasks/abc123/changes', 'task-changes', 'Loading changes…'],
    ['/tasks/abc123/files', 'task-files', 'Loading files…'],
    // The real compare view (Step R3 2.3): with fetch never answering it is honestly loading.
    ['/compare/grp-1', 'compare', 'Loading variants…'],
    // The real repo view (R5 Step 1.7): with fetch never answering it is honestly loading —
    // and every segment is its own URL, commit deep links included.
    ['/git', 'repo-git', 'Loading repository…'],
    ['/git/commits', 'repo-git', 'Loading repository…'],
    ['/git/commits/abc1234', 'repo-git', 'Loading repository…'],
    ['/git/branches', 'repo-git', 'Loading repository…'],
    // The real GitHub tab (R6 Step 1.1): with fetch never answering every github URL is
    // honestly loading — lists and item deep links included.
    ['/github', 'github', 'Loading GitHub…'],
    ['/github/prs', 'github', 'Loading GitHub…'],
    ['/github/issues/42', 'github', 'Loading GitHub…'],
    ['/github/prs/7', 'github', 'Loading GitHub…'],
    ['/inbox', 'inbox', 'Inbox'],
    // The real workflow builder (R6 Step 1.6): with fetch never answering both the list URL
    // and a named deep link are honestly loading.
    ['/workflows', 'workflows', 'Loading workflows…'],
    ['/workflows/ship-it', 'workflows', 'Loading workflows…'],
    ['/skills', 'skills', 'Skills'],
    ['/settings', 'settings', 'Settings'],
    ['/settings/bookmarklets', 'settings-bookmarklets', 'Bookmarklets'],
    ['/settings/appearance', 'settings-appearance', 'Appearance'],
    ['/settings/agents', 'settings-agents', 'Agents'],
    ['/settings/agent-config', 'settings-agent-config', 'Agent config'],
    ['/settings/mcp', 'settings-mcp', 'MCP'],
    ['/settings/notifications', 'settings-notifications', 'Notifications'],
  ]

  for (const [url, route, title] of cases) {
    it(`${url} → ${route}`, () => {
      renderAt(url)
      expect(routeName()).toBe(route)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
    })
  }

  // The tab lives in the path, so /tasks/:id/changes must not fall back to the thread.
  it('a task tab deep link renders the tab, not the thread', () => {
    renderAt('/tasks/abc123/changes')
    expect(document.querySelector('[data-route="task-thread"]')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Loading task…' })).toBeNull()
  })

  // Hidden registry sections (keyboard) are deliberately NOT routed — their URLs
  // stay honest 404s until the section ships (registry.tsx `hidden`). mcp shipped
  // with the agent-config feature (#404), so it is a real route above now.
  const unknown = [
    '/nope-404',
    '/tasks',
    '/settings/nope',
    '/settings/keyboard',
    '/tasks/abc123/nope',
    '/compare',
  ]
  for (const url of unknown) {
    it(`${url} → the 404 route`, () => {
      renderAt(url)
      expect(routeName()).toBe('not-found')
    })
  }

  // Step 4.1: the 404 is a CenteredState with a way home, not a bare stub.
  it('the 404 renders a CenteredState with a back-to-tasks action', () => {
    renderAt('/definitely-not-a-route')
    expect(routeName()).toBe('not-found')
    expect(document.querySelector('[data-route="not-found"] [data-slot="centered-state"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/')
  })

})

/** The bookmarklet contract (spec 011), protected by BACKWARD_COMPATIBILITY.md:
 *  `/new?skill=&ref=&auto=1&key=`. Since R4 Step 1.3 `auto=1` arms the real unattended start
 *  (the full matrix lives in routes/new-task.test.tsx); this file keeps the URL contract. */
describe('/new query params', () => {
  const textarea = () =>
    screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement

  it('prefills the composer from a non-auto deep link', () => {
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1')
    expect(routeName()).toBe('new')
    expect(textarea().value).toBe('https://github.com/o/r/pull/1')
  })

  it('an armed auto=1 link shows the starting surface, never the composer mid-flight', () => {
    // fetch never answers here, so the key check is honestly in flight: no composer to type
    // into, no run POSTed, and the key nowhere in the DOM.
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret')
    expect(routeName()).toBe('new')
    expect(document.querySelector('[data-slot="auto-starting"]')).not.toBeNull()
    expect(screen.queryByLabelText('Describe a task for the agent')).toBeNull()
    expect(document.body.textContent).not.toContain('s3cret')
  })

  it('renders an empty composer without params', () => {
    renderAt('/new')
    expect(routeName()).toBe('new')
    expect(textarea().value).toBe('')
  })

  it('never prints the launch key anywhere on the page', () => {
    renderAt('/new?key=s3cret')
    expect(routeName()).toBe('new')
    expect(document.body.textContent).not.toContain('s3cret')
    expect(textarea().value).toBe('')
  })
})
