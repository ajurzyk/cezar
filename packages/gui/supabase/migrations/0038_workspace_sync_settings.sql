-- 0038_workspace_sync_settings.sql
-- Per-workspace control over the unified sync (migration 0037 / Phase B).
--
--   * sync_mode = 'auto'   — the `/api/cron/sync` sweep enqueues a sync job
--                            once per `sync_interval_minutes` (default).
--   * sync_mode = 'manual' — the cron never auto-enqueues; the workspace syncs
--                            only when an admin clicks "sync now" in the header.
--
-- `sync_interval_minutes` is the minimum gap between automatic syncs; the sweep
-- skips a workspace whose last sync finished less than this ago. Floored at 5
-- since the cron tick itself runs every 5 minutes — a smaller value can't sync
-- any more often.

alter table workspaces
  add column sync_mode text not null default 'auto'
    check (sync_mode in ('auto', 'manual')),
  add column sync_interval_minutes integer not null default 15
    check (sync_interval_minutes >= 5);

comment on column workspaces.sync_mode is
  'auto (default): the /api/cron/sync sweep auto-enqueues sync jobs on the
   sync_interval_minutes cadence. manual: only the header "sync now" triggers a
   sync.';
comment on column workspaces.sync_interval_minutes is
  'Minimum minutes between automatic syncs (sync_mode=auto). The sweep skips a
   workspace whose last sync finished less than this ago. Floored at 5 (the
   cron tick cadence).';
