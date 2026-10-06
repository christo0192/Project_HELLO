-- R1 WebRTC interview rounds: isolated aggregate, consent, capacity and admission.
-- The only shared-table dependencies are added by 0116 immediately after this file.
set local lock_timeout = '10s';

create table if not exists screening_v2.interview_rounds (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id) on delete cascade,
  role_id uuid not null references screening_v2.roles(id) on delete cascade,
  kind text not null default 'sales_r1' check (kind in ('sales_r1')),
  status text not null default 'invited'
    check (status in ('invited', 'in_progress', 'completed', 'expired', 'cancelled')),
  link_token_digest text not null unique check (link_token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  attempts_allowed integer not null default 2 check (attempts_allowed between 1 and 2),
  attempts_counted integer not null default 0 check (attempts_counted >= 0),
  starts_used integer not null default 0 check (starts_used >= 0 and starts_used <= 3),
  candidate_status_at_send text,
  recommendation text check (recommendation in ('advance', 'hold', 'reject')),
  overall numeric(5,2) check (overall is null or (overall >= 0 and overall <= 100)),
  assessment_id uuid references screening_v2.assessments(id) on delete cascade,
  status_written_at timestamptz,
  pending_reject_until timestamptz,
  created_by uuid not null,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_interview_rounds_attempts check (attempts_counted <= attempts_allowed),
  constraint chk_interview_rounds_pending_reject check (
    pending_reject_until is null or recommendation = 'reject'
  )
);

create unique index if not exists uq_interview_rounds_candidate_kind_live
  on screening_v2.interview_rounds(candidate_id, kind)
  where status not in ('completed', 'expired', 'cancelled');
create index if not exists idx_interview_rounds_role on screening_v2.interview_rounds(role_id);

create table if not exists screening_v2.interview_round_attempts (
  session_id uuid primary key references screening_v2.call_sessions(id) on delete cascade,
  round_id uuid not null references screening_v2.interview_rounds(id) on delete cascade,
  attempt_number integer not null check (attempt_number >= 1),
  persona_id text not null check (persona_id in (
    'p1_career_switcher', 'p2_recent_grad', 'p3_data_analyst', 'p4_research_scholar'
  )),
  persona_version integer not null default 1 check (persona_version >= 1),
  persona_variant text not null default 'default' check (length(persona_variant) between 1 and 64),
  content_sha text check (content_sha is null or content_sha ~ '^[a-f0-9]{64}$'),
  counted boolean not null default false,
  outcome text,
  nonce_digest text not null check (nonce_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint uq_interview_round_attempts_session_round unique (session_id, round_id)
);
create index if not exists idx_interview_round_attempts_round on screening_v2.interview_round_attempts(round_id, attempt_number, created_at desc);

create table if not exists screening_v2.interview_round_consent_templates (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  locale text not null default 'en-IN',
  title text not null,
  body_md text not null,
  required_consents jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  constraint uq_interview_round_consent_templates_version_locale unique (version, locale),
  constraint chk_interview_round_consent_templates_required_consents_array check (jsonb_typeof(required_consents) = 'array')
);

create or replace function screening_v2.prevent_interview_round_consent_template_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception 'interview_round_consent_templates are immutable: % is not permitted', tg_op
    using errcode = 'P0001';
end;
$$;
drop trigger if exists trg_interview_round_consent_templates_immutable on screening_v2.interview_round_consent_templates;
create trigger trg_interview_round_consent_templates_immutable
  before update or delete on screening_v2.interview_round_consent_templates
  for each row execute function screening_v2.prevent_interview_round_consent_template_mutation();

create table if not exists screening_v2.interview_round_consents (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references screening_v2.interview_rounds(id) on delete cascade,
  template_id uuid not null references screening_v2.interview_round_consent_templates(id) on delete cascade,
  consents jsonb not null default '[]'::jsonb,
  proof jsonb,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chk_interview_round_consents_array check (jsonb_typeof(consents) = 'array')
);
create unique index if not exists uq_interview_round_consents_live_round
  on screening_v2.interview_round_consents(round_id)
  where withdrawn_at is null;

create table if not exists screening_v2.r1_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  paused boolean not null default false,
  auto_status_enabled boolean not null default false,
  monthly_cap_minutes integer not null default 4000 check (monthly_cap_minutes > 0),
  pause_line_minutes integer not null default 4000 check (pause_line_minutes > 0),
  admission_hold_minutes integer not null default 55 check (admission_hold_minutes = 55),
  advance_threshold numeric(5,2) not null default 65 check (advance_threshold between 0 and 100),
  hold_threshold numeric(5,2) not null default 45 check (hold_threshold between 0 and 100),
  livekit_target text not null default 'cloud' check (livekit_target in ('cloud', 'r1')),
  dashboard_minutes numeric(10,2) not null default 0 check (dashboard_minutes >= 0),
  dashboard_read_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint chk_r1_settings_threshold_order check (hold_threshold <= advance_threshold)
);
insert into screening_v2.r1_settings (singleton) values (true) on conflict (singleton) do nothing;

