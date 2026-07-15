# Handoff — R3 (Thread view)
## State
Checkpoint 1: Steps 1.1-1.4 done (thread core). Next: Step 2.1 (composer). Toaster + AlertDialog primitives now exist for reuse. All R1/R2 conventions apply (see prior run folders' HANDOFFs — gotchas lists especially).
Key inputs: `useRunEvents(runId)` (both SSE names, seq `>` dedup), `web/app/src/protocol/` (v2 types + toolDisplay), golden fixtures under `src/core/__fixtures__/` for realistic event shapes, `docs/mockups/thread.html` (visual contract).
