-- Faithful-minimal screening_v2 objects that 0091 touches or reads, plus a
-- fixture mirroring the production incident (assessment e333af5d): a v2
-- incomplete_evidence row with 3 scored metrics (3/5) + 2 insufficient, weighted
-- NULL and raw.recommendation='human_review'. Applying 0091 must recover it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create schema if not exists screening_v2;
create extension if not exists pgcrypto;

create table screening_v2.role_scorecard_version_metrics (
  id uuid primary key default gen_random_uuid(),
  weight_bps integer not null
);

create table screening_v2.assessments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid,
  candidate_id uuid,
  schema_version integer not null default 1,
  revision integer not null default 1,
  scorecard_version_id uuid,
  metric_results jsonb,
  weighted_score_5 numeric(5,4),
  overall_score numeric,
  scoring_status text not null default 'complete',
  recommendation text,
  source text not null default 'browser',
  partial boolean not null default false,
  raw jsonb,
  created_at timestamptz not null default now(),
  constraint chk_assessments_recommendation check (recommendation is null or recommendation in ('advance','hold','reject')),
  constraint chk_assessments_scoring_status check (scoring_status in ('complete','incomplete_evidence')),
  constraint chk_assessments_weighted_score_5 check (weighted_score_5 is null or weighted_score_5 between 1 and 5),
  -- ORIGINAL 0088 shape CHECK (the one 0091 relaxes): incomplete_evidence forced weighted NULL.
  constraint chk_assessments_v2_shape check (
    (schema_version = 1 and scorecard_version_id is null and metric_results is null and weighted_score_5 is null)
    or (schema_version = 2 and metric_results is not null and jsonb_typeof(metric_results) = 'array'
        and ((scoring_status = 'complete' and weighted_score_5 is not null)
             or (scoring_status = 'incomplete_evidence' and weighted_score_5 is null)))
  )
);

-- Tables v_funnel_failures reads (minimal).
create table screening_v2.job_dlq (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  error_message text,
  failed_at timestamptz not null default now()
);
create table screening_v2.resume_intake_failures (
  id uuid primary key default gen_random_uuid(),
  role_id uuid,
  failed_reason text not null,
  source text not null default 'recruiter_upload',
  occurred_at timestamptz not null default now()
);
create table screening_v2.ashby_resume_ingestions (
  id uuid primary key default gen_random_uuid(),
  application_link_id uuid,
  state text not null default 'queued',
  failed_reason text,
  updated_at timestamptz not null default now()
);
create table screening_v2.phone_call_attempts (
  id uuid primary key default gen_random_uuid(),
  outcome_class text,
  egress_status text,
  admitted_at timestamptz not null default now(),
  ended_at timestamptz
);
create table screening_v2.call_sessions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'created',
  terminal_reason text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- ── Fixture: 5 metrics @ 2000 bps; the incident assessment ────────────
-- metric ids ...0001..0005; scored = 0001/0004/0005, insufficient = 0002/0003.
insert into screening_v2.role_scorecard_version_metrics (id, weight_bps) values
  ('00000000-0000-0000-0000-000000000001', 2000),
  ('00000000-0000-0000-0000-000000000002', 2000),
  ('00000000-0000-0000-0000-000000000003', 2000),
  ('00000000-0000-0000-0000-000000000004', 2000),
  ('00000000-0000-0000-0000-000000000005', 2000);

insert into screening_v2.assessments
  (id, session_id, candidate_id, schema_version, revision, scorecard_version_id,
   scoring_status, weighted_score_5, overall_score, recommendation, source, partial,
   metric_results, raw)
