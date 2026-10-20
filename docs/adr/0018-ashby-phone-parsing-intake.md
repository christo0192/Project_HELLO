# ADR-0018: Ashby "phone parsing" intake for applicants without a resume

**Status:** Proposed

**Decision owner:** Repository owner

**Plan references:** M017 (phone parsing intake)

## Context

Phone screening is reachable only through the Ashby integration. Today an Ashby
application is screened only when a resume file is attached:

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

Introduce two named intake types for Ashby applications:

1. **Resume parsing** — the existing pipeline, unchanged: resume fetched, parsed
   by the model, candidate materialized from the parsed resume.
2. **Phone parsing** — used when the application has no resume attached:
   candidate name, phone number and contact details are taken directly from the
   Ashby candidate record, the candidate is made dialable, the phone engagement
   is created, and the screening runs on the role's question template with no
   resume-dependent questions or cross-checks.

Owner decisions (2026-10-20):

- **Rollout:** phone parsing is on for every phone-primary Ashby job, with a
  server-side kill switch that disables it without a redeploy.
- **Eligibility:** any application moved into the AI screening stage qualifies,
  whether or not the candidate submitted it themselves.
- **Fallback:** for resume-parsing candidates whose resume has no valid Indian
  mobile number, the Ashby phone number is used instead.
- **Release:** merged on green CI after two adversarial reviews; merging deploys.

The detailed design (state model, migration, worker prompt changes, dashboard
labels) is recorded in the pull request and refined here before merge.

## Consequences

To be completed with the final design: contact PII now flows from Ashby into the
candidate record; identity confirmation and duplicate detection rely on Ashby
data; screenings for phone-parsing candidates carry no resume evidence.

## Evidence

To be completed: unit, contract and SQL policy tests; adversarial review records.

## Supersession

None.
