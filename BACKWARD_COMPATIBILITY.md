# Backward compatibility — protected surfaces

cezar is a published npm CLI (`@pat-lewczuk/cezar`, currently 0.x) whose state lives as plain files inside users' repos. Users upgrade with `npx cezar@latest` against `.ai/cezar/` directories written by older versions, and they script the CLI and hand-edit the files — the README promises "plain JSON, NDJSON and Markdown you can `cat` and fix by hand." That promise is the compatibility contract.

**General rule for every surface below:** additive changes (new optional field, new flag, new route) are fine; anything that makes an existing input rejected, an existing output disappear, or an existing file unreadable is breaking. While the package is 0.x, a breaking change requires: a deprecation note in the README + CHANGELOG, a migration path (code that reads the old shape, or a documented manual fix), and a **minor** version bump called out as breaking. From 1.0 on, breaking = major bump.

## 1. CLI commands, flags and exit codes (`src/index.ts`)

- **Bins:** `cezar` and `cez` (both in `package.json` `bin`). Removing either alias is breaking.
- **Commands:** bare invocation = `serve` (cockpit); `cezar run "<task>"`; `cezar init`.
- **Flags:** `-p/--port` (default 4321, auto-picks the next free port), `--repo <dir>`, `--workflow <name>` (default `quick-task`), `--model <model>`, `--no-open`, `-h/--help`.
- **Exit codes:** `run` exits 0 on `done` **and** `review` (spec 009 — headless runs must not hang on the review gate), 1 on `failed`/`cancelled`/unknown workflow. CI scripts depend on this.
- **Env vars:** `CEZ_DRY_RUN`, `CEZ_CLAUDE_BIN`, `CEZ_CODEX_BIN`, `CEZ_OPENCODE_BIN`, `GITHUB_TOKEN`.

Breaking: renaming/removing a command, flag, alias or env var; changing a default (port, workflow); changing `run` exit-code semantics. Required path: keep the old spelling as a deprecated alias for at least one minor release, print a one-line deprecation warning, document the replacement.

## 2. HTTP API of the cockpit server (`src/server/server.ts`)

Consumed by the bundled React cockpit (`web/dist`, shipped in lockstep — low risk) but also by the **bookmarklets users have already saved in their browsers** (spec 011) and by anyone scripting `localhost:4321`. Routes:

