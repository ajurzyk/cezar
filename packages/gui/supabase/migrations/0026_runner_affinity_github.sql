-- 0026_runner_affinity_github.sql
-- Phase 4 of the runner horizontal-scaling effort. Two related changes,
-- both gated on this migration:
--
-- (A) Soft affinity routing for multi-step workflows. A workflow is several
--     jobs (often triage → autofix → ci-followup). After step 1 finishes on
--     runner A, the bare clone is warm, `~/.claude/` is populated, and the
--     Claude session_id exists on disk on host A. If step 2 lands on runner
--     B all that state is cold/unreachable. So follow-up jobs *prefer* the
--     runner that ran the parent — but not hard-pin, so a slow / dead runner
--     can't strand the workflow. `preferred_until` gives a soft window
--     (default 30s on the enqueue side) after which any matching runner can
--     claim.
--
-- (B) Per-runner GitHub identity, with inheritance. Three modes per runner:
--      1. per-runner App install  (runners.github_installation_id set)
--      2. inherit workspace       (default — both new columns NULL/false)
--      3. inherit host            (runners.github_inherit_host true → the
--                                  runner mints its own token from `gh auth
--                                  token` / GITHUB_TOKEN; the central does
--                                  NOT mint anything for these runs)
--     Precedence (mirrored in the claim route): if both `inherit_host` AND
--     `github_installation_id` are set, `inherit_host` wins.

-- ─── jobs: soft affinity columns ────────────────────────────────────────
alter table jobs
  add column if not exists preferred_runner_id uuid references runners(id) on delete set null,
  add column if not exists preferred_until timestamptz;

-- Partial index covering the hot path: scan only queued rows with a
-- preference set. Drops `preferred_until` from the predicate (a partial
-- index with `now()` would not be immutable); the function's WHERE handles
-- the time filter at claim time.
create index if not exists jobs_preferred_runner_idx
  on jobs (preferred_runner_id)
  where preferred_runner_id is not null and status = 'queued';

-- ─── runners: per-runner GH identity ────────────────────────────────────
-- `github_installation_id` is `bigint` because GitHub install ids can exceed
-- 2^31. NULL = no per-runner install configured.
alter table runners
  add column if not exists github_installation_id bigint,
  add column if not exists github_inherit_host boolean not null default false;

-- ─── claim_next_job_for_runner ──────────────────────────────────────────
-- Supersedes the 0025 definition. Adds soft affinity:
--   * a job's preferred runner can claim it whenever (preferred_until is
--     advisory only on the fallback path);
--   * any other runner can also claim it once the preference is unset OR
--     the preferred_until window has passed;
--   * within the resulting candidate set, preferred-runner matches sort
--     ahead of fallback matches, then the usual priority/scheduled_at.
create or replace function claim_next_job_for_runner(
  p_runner_id uuid,
  p_backends  text[],
  p_limit     int default 1,
  p_lease_seconds int default 60
)
returns setof jobs
language plpgsql
as $$
declare
  v_now timestamptz := now();
begin
  return query
  update jobs
     set status            = 'claimed',
         claimed_by_runner = p_runner_id,
         claim_expires_at  = v_now + make_interval(secs => p_lease_seconds),
         attempts          = attempts + 1,
         updated_at        = v_now
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= v_now
        and kind <> 'label-analysis'
        and (required_backend is null or required_backend = any(p_backends))
        and (
          -- this runner is the preferred one (affinity match)
          preferred_runner_id = p_runner_id
          -- or no preference set
          or preferred_runner_id is null
          -- or the soft-affinity window has expired (fallback)
          or preferred_until is null
          or preferred_until <= v_now
        )
      order by
        -- prioritize affinity matches over fallback matches
        case when preferred_runner_id = p_runner_id then 0 else 1 end,
        priority desc,
        scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
end;
$$;

grant execute on function claim_next_job_for_runner(uuid, text[], int, int)
  to anon, authenticated, service_role;
