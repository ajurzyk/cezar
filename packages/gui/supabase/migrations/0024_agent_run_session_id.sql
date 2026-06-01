-- 0024_agent_run_session_id.sql
-- Persist the Claude session UUID per agent run so multi-step workflows can
-- reuse a single warm session, and so a re-claimed job can resume with
-- `claude --resume <sessionId>` after a runner crash (same host) or fall back
-- to a fresh start under the same id (cross-host re-claims).
--
-- Schema:
--   agent_runs.session_id     — per-step, the session that drove this step.
--                                Today the same id is reused across every step
--                                in a workflow run (each row carries it for the
--                                cockpit / debugging); future per-step sessions
--                                would diverge here.
--   workflow_runs.session_id  — the canonical "session to resume" for this run,
--                                set by the first step that minted one. Re-claims
--                                read this column to pass `claude --resume <id>`.
--
-- The `ingest_runner_events` RPC is extended to accept a `sessionId` on each
-- step event so the runner can plumb it through the same wire path as
-- `tokensUsed` / `startedAt`. The workflow_runs roll-up adopts the first
-- non-null session_id it sees in a batch (idempotent — later batches will
-- usually carry the same id, and `coalesce` keeps the first one set).

alter table agent_runs
  add column if not exists session_id text;

alter table workflow_runs
  add column if not exists session_id text;

create index if not exists agent_runs_session_id_idx
  on agent_runs (session_id)
  where session_id is not null;

create index if not exists workflow_runs_session_id_idx
  on workflow_runs (session_id)
  where session_id is not null;

-- ─── Update ingest_runner_events to plumb session_id through ────────────
--
-- The runner already POSTs a `sessionId` field on `step-start` / `step-end`
-- envelopes (see packages/runner/src/runner-client.ts). The RPC writes it to
-- `agent_runs.session_id` (same upsert path as tokens / status) and adopts the
-- first non-null one it sees into `workflow_runs.session_id` so a re-claimed
-- runner can resume.

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
  --    stays in place until step-end (#2) closes it.
  insert into agent_runs (
    workspace_id, workflow_run_id, step_id, iteration, kind, backend, model,
    status, started_at, session_id
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
    e->>'sessionId'
  from jsonb_array_elements(p_events) as e
  where e->>'type' = 'step-start'
    and e->>'stepId' is not null
  on conflict (workflow_run_id, step_id, iteration) do update set
    session_id = coalesce(agent_runs.session_id, excluded.session_id);

  -- 2. step-end: close the matching row (or insert a closed row if step-start
  --    was never delivered for it — the route's previous fallback path).
  insert into agent_runs (
    workspace_id, workflow_run_id, step_id, iteration, kind, backend, model,
    status, started_at, finished_at, tokens_used, summary, error, session_id
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
    e->>'sessionId'
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
    session_id  = coalesce(agent_runs.session_id, excluded.session_id);

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
