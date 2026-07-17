# Checkpoint 1 — steps 1.1..2.3

- **Steps covered:** 1.1 (e925166) .. 2.3 (aaa5648) — #442 merge, task-refs, RunRecord fields, number-first titles, namer core, runner call + mock, startRun wiring.
- **Touched areas:** `src/runs/` (new task-refs, auto-name; store schema), `src/workflows/run.ts` + `system-prompt.test.ts`, `src/server/server.ts` (PATCH) + `patch-run.test.ts`, `src/config.ts`, `scripts/mock-claude.mjs`, `web/app/src/api/types.ts` (type mirror only).

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | pass |
| vitest: `src/runs` + `system-prompt` + `patch-run` + `api-types` + `config` | pass — 119 tests |

UI verification: skipped — no UI surface touched in this window (the type-mirror edit in `web/app/src/api/types.ts` has no rendered behavior; the Settings toggle lands in step 3.3 and will be covered then and at the final gate).
