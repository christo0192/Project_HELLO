-- 0070 — gate-free resume context, and a durable-consent signal for the worker.
--
-- FORWARD-ONLY and ADDITIVE. It REPLACES exactly one function body in full
-- (`get_phone_assessment_state`, latest was 0049) and changes NOTHING else. It
-- drops no table, column, index or constraint, retypes nothing, rewrites no
-- row, and adds no new RPC. Every earlier migration stays byte-identical.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────
-- Two live phone-parity defects (both observed 2026-08-29) share one root:
-- the resume projection this function returns does not distinguish the
-- pre-consent GATE turns from the scored ASSESSMENT turns.
--
--   1. CROSS-LEG CONTEXT LEAK. 0067 added `transcript_turns.is_gate` precisely
--      to separate the greeting/consent exchange (`is_gate = true`, written by
--      `commit_phone_gate_turns`) from the scored assessment boundary turns
--      (`is_gate = false`). But the `turns` aggregation here never filtered on
--      it, so a prior leg's gate chatter — the consent Q&A, a candidate side
--      question — leaked into the resuming leg's LLM context. Live proof: the
--      bot answered a question that belonged to a PREVIOUS call's gate.
--      Fix: the aggregation now excludes gate turns
--      (`coalesce(is_gate, false) = false`, so a NULL reads as not-a-gate),
--      which is the SAME boundary the scored transcript already means.
--
--   2. CONSENT REPLAY ON RE-DISPATCH. On a worker deploy/crash mid-call the
--      leg re-enters the gate and asks for consent a SECOND time, mid-
--      interview (live proof: `disclosure.delivered` applied twice on one
--      session; the candidate heard a double consent ask). The worker needs a
--      narrow, server-owned signal that durable consent already exists for
--      this session so it can SKIP the disclosure. That signal is exactly
--      "gate turns have been recorded", which this function now exposes as
--      `gate_recorded` — a boolean derived in SQL, named once, rather than
--      re-derived by every caller. It reads the UNFILTERED `is_gate = true`
--      rows on purpose: those rows are the durable record that the gate ran.
--
-- ── TIME IS NOT INJECTED (deliberately) ───────────────────────────────
-- `get_phone_assessment_state` is a pure read and decides nothing that
-- depends on time, so — as in 0044/0049 — it keeps its `(p_session_id uuid)`
-- signature, takes no `p_now`, and calls no `now()`. It stays NOT STABLE for
-- the same reason 0044 documents: `start_phone_assessment` calls it inside the
-- transaction that just inserted the plan row.
--
-- ── PROJECTION IS UNCHANGED OTHERWISE ─────────────────────────────────
-- Every other field is byte-identical to 0049: no phone number, SIP or
-- provider identifier, room name, attempt id, egress key or raw resume text
-- is returned, and the API layer's `sanitizeAssessmentState` still decides
-- what actually crosses to the worker.

