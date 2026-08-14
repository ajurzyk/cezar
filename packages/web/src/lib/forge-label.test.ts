import { describe, expect, it } from 'vitest'

import { forgeChecksUrl, forgeHint, forgeHintText, forgeLabel } from './forge-label'

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

  // A hint that names a SUBSET of what the parser demands is worse than no hint: `forgeSettings
  // Schema` (server/forge/types.ts) requires `kind`, `apiUrl` AND `webUrl`, and a `forge` key
  // missing any of them is dropped silently — so a user who follows the hint verbatim lands back
  // on this very empty state with nothing new to read.
  it('names every field the forge config actually requires', () => {
    const hint = forgeHintText('forgejo')
    for (const field of ['kind', 'apiUrl', 'webUrl']) expect(hint).toContain(field)
  })

  it('falls back to the GitHub hint when no kind is known', () => {
    expect(forgeHint(undefined)).toEqual(forgeHint('github'))
  })

  it('keeps the command names monospaced', () => {
    expect(forgeHint('github').filter((part) => part.mono).map((part) => part.text))
      .toEqual(['gh', 'gh auth login'])
    expect(forgeHint('forgejo').filter((part) => part.mono).map((part) => part.text))
      .toEqual(['CEZ_FORGEJO_TOKEN', 'forge', 'kind', 'apiUrl', 'webUrl', '.ai/cezar/config.json'])
  })
})

/** Where the checks badge points. NOT a label — a route in someone else's web UI, and the two
 *  forges do not share it. GitHub keeps checks on their own tab under the PR; Forgejo has no such
 *  route at all (the CI box sits on the pull request page), so a pasted-on `/checks` 404s there. */
describe('forgeChecksUrl', () => {
  const PR = 'https://github.com/acme/demo/pull/137'

  it('sends GitHub to the PR checks tab', () => {
    expect(forgeChecksUrl(PR, 'github')).toBe(`${PR}/checks`)
  })

  it('sends Forgejo to the pull request itself — it has no checks route', () => {
    const pull = 'https://forge.example/acme/demo/pulls/137'
    expect(forgeChecksUrl(pull, 'forgejo')).toBe(pull)
  })

  // The same rule `forgeLabel` follows: "nothing has said yet" reads as GitHub, so the upstream
  // path behaves exactly as it did before Stage 4.
  it('falls back to the GitHub shape when no kind is known', () => {
    expect(forgeChecksUrl(PR, undefined)).toBe(`${PR}/checks`)
    expect(forgeChecksUrl(PR)).toBe(`${PR}/checks`)
  })
})
