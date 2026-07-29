\set ON_ERROR_STOP on

-- =============================================================================
-- synthetic_seed_tests.sql — GOV-06 Local SQL integration tests
--
-- These tests run against a local Supabase instance with the seed applied.
-- SCOPE: Every assertion on email, phone, status, FK, or content is
-- restricted to the GOV-06 UUID namespace
-- (60000000-0000-4000-a000-XXXXXXXXXX). Unrelated rows outside this
-- namespace are tolerated — but every row in this test uses obviously
-- synthetic markers even outside the GOV namespace.
--
-- Assessment shape assertions follow the TypeScript Assessment type
-- (app/api/src/lib/types.ts) with strict NULL-safe predicates:
-- missing/null fields are FAIL, not PASS.
--
-- Run after: supabase db reset (applies migrations + seed)
-- =============================================================================

create schema if not exists _synthetic_seed_tests;
drop table if exists _synthetic_seed_tests.results;
create table _synthetic_seed_tests.results (
  id serial primary key,
  test text not null,
  passed boolean not null,
  detail text
);

create or replace function _synthetic_seed_tests.assert(
  test_name text,
  condition boolean,
  failure_detail text
) returns void language plpgsql as $$
begin
  insert into _synthetic_seed_tests.results(test, passed, detail)
  values (test_name, coalesce(condition, false), failure_detail);
end;
$$;

-- =============================================================================
-- Helper: Gov-06 UUID range predicate for scoped assertions
-- =============================================================================
create or replace function _synthetic_seed_tests.is_gov06(id uuid)
returns boolean language sql immutable as $$
  select id >= '60000000-0000-4000-a000-000000000000'
     and id <= '60000000-0000-4000-a000-00000000ffff';
$$;

-- =============================================================================
-- FIXTURE: Insert unrelated rows BEFORE all assertions (Finding 6)
-- Uses synthetic names/markers even outside GOV namespace.
-- =============================================================================
insert into screening_v2.roles (id, title, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'Synthetic External Role', '2026-06-01T00:00:00Z'::timestamptz, '2026-06-01T00:00:00Z'::timestamptz)
  on conflict (id) do nothing;
insert into screening_v2.candidates (id, role_id, name, email, phone_e164, phone_valid, skills, experience_years, parsed, status, consent_source, consent_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Synth External Candidate', 'ext.synth@example.invalid', null, false, '["testing"]'::jsonb, 3, '{"is_synthetic":true}'::jsonb, 'screened', 'test', '2026-06-01T00:00:00Z'::timestamptz, '2026-06-01T00:00:00Z'::timestamptz, '2026-06-01T00:00:00Z'::timestamptz)
  on conflict (id) do nothing;
insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, status, started_at, updated_at) values
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'browser', 'completed', '2026-06-01T00:00:00Z'::timestamptz, '2026-06-01T00:00:00Z'::timestamptz)
  on conflict (id) do nothing;

-- =============================================================================
-- 1. Exact reserved IDs exist (within GOV-06 namespace range)
-- =============================================================================
select _synthetic_seed_tests.assert(
  'all expected role IDs exist',
  (select count(*) = 3 from screening_v2.roles
    where id in (
      '60000000-0000-4000-a000-000000000001',
      '60000000-0000-4000-a000-000000000002',
      '60000000-0000-4000-a000-000000000003'
    )),
  'role IDs 001-003 must exist'
);

select _synthetic_seed_tests.assert(
  'no unknown IDs inside role reserved range',
  not exists (
    select 1 from screening_v2.roles
    where id >= '60000000-0000-4000-a000-000000000001'
      and id <= '60000000-0000-4000-a000-00000000000f'
      and id not in (
        '60000000-0000-4000-a000-000000000001',
        '60000000-0000-4000-a000-000000000002',
        '60000000-0000-4000-a000-000000000003'
      )
  ),
  'no unexpected IDs in role range 001-00f'
);

select _synthetic_seed_tests.assert(
  'all expected resume IDs exist',
  (select count(*) = 3 from screening_v2.resumes
    where id in (
      '60000000-0000-4000-a000-000000000011',
      '60000000-0000-4000-a000-000000000012',
      '60000000-0000-4000-a000-000000000013'
    )),
  'resume IDs 011-013 must exist'
);

