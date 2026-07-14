# Code review rules

Review checklist for this repository, applied by human reviewers and by the `om-code-review` skill (which picks this file up automatically). Severity discipline and the label state machine are defined in `SDLC.md`.

## Review priorities, in order

1. **Correctness** — the change does what the PR says, handles the empty/error paths, and does not regress an existing flow.
2. **Contracts** — nothing in `BACKWARD_COMPATIBILITY.md` is broken silently: CLI flags, `/api/*` routes and shapes, on-disk state formats, workflow YAML schema, the published npm package surface.
3. **Security** — see repo-specific checks below; cezar spawns child processes and serves HTTP on localhost, so the interesting risks are command construction and what the server exposes.
4. **Scope** — the diff matches the plan/issue; no unrelated churn, no drive-by refactors.

## Repo-specific checks

- **TypeScript / ESM**: `npm run typecheck` and `npm run build` must pass; the project is `"type": "module"` on Node 20+ — no CommonJS `require`, no default-import of JSON.
- **API handlers** (`src/server/server.ts`): request bodies validated with `zod` before use; errors return JSON with a sensible status, never a stack trace. Any new/changed route is exercised by `web/app.js` in the same PR.
- **Child processes** (`src/core/*-runner.ts`, `src/server/open-in-terminal.ts`, git helpers): arguments passed as arrays, never interpolated into a shell string; user-supplied text (task briefs, branch names, file paths) must not reach a shell unquoted.
- **Filesystem state** (`src/runs/store.ts`, `src/handoff.ts`, `src/todos.ts`): writes stay inside `.ai/cezar/` (or the run's worktree); reads tolerate missing/corrupt files (the README promises hand-editable state); no secrets written world-readable — follow the `launch-key` pattern (mode 0600).
- **Launch key** (`src/server/launch-key.ts`): never logged, never embedded in pages beyond the documented bookmarklet flow, never required reading for any code path outside the server.
- **Worktrees** (`src/git-worktree.ts`): operations target the run's worktree, never the primary checkout; failure paths clean up what they created.
- **Graceful degradation**: no `gh` → cockpit works without PR features; no network → local skills still load. A change that turns a degradation path into a hard failure is a bug.
- **Web UI** (`web/`): stays framework-free and build-free; no external CDN resources.
- **Dependencies**: this package ships via `npx` — every new runtime dependency is startup cost for users; justify it in the PR.

## Severity guidance

- **Blocker** — breaks a protected contract without the documented path, security regression (shell injection, launch-key exposure, server listening beyond localhost), data-destroying bug in run state or worktree handling, validation gate red.
- **Major** — correctness bug in a main flow, missing zod validation on a new route, degradation path removed, API/UI drift (route changed, `web/app.js` not updated).
- **Minor** — naming, structure, missed edge case with low blast radius, docs drift.

Request changes on any Blocker or Major; Minors alone can be approved with comments.
