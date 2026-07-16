# Server installer & uninstaller

## TLDR

A dependency-free interactive wizard — `npx @pat-lewczuk/cezar server-install --platform <id>` — that turns a bare Ubuntu/Debian VPS (or a local macOS box fronted by ngrok) into a running, reachable, authenticated cezar server in one sitting, and a matching `server-uninstall` that reverses every change it made. The wizard is **modularized by platform strategy** (`ubuntu-vps`, `macosx-ngrok`, …): a shared engine drives the flow and each strategy declares its own ordered steps, so a third platform is "declare steps", not "re-solve UX". It is **idempotent and resumable** (progress persisted to `~/.cezar/server.json`), **sudo-aware** (it never runs a privileged command silently — it prints the exact command, asks whether to run it under `sudo` or hand it to the operator, then verifies the result before advancing and offers a redo), and **install-once per host** (the OS-level proxy, TLS and autostart service are shared by every repo instance, matching multi-instance mode where the first cezar proxies the rest).

Resolved design decisions (drafting gate): **one cohesive spec**, phased; TUI on **`@clack/prompts`** (first blessed exception to the small-stack rule, installer-only); identity is the **nginx Basic-auth / htpasswd** layer (ngrok's built-in basic-auth on macOS), cezar itself stays loopback-bound and unchanged; commands are **subcommands on the existing `cezar` bin**.

## Problem Statement

cezar is built for a developer laptop, and every assumption in that build is wrong for a server:

- `npx cezar` binds `127.0.0.1` and is meant to (`src/server/server.ts:1277` — "binding to a non-loopback host would expose an agent-executing box to the network"). On a VPS that means the cockpit is unreachable until something terminates TLS and authenticates in front of it. Nothing in the repo sets that up.
- It uses your **already-logged-in** `claude`/`codex`/`gh`. A fresh VPS has none of them. `detectEnvironment()` (`src/core/backend-detect.ts`) already *detects* what is missing and prints install hints — but nothing acts on those hints; the operator is left to copy-paste for each tool and then figure out the auth dance (`claude` interactive login, `gh auth login`, Codex/OpenCode provider setup).
- Surviving a reboot, getting a domain + cert, and gating access to a box that runs coding agents with your credentials are all manual, undocumented, and — critically — **irreversible by any tool cezar ships**. There is no "undo" for a half-configured server.

Evidence it matters: the codebase already carries the seams for hosted operation — `bindHost`, `CEZ_REMOTE` hosted-mode gating (`server.ts:231`, `:698`), the multi-project `~/.cezar` registry and loopback proxy (PR #406) — but there is no on-ramp that assembles them on a real machine. The brief is that on-ramp: a guided, resumable, reversible wizard whose only prerequisites are `node` and `npx`.

## Proposed Solution

A **strategy-driven install engine** with a **reusable interactive step vocabulary**.

`server-install --platform ubuntu-vps` resolves a `PlatformStrategy` from a registry, asks it for an ordered list of `InstallStep`s, and runs them through the engine. The engine persists a `StepOutcome` to `~/.cezar/server.json` after every step, so a re-run **resumes at the first step not yet `done`**. Each step is a small object with `id`, `title`, a `check()` (already satisfied? → skip), a `run(ctx)` (do it, interactively), and — for anything it created — an `undo(ctx)` used by `server-uninstall`.

The interactive vocabulary is the part the brief calls "shared helpers", and it is what makes the next platform cheap:

- **`sudoStep`** — the load-bearing helper. The wizard always runs as a normal, non-privileged account. When a step needs root it does **not** silently `sudo`. It prints the exact command, and offers: **(1)** run it now via `sudo` (the wizard shells out, streams output), or **(2)** "I'll run it myself" — the wizard prints a copy-paste block, waits, and on confirmation runs the step's `verify()` to prove the box is actually in the expected state. If `verify()` fails, it shows the diff between expected and actual and offers **redo**. No step advances on an operator's word alone — only on a passing `verify()`.
- **`select` / `checkbox` / `confirm` / `text` / `password` / `spinner`** — thin typed wrappers over `@clack/prompts` with cancel handling routed to a clean, resumable exit (Ctrl-C mid-install is a valid state, not a crash).
- **`verifyCommand(cmd, matcher)`** — run a probe, assert its output; the shared assertion behind both `check()` (skip-if-done) and `sudoStep` verification.

Reusing `detectEnvironment()` verbatim gives the dependency step for free: it already returns per-tool `available` + `hint`. The wizard shows the missing ones as a **checkbox list**, installs the selected, and — because agent CLIs need interactive auth that a wizard cannot fully automate — prints the exact authorization instruction per tool (`claude` → run once and log in; `gh auth login`; Codex/OpenCode provider setup) and verifies auth landed before moving on.

**`server-uninstall`** loads the recorded state and walks the completed steps **in reverse**, calling each `undo(ctx)`. Because every step recorded *what it created* (the systemd unit name, the nginx vhost path, the cert domain, the htpasswd file), uninstall removes exactly that and nothing else — each destructive action confirmed, each also `verify()`-checked.

**Two undo classes — `owned` vs `shared`.** Not everything a step installs is cezar's to remove. Each `StepCreated` is tagged:

- **`owned`** — config cezar authored and nothing else uses: the nginx vhost, the htpasswd file, the systemd/launchd unit, the `CEZ_REMOTE` service env. Uninstall *removes* these.
- **`shared`** — system tools an operator may now depend on independently: `gh`, the agent CLIs (`apt`/`npm -g`), the `certbot` package and the **global cert-renewal timer it installs**. Uninstall does **not** `apt remove` / `npm rm -g` these — it **lists them and prints the manual removal commands**, leaving the choice to the operator. The obtained certificate itself is left in place (removing it can break other vhosts); uninstall removes only cezar's vhost reference to it.

This is why "removes exactly what was added" is precise, not reckless: the `owned`/`shared` tag on each `created` record is what draws the line.

### Why this shape, and not the alternatives

**Rejected — a `curl | bash` shell installer (the Coolify/CapRover/k3s pattern).** It is the market default, but it throws away cezar's single biggest advantage: the box already has `node`. A Node engine gives us typed steps, a structured resumable state file, real `verify()` logic, and *the same code path for install and uninstall* — none of which bash gives without pain. It would also be a second language to maintain beside the whole TypeScript codebase.

**Rejected — Caddy for auto-HTTPS instead of nginx + certbot.** Caddy is objectively less work (automatic certs, one-line config). But the brief mandates nginx + htpasswd as the only `ubuntu-vps` proxy for now, and the strategy seam means Caddy can be added later as `ubuntu-vps-caddy` without touching the engine. Noted as the obvious future strategy.

**Rejected — hand-rolled ACME.** `server-install` shells out to `certbot --nginx`, which edits the vhost in place *and* installs its own renewal timer. Re-implementing ACME or cert renewal would be strictly worse than the tool every distro ships.

**Rejected — auto-`sudo` / re-exec as root.** Silently escalating on a box that runs coding agents with the user's credentials is exactly the wrong instinct. The operator-in-the-loop `sudoStep` is slower by design and safer by design, and it is the only way to honor "let the user know and ask if they want us to run this with sudo or run it themselves."

## Architecture

### Components

| Component | File | Responsibility |
|---|---|---|
| Path helper | `src/paths.ts` (shared — see coordination) | `cezarHomeDir()` → `CEZ_HOME ?? ~/.cezar`; add `serverStatePath()`. |
| Server state | `src/server-install/state.ts` (new) | Read/write/validate `~/.cezar/server.json` (zod, atomic tmp+rename, `0600`). Idempotency + resume live here. |
| Engine | `src/server-install/engine.ts` (new) | `runInstall(strategy, ctx)` / `runUninstall(strategy, ctx)`: iterate steps, skip via `check()`, persist each `StepOutcome`, resume from state. Pure control flow — no I/O of its own. |
| Step + strategy contract | `src/server-install/types.ts` (new) | `InstallStep`, `StepOutcome`, `PlatformStrategy`, `InstallContext`. The seam every backend closes over. |
| Interactive helpers | `src/server-install/ui.ts` (new) | `select`/`checkbox`/`confirm`/`text`/`password`/`spinner`/`note` over `@clack/prompts`; unified cancel → clean resumable exit. |
| Step helpers | `src/server-install/steps.ts` (new) | `sudoStep`, `verifyCommand`, `installPackageStep`, `depCheckStep` (wraps `detectEnvironment`). Platform-agnostic. |
| Strategy registry | `src/server-install/strategies.ts` (new) | Map `platform` id → `PlatformStrategy`; `--platform` validated against it (unknown id → list valid ids, exit 1). |
| ubuntu-vps strategy | `src/server-install/platforms/ubuntu-vps.ts` (new) | Ordered steps: deps → nginx+htpasswd → optional LE domain/SSL → optional systemd autostart → identity verify. |
| macosx-ngrok strategy | `src/server-install/platforms/macosx-ngrok.ts` (new) | Steps: deps → ngrok authtoken + reserved domain + basic-auth → launchd autostart. |
| CLI wiring | `src/index.ts` (edit) | `server-install` / `server-uninstall` commands + `--platform`; help text. |
| npm script | `package.json` (edit) | `"server-install": "tsx src/index.ts server-install"` for testing from a git checkout. |

### The strategy seam (the whole point of "modularized")

```ts
// src/server-install/types.ts
export interface InstallContext {
  state: ServerState;                 // live, persisted after each step
  ui: Ui;                             // the @clack wrappers
  save(): Promise<void>;              // atomic write of state
  dryRun: boolean;                    // CEZ_DRY_RUN — no real sudo/network
}

export interface InstallStep {
  id: string;                         // stable — the key in server.json
  title: string;                      // shown in the wizard
  optional?: boolean;                 // user may skip (SSL, autostart)
  check(ctx: InstallContext): Promise<boolean>;   // true ⇒ already done, skip
  run(ctx: InstallContext): Promise<StepCreated>; // do it; return what was created
  undo(ctx: InstallContext, created: StepCreated): Promise<void>; // reverse it
}

export interface PlatformStrategy {
  id: 'ubuntu-vps' | 'macosx-ngrok';
  label: string;
  preflight(ctx: InstallContext): Promise<void>;  // OS/arch/privilege sanity
  steps(ctx: InstallContext): InstallStep[];      // ordered
}
```

The engine never knows what a step *does* — only `check`/`run`/`undo`. That is what lets "use ubuntu as a selector and run it that way" be literally `strategies.get('ubuntu-vps')`, and what makes the shared helpers reusable across every future platform.

### Deployment topology (ubuntu-vps)

```
Internet ──443/80──► nginx (TLS via certbot, auth_basic htpasswd)
                        └─proxy_pass──► 127.0.0.1:4321  (cezar serve, CEZ_REMOTE=1, loopback)
                                          └─ (multi-instance) /p/<id>/* ──► other repo instances
```

cezar **stays loopback-bound** — the installer never sets `bindHost` to a public address and never flips the server to `0.0.0.0`. nginx is the single public surface; it terminates TLS, enforces htpasswd identity, and forwards to loopback. The service is started with `CEZ_REMOTE=1` so the local-handoff endpoints self-gate (`server.ts:698`). This keeps the `server.ts:1277` loopback guarantee intact — the box that runs agents with your credentials is never directly exposed. macOS is the same shape with ngrok in place of nginx+certbot and ngrok basic-auth in place of htpasswd.

### Multi-instance: install-once

The OS-level pieces (nginx vhost, cert, systemd/launchd unit) are **host-level and installed once**, keyed by a top-level `installed: true` in `~/.cezar/server.json`. This matches PR #406 (multi-project): the first cezar owns the loopback reverse proxy at `/p/<id>/*`, and nginx only ever needs to forward to that one primary port (default 4321). A second repo's `cezar serve` registers itself in `~/.cezar/instances/` and is reached *through* the primary — it does **not** re-run the server installer. If `server-install` is re-run on an already-installed host it detects `installed: true`, reports status, and offers only reconfigure/repair (per-step `check()` short-circuits everything already done).

> **Coordination — `src/paths.ts`.** This helper does not exist yet; two other 2026-07-16 specs (multi-project-switcher, agent-config-files) also introduce it. First writer owns the file; whoever lands second imports and extends it. This spec adds only `serverStatePath()` and must not duplicate `cezarHomeDir()`/homedir logic. `~/.cezar/server.json` (host-level, install-once) is a *different* file from `~/.cezar/instances/<id>.json` (per-instance, multi-project) — they coexist.

## Data Model — `~/.cezar/server.json`

Host-level record of the install: which platform, what each step created (so uninstall reverses exactly that), and per-step status for idempotent resume. Additive-safe (all new fields optional so an older cezar still parses it), atomic tmp+rename, mode `0600`.

```jsonc
{
  "schema": 1,
  "platform": "ubuntu-vps",
  "installed": false,            // flips true only when all required steps are done
  "createdAt": "2026-07-16T…",   // stamped by the caller, not in-script (Date.now guard)
  "primaryPort": 4321,
  "steps": {
    "deps":          { "status": "done",    "created": { "installed": ["gh"] } },
    "nginx-proxy":   { "status": "done",    "created": { "vhost": "/etc/nginx/sites-available/cezar", "htpasswd": "/etc/cezar/htpasswd" } },
    "ssl":           { "status": "skipped", "created": null },
    "autostart":     { "status": "done",    "created": { "unit": "cezar.service", "scope": "system" } },
    "identity":      { "status": "done",    "created": { "authUser": "ops" } }
  }
}
```

`status ∈ pending | done | skipped | failed`. `created` is the typed `StepCreated` the step returns; `undo` receives it back verbatim. No secrets are stored — htpasswd hashes live in their own root-owned file, never in `server.json`. Reads degrade to a fresh record on corruption (house pattern), never crash the wizard.

## API / CLI Contracts

New subcommands on the existing `cezar` bin (`src/index.ts` `parseArgs`, positional command — same pattern as `serve`/`run`/`init`):

```
cezar server-install   --platform <ubuntu-vps|macosx-ngrok> [--yes] [--reconfigure]
cezar server-uninstall [--platform <id>] [--yes]

  --platform <id>   required for install; validated against the registry (unknown ⇒ list valid ids, exit 1)
  --yes             non-interactive where a safe default exists (CI/testing); still never auto-sudo
  --reconfigure <stepId|group>   force re-run of a specific step/group even if already `done`
```

- Unknown platform / missing `--platform` → the same `{ list valid ids }` + `exit 1` shape the rest of the CLI uses.
- **`--reconfigure <id>`** overrides the idempotency skip for exactly the named step(s): the engine ignores their `done` status, re-prompts, and re-runs `run()` (which must be write-idempotent — overwrite the vhost, re-hash the htpasswd, re-render the unit). Without the flag, `check()` skips every completed step; the two are not in tension because reconfigure is opt-in and step-scoped, never a blanket re-install.
- **`--yes` at a sudo touchpoint:** `--yes` auto-accepts *safe defaults* (skip-optional, reuse-existing) but cannot invent a sudo password. A privileged step under `--yes` runs non-interactively **only** if `CEZ_DRY_RUN=1` (no-op) or passwordless sudo is available; otherwise it falls back to the **delegate** path (print the command, pause for the operator) rather than blocking on a hidden prompt. Named so CI expectations are explicit: fully unattended install requires passwordless sudo or dry-run.
- **Single-writer lock.** `server-install`/`server-uninstall` take an exclusive `~/.cezar/server.install.lock` (pid + stale-detection) for their whole run — the host-level installer is not concurrency-safe with itself, and refuses to start if another install is live. Repo instances only ever write their own `~/.cezar/instances/<id>.json`; they never touch `server.json`, so there is no installer-vs-instance write race.
- `CEZ_DRY_RUN=1` must produce a full, faithful transcript with **no real sudo, package installs, or network** — mirroring the existing dry-run contract so the wizard is testable offline (this is how `test:package` and unit tests exercise it).
- Exit codes: `0` success or clean user-cancel-with-resumable-state; `1` unrecoverable error or unknown platform.
- `npm run server-install` (new script) runs the same command via `tsx` from a git checkout — the "test it before publishing" path in the brief.

## UI/UX — the wizard flow (ubuntu-vps)

Only the parts unique to this feature; standard prompt rendering is `@clack/prompts`' job.

1. **Preflight** — confirm Ubuntu/Debian + arch + that we are a non-root sudo-capable user; refuse politely on mismatch with the reason.
2. **Resume banner** — if `server.json` shows prior progress: "Resuming ubuntu-vps install — 3/6 steps done." and jump to the first incomplete step.
3. **Dependencies** — `detectEnvironment()` → checkbox of missing tools → install selected (`sudoStep` for apt, npm-global for agent CLIs) → per-tool **authorization instructions** + `verify()` (e.g. `gh auth token` succeeds; `claude` present and authed).
4. **Reverse proxy (nginx + htpasswd)** — the only proxy option for now: install nginx, write the cezar vhost (`proxy_pass 127.0.0.1:<port>`, SSE-safe headers: `proxy_buffering off`, `X-Accel-Buffering no` — cezar's SSE needs this, see multi-project spec §SSE), create the htpasswd identity (prompt user + password), reload nginx. **Or** skip proxy → the wizard prints the exact manual config the operator must apply and what to point at loopback.
5. **Domain + SSL (optional)** — `certbot --nginx -d <domain>`; if DNS isn't pointed yet or rate-limited, show the reason and let them skip and finish later by hand.
6. **Autostart (optional)** — a systemd unit running `cezar serve` as this user with `CEZ_REMOTE=1`, `WorkingDirectory` = the repo. Prefer `systemd --user` + `loginctl enable-linger` (no sudo) where possible; fall back to a system unit via `sudoStep`.
7. **Identity confirm** — verify the proxy actually challenges: an unauthenticated request gets `401`, an authenticated one reaches the cockpit. This is the "always identified" guarantee, proven, not assumed.
8. **Done** — print the public URL, the identity user, the service name, and the exact `server-uninstall` command.

Every sudo touchpoint (3 apt, 4 nginx, 5 certbot, 6 system unit) flows through `sudoStep`: **print → run-via-sudo or delegate → verify → redo-on-mismatch**.

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| Ctrl-C mid-install | State already persisted through the last completed step; re-run resumes. Clean exit, not a stack trace. |
| A required step recorded `failed` | Resume re-runs it (identical to `pending` — the engine advances to the first step not `done`); `failed` vs `pending` differs only in the resume banner wording, carrying no divergent control flow. |
| Operator says "I ran it" but didn't (or ran it wrong) | `verify()` fails → show expected vs actual → offer redo. Never advance on trust. |
| Dep already present/authed | `check()` returns true → step skipped, shown as `= already done`. |
| certbot: DNS not pointed / LE rate-limit | Step is `optional`; show certbot's reason, mark `skipped`, print how to finish manually later. Install still completes. |
| Re-run on installed host | `installed:true` detected → status report + reconfigure/repair only; no duplicate vhost/unit. |
| Uninstall while a repo instance is running | Detect live `~/.cezar/instances/*`; warn and require confirm before removing the shared proxy/service. |
| `~/.cezar` unwritable (read-only home/container) | Fail fast with the reason before touching the system — resume is impossible without state, so we do not start. |
| No agent CLI installable (offline) | Dependencies step cannot complete; wizard stops with the missing-tool hints rather than a broken half-install. |
| macOS: ngrok free tier (no reserved domain) | Proceed with an ephemeral URL; warn it changes across restarts and record it as ephemeral in state. |

## Risks & Impact Review

- **Blast radius.** The installer touches system state (packages, nginx, certs, services) — but only through `sudoStep`, so every privileged action is operator-approved and verified. cezar's own runtime code is unchanged except the additive CLI wiring; the loopback bind guarantee is preserved (nginx fronts loopback, `bindHost` untouched).
- **New dependency (`@clack/prompts`).** First addition to the deliberately-small prod stack (AGENTS.md). Justified: installer-only, not imported by `serve`/`run`/the server; a hand-rolled TUI would be materially worse UX for the flagship on-ramp. Flag it explicitly in the PR for the reviewer to bless; keep it out of the server/runtime import graph so the "read in one sitting" server stack stays tiny.
- **Reversibility.** `server-uninstall` is a first-class deliverable, not an afterthought — every step ships its `undo` in the same PR as its `run`. The `created`-record design means uninstall removes exactly what was added.
- **Compatibility.** `~/.cezar/server.json` is a new cross-version file → optional-field discipline is a compat rule (BACKWARD_COMPATIBILITY.md class of state). No existing public surface changes; `server-install`/`server-uninstall` are purely additive commands.
- **Dependency on unmerged work.** `src/paths.ts` and the multi-project registry are specs/PRs, not merged code. This spec must not hard-depend on either shipping first: it creates `src/paths.ts` with only `serverStatePath()` if absent, and the install-once/primary-port design works for a single instance even before multi-project lands.

## Phasing

Each phase leaves the app working and is independently shippable.

- **Phase 1 — Engine + ubuntu-vps happy path, install *and* uninstall.** State, types, engine (`runInstall` **and** `runUninstall`), `ui`/`steps` helpers, `sudoStep`, dependency step, nginx+htpasswd, identity verify. No SSL, no autostart. `server-install --platform ubuntu-vps` stands up an authenticated, proxied cezar; `server-uninstall` reverses every Phase-1 step. Uninstall ships **with** install — never a phase that modifies the box (vhost, htpasswd, packages) without a tool-driven undo, which is the exact failure the Problem Statement condemns. Fully dry-run testable.
- **Phase 2 — SSL + autostart.** `certbot --nginx` step and systemd autostart step, each landing with its own `undo` so `runUninstall` (already shipped in Phase 1) reverses them too. Now a reboot-surviving, TLS'd install.
- **Phase 3 — macosx-ngrok.** The second strategy (ngrok authtoken + reserved domain + basic-auth + launchd) and its uninstall — proving the seam with a genuinely different platform.

## Implementation Plan

Numbered steps; each is testable and leaves the app working. Steps map onto `om-auto-create-pr` execution-plan rows.

### Phase 1 — Engine + ubuntu-vps happy path

1. **`src/paths.ts`** — if absent, create `cezarHomeDir()` (`CEZ_HOME ?? join(homedir(), '.cezar')`) + `serverStatePath()`; if present, add only `serverStatePath()`. *Test:* unit — default and `CEZ_HOME` override; no duplication of homedir logic.
2. **`src/server-install/types.ts`** — `InstallStep`, `StepOutcome`, `StepCreated`, `PlatformStrategy`, `InstallContext`, `ServerState` (+ zod schema). *Test:* zod round-trips a full `server.json`; unknown-field additive-safe.
3. **`src/server-install/state.ts`** — load (degrade-to-fresh on corrupt), atomic `save`, `0600`, resume helpers (`firstIncompleteStep`). *Test:* unit — write/read round-trip, corrupt file → fresh, mode is `0600`.
4. **`src/server-install/ui.ts`** — typed `@clack/prompts` wrappers; cancel → resumable clean exit. Add `@clack/prompts` to `dependencies`. *Test:* unit with a scripted prompt transport (or `CEZ_DRY_RUN` auto-answers); cancel path returns the sentinel, not a throw.
5. **`src/server-install/steps.ts`** — `verifyCommand`, `sudoStep` (print → run/delegate → verify → redo), `depCheckStep` (wraps `detectEnvironment`), `installPackageStep`. Honor `CEZ_DRY_RUN` (no real exec). *Test:* unit — `sudoStep` verify-fail loops to redo; dry-run performs no exec; delegate path waits then verifies.
6. **`src/server-install/engine.ts`** — `runInstall` (iterate `steps()`, skip on `check()` unless `--reconfigure` names it, `run()`, persist `StepOutcome`, resume from state, flip `installed` when all required done) **and `runUninstall`** (walk completed steps reverse, call `undo(created)` for `owned` records, list `shared` records for manual removal, each destructive action confirmed + `verify()`-checked; warn if a repo instance is live). Acquire the single-writer lock for both. *Test:* unit with fake steps — resume skips completed; `--reconfigure` re-runs a named `done` step; a failing required step stops with state intact; install-then-uninstall calls each `undo` with its recorded `created` and leaves state empty; `shared` records are listed, not removed.
7. **`src/server-install/strategies.ts`** + **`platforms/ubuntu-vps.ts`** (deps, nginx+htpasswd, identity-verify steps only — each with `check`/`run`/`undo`). *Test:* unit — registry lookup; unknown id lists valid ids; dry-run walks all Phase-1 steps and produces a complete transcript + `server.json`.
8. **`src/index.ts`** — wire **both** `server-install` (+ `--platform`, `--yes`, `--reconfigure`) **and `server-uninstall`**; help text; unknown/missing platform → list + exit 1. Add `npm run server-install`. *Test:* `test/e2e/package-cli.test.ts` — `server-install --platform ubuntu-vps` under `CEZ_DRY_RUN=1` exits 0 and writes `server.json`; `server-uninstall` reverses it to empty; bad platform exits 1.

### Phase 2 — SSL + autostart

9. **SSL step** (`ubuntu-vps.ts`) — optional `certbot --nginx -d <domain>` via `sudoStep`; DNS/rate-limit → skip with guidance; record cert domain (`shared` — the cert + renewal timer survive uninstall; only the vhost reference is `owned`). *Test:* dry-run records intended cert domain; skip path marks `skipped` and install still completes; `undo` removes the vhost reference, not the cert.
10. **Autostart step** (`ubuntu-vps.ts`) — systemd unit (`owned`) running `cezar serve` with `CEZ_REMOTE=1`; prefer `systemd --user` + linger, fall back to system unit via `sudoStep`; record unit name + scope. Its `undo` (run by the Phase-1 `runUninstall`) disables + removes the unit. *Test:* dry-run emits the unit file content and records `created.unit`; `verify` asserts `is-enabled`; `undo` disables it.

### Phase 3 — macosx-ngrok

11. **`platforms/macosx-ngrok.ts`** — preflight (macOS), deps, `ngrok config add-authtoken` + reserved domain + `--basic-auth`, launchd autostart, identity verify; ephemeral-URL fallback recorded in state. Full `undo` per step (reuses the Phase-1 `runUninstall`). *Test:* dry-run walks every step, produces `server.json` with `platform:"macosx-ngrok"`, and `server-uninstall` reverses it; registry now lists both platforms.
