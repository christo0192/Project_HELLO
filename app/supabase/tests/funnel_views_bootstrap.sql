-- Minimal, faithful bootstrap of the screening_v2 objects that 0090 reads.
-- Columns match the real migrations (0001/0029/0042/0044/0086/0088); triggers
-- and most CHECKs are omitted (not needed to validate the funnel views/RPC).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create schema if not exists screening_v2;
create extension if not exists pgcrypto;

create table screening_v2.roles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  created_at timestamptz not null default now()
);

create table screening_v2.resumes (
  id uuid primary key default gen_random_uuid(),
  parsed jsonb,
  created_at timestamptz not null default now()
);

create table screening_v2.candidates (
  id uuid primary key default gen_random_uuid(),
  role_id uuid references screening_v2.roles(id) on delete set null,
  resume_id uuid references screening_v2.resumes(id) on delete set null,
  phone_valid boolean not null default false,
  parsed jsonb,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create table screening_v2.call_sessions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id) on delete cascade,
  role_id uuid references screening_v2.roles(id) on delete set null,
  status text not null default 'created',
  terminal_reason text,
  duration_sec int,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table screening_v2.assessments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_v2.call_sessions(id) on delete cascade,
  candidate_id uuid not null references screening_v2.candidates(id) on delete cascade,
  overall_score numeric,
  recommendation text,
  source text not null default 'browser',
  partial boolean not null default false,
  scoring_status text not null default 'complete',
  weighted_score_5 numeric(5,4),
  created_at timestamptz not null default now()
);

create table screening_v2.ashby_job_mappings (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references screening_v2.roles(id) on delete restrict,
  ai_screening_stage_id text,
  ta_screening_stage_id text,
  created_at timestamptz not null default now()
);

create table screening_v2.ashby_application_links (
  id uuid primary key default gen_random_uuid(),
  external_application_id text not null,
  external_stage_id text,
  job_mapping_id uuid references screening_v2.ashby_job_mappings(id) on delete set null,
  candidate_id uuid references screening_v2.candidates(id) on delete set null,
  created_at timestamptz not null default now()
);

create table screening_v2.ashby_resume_ingestions (
  id uuid primary key default gen_random_uuid(),
  application_link_id uuid not null references screening_v2.ashby_application_links(id) on delete cascade,
  state text not null default 'queued',
  failed_reason text,
  updated_at timestamptz not null default now()
);

create table screening_v2.phone_engagements (
  id uuid primary key default gen_random_uuid(),
  application_link_id uuid,
  candidate_id uuid not null references screening_v2.candidates(id) on delete restrict,
  role_id uuid references screening_v2.roles(id) on delete set null,
  state text not null default 'pending_prereqs',
  session_id uuid references screening_v2.call_sessions(id) on delete set null,
  terminal_at timestamptz,
  created_at timestamptz not null default now()
);

create table screening_v2.phone_call_attempts (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references screening_v2.phone_engagements(id) on delete cascade,
  session_id uuid references screening_v2.call_sessions(id) on delete set null,
  state text not null default 'admitted',
  outcome_class text,
  egress_status text,
  admitted_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);

create table screening_v2.phone_session_plans (
  session_id uuid primary key references screening_v2.call_sessions(id) on delete cascade,
  engagement_id uuid,
  question_count int not null default 1,
  created_at timestamptz not null default now()
);

create table screening_v2.phone_session_progress (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_v2.call_sessions(id) on delete cascade,
  question_key text not null,
  disposition text,
  committed_at timestamptz not null default now()
);
