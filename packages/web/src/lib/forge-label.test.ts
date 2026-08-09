import { describe, expect, it } from 'vitest'

import { forgeHint, forgeHintText, forgeLabel } from './forge-label'

/** The single source of truth for what the cockpit CALLS the forge. The default is the part
 *  that matters most: every surface that has no kind to offer — a presentational shell rendered
 *  without health, a project registry entry with no `forge` — must keep saying "GitHub", or this
 *  change would rename the tab on the upstream path it is meant to leave untouched. */
describe('forgeLabel', () => {
  it('names GitHub', () => {
    expect(forgeLabel('github')).toBe('GitHub')
  })

  it('names Forgejo — the whole point of the stage', () => {
    expect(forgeLabel('forgejo')).toBe('Forgejo')
  })

  it('falls back to GitHub when no kind is known', () => {
    expect(forgeLabel(undefined)).toBe('GitHub')
    expect(forgeLabel()).toBe('GitHub')
  })

  // A kind the wire may grow before this file learns about it (the contract's enum tracks the
  // service's `FORGE_KINDS`). Rendering the raw slug would be worse than the old default.
  it('falls back to GitHub on a kind it does not know', () => {
    expect(forgeLabel('gitlab' as never)).toBe('GitHub')
  })
})

/** What the empty state tells you to go fix. The REASON stays with the server's `reason` —
 *  this is only the "what this tab needs" sentence, and it differs per forge.
 *
 *  Segments rather than one string because the command names render `font-mono` today, and an
 *  empty state that lost that styling would be a regression on the GitHub path. */
describe('forgeHint', () => {
  it('points GitHub at the gh CLI', () => {
    const hint = forgeHintText('github')
    expect(hint).toContain('gh auth login')
    expect(hint).toContain('GitHub remote')
    expect(hint).not.toContain('CEZ_FORGEJO_TOKEN')
  })

  it('points Forgejo at its token and API URL, never at gh', () => {
    const hint = forgeHintText('forgejo')
    expect(hint).toContain('CEZ_FORGEJO_TOKEN')
    expect(hint).toContain('.ai/cezar/config.json')
    expect(hint).not.toContain('gh auth login')
  })

  it('falls back to the GitHub hint when no kind is known', () => {
    expect(forgeHint(undefined)).toEqual(forgeHint('github'))
  })

  it('keeps the command names monospaced', () => {
    expect(forgeHint('github').filter((part) => part.mono).map((part) => part.text))
      .toEqual(['gh', 'gh auth login'])
    expect(forgeHint('forgejo').filter((part) => part.mono).map((part) => part.text))
      .toEqual(['CEZ_FORGEJO_TOKEN', 'forge.apiUrl', '.ai/cezar/config.json'])
  })
})
