# Handoff — server-installer

**State:** in-progress (run start)
**Branch:** `feat/server-installer`
**PR:** not opened yet

## Next concrete action

Step 1.1 — create `src/paths.ts` with `cezarHomeDir()` (`CEZ_HOME ?? ~/.cezar`) and `serverStatePath()`, plus a unit test. `src/paths.ts` does not exist on `main` yet, so this run creates it.

## Context a fresh agent needs

- Source spec: `.ai/specs/2026-07-16-server-installer.md` — read it first.
- Reuse `detectEnvironment()` from `src/core/backend-detect.ts` for the dependency step.
- cezar stays loopback-bound; installer sets `CEZ_REMOTE=1` in the service, nginx fronts it.
- `~/.cezar/server.json` is host-level/install-once; coexists with the multi-project `~/.cezar/instances/`.
- Validation gate: `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`.

## Checkpoints so far

None yet.
