-- 0088 — Role-owned, immutable scorecard configurations.
-- Additive only: existing assessments stay schema_version=1 and are never rewritten.

-- CHECK constraints cannot contain subqueries, so keep the exact five-key
-- rubric validation in an immutable helper that constraints can safely call.
create or replace function screening_v2.is_scorecard_rubric(value jsonb)
returns boolean language sql immutable strict set search_path = pg_catalog as $$
  select jsonb_typeof(value) = 'object'
    and (select count(*) from jsonb_object_keys(value)) = 5
    and value ?& array['1','2','3','4','5']
    and jsonb_typeof(value->'1') = 'string' and char_length(value->>'1') between 1 and 500
    and jsonb_typeof(value->'2') = 'string' and char_length(value->>'2') between 1 and 500
    and jsonb_typeof(value->'3') = 'string' and char_length(value->>'3') between 1 and 500
    and jsonb_typeof(value->'4') = 'string' and char_length(value->>'4') between 1 and 500
    and jsonb_typeof(value->'5') = 'string' and char_length(value->>'5') between 1 and 500;
$$;

-- ── Global reusable metric templates ────────────────────────────────────
create table if not exists screening_v2.scorecard_metric_library (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name text not null,
  description text,
  default_instruction text not null,
  rubric jsonb not null,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_scorecard_metric_library_key unique (key),
  constraint chk_scorecard_metric_library_key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint chk_scorecard_metric_library_name check (char_length(name) between 1 and 100),
  constraint chk_scorecard_metric_library_description check (description is null or char_length(description) <= 500),
  constraint chk_scorecard_metric_library_instruction check (char_length(default_instruction) between 1 and 1000),
  constraint chk_scorecard_metric_library_version check (version > 0),
  constraint chk_scorecard_metric_library_rubric check (screening_v2.is_scorecard_rubric(rubric))
);
alter table screening_v2.scorecard_metric_library enable row level security;
create index if not exists idx_scorecard_metric_library_active
  on screening_v2.scorecard_metric_library (archived_at nulls first, name);

-- ── Immutable role configuration versions ───────────────────────────────
create table if not exists screening_v2.role_scorecard_versions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references screening_v2.roles(id) on delete cascade,
  version integer not null,
  configuration_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint uq_role_scorecard_version unique (role_id, version),
  constraint chk_role_scorecard_version_positive check (version > 0),
  constraint chk_role_scorecard_configuration_hash check (configuration_hash ~ '^[a-f0-9]{64}$')
);
alter table screening_v2.role_scorecard_versions enable row level security;
create index if not exists idx_role_scorecard_versions_role on screening_v2.role_scorecard_versions(role_id, version desc);

