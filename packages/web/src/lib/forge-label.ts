import type { ForgeInfo } from '@open-mercato/cezar-api-client'
import { GitPullRequestIcon } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { GithubIcon } from '@/components/icons'

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
 * whose queries have not answered yet — keeps saying "GitHub", exactly as it did before Stage 4
 * (spec 2026-08-14-forgejo-forge-support §"Stage 4").
 * That is what lets this change cost the GitHub path (the upstream path) zero test expectations.
 * An unknown kind lands here too: a raw `gitlab` slug on screen would be worse than the default.
 */
export function forgeLabel(kind?: ForgeKind): string {
  return kind === 'forgejo' ? 'Forgejo' : 'GitHub'
}

/**
 * What the cockpit MARKS the forge with. Lives beside `forgeLabel` because the two call sites
 * that need a mark — the nav item (`forgeItem`) and the forge tab's own unavailable state —
 * choose the name and the mark in the same breath. Two spellings of this mapping would eventually
 * disagree, and a third forge would mean editing two unrelated files: the same argument
 * `forgeChecksUrl` makes for itself below.
 *
 * lucide-react 1.x ships no Forgejo mark, and an octocat beside the word "Forgejo" is precisely
 * the mismatch this stage removes — so a neutral forge-shaped icon stands in.
 *
 * Returns the COMPONENT, not an element: `NavItem.icon` holds a component, and `forgeItem`
 * compares it by identity to leave the GitHub item untouched. The `undefined` default carries the
 * same non-regression rule as `forgeLabel`.
 */
export function forgeIcon(kind?: ForgeKind): ComponentType<SVGProps<SVGSVGElement>> {
  return kind === 'forgejo' ? GitPullRequestIcon : GithubIcon
}

/** One run of hint text. `mono` marks the command/identifier runs the empty state renders in
 *  `font-mono` — the reason this is segments and not one string. */
export type ForgeHintSegment = { text: string; mono?: true }

/**
 * What the forge tab NEEDS, for the empty state — never why it is currently unavailable. The
 * reason stays with the server's own `reason` (Stage 3 made it a sensible sentence for Forgejo);
 * duplicating it here would give the user two answers that can disagree.
 *
 * Each branch talks to the audience that can actually reach it, and that split is NOT the label's.
 * A kind of `forgejo` is only ever read from a `forge` block that already passed
 * `forgeSettingsSchema` — `classifyForgeKind` (server/forge/index.ts) has no other route to it,
 * since `FORGE_HOSTS` holds github.com alone — so a Forgejo reader HAS the block, and "declare a
 * forge block" is the one instruction they cannot act on. The reader who needs that sentence
 * arrives with NO kind: a self-hosted remote whose block is missing, or missing one field, is
 * dropped silently by `readForgeSettings` and resolves to no driver at all. So the no-kind branch
 * carries both ways in.
 *
 * That is a deliberate exception to the "absent reads as GitHub" default, and the only one here:
 * this branch is ADVICE, not a name. `forgeLabel(undefined)` still says GitHub, and the tab is
 * still titled "GitHub is unavailable here" above this text.
 */
export function forgeHint(kind?: ForgeKind): ForgeHintSegment[] {
  if (kind === 'forgejo') {
    return [
      // What can still be wrong once the block validates: the instance answering, and the token.
      // The token is optional: `forgejo-http.ts` (`currentToken`) supports an anonymous request in
      // full, and the server's own token hints fire only on 401/403 and on a 404 with no token.
      // Opening with the token sent a public-instance user hunting for one when their outage was
      // something else entirely — a wrong `apiUrl`, an unreachable host — and no token would have
      // fixed it.
      { text: 'The tab needs the instance at your ' },
      { text: 'apiUrl', mono: true },
      { text: ' to answer, and a private repository also needs a token in ' },
      { text: 'CEZ_FORGEJO_TOKEN', mono: true },
      { text: '. The ' },
      { text: 'forge', mono: true },
      { text: ' block in ' },
      { text: '.ai/cezar/config.json', mono: true },
      // Said out loud so the reader does not go hunting through their config for a typo that
      // cannot be there: the word "Forgejo" on this screen is itself proof the block parsed.
      { text: ' already validated — it is where this tab learned to call itself Forgejo.' },
      { text: ' Everything else in cezar works without it.' },
    ]
  }
  if (kind === undefined) {
    return [
      { text: 'The tab needs a forge cezar can reach: a GitHub remote with the ' },
      { text: 'gh', mono: true },
      { text: ' CLI, logged in (' },
      { text: 'gh auth login', mono: true },
      { text: '), or — on any other host — a ' },
      { text: 'forge', mono: true },
      // Every field `forgeSettingsSchema` demands, not just the interesting one: a `forge` key
      // missing any of the three fails validation and is dropped SILENTLY, which is exactly how a
      // reader ends up here rather than on the Forgejo branch.
      { text: ' block with ' },
      { text: 'kind', mono: true },
      { text: ', ' },
      { text: 'apiUrl', mono: true },
      { text: ' and ' },
      { text: 'webUrl', mono: true },
      { text: ' in the repo’s ' },
      { text: '.ai/cezar/config.json', mono: true },
      { text: '. A block missing any of the three is dropped without a word.' },
      { text: ' Everything else in cezar works without it.' },
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
