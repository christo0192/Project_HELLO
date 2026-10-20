# ADR-0018: Ashby "phone parsing" intake for applicants without a resume

**Status:** Accepted

**Owner decision date:** 2026-10-20

**Decision owner:** Repository owner

**Plan references:** M017 (phone parsing intake), including its Addenda A
(visible intake type) and B (owner answers of 2026-10-20); migration
`app/supabase/migrations/0130_ashby_phone_parsing_intake.sql`; runbooks
`docs/runbooks/ashby-runtime-activation.md` §10 and
`docs/runbooks/phone-runtime.md` §11

## Context

Phone screening is reachable only through the Ashby integration. Before this
decision an Ashby application was screened only when a resume file was attached:

- The import keeps only the resume file handle from `candidate.info`; the
  candidate row is a PII-minimal shell (name, email, phone all null).
- The ingestion job exits early when there is no resume handle, so the
  application stays `queued` forever ("Resume processing" in the dashboard).
- The candidate phone number is derived only from the model-parsed resume, and
  only model-structured numbers are dialable.
- `ensure_ashby_phone_engagement` refuses with `ingestion_not_ready`, and
  `admit_phone_attempt` refuses applications without a resume handle.

Applicants who reach the AI screening stage without a resume are therefore never
called, and resume-backed candidates whose resume has no valid Indian mobile
number are held at `phone_invalid`.

## Decision

Introduce two named intake types for Ashby applications, recorded on the
application link as `ashby_application_links.intake_type`:

1. **Resume parsing** (`resume_parsing`, the default and every pre-0130 row) —
   the existing pipeline: resume fetched, scanned, parsed by the model, candidate
   materialized from the parsed resume.
2. **Phone parsing** (`phone_parsing`) — used when the application has no resume
   attached, or its resume could not be read: the candidate's name, email and
   primary phone number are taken from the Ashby candidate record, the
   engagement is created, and the screening runs on the role's question template
   with no resume-dependent questions or cross-checks.

How it is classified and applied:

- An application is classified by a delayed `ashby.profile` job (15 minutes after
  import, re-reading Ashby first) and by a durable sweep, never at import time.
  Only `apply_ashby_candidate_profile` writes `phone_parsing` or an Ashby number;
  it re-checks every gate under the link and candidate locks. The stamp is never
  flipped back: a resume that arrives after stamping is logged and ignored.
- Only the Ashby primary number is used (another entry only when no primary
  exists). It must be a strict +91 mobile, not a placeholder pattern, and not a
  number another Ashby person already holds as valid. A phone-parsing applicant
  with no usable name gets no number (`name_missing`), because without a name the
  identity check cannot catch the wrong person.
- An Ashby number is applied at most once per candidate row
  (`candidates.ashby_phone_applied_at`, never cleared) and never overwrites a
  valid number, a parsed name or an HR correction.
- `admit_phone_attempt` and `ensure_ashby_phone_engagement` skip only the
  resume/ingestion gate for `phone_parsing`; every other gate runs unchanged.

Owner decisions (2026-10-20):

- **Rollout and kill switch:** phone parsing is on for every enabled
  `phone_primary` Ashby job. The switch is `ASHBY_PHONE_PARSING_ENABLED`, read as
  the literal `"true"` only (unset is OFF in code and tests); `app/api/fly.toml`
  `[env]` sets `"true"`, and a Fly secret overrides it without a code deploy.
  OFF stops every profile enqueue, the profile sweep and the profile job, and the
  due loop holds every dial of a `phone_parsing` engagement, including HR "Call
  now", rescreens and booked appointments (they are accepted and dial once the
  switch is back on). Only reconnects of a live call still flow. OFF does not
  undo the always-on safety fixes listed under Consequences.
- **Eligibility and consent basis:** any application moved into the AI screening
  stage qualifies, whether or not the candidate submitted it. The consent record
  keeps `source = 'job_application'`; for `phone_parsing` its proof carries
  `basis: 'ashby_ai_stage_application'` and the intake type.
- **Fallback number:** for a resume-parsing candidate whose resume has no valid
  +91 mobile (`phone_invalid`), the Ashby number is applied instead, under the
  same rules.
- **Unreadable resume:** a resume-parsing link whose ingestion rests in
  `failed_review` ("Resume needs review") falls back to phone parsing, while the
  switch is on, the mapping is an enabled `phone_primary` and no engagement has
  gone beyond `pending_prereqs`. Name and email are filled only where null.
