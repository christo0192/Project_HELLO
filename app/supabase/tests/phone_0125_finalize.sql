-- =====================================================================
-- 0125 §4 (T05) — the partial-finalize reconnect guard and the truthful
-- disconnect label, on real Postgres.
--
-- scripts/test-phone-0125.sh runs this AFTER phone_0125_assert.sql, so every
-- migration (0125 applied twice) is in place. Each case builds its own
-- engagement chain under the synthetic `p115f` namespace and calls
-- finalize_phone_partial_sessions at a frozen instant. The sweep is
-- fleet-wide, so every assertion looks its session up by id and the cases
-- run in time order (a later case's legs lie in an earlier call's future).
--
--   replay   The 9f60523d SEQUENCE (timings only, synthetic ids):
--            leg A dropped, leg B (the reconnect) answered and was ended
--            only by the lease reclaim, leg C (the next reconnect) is
--            `ringing` with the engagement `dialing`.
--              1. NOT selected, although leg B ended past the grace.
--              2. leg C `call.failed` through apply_phone_event; the
--                 engagement state it leaves is PINNED (`eligible`).
--              3. selected, disconnect_reason = 'unobserved_disconnect'
--                 (leg B carries a verified recording upload).
--   newer    Guard (b), pinned through apply_phone_event: a newer
--            reconnect leg answered but NOT consent.resumed keeps the
--            engagement `dialing` and is unbound -> not selected; with the
--            engagement forced to `in_call` the newer live leg alone still
--            holds it; once that leg ends the session is selected.
--   label    A lease-lapsed live leg with an observed SIP leave, and a
--            reclaimed leg with a completed egress -> 'unobserved_disconnect'
--            (no guard: the engagement is `in_call`).
--   stuck    Guard (a) on the EXPIRED arm, and the time bound: engagement
--            wedged in `reconnecting`, the session crash-terminalized. At
--            +29 min not selected; at +31 min selected, and with no teardown
--            evidence the label stays 'worker_crash'.
--   detached The guard keys on the engagement BOUND to the session: a C2-a
--            deferral detached it, and the engagement's callback dial must
--            not hold the old session (selected, score suppressed).
--   edges    Guard (a) `dialing` alone (no attempt row yet) holds; an
--            ENDED newer leg (machine/voicemail) does not hold.
--
-- T06 continues the replay (relabel to failed/screening_abandoned).
-- Synthetic identifiers only; no real candidate, email, number or document.
-- =====================================================================
\set ON_ERROR_STOP on

create schema if not exists _p115;

-- One engagement chain: candidate -> job mapping -> application link
-- (ingestion `ready`) -> engagement in p_state -> live phone session
-- (in_progress, claiming the engagement as 0107 does) -> question plan.
-- Returns [engagement, session, candidate].
create or replace function _p115.fin_chain(
  p_slug      text,
  p_n         integer,
  p_state     text,
  p_epoch     integer,
  p_reconnects integer,
  p_started   timestamptz
)
returns uuid[]
language plpgsql as $fc$
declare
  v_owner  constant uuid := '00000000-0000-4000-8000-0000000000ad';
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_role uuid; v_cand uuid; v_map uuid; v_link uuid; v_eng uuid; v_sess uuid;
begin
  select id into v_role from screening_v2.roles where title = 'p115f role';
  if v_role is null then
    insert into screening_v2.roles (title, jd, required_skills, screening_template, owner_id)
    values ('p115f role', 'Synthetic role for the 0125 finalize harness.', '[]'::jsonb,
            jsonb_build_array(jsonb_build_object('id','q1','question','Tell me about yourself?','weight',1)),
            v_owner)
    returning id into v_role;
  end if;

  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'p115f ' || p_slug, 'p115f-' || p_slug || '@example.test',
          '+9199901152' || lpad(p_n::text, 2, '0'), true)
  returning id into v_cand;

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('p115f-' || p_slug || '-job', v_role, v_owner,
          'p115f-' || p_slug || '-ai', 'p115f-' || p_slug || '-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle, candidate_id)
  values ('p115f-' || p_slug || '-app', 'p115f-' || p_slug || '-job', v_map, repeat('h', 64), v_cand)
  returning id into v_link;

  perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
    from unnest(v_states);

  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, state, epoch, reconnects_used)
  values (v_link, v_cand, v_role, p_state, p_epoch, p_reconnects)
  returning id into v_eng;

  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, external_call_id, status, current_question_index,
     started_at, updated_at)
  values (v_cand, v_role, 'live', 'livekit', 'p115f-placeholder-' || p_slug, 'created', 0,
          p_started, p_started)
  returning id into v_sess;
  update screening_v2.call_sessions
     set external_call_id    = 'phone-' || v_sess::text,
         status              = 'in_progress',
         phone_engagement_id = v_eng,
         updated_at          = p_started
   where id = v_sess;
  update screening_v2.phone_engagements set session_id = v_sess where id = v_eng;

  insert into screening_v2.phone_session_plans
    (session_id, engagement_id, role_id, source, questions, question_count)
  select v_sess, v_eng, v_role, 'default', q, jsonb_array_length(q)
    from (select screening_v2.phone_default_question_plan() as q) s;

  return array[v_eng, v_sess, v_cand];
