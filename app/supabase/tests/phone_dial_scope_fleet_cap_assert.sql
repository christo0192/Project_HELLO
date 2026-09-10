-- =====================================================================
-- 0094 assertions — the fleet daily cap and the suppression write path.
--
-- Every assertion RAISEs on violation, so ON_ERROR_STOP makes psql exit
-- non-zero and the harness fails.
--
-- WHY THE CAP VALUE IS OVERRIDDEN MID-SUITE: the shipped ceiling is 50.
-- Proving the BOUNDARY at 50 would need fifty eligible engagements — the
-- per-engagement `uq_phone_attempts_one_per_ist_day` index forbids
-- stacking same-day cold calls onto fewer. The value and the logic are
-- separable, so this suite proves the shipped VALUE directly (A1), then
-- lowers it to 2 to prove the LOGIC against a reachable boundary, then
-- restores it and re-proves the value (F1). The function replaced is the
-- real one `admit_phone_attempt` calls, so the code path under test is
-- production's.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_now  constant timestamptz := '2026-09-05T12:00:00+05:30'::timestamptz;
  v_ist  constant date        := screening_v2.phone_ist_date(v_now);
  v_eng_a uuid; v_eng_b uuid; v_eng_c uuid; v_eng_d uuid;
  v_cand_c uuid;
  v_res  jsonb;
  v_n    integer;
