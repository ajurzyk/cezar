# Generate follow-ups per task

## Overview

Add a per-task **Generate follow-ups** choice to the New Task composer, defaulting on and remembered like the existing worktree/autonomous choices. When disabled, the run keeps its handoff journal and completion marker but agents receive neither `CEZ_TODOS_FILE` nor instructions for appending inbox entries.

## Goal

Let users prevent follow-up inbox clutter for individual tasks without changing the zero-config default or breaking old API clients and persisted runs.

## Scope

- Add an optional run/API field whose omitted value means follow-ups are enabled.
- Persist the choice on `RunRecord` so Continue/recovery sessions retain the original contract.
- Separate handoff instructions from follow-up inbox instructions and conditionally expose the latter in runner prompts and environment.
- Add a default-on composer checkbox, draft persistence, last-used UI-state persistence, planned-run propagation, type mirrors, and regression tests.

## Non-goals

- No global config setting or required migration.
- No changes to inbox storage, rendering, or existing entries.
- No change to handoff journal seeding, progress logging, resume notes, or `CEZ:DONE` behavior.
- No change to bookmarklet/inbox-start defaults; omitted fields continue to enable follow-ups.

## Implementation Plan

### Phase 1: Run contract and agent boundary

1. Split the handoff and follow-up prompt contracts, add the optional persisted run flag, and make initial/continued agent prompts and environments conditional.
2. Accept and forward the optional API field with omitted-as-enabled semantics, then add server, store, and dry-run runner regression coverage.

### Phase 2: New Task UI and browser contract

1. Add the default-on Generate follow-ups toggle, draft/UI-state persistence, create/planned-run payload propagation, and browser/server type mirrors.
2. Add pure form, draft, plan, and component tests for default-on, remembered, and explicitly-off behavior.

### Phase 3: Verification and review

1. Run the full configured validation gate, apply code-review and backward-compatibility checks, and remove any scope drift.

## Risks

- A continuation could accidentally regain inbox access unless the optional flag is persisted and interpreted as enabled unless literally `false`.
- Splitting the shared prompt must not remove the handoff journal or completion-marker instructions.
- UI omission rules must send only `false`; old callers and old state records must continue to behave as enabled.

## Progress

PR: #444

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Run contract and agent boundary

- [x] 1.1 Split the handoff and follow-up prompt contracts, add the optional persisted run flag, and make initial/continued agent prompts and environments conditional. — 38d2f74
- [x] 1.2 Accept and forward the optional API field with omitted-as-enabled semantics, then add server, store, and dry-run runner regression coverage. — 38d2f74

### Phase 2: New Task UI and browser contract

- [x] 2.1 Add the default-on Generate follow-ups toggle, draft/UI-state persistence, create/planned-run payload propagation, and browser/server type mirrors. — 1646b5c
- [x] 2.2 Add pure form, draft, plan, and component tests for default-on, remembered, and explicitly-off behavior. — 1646b5c

### Phase 3: Verification and review

- [x] 3.1 Run the full configured validation gate, apply code-review and backward-compatibility checks, and remove any scope drift. — 98db454
