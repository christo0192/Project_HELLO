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
