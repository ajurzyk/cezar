-- Simple workflow chains — one row per "flow" (a named chain of skill steps).
--
--   * Each flow has a name (e.g. "fix github issue") and an ordered list of
--     `{ skill, argsTemplate, stopChainIfContains? }` pairs. The skill is
--     the markdown file name under `<repo>/.ai/skills/` (no extension),
--     discovered via `repo_skills` (migration 0007).
--   * The args template renders against a fixed scope:
--       {{input}}                  — the value passed when the flow is run
--       {{previousTaskId}}         — id of the previous step's agent_run
--       {{previousPullRequestUrl}} — url of any PR opened during the previous step
--       {{previousPullRequestNumber}}
--     PR variables are extracted from `PR_URL=…` / `PR_NUMBER=…` markers in
--     the previous step's agent text output (soft contract with the skill body).
--   * `stopChainIfContains` (optional, per-step) — when the step's text output
--     contains this substring, the chain ends cleanly with status `succeeded`
--     and reason "stopped at step N…". Lets gating skills short-circuit
--     without a JSON contract.
--   * `triggers` — array of trigger objects matched by the GitHub App webhook.
--     Today's shapes:
--       { "kind": "issue.opened" }
--       { "kind": "issue.labeled", "label": "auto-fix" }
--     The dispatcher dedupes against in-flight (workspace, flow, issue) jobs.
--   * `paused` — operational kill switch. Paused flows skip auto-triggers
--     but stay editable + manually runnable.
--
-- The dispatcher (execute-workflow-job.ts) handles `kind='flow'` by loading
-- the row, building an in-memory `Workflow` (one agent step per flow step),
-- and running it through the existing engine.

create table flows (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  -- Array of `{ skill: text, argsTemplate: text, stopChainIfContains?: text }`.
  -- Empty steps array is allowed (save a flow before adding steps); the
  -- dispatcher rejects empty steps at run time.
  steps         jsonb not null default '[]'::jsonb,
  -- Array of trigger objects matched by the webhook receiver.
  triggers      jsonb not null default '[]'::jsonb,
  -- Operational kill switch — paused flows skip webhook auto-triggers but
  -- remain editable and manually runnable.
  paused        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index flows_workspace_name_unique on flows (workspace_id, name);
create index flows_workspace_idx on flows(workspace_id);

-- Speeds up the webhook trigger lookup (rare but bursty traffic — every
-- issues event against any installed repo). GIN over the JSONB array makes
-- the trigger search index-eligible without a separate row-per-trigger table.
create index flows_triggers_gin on flows using gin (triggers);

-- Allow `jobs.kind = 'flow'` so the dispatcher can claim flow runs.
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('triage','autofix','ci-followup','flow'));

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table flows enable row level security;
create policy "flows_member_select" on flows
  for select using (is_workspace_member(workspace_id));
create policy "flows_admin_write" on flows
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- ─── updated_at trigger ─────────────────────────────────────────────────
create trigger flows_touch before update on flows
  for each row execute function touch_updated_at();
