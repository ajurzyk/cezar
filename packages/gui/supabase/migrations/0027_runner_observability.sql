-- 0027_runner_observability.sql
-- Phase 5 of the runner horizontal-scaling effort. Operational observability:
--
-- (A) `agent_runs.runner_id` — attribute every step row to the runner that
--     served it. NULL means the cron dispatch path (anthropic-api) handled the
--     step; the runner-driven path stamps the daemon's own runner UUID. The
--     cockpit `/cockpit/[runId]` page renders a small chip per step from this.
--
-- (B) `runners.utilization` JSONB — a snapshot of the runner's load reported
--     on each heartbeat (`{ inflight, capacity, cpuLoad, freeMemMb, totalMemMb,
--     nodeVersion, uptimeSec, capturedAt }`). The cockpit `/cockpit/runners`
--     page reads the latest snapshot. We do NOT aggregate or time-series here —
--     a JSONB snapshot is sufficient for operator-grade observability and keeps
--     the migration / heartbeat write paths trivial.
--
-- (C) Extends the `ingest_runner_events` RPC (last bumped in 0024 for
--     `session_id`) to plumb a per-event `runnerId` through to
--     `agent_runs.runner_id`. Same `coalesce` first-writer-wins semantic as
--     session_id, so a re-delivered batch never overwrites the originating
--     runner with NULL.

-- ─── agent_runs.runner_id ───────────────────────────────────────────────
alter table agent_runs
  add column if not exists runner_id uuid references runners(id) on delete set null;

create index if not exists agent_runs_runner_idx
  on agent_runs (runner_id)
  where runner_id is not null;

-- ─── runners.utilization ────────────────────────────────────────────────
alter table runners
  add column if not exists utilization jsonb;

-- ─── ingest_runner_events: plumb runner_id through ──────────────────────
-- Reproduces the 0024 definition and extends it: every step event now reads a
-- `runnerId` field off the envelope and `coalesce`s it onto
-- `agent_runs.runner_id` (first-writer-wins). Other behavior is unchanged.

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
  v_session_id  text;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    return;
  end if;

  -- 1. step-start: open an agent_runs row per step. Idempotent on the unique
  --    key so a re-delivered batch doesn't double-insert; the running row
  --    stays in place until step-end (#2) closes it. `runner_id` is set on
  --    first delivery; subsequent re-deliveries `coalesce` so the originating
  --    runner isn't overwritten with NULL.
  insert into agent_runs (
    workspace_id, workflow_run_id, step_id, iteration, kind, backend, model,
    status, started_at, session_id, runner_id
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
    coalesce((e->>'startedAt')::timestamptz, now()),
    e->>'sessionId',
    nullif(e->>'runnerId', '')::uuid
  from jsonb_array_elements(p_events) as e
  where e->>'type' = 'step-start'
    and e->>'stepId' is not null
  on conflict (workflow_run_id, step_id, iteration) do update set
    session_id = coalesce(agent_runs.session_id, excluded.session_id),
    runner_id  = coalesce(agent_runs.runner_id,  excluded.runner_id);

  -- 2. step-end: close the matching row (or insert a closed row if step-start
  --    was never delivered for it — the route's previous fallback path).
  insert into agent_runs (
    workspace_id, workflow_run_id, step_id, iteration, kind, backend, model,
    status, started_at, finished_at, tokens_used, summary, error, session_id, runner_id
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
    e->>'error',
    e->>'sessionId',
    nullif(e->>'runnerId', '')::uuid
  from jsonb_array_elements(p_events) as e
  where e->>'type' = 'step-end'
    and e->>'stepId' is not null
  on conflict (workflow_run_id, step_id, iteration) do update set
    status      = excluded.status,
    finished_at = excluded.finished_at,
    tokens_used = excluded.tokens_used,
    summary     = excluded.summary,
    error       = excluded.error,
    kind        = coalesce(agent_runs.kind, excluded.kind),
    session_id  = coalesce(agent_runs.session_id, excluded.session_id),
    runner_id   = coalesce(agent_runs.runner_id,  excluded.runner_id);

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
  --    is updated to the last step touched in this batch. session_id adopts
  --    the first non-null sessionId in the batch — once set it stays set
  --    (coalesce keeps the existing value), so the same id survives runner
  --    restarts.
  select
    coalesce(sum( (e->>'tokensUsed')::int ) filter (where (e->>'tokensUsed') is not null), 0),
    (
      select e2->>'stepId'
        from jsonb_array_elements(p_events) with ordinality as t2(e2, ord)
       where e2->>'stepId' is not null
       order by t2.ord desc
       limit 1
    ),
    (
      select e3->>'sessionId'
        from jsonb_array_elements(p_events) with ordinality as t3(e3, ord)
       where e3->>'sessionId' is not null
       order by t3.ord asc
       limit 1
    )
  into v_token_delta, v_last_step, v_session_id
  from jsonb_array_elements(p_events) as e;

  if v_token_delta > 0 or v_last_step is not null or v_session_id is not null then
    update workflow_runs
       set tokens_used     = tokens_used + coalesce(v_token_delta, 0),
           current_step_id = coalesce(v_last_step, current_step_id),
           session_id      = coalesce(session_id, v_session_id)
     where id = p_run_id;
  end if;
end;
$$;

grant execute on function ingest_runner_events(uuid, uuid, jsonb) to anon, authenticated, service_role;
