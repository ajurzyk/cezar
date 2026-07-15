import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Diff } from './diff'
import type { DiffFileChange } from './types'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

/** The server's `/api/runs/:id/changes` file shape — the facade's input contract. */
const MODIFIED: DiffFileChange = {
  path: 'src/a.ts',
  status: 'modified',
  adds: 1,
  dels: 1,
  patch: [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,3 +3,3 @@',
    ' const one = 1',
    '-const two = 2',
    '+const two = 3',
    ' const three = 3',
    '',
  ].join('\n'),
}

const ADDED: DiffFileChange = {
  path: 'README.md',
  status: 'added',
  adds: 2,
  dels: 0,
  patch: ['diff --git a/README.md b/README.md', '@@ -0,0 +1,2 @@', '+# Title', '+Body', ''].join('\n'),
}

/** The engine chunk loads lazily — settle on a rendered file header before asserting. */
async function renderDiff(ui: React.ReactElement) {
  const view = render(ui)
  await screen.findByText('src/a.ts')
  return view
}

describe('Diff facade', () => {
  it('renders every file with its path, per-file ± and status badge', async () => {
    await renderDiff(<Diff files={[MODIFIED, ADDED]} />)

    expect(screen.getByText('src/a.ts')).not.toBeNull()
    expect(screen.getByText('README.md')).not.toBeNull()
    expect(screen.getByText('added')).not.toBeNull()
    const files = document.querySelectorAll('[data-slot="diff-file"]')
    expect(files).toHaveLength(2)
  })

  it('shows the aggregate ± stat across files', async () => {
    await renderDiff(<Diff files={[MODIFIED, ADDED]} />)

    const totals = document.querySelector('[data-slot="diff-totals"]')!
    expect(totals.textContent).toContain('2 files changed')
    expect(totals.textContent).toContain('+3')
    expect(totals.textContent).toContain('−1')
  })

  it('defaults to unified mode and flips to split on the mode prop', async () => {
    const { rerender } = await renderDiff(<Diff files={[MODIFIED]} />)

    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('unified')
    expect(document.querySelector('[data-slot="diff-line"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="diff-pair"]')).toBeNull()

    rerender(<Diff files={[MODIFIED]} mode="split" />)
    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('split')
    expect(document.querySelector('[data-slot="diff-pair"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="diff-line"]')).toBeNull()
    // The del/add pair shares one row: left cell del, right cell add.
    const pair = Array.from(document.querySelectorAll('[data-slot="diff-pair"]')).find((row) =>
      row.querySelector('[data-line="del"]'),
    )!
    expect(pair.querySelector('[data-line="add"]')).not.toBeNull()
  })

  it('marks the word-level change on both sides of a paired edit', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)

    const delMarks = Array.from(document.querySelectorAll('[data-word="del"]'))
    const addMarks = Array.from(document.querySelectorAll('[data-word="add"]'))
    expect(delMarks.map((mark) => mark.textContent)).toEqual(['2'])
    expect(addMarks.map((mark) => mark.textContent)).toEqual(['3'])
    expect(addMarks[0]!.className).toContain('bg-diff-add-strong')
  })

  it('renders the empty state synchronously for an empty file list', () => {
    render(<Diff files={[]} />)

    expect(document.querySelector('[data-slot="diff-empty"]')?.textContent).toBe('No changes.')
    expect(document.querySelector('[data-slot="diff-loading"]')).toBeNull()
  })

  it('soft-wraps line content when wrap is set', async () => {
    await renderDiff(<Diff files={[MODIFIED]} wrap />)

    const body = document.querySelector('[data-slot="diff-file-body"]')!
    expect(body.getAttribute('data-wrap')).toBe('true')
    expect(body.innerHTML).toContain('whitespace-pre-wrap')
  })

  it('collapses a file body from its sticky header', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(document.querySelector('[data-slot="diff-file-body"]')).toBeNull()
  })

  it('expands a context gap through the loadFileText seam', async () => {
    const fileText = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n')
    const loadFileText = vi.fn().mockResolvedValue(fileText)
    await renderDiff(<Diff files={[MODIFIED]} loadFileText={loadFileText} />)

    // The hunk starts at line 3 — a 2-line leading gap renders as an expander.
    const gap = screen.getByRole('button', { name: /2 unchanged lines/ })
    fireEvent.click(gap)
    // Expanded lines render as syntax-token spans — assert on whole-row text, not one node.
    const contextRows = () => Array.from(document.querySelectorAll('[data-line="context"]'))
    await waitFor(() => expect(contextRows().some((row) => row.textContent?.includes('line 1'))).toBe(true))
    expect(loadFileText).toHaveBeenCalledWith('src/a.ts')
    expect(contextRows().some((row) => row.textContent?.includes('line 2'))).toBe(true)
    expect(screen.queryByRole('button', { name: /2 unchanged lines/ })).toBeNull()
  })

  it('renders static gap separators when no loader is wired', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)

    const gap = document.querySelector('[data-slot="diff-gap"]')!
    expect(gap.tagName).toBe('DIV')
    expect(gap.textContent).toContain('2 unchanged lines')
  })

  it('explains binary and metadata-only files instead of rendering rows', async () => {
    const binary: DiffFileChange = { path: 'logo.png', status: 'modified', adds: 0, dels: 0, binary: true, patch: '' }
    const metaOnly: DiffFileChange = { path: 'src/a.ts', status: 'modified', adds: 0, dels: 0, patch: '' }
    await renderDiff(<Diff files={[metaOnly, binary]} />)

    expect(screen.getByText('Binary file — no text diff.')).not.toBeNull()
    expect(screen.getByText('No content changes (metadata only).')).not.toBeNull()
  })
})
