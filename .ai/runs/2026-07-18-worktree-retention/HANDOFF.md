# HANDOFF — worktree retention (#483, PR #486)

**Status:** in-progress — Phase 1 complete, Phase 2 next
**Branch:** cez/208500a8 (pushed via `git push origin HEAD:cez/208500a8` from a detached temp worktree)
**Worktree:** `.ai/tmp/om-auto-continue-pr-loop/pr-486-<ts>` (temp; the branch is checked out in the original cez run worktree, so this run commits detached and pushes explicitly)

## Done so far

- Step 0.1 — flaky #413 follow-up-template CI test fixed (`chooseTemplate` helper).
- Phase 1 (Steps 1.1–1.6) — retention engine complete: config key, `worktreeReclaimedAt`,
  pure selector, enforcer, startup + terminal-transition wiring, resume re-materialization,
  Settings → Resources "Keep last N worktrees" input. All unit-tested.
- Checkpoint 1 green: typecheck + full unit suite (2356) + build all pass.

## Next concrete action

Start **Phase 2, Step 2.1** — `GET /api/worktrees` in `src/server/server.ts`
(list materialized worktrees + `du -sk` sizes degrading to null + `reclaimable`
flag + `totalBytes`). Then 2.2 (`POST /api/worktrees/reclaim`), 2.3 (the
Worktrees management table UI), 2.4 (docs). Then Phase 3 (E2E) + the final gate:
run `om-auto-verify-pr-ui`, add integration tests, full validation gate, style pass.

## Key implementation facts

- Reclaim = `removeWorktree(repoRoot, path)` with NO branch arg (dir only, branch kept).
- Finished set = `['done','failed','cancelled']`; `review`/live excluded from the budget.
- `worktreeRetention` 0 = unlimited; default 10; `.catch(10)`.
- Enforcer hook is a single call in `RunManager.dropActive` (fire-and-forget).
- Resume re-materialization: `rematerializeReclaimedWorktree` in `src/runs/retention.ts`,
  called at the top of `runContinuation`.
- The stamp (`worktreeReclaimedAt`), not the directory, is the definitive "reclaim
  complete" signal (the dir disappears one git call earlier) — matters for tests.

## Caveats

- Branch is checked out in another cez-managed worktree, so this run commits detached.
- CI on the pushed branch runs the full gate; only pushed HEAD needs to be green.
