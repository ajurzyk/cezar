# AGENTS.md — working in this repository

cezar is a **parallel coding-agents orchestrator**: a local cockpit (CLI + browser GUI) for running and tracking AI coding-agent tasks in a repo. You type a task, pick a workflow and a backend — Claude Code, Codex or OpenCode, or a mix per step — and watch it work live: steps, tool calls, tokens, diffs. Each task runs in its own git worktree, ends at a review gate (never auto-merges), and can be pushed as a draft PR through `gh`. Everything is local: no accounts, no database, no cloud — state is plain JSON, NDJSON and Markdown under `.ai/cezar/`. The server stack stays deliberately small: strict TypeScript (ESM, Node 20+), Hono + SSE, Zod at every boundary, and YAML workflows. The cockpit is React 19 + Vite + Tailwind v4 + shadcn/ui, compiled to static assets (the legacy vanilla UI was retired in R7). Every module is meant to be read in one sitting.

## Zero config

cezar ships no config file the user must create and no setting they must set before it works. Every capability is discovered from what is already there — the repo, the environment, `gh`, the running processes — or it degrades quietly to a smaller cezar. `.ai/cezar/config.json` is optional and every key has a working default; `.env` is never auto-loaded.

New state may be **written**, never **required**: `.ai/cezar/`, `~/.cache/cez/`, `~/.cezar/`. Delete any of them and cezar rebuilds what it needs on the next run. State that a user must author, migrate, or repair is not state — it is configuration, and it needs a reason.

Practical rules:

- When a feature seems to need configuration, the design is wrong. Discover it, or default it.
- Features that widen exposure or cost (network, other processes) are opt-in behind a `CEZ_*` flag, off by default — the zero-config default is also the safe default.
- A missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit, never fail the boot.
- Prefer a proxy-free, daemon-free mechanism when one exists — and when it doesn't, keep the mechanism invisible: no process to manage, no port to remember, no file to edit.
- Never trade a working default for a knob.

## Task routing

| When the task involves… | Read first | Key rules |
|---|---|---|
| CLI entry, `serve`/`run`/`init` subcommands, flags | `src/index.ts` | Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file. |
| Agent runners / backends | `src/core/agent-runner.ts`, then `src/core/runner-factory.ts`, `src/core/claude-cli-runner.ts`, `src/core/codex-app-server-runner.ts`, `src/core/opencode-server-runner.ts`, `src/core/backend-detect.ts` | One seam: every backend implements `AgentRunner`/`AgentSession` and emits normalized `AgentEvent`s. New backends slot in as one class — do not leak backend-specific types past the seam. `claude-cli` is a legacy backend id kept so old run records parse. `CEZ_DRY_RUN=1` must keep working (bundled mock, no real CLI). Tool access goes through `allowedTools`, but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`) and Codex/OpenCode don't honor `allowedTools` at all — see #430. |
| HTTP server & API routes | `src/server/server.ts` | Hono app, binds to `127.0.0.1` only. Every mutating route validates its body with a zod `safeParse` and returns `{ error }` with 400/404/409 — follow that pattern exactly. CORS is deliberately enabled for `/api/health` only (bookmarklets); never widen it. SSE endpoints replay from NDJSON then stream live, deduped by `seq`. |
| Git / worktree logic | `src/git-worktree.ts`, `src/server/git.ts` | One worktree per task at `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` off the configured base branch. Helpers never throw (except `createWorktree`) — degradation is the caller's policy. Diffs are capped (`DIFF_CAP`). Orphaned worktrees are pruned at startup. |
| GitHub integration (issues/PRs tab, draft PRs) | `src/server/github.ts`, `src/server/pr.ts` | Must degrade gracefully: no `gh`, no remote, offline all return `{ available: false, reason }` — never an error. `gh … --json` output is zod-validated at the boundary. `GITHUB_TOKEN` is the fallback when `gh` isn't authenticated. `createDraftPr` never throws; failures map to one-line human errors. `CEZ_DRY_RUN=1` fakes the PR URL. |
| Workflows (YAML chains, steps, retries) | `src/workflows/types.ts`, then `src/workflows/load.ts`, `src/workflows/run.ts` | A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an *earlier* step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete. |
| Skills (Markdown playbooks, team repos) | `src/skills.ts`, `src/skills-remote.ts` | A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); its body becomes the agent's extra system prompt. Discovery precedence is local-first: `.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → global → team repo. Missing dirs are fine; team-skill loading never blocks on the network (background cache in `~/.cache/cez/`). |
| Runs store / state persistence | `src/runs/store.ts` | Plain files in `.ai/cezar/`, no DB: `runs.json` index (zod-validated, atomic tmp+rename, debounced save) plus one append-only NDJSON event file per run. New `RunRecord` fields must be optional so old files still parse; corrupt files degrade to fresh, never crash. The store is also the in-process event bus for SSE. |
| Web UI (cockpit) | `web/app/src/app.tsx`, then `web/app/src/routes.tsx`, `web/app/src/api/`, and the affected component/route | React 19 + Vite + Tailwind v4 + shadcn/ui; source lives in `web/app/`, build output in ignored `web/dist/`. Keep one global SSE connection and patch the TanStack Query cache in place; authoritative refetch happens on reconnect/visibility. Preserve light/dark/system theming, mobile safe areas, keyboard access, and unit coverage. The legacy vanilla web app was deleted in R7; when `web/dist` is missing the server answers every shell route with a built-in "run `npm run build:web`" hint page (`src/server/static-ui.ts`). |
| Feature specs / design history | `.ai/specs/` | Numbered and dated specs are the design record — code comments cite them (`spec 006`, `#348`). Read the relevant spec before changing a feature it covers; keep new work consistent with it or update the spec. |

## Validation

Before any commit or PR, run in order:

```bash
npm run typecheck   # tsc --noEmit (server + web)
npm test            # vitest — server + cockpit unit suites
npm run test:unit   # node:test — fast core-module coverage (test/unit/)
npm run build       # tsc → dist/, vite → web/dist/, then the check:pack tarball gate
npm run test:package # pack/install the release tarball and exercise the built CLI (test/e2e/)
```

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way. `npm run test:package` needs a completed `npm run build` (it packs the tarball).

The UI smoke suite is a **separate** command — it boots the real app and drives it in a real
Chrome through the `agent-browser` provider (`.ai/browsers/agent-browser.md`):

```bash
npm run test:e2e    # .ai/scripts/e2e.sh → test-env-up.sh + vitest (web/app/e2e/)
```

It boots the app on a free port with `CEZ_DRY_RUN=1` (agent CLIs mocked — no login, no
network), reuses an already-healthy instance instead of double-booting, and writes
`.ai/qa/test-env.json` so QA skills attach to the same instance. Stop it with
`.ai/scripts/test-env-down.sh`. Exit contract:

| Exit | Marker | Meaning |
| --- | --- | --- |
| 0 | `TEST_E2E_STATUS=passed` | every spec passed |
| 0 | `TEST_E2E_STATUS=skipped` | agent-browser could not be provisioned (no network / unsupported platform); prints a loud banner — **not** a pass |
| non-zero | `TEST_E2E_STATUS=failed` | a spec failed, or the env could not boot |

`CEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual verification.

## Related documents

- `SDLC.md` — ticket flow, label state machine, QA gate, claim protocol.
- `CODE_REVIEW.md` — what reviewers check and how severities are assigned.
- `BACKWARD_COMPATIBILITY.md` — the public surfaces you must not break silently.
- `.ai/agentic.config.json` — machine-readable pipeline config every om-* skill reads (base branch, validation commands, labels).
