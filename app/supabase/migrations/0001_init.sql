-- =====================================================================
-- AI HR Screening Bot — CLEAN schema (Pipecat + Sarvam build)
-- Isolated in schema `screening_v2` so it can be rehearsed without colliding
-- with legacy tables in `public`.
--
-- APPLY: Use the migration workflow against an isolated development project.
-- THEN:  Settings → API → "Exposed schemas" → add `screening_v2` (so the
--        supabase-py client can read/write it over REST).
-- Single-tenant internal tool: backend uses service_role (bypasses RLS).
-- =====================================================================

create schema if not exists screening_v2;
create extension if not exists "pgcrypto";

-- ---------- Roles / job openings -------------------------------------
create table if not exists screening_v2.roles (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  jd            text,
  required_skills jsonb not null default '[]'::jsonb,
  screening_template jsonb not null default '[]'::jsonb,  -- [{id,question,weight,follow_up_hint}]
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- Resumes (raw file + parsed) -----------------------------
create table if not exists screening_v2.resumes (
  id             uuid primary key default gen_random_uuid(),
  file_path      text,
  file_name      text,
  mime_type      text,
  text_extracted text,
  parsed         jsonb,
  created_at     timestamptz not null default now()
);

-- ---------- Candidates ----------------------------------------------
create table if not exists screening_v2.candidates (
  id              uuid primary key default gen_random_uuid(),
  role_id         uuid references screening_v2.roles(id) on delete set null,
  resume_id       uuid references screening_v2.resumes(id) on delete set null,
  name            text,
  email           text,
  phone_raw       text,
  phone_e164      text,
  phone_valid     boolean not null default false,
  skills          jsonb not null default '[]'::jsonb,
  experience_years numeric,
  parsed          jsonb,
  status          text not null default 'new',  -- new|queued|screening|screened|advanced|rejected
  consent_source  text default 'job_application',
  consent_at      timestamptz,
  ats_external_id text,                          -- Ashby placeholder (deferred)
  ats_source      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_v2_candidates_role on screening_v2.candidates(role_id);
create index if not exists idx_v2_candidates_phone on screening_v2.candidates(phone_e164);
create index if not exists idx_v2_candidates_status on screening_v2.candidates(status);

-- ---------- Call sessions (Pipecat browser/live) --------------------
create table if not exists screening_v2.call_sessions (
  id              uuid primary key default gen_random_uuid(),
  candidate_id    uuid not null references screening_v2.candidates(id) on delete cascade,
  role_id         uuid references screening_v2.roles(id) on delete set null,
  mode            text not null default 'browser',   -- browser|live(telephony)
  provider        text not null default 'pipecat',
  external_call_id text,
  status          text not null default 'in_progress', -- in_progress|completed|abandoned|failed
  recording_url   text,
  current_question_index int not null default 0,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  duration_sec    int
);
create index if not exists idx_v2_sessions_candidate on screening_v2.call_sessions(candidate_id);

-- ---------- Transcript turns ----------------------------------------
create table if not exists screening_v2.transcript_turns (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references screening_v2.call_sessions(id) on delete cascade,
  turn_index  int not null,
  speaker     text not null,      -- bot|candidate
  text        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_turns_session on screening_v2.transcript_turns(session_id, turn_index);

-- ---------- Assessments (scoring) -----------------------------------
create table if not exists screening_v2.assessments (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references screening_v2.call_sessions(id) on delete cascade,
  candidate_id  uuid not null references screening_v2.candidates(id) on delete cascade,
  english       jsonb,
  tone          jsonb,
  role_fit      jsonb,
  overall_score numeric,
  recommendation text,   -- advance|hold|reject
  summary       text,
  raw           jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_v2_assess_candidate on screening_v2.assessments(candidate_id);

-- ---------- Consent records (audit) ---------------------------------
create table if not exists screening_v2.consent_records (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id) on delete cascade,
  source       text not null default 'job_application',
  proof        jsonb,
  created_at   timestamptz not null default now()
);

-- ---------- Call queue (lightweight scheduling) ---------------------
create table if not exists screening_v2.call_queue (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references screening_v2.candidates(id) on delete cascade,
  role_id       uuid references screening_v2.roles(id) on delete set null,
  status        text not null default 'pending', -- pending|dialing|completed|no_answer|failed
  attempts      int not null default 0,
  next_attempt_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_v2_queue_status on screening_v2.call_queue(status, next_attempt_at);

-- ---------- SMS follow-ups (DLT-templated, telephony-gated) ---------
create table if not exists screening_v2.sms_follow_ups (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id) on delete cascade,
  template_id  text,
  body         text,
  status       text not null default 'pending', -- pending|sent|failed
  created_at   timestamptz not null default now()
);

-- ---------- ATS sync log (Ashby — deferred) -------------------------
create table if not exists screening_v2.ats_sync_log (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid references screening_v2.candidates(id) on delete set null,
  provider     text not null default 'ashby',
  payload      jsonb,
  status       text not null default 'pending',
  created_at   timestamptz not null default now()
);

-- ---------- updated_at trigger --------------------------------------
create or replace function screening_v2.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_v2_candidates_updated on screening_v2.candidates;
create trigger trg_v2_candidates_updated before update on screening_v2.candidates
  for each row execute function screening_v2.set_updated_at();

-- ---------- RLS: deny-by-default (service_role bypasses) ------------
alter table screening_v2.roles            enable row level security;
alter table screening_v2.resumes          enable row level security;
alter table screening_v2.candidates       enable row level security;
alter table screening_v2.call_sessions    enable row level security;
alter table screening_v2.transcript_turns enable row level security;
alter table screening_v2.assessments      enable row level security;
alter table screening_v2.consent_records  enable row level security;
alter table screening_v2.call_queue       enable row level security;
alter table screening_v2.sms_follow_ups   enable row level security;
alter table screening_v2.ats_sync_log     enable row level security;

-- ---------- Server-only baseline grants -----------------------------
-- The initial production state is deny-by-default for browser roles.
-- Migration 0004 grants narrowly scoped authenticated read access only
-- after an active recruiter-membership check. Backend services use the
-- server-only service_role, which bypasses RLS.
revoke all on schema screening_v2 from anon, authenticated;
grant usage on schema screening_v2 to service_role;
grant all privileges on all tables    in schema screening_v2 to service_role;
grant all privileges on all sequences in schema screening_v2 to service_role;
grant all privileges on all functions in schema screening_v2 to service_role;
alter default privileges in schema screening_v2 grant all on tables    to service_role;
alter default privileges in schema screening_v2 grant all on sequences to service_role;
alter default privileges in schema screening_v2 grant all on functions to service_role;

-- ---------- Storage buckets (global; v2-suffixed to avoid v1 clash) -
insert into storage.buckets (id, name, public)
values ('resumes_v2', 'resumes_v2', false) on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('recordings_v2', 'recordings_v2', false) on conflict (id) do nothing;

-- =====================================================================
-- After running: Settings → API → Exposed schemas → add `screening_v2`.
-- The voice service reads SUPABASE_SCHEMA=screening_v2 from app/voice/.env.
-- =====================================================================
