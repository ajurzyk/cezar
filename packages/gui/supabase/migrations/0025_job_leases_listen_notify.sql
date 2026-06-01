-- 0025_job_leases_listen_notify.sql
-- Lease-based job claims with renewable expiry, plus a NOTIFY trigger so the
-- runner API can long-poll for new work instead of short-polling.
--
-- A claim now stamps jobs.claim_expires_at = now() + lease window. The runner
-- heartbeat renews leases for the job ids it currently holds; the watchdog
-- reclaims any job whose lease has lapsed. This replaces the 3-minute
-- runner-offline blind window (and the false-reclaim race where a runner
-- whose heartbeat is briefly slow loses its jobs even though they're
-- progressing) — the runner offline check is now cosmetic.
--
-- Lease windows:
--   * runner-side claims      → 60s   (renewed every ~2s by the heartbeat)
--   * cron-side claims        → 5min  (cron handlers are fire-and-forget but
--                                      individual jobs can run a few minutes;
--                                      the longer lease avoids needing an
--                                      in-handler renewal tick)
-- Both are tunable via the new `p_lease_seconds` arg.

alter table jobs
  add column if not exists claim_expires_at timestamptz;

-- Partial index covers the watchdog's hot path: scan only in-flight rows whose
-- lease may have lapsed.
create index if not exists jobs_claim_expires_idx
  on jobs (claim_expires_at)
  where status in ('claimed', 'running');

-- ─── claim_next_job (cron side) ─────────────────────────────────────────
-- Supersedes 0010. Adds p_lease_seconds (default 60) so callers can pick a
-- longer lease for cron-dispatched work (the cron path passes 300 = 5min).
create or replace function claim_next_job(
  p_limit int default 1,
  p_lease_seconds int default 60
)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'claimed',
         claimed_by_runner = null,
         claim_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = attempts + 1,
         updated_at = now()
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= now()
        and (required_backend is null or required_backend = 'anthropic-api')
      order by priority desc, scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- ─── claim_next_job_for_runner ──────────────────────────────────────────
-- Supersedes 0023. Stamps a 60s lease the runner heartbeat will renew.
create or replace function claim_next_job_for_runner(
  p_runner_id uuid,
  p_backends  text[],
  p_limit     int default 1,
  p_lease_seconds int default 60
)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'claimed',
         claimed_by_runner = p_runner_id,
         claim_expires_at = now() + make_interval(secs => p_lease_seconds),
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

-- ─── renew_claim_leases ─────────────────────────────────────────────────
-- Bulk-renews leases for in-flight jobs the runner currently holds. Returns
-- the ids actually renewed — anything in p_job_ids missing from the result
-- means the runner has lost its claim (watchdog reclaim, manual cancel,
-- different runner picked it up after re-queue, etc.) and should abort.
create or replace function renew_claim_leases(
  p_runner_id uuid,
  p_job_ids   uuid[],
  p_lease_seconds int default 60
)
returns table (renewed_id uuid)
language sql
as $$
  update jobs
     set claim_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at       = now()
   where id = any(p_job_ids)
     and claimed_by_runner = p_runner_id
     and status in ('claimed', 'running')
  returning id;
$$;

-- ─── requeue_jobs_for_offline_runners — now reclaims by lease expiry ────
-- Supersedes 0010. The function name is preserved so the existing cron
-- callers (lib/scheduler/run-dispatch.ts) don't have to change. Body now:
--   1. Marks self-hosted runners offline once their heartbeat lapses
--      (cosmetic — surfaces in the cockpit "runners" page).
--   2. Reclaims any job whose claim_expires_at < now(), regardless of which
--      runner held it and regardless of that runner's status. This is the
--      real correctness mechanism.
-- The p_stale_minutes arg now only controls the cosmetic runner-offline
-- threshold; job reclaim is driven purely by lease expiry.
create or replace function requeue_jobs_for_offline_runners(p_stale_minutes int default 3)
returns int
language plpgsql
as $$
declare
  v_now       timestamptz := now();
  v_reclaimed int;
begin
  -- 1. Cosmetic: mark self-hosted runners offline when their heartbeat lapses.
  update runners
     set status     = 'offline',
         updated_at = v_now
   where kind = 'self-hosted'
     and status <> 'offline'
     and (last_heartbeat_at is null
          or last_heartbeat_at < v_now - make_interval(mins => p_stale_minutes));

  -- 2. Reclaim by lease expiry — independent of runner status.
  with reclaimed as (
    update jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           claimed_by_runner = null,
           claim_expires_at  = null,
           updated_at        = v_now
     where status in ('claimed', 'running')
       and claim_expires_at is not null
       and claim_expires_at < v_now
     returning id
  )
  select count(*) into v_reclaimed from reclaimed;

  return v_reclaimed;
end;
$$;

-- ─── requeue_stalled_jobs — keep the old time-since-updated_at fallback ─
-- Still useful for jobs that pre-date this migration (claim_expires_at NULL)
-- or jobs the cron stamped without renewal where execution outlasts the
-- lease for some unforeseen reason. Now gated on claim_expires_at IS NULL so
-- it doesn't fight with the lease-driven reclaim in (2) above.
create or replace function requeue_stalled_jobs(p_stale_minutes int default 15)
returns int
language plpgsql
as $$
declare
  n int;
begin
  update jobs
     set status     = case when attempts >= max_attempts then 'failed' else 'queued' end,
         updated_at = now()
   where status in ('claimed', 'running')
     and claim_expires_at is null
     and updated_at < now() - make_interval(mins => p_stale_minutes);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ─── NOTIFY trigger: wake LISTENers when a job becomes claimable ────────
-- Fires on insert of a queued job (new work) or on update that transitions
-- a row back into queued (watchdog reclaim, retry, paused-run resume). The
-- payload carries the workspace id so listeners *could* filter; today the
-- runner API listens un-filtered and gates on backends at claim time.
create or replace function notify_jobs_queued()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT' and NEW.status = 'queued')
     or (tg_op = 'UPDATE' and NEW.status = 'queued' and (OLD.status is distinct from 'queued')) then
    perform pg_notify('jobs_queued', coalesce(NEW.workspace_id::text, ''));
  end if;
  return NEW;
end;
$$;

drop trigger if exists jobs_notify_queued on jobs;
create trigger jobs_notify_queued
after insert or update on jobs
for each row execute function notify_jobs_queued();

-- ─── grants ─────────────────────────────────────────────────────────────
grant execute on function claim_next_job(int, int)                              to anon, authenticated, service_role;
grant execute on function claim_next_job_for_runner(uuid, text[], int, int)     to anon, authenticated, service_role;
grant execute on function renew_claim_leases(uuid, uuid[], int)                 to anon, authenticated, service_role;
grant execute on function requeue_jobs_for_offline_runners(int)                 to anon, authenticated, service_role;
grant execute on function requeue_stalled_jobs(int)                             to anon, authenticated, service_role;
