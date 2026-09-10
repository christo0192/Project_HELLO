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

1. Through September 6, 2026 inclusive, calling may start at any hour in IST. From
   September 7, the existing 09:00 inclusive to 21:00 exclusive IST window applies
   again automatically. The calendar response exposes the cutoff.
2. Candidate voice reservations are exactly ten minutes; this is a calendar
   reservation/target and never a ten-minute forced disconnect.
3. Operator-created slots remain 15–60 minutes. Candidate voice confirmation
   uses its dedicated RPC and cannot widen the operator API.
4. Candidate-profile booking resolves the current active cycle and appointment
   in one database transaction.
5. `ok_prereqs_pending` means the appointment exists but a call is **not**
   promised until admission re-checks mapping, ingestion, consent, number,
   suppression, halt, calling window, daily contact, concurrency, and budget.
6. A terminal cycle returns `rescreen_required`; it is never reopened by
   scheduling.

At the appointment start, the due loop invokes normal `admit_phone_attempt`
with `kind = scheduled`. A halt, stale consent, suppression, invalid number,
capacity, or daily-attempt refusal produces no dial and no fabricated success.

## Candidate voice callbacks

A candidate saying they are busy remains in the current cycle. The voice worker
uses a two-phase protocol:

1. `POST /api/internal/phone/callbacks/propose` validates an absolute UTC instant
   and returns the server-normalized weekday, IST date/time, and ten-minute
   duration. It performs no write.
2. The bot reads those exact values back and asks whether they are correct.
3. Only an unambiguous affirmative response unlocks
   `POST /api/internal/phone/callbacks/confirm`.
4. The confirmation RPC atomically rechecks five-minute lead, calling window,
   midnight, daily-contact, capacity, idempotency, and the active answered
   attempt; it records `confirmed_at`, closes the current leg, supersedes the
   previous live appointment, and moves the engagement to `scheduled`.

Before disclosure, the older `/appointments` compatibility path ends the attempt
as an uncharged pre-disclosure deferral before booking. New candidate confirmation
never uses that compatibility path. Past, illegal, out-of-window, ambiguous,
full, or unavailable slots are refusals and must not be spoken as confirmations.
The temporary 24/7 testing period (ended by migration 0092 on 2026-09-10) never
bypassed consent, halt, capacity, budget, or any other admission control; the
09:00–21:00 IST window now applies to every booking. A booked callback must not be converted into a completed
or re-screened cycle.

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

## Synthetic validation

Run the callback contract and voice protocol tests with no provider credentials:

```bash
cd app/api && npm test -- --run src/__tests__/phone-worker-route.test.ts src/__tests__/phone-screening-rpc-contract.test.ts
cd app/voice-livekit && python3 -m unittest tests.test_phone_callback -v
```

These tests prove proposal-without-write, five-minute rejection, normalized IST
read-back, explicit confirmation routing, refusal truthfulness, and the ten-minute
reservation/no-forced-disconnect distinction. They must run with PSTN/SIP
network access blocked.

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
