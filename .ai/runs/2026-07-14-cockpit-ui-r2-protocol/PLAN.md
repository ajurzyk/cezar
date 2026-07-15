# Run: Cockpit UI redesign — Phase R2 (Protocol v2)

- Date: 2026-07-14
- Branch: `feat/cockpit-ui-r2-protocol` (stacked on `feat/cockpit-ui-r1-platform-shell`, PR #396; GitHub retargets to main when #396 merges)
- Source spec: `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — §"Normalized agent-event protocol v2", §"Backend parity requirement", Implementation Plan steps 5–7
- Mode: Spec-implementation run

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill `Commit` (executors leave `pending`; the dispatcher backfills real SHAs at checkpoints). The first non-`done` row is the resume point for `om-auto-continue-pr-loop`.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | UiEvent/UiItem v2 types + tool display model (shared protocol module) | done | 4aaaa82 |
| 1 | 1.2 | Claude runner v2 emitter + golden fixtures (thinking, TodoWrite→plan, parentItemId) | done | 3653ab2 |
| 1 | 1.3 | Codex runner v2 emitter + golden fixtures (items, statuses, outputDelta, todoList→plan) | done | 6c924cc |
| 1 | 1.4 | OpenCode runner v2 emitter + golden fixtures (parts, session.idle turn-end, todowrite→plan) | done | cbaf869 |
| 2 | 2.1 | RunManager persists v2 (delta coalescing + item snapshots) and fans out over SSE | done | 28a75b3 |
| 2 | 2.2 | titleSummary + diffStat on turn-end; PATCH /api/runs/:id title | done | 9e89489 |
| 2 | 2.3 | systemPrompt end-to-end (config default + POST /api/runs override + all three runners) | done | f9c5bd9 |
| 2 | 2.4 | Web: v2 event types + display model; wire titleSummary/± into quick-list and table | done | 7de1ad2 |

## Goal

Land the normalized agent-event protocol v2 (ACP-aligned; the spec's §protocol is the contract) emitted by all three runners with golden-fixture parity tests, persisted by the RunManager with the spec's performance guardrails (coalesce `item.delta` ~30–50ms; persist item snapshots, not raw deltas), plus the run-metadata upgrades R1 left honest slots for: `titleSummary`, `diffStat`, editable titles, and system-prompt support.

## Scope

- `src/core/` — `ui-events.ts` (v2 types + display model), the three runner files (additive v2 emission alongside v1), `__fixtures__/` golden transcripts per backend.
- `src/workflows/run.ts` (RunManager), `src/runs/store.ts` (additive `titleSummary?`, `diffStat?`, `systemPrompt?`), `src/server/server.ts` (`PATCH /api/runs/:id`, `systemPrompt` on POST), `src/config.ts` (systemPrompt default).
- `web/app/src/protocol/` (v2 types + display model mirror), quick-list/table title + ± wiring.

## Non-goals

- NO thread UI (R3 renders the v2 events; this phase only produces/persists them).
- NO permission interactivity (v2 reserves `permission.*`; runners stay auto-approve).
- v1 events keep flowing unchanged — mixed NDJSON files are valid; the legacy UI must keep working.

## Backend parity rule (hard, from the spec)

Every capability maps from ALL THREE backends (claude, codex, opencode) — plan.updated, tool lifecycle statuses, reasoning, structured diffs, sub-agent nesting, usage. Acceptance per step: the golden-fixture suite passes for all backends covered so far. Where a backend lacks a signal (claude: no live command output), the mapping degrades per-capability, never per-backend.

## Risks

- Runner changes touch the live execution path — v2 emission must be additive and side-effect-free for v1 consumers (legacy UI renders unknown NDJSON types as dim notes — verified behavior).
- Fixture fidelity: fixtures must be REAL recorded transcripts (or faithfully hand-derived from the documented wire formats in `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md`), never invented shapes.
- NDJSON write amplification: guarded by snapshot-persistence (spec §performance guardrails).

## Deferred

- README screenshots → R7 step 22. Thread rendering of v2 → R3.
