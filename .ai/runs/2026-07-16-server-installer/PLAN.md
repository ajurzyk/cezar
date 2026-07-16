# Execution plan: server installer & uninstaller

Source spec: `.ai/specs/2026-07-16-server-installer.md`
Tracking issue: #419

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | `src/paths.ts` — cezarHomeDir + serverStatePath | done | 60d9d30 |
| 1 | 1.2 | `src/server-install/types.ts` — contracts + zod ServerState | done | 05c56ac |
| 1 | 1.3 | `src/server-install/state.ts` — load/save/resume | done | 1a0f9bd |
| 1 | 1.4 | `src/server-install/ui.ts` — @clack wrappers + cancel sentinel | done | bca8202 |
| 1 | 1.5 | `src/server-install/steps.ts` — sudoStep/verifyCommand/depCheckStep | done | 1599abb |
| 1 | 1.6 | `src/server-install/engine.ts` — runInstall/runUninstall + lock | done | 27da0e7 |
| 1 | 1.7 | `strategies.ts` + `platforms/ubuntu-vps.ts` (Phase-1 steps) | done | 3bb88ae |
| 1 | 1.8 | `src/index.ts` wiring + npm script + e2e | done | 693cda2 |
| 2 | 2.1 | ubuntu-vps SSL step (certbot --nginx) | done | 67e99b6 |
| 2 | 2.2 | ubuntu-vps autostart step (systemd) | done | d10ba40 |
| 3 | 3.1 | `platforms/macosx-ngrok.ts` + registry | done | PENDING31 |

## Goal

Implement the merged spec: a dependency-free interactive `server-install` / `server-uninstall` wizard modularized by platform strategy (`ubuntu-vps`, `macosx-ngrok`), idempotent/resumable via `~/.cezar/server.json`, sudo-aware, install-once per host.

## Scope

New module `src/server-install/*`, a shared `src/paths.ts` helper, CLI wiring in `src/index.ts`, one new prod dependency (`@clack/prompts`), an npm script, and unit + e2e tests. No changes to the runtime server/agent code.

## Non-goals

- No changes to `serve`/`run`/`init` behavior beyond adding two new positional commands.
- `@clack/prompts` must not be imported by the server/runtime import graph.
- Not refactoring `skills-remote.ts`'s inline homedir onto the new helper (spec says out of scope).

## Risks

- First prod dependency beyond hono/yaml/zod (`@clack/prompts`) — installer-only; keep out of server graph.
- `src/paths.ts` shared with two other in-flight specs — first-writer-owns; create minimal if absent.
- Interactive TUI is hard to unit-test — design `ui.ts` around an injectable/scriptable prompt transport and `CEZ_DRY_RUN` auto-answers so the engine and steps are testable headless.

## Approach note

Implemented directly in the main session (not via executor subagents): the design context from authoring + reviewing this spec lives here, and the module is tightly coupled (engine ↔ types ↔ steps ↔ ui), so coherence beats parallelism. Checkpoints every ~5 steps per the loop contract.
