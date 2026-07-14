# Backward compatibility

Protected contract surfaces of this repository, and the required path for changing one. Review skills check diffs against this file; implementation skills must warn when a change violates it. cezar is distributed on npm (`@pat-lewczuk/cezar`, run via `npx cezar-cli`), so users upgrade independently of this repo — anything they invoke, script, or leave on disk is a contract.

## Protected surfaces

### 1. CLI commands and flags (`src/index.ts`)

The `cezar` / `cez` binaries, their subcommands (e.g. `run`), and documented flags (`-p/--port`, `--workflow`, `--model`, …).

- **Breaking**: removing/renaming a command or flag, changing a default in a way that alters behavior, changing exit codes or machine-read output.
- **Required path**: keep the old name as an alias for at least one minor release, print a deprecation note to stderr, document in the release notes.

### 2. On-disk state under `.ai/cezar/` (`src/runs/store.ts`, `src/handoff.ts`, `src/todos.ts`, `src/server/launch-key.ts`)

Run records, NDJSON transcripts, handoff/todo Markdown, the launch key. The README promises this state is plain-text and hand-editable, and it survives upgrades on users' machines.

- **Breaking**: renaming/moving files, changing JSON/NDJSON field meanings, or making a new version unable to read state written by an older one.
- **Required path**: new readers must tolerate old files (missing fields get defaults; unknown fields are preserved or ignored, never a crash). A migration must be automatic and one-way-safe; call it out in release notes.

### 3. HTTP API (`src/server/server.ts`)

The `/api/*` routes and response shapes. Primary consumer is the bundled `web/app.js`, but bookmarklets (spec 011) and users' local scripts also hit these endpoints.

- **Breaking**: removing a route, changing a response shape, adding a required request field, changing `/new` query parameters or the `/api/launch-key` contract.
- **Required path**: server and `web/` change together in the same PR; for surfaces referenced by bookmarklets or specs, keep the old behavior working for one minor release.

### 4. Workflow YAML and skill discovery (`src/workflows/types.ts`, `src/skills.ts`, `src/skills-remote.ts`)

Users keep workflow YAML files and Markdown skills in their repos (`.ai/skills`, workflow files).

- **Breaking**: a schema change that makes an existing workflow file fail to parse, or a discovery change that stops finding previously-found skills.
- **Required path**: parse old shapes with defaults and a warning; never hard-fail on fields an older version accepted.

### 5. npm package surface (`package.json`)

Package name, `bin` names (`cezar`, `cez`), published `files` (`dist`, `web`, `scripts`), `engines` (Node >= 20).

- **Breaking**: renaming binaries, dropping published files other tooling references, raising the Node floor.
- **Required path**: semver — a major (or clearly announced minor pre-1.0) bump plus release notes.

## Cockpit UI redesign waiver (spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`)

The UI redesign is a deliberate generational change (approved 2026-07-14): while its phases R1–R7 land, backward compatibility MUST NOT constrain the redesign's outcome. During the program, on top of the "Not protected" list below:

- **Waived**: the `web/` asset layout and everything the browser consumes (markup, CSS, JS, fonts), the npm tarball's `web/` layout (moves to built `web/dist`), `/api` **response shapes gaining fields** (always allowed) and **internal-only endpoints whose sole consumer is the bundled UI** — these may be reshaped or replaced in the same PR that updates the UI, with a line in the release notes. New NDJSON event types (protocol v2) are additive by design.
- **Still protected — the redesign works around these, never through them**: CLI commands/flags (§1); *readability* of existing on-disk state (§2 — a new version must still open old `runs.json`/NDJSON transcripts; v1 event types stay parseable even after v2 ships); the `/new` bookmarklet query contract and `/api/launch-key` (§3, spec 011); workflow YAML and skills formats (§4); config file keys (§5 additive-only).
- **Required path for each waived break**: called out in the phase PR body under "Breaking changes", release-notes entry, minor version bump (pre-1.0). No deprecation window required.

The waiver expires when phase R7 merges; afterwards this document returns to full force with the then-current surfaces.

## Not protected

- Internal module structure under `src/` (imports between modules may change freely).
- Cockpit UI layout/markup in `web/` (behavior contracts above still apply).
- `.ai/cezar/` files explicitly documented as ephemeral (locks, temp worktree dirs).
- Anything in `.ai/tmp/`.

## Rule of thumb

If a user could have scripted it, bookmarked it, or left it on disk before upgrading — it's a contract. When in doubt, treat it as protected and provide the deprecation path, or flag it as a `WARNING: breaking` in the PR body and summary comment so a human decides.
