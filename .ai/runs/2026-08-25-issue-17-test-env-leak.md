# Execution plan — issue #17: two tests leak the host environment

**Issue:** ajurzyk/cezar#17
**Branch:** `fix/issue-17-test-env-leak`
**Base:** `main` @ `0678ea8a`
**Engine:** om-auto-create-pr

## Goal

Make `packages/cezar/src/server/config-api.test.ts` and
`packages/cezar/src/server/git-changes.test.ts` immune to a host that exports
`CLAUDE_CONFIG_DIR` or `GIT_CONFIG_*`, so the `env -u …` prefix can be dropped from
`.ai/agentic.config.json` and the agent's validation gate runs the same five bare commands
as `.github/workflows/ci.yml`.

## Scope

Three files:

- `packages/cezar/src/server/config-api.test.ts` — the fixture repoints `HOME`, `CEZ_HOME`,
  `CODEX_HOME` and `XDG_CONFIG_HOME` into a temp `homeRoot` but never touches
  `CLAUDE_CONFIG_DIR`. `agentHomePaths` (`packages/cezar/src/paths.ts:165`) resolves the
  Claude home as `env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')`, so an exported
  value outranks the repointed `HOME` and the code under test reads the host's real Claude
  config. Fix with the file's own `CODEX_HOME` pattern: save, repoint into `homeRoot`,
  restore.
- `packages/cezar/src/server/git-changes.test.ts` — `initRepo` sets the fixture identity
  with **repository-local** `git config`, which loses to `GIT_CONFIG_*` in the environment.
  Carry the identity as `git -c user.email=… -c user.name=…` on the fixture's own git
  invocations, which outranks the environment. That spelling is already the repo idiom
  (`packages/cezar/src/workflows/workspace-semaphore.test.ts:11`,
  `packages/cezar/src/skills.test.ts:185`, `packages/cezar/test/e2e/package-cli.test.ts:84`).
- `.ai/agentic.config.json` — drop the `env -u …` prefix from the two affected
  `validation.commands` entries, leaving bare `npm test` and `npm run test:unit`.

## Non-goals

- `SDLC.md` — its "Validation gate" section already lists the five commands bare, so it
  matches again the moment the prefix is gone. No edit, and explicitly no `env -u` note.
- No new `env -u` anywhere — not in a script, not in a vitest `setupFiles` hook, not in a
  wrapper. The point is removing the workaround, not relocating it.
- `.github/workflows/ci.yml` — the CI side is already correct.
- `.ai/cezar/gates/baseline.sh` — strips a wider set for reasons documented in its own
  header; out of scope.
- The assertions of both test files (15 and 70 cases). This fixes fixture isolation, not
  what is being tested. No new test file.

## Implementation Plan

### Phase 1: Reproduce the leak (red)

The two cases are already-existing tests that fail under a leaked environment, so the red
step is reproducing the leak deliberately rather than writing a new spec. This run's own
environment exports `CLAUDE_CONFIG_DIR` but **not** `GIT_CONFIG_*`, so the git half must be
exported explicitly for the repro to prove anything.

- 1.1 Run `config-api.test.ts` with `CLAUDE_CONFIG_DIR` exported; confirm the four named
  failures.
- 1.2 Run `git-changes.test.ts` with `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` /
  `GIT_CONFIG_VALUE_*` exported; confirm the two named failures.

### Phase 2: Seal the two fixtures (green)

- 2.1 `config-api.test.ts`: save `CLAUDE_CONFIG_DIR` alongside the other four, point it
  inside `homeRoot` in `beforeEach`, restore it in `afterEach`. Re-run: 15 passed with the
  host value still exported.
- 2.2 `git-changes.test.ts`: carry the fixture identity as `-c` flags on the fixture's git
  helper so it outranks `GIT_CONFIG_*`. Re-run: 70 passed with the host values still
  exported.

### Phase 3: Remove the workaround from the gate

- 3.1 Drop the `env -u …` prefix from both `validation.commands` entries in
  `.ai/agentic.config.json`; verify `grep -n "env -u"` prints nothing and that the five
  commands match `SDLC.md:99-103` in the same order.

### Phase 4: Full validation gate

- 4.1 Run the project baseline gate and `npm run typecheck`; confirm the suite is green and
  has not lost tests against the `main` @ `0678ea8a` baseline.

## Risks

