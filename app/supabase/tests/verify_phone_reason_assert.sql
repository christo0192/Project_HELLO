-- Behavioural assertions for 0099 `verify_candidate_phone`, run against the
-- REAL migration on a real Postgres. Every `raise exception` here is a red CI.
--
-- The five claims 0099's header makes, each tested by executing it:
--   1. a stale `phone_invalid` is cleared on a non-terminal engagement;
--   2. any OTHER reason survives untouched;
--   3. `state`, `version` and `updated_at` are NOT touched — the load-bearing
--      one, because the due read orders by `updated_at asc` and the reconnect
--      batch derives its due time from it;
--   4. a candidate holding a TERMINAL engagement does not make the whole call
--      fail (the trigger raises P0001 on any update to a terminal row);
--   5. it is idempotent — the second call clears 0.

set search_path = screening_v2, pg_catalog;

\set ACTOR '''00000000-0000-4000-8000-000000000001'''
\set FROZEN '''2026-09-17T12:00:00Z'''

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into screening_v2.candidates (id, phone_e164, phone_valid) values
  ('11111111-1111-4111-8111-111111111111', null, false),  -- the Tina shape
  ('22222222-2222-4222-8222-222222222222', null, false),  -- other reason
  ('33333333-3333-4333-8333-333333333333', null, false),  -- terminal engagement
  ('44444444-4444-4444-8444-444444444444', null, false);  -- already clean

-- `updated_at` and `version` are set to distinctive values so claim 3 is
-- checked against an exact expected value, not against "it did not change
-- much".
insert into screening_v2.phone_engagements
  (id, candidate_id, state, state_reason, version, terminal_at, updated_at)
values
  ('aaaaaaaa-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111',
   'eligible', 'phone_invalid', 7, null, '2020-01-01T00:00:00Z'),
  ('aaaaaaaa-2222-4222-8222-222222222222',
   '22222222-2222-4222-8222-222222222222',
   'eligible', 'mapping_not_enabled', 7, null, '2020-01-01T00:00:00Z'),
  ('aaaaaaaa-3333-4333-8333-333333333333',
   '33333333-3333-4333-8333-333333333333',
   'opted_out', 'phone_invalid', 7, '2026-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  ('aaaaaaaa-4444-4444-8444-444444444444',
   '44444444-4444-4444-8444-444444444444',
   'eligible', null, 7, null, '2020-01-01T00:00:00Z');

-- ── 1 + 3: the stale reason goes, and nothing else moves ──────────────
do $$
declare
  v_result jsonb;
  v_row    screening_v2.phone_engagements%rowtype;
begin
  v_result := screening_v2.verify_candidate_phone(
    '11111111-1111-4111-8111-111111111111', '+919731247881',
    '00000000-0000-4000-8000-000000000001', '2026-09-17T12:00:00Z');

  if v_result->>'status' <> 'ok' then
    raise exception '0099/1: expected ok, got %', v_result;
  end if;
  if (v_result->>'stale_phone_invalid_cleared')::int <> 1 then
    raise exception '0099/1: expected 1 cleared, got %', v_result;
  end if;

  select * into v_row from screening_v2.phone_engagements
   where id = 'aaaaaaaa-1111-4111-8111-111111111111';

  if v_row.state_reason is not null then
    raise exception '0099/1: state_reason survived as %', v_row.state_reason;
  end if;
  -- CLAIM 3. These three are what the dial queue's ordering depends on.
  if v_row.state <> 'eligible' then
    raise exception '0099/3: state moved to %', v_row.state;
  end if;
  if v_row.version <> 7 then
    raise exception '0099/3: version bumped to %', v_row.version;
  end if;
  if v_row.updated_at <> '2020-01-01T00:00:00Z'::timestamptz then
    raise exception
      '0099/3: updated_at moved to % — this silently re-orders the due read '
      '(updated_at asc) and the reconnect backoff', v_row.updated_at;
  end if;

  -- The number itself was still written, i.e. 0099 did not break 0057.
  if not exists (select 1 from screening_v2.candidates
                  where id = '11111111-1111-4111-8111-111111111111'
                    and phone_valid and phone_e164 = '+919731247881') then
    raise exception '0099/1: the candidate number was not updated';
  end if;
  if not exists (select 1 from screening_v2.phone_number_verifications
                  where candidate_id = '11111111-1111-4111-8111-111111111111') then
    raise exception '0099/1: no verification row was written';
  end if;
  if not exists (select 1 from screening_v2.audit_events
                  where target_id = '11111111-1111-4111-8111-111111111111'
                    and action = 'phone_number_reverified'
                    and (metadata->>'stale_phone_invalid_cleared')::int = 1) then
    raise exception '0099/1: the audit row lost its count';
  end if;
