# Execution plan — CI leg that runs the suite under a leaked host environment

**Issue:** #39 (`ajurzyk/cezar`) — *ci: no leg runs the suite with the host environment leaked, so the
#17 seals are unguarded*
**Branch:** `fix/issue-39-ci-leaked-host-env-leg`
**Engine:** om-auto-create-pr (steps: 8, --loop: no)

## Goal

Add a CI job that runs the unit suites with `CLAUDE_CONFIG_DIR` and `GIT_CONFIG_*` deliberately
exported, so that deleting either of the fixture seals PR #38 added turns CI red instead of staying
invisibly green.

## Scope

Exactly one production file: `.github/workflows/ci.yml`, plus this tracking plan.

A new job `verify-host-env-leak` (`name: Suite under a leaked host environment`) sits beside `verify`
and runs in parallel with it: checkout / `setup-node` / `npm ci` preamble, a preparation step that
materialises a leaked Claude home carrying a model, then `npm run test:unit` and `npm test` with the
leak declared as step-level `env:`.

### Non-goals

- No test file changes at all (`config-api.test.ts`, `git-changes.test.ts`, `vitest.setup.ts`,
  `host-env.testkit.ts`, any fixture). This adds a guard *around* the #38 seals.
- No `.ai/agentic.config.json` change — the five `validation.commands` stay bare; re-adding any
  `env -u` prefix would reopen what #38 closed.
- No `SDLC.md` change (the validation gate list is unchanged).
- No `nightly.yml` change — it is gated on `refs/heads/main`, so a seal-removing PR would merge before
  it ever ran.
- `publish-snapshot` keeps `needs: verify` and does **not** gain `needs: verify-host-env-leak`.
- No vitest `setupFiles` scrub — forbidden by name in #17 and a weak guard anyway (a scrub deletes
  only keys that are present, so its presence and absence are indistinguishable on a clean runner).
- Not merged with #35 / #30 (the browser-e2e CI job). Same file, different testing scope; whoever goes
  second resolves the conflict.

## Preconditions (verified before starting)

| Check | Result |
|---|---|
| `grep -n "CLAUDE_CONFIG_DIR" packages/cezar/src/server/config-api.test.ts` | 5 hits (`:26`, `:29`, `:41`, `:61`, `:62`) |
| `grep -n "commit.gpgsign=false" packages/cezar/src/server/git-changes.test.ts` | `57:  'commit.gpgsign=false',` |
| `git log --oneline -1 -- packages/cezar/src/server/config-api.test.ts` | `d9138585 … (#38)` |

The `## Order` dependency (PR #38 merged first) is therefore met.

## Implementation Plan

### Phase 1 — Add the leaked-environment CI leg

Write the `verify-host-env-leak` job into `.github/workflows/ci.yml`, between `verify` and
`publish-snapshot`. `runs-on: ubuntu-latest`, explicit `timeout-minutes: 15` (matching `verify`; a
full `verify` run on this fork measures 4m23s–5m25s). Preparation step creates
`${{ runner.temp }}/leaked-claude-home/settings.json` containing `{"model":"opus"}` and carries no
`env:` of its own. The two suite steps carry the leak as step-level `env:`, keeping `checkout` and
`npm ci` outside its scope.

### Phase 2 — Prove the leg red-first, then green

Locally there is no `runner.temp`, so the job's effect is rebuilt by hand: create
`/tmp/leaked-claude-home/settings.json`, export the same six variables plus `TMPDIR=/tmp` (an
unrelated axis — a `TMPDIR` inside the repository produces six phantom failures, and this worktree
sits inside the repository).

Red first: swap in the pre-#38 fixtures from `8700e139` explicitly (not `origin/main`, which now
carries the sealed copies), run both files, and confirm the failures are exactly the four
`config-api` and two `git-changes` cases #17 named — no fewer and no others. Restore and prove a
clean `git status --porcelain`.

Green after: same exported preamble on the sealed tree, running the two commands the job runs, bare
with no `env -u`.

### Phase 3 — Validation gate and PR evidence

Full `validation.commands` gate, the `.ai/cezar/gates/baseline.sh` baseline, the acceptance-criteria
quotes (diff file list, bare `validation.commands`, `needs: verify` intact), then the PR's own run of
the new leg — quoted only once settled, never as `pending`.

## Risks

- **CI spend.** The leg is a second `npm ci` plus a second full suite run — roughly 5 minutes of CI on
  every PR. It runs in parallel with `verify`, so wall-clock to green barely moves; the spend does.
  Stated in the issue and accepted there.
- **`main` has no branch protection** (`gh api repos/ajurzyk/cezar/branches/main/protection` → 404).
  Per `.ai/trackers/github.md:45` every reported check is then treated as required, so this leg is not
  advisory: red forces `changes-requested` on every subsequent PR. It must be green at merge and must
  never be parked red.
- **Conflict with #35 / #30**, which also add a job to this file. Textual, not semantic.
- **Local reproduction is not the runner.** `runner.temp` exists only on a runner; the local proof
  substitutes `/tmp`. Criterion 5 (the leg actually running on the PR) is what closes that gap.

## Progress

### Phase 1: Add the leaked-environment CI leg

- [ ] 1.1 Add `verify-host-env-leak` job to `.github/workflows/ci.yml`

### Phase 2: Prove the leg red-first, then green

- [ ] 2.1 Red-first: pre-#38 fixtures under the leaked environment fail exactly the six named cases
- [ ] 2.2 Restore the fixtures and prove a clean working tree
- [ ] 2.3 Green: sealed tree under the same leaked environment, both suite commands bare

### Phase 3: Validation gate and PR evidence

- [ ] 3.1 Full `validation.commands` gate green
- [ ] 3.2 Baseline gate green (`.ai/cezar/gates/baseline.sh`)
- [ ] 3.3 Acceptance quotes collected (diff list, bare commands, `needs: verify`)
- [ ] 3.4 New leg settled green on this PR