end;
$fc$;

-- The finalize result entry for one session, or NULL when not selected.
create or replace function _p115.fin_entry(p_fin jsonb, p_session uuid)
returns jsonb
language sql as $fe$
  select e from jsonb_array_elements(coalesce(p_fin->'sessions', '[]'::jsonb)) e
   where (e->>'session_id')::uuid = p_session
$fe$;

create table if not exists _p115.fin_ids (
  slug text primary key,
  ids  uuid[] not null
);

-- ─────────────────────────────────────────────────────────────────────
-- replay — the 9f60523d sequence.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_eng uuid; v_sess uuid;
  v_leg_a uuid; v_leg_b uuid; v_leg_c uuid;
  v_fin jsonb; v_e jsonb; v_ev jsonb;
  v_status text; v_state text; v_cstate text; v_cout text;
begin
  -- After leg B's reclaim the engagement was restored to `reconnecting`, and
  -- the next reconnect's admission put it in `dialing` (epoch 2).
  v_ids := _p115.fin_chain('replay', 1, 'dialing', 2, 2, '2026-10-05T03:30:50Z');
  v_eng := v_ids[1]; v_sess := v_ids[2];

  -- Leg A: the first leg, dropped and reported (the reconciler's end).
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible', v_sess,
          '2026-10-05T03:30:20Z', '2026-10-05T03:30:46.8Z', '2026-10-05T03:32:02.4Z')
  returning id into v_leg_a;

  -- Leg B: the reconnect, bound by 0114 C1-d, ended ONLY by the lease
  -- reclaim (the 0112 signature). Its recording was uploaded and verified
  -- (0107 recording_ready) — the worker saw the leg end.
  v_leg_b := gen_random_uuid();
  insert into screening_v2.phone_call_attempts
    (id, engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at,
     recording_object_key, recording_manifest_key, recording_role, recording_sha256,
     recording_size_bytes, recording_content_type, recording_ready)
  values (v_leg_b, v_eng, 2, 1, 'reconnect', 'abandoned', null, '2026-10-05', 'reconnecting', v_sess,
          '2026-10-05T03:34:30Z', '2026-10-05T03:34:49.6Z', '2026-10-05T03:40:57.456Z',
          'phone-' || v_leg_b::text || '-egress.mp3', 'phone-' || v_leg_b::text || '-egress.mp3.json',
          'supplementary', repeat('a', 64), 140800, 'audio/mpeg', true);

  -- Leg C: the next reconnect, admitted and RINGING, not bound (binding
  -- happens only at consent.resumed or the drop race).
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, lease_expires_at)
  values (v_eng, 3, 2, 'reconnect', 'ringing', null, '2026-10-05', 'reconnecting', null,
          '2026-10-05T03:41:30Z', '2026-10-05T03:45:30Z')
  returning id into v_leg_c;

  insert into _p115.fin_ids values ('replay', array[v_eng, v_sess, v_leg_a, v_leg_b, v_leg_c]);

  -- 1. 03:44:00 — leg B ended 3m02s ago, past the 180 s grace, so without
  --    the guard the session WOULD be selected. The pending reconnect holds it.
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T03:44:00Z');
  v_e := _p115.fin_entry(v_fin, v_sess);
  select status into v_status from screening_v2.call_sessions where id = v_sess;
  if v_e is not null or v_status <> 'in_progress' then
    raise exception 'p115f replay 1: a session with a pending reconnect (engagement dialing, '
      'leg C ringing) must not be finalized; entry=% session=%', v_e, v_status;
  end if;

  -- 2. Leg C fails at the provider. The engagement state this leaves is read
  --    from apply_phone_event, not assumed.
  v_ev := screening_v2.apply_phone_event('internal', 'call.failed', v_leg_c, null, null, null, null,
            '2026-10-05T03:44:30Z');
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  select state, outcome_class into v_cstate, v_cout from screening_v2.phone_call_attempts where id = v_leg_c;
  if v_ev->>'status' <> 'applied' or v_state <> 'eligible' or v_cstate <> 'ended'
     or v_cout <> 'provider_error' then
    raise exception 'p115f replay 2: call.failed on the ringing reconnect: event=% engagement=% leg=%/%',
      v_ev, v_state, v_cstate, v_cout;
  end if;

  -- 3. 03:45:00 — no reconnect pending: selected, the session completes, and
  --    the reclaimed leg with a verified upload is an UNOBSERVED disconnect.
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T03:45:00Z');
  v_e := _p115.fin_entry(v_fin, v_sess);
  select status into v_status from screening_v2.call_sessions where id = v_sess;
  if v_e is null
     or v_e->>'disconnect_reason' <> 'unobserved_disconnect'
     or (v_e->>'attempt_id')::uuid <> v_leg_b
     or (v_e->>'engagement_id')::uuid <> v_eng
     or (v_e->>'transitioned')::boolean is not true
     or v_status <> 'completed' then
    raise exception 'p115f replay 3: expected selected/unobserved_disconnect on leg B, completed; '
      'entry=% session=%', v_e, v_status;
  end if;

  raise notice 'p115f replay: PASS (held while dialing; call.failed -> eligible; finalized as unobserved_disconnect)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- newer — guard (b): a newer live, unbound leg.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_eng uuid; v_sess uuid; v_leg_a uuid; v_leg_c uuid;
  v_fin jsonb; v_e jsonb; v_ev jsonb;
  v_state text; v_cstate text; v_cbound uuid; v_status text;
