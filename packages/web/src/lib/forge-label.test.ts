import { describe, expect, it } from 'vitest'

import { GithubIcon } from '@/components/icons'

import { forgeChecksUrl, forgeHint, forgeHintText, forgeIcon, forgeLabel } from './forge-label'

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

/** The MARK, decided next to the label because the two call sites that need one — the nav item
 *  (`forgeItem`) and the forge tab's own unavailable state — choose the name and the mark in the
 *  same breath. Two spellings of this mapping would eventually disagree, and a third forge would
 *  mean editing two unrelated files; that is the argument `forgeChecksUrl` already makes for
 *  itself one screen below. */
describe('forgeIcon', () => {
  it('wears the GitHub mark for GitHub', () => {
    expect(forgeIcon('github')).toBe(GithubIcon)
  })

  it('drops the octocat for a forge that is not GitHub', () => {
    expect(forgeIcon('forgejo')).not.toBe(GithubIcon)
  })

  // The same non-regression rule `forgeLabel` carries: a surface with no kind to offer renders
  // exactly what it rendered before the stage.
  it('falls back to the GitHub mark when no kind is known', () => {
    expect(forgeIcon(undefined)).toBe(GithubIcon)
    expect(forgeIcon()).toBe(GithubIcon)
  })

  // A kind the wire may grow before this file learns about it. The fallback must be the old
  // default — a missing mark would be worse than a wrong one.
  it('falls back to the GitHub mark on a kind it does not know', () => {
    expect(forgeIcon('gitlab' as never)).toBe(GithubIcon)
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

  // `kind: 'forgejo'` is only ever read from a `forge` block that already passed
  // `forgeSettingsSchema` — `classifyForgeKind` (server/forge/index.ts) reaches that kind no other
  // way, because `FORGE_HOSTS` holds github.com alone. So this reader HAS the block, and telling
  // them to declare one is the single instruction they cannot act on.
  it('tells a Forgejo user what can still be wrong, not to declare what they already have', () => {
    const hint = forgeHintText('forgejo')
    expect(hint).toContain('CEZ_FORGEJO_TOKEN')
    expect(hint).toContain('apiUrl')
    expect(hint).not.toContain('gh auth login')
    expect(hint).not.toContain('needs a forge block')
    // The token is OPTIONAL: `forgejo-http.ts` supports an anonymous request in full, and the
    // server's own token hints fire only on 401/403 and on a 404 with no token. An empty state
    // that opens with "the tab needs a token" sends a public-instance user down a blind alley —
    // their outage is a wrong `apiUrl` or an unreachable host, and no token will fix it.
    expect(hint).not.toMatch(/^The tab needs a Forgejo token/)
    expect(hint).toContain('private')
  })

  // The no-kind case is NOT "probably GitHub" here, whatever `forgeLabel` calls it. A repo whose
  // remote is self-hosted and whose `forge` block is missing or half-written resolves to no driver
  // at all — `forge: null`, kind undefined — and it is the ONLY audience that still needs to be
  // told a block exists. Sending it to `gh auth login` is advice for someone else's outage.
  it('names both ways in when no kind is known', () => {
    const hint = forgeHintText(undefined)
    expect(hint).toContain('gh auth login')
    expect(hint).toContain('.ai/cezar/config.json')
  })

  // A hint that names a SUBSET of what the parser demands is worse than no hint: `forgeSettings
  // Schema` (server/forge/types.ts) requires `kind`, `apiUrl` AND `webUrl`, and a `forge` key
  // missing any of them is dropped silently — which is precisely how a user lands on the NO-KIND
  // hint, so that is where the field list has to be.
  it('lists every field the config block needs, where a broken block lands', () => {
    const hint = forgeHintText(undefined)
    for (const field of ['kind', 'apiUrl', 'webUrl']) expect(hint).toContain(field)
  })

  it('keeps the command names monospaced', () => {
    expect(forgeHint('github').filter((part) => part.mono).map((part) => part.text))
      .toEqual(['gh', 'gh auth login'])
    expect(forgeHint('forgejo').filter((part) => part.mono).map((part) => part.text))
      .toEqual(['apiUrl', 'CEZ_FORGEJO_TOKEN', 'forge', '.ai/cezar/config.json'])
    expect(forgeHint(undefined).filter((part) => part.mono).map((part) => part.text))
      .toEqual(['gh', 'gh auth login', 'forge', 'kind', 'apiUrl', 'webUrl', '.ai/cezar/config.json'])
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
  // path behaves exactly as it did before Stage 4 (spec 2026-08-14-forgejo-forge-support).
  it('falls back to the GitHub shape when no kind is known', () => {
    expect(forgeChecksUrl(PR, undefined)).toBe(`${PR}/checks`)
    expect(forgeChecksUrl(PR)).toBe(`${PR}/checks`)
  })
})
