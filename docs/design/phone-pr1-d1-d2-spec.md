# PR-1 — Phone post-call finalization (D1) + judge resilience (D2)

Base: origin/main 9aa8433. Worktree /tmp/wt-phone-postcall, branch fix/phone-postcall-and-judge. Schema screening_v2.
Owner decision: a candidate disconnect **scores the partial transcript**, tagged `partial:true` + `covered n/N` + `disconnect_reason`, session terminal status `completed`.
**HARD REQUIREMENT (owner):** the scorecard AND the MP3 must ALWAYS come through on a disconnect — every non-terminal-ending phone session (deliberate hangup, network drop, worker crash), with the two guaranteed INDEPENDENTLY (scoring runs off `transcript_turns`, never blocked on MP3 finalize; MP3 promotion runs off the egress trigger, never blocked on scoring). If one genuinely cannot complete (e.g. egress produced no object), log it distinctly but still deliver the other.

## D1 — server-side partial-finalize on disconnect (TS runtime + SQL migration + Vitest)

**The gap (verified):** candidate hangup → `agent.py:2212` `disconnect` branch returns non-terminal; `call_sessions` stays `status='in_progress'`, `ended_at NULL`, `recording_egress_status='active'`, no MP3, no assessment. The 0038 recording trigger + sweeper only fire on a TERMINAL status; the 0071 `sweep_phone_stranded_recordings` matches the shape but (a) waits ~7200s and (b) drives to `expired` and **never enqueues scoring**. So partials are never scored.

**Fix — a prompt partial-finalizer (new runtime tick `phone-partial-finalize`):**
Select phone sessions that ended non-terminally past a SHORT reconnect grace — covering ALL disconnect modes (hangup, network drop, worker crash):
- `call_sessions`: `mode='live'`, `status='in_progress'` (never reached completed/failed/aborted), `started_at` present.
- AND the call is genuinely over (not just briefly quiet): the session's `phone_call_attempts` row is in a terminal/dead state — `state in ('ended','human','machine')` with `ended_at set`, OR the attempt lease is expired (crash case, mirror 0071 reclaim cursor) — with the terminal/expiry timestamp `< now() - grace`.
- grace = env `PHONE_PARTIAL_FINALIZE_GRACE_SEC` (default 180). Must be < the 0071 stranded 7200s so this wins.
- Selection is on session-ended, NOT on egress state — because the scorecard must come through even if egress never started/produced nothing. Egress finalize is a SEPARATE guarantee below.

For each claimed session (lease/guard to avoid double-processing, mirror `sweep_phone_stranded_recordings` claim idiom):
1. Compute coverage: `covered = call_sessions.current_question_index`; `total = count of questions in the session plan` (`phone_session_plans` / however the plan length is derived — see `agent.py` plan build + `phone.py` plan question count). Fall back to `total = null` if plan not resolvable (still score, coverage unknown).
2. `disconnect_reason` = 'candidate_hangup' (attempt.outcome_class='disconnected'); keep a generic 'disconnected' otherwise.
3. Transition session `in_progress → completed` via the existing `transitionSession(sessionId,'in_progress','completed','conversation_complete')` (phone-worker.ts:507 idiom) — this fires the 0038 trigger → `recording.finalize` job → `finalizeAuthoritativeRecording` (recording-egress.ts:408,444-458) promotes the attempt MP3 to the session. (Idempotent: if already terminal, skip.)
4. Enqueue scoring: `assessmentQueue.enqueue(PHONE_ASSESSMENT_QUEUE, { session_id, attempt_id, partial:true, covered, total, disconnect_reason }, { dedupKey: phoneAssessmentDedupKey(sessionId), maxAttempts:5 })` — mirror phone-worker.ts:1314.
5. The scorer (`assessment-handler.ts:40` → `runAssessment(sessionId,{source:'phone', partial:true, covered, total, disconnect_reason})`) writes the assessment row (partial metadata in `raw` + new `partial boolean` column) then posts `assessment.completed` (assessment-handler.ts:50) → `apply_phone_event` (0067) drives engagement `completed` + attempt `ended`. The 0044 interlock is satisfied because the assessment row is written before the event posts.

**Migration 0072** (`app/supabase/migrations/0072_phone_partial_assessment.sql`):
- `alter table screening_v2.assessments add column if not exists partial boolean not null default false;`
- (coverage/disconnect detail live in `assessments.raw` JSON — no extra columns.)
- If a claim-lease column/table is needed for the tick, add it; otherwise reuse an existing lease mechanism. Keep it forward-only, `NNNN_name.sql`, pass supabase-static-security.
- SQL assertion test under `app/supabase/tests/` exercising: seed a stranded-disconnected phone session → run the terminalize path (or assert the predicate selects it) → assert it can reach `completed` + a partial assessment. Validated by scripts/supabase-test.sh (`supabase-check` CI).

