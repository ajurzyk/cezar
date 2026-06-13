# Plan: Actions cleanup — 15 built-ins → 2 that matter

**Branch:** `feat/actions-cleanup`
**Status:** draft for review

## Why

The actions-v2 catalog ships 15 built-in actions, but the runtime reality is:

- ~11 of them fire **sequentially on every new issue** (one Sonnet call each),
  with heavy overlap — `auto-triage` already adds type labels + critical
  priority, then `bug-detector`, `priority`, `categorize`, `auto-label`, and
  `quality` re-decide overlapping subsets. Conflicting labels, 11× cost.
- 4 actions (`stale`, `done-detector`, `claim-detector`,
  `recurring-questions`) declare `on-cron` — **no cron fires that trigger**.
  They are dead weight except for manual "run now".
- `duplicates` is **functionally broken**: its skill is written around an
  "open-issue knowledge base" the runner never injects — the model only sees
  the single target issue, so any `link-duplicate` is hallucinated.
- The catalog is defined **twice** (TS `DEFAULT_ACTIONS` for the CLI, SQL
  `seed_default_actions` for SaaS) and has **already drifted** — the TS
  prompts gained confidence-calibration text that no migration ever applied
  to the SQL seed.
- `run-triage-pass-job.ts` hardcodes `trigger: 'on-issue-opened'`, so
  `on-issue-edited` / `on-issue-reopened` on action rows are decorative.
- Action-posted comments (the branded auto-comment summary and `comment`
  effects) are verbose; they should be short, to-the-point notes.

## Target action set (2)

Both keep `target: 'issue'`.

### 1. `auto-triage` (classification + duplicate detection in one pass)

Absorbs `bug-detector` and the (fixed) `duplicates` action.

- **Mode:** tool-use (`effects: null`).
- **Triggers:** `on-issue-opened`, `on-issue-reopened`, `manual`.
- **skillRefs:** `auto-triage-playbook`, `bug-classification`,
  `dedupe-heuristics`.
- **contextRefs:** `['open-issues']` — the open-issue knowledge base
  (Phase 2) is required for the dedupe half.
