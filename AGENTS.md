# AGENTS.md — working in this repository

cezar is a **parallel coding-agents orchestrator**: a local cockpit (CLI + browser GUI) for running and tracking AI coding-agent tasks in a repo. You type a task, pick a workflow and a backend — Claude Code, Codex or OpenCode, or a mix per step — and watch it work live: steps, tool calls, tokens, diffs. Each task runs in its own git worktree, ends at a review gate (never auto-merges), and can be pushed as a draft PR through `gh`. Everything is local: no accounts, no database, no cloud — state is plain JSON, NDJSON and Markdown under `.ai/cezar/`. The stack is deliberately small: strict TypeScript (ESM, Node 20+), Hono + SSE for the server, Zod at every boundary, YAML for workflows, and dependency-free vanilla JS for the GUI. Every module is meant to be read in one sitting.

## Task routing

| When the task involves… | Read first | Key rules |
|---|---|---|
| CLI entry, `serve`/`run`/`init` subcommands, flags | `src/index.ts` | Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file. |
| Agent runners / backends | `src/core/agent-runner.ts`, then `src/core/runner-factory.ts`, `src/core/claude-cli-runner.ts`, `src/core/codex-app-server-runner.ts`, `src/core/opencode-server-runner.ts`, `src/core/backend-detect.ts` | One seam: every backend implements `AgentRunner`/`AgentSession` and emits normalized `AgentEvent`s. New backends slot in as one class — do not leak backend-specific types past the seam. `claude-cli` is a legacy backend id kept so old run records parse. `CEZ_DRY_RUN=1` must keep working (bundled mock, no real CLI). Tool access is default-deny via `allowedTools`. |
| HTTP server & API routes | `src/server/server.ts` | Hono app, binds to `127.0.0.1` only. Every mutating route validates its body with a zod `safeParse` and returns `{ error }` with 400/404/409 — follow that pattern exactly. CORS is deliberately enabled for `/api/health` only (bookmarklets); never widen it. SSE endpoints replay from NDJSON then stream live, deduped by `seq`. |
| Git / worktree logic | `src/git-worktree.ts`, `src/server/git.ts` | One worktree per task at `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` off the configured base branch. Helpers never throw (except `createWorktree`) — degradation is the caller's policy. Diffs are capped (`DIFF_CAP`). Orphaned worktrees are pruned at startup. |
| GitHub integration (issues/PRs tab, draft PRs) | `src/server/github.ts`, `src/server/pr.ts` | Must degrade gracefully: no `gh`, no remote, offline all return `{ available: false, reason }` — never an error. `gh … --json` output is zod-validated at the boundary. `GITHUB_TOKEN` is the fallback when `gh` isn't authenticated. `createDraftPr` never throws; failures map to one-line human errors. `CEZ_DRY_RUN=1` fakes the PR URL. |
| Workflows (YAML chains, steps, retries) | `src/workflows/types.ts`, then `src/workflows/load.ts`, `src/workflows/run.ts` | A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an *earlier* step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete. |
| Skills (Markdown playbooks, team repos) | `src/skills.ts`, `src/skills-remote.ts` | A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); its body becomes the agent's extra system prompt. Discovery precedence is local-first: `.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → global → team repo. Missing dirs are fine; team-skill loading never blocks on the network (background cache in `~/.cache/cez/`). |
| Runs store / state persistence | `src/runs/store.ts` | Plain files in `.ai/cezar/`, no DB: `runs.json` index (zod-validated, atomic tmp+rename, debounced save) plus one append-only NDJSON event file per run. New `RunRecord` fields must be optional so old files still parse; corrupt files degrade to fresh, never crash. The store is also the in-process event bus for SSE. |
| Web UI (cockpit) | `web/app.js`, `web/index.html`, `web/style.css` | Vanilla JS, no framework, no bundler, no build step — files are served as-is and read per request in dev. One `state` object, fetch + EventSource, SSE events deduped by `seq`. Dark/light theme must keep working. Do not introduce a build tool or dependency. |
| Feature specs / design history | `.ai/specs/` (000–012) | Numbered specs are the design record — code comments cite them (`spec 006`, `#348`). Read the relevant spec before changing a feature it covers; keep new work consistent with it or update the spec. |

## Validation

Before any commit or PR, run in order:

```bash
npm run typecheck                    # tsc --noEmit
npm run test:unit                    # fast node:test coverage of core modules
npm run build                        # tsc → dist/
npm run test:e2e                     # pack/install and exercise the built CLI
npm pack --dry-run --ignore-scripts  # verify the release tarball contents
```

`CEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual verification.

## Related documents

- `SDLC.md` — ticket flow, label state machine, QA gate, claim protocol.
- `CODE_REVIEW.md` — what reviewers check and how severities are assigned.
- `BACKWARD_COMPATIBILITY.md` — the public surfaces you must not break silently.
- `.ai/agentic.config.json` — machine-readable pipeline config every om-* skill reads (base branch, validation commands, labels).
