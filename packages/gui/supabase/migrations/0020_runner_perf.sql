-- Runner hot-path collapse: 4-query heartbeat → 1 RPC, N+2-query event ingest
-- → 1 RPC. Production symptom was bimodal 200ms / 10-16s tail latency on
-- /api/runner/heartbeat and /api/runner/runs/:id/events under multi-runner
-- load — caused by PgBouncer pool starvation from chatty per-request
-- pipelines (heartbeat = 4 sequential statements, a 25-event batch = 30-60
-- sequential statements). Both endpoints now do a single RPC round-trip.

-- ─── agent_runs unique key ─────────────────────────────────────────────
-- Required by ingest_runner_events' `on conflict` upsert: a step's
-- (workflow_run_id, step_id, iteration) is logically unique already, the
-- constraint just makes it enforceable so the RPC can be set-based.
alter table agent_runs
  add constraint agent_runs_run_step_iter_uniq
  unique (workflow_run_id, step_id, iteration);

-- ─── runner_heartbeat ──────────────────────────────────────────────────
-- Replaces the per-heartbeat sequence:
--   UPDATE runners …
--   SELECT cancelled jobs claimed by this runner
--   SELECT this runner's active jobs
--   SELECT workflow_runs.pause_requested for those jobs
-- with a single CTE pipeline that runs in one round-trip and returns
-- (cancel_job_ids, pause_run_ids).
create or replace function runner_heartbeat(
  p_runner_id uuid,
  p_status    text default 'online'
) returns table (cancel_job_ids uuid[], pause_run_ids uuid[])
language sql
as $$
  with hb as (
    update runners
       set last_heartbeat_at = now(),
           status            = coalesce(p_status, status),
           updated_at        = now()
     where id = p_runner_id
     returning id
  ),
  -- Single pass over `jobs` partitioned by status: cancellations + the set of
  -- active jobs whose workflow_runs we'll check for pause_requested.
  runner_jobs as (
    select id, status
      from jobs
     where claimed_by_runner = p_runner_id
       and status in ('claimed', 'running', 'cancelled')
  ),
  cancels as (
    select coalesce(array_agg(id), '{}'::uuid[]) as ids
      from runner_jobs
     where status = 'cancelled'
  ),
  pauses as (
    select coalesce(array_agg(wr.id), '{}'::uuid[]) as ids
      from workflow_runs wr
      join runner_jobs rj on rj.id = wr.job_id
     where wr.pause_requested = true
       and rj.status in ('claimed', 'running')
  )
  select cancels.ids, pauses.ids
    from hb, cancels, pauses;
$$;