- **Wrong person on an unverified Ashby number: one more try.** The first
  confirmed identity mismatch (the worker's `recording_discarded` flag on
  `candidate.deferred_pre_disclosure`, set only for a not-the-candidate or
  wrong-number verdict) is recorded on the link
  (`identity_mismatch_attempt_id`) and the engagement follows the existing
  pre-disclosure path, redialled no earlier than the next IST day's calling
  window. A second confirmed mismatch on a later attempt of the same engagement
  releases the number: `phone_e164` is cleared, the engagement is cancelled with
  `identity_unconfirmed`, and the link outcome is `identity_unconfirmed`. A
  number HR verified, or one that came from a resume, is never released.
- **Disclosure wording:** unchanged ("your job application"). Neutral wording for
  recruiter-sourced applications is a follow-up for owner or Legal review.
- **Release:** merged as soon as CI is green and both adversarial reviews pass;
  merging deploys. There is no merge window; the 15-minute classification delay
  and the sweep's age gates cover the new-API/old-worker skew.

## Consequences

**Data and privacy.**

- Contact data (name, email, phone number) can now originate from the Ashby
  candidate record as well as from the parsed resume and HR verification. It has
  the same classification as resume-derived contact data
  (`docs/data-classification.md`).
- No audit row is written for an applied profile, and no RPC answer, log line,
  job payload or error carries a name, email or number: answers are codes, flags
  and an engagement id, and the job payload is the link id only.
- A pending, in-progress or fulfilled correction, restriction or erasure request
  holds every profile write and every sweep claim for that candidate. A DSAR
  delete also terminates the candidate's live Ashby links
  (`terminal_reason = 'subject_erasure'`), so an erased person is never
  re-collected by a later import or sweep.

**Behaviour.**

- Two RPC roles: `apply_ashby_candidate_profile` is the only writer of the intake
  and of an Ashby number, and ends in `ensure_ashby_phone_engagement` in the same
  transaction; `claim_ashby_profile_due` is the sweep's bounded claim
  (`SKIP LOCKED`, at most 25 links per tick, exponential backoff from 6 hours, at
  most 4 claims per link). `release_ashby_number_after_identity_mismatch` is the
  third RPC, called by the worker-events route.
- The sweep's configured interval is 600 s, but `lib/scheduler.ts` caps every
  loop's poll delay at 60 s, so the claim runs every 30-60 s. This is harmless:
  due-ness is decided in SQL, and a tick with nothing due costs one RPC and no
  Ashby read.
- Phone-parsing screenings carry no resume evidence. The worker renders a
  no-resume instruction set, and scoring uses fixed no-resume facts with no
  resume-conflict checks (`candidates.resume_id is null`).
- Always on, whatever the switch: the phone-first parse write (a parse never
  overwrites a valid number), the intake filter on binding a resume handle, the
  ingestion guard for stamped links, the worker and scoring no-resume handling,
  the identity-mismatch release, and DSAR link termination.
- The dashboard shows the intake ("Resume parsing" / "Phone parsing") on the
  candidate list, detail page, workflow card and Mission Control, with a list
  filter, and shows the profile outcome on Ashby workflow rows.

**Follow-ups and residual risks.**

- The funnel intake view counts phone-parsing applications as parsed; a later
  change adds an intake column.
- A landline or a foreign 10-digit number can still pass the strict pattern, as
  on the resume path; the identity gate and the second-mismatch release bound the
  harm. A number-type check is a follow-up.
- A general "application left the AI stage" cancel is a pre-existing gap; the
  profile job re-checks the stage before it applies anything.
- Rolling back the application on the new database leaves stamped links
  passing the SQL gates with no due-loop hold and no mismatch release; use the
  global phone halt (`set_phone_halt`). See the activation runbook §10.

## Evidence

- SQL: `app/supabase/tests/policy_tests.sql` (intake gates, apply, claim arms,
  unreadable-resume fallback, second-mismatch release, privacy of answers);
  `scripts/migrate-rollback.test.mjs` (forward-only, additive migration);
  `scripts/verify-prod-function-drift.sh` checks the five functions 0130
  declares.
- API: `ashby-candidate-profile.test.ts`, `ashby-phone-parsing-import.test.ts`,
  `ashby-profile-job.test.ts`, `ashby-profile-sweep.test.ts`,
  `ashby-workflow-stores-intake.test.ts`, `phone-0130-intake.test.ts`,
  `phone-0130-prod-drift-check.test.ts`, `phone-ashby-profile-derive.test.ts`,
  plus the updated runtime-config, phone-runtime, worker-route, DSAR, scoring and
  OpenAPI contract suites under `app/api/src/__tests__/`.
- Worker: `app/voice-livekit/tests/test_prompting.py`,
  `test_phone_assessment.py` and `test_phone_gate.py` (no-resume rendering and
  the safe first name).
- Web: candidate filter, intake badge, workflow card, candidate detail and
  Mission Control suites under `app/web/src/`.
- Two adversarial reviews are recorded on the pull request before merge.

## Supersession

None.
