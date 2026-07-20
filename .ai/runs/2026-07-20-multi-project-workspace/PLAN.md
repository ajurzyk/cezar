# Plan — 2026-07-20-multi-project-workspace

**Skill:** om-auto-create-pr-loop
**Owner:** pkarw
**Branch:** feat/multi-project-workspace
**Base:** main
**Issue:** #520
**Spec:** `.ai/specs/2026-07-20-multi-project-workspace.md` (authoritative — this plan maps its numbered steps 1:1 onto the Tasks table; step details live in the spec)
**Status:** in-progress

## Tasks

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | `src/paths.ts` workspace path helpers + fix stale `instances/` docstring | done | edf42f6 |
| 1 | 1.2 | `src/workspace/config.ts` — zod schema, load, merge-write (atomic, 0600) | done | ca64ed5 |
| 1 | 1.3 | `src/workspace/projects.ts` — register/list/remove, slug alloc, realpath dedupe | done | c8de088 |
| 1 | 1.4 | `src/workspace/migrations.ts` framework + migration 001 | done | 8d27de2 |
| 1 | 1.5 | Boot wiring in `src/index.ts` (serve+run, worktree/$HOME guards) + pin `CEZ_HOME` in e2e/test:package harnesses | done | 757b66e |
| 1 | 1.6 | `GET /api/projects` + additive `/api/health` fields (`projects`, `bootProject`) | done | 0050994 |
| 1 | 1.7 | BACKWARD_COMPATIBILITY.md: `~/.cezar/{config,ui-state}.json`, `/api/projects`, health additions | todo | |
| 2 | 2.1 | `src/server/project-context.ts` lazy context map + `RunManager.dispose()` | todo | |
| 2 | 2.2 | `server.ts` context-resolver refactor: `/api/p/:projectId/*` + legacy aliases + parity tests | todo | |
| 2 | 2.3 | `src/todos.ts` per-dataDir watcher/emitter map | todo | |
| 2 | 2.4 | Usage fan-out scoping (`run.ts` + SSE relay per-project `usage` filtering) | todo | |
| 2 | 2.5 | Workspace semaphore for global `maxParallel` (cached config, #347 exemption preserved) | todo | |
| 2 | 2.6 | Per-project cache keying: GitHub list + comments caches, team-skills cache (+ isolation regression tests) | todo | |
| 2 | 2.7 | `GET/PUT /api/workspace/config` (projectsDir writability probe) + `/api/workspace/ui-state` | todo | |
| 2 | 2.8 | `GET /api/workspace/events` all-project SSE; legacy `/api/events` stays boot-filtered | todo | |
| 2 | 2.9 | BACKWARD_COMPATIBILITY.md: `/api/p/*`, workspace SSE stream, `project` SSE field | todo | |
| 3 | 3.1 | Cockpit API-client scope seam (`send()` prefix, 4 non-send sites, workspace EventSource, query keys) | todo | |
| 3 | 3.2 | `/p/:projectId/*` routes + legacy redirects (params preserved) + `default` alias normalization | todo | |
| 3 | 3.3 | Multi-project sidebar: groups, collapse persistence, 10-recent + More…, missing state, add-project button | todo | |
| 3 | 3.4 | New-task project pill: scope swap, per-project draft keys, scoped submit | todo | |
| 3 | 3.5 | Settings split: registry `scope` field, `/settings/global/*` sections, project sections | todo | |
| 3 | 3.6 | Project-scoped bookmarklets (per-project launch-key URLs) | todo | |
| 3 | 3.7 | BACKWARD_COMPATIBILITY.md: `/p/*` URLs + bookmarklet redirect | todo | |
| 4 | 4.1 | `GET /api/fs/browse` (home-rooted, realpath containment, `CEZ_REMOTE` restriction) | todo | |
| 4 | 4.2 | Folder-browser dialog → `POST /api/projects` | todo | |
| 4 | 4.3 | `POST /api/projects/checkout` + `checkout-progress` SSE + partial-clone cleanup + dialog flow | todo | |
| 4 | 4.4 | Global Projects settings pane: list/remove, `projectsDir` field with inline validation | todo | |
| 5 | 5.1 | Docs: AGENTS.md routing rows, README multi-project section, `.env.example` | todo | |
| 5 | 5.2 | `cezar projects` CLI + server-install docs note | todo | |
| 5 | 5.3 | File follow-up issue: retire `liveInstancesExist()` / `~/.cezar/instances/` | todo | |

## Goal

Implement issue #520: turn a single `cezar serve` into a workspace over all the
user's projects — per-user registry in `~/.cezar/config.json`, project-scoped
API + cockpit routes (`/api/p/:projectId/*`, `/p/:projectId/*`), multi-project
sidebar, GUI project add/clone, and boot-time config migrations so existing
installs upgrade invisibly.

## Scope

Everything in the spec's Implementation Plan (Phases 1–5). Each phase leaves
the app fully working; legacy unprefixed routes stay byte-identical for the
boot project (alias parity is the Phase-2 safety net).

## Non-goals

- Cross-machine sync, per-project OS windows, background daemons.
- Migrating task data (all per-project state stays under `<repo>/.ai/cezar/`).
- Reviving the #406 per-process-instances + reverse-proxy design.
- Retiring `liveInstancesExist()` (tracked as follow-up issue, step 5.3).

## External references

- `--skill-url`: none provided.
- Spec mockups: `.ai/specs/assets/2026-07-20-multi-project-workspace/`.

## Risks

- **Blast radius**: `server.ts` closure→context-resolver refactor (2.2) is the
  riskiest single change; alias parity tests are the safety net.
- **Data isolation**: cache-keying fixes (2.6) need regression tests that one
  project's data is never served under another's scope.
- **#347 regression**: the workspace semaphore (2.5) must keep the `waiting`-run
  exemption (`run.ts` pump) or resumes hang at saturation.
- **Health leak**: `/api/health` must never expose `projects[].root` (#431).
- **Harness pollution**: e2e/test:package boot the real CLI — `CEZ_HOME` must be
  pinned to a temp dir from 1.5 on, or tests write the developer's `~/.cezar`.
