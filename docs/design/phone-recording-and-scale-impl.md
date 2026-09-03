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

### Tests (PR A)
- API: provider=worker branch returns presigned PUT + preserves the attach consent gate/roles; refusal/pre-disclosure paths still record nothing; finalize worker-branch downloads+hashes+links; provenance migration.
- Worker: RecorderIO wired with both taps; start() only at consent; OGG→MP3 transcode; upload PUT; fail-open on each failure; strong-ref retained.
- Integration/mock: synthetic candidate + bot frames → a stereo file with BOTH streams on the timeline; consent-ask excluded.

---

## PR B — unified on-demand Fly orchestration (both pipelines), flag-gated

Full spec in `docs/design/phone-cost-and-scale-plan.md` §2 (copy into PR B). Summary:
- Two invariants: never admit without a ready worker; never leave a machine started without a session (reaper backstop).
- `voice_worker_leases` table; warm pool of stopped machines; readiness handshake (worker→API on LiveKit registration); Fly Machines API client (`https://api.fly.io/v1`, start/stop/wait/list, `FLY_API_TOKEN` secret).
- Phone: gate `admit_phone_attempt` on a ready claimed machine. Browser: **B-i** name the worker (`project-hello-voice`) + explicit dispatch + "Preparing…" gate.
- Pure scale-to-zero. Deploy-gate reconciliation (start→verify registration→deploy→stop) + CI posture check. 1 session/worker (`max_jobs=1`), perf-1x pin retained.
- Flag-gated so merge changes nothing until owner enables.

---

## Order & verification
PR A first (owner emphasized the recorder), merge, then PR B off updated main. Each: unit+integration green, env-contract, gitleaks, full suites, CI green, squash-merge. Then mock-test both, ESPECIALLY the recorder mixing bot+candidate. Report ready only when all verified.
