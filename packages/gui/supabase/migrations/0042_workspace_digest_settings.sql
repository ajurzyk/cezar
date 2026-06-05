-- 0042_workspace_digest_settings.sql
-- §5: Decouple metadata sync from AI digests (cost + cadence control).
--
-- Issue/PR metadata is cheap to pull; digests are the only LLM spend in a sync.
-- Bundling them meant "sync more often" silently meant "spend more often". This
-- gives digests their OWN cadence, independent of `sync_interval_minutes`:
--
--   * digest_mode = 'auto'   — digests run on their own (typically slower)
--                              cadence, gated by digest_interval_minutes.
--   * digest_mode = 'manual' — digests never run during cron/auto syncs; only
--                              an admin's "Generate digests now" (or the initial
--                              import) produces them.
--   * digest_mode = 'off'    — digests never run; the inbox shows raw titles.
--
-- `last_digested_at` is the per-workspace cadence marker the gate compares
-- against: in auto mode the digest phase runs only when it's null or older than
-- digest_interval_minutes ago. Stored on `workspaces` (not `sync_status`) so the
-- sync engine reads mode + interval + marker in the single workspace SELECT it
-- already issues, and updates the marker in one indexed write when digests run.

alter table workspaces
  add column digest_mode text not null default 'auto'
    check (digest_mode in ('auto', 'manual', 'off')),
  add column digest_interval_minutes integer not null default 60
    check (digest_interval_minutes >= 15),
  add column last_digested_at timestamptz;

comment on column workspaces.digest_mode is
  'auto (default): the digest phase of a sync runs on its own cadence
   (digest_interval_minutes), independent of sync_interval_minutes. manual:
   digests run only on the initial import or via the admin "Generate digests
   now" action. off: digests never run (inbox shows raw issue titles/bodies).';
comment on column workspaces.digest_interval_minutes is
  'Minimum minutes between automatic digest passes (digest_mode=auto). The
   digest phase is skipped when last_digested_at is newer than this. Floored at
   15 — digests are LLM spend, so the minimum cadence is coarser than sync.';
comment on column workspaces.last_digested_at is
  'When the digest phase last actually ran (regardless of mode). The auto-mode
   cadence gate compares this against digest_interval_minutes. Null until the
   first digest pass.';
