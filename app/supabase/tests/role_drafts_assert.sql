-- 0101's partial unique index, asserted by EXECUTION.
--
-- `uq_role_drafts_owner_running` is the only admission control on a feature
-- that detaches up to six DeepSeek v4-pro calls per press, and the API layer
-- says so out loud: "a SELECT-then-INSERT cannot [enforce it], because a
-- concurrent request sees the same empty result." Every vitest suite mocks
-- Supabase, so before this file the `create unique index` line could be
-- deleted with the entire JS/TS suite green.
--
-- Each block raises on failure; `psql -v ON_ERROR_STOP=1` turns that into a
-- non-zero exit.
\set owner_a '11111111-1111-4111-8111-111111111111'
\set owner_b '22222222-2222-4222-8222-222222222222'

-- ── 1. the index exists, is UNIQUE, and is PARTIAL on `running` ───────────
do $$
declare
  n integer;
begin
  select count(*) into n
  from pg_indexes
  where schemaname = 'screening_v2'
    and indexname = 'uq_role_drafts_owner_running'
    and indexdef ilike 'create unique index%'
    and indexdef ilike '%(owner_id)%'
    and indexdef ilike '%where (status = ''running''::text)%';
  if n <> 1 then
    raise exception 'uq_role_drafts_owner_running is missing, not unique, or not partial on running (matched %)', n;
  end if;
end $$;

-- ── 2. ONE LIVE JOB PER OWNER — the whole point ───────────────────────────
insert into screening_v2.role_drafts (owner_id, job_role)
values (:'owner_a', 'Sales Advisor');

do $$
begin
  insert into screening_v2.role_drafts (owner_id, job_role)
  values ('11111111-1111-4111-8111-111111111111', 'Data Engineer');
  raise exception 'a SECOND running draft was accepted for the same owner — the cap does not exist';
exception
  when unique_violation then
    null; -- 23505 is the contract `startRoleDraft` branches on
end $$;

-- ── 3. a SETTLED row must not block the next start ────────────────────────
-- This is the lockout a previous review found: the index counts stale
-- `running` rows while the read filters them, so an owner who settles a draft
-- and starts another must not be refused.
update screening_v2.role_drafts
set status = 'cancelled', cancelled_at = now()
where owner_id = :'owner_a';

insert into screening_v2.role_drafts (owner_id, job_role)
values (:'owner_a', 'Data Engineer');

update screening_v2.role_drafts
set status = 'succeeded', draft = '{"jd":"x"}'::jsonb
where owner_id = :'owner_a' and status = 'running';

insert into screening_v2.role_drafts (owner_id, job_role)
values (:'owner_a', 'Solutions Architect');

update screening_v2.role_drafts
set status = 'failed', error_reason = 'unusable_output'
where owner_id = :'owner_a' and status = 'running';

insert into screening_v2.role_drafts (owner_id, job_role)
values (:'owner_a', 'Account Manager');

do $$
declare
  n integer;
begin
  select count(*) into n from screening_v2.role_drafts
  where owner_id = '11111111-1111-4111-8111-111111111111';
  if n <> 4 then
    raise exception 'cancelled/succeeded/failed rows blocked a new start (expected 4 rows, got %)', n;
  end if;
end $$;

-- ── 4. the cap is PER OWNER, not global ───────────────────────────────────
insert into screening_v2.role_drafts (owner_id, job_role)
values (:'owner_b', 'Sales Advisor');

-- ── 5. fail-closed exposure: RLS on, no policies, no grants to the web roles
do $$
declare
  rls boolean;
  policies integer;
  leaked text;
begin
  select relrowsecurity into rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'screening_v2' and c.relname = 'role_drafts';
  if not rls then
    raise exception 'row level security is not enabled on role_drafts';
  end if;

  select count(*) into policies
  from pg_policies where schemaname = 'screening_v2' and tablename = 'role_drafts';
  if policies <> 0 then
    raise exception 'role_drafts has % policy/policies; it is meant to be reachable only by service_role', policies;
  end if;

  select string_agg(distinct grantee, ', ') into leaked
  from information_schema.role_table_grants
  where table_schema = 'screening_v2' and table_name = 'role_drafts'
    and grantee in ('anon', 'authenticated', 'public');
  if leaked is not null then
    raise exception 'role_drafts is granted to %', leaked;
  end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'screening_v2' and table_name = 'role_drafts'
      and grantee = 'service_role' and privilege_type = 'INSERT'
  ) then
    raise exception 'service_role cannot write role_drafts — the API would 500 on every start';
  end if;
end $$;

select 'role_drafts index + exposure assertions passed' as result;
