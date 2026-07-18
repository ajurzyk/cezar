# Execution plan: monitoring run activity (FR #490)

Date: 2026-07-18
Slug: subagent-monitoring-status
Branch: cez/467bfd0a
Source doc: .ai/specs/2026-07-18-subagent-monitoring-status.md

> The Progress phases below mirror the spec's Implementation Plan (Phases → Steps).

## Overview

### Goal

Stop the cockpit from raising "Needs attention" / "The agent is paused, waiting for
your reply" when the agent ended its turn still working on its own downstream work
(a sub-agent or a monitored command), not on the user. The agent declares that state
with a new `CEZ:MONITORING` turn-end marker (sibling of `CEZ:DONE`); cezar maps it to
`status: running` + a new optional `activity: 'monitoring'` sub-state, which the UI
shows as a non-attention "monitoring" label.

### Scope

- `src/handoff.ts` — one agent-contract line introducing `CEZ:MONITORING`.
- `src/workflows/run.ts` — marker regex + strip helper; turn-end branch at both sites;
  `activity` clears on resume/terminal.
- `src/runs/store.ts` + `web/app/src/api/types.ts` — optional `activity?: 'monitoring'`
  field.
- `web/app/src/lib/attention.ts` — widen `AttentionInput`, add the monitoring branch.
- Tests across server + web; transcript marker-stripping; agent-contract docs.

### Non-goals

- No new `RunStatus` enum value (activity is a sub-state of `running`).
- No inference from tool events (rejected — see spec "Why detection cannot be inferred").
- No escalation timer to "needs you" (FR Q3); the existing 15-min idle timer is kept
  unchanged for liveness/slot reclaim.
- No new `CEZ_*` env var; `.env.example` untouched.

## Risks

- Marker reliance has the same reliability profile as `CEZ:DONE` (model-followed) with
  graceful fallback to `waiting` — no regression when absent.
- `activity` must be clearable via `updateRun` (writing `undefined`); verify the store's
  merge semantics during Step 3.
- Widening `AttentionInput` touches every call site that builds it — must pass `activity`.

## Progress

PR: (pending)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Agent contract + server detection

- [ ] 1.1 Add `MONITORING_MARKER_RE` + `stripMonitoringMarker` in `run.ts` (mirror DONE) + tests
- [ ] 1.2 Add the `CEZ:MONITORING` rule to `HANDOFF_ONLY_INSTRUCTIONS` (`handoff.ts`) + system-prompt test
- [ ] 1.3 Add `RunActivity`/`activity?` to `store.ts` (+ zod) and mirror in web `api/types.ts` + schema test
- [ ] 1.4 Turn-end branch at both sites (runAgentStep, runContinuation); keep waiting-parity lifecycle; clear `activity` on resume/terminal + tests

### Phase 2: UI surfacing

- [ ] 2.1 Widen `AttentionInput` to include `activity`; add `deriveAttention` monitoring branch + `attention.test.ts`
- [ ] 2.2 Surface/suppression tests: run-header pill, task-thread no paused-hint, notifications no-notify, stays in Working

### Phase 3: Polish & docs

- [ ] 3.1 Strip `CEZ:MONITORING` from displayed transcript + heartbeat wording; document the marker beside `CEZ:DONE` (AGENTS.md / AGENT_PROTOCOL.md) + test