- Static/GUI: `GET /` and every SPA shell route, `/new` (bookmarklet deep-link, query `?skill=&ref=&auto=&key=`), `/assets/:file`, `/open-mercato.svg`
- Meta: `GET /api/health` (the **only** CORS-open route — bookmarklets probe it cross-origin; its shape `{version, latestVersion, repoRoot, repo, checks, defaultRunner}` is the most externally-depended-on JSON in the app), `GET /api/launch-key`
- Skills: `GET /api/skills`, `POST /api/skills/refresh`
- Workflows: `GET/POST /api/workflows`, `DELETE /api/workflows/:name`, `POST /api/workflows/parse`, `POST /api/plan`
- Runs: `GET/POST /api/runs`, `GET /api/runs/:id`, `PATCH /api/runs/:id`, `POST /api/runs/:id/{cancel,messages,finish,continue,open-in-cli,open-in,pr,archive,remove-worktree,git/commit,git/push}`, `POST /api/runs/archive-finished`, `DELETE /api/runs/:id`, `GET /api/runs/:id/{handoff,diff,changes,files,commits,events}`, `GET /api/runs/:id/commit/:sha`, `GET /api/runs/:id/images/:file`
- Open-in: `GET /api/open-targets`
- Variants: `GET /api/groups/:groupId`, `POST /api/groups/:groupId/pick`
- Inbox: `GET /api/todos`, `DELETE /api/todos/:id`, `POST /api/todos/:id/start`
- SSE: `GET /api/events` (global), `GET /api/runs/:id/events` (replay + live, dedup by `seq`)
- Repo/GitHub: `GET /api/github`, `GET /api/repo`, `GET /api/repo/{diff,changes}`, `GET /api/repo/commit/:sha`, `POST /api/repo/branch`, `GET/PUT /api/config`, `GET/PUT /api/ui-state`
- Agent config (spec #404, additive): `GET /api/agent-config`, `GET/PUT /api/agent-config/:id` — writes 409 in hosted mode (`CEZ_REMOTE`) by design
- SSE event names: `run-event` (v1), `ui-event` (v2 dotted types)

Breaking: removing/renaming a route; making a previously optional body field required; removing a response field; changing an SSE event name (`run`, `run-event`, `run-deleted`, `todos`, `usage`, `ping`) or the `seq` dedup contract; narrowing `/api/health` CORS or its fields; changing `/new` query parameters (breaks saved bookmarklets). Required path: additive first; if removal is unavoidable, keep the old route/field answering for one minor release and note it in the CHANGELOG. `/api/health` and `/new` deserve extra caution — they live in users' browsers, not in this repo.

## 3. `.ai/cezar/` state files (`src/runs/store.ts` and friends)

Written by one version, read by the next, and hand-editable by design:

- **`runs.json`** — array of `RunRecord` (zod schema in `src/runs/store.ts`), atomic tmp+rename writes. New fields MUST be optional or defaulted (`archived` uses `.default(false)`); a required new field silently drops every pre-existing run because the loader `safeParse`s the whole array. The `runner` enum keeps legacy ids parseable (`claude-cli`) — follow that precedent.
- **`runs/<id>.ndjson`** — append-only event log, one JSON object per line with `seq`, `ts`, `type`, free extra keys. Readers skip bad lines. Never rewrite, reorder or re-number an existing file; event `type` strings are part of the format (GUI replay + `cezar run` console rendering).
- **`runs/<id>.handoff.md`**, **`runs/<id>-images/`** — Markdown journal and screenshots; deleted with the run.
- **`ui-state.json`** — GUI prefs; schema is `.passthrough()` so unknown keys survive round-trips. Keep it that way — never strip keys you don't know.
- **`config.json`** — user-owned (`src/config.ts`): missing/invalid degrades to defaults; the `PUT /api/config` handler merges into the raw file so user keys survive and defaults are never materialized. Renaming a key (`skillsRepos`, `maxParallel`, `defaultRunner`, `plannerModel`, `baseBranch`) or changing a default is breaking; accept the old key as an alias during migration.
- **`todos.json`**, **`launch-key`** — inbox entries (spec 007) and the bookmarklet secret.
- **`.gitignore`** — maintained by `ensureDataGitignore` in `src/index.ts`; any new run-data file must be added there in the same PR.

Breaking: any change that makes an existing file unparseable, silently discarded, or rewritten into a new shape without reading the old one. Required path: read old + new shapes for at least one minor release (a lazy upgrade-on-read is fine since writes go through the schema), or ship an explicit migration; never require the user to delete `.ai/cezar/`.

## 4. Workflow YAML format (`src/workflows/types.ts`)

Users commit these files (`.ai/cezar/workflows/*.yaml`) and share them across repos — the compact `skills:` form exists specifically to be portable. Protected shape: `name`, `description?`, and `steps` XOR `skills`; per step `id`, `name?`, agent fields (`prompt`, `skill`, `model`, `runner`, `allowedTools`, `bashAllowlist`) XOR check fields (`command`, `onFail: {retry, max}`); the `{{task}}` token; `onFail.retry` referencing an earlier step; the built-in `quick-task` name.

Breaking: renaming a key, tightening a refinement so previously valid files fail to load, changing `{{task}}` substitution, changing `onFail` semantics (retry target, `max` default of 2), or removing a `runner` value. Note the loader already degrades per file (bad files are reported in `issues` and skipped, `cezar run` prints `! skipped …`) — but "your existing workflow is now skipped" is still a break. Required path: accept the old spelling alongside the new, and have `POST /api/workflows` keep writing the most portable form.

## 5. Skills Markdown format (`src/skills.ts`)

A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); the body becomes the agent's extra system prompt. Protected: frontmatter keys; the `SKILL.md`-in-a-directory convention; the discovery locations and their precedence (`.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → `~/.agents/skills`, `~/.claude/skills` → team repos); name-collision resolution ("the user's repo is the source of truth"); the `config.json` `skillsRepos` source shape (`{repo, ref}` — GitHub shorthand, git URL, or local path).

