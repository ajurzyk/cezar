# Forgejo forge support

Status: implemented · 2026-08-14

## TLDR

The forge-driver seam was designed with a second forge in mind (`2026-07-14-cockpit-ui-redesign`
§"Forge-driver seam") but only ever had one implementation, so "the forge" and "GitHub" stayed
interchangeable in practice: the `gh` CLI, `github.com` URL shapes, and the literal word "GitHub"
in the nav item, the screen headings and the prompt handed to agents. Four stages made the forge a
resolved dependency instead of a constant — a repo-local config block names a self-hosted forge, a
REST driver speaks Forgejo, `resolveForge` picks the driver per project, and the cockpit says which
forge actually answered. Routes, endpoints and file names stay `github*` on purpose
(`BACKWARD_COMPATIBILITY.md` §2).

## Problem Statement

A self-hosted Forgejo instance is reachable by neither of the two things the GitHub driver assumes.
It has no `gh` CLI, and its `html_url`s are not `github.com` URLs, so every consumer keyed on that
host silently fails to recognize its own items. Three further constraints shaped the design:

- **A self-hosted forge has three independent addresses** — the git remote, the REST API as
  reachable from the cezar process (often a container hostname), and the web link base a human
  clicks. None can be derived from the others.
- **The host table cannot help.** `github.com → github` is knowable from the remote alone; a
  private hostname is not. Recognition has to come from the repo itself.
- **`/api/v1/health` is workspace-level.** It is built from the boot folder, so it describes one
  project. In a multi-project workspace it cannot answer "which forge is THIS project on".

The last one is what made stage 4 necessary rather than cosmetic: with more than one project the
cockpit renders a grouped sidebar, and the group gated its forge tab on `project.forge === 'github'`.
A Forgejo project's tab dropped out of the navigation entirely — the screen stayed reachable only by
a hand-typed URL.

## Proposed Solution

Keep the seam exactly as specified and add the second driver behind it. Recognition comes from a
`forge` key in the repo's own `.ai/cezar/config.json`; the host table still wins wherever it has an
answer, so the config fills the table's gap and never overrides it. The wire contract grows one
enum value and nothing else: `health.forge.kind` and `project.forge` already travel as
`'github' | 'forgejo'`.

The cockpit reads that kind and, with two deliberate exceptions, only NAMES things with it. It does
not branch on the forge to decide behavior — the seam exists so it does not have to.

## Goals

- Recognize a self-hosted Forgejo repo from its own config, with no workspace-level setting.
- Implement `ForgeDriver` over the Forgejo REST API, with no `gh` and no GitHub URL assumptions.
- Route every forge-backed cockpit surface through `resolveForge`, so no route knows which forge
  answered it.
- Let the cockpit say which forge answered — nav item, headings, links, empty states, browser tab —
  without renaming a single route, endpoint or file.
- Cost the GitHub path zero behavior changes and zero changed test expectations.

## Non-goals

- Renaming routes, endpoints or files. `/api/v1/github*` and `/p/:id/github` stay
  (`BACKWARD_COMPATIBILITY.md` §2).
- A Forgejo configuration screen. No write path to the `forge` key exists yet; it is hand-edited.
- GitLab or any third forge. `FORGE_KINDS` is the one place that grows, and the contract-parity
  tests make the growth loud.
- Automations on a non-GitHub forge. `src/automations/github-poller.ts` shells out to `gh` and
  never goes through `resolveForge`, so it has nothing to say about a Forgejo remote.
- Per-project forge availability. Availability is still probed for the boot project only; the ⌘K
  palette's gate is boot-scoped for that reason.

## Stage 1 — recognition

`forgeSettingsSchema` (`packages/cezar/src/server/forge/types.ts`) declares the `forge` key of
`.ai/cezar/config.json` once, as a zod object: `{ kind, apiUrl, webUrl }`, all three required. The
two URLs are separate fields because the REST base and the human link base are independent
addresses, and both are pinned to `http`/`https` — `.url()` alone would accept `javascript:`,
`file:` and `data:` from a repo-owned config file.

`config.ts` composes that schema instead of re-declaring the fields, so the parser and the type the
drivers consume cannot drift. `FORGE_KINDS` is the single list on the service side; the
`packages/contract` copies stay literal because the contract cannot import from the service, and
`contract-parity*.test.ts` catches the drift that arrangement invites.

Precedence: `FORGE_HOSTS` (a `Map`, not an object literal — a host named `__proto__` would otherwise
return an inherited `Object.prototype` member and pass straight through `??`) answers first, the
repo's config second. A repo with no answer from either is `null`, meaning plain-git features only.