begin
  select e.id into v_eng_a from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'fleet94-a-app';
  select e.id into v_eng_b from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'fleet94-b-app';
  select e.id, e.candidate_id into v_eng_c, v_cand_c from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'fleet94-c-app';
  select e.id into v_eng_d from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'fleet94-d-app';
  if v_eng_a is null or v_eng_b is null or v_eng_c is null or v_eng_d is null then
    raise exception 'fleet94: fixture engagements missing — run the setup first';
  end if;

  -- ── A1. The SHIPPED ceiling ─────────────────────────────────────────
  if screening_v2.phone_max_daily_dials() <> 50 then
    raise exception 'fleet94 A1: shipped phone_max_daily_dials() is %, expected 50',
      screening_v2.phone_max_daily_dials();
  end if;

  -- ── A2. It is IMMUTABLE and argument-free, mirroring phone_max_concurrent
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'screening_v2' and p.proname = 'phone_max_daily_dials'
     and p.provolatile = 'i' and p.pronargs = 0;
  if v_n <> 1 then
    raise exception 'fleet94 A2: phone_max_daily_dials() is not a single IMMUTABLE zero-arg function';
  end if;

  -- Lower the ceiling to a reachable boundary for the logic assertions.
  create or replace function screening_v2.phone_max_daily_dials()
  returns integer language sql immutable set search_path to 'pg_catalog'
  as $fn$ select 2 $fn$;

  -- ── B1. The first two cold calls are admitted ───────────────────────
  v_res := screening_v2.admit_phone_attempt(v_eng_a, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'ok' then
    raise exception 'fleet94 B1: engagement A refused %, expected ok', v_res;
  end if;
  v_res := screening_v2.admit_phone_attempt(v_eng_b, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'ok' then
    raise exception 'fleet94 B1: engagement B refused %, expected ok', v_res;
  end if;

  -- ── B2. The third is refused by the CAP, and says so ────────────────
  -- The refusal must be the new status, not `at_capacity`: the two live
  -- attempts above also occupy concurrency slots, and reporting a volume
  -- refusal as a simultaneity one would send an operator looking for calls
  -- that will finish on their own.
  v_res := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'fleet_daily_cap_reached' then
    raise exception 'fleet94 B2: engagement C returned %, expected fleet_daily_cap_reached', v_res;
  end if;
  if (v_res->>'dials_today')::int <> 2 or (v_res->>'max_daily')::int <> 2
     or (v_res->>'ist_date')::date <> v_ist then
    raise exception 'fleet94 B2: refusal payload is not self-describing: %', v_res;
  end if;

  -- ── B3. NOTHING was written by the refusal ──────────────────────────
  -- A pre-insert refusal must leave no attempt, no queue job and no
  -- engagement transition, or the cap would consume the very budget it
  -- declined to spend.
  select count(*) into v_n from screening_v2.phone_call_attempts
   where engagement_id = v_eng_c;
  if v_n <> 0 then
    raise exception 'fleet94 B3: refused admission wrote % attempt row(s)', v_n;
  end if;
  select count(*) into v_n from screening_v2.phone_engagements
   where id = v_eng_c and state = 'eligible';
  if v_n <> 1 then
    raise exception 'fleet94 B3: refused admission moved engagement C out of eligible';
  end if;

  -- ── C1. `reconnect` is EXCLUDED from the cap ────────────────────────
  -- It redeems a budget charged at the grant; refusing it would strand the
  -- engagement in `reconnecting` with no edge out. The cap is already
  -- reached (2 of 2), so reaching ANY later gate proves the exclusion.
  v_res := screening_v2.admit_phone_attempt(v_eng_d, 'reconnect', 'fleet94', 60, v_now);
  if v_res->>'status' = 'fleet_daily_cap_reached' then
    raise exception 'fleet94 C1: a reconnect was refused by the fleet daily cap: %', v_res;
  end if;
  if v_res->>'status' <> 'ok' then
    raise exception 'fleet94 C1: reconnect returned % — expected ok past the cap', v_res;
  end if;

  -- ── D1. An infra-deferred attempt does NOT charge the fleet's day ───
  -- Demote A's attempt to the infra-deferred shape the 0083 narrowing
  -- excludes. The fleet count must fall to 1, freeing a slot for C.
  update screening_v2.phone_call_attempts
     set state = 'abandoned', abandon_reason = 'infra_deferred', ended_at = v_now
   where engagement_id = v_eng_a;
  update screening_v2.phone_engagements
     set state = 'eligible', state_reason = null, version = version + 1
   where id = v_eng_a;

  v_res := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'ok' then
    raise exception 'fleet94 D1: infra-deferred row still charged the fleet day: %', v_res;
  end if;

  -- ── E1. Suppression: add is idempotent and keyed on the DIGEST ──────
  v_res := screening_v2.suppress_candidate_phone(v_cand_c, 'candidate_opt_out', 'candidate', null, v_now);
  if v_res->>'status' <> 'ok' or (v_res->>'already_suppressed')::boolean <> false then
    raise exception 'fleet94 E1: first suppress returned %', v_res;
  end if;
  v_res := screening_v2.suppress_candidate_phone(v_cand_c, 'operator', 'operator', null, v_now);
  if v_res->>'status' <> 'ok' or (v_res->>'already_suppressed')::boolean <> true then
    raise exception 'fleet94 E1: repeat suppress returned %', v_res;
  end if;
  select count(*) into v_n from screening_v2.phone_suppressions where candidate_id = v_cand_c;
  if v_n <> 1 then
    raise exception 'fleet94 E1: repeat suppress produced % rows, expected 1', v_n;
  end if;
  -- The FIRST reason survives; a re-suppression must not silently rewrite
  -- why the promise was made or who made it.
  if (select reason from screening_v2.phone_suppressions where candidate_id = v_cand_c)
     <> 'candidate_opt_out' then
    raise exception 'fleet94 E1: repeat suppress overwrote the original reason';
  end if;

  -- ── E2. The read exposes state, never the digest ────────────────────
  v_res := screening_v2.phone_suppression_state(v_cand_c);
  if v_res->>'status' <> 'ok' or (v_res->>'suppressed')::boolean <> true
     or v_res->>'reason' <> 'candidate_opt_out' then
    raise exception 'fleet94 E2: suppression_state returned %', v_res;
  end if;
  if v_res ? 'phone_sha256' or v_res ? 'digest' or v_res ? 'phone_e164' then
    raise exception 'fleet94 E2: suppression_state leaked a number or digest: %', v_res;
  end if;

  -- ── E3. A suppressed candidate is refused BY ADMISSION ──────────────
  -- The whole point of the write path: it must reach the gate that has
  -- read `phone_suppressions` since 0042. Free C's day and slot first so
  -- `suppressed` is the only reason left to refuse.
  update screening_v2.phone_call_attempts
     set state = 'abandoned', abandon_reason = 'infra_deferred', ended_at = v_now
   where engagement_id = v_eng_c;
  update screening_v2.phone_engagements
     set state = 'eligible', state_reason = null, version = version + 1
   where id = v_eng_c;
  v_res := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'suppressed' then
    raise exception 'fleet94 E3: suppressed candidate returned %, expected suppressed', v_res;
  end if;

  -- ── E4. Release restores dialability and is not idempotent-silent ───
  v_res := screening_v2.release_candidate_phone_suppression(v_cand_c, null, v_now);
  if v_res->>'status' <> 'ok' or (v_res->>'released')::int <> 1 then
    raise exception 'fleet94 E4: release returned %', v_res;
  end if;
  v_res := screening_v2.release_candidate_phone_suppression(v_cand_c, null, v_now);
  if v_res->>'status' <> 'not_suppressed' then
    raise exception 'fleet94 E4: second release returned %, expected not_suppressed', v_res;
  end if;
  v_res := screening_v2.phone_suppression_state(v_cand_c);
  if (v_res->>'suppressed')::boolean <> false then
    raise exception 'fleet94 E4: state still suppressed after release: %', v_res;
  end if;

  -- ── E5. Closed vocabularies and unknown candidates are NAMED refusals
  v_res := screening_v2.suppress_candidate_phone(v_cand_c, 'because_i_said_so', 'operator', null, v_now);
  if v_res->>'status' <> 'invalid_reason' then
    raise exception 'fleet94 E5: bad reason returned %', v_res;
  end if;
  v_res := screening_v2.suppress_candidate_phone(v_cand_c, 'operator', 'telepathy', null, v_now);
  if v_res->>'status' <> 'invalid_source' then
    raise exception 'fleet94 E5: bad source returned %', v_res;
  end if;
  v_res := screening_v2.suppress_candidate_phone(
    '00000000-0000-4000-8000-00000000dead'::uuid, 'operator', 'operator', null, v_now);
  if v_res->>'status' <> 'candidate_not_found' then
    raise exception 'fleet94 E5: unknown candidate returned %', v_res;
  end if;
  v_res := screening_v2.release_candidate_phone_suppression(
    '00000000-0000-4000-8000-00000000dead'::uuid, null, v_now);
  if v_res->>'status' <> 'candidate_not_found' then
    raise exception 'fleet94 E5: unknown candidate release returned %', v_res;
  end if;
  -- A refused suppression must leave no row behind.
  select count(*) into v_n from screening_v2.phone_suppressions where candidate_id = v_cand_c;
  if v_n <> 0 then
    raise exception 'fleet94 E5: a refused suppress wrote % row(s)', v_n;
  end if;

  -- ── F1. Restore the shipped ceiling and re-prove it ─────────────────
  create or replace function screening_v2.phone_max_daily_dials()
  returns integer language sql immutable set search_path to 'pg_catalog'
  as $fn$ select 50 $fn$;
  if screening_v2.phone_max_daily_dials() <> 50 then
    raise exception 'fleet94 F1: ceiling not restored to the shipped 50';
  end if;

  raise notice 'fleet94: PASS — cap fires at the boundary, refuses without writing, excludes reconnect and infra-defer; suppression add/read/release round-trips and reaches admission.';
end;
$$;

-- ── Teardown ──────────────────────────────────────────────────────────
-- This suite is the only one on its IST date, but it shares the fleet-wide
-- counter with every later suite, so its attempts must not outlive it.
do $$
begin
  delete from screening_v2.job_queue
   where dedup_key in (
     select 'phone.dial:' || id::text from screening_v2.phone_call_attempts
      where engagement_id in (
        select id from screening_v2.phone_engagements
         where application_link_id in (
           select id from screening_v2.ashby_application_links
            where external_application_id like 'fleet94-%')));
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'fleet94-%'));
end;
$$;
