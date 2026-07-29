-- =============================================================================
-- GOV-06: Deterministic synthetic demo seed for local Supabase rehearsal
--
-- synthetic_dataset_version=gov-06-synthetic-v1
--
-- SAFETY GUARDS:
--   • All rows use the reserved GOV-06 UUID namespace
--     (60000000-0000-4000-a000-XXXXXXXXXX) — never real data.
--   • Every INSERT has ON CONFLICT DO NOTHING — idempotent, never
--     overwrites or duplicates.
--   • No DELETE, TRUNCATE, or UPDATE anywhere in this file.
--   • All identities use the RFC-reserved @example.invalid domain
--     (phone fields are null — no phone numbers in seed).
--   • All names, companies, and text are obviously fictional and
--     marked with "Synthetic Demo" prefixes.
--   • No real candidate data, company names, personal addresses,
--     production identifiers, audio files, or URLs.
--   • No data is written to storage buckets (resumes_v2 / recordings_v2).
--   • Call queue, SMS follow-ups, and ATS sync log are intentionally
--     NOT seeded (those trigger telephony or external integrations).
--   • All timestamps are fixed UTC (2026-01-15) — no now()/CURRENT_TIMESTAMP.
--     Explicit created_at and updated_at (where the column exists) provided
--     for every seeded row.
--   • Assessment JSON follows the TypeScript Assessment type shape
--     (app/api/src/lib/types.ts): sub-scores 0–10, overall_score 0–100.
--     The communication, motivation, and resume_conflicts sub-objects are
--     populated both in their canonical JSONB columns and mirrored in raw.
--
-- KNOWN SCHEMA GAPS (no migration yet):
--   • call_sessions has no `created_at` column — use `updated_at` for ordering.
--
-- IDEMPOTENCY: Running this file multiple times produces exactly one
-- stable dataset. No duplicate rows, no FK violations, no side effects
-- outside the reserved namespace.
--
-- APPLY: Only via local Supabase config (db.seed.sql_paths) or
-- docker exec psql against an ephemeral local stack. Never production.
-- =============================================================================