begin
  v_ids := _p115.fin_chain('newer', 2, 'dialing', 1, 1, '2026-10-05T07:00:10Z');
  v_eng := v_ids[1]; v_sess := v_ids[2];

  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible', v_sess,
          '2026-10-05T07:00:00Z', '2026-10-05T07:00:30Z', '2026-10-05T07:02:00Z')
  returning id into v_leg_a;
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, lease_expires_at)
  values (v_eng, 2, 1, 'reconnect', 'admitted', null, '2026-10-05', 'reconnecting', null,
          '2026-10-05T07:02:30Z', '2026-10-05T07:10:30Z')
  returning id into v_leg_c;
  insert into _p115.fin_ids values ('newer', array[v_eng, v_sess, v_leg_a, v_leg_c]);

  -- The reconnect leg is ANSWERED (no consent.resumed): pin what that leaves.
  v_ev := screening_v2.apply_phone_event('internal', 'call.answered', v_leg_c, null, null, null, null,
            '2026-10-05T07:02:50Z');
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  select state, session_id into v_cstate, v_cbound from screening_v2.phone_call_attempts where id = v_leg_c;
  if v_ev->>'status' <> 'applied' or v_state <> 'dialing'
     or v_cstate <> 'answered_unclassified' or v_cbound is not null then
    raise exception 'p115f newer: call.answered on the reconnect leg: event=% engagement=% leg=% bound=%',
      v_ev, v_state, v_cstate, v_cbound;
  end if;

  -- 07:06:00 — leg A ended 4 min ago (past the grace): held.
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T07:06:00Z');
  if _p115.fin_entry(v_fin, v_sess) is not null then
    raise exception 'p115f newer: an answered, unresumed reconnect leg must hold the session; entry=%',
      _p115.fin_entry(v_fin, v_sess);
  end if;

  -- Guard (b) ALONE: the engagement no longer in a guarded state, the newer
  -- leg still live and unbound -> still held.
  update screening_v2.phone_engagements set state = 'in_call' where id = v_eng;
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T07:06:10Z');
  if _p115.fin_entry(v_fin, v_sess) is not null then
    raise exception 'p115f newer (b): a newer live unbound leg alone must hold the session; entry=%',
      _p115.fin_entry(v_fin, v_sess);
  end if;

  -- The newer leg ends (a pre-disclosure drop, never bound): released.
  update screening_v2.phone_call_attempts
     set state = 'ended', outcome_class = 'abandoned_pre_disclosure', ended_at = '2026-10-05T07:06:20Z'
   where id = v_leg_c;
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T07:06:30Z');
  v_e := _p115.fin_entry(v_fin, v_sess);
  select status into v_status from screening_v2.call_sessions where id = v_sess;
  if v_e is null or (v_e->>'attempt_id')::uuid <> v_leg_a
     or v_e->>'disconnect_reason' <> 'candidate_hangup' or v_status <> 'completed' then
    raise exception 'p115f newer: once the newer leg ended the session must finalize on leg A; entry=% session=%',
      v_e, v_status;
  end if;

  raise notice 'p115f newer: PASS (answered reconnect keeps dialing; guard (b) holds alone; released on end)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- label — teardown evidence other than a verified upload.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_obs uuid[]; v_egr uuid[]; v_crash uuid[]; v_fin jsonb; v_o jsonb; v_g jsonb; v_c jsonb;
