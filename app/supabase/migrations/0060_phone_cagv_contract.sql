-- 0060 — CAGV candidate-facing question and max-one probe contract.
-- Additive and service-role-only. Historical session plans are immutable.

create table if not exists screening_v2.phone_session_probes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_v2.call_sessions(id) on delete cascade,
  question_key text not null,
  question_index integer not null,
  source_event_id text not null,
  created_at timestamptz not null default now(),
  constraint uq_phone_session_probes_question unique (session_id, question_key),
  constraint uq_phone_session_probes_event unique (session_id, source_event_id),
  constraint chk_phone_session_probes_key check (question_key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  constraint chk_phone_session_probes_event check (source_event_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  constraint chk_phone_session_probes_index check (question_index >= 0)
);

create index if not exists idx_phone_session_probes_session
  on screening_v2.phone_session_probes(session_id, question_index);

alter table screening_v2.phone_session_probes enable row level security;

create or replace function screening_v2.prevent_phone_probe_update()
returns trigger language plpgsql security invoker set search_path = pg_catalog
as $$
begin
  raise exception 'phone_session_probes is write-once: UPDATE not permitted' using errcode = 'P0001';
end;
$$;
drop trigger if exists trg_phone_session_probes_prevent_update on screening_v2.phone_session_probes;
create trigger trg_phone_session_probes_prevent_update
  before update on screening_v2.phone_session_probes
  for each row execute function screening_v2.prevent_phone_probe_update();

-- The trigger protects both newly written role templates and legacy malformed
-- rows when the immutable plan is first materialized. It intentionally rejects
-- meta/instruction text instead of silently substituting a different question.
create or replace function screening_v2.cagv_question_is_speakable(p_text text)
returns boolean language sql immutable
as $$
  select p_text is not null
    and length(btrim(p_text)) between 1 and 2000
    and btrim(p_text) ~* '\\?|\\m(tell|describe|walk|explain|what|how|why|when|where|which|could|can|have|did|would|are|do|is)\\M'
    and btrim(p_text) !~* '\\m(system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\\M'
    and btrim(p_text) !~* '\\m(must|should|do not|don''t)\\s+(ask|say|tell|mention|reveal|ignore)\\M'
    and btrim(p_text) !~ '[\\[\\]{}<>]'
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
  if new.source <> 'role_template' then return new; end if;
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
drop trigger if exists trg_phone_plan_questions_valid on screening_v2.phone_session_plans;
create trigger trg_phone_plan_questions_valid
  before insert on screening_v2.phone_session_plans
  for each row execute function screening_v2.validate_phone_plan_questions();

create or replace function screening_v2.record_phone_probe(
  p_session_id uuid,
  p_question_key text,
  p_expected_index integer,
  p_source_event_id text,
  p_now timestamptz default now()
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_session screening_v2.call_sessions%rowtype;
  v_plan screening_v2.phone_session_plans%rowtype;
  v_existing screening_v2.phone_session_probes%rowtype;
  v_expected text;
begin
  if p_session_id is null or p_question_key is null
     or p_question_key !~ '^[A-Za-z0-9_.:-]{1,100}$'
     or p_source_event_id is null
     or p_source_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_expected_index is null or p_expected_index < 0 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select * into v_session from screening_v2.call_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'unknown_session'); end if;
  select * into v_plan from screening_v2.phone_session_plans where session_id = p_session_id;
  if not found then return jsonb_build_object('status', 'plan_missing'); end if;
  select * into v_existing from screening_v2.phone_session_probes
    where session_id = p_session_id and source_event_id = p_source_event_id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'question_key', v_existing.question_key,
      'question_index', v_existing.question_index, 'probe_count', 1);
  end if;
  if v_session.status <> 'in_progress' then
    return jsonb_build_object('status', 'session_not_active');
  end if;
  if p_expected_index <> greatest(coalesce(v_session.current_question_index, 0), 0)
     or p_expected_index >= v_plan.question_count then
    return jsonb_build_object('status', 'stale_cursor',
      'cursor', greatest(coalesce(v_session.current_question_index, 0), 0));
  end if;
  v_expected := v_plan.questions -> p_expected_index ->> 'key';
  if p_question_key <> v_expected then
    return jsonb_build_object('status', 'key_not_current');
  end if;
  if exists (select 1 from screening_v2.phone_session_probes
             where session_id = p_session_id and question_key = p_question_key) then
    return jsonb_build_object('status', 'probe_denied', 'probe_count', 1);
  end if;
  insert into screening_v2.phone_session_probes(session_id, question_key, question_index, source_event_id, created_at)
  values (p_session_id, p_question_key, p_expected_index, p_source_event_id, p_now);
  return jsonb_build_object('status', 'probe_recorded', 'probe_count', 1,
    'question_key', p_question_key, 'question_index', p_expected_index);
exception when unique_violation then
  -- A concurrent retry is a normal idempotent outcome. Do not expose detail.
  return jsonb_build_object('status', 'duplicate', 'probe_count', 1);
end;
$$;

revoke all on function screening_v2.record_phone_probe(uuid,text,integer,text,timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.record_phone_probe(uuid,text,integer,text,timestamptz)
  to service_role;
