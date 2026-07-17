# Checkpoint 1 — steps 1.1 .. 1.5

Covers: `src/paths.ts`, `src/server-install/{types,state,ui,steps}.ts` (the engine's foundation — paths, contracts, state I/O + lock, interactive UI, sudoStep).
Commit range: 60d9d30 .. 1599abb (+ checkpoint typing fixes).

## Checks

| Check | Result |
|---|---|
| `npm run typecheck:server` (tsc, server + tests) | ✅ pass (after casting clack's conditional `Option<T>` and fixing the test `makeCtx` signature) |
| `vitest run src/paths.test.ts src/server-install/` | ✅ 20 passed (5 files) |

Fixes applied at this checkpoint (folded into the checkpoint commit):
- `ui.ts` — `select`/`multiselect` needed per-method generics + an options cast to satisfy clack's conditional `Option<Value>` type.
- `steps.test.ts` — `makeCtx` param type no longer intersects `Partial<InstallContext>` (which forced a full `Runner`).

## UI verification

Skipped — no product UI (cockpit) touched in this window; this is CLI/server module code. No dev env needed.

## Notes

- No real exec, sudo, or network in any test — `Runner` is injected and `CEZ_DRY_RUN` semantics are unit-covered (`verifyCommand` returns false in dry-run; `sudoStep` short-circuits).
- `@clack/prompts` is imported only by `ui.ts`; `types.ts`/`state.ts`/`steps.ts` stay library-free.