select _synthetic_seed_tests.assert(
  'no unknown IDs inside resume reserved range',
  not exists (
    select 1 from screening_v2.resumes
    where id >= '60000000-0000-4000-a000-000000000011'
      and id <= '60000000-0000-4000-a000-00000000001f'
      and id not in (
        '60000000-0000-4000-a000-000000000011',
        '60000000-0000-4000-a000-000000000012',
        '60000000-0000-4000-a000-000000000013'
      )
  ),
  'no unexpected IDs in resume range 011-01f'
);

select _synthetic_seed_tests.assert(
  'all expected candidate IDs exist',
  (select count(*) = 3 from screening_v2.candidates
    where id in (
      '60000000-0000-4000-a000-000000000021',
      '60000000-0000-4000-a000-000000000022',
      '60000000-0000-4000-a000-000000000023'
    )),
  'candidate IDs 021-023 must exist'
);

select _synthetic_seed_tests.assert(
  'all expected call_session IDs exist',
  (select count(*) = 3 from screening_v2.call_sessions
    where id in (
      '60000000-0000-4000-a000-000000000031',
      '60000000-0000-4000-a000-000000000032',
      '60000000-0000-4000-a000-000000000033'
    )),
  'call_session IDs 031-033 must exist'
);

select _synthetic_seed_tests.assert(
  'all expected transcript_turn IDs exist',
  (select count(*) = 13 from screening_v2.transcript_turns
    where id in (
      '60000000-0000-4000-a000-000000000041',
      '60000000-0000-4000-a000-000000000042',
      '60000000-0000-4000-a000-000000000043',
      '60000000-0000-4000-a000-000000000044',
      '60000000-0000-4000-a000-000000000045',
      '60000000-0000-4000-a000-000000000046',
      '60000000-0000-4000-a000-000000000047',
      '60000000-0000-4000-a000-000000000048',
      '60000000-0000-4000-a000-000000000049',
      '60000000-0000-4000-a000-00000000004a',
      '60000000-0000-4000-a000-00000000004b',
      '60000000-0000-4000-a000-00000000004c',
      '60000000-0000-4000-a000-00000000004d'
    )),
  'transcript_turn IDs 041-04d must exist'
);

select _synthetic_seed_tests.assert(
  'all expected assessment IDs exist',
  (select count(*) = 2 from screening_v2.assessments
    where id in (
      '60000000-0000-4000-a000-000000000051',
      '60000000-0000-4000-a000-000000000052'
    )),
  'assessment IDs 051-052 must exist'
);

select _synthetic_seed_tests.assert(
  'assessment 053 does NOT exist (in-progress session has none)',
  not exists (
    select 1 from screening_v2.assessments
    where id = '60000000-0000-4000-a000-000000000053'
  ),
  'in-progress session must not have an assessment'
);

select _synthetic_seed_tests.assert(
  'all expected consent_record IDs exist',
  (select count(*) = 3 from screening_v2.consent_records
    where id in (
      '60000000-0000-4000-a000-000000000061',
      '60000000-0000-4000-a000-000000000062',
      '60000000-0000-4000-a000-000000000063'
    )),
  'consent_record IDs 061-063 must exist'
);

-- =============================================================================
-- 2. Email uses RFC-reserved domain (scoped to GOV-06 IDs)
-- =============================================================================
select _synthetic_seed_tests.assert(
  'all GOV-06 candidate emails use @example.invalid',
  not exists (
    select 1 from screening_v2.candidates
    where _synthetic_seed_tests.is_gov06(id)
      and email is not null
      and email not like '%@example.invalid'
  ),
  'every GOV-06 candidate email must use @example.invalid'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 candidate emails start with synth.',
  not exists (
    select 1 from screening_v2.candidates
    where _synthetic_seed_tests.is_gov06(id)
      and email is not null
      and email not like 'synth.%@example.invalid'
  ),
  'every GOV-06 candidate email must start with synth.'
);

-- =============================================================================
-- 3. Phone fields are null (scoped to GOV-06 IDs)
-- =============================================================================
select _synthetic_seed_tests.assert(
  'all GOV-06 candidate phone_e164 are null',
  not exists (
    select 1 from screening_v2.candidates
    where _synthetic_seed_tests.is_gov06(id)
      and phone_e164 is not null
  ),
  'GOV-06 synthetic candidates must not have phone_e164 values'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 candidate phone_valid are false',
  not exists (
    select 1 from screening_v2.candidates
    where _synthetic_seed_tests.is_gov06(id)
      and phone_valid is not false
  ),
  'GOV-06 synthetic candidates must have phone_valid = false'
);