create table if not exists screening_v2.r1_budget_month (
  month_start date primary key check (month_start = date_trunc('month', month_start)::date),
  minutes_reserved numeric(10,2) not null default 0 check (minutes_reserved >= 0),
  minutes_used numeric(10,2) not null default 0 check (minutes_used >= 0),
  starts_admitted integer not null default 0 check (starts_admitted >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table screening_v2.roles
  add column if not exists interview_kind text null
  check (interview_kind is null or interview_kind in ('sales_r1'));

create or replace function screening_v2.reject_ashby_r1_role_mapping()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if exists (select 1 from screening_v2.roles r
             where r.id = new.role_id and r.interview_kind is not null) then
    raise exception 'Ashby mappings are not allowed for interview_kind roles'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ashby_mapping_reject_r1_role on screening_v2.ashby_job_mappings;
create trigger trg_ashby_mapping_reject_r1_role
  before insert or update of role_id on screening_v2.ashby_job_mappings
  for each row execute function screening_v2.reject_ashby_r1_role_mapping();

create or replace function screening_v2.audit_r1_settings_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(new.updated_by, auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
     case when new.updated_by is not null or auth.uid() is not null then 'recruiter' else 'system' end,
     'config_changed', 'r1_settings', 'default', 'success',
     jsonb_build_object('enabled', new.enabled, 'paused', new.paused,
                        'auto_status_enabled', new.auto_status_enabled,
                        'livekit_target', new.livekit_target));
  return new;
end;
$$;

drop trigger if exists trg_r1_settings_audit on screening_v2.r1_settings;
create trigger trg_r1_settings_audit
  after update on screening_v2.r1_settings
  for each row execute function screening_v2.audit_r1_settings_change();

-- `call_sessions.interview_round_id` is deliberately introduced by 0116. PL/pgSQL
-- validates this body on first execution, after that adjacent migration has run.
create or replace function screening_v2.r1_admit_attempt(
  p_round_id uuid,
  p_nonce_digest text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_round screening_v2.interview_rounds%rowtype;
  v_settings screening_v2.r1_settings%rowtype;
  v_budget screening_v2.r1_budget_month%rowtype;
  v_month date := date_trunc('month', p_now)::date;
  v_live_r1 integer;
  v_live_phone integer;
  v_attempt_number integer;
  v_persona text;
  v_session_id uuid := gen_random_uuid();
begin
  if p_nonce_digest is null or p_nonce_digest !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_nonce');
  end if;

  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found or not v_settings.enabled then return jsonb_build_object('status', 'disabled'); end if;
  if v_settings.paused then return jsonb_build_object('status', 'paused'); end if;

  insert into screening_v2.r1_budget_month (month_start) values (v_month) on conflict (month_start) do nothing;
  select * into v_budget from screening_v2.r1_budget_month where month_start = v_month for update;

  select * into v_round from screening_v2.interview_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('status', 'round_not_found'); end if;
  if v_round.status not in ('invited', 'in_progress') then return jsonb_build_object('status', 'round_not_admissible'); end if;
  if v_round.expires_at <= p_now then return jsonb_build_object('status', 'round_expired'); end if;
  if v_round.starts_used >= 3 then return jsonb_build_object('status', 'starts_exhausted'); end if;
  if v_round.attempts_counted >= v_round.attempts_allowed then return jsonb_build_object('status', 'attempts_exhausted'); end if;
  if not exists (select 1 from screening_v2.roles r where r.id = v_round.role_id and r.interview_kind = v_round.kind) then
    return jsonb_build_object('status', 'r1_role_invalid');
  end if;
  if not exists (
    select 1
      from screening_v2.interview_round_consents c
      join screening_v2.interview_round_consent_templates t on t.id = c.template_id
     where c.round_id = v_round.id and c.withdrawn_at is null and c.granted_at <= p_now
       and t.required_consents <@ c.consents
  ) then return jsonb_build_object('status', 'consent_missing'); end if;

  if greatest(v_budget.minutes_used + v_budget.minutes_reserved, v_settings.dashboard_minutes)
       + v_settings.admission_hold_minutes > least(v_settings.monthly_cap_minutes, v_settings.pause_line_minutes) then
    return jsonb_build_object('status', 'capacity_exhausted');
  end if;

  select count(*) into v_live_r1 from screening_v2.call_sessions s
   where s.interview_round_id is not null and s.status in ('created', 'waiting', 'in_progress');
  if v_live_r1 >= 1 then return jsonb_build_object('status', 'r1_in_flight'); end if;
  if v_settings.livekit_target = 'cloud' then
    select count(*) into v_live_phone from screening_v2.call_sessions s
     where s.mode = 'live' and s.status in ('created', 'waiting', 'in_progress');
    if v_live_r1 + v_live_phone >= 4 then return jsonb_build_object('status', 'cloud_capacity_exhausted'); end if;
  end if;

  v_attempt_number := v_round.attempts_counted + 1;
  select a.persona_id into v_persona from screening_v2.interview_round_attempts a
   where a.round_id = v_round.id and a.attempt_number = v_attempt_number and not a.counted
   order by a.created_at desc limit 1;
  if v_persona is null then
    select p.persona_id into v_persona
      from unnest(array['p1_career_switcher', 'p2_recent_grad', 'p3_data_analyst', 'p4_research_scholar']) as p(persona_id)
     where not exists (
       select 1 from screening_v2.interview_round_attempts prior
        where prior.round_id = v_round.id and prior.counted and prior.persona_id = p.persona_id
     )
     order by (select count(*) from screening_v2.interview_round_attempts used
               where used.persona_id = p.persona_id), random()
     limit 1;
  end if;

  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values
    (v_session_id, v_round.candidate_id, v_round.role_id, 'browser', 'livekit',
     'screening-' || v_session_id::text, 'created', v_round.id, v_round.created_by);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest)
  values (v_session_id, v_round.id, v_attempt_number, v_persona, p_nonce_digest);
  update screening_v2.interview_rounds
     set starts_used = starts_used + 1, status = 'in_progress', version = version + 1, updated_at = p_now
   where id = v_round.id;
  update screening_v2.r1_budget_month
     set minutes_reserved = minutes_reserved + v_settings.admission_hold_minutes,
         starts_admitted = starts_admitted + 1, updated_at = p_now
   where month_start = v_month;

  return jsonb_build_object('status', 'ok', 'session_id', v_session_id,
                            'attempt_number', v_attempt_number, 'persona_id', v_persona);
end;
$$;

alter table screening_v2.interview_rounds enable row level security;
alter table screening_v2.interview_round_attempts enable row level security;
alter table screening_v2.interview_round_consent_templates enable row level security;
alter table screening_v2.interview_round_consents enable row level security;
alter table screening_v2.r1_settings enable row level security;
alter table screening_v2.r1_budget_month enable row level security;

revoke all on screening_v2.interview_rounds, screening_v2.interview_round_attempts,
  screening_v2.interview_round_consent_templates, screening_v2.interview_round_consents,
  screening_v2.r1_settings, screening_v2.r1_budget_month from public, anon, authenticated;
grant all privileges on screening_v2.interview_rounds, screening_v2.interview_round_attempts,
  screening_v2.interview_round_consent_templates, screening_v2.interview_round_consents,
  screening_v2.r1_settings, screening_v2.r1_budget_month to service_role;
revoke all on function screening_v2.r1_admit_attempt(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_admit_attempt(uuid, text, timestamptz) to service_role;
revoke all on function screening_v2.reject_ashby_r1_role_mapping() from public, anon, authenticated;
revoke all on function screening_v2.audit_r1_settings_change() from public, anon, authenticated;
revoke all on function screening_v2.prevent_interview_round_consent_template_mutation() from public, anon, authenticated;
