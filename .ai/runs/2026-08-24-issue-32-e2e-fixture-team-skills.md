# Execution plan — issue #32: fixture servers see the machine's team-skill collection

**Issue:** ajurzyk/cezar#32 (package 1 of the #30 split)
**Base:** `main` @ `7184308e`
**Branch:** `fix/issue-32-e2e-fixture-team-skills`

## Goal

A spec-owned fixture server's skill catalog contains exactly what the fixture put there, on any
machine, warm cache or cold — and no future spec can silently reacquire the leak.

## Scope

`discoverSkills` (`packages/cezar/src/skills.ts:85`) merges repo-local dirs, global dirs, and
`getTeamSkillsCached(repoRoot)`. The team-skill bare clone lives at
`join(homedir(), '.cache', 'cez', 'skills', key)` (`skills-remote.ts:155`), keyed off `homedir()`
— so `fixtureServeEnv`'s `CEZ_HOME` pin cannot contain it. `open-mercato/skills` is the DEFAULT
source for any repo that has not set `skillsRepos`, and no fixture repo sets one.

Route taken: **spec-side**, the route the issue prefers. `.ai/cezar/config.json` with
`"skillsRepos": []` is the documented opt-out (`config.ts:12`), it is read per-repo by
`loadTeamSkills`, and it closes the cold-cache race too — with an empty source list
`loadTeamSkills` iterates nothing, so it neither clones nor lists, warm or cold. No product
behaviour changes for users.

Chokepoint: `fixtureServeEnv` in `packages/web/e2e/agent-browser.ts` — every self-booting spec
already calls it, and in every call site the directory it is handed is the same directory passed
to `serve --repo`. Folding the seal in there (rather than adding a companion helper specs must
remember to call) is what makes the invariant automatic.

## Non-goals

- Any other failing spec from #30 — groups 2 and 3 are separate packages. `queued-stack.e2e.ts`
  is touched for exactly one expression (its hand-rolled serve env), never for its own failures.
- `packages/cezar/src/server/forge/**`.
- `~/.cache/cez/skills` itself: never deleted. The cold path is exercised by redirecting `HOME`
  to a throwaway directory, which leaves the developer's cache untouched.
- The shared test env (`.ai/scripts/test-env-up.sh`) serves the REAL repo, whose catalog
  legitimately includes team skills — `settings-skills.e2e.ts` and `skills-update.e2e.ts` assert
  against exactly that. It must NOT get the same seal.

## Implementation Plan

### Phase 1: Pin the mechanism at the config seam

Prove, in the fast unit gate and without a network, that `"skillsRepos": []` empties the team
catalog while a configured source fills it — so the seal below is not asserted vacuously on a
machine with a cold cache.

### Phase 2: Seal the chokepoint

`fixtureServeEnv(dataRoot)` writes the seal into `<dataRoot>/.ai/cezar/config.json` before
returning the env, MERGING into an existing config (`forgejo.e2e.ts` writes a `forge` block into
that same file) and never overwriting a `skillsRepos` a spec set deliberately.

### Phase 3: Close the bypass

The `fixture-serve-must-pin-cez-home` design guardian is line-level: a hand-rolled
`{ CEZ_DRY_RUN, CEZ_HOME }` satisfies it without going through the helper, and
`queued-stack.e2e.ts` does exactly that. Tighten the guardian to require the helper and route
that one spec through it, so the seal cannot be bypassed by a future spec either.

### Phase 4: Verify

Warm cache, cold cache, the two target specs, and the full suite before/after.

## Risks

- The seal adds one untracked file to each fixture repo. `diff-scroll.e2e.ts` already absorbs the
  `.ai/cezar/.gitignore` cezar writes at boot (it reads the server's own count and asserts
  `>= FIXTURE_FILES`), and no other fixture spec asserts an exact untracked-file set — but the
  full-suite before/after comparison is what actually settles this.
- Making an env-returning function write a file is a real surprise. Mitigated by naming it in the
  doc comment and by the guardian, which is now the thing that says specs must go through it.
- The full suite is run from inside `.ai/cezar/worktrees/`, so `test-env-up.sh` skips the Forgejo
  test project by design (its own QA CAVEAT). Before and after are measured in that same
  environment, so the comparison is valid even though the absolute count differs from #30's.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Pin the mechanism at the config seam

- [x] 1.1 Unit test: `skillsRepos: []` yields no team skills, with a local-repo positive control — 5fdbcee9

### Phase 2: Seal the chokepoint

- [x] 2.1 `fixtureServeEnv` seals the fixture repo's `.ai/cezar/config.json` — 03dc3e9e
- [x] 2.2 Unit test for the seal: creates, merges, and never clobbers a deliberate `skillsRepos` — 03dc3e9e

### Phase 3: Close the bypass

- [x] 3.1 Tighten the `fixture-serve-must-pin-cez-home` guardian to require the helper — f724c3eb (renamed to `fixture-serve-must-use-helper`, since the fix it asks for changed)
- [x] 3.2 Route `queued-stack.e2e.ts`'s hand-rolled serve env through `fixtureServeEnv` — f724c3eb

### Phase 4: Verify

> The agent-browser provider cannot be provisioned in the container this branch was built in —
> `test-env-up.sh` boots the app fine but reports `BROWSER_INSTALLED=0`, and the harness's own
> contract says a machine that cannot run a browser must not masquerade as a pass. So 4.1 and 4.2
> were measured one layer down instead, at the seam the DOM assertion reads
> (`GET /api/v1/p/<projectId>/skills?wait=1`, which is what renders the source dropdown), by
> booting the `new-task.e2e.ts` fixture verbatim three ways. The browser-level run is CI's
> ("Unit, build, E2E, and package"), and it is the acceptance evidence.

- [x] 4.1 `new-task` + `plan-mode` green on a warm cache (9 → 0) — measured at the skills API:
      unsealed, this machine's warm cache leaked **36** team skills into the fixture, so the
      catalog began `lint-fix, om-apply-upgrade-notes, …` — the exact miscompare the issue
      reports. Sealed, it is exactly `lint-fix, spec-writer`.
- [x] 4.2 `new-task` + `plan-mode` green on a cold cache (redirected `HOME`), no cache dir created
      — sealed against a throwaway `HOME`: catalog again exactly `lint-fix, spec-writer`, and
      `<home>/.cache/cez/skills` was **not** created, so nothing was cloned and no background load
      can move the answer between two reads.
- [x] 4.3 Full validation gate + full e2e suite before/after, no baseline regression — the gate is
      green in full (typecheck, `npm test` 335 files / 6595 tests, `test:unit` 36, build +
      `check:pack`, `test:package` 15); before the change it was 334 / 6589. The full e2e suite is
      the browser run this container cannot host, so CI carries it.
