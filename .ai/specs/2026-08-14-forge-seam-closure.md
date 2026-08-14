# Forge seam closure

Status: designed · 2026-08-14

## TLDR

`2026-08-14-forgejo-forge-support.md` shipped the second driver, but three forge-backed surfaces
never reached the seam: draft-PR creation, the reference-status family, and `forgeWebRoot`. Each
one left behind a `kind === 'github'` branch in a file the fork does not own — the branch is the
symptom, the unrouted surface is the cause. This spec routes all three through `ForgeDriver` and
records the rule that keeps the fork's delta against `open-mercato/cezar` from growing back.

Closing a hole **shrinks** the fork rather than growing it: every gate removed is a fork-only
branch leaving an upstream file. That is the primary reason to do this work now, ahead of any
third driver.

## Problem statement

Three surfaces still assume GitHub, and each pays for it in a different file the fork has to keep
re-merging:

- **`POST /runs/:id/pr`** calls `createDraftPr` (which ends in `gh pr create`) directly instead of
  resolving a driver. Because `resolveForge` now answers with a real Forgejo driver, the cockpit's
  Create PR button is enabled for those repos, and `createDraftPr` pushes the branch BEFORE it
  creates the pull request — a click would leave the remote ahead with no rollback. The route
  therefore carries a pre-mutation 409 gate (`server.ts`), and `git-actions.ts` mirrors it so the
  button is disabled rather than the click discovering the refusal. Two fork-only branches for one
  unrouted route — while `forgejo.ts` has had a tested `createPR` all along.
- **The reference-status family** (`fetchGithubRefStatus`, `readCachedRefStatuses`,
  `forgetRefStatus`) has no seam at all. The task chips that show `#N` state silently carry no
  status on a Forgejo project, and `server.ts` imports the `gh`-backed functions directly.
- **`forgeWebRoot`** is gated on the host table alone, so a Forgejo project reports no `repoUrl`
  and every cross-project surface that links by number degrades to plain text — even though the
  repo's own `forge` block carries a validated `webUrl`.

## Goals

- Route all three surfaces through `ForgeDriver`, using one repeatable pattern.
- Remove every `kind === 'github'` gate those holes created.
- Add no new fork delta to `forge/github.ts` beyond a single export.
- Write down the invariants that keep the delta small, plus a ledger of what the fork owns.

## Non-goals

- Extracting a `forge/shared/` layer. Cross-driver reuse stays as it is today — `forgejo.ts`
  imports from `github.ts` — because moving symbols out of `github.ts` buys a merge conflict on
  every upstream release and pays off only when a third driver exists. See "Invariants" §4.
- Automations on a non-GitHub forge. `automations/github-poller.ts` shells out to `gh` and never
  resolves a driver, so `automationsPollable` (`web/src/components/nav-items.ts`) stays.
- Per-project forge availability. Still probed for the boot project only.
- A write path to the `forge` key. Hand-edited, as before.
- Any renaming of routes, endpoints or files (`BACKWARD_COMPATIBILITY.md` §2).

## The pattern

Every closure follows the same four steps, so a fourth surface does not invent a fifth shape:

1. The capability enters `ForgeDriver` as an **optional method**. Never a change to an existing
   signature — see "Invariants" §1.
2. The route resolves a driver through the preamble that already exists (`loadForgeInputs` +
   `resolveForgeOrGithub` where a pre-seam GitHub fallback must be preserved byte-for-byte,
   `resolveForge` otherwise).
3. A driver that does not implement the method degrades to `{ available: false, reason }` — never
   a 5xx, matching the tab's quiet-degradation contract.
4. The `kind === 'X'` gate is deleted **in the same change** as the hole it guarded. A gate that
   outlives its hole is indistinguishable from a gate nobody understands.

## Stage A — Create PR through the driver

`POST /runs/:id/pr` resolves a driver and calls `forge.createPR(input)`.

`resolveForgeOrGithub`, not `resolveForge`: the GitHub driver's `createPR` **is** `createDraftPr`,
so the fallback for a repo with no forge (no remote, an unrecognized host, `CEZ_DRY_RUN`)
reproduces today's behaviour exactly, with no second branch to express it. This widens
`resolveForgeOrGithub` past the `/api/v1/github*` family its own doc comment scopes it to; the
widening is behaviour-preserving by construction and the comment is updated to say so.

