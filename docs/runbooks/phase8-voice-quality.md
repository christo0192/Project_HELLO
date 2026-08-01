# Phase 8 Voice-Quality Foundations Runbook (VOI-02..06, VOI-08)

## 1. Purpose and honesty statement

Phase 8 L4 builds LOCAL/OFFLINE synthetic foundations ONLY. Nothing here is production acceptance:

- No representative-human dataset.
- No real device/network/provider measurement.
- No approved quality thresholds.
- No real MOS raters.
- No real TTS/STT audio.

All thresholds and profiles are PROPOSED (`"status": "proposed"`) until Product/Legal/SRE approval. Authentic VOI-02..06 acceptance and full VOI-08 lifecycle completeness remain **external-pending**.

## 2. What was delivered (exact paths)

| Path | What it is |
| --- | --- |
| `app/voice-livekit/voice_quality_harness.py` | Pure-stdlib offline harness: deterministic bounded WER + entity precision/recall/F1, MOS rating bounds, PROPOSED profile/fixture validators. No network/TTS/STT/audio. |
| `app/voice-livekit/tests/fixtures/voice-quality/turn_profiles.json` | VOI-02 fixture. |
| `app/voice-livekit/tests/fixtures/voice-quality/noise_profiles.json` | VOI-05 fixture. |
| `app/voice-livekit/tests/fixtures/voice-quality/network_profiles.json` | VOI-06 fixture. |
| `app/voice-livekit/tests/fixtures/voice-quality/pronunciation_protocol.json` | VOI-04 fixture; invented synthetic Indian names/roles explicitly marked `"synthetic": true`. |
| `app/voice-livekit/tests/fixtures/voice-quality/wer_pairs.json` | VOI-03 synthetic de-identified text. |
| `app/voice-livekit/tests/test_voice_quality_harness.py` | `unittest.TestCase` — runs under pytest AND `python3 -m unittest discover`. |
| `config/voice-quality-harness.schema.json` | JSON Schema draft-07; requires `status` const `"proposed"`; mirrors harness bounds. |
| `app/api/src/services/assessment.ts` | Edited: VOI-08 preflight. |
| `app/api/src/__tests__/assessment-eligibility.test.ts` | New VOI-08 tests. |
| `docs/runbooks/phase8-voice-quality.md` | This file. |

## 3. VOI-02 — turn/barge-in/cutoff/double-talk foundation

Versioned PROPOSED-only profile schema for barge-in sensitivity, trigger/cutoff/double-talk windows, and VAD aggression. Validated for **shape + bounds only** — no runtime VAD tuning, no measured-rate claims.

External: tuning against representative calls with approved thresholds.

## 4. VOI-03 — deterministic bounded WER + entity accuracy harness

Offline synthetic WER (word-level Levenshtein, normalized tokens) with an input-word bound guarding O(n\*m) abuse. Entity precision/recall/F1 over exact `(start, end, label)` spans — reference overlaps are rejected (fail closed), predicted overlaps are defined deterministically. MOS is bounds-only. No real/accent dataset, no accent-quality claim.

External: consented statistically justified Indian-English/accent corpus with confidence intervals.

## 5. VOI-04 — pronunciation protocol + MOS bounds only

PROPOSED pronunciation protocol (MOS 1–5 scale, `raters_required`) plus invented synthetic Indian names/roles explicitly marked synthetic. `validate_mos_rating` performs BOUNDS validation only — never an acceptance/pass-fail decision; no fake MOS acceptance; no TTS calls.

External: human MOS/A-B evaluation with approved acceptance.

## 6. VOI-05 — noise/reverb/double-talk profiles (PROPOSED)

Closed-scene enum + SNR/reverb/overlap bounds; unknown scene or out-of-range params fail closed. No real room/device measurements.

External: real acoustic measurement + cohort thresholds.

## 7. VOI-06 — bandwidth/latency/jitter/loss/reconnect profiles (PROPOSED)