- **Removing the repo-local `git config` identity outright could break the fixture repos'
  API-driven commits.** `POST git/commit` (`git-changes.test.ts:822`) commits through the
  *code under test*, which the fixture cannot inject `-c` flags into; it takes its identity
  from the repo-local config. On a runner with no global identity (GitHub Actions'
  `actions/checkout` sets `http.extraheader`, not `user.name`/`user.email`) such a commit
  would fail. Mitigation: keep the repo-local config for the code-under-test's commits and
  add `-c` for the fixture's own commits, then verify the claim by measurement rather than
  argument — run the file with the global and system config files neutralized.
  **Measured, and the risk was real:** with the two repo-local `config` lines removed,
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null TMPDIR=/tmp npx vitest run
  packages/cezar/src/server/git-changes.test.ts` fails exactly one case —
  `POST git/commit commits everything; a clean tree is a 409, a bad body a 400` (1 failed |
  69 passed). The lines therefore stay, and the reasoning is recorded on `initRepo` so the
  next reader does not "tidy" them away. With them kept, the same command is 70 passed.
- **Low blast radius otherwise.** Both edits are confined to test fixtures; the config edit
  only removes a prefix, restoring parity with CI.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce the leak (red)

- [x] 1.1 Reproduce the four `config-api.test.ts` failures under an exported `CLAUDE_CONFIG_DIR` — 1b1319d7
- [x] 1.2 Reproduce the two `git-changes.test.ts` failures under exported `GIT_CONFIG_*` — 1b1319d7

### Phase 2: Seal the two fixtures (green)

- [x] 2.1 Repoint and restore `CLAUDE_CONFIG_DIR` in the `config-api.test.ts` fixture — 1b1319d7
- [x] 2.2 Carry the `git-changes.test.ts` fixture identity as `-c` flags — 1b1319d7

### Phase 3: Remove the workaround from the gate

- [x] 3.1 Drop the `env -u …` prefix from both `validation.commands` entries — 79016d91

### Phase 4: Full validation gate

- [x] 4.1 Run the baseline gate and `npm run typecheck`, and record the acceptance evidence — 79016d91 (evidence below)

### Phase 5: Review follow-up (om-auto-review-pr on PR #38)

- [x] 5.1 Extend `GIT_ID` with `commit.gpgsign=false` — repo-local config loses to `GIT_CONFIG_*`
      for every key, not just the identity pair, so the same leak axis was still open

## Acceptance evidence

All five `validation.commands` were run in order in the PR's isolated worktree:

| Command | Result |
|---|---|
| `npm run typecheck` | `tsc --noEmit`, exit 0 |
| `npm test` | 335 test files, 6595 tests passed (~70 s) |
| `npm run test:unit` | 36 tests, 0 failures |
| `npm run build` | `check:pack ok — 487 files, 85 under web/dist` |
| `npm run test:package` | 15 tests, 0 failures |

335 files / 6595 tests matches the `main` @ `0678ea8a` baseline exactly, so the branch
lost no tests.

The gate above ran through `.ai/cezar/gates/baseline.sh`, which strips the leaking variables —
so on its own it proves no regression, not that the fixtures are sealed. The sealing was measured
separately, with the host environment deliberately exported (`CLAUDE_CONFIG_DIR=/srv/claude-home`
plus `GIT_CONFIG_COUNT=2` carrying `user.email`/`user.name`; `TMPDIR=/tmp` pins the unrelated
pre-existing tmp axis that the removed prefix never covered either):

```
TMPDIR=/tmp npx vitest run packages/cezar/src/server/config-api.test.ts    → 15 passed (15)
TMPDIR=/tmp npx vitest run packages/cezar/src/server/git-changes.test.ts   → 70 passed (70)
TMPDIR=/tmp npm test                                                       → 335 files / 6595 tests passed
TMPDIR=/tmp npm run test:unit                                              → 36 pass, 0 fail
```

The bare-`npm test` line is the one that licenses removing the `env -u` prefix: it shows no other
test file in the suite depended on it.

Negative control — the `origin/main` versions of both files under the identical leaked environment
fail with exactly the six cases issue #17 named, and no others (`6 failed | 79 passed (85)`), so
the fix is not a no-op.

Remaining known gap (filed as a follow-up, not fixed here): the sealing has no regression guard,
because a guard written inside these fixtures runs *after* `beforeEach` has applied the seal and
therefore passes on a clean host whether or not the seal exists. The only honest guard is
environmental — a CI leg that runs the suite with the variables deliberately exported — and
`.github/workflows/ci.yml` is out of scope for this issue.