Removed by this stage:

- the pre-mutation 409 gate and its rationale comment in `server.ts`,
- the `state.forge.kind !== 'github'` branch in `web/src/lib/git-actions.ts`. The file keeps a
  one-line delta: the no-forge message the fork reworded from "no supported forge remote (GitHub)
  detected" to drop the parenthetical is correct for any forge and stays.

`refNumberFromUrl(outcome.url)` and the `forgetRefStatus` invalidation that follows it need no
change: the parse reads the URL's trailing number, not its host, and a Forgejo pull-request URL
ends the same way. `createForgejoPr` already pushes before creating, so the "push, then create"
ordering the route's error handling assumes holds for both drivers.

Types touched: **none**. `DraftPrInput`, `DraftPrOutcome` and `ForgeDriver.createPR` are all
already in `types.ts`.

## Stage B — `forgeWebRoot` reads the repo's own `webUrl`

`forgeWebRoot(remote, forge?)` gains the same second parameter `forgeKindOfRemote` already takes.
When the host table has no answer and the repo declares a `forge` block, the web root is
`${forge.webUrl}/${owner}/${repo}`.

The security property that made this function rebuild rather than pass through is preserved and is
the reason the shape is exactly this: `owner`/`repo` still come from the **parsed** remote, never
the raw one, so a remote carrying credentials cannot leak; and `webUrl` has already passed
`forgeSettingsSchema`, which pins it to `http`/`https`. The precedence rule is unchanged — the host
table answers first, the config only fills its gap.

This unblocks `repoUrl` on Forgejo project rows and the cross-project surfaces that link by number.

## Stage C — reference status through the driver

The subtlety that shapes this stage: `readCachedRefStatuses` (`server.ts`, the runs index) is
**synchronous**, while resolving a driver needs I/O (`getRepoInfo` + `readForgeSettings`). It
therefore cannot become a driver method.

It does not need to. `refStatusCache` is keyed by `repoRoot` + number and its TTL policy (`merged`
is forever-ish at 24h, `closed` at 10 minutes, everything else short) is pure and forge-agnostic:
this is **per-repo infrastructure, not per-forge behaviour**. Only the act of FILLING it is
driver-specific.

So:

- `ForgeDriver` gains `refStatus?(input: { prs?: number[]; issues?: number[] })`, returning a
  `ForgeRefStatusResult` mirroring `githubRefStatusDataSchema` (additive: new optional method, new
  exported type).
- `createGithubDriver` wires it to the existing `fetchGithubRefStatus` — one line.
- The Forgejo driver resolves each number through `GET /repos/{owner}/{repo}/issues/{n}`, which
  answers for pull requests too and carries a `pull_request` member that identifies the kind, so
  one read settles both what a number IS and what state it is in. Results are written into the
  shared cache. `derivePrReferenceStatus` and `deriveIssueReferenceStatus` are already exported
  and pure, so the status ladder itself is reused rather than re-derived — the same reuse rule
  Invariants §4 states.
- The `/github/ref-status` route resolves a driver and degrades when the method is absent.
- `readCachedRefStatuses`, `forgetRefStatus` and `refNumberFromUrl` call sites are **unchanged**.

The one new fork delta in `forge/github.ts` is exporting the cache-write helper the Forgejo driver
needs. One line, deliberately preferred over moving the family into a shared module — see
"Invariants" §4.

## Invariants

Rules the fork follows so its delta against upstream stays small and legible.

1. **A new capability is an optional method on `ForgeDriver`, never a change to an existing
   signature.** Two changes already violate this and are frozen, not precedent:
   `listIssues`/`listPRs` returning `ForgeListResult` instead of `ForgeItem[]`, and `prStatus`
   returning `ForgePrStatusResult` instead of `ForgePrStatus | null`. Both were forced by the same
   real defect — an unreachable forge and an empty result were indistinguishable — and both are
   permanent merge cost. Nothing else may join them without the same justification.
2. **A `kind === 'X'` branch in an upstream-owned file is debt, not a solution.** It is admissible
   only with a comment naming the change that will delete it. Where the branch is permanent
   (naming, iconography), it belongs in a fork-owned table instead — `web/src/lib/forge-label.ts`
   is that table for the cockpit.