## Stage 2 — the REST driver

`createForgejoDriver` implements `ForgeDriver` over the Forgejo REST API, split across
`forgejo.ts` (the driver), `forgejo-http.ts` (transport), `forgejo-map.ts` (payload mapping) and
`forgejo-diff.ts` (bounded PR file changes). The interface's optional members are the seam's own
degradation contract — a forge that cannot serve comment timelines simply never sets
`ForgeCommentsData.events`, which the contract already reads as comments-only, not as a defect.

`rebaseToWebUrl` in `forgejo-map.ts` carries a constraint the GitHub driver never had: the API
answers with `html_url`s built from the instance's own configured root, which is not necessarily
the address the user's browser can reach. Items are rebased onto `webUrl` before they leave the
driver.

## Stage 3 — the resolveForge seam

The forge-backed routes in `packages/cezar/src/server/server.ts` resolve a driver per request
instead of assuming GitHub — some through `resolveForgeOrGithub`, some through `resolveForge`
directly — and `ForgeAvailability` became something a non-`gh` driver can answer honestly. The
route names did not change, and neither did the `/api/github` response shape.

## Stage 4 — the cockpit says which forge

The stage this file is most often cited from. Everything in it is presentation: the wire contract,
the routes and the server are unchanged.

- **`packages/web/src/lib/forge-label.ts` is the single source of truth** for what the cockpit calls
  the forge and which mark it wears. `forgeLabel(undefined) → 'GitHub'` is a non-regression
  contract, not tidiness: every surface with no kind to offer renders exactly as it did before this
  stage, which is why the stage cost the GitHub path zero changed test expectations. An unknown kind
  lands on the same default — a raw `gitlab` slug on screen would be worse.
- **`packages/web/src/lib/use-forge-kind.ts` answers with the URL project's own registry entry.**
  Health stands in for the boot project alone. A scoped project borrowing the boot project's forge
  is precisely the bug this rule prevents, and it is the same guard `useProjectRepoBase` puts in
  front of repo links.
- **The nav gate widened** from `project.forge === 'github'` to `project.forge != null`. Automations
  kept the narrow gate (`automationsPollable`), because its poller cannot reach a non-GitHub forge
  and a visible tab that can never fire is worse than an absent one.
- **The hand-off prompt names the forge.** That block is an INSTRUCTION sent to an agent, not a
  label on a screen: "Fix GitHub issue #24" about a Forgejo issue is a false instruction, and it
  survives into the run record. The prompt box therefore holds its run until the forge is known,
  and corrects a seeded prompt exactly once if the answer arrives late.

Four places legitimately branch on the kind rather than merely naming it, and all four are recorded
here so a third forge knows where to look:

- `forgeIcon` — lucide ships no Forgejo mark, and an octocat beside the word "Forgejo" is the
  mismatch this stage removes.
- `forgeChecksUrl` — the only one that changes a URL rather than a word. GitHub keeps checks on a
  `<pr>/checks` tab; Forgejo has no such route at all (its CI status is a box on the pull request
  page), so the badge aims at the PR itself. A third forge that 404s on `/checks` needs a row here
  or the badge hands its users a dead link.
- `automationsPollable` — the poller shells out to `gh` and never goes through `resolveForge`, so a
  visible tab that can never fire is worse than an absent one. It fails CLOSED while the kind is
  unsettled: naming an unnamed tab "GitHub" is undone by the next render, but an offer taken in
  that window leaves behind an automation nothing will ever poll.
- `forgeHint` — the empty state's advice, and the one branch whose split is NOT the label's. A kind
  of `forgejo` proves a valid `forge` block exists (`classifyForgeKind` reaches it no other way, so
  the block passed `forgeSettingsSchema`), which means the reader who still needs to be told to
  declare one arrives with NO kind: a self-hosted remote whose block is missing, or missing one
  field, is dropped silently by `readForgeSettings`. The no-kind hint therefore names both ways in,
  and `tools-menu.tsx`'s `forgeNote` reads `repo.remote` to tell that reader apart from one who
  simply has no remote at all.

## Open questions

- **A Forgejo configuration screen.** The `forge` key is hand-edited today. A write path needs its
  own design — it is the one place a bad value takes the forge tab down for a project.
- **Per-project availability.** The ⌘K palette gates its forge entry on the boot project's
  `health.forge.available` while naming it from the URL project's kind. Closing that needs a
  server-side per-project availability probe, which does not exist.
- **Automations on Forgejo.** Requires the poller to go through `resolveForge` instead of `gh`.
