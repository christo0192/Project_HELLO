-- R1's append-only worker ledger and read-only capacity estimates.
set local lock_timeout = '10s';

create table if not exists screening_v2.r1_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references screening_v2.call_sessions(id) on delete cascade,
  round_id uuid references screening_v2.interview_rounds(id) on delete cascade,
  participant_kind text not null check (participant_kind in ('candidate','agent','preflight','manual_test')),
  event text not null check (event in ('connect','disconnect','usage')),
  seconds numeric(12,2) not null default 0 check (seconds >= 0),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((participant_kind in ('preflight','manual_test')) or session_id is not null)
);
create index if not exists idx_r1_usage_ledger_occurred on screening_v2.r1_usage_ledger(occurred_at);
create index if not exists idx_r1_usage_ledger_session on screening_v2.r1_usage_ledger(session_id) where session_id is not null;

create table if not exists screening_v2.r1_admin_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_v2.call_sessions(id) on delete cascade,
  round_id uuid not null references screening_v2.interview_rounds(id) on delete cascade,
  event_type text not null check (event_type in ('need_revealed','family_delivered','push_delivered','counter_delivered','discount_detected','guard_hit','time_cue')),
  turn_index integer check (turn_index is null or turn_index >= 0),
  family_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object')
);
create index if not exists idx_r1_admin_log_session on screening_v2.r1_admin_log(session_id, created_at);

-- The estimate intentionally reads existing phone/legacy rows only; it never
-- alters their lifecycle. Ledger seconds are authoritative when supplied.
create or replace view screening_v2.v_webrtc_minutes_estimate
with (security_invoker = true) as
with ledger as (
  select date_trunc('month', occurred_at)::date as month_start, sum(seconds) / 60.0 as minutes
  from screening_v2.r1_usage_ledger group by 1
), legacy_browser as (
  select date_trunc('month', coalesce(ended_at, started_at, updated_at))::date as month_start,
    sum((greatest(0, extract(epoch from (coalesce(ended_at, updated_at) - coalesce(started_at, updated_at)))) * 2 + 60) / 60.0) as minutes
  from screening_v2.call_sessions
  where mode = 'browser' and interview_round_id is null
  group by 1
), phone as (
  select date_trunc('month', coalesce(a.ended_at, a.created_at))::date as month_start,
    sum((greatest(0, extract(epoch from (coalesce(a.ended_at, a.created_at) - a.created_at))) + 60) / 60.0) as minutes
  from screening_v2.phone_call_attempts a group by 1
), months as (select month_start from ledger union select month_start from legacy_browser union select month_start from phone)
select m.month_start, coalesce(l.minutes,0) as r1_minutes, coalesce(p.minutes,0) as phone_minutes,
       coalesce(b.minutes,0) as legacy_browser_minutes,
       (coalesce(l.minutes,0)+coalesce(p.minutes,0)+coalesce(b.minutes,0))*1.15 as estimated_minutes
from months m left join ledger l using(month_start) left join phone p using(month_start) left join legacy_browser b using(month_start);

create or replace view screening_v2.v_r1_budget_month
with (security_invoker = true) as
select b.month_start, b.minutes_reserved, b.minutes_used, b.starts_admitted,
       coalesce(e.r1_minutes, 0) as ledger_minutes, coalesce(e.estimated_minutes, 0) as webrtc_estimated_minutes,
       s.monthly_cap_minutes, s.pause_line_minutes, s.dashboard_minutes, s.dashboard_read_at,
       greatest(coalesce(e.estimated_minutes, 0), s.dashboard_minutes) as guarded_minutes
from screening_v2.r1_budget_month b
cross join screening_v2.r1_settings s
left join screening_v2.v_webrtc_minutes_estimate e on e.month_start = b.month_start;

alter table screening_v2.r1_usage_ledger enable row level security;
alter table screening_v2.r1_admin_log enable row level security;
revoke all on screening_v2.r1_usage_ledger, screening_v2.r1_admin_log,
  screening_v2.v_webrtc_minutes_estimate, screening_v2.v_r1_budget_month from public, anon, authenticated;
grant all privileges on screening_v2.r1_usage_ledger, screening_v2.r1_admin_log to service_role;
grant select on screening_v2.v_webrtc_minutes_estimate, screening_v2.v_r1_budget_month to service_role;

-- 0117 is unreleased.  A hold belongs to the round that caused it, which makes
-- conversion and release auditable and prevents an admission from reserving a
-- second 55 minutes after Send R1 already won capacity.
alter table screening_v2.interview_rounds
  add column if not exists held_minutes numeric(10,2) not null default 0
  check (held_minutes in (0, 55));
