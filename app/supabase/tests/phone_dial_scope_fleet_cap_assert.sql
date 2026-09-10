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
  v_eng_e uuid; v_eng_f uuid;
  v_cand_c uuid; v_cand_e uuid;
  v_res  jsonb;
  v_n    integer;
  v_shipped_cap integer;
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
  select e.id, e.candidate_id into v_eng_e, v_cand_e from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'fleet94-e-app';
  select e.id into v_eng_f from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'fleet94-f-app';
  if v_eng_a is null or v_eng_b is null or v_eng_c is null or v_eng_d is null
     or v_eng_e is null or v_eng_f is null then
    raise exception 'fleet94: fixture engagements missing — run the setup first';
  end if;

  -- PRECONDITION for the shared-line assertions: c and e really do resolve to
  -- one suppression row. If the fixture ever stops sharing the number, the
  -- ownership tests below would pass vacuously.
  if (select screening_v2.sha256_hex(phone_e164) from screening_v2.candidates where id = v_cand_c)
     is distinct from
     (select screening_v2.sha256_hex(phone_e164) from screening_v2.candidates where id = v_cand_e)
  then
    raise exception 'fleet94: fixtures c and e must share a line for the ownership tests';
  end if;

  -- ── A1. The SHIPPED ceiling ─────────────────────────────────────────
  v_shipped_cap := screening_v2.phone_max_daily_dials();
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
  -- The refusal must be the new status, not `at_capacity`. Both can be true
  -- at once and the caller is told only the first, so ORDER IS THE ASSERTION:
  -- `at_capacity` clears by itself as live calls end, while the fleet cap
  -- clears at IST midnight and not before. Reporting the self-clearing one
  -- would send an operator to wait for calls that will not help.
  --
  -- An earlier draft evaluated the cap AFTER the concurrency check, and this
  -- assertion passed anyway because the fixture left eight free slots — it
  -- never reached the case the comment was about. B2b below removes that
  -- escape by squeezing the concurrency cap to the number of live attempts,
  -- so BOTH refusals are live simultaneously.
  v_res := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'fleet_daily_cap_reached' then
    raise exception 'fleet94 B2: engagement C returned %, expected fleet_daily_cap_reached', v_res;
  end if;
  if (v_res->>'dials_today')::int <> 2 or (v_res->>'max_daily')::int <> 2
     or (v_res->>'ist_date')::date <> v_ist then
    raise exception 'fleet94 B2: refusal payload is not self-describing: %', v_res;
  end if;

  -- ── B2b. With BOTH caps reached, the cap that clears LAST is reported.
  create or replace function screening_v2.phone_max_concurrent()
  returns integer language sql immutable set search_path to 'pg_catalog'
  as $fn$ select 2 $fn$;
  v_res := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'fleet_daily_cap_reached' then
    raise exception 'fleet94 B2b: with both caps reached the answer was %, expected fleet_daily_cap_reached', v_res;
  end if;
  create or replace function screening_v2.phone_max_concurrent()
  returns integer language sql immutable set search_path to 'pg_catalog'
  as $fn$ select 10 $fn$;

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

  -- ── C2. `scheduled` is COUNTED but NEVER refused ────────────────────
  -- The distinction Guard B spends a paragraph on, and the one an earlier
  -- draft of the cap block got wrong. A booked slot is not a cold call: the
  -- candidate or HR agreed a time. Refusing it would leave the appointment
  -- sitting `scheduled` until the expiry sweep marked it `missed`, with the
  -- only signal a counter on a health page — the exact failure shape this
  -- migration exists to end. The cap is already reached (2 of 2), so reaching
  -- ANY later gate proves the exclusion.
  update screening_v2.phone_engagements
     set state = 'scheduled', state_reason = null, version = version + 1
   where id = v_eng_f;
  v_res := screening_v2.admit_phone_attempt(v_eng_f, 'scheduled', 'fleet94', 60, v_now);
  if v_res->>'status' = 'fleet_daily_cap_reached' then
    raise exception 'fleet94 C2: a BOOKED appointment was refused by the fleet cap: %', v_res;
  end if;
  if v_res->>'status' <> 'ok' then
    raise exception 'fleet94 C2: scheduled dial returned % — expected ok past the cap', v_res;
  end if;

  -- ── C3. …and that scheduled dial DOES charge the fleet's day ────────
  -- Counted, because it is a real billable call and the ceiling is about
  -- spend and blast radius. Proven by the count in the next refusal, which
  -- must now include it.
  update screening_v2.phone_engagements
     set state = 'eligible', state_reason = null, version = version + 1
   where id = v_eng_e;
  v_res := screening_v2.admit_phone_attempt(v_eng_e, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'fleet_daily_cap_reached' then
    raise exception 'fleet94 C3: expected the cap, got %', v_res;
  end if;
  if (v_res->>'dials_today')::int < 3 then
    raise exception 'fleet94 C3: the scheduled dial was not counted (dials_today=%)',
      v_res->>'dials_today';
  end if;

  -- ── C4. `no_answer_retry` IS refused — it is a cold call ────────────
  v_res := screening_v2.admit_phone_attempt(v_eng_e, 'no_answer_retry', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'fleet_daily_cap_reached' then
    raise exception 'fleet94 C4: no_answer_retry returned %, expected the cap', v_res;
  end if;

  -- Park f's attempt so it stops holding a concurrency slot and a day.
  update screening_v2.phone_call_attempts
     set state = 'abandoned', abandon_reason = 'infra_deferred', ended_at = v_now
   where engagement_id = v_eng_f;

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

  -- ── E1b. A suppression STOPS a dial already queued ──────────────────
  -- Recording the promise is not keeping it. Admission checks suppression at
  -- claim time and `dial.ts` deliberately does not re-check downstream, so an
  -- attempt admitted a moment earlier still has a claimable `phone.dial` job.
  -- An operator told "ok" while the phone rings has been failed as completely
  -- as one told nothing.
  select count(*) into v_n from screening_v2.job_queue
   where name = 'phone.dial' and status in ('pending','delayed')
     and dedup_key in (select 'phone.dial:' || id::text
                         from screening_v2.phone_call_attempts
                        where engagement_id = v_eng_b);
  if v_n <> 1 then
    raise exception 'fleet94 E1b: expected B to hold one live dial job, found %', v_n;
  end if;
  v_res := screening_v2.suppress_candidate_phone(
    (select candidate_id from screening_v2.phone_engagements where id = v_eng_b),
    'wrong_number', 'operator', null, v_now);
  if v_res->>'status' <> 'ok' or (v_res->>'dials_stopped')::int <> 1 then
    raise exception 'fleet94 E1b: suppress did not stop the queued dial: %', v_res;
  end if;
  select count(*) into v_n from screening_v2.job_queue
   where name = 'phone.dial' and status in ('pending','delayed')
     and dedup_key in (select 'phone.dial:' || id::text
                         from screening_v2.phone_call_attempts
                        where engagement_id = v_eng_b);
  if v_n <> 0 then
    raise exception 'fleet94 E1b: % dial job(s) survived the suppression', v_n;
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
  -- The whole point of the write path: it must reach the gate that has read
  -- `phone_suppressions` since 0042.
  --
  -- The day and the slot are freed first not because they would otherwise
  -- win — the suppression check sits ~150 lines EARLIER in the function than
  -- the daily pre-check, the candidate guards and both caps, so it answers
  -- first regardless — but so that the engagement is left in a state the
  -- later assertions can reuse. An earlier version of this comment claimed
  -- the ordering ran the other way, which would have taught a reader
  -- something false about the function.
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

  -- ── E3b. A RELEASE CANNOT REACH ACROSS A SHARED LINE ────────────────
  -- The defect this predicate exists for. `phone_suppressions` is keyed on
  -- the DIGEST, so c and e resolve to one row — correct for the add, and
  -- catastrophic for a delete without an ownership check. An earlier draft
  -- deleted on the digest alone, so an admin lifting e's suppression
  -- destroyed c's row. Those rows are very often candidate-authored:
  -- `apply_phone_event` has written `reason='candidate_opt_out',
  -- source='candidate'` there since 0042 whenever somebody says "don't call
  -- me" during a call.
  --
  -- c is suppressed (E1, reason `candidate_opt_out`). e shares the line and
  -- owns nothing.
  v_res := screening_v2.phone_suppression_state(v_cand_e);
  if (v_res->>'suppressed')::boolean <> true then
    raise exception 'fleet94 E3b: e should read as suppressed through the shared line: %', v_res;
  end if;
  if (v_res->>'owned')::boolean <> false then
    raise exception 'fleet94 E3b: e must NOT be reported as owning c''s promise: %', v_res;
  end if;

  v_res := screening_v2.release_candidate_phone_suppression(v_cand_e, null, v_now);
  if v_res->>'status' <> 'suppressed_by_other_candidate' then
    raise exception 'fleet94 E3b: releasing e returned % — it must refuse by name, not delete c''s row', v_res;
  end if;
  select count(*) into v_n from screening_v2.phone_suppressions where candidate_id = v_cand_c;
  if v_n <> 1 then
    raise exception 'fleet94 E3b: c''s opt-out was destroyed by a release scoped to e';
  end if;
  if (select reason from screening_v2.phone_suppressions where candidate_id = v_cand_c)
     <> 'candidate_opt_out' then
    raise exception 'fleet94 E3b: c''s reason was rewritten';
  end if;

  -- ── E3c. Suppression survives a NUMBER CORRECTION ───────────────────
  -- `verify_candidate_phone` rewrites `candidates.phone_e164` with no
  -- suppression check, so a digest-only gate lets a corrected typo undo an
  -- opt-out. Under `allowlist` the corrected number also had to be hand-
  -- pasted into PHONE_DIAL_ALLOWLIST, and a human was in that loop;
  -- `pipeline` removes the human, so admission checks the CANDIDATE too.
  update screening_v2.candidates
     set phone_e164 = '+919888100001'
   where id = v_cand_c;
  v_res := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' <> 'suppressed' then
    raise exception 'fleet94 E3c: a number change undid the opt-out (got %)', v_res;
  end if;

  -- ── E4. Release restores dialability and is not idempotent-silent ───
  v_res := screening_v2.release_candidate_phone_suppression(v_cand_c, null, v_now);
  if v_res->>'status' <> 'ok' or (v_res->>'released')::int <> 1 then
    raise exception 'fleet94 E4: release returned %', v_res;
  end if;
  -- It must say WHAT it lifted. A hard DELETE reporting a bare count left no
  -- way to tell a candidate's own opt-out from an operator's note.
  if v_res->>'released_reason' <> 'candidate_opt_out'
     or v_res->>'released_source' <> 'candidate' then
    raise exception 'fleet94 E4: release did not report what it destroyed: %', v_res;
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
  -- A refused suppression must leave no row behind — checked for BOTH the
  -- real candidate and the unknown id the last two refusals used. An earlier
  -- draft filtered on the real candidate only, so a `candidate_not_found`
  -- path that wrote a row would have written it under the other id and gone
  -- unseen.
  select count(*) into v_n from screening_v2.phone_suppressions
   where candidate_id = v_cand_c
      or candidate_id = '00000000-0000-4000-8000-00000000dead'::uuid;
  if v_n <> 0 then
    raise exception 'fleet94 E5: a refused suppress wrote % row(s)', v_n;
  end if;

  -- ── F1. Restore the shipped ceiling and re-prove it THROUGH ADMISSION
  -- Restored by re-reading the migration's own definition rather than by
  -- retyping the literal: hardcoding 50 in a second place means a future
  -- migration that raises the ceiling would have this suite silently restore
  -- the wrong one.
  execute format(
    'create or replace function screening_v2.phone_max_daily_dials() '
    'returns integer language sql immutable set search_path to ''pg_catalog'' as $fn$ %s $fn$',
    'select ' || v_shipped_cap::text);
  if screening_v2.phone_max_daily_dials() <> v_shipped_cap then
    raise exception 'fleet94 F1: ceiling not restored to the shipped %', v_shipped_cap;
  end if;
  -- And prove ADMISSION sees it: with the real ceiling back, an engagement
  -- refused a moment ago by the lowered cap is admitted again. Asserting the
  -- getter alone would not show the restore reached the code path.
  update screening_v2.phone_engagements
     set state = 'eligible', state_reason = null, version = version + 1
   where id = v_eng_e;
  v_res := screening_v2.admit_phone_attempt(v_eng_e, 'initial', 'fleet94', 60, v_now);
  if v_res->>'status' = 'fleet_daily_cap_reached' then
    raise exception 'fleet94 F1: the restored ceiling did not reach admission: %', v_res;
  end if;

  raise notice 'fleet94: PASS — cap fires at the boundary and outranks at_capacity, refuses without writing, excludes reconnect, counts-but-never-refuses scheduled, refuses no_answer_retry, ignores infra-defer; suppression stops a queued dial, survives a number correction, cannot be released across a shared line, and reports what it lifted.';
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