begin
  -- A live leg whose lease lapsed, with the worker's observed SIP leave.
  v_obs := _p115.fin_chain('label-observed', 3, 'in_call', 0, 0, '2026-10-05T08:00:10Z');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, lease_expires_at, observed_ended_at)
  values (v_obs[1], 1, 0, 'initial', 'human', null, '2026-10-05', 'eligible', v_obs[2],
          '2026-10-05T08:00:00Z', '2026-10-05T08:00:30Z', '2026-10-05T08:02:00Z', '2026-10-05T08:01:30Z');
  -- A reclaimed leg whose egress completed.
  v_egr := _p115.fin_chain('label-egress', 4, 'in_call', 0, 0, '2026-10-05T08:00:10Z');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at, egress_id, egress_status)
  values (v_egr[1], 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible', v_egr[2],
          '2026-10-05T08:00:00Z', '2026-10-05T08:00:30Z', '2026-10-05T08:02:00Z',
          'EG_p115flabel', 'complete');
  -- A genuinely crashed leg with NO evidence of its own: the SESSION's egress
  -- completed, and 0062's projection copied it onto the attempt. That is not
  -- this leg's teardown evidence: it must stay worker_crash.
  v_crash := _p115.fin_chain('label-crash', 9, 'in_call', 0, 0, '2026-10-05T08:00:10Z');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_crash[1], 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible', v_crash[2],
          '2026-10-05T08:00:00Z', '2026-10-05T08:00:30Z', '2026-10-05T08:02:00Z');
  update screening_v2.call_sessions
     set recording_egress_id = 'EG_p115fsession', recording_egress_status = 'complete'
   where id = v_crash[2];
  if (select egress_status from screening_v2.phone_call_attempts where session_id = v_crash[2])
     is distinct from 'complete' then
    raise exception 'p115f label: the 0062 projection did not copy the session egress (fixture premise)';
  end if;

  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T08:06:00Z');
  v_o := _p115.fin_entry(v_fin, v_obs[2]);
  v_g := _p115.fin_entry(v_fin, v_egr[2]);
  v_c := _p115.fin_entry(v_fin, v_crash[2]);
  if v_o is null or v_o->>'disconnect_reason' <> 'unobserved_disconnect'
     or (v_o->>'transitioned')::boolean is not true then
    raise exception 'p115f label: lease-lapsed leg with observed_ended_at: entry=%', v_o;
  end if;
  if v_g is null or v_g->>'disconnect_reason' <> 'unobserved_disconnect' then
    raise exception 'p115f label: reclaimed leg with egress complete: entry=%', v_g;
  end if;
  if v_c is null or v_c->>'disconnect_reason' <> 'worker_crash' then
    raise exception 'p115f label: a leg whose only egress evidence is the session''s must stay worker_crash: entry=%', v_c;
  end if;

  raise notice 'p115f label: PASS (observed leave and the leg''s own egress -> unobserved_disconnect; session egress alone -> worker_crash)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- stuck — guard (a) on the EXPIRED arm, and the 30-minute bound.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_sess uuid; v_fin jsonb; v_e jsonb; v_status text;
