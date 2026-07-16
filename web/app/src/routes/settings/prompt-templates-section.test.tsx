import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { DEFAULT_PROMPT_TEMPLATES } from '@/lib/prompt-templates'
import { PromptTemplatesSection } from './prompt-templates-section'

/**
 * Settings → Prompt templates (#413): the round-trip against a stubbed `/api/ui-state` — an
 * untouched repo shows the built-ins with nothing persisted yet, edits are local until Save,
 * and Save PUTs the whole `promptTemplates` array (the ui-state merge is shallow, same rule as
 * Appearance's accent/density PUT).
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

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

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PromptTemplatesSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

const putBody = () =>
  requests.find((r) => r.method === 'PUT' && r.url === '/api/ui-state')?.body as
    | { promptTemplates?: unknown[] }
    | undefined
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="prompt-template-row"]')]
const saveButton = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-templates-save"]')!
const addButton = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-template-add"]')!
const resetButton = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-templates-reset"]')!

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the prompt templates section', () => {
  it('an untouched ui-state renders the built-in templates, Save disabled (nothing edited yet)', async () => {
    serve()
    renderSection()

    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))
    expect(rows().map((row) => row.dataset.template)).toEqual(
      DEFAULT_PROMPT_TEMPLATES.map((t) => t.id),
    )
    expect(saveButton().disabled).toBe(true)
  })

  it('a persisted custom list wins over the built-ins at boot', async () => {
    serve({ promptTemplates: [{ id: 'custom-1', label: 'My snippet', text: 'Custom instructions.' }] })
    renderSection()

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.dataset.template).toBe('custom-1')
  })

  it('editing a template label enables Save; Save PUTs the whole edited list', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    const firstLabelInput = rows()[0]!.querySelector<HTMLInputElement>(
      '[data-slot="prompt-template-label-input"]',
    )!
    fireEvent.change(firstLabelInput, { target: { value: 'Renamed template' } })
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeDefined())
    expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length)
    expect((putBody()?.promptTemplates?.[0] as { label: string }).label).toBe('Renamed template')
    expect(await screen.findByText('Prompt templates saved')).toBeTruthy()
  })

  it('removing a template drops its row and Save persists the shorter list', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    fireEvent.click(rows()[0]!.querySelector('[data-action="prompt-template-remove"]')!)
    expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length - 1)

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length - 1))
  })

  it('adding a template requires both a label and text before the Add button enables', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    expect(addButton().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('New template label'), { target: { value: 'Ship it' } })
    expect(addButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New template text'), {
      target: { value: 'Ship the change once green.' },
    })
    expect(addButton().disabled).toBe(false)

    fireEvent.click(addButton())
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length + 1))
    expect(screen.getByDisplayValue('Ship it')).toBeTruthy()
    // The mini-form clears after adding.
    expect(screen.getByLabelText('New template label')).toHaveProperty('value', '')

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length + 1))
  })

  it('clearing a label disables Save again and shows the "needs both" validation message', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    const firstLabelInput = rows()[0]!.querySelector<HTMLInputElement>(
      '[data-slot="prompt-template-label-input"]',
    )!
    fireEvent.change(firstLabelInput, { target: { value: '' } })
    expect(saveButton().disabled).toBe(true)
    expect(document.querySelector('[data-slot="prompt-templates-invalid"]')).not.toBeNull()
  })

  it('Reset to defaults restores the built-ins locally (still requires Save to persist)', async () => {
    serve({ promptTemplates: [{ id: 'custom-1', label: 'My snippet', text: 'Custom instructions.' }] })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.click(resetButton())
    expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length)
    expect(saveButton().disabled).toBe(false) // differs from the persisted (custom) list

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))
  })

  it('a PUT failure surfaces as a toast', async () => {
    requests = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/api/ui-state' && method === 'GET')
          return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
        if (url === '/api/ui-state' && method === 'PUT')
          return new Response(JSON.stringify({ error: 'disk full' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        return new Promise<never>(() => {})
      }),
    )
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    fireEvent.click(rows()[0]!.querySelector('[data-action="prompt-template-remove"]')!)
    fireEvent.click(saveButton())
    expect(await screen.findByText('disk full')).toBeTruthy()
  })
})
