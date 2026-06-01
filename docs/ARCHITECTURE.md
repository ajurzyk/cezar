# Architecture

The under-the-hood reference for Cezar. If you just want to *use* it, see the
[README](../README.md) and [`INSTALL.md`](INSTALL.md) first.

- [The Action model](#the-action-model)
- [Workflow engine](#workflow-engine)
- [Packages](#packages)
- [Three-phase data flow](#three-phase-data-flow)
- [Agent runner abstraction](#agent-runner-abstraction)
- [Job queue + cockpit](#job-queue--cockpit)
- [Source of truth](#source-of-truth)

---

## The Action model

An **Action** is a data-driven spec — no TypeScript plugin required. It lives
either in the built-in catalog ([`packages/core/src/actions-v2/default-actions.ts`](../packages/core/src/actions-v2/default-actions.ts))
or in the `actions` table for the SaaS path.

```ts
interface ActionDef {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  systemPrompt: string;                       // operative instruction
  skillRefs: string[];                        // composed into the system message
  target: 'issue' | 'pr';
  triggers: ActionTrigger[];                  // when to fire
  effects: EffectName[] | null;               // null = let the agent choose
  outputSchema: Record<string, unknown> | null;
  enabled: boolean;
}
```

**Triggers**: `manual`, `on-issue-opened`, `on-issue-edited`, `on-issue-reopened`,
`on-pr-opened`, `on-pr-edited`, `on-comment`, `on-check-failed`, `on-cron`.

**Effect vocabulary** (the only side-effects an Action can have on GitHub):

| Effect | Description |
|---|---|
| `label.add` / `label.remove` / `label.set` | Manage labels on the target |
| `comment` | Post a comment |
| `close` | Close the issue (`completed` / `not_planned`) |
| `assign` | Add assignees |
| `link-duplicate` | Mark as duplicate of another issue (comment + `duplicate` label) |
| `set-priority` | Apply a `priority/<level>` label |

### Two execution modes

The runner dispatches on the Action's `effects` field:

- **Declared mode** (`effects` is non-null). The system prompt is augmented
  with a strict JSON response format. The model returns
  `{ summary, effects: [{ effect, args }] }`; the runner validates each call
  against the registered Zod schema and rejects any effect the Action didn't
  declare. Predictable, auditable, easy to dry-run.

- **Tool-use mode** (`effects` is null). The full effect vocabulary is exposed
  to the model as Anthropic tools. The agent calls them mid-run; the runner
  feeds back `tool_result` blocks and loops until the model produces a final
  text response. Max 8 iterations to bound runaway runs.

Both modes share the same effect registry, the same Zod validation, and the
same audit trail.

![Action editor — name, target, triggers, skill refs, effects mode (Declared / Agent tools), live system prompt with auto-save](images/cezar-action-details-1.png)

![Acceptance settings — model choice, auto-accept vs human-in-the-loop, confidence cutoff with a live preview](images/cezar-action-details-2.png)

### Skills as composable playbooks

`skill_refs` names skills whose markdown body is concatenated into the system
message ahead of the prompt. Skills are discovered from two sources:

- **Built-in** — shipped with `@cezar/core` (`packages/core/skills/*.md`).
- **Repo** — globbed from `<repo>/.ai/skills/**/*.md` (configurable via
  `autofix.skillsDir`). Repo skills override built-ins of the same name.

A skill is a Markdown file with optional frontmatter:

```markdown
---
name: bug-classification
description: Calibrated bug / feature / question / other rubric.
cezar-stages: [triage]
---

When classifying an issue, weight:
1. Presence of reproduction steps...
```

Empty `.ai/skills/` is fully supported — every Action uses its built-in default.

### Workspace label catalog

The label catalog is the per-workspace vocabulary of labels Cezar will apply.
Instead of having every Action's prompt list which labels exist (or worse,
letting the model invent them), each workspace owns a single `workspace_labels`
table that the engine appends to every agent step's system prompt under a
"Repository label catalog" section.

```text
# Repository label catalog                  (rendered into the system prompt)

- bug          (issue)       a defect: reproducible incorrect behavior
   add when:   reproduction steps + observed/expected behavior present
   remove when: triage confirms not-a-bug or it's converted to a question
- needs-qa     (pr)          a fix that needs manual verification before merge
   add when:   the change isn't fully covered by automated tests
- …
```

A **label-analysis job** (`kind='label-analysis'` on the `jobs` queue) builds
the catalog: pulls the repo's current labels, scans the codebase for label
guidance, walks the last 100 issues + 100 PRs for `labeled`/`unlabeled` timeline
events to learn maintainer conventions, then asks Claude to synthesize a draft.
You review/edit the draft in **Settings → Labels** and accept it, materializing
into `workspace_labels`.

Each agent step picks the relevant slice via its `labelScope`: `issue` (issue-
scoped + `both`), `pr` (pr-scoped + `both`), or `both` (everything). Effect:
agents reliably apply *your* labels with *your* semantics, and stop inventing
new ones.

---

## Workflow engine

Beyond single-action triage, Cezar ships a declarative engine for multi-step
agent workflows. A `Workflow` is an ordered list of steps:

```ts
type WorkflowStep =
  | { kind: 'agent';      skill: string; backend?: Backend; model?: string }
  | { kind: 'effect';     effect: EffectName; args: unknown }
  | { kind: 'human-gate'; reason: string }      // pauses for a decision
  | { kind: 'commit';     message: string }
  | { kind: 'open-pr';    draft?: boolean }
  | { kind: 'push' }
```

Three definitions ship:

- **`autofixWorkflow`** — `verify-in-repo → root-cause → fix → review-loop → open PR (draft)`.
  Loops on `review-loop` if the reviewer rejects.
- **`ciFollowupWorkflow`** — classifies a failing CI check on an autofix-owned
  PR, patches, and pushes (capped at 3 prior attempts).
- **`triageWorkflow`** — wraps the data-driven triage pass.

Per-step binding resolves through:
**step binding → run-launch override → workspace default → built-in default**.
So an unconfigured workspace behaves exactly like the defaults.

`runWorkflow` (in [`packages/core/src/workflows/workflow-engine.ts`](../packages/core/src/workflows/workflow-engine.ts))
threads a blackboard, emits one `AgentRunRecord` per step, and writes
`agent_run_events` rows the cockpit subscribes to.

**User-defined flows** (a named chain of `{ skill, argsTemplate }` steps,
configurable per workspace) run on the same engine. The flow runtime adds:

- A **run-environment hint** auto-injected into every flow agent step's user
  prompt — `CWD`, `BRANCH`, `BASE`, plus an explicit *no-network-for-git* note.
  Stops review-class skills from burning their turn budget on offline
  `gh pr checkout` / `git fetch origin pull/<n>/head` before realizing the
  worktree is already on the PR's head branch.
- `NO_ACTION_NEEDED` on its own line in a step's output **stops the chain**
  cleanly (run ends `succeeded` with reason). The marker is the universal
  "this issue doesn't need any further action" signal — shared with the typed
  autofix workflow's `isNoActionNeeded` exit.
- **Per-section body cap** (20 KB tail) when rendering a step's output into
  the run's living comment, so a single long investigation can't push the
  combined comment past GitHub's 65 536-byte limit.

![Workflows editor — drag-orderable steps, each binding a skill and an args template; chain agent + effect + human-gate steps](images/cezar-workflows.png)

---

## Packages

Yarn 4 monorepo. Four packages:

| Package | Role |
|---|---|
| [`@cezar/core`](../packages/core) | Engine — store schemas, GitHub/LLM services, the Action runner + effect registry, the workflow engine, the agent-runner abstraction, the skill catalog. No UI. |
| [`cezar`](../packages/cli) (CLI) | Interactive hub + `init` / `sync` / `run` / `status` / `runs` commands. Solo-use front end over `@cezar/core`. |
| [`@cezar/gui`](../packages/gui) | Next.js 15 app — cockpit, Inbox, Issues, Skills, Actions, Runs, Activity, Settings. Supabase-backed. GitHub App webhook + cron routes. |
| [`@cezar/runner`](../packages/runner) | Optional self-hosted runner daemon. Long-polls for jobs, runs the engine locally, streams events back. |

---

## Three-phase data flow

1. **Fetch** — `init`/`sync` (CLI) or the `issue-sync` cron + the GitHub App
   webhook (GUI) pulls issues into the store. CLI store = `.issue-store/store.json`;
   GUI store = Supabase.
2. **Digest** — Claude generates a compact (~80-token) summary per issue:
   category, affected area, keywords. Comments are fetched and stored too.
3. **Analyze** — Actions and workflows run against digests + comments.

---

## Agent runner abstraction

`AgentRunner` is an interface with three implementations:

- `AnthropicApiRunner` — streaming `@anthropic-ai/sdk`, the managed-cloud default.
- `ClaudeCodeCliRunner` — wraps `claude` (the Claude Code CLI). Subscription auth.
- `CodexCliRunner` — wraps `codex exec --json` (interface implemented, live-binary
  validation pending; `grep phase-4-verify`).

A normalized `AgentEvent` stream plus an `AgentRunResult` with structured output
and cost-weighted token usage. `createAgentRunner(backend, …)` picks one.

---

## Job queue + cockpit

`jobs` → `workflow_runs` → `agent_runs` → `agent_run_events`, plus a `runners`
table. `/api/cron/dispatch` claims jobs with `FOR UPDATE SKIP LOCKED` and runs
them in-process via `execute-workflow-job.ts`. `/api/cron/triage-sweep` is the
missed-webhook poll fallback. `/api/cron/issue-sync` is the GitHub →
`issues`-table reconcile. `/api/runner/*` is the long-poll API for self-hosted
runners. Shared writes go through `lib/persist-workflow-run.ts`.

---

## Source of truth

The CLI keeps a single JSON file with atomic writes; the GUI uses Supabase
tables. Zod schemas validate everything in both paths.