3. **The delta ledger below is maintained with every change.** After three upstream merges, nobody
   can otherwise tell the fork's lines from upstream's.
4. **Cross-driver reuse is by import while there are two drivers.** `forgejo.ts` importing
   `buildPrBody`, `mergePreflightAllowed` and (from Stage C) one cache helper from `github.ts` is
   accepted coupling. Extraction into `forge/shared/` happens once, when a third driver makes it
   load-bearing — moving code out of `github.ts` earlier trades a cost that has not arrived for a
   merge conflict on every upstream release.
5. **`FORGE_KINDS` plus the two literal copies in `packages/contract`, guarded by
   `contract-parity*.test.ts`, stays as it is.** The contract cannot import from the service; the
   parity tests are what make the duplication safe.

## Delta ledger

What the fork owns outright, and what it has had to touch in files upstream owns.

### Fork-owned (no upstream counterpart)

`packages/cezar/src/server/forge/forgejo.ts`, `forgejo-http.ts`, `forgejo-map.ts`,
`forgejo-diff.ts` and their tests · `packages/cezar/src/server/forge-seam-api.test.ts` ·
`packages/cezar/src/server/forgejo-pr-gate.test.ts` · `packages/web/src/lib/forge-label.ts` ·
`packages/web/src/lib/use-forge-kind.ts` and their tests · `.ai/specs/2026-08-14-*.md`.

### Upstream-owned, touched by the fork

| File | Why | What removes it |
|---|---|---|
| `server/forge/types.ts` | `FORGE_KINDS`, `forgeSettingsSchema`, `ForgeListResult`, `ForgePrStatusResult`, `ForgeChecksResult`, optional `listComments`/`listChecks` | Nothing — permanent. The two changed signatures are frozen (Invariants §1) |
| `server/forge/index.ts` | `classifyForgeKind`, the Forgejo branch of `resolveForge`, `resolveForgeOrGithub`, `forgeWebRoot` | Nothing — this file IS the seam's resolution point; de facto fork-owned |
| `server/forge/github.ts` | `toListResult`, the `prStatus` availability split, `listInflight` dedupe, `listComments`/`listChecks` wiring, one cache export (Stage C) | `listInflight` only if upstream ever routes `/api/github` through the driver itself |
| `server/server.ts` | driver resolution in the forge-backed routes, `loadForgeInputs` | Shrinks with every stage here; the 409 gate goes in Stage A |
| `config.ts` | the `forge` key, `readForgeSettings` | Nothing — permanent |
| `core/agent-env.ts` | `CEZ_` prefix no longer blanket-forwarded; a credential-shaped member is denied | Nothing — this is a security fix that stands on its own, forge or not |
| `workspace/projects.ts` | per-project forge classification reads the repo config | Nothing — permanent |
| `contract/src/health.ts`, `contract/src/projects.ts` | the forge enum grows one value | Nothing — permanent, guarded by parity tests |
| `web/src/lib/git-actions.ts` | Create PR gate; reworded no-forge message | **Stage A** removes the gate; the reworded message stays (correct for any forge) |
| `web/src/components/nav-items.ts` | `forgeItem`, `automationsPollable` | Automations through `resolveForge` (out of scope) |
| `web/src/components/*.tsx`, `web/src/routes/github/*` | the cockpit names the forge that answered | Nothing — presentation, permanent |

## Remaining holes (deliberate)

- **Automations.** The poller is `gh`-only. Closing it means routing it through `resolveForge`,
  which also deletes `automationsPollable`.
- **Per-project availability.** The ⌘K palette gates on the boot project's
  `health.forge.available` while naming the forge from the URL project's kind.
- **Credentials.** `CEZ_FORGEJO_TOKEN` is a single global environment variable read inside the
  HTTP layer, so two Forgejo instances in one workspace share one token and a third driver would
  add `CEZ_GITLAB_TOKEN` beside it. The natural fix — resolving credentials once, into the
  driver's context — is worth doing when there is a third driver to justify the move, not before.
- **A `forge` configuration screen.** The key is hand-edited; a bad value takes the tab down for a
  project.
