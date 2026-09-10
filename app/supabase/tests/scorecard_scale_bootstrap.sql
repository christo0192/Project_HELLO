-- Faithful-minimal screening_v2 objects that 0088/0089/0093 need, so the REAL
-- 0093 migration can be applied to a throwaway Postgres and its behaviour
-- asserted. Only the tables/roles those migrations touch or reference are
-- created here; everything else about 0093 (the immutability triggers, the
-- weight trigger, the rubric CHECKs) comes from the real 0088 file.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create schema if not exists screening_v2;
create schema if not exists extensions;
-- Supabase installs pgcrypto into `extensions`; 0089/0093 call
-- `extensions.digest`. A stock image has it in `public`, so install it there
-- and expose the one function those migrations use under `extensions`.
create extension if not exists pgcrypto;
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'digest'
  ) then
    execute 'create function extensions.digest(text, text) returns bytea language sql immutable strict as $f$ select public.digest($1, $2) $f$';
  end if;
end $$;

-- 0088 references auth.users for `created_by`.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());

create table if not exists screening_v2.roles (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Night ops',
  is_active boolean not null default true,
  active_scorecard_version_id uuid
);

-- The columns 0088/0091/0093 add to `assessments` are added by those migrations;
-- this is the pre-0088 shape.
create table if not exists screening_v2.assessments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid,
  candidate_id uuid,
  overall_score numeric,
  recommendation text,
  summary text,
  raw jsonb,
  provenance jsonb,
  english jsonb, tone jsonb, communication jsonb, motivation jsonb, role_fit jsonb,
  resume_conflicts jsonb,
  source text not null default 'browser',
  partial boolean not null default false,
  created_at timestamptz not null default now()
);

-- One role, so 0089 seeds it a five-level default scorecard exactly as
-- production had before 0093.
insert into screening_v2.roles(title) values ('Night ops');
