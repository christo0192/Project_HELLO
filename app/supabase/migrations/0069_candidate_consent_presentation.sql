-- 0069 — Candidate-facing concise consent presentation metadata.
-- The full body_md remains the authoritative legal text. These fields only
-- provide a shorter, structured presentation layer for the invite UI.

alter table screening_v2.consent_templates
  add column if not exists summary text,
  add column if not exists consent_items jsonb;

alter table screening_v2.consent_templates
  drop constraint if exists chk_consent_template_summary,
  drop constraint if exists chk_consent_template_items;

alter table screening_v2.consent_templates
  add constraint chk_consent_template_summary
    check (summary is null or (length(btrim(summary)) between 1 and 500)),
  add constraint chk_consent_template_items
    check (
      consent_items is null
      or (
        jsonb_typeof(consent_items) = 'array'
        and jsonb_array_length(consent_items) between 1 and 16
      )
    );

comment on column screening_v2.consent_templates.summary is
  'Candidate UX summary only; must not replace the full Legal body_md.';
comment on column screening_v2.consent_templates.consent_items is
  'Candidate UX labels keyed by consent type; API validates exact required coverage.';

-- Populate presentation metadata for the already-active approved template only.
-- The required consent set and body_md are deliberately unchanged.
update screening_v2.consent_templates
set summary = 'Please review these short points before your audio screening. You can decline if you are not comfortable proceeding.',
    consent_items = jsonb_build_array(
      jsonb_build_object('type', 'ai_interview', 'label', 'I agree to an AI-led voice screening.'),
      jsonb_build_object('type', 'recording', 'label', 'I agree to audio recording and transcription.'),
      jsonb_build_object('type', 'purpose', 'label', 'I understand this is used for recruitment.'),
      jsonb_build_object('type', 'data_processing', 'label', 'I agree to processing my interview information.'),
      jsonb_build_object('type', 'retention', 'label', 'I understand information is retained under the privacy notice.'),
      jsonb_build_object('type', 'rights', 'label', 'I understand my privacy choices and rights.')
    ),
    updated_at = now()
where is_active = true
  and locale = 'en-IN'
  and version = '2026-08-04.1';

notify pgrst, 'reload schema';
