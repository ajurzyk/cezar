-- 0043_jobs_kind_action.sql
-- Queue manual "run action on issue/PR" instead of running it synchronously.
--
-- The "Run action" modal used to call a server action that ran `core.runAction`
-- inline and only returned when it finished — blocking the UI for the whole run
-- (often minutes). The modal now enqueues an `action` job that the dispatch
-- worker claims and runs in the background (see execute-action-job.ts), freeing
-- the UI immediately. Each job references a pre-created `workflow_runs` row via
-- `payload->>'runId'` so the cockpit can render its live progress.

-- ─── extend jobs.kind ───────────────────────────────────────────────────
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('triage','autofix','ci-followup','flow','label-analysis','sync','action'));
