# Execution plan — AskUser across claude/codex/opencode (FR #473)

Source doc: `.ai/specs/2026-07-18-askuser-across-runners.md`
Tracking issue: #473
Branch: `feat/issue-473-askuser-support`
Base: `main`

The Progress phases mirror the spec's Implementation Plan (Phases → Steps). Each
step is independently testable and leaves the app green. Every code change ships
with tests; the docs phase runs the configured lint/check only.

## Goal

Let agents ask the user a structured multiple-choice question instead of falling
back to prose ("`AskUserQuestion` isn't available…"). The agent emits a `CEZ:ASK`
control marker (mirroring `CEZ:DONE`/`CEZ:MONITORING`); cezar parks the run
`waiting`, the cockpit renders clickable option chips, and the pick (or a
free-form reply) rides the existing reply seam back to the live session — uniform
across all three backends.

## Progress

### Phase 1 — Protocol, parser & cockpit UI
- [ ] 1. Payload module + zod validator — `src/core/ask.ts` (`AskRequest`/`AskQuestion`/`AskOption`, counts, header ≤12, uniqueness). Test: valid parses, each violation rejects.
- [ ] 2. `ask.requested` UiEvent — add `UiAskRequestedEvent` to `src/core/ui-events.ts` (union + `UiEventType`); mirror `web/app/src/protocol/ui-events.ts`; keep `src/server/api-types.test.ts` exact. Test: event shape + discriminator.
- [ ] 3. Marker parser — `ASK_MARKER_RE` + `parseAskMarker()` + `stripAskMarker()` in `src/workflows/run.ts`. Test: extract, invalid → null, marker stripped from display.
- [ ] 4. Turn-end wiring + park — hook into both turn-end sites with `DONE > ASK > MONITORING > plain` precedence; emit `ask.requested`, record in-memory `pendingAskId`, park `waiting`; clear in cancel/finish/sendMessage. Test (RunManager): CEZ:ASK → ask.requested + waiting; DONE+ASK → done.
- [ ] 5. System-prompt instruction — AskUser block + schema summary in `src/handoff.ts`. Test: assembled prompt contains the instruction.
- [ ] 6. Thread reducer + AskCard — `ask.requested` case in `thread-state.ts` + `AskCard` component (single + multi-select), wired to `useSendMessage`, client-side resolution on next user message. Component tests: renders, single-click sends `header: label` + resolves, multi-select sends comma-joined + resolves, composer stays enabled.

### Phase 2 — Cross-backend proof & degradation
- [ ] 7. End-to-end per backend — drive each mock claude/codex/opencode runner through a `CEZ:ASK` turn; assert `ask.requested` + `waiting` for all three.
- [ ] 8. Graceful degradation — malformed marker → plain text + `waiting`, no card, non-fatal note; multiple markers → first wins.

### Phase 3 — Documentation
- [ ] 9. Docs — `AGENT_PROTOCOL.md` (event + marker + future native-`AskUserQuestion` bridge note), `BACKWARD_COMPATIBILITY.md §7` (enumerate `ask.requested`), README/handoff note. No code; configured lint/check still runs.

## Validation gate (before marking ready)
`npm run typecheck` · `npm test` · `npm run test:unit` · `npm run build` · `npm run test:package`

## PR
PR: (pending — draft opened after this plan lands)
