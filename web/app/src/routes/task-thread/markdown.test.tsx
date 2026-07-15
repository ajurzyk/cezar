import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Markdown } from './markdown'

afterEach(cleanup)

/**
 * Streamdown + the Shiki singleton, rendered for real in jsdom (the JS regex engine needs no
 * browser API, so nothing is stubbed). What matters: a fence becomes a code block with the
 * copy button and language chip, tokens get their color from the `--syn-*` variables (the
 * dual-theme contract), and an unknown fence language degrades to plaintext instead of
 * crashing the message.
 */
describe('Markdown', () => {
  it('renders a ts fence as a code block with language chip and copy button, tokens on --syn-*', async () => {
    render(<Markdown>{'Before.\n\n```ts\nconst answer: number = 42;\n```'}</Markdown>)

    const block = document.querySelector('[data-streamdown="code-block"]')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-language')).toBe('ts')
    expect(document.querySelector('[data-streamdown="code-block-header"]')?.textContent).toBe('ts')
    expect(document.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull()
    // Download is deliberately off — a chat reply is not a file manager.
    expect(document.querySelector('[data-streamdown="code-block-download-button"]')).toBeNull()

    // The singleton loads shiki/core + the grammar lazily; the keyword token lands colored
    // with the CSS variable (never a hex literal — the theme IS the variables).
    await waitFor(
      () => {
        const spans = [...document.querySelectorAll('[data-streamdown="code-block-body"] span')]
        const colors = spans.map((s) => (s as HTMLElement).style.getPropertyValue('--sdm-c')).filter(Boolean)
        expect(colors).toContain('var(--syn-key)')
        expect(colors.some((c) => /#[0-9a-f]{3,8}/i.test(c))).toBe(false)
      },
      { timeout: 10_000 },
    )
  }, 15_000)

  it('renders an unknown fence language as plaintext — no crash, chip kept honest', async () => {
    render(<Markdown>{'```wat-lang\nsome opaque output\n```'}</Markdown>)
    const block = document.querySelector('[data-streamdown="code-block"]')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-language')).toBe('wat-lang')
    await waitFor(() => {
      expect(document.querySelector('[data-streamdown="code-block-body"]')?.textContent).toContain(
        'some opaque output',
      )
    })
  })

  it('renders streaming-typical markdown (emphasis, lists, inline code) as elements', () => {
    render(<Markdown>{'A **bold** claim with `code`.\n\n- one\n- two'}</Markdown>)
    expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold')
    expect(document.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('code')
    expect(document.querySelectorAll('[data-streamdown="list-item"]')).toHaveLength(2)
  })

  it('repairs an unterminated fence while streaming instead of leaking backticks', () => {
    render(<Markdown>{'Look:\n\n```ts\nconst part = "still stre'}</Markdown>)
    // The half-open fence renders as a code block (Streamdown's unterminated-block repair);
    // the raw ``` never shows as text.
    expect(document.querySelector('[data-streamdown="code-block"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('```')
  })
})