begin
  v_ids := _p115.fin_chain('stuck', 5, 'reconnecting', 1, 1, '2026-10-05T09:00:10Z');
  v_sess := v_ids[2];
  -- Reclaimed, with NO teardown evidence (no upload, no egress, no leave).
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_ids[1], 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible', v_sess,
          '2026-10-05T09:00:00Z', '2026-10-05T09:00:30Z', '2026-10-05T09:05:00Z');
  -- The crash residue: the session already expired/grace_timeout.
  update screening_v2.call_sessions
     set status = 'expired', terminal_reason = 'grace_timeout', ended_at = '2026-10-05T09:05:00Z'
   where id = v_sess;

  -- +29 min: the engagement is still `reconnecting` -> held, on the expired arm too.
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T09:34:00Z');
  if _p115.fin_entry(v_fin, v_sess) is not null then
    raise exception 'p115f stuck: within 30 min of the leg end a reconnecting engagement must hold '
      'the expired-arm session; entry=%', _p115.fin_entry(v_fin, v_sess);
  end if;

  -- +31 min: the bound has passed -> selected exactly as before 0125.
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T09:36:00Z');
  v_e := _p115.fin_entry(v_fin, v_sess);
  select status into v_status from screening_v2.call_sessions where id = v_sess;
  if v_e is null or v_e->>'disconnect_reason' <> 'worker_crash'
     or (v_e->>'transitioned')::boolean is not false or v_status <> 'expired' then
    raise exception 'p115f stuck: past the bound the wedged session must be selected (worker_crash, '
      'not re-transitioned); entry=% session=%', v_e, v_status;
  end if;

  raise notice 'p115f stuck: PASS (held at +29 min, released at +31 min, worker_crash without evidence)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- detached — the guard keys on the engagement BOUND to the session.
