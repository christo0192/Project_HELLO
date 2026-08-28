-- 0065_phone_speakable_parity.sql
--
-- Phone/WebRTC parity, part 1 of the 2026-08-28 RCA: the first recorded
-- owner call spoke its own instructions to the candidate ("ask the candidate
-- to summarise their current work") because the DEFAULT question plan carried
-- interviewer TOPIC PROSE — 0044 copied the browser prompt's topic list
-- verbatim, and the phone lane's fixed-text delivery (`session.say`, PR #157)
-- speaks plan text exactly as written. The browser lane hands the same rows
-- to Gemini as topics and is untouched by this migration.
--
-- Three function replacements, no schema change, forward-only:
--
--   1. `phone_default_question_plan()` — the five fallback questions become
--      candidate-facing SPOKEN questions. Keys, order and mandatory flags are
--      unchanged, so cursors, probes, scorecards and drift tooling keyed on
--      `default_*` are unaffected. The Python drift test now asserts key/flag
--      alignment plus speakability, not text equality — the browser topic
--      list and the phone spoken list diverge ON PURPOSE from here on.
--
--   2. `validate_phone_plan_questions()` — the 0060 speakability gate now
--      covers `source='default'` too. 0060 exempted the default plan, which
--      was exactly the source carrying unspeakable prose to a live candidate.
--      The texts installed by (1) pass the gate; a future edit that regresses
--      them fails the insert loudly instead of reading instructions aloud.
--
--   3. `arm_phone_test_gate()` — an EXPIRED, unconsumed gate for the same
--      request_id is refreshed instead of being echoed back as
--      `already_armed` with a dead expiry. Tonight's operator flow armed a
--      gate, watched it expire unconsumed (admission was refusing on
--      `daily_attempt_exists`), and every subsequent re-arm through the route
--      returned "armed" while no active gate existed. A CONSUMED gate stays
--      one-shot: `already_armed` remains its answer, because a spent test is
--      history, not a permission.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Speakable default plan (keys/order/mandatory identical to 0044)
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.phone_default_question_plan()
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'key', 'default_intro',
      'text', 'To get us started, could you tell me a bit about yourself and what you''re working on these days?',
      'mandatory', false,
      'hint', null),
    jsonb_build_object(
      'key', 'default_experience_years',
      'text', 'How many years of relevant experience do you have overall?',
      'mandatory', true,
      'hint', null),
    jsonb_build_object(
      'key', 'default_relevant_experience',
      'text', 'Which part of your experience do you feel is most relevant to this role?',
      'mandatory', false,
      'hint', 'Adapt to what their resume mentions and what the role needs.'),
    jsonb_build_object(
      'key', 'default_reason_for_leaving',
      'text', 'What''s your reason for leaving your current or most recent organization?',
      'mandatory', true,
      'hint', null),
    jsonb_build_object(
      'key', 'default_expected_ctc_notice',
      'text', 'What are your expectations on CTC, and what''s your notice period?',
      'mandatory', true,
      'hint', null)
  )
$$;

revoke all on function screening_v2.phone_default_question_plan()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_default_question_plan()
  to service_role;

comment on function screening_v2.phone_default_question_plan is
  'The five-question fallback plan with the SAME keys, order and mandatory '
  'flags as 0044, but candidate-facing spoken question text. The browser '
  'prompt''s topic list (prompting.DEFAULT_QUESTIONS) intentionally differs: '
  'it is model guidance, this is speech. A Python drift test asserts the '
  'key/flag alignment and that every text passes cagv_question_is_speakable.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Speakability gate: fixed escaping, and it covers 'default' too
-- ═══════════════════════════════════════════════════════════════════════
-- 0060 wrote the regexes with DOUBLED backslashes inside standard-conforming
-- strings, so the pattern text reaching the regex engine was '\\?|\\m(...)'.
-- '\\?' is an OPTIONAL LITERAL BACKSLASH — it matches the empty string, so
-- the "must contain a question mark or an interrogative" requirement passed
-- EVERY text; and '\\m' is a literal backslash before 'm', so neither
-- ban-list could ever match. The gate was a tripwire that could not fire —
-- which is how "Ask the candidate to summarise their current work" reached a
-- live candidate's ear verbatim on 2026-08-28.
--
-- The corrected gate is STRICTER than what production enforced. A role
-- template whose rows are instruction prose (no question mark, no
-- interrogative word) now refuses at plan materialization with
-- `invalid_role_template` — loudly, before anything is asked — instead of
-- being spoken aloud. Operators must re-author such templates as spoken
-- questions (the role editor previews them); an empty template falls back to
-- the speakable default plan above.

