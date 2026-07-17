# Handoff — task auto-naming (PR #479)

**Run folder:** `.ai/runs/2026-07-17-task-auto-naming/`
**Branch:** `feat/task-auto-naming-spec` (base `main`) — PR #479
**Plan:** `PLAN.md` — the `## Tasks` table is the authoritative status source.

## State

Phases 1–2 done (checkpoint-1 green): heuristic layer (task-refs + number-first titles,
#442 vendored), namer core + one-shot runner call + `[cez-namer]` mock, fire-and-forget
apply on `startRun` with user-rename precedence (`titleOrigin`).

## The one thing to know

The namer shadows `CEZ_MOCK_ARGS_FILE` (empty env) on its runner call so dry-run tests
capturing the AGENT's argv never see the namer's bookkeeping call interleaved.

## Next concrete action

Step 3.1 — `liveTitleUpdates` resolution helper (config wins over `CEZ_TITLE_UPDATES` env
wins over built-in ON) with unit tests.

## Blockers

None.
