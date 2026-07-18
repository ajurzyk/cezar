# HANDOFF — worktree retention (#483, PR #486)

**Status:** in-progress
**Branch:** cez/208500a8 (pushed via `HEAD:cez/208500a8` from a detached temp worktree)
**Worktree:** `.ai/tmp/om-auto-continue-pr-loop/pr-486-<ts>` (temp; branch is checked out in the original cez run worktree, so this run pushes detached)

## Current step

Resume at the first `todo` row in `PLAN.md`'s Tasks table.

## Last commit

CI fix pending commit: robust `chooseTemplate` helper in
`web/app/src/routes/github/github.test.tsx` (fixes the flaky #413 follow-up
template test that was reddening PR #486's CI).

## Next concrete action

Land Step 1.1 — add `worktreeRetention` to `configSchema` and thread it through
`configAnswer` / `setConfigSchema` / the PUT merge block in `src/server/server.ts`.

## Caveats

- The PR branch is checked out in another (cez-managed) worktree, so this run
  commits on a detached HEAD and pushes with `git push origin HEAD:cez/208500a8`.
- Resume/continue path (`run.ts` `continueRun`/`recover`) does NOT call
  `createWorktree` today — Step 1.5a must add re-materialization when the dir is
  missing, else a resumed reclaimed run has no cwd.
