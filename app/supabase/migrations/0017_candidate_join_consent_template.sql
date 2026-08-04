-- 0017 — Candidate join consent template activation for browser call flow.
-- Provides an explicit versioned template required by /candidate/join before
-- AI interview and recording access. The candidate may decline; invite exchange
-- remains fail-closed unless all required consent types are granted.

insert into screening_v2.consent_templates
  (version, locale, title, body_md, required_consents, is_active)
values
  (
    '2026-08-04.1',
    'en-IN',
    'Screening consent',
    '# Screening consent

You are being invited to a short first-round screening call for recruitment purposes.

## What you consent to

- An automated voice assistant will conduct the screening conversation.
- The call audio may be recorded and transcribed.
- Your resume, answers, transcript, and screening scorecard may be processed for recruitment review.
- The hiring team may use this information to decide whether to continue to the next interview stage.

## What is not allowed

- The assistant should not ask for passwords, OTPs, payment details, exact home address, or government ID numbers.
- The assistant should not ask about protected or irrelevant personal attributes such as age, marital or family status, religion, caste, disability, medical history, political views, union activity, or nationality unless you volunteer job-relevant work authorization details.
- The assistant should not make hiring promises or final hiring decisions.

## Your choice

You may decline this screening consent. If you decline, you will not join the AI screening call through this invite. You may contact the hiring team for an alternative process or to ask privacy questions.

By accepting all required items below, you consent to the AI interview and recording for this screening.',
    '{ai_interview,recording,purpose,data_processing,retention,rights}'::screening_v2.consent_type[],
    true
  )
on conflict do nothing;

update screening_v2.consent_templates
   set is_active = false,
       updated_at = now()
 where locale = 'en-IN'
   and version <> '2026-08-04.1';