Bounded profile validation including reconnect `{enabled, max_reconnects, reconnect_timeout_ms}`; out-of-range/unknown profiles fail closed. No real WebRTC conditioning/network emulation.

External: real network impairment + WebRTC conditioning.

## 8. VOI-08 — authoritative assessment-eligibility preflight

**Lifecycle inspection result:** the ONLY current producer of an initially-scorable session is the worker/browser flow that transitions `in_progress` → `completed` with `terminal_reason: "conversation_complete"` BEFORE triggering scoring (`POST /api/assess`). No code sets `assessment_done` today; it is a reserved post-scoring affordance, so the repeat path is NOT proven necessary and is blocked.

Preflight in `runAssessmentImpl`: select `status, terminal_reason`; throw stable `ERR_SESSION_NOT_COMPLETED` before transcript fetch/provider/inserts unless `status === 'completed'` AND `terminal_reason === 'conversation_complete'`. Blocks `created`/`waiting`/`in_progress`/`failed`/`cancelled`/`expired`, null/malformed reasons, and the `assessment_done` repeat path.

- No consent import/invention.
- No route → service coupling.
- No raw DB error leakage added.
- Direct API (`routes/assess.ts`) and screening/queue (`routes/screening.ts`) callers both route through `runAssessment` — the service-level guard covers both.
- Tests prove provider/inserts/transcript are NOT touched for ineligible sessions and the eligible path proceeds.

Explicit: semantic short-call/decline completeness and reconnect/rejoin lifecycle remain partial/external.

## 9. Verification (exact commands + results)

| Command | Result |
| --- | --- |
| `cd app/voice-livekit && python3 -m pytest tests/test_voice_quality_harness.py -v` | 79 passed |
| `cd app/voice-livekit && python3 -m unittest tests.test_voice_quality_harness -v` | 79 OK |
| `cd app/api && npx vitest run src/__tests__/assessment-eligibility.test.ts` | 7 passed |
| `cd app/api && npm run typecheck` | clean |
| `node scripts/check-env-contract.mjs` | valid |
| `git diff --check` | clean |

Lane-only L4 standalone counts are the 79 Python and 7 API rows above. Integrated full-suite counts (all Phase 8 changes combined): Python **478 passed**; API **1229 passed** (29 files); web **183 passed** (19 files); coverage API **81.74 / 73.27 / 81.26 / 83.97** (floors 71 / 61 / 71 / 73) and web **59.57 / 51.71 / 58.99 / 63.42** (floors 58 / 50 / 58 / 62); `config/current-state.json` byte-identical to baseline.

**Negative controls:** oversized WER input rejected; empty/reference edges deterministic; overlapping reference entities rejected, overlapping predicted defined; MOS out-of-range rejected; every profile range/unknown-field/status mutation rejected; all ineligible session statuses/reasons skip provider and DB writes.

## 10. External-pending register (do not trim)

1. Representative consented Indian-English/accent/noise corpus + confidence intervals (GOV-07).
2. Human MOS/A-B raters + approved pronunciation acceptance.
3. Real noise/reverb/double-talk acoustic measurement.
4. Real WebRTC network conditioning/carrier profiles.
5. Reconnect/rejoin lifecycle.
6. Semantic decline + short-call scoring policy.
7. Approved production quality thresholds for all profiles.
8. Real-device browser matrix.
9. Production dashboards/provider/deployment evidence.
10. DB-level assessment idempotency (assessments UNIQUE on session_id): deferred pending Product decision on intentional rescoring. The TOCTOU race for concurrent scoring calls is a known residual gate; current impact is bounded (duplicate rows, no corruption). Non-concurrent repeats are blocked by the post-scoring `assessment_done` transition.

## 11. Truthfulness rules

- Every numeric profile value in this repo is PROPOSED; the schema REQUIRES `status: "proposed"`; nothing may be re-labelled approved.
- No real candidate/PII anywhere; pronunciation names are invented and marked synthetic.