create table if not exists screening_v2.role_scorecard_version_metrics (
  id uuid primary key default gen_random_uuid(),
  scorecard_version_id uuid not null references screening_v2.role_scorecard_versions(id) on delete cascade,
  library_metric_id uuid not null references screening_v2.scorecard_metric_library(id) on delete restrict,
  metric_key text not null,
  name text not null,
  instruction text not null,
  rubric jsonb not null,
  weight_bps integer not null,
  display_order integer not null,
  created_at timestamptz not null default now(),
  constraint uq_role_scorecard_metric_library unique (scorecard_version_id, library_metric_id),
  constraint uq_role_scorecard_metric_key unique (scorecard_version_id, metric_key),
  constraint uq_role_scorecard_metric_order unique (scorecard_version_id, display_order),
  constraint chk_role_scorecard_metric_key check (metric_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint chk_role_scorecard_metric_name check (char_length(name) between 1 and 100),
  constraint chk_role_scorecard_metric_instruction check (char_length(instruction) between 1 and 1000),
  constraint chk_role_scorecard_metric_weight check (weight_bps between 1 and 10000),
  constraint chk_role_scorecard_metric_display_order check (display_order >= 0),
  constraint chk_role_scorecard_metric_rubric check (screening_v2.is_scorecard_rubric(rubric))
);
alter table screening_v2.role_scorecard_version_metrics enable row level security;

alter table screening_v2.roles add column if not exists active_scorecard_version_id uuid;
alter table screening_v2.roles drop constraint if exists fk_roles_active_scorecard_version;
alter table screening_v2.roles add constraint fk_roles_active_scorecard_version
  foreign key (active_scorecard_version_id) references screening_v2.role_scorecard_versions(id) on delete restrict;

-- A role can point only to one of its own immutable versions.
create or replace function screening_v2.assert_role_scorecard_pointer()
returns trigger language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
begin
  if new.active_scorecard_version_id is not null and not exists (
    select 1 from screening_v2.role_scorecard_versions v
    where v.id = new.active_scorecard_version_id and v.role_id = new.id
  ) then
    raise exception 'active scorecard version must belong to the role' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_roles_active_scorecard_pointer on screening_v2.roles;
create trigger trg_roles_active_scorecard_pointer
  before insert or update of active_scorecard_version_id on screening_v2.roles
  for each row execute function screening_v2.assert_role_scorecard_pointer();

-- Metric rows are immutable once committed. New role versions are created instead.
create or replace function screening_v2.prevent_scorecard_version_mutation()
returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
begin
  raise exception 'scorecard configuration versions are immutable' using errcode = '55000';
end;
$$;
drop trigger if exists trg_prevent_role_scorecard_versions_mutation on screening_v2.role_scorecard_versions;
create trigger trg_prevent_role_scorecard_versions_mutation
  before update or delete on screening_v2.role_scorecard_versions
  for each row execute function screening_v2.prevent_scorecard_version_mutation();
drop trigger if exists trg_prevent_role_scorecard_metrics_mutation on screening_v2.role_scorecard_version_metrics;
create trigger trg_prevent_role_scorecard_metrics_mutation
  before update or delete on screening_v2.role_scorecard_version_metrics
  for each row execute function screening_v2.prevent_scorecard_version_mutation();

-- The total is checked at transaction end so an atomic complete configuration
-- can be inserted as a set, but never commits with any other total.
create or replace function screening_v2.assert_role_scorecard_weights()
returns trigger language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_version_id uuid := coalesce(new.scorecard_version_id, old.scorecard_version_id);
declare v_count integer; v_total integer;
begin
  select count(*), coalesce(sum(weight_bps), 0) into v_count, v_total
  from screening_v2.role_scorecard_version_metrics where scorecard_version_id = v_version_id;
  if v_count < 1 or v_count > 20 or v_total <> 10000 then
    raise exception 'scorecard version % must contain 1..20 metrics totaling exactly 10000 bps (got count %, total %)', v_version_id, v_count, v_total
      using errcode = '23514';
  end if;
  return null;
end;
$$;
drop trigger if exists trg_role_scorecard_exact_weights on screening_v2.role_scorecard_version_metrics;
create constraint trigger trg_role_scorecard_exact_weights
  after insert or update or delete on screening_v2.role_scorecard_version_metrics
  deferrable initially deferred for each row execute function screening_v2.assert_role_scorecard_weights();

-- ── Assessment v2 metadata/results ─────────────────────────────────────
alter table screening_v2.assessments
  add column if not exists schema_version integer not null default 1,
  add column if not exists revision integer not null default 1,
  add column if not exists scorecard_version_id uuid references screening_v2.role_scorecard_versions(id) on delete set null,
  add column if not exists metric_results jsonb,
  add column if not exists weighted_score_5 numeric(5,4),
  add column if not exists scoring_status text not null default 'complete',
  add column if not exists supersedes_assessment_id uuid references screening_v2.assessments(id) on delete restrict,
  add column if not exists rescore_request_id uuid;

alter table screening_v2.assessments drop constraint if exists chk_assessments_schema_version;
alter table screening_v2.assessments add constraint chk_assessments_schema_version check (schema_version in (1,2));
alter table screening_v2.assessments drop constraint if exists chk_assessments_revision;
alter table screening_v2.assessments add constraint chk_assessments_revision check (revision >= 1);
alter table screening_v2.assessments drop constraint if exists chk_assessments_weighted_score_5;
alter table screening_v2.assessments add constraint chk_assessments_weighted_score_5 check (weighted_score_5 is null or weighted_score_5 between 1 and 5);
alter table screening_v2.assessments drop constraint if exists chk_assessments_scoring_status;
alter table screening_v2.assessments add constraint chk_assessments_scoring_status check (scoring_status in ('complete','incomplete_evidence'));
alter table screening_v2.assessments drop constraint if exists chk_assessments_v2_shape;
alter table screening_v2.assessments add constraint chk_assessments_v2_shape check (
  (schema_version = 1 and scorecard_version_id is null and metric_results is null and weighted_score_5 is null)
  or (schema_version = 2 and metric_results is not null
      and jsonb_typeof(metric_results) = 'array'
      and ((scoring_status = 'complete' and weighted_score_5 is not null) or (scoring_status = 'incomplete_evidence' and weighted_score_5 is null)))
);

-- SCORECARD-INDEX-NARROW SANCTION: preserve the initial phone uniqueness
-- guarantee while deliberately removing only later revisions from the legacy
-- index's coverage. The same migration immediately recreates it with its
-- narrowed `revision = 1` predicate; it cannot admit duplicate initial calls.
drop index if exists screening_v2.uq_assessments_phone_session;
create unique index if not exists uq_assessments_phone_initial_revision
  on screening_v2.assessments(session_id) where source = 'phone' and revision = 1;
create unique index if not exists uq_assessments_v2_session_revision
  on screening_v2.assessments(session_id, revision) where schema_version = 2;
create unique index if not exists uq_assessments_rescore_request
  on screening_v2.assessments(rescore_request_id) where rescore_request_id is not null;
create index if not exists idx_assessments_scorecard_version on screening_v2.assessments(scorecard_version_id);

-- New tables are server-only; they must remain in the global RLS posture.
revoke all on screening_v2.scorecard_metric_library, screening_v2.role_scorecard_versions,
  screening_v2.role_scorecard_version_metrics from anon, authenticated;
grant all privileges on screening_v2.scorecard_metric_library, screening_v2.role_scorecard_versions,
  screening_v2.role_scorecard_version_metrics to service_role;
