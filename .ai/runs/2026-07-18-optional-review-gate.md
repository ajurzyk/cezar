# Execution plan — Optional review gate (FR #489)

Source doc: `.ai/specs/2026-07-18-optional-review-gate.md`
Tracking issue: #489
Branch: `feat/issue-489-optional-review-gate`
Base: `main`

The Progress phases mirror the spec's Implementation Plan (Phases → Steps). Each
step is independently testable and leaves the app green. Every code change ships
with tests; the docs phase runs the configured lint/check only.

## Goal

Make the diff-first review gate (spec 009) **opt-in**: OFF by default, enabled by
`CEZ_REVIEW_GATE=1` overridable by a `reviewGate` Settings toggle, and **always
skipped for autonomous runs**. A successful run with changes then settles straight
to `done` (diff stays in the worktree) unless the gate applies.

## Progress

### Phase 1 — Engine + persistence (the #489 fix) — done @ b958703
- [x] 1. Persist `autonomous?: boolean` on `runRecordSchema` (`src/runs/store.ts`) and write it from `startRun` (`src/workflows/run.ts`) as `autonomous: input.autonomous === true`. Test: record round-trips `autonomous`.
- [x] 2. Add `reviewGateEnabled(config, env)` (`src/runs/review-gate.ts`), default-off precedence. Unit-test the matrix (`src/runs/review-gate.test.ts`).
- [x] 3. Gate `settleSuccess` (`src/workflows/run.ts`) on `diff && reviewGateEnabled(config) && !run.autonomous`, else `done`. Engine test: gate-off / autonomous / gate-on+manual / no-diff.
- [x] 4. Re-thread `autonomous` through `recover()`'s rebuilt `input` (`src/workflows/run.ts`). Test: recovered queued autonomous run stays autonomous.
- [x] 5. Gate the group-pick winner-park (`POST /api/groups/:groupId/pick`, `src/server/server.ts`). Test: autonomous / gate-off winner stays `done`. (Also added the additive `reviewGate` config schema key here — the engine's config path depends on it to typecheck.)

### Phase 2 — Config surface (env + Settings)
- [ ] 6. Add `reviewGate` to config schema (`src/config.ts`), GET `/api/config` and PUT `/api/config` (`src/server/server.ts`). Test in `src/server/config-api.test.ts`.
- [ ] 7. Add `reviewGate` to client GET/PUT config types (`web/app/src/api/types.ts`).
- [ ] 8. Add the Settings → Agents Switch (`web/app/src/routes/settings/agents-section.tsx`), `checked={config.reviewGate ?? false}`. Test in `agents-section.test.tsx`.

### Phase 3 — Docs
- [ ] 9. Document `CEZ_REVIEW_GATE` (default off) in `.env.example` and the `README.md` env table.

## Validation gate (before marking ready)
`npm run typecheck` · `npm test` · `npm run test:unit` · `npm run build` · `npm run test:package`

## PR
PR: (pending)
