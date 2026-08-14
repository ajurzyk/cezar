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

- Route all three surfaces through `ForgeDriver`, using one repeatable pattern where the surface
  admits one (see "The pattern" for the two that do not).
- Remove every `kind === 'github'` gate those holes created.
- Keep the new fork delta in `forge/github.ts` to the smallest thing that works — which Stage C
  prices honestly rather than optimistically: extracting the ref-status cache helpers, not a
  one-line export.
- Write down the invariants that keep the delta small, plus a ledger of what the fork owns that can
  be CHECKED against the tree rather than trusted.

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

The shape a **new driver-backed read** takes, so a fourth one does not invent a fifth. Stage C is
the worked example; Stage A and Stage B are the two variants this pattern does NOT cover, named
below so nobody tries to force them into it.

1. The capability enters `ForgeDriver` as an **optional method**. Never a change to an existing
   signature — see "Invariants" §1.
2. The route resolves a driver through the preamble that already exists (`loadForgeInputs` +
   `resolveForgeOrGithub` where a pre-seam GitHub fallback must be preserved byte-for-byte,
   `resolveForge` otherwise).
3. A driver that does not implement the method degrades to `{ available: false, reason }` — never
   a 5xx, matching the tab's quiet-degradation contract.
4. The `kind === 'X'` gate is deleted **in the same change** as the hole it guarded. A gate that
   outlives its hole is indistinguishable from a gate nobody understands.

The two variants, and why each is one:

- **A capability already on the interface** (Stage A). `createPR` is a REQUIRED member of
  `ForgeDriver` and both drivers implement it, so step 1 does not apply and step 3's shape is the
  wrong one: this route's failure contract is `DraftPrOutcome` plus a 409 carrying a `manual`
  command, not `{ available: false }`. Only steps 2 and 4 apply.
- **A pure function, not a driver method** (Stage B). `forgeWebRoot` is called from a synchronous
  path with no driver in hand; it gains a parameter, not a seam. Only step 4 applies.

Step 4 is the one step all three share, and it is the one that shrinks the fork.

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
  detected" to drop the parenthetical is correct for any forge and stays,
- the two tests that pin that gate, replaced rather than deleted:
  `server/forgejo-pr-gate.test.ts`'s "refuses with 409 instead of pushing the branch" case becomes
  the positive one (the route resolves the driver and creates the pull request through it), while
  its "still creates the draft PR for a github forge" sibling stands unchanged and is what proves
  the GitHub path did not move; `web/src/lib/git-actions.test.ts`'s "disabled for a non-GitHub
  forge" case becomes "enabled for an available non-GitHub forge", keeping the surrounding
  `hasWorktree`/`available`/`isActive` cases as they are,
- the `POST /api/v1/runs/:id/pr` entry in `BACKWARD_COMPATIBILITY.md` §2, which already declares
  the refusal temporary and names this change as what ends it — see "Backward compatibility" below,
- the same gap where the fork wrote it down twice more: the "known gap" paragraph in `README.md`'s
  Forgejo section and the closing sentence of `AGENTS.md`'s forge-integration row. A gate deleted in
  three files and left standing in two documents is how the next reader learns to distrust both.

**Known caveat this stage makes reachable.** Forgejo's `CreatePullRequestOption` has no `draft`
field: `createForgejoPr` fakes draft state with a `WIP:` title prefix, and an instance that has
customized `WORK_IN_PROGRESS_PREFIXES` away from the default list creates a NON-draft pull request
instead — documented in the driver, unreachable until now because the gate refused first. Enabling
the button ships that caveat to the review gate, where "draft" is a promise about mergeability.
Accepted as-is rather than fixed here: `DraftPrOutcome` has no field to carry a "created, but not
actually a draft" warning, so surfacing it is a route-and-UI change of its own. Named so the next
reader finds it in the design record and not only in a comment.

`refNumberFromUrl(outcome.url)` and the `forgetRefStatus` invalidation that follows it need no
change: the parse reads the URL's trailing number, not its host, and a Forgejo pull-request URL
ends the same way. `createForgejoPr` already pushes before creating, so the "push, then create"
ordering the route's error handling assumes holds for both drivers.

Types touched: **none**. `DraftPrInput`, `DraftPrOutcome` and `ForgeDriver.createPR` are all
already in `types.ts`.