create or replace function screening_v2.cagv_question_is_speakable(p_text text)
returns boolean language sql immutable
as $$
  select p_text is not null
    and length(btrim(p_text)) between 1 and 2000
    and btrim(p_text) ~* '\?|\m(tell|describe|walk|explain|what|how|why|when|where|which|could|can|have|did|would|are|do|is)\M'
    and btrim(p_text) !~* '\m(system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\M'
    and btrim(p_text) !~* '\m(must|should|do not|don''t)\s+(ask|say|tell|mention|reveal|ignore)\M'
    and btrim(p_text) !~ '[\[\]{}<>]'
$$;

create or replace function screening_v2.validate_phone_plan_questions()
returns trigger language plpgsql security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  item jsonb;
  text_value text;
  key_value text;
  seen_keys text[] := '{}';
  seen_texts text[] := '{}';
begin
  -- 0060 exempted 'default' — and the default plan was the common case that
  -- carried topic prose onto a live call. Both materializable sources are
  -- validated now; the error name is kept because every existing consumer of
  -- the refusal maps it, and a default-plan violation is a deploy defect of
  -- this repository, not recruiter input.
  if new.source not in ('role_template', 'default') then return new; end if;
  if jsonb_typeof(new.questions) <> 'array' then
    raise exception 'phone_role_template_invalid' using errcode = 'P0001';
  end if;
  for item in select value from jsonb_array_elements(new.questions) loop
    key_value := nullif(btrim(item ->> 'key'), '');
    text_value := nullif(btrim(item ->> 'text'), '');
    if key_value is null or key_value = any(seen_keys)
       or key_value !~ '^[A-Za-z0-9_.:-]{1,100}$'
       or text_value is null or text_value = any(seen_texts)
       or not screening_v2.cagv_question_is_speakable(text_value) then
      raise exception 'phone_role_template_invalid' using errcode = 'P0001';
    end if;
    seen_keys := array_append(seen_keys, key_value);
    seen_texts := array_append(seen_texts, text_value);
  end loop;
  return new;
end;
$$;

