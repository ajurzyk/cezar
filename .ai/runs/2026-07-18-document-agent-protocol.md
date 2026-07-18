# Execution plan — Document the cezar AGENT protocol

**Slug:** `document-agent-protocol`
**Date:** 2026-07-18
**Branch:** `cez/58156848` (cezar-managed task worktree; kept as-is rather than a fresh `feat/` branch so the cezar session tracking stays intact)
**Base:** `main`

## Overview

### Goal

Write a single canonical document for the **agent protocol** cezar uses to run and
observe coding-agent backends — the runner seam (`AgentRunner`/`AgentSession`),
the v1 `AgentEvent` stream, the normalized v2 `UiEvent` protocol, the golden
NDJSON-fixture testing contract, and the backend-parity requirement — so a
newly added runner (e.g. `pi`, PR #387) can implement the same contract without
reverse-engineering three existing runners. Link it from `AGENTS.md` and record
the protocol as a protected surface in `BACKWARD_COMPATIBILITY.md`.

### Source material

- `src/core/agent-runner.ts` — the runner/session seam and v1 `AgentEvent` union.
- `src/core/ui-events.ts` — the v2 `UiEvent` vocabulary (heavily documented, per-backend mapping notes inline).
- `src/core/ui-parity.test.ts` — the executable backend-parity matrix.
- `src/core/*-ui-mapper.test.ts` + `src/core/__fixtures__/<backend>/*.ndjson|*.expected.json` — the golden-fixture contract.
- `src/core/tool-display.ts`, `src/core/ndjson.ts`, `src/core/runner-factory.ts`, `src/core/backend-detect.ts`.
- `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` (§7 schema, §7.1 mapping) and the spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — the authoritative contract sources the code cites.
- **PR #443** (`fix/issue-433-render-plan-todo`, open) — hardens the `plan.updated` channel across all three backends (Claude `TaskCreate/TaskUpdate/TaskList` as plan tools; Codex `turn/plan/updated`; OpenCode `cancelled` status), verified against upstream schemas. Documented as the current direction of the plan channel and attributed to the PR.
- **PR #387** — adds the `pi` runner; the consumer this doc is written for.

### Non-goals

- No code changes to runners, mappers, or the protocol types. Docs only.
- Not rewriting the analysis doc / spec — the new doc links to them as the deep contract sources and is the concise operational contract.
- Not implementing the `pi` runner (#387) or merging #443.

### Risks

- The new doc must match the code **on `main`** (where #443 is not yet merged). The plan-status vocabulary is documented as the current 3 values with #443's in-flight extension attributed as such, so the doc does not assert un-merged shapes as current truth.

## Implementation Plan

### Phase 1 — Author the canonical protocol doc

- Create `AGENT_PROTOCOL.md` at the repo root (matching the existing root-level uppercase doc convention: `AGENTS.md`, `BACKWARD_COMPATIBILITY.md`, `CODE_REVIEW.md`, `SDLC.md`).
- Cover: the runner seam; the v1 `AgentEvent` stream; the v2 `UiEvent` protocol and its design rules; per-backend mapping summary; the golden NDJSON-fixture + parity-matrix testing contract; and a concrete "adding a new runner" checklist keyed to #387.

### Phase 2 — Wire it into AGENTS.md and BACKWARD_COMPATIBILITY.md

- `AGENTS.md`: reference `AGENT_PROTOCOL.md` from the "Agent runners / backends" task-routing row and add it to "Related documents".
- `BACKWARD_COMPATIBILITY.md`: add a protected-surface section for the agent event protocol (v1 `AgentEvent` types, v2 `UiEvent` dotted types + SSE names, NDJSON persistence, the parity requirement) and cross-link `AGENT_PROTOCOL.md`.

### Phase 3 — Validate, self-review, PR

- Docs-only gate: re-read the full diff; run `npm run typecheck` as a cheap safety net (confirms no stray references / it is unaffected).
- `om-code-review` self-review + breaking-change check.
- Open PR against `main`, normalize labels, run `om-auto-review-pr`, post summary comment.

## Progress

PR: #491

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Author the canonical protocol doc

- [x] 1.1 Draft `AGENT_PROTOCOL.md` (seam, v1, v2, per-backend mapping, testing contract, new-runner checklist) — 055255e

### Phase 2: Wire into AGENTS.md and BACKWARD_COMPATIBILITY.md

- [x] 2.1 Link `AGENT_PROTOCOL.md` from AGENTS.md (routing row + Related documents) — fd0b7ee
- [x] 2.2 Add the agent-protocol protected-surface section to BACKWARD_COMPATIBILITY.md — b910faa

### Phase 3: Validate, self-review, PR

- [x] 3.1 Docs-only validation + self-review (diff re-read; referenced paths + technical claims verified against code) — 02f90a7
- [ ] 3.2 Open PR, normalize labels, run `om-auto-review-pr`, post summary comment