values (
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-000000000551',
  '00000000-0000-0000-0000-0000000000c1',
  2, 1, '00000000-0000-0000-0000-0000000000f1',
  'incomplete_evidence', null, null, null, 'phone', true,
  '[{"configMetricId":"00000000-0000-0000-0000-000000000001","evidenceStatus":"scored","score":3},
    {"configMetricId":"00000000-0000-0000-0000-000000000002","evidenceStatus":"insufficient_evidence","score":null},
    {"configMetricId":"00000000-0000-0000-0000-000000000003","evidenceStatus":"insufficient_evidence","score":null},
    {"configMetricId":"00000000-0000-0000-0000-000000000004","evidenceStatus":"scored","score":3},
    {"configMetricId":"00000000-0000-0000-0000-000000000005","evidenceStatus":"scored","score":3}]'::jsonb,
  '{"schemaVersion":2,"status":"incomplete_evidence","weightedScore5":null,"overallScore":null,"recommendation":"human_review","metricResults":[]}'::jsonb
);

-- Second incident-shape row: EVERY metric insufficient (nothing scored). This is
-- the genuine "no evidence at all" case — the recovery must LEAVE it null
-- (weighted/overall/recommendation stay null, raw.recommendation stays
-- 'human_review'), because there is nothing to renormalize over. Guards the
-- "null only when NONE scored" branch of domain.ts / the migration.
insert into screening_v2.assessments
  (id, session_id, candidate_id, schema_version, revision, scorecard_version_id,
   scoring_status, weighted_score_5, overall_score, recommendation, source, partial,
   metric_results, raw)
values (
  '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-000000000552',
  '00000000-0000-0000-0000-0000000000c2',
  2, 1, '00000000-0000-0000-0000-0000000000f1',
  'incomplete_evidence', null, null, null, 'phone', true,
  '[{"configMetricId":"00000000-0000-0000-0000-000000000001","evidenceStatus":"insufficient_evidence","score":null},
    {"configMetricId":"00000000-0000-0000-0000-000000000002","evidenceStatus":"insufficient_evidence","score":null},
    {"configMetricId":"00000000-0000-0000-0000-000000000003","evidenceStatus":"insufficient_evidence","score":null},
    {"configMetricId":"00000000-0000-0000-0000-000000000004","evidenceStatus":"insufficient_evidence","score":null},
    {"configMetricId":"00000000-0000-0000-0000-000000000005","evidenceStatus":"insufficient_evidence","score":null}]'::jsonb,
  '{"schemaVersion":2,"status":"incomplete_evidence","weightedScore5":null,"overallScore":null,"recommendation":"human_review","metricResults":[]}'::jsonb
);

-- Third row: FAIL-SOFT guard fixture. A malformed historical row whose scored
-- elements include a bad configMetricId (not a uuid) and a bad score (non-integer),
-- plus ONE well-formed scored metric (0002 @3). The recovery must NOT abort — it
-- must SKIP the two malformed elements and recover over the single valid one →
-- weighted 3.0 (proves both cast guards AND that a valid-uuid/bad-score element is
-- dropped whole so it never skews the denominator).
insert into screening_v2.assessments
  (id, session_id, candidate_id, schema_version, revision, scorecard_version_id,
   scoring_status, weighted_score_5, overall_score, recommendation, source, partial,
   metric_results, raw)
values (
  '00000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-000000000553',
  '00000000-0000-0000-0000-0000000000c3',
  2, 1, '00000000-0000-0000-0000-0000000000f1',
  'incomplete_evidence', null, null, null, 'phone', true,
  '[{"configMetricId":"not-a-valid-uuid","evidenceStatus":"scored","score":3},
    {"configMetricId":"00000000-0000-0000-0000-000000000001","evidenceStatus":"scored","score":3.5},
    {"configMetricId":"00000000-0000-0000-0000-000000000002","evidenceStatus":"scored","score":3},
    {"configMetricId":"00000000-0000-0000-0000-000000000003","evidenceStatus":"insufficient_evidence","score":null}]'::jsonb,
  '{"schemaVersion":2,"status":"incomplete_evidence","weightedScore5":null,"overallScore":null,"recommendation":"human_review","metricResults":[]}'::jsonb
);

-- A hard scoring failure in the DLQ (must surface in v_funnel_failures after 0091).
insert into screening_v2.job_dlq (name, error_message) values ('phone.assessment', 'timeout');
