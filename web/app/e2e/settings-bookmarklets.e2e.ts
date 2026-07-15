import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Settings → Bookmarklets end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The generator needs only the skills catalog (discovered
 * fresh on every GET, so the suite seeds two real project skills into this worktree's
 * `.ai/skills/` and removes them in afterAll) and the launch-key route. Nothing here
 * executes a `javascript:` URL — the page is a drag source only (spec 011 §5), so the specs
 * assert on the generated `href`, which is exactly what a user would drag to their bar.
 *
 * The `/new?skill=&auto=&key=&ref=` grammar these links bake is a PROTECTED contract
 * (BACKWARD_COMPATIBILITY.md §1): promoting the generator to its own subpage must not
 * change a single character of it, and the legacy `/settings/skills?skill=__bm` entry point
 * must keep working. Both are pinned below.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-bookmarklets-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const skillsDir = resolve(import.meta.dirname, '../../../.ai/skills')
const ALPHA = 'e2e-bm-alpha-skill'
const BETA = 'e2e-bm-beta-skill'

let browser: AgentBrowser
let baseUrl: string
let createdSkillsDir = false

const linkIn = (slot: string) => `[data-slot="${slot}"] [data-slot="bm-link"]`
const hrefOf = (selector: string) =>
  decodeURIComponent(String(browser.evaluate(`document.querySelector('${selector}').getAttribute('href')`)))
/** The generated href lands imperatively after mount — never read it before it is a real URL. */
const waitForGeneratedHref = (selector: string) =>
  browser.waitForFunction(
    `(document.querySelector('${selector}')?.getAttribute('href') ?? '').startsWith('javascript:')`,
  )
/**
 * Backspace the filter empty the way a user does. `fill(selector, '')` cannot do this: it
 * assigns `.value` directly, which a controlled React input never observes — the DOM would
 * read empty while the component still filtered on the old needle.
 */
const clearFilter = () => {
  const selector = '[data-slot="bm-filter"]'
  browser.click(selector)
  const length = Number(browser.evaluate(`document.querySelector('${selector}').value.length`))
  for (let i = 0; i < length; i += 1) browser.press('Backspace')
}

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${ALPHA}.md`),
    `---\nname: ${ALPHA}\ndescription: An e2e-seeded project skill\n---\n\nDo the alpha thing.\n`,
    'utf8',
  )
  writeFileSync(
    resolve(skillsDir, `${BETA}.md`),
    `---\nname: ${BETA}\ndescription: The second seeded skill\n---\n\nDo the beta thing.\n`,
    'utf8',
  )
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave test skills in a developer's catalog.
  rmSync(resolve(skillsDir, `${ALPHA}.md`), { force: true })
  rmSync(resolve(skillsDir, `${BETA}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  browser?.close()
})

describe('settings → bookmarklets against the live dry-run server', () => {
  it('is a first-class subpage: /settings/bookmarklets renders the generator and the nav marks it current', () => {
    browser.goto(`${baseUrl}/settings/bookmarklets`)
    browser.waitForFunction(`document.querySelector('[data-slot="bookmarklet-panel"]') !== null`)

    // The point of the change (#399): reachable by URL and findable in the nav, not buried
    // behind a Skills deep link.
    const nav = '[data-slot="settings-nav"]'
    expect(browser.count(`${nav} [data-section="bookmarklets"]`)).toBe(1)
    expect(
      browser.evaluate(`document.querySelector('${nav} [aria-current="page"]').getAttribute('data-section')`),
    ).toBe('bookmarklets')
    browser.screenshot(`${artifactsDir}/settings-bookmarklets.png`)
  })

  it('the generic launcher bakes the protected /new grammar with the server real launch key', () => {
    waitForGeneratedHref(linkIn('bm-generic'))
    const generic = hrefOf(linkIn('bm-generic'))

    // The protected deep-link grammar (BACKWARD_COMPATIBILITY.md §1), baked with the real key.
    expect(generic).toContain(`'/new?'+q`)
    expect(generic).toMatch(/auto=0&key=[^&]+&ref=/)
    // A real key, not the empty-string fallback of a failed fetch.
    expect(generic).toMatch(/key=[^&]+&/)
    // The generic launcher carries no skill — it only prefills the form.
    expect(generic).not.toContain('skill=')
  })

  it('one launcher per catalog skill, and the filter narrows the list', () => {
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')].some((a) => a.textContent.includes('/${ALPHA}'))`,
    )
    expect(browser.count('[data-slot="bm-list"] [data-slot="bm-row"]')).toBeGreaterThanOrEqual(2)

    browser.fill('[data-slot="bm-filter"]', ALPHA)
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]').length === 1`,
    )
    expect(browser.text('[data-slot="bm-list"]')).toContain(`/${ALPHA}`)
    expect(browser.text('[data-slot="bm-list"]')).not.toContain(`/${BETA}`)

    // A filter that matches nothing says so rather than rendering an empty void.
    browser.fill('[data-slot="bm-filter"]', 'zzz-no-such-skill')
    browser.waitForFunction(
      `document.querySelector('[data-slot="bm-list"]').textContent.includes('(no skills match)')`,
    )
    clearFilter()
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')].some((a) => a.textContent.includes('/${BETA}'))`,
    )
  })

  it('one-click launch arms the per-skill launchers but never the generic one', () => {
    const skillLink = `[data-slot="bm-list"] [data-slot="bm-row"] [data-slot="bm-link"]`
    waitForGeneratedHref(skillLink)
    expect(hrefOf(skillLink)).toContain('auto=0')

    browser.click('[data-slot="bm-auto"]')
    browser.waitForFunction(
      `decodeURIComponent(document.querySelector('${skillLink}').getAttribute('href')).includes('auto=1')`,
    )
    expect(hrefOf(skillLink)).toContain('auto=1')

    // The generic launcher forces auto off no matter what the checkbox says: it has no skill
    // to run, so auto-submitting it would arm nothing.
    expect(hrefOf(linkIn('bm-generic'))).toContain('auto=0')
  })

  it('the legacy /settings/skills?skill=__bm entry point still opens the same generator', () => {
    // Compatibility: bookmarks and docs pointing at the old deep link must not 404 or go blank.
    browser.goto(`${baseUrl}/settings/skills?skill=__bm`)
    browser.waitForFunction(`document.querySelector('[data-slot="bookmarklet-panel"]') !== null`)
    waitForGeneratedHref(linkIn('bm-generic'))
    expect(hrefOf(linkIn('bm-generic'))).toContain(`'/new?'+q`)
  })
})
