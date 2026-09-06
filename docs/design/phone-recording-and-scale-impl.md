# Verified implementation spec — PR A (in-worker recorder) + PR B (on-demand orchestration)

**Status:** APPROVED by owner (2026-09-03). A2 agent-as-recorder + B-i named browser worker + pure scale-to-zero. Two PRs, additive + flag-gated OFF by default, green + squash-merge, then mock testing. No real call until owner runs it.

---

## PR A — in-worker recording (replace LiveKit Cloud egress), flag-gated

### Why (evidence)
LiveKit Build free wall = **concurrent egress = 2** (owner hit 3/2). Agent-session minutes = 0 (self-hosted). So record **in the worker** → the egress-concurrency limit stops applying; stay on free. `docs/design/phone-cost-and-scale-plan.md` has the full RCA.

### Verified facts (do not re-derive)
- **livekit-agents is pinned `==1.6.4`.** It DOES ship `RecorderIO` (`livekit.agents.voice.recorder_io`), and the first-class `AgentSession.start(record=...)` exists too. Exact 1.6.4 API:
  - `RecorderIO(agent_session=session, sample_rate=48000)`
  - `recorder.record_input(session.input.audio) -> RecorderAudioInput` (taps the SAME candidate feed STT uses — do NOT open a 2nd AudioStream)
  - `recorder.record_output(session.output.audio) -> RecorderAudioOutput` (taps bot TTS at ACTUAL-played time via playback-progress callbacks)
  - `await recorder.start(output_path=<Path>)` — RAISES if both record_input and record_output not called first; sets timeline t0 here; launches forward task + daemon encode thread.
  - `await recorder.aclose()` — flushes resampler tails, muxes trailing packets, closes container.
  - Output = **stereo OGG/Opus** (candidate=L, agent=R), 48 kHz, incremental encode (2.5s flush → constant memory). PyAV/libopus. Keep a STRONG reference to the RecorderIO for the call lifetime (GC pitfall).
- **Consent (ask-first-record-second) is preserved by starting recording only at the consent moment**, NOT `session.start(record=True)` (that records the consent ask). See "consent timing" below — the #1 mock-test target.
- Downstream contract (unchanged, MUST preserve): the finalizer downloads the object at `recording_object_key`, hashes it (SHA-256), stores `recording_sha256`/`recording_size_bytes`, links the key; the download route re-verifies SHA-256 and mints a signed URL; recruiter UI plays `<audio controls>`. Object must be an **MP3** at the attempt-scoped key (recruiter/Safari compat + existing `audio/mpeg` contentType). ⇒ transcode OGG→MP3 once at call end (`ffmpeg -i audio.ogg -c:a libmp3lame -b:a 64k`), upload MP3 to the objectKey.
- Recording trigger seam: worker POSTs to the phone-worker API on disclosure-delivered → `createPhoneWorkerRouter` deps.startRecording (`app/api/src/routes/phone-worker.ts:1567`, wired at :1668 only when `phoneEgressConfigured()`). Consent gate + key binding = `startPhoneAttemptRecording` (`app/api/src/integrations/livekit-phone-dial/recording.ts`): STEP1 attach (0043 in_call gate + authoritative/supplementary role + DERIVED objectKey/manifestKey), STEP2 producer, STEP3 finalize egressId, STEP4 stampSessionEgress (0051). Finalizer = `finalizeAuthoritativeRecording` (`app/api/src/lib/recording-egress.ts:407`).

### Design (additive, flag = `RECORDING_PROVIDER` ∈ {`egress`(default), `worker`})
1. **API — new provider branch** in the recording seam. When `RECORDING_PROVIDER=worker`:
   - STEP1 attach stays IDENTICAL (consent gate, roles, DERIVED keys) — reuse verbatim.
   - STEP2: instead of `startRoomCompositeEgress`, mint a **presigned S3 PUT** for the objectKey (bounded expiry) and return `{ objectKey, uploadUrl, provider:'worker' }` to the worker. No egress client. `recording_provenance='worker_inband'` (new value; migration).
   - Set `recording_egress_status='active'`, `recording_provider='worker'`; stamp session (0051) so the session-keyed reader can find it. (No egressId — use a synthetic worker-recording id or null-safe the finalizer.)