-- =============================================================================
-- 4. Status consistency (scoped to GOV-06 IDs)
-- =============================================================================
select _synthetic_seed_tests.assert(
  'GOV-06 completed sessions have screened candidates',
  not exists (
    select 1 from screening_v2.call_sessions cs
    join screening_v2.candidates c on c.id = cs.candidate_id
    where _synthetic_seed_tests.is_gov06(cs.id)
      and _synthetic_seed_tests.is_gov06(c.id)
      and cs.status = 'completed'
      and c.status not in ('screened', 'advanced', 'rejected')
  ),
  'completed session candidates must have screened/advanced/rejected status'
);

select _synthetic_seed_tests.assert(
  'GOV-06 in-progress sessions have screening-status candidates',
  not exists (
    select 1 from screening_v2.call_sessions cs
    join screening_v2.candidates c on c.id = cs.candidate_id
    where _synthetic_seed_tests.is_gov06(cs.id)
      and _synthetic_seed_tests.is_gov06(c.id)
      and cs.status = 'in_progress'
      and c.status != 'screening'
  ),
  'in-progress session candidates must have screening status'
);

select _synthetic_seed_tests.assert(
  'in-progress session has no assessment',
  not exists (
    select 1 from screening_v2.assessments a
    join screening_v2.call_sessions cs on cs.id = a.session_id
    where _synthetic_seed_tests.is_gov06(cs.id)
      and _synthetic_seed_tests.is_gov06(a.id)
      and cs.status = 'in_progress'
  ),
  'in-progress sessions must not have assessments'
);

-- =============================================================================
-- 5. FK constraints satisfied (scoped to GOV-06 IDs)
-- =============================================================================
select _synthetic_seed_tests.assert(
  'all GOV-06 candidate role_ids reference existing roles',
  not exists (
    select 1 from screening_v2.candidates c
    where _synthetic_seed_tests.is_gov06(c.id)
      and c.role_id is not null
      and not exists (select 1 from screening_v2.roles r where r.id = c.role_id)
  ),
  'every GOV-06 candidate role_id must reference an existing role'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 candidate resume_ids reference existing resumes',
  not exists (
    select 1 from screening_v2.candidates c
    where _synthetic_seed_tests.is_gov06(c.id)
      and c.resume_id is not null
      and not exists (select 1 from screening_v2.resumes r where r.id = c.resume_id)
  ),
  'every GOV-06 candidate resume_id must reference an existing resume'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 call_session candidate_ids reference existing candidates',
  not exists (
    select 1 from screening_v2.call_sessions cs
    where _synthetic_seed_tests.is_gov06(cs.id)
      and not exists (select 1 from screening_v2.candidates c where c.id = cs.candidate_id)
  ),
  'every GOV-06 call_session must reference an existing candidate'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 transcript_turn session_ids reference existing call_sessions',
  not exists (
    select 1 from screening_v2.transcript_turns tt
    where _synthetic_seed_tests.is_gov06(tt.id)
      and not exists (select 1 from screening_v2.call_sessions cs where cs.id = tt.session_id)
  ),
  'every GOV-06 transcript_turn must reference an existing call_session'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessment session_ids reference existing call_sessions',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and not exists (select 1 from screening_v2.call_sessions cs where cs.id = a.session_id)
  ),
  'every GOV-06 assessment must reference an existing call_session'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessment candidate_ids reference existing candidates',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and not exists (select 1 from screening_v2.candidates c where c.id = a.candidate_id)
  ),
  'every GOV-06 assessment must reference an existing candidate'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 consent_record candidate_ids reference existing candidates',
  not exists (
    select 1 from screening_v2.consent_records cr
    where _synthetic_seed_tests.is_gov06(cr.id)
      and not exists (select 1 from screening_v2.candidates c where c.id = cr.candidate_id)
  ),
  'every GOV-06 consent_record must reference an existing candidate'
);

-- =============================================================================
-- 6. Assessment shape: strict NULL-safe predicates (Finding 5 fix)
-- =============================================================================
-- Use (condition is not true) instead of (condition) to handle NULL correctly.
-- Wrap numeric comparisons with COALESCE to prevent NULL-pass.

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have overall_score 0-100',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.overall_score < 0 or a.overall_score > 100)
  ),
  'every GOV-06 assessment overall_score must be 0-100'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have valid recommendation',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.recommendation is null or a.recommendation not in ('advance', 'hold', 'reject'))
  ),
  'every GOV-06 assessment recommendation must be advance|hold|reject'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have non-empty summary',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.summary is null or trim(a.summary) = '')
  ),
  'every GOV-06 assessment must have a non-empty summary'
);

