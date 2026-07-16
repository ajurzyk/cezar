# Handoff — server-installer

**State:** in-progress
**Branch:** `feat/server-installer`
**PR:** not opened yet
**Checkpoint:** 1 (steps 1.1–1.5 verified)

## Next concrete action

Step 1.6 — `src/server-install/engine.ts`: `runInstall` (iterate strategy steps, skip resolved via `check()` unless `--reconfigure` names them, `run()`, persist each `StepOutcome`, resume from state, flip `installed` when all required steps done) **and** `runUninstall` (walk completed steps in reverse, `undo(created)` for `owned` artifacts, list `shared` ones for manual removal). Acquire the single-writer lock (`acquireLock` from `state.ts`) for both. Build the real `InstallContext` (with `defaultRunner`, `createClackUi`/`createAutoUi`, `save` → `saveServerState`).

## Foundation in place (1.1–1.5)

- `src/paths.ts` — `cezarHomeDir` / `serverStatePath` / `serverLockPath` (CEZ_HOME override).
- `types.ts` — `InstallStep`/`PlatformStrategy`/`InstallContext`/`Runner`/`Ui`/`StepArtifact` + zod `serverStateSchema`; `CANCEL` sentinel; `PreflightError`.
- `state.ts` — `loadServerState`/`saveServerState` (atomic 0600, degrade-to-fresh), `firstIncompleteStep`, `acquireLock` (pid + stale reclaim).
- `ui.ts` — `createClackUi` (cancel→CANCEL) + `createAutoUi` (headless defaults for --yes/dry-run/tests).
- `steps.ts` — `defaultRunner`, `verifyCommand`, `hasPasswordlessSudo`, `sudoStep`, `owned`/`shared` helpers, `depCheckStep` (wraps `detectEnvironment`).

## Remaining steps

1.6 engine · 1.7 strategies+ubuntu-vps · 1.8 CLI wiring+npm script+e2e · 2.1 SSL · 2.2 autostart · 3.1 macosx-ngrok.

## Validation

Gate: `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`.
