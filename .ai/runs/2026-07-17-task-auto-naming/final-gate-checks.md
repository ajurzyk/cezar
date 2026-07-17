# Final gate — task auto-naming (PR #479)

## Full validation gate (all green, at the post-merge head)

| Command | Result |
|---|---|
| `npm run typecheck` (server + web) | pass |
| `npm test` (vitest) | pass — 128 files / 2121 tests |
| `npm run test:unit` | pass — 4 |
| `npm run build` + `check:pack` | pass — 240 files packed |
| `npm run test:package` | pass |

## Integration suite (`npm run test:e2e`) — failed, MATCHES the main baseline (recorded, not blocking)

- Branch (solo run, no competing env): 15 files / 17 tests failed — every failure is a
  connection/driver error (`ECONNRESET`, `fetch failed`, agent-browser click/wait timeouts).
  **No naming/title assertion failed in any run.**
- **Baseline on `origin/main` (same machine, same conditions): 14 files / 14 tests failed**,
  heavily-overlapping set, same error classes — the suite is unstable in this environment
  independent of this branch (already documented by PR #418's QA as pre-existing).
- Logs: `final-gate-artifacts/e2e-branch.log.gz`, `final-gate-artifacts/e2e-main-baseline.log.gz`.
- A real e2e finding WAS caught and fixed earlier: the mock namer's canned title replaced
  heuristic titles under `CEZ_DRY_RUN` — fixed in `d408880` (naming now off in dry-run unless
  `CEZ_AUTONAME=1`); post-fix runs contain zero title-related failures.

## UI verification

`om-auto-verify-pr-ui` PASS 5/5 in a real Chrome at head `d408880` (evidence + 7 screenshots:
PR comment 5001930252): Settings toggle round-trip incl. exact PUT body and persistence,
number-first `437:` title + persisted `prNumber`, plain-prompt fallback, rename stickiness
via `titleOrigin: user`, mobile smoke.

## Style-compliance pass

Skipped — the repo has no design-system/style lint skill or configured command.

## Backward compatibility

Additive throughout: optional `RunRecord` fields (BC §3 rule), nullable `liveTitleUpdates`
config key, PATCH gains `titleOrigin`. One deliberate behavioral change (turn-text titles
retired, `feat!` commit b4359fd) — spec-backed owner direction, surfaced in the PR summary.
