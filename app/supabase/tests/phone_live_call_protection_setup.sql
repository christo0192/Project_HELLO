-- =====================================================================
-- 0096 fixture — a connected call the reaper must spare, and the orphan
-- session nothing else can see.
--
-- Seeds two independent families under the synthetic `lcp96-` namespace:
--
-- ── A. THE REAPER'S ANSWERED GRACE ───────────────────────────────────
-- Three attempts, all with an EXPIRED lease, differing only in whether
-- (and how long ago) they answered:
--   * `spared`   — answered, lease expired 30s ago. Inside the 120s grace,
--                  so `reclaim_phone_attempt_leases` MUST leave it alone.
--                  This is the live-conversation shape that was abandoned
--                  with a candidate on the line on 2026-09-10.
--   * `reaped`   — answered, lease expired 300s ago. Past the grace, so it
--                  MUST still be reclaimed: the grace is a delay, never an
--                  exemption, or a dead worker would hold its fleet slot
--                  for ever.
--   * `unanswered` — NEVER answered, lease expired 1s ago. MUST be
--                  reclaimed with no grace at all: a ringing leg that
--                  stopped heartbeating is holding up somebody else's call.
--
-- ── B. THE ORPHAN SESSION ────────────────────────────────────────────
-- Four `live`/`waiting` sessions for `sweep_phone_orphan_sessions`:
--   * `orphan`  — created 1800s ago, NO attempt, no engagement pointing at
--                 it. The shape `ensureSession` leaves behind when
--                 admission refuses, and the one that wedged a worker
--                 lease for four days. MUST be expired/idle_timeout.
--   * `young`   — identical but created 60s ago, inside the 900s grace.
--                 MUST be untouched: a session mid-admission is not an
--                 orphan, and taking it would race a dial in flight.
--   * `dialled` — old, but an attempt exists against it. MUST be
--                 untouched — it has a real call behind it and belongs to
--                 the engagement machinery.
--   * `engaged` — old, no attempt, but a NON-TERMINAL engagement points at
--                 it. MUST be untouched: that is a screening in flight.
--
-- Run:
--   psql -v ON_ERROR_STOP=1 -f phone_live_call_protection_setup.sql
--   psql -v ON_ERROR_STOP=1 -f phone_live_call_protection_assert.sql
--
-- Synthetic identifiers only; no real candidate, email or document.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_role  uuid;
  -- Every timestamp below is relative to this instant, and the assert
  -- script passes the SAME instant as `p_now`. Nothing here reads the
  -- host clock, so the fixture cannot drift between the two files.
  v_now   constant timestamptz := '2026-09-10T12:00:00Z'::timestamptz;
  v_cand  uuid;
  v_map   uuid;
  v_link  uuid;
  v_eng   uuid;
  v_sess  uuid;
  v_s     text;
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
begin
  select id into v_role from screening_v2.roles order by id limit 1;
  if v_role is null then
    raise exception 'lcp96: no seed role available';
  end if;

  -- Idempotent teardown first, so a re-run starts clean. Order matters:
  -- attempts before engagements, engagements before links.
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'lcp96-%'));
  delete from screening_v2.phone_engagements
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'lcp96-%');
  delete from screening_v2.call_sessions where external_call_id like 'phone-lcp96-%';
  delete from screening_v2.ashby_application_links where external_application_id like 'lcp96-%';
  delete from screening_v2.ashby_job_mappings where external_job_id like 'lcp96-%';
  delete from screening_v2.candidates where email like 'lcp96-%@example.test';

  -- ═══════════════════════════════════════════════════════════════════
  -- A. THE REAPER'S ANSWERED GRACE
  -- ═══════════════════════════════════════════════════════════════════
  for v_s in select unnest(array['spared','reaped','unanswered']) loop
    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'lcp96 ' || v_s, 'lcp96-' || v_s || '@example.test',
            '+9199977' || lpad((abs(hashtext('a' || v_s)) % 100000)::text, 5, '0'), true)
    returning id into v_cand;

    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, 'granted',
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1');

    insert into screening_v2.ashby_job_mappings
      (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
       status, delivery_mode)
    values ('lcp96-' || v_s || '-job', v_role, '00000000-0000-4000-8000-0000000000ad',
            'lcp96-' || v_s || '-ai', 'lcp96-' || v_s || '-ta', 'enabled', 'manual')
    returning id into v_map;

    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id,
       external_resume_file_handle, candidate_id)
    values ('lcp96-' || v_s || '-app', 'lcp96-' || v_s || '-job', v_map,
            repeat('h', 64), v_cand)
    returning id into v_link;

    perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
      from unnest(v_states);

    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, state)
    values (v_link, v_cand, v_role, 'in_call')
    returning id into v_eng;

    insert into screening_v2.call_sessions
      (candidate_id, role_id, mode, provider, external_call_id, status,
       current_question_index, started_at, updated_at)
    values (v_cand, v_role, 'live', 'livekit', 'phone-lcp96-' || v_s, 'created',
            0, v_now - interval '600 seconds', v_now - interval '600 seconds')
    returning id into v_sess;

    update screening_v2.call_sessions
       set status     = 'in_progress',
           updated_at = v_now - interval '600 seconds'
     where id = v_sess;

    update screening_v2.phone_engagements set session_id = v_sess where id = v_eng;

    -- `human` for the two answered legs: a CONSENTED, TALKING candidate.
    -- That state sitting in the reaper's IN-list with zero grace is the
    -- whole defect, so the fixture uses it rather than a softer one.
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, outcome_class,
       ist_date, prior_engagement_state, session_id, admitted_at, answered_at,
       ended_at, lease_expires_at, lease_token, lease_owner)
    values (v_eng, 1, 0, 'initial',
            case when v_s = 'unanswered' then 'ringing' else 'human' end,
            null, '2026-09-10', 'eligible', v_sess,
            v_now - interval '900 seconds',
            -- answered_at: NULL is what makes a leg ineligible for grace.
            case when v_s = 'unanswered' then null
                 else v_now - interval '800 seconds' end,
            null,
            case
              -- Inside the 120s grace: 30s past expiry.
              when v_s = 'spared'     then v_now - interval '30 seconds'
              -- Past the 120s grace: 300s past expiry.
              when v_s = 'reaped'     then v_now - interval '300 seconds'
              -- Never answered: 1s past expiry is already enough.
              else                         v_now - interval '1 second'
            end,
            gen_random_uuid(), 'lcp96-' || v_s)
    ;
  end loop;

  -- ═══════════════════════════════════════════════════════════════════
  -- B. THE ORPHAN SESSION
  -- ═══════════════════════════════════════════════════════════════════
  for v_s in select unnest(array['orphan','young','dialled','engaged']) loop
    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'lcp96 ' || v_s, 'lcp96-' || v_s || '@example.test',
            '+9199966' || lpad((abs(hashtext('b' || v_s)) % 100000)::text, 5, '0'), true)
    returning id into v_cand;

    -- The session, left in `waiting` — exactly where `ensureSession` puts it
    -- before admission runs, and exactly where a refused admission leaves it.
    insert into screening_v2.call_sessions
      (candidate_id, role_id, mode, provider, external_call_id, status,
       current_question_index, started_at, updated_at)
    values (v_cand, v_role, 'live', 'livekit', 'phone-lcp96-' || v_s, 'created',
            0,
            case when v_s = 'young' then v_now - interval '60 seconds'
                 else v_now - interval '1800 seconds' end,
            v_now - interval '1800 seconds')
    returning id into v_sess;

    update screening_v2.call_sessions
       set status     = 'waiting',
           started_at = case when v_s = 'young' then v_now - interval '60 seconds'
                             else v_now - interval '1800 seconds' end,
           updated_at = v_now - interval '1800 seconds'
     where id = v_sess;

    -- `dialled` and `engaged` need the full chain; `orphan` and `young`
    -- deliberately have NO engagement at all, which is the real shape —
    -- `phone_engagements.session_id` is written by `start_phone_assessment`,
    -- and for a dial that never happened it never runs.
    if v_s in ('dialled', 'engaged') then
      insert into screening_v2.consent_records (candidate_id, status, consents, version)
      values (v_cand, 'granted',
              '{ai_interview,recording,purpose,data_processing,retention,rights}'
                ::screening_v2.consent_type[], '2026-08-04.1');

      insert into screening_v2.ashby_job_mappings
        (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
         status, delivery_mode)
      values ('lcp96-' || v_s || '-job', v_role, '00000000-0000-4000-8000-0000000000ad',
              'lcp96-' || v_s || '-ai', 'lcp96-' || v_s || '-ta', 'enabled', 'manual')
      returning id into v_map;

      insert into screening_v2.ashby_application_links
        (external_application_id, external_job_id, job_mapping_id,
         external_resume_file_handle, candidate_id)
      values ('lcp96-' || v_s || '-app', 'lcp96-' || v_s || '-job', v_map,
              repeat('h', 64), v_cand)
      returning id into v_link;

      perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
        from unnest(v_states);

      insert into screening_v2.phone_engagements
        (application_link_id, candidate_id, role_id, state)
      values (v_link, v_cand, v_role, 'in_call')
      returning id into v_eng;

      if v_s = 'dialled' then
        -- An attempt EXISTS against this session. Terminal, so it is not a
        -- reaper candidate — the point is only that the orphan sweep must
        -- not look at a session a call was actually made on.
        insert into screening_v2.phone_call_attempts
          (engagement_id, attempt_seq, epoch, kind, state, outcome_class,
           ist_date, prior_engagement_state, session_id, admitted_at, ended_at)
        values (v_eng, 1, 0, 'initial', 'ended', 'disconnected',
                '2026-09-10', 'eligible', v_sess,
                v_now - interval '1700 seconds', v_now - interval '1600 seconds');
      else
        -- A LIVE engagement pointing straight at the session: a screening in
        -- flight, however old the row looks.
        update screening_v2.phone_engagements set session_id = v_sess where id = v_eng;
      end if;
    end if;
  end loop;

  raise notice 'lcp96: reaper-grace (spared/reaped/unanswered) + orphan-sweep '
               '(orphan/young/dialled/engaged) fixtures ready at %', v_now;
end;
$$;
