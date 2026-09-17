-- Faithful-minimal screening_v2 fixture for the 0099 behavioural test.
--
-- Exactly the objects `verify_candidate_phone` reads or writes, and nothing
-- else. Same contract as `funnel_views_bootstrap.sql`: the shapes are copied
-- from production `information_schema` so the REAL migration can be applied on
-- top of them unmodified.
--
-- The transition trigger is included VERBATIM (0042/0045/0057 lineage) and is
-- the whole point of the exercise: the claim 0099 makes is that its update is a
-- no-op to this trigger, and the only way to test that claim is to make the
-- trigger present and let it fire.

create schema if not exists screening_v2;
set search_path = screening_v2, pg_catalog;

-- `sha256_hex` is the REAL one, not a stub. An earlier draft used `md5` and
-- justified it as "pgcrypto is not worth pulling in for a value this test
-- ignores" — which was wrong twice: the image already ships pgcrypto, and the
-- digest is NOT ignored, because production carries
-- `chk_phone_verification_digest check (phone_sha256 ~ '^[a-f0-9]{64}$')`.
-- md5 is 32 hex characters, so the stub made it impossible for this fixture to
-- carry that constraint, and a 0099 that wrote a malformed digest would have
-- passed here and failed in production.
create extension if not exists pgcrypto;
create or replace function screening_v2.sha256_hex(p_input text)
returns text language sql immutable as $$
  select encode(digest($1, 'sha256'), 'hex')
$$;

create table screening_v2.candidates (
  id          uuid primary key default gen_random_uuid(),
  phone_e164  text,
  phone_valid boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table screening_v2.phone_engagements (
  id                  uuid primary key default gen_random_uuid(),
  candidate_id        uuid not null references screening_v2.candidates(id),
  state               text not null default 'pending_prereqs',
  state_reason        text,
  version             integer not null default 1,
  terminal_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table screening_v2.phone_number_verifications (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id),
  phone_sha256 text not null,
  verified_by  uuid not null,
  verified_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  -- Production's constraint, verbatim (0057:86). Carried so a digest the
  -- function writes is checked here rather than at `supabase db push`.
  constraint chk_phone_verification_digest check (phone_sha256 ~ '^[a-f0-9]{64}$')
);

create table screening_v2.audit_events (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null,
  actor_type  text not null,
  action      text not null,
  target_type text not null,
  target_id   text not null,
  result      text not null,
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  -- Production's actor-type constraint verbatim (0007:290), plus the ONE
  -- action this function writes. Carried so a wrong actor_type or a renamed
  -- action fails here instead of in production. The full 90-value action list
  -- is not reproduced — only the value under test, which is the point.
  constraint chk_audit_actor_type check (
    actor_type in ('recruiter', 'system', 'candidate', 'api_key')
  ),
  constraint chk_audit_action_subset check (action = 'phone_number_reverified')
);

-- ── The transition trigger, verbatim from production ──────────────────
create or replace function screening_v2.enforce_phone_engagement_transition()
returns trigger language plpgsql set search_path to 'pg_catalog' as $$
declare
  allowed text[];
begin
  if old.terminal_at is not null and new is distinct from old then
    raise exception 'phone engagement % is terminal (%) and immutable', old.id, old.state
      using errcode = 'P0001';
  end if;

  if old.state = new.state then
    return new;   -- idempotent no-op (#14/#16 and every retry)
  end if;
  case old.state
    when 'pending_prereqs' then allowed := array['eligible','cancelled'];
    when 'eligible'        then allowed := array['dialing','scheduled','cancelled',
                                                 'completed','failed'];
    when 'scheduled'       then allowed := array['dialing','eligible','cancelled',
                                                 'completed','failed'];
    when 'dialing'         then allowed := array[
      'in_call','awaiting_retry','eligible','scheduled','reconnecting',
      'abandoned_no_answer','opted_out','wrong_number','failed','cancelled'];
    when 'in_call'         then allowed := array[
      'reconnecting','scheduled','completed','failed','opted_out','wrong_number',
      'cancelled','eligible'];
    when 'reconnecting'    then allowed := array['dialing','scheduled','eligible','failed',
                                                 'cancelled','completed'];
    when 'awaiting_retry'  then allowed := array['eligible','abandoned_no_answer',
                                                 'cancelled','scheduled'];
    else allowed := '{}'::text[];
  end case;
  if not (new.state = any(allowed)) then
    raise exception 'invalid phone engagement transition % -> %', old.state, new.state
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger trg_phone_engagement_transition
  before update on screening_v2.phone_engagements
  for each row execute function screening_v2.enforce_phone_engagement_transition();

-- `service_role` is granted EXECUTE by the migration; the role must exist for
-- the grant to parse.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;
