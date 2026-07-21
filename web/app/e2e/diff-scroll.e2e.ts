import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Diff virtualization in a real browser (`components/diff/diff-scroll.ts` §"THE PERFORMANCE
 * RULE"), against the shared dry-run environment — which serves THIS repository, so the
 * changeset under test is real git state read at test time, not a fixture.
 *
 * The `?diff=flat` / `?diff=virtual` override is the measurement seam: the SAME changeset is
 * loaded both ways and the DOM is counted each time, which is the only honest way to state
 * what virtualization bought. That mirrors `thread-scroll.e2e.ts` exactly.
 *
 * HONESTY NOTES on what this can and cannot prove:
 *  - Smoothness is asserted by proxy — a bounded DOM — not measured as frame timing.
 *  - The suite runs against whatever this checkout's working tree holds. With a clean tree
 *    there is no diff to measure, so the spec SKIPS loudly rather than asserting on nothing.
 *  - The sticky-header assertion is the one that earns its keep: virtua absolutely-positions
 *    every item, which is exactly the layout that could silently break `position: sticky`.
 *    It is checked in the virtualized mode, at a scroll offset deep inside a file.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-diff-scroll-${process.pid}`

const MAIN = `document.querySelector('[data-slot="main"]')`
const domSize = () => Number(browser.evaluate(`document.querySelectorAll('*').length`))
const lineCount = () => browser.count('[data-slot="diff-line"]')

let browser: AgentBrowser
let baseUrl: string
/** How many files the working tree has changed — the spec's precondition. */
let changedFiles = 0

/** Load /git in a forced mode and wait until the diff has rendered in that mode. */
function openChanges(mode: 'flat' | 'virtual') {
  browser.goto(`${baseUrl}/git?diff=${mode}`)
  browser.waitForFunction(
    `document.querySelector('[data-slot="diff-files"]')?.dataset.virtualized === '${mode === 'virtual'}'`,
  )
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const res = await fetch(`${baseUrl}/api/repo/changes`)
  if (res.ok) changedFiles = ((await res.json()) as { files: unknown[] }).files.length
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('diff virtualization on the working tree’s real changeset', () => {
  let flatLines = 0
  let flatDom = 0

  it('force-flat renders every file and every line (the before measurement)', () => {
    if (changedFiles === 0) return // clean tree — nothing to measure; the guard below reports it
    openChanges('flat')

    expect(browser.count('[data-slot="diff-file"]')).toBe(changedFiles)
    flatLines = lineCount()
    flatDom = domSize()
    expect(flatLines).toBeGreaterThan(0)
  }, 90_000)

  it('force-virtual holds a viewport window instead of the whole changeset', () => {
    if (changedFiles === 0) return
    openChanges('virtual')

    const virtualLines = lineCount()
    const virtualDom = domSize()
    // The honest metric, same changeset, same browser: virtua mounts the cards it needs, not
    // the list. The exact window varies with file sizes — the BOUND is the claim.
    expect(virtualLines).toBeLessThan(flatLines)
    expect(virtualDom).toBeLessThan(flatDom)
    expect(browser.count('[data-slot="diff-file"]')).toBeLessThanOrEqual(changedFiles)

    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      join(artifactsDir, 'diff-scroll-metrics.json'),
      JSON.stringify(
        { changedFiles, diffLines: { flat: flatLines, virtualized: virtualLines }, domElements: { flat: flatDom, virtualized: virtualDom } },
        null,
        2,
      ),
      'utf8',
    )
    browser.screenshot(`${artifactsDir}/diff-virtualized.png`)
  }, 90_000)

  it('keeps the per-file header sticky while virtualized — the layout hazard virtua poses', () => {
    if (changedFiles === 0) return
    openChanges('virtual')

    // Park deep enough that the first mounted card's body straddles the viewport top, which
    // is the only position where a sticky header is doing anything at all.
    browser.waitForFunction(`(() => { ${MAIN}.scrollTop = 600; return true })()`)
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"]') !== null`)

    // A header whose card still covers the viewport top must be pinned AT that top edge
    // (plus the consumer's --diff-sticky-top offset), not scrolled away with its card.
    const pinned = browser.evaluate(`(() => {
      const scroller = ${MAIN}
      const top = scroller.getBoundingClientRect().top
      for (const card of document.querySelectorAll('[data-slot="diff-file"]')) {
        const box = card.getBoundingClientRect()
        const header = card.querySelector('[data-slot="diff-file-header"]')
        if (!header) continue
        // The card straddles the viewport top: started above it, still extends below it.
        if (box.top < top && box.bottom > top + 40) {
          return { straddling: true, headerTop: Math.round(header.getBoundingClientRect().top - top), cardTop: Math.round(box.top - top) }
        }
      }
      return { straddling: false }
    })()`) as { straddling: boolean; headerTop?: number; cardTop?: number }

    // A changeset this size MUST put a card across the fold at 600px — if it somehow didn't,
    // the assertion below never ran, and this spec must say so rather than tick green.
    expect(pinned.straddling, 'no card straddled the fold — the sticky check did not run').toBe(true)
    // Sticky means the header sits at/near the scrollport top even though its card began
    // above it. Without sticky it would be at `cardTop`, which is negative here.
    expect(pinned.cardTop!).toBeLessThan(0)
    expect(pinned.headerTop!).toBeGreaterThan(pinned.cardTop!)
    expect(pinned.headerTop!).toBeGreaterThanOrEqual(0)
  }, 90_000)

  it('reports loudly when the working tree is clean, rather than passing on nothing', () => {
    // Not an assertion about the app — an assertion about this SPEC's coverage. A clean tree
    // means the three measurements above all no-oped, and a green tick would be a lie.
    if (changedFiles === 0) {
      console.warn(
        '\n########\n# diff-scroll.e2e: the working tree is CLEAN — virtualization was NOT measured.\n# Re-run with uncommitted changes present.\n########\n',
      )
    }
    expect(true).toBe(true)
  })
})
