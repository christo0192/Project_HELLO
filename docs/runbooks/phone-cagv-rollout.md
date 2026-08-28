# CAGV phone rollout gate

CAGV is a guarded conversational mode for the existing LiveKit/SIP phone lane. This runbook is an acceptance checklist, not an authorization to clear the phone halt.

## Required state

- Keep the production phone halt raised during build, deploy, and verification.
- Do not create or reopen a candidate cycle during verification.
- Use synthetic audio and an owner-controlled non-production API/room for provider-connected measurements.
- Never place a PSTN call from the feasibility harness.

## P-0 evidence

Run the offline safety fixtures first:

```bash
cd app/voice-livekit
python3 benchmarks/phone_cagv_harness.py --verify
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The offline harness must report `network:false`, `production:false`, and must not claim live latency. A separate non-production runner must collect at least 50 warm Gemini samples, interim STT coverage, tool RTT, post-tool TTFT, end-to-end candidate-stopped-speaking-to-first-audio, disclosure start, consent-start, recording activation, event-loop lag, and CPU attribution.

The binding outcomes are the P-0 thresholds in the approved CAGV plan. Any STOP blocks rollout. Every CONDITIONAL requires a recorded owner decision; no fallback may be selected by an implementer.

## P-10 acceptance

Before deployment, verify:

1. Full API, web, voice, SQL policy, OpenAPI, migration re-apply, security, and container-import checks pass.
2. The tool-first hard fixtures pass: no eager unscheduled tool execution, exactly-once idempotency, required tool-choice support, and no pre-tool audio.
3. `scoring_queued` is terminal ownership transfer to the assessment queue worker; the PSTN worker posts nothing afterward.
4. Recording state converges for both session and bound attempt; stale/conflicting egress ids are not overwritten.
5. A halted spent `phone.dial` job can drain without any originate/provider operation; a due admission remains blocked by the halt.
6. Worker registration, image, measured capacity, and event-loop/cancellation evidence are current.
7. Ashby multi-feedback writeback remains disabled unless independently verified.

Deploy only while halted. Recheck health, worker registration, zero live attempts, and queue state. A test call requires separate owner authorization and a newly created immutable cycle; restore the halt immediately after admission.

## Rollback

Raise or retain the halt, stop new claims, and restore the previous API/voice-worker image. Do not reopen a historical cycle. Keep additive migrations only when the prior image is compatible; otherwise use the tested migration recovery procedure. The previous outbound framework is an operational rollback target, but its known conversation defects mean it is not an automatic permission to resume calls.
