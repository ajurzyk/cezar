# Notify — 2026-07-21-queued-session-prompt-stacking

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-07-21T11:40:00Z — run started
- Brief: Implement the spec at `.ai/specs/2026-07-21-queued-session-prompt-stacking.md` (FR #472 — stack, edit and remove prompt messages on a queued run).
- External skill URLs: none
- Mode: Spec-implementation run (spec-driven, 11 Steps, new HTTP routes + new record field → heuristic rule 1).
- Engine chosen by `om-auto-implement-spec`: `om-auto-create-pr-loop` (11 Steps > the 8–10 threshold, UI work needing screenshots, no pre-existing spec PR — #537 is merged).
- Worktree: reused the existing linked cez worktree rather than nesting a new one.

## 2026-07-21T11:41:00Z — checkpoint 1 (after Step 1.5)
- Steps 1.1–1.5 landed, one commit each (`163e6ff`, `415d486`, `98d1858`, `dd83a3b`, `b7d8b55`).
- Gate: `npm run typecheck` clean; `npm test` **3010 passed / 175 files**, 0 failed. No regressions.
- UI checks skipped — correctly, nothing user-facing has landed yet (Phase 1 is engine + API). Screenshots deferred to the Phase 2 checkpoint.
- DECISION: stacked attachments ride a new `StartRunInput.stackedImages` field instead of `input.images`. `execute()` persists `input.images` into `taskImages`, so folding already-persisted files there would duplicate them on disk and make the task bubble claim the stack's images. Same delivery, no side effects.
- DECISION: `deferMessage` gates on a new `ActiveRun.sessionEverOpened` flag, not the `starting` set alone. `execute()` drops the run from `starting` seconds before the backend spawns, so gating on it would have reopened the exact dropped-message window rung 3 exists to close. `state.session` cannot substitute — teardown resets it to `undefined`, making a closed session indistinguishable from one that never opened.
- No subagents dispatched: the Phase 1 steps are tightly coupled (schema → mutators → hydration → routes) and the dispatcher pattern would have had each executor re-derive the same context.