-- Trigger object is unchanged (same name, same timing); recreating it keeps
-- the binding explicit next to the function it executes.
drop trigger if exists trg_phone_plan_questions_valid on screening_v2.phone_session_plans;
create trigger trg_phone_plan_questions_valid
  before insert on screening_v2.phone_session_plans
  for each row execute function screening_v2.validate_phone_plan_questions();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Re-arming an expired, unconsumed gate refreshes it honestly
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.arm_phone_test_gate(
  p_candidate_id  uuid,
  p_engagement_id uuid,
  p_actor_id      uuid,
  p_request_id    text,
  p_expires_at    timestamptz,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_ctl            record;
  v_link_id        uuid;
  v_candidate_id   uuid;
  v_state          text;
  v_terminal_at    timestamptz;
  v_existing       screening_v2.phone_test_gates%rowtype;
  v_gate           screening_v2.phone_test_gates%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('phone_admission'));

  if p_actor_id is null then return jsonb_build_object('status', 'actor_required'); end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    return jsonb_build_object('status', 'invalid_request_id');
  end if;
  if p_expires_at is null or p_expires_at <= p_now + interval '60 seconds'
     or p_expires_at > p_now + interval '15 minutes' then
    return jsonb_build_object('status', 'invalid_expiry');
  end if;

  select halted_at, halt_reason into v_ctl
    from screening_v2.phone_control
   where control_key = 'default'
   for share;
  if not found then return jsonb_build_object('status', 'halt_unreadable'); end if;
  if v_ctl.halted_at is null then
    return jsonb_build_object('status', 'test_gate_requires_halt');
  end if;
  if v_ctl.halt_reason <> 'operator_pause' then
    return jsonb_build_object('status', 'test_gate_halt_not_permitted');
  end if;

  select application_link_id, candidate_id into v_link_id, v_candidate_id
    from screening_v2.phone_engagements
   where id = p_engagement_id;
  if not found then return jsonb_build_object('status', 'engagement_not_found'); end if;
  if v_candidate_id <> p_candidate_id then
    return jsonb_build_object('status', 'candidate_mismatch');
  end if;

  select * into v_existing
    from screening_v2.phone_test_gates
   where request_id = p_request_id
   for update;
  if found then
    if v_existing.candidate_id <> p_candidate_id
       or v_existing.engagement_id <> p_engagement_id then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    -- A CONSUMED gate is spent history: one request key authorizes one test.
    -- A STILL-ACTIVE gate is idempotent success. Only an EXPIRED, unconsumed
    -- gate falls through to the refresh below — before this migration that
    -- case answered `already_armed` with a dead expiry, which the route
    -- reported to the operator as "armed" while nothing could ever dial.
    if v_existing.consumed_at is not null
       or v_existing.expires_at > p_now then
      return jsonb_build_object('status', 'already_armed', 'gate_id', v_existing.id,
        'candidate_id', v_existing.candidate_id, 'engagement_id', v_existing.engagement_id,
        'expires_at', v_existing.expires_at);
    end if;
  end if;

  -- Lock order matches admission: advisory -> application link -> engagement.
  perform 1 from screening_v2.ashby_application_links
   where id = v_link_id
   for update;
  if not found then return jsonb_build_object('status', 'application_not_found'); end if;
  select state, terminal_at into v_state, v_terminal_at
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;
  if not found then return jsonb_build_object('status', 'engagement_not_found'); end if;
  if v_terminal_at is not null or v_state <> 'eligible' then
    return jsonb_build_object('status', 'test_gate_not_eligible', 'state', coalesce(v_state, 'unknown'));
  end if;

  -- Expired gates are retired under the same admission serialiser before the
  -- global unique index is tested. They cannot silently block the next window.
  update screening_v2.phone_test_gates
     set consumed_at = p_now
   where consumed_at is null and expires_at <= p_now
     and (v_existing.id is null or id <> v_existing.id);

  select * into v_gate
    from screening_v2.phone_test_gates
   where consumed_at is null and expires_at > p_now
   for update;
  if found then
    return jsonb_build_object('status', 'test_gate_already_armed');
  end if;

  if v_existing.id is not null then
    -- Refresh the expired, unconsumed gate in place: the request key keeps
    -- its one-row identity, the expiry becomes real again, and the audit
    -- trail records the re-arm as its own action.
    update screening_v2.phone_test_gates
       set expires_at = p_expires_at, actor_id = p_actor_id
     where id = v_existing.id
     returning * into v_gate;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (p_actor_id, 'recruiter', 'phone_test_gate_rearmed', 'phone_engagement',
       v_gate.engagement_id::text, 'success',
       jsonb_build_object('candidate_id', v_gate.candidate_id,
         'gate_id', v_gate.id, 'request_id', v_gate.request_id,
         'expires_at', v_gate.expires_at));

    return jsonb_build_object('status', 'ok', 'gate_id', v_gate.id,
      'candidate_id', v_gate.candidate_id, 'engagement_id', v_gate.engagement_id,
      'expires_at', v_gate.expires_at);
  end if;

  insert into screening_v2.phone_test_gates
    (candidate_id, engagement_id, actor_id, request_id, created_at, expires_at)
  values
    (p_candidate_id, p_engagement_id, p_actor_id, p_request_id, p_now, p_expires_at)
  returning * into v_gate;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'phone_test_gate_armed', 'phone_engagement',
     v_gate.engagement_id::text, 'success',
     jsonb_build_object('candidate_id', v_gate.candidate_id,
       'gate_id', v_gate.id, 'request_id', v_gate.request_id,
       'expires_at', v_gate.expires_at));

  return jsonb_build_object('status', 'ok', 'gate_id', v_gate.id,
    'candidate_id', v_gate.candidate_id, 'engagement_id', v_gate.engagement_id,
    'expires_at', v_gate.expires_at);
end;
$$;

revoke all on function screening_v2.arm_phone_test_gate(uuid, uuid, uuid, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.arm_phone_test_gate(uuid, uuid, uuid, text, timestamptz, timestamptz)
  to service_role;