2. **Worker — record + transcode + upload** (`app/voice-livekit`): on the consent trigger, if provider=worker, wire+start RecorderIO (manual), record locally; on call end `aclose()`, transcode OGG→MP3, PUT to `uploadUrl`; then POST `/recording/uploaded {attemptId, sessionId, sha256, sizeBytes, durationMs}` to the API.
3. **API — finalize (worker branch)** in `finalizeAuthoritativeRecording`: when provenance=`worker_inband`, SKIP egress stop/poll; download the object at objectKey, hash, verify size cap, write `recording_sha256`/`size`/link key/manifest exactly as the egress branch does. The `/recording/uploaded` handler drives this (or marks `recording_egress_status='complete'` and lets the existing finalize path run the worker branch).
4. **Migration:** add `worker_inband` to the `recording_provenance` domain/enum + any status; additive only. Default flag = egress ⇒ zero behavior change on merge.
5. **Guardrails:** recording is **fail-open** (if RecorderIO/transcode/upload fails, log + the call proceeds; consent gate already prevents audio-without-binding). Never block the screening. Preserve purge/erasure/quarantine/revocation (they key off objectKey — unchanged).

### Consent posture — CORRECTED to match 0067/PR160 (record-from-answer, keep-if-consent)
The egress posture SINCE migration 0067 is **record from `call.answered` (before consent, to capture the greeting + consent exchange), keep ONLY if consent is delivered, PURGE otherwise** (`app/api/src/routes/phone-worker.ts:103,356` — `startRecordingForAttempt` is called on `call.answered` AND idempotently on `disclosure.delivered`; purge events = `disclosure.refused` / machine pickup / `candidate.deferred_pre_disclosure`). The in-worker recorder MUST match this, NOT an ask-first-start:
- `wire()` at session construction; `begin()` at **`call.answered`** (record from answer).
- On a terminal that KEEPS (consent delivered): `finish()` → transcode + upload to the objectKey.
- On a terminal that PURGES (refusal / machine / pre-disclosure deferral): `discard()` → close + delete local, **upload NOTHING** (so there is no object for the server-side purge to race). The caller gates upload on the consent outcome; the recorder never uploads blindly.
- The attempt-scoped objectKey binding (attach consent gate) still governs findability; the existing purge (keyed by objectKey) already deletes a kept-then-revoked object.
- MOCK-TEST: begin→discard uploads nothing + disables finish; begin→finish uploads; both audio streams present in a real RecorderIO run.

### DECISION — worker recording enable-point + guards (consent-sensitive)
Two existing mechanisms disagree on posture: API egress attaches at `call.answered` (0067: record-from-answer, keep-if-consent, purge-otherwise), while the worker's `_phone_recording_permitted()` (agent.py:928) is documented as the single legal worker-side recording seam, gated post-`disclosure.delivered` and "never reached on the machine, refusal, opt-out, wrong-number or no-participant paths" (and the Canary-1 disclosure text claims "not being recorded").
**Resolution (behavior-preserving):** PR A's in-worker recorder matches the SHIPPING egress semantics — it begins at the same lifecycle point egress attaches and reuses the EXACT guard set of `_phone_recording_permitted` (never machine/refusal/opt-out/wrong-number/no-participant/canary), then keeps-if-consent (`finish()`→upload) or purges-otherwise (`discard()`). This makes PR A a faithful producer swap with IDENTICAL consent semantics to production; no new posture is invented. The recorder must NOT run on any canary path (Canary-1 must keep speaking "not being recorded" truthfully — so worker recording is disabled whenever the room is a canary room). Flag-gated OFF (`RECORDING_PROVIDER=egress` default); owner confirms before any prod enable. Wire point in agent.py: the worker already calls `session.start(record=phone.PHONE_NO_RECORDING)` (recording off) at agent.py:3648 / 4414 — PR A wires the manual RecorderIO (recording.py) and gates begin() on the same permitted/guarded event, leaving `PHONE_NO_RECORDING` as the session.start default (we drive RecorderIO manually, not via the first-class `record=`, to keep the ask-guarded control).

