# README: orchestration-first gallery, positioning prose, emoji sweep

Status: complete

## Goal

Reposition the README around what cezar actually is — a parallel coding-agent
orchestrator you can fire and forget — by reshooting the screenshot gallery
around the Task view, adding a positioning paragraph under the tagline,
rewriting "What it solves" with the orchestration/queue/fire-and-forget angle,
and giving "Core concepts" emojis plus the queue and memory-usage facts.

## Scope

- `README.md` — the gallery table, the intro paragraph, "What it solves",
  "Core concepts".
- `docs/screenshots/` — add `task-view.png` and `skills-autonomous.png`;
  retire `review-gate.png` and `plan-chain.png` from the gallery.

### Non-goals

- No source changes. This is a docs-only run.
- No rewrite of Quick start, How it works, Cockpit tour, Workflow format,
  Agent backends, Configuration, Development, or License.
- No new product claims that the code does not already support.

## Decisions taken with the user

- Gallery stays at **6 cells**: Task view · Watch a run live · Parallel
  variants / Workflow builder · GitHub · Skills + autonomous. `review-gate.png`
  and `plan-chain.png` leave the gallery (the prose still covers both features);
  the files stay in `docs/screenshots/` so nothing else that links them breaks.
- Screenshots are **captured this run** from a real cockpit booted via
  `.ai/scripts/test-env-up.sh` (`CEZ_DRY_RUN=1`), seeded with a realistic,
  presentable set of tasks before the shot.

## Risks

- **Fabricated claims.** The brief asks for queue and memory-usage copy. Both
  must be grounded in code (`maxParallel` scheduling, `peakRssBytes` /
  `peakProcCount` from `src/core/process-usage.ts`) — anything the code does not
  support gets dropped rather than softened.
- **Seeded screenshots must not look fake.** Task titles must read like real
  work on this repo, with plausible token/cost/status spread.
- **Emoji overload.** Emojis go on list-item headers only; prose stays clean.
- **Screenshots carry real paths/branches.** Check each PNG for anything
  private before committing.

## Implementation Plan

### Phase 1: Ground the claims

- 1.1 Establish queue facts (maxParallel, queued→running, FIFO, non-git cap).
- 1.2 Establish memory facts (peak RSS/proc tracking, NDJSON streaming).

### Phase 2: Capture the screenshots

- 2.1 Boot the cockpit via test-env-up.sh and seed a presentable task set.
- 2.2 Capture `task-view.png` (Task view — the orchestration headline).
- 2.3 Capture `skills-autonomous.png` (skills picker + autonomous flag).

### Phase 3: Rewrite the prose

- 3.1 Rewire the gallery table to the six agreed cells.
- 3.2 Add the fire-and-forget positioning paragraph under the tagline.
- 3.3 Rewrite "What it solves" with emojis + orchestration/queue/OSS-models angle.
- 3.4 Add emojis, the queuing system and memory-usage bullets to "Core concepts".

### Phase 4: Validate and ship

- 4.1 Run the validation gate and re-read the rendered diff.
- 4.2 Self-review (om-code-review) and open the PR.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Ground the claims

- [x] 1.1 Establish queue facts — Explore agent (maxParallel default 2, non-git=1, FIFO with positions, restart recovery, cancel-while-queued; no reorder)
- [x] 1.2 Establish memory facts — Explore agent (peak RSS/CPU sampling, opt-in memoryLimitMb pause-and-advance, append-only NDJSON, coalesced deltas; NOT log truncation/ring buffer/streaming replay)

### Phase 2: Capture the screenshots

- [x] 2.1 Boot the cockpit and seed a presentable task set — seed.mjs, 16 runs, CEZ_NO_RECOVER harness
- [x] 2.2 Capture task-view.png — c-later
- [x] 2.3 Capture skills-autonomous.png — c-later

### Phase 3: Rewrite the prose

- [x] 3.1 Rewire the gallery table to the six agreed cells
- [x] 3.2 Add the fire-and-forget positioning paragraph
- [x] 3.3 Rewrite "What it solves"
- [x] 3.4 Emoji + queue + memory in "Core concepts"

### Phase 4: Validate and ship

- [x] 4.1 Docs-only gate: no docs linter in repo; every screenshot ref resolves; manual diff re-read; mobile claim verified against e2e iPhone specs
- [ ] 4.2 Self-review and open the PR
