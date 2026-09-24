-- Faithful-minimal objects that 0101 needs, so the REAL migration can be
-- applied to a throwaway Postgres and the index it creates can be tested by
-- executing it rather than by reading it.
--
-- 0101 is nearly self-contained: it needs the `screening_v2` schema, the three
-- Supabase roles its GRANT/REVOKE lines name, and `gen_random_uuid()`. It
-- references no other table, so nothing else is stubbed here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create schema if not exists screening_v2;
create extension if not exists pgcrypto;
