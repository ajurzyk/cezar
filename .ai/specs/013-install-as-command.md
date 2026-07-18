# 013 — `install-as-command`: global `cezar` from a local checkout (no publish)

Status: READY (spec complete, reviewed) · Wave: — · Depends on: 001 (packaging/`npx`)

## TLDR

Add npm scripts that build the local checkout and put a global `cezar` / `cez` /
`cezar-cli` command on the developer's PATH pointing at *this working tree* — the
local-dev equivalent of `npx cezar-cli`, with no publish and no `npx` download.
Two flavors: **link** (default — live symlink, `npm run build` refreshes it) and
**global snapshot** (self-contained copy that survives moving the checkout), plus
a one-command **uninstall**. The README's local-setup story is rewritten so a
fresh clone reaches a working global `cezar` end-to-end.

Decisions (resolved): install mechanism = **both** link + snapshot; command
names = **`cezar` + `cez` + `cezar-cli`**; ship an **uninstall** script too.

## Problem Statement

A contributor hacking on cezar can run it from the checkout with `npm run dev`
(Vite + `tsx src/index.ts` — the dev-server flavor, not the packed CLI) or
`npm run dev:server`. Neither gives them the **real built CLI on their PATH**
that they can invoke inside *any other repo on the machine* — which is exactly
how end users experience cezar (`npx cezar-cli` in some unrelated project).

Today the only way to get that is to publish to npm and `npx cezar-cli`, or hand-
roll `npm link`. So contributors can't cheaply dogfood an unpublished change
against their real repos, and the README's "Development" section stops at
in-checkout scripts — it never shows the end-to-end path from `git clone` to a
usable global `cezar`.

## Proposed Solution

One pure planner module + one cross-platform orchestrator script, wired to three
npm scripts, plus a rewritten README section.

The key enabling change: **add `cezar-cli` to the main package's `bin` map**
(`"cezar-cli": "dist/index.js"`). This is what lets a *single* `npm link` or
`npm install --global .` of the main package expose all three command names from
the local build — no dependency on the published registry, identical behavior in
both link and snapshot modes. The separate `alias-cezar/` package stays untouched;
it continues to serve the *published* `npx cezar-cli` path. (Additive, non-breaking
— see Risks.)

npm scripts:

| Script | Action | When |
| --- | --- | --- |
| `install-as-command` | build → `npm link` | Default. Live dev loop: after the first link, a plain `npm run build` refreshes the global command; no relink. |
| `install-as-command:global` | build → `npm install --global .` | Self-contained snapshot. Survives moving/deleting the checkout; a source change needs re-running this script. |
| `uninstall-as-command` | `npm rm --global @open-mercato/cezar` | Removes whichever flavor is installed (both register globally under the package name). Best-effort, idempotent. |

Alternatives considered and rejected:
- **Link/globally-install the `alias-cezar/` shim to get `cezar-cli`.** Its bin
  `import()`s `@open-mercato/cezar`; resolving that to the *local* build requires a
  3-step link chain (link mode) and is impossible without publishing in snapshot
  mode (`npm i -g ./alias-cezar` pulls the dependency from the registry). The
  additive-bin approach avoids all of it.
- **Have the script mutate `package.json` to inject the bin only locally.** Dirty
  working tree, easy to commit by accident. Rejected.
- **A dedicated `cezar install-as-command` CLI subcommand.** Wrong altitude —
  this is a repo dev task (needs the checkout + build toolchain), not something a
  packaged end-user runs. Keep it an npm script.

### Research — how peers document local installs

`npm link` is the ecosystem-standard "use my checkout globally" primitive; the
snapshot flavor (`npm install --global .`) is the direct analog of
`cargo install --path .` / `pipx install -e .` / `go install`, and the live-link
flavor mirrors those tools' editable dev loop — offering both, named clearly,
matches contributor expectations. The one lesson worth stealing: all of them put
the **PATH / prefix caveat** front and center, so the README rewrite leads with a
troubleshooting block instead of leaving EACCES / "command not found" as a
surprise.

## Architecture