**Verified by:** the two rewritten tests above, plus `forge-seam-api.test.ts`'s existing coverage
that `resolveForgeOrGithub`'s fallback reaches the GitHub path byte for byte for a repo
`resolveForge` cannot answer for. Done means: a Forgejo repo's Create PR button is enabled, the
click creates the pull request through `forge.createPR`, and no `kind === 'github'` branch remains
in either file.

## Stage B — `forgeWebRoot` reads the repo's own `webUrl`

`forgeWebRoot(remote, forge?)` gains the same second parameter `forgeKindOfRemote` already takes.
When the host table has no answer and the repo declares a `forge` block, the web root is
`${forge.webUrl}/${owner}/${repo}`.

The security property that made this function rebuild rather than pass through is preserved and is
the reason the shape is exactly this: `owner`/`repo` still come from the **parsed** remote, never
the raw one, so a remote carrying credentials cannot leak; and `webUrl` has already passed
`forgeSettingsSchema`, which pins it to `http`/`https`. The precedence rule is unchanged — the host
table answers first, the config only fills its gap.

Two details the formula above is shorthand for, both matching what the driver already does with the
same value: the segments are `encodeURIComponent`'d exactly as `forgejoViewUrl` encodes them, and
`webUrl`'s trailing slashes are trimmed before concatenation. `apiUrl` is already trimmed on its way
into `ForgejoHttp`; `webUrl` is trimmed nowhere today, so a config ending in `/` would otherwise
render `https://host//owner/repo`.

What this does NOT do is verify that the declared `webUrl` and the remote's host describe the same
instance — `classifyForgeKind` answers `forgejo` for ANY host the table cannot name once the config
declares one, so a repo whose remote points somewhere else gets a link into the configured instance.
That is the trust model `resolveForge` already applies to the driver (same config, same host, same
consequences); the only thing new here is that a mistake becomes a visibly wrong link rather than a
failing API call. Config-declared, hand-edited, code-trusted: accepted, and stated so that a future
"why does this row link to the wrong server" starts here.

This unblocks `repoUrl` on Forgejo project rows and the cross-project surfaces that link by number,
and it changes a statement `BACKWARD_COMPATIBILITY.md` §2 makes about that field — see "Backward
compatibility" below.

**Verified by:** `forge/index.test.ts` gains the config-fills-the-gap cases `forgeKindOfRemote`
already has (host table wins; a `github.com` remote is unaffected whatever the config says; a
trailing-slash `webUrl` and an odd owner/repo segment both render correctly), and
`workspace/projects.test.ts` gains a Forgejo project row asserting `repoUrl`. Done means: a Forgejo
project reports `repoUrl`, a GitHub project's value is byte-identical to today's, and a project with
no forge still reports none.

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
  exported type). `recheckAfterMs` is REQUIRED in both branches of that union — the cockpit's whole
  refresh policy is "ask again when told to" — so a driver implementing this method owes a cadence,
  not just statuses.
- `createGithubDriver` wires it to the existing `fetchGithubRefStatus` — one line.
- The Forgejo driver resolves each number through `GET /repos/{owner}/{repo}/issues/{n}`, which
  answers for pull requests too and carries a `pull_request` member that identifies the kind, so
  one read settles what a number IS and whether it is open, closed or merged. Results are written
  into the shared cache.
- The `/github/ref-status` route resolves a driver and degrades when the method is absent.
- `readCachedRefStatuses`, `forgetRefStatus` and `refNumberFromUrl` call sites are **unchanged**.

### What that one read can honestly say

`derivePrReferenceStatus` and `deriveIssueReferenceStatus` are exported and pure, so the derivation
is reused rather than re-implemented — but reusing the function is not the same as reaching every
rung of its ladder, and this is where the stage has a real decision rather than a mechanical port.

`derivePrReferenceStatus` reads `checks` and `reviewDecision` before it will say `ready`; the
Forgejo issues payload carries neither. Feeding it `checks: null, reviewDecision: null` returns
`ready` for EVERY open non-draft pull request — including one whose CI is red and one whose reviewer
asked for changes. `ready` is documented as "no failing or running checks, and no review the forge is
still waiting on", so that is not a degradation, it is the chip asserting the opposite of the truth.
The chips spec (`2026-08-11-reference-status-chips.md`) settles this direction already: a chip with
no status says which kind of nothing it is, and never guesses.