-- ─── ingest_runner_events ──────────────────────────────────────────────
-- Replaces the per-batch loop in /api/runner/runs/:id/events. A 25-event
-- batch previously generated ~30-60 statements (insert agent_runs per
-- step-start, update agent_runs per step-end, insert agent_run_events per
-- event, select-then-update workflow_runs.tokens_used). This function runs
-- the whole batch in three set-based statements + one workflow_runs update,
-- all in a single round-trip, and makes the token rollup atomic
-- (`tokens_used = tokens_used + delta`).
--
-- The event payload shape mirrors `RunnerEvent` (packages/runner/src/runner-client.ts):
--   { type, payload, stepId?, iteration?, kind?, backend?, model?, status?,
--     summary?, error?, tokensUsed?, startedAt?, finishedAt? }
--
-- Caller guarantees: p_run_id is a real workflow_runs.id whose workspace
-- equals p_workspace_id (the route does this check before calling).
create or replace function ingest_runner_events(
  p_run_id       uuid,
  p_workspace_id uuid,
  p_events       jsonb
) returns void
language plpgsql
as $$
declare
  v_token_delta int;
  v_last_step   text;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    return;
  end if;

  -- 1. step-start: open an agent_runs row per step. Idempotent on the unique
  --    key so a re-delivered batch doesn't double-insert; the running row
  --    stays in place until step-end (#2) closes it.
  insert into agent_runs (
    workspace_id, workflow_run_id, step_id, iteration, kind, backend, model,
    status, started_at
  )
  select
    p_workspace_id,
    p_run_id,
    e->>'stepId',
    coalesce((e->>'iteration')::int, 1),
    e->>'kind',
    e->>'backend',
    e->>'model',
    'running',
    coalesce((e->>'startedAt')::timestamptz, now())
  from jsonb_array_elements(p_events) as e
  where e->>'type' = 'step-start'
    and e->>'stepId' is not null
  on conflict (workflow_run_id, step_id, iteration) do nothing;

  -- 2. step-end: close the matching row (or insert a closed row if step-start
  --    was never delivered for it — the route's previous fallback path).
  insert into agent_runs (
    workspace_id, workflow_run_id, step_id, iteration, kind, backend, model,
    status, started_at, finished_at, tokens_used, summary, error
  )
  select
    p_workspace_id,
    p_run_id,
    e->>'stepId',
    coalesce((e->>'iteration')::int, 1),
    e->>'kind',
    e->>'backend',
    e->>'model',
    case e->>'status'
      when 'succeeded' then 'succeeded'
      when 'skipped'   then 'skipped'
      when 'running'   then 'running'
      else 'failed'
    end,
    coalesce((e->>'startedAt')::timestamptz, now()),
    coalesce((e->>'finishedAt')::timestamptz, now()),
    coalesce((e->>'tokensUsed')::int, 0),
    e->>'summary',
    e->>'error'
  from jsonb_array_elements(p_events) as e
  where e->>'type' = 'step-end'
    and e->>'stepId' is not null
  on conflict (workflow_run_id, step_id, iteration) do update set
    status      = excluded.status,
    finished_at = excluded.finished_at,
    tokens_used = excluded.tokens_used,
    summary     = excluded.summary,
    error       = excluded.error,
    kind        = coalesce(agent_runs.kind, excluded.kind);

  -- 3. agent_run_events: one insert for the whole batch. agent_run_id is
  --    resolved via join (NULL for events with no stepId, e.g. lifecycle).
  --    `with ordinality` + ORDER BY preserves the runner's emission order so
  --    the auto-assigned identity values are stable for the cockpit's
  --    chronological view.
  insert into agent_run_events (workspace_id, workflow_run_id, agent_run_id, type, payload)
  select
    p_workspace_id,
    p_run_id,
    ar.id,
    case
      when ev.e->>'type' in ('lifecycle','agent-text','tool-call','tool-result','note','step-start','step-end')
        then ev.e->>'type'
      else 'note'
    end,
    coalesce(ev.e->'payload', '{}'::jsonb)
  from jsonb_array_elements(p_events) with ordinality as ev(e, ord)
  left join agent_runs ar
    on ar.workflow_run_id = p_run_id
   and ar.step_id         = ev.e->>'stepId'
   and ar.iteration       = coalesce((ev.e->>'iteration')::int, 1)
  order by ev.ord;

  -- 4. workflow_runs roll-up. Tokens go through `tokens_used = tokens_used +
  --    delta` so concurrent batches can't lose increments. current_step_id
  --    is updated to the last step touched in this batch.
  select
    coalesce(sum( (e->>'tokensUsed')::int ) filter (where (e->>'tokensUsed') is not null), 0),
    (
      select e2->>'stepId'
        from jsonb_array_elements(p_events) with ordinality as t2(e2, ord)
       where e2->>'stepId' is not null
       order by t2.ord desc
       limit 1
    )
  into v_token_delta, v_last_step
  from jsonb_array_elements(p_events) as e;

  if v_token_delta > 0 or v_last_step is not null then
    update workflow_runs
       set tokens_used     = tokens_used + coalesce(v_token_delta, 0),
           current_step_id = coalesce(v_last_step, current_step_id)
     where id = p_run_id;
  end if;
end;
$$;

-- Runner API routes call these via the service-role key (bypasses RLS); the
-- function bodies are the trust boundary, not who may invoke them. Same
-- pattern as 0010_runner_api.sql.
grant execute on function runner_heartbeat(uuid, text)                       to anon, authenticated, service_role;
grant execute on function ingest_runner_events(uuid, uuid, jsonb)            to anon, authenticated, service_role;
