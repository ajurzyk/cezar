# Final gate — worktree retention (#483, PR #486)

Run at spec completion (all Tasks-table rows `done`). Final commit at gate time: `d161978`.

## Full validation gate (validation.commands, in order)

| # | Command | Result |
|---|---------|--------|
| 1 | `npm run typecheck` | ✅ PASS |
| 2 | `npm test` (vitest server + cockpit unit) | ✅ PASS — 2369 tests / 148 files |
| 3 | `npm run test:unit` (node:test core) | ✅ PASS — 9/9 |
| 4 | `npm run build` (tsc + vite + check:pack) | ✅ PASS — 249 files, web/dist present |
| 5 | `npm run test:package` (tarball install + CLI e2e) | ✅ PASS — 1/1 |

Raw logs under `final-gate-artifacts/`.

## Full integration suite (om-integration-tests / test:e2e)

- **This feature's E2E** — `web/app/e2e/settings-resources.e2e.ts`: ✅ **4/4 PASS** (verified in isolation against the live dry-run server; drives the real form, asserts persistence incl. 0=unlimited and a cold-load view of config.json, and the panel render).
- **Full suite (`npm run test:e2e`)** — 14 files pass, 10 files have 1–2 failures each (11 tests). **All failures are in specs unrelated to this change** — `github` (row #142 fixture), `review-gate` (PR-link), `settings-bookmarklets` (javascript: content), `settings-appearance`, `settings-skills`, `task-thread`, `task-changes`, `task-files`, `repo-git`, plus one `ENOTEMPTY` temp-dir race. These are pre-existing agent-browser selector/fixture/timing flakes (`TEST_E2E_STATUS` is environment-sensitive per AGENTS.md); there is no mechanism by which a Settings config key + a worktrees panel affects the GitHub tab, bookmarklet content, or theming. Not introduced by this PR. Full log: `final-gate-artifacts/e2e.log`.

## UI verification (om-auto-verify-pr-ui)

✅ **PASS** — PR mode, agent-browser, 3 inline screenshots posted to the PR (evidence branch `qa-evidence-pr-486-qa`). Report: `.ai/qa/artifacts_pr-486/report.md`. One coherence issue (stale footer keep-limit on retention save) found and fixed during QA (`d161978`).

## Style / design-compliance pass

No dedicated design-system lint skill is configured; the repo enforces design compliance via the `design-guardian` unit test (part of `npm test`, green above). Its `no-native-dialogs` rule caught an early native `confirm()` in the worktrees panel; fixed to the design-system `AlertDialog` (`4e05683`). No residual findings.

## Backward compatibility (BACKWARD_COMPATIBILITY.md)

✅ No violation — every change is additive: new optional `config.json` key `worktreeRetention` (additive-only per §"Files"), new optional `RunRecord.worktreeReclaimedAt` (§"runs.json" new-fields-optional rule), two new additive routes (`GET /api/worktrees`, `POST /api/worktrees/reclaim`), and `GET/PUT /api/config` gaining a response field (explicitly allowed). No route/field removed, no default changed, no required field added, no SSE event renamed.