create or replace function screening_v2.get_phone_assessment_state(
  p_session_id uuid
)
returns jsonb
language plpgsql
-- Deliberately NOT declared STABLE. `start_phone_assessment` calls this
-- immediately after inserting the plan row, and a STABLE function runs
-- against the CALLING query's snapshot — which would not yet include the
-- insert this very transaction just made, so a first leg would be told
-- its own plan was missing.
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess      screening_v2.call_sessions%rowtype;
  v_plan      screening_v2.phone_session_plans%rowtype;
  v_name      text;
  v_role      screening_v2.roles%rowtype;
  v_parsed    jsonb;
  v_completed jsonb;
  v_turns     jsonb;
  v_cursor    integer;
  v_next      text;
  v_scored    boolean;
  v_gate      boolean;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_sess from screening_v2.call_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'plan_missing', 'session_status', v_sess.status);
  end if;

  select c.name, c.parsed
    into v_name, v_parsed
    from screening_v2.candidates c
   where c.id = v_sess.candidate_id;

  select r.*
    into v_role
    from screening_v2.roles r
   where r.id = v_sess.role_id;

  select coalesce(jsonb_agg(p.question_key order by p.question_index), '[]'::jsonb)
    into v_completed
    from screening_v2.phone_session_progress p
   where p.session_id = p_session_id;

  -- 0070: the resume context is the SCORED transcript only. Gate turns
  -- (`is_gate = true`) are the pre-consent greeting/consent exchange 0067
  -- captured separately; feeding them to the resuming leg's model is the
  -- cross-leg leak this migration closes. `coalesce(is_gate, false) = false`
  -- keeps legacy rows (written before 0067's column existed) in the resume
  -- context, exactly as they have always been.
  select coalesce(jsonb_agg(jsonb_build_object(
           'turn_index', t.turn_index, 'speaker', t.speaker, 'text', t.text)
           order by t.turn_index), '[]'::jsonb)
    into v_turns
    from screening_v2.transcript_turns t
   where t.session_id = p_session_id
     and coalesce(t.is_gate, false) = false;

  -- 0070: the durable-consent signal. TRUE once the gate has recorded its
  -- turns for this session, which is `commit_phone_gate_turns`' single side
  -- effect and therefore the proof that disclosure+consent already ran. A
  -- re-dispatched leg reads this to SKIP the disclosure instead of asking for
  -- consent a second time. It counts the gate rows UNFILTERED on purpose —
  -- those are the very rows excluded from the resume context above.
  select exists (
    select 1 from screening_v2.transcript_turns g
     where g.session_id = p_session_id and g.is_gate = true)
    into v_gate;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  if v_cursor < v_plan.question_count then
    v_next := v_plan.questions -> v_cursor ->> 'key';
  else
    v_next := null;
  end if;

  select exists (
    select 1 from screening_v2.assessments a
     where a.session_id = p_session_id and a.source = 'phone')
    into v_scored;

  return jsonb_build_object(
    'status', 'ok',
    'session_id', v_sess.id,
    'session_status', v_sess.status,
    'terminal_reason', v_sess.terminal_reason,
    'candidate_name', v_name,
    'role_title', v_role.title,
    'role_focus', left(v_role.jd, 900),
    'role_required_skills', coalesce(v_role.required_skills, '[]'::jsonb),
    'interviewer_instructions', left(coalesce(v_role.interviewer_instructions, ''), 10000),
    'candidate_evidence', jsonb_build_object(
      'name', v_parsed -> 'name',
      'current_role', v_parsed -> 'current_role',
      'experience_years', v_parsed -> 'experience_years',
      'skills', v_parsed -> 'skills',
      'summary', left(coalesce(v_parsed ->> 'summary', ''), 500),
      'recent_role', v_parsed -> 'recent_role',
      'prior_roles', v_parsed -> 'prior_roles',
      'career_highlights', v_parsed -> 'career_highlights',
      'education', v_parsed -> 'education',
      'certifications', v_parsed -> 'certifications'
    ),
    'plan_source', v_plan.source,
    'question_count', v_plan.question_count,
    'questions', v_plan.questions,
    'cursor', v_cursor,
    'next_key', v_next,
    'completed_keys', v_completed,
    'turns', v_turns,
    'gate_recorded', v_gate,
    'assessment_exists', v_scored,
    'already_scored', v_sess.status = 'completed' and v_scored,
    'plan_complete', v_cursor >= v_plan.question_count
  );
end;
$$;

revoke all on function screening_v2.get_phone_assessment_state(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.get_phone_assessment_state(uuid)
  to service_role;

comment on function screening_v2.get_phone_assessment_state(uuid) is
  'Returns the phone plan plus a server-verified, allowlisted role/resume evidence projection. The resume `turns` exclude pre-consent gate turns (is_gate); `gate_recorded` reports whether the gate has been recorded so a re-dispatched leg can skip the disclosure. Never returns contact PII, raw resume text, transcript outside the existing bounded (non-gate) turns, provider identifiers or room names.';
