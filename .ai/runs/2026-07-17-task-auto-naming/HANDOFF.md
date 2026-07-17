# Handoff — task auto-naming (PR #479)

**Run folder:** `.ai/runs/2026-07-17-task-auto-naming/`
**Branch:** `feat/task-auto-naming-spec` (base `main`) — PR #479
**Plan:** `PLAN.md` — the `## Tasks` table is the authoritative status source.

## State

Run promoted from a docs-only spec PR to a spec-implementation run. Spec is final (incl. the
owner's live-title-updates change request). No implementation Steps landed yet.

## The one thing to know

The namer mirrors `src/planner.ts` (spec 008) exactly: one-shot `createRunner(...).run()`,
`[cez-namer]` marker for the dry-run mock, strict JSON via `parseStructured` + zod, never
blocks, degrades to the heuristic title. PR #442's branch is merged in as the heuristic base.

## Next concrete action

Step 1.1 — merge `origin/fix/issue-432-include-skill-context-in-task-naming` (PR #442).

## Blockers

None.
