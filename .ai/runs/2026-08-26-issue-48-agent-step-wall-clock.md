# Execution plan — issue #48: the 30-minute wall clock kills a working run

**Issue:** ajurzyk/cezar#48 · **Branch:** `fix/issue-48-agent-step-wall-clock` · **Base:** `main` (`cde4af77`)
**Engine:** om-auto-create-pr (steps: 10, --loop: no)

## Goal

Let a workflow step declare how long it may run, and make a step that *is* killed by the wall
clock say so honestly — instead of reporting `implement failed`, `tokensUsed: 0` and no cost,
which is indistinguishable from a step that did nothing.

## Scope

Three axes, exactly as the issue frames them.

1. **The cap is unconfigurable.** Add an optional `timeoutMinutes` to `workflowStepSchema`
   (`packages/cezar/src/workflows/types.ts`), bounded `z.number().int().positive().max(240)`,
   and thread it to the runner at `packages/cezar/src/workflows/run.ts:2980`.
   `DEFAULT_RUN_TIMEOUT_MS` stays the fallback. The change has to reach four places or it is
   silently incomplete: the hand-kept contract mirror (`packages/contract/src/workflows.ts`),
   the `skillStackOf` richer-fields guard, the step-kind `.refine`, and the commit message's
   note about the persisted `workflowDef`.
2. **The timeout message cannot tell a hung agent from a busy one.** Append the observed tool
   call count to `claude-cli-runner.ts:290`.
3. **The kill destroys the step's accounting.** Emit a note on the timeout path — but only
   when `sawUsage` is false, so a multi-turn timeout that kept its accounting is not slandered.

### Non-goals

- Removing or raising `DEFAULT_RUN_TIMEOUT_MS` itself.
- Touching the interactive path (`run.ts:2648`, `:2980`) or `runContinuation`'s hard
  `timeoutMs: 0` (`run.ts:2394`).
- Re-enabling assistant-frame usage accounting (upstream #716 exists because summing both
  sources double-counts).
- Any behaviour change in `codex-app-server-runner.ts`, `opencode-server-runner.ts`,
  `pi-runner.ts`. They already honour `spec.timeoutMs`, so they inherit the fix for free.
- The legacy `claude-cli` id in `runner: z.enum(RUNNER_IDS)`.

## Correction to the issue's premise

The issue states that
`grep -rln 'workflowStepSchema\|workflowFileSchema\|skillStackOf\|loadWorkflows' --include=*.test.ts`
"returns nothing, so there is no existing schema test to extend". It does return one file:

    ./packages/cezar/test/unit/workflow-types.test.ts

That file is a **`node:test`** suite (`node --import tsx --test test/unit/*.test.ts`,
`npm run test:unit`) and is deliberately excluded from the vitest gate —
`packages/cezar/vitest.config.ts` includes only `src/**/*.test.ts`. So the issue's instruction
stands and its arithmetic is right: the new vitest file `src/workflows/types.test.ts` is
genuinely new to `npm test`, and the acceptance count (337 files / 6661 tests) holds. Recorded
here because the stated reason was wrong even though the conclusion was not.

## Risks

- **A narrowing on `workflowStepSchema` eats already-queued runs** (`runs/store.ts:299`). The
  new refine clause can only reject a `command` step carrying `timeoutMinutes`, which nothing
  has ever been able to write — the field does not exist on `main`. Called out in the commit
  message.
- **The contract mirror is enforced at typecheck time**, not test time
  (`contract-parity.workflows.test.ts`, `Mutual<A, B>`). Adding the field on one side only
  fails `npm run typecheck` with `schema-is-wider`; the gate catches it.
- **The runner-factory seam does not exist.** The wiring tests need one. Mocking the factory
  with a *delegating* recorder (it forwards to the real runner and only observes the spec)
  keeps the rest of `run.test.ts` byte-identical in behaviour.
- **Fake timers vs. the stream loop.** The existing timeout test never awaits `session.result`.
  The new runner tests do, so they drive the fake child on real timers with a 20 ms cap and
  emit the exit explicitly, rather than fighting fake timers over PassThrough internals.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Schema, guards and the contract mirror

- [x] 1.1 Red: new vitest file `src/workflows/types.test.ts` with the four schema cases — 6b81bdba
- [x] 1.2 Green: `timeoutMinutes` on `workflowStepSchema`, the new refine clause, the `skillStackOf` guard — 6b81bdba
- [x] 1.3 Green: the identical field and refine in the contract mirror `packages/contract/src/workflows.ts` — 6b81bdba

### Phase 2: Wiring the value to the runner

- [ ] 2.1 Red: `run.test.ts` — the value reaches the runner, and the last agent step still gets `timeoutMs: 0`
- [ ] 2.2 Green: `stepTimeoutMs(step, interactive)` in `run.ts`, used at the `startSession` call

### Phase 3: Runner diagnostics on the timeout path

- [ ] 3.1 Red: `claude-cli-runner.test.ts` — the lost-accounting note, its `sawUsage` guard, and the tool-call count
- [ ] 3.2 Green: Axis 2 and Axis 3 in `claude-cli-runner.ts`

### Phase 4: Proof

- [ ] 4.1 Full validation gate green, both counts quoted
- [ ] 4.2 Mutation check per guard, red output pasted into the PR body
- [ ] 4.3 PR body, labels, summary comment
