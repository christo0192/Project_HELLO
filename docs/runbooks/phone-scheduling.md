# Phone scheduling runbook

This runbook covers the internal Project HELLO phone schedule. It does not send
notifications, synchronize an external calendar, or place a call directly.
Every dial remains owned by the LiveKit phone worker and enters through
`admit_phone_attempt`.

## Roles and surfaces

- **Admin:** dashboard schedule summary, global `/phone-calendar`, and any
  visible candidate profile. May book, reschedule, or cancel.
- **Interviewer:** dashboard schedule summary and candidate-profile scheduling
  only for owned candidates. The API returns the same not-found result for an
  unowned candidate; the global calendar remains read-only.
- **Viewer:** no phone schedule request is made by the dashboard or calendar
  UI and no schedule data is rendered.

Use the candidate profile for normal booking. The global calendar is for
range-based visibility, overdue triage, and admin operations. It no longer asks
operators to copy an internal engagement UUID.

## Booking semantics

1. Select an IST date and a slot between 09:00 inclusive and 21:00 exclusive.
2. Treat the capacity label as an advisory projection, not a reservation.
3. Candidate-profile booking resolves the current active cycle and appointment
   in one database transaction.
4. `ok_prereqs_pending` means the appointment exists but a call is **not**
   promised until admission re-checks mapping, ingestion, consent, number,
   suppression, halt, calling window, daily contact, concurrency, and budget.
5. A terminal cycle returns `rescreen_required`; it is never reopened by
   scheduling.

At the appointment start, the due loop invokes normal `admit_phone_attempt`
with `kind = scheduled`. A halt, stale consent, suppression, invalid number,
capacity, or daily-attempt refusal produces no dial and no fabricated success.

## Candidate voice callbacks

A candidate saying they are busy remains in the current cycle. The voice worker
books through the internal appointment endpoint with source `candidate_voice`.
Before disclosure, the attempt is ended as an uncharged pre-disclosure deferral
before the appointment is booked. The worker confirms a callback only after the
server returns an accepted appointment result.

Past, illegal, out-of-window, unclear, or unavailable slots are refusals and
must not be spoken as confirmations. A booked callback must not be converted
into a completed or re-screened cycle.

## Reschedule and cancellation

- Use the appointment's current version; stale versions return
  `version_conflict` and the UI must re-read.
- Rescheduling is an atomic supersede, not cancel-then-book.
- Cancellation requires a reason and version. `already_cancelled` is an
  idempotent success.
- An appointment becoming `fulfilled` means it was admitted at its scheduled
  start; the conversation outcome is recorded separately.
- A missed appointment is expired by the bounded sweep and does not consume a
  dial budget.

## Troubleshooting

- **No schedule card:** verify the authenticated role and the deployed web
  build. Viewer accounts intentionally see no phone request. Then verify the
  phone feature flag and API health through the protected operator workflow.
- **Unavailable summary:** do not interpret it as zero. Open the calendar and
  retry after checking API health.
- **Overdue rows:** the expiry sweep is stale. Keep the phone halt raised if
  live operations are not understood; inspect the runtime health surface and
  re-read the calendar after the sweep recovers.
- **Prerequisites pending:** resolve the reported prerequisite through its
  owning workflow. Do not bypass it by creating another appointment.
- **Version conflict:** discard stale form state and reload; never retry a
  mutation with an old version.
- **`rescreen_required`:** use the governed re-screen action on the candidate
  profile. Do not reset or edit the terminal cycle.

## Release gate

Before enabling or using a live scheduled call:

1. Run API and web quality/typecheck suites, SQL policy tests, migration
   rollback/compatibility checks, OpenAPI drift checks, secret scan, and
   Canary-0.
2. Deploy migrations and services only through the protected workflow.
3. Keep the phone halt raised during migration and application rollout.
4. Verify API health, worker registration, schedule read access, and zero live
   attempts before any separately authorized owner test.
