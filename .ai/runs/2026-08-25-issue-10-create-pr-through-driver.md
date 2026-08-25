# Forge seam Stage A — Create PR through the driver

Source doc: `.ai/specs/2026-08-14-forge-seam-closure.md` (Stage A)
Issue: ajurzyk/cezar#10
Date: 2026-08-25

## Goal

`POST /runs/:id/pr` resolves a `ForgeDriver` and calls `forge.createPR(...)` instead of importing
the GitHub-only `createDraftPr` directly — so a Forgejo repo's Create PR button works, and the two
fork-only `kind === 'github'` branches that guarded the unrouted route leave upstream-owned files.

## Scope

- `packages/cezar/src/server/server.ts` — the `.post('/runs/:id/pr', …)` handler: resolve the driver
  through the existing `loadForgeInputs` + `resolveForgeOrGithub` preamble, call `forge.createPR`,
  delete the pre-mutation 409 gate, its rationale comment, the now-unused `loadConfig(repoRoot)`
  read in this handler and the now-unused `createDraftPr` import.
- `packages/cezar/src/server/forge/index.ts` — widen `resolveForgeOrGithub`'s doc comment past the
  `/api/v1/github*` family it currently scopes itself to, and say why the widening is
  behaviour-preserving.
- `packages/web/src/lib/git-actions.ts` — delete the `state.forge.kind !== 'github'` branch in
  `createPrAction` and its rationale comment. Keep the reworded no-forge message.
- Tests: `packages/cezar/src/server/forgejo-pr-gate.test.ts` (rewritten red-first),
  `packages/web/src/lib/git-actions.test.ts` (the disabled-button case).
- Docs the same gate is written down in: `BACKWARD_COMPATIBILITY.md` §2, `README.md`'s Forgejo
  section, `AGENTS.md`'s forge-integration row.

`resolveForgeOrGithub`, **not** `resolveForge`: the GitHub driver's `createPR` *is* `createDraftPr`,
so the fallback for a repo with no forge (no remote, unrecognized host, `CEZ_DRY_RUN`) reproduces
today's behaviour exactly, with no second branch needed to express it.

## Non-goals

- No change to `server/forge/types.ts`. `DraftPrInput`, `DraftPrOutcome` and `ForgeDriver.createPR`
  are all already there. **This stage changes no types.**
- No change to `refNumberFromUrl` / `forgetRefStatus` after a successful create: the parse reads the
  URL's trailing number, not its host, and a Forgejo PR URL ends the same way.
- No change to the route's "push, then create" error handling — `createForgejoPr` already pushes
  before creating, so the ordering the handler assumes holds for both drivers.
- Stage B (`forgeWebRoot`, landed as #22) and Stage C (reference status) are out of scope. No
  ordering constraint against either.
- No `/api/github` response-shape change (`BACKWARD_COMPATIBILITY.md` §2).
- The Forgejo `WIP:`-prefix draft caveat is **not** fixed here — the spec names it as accepted, and
  `DraftPrOutcome` has no field to carry "created, but not actually a draft".

## Implementation Plan

### Phase 1 — Red tests

Rewrite the two tests that pin the gate so they assert the opposite. Red first: both must fail
against the current implementation before Phase 2 touches production code.

### Phase 2 — Route the handler through the driver

The three production edits, landed together so no gate outlives its hole.

### Phase 3 — The same gate, written down three more times

The spec is explicit that a gate deleted in code and left standing in the documents is how the next
reader learns to distrust both.

### Phase 4 — Full validation gate

Baseline suite (`.ai/cezar/gates/baseline.sh`) plus `npm run typecheck`, then the PR.

## Risks

- **Scope-of-preamble.** `loadForgeInputs` is a hoisted `async function` declared inside `createApp`
  at the same nesting level as `runsRoutes`, so it is in scope at a call site textually above it.
  Verified structurally (both at indent 2 inside `createApp`) and again by the Phase 1 test running
  green in Phase 2 — not assumed.
- **Dry-run divergence.** `createDraftPr` and `createForgejoPr` both short-circuit under
  `CEZ_DRY_RUN=1`, but to different fake URLs (`…/pull/…` vs `…/pulls/777`). The rewritten test
  asserts the driver's URL, so a handler that silently kept the GitHub path would fail.
- **Behaviour preservation for GitHub / no-forge repos.** Guarded by the untouched
  "still creates the draft PR for a github forge" case plus a new no-forge case, and by
  `forge-seam-api.test.ts`'s existing coverage of `resolveForgeOrGithub`'s fallback.
- **Test-count regression.** Baseline on `main` at `0678ea8a` is 335 files / 6595 tests. The branch
  must be green and must not lose tests against that number.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Red tests

- [x] 1.1 Rewrite `forgejo-pr-gate.test.ts`: the Forgejo case reaches the driver's `createPR` and answers 201 with the driver's URL; keep the github-forge case; add a no-forge case proving the GitHub fallback — c6357898
- [x] 1.2 Flip `git-actions.test.ts`'s "disabled for a non-GitHub forge" case to "enabled for an available non-GitHub forge" — c6357898

### Phase 2: Route the handler through the driver

- [x] 2.1 `server.ts`: resolve via `loadForgeInputs` + `resolveForgeOrGithub`, call `forge.createPR`, delete the 409 gate, its comment, the unused `loadConfig` read and the unused `createDraftPr` import — c0be5da5
- [x] 2.2 `forge/index.ts`: widen `resolveForgeOrGithub`'s doc comment to cover this mutation route and say why it is behaviour-preserving — c0be5da5
- [x] 2.3 `git-actions.ts`: delete the `state.forge.kind !== 'github'` branch and its rationale comment — c0be5da5

### Phase 3: The same gate, written down three more times

- [ ] 3.1 `BACKWARD_COMPATIBILITY.md` §2: retire the `POST /api/v1/runs/:id/pr` 409 entry
- [ ] 3.2 `README.md`: rewrite the Forgejo section's "two gaps remain" — draft-PR creation is no longer one
- [ ] 3.3 `AGENTS.md`: drop the "Known gap" sentence from the forge-integration row

### Phase 4: Full validation gate

- [ ] 4.1 `npm run typecheck` clean and the baseline suite green with no lost tests
- [ ] 4.2 Grep-proof: no `kind === 'github'` / `kind !== 'github'` left in `server.ts` or `git-actions.ts`
