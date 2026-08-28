# Owner phone test gate

This is the repeatable production test path for the designated owner candidate.
It exercises the durable rescreen, admission, LiveKit/SIP, recording and
assessment flow without clearing the global phone halt or exposing other
candidates to a dial.

## Safety contract

- The candidate is selected by an authenticated admin using an immutable
  candidate id, never by display-name matching.
- `POST /api/candidates/{id}/phone-test-gate` creates the next immutable
  rescreen cycle when the prior cycle is terminal and arms one ten-minute gate.
- The gate is globally exclusive and is consumed atomically by admission.
- The due loop is scoped to that gate's engagement only; other candidates are
  not read for dialing while the gate is active.
- The global `operator_pause` remains raised. The gate is the only permitted
  exception. `emergency_stop`, `provider_incident`, `legal_hold` and
  `cost_control` remain absolute refusals.
- Consent, number validity, allowlist, IST window, fleet capacity, leases,
  recording and all ordinary admission checks still apply.
- A gate expiry or failed admission does not create permission to retry the
  same gate. Arm a new request after the state is terminal/reclaimable.

## Repeat a test

1. Confirm the owner is ready to answer and the global halt reason is still
   `operator_pause`.
2. From an authenticated admin session, POST the exact owner candidate id with
   a fresh bounded idempotency key:

   ```http
   POST /api/candidates/{candidate_id}/phone-test-gate
   {"request_id":"owner-test-<unique-key>"}
   ```

3. A `202` means the immutable rescreen and exclusive gate were accepted. It
   does not claim that a call has already been placed.
4. Watch the phone worker and API structured logs. The gate is consumed only
   when `admit_phone_test_attempt` succeeds; provider failure, a closed window,
   missing consent, or an unavailable worker remains a refusal.
5. After the call, verify the assessment, recording projection, terminal state,
   and the consumed gate. No global halt clear is needed.
6. Use a new request key for the next owner test. The previous cycle remains
   immutable history; the endpoint creates the next cycle only after the prior
   one is terminal.

If the call must stop, use the existing room/worker abort card. Raising the
ordinary global halt is still valid for all ordinary admissions, but it does
not terminate an already-connected call.

## Cadence: why an armed gate can still dial nobody

The gate bypasses only the `operator_pause` halt. Every other admission rule
still applies, and two of them are per-IST-day (midnight = 18:30 UTC):

- **Per-engagement**: one `initial`/`no_answer_retry`/`scheduled` attempt per
  engagement per IST day. A gate on an engagement that already dialled today
  is refused `daily_attempt_exists` until the IST day rolls.
- **Per-candidate**: one cold call (`initial`/`no_answer_retry`) per candidate
  per IST day across ALL engagements. `scheduled` dials are exempt — a booked
  slot is not a cold call.

So the repeatable owner cadence is: one gated test call per owner candidate
per IST day. For a second same-day test, use a different owner candidate row
(each has its own per-candidate budget), or book an appointment (the
`scheduled` kind) on a fresh cycle.

Two more traps, both fixed by 0065 but worth knowing:

- Re-POSTing the endpoint with a prior request key now REFRESHES an expired,
  unconsumed gate. A CONSUMED key stays spent — arm a new request id.
- The health surface expands `admission_refused` by its real constraint (for
  example `admission_refused:daily_attempt_exists`), so a refused gate names
  its reason instead of reporting `halted`.

Also remember `cycle_limit_reached`: three cycles per application is the
ceiling. An owner candidate whose application has burned all three cycles
cannot be re-gated at all; keep a spare owner candidate row for that case.
