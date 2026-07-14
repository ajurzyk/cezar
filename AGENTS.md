# Agent instructions for cezar

cezar is a local cockpit for running and tracking AI coding-agent tasks in a repository: a Node 20+ / TypeScript CLI (`cezar` / `cez`) that starts a Hono HTTP server and serves a vanilla-JS browser cockpit from `web/`. Tasks run through pluggable agent backends (Claude CLI, Codex app-server, OpenCode server), each in its own git worktree. All state is plain JSON / NDJSON / Markdown under `.ai/cezar/` — no database, no cloud, no accounts.

## Task routing

| When the task involves… | Read first | Key rules |
|---|---|---|
| CLI entrypoint, flags, commands | `src/index.ts`, `src/config.ts` | Keep `--help` output in `src/index.ts` in sync with any flag change. Node 20+, ESM (`"type": "module"`). |
| Agent backends / run execution | `src/core/agent-runner.ts`, `src/core/runner-factory.ts`, `src/core/backend-detect.ts`, then the backend runner (`claude-cli-runner.ts`, `codex-app-server-runner.ts`, `opencode-server-runner.ts`) | New backends go through the runner factory + backend detection; keep the shared `agent-runner` contract. Streamed events are NDJSON (`src/core/ndjson.ts`); token/cost accounting in `src/core/usage.ts`. |
| HTTP API | `src/server/server.ts` | Routes are `/api/*` on Hono. Validate request bodies with `zod` (already a dependency). The bundled `web/app.js` is the only consumer — update it in the same PR as any route change. |
| Cockpit UI | `web/index.html`, `web/app.js`, `web/style.css` | Vanilla JS, no framework, no build step — `web/` ships as-is in the npm package. |
| Run state / persistence | `src/runs/store.ts`, `src/handoff.ts`, `src/todos.ts` | State under `.ai/cezar/` must stay hand-editable (README promise): plain JSON, NDJSON, Markdown. Changes to on-disk formats must tolerate files written by older versions. |
| Worktrees / git | `src/git-worktree.ts`, `src/server/git.ts`, `src/server/pr.ts`, `src/server/github.ts` | Each run gets its own worktree; never operate on the user's primary checkout. PRs open as drafts via `gh`; everything must degrade gracefully when `gh` is missing. |
| Skills / workflows | `src/skills.ts`, `src/skills-remote.ts`, `src/workflows/` | Skills are Markdown, workflows are YAML (`src/workflows/types.ts` is the schema). Local skills must keep loading without network. |
| Security-sensitive surfaces | `src/server/launch-key.ts`, `src/server/server.ts` | The launch key gates auto-start from bookmarklets (`/new?auto=1`); never expose it beyond `/api/launch-key`, never log it. Server is a localhost tool — do not add remote-exposure features casually. |
| Feature design / specs | `.ai/specs/` | Specs are numbered `NNN-title.md`; read the relevant spec before changing the feature it defines. |

## Validation

Run before every PR (also configured in `.ai/agentic.config.json`):

```bash
npm run typecheck
npm run build
```

There is no automated test suite yet (TODO); until one exists, verify behavior changes by running the cockpit locally (`npm run dev`) and exercising the affected flow.

## Process pointers

- `SDLC.md` — ticket flow, label state machine, QA gate, claim protocol.
- `CODE_REVIEW.md` — review rules for this repo.
- `BACKWARD_COMPATIBILITY.md` — protected contract surfaces; check before changing CLI flags, API routes, or on-disk formats.
- `.ai/agentic.config.json` — pipeline config every `om-*` skill reads; tracker operations in `.ai/trackers/github.md`.