Breaking: requiring frontmatter, dropping a discovery directory, or inverting precedence so a team skill shadows a local one. Required path: additive discovery only; a precedence change needs a README callout and a minor bump.

## 6. npm package surface (`package.json`)

- Name `@pat-lewczuk/cezar` (plus the `cezar-cli` npx alias documented in the README); `bin` entries `cezar` + `cez`; published `files`: `dist`, `web/dist`, `web/open-mercato.svg`, `scripts`, `README.md`; `engines.node >= 20`; `"type": "module"`.
- There is **no** `exports`/library API — the package is CLI-only. Keep it that way deliberately: adding one creates a new compatibility surface; if it happens, this document gains a section first.
- `dist/index.js` must remain the bin entry, and `web/` must stay resolvable relative to `dist/server` (`resolveWebDir` walks `../../web`; the built cockpit lives at `web/dist`).
- The tarball MUST contain the built UI (`web/dist/index.html` + hashed `web/dist/assets/*`) — `npm run check:pack` (`scripts/check-pack.mjs`, run as the last leg of `npm run build`, hence by `prepublishOnly`) enforces this; do not remove it from the build chain.

Breaking: dropping a bin alias, raising `engines.node`, removing `web/dist/` or `scripts/` from `files`, renaming the package. Required path: raise `engines` only in a version bump flagged as breaking; keep old aliases through a deprecation release.

## Cockpit UI redesign waiver (spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`) — EXPIRED at R7

**Status: expired as of phase R7 (2026-07-15).** The waiver below covered the redesign program R1–R7 and, per the spec's compatibility policy, expires at R7. It is kept for the historical record only — the surfaces it waived (the `web/` asset layout, the npm tarball layout, internal-only `/api` shapes whose sole consumer is the bundled UI) are back under this document's normal rules, as restated in sections 1–6 above with their post-redesign shapes (built `web/dist`, no legacy `web/app.js`).

The UI redesign was a deliberate generational change (approved 2026-07-14): while its phases R1–R7 landed, backward compatibility MUST NOT constrain the redesign's outcome. For the duration of the program:

- **Waived**: the `web/` asset layout and everything the browser consumes (markup, CSS, JS, fonts); the npm tarball's `web/` layout (moves to built `web/dist` — `resolveWebDir` is updated in the same PR); `/api` **response shapes gaining fields** (always allowed) and **internal-only endpoints whose sole consumer is the bundled UI** — these may be reshaped or replaced in the same PR that updates the UI, with a line in the release notes. New NDJSON event types (protocol v2) are additive by design.
- **Still protected — the redesign works around these, never through them**: CLI commands, flags and exit codes; *readability* of existing `.ai/cezar/` state (a new version must still open old `runs.json`/NDJSON transcripts; v1 event types stay parseable after v2 ships); the `/new` bookmarklet query contract and `/api/launch-key`; workflow YAML and skills Markdown formats and discovery; `config.json` keys (additive only); the npm bin entries and package name.
- **Required path for each waived break**: called out in the phase PR body under "Breaking changes", release-notes entry, minor version bump (pre-1.0). No deprecation window required.

The waiver expired when phase R7 landed; this document is back in full force with the then-current surfaces described above.

## When in doubt

If a change might break any surface above, say so in the PR description, label the PR `risk-high`, and route it through the review + QA gates in `SDLC.md`. A silent break found in review is a blocker per `CODE_REVIEW.md`.
