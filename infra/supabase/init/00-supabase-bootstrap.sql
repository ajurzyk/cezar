-- Bootstrap for a plain `postgres:15` instance to look enough like a Supabase
-- DB for GoTrue + PostgREST + our migrations to apply unchanged.
--
-- Runs once on first boot via /docker-entrypoint-initdb.d. Idempotent (`if not
-- exists`) so re-running is safe if you bind a fresh volume on top of an
-- existing data dir.

-- ─── Extensions ───────────────────────────────────────────────────────────
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ─── Roles ───────────────────────────────────────────────────────────────
-- `anon`, `authenticated`, `service_role` are the JWT-claim roles PostgREST
-- and our RLS policies switch into. `authenticator` is the connection role
-- PostgREST uses; it does `SET ROLE` to the JWT's role per request.
-- `supabase_admin` + `supabase_auth_admin` mirror what GoTrue expects.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin login password 'postgres' superuser createrole createdb replication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login password 'postgres' createrole noinherit;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ─── auth schema (GoTrue migrates the rest itself) ────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
grant all on schema auth to supabase_auth_admin;
alter schema auth owner to supabase_auth_admin;

-- GoTrue's 00_init_auth_schema migration creates auth.uid()/auth.role()
-- itself; we just need the schema to exist + supabase_auth_admin to own it.

-- ─── realtime/storage schemas (so GoTrue/realtime can attach) ────────────
create schema if not exists _realtime;
grant all on schema _realtime to supabase_admin;

create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;

-- Hosted Supabase pre-creates an empty `supabase_realtime` publication and
-- migrations (e.g. 0008_agent_runs.sql) add tables to it. The supabase/realtime
-- container won't tail anything otherwise — its WAL listener has no slot.
-- The publication must exist BEFORE our migrations run; bootstrap is the right
-- place since it runs once on a fresh data dir.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