- **`src/install-as-command.ts`** (new, pure, unit-tested — mirrors the
  `pack-check.ts` split): exports
  - `planInstall({ mode: 'link' | 'global' | 'uninstall', build: boolean })` →
    ordered list of `{ cmd, args, cwd }` command specs (build step + npm
    link/install/rm), so the decision logic is testable without touching a real
    global prefix.
  - `globalShimPaths(prefix, platform)` → the expected shim file paths for **all
    three** commands (`<prefix>/bin/{cezar,cez,cezar-cli}` on POSIX;
    `<prefix>\{cezar,cez,cezar-cli}.cmd` on Windows) for the post-install
    verification + PATH hint. `prefix` is resolved at runtime via `npm prefix -g`
    (spawned by the orchestrator and passed in, so the module stays pure/testable).
- **`scripts/install-as-command.mjs`** (new, self-contained orchestrator): parses
  `--mode`/`--no-build`, runs the build via npm first (so `dist/` — including the
  planner module and `web/dist/` the cockpit needs — exists), then
  `import()`s `../dist/install-as-command.js`, executes the plan via `spawn`,
  verifies the expected shim exists, and prints the resolved global bin dir plus a
  PATH hint. Uses the **same cross-platform spawn pattern as `scripts/dev.mjs` /
  `scripts/check-pack.mjs`** (`process.env.npm_execpath` + `process.execPath`, no
  `.cmd` shim assumptions). `uninstall` skips the build and needs no dist import.
- **`package.json`**: add the `cezar-cli` bin entry; add the three `scripts`
  entries above.

What is reused vs new: reuses the existing `npm run build` pipeline verbatim (no
new build path), the npm bin mechanism (no hand-rolled shims), and the established
cross-platform spawn idiom. New surface is one small pure module + one script +
three script aliases + docs.

## Data Model

None. No persisted state, no config keys, no `.ai/cezar/` changes.

## API / Contract Changes

- **`package.json` `bin`** gains `cezar-cli` (additive). No entry removed or
  repointed; `cezar` and `cez` stay `dist/index.js`.
- **npm scripts** gain `install-as-command`, `install-as-command:global`,
  `uninstall-as-command` (additive).
- No HTTP/SSE/CLI-command/flag/exit-code changes. No workflow/skill/config format
  changes.

## Local Development (README) — the e2e deliverable

Rewrite the README **Development** section into a **Local development** section
that reads top-to-bottom for a fresh clone:

1. **Prerequisites** — Node 20+, git; (the agent-CLI prerequisites already
   documented in Quick start, linked not repeated).
2. **Clone & install** — `git clone … && cd cezar && npm install`.
3. **Build** — `npm run build` (what it produces: `dist/`, `web/dist/`).
4. **Install as a global command** —
   ```bash
   npm run install-as-command          # live link (default)
   #   or: npm run install-as-command:global   # self-contained snapshot
   ```
   then `cd` into *any other repo* and run `cezar` (or `cez` / `cezar-cli`).
5. **The change loop** — link mode: edit source → `npm run build` → the global
   command reflects it (no relink). Snapshot mode: re-run
   `install-as-command:global`.
