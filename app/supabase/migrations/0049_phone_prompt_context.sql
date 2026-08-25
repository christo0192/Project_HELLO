-- 0049 — server-verified role and bounded resume context for phone prompts.
-- Context is an allowlisted projection: no email, phone, provider id, room,
-- raw resume text, transcript, or durable identifier crosses to the worker.

create or replace function screening_v2.get_phone_assessment_state(
  p_session_id uuid
)
returns jsonb
language plpgsql
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'turn_index', t.turn_index, 'speaker', t.speaker, 'text', t.text)
           order by t.turn_index), '[]'::jsonb)
    into v_turns
    from screening_v2.transcript_turns t
   where t.session_id = p_session_id;

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
    'assessment_exists', v_scored,
    'already_scored', v_sess.status = 'completed' and v_scored,
    'plan_complete', v_cursor >= v_plan.question_count
  );
end;
$$;

comment on function screening_v2.get_phone_assessment_state(uuid) is
  'Returns the phone plan plus a server-verified, allowlisted role/resume evidence projection. Never returns contact PII, raw resume text, transcript outside the existing bounded turns, provider identifiers or room names.';
