# Checkpoint 1 — R2 Steps 1.1..1.4 (Phase 1: the three emitters)

- Commits: `4aaaa82`..`cbaf869`
- Gate: `npm run typecheck` PASS · `npm test` **800/800** (38 files, run twice — no order-dependence) · `npm run build` PASS. E2E deliberately not run this window: zero UI surface changed (server-side protocol only); the web app is untouched since R1's final 41/41.

## What landed
- `ui-events.ts` (the v2 vocabulary, JSDoc'd per-backend sources) + `tool-display.ts` (paseo-pattern display model, exhaustive table tests, never throws).
- Three pure mappers with explicit immutable state + deterministic ids, wired additively via `SessionOptions.onUiEvent` (v1 byte-identical, proven by wiring tests): claude (thinking, TodoWrite→plan, parent_tool_use_id, permission_denials→declined), codex (typed items, real status map killing the v1 regex-on-status hack, text/reasoning/output deltas, todoList→plan, no fabricated cost), opencode (true cursor deltas, the only genuine `pending` phase, patch→diffs, subtask nesting, **turn-end from `session.idle`** fixing v1's HTTP-response synthesis — in v2 only).
- 16 golden fixtures + `.expected.json` across `__fixtures__/{claude,codex,opencode}/`, faithful to the documented wire formats; 2 test-only mock servers.
- **`ui-parity.test.ts` — the spec's backend-parity hard rule as an executable table** over all three backends' fixture outputs (plan, statuses, reasoning, diffs, task items, usage, stop reasons; codex's sub-agent cell = review-mode items since its wire carries no parent attribution).

## Honesty notes
- Codex emits no `costUsd` (its wire has none) — asserted, not fabricated. Claude emits whole text blocks, not fake deltas. RunManager consumption is 2.1 (the `onUiEvent` channel is plumbed, unconsumed).
