-- 0028_fix_seed_default_actions_conflict.sql
-- Fix the dangling ON CONFLICT target in seed_default_actions left behind
-- by 0015_action_overrides.sql.
--
-- 0014 created seed_default_actions(uuid) with
--   `on conflict (workspace_id, name) do nothing`
-- in all 15 inserts, targeting the unique constraint
-- actions_workspace_id_name_key.
--
-- 0015 dropped that constraint and replaced it with
--   actions_workspace_id_name_kind_key (workspace_id, name, kind)
-- so user-overrides can share a name with the built-in they replace.
-- The seed function was never updated, so any call to it raises
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- on the very first insert. The workspace-creation server action swallows
-- that error (logs only -- see packages/gui/src/app/workspaces/actions.ts),
-- so every workspace created after 0015 has zero rows in `actions` and a
-- NULL `workspaces.auto_triage_action_id`.
--
-- Rewriting the function body to use (workspace_id, name, kind) restores
-- the original behaviour; backfilling every workspace recovers the empty
-- ones (seed_default_actions is idempotent -- DO NOTHING + the
-- auto_triage_action_id update is guarded by `IS NULL`).

do $migrate$
declare
  v_src text;
  v_new text;
begin
  v_src := pg_get_functiondef('public.seed_default_actions(uuid)'::regprocedure);
  v_new := regexp_replace(
    v_src,
    'on conflict \(workspace_id, name\) do nothing',
    'on conflict (workspace_id, name, kind) do nothing',
    'gi'
  );
  if v_new = v_src then
    raise notice 'seed_default_actions: ON CONFLICT target already correct, skipping rewrite';
  else
    execute v_new;
    raise notice 'seed_default_actions: ON CONFLICT target rewritten to (workspace_id, name, kind)';
  end if;
end
$migrate$;

-- Backfill: re-seed every existing workspace. Idempotent on already-seeded
-- workspaces (ON CONFLICT DO NOTHING + auto_triage pointer guarded by IS NULL),
-- so this is safe to run on workspaces that were unaffected and recovers the
-- ones that were stuck empty since 0015.
do $backfill$
declare
  ws record;
begin
  for ws in select id from workspaces loop
    perform seed_default_actions(ws.id);
  end loop;
end
$backfill$;