-- =============================================================================
-- 1. ROLES (job openings)
-- =============================================================================
insert into screening_v2.roles (id, title, jd, required_skills, screening_template, is_active, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000001',
  'Synthetic Demo Test Engineer',
  'Synthetic demo position for local rehearsal only. Evaluates collaborative problem-solving and communication. Not a real job opening.',
  '["Python", "testing", "communication"]'::jsonb,
  '[{"id":"q1","question":"Describe how you would test a login flow.","weight":0.5,"follow_up_hint":"edge cases"},{"id":"q2","question":"How do you prioritize test cases?","weight":0.3,"follow_up_hint":"frameworks"},{"id":"q3","question":"Describe a bug you found that others missed.","weight":0.2,"follow_up_hint":"impact"}]'::jsonb,
  true,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.roles (id, title, jd, required_skills, screening_template, is_active, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000002',
  'Synthetic Demo Data Scientist',
  'Synthetic demo position for local rehearsal only. Evaluates analytical reasoning and model understanding.',
  '["Python", "statistics", "machine learning"]'::jsonb,
  '[{"id":"q1","question":"Explain how you validate a predictive model.","weight":0.4,"follow_up_hint":"overfitting"},{"id":"q2","question":"How would you design an A/B test?","weight":0.4,"follow_up_hint":"sample size"},{"id":"q3","question":"Describe a data pipeline you built.","weight":0.2,"follow_up_hint":"orchestration"}]'::jsonb,
  true,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.roles (id, title, jd, required_skills, screening_template, is_active, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000003',
  'Synthetic Demo UX Designer',
  'Synthetic demo position for local rehearsal only. Evaluates design thinking and user research.',
  '["Figma", "user research", "prototyping"]'::jsonb,
  '[{"id":"q1","question":"Walk me through your design process for a new feature.","weight":0.4,"follow_up_hint":"stakeholders"},{"id":"q2","question":"How do you validate design decisions?","weight":0.3,"follow_up_hint":"usability testing"},{"id":"q3","question":"Describe a time you simplified a complex flow.","weight":0.3,"follow_up_hint":"metrics"}]'::jsonb,
  true,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:00:00Z'::timestamptz
) on conflict (id) do nothing;

-- =============================================================================
-- 2. RESUMES (synthetic text only — no file storage)
-- =============================================================================
insert into screening_v2.resumes (id, file_path, file_name, mime_type, text_extracted, parsed, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000011',
  null,
  'synth_demo_test_engineer_resume.pdf',
  'application/pdf',
  'SYNTHETIC DEMO RESUME — Test Engineer. Years of experience: 4. Skills: Python, Selenium, pytest. Education: BS Computer Science, Synthetic Demo University. Previous role: QA Analyst at Demo Corp (fictional).',
  '{"skills":["Python","Selenium","pytest"],"years_experience":4,"education":[{"degree":"BS Computer Science","institution":"Synthetic Demo University"}],"previous_roles":[{"title":"QA Analyst","company":"Demo Corp"}],"is_synthetic":true}'::jsonb,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.resumes (id, file_path, file_name, mime_type, text_extracted, parsed, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000012',
  null,
  'synth_demo_data_scientist_resume.pdf',
  'application/pdf',
  'SYNTHETIC DEMO RESUME — Data Scientist. Years of experience: 6. Skills: Python, TensorFlow, SQL, Spark. Education: MS Statistics, Synthetic Demo University. Previous role: ML Engineer at Fictional Labs Inc.',
  '{"skills":["Python","TensorFlow","SQL","Spark"],"years_experience":6,"education":[{"degree":"MS Statistics","institution":"Synthetic Demo University"}],"previous_roles":[{"title":"ML Engineer","company":"Fictional Labs Inc"}],"is_synthetic":true}'::jsonb,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.resumes (id, file_path, file_name, mime_type, text_extracted, parsed, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000013',
  null,
  'synth_demo_ux_designer_resume.pdf',
  'application/pdf',
  'SYNTHETIC DEMO RESUME — UX Designer. Years of experience: 5. Skills: Figma, Sketch, user research, prototyping. Education: BFA Interaction Design, Synthetic Demo University. Previous role: Product Designer at Mock Company Ltd.',
  '{"skills":["Figma","Sketch","user research","prototyping"],"years_experience":5,"education":[{"degree":"BFA Interaction Design","institution":"Synthetic Demo University"}],"previous_roles":[{"title":"Product Designer","company":"Mock Company Ltd"}],"is_synthetic":true}'::jsonb,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:00:00Z'::timestamptz
) on conflict (id) do nothing;

-- =============================================================================
-- 3. CANDIDATES
-- =============================================================================
insert into screening_v2.candidates (id, role_id, resume_id, name, email, phone_raw, phone_e164, phone_valid, skills, experience_years, parsed, status, consent_source, consent_at, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000021',
  '60000000-0000-4000-a000-000000000001',
  '60000000-0000-4000-a000-000000000011',
  'Synth Demo Candidate Alpha',
  'synth.test.alpha@example.invalid',
  null,
  null,
  false,
  '["Python", "pytest", "Selenium"]'::jsonb,
  4,
  '{"alias":"alpha","is_synthetic":true,"source":"gov-06-seed"}'::jsonb,
  'screened',
  'demo_seed',
  '2026-01-15T12:00:00Z'::timestamptz,
  '2026-01-15T12:00:00Z'::timestamptz,
  '2026-01-15T12:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.candidates (id, role_id, resume_id, name, email, phone_raw, phone_e164, phone_valid, skills, experience_years, parsed, status, consent_source, consent_at, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000022',
  '60000000-0000-4000-a000-000000000002',
  '60000000-0000-4000-a000-000000000012',
  'Synth Demo Candidate Beta',
  'synth.test.beta@example.invalid',
  null,
  null,
  false,
  '["Python", "TensorFlow", "SQL"]'::jsonb,
  6,
  '{"alias":"beta","is_synthetic":true,"source":"gov-06-seed"}'::jsonb,
  'screened',
  'demo_seed',
  '2026-01-15T12:00:00Z'::timestamptz,
  '2026-01-15T12:00:00Z'::timestamptz,
  '2026-01-15T12:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.candidates (id, role_id, resume_id, name, email, phone_raw, phone_e164, phone_valid, skills, experience_years, parsed, status, consent_source, consent_at, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000023',
  '60000000-0000-4000-a000-000000000003',
  '60000000-0000-4000-a000-000000000013',
  'Synth Demo Candidate Gamma',
  'synth.test.gamma@example.invalid',
  null,
  null,
  false,
  '["Figma", "user research", "prototyping"]'::jsonb,
  5,
  '{"alias":"gamma","is_synthetic":true,"source":"gov-06-seed"}'::jsonb,
  'screening',
  'demo_seed',
  '2026-01-15T12:00:00Z'::timestamptz,
  '2026-01-15T12:00:00Z'::timestamptz,
  '2026-01-15T12:00:00Z'::timestamptz
) on conflict (id) do nothing;

-- =============================================================================
-- 4. CALL SESSIONS (browser mode only — no telephony)
-- =============================================================================
insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, status, current_question_index, started_at, ended_at, duration_sec, updated_at) values
(
  '60000000-0000-4000-a000-000000000031',
  '60000000-0000-4000-a000-000000000021',
  '60000000-0000-4000-a000-000000000001',
  'browser',
  'pipecat',
  'completed',
  3,
  '2026-01-15T10:00:00Z'::timestamptz,
  '2026-01-15T10:15:00Z'::timestamptz,
  900,
  '2026-01-15T10:15:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, status, current_question_index, started_at, ended_at, duration_sec, updated_at) values
(
  '60000000-0000-4000-a000-000000000032',
  '60000000-0000-4000-a000-000000000022',
  '60000000-0000-4000-a000-000000000002',
  'browser',
  'pipecat',
  'completed',
  3,
  '2026-01-15T11:00:00Z'::timestamptz,
  '2026-01-15T11:15:00Z'::timestamptz,
  900,
  '2026-01-15T11:15:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, status, current_question_index, started_at, ended_at, duration_sec, updated_at) values
(
  '60000000-0000-4000-a000-000000000033',
  '60000000-0000-4000-a000-000000000023',
  '60000000-0000-4000-a000-000000000003',
  'browser',
  'pipecat',
  'in_progress',
  1,
  '2026-01-15T11:45:00Z'::timestamptz,
  null,
  null,
  '2026-01-15T11:45:00Z'::timestamptz
) on conflict (id) do nothing;

-- =============================================================================
-- 5. TRANSCRIPT TURNS (fictional, neutral demo text)
-- =============================================================================
insert into screening_v2.transcript_turns (id, session_id, turn_index, speaker, text, created_at) values
('60000000-0000-4000-a000-000000000041', '60000000-0000-4000-a000-000000000031', 0, 'bot',   'Welcome to the synthetic demo screening session. I will ask you a few questions about your experience.', '2026-01-15T10:00:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000042', '60000000-0000-4000-a000-000000000031', 1, 'candidate', 'Thank you. I am ready to discuss my experience in software testing.', '2026-01-15T10:01:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000043', '60000000-0000-4000-a000-000000000031', 2, 'bot',   'Please describe how you would test a login flow.', '2026-01-15T10:02:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000044', '60000000-0000-4000-a000-000000000031', 3, 'candidate', 'I would start with unit tests for the authentication logic, then integration tests for the API endpoints, and finally end-to-end tests covering the complete login flow including error states.', '2026-01-15T10:03:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000045', '60000000-0000-4000-a000-000000000031', 4, 'bot',   'Thank you. That covers the key testing layers.', '2026-01-15T10:04:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000046', '60000000-0000-4000-a000-000000000032', 0, 'bot',   'Welcome to the synthetic demo screening session. I will ask you about data science.', '2026-01-15T11:00:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000047', '60000000-0000-4000-a000-000000000032', 1, 'candidate', 'Thank you. I have prepared examples of my work with predictive models.', '2026-01-15T11:01:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000048', '60000000-0000-4000-a000-000000000032', 2, 'bot',   'Please explain how you validate a predictive model.', '2026-01-15T11:02:00Z'::timestamptz),
('60000000-0000-4000-a000-000000000049', '60000000-0000-4000-a000-000000000032', 3, 'candidate', 'I use cross-validation with stratified folds, monitor precision and recall, and check for overfitting by comparing training and validation performance.', '2026-01-15T11:03:00Z'::timestamptz),
('60000000-0000-4000-a000-00000000004a', '60000000-0000-4000-a000-000000000032', 4, 'bot',   'Good. How would you design an A/B test?', '2026-01-15T11:04:00Z'::timestamptz),
('60000000-0000-4000-a000-00000000004b', '60000000-0000-4000-a000-000000000032', 5, 'candidate', 'I would define the null hypothesis, calculate the required sample size using power analysis, randomize users into control and treatment groups, and analyze results with a t-test or chi-squared test.', '2026-01-15T11:05:00Z'::timestamptz),
('60000000-0000-4000-a000-00000000004c', '60000000-0000-4000-a000-000000000033', 0, 'bot',   'Welcome to the synthetic demo screening session. I will ask about your design process.', '2026-01-15T11:45:00Z'::timestamptz),
('60000000-0000-4000-a000-00000000004d', '60000000-0000-4000-a000-000000000033', 1, 'candidate', 'Thank you. I look forward to discussing my approach to user experience design.', '2026-01-15T11:46:00Z'::timestamptz)
on conflict (id) do nothing;

-- =============================================================================
-- 6. ASSESSMENTS (2 completed sessions only)
--
-- JSON shapes follow TypeScript Assessment type (app/api/src/lib/types.ts):
--   • english -> LanguageProficiencyScore (band, grammar 0-10, vocabulary 0-10,
--     fluency 0-10, coherence 0-10, notes)
--   • tone -> clarity 0-10, confidence 0-10, professionalism 0-10, sentiment, notes
--   • communication -> score 0-10, clarity, structure, listening, rapport,
--     english_proficiency (LanguageProficiencyScore), filler_usage,
--     native_language_usage, notes
--   • motivation -> score 0-10, notes
--   • role_fit -> score 0-10, matched_skills[], gaps[], red_flags[], notes
--   • overall_score -> 0-100
--   • recommendation -> advance|hold|reject
--   • resume_conflicts -> array of discrepancy objects
-- =============================================================================
insert into screening_v2.assessments (id, session_id, candidate_id, english, tone, communication, motivation, role_fit, resume_conflicts, overall_score, recommendation, summary, raw, provenance, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000051',
  '60000000-0000-4000-a000-000000000031',
  '60000000-0000-4000-a000-000000000021',
  '{"band":"C1","grammar":8,"vocabulary":7,"fluency":9,"coherence":8,"notes":"Strong English proficiency demonstrated during session"}'::jsonb,
  '{"clarity":8,"confidence":7,"professionalism":9,"sentiment":"positive","notes":"Professional and well-articulated responses"}'::jsonb,
  '{"score":8,"clarity":8,"structure":7,"listening":9,"rapport":8,"english_proficiency":{"band":"C1","grammar":8,"vocabulary":7,"fluency":9,"coherence":8,"notes":"Strong English proficiency"},"filler_usage":{"level":"low","examples":["um","like"],"impact_score":8,"notes":"Minimal filler words"},"native_language_usage":{"level":"low","examples":[],"impact_score":9,"notes":"No noticeable native language interference"},"notes":"Good communication overall"}'::jsonb,
  '{"score":7,"notes":"Showed moderate enthusiasm for the role"}'::jsonb,
  '{"score":8,"matched_skills":["Python","testing","communication"],"gaps":["CI/CD","performance testing"],"red_flags":[],"notes":"Strong fit for test engineer role"}'::jsonb,
  '[]'::jsonb,
  82,
  'advance',
  'SYNTHETIC DEMO: Candidate demonstrated strong testing methodology knowledge.',
  '{"is_synthetic":true,"version":"gov-06-synthetic-v1","source":"demo_seed","communication":{"score":8,"clarity":8,"structure":7,"listening":9,"rapport":8,"english_proficiency":{"band":"C1","grammar":8,"vocabulary":7,"fluency":9,"coherence":8,"notes":"Strong English proficiency"},"filler_usage":{"level":"low","examples":["um","like"],"impact_score":8,"notes":"Minimal filler words"},"native_language_usage":{"level":"low","examples":[],"impact_score":9,"notes":"No noticeable native language interference"},"notes":"Good communication overall"},"motivation":{"score":7,"notes":"Showed moderate enthusiasm for the role"},"resume_conflicts":[]}'::jsonb,
  '{"schema_version":1,"provider":"anthropic","requestedModel":"claude-sonnet-4-20250514","workload":"scoring","prompt_template_version":"2026-07-28.1","timestamp":"2026-01-15T10:16:00Z"}'::jsonb,
  '2026-01-15T10:16:00Z'::timestamptz,
  '2026-01-15T10:16:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.assessments (id, session_id, candidate_id, english, tone, communication, motivation, role_fit, resume_conflicts, overall_score, recommendation, summary, raw, provenance, created_at, updated_at) values
(
  '60000000-0000-4000-a000-000000000052',
  '60000000-0000-4000-a000-000000000032',
  '60000000-0000-4000-a000-000000000022',
  '{"band":"C2","grammar":9,"vocabulary":9,"fluency":10,"coherence":9,"notes":"Excellent English proficiency"}'::jsonb,
  '{"clarity":9,"confidence":8,"professionalism":10,"sentiment":"positive","notes":"Very professional and confident"}'::jsonb,
  '{"score":9,"clarity":9,"structure":9,"listening":9,"rapport":8,"english_proficiency":{"band":"C2","grammar":9,"vocabulary":9,"fluency":10,"coherence":9,"notes":"Excellent English proficiency"},"filler_usage":{"level":"low","examples":[],"impact_score":9,"notes":"Very few filler words"},"native_language_usage":{"level":"none","examples":[],"impact_score":10,"notes":"No native language interference"},"notes":"Excellent communication skills"}'::jsonb,
  '{"score":8,"notes":"Good motivation for the role and company"}'::jsonb,
  '{"score":9,"matched_skills":["Python","statistics","machine learning","SQL"],"gaps":["deep learning","NLP"],"red_flags":[],"notes":"Excellent fit for data scientist role"}'::jsonb,
  '[]'::jsonb,
  88,
  'advance',
  'SYNTHETIC DEMO: Candidate showed strong data science foundation.',
  '{"is_synthetic":true,"version":"gov-06-synthetic-v1","source":"demo_seed","communication":{"score":9,"clarity":9,"structure":9,"listening":9,"rapport":8,"english_proficiency":{"band":"C2","grammar":9,"vocabulary":9,"fluency":10,"coherence":9,"notes":"Excellent English proficiency"},"filler_usage":{"level":"low","examples":[],"impact_score":9,"notes":"Very few filler words"},"native_language_usage":{"level":"none","examples":[],"impact_score":10,"notes":"No native language interference"},"notes":"Excellent communication skills"},"motivation":{"score":8,"notes":"Good motivation for the role and company"},"resume_conflicts":[]}'::jsonb,
  '{"schema_version":1,"provider":"anthropic","requestedModel":"claude-sonnet-4-20250514","workload":"scoring","prompt_template_version":"2026-07-28.1","timestamp":"2026-01-15T11:16:00Z"}'::jsonb,
  '2026-01-15T11:16:00Z'::timestamptz,
  '2026-01-15T11:16:00Z'::timestamptz
) on conflict (id) do nothing;

-- Note: No assessment for session 033 (in_progress).
-- The in-progress session has no assessment yet.

-- =============================================================================
-- 7. CONSENT RECORDS
-- =============================================================================
insert into screening_v2.consent_records (id, candidate_id, source, proof, created_at) values
(
  '60000000-0000-4000-a000-000000000061',
  '60000000-0000-4000-a000-000000000021',
  'demo_seed',
  '{"method":"simulated_consent","timestamp":"2026-01-15T12:00:00Z","is_synthetic":true}'::jsonb,
  '2026-01-15T12:00:00Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.consent_records (id, candidate_id, source, proof, created_at) values
(
  '60000000-0000-4000-a000-000000000062',
  '60000000-0000-4000-a000-000000000022',
  'demo_seed',
  '{"method":"simulated_consent","timestamp":"2026-01-15T12:00:01Z","is_synthetic":true}'::jsonb,
  '2026-01-15T12:00:01Z'::timestamptz
) on conflict (id) do nothing;

insert into screening_v2.consent_records (id, candidate_id, source, proof, created_at) values
(
  '60000000-0000-4000-a000-000000000063',
  '60000000-0000-4000-a000-000000000023',
  'demo_seed',
  '{"method":"simulated_consent","timestamp":"2026-01-15T12:00:02Z","is_synthetic":true}'::jsonb,
  '2026-01-15T12:00:02Z'::timestamptz
) on conflict (id) do nothing;

-- =============================================================================
-- INTENTIONALLY NOT SEEDED (would trigger external integrations):
--   • call_queue     — telephony scheduling
--   • sms_follow_ups — SMS delivery gate
--   • ats_sync_log   — Ashby (or other ATS) external sync
--   • storage.objects (resumes_v2 / recordings_v2) — no file uploads
-- =============================================================================
