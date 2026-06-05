-- §3: Stale & actionable states — classify sync failures so the indicator can
-- show a recovery CTA instead of a raw error string. The most common real
-- failures (expired/revoked OAuth token or an uninstalled GitHub App) map to
-- `auth`, which the indicator surfaces with a "Reconnect" action.
alter table sync_status add column error_kind text
  check (error_kind in ('auth', 'rate_limit', 'not_found', 'unknown'));

comment on column sync_status.error_kind is
  'Classification of the most recent sync failure (auth | rate_limit | '
  'not_found | unknown), set alongside status=''error'' so the sync indicator '
  'can render actionable copy + a recovery CTA (e.g. auth → Reconnect). Null '
  'when the last sync did not fail.';
