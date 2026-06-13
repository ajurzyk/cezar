<div align="center">

<img src="docs/images/cezar-banner.svg" alt="CEZAR" width="528" height="120">

**Software delivery life cycle cockpit for managing projects and co-working with agents.**

Coordinate humans and AI agent teams across the GitHub issue lifecycle — from
intake and triage, through autofix, to a draft PR ready for review. Agents do
the routine; you keep control of the judgment calls.

[What it solves](#what-it-solves) · [Who it's for](#who-its-for) · [Quick start](#quick-start) · [How the loop works](#how-the-humanagent-loop-works) · [Built-in actions](#built-in-actions)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/Node-20%2B-339933)
![TypeScript 5.x](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![Status: active](https://img.shields.io/badge/status-active-success)

</div>

![Cockpit — every agent run across the workspace, with row-level controls](docs/images/cezar-runs.png)

---

## What it solves

Most "AI for GitHub" tools are point solutions — a labeler, a duplicate
detector, an autofix bot. Run a few side by side and you end up with no
shared model, no shared visibility, and no clear place for the human to step
in. Cezar is the **cockpit** that pulls those jobs into one delivery flow.

- **Backlog outpaces triage.** New issues sit unlabeled and unprioritized for
  days. Cezar auto-triages every incoming issue on webhook — type, priority,
  duplicates, missing-info — and posts one summary comment, not a wall of bots.
- **No visibility into what agents are doing.** Once you have more than one
  agent running, you stop knowing which run is paused, which failed, which
  ate its turn budget. The cockpit shows every run live, with pause / cancel
  / resume / retry / delete on each row.
- **Hand-off without losing control.** Agents handle the routine; **human-gate**
  steps pause the workflow on low-confidence decisions so you approve before
  anything ships. Fixes land as draft PRs — never auto-merge.
- **Customization without forking.** Actions are data-driven specs, skills are
  Markdown playbooks pulled from your repo's `.ai/skills/`. Override a built-in
  via a clone-and-edit in the GUI, no TypeScript plugin required.
- **Bring your own agent backend.** Anthropic API, Claude Code CLI, or Codex
  CLI — pick per workflow step. Run subscription CLIs on your own infra under
  your own login via the self-hosted runner.

---

## Who it's for

- **Engineering leads** managing a steady inbound of bug reports and feature
  requests, who want delegation without losing the audit trail.
- **OSS maintainers** whose backlog grows faster than triage time and who want
  one consistent voice on issues — not five bot comments.
- **Platform / DevEx teams** rolling out agent workflows across multiple repos
  and looking for shared observability, shared playbooks, and shared gates.
- **Solo devs** running through an issue backlog one-off — the CLI mode works
  against a local JSON store, no SaaS or DB required.

---

## Screenshots

The cockpit shot above is the app as it stands today. Below — a tour of the rest of the surface area. Click any card for the full-size view.

<table>
<tr>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-run-details.png"><img src="docs/images/cezar-run-details.png" alt="Run detail" /></a>
  <br/><sub><b>Run detail</b><br/>step graph + streaming event log</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-activity-log.png"><img src="docs/images/cezar-activity-log.png" alt="Activity feed" /></a>
  <br/><sub><b>Activity feed</b><br/>workspace-wide audit trail</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-inbox.png"><img src="docs/images/cezar-inbox.png" alt="Inbox" /></a>
  <br/><sub><b>Inbox</b><br/>pending decisions and paused runs</sub>
</td>
</tr>
<tr>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-action-details-1.png"><img src="docs/images/cezar-action-details-1.png" alt="Action editor" /></a>
  <br/><sub><b>Action editor</b><br/>system prompt, skills, effects</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-action-details-2.png"><img src="docs/images/cezar-action-details-2.png" alt="Acceptance settings" /></a>
  <br/><sub><b>Acceptance settings</b><br/>model, auto-accept, confidence cutoff</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-actions.png"><img src="docs/images/cezar-actions.png" alt="Actions catalog" /></a>
  <br/><sub><b>Actions catalog</b><br/>built-in + user-defined plays</sub>
</td>
</tr>
<tr>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-skills.png"><img src="docs/images/cezar-skills.png" alt="Skills" /></a>
  <br/><sub><b>Skills</b><br/>built-in + repo <code>.ai/skills/</code></sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-skill-details.png"><img src="docs/images/cezar-skill-details.png" alt="Skill details" /></a>
  <br/><sub><b>Skill details</b><br/>rendered body + prompt preview</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-workflows.png"><img src="docs/images/cezar-workflows.png" alt="Workflows" /></a>
  <br/><sub><b>Workflows editor</b><br/>drag-orderable steps + skill bindings</sub>
</td>
</tr>
<tr>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-settings.png"><img src="docs/images/cezar-settings.png" alt="Settings" /></a>
  <br/><sub><b>Settings landing</b><br/>workspace-level switches in one place</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-setting-runner.png"><img src="docs/images/cezar-setting-runner.png" alt="Runners" /></a>
  <br/><sub><b>Settings → Runners</b><br/>registered runners with heartbeat</sub>
</td>
<td align="center" width="33%" valign="top">
  <a href="docs/images/cezar-settings-runner-register.png"><img src="docs/images/cezar-settings-runner-register.png" alt="Register runner" /></a>
  <br/><sub><b>Register a runner</b><br/>name + backend selection</sub>
</td>
</tr>
</table>

---

## Quick start

The recommended path: self-hosted SaaS (full cockpit + auto-triage) against
the local Supabase docker stack. Two other paths — solo-use CLI and an
optional self-hosted runner — are in [`docs/INSTALL.md`](docs/INSTALL.md).

```bash
git clone https://github.com/comerito/cezar.git
cd cezar
yarn install

# 1. start the local Supabase stack (db + kong + Realtime in Docker)
yarn db:start

# 2. seed env from the local-dev example; everything but ANTHROPIC_API_KEY
#    is pre-filled for the local Supabase stack
cp packages/gui/.env.local.example packages/gui/.env.local
# then edit packages/gui/.env.local and replace `sk-ant-REPLACE-ME` with
# your Anthropic key. GitHub App vars are optional for local-only use.

# 3. run
yarn workspace @cezar/gui dev
```

For self-hosted (non-local) deployments, see
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for the full env-var list
including hosted Supabase, the in-process scheduler, and tuning knobs.

Then install the GitHub App on your repo, walk through the **Workspaces → New**
wizard (project env preset, label-catalog analysis, workflow defaults), and
open `/dashboard`. New issues will start triaging automatically.

> Prefer a no-DB, no-SaaS path? The solo-use CLI runs against a local JSON
> store. See [`docs/INSTALL.md`](docs/INSTALL.md#option-1--solo-use-cli).

---

## How the human–agent loop works

A bug report lands on GitHub. The GitHub App webhook enqueues a **triage** job.
The triage pass runs every enabled Action whose trigger matches `on-issue-opened`,
in deterministic order. If a fix is in scope, the autofix workflow kicks off:
`verify-in-repo → root-cause → fix → review-loop → open PR (draft)` — and any
step can be a **human-gate** that pauses until you approve.

```
                ┌────────────────────────────────────────────────┐
GitHub  ──►─── │  webhook (issues.opened)                       │
                │   └─► jobs (deduped)                           │
                └────────────────────────────────────────────────┘
                                  │
                                  ▼
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
      Triage pass         Autofix workflow       CI follow-up
      ┌────────────┐      ┌──────────────────┐   ┌───────────────┐
      │ bug detect │      │ verify-in-repo   │   │ classify CI   │
      │ priority   │      │ root-cause       │   │ failure       │
      │ duplicates │      │ fix              │   │ patch + push  │
      │ auto-label │      │ review-loop      │   └───────────────┘
      │ …          │      │ open PR (draft)  │
      └────────────┘      └──────────────────┘
            │                     │
            ▼                     ▼
   agent_run_events ──realtime──► Cockpit UI
                                  │
                          human-gates pause here
                          for your approval
```

Every step writes structured events; the cockpit (`/cockpit`, `/cockpit/[runId]`)
subscribes via Supabase Realtime and renders the step graph filling in live. A
single *living comment* on the issue (then the PR) is edited as steps complete —
one comment per run, not a wall of bot chatter.

For the underlying data model, the Action spec, the workflow engine, and the
runner abstraction, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Core concepts

Four ideas, each one a thin wrapper over the next. Full reference in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

- **Actions** are your team's playbook, encoded once: a system prompt, a list
  of skills, a set of allowed effects (`label.add`, `comment`, `close`, …),
  and a trigger. No bespoke TypeScript — just data. 2 built-ins ship; you
  can override any of them per workspace, or write new ones in the GUI.
- **Skills** are Markdown playbooks pulled from your repo's `.ai/skills/`
  (built-in fallbacks ship with `@cezar/core`). Any Action composes them into
  its prompt — so you customize *how* an agent reasons without forking Cezar.
- **Workflows** chain steps into a multi-step pipeline (`agent` · `effect` ·
  `human-gate` · `commit` · `open-pr` · `push`). The autofix workflow is one;
  you can define your own per workspace.
- **Human gates** are the coordination piece. Any workflow step can pause for
  a decision — low-confidence triage, ambiguous fix, sensitive area of the
  codebase. The run sits in `paused` in the cockpit until you approve.

### Workspace label catalog

A per-workspace vocabulary of labels Cezar will apply, with add/remove
guidance per label. A **label-analysis job** scans your repo's existing labels
and the last 100 issues/PRs to learn maintainer conventions, then asks Claude
to synthesize a draft you edit in **Settings → Labels**. The accepted catalog
is appended to every agent step's system prompt — so agents apply *your*
labels with *your* semantics, and stop inventing new ones.

---

## Built-in actions

15 Actions ship with `@cezar/core`. Each one is data — you can enable, disable,
override, or clone any of them in the GUI without touching code.

| Action | Triggers | Effects | What it does |
|---|---|---|---|
| `auto-triage` | `on-issue-opened`, `on-issue-reopened` | tool-use (`label.add`, `set-priority`) | First-pass orchestrator — type labels + priority for clear critical defects |
| `bug-detector` | `on-issue-opened`, `on-issue-edited` | declared (`label.add`) | Classify bug / feature / question / other with calibrated confidence |
| `priority` | `on-issue-opened` | declared (`set-priority`) | Impact-and-urgency rubric with cited signals |
| `duplicates` | `on-issue-opened` | tool-use (`link-duplicate`) | Detect duplicates against the open-issue knowledge base (conf ≥ 0.80) |
| `auto-label` | `on-issue-opened`, `on-issue-edited` | tool-use (`label.add`, `label.remove`) | Apply repo-defined labels — never invents new ones |
| `missing-info` | `on-issue-opened` | declared (`comment`, `label.add`) | Ask for missing repro info (3-5 bullets max) |
| `security` | `on-issue-opened`, `on-issue-edited` | declared (`label.add`, `comment`) | Flag security implications, false positives preferred |
| `quality` | `on-issue-opened` | declared (`label.add`) | Detect spam / vague / test / wrong-language submissions |
| `good-first-issue` | `on-issue-opened` | declared (`label.add`) | Surface newcomer-friendly issues with a code hint |
| `claim-detector` | `on-cron` | declared (`comment`) | Find stale claims (>14 days, no PR) and post a polite nudge |
| `contributor-welcome` | `on-issue-opened` | declared (`comment`) | Personalised first-timer welcome — references issue specifics |
| `recurring-questions` | `on-cron` | declared (`comment`) | Redirect open questions already answered in closed issues |
| `categorize` | `on-issue-opened` | declared (`label.add`) | Framework / domain / integration categorization |
| `done-detector` | `on-cron` | declared (`comment`, `close`) | Find issues silently resolved by merged PRs (conf ≥ 0.70) |
| `stale` | `on-cron` | declared (`comment`, `close`, `label.add`) | Triage stale issues — close / label / keep-open |

---

## Self-hosting

Cezar runs on a managed cloud path (`ANTHROPIC_API_KEY` + the in-process
dispatcher) by default. Add the optional `@cezar/runner` daemon if you want
subscription CLIs (`claude`, `codex`) to run under your own login on your
own infra. Full setup: [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

---

## Documentation

- [`docs/INSTALL.md`](docs/INSTALL.md) — the three install paths (CLI · SaaS · self-hosted runner).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Action model, workflow engine, packages, data flow, runner abstraction.
- [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) — self-hosted runner, configuration, env vars.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — local dev, tech stack, adding new Actions and effects.
- [`docs/dokploy-setup.md`](docs/dokploy-setup.md) — deploying the Docker Compose stack on a Hetzner VPS via Dokploy.
- [`CLAUDE.md`](CLAUDE.md) — operating manual for AI assistants editing this repo.
- [`DESIGN.md`](DESIGN.md) — design system spec for the GUI.
- [`cezar-ROADMAP.md`](cezar-ROADMAP.md) — what's next.

---

## Contributing

Bug fixes, new Actions, new skills, new effects — all welcome. Please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and code
standards (TypeScript strict, ESM, Zod at every boundary, tests for new logic).

Found a bug? Open an issue — Cezar will auto-triage it.

---

## License

[MIT](LICENSE) © [Comerito](https://github.com/comerito)
