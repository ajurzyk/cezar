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

## Measurements

Numbering in this document is **this fork's** (`ajurzyk/cezar`), not upstream's.

Local stand-in for the job (there is no `runner.temp` off a runner, and `TMPDIR=/tmp` pins an
unrelated axis — a `TMPDIR` inside the repository produces six phantom failures, and this worktree
sits inside the repository):

```
mkdir -p /tmp/leaked-claude-home
printf '{"model":"opus"}' > /tmp/leaked-claude-home/settings.json
export CLAUDE_CONFIG_DIR=/tmp/leaked-claude-home
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=host@leak.invalid
export GIT_CONFIG_KEY_1=user.name GIT_CONFIG_VALUE_1=host-leak
export TMPDIR=/tmp
```

**Red — pre-#38 fixtures restored from `8700e139` explicitly** (not `origin/main`, which now carries
the sealed copies), `npx vitest run` over both files:

```
 × GET answers the zero-config defaults when no file exists
 × uses the coding agents' native model settings as the initial defaults
 × locks native defaults and rejects Cezar model overrides
 × supports the same lock through the optional repository config key
 × lists only the branch commits past the merge-base, newest first
 × ?structured=1 answers {sha, subject, author, when, files, stat} with per-file patches
 Test Files  2 failed (2)
      Tests  6 failed | 79 passed (85)
```

The four `config-api` and the two `git-changes` cases #17 named — no fewer and no others. Fixtures
restored with `git checkout --`; `git status --porcelain` for both prints nothing.

**Green — sealed tree, the two commands the job runs, bare:**

```
npm run test:unit  → ℹ tests 36 / ℹ pass 36 / ℹ fail 0            (exit 0)
npm test           → Test Files  336 passed (336)
                     Tests  6602 passed (6602)                    (exit 0)
```

## Progress

### Phase 1: Add the leaked-environment CI leg

- [x] 1.1 Add `verify-host-env-leak` job to `.github/workflows/ci.yml` — 9938b5dc

### Phase 2: Prove the leg red-first, then green

- [x] 2.1 Red-first: pre-#38 fixtures under the leaked environment fail exactly the six named cases — 9938b5dc
- [x] 2.2 Restore the fixtures and prove a clean working tree — 9938b5dc
- [x] 2.3 Green: sealed tree under the same leaked environment, both suite commands bare — 9938b5dc

### Phase 3: Validation gate and PR evidence

- [x] 3.1 Full `validation.commands` gate green — all five, in order, at `16a57eac`:
      `npm run typecheck` exit 0; `npm test` → `Test Files 336 passed (336)` / `Tests 6602 passed (6602)`;
      `npm run test:unit` → `pass 36 / fail 0`; `npm run build` exit 0; `npm run test:package` → `pass 15 / fail 0`
- [x] 3.2 Baseline gate green (`.ai/cezar/gates/baseline.sh`, via `verify.sh`) — `336 passed (336)` / `6602 passed (6602)`, 70.46 s
- [x] 3.3 Acceptance quotes collected — `git diff --name-only origin/main...HEAD` lists exactly
      `.ai/runs/2026-08-25-ci-leaked-host-env-leg.md` and `.github/workflows/ci.yml`;
      `jq -r '.validation.commands[]' .ai/agentic.config.json` answers the five bare commands and
      `grep -n "env -u" .ai/agentic.config.json` prints nothing; `needs: verify` still at `.github/workflows/ci.yml:142`
- [x] 3.4 New leg settled green on this PR — `gh pr checks 43` → `Suite under a leaked host environment  pass  4m17s`
      (run 32888710316, job 97935473659; all seven steps `success`)
