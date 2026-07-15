# Final gate — R4 (New task + list)

Covers Steps 1.1–1.5 (`cf01558`..`d6e6bbb`). Run by `om-auto-continue-pr-loop` resume on 2026-07-15.

## Context

The previous session implemented Step 1.4 fully but crashed before committing. This resume
verified and landed that work as `2e82aa4`, then the gate's first full e2e run exposed a real
product bug (Step 1.5, `d6e6bbb`): SSE streams leaked sockets into the back/forward cache on
full navigations, wedging the next page load once Chrome's per-origin pool (6) was exhausted.
Reproduced deterministically outside the suite (connections plateau at 7; `/new?legacy=1` open
times out), fixed with pagehide/pageshow lifecycle in both React hooks and the legacy app,
re-verified (connections hover at 3–5; the same open completes in 0.38s).

## Checks

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | PASS |
| `npm run build` (server + web bundle) | PASS |
| `npm test` (full unit suite, vitest server+web) | PASS — 1475/1475 (first run had 1 flake, not reproduced across two consecutive full reruns) |
| `npm run test:e2e` (full integration suite, agent-browser, real Chrome, dry-run servers) | PASS — 103/103 across 12 files |
| Socket-leak repro loop (16 navigations, `ss` on :4321) | PASS — no pool exhaustion after fix |

## UI verification

Full e2e suite covers all R4 surfaces: `/new` hero composer + pickers + drafts, plan-mode
overlay, bookmarklet auto-start matrix (new-task.e2e.ts), table inline rename (quick-list.e2e.ts,
screenshot `tasks-table-row-edit.png`), legacy escape hatch. Artifacts in `.ai/qa/artifacts_e2e/`.

## Style compliance

Design-guardian test (no raw hex outside `styles/index.css`) runs inside `npm test` — green.
The full-branch style pass happens at spec completion (R7 gate), per plan.