So the Forgejo ladder is bounded to what one read supports, and the bound is part of the design:

| Number is | Forgejo answers | Why |
|---|---|---|
| issue, open | `open` | direct |
| issue, closed | `completed` | Forgejo has no state-reason concept, so `not-planned` is unreachable and every closed issue reads as done. Stated, not silently inherited — the vocabulary keeps these apart precisely because they are opposite outcomes |
| PR, merged / closed | `merged` / `closed` | `pull_request.merged` distinguishes them |
| PR, open + draft | `draft` | from `pull_request.draft` where the payload carries it, else the `WIP:` prefix `stripWipTitle` already recognises — see Open questions |
| PR, open + not draft | **absent from the map** | the contract's own "absent number = nothing known, chip stays neutral". A neutral chip is the honest answer while checks and reviews are unread |

Filling the remaining rungs costs `pulls/{n}` (head sha), `commits/{sha}/status` and
`pulls/{n}/reviews` per number — three more reads each, against a route that accepts up to
`REFERENCE_STATUS_MAX` (100) numbers per kind. The driver can already do all three; spending them is
a follow-up with its own budget question, listed under "Remaining holes", not a line item here.

**Failed is not absent.** `RefStatusBatch` exists to keep "this repository has no such number" apart
from "we could not ask", and to make sure the second is never cached. The Forgejo path inherits that
rule explicitly: a **404 is absent** and is cached as such; any other outcome — transport failure,
5xx, 401/403 — marks the number FAILED, caches nothing, and degrades the whole payload to
`{ available: false, reason, recheckAfterMs }` on the same five-minute retry the GitHub path uses.
An outage cached as "that reference is bogus" is the defect this rule exists to prevent.

**Bounded fan-out.** One request per number, capped by the route's existing per-kind limit and issued
through the same bounded-concurrency helper `forgejoListChecks` already uses for its
`commits/{sha}/status` fan-out — never an unbounded `Promise.all` over a hundred numbers at a
self-hosted instance.

### What `forge/github.ts` actually has to give up

Not "one line". There is no cache-write helper to export: the write is inline in
`fetchGithubRefStatus`, together with the `storedAt` stamping and the LRU eviction that bounds the
map, and `refStatusKey` is private. `recheckAfterMs` is computed by the private `batchRecheckAfter`
over `refStatusRecheckAfter`/`refStatusTtl`, all three of them private too. So Stage C **extracts** a
small cache module's worth of behaviour from that file — write-with-eviction, the key builder, and
the recheck cadence — and exports it, which is a change to an upstream-owned function body plus
three or four newly exported symbols.

That is worth restating rather than glossing, because Invariants §4 argues against `forge/shared/`
on the strength of the coupling being cheap. At three or four symbols it is no longer one line — and
the answer is still by-import, for a different reason than before: what the Forgejo driver needs is
the CACHE, and the cache is per-repo infrastructure that `github.ts` happens to house, not GitHub
behaviour that wants a neutral home. If a third driver arrives, `forge/shared/ref-status-cache.ts`
is the first thing to extract, and this stage is what makes that a move rather than a rewrite.

**Verified by:** `forge/github.test.ts` keeps its `fetchGithubRefStatus` suite green through the
extraction (that suite IS the regression test for the cache's TTL, eviction and
failed-is-not-absent behaviour); the Forgejo driver's own tests cover the ladder table above row by
row, the 404-versus-transport-failure split, and that a failed number is never cached;
`forge-seam-api.test.ts` covers the route degrading to `{ available: false, reason }` for a driver
without the method. Done means: a Forgejo task chip shows a status for issues and for
merged/closed/draft pull requests, an unreachable instance degrades in the payload instead of
5xx-ing, and the GitHub payloads are byte-identical to today's.

## Backward compatibility

`BACKWARD_COMPATIBILITY.md` §2 protects the shape of every `/api/v1` route, and two of these three
stages move sentences in it. Neither is breaking under that document's own rules, but both edits
belong to the stage that causes them:

- **Stage A — `POST /api/v1/runs/:id/pr`.** §2 currently documents the 409 for a non-GitHub forge
  and calls it "temporary: the refusal goes away when this route resolves a `ForgeDriver`". This is
  that change, so the removal is pre-authorised; the entry is rewritten to describe the driver-backed
  behaviour instead of deleted, because a route that USED to refuse is worth a sentence for at least
  one release. GitHub repos and repos with no forge are unaffected — same handler, same 409 shape for
  every other failure.
- **Stage B — `GET /api/v1/projects`.** §2 states that `repoUrl?` is omitted for a project "whose
  forge is known only from its repo config … so such a row's references degrade to plain text".
  Stage B makes that false: the field starts appearing for exactly those rows. Additive — an
  already-optional field begins to be sent, its type and format unchanged, and a consumer that
  ignores it sees nothing new — but the paragraph must be updated in the same change, along with the
  two comments that repeat the reasoning (`workspace/projects.ts`'s `forgeWebRoot` note and
  `contract/src/projects.ts`'s `repoUrl` doc).
- **Stage C** adds a route behaviour rather than changing one: `/github/ref-status` starts answering
  for a forge that previously always degraded. The payload schema is untouched.

Nothing here renames a route, an endpoint or a file (Non-goals), and no protected state file, CLI
flag or event name is involved.

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
3. **The delta ledger below is maintained with every change, and it is checkable rather than
   remembered.** `git diff --name-only <latest-upstream-tag> origin/main` is the ledger's ground
   truth: every path it prints outside `.ai/` is either fork-owned or has a row. Run it when
   updating the ledger — a ledger nobody can verify is a ledger that quietly stops being true, and
   after three upstream merges it is the only thing that can tell the fork's lines from upstream's.
4. **Cross-driver reuse is by import while there are two drivers.** `forgejo.ts` importing
   `buildPrBody`, `mergePreflightAllowed` and (from Stage C) the extracted ref-status cache helpers
   from `github.ts` is accepted coupling. Extraction into `forge/shared/` happens once, when a third
   driver makes it load-bearing — moving code out of `github.ts` earlier trades a cost that has not
   arrived for a merge conflict on every upstream release. Stage C is the first time that trade got
   more expensive (three or four symbols rather than one); the next time it does, re-argue it instead
   of citing this rule.
5. **`FORGE_KINDS` plus the two literal copies in `packages/contract`, guarded by
   `contract-parity*.test.ts`, stays as it is.** The contract cannot import from the service; the
   parity tests are what make the duplication safe.

## Delta ledger

What the fork owns outright, and what it has had to touch in files upstream owns. Ground truth is
`git diff --name-only <latest-upstream-tag> origin/main` (Invariants §3) — as of v0.10.0 that is 58
paths outside `.ai/`, and every one of them appears below or is fork-owned.

### Fork-owned (no upstream counterpart)

`packages/cezar/src/server/forge/forgejo.ts`, `forgejo-http.ts`, `forgejo-map.ts`,
`forgejo-diff.ts` and their tests · `packages/cezar/src/server/forge-seam-api.test.ts` ·
`packages/cezar/src/server/forgejo-pr-gate.test.ts` · `packages/web/src/lib/forge-label.ts` ·
`packages/web/src/lib/use-forge-kind.ts` and their tests · `.ai/specs/2026-08-14-*.md`.

### Upstream-owned, touched by the fork

Every row's tests travel with it: where the fork changed an upstream source file it also changed
that file's upstream test (`config.test.ts`, `core/agent-env.test.ts`, `runs/task-refs.test.ts`,
`server/automations-api.test.ts`, `server/forge/github.test.ts`, `server/forge/index.test.ts`,
`server/github-merge-api.test.ts`, `server/health-forge.test.ts`, `workspace/projects.test.ts`, and
the web counterparts of every `web/src` row). They are not listed separately — the rule is that a
row covers its own test file, and only the additions are new cases, never rewritten upstream ones.