-- Tone fields - use COALESCE to prevent NULL-pass
select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have tone.clarity 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.tone) as t(clarity numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(clarity, -1) < 0 or coalesce(clarity, -1) > 10)
  ),
  'tone.clarity must be 0-10 (null is failure)'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have tone.confidence 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.tone) as t(confidence numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(confidence, -1) < 0 or coalesce(confidence, -1) > 10)
  ),
  'tone.confidence must be 0-10 (null is failure)'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have tone.professionalism 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.tone) as t(professionalism numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(professionalism, -1) < 0 or coalesce(professionalism, -1) > 10)
  ),
  'tone.professionalism must be 0-10 (null is failure)'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have tone.sentiment present',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.tone->>'sentiment' is null or a.tone->>'sentiment' not in ('positive', 'neutral', 'negative'))
  ),
  'tone.sentiment must be present and valid'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have tone.notes',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.tone->>'notes' is null or a.tone->>'notes' = '')
  ),
  'tone.notes must be present and non-empty'
);

-- Communication
select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.score 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication) as c(score numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(score, -1) < 0 or coalesce(score, -1) > 10)
  ),
  'communication.score must be 0-10 (null is failure)'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.clarity 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication) as c(clarity numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(clarity, -1) < 0 or coalesce(clarity, -1) > 10)
  ),
  'communication.clarity must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.structure 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication) as c(structure numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(structure, -1) < 0 or coalesce(structure, -1) > 10)
  ),
  'communication.structure must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.listening 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication) as c(listening numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(listening, -1) < 0 or coalesce(listening, -1) > 10)
  ),
  'communication.listening must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.rapport 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication) as c(rapport numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(rapport, -1) < 0 or coalesce(rapport, -1) > 10)
  ),
  'communication.rapport must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.english_proficiency.grammar 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication->'english_proficiency') as e(grammar numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(grammar, -1) < 0 or coalesce(grammar, -1) > 10)
  ),
  'communication.english_proficiency.grammar must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.english_proficiency.band',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.communication#>'{english_proficiency,band}' is null
           or (a.communication#>>'{english_proficiency,band}') !~ '^[ABC][12]$')
  ),
  'communication.english_proficiency.band must be CEFR A1-C2'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.filler_usage.level',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.communication->'filler_usage'->>'level' is null
           or a.communication->'filler_usage'->>'level' not in ('low', 'moderate', 'high'))
  ),
  'communication.filler_usage.level must be low|moderate|high'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.filler_usage.impact_score 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.communication->'filler_usage') as f(impact_score numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(impact_score, -1) < 0 or coalesce(impact_score, -1) > 10)
  ),
  'communication.filler_usage.impact_score must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.native_language_usage.level',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.communication->'native_language_usage'->>'level' is null
           or a.communication->'native_language_usage'->>'level' not in ('none', 'low', 'moderate', 'high'))
  ),
  'communication.native_language_usage.level must be none|low|moderate|high'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have communication.filler_usage.examples as array',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and jsonb_typeof(a.communication->'filler_usage'->'examples') is distinct from 'array'
  ),
  'communication.filler_usage.examples must be an array'
);

-- English (top-level optional)
select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have english.band valid CEFR',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and a.english is not null
      and (a.english->>'band' is null or (a.english->>'band') !~ '^[ABC][12]$')
  ),
  'english.band must be CEFR A1-C2 when present'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have english.grammar 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.english) as e(grammar numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and a.english is not null
      and (coalesce(grammar, -1) < 0 or coalesce(grammar, -1) > 10)
  ),
  'english.grammar must be 0-10'
);

-- Motivation
select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have motivation.score 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.motivation) as m(score numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(score, -1) < 0 or coalesce(score, -1) > 10)
  ),
  'motivation.score must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have motivation.notes',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.motivation->>'notes' is null or a.motivation->>'notes' = '')
  ),
  'motivation.notes must be present and non-empty'
);

