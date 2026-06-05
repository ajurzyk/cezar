-- §2: First-sync progress — flag the initial full import so the UI can show a
-- determinate "Importing" progress bar (n/total digested) instead of an
-- indeterminate spinner. Subsequent (incremental) syncs leave this false and
-- keep the subtle pulsing dot. Derivable from `store.getMeta().fullSyncedAt`,
-- but stored here so the indicator doesn't need a second read.
alter table sync_status add column initial boolean not null default false;

comment on column sync_status.initial is
  'True while the workspace''s first full (all-states) import is running, so the '
  'sync indicator renders a determinate import bar (n/total digested) rather '
  'than the subtle pulsing dot used for fast incremental syncs.';
