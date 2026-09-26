-- =====================================================================
-- 0105 fixture — one phone call sitting in the consent gate.
--
-- The session is `waiting` (the gate's state), `mode = 'live'`, and has NO
-- plan: `start_phone_assessment` has not run because consent has not been
-- given. That is exactly the shape of every 2026-09-25 call, and exactly the
-- shape in which the per-item gate writer must work AND must not turn into a
-- consent bypass.
--
-- Run:
--   psql -v ON_ERROR_STOP=1 -f gate_transcript_setup.sql
--   psql -v ON_ERROR_STOP=1 -f gate_transcript_assert.sql
--
-- Synthetic identifiers only; no real candidate, email or document.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_role  uuid;
  v_cand  uuid;
  v_sess  uuid;
  v_owner constant uuid := '00000000-0000-4000-8000-0000000000ad';
begin
  -- ── Idempotent teardown ────────────────────────────────────────────
  delete from screening_v2.transcript_turns
   where session_id in (select id from screening_v2.call_sessions
                         where external_call_id like 'gt105-%');
  delete from screening_v2.call_sessions where external_call_id like 'gt105-%';
  delete from screening_v2.candidates where email like 'gt105-%@example.test';
  delete from screening_v2.roles where title like 'gt105 %';

  insert into screening_v2.roles (title, jd, required_skills, screening_template, owner_id)
  values ('gt105 role', 'Sell to enterprise buyers on US hours.',
          '["Outbound calling"]'::jsonb,
          jsonb_build_array(
            jsonb_build_object('id','q1','question','Tell me about yourself?','weight',1)),
          v_owner)
  returning id into v_role;

  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'gt105 gate', 'gt105-gate@example.test', '+919986700105', true)
  returning id into v_cand;

  -- The session the dialer creates before the room is dispatched: `waiting`
  -- until consent moves it to `in_progress`. The deterministic room name is
  -- what `start_phone_assessment` would later verify.
  -- A session is BORN `created` (the transition trigger insists) and the
  -- dialer moves it to `waiting` once the room is dispatched — the state the
  -- whole gate runs in.
  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, external_call_id, status,
     current_question_index)
  values (v_cand, v_role, 'live', 'livekit', 'gt105-placeholder', 'created', 0)
  returning id into v_sess;
  update screening_v2.call_sessions
     set external_call_id = 'gt105-phone-' || v_sess::text,
         status           = 'waiting'
   where id = v_sess;
end $$;

select 'gt105 seeded' as fixture,
       count(*) filter (where s.status = 'waiting') as waiting_sessions
  from screening_v2.call_sessions s
 where s.external_call_id like 'gt105-%';
