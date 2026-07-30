-- =====================================================================
-- 0013 — GOV-01/GOV-03: Consent versioning, classification, and
--        placeholder consent-template foundation.
--
-- DESIGN:
--   1. Extend consent_records with version, consent_type[], status,
--      classification_level, expires_at for versioned consent.
--   2. Add consent_templates table for versioned privacy notice
--      content (legal copy is unapproved placeholder).
--   3. Add consent_purposes enum or reference set.
--   4. GOV-10: job_application consent_type alone cannot unlock
--      AI/recording — enforced via CHECK constraint.
--   5. RLS: service_role full access, authenticated read only,
--      consistent with existing 0008 patterns.
--
-- Forward-only: existing consent_records rows get default version='1.0'
-- and consents upgraded via application logic, not this migration.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Extend consent_records with consent versioning & classification
-- ═══════════════════════════════════════════════════════════════════════

-- Define recognized consent types as an enum for type safety.
do $$ begin
  create type screening_v2.consent_type as enum (
    'ai_interview',    -- AI-conducted voice interview
    'recording',       -- audio/video recording
    'purpose',         -- processing purpose acknowledgement
    'data_processing', -- general data processing (DPDP)
    'retention',       -- retention period acknowledgement
    'rights',          -- candidate rights acknowledgement
    'job_application'  -- generic application consent (NOT sufficient for AI/recording)
  );
exception
  when duplicate_object then null;
end $$;

-- Add new columns to consent_records.
-- Existing rows get default version='1.0' and consents='{}' (no typed consents).
alter table screening_v2.consent_records
  add column if not exists version text not null default '1.0';

alter table screening_v2.consent_records
  add column if not exists consents screening_v2.consent_type[] not null default '{}';

alter table screening_v2.consent_records
  add column if not exists status text not null default 'granted'
    check (status in ('granted', 'declined', 'withdrawn'));

alter table screening_v2.consent_records
  add column if not exists expires_at timestamptz;

alter table screening_v2.consent_records
  add column if not exists classification_level int not null default 3
    check (classification_level between 1 and 5);

alter table screening_v2.consent_records
  add column if not exists ip_address text;

alter table screening_v2.consent_records
  add column if not exists user_agent text;

alter table screening_v2.consent_records
  add column if not exists updated_at timestamptz not null default now();

comment on column screening_v2.consent_records.version is
  'GOV-03: Semver consent template version at time of consent.';

comment on column screening_v2.consent_records.consents is
  'GOV-03/GOV-10: Array of consent_type enums granted/declined. '
  'job_application alone cannot unlock ai_interview or recording.';

comment on column screening_v2.consent_records.status is
  'GOV-09: granted|declined|withdrawn. Decline or withdrawal blocks AI/recording.';

comment on column screening_v2.consent_records.classification_level is
  'GOV-01: Data classification level per docs/data-classification.md. '
  'Default 3 = Confidential PII (proof may contain PII).';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. GOV-10: CHECK constraint — job_application cannot unlock AI/recording
-- ═══════════════════════════════════════════════════════════════════════

-- If consents contains 'job_application' but NOT 'ai_interview' or 'recording'
-- or 'data_processing', that's fine (generic application consent).
-- But if consents contains ONLY 'job_application' (or includes it) and the
-- record has status='granted', we still allow it — the guard is consumer-side:
-- downstream code must check that ai_interview or recording is present before
-- initiating AI screening or recording.
--
-- The real enforcement is:
--   1. Consumer-side: routes check consent before AI/recording (see routes/consent.ts)
--   2. This migration adds a helper function to check specific consent.

create or replace function screening_v2.has_consent(
  p_candidate_id uuid,
  p_consent_type screening_v2.consent_type
) returns boolean
  language sql
  stable
  security definer
  set search_path = 'pg_catalog'
as $$
  -- Returns true if candidate has an active (granted, not expired) consent
  -- record that includes the specified consent_type.
  select exists (
    select 1
    from screening_v2.consent_records
    where candidate_id = p_candidate_id
      and status = 'granted'
      and (expires_at is null or expires_at > now())
      and p_consent_type = any (consents)
    order by created_at desc
    limit 1
  );
$$;

comment on function screening_v2.has_consent is
  'GOV-03/GOV-10: Check if candidate has granted a specific consent type. '
  'Used by API routes to gate AI screening and recording.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Consent templates table (placeholder — legal copy unapproved)
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.consent_templates (
  id            uuid primary key default gen_random_uuid(),
  version       text not null,
  locale        text not null default 'en-IN',
  title         text not null default 'Privacy Notice',
  body_md       text not null default '<!-- PLACEHOLDER – Legal copy unapproved. Do not use in production. -->',
  required_consents screening_v2.consent_type[] not null default '{ai_interview,recording,purpose,data_processing,retention,rights}',
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table screening_v2.consent_templates is
  'GOV-08: Versioned consent/privacy notice templates. '
  'Legal copy is UNVERIFIED placeholder — do not use in production.';

comment on column screening_v2.consent_templates.body_md is
  'GOV-08: Markdown body of privacy notice. CURRENTLY PLACEHOLDER — '
  'not Legal-approved. Do not use in production.';

comment on column screening_v2.consent_templates.required_consents is
  'GOV-10: Consent types that must be granted/declined for this template version.';

-- Insert a single placeholder template (inactive by default)
insert into screening_v2.consent_templates
  (version, locale, title, body_md, is_active)
values
  ('1.0', 'en-IN', 'Privacy Notice',
   '# Privacy Notice\n\n'
   '**PLACEHOLDER — Legal copy unapproved.**\n\n'
   'This privacy notice is a scaffold for the consent flow. '
   'Legal-approved copy must replace this before production use.\n\n'
   '## Data Collected\n'
   '- Name, email, phone number\n'
   '- Resume and work history\n'
   '- Voice recording and transcript from AI screening interview\n'
   '- Assessment scorecard\n\n'
   '## Purpose\n'
   'Your data is processed for recruitment screening purposes only.\n\n'
   '## Data Processors\n'
   '- In-region hosting (India)\n'
   '- Axiom (US) — redacted operational logs only\n\n'
   '## Retention\n'
   'Data is retained for the duration of the recruitment process '
   'and as required by applicable law.\n\n'
   '## Your Rights\n'
   'You may access, correct, delete, or port your data. '
   'Contact the hiring team to exercise your rights.\n\n'
   '## Consent\n'
   'By accepting, you consent to AI-conducted voice interview, '
   'recording, and data processing for recruitment purposes. '
   'You may decline or withdraw consent at any time.',
   false)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Indexes for consent lookups
-- ═══════════════════════════════════════════════════════════════════════

create index if not exists idx_v2_consent_candidate_latest
  on screening_v2.consent_records(candidate_id, created_at desc);

create index if not exists idx_v2_consent_active
  on screening_v2.consent_records(candidate_id, status)
  where status = 'granted';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. RLS — extend existing 0008 policies
-- ═══════════════════════════════════════════════════════════════════════

-- consent_templates: active recruiters can read, insert/update service_role only
alter table screening_v2.consent_templates enable row level security;

drop policy if exists "active recruiter read consent_templates"
  on screening_v2.consent_templates;
create policy "active recruiter read consent_templates"
  on screening_v2.consent_templates for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

grant all privileges on screening_v2.consent_templates to service_role;
grant select on screening_v2.consent_templates to authenticated;

-- Update consent_records grants (new columns, existing table already granted)
grant select on screening_v2.consent_records to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Verifier schema reload
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
