-- 0037_jobs_kind_sync.sql
-- Unified sync — one `sync` job per workspace, run by the dispatch worker.
--
-- Phase B of the unified-sync refactor replaces the two fragmented reconcile
-- crons (`issue-sync`, `prs-sync`) with a single `/api/cron/sync` sweep that
-- enqueues a deduped `sync` job per workspace; the existing dispatch worker
-- claims it and runs the shared sync engine (issues + PRs + digests + comments).

-- ─── extend jobs.kind ───────────────────────────────────────────────────
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('triage','autofix','ci-followup','flow','label-analysis','sync'));

-- ─── at-most-one open sync job per workspace ────────────────────────────
-- The sweep dedupes with a check-then-insert; this partial unique index is
-- the real guard, so a lost race surfaces as a 23505 the sweep swallows as a
-- benign no-op (already-enqueued). "Open" = status in queued/claimed/running;
-- a job that reaches done/failed/cancelled no longer counts, so the next tick
-- can enqueue again.
create unique index if not exists jobs_sync_open_uniq
  on jobs (workspace_id)
  where kind = 'sync'
    and status in ('queued', 'claimed', 'running');
