# NOTIFY — worktree retention (#483, PR #486)

## 2026-07-18T05:00:16Z — om-auto-continue-pr-loop resume
- Resumed by: @pkarw
- Resume point: spec-implementation bootstrap (PR #486 was docs-only spec; no prior run folder — created one here)
- PR head SHA: b7a7e9c
- Classification: Spec-implementation run (linked spec, multi-phase, UI+API+tests)
- Note: user asked to also fix failing CI + run UI verification + add integration tests.
- CI diagnosis: failing test was flaky #413 follow-up-template test (`github.test.tsx`), passes locally, races in CI on menu reopen. Fixed with a `chooseTemplate` helper that waits for the specific option.