alter table screening_v2.r1_usage_ledger
  add column if not exists event_key text;
update screening_v2.r1_usage_ledger set event_key = id::text where event_key is null;
alter table screening_v2.r1_usage_ledger alter column event_key set not null;
alter table screening_v2.r1_usage_ledger
  add constraint chk_r1_usage_event_key check (event_key ~ '^[A-Za-z0-9:_-]{1,128}$'),
  add constraint chk_r1_usage_event_bounds check (
    (participant_kind = 'preflight' and seconds <= 15) or
    (participant_kind in ('candidate','agent','manual_test') and seconds <= 1830)
  );
create unique index if not exists uq_r1_usage_ledger_session_event_key
  on screening_v2.r1_usage_ledger(session_id, event_key);

-- Estimate R1 time from server session timestamps when an older/live session
-- has no ledger event yet.  This is deliberately a fallback, not additive.
create or replace view screening_v2.v_webrtc_minutes_estimate
with (security_invoker = true) as
with ledger as (
  select date_trunc('month', occurred_at)::date as month_start, sum(seconds) / 60.0 as minutes
  from screening_v2.r1_usage_ledger group by 1
), r1_session_fallback as (
  select date_trunc('month', coalesce(s.ended_at, s.updated_at, s.started_at, s.created_at))::date as month_start,
    sum(greatest(0, extract(epoch from (coalesce(s.ended_at, s.updated_at, now()) - coalesce(s.started_at, s.created_at)))) / 60.0) as minutes
  from screening_v2.call_sessions s
  where s.interview_round_id is not null
    and not exists (select 1 from screening_v2.r1_usage_ledger l where l.session_id = s.id)
  group by 1
), legacy_browser as (
  select date_trunc('month', coalesce(ended_at, started_at, updated_at))::date as month_start,
    sum((greatest(0, extract(epoch from (coalesce(ended_at, updated_at) - coalesce(started_at, updated_at))) * 2 + 60) / 60.0) as minutes
  from screening_v2.call_sessions where mode = 'browser' and interview_round_id is null group by 1
), phone as (
  select date_trunc('month', coalesce(a.ended_at, a.created_at))::date as month_start,
    sum((greatest(0, extract(epoch from (coalesce(a.ended_at, a.created_at) - a.created_at))) + 60) / 60.0) as minutes
  from screening_v2.phone_call_attempts a group by 1
), months as (select month_start from ledger union select month_start from r1_session_fallback union select month_start from legacy_browser union select month_start from phone)
select m.month_start, coalesce(l.minutes,0) + coalesce(f.minutes,0) as r1_minutes, coalesce(p.minutes,0) as phone_minutes,
       coalesce(b.minutes,0) as legacy_browser_minutes,
       (coalesce(l.minutes,0)+coalesce(f.minutes,0)+coalesce(p.minutes,0)+coalesce(b.minutes,0))*1.15 as estimated_minutes
from months m left join ledger l using(month_start) left join r1_session_fallback f using(month_start)
left join phone p using(month_start) left join legacy_browser b using(month_start);

create or replace function screening_v2.r1_send_round(
  p_candidate_id uuid, p_role_id uuid, p_created_by uuid, p_link_token_digest text,
  p_candidate_status_at_send text, p_expires_at timestamptz, p_now timestamptz default now()
) returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_settings screening_v2.r1_settings%rowtype; v_budget screening_v2.r1_budget_month%rowtype;
  v_month date := date_trunc('month', p_now)::date; v_round uuid := gen_random_uuid();
  v_ledger_since numeric := 0; v_pure numeric := 0; v_guard numeric := 0;
begin
  if p_link_token_digest is null or p_link_token_digest !~ '^[a-f0-9]{64}$' or p_expires_at <= p_now then return jsonb_build_object('status','invalid_request'); end if;
  -- Same lock order in every capacity writer: settings then month.
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found or not v_settings.enabled then return jsonb_build_object('status','disabled'); end if;
  if v_settings.paused then return jsonb_build_object('status','paused'); end if;
  insert into screening_v2.r1_budget_month(month_start) values(v_month) on conflict do nothing;
  select * into v_budget from screening_v2.r1_budget_month where month_start=v_month for update;
  if not exists (select 1 from screening_v2.candidates c where c.id=p_candidate_id and c.decision_use_blocked_at is null) then return jsonb_build_object('status','candidate_ineligible'); end if;
  if not exists (select 1 from screening_v2.roles r where r.id=p_role_id and r.interview_kind='sales_r1') then return jsonb_build_object('status','role_not_configured'); end if;
  if exists (select 1 from screening_v2.interview_rounds r where r.candidate_id=p_candidate_id and r.kind='sales_r1' and r.status in ('invited','in_progress')) then return jsonb_build_object('status','round_active'); end if;
  if exists (select 1 from screening_v2.phone_engagements e where e.candidate_id=p_candidate_id and e.state in ('pending_prereqs','eligible','scheduled','dialing','in_call','reconnecting','awaiting_retry')) then return jsonb_build_object('status','phone_engagement_active'); end if;
  if exists (select 1 from screening_v2.call_sessions s join screening_v2.job_queue j on j.payload->>'session_id'=s.id::text where s.candidate_id=p_candidate_id and s.mode='live' and j.name='phone.assessment' and j.status in ('pending','active','delayed')) then return jsonb_build_object('status','phone_assessment_pending'); end if;
  select coalesce(sum(l.seconds)/60.0,0) into v_ledger_since from screening_v2.r1_usage_ledger l where l.occurred_at >= coalesce(v_settings.dashboard_read_at, p_now);
  select coalesce(e.r1_minutes + e.phone_minutes + e.legacy_browser_minutes,0) into v_pure from screening_v2.v_webrtc_minutes_estimate e where e.month_start=v_month;
  v_guard := greatest(v_settings.dashboard_minutes + v_ledger_since, v_pure) * 1.15;
  if greatest(v_budget.minutes_used + v_budget.minutes_reserved, v_guard) + 55 > least(v_settings.monthly_cap_minutes,v_settings.pause_line_minutes) then return jsonb_build_object('status','capacity_exhausted'); end if;
  insert into screening_v2.interview_rounds(id,candidate_id,role_id,kind,link_token_digest,expires_at,candidate_status_at_send,created_by,held_minutes) values(v_round,p_candidate_id,p_role_id,'sales_r1',p_link_token_digest,p_expires_at,p_candidate_status_at_send,p_created_by,55);
  update screening_v2.r1_budget_month set minutes_reserved=minutes_reserved+55,updated_at=p_now where month_start=v_month;
  return jsonb_build_object('status','ok','id',v_round,'round_status','invited','expires_at',p_expires_at);
end; $$;

create or replace function screening_v2.r1_release_round_hold(p_round_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_round screening_v2.interview_rounds%rowtype; v_month date := date_trunc('month',p_now)::date;
begin
  select * into v_round from screening_v2.interview_rounds where id=p_round_id for update;
  if not found then return jsonb_build_object('status','round_not_found'); end if;
  if v_round.held_minutes = 0 then return jsonb_build_object('status','ok','released',0); end if;
  insert into screening_v2.r1_budget_month(month_start) values(v_month) on conflict do nothing;
  perform 1 from screening_v2.r1_budget_month where month_start=v_month for update;
  update screening_v2.r1_budget_month set minutes_reserved=greatest(0,minutes_reserved-v_round.held_minutes),updated_at=p_now where month_start=v_month;
  update screening_v2.interview_rounds set held_minutes=0,updated_at=p_now where id=p_round_id;
  return jsonb_build_object('status','ok','released',v_round.held_minutes);
end; $$;

create or replace function screening_v2.r1_transition_round(p_round_id uuid,p_action text,p_expected_version integer,p_link_token_digest text default null,p_expires_at timestamptz default null,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v screening_v2.interview_rounds%rowtype;
begin
 select * into v from screening_v2.interview_rounds where id=p_round_id for update;
 if not found or v.version <> p_expected_version then return jsonb_build_object('status','version_conflict'); end if;
 if p_action='cancel' then
   if v.status in ('completed','expired','cancelled') then return jsonb_build_object('status','round_terminal'); end if;
   update screening_v2.interview_rounds set status='cancelled',version=version+1,updated_at=p_now where id=v.id;
   perform screening_v2.r1_release_round_hold(v.id,p_now); return jsonb_build_object('status','ok');
 end if;
 if p_action='reissue' then
   if v.status <> 'invited' or p_link_token_digest is null or p_expires_at <= p_now then return jsonb_build_object('status','round_terminal'); end if;
   update screening_v2.interview_rounds set link_token_digest=p_link_token_digest,expires_at=p_expires_at,version=version+1,updated_at=p_now where id=v.id; return jsonb_build_object('status','ok');
 end if;
 if p_action='grant-retake' then
   -- A manual retake is only a final first attempt.  We require a completed,
   -- counted attempt; until score status is available this is intentionally the
   -- conservative gate rather than treating an active/invited row as final.
   if v.status <> 'completed' or v.attempts_counted <> 1 or v.attempts_allowed <= 1
      or (select count(*) from screening_v2.interview_round_attempts a join screening_v2.call_sessions s on s.id=a.session_id where a.round_id=v.id and a.counted and s.status='completed') <> 1 then return jsonb_build_object('status','retake_not_allowed'); end if;
   update screening_v2.interview_rounds set status='invited',expires_at=p_expires_at,version=version+1,updated_at=p_now where id=v.id; return jsonb_build_object('status','ok');
 end if;
 return jsonb_build_object('status','invalid_action');
end; $$;

create or replace function screening_v2.r1_record_usage(p_session_id uuid,p_round_id uuid,p_participant_kind text,p_event text,p_seconds numeric,p_event_key text,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_session record;
begin
 if p_event_key is null or p_event_key !~ '^[A-Za-z0-9:_-]{1,128}$' or p_seconds < 0 or (p_participant_kind='preflight' and p_seconds>15) or (p_participant_kind <> 'preflight' and p_seconds>1830) then return jsonb_build_object('status','invalid_usage'); end if;
 select id,interview_round_id,status,mode,updated_at into v_session from screening_v2.call_sessions where id=p_session_id;
 if not found or v_session.interview_round_id is distinct from p_round_id or v_session.mode <> 'browser' or v_session.status not in ('waiting','in_progress') then return jsonb_build_object('status','session_invalid'); end if;
 insert into screening_v2.r1_usage_ledger(session_id,round_id,participant_kind,event,seconds,event_key,occurred_at) values(p_session_id,p_round_id,p_participant_kind,p_event,p_seconds,p_event_key,p_now) on conflict(session_id,event_key) do nothing;
 if not found then return jsonb_build_object('status','ok','duplicate',true); end if;
 return jsonb_build_object('status','ok','duplicate',false);
end; $$;

create or replace function screening_v2.r1_sweep_expired_rounds(p_now timestamptz default now(),p_limit integer default 100)
returns integer language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare r record; n integer:=0;
begin
 for r in select id from screening_v2.interview_rounds where status='invited' and expires_at<=p_now order by expires_at limit greatest(1,least(p_limit,1000)) for update skip locked loop
   update screening_v2.interview_rounds set status='expired',version=version+1,updated_at=p_now where id=r.id;
   perform screening_v2.r1_release_round_hold(r.id,p_now); n:=n+1;
 end loop; return n;
end; $$;

-- Replaces 0115's admission implementation.  Send owns the first-attempt
-- hold; admission converts it.  A counted retake has no standing hold and
-- therefore takes and converts a fresh one atomically at its start.
create or replace function screening_v2.r1_admit_attempt(p_round_id uuid,p_nonce_digest text,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_round screening_v2.interview_rounds%rowtype; v_settings screening_v2.r1_settings%rowtype; v_budget screening_v2.r1_budget_month%rowtype;
 v_month date:=date_trunc('month',p_now)::date; v_attempt integer; v_persona text; v_session uuid:=gen_random_uuid(); v_hold numeric:=55;
 v_ledger_since numeric:=0; v_pure numeric:=0; v_guard numeric:=0; v_live_r1 integer; v_live_phone integer;
begin
 if p_nonce_digest is null or p_nonce_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status','invalid_nonce'); end if;
 select * into v_settings from screening_v2.r1_settings where singleton for update;
 if not found or not v_settings.enabled then return jsonb_build_object('status','disabled'); end if;
 if v_settings.paused then return jsonb_build_object('status','paused'); end if;
 insert into screening_v2.r1_budget_month(month_start) values(v_month) on conflict do nothing;
 select * into v_budget from screening_v2.r1_budget_month where month_start=v_month for update;
 select * into v_round from screening_v2.interview_rounds where id=p_round_id for update;
 if not found then return jsonb_build_object('status','round_not_found'); end if;
 if v_round.status not in ('invited','in_progress') then return jsonb_build_object('status','round_not_admissible'); end if;
 if v_round.expires_at<=p_now then return jsonb_build_object('status','round_expired'); end if;
 if v_round.starts_used>=3 then return jsonb_build_object('status','starts_exhausted'); end if;
 if v_round.attempts_counted>=v_round.attempts_allowed then return jsonb_build_object('status','attempts_exhausted'); end if;
 if not exists(select 1 from screening_v2.roles r where r.id=v_round.role_id and r.interview_kind=v_round.kind) then return jsonb_build_object('status','r1_role_invalid'); end if;
 if not exists(select 1 from screening_v2.interview_round_consents c join screening_v2.interview_round_consent_templates t on t.id=c.template_id where c.round_id=v_round.id and c.withdrawn_at is null and c.granted_at<=p_now and t.is_active and t.version=(select max(x.version) from screening_v2.interview_round_consent_templates x where x.is_active) and t.required_consents <@ c.consents) then return jsonb_build_object('status','consent_missing'); end if;
 select count(*) into v_live_r1 from screening_v2.call_sessions s where s.interview_round_id is not null and s.status in ('created','waiting','in_progress');
 if v_live_r1>=1 then return jsonb_build_object('status','r1_in_flight'); end if;
 if v_settings.livekit_target='cloud' then select count(*) into v_live_phone from screening_v2.phone_call_attempts p where p.state in ('admitted','ringing','answered_unclassified','human','machine') and p.lease_expires_at>p_now; if v_live_phone>=4 then return jsonb_build_object('status','cloud_capacity_exhausted'); end if; end if;
 if v_round.held_minutes=0 then
   select coalesce(sum(seconds)/60.0,0) into v_ledger_since from screening_v2.r1_usage_ledger where occurred_at>=coalesce(v_settings.dashboard_read_at,p_now);
   select coalesce(r1_minutes+phone_minutes+legacy_browser_minutes,0) into v_pure from screening_v2.v_webrtc_minutes_estimate where month_start=v_month;
   v_guard:=greatest(v_settings.dashboard_minutes+v_ledger_since,v_pure)*1.15;
   if greatest(v_budget.minutes_used+v_budget.minutes_reserved,v_guard)+v_hold>least(v_settings.monthly_cap_minutes,v_settings.pause_line_minutes) then return jsonb_build_object('status','capacity_exhausted'); end if;
   update screening_v2.r1_budget_month set minutes_used=minutes_used+v_hold,starts_admitted=starts_admitted+1,updated_at=p_now where month_start=v_month;
 else
   update screening_v2.r1_budget_month set minutes_reserved=greatest(0,minutes_reserved-v_round.held_minutes),minutes_used=minutes_used+v_round.held_minutes,starts_admitted=starts_admitted+1,updated_at=p_now where month_start=v_month;
   update screening_v2.interview_rounds set held_minutes=0 where id=v_round.id;
 end if;
 v_attempt:=v_round.attempts_counted+1;
 select a.persona_id into v_persona from screening_v2.interview_round_attempts a where a.round_id=v_round.id and a.attempt_number=v_attempt and not a.counted order by a.created_at desc limit 1;
 if v_persona is null then select p.persona_id into v_persona from unnest(array['p1_career_switcher','p2_recent_grad','p3_data_analyst','p4_research_scholar']) p(persona_id) where not exists(select 1 from screening_v2.interview_round_attempts prior where prior.round_id=v_round.id and prior.counted and prior.persona_id=p.persona_id) order by random() limit 1; end if;
 insert into screening_v2.call_sessions(id,candidate_id,role_id,mode,provider,external_call_id,status,interview_round_id,owner_id) values(v_session,v_round.candidate_id,v_round.role_id,'browser','livekit','screening-'||v_session::text,'created',v_round.id,v_round.created_by);
 insert into screening_v2.interview_round_attempts(session_id,round_id,attempt_number,persona_id,nonce_digest) values(v_session,v_round.id,v_attempt,v_persona,p_nonce_digest);
 update screening_v2.interview_rounds set starts_used=starts_used+1,status='in_progress',version=version+1,updated_at=p_now where id=v_round.id;
 return jsonb_build_object('status','ok','session_id',v_session,'attempt_number',v_attempt,'persona_id',v_persona);
end; $$;

revoke all on function screening_v2.r1_send_round(uuid,uuid,uuid,text,text,timestamptz,timestamptz), screening_v2.r1_release_round_hold(uuid,timestamptz), screening_v2.r1_transition_round(uuid,text,integer,text,timestamptz,timestamptz), screening_v2.r1_record_usage(uuid,uuid,text,text,numeric,text,timestamptz), screening_v2.r1_sweep_expired_rounds(timestamptz,integer) from public, anon, authenticated;
grant execute on function screening_v2.r1_send_round(uuid,uuid,uuid,text,text,timestamptz,timestamptz), screening_v2.r1_release_round_hold(uuid,timestamptz), screening_v2.r1_transition_round(uuid,text,integer,text,timestamptz,timestamptz), screening_v2.r1_record_usage(uuid,uuid,text,text,numeric,text,timestamptz), screening_v2.r1_sweep_expired_rounds(timestamptz,integer) to service_role;