| File | Why | What removes it |
|---|---|---|
| `server/forge/types.ts` | `FORGE_KINDS`, `forgeSettingsSchema`, `ForgeListResult`, `ForgePrStatusResult`, `ForgeChecksResult`, optional `listComments`/`listChecks` | Nothing — permanent. The two changed signatures are frozen (Invariants §1) |
| `server/forge/index.ts` | `classifyForgeKind`, the Forgejo branch of `resolveForge`, `resolveForgeOrGithub`, `forgeWebRoot` | Nothing — this file IS the seam's resolution point; de facto fork-owned |
| `server/forge/github.ts` | `toListResult`, the `prStatus` availability split, `listInflight` dedupe, `listComments`/`listChecks` wiring, the extracted ref-status cache helpers (Stage C: write-with-eviction, key builder, recheck cadence) | `listInflight` only if upstream ever routes `/api/github` through the driver itself; the cache helpers only if they move to `forge/shared/` behind a third driver |
| `server/server.ts` | driver resolution in the forge-backed routes, `loadForgeInputs` | Shrinks with every stage here; the 409 gate goes in Stage A |
| `config.ts` | the `forge` key, `readForgeSettings` | Nothing — permanent |
| `core/agent-env.ts` | `CEZ_` prefix no longer blanket-forwarded; a credential-shaped member is denied | Nothing — this is a security fix that stands on its own, forge or not |
| `workspace/projects.ts` | per-project forge classification reads the repo config | Nothing — permanent |
| `contract/src/health.ts`, `contract/src/projects.ts` | the forge enum grows one value | Nothing — permanent, guarded by parity tests |
| `web/src/lib/git-actions.ts` | Create PR gate; reworded no-forge message | **Stage A** removes the gate; the reworded message stays (correct for any forge) |
| `web/src/lib/github-task.ts` | the hand-to-agent prompt names the forge the item lives on (`forge` parameter, `FORGE_KINDS` import); omitted keeps the GitHub wording | Nothing — permanent; an instruction that says "GitHub issue" about a Forgejo issue is simply false |
| `web/src/components/nav-items.ts` | `forgeItem`, `automationsPollable` | Automations through `resolveForge` (out of scope) |
| `web/src/routes.tsx` | the forge tab's route entry carries `forge: true` instead of a literal `pageLabel`, and `pageTitleContext` takes the kind | Nothing — presentation, permanent |
| `web/src/components/*.tsx`, `web/src/routes/github/*` | the cockpit names the forge that answered | Nothing — presentation, permanent |
| `BACKWARD_COMPATIBILITY.md` | §1 env vars gains `CEZ_FORGEJO_TOKEN`; §2 health `forge.kind` gains `'forgejo'`, `GET /projects` documents the `repoUrl`/`forge` behaviour, `POST /runs/:id/pr` documents the temporary 409; §3 `config.json` documents the `forge` key | **Stage A** removes the 409 entry, **Stage B** rewrites the `repoUrl` clause; the rest is permanent |
| `README.md` | the `CEZ_FORGEJO_TOKEN` row, the `forge` config block, and the Forgejo driver section including its "known gap" paragraph | **Stage A** removes the known-gap paragraph; the rest is permanent |
| `AGENTS.md` | the GitHub-integration row became a forge-integration row (the `ForgeDriver` seam, two credential postures, the `POST /runs/:id/pr` known gap) | **Stage A** removes the known-gap sentence; the rest is permanent |
| `.env.example` | the Forgejo section documenting `CEZ_FORGEJO_TOKEN`'s scope and non-forwarding | Nothing — permanent |

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
- **The upper rungs of the Forgejo reference-status ladder.** Stage C stops at what one read can
  prove: `checks-pending`, `checks-failing`, `changes-requested`, `review-required` and the honest
  `ready` need `pulls/{n}` + `commits/{sha}/status` + `pulls/{n}/reviews` per number, against a route
  that takes up to a hundred numbers at a time. Worth doing once someone is actually watching CI from
  a Forgejo task table; until then a neutral chip beats a green one that has not looked.

## Open questions

Two measurements against a live instance, both of which change one line of Stage C and neither of
which blocks the design (the fork's habit is to measure rather than assume — every "measured on a
live instance" note in `forgejo.ts` came from one of these):

1. **Does Forgejo's `GET /repos/{o}/{r}/issues/{n}` carry `pull_request.draft`?** If it does, the
   `draft` rung comes free from the one read. If it does not, fall back to the `WIP:` prefix that
   `stripWipTitle` already recognises — which is the same signal Forgejo itself derives draft state
   from, and therefore no less reliable than the create path already is.
2. **Is there any `state_reason` equivalent on a closed Forgejo issue?** The ladder table assumes
   there is not, and maps every closed issue to `completed`. If a later Forgejo version grows one,
   `not-planned` becomes reachable and the table's second row changes.
