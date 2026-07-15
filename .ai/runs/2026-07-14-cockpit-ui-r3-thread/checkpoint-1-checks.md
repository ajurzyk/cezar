# Checkpoint 1 — R3 Steps 1.1..1.4 (thread core)

- Commits `a19391d`..`1b7a72e`. Gate: typecheck ✓ · `npm test` ×2 **1169/1169** ✓ · build ✓ · `npm run test:e2e` **64/64** (agent-browser) ✓.
- Artifacts: screenshots (thread desktop/mobile, header desktop) — verified by eye against `docs/mockups/thread.html`.

## Landed
- **1.1** thread reducer (v2 primary, honest v1 fallback, mixed-file dedup verified against a live-generated transcript), Streamdown + Shiki singleton on the `--syn-*` token theme (lazy chunks — initial bundle unchanged), committed real-transcript e2e fixture.
- **1.2** ToolCards (#381): trigger grammar, shimmer (added as tokenized utility), exit pills, clamped output + live tail with stick-to-bottom, `InlineDiffPreview` seam for R5, context groups, reasoning rows, streak folding, sub-agent nesting. No fabricated durations (items carry no timestamps — honest).
- **1.3** PlanDock (#382): grad-edge, latest-plan-wins, three states, per-run collapse persistence; plan-kind cards hidden (v1 TodoWrite recovery added so old runs lose nothing); StepRail (mercato grammar) + check-output as ToolCards (reused, not duplicated). Guardian caught a `text-pending` attempt — `stroke-pending` used.
- **1.4** full run header: inline title edit (#389, PATCH-persisted, proven by e2e API readback), meta line (no fake context gauge — RunRecord has no window data), status pill + queue position, Session|Changes|Files tabs, action bar with the full legacy visibility matrix, Terminal 409→clipboard+toast, AlertDialog confirms (no native confirm), resume hint, mobile kebab. VS Code + hosted-mode hiding = marked seams for R5 (no endpoint/field exists — not faked).

## Next
Phase 2: 2.1 composer (skills `/`, `@` files, dictation), 2.2 review gate, 2.3 variants compare, 2.4 virtualization + iOS pass.
