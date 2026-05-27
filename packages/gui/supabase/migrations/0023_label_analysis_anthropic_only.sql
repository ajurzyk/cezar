-- Enforce that `label-analysis` jobs only ever run on the cron-dispatched
-- (Anthropic API) path. The label-analysis executor calls the Anthropic SDK
-- directly and does not understand the workflow_runs / agent_runs shape that
-- the runner-API route builds — so if a self-hosted runner claimed one it
-- would either fail or strand a half-formed workflow_run row.
--
-- We layer two guards:
--   1. Application code stamps `required_backend = 'anthropic-api'` on the
--      job at enqueue time (see workspaces/actions.ts + labels-actions.ts).
--   2. This migration adds a hard SQL guard: `claim_next_job_for_runner`
--      explicitly excludes `kind = 'label-analysis'` — even a runner that
--      advertises `anthropic-api` (the runner CLI's default backend) can no
--      longer claim such a job.
--
-- The cron-side `claim_next_job` is untouched: it still accepts jobs whose
-- `required_backend` is NULL or 'anthropic-api', so label-analysis flows
-- through the cron dispatcher as today.

create or replace function claim_next_job_for_runner(p_runner_id uuid, p_backends text[], p_limit int default 1)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'claimed',
         claimed_by_runner = p_runner_id,
         attempts = attempts + 1,
         updated_at = now()
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= now()
        and kind <> 'label-analysis'
        and (required_backend is null or required_backend = any(p_backends))
      order by priority desc, scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;