### Tests (PR A)
- API: provider=worker branch returns presigned PUT + preserves the attach consent gate/roles; refusal/pre-disclosure paths still record nothing; finalize worker-branch downloads+hashes+links; provenance migration.
- Worker: RecorderIO wired with both taps; start() only at consent; OGG→MP3 transcode; upload PUT; fail-open on each failure; strong-ref retained.
- Integration/mock: synthetic candidate + bot frames → a stereo file with BOTH streams on the timeline; consent-ask excluded.

---

## PR B — unified on-demand Fly orchestration (both pipelines), flag-gated

Full spec in `docs/design/phone-cost-and-scale-plan.md` §2 (copy into PR B). Summary:
- Two invariants: never admit without a ready worker; never leave a machine started without a session (reaper backstop).
- `voice_worker_leases` table; warm pool of stopped machines; readiness handshake (worker→API on LiveKit registration); Fly Machines API client (`https://api.machines.dev/v1` — *corrected per RCA 2026-09-06; `api.fly.io/v1` does not serve the Machines API* — start/stop/wait/list, `FLY_API_TOKEN` org-scoped secret).
- Phone: gate `admit_phone_attempt` on a ready claimed machine. Browser: **B-i** name the worker (`project-hello-voice`) + explicit dispatch + "Preparing…" gate.
- Pure scale-to-zero. Deploy-gate reconciliation (start→verify registration→deploy→stop) + CI posture check. 1 session/worker (`max_jobs=1`), perf-1x pin retained.
- Flag-gated so merge changes nothing until owner enables.

---

## Order & verification
PR A first (owner emphasized the recorder), merge, then PR B off updated main. Each: unit+integration green, env-contract, gitleaks, full suites, CI green, squash-merge. Then mock-test both, ESPECIALLY the recorder mixing bot+candidate. Report ready only when all verified.