-- A C2-a callback deferral detaches the session; the engagement then dials
-- the callback. That dial must not hold the old, detached session.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_eng uuid; v_sess uuid; v_leg uuid; v_fin jsonb; v_e jsonb;
begin
  v_ids := _p115.fin_chain('detached', 6, 'dialing', 1, 0, '2026-10-05T10:00:10Z');
  v_eng := v_ids[1]; v_sess := v_ids[2];
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'ended', 'callback_deferred', '2026-10-05', 'eligible', v_sess,
          '2026-10-05T10:00:00Z', '2026-10-05T10:00:30Z', '2026-10-05T10:02:00Z')
  returning id into v_leg;
  -- Detached exactly as 0114 v_detach_session leaves it.
  update screening_v2.phone_engagements set session_id = null where id = v_eng;
  update screening_v2.call_sessions set phone_engagement_id = null where id = v_sess;
  -- The callback dial: a newer live leg on the same engagement, `dialing`.
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, lease_expires_at)
  values (v_eng, 2, 1, 'scheduled', 'ringing', null, '2026-10-06', 'scheduled', null,
          '2026-10-05T10:04:00Z', '2026-10-05T10:10:00Z');

  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T10:06:00Z');
  v_e := _p115.fin_entry(v_fin, v_sess);
  if v_e is null or (v_e->>'attempt_id')::uuid <> v_leg
     or (v_e->>'score_suppressed')::boolean is not true
     or v_e->>'suppress_reason' <> 'callback_deferred' then
    raise exception 'p115f detached: a detached session is never held by its old engagement''s dial; entry=%',
      v_e;
  end if;

  raise notice 'p115f detached: PASS (finalized for its MP3, score suppressed, not held)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- edges — each guard arm on its own, so neither hides behind the other.
--   dialing  Guard (a) `dialing` ALONE: the engagement is placing the next
--            reconnect but no attempt row exists yet -> held; once the
--            engagement leaves `dialing` -> selected.
--   ended    Guard (b) needs a LIVE newer leg: a newer reconnect that is
--            `machine` but already ENDED (voicemail) holds nothing.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_dial uuid[]; v_end uuid[]; v_fin jsonb; v_e jsonb;
begin
  v_dial := _p115.fin_chain('edge-dialing', 7, 'dialing', 1, 1, '2026-10-05T11:00:10Z');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_dial[1], 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible', v_dial[2],
          '2026-10-05T11:00:00Z', '2026-10-05T11:00:30Z', '2026-10-05T11:02:00Z');

  v_end := _p115.fin_chain('edge-ended', 8, 'eligible', 1, 1, '2026-10-05T11:00:10Z');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_end[1], 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible', v_end[2],
          '2026-10-05T11:00:00Z', '2026-10-05T11:00:30Z', '2026-10-05T11:02:00Z');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_end[1], 2, 1, 'reconnect', 'machine', 'voicemail', '2026-10-05', 'reconnecting', null,
          '2026-10-05T11:02:30Z', '2026-10-05T11:02:50Z', '2026-10-05T11:03:10Z');

  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T11:06:00Z');
  if _p115.fin_entry(v_fin, v_dial[2]) is not null then
    raise exception 'p115f edges dialing: an engagement dialing the next reconnect must hold the session '
      'even before the attempt row exists; entry=%', _p115.fin_entry(v_fin, v_dial[2]);
  end if;
  v_e := _p115.fin_entry(v_fin, v_end[2]);
  if v_e is null or v_e->>'disconnect_reason' <> 'candidate_hangup'
     or (v_e->>'transitioned')::boolean is not true then
    raise exception 'p115f edges ended: an ENDED newer leg (machine/voicemail) must not hold the session; entry=%',
      v_e;
  end if;

  update screening_v2.phone_engagements set state = 'eligible' where id = v_dial[1];
  v_fin := screening_v2.finalize_phone_partial_sessions(200, 180, '2026-10-05T11:06:10Z');
  v_e := _p115.fin_entry(v_fin, v_dial[2]);
  if v_e is null or v_e->>'disconnect_reason' <> 'candidate_hangup' then
    raise exception 'p115f edges dialing: once the engagement left dialing the session must finalize; entry=%', v_e;
  end if;

  raise notice 'p115f edges: PASS (dialing alone holds; an ended newer leg does not)';
end $$;

select 'p115 finalize guard and label' as suite, 'PASS' as result;
