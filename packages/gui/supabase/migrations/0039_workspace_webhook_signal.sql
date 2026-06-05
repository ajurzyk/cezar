-- Per-workspace "last webhook delivery" signal — powers the header sync
-- indicator's "⚡ Live" vs "⏱ Polling" state (spec §1).
--
-- A workspace with a healthy GitHub App webhook updates in seconds; one whose
-- App was uninstalled or whose `GITHUB_APP_WEBHOOK_SECRET` is unset silently
-- falls back to the cron reconcile interval. The receiver stamps these columns
-- on every matched (non-ping) delivery so the UI can tell the two apart without
-- scanning the global, 48h-GC'd `webhook_deliveries` table.

alter table workspaces
  add column last_webhook_received_at timestamptz,
  add column last_webhook_event       text;

comment on column workspaces.last_webhook_received_at is
  'Timestamp of the most recent GitHub App webhook delivery matched to this
   workspace. Non-null + recent ⇒ the live path is healthy; the sync indicator
   reads it (with installation_id + the receiver-active flag) to show Live vs
   Polling. Set best-effort by app/api/github/webhook/route.ts.';

comment on column workspaces.last_webhook_event is
  'The `X-GitHub-Event` name of the most recent matched webhook delivery
   (e.g. `issues`, `pull_request`) — companion to last_webhook_received_at.';
