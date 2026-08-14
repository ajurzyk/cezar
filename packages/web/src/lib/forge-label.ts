import type { ForgeInfo } from '@open-mercato/cezar-api-client'

/**
 * Which forge answered. Taken from the contract rather than re-declared, so the day the service's
 * `FORGE_KINDS` grows a third entry this file is a type error instead of a silent mislabel.
 */
export type ForgeKind = ForgeInfo['kind']

/** Every kind the cockpit can spell, for callers that must consider ALL spellings of a label
 *  rather than the one for the kind currently known (`composeGithubTask`'s seeded-ref guard).
 *  A `Record<ForgeKind, true>` rather than an array literal, so the contract growing a third
 *  entry is a type error here instead of a spelling those callers silently stop recognizing —
 *  the same guarantee `ForgeKind` itself carries. */
const ALL_FORGE_KINDS: Record<ForgeKind, true> = { github: true, forgejo: true }
export const FORGE_KINDS = Object.keys(ALL_FORGE_KINDS) as ForgeKind[]

/**
 * What the cockpit CALLS the forge — the single source of truth for every label on the forge
 * surface (nav item, screen header, "open on …" links, hand-off prompt).
 *
 * The `undefined` default is load-bearing, not tidiness: every surface that has no kind to offer
 * — a presentational shell rendered without health, a registry entry with no `forge`, a screen
 * whose queries have not answered yet — keeps saying "GitHub", exactly as it did before Stage 4.
 * That is what lets this change cost the GitHub path (the upstream path) zero test expectations.
 * An unknown kind lands here too: a raw `gitlab` slug on screen would be worse than the default.
 */
export function forgeLabel(kind?: ForgeKind): string {
  return kind === 'forgejo' ? 'Forgejo' : 'GitHub'
}

/** One run of hint text. `mono` marks the command/identifier runs the empty state renders in
 *  `font-mono` — the reason this is segments and not one string. */
export type ForgeHintSegment = { text: string; mono?: true }

/**
 * What the forge tab NEEDS, for the empty state — never why it is currently unavailable. The
 * reason stays with the server's own `reason` (Stage 3 made it a sensible sentence for Forgejo);
 * duplicating it here would give the user two answers that can disagree.
 */
export function forgeHint(kind?: ForgeKind): ForgeHintSegment[] {
  if (kind === 'forgejo') {
    return [
      { text: 'The tab needs a Forgejo token in ' },
      { text: 'CEZ_FORGEJO_TOKEN', mono: true },
      // Every field `forgeSettingsSchema` demands, not just the interesting one: a `forge` key
      // missing any of the three fails validation and is dropped SILENTLY, which leaves the user
      // back on this empty state having done exactly what it told them to.
      { text: ' and a ' },
      { text: 'forge', mono: true },
      { text: ' block — ' },
      { text: 'kind', mono: true },
      { text: ', ' },
      { text: 'apiUrl', mono: true },
      { text: ' and ' },
      { text: 'webUrl', mono: true },
      { text: ' — declared in the repo’s ' },
      { text: '.ai/cezar/config.json', mono: true },
      { text: '. Everything else in cezar works without it.' },
    ]
  }
  return [
    { text: 'The tab needs the ' },
    { text: 'gh', mono: true },
    { text: ' CLI, logged in (' },
    { text: 'gh auth login', mono: true },
    { text: '), and a repo with a GitHub remote. Everything else in cezar works without it.' },
  ]
}

/**
 * Where the checks badge on a pull request points. A function rather than a ternary at the call
 * site because it is a decision about the shape of SOMEONE ELSE'S web UI — exactly the kind of
 * knowledge this module already holds.
 *
 * GitHub has a checks tab under the PR (`<pr>/checks`, issue #415 — why the link exists at all).
 * Forgejo has no such route: its CI status sits in a box on the pull request page itself, and
 * `<pr>/checks` is a 404 there — so the badge aims at the PR. The Forgejo driver does populate
 * the glyph (`server/forge/forgejo.ts` serves `GET /github/checks`), so this branch is reached in
 * practice, not defensively. An unknown kind takes the GitHub shape, the same rule `forgeLabel`
 * follows.
 */
export function forgeChecksUrl(url: string, kind?: ForgeKind): string {
  return kind === 'forgejo' ? url : `${url}/checks`
}

/** The hint as flat text — what a test asserts on, and what a non-styling caller can read. */
export function forgeHintText(kind?: ForgeKind): string {
  return forgeHint(kind).map((part) => part.text).join('')
}