6. **Uninstall** — `npm run uninstall-as-command`.
7. **Troubleshooting** — PATH doesn't include the npm global bin dir (print/hint);
   `EACCES` on a root-owned global prefix (set a user-writable prefix, e.g.
   `npm config set prefix ~/.npm-global`; **never** sudo — consistent with
   `server-install`'s no-auto-sudo stance); how this interacts with a real
   published `npm i -g @open-mercato/cezar` (link/install replaces it; uninstall
   removes ours; reinstall the published one normally).
8. Keep the existing in-checkout script table (`npm run dev`, `test`, `typecheck`,
   …) directly beneath, so both "run from the checkout" and "install globally"
   flows live in one section.

Also add a one-line pointer from **Quick start** ("Contributing? See Local
development for a global command off your checkout, no publish needed").

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
| --- | --- |
| Global prefix not user-writable (`EACCES`) | npm fails; script surfaces a clear message + the `npm config set prefix …` fix; non-zero exit. Never auto-sudo. |
| npm global bin dir not on PATH | Command "installed" but `cezar` not found; script prints the resolved bin dir + a PATH-export hint after a successful link/install. |
| Windows | Verification checks `cezar.cmd` (npm-generated shim); spawn pattern already `.cmd`-safe. |
| `--no-build` with no `dist/` (link mode) | Fail fast: "no build found — run without `--no-build` first." |
| Stale link after moving/deleting the checkout (link mode only) | Global `cezar` errors on the dangling target; fix = re-run `install-as-command` or `uninstall-as-command`. Snapshot mode is immune (documented as the trade-off). |
| Collision with a published global `@open-mercato/cezar` | link/global-install replaces it (npm's own behavior); `uninstall-as-command` removes ours; documented. |
| Re-running install (already linked) | Idempotent — npm relinks; no error. |
| `uninstall-as-command` when nothing is installed | Idempotent no-op success: `npm rm --global` of an absent package is treated as success; the script does not hard-fail. |

## Risks & Impact Review

- **Blast radius:** additive only — a new pure module, a new script, three npm
  script aliases, one added bin, and docs. No runtime code path of the shipped CLI
  changes.
- **Public surface:** adding `cezar-cli` to the published package's `bin` means
  `npm i -g @open-mercato/cezar` would *also* expose `cezar-cli`. This is additive
  and consistent with the README already advertising `cezar-cli`; per
  `BACKWARD_COMPATIBILITY.md` adding a bin is non-breaking (only *removal* is).
  Flag it in the PR body regardless so the maintainer signs off.
- **Test touchpoint:** `test/e2e/package-cli.test.ts` asserts the `cezar`/`cez`
  bins by key (no exact-count assertion), so the addition is safe; extend it to
  also assert `manifest.bin['cezar-cli'] === 'dist/index.js'`.
- **Rollback:** revert the PR — nothing installed on a user's machine is affected;
  a contributor who ran the script removes the global command with
  `npm run uninstall-as-command` (or `npm rm -g @open-mercato/cezar`).

## Phasing & Implementation Plan

Each step leaves the app building and green.

### Phase 1 — Mechanism (script + wiring)

- **1.1** Add `"cezar-cli": "dist/index.js"` to `package.json` `bin`. Extend
  `test/e2e/package-cli.test.ts` to assert the new bin. (`npm run build`,
  `npm run test:package` green.)
- **1.2** Add `src/install-as-command.ts` — pure `planInstall()` +
  `globalShimPaths()` — with a colocated **vitest** unit test
  `src/install-as-command.test.ts` (matching the `src/pack-check.test.ts` /
  `src/config.test.ts` convention — `npm test`, not the `node:test`
  `test/unit/` suite) covering link, global, uninstall, `--no-build`, and
  POSIX-vs-Windows shim paths. (`npm run typecheck`, `npm test` green.)
- **1.3** Add `scripts/install-as-command.mjs` — build → import planner → exec →
  verify shim → print bin dir + PATH hint; cross-platform spawn per `dev.mjs`.
- **1.4** Wire the three npm scripts (`install-as-command`,
  `install-as-command:global`, `uninstall-as-command`).
- **1.5** Manual smoke on this machine: link → `cd` to another repo → `cezar
  --help`, `cezar-cli --help`, `cez --help`; edit source → `npm run build` →
  change reflected; `install-as-command:global` snapshot path; then
  `uninstall-as-command`. Record results in the PR.

### Phase 2 — Docs (the e2e local-dev story)

- **2.1** Rewrite README **Development** → **Local development** per the section
  above (clone → install → build → install-as-command → use anywhere → change
  loop → uninstall → troubleshooting), keeping the in-checkout script table.
- **2.2** Add the Quick-start pointer line; re-read the diff for scope creep.

## Non-goals

- No migration of `.cez/`/data, no config keys, no telemetry.
- No change to the published `alias-cezar/` package or the `npx cezar-cli` path.
- No auto-sudo / no writing to root-owned prefixes.
- Not a packaged end-user feature — this is a contributor/dev-loop tool.