### UPDATE — worker records FROM CONSENT (posture B), via the `_phone_recording_permitted` seam
On closer reading of `agent.py`, the clean, intended worker hook is `start_recording=_phone_recording_permitted` (passed to `phone.run_phone_gate` at agent.py:3754) — the documented single legal worker-recording seam, called only AFTER consent and guarded against machine/refusal/etc. Decision: the in-worker recorder BEGINS at this seam (record-from-consent), not from answer. Rationale: it's the intended hook, it's more privacy-conservative ("recording less harms nobody" — the subsystem's stated safe direction), the consent is already captured in the DB gate transcript (not needed as audio), and it AVOIDS the purge-vs-late-upload race entirely (recording never exists without consent ⇒ no `discard()` needed for the no-consent case). The server egress path (post_call_answered=True, record-from-answer) is a DIFFERENT mechanism and is untouched. `discard()` remains only as a defensive close-without-upload for a post-consent abnormal abort. This is a documented, conservative divergence from egress's record-from-answer window; flag-gated OFF, owner confirms before prod enable.
Wire seams: (1) `recorder.wire()` immediately before `session.start(... record=PHONE_NO_RECORDING)` in `wait_for_participant` (agent.py:3648) — taps installed, recording off; (2) `recorder.begin(object_key)` inside a wrapper around `_phone_recording_permitted` after a successful `prepare_recording`; (3) `recorder.finish(upload_url)` + `complete_recording(...)` at the single call teardown (a `finally`/close handler covering the many `_close_phone_room` return points). If `engagement_id` is not in scope worker-side, make `/recording/prepare` resolve it from `attempt_id` server-side (reuse the router's `resolveEngagement`).

### PR B RISK (must validate in mock/live before activation) — dispatch ordering vs cold start
B4 places `ensureReadyWorker` AFTER `createDispatch` (provisionPhoneRoom), and the worker posts `/ready` only after it receives the dispatch (`ctx.connect`). With scale-to-zero this depends on **LiveKit holding the explicit dispatch until the just-started worker boots+registers (~15-25s cold) and picks it up**. If LiveKit's dispatch-assignment window is shorter than machine boot, the dispatch is lost → worker never joins → `/ready` never posts → dial defers forever (a non-converging loop, since ensureReadyWorker stops the machine on timeout). MOCK-TEST THIS FIRST. If it fails, the fix is **ready-before-dispatch with MACHINE-LEVEL readiness**: the worker posts `/ready` on LiveKit-registration/prewarm (NOT on job receipt) carrying only {machine_id, app} (it doesn't know the session pre-dispatch); `mark_voice_worker_ready` keys the lease by machine_id alone; ensureReadyWorker (claim→start→wait registered) runs BEFORE createDispatch. Keep the flag OFF until this is resolved.

## PR B — PRE-ACTIVATION checklist (before flipping WORKER_ORCHESTRATION on in prod)
PR B ships the complete on-demand orchestration machinery for both pipelines, flag-gated OFF (WORKER_ORCHESTRATION default false; browser BROWSER_AGENT_NAME inert until the flag flips). Merging changes nothing. Before the owner activates, these must be done:
1. **Warm pool + FLY_API_TOKEN**: create the pool of pre-created STOPPED machines per app and `register_voice_worker` them; set `FLY_API_TOKEN` (org/app-scoped) as an API secret. Fly injects `FLY_MACHINE_ID`/`FLY_APP_NAME` into the workers.
2. **Deploy-gate reconciliation (NOT done in code — runbook)**: the phone deploy workflow's CURRENT-registration watermark proof assumes an always-on worker; with scale-to-zero it must `start → verify registration → deploy → stop`, and the app must NOT be left ALWAYS_ON (a CI posture check should assert this). Until reconciled, keep the workers always-on and orchestration OFF.
3. **Phone-path readiness retrofit (contingency)**: the browser path uses machine-level ready-before-dispatch (RPC 0080, prewarm session-less ping) — the correct pattern. The phone path (B4) still posts session-keyed `/ready` AFTER dispatch (documented dispatch-ordering risk). If the mock/live test shows LiveKit does NOT hold the phone dispatch until the cold-started worker registers, retrofit the phone path to the same machine-level pattern: phone worker prewarm posts `post_worker_ready_machine`, and move the dial gate BEFORE provisionPhoneRoom's dispatch. Infra (0080) is already in place.
4. **Mock/live validation (owner)**: the orchestration handshake under real cold start needs real Fly + LiveKit (a staging run or the on-hold test call). The recorder's audio fidelity (both streams mixed) needs a real RecorderIO run. Both are flag-OFF until validated.


### PR B activation-readiness UPDATE (2026-09-03) — items 2 & 3 DONE in code
- **Deploy-gate reconciliation: DONE** (`deploy-fly.yml` + `scripts/deploy-voice-orchestration.sh` + posture check in `validate-voice-worker-apps.mjs`). Gated on the per-app `WORKER_ORCHESTRATION` fly-config flag: OFF path byte-identical (always-on deploy unchanged); ON path does start→verify→deploy→re-verify→stop. Posture check rejects ALWAYS_ON+orchestration-on and scale-to-zero+orchestration-off.
- **Phone-path readiness retrofit: DONE** — phone now uses machine-level ready-BEFORE-dispatch (prewarm session-less ping → RPC 0080), same as browser; the dispatch-ordering risk is resolved. Both pipelines are correct-by-construction.
- **REMAINING (owner, needs real Fly)**: (1) `fly auth login` + app-scoped `FLY_API_TOKEN` secret on project-hello-api; (2) create the warm pool of STOPPED machines per app + `register_voice_worker` each; (3) set `WORKER_ORCHESTRATION="worker"` in each worker app's fly config (deploy) so the deploy-gate + worker agree, then a live cold-start validation; (4) flip on. The `fly machine list` column parse in deploy-voice-orchestration.sh should be smoke-tested against real flyctl output on first activation.
