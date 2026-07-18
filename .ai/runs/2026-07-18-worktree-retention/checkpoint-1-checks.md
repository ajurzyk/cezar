# Checkpoint 1 — Phase 1 (retention engine) complete

Covers Steps **0.1 → 1.6** (CI fix + full Phase 1). Commit range `8e71da3..da9186f`.

## Steps in this window

| Step | Title | Commit |
|------|-------|--------|
| 0.1 | Fix flaky follow-up-template CI test (#413) | 8e71da3 |
| 1.1 | `worktreeRetention` config key + server wiring | ebe9543 |
| 1.2 | `worktreeReclaimedAt` on RunRecord | bb729cd |
| 1.3 | pure `selectReclaimableWorktrees` | 0bc6ab3 |
| 1.4 | `reclaimWorktrees` enforcer (real-git tested) | 6a535f2 |
| 1.5 | startup + terminal-transition wiring | bca6926 |
| 1.5a | re-materialize + un-stamp on resume | 24ada5b |
| 1.6 | Settings → Resources "Keep last N" input | da9186f |

## Areas touched

- Server: `src/config.ts`, `src/server/server.ts` (config API), `src/index.ts` (startup sweep).
- Runs: `src/runs/store.ts`, new `src/runs/retention.ts` (selector + enforcer + re-materializer).
- Runner: `src/workflows/run.ts` (dropActive hook + resume re-materialization).
- UI: `web/app/src/routes/settings/resources-section.tsx`, `web/app/src/api/types.ts`.
- CI fix (unrelated feature): `web/app/src/routes/github/github.test.tsx`.

## Checks run

| Check | Result |
|-------|--------|
| `npm run typecheck` (server + web) | ✅ pass |
| `npm test` (full unit suite) | ✅ 2356 tests / 146 files pass |
| `npm run build` (tsc + vite + check:pack) | ✅ pass (249 files, web/dist present) |

New tests added this window: config (`config.test.ts`, `config-api.test.ts`),
store (`store.test.ts`), `retention.test.ts` (7), `retention-enforce.test.ts` (4),
`retention-rematerialize.test.ts` (3), `retention-wiring.test.ts` (1, DRY_RUN
integration), `resources-section.test.tsx` (4). The previously RED CI test
(`github.test.tsx` #413) is green in this run.

## UI verification

Deferred to spec completion per the run's explicit instruction to run
`om-auto-verify-pr-ui` and add integration/E2E tests as a final pass (Phase 3 +
final gate). No screenshots captured at this checkpoint; the Settings → Resources
field is covered by the component test above.
