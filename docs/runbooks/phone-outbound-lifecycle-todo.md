# Phone outbound lifecycle follow-up

Status: investigation after owner-only PSTN test; production remains halted.

## Findings

- `phone_queue_not_admitted` is the queue runner's content-free event emitted while the phone queue claim gate is closed. It is not evidence that `admit_phone_attempt` rejected a dial.
- The observed attempts were admitted and later ended without answer; the reclaimer marked them `abandoned` after lease expiry.
- At least one observed attempt retained `egress_status = active` after the attempt ended. This is a recording-egress convergence issue, separate from phone admission.
- The engagement state must be checked against the authoritative attempt/session terminal outcome before interpreting it as a completed screening.

## TODO

- [ ] Add a content-free admission/dial diagnostic surface that distinguishes `admission_deferred`, `admission_refused`, queue claim suppression, and provider originate failure without identifiers or transcript data.
- [ ] Add an idempotent phone-egress reconciliation path for ended/abandoned attempts whose egress remains active; preserve evidence and never redial.
- [ ] Ensure no-answer/lease-reclaim transitions cannot mark a screening engagement `completed` unless the authoritative session has completed and terminal persistence has converged.
- [ ] Add regression tests for admitted → unanswered → lease reclaim → stale active egress, including retry eligibility and no duplicate dial.
- [ ] Add a protected staging/synthetic lifecycle test covering the real dial controller and LiveKit/Plivo adapter contracts without contacting a carrier.
- [ ] Run merged-main validation and deploy only through the protected workflow.
- [ ] After deployment, verify the halt, worker registrations, API health, and one owner-only canary only when explicitly authorized.

## Safety constraints

- Do not mutate historical `ist_date` values to create a slot.
- Do not bypass `admit_phone_attempt`.
- Do not dial while the production halt is raised.
- Do not expose phone numbers, identifiers, transcript content, or secrets in diagnostics.
