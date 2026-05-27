-- Repo label management — analysis + accepted catalog.
--
-- A label-analysis job pulls the repo's current labels, scans the codebase
-- for label guidance, walks the last 100 issues + 100 PRs (timeline events,
-- comments, label add/remove actions), asks Claude to synthesize a catalog,
-- and writes the draft to `workspace_label_analyses.result`. When the user
-- accepts the draft (optionally edited), the catalog is materialized into
-- `workspace_labels` (one row per label per scope: issue|pr|both).
--
-- The job runs through the existing `jobs` queue (`kind='label-analysis'`)
-- but bypasses the workflow_runs persister — it's not a per-issue/PR
-- workflow, so it routes off run-dispatch.ts directly to a dedicated
-- executor and only ever writes to the two tables below.

-- ─── extend jobs.kind ───────────────────────────────────────────────────
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('triage','autofix','ci-followup','flow','label-analysis'));

-- ─── workspace_label_analyses ───────────────────────────────────────────
-- One row per analysis run. Lifecycle:
--   queued    — job enqueued, no executor has picked it up yet
--   running   — executor is fetching inputs + calling Claude
--   completed — `result` is populated, awaiting user review
--   accepted  — user reviewed + accepted; `workspace_labels` materialized
--   failed    — executor errored; `error` is populated
--   cancelled — user cancelled before completion
create table workspace_label_analyses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  job_id          uuid references jobs(id) on delete set null,
  status          text not null default 'queued'
                    check (status in ('queued','running','completed','accepted','failed','cancelled')),
  started_at      timestamptz,
  finished_at     timestamptz,
  -- AI draft, shape: { issue_labels: LabelDraft[], pr_labels: LabelDraft[], notes?: string }
  -- where LabelDraft = { name, color?, description, when_to_add, when_to_remove,
  --                      add_meaning, remove_meaning, exists_on_github }.
  result          jsonb,
  error           text,
  -- Provenance summary so reinit/UI can show what was scanned without
  -- re-fetching: { github_labels, issues_scanned, prs_scanned, codebase_files[] }
  inputs_summary  jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index workspace_label_analyses_workspace_created_idx
  on workspace_label_analyses(workspace_id, created_at desc);
create index workspace_label_analyses_job_idx
  on workspace_label_analyses(job_id) where job_id is not null;

create trigger workspace_label_analyses_touch before update on workspace_label_analyses
  for each row execute function touch_updated_at();

-- ─── workspace_labels ───────────────────────────────────────────────────
-- The accepted catalog. One row per (workspace, name, scope). `scope='both'`
-- is allowed so a label that applies identically to issues and PRs doesn't
-- need to be duplicated; the UI normalizes on read.
create table workspace_labels (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  analysis_id       uuid references workspace_label_analyses(id) on delete set null,
  name              text not null,
  scope             text not null check (scope in ('issue','pr','both')),
  color             text,                         -- hex w/o leading '#'
  description       text,
  when_to_add       text,
  when_to_remove    text,
  add_meaning       text,
  remove_meaning    text,
  exists_on_github  boolean not null default true,
  source            text not null default 'ai-analyzed'
                      check (source in ('ai-analyzed','user-edited','manual')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, name, scope)
);

create index workspace_labels_workspace_idx on workspace_labels(workspace_id);

create trigger workspace_labels_touch before update on workspace_labels
  for each row execute function touch_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table workspace_label_analyses enable row level security;
create policy "workspace_label_analyses_member_select" on workspace_label_analyses
  for select using (is_workspace_member(workspace_id));
create policy "workspace_label_analyses_admin_write" on workspace_label_analyses
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

alter table workspace_labels enable row level security;
create policy "workspace_labels_member_select" on workspace_labels
  for select using (is_workspace_member(workspace_id));
create policy "workspace_labels_admin_write" on workspace_labels
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));