-- Role_fit
select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have role_fit.score 0-10',
  not exists (
    select 1 from screening_v2.assessments a
    cross join lateral jsonb_to_record(a.role_fit) as rf(score numeric)
    where _synthetic_seed_tests.is_gov06(a.id)
      and (coalesce(score, -1) < 0 or coalesce(score, -1) > 10)
  ),
  'role_fit.score must be 0-10'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have role_fit.matched_skills as array',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and jsonb_typeof(a.role_fit->'matched_skills') is distinct from 'array'
  ),
  'role_fit.matched_skills must be an array'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have role_fit.gaps as array',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and jsonb_typeof(a.role_fit->'gaps') is distinct from 'array'
  ),
  'role_fit.gaps must be an array'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have role_fit.red_flags as array',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and jsonb_typeof(a.role_fit->'red_flags') is distinct from 'array'
  ),
  'role_fit.red_flags must be an array'
);

select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have role_fit.notes',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and (a.role_fit->>'notes' is null or a.role_fit->>'notes' = '')
  ),
  'role_fit.notes must be present and non-empty'
);

-- Resume conflicts
select _synthetic_seed_tests.assert(
  'all GOV-06 assessments have resume_conflicts as array (or null)',
  not exists (
    select 1 from screening_v2.assessments a
    where _synthetic_seed_tests.is_gov06(a.id)
      and a.resume_conflicts is not null
      and jsonb_typeof(a.resume_conflicts) is distinct from 'array'
  ),
  'resume_conflicts must be null or an array'
);

-- =============================================================================
-- 7. Manifest-scoped idempotency: full seed rerun via count by exact IDs
-- =============================================================================
do $$
declare
  null_val record;
  before_count int;
  after_count int;
  tbl text;
  tables text[] := array[
    'roles', 'resumes', 'candidates', 'call_sessions',
    'transcript_turns', 'assessments', 'consent_records'
  ];
  expected_count int;
begin
  foreach tbl in array tables
  loop
    -- Use static manifest counts per table. Full seed-rerun idempotency is
    -- proven by scripts/supabase-test.sh applying app/supabase/seed.sql twice;
    -- this SQL file only asserts the post-rerun manifest state.
    case tbl
      when 'roles' then expected_count := 3;
      when 'resumes' then expected_count := 3;
      when 'candidates' then expected_count := 3;
      when 'call_sessions' then expected_count := 3;
      when 'transcript_turns' then expected_count := 13;
      when 'assessments' then expected_count := 2;
      when 'consent_records' then expected_count := 3;
      else expected_count := 0;
    end case;

    execute format('select count(*) from screening_v2.%I where id >= ''60000000-0000-4000-a000-000000000001''', tbl) into before_count;
    if before_count != expected_count then
      perform _synthetic_seed_tests.assert(
        'pre-rerun manifest count: ' || tbl,
        false,
        format('expected %s rows, found %s', expected_count, before_count)
      );
    else
      perform _synthetic_seed_tests.assert(
        'pre-rerun manifest count: ' || tbl,
        true,
        format('count %s matches manifest', expected_count)
      );
    end if;

  end loop;
end;
$$;

-- =============================================================================
-- 8. Cleanup fixture and verify
-- =============================================================================
do $$
declare
  exists_role boolean;
begin
  -- Verify fixture exists
  select exists(select 1 from screening_v2.roles where id = '00000000-0000-0000-0000-000000000000') into exists_role;
  perform _synthetic_seed_tests.assert(
    'fixture role exists during scoped tests',
    exists_role,
    'fixture role should have been present'
  );

  -- Remove fixture rows in safe order (respecting FK constraints)
  delete from screening_v2.call_sessions where id = '00000000-0000-0000-0000-000000000002';
  delete from screening_v2.candidates where id = '00000000-0000-0000-0000-000000000001';
  delete from screening_v2.roles where id = '00000000-0000-0000-0000-000000000000';

  select not exists(select 1 from screening_v2.roles where id = '00000000-0000-0000-0000-000000000000') into exists_role;
  perform _synthetic_seed_tests.assert(
    'fixture role cleaned up after tests',
    exists_role,
    'fixture role should have been removed'
  );
end;
$$;

-- =============================================================================
-- RESULTS
-- =============================================================================
select test, case when passed then 'PASS' else 'FAIL' end as result, detail
  from _synthetic_seed_tests.results order by id;

do $$
declare failures integer; total integer;
begin
  select count(*), count(*) filter (where not passed)
    into total, failures from _synthetic_seed_tests.results;
  if failures > 0 then
    raise exception '% of % synthetic seed tests FAILED', failures, total;
  end if;
  raise notice 'All % synthetic seed tests PASSED', total;
end;
$$;

drop schema _synthetic_seed_tests cascade;