end $$;

-- ── 5: idempotent. A second call clears nothing. ──────────────────────
do $$
declare v_result jsonb;
begin
  v_result := screening_v2.verify_candidate_phone(
    '11111111-1111-4111-8111-111111111111', '+919731247881',
    '00000000-0000-4000-8000-000000000001', '2026-09-17T12:00:00Z');
  if (v_result->>'stale_phone_invalid_cleared')::int <> 0 then
    raise exception '0099/5: second call cleared %',
      v_result->>'stale_phone_invalid_cleared';
  end if;
end $$;

-- ── 2: a reason this function did not fix must survive ────────────────
do $$
declare
  v_result jsonb;
  v_reason text;
begin
  v_result := screening_v2.verify_candidate_phone(
    '22222222-2222-4222-8222-222222222222', '+919731247882',
    '00000000-0000-4000-8000-000000000001', '2026-09-17T12:00:00Z');
  if (v_result->>'stale_phone_invalid_cleared')::int <> 0 then
    raise exception '0099/2: cleared a reason it does not own';
  end if;
  select state_reason into v_reason from screening_v2.phone_engagements
   where id = 'aaaaaaaa-2222-4222-8222-222222222222';
  if v_reason is distinct from 'mapping_not_enabled' then
    raise exception '0099/2: mapping_not_enabled became %', v_reason;
  end if;
end $$;

-- ── 4: a terminal engagement must not break the number correction ─────
-- Without `terminal_at is null` in the predicate, the trigger raises P0001
-- here and an ordinary HR typo fix starts failing outright.
do $$
declare
  v_result jsonb;
  v_reason text;
begin
  v_result := screening_v2.verify_candidate_phone(
    '33333333-3333-4333-8333-333333333333', '+919731247883',
    '00000000-0000-4000-8000-000000000001', '2026-09-17T12:00:00Z');
  if v_result->>'status' <> 'ok' then
    raise exception
      '0099/4: a candidate with a TERMINAL engagement could not be verified: %',
      v_result;
  end if;
  if (v_result->>'stale_phone_invalid_cleared')::int <> 0 then
    raise exception '0099/4: wrote to a terminal engagement';
  end if;
  select state_reason into v_reason from screening_v2.phone_engagements
   where id = 'aaaaaaaa-3333-4333-8333-333333333333';
  if v_reason is distinct from 'phone_invalid' then
    raise exception '0099/4: the terminal row was modified (reason now %)', v_reason;
  end if;
end $$;

-- ── The existing 0057 refusals still refuse ───────────────────────────
do $$
declare v_result jsonb;
begin
  v_result := screening_v2.verify_candidate_phone(
    '44444444-4444-4444-8444-444444444444', '+911234567890',
    '00000000-0000-4000-8000-000000000001', '2026-09-17T12:00:00Z');
  if v_result->>'status' <> 'invalid_phone' then
    raise exception '0099/0057: a non-mobile number was accepted: %', v_result;
  end if;

  v_result := screening_v2.verify_candidate_phone(
    '44444444-4444-4444-8444-444444444444', '+919731247884', null,
    '2026-09-17T12:00:00Z');
  if v_result->>'status' <> 'actor_required' then
    raise exception '0099/0057: an actorless verification was accepted: %', v_result;
  end if;

  v_result := screening_v2.verify_candidate_phone(
    '55555555-5555-4555-8555-555555555555', '+919731247885',
    '00000000-0000-4000-8000-000000000001', '2026-09-17T12:00:00Z');
  if v_result->>'status' <> 'candidate_not_found' then
    raise exception '0099/0057: an unknown candidate was accepted: %', v_result;
  end if;
end $$;

\echo '[verify-phone-reason] all 0099 assertions passed'