**TS runtime wiring:** add tick `phone-partial-finalize` in `app/api/src/lib/phone-runtime/runtime.ts` (mirror `phone-recstrand` at runtime.ts:725-761), store method in `stores.ts` (mirror `sweepStrandedRecordings` stores.ts:479). Scorer partial plumbing in `assessment-handler.ts` + `runAssessment`. Vitest in `app/api/src/__tests__/` (new `phone-partial-finalize.test.ts`; extend `recording-finalize-convergence.test.ts` / `phone-recording.test.ts`). MUST assert: a stranded-disconnected session gets terminalized to `completed`, MP3 promoted, and a `partial:true` assessment enqueued+written; and that a genuinely-in-progress (recent, within grace) session is NOT touched.

**Independence (HARD REQUIREMENT):** steps 3 (session→completed, fires MP3 promotion) and 4 (enqueue scoring) must each be guaranteed on their own retry path. Enqueue scoring even if the session→completed transition or the recording finalize is deferred/failing; promote the MP3 even if scoring is retrying. The scorer reads `transcript_turns` only — it must NEVER depend on `recording_object_key`. If egress genuinely produced no object, the recording finalize job defers with `object_absent` (existing behavior) and we log `phone_partial_finalize` `recording=absent`, but the scorecard STILL lands. Symmetrically, a scoring failure (retried up to maxAttempts) never blocks MP3 promotion.

**Guardrails:** do not clobber a session already terminal; do not race the 0071 stranded sweep (shorter grace + status guard); do not double-score (dedupKey); idempotent per session (safe to re-run each tick until both MP3 and assessment exist). Log a bounded structured line per finalize (`phone_partial_finalize` with covered/total + whether mp3/score already present, NO transcript/PII).

## D2 — judge resilience (Python only: phone.py + agent.py + test_phone_gate.py)

**Root cause (verified):** judge input is ALREADY bounded (4 fields, no transcript). The `judge_error` bursts are a **breaker-open storm**: provider timeout `_PHONE_COVERAGE_PROVIDER_TIMEOUT_SEC=2.0` (+0.25 wrapper) trips on Gemini's real 3.7s spikes; `_PHONE_COVERAGE_BREAKER` (failure_threshold=3, cooldown 10s) then opens and every judge call for 10s fast-fails to `judge_error`. No consecutive-error counter → 16 errors = 16 silent holds → topic stall → hangup.

**Fixes:**
1. **Timeout knob + higher default.** phone.py:3104 `_PHONE_COVERAGE_PROVIDER_TIMEOUT_SEC` → read from env `PHONE_COVERAGE_TIMEOUT_SEC` (default 4.0, up from 2.0) so normal Gemini latency (spikes ~3.7s) doesn't time out. Register the env var in the env contract (config/environment.schema.json one-line + check-env-contract). Keep the +0.25 wrapper.
2. **Advance-with-caution after N consecutive judge_errors.** In the coordinator commit block (agent.py ~1888-1978): add a closure counter (mirror `coverage_reanchor` dict idiom, created ~agent.py:1290). Increment on `judge_error` (agent.py:1938-1939); RESET on any non-error verdict (covered or not_covered). In the `if not verdict.covered:` hold branch (agent.py:1971-1976), once the counter reaches N (env `PHONE_COVERAGE_MAX_CONSEC_ERRORS`, default 3): `await apply_background_advance(boundary)` (the covered-path call at agent.py:1978) instead of holding — advancing past the stalled topic. Reset the counter after the caution-advance. Log a distinct bounded category (e.g. `phone_coverage_judge` `error_category='caution_advance'`). Only trigger caution-advance on a run of ERRORS, never on legitimate `not_covered_model` (those are real "keep probing").
3. **Résumé-always-present guard.** phone.py:3294-3302: today `evidence = resume_facts if isinstance(resume_facts, dict) else {}` and the shortcut at 3297-3298 skips the model when `not evidence` — which silently disables conflict detection. Guard: if `resume_facts` was expected non-empty but arrives empty, log a distinct category (`phone_coverage_judge` `error_category='resume_missing'`) and DO NOT take the deterministic no-evidence shortcut in a way that disables conflict detection. Keep passing résumé in full (never clip below the conflict-detector fields).
4. **Tests** (test_phone_gate.py): (a) timeout env knob honored; (b) N consecutive judge_error verdicts → caution-advance (cursor advances) while N-1 does NOT (compare vs existing hold-only assert at 4392-4408); (c) a run of `not_covered_model` NEVER triggers caution-advance; (d) résumé-always-present guard: empty résumé with expected facts logs `resume_missing` and does not silently skip conflict detection; (e) a GUARD test asserting the judge payload always contains `resume_evidence_json` populated when resume_facts non-empty (protects against a future edit dropping it).

**Hard constraint:** D2 changes ONLY the judge path. Do NOT alter the speaking LLM's ChatContext/instructions/model/client. No changes to browser/WebRTC path (sha-pinned prompt).

## Global
- Worker tests: `cd app/voice-livekit && python3 -m unittest discover -s tests`.
- API tests: `cd app/api && npx vitest run`.
- Env contract: any new env var → one line in config/environment.schema.json + passes scripts check-env-contract.mjs.
- Cross-language tripwire: if any pinned agent.py string changes, update phone-canary1-cross-language.test.ts.
- Owner squash-merges. Keep both halves in ONE PR (fix/phone-postcall-and-judge).