- **Playbook rewrite** (`auto-triage-playbook.md`): one pass that
  1. classifies the issue and adds **`bug` or `feature`** via `label.add` —
     nothing else (questions/other get no label),
  2. checks the issue against the injected open-issue knowledge base and
     calls `link-duplicate` on a match (never `close`),
  3. when it added `bug` (and found no duplicate), calls
     `suggest-workflow` with a one-line reason — surfaces as a
     "Run \<configured workflow\>" suggestion in the inbox (Phase 5). The
     target workflow is configured on the action (dropdown of the
     workspace's workflows), not chosen by the model; the tool is only
     exposed when one is configured,
  4. never comments, closes, or assigns.
- **Acceptance:** `human-in-the-loop` with
  `{autoAcceptAbove: 90, autoDenyBelow: 60}`. Routing is per effect, so
  confident label adds apply immediately while mid-confidence duplicate
  links land in the `pending_decisions` inbox.

### 2. `security` (kept as-is, prompt refreshed)

- Distinct, high-stakes, asymmetric-cost signal; a conservative standalone
  prompt beats one bullet in a mega-prompt.
- **Mode:** declared (`effects: ['label.add', 'comment']`).
- **Triggers:** `on-issue-opened`, `on-issue-edited`, `manual`.
- Comment output constrained to a short, direct finding summary (see
  comment refactor in Phase 1).

### Dropped (restorable from git history)

`bug-detector`, `duplicates` (merged into `auto-triage`), `priority`,
`categorize`, `quality`, `auto-label`, `missing-info`, `good-first-issue`,
`contributor-welcome`, `claim-detector`, `recurring-questions`,
`done-detector`, `stale`.

**Skill files:** keep `auto-triage-playbook`, `bug-classification`,
`dedupe-heuristics`, `security-signals`. Delete `priority-rubric`,
`auto-labeling-rubric`, `quality-rubric`, `missing-info-checklist`,
`categorization-rubric`, `good-first-issue-signals`, `contributor-welcome`,
`claim-signals`, `recurring-question-patterns`, `done-signals`,
`stale-criteria`.

---

## Phases

### Phase 1 — Consolidate the catalog (core, no schema change)

1. Rewrite `packages/core/src/actions-v2/default-actions.ts` to the 2 specs
   above.
2. Rewrite `packages/core/skills/auto-triage-playbook.md`; delete the 11
   retired skill files.
3. **Comment refactor:** rewrite `actions-v2/auto-comment.ts`
   (`buildAutoCommentBody`) to a minimal format — what happened, which
   effects fired, one line each; drop verbose framing. Add an explicit
   "comments must be short and direct — state the point, no filler" rule to
   every prompt/skill that can emit a `comment` effect (`security-signals`,
   the `comment` effect description in `effects.ts`).
4. Update CLI expectations (`packages/cli/src/utils/cli-action-runner.ts`
   docstring says "the 15 built-in defaults"; any hub copy listing actions).
5. Update CLAUDE.md: replace the stale "Action Plugin System" section with a
   short actions-v2 description (data-driven `ActionDef`, two run modes,
   skills as prompt building blocks, seed flow).

### Phase 2 — Knowledge-base injection for the dedupe half of `auto-triage`

Add a small, declarative context-provider mechanism rather than hardcoding
per-action-name behavior:

1. `ActionDef.contextRefs?: string[]` (+ `context_refs jsonb` column,
   default `'[]'`, in the Phase 3 migration; loader maps it).
2. `RunActionDeps.contextProviders?: Record<string, () => Promise<string>>`.
   The runner resolves each ref and appends the returned markdown section to
   the **user message** (after the target, e.g.
   `## Open-issue knowledge base`).
3. One provider for now, `open-issues`:
   - **GUI** (`run-triage-pass-job.ts`, `execute-action-job.ts`): select
     open issues from the `issues` table for the workspace — `number`,
     `title`, digest/body first ~300 chars — excluding the target, capped at
     ~100 lower-numbered issues (matches the skill's "lower-numbered
     original" rule).
   - **CLI** (`cli-action-runner.ts`): same shape from the local
     `IssueStore`.
4. `auto-triage` gets `contextRefs: ['open-issues']`.
5. Unit tests: runner appends context sections; provider failure degrades to
   no section (log, don't abort the action).

### Phase 3 — Seeding unification + retirement migration

Kill the dual source of truth: **the TS catalog becomes the only seed
definition**; SQL no longer embeds prompts.

1. Replace the two `supabase.rpc('seed_default_actions', …)` call sites
   (`app/workspaces/actions.ts` on creation,
   `app/actions/actions-page-actions.ts` "restore defaults") with a server
   helper that upserts from `DEFAULT_ACTIONS`:
   - insert missing `built-in` rows, `ON CONFLICT (workspace_id, name, kind)`
     update `system_prompt / skill_refs / triggers / effects / output_schema /
     description / context_refs / effect_routing / acceptance_mode /
     confidence_config` (never `suggested_flow_id` — per-workspace user
     choice)
     (built-ins are RLS-locked from user edits, so overwriting them is safe;
     user overrides are separate rows and untouched),
   - set `workspaces.auto_triage_action_id` when null.
2. Migration `0044_consolidate_default_actions.sql`:
   - `alter table actions add column context_refs jsonb not null default '[]'`,
     `effect_routing jsonb not null default '{}'`, and
     `suggested_flow_id uuid null references flows(id) on delete set null`
     (used by Phase 5),
   - delete retired `built-in` rows (the 13 dropped names) — user-kind rows
     with those names survive as standalone user actions,
   - update the 2 kept `built-in` rows to match the TS catalog (one-time
     sync; afterwards the server helper owns it), including `auto-triage`'s
     `context_refs`, `acceptance_mode = 'human-in-the-loop'`, and
     `confidence_config = {"autoAcceptAbove":90,"autoDenyBelow":60}`,
   - drop `function seed_default_actions(uuid)`,
   - `auto_triage_action_id` needs no repoint (`auto-triage` keeps its name
     and row id).
3. Regenerate `lib/supabase/types.ts`.

### Phase 4 — Trigger honesty

1. Plumb the real trigger: webhook enqueue puts
   `trigger: 'on-issue-opened' | 'on-issue-reopened' | 'on-issue-edited'`
   into the triage job payload; `execute-workflow-job.ts` /
   `run-triage-pass-job.ts` forward it to `runTriagePass` instead of the
   hardcoded literal. `triage-sweep` keeps `on-issue-opened` (correct for
   backlog triage). Default to `on-issue-opened` when the payload field is
   absent (in-flight jobs during deploy).
2. Trim `ActionTrigger` to what can actually fire:
   `manual | on-issue-opened | on-issue-edited | on-issue-reopened`.
   Remove `on-pr-opened / on-pr-edited / on-comment / on-check-failed /
   on-cron` from the type and the GUI trigger picker
   (`app/actions/[name]/action-detail-view.tsx`). Existing user rows with
   dead triggers keep working — unknown strings simply never match.
   (Re-add triggers when a real firing path ships.)

### Phase 5 — Workflow suggestions (new feature)

Actions can propose a workflow run on their target; the user accepts from
the inbox. Generic over the **workflows feature** (the `flows` table —
named skill-step chains, `jobs.kind='flow'`); v1 use case: auto-triage adds
`bug` → "Run fix workflow" suggestion.

**No autofix coupling.** The legacy `autofix` job kind / built-in
`autofixWorkflow` is deprecated and slated for removal — nothing in this
feature references it. The suggestion targets a workspace workflow row by
id; "fix" is just one workflow among many (seeded from the existing fix
template in `app/workflows/templates.ts`).

The trick that makes this cheap: the inbox accept flow already re-fires the
stored `(effect, effect_args)` through `executeEffect`
(`app/inbox/decision-actions.ts`). Modeling the suggestion as an *effect
whose executor enqueues the workflow job* means deferral = suggestion and
acceptance = dispatch, with no changes to the accept flow.

1. New effect `suggest-workflow` in `EFFECT_REGISTRY`:
   - fired/stored args: `{ flowId, flowName, reason?: string }`. The
     **model-facing tool schema is `{ reason }` only** — the runner injects
     `flowId`/`flowName` from the action's configuration before routing, so
     the model decides *whether* to suggest, never *which* workflow,
   - executor inserts a `jobs` row of kind `flow` (same enqueue shape as
     the webhook's `enqueueFlowsForIssueEvent` / the manual flow run, input
     = the target issue/PR number), deduped against in-flight
     (workspace, flow, issue) jobs,
   - `EffectContext` gains `workspaceId` (executor needs it for the
     insert); CLI context has no job queue → executor returns a "not
     supported locally" summary instead of throwing,
   - dangling config (workflow deleted after the suggestion was created) →
     accept fails gracefully with "workflow no longer exists".
2. Action configuration:
   - `actions.suggested_flow_id uuid null references flows(id) on delete
     set null` (+ `suggestedFlowId` on `ActionDef`, loader mapping),
   - the GUI action editor renders a **dropdown of the workspace's
     workflows** (from `flows`) to pick the suggestion target; empty = the
     `suggest-workflow` tool is not exposed to the model at all,
   - built-in rows are RLS-locked, so setting the dropdown on a built-in
     action goes through the existing override-by-copy pattern (0015) —
     the user row carries `suggested_flow_id`; seeding never touches it,
   - CLI: `suggested-flow` frontmatter key parsed but inert (no queue).
3. Per-effect routing override on the action —
   `ActionDef.effectRouting?: Record<EffectName, 'auto' | 'always-defer'>`
   (+ `effect_routing jsonb` column, loader mapping). `applyOrDefer` checks
   it before the confidence thresholds. `suggest-workflow` defaults to
   `always-defer` (a suggestion by definition); a workspace can flip it to
   `auto` for a fully automatic bug → workflow pipeline — same mechanism,
   config-only change.
4. Inbox rendering: a `suggest-workflow` row reads
   "Run workflow \<flowName\> on #N — \<reason\>" with the accept button
   labelled "Run workflow". Dedup of repeat suggestions (re-triage,
   webhook re-delivery) comes free from 0035's pending-decisions dedup.
5. `auto-triage` declares the playbook rule (step 3 above). Seeding can't
   hardcode a `suggested_flow_id` (flows are per-workspace user data), so
   the built-in ships with it null; the action editor nudges the user to
   pick one (e.g. the fix-template workflow).

### Phase 6 — Tests + verification

1. Core: tests for the consolidated catalog (2 actions, skill refs resolve
   against shipped skill files — guards against ref/file drift), runner
   context-section tests (Phase 2), trigger filtering in
   `listEnabledActions`, auto-comment format test update, `applyOrDefer`
   honours `effectRouting` (always-defer beats high confidence).
2. GUI: seed-helper test (insert + conflict-update path).
3. Manual verification: create a fresh workspace → 2 actions seeded,
   auto-triage pointer set; "restore defaults" refreshes prompts; open a
   test issue → one triage pass with at most 2 action runs in the cockpit;
   the `auto-triage` run shows the KB section in its inputs, applies a
   `bug`/`feature` label, and defers mid-confidence duplicate links to the
   inbox; with a workflow configured on the action, a bug-labelled issue
   produces a "Run workflow" inbox suggestion whose accept enqueues a
   `flow` job visible in the cockpit; with none configured, no suggestion
   tool is exposed.
4. `yarn build && yarn typecheck && yarn lint && yarn test` (known
   pre-existing failure: `tests/actions/stale/runner.test.ts` — which
   Phase 1 deletes along with the action, resolving it).

---

## Decisions taken (flag if you disagree)

| Decision | Choice | Rationale |
|---|---|---|
| `security` separate vs folded into auto-triage | separate (2 actions) | asymmetric cost of a miss; conservative standalone prompt |
| Rename `auto-triage` → `triage` | no | avoids `auto_triage_action_id` repoint + name-based override breakage |
| Seed source | TS catalog, SQL function dropped | drift already happened once; one definition |
| Retired built-ins in existing workspaces | hard-delete rows | RLS means users never edited them; user overrides survive |
| Dead triggers | remove from type + UI | honest config beats aspirational enum |
| Dedupe KB | declarative `contextRefs` + provider registry | extensible (later: `repo-labels`, `recent-prs`) without name-matching hacks |
| auto-triage acceptance | HITL 90/60 on the whole action | per-effect routing: confident labels auto-apply, dup links go to inbox |
| Workflow suggestion mechanism | `suggest-workflow` effect, executor enqueues a `flow` job | inbox accept already re-fires effects — deferral = suggestion, accept = dispatch, no new accept flow |
| Suggestion target | configured per action (`suggested_flow_id`, dropdown of workspace workflows) | model decides *whether*, config decides *which*; no hardcoded workflow names, autofix is deprecated |
| Suggestion default routing | `always-defer` (per-effect override) | a suggestion should land in the inbox; flipping to `auto` gives an automatic bug→workflow pipeline |

## Out of scope

- A real cron trigger path (would resurrect stale/done-detector etc. — separate feature).
- PR-target actions (plumbing exists; no seeded PR action yet).
- Migrating the GUI actions page UX.

## Status

All 6 phases implemented on `feat/actions-cleanup`:

| Phase | Commit |
|---|---|
| Plan | `67f9bc0` docs: add actions cleanup plan (15 built-ins → 2 + workflow suggestions) |
| 1 — catalog consolidation | `3d28fdc` feat(actions): consolidate built-in catalog to 2 actions (auto-triage + security) |
| 2 — KB injection | `6f49b7f` feat(actions): declarative contextRefs + open-issues knowledge base injection |
| 3 — seeding unification | `6ac246e` feat(gui): seed built-in actions from the TS catalog; retire SQL seed fn |
| 4 — trigger honesty | `ce1f9a5` feat(actions): plumb real triage triggers; trim trigger enum to what fires |
| 5 — workflow suggestions | `bb0507a` feat(actions): workflow suggestions via suggest-workflow effect + inbox |
| 6 — tests + verification | (this change) catalog-drift + loader tests; manual run-now deferSink fix |

Phase 6 also fixed a functional gap: `execute-action-job.ts` (manual "run
now") ran actions without a `deferSink`, so always-defer effects (workflow
suggestions) and mid-confidence HITL effects were silently dropped instead of
landing in the inbox. It now writes `pending_decisions` rows the same way the
triage dispatch path does.

Note: `packages/gui` has no test infrastructure (no vitest/test script), so
the Phase 6 seed-helper test was skipped rather than bolting a runner onto the
Next.js workspace; `seedDefaultActions` remains covered by manual verification.

**Remaining manual steps:**

1. Apply migration `0044_consolidate_default_actions.sql` to the Supabase
   project (adds `context_refs` / `effect_routing` / `suggested_flow_id`,
   deletes retired built-in rows, syncs the 2 kept rows, drops
   `seed_default_actions`).
2. Per workspace: configure a suggested workflow on the `auto-triage` action
   (the action editor's workflow dropdown — saved via the override-by-copy
   pattern) to enable "Run workflow" inbox suggestions; with none configured
   the `suggest-workflow` tool is simply not exposed.
3. Run the Phase 6 manual verification checklist above against a fresh
   workspace.
