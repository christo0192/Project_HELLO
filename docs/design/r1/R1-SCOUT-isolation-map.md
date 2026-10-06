# R1 WebRTC pipeline: isolation map

Repo state: detached `origin/main @ eec54af` (#332). Worktree: `C:\Users\Admin\Claude projects\Screening bot for HR\.claude\worktrees\r1-scout`. The parent checkout (`fix/phone-consent-latency-opener`) is about 50 commits behind and must not be used as the base.

All paths below are repo-relative to that worktree. "LB" marks a fact the R1 plan depends on.

---

## 1. TL;DR

- **One codebase and image, two Fly apps, split at runtime.** The browser lane (`project-hello-voice`, worker `browser-screener`) and the phone lane (`project-hello-phone-voice`, `phone-screener`) both build from `app/voice-livekit` with one Dockerfile (`fly.toml:1`, `fly.phone.toml:38`, `Dockerfile:102,108`). The process picks its lane from environment variables only. The hard split is at `agent.py:11854-11861`: `if _phone_agent_name(): await _run_phone_entrypoint(...); return`. Any merge under `app/voice-livekit/` redeploys **both** workers (`deploy-fly.yml:157-165`, pinned by `scripts/deploy-fly-workflow.test.mjs:67-70`). (LB)
- **The browser lane is a bare, free-form screener.** It is a single `Christy(Agent)` with instructions only (`agent.py:1055-1057`). It has one shared, sha-pinned prompt (`prompting.system_prompt`, `tests/test_browser_prompt_pin.py:34`) and a fixed `session.say` opener. There are no tools, no phase machine, no handoff, and no video. Any assistant line matching `bye|goodbye|take care` deletes the room (`agent.py:1060-1065, 12203-12218`). That would end R1 mid role-play. (LB)
- **Nothing in schema or code says "this session is an R1".** No interview kind, round, or persona exists (`worker-context.ts:22-42`, `persistence.py:740-798`, migrations through `0114`). The cleanest plug-in has four parts:
  1. a server-side discriminator carried in the worker-context payload (additive; the phone parser ignores unknown keys, `persistence.py:780-798`);
  2. a new Python module (R1 Agent(s) + phase machine + prompt);
  3. a branch after the phone early return;
  4. the room-name contract `screening-<uuid>` left unchanged.
  (LB)
- **R1 needs its own role row.** The scorecard (`assessment.ts:298-300`, `store.ts:93-129`) and the prompt context (`worker-context.ts:171-195`, and phone `0070:94-97`) both come from `call_sessions.role_id`. The live phone-screened role is "Sales Program Advisor". A code comment says production has **two** SPA rows (`ScreeningKpis.test.tsx:455-462`). Editing the phone SPA row would change phone scoring and prompts. New roles get the 5 phone-screen default metrics by trigger (`0089:56-80`). (LB)
- **Long sessions break the browser-side completion path.** The candidate grant and JWT expire after 5 min (`candidate-access.ts:18`, `invites.ts:559-564, 644`), so `/complete` and the fallback recording upload return 403 on any call over about 5 minutes (`livekit.ts:436-440, 540-546`). The worker finalizer becomes the only completion and scoring path. The API then stops the browser machine about 15 s after the completed CAS while the worker's 180 s scoring POST is still in flight (`worker-orchestration-runtime.ts:56,173-193`; `0083:175-199`). Browser scoring is not durable. (LB)
- **Video is a reversal of recorded decisions, not an added feature.** The UI is audio-only by ADR-0014 and a structure test (`candidate-webrtc-structure.test.ts:10-13`). Other blockers:
  - egress is `audioOnly:true` OGG (`recording-egress.ts:301-305`);
  - a DB CHECK allows only audio MIME types (`0014:71-86`);
  - files are capped at 25 MiB with whole-object in-memory hashing (`env.ts:259`, `recording-egress.ts:1192-1218`);
  - LiveKit Build allows 2 concurrent egress (`env.ts:143-150`, medium confidence);
  - consent copy says "audio" (`0017:20,35`, `0069:33-41`).

  livekit-agents 1.6.4 `record=` uploads audio only, to LiveKit Cloud observability, not our storage. Its `video_input` is off by default, and frames are dropped for non-Realtime LLMs (wheel-verified). (LB)
- **The persona switch is supported by the pinned SDK.** Checked against the 1.6.4 wheel:
  - per-Agent `tts`/`llm`/`stt` overrides (`voice/agent.py:39-60`);
  - handoff by a tool that returns an Agent, or by `session.update_agent` (`generation.py:839-879`, `agent_session.py:1347-1505`);
  - `on_enter`;
  - `AgentTask`, which pauses the interviewer, runs the learner, then merges the transcript and resumes (`voice/agent.py:723-983`);
  - Sarvam `bulbul:v3` with 14 male speakers (`sarvam/tts.py:286-355`).

  The repo has never exercised any of these, so plan a spike. `update_instructions` mid-call was behaviourally ignored on live phone calls (`phone.py:4021-4028`). The proven steering pattern is constructor instructions plus a per-turn developer message.
- **Browser turn-taking runs on unmeasured SDK defaults.** It gets Silero VAD and a local v1-mini end-of-turn model, endpointing of 0.3 s / 2.5 s, barge-in at 0.5 s of voice with no word floor, and preemptive generation on. Browser latency has never been measured: the production metric sink is a no-op (`observability.py:579`). R1 needs its own `turn_handling` and a measured baseline.
- **The browser lane barely carries traffic today (medium confidence).** Every Ashby mapping defaults to `phone_primary`, which suppresses browser invites (`0047:9-22`, `orchestration.ts:508-525`). The only live entry is the recruiter "Create invite" card (`CandidateDetailPage.tsx:537`). The browser pool is one stopped machine (live `flyctl`, 2026-10-05). Gating R1 per session inside `browser-screener` is low-risk and keeps that card working.
- **Owner decisions needed before planning:**
  - gate per session vs replace the lane;
  - which role row R1 uses;
  - trigger and delivery (manual link recommended);
  - what "video recording" means, including plan, storage and consent;
  - duration and phase budget;
  - persona, objection and discount rules;
  - learner voice;
  - scoring, status, and auto-reject policy;
  - LLM choice.

---

## 2. System map today

```
 Candidate browser  (Vercel SPA app/web; /candidate/join#<token>)          Recruiter web (same SPA)
   | HTTPS /api/* (vercel.json rewrite -> project-hello-api.fly.dev)          | LiveKitCallCard: /start + /invite
   | WebRTC: mic track only today                                            |
   v                                                                          v
 +------------------------------------------+   Server SDK (rooms, dispatch,   +-------------------------------+
 | project-hello-api  (Fly, sin)            |-- egress start/stop/list) ----->| LiveKit Cloud (Build plan)    |
 |  Express: invites/exchange, livekit,     |                                 |  rooms: screening-<uuid>      |
 |  worker-context, assess, recordings,     |                                 |         phone-<uuid>          |
 |  candidate-consent, Ashby, phone runtime |                                 |         preflight-<uuid>      |
 |  loops: worker-orchestration reaper +    |                                 |  RoomComposite egress (OGG)   |
 |   terminal-release (both voice apps),    |                                 |  SIP (phone lane only)        |
 |   recording.finalize worker/sweeper,     |                                 +--------+-------------+--------+
 |   Ashby signal/import/ingestion queues,  |   Fly Machines API                       | dispatch     | dispatch
 |   phone.dial / phone.assessment queues   |---(start/stop, org token)---+            | browser-     | phone-
 +-----+-----------------------+------------+                             |            | screener     | screener[-<mach>]
       |                       |                                          v            v              v
       |                       |                    +----------------------------+  +------------------------------+
       |                       |                    | project-hello-voice (sin)  |  | project-hello-phone-voice    |
       |                       |                    | fly.toml; BROWSER_AGENT_   |  | fly.phone.toml; PHONE_AGENT_ |
       |                       |                    | NAME=browser-screener;     |  | NAME=phone-screener;         |
       |                       |                    | WORKER_ORCHESTRATION=worker|  | kill_timeout=300; RNNoise;   |
       |                       |                    | on-demand pool (1 machine, |  | in-worker RecorderIO; judge  |
       |                       |                    | stopped); no kill_timeout  |  | (DeepSeek v4-flash)          |
       |                       |                    +-------------+--------------+  +---------------+--------------+
       |                       |                                  \  SAME IMAGE: app/voice-livekit/Dockerfile   /
       |                       |                                   \ agent.py (both lanes) phone.py prompting.py /
       |                       |                                    \ persistence.py provenance.py closing.py... /
       v                       v                                     +-------------------+--------------------+
 +-----------------------------------------------+                                       | service-role writes,
 | Supabase: schema screening_v2 (call_sessions, |<--------------------------------------+ POST worker-context,
 |  transcript_turns, assessments, roles, ...),  |                                         POST /api/internal/assess
 |  job_queue, voice_worker_leases, bucket       |
 |  recordings_v2 (S3 gateway for egress)        |
 +-----------------------------------------------+
 External: Gemini (browser LLM, OpenAI-compat), Sarvam STT saaras:v3 / TTS bulbul:v3, DeepSeek v4-pro (API scoring),
           Ashby (webhooks + API).   Legacy app/voice (Pipecat SmallWebRTC, :7860) — NOT deployed, nothing imports it.
```

**Deployments and config**

| Component | Where | Lane | Key evidence |
|---|---|---|---|
| Web SPA | Vercel; deploys outside `deploy-fly.yml` | Candidate join + recruiter UI | `app/web/vercel.json`; flag `VITE_CANDIDATE_WEBRTC_V2` (`CandidateJoinPage.tsx:22`) |
| API | Fly `project-hello-api`, `sin` | Both lanes; runs orchestration loops for both voice apps | `app/api/fly.toml`; `worker-orchestration-runtime.ts:43-44,103` |
| Browser worker | Fly `project-hello-voice`, `sin`, performance-1x 2 GB | Browser only (`screening-*` rooms) | `app/voice-livekit/fly.toml:1,9,37-62` |
| Phone worker | Fly `project-hello-phone-voice`, `sin` | Phone only (`phone-*` rooms) | `fly.phone.toml:38,46,61,418` |
| LiveKit | LiveKit Cloud Build (free) plan; region not recorded in repo | Shared project and quotas | `docs/design/phone-cost-and-scale-plan.md:8-14` (2026-09-03 snapshot) |
| DB / storage | Supabase `screening_v2`, bucket `recordings_v2` | Shared | `0001_init.sql:186-187` |

**Processes.** The voice worker is `python agent.py start` (`Dockerfile:108`). A livekit-agents main process forks job processes; the browser keeps one idle process (`agent.py:1968`). The API is one Node process that serves routes and runs scheduler loops.

**Lane ownership.**
- `_worker_handles_room` (`agent.py:1932-1943`): the phone worker takes only phone rooms. The browser worker takes everything that is not phone and not preflight (`phone.py:336-358`).
- Phone room = name `phone-<uuid>` OR metadata `channel=='phone'`.

---

## 3. Browser/WebRTC lane end-to-end call chain

**A. Session creation (API)**
1. **Recruiter path.** `LiveKitCallCard.createInvite` (`app/web/src/components/LiveKitCallCard.tsx:20-36`) calls `POST /api/livekit/start` (`app/api/src/routes/livekit.ts:136-309`). That route:
   - authorises admin or interviewer and claims ownership (163-183);
   - reserves quota with an Idempotency-Key (262-273);
   - runs `createSession({candidate_id, role_id: candidate.role_id, mode:'browser', provider:'livekit'})` with status `created` (186-191; `lib/session-lifecycle.ts:235-263`);
   - CASes `owner_id` (194-203);
   - calls `provisionRoomForCreatedSession(..., 'new_session')` (209), so room and egress are created **at invite time**;
   - sets `candidates.status='screening'` unconditionally (237-243);
   - returns `{session_id, room_name, url}` (247-251).

   The request schema is strictly `{candidate_id}` (`schemas/livekit.ts:3-7`), so there is no role override.
2. `POST /api/livekit/invite` (`routes/invites.ts:126-198`) mints a 256-bit token and stores only its SHA-256 digest with a 24 h expiry (`lib/invite-token.ts:21-39`). The link is `${origin}/candidate/join#<token>` (`LiveKitCallCard.tsx:28`).
3. **Ashby path (dormant by default).** `materializeInvite` (`integrations/ashby/materialize.ts:487-615`; `runtime.ts:403-447`) creates a `mode:'browser'`, `status:'created'` session with `role_id` = the mapping's role (`materialize.ts:517-521`). It does **not** provision a room. It only runs when `screening_mode !== 'phone_primary'` (`orchestration.ts:508-525`).

**B. Room and egress provisioning** (`lib/room-provisioning.ts:156-254`)
4. Room `screening-<sessionId>` (59-61), `emptyTimeout` 600 s, `maxParticipants` 4 (46-48). Room metadata is `{session_id, room_name, correlation_id}` with no `channel` key (68-74).
5. `startAuthoritativeRecording` runs **before** the room is joinable (183-189 → `recording-egress.ts:264-323`):
   - gated on `RECORDING_EGRESS_ENABLED` (38-57);
   - `EncodedFileOutput` OGG via S3 to `recordings_v2`, key `<sid>-egress.ogg` (59-61, 283-299);
   - `startRoomCompositeEgress(room, out, {audioOnly:true})` (301-305);
   - links the egress id with an is-null CAS (308-321).
   - Then CAS `created→waiting` with `external_call_id=room` (218-221).

**C. Candidate page** (`app/web/src/pages/CandidateJoinPage.tsx`)
6. Lazy route `/candidate/join` (`App.tsx:127-134`). The token is read from the fragment into memory and stripped with `history.replaceState` (196-219).
7. Consent:
   - `POST /api/candidate-consent/status` (`routes/candidate-consent.ts:68-122`) checks the latest granted `consent_records` row against the active template, so Ashby-synthesised consent skips the UI (`CandidateJoinPage.tsx:294-308`).
   - Otherwise `GET /template` + `POST /submit` (`candidate-consent.ts:129-286`).
   - Landing copy reads "Audio screening interview / No camera is needed / Approx. 20 minutes" (621-630).
8. Readiness: `AudioReadinessStep` (`components/candidate-join/AudioReadinessStep.tsx:95-205`) runs a mic level check, then `POST /api/livekit/preflight` (`invites.ts:266-343`). That creates a `preflight-<uuid>` room with a MICROPHONE-only token (320-327). The page publishes for 6 s and needs at least 50 packets (`lib/candidate-preflight-policy.ts:22-43`, policy `voice-v1`).
9. `POST /api/livekit/exchange` (`invites.ts:348-591`):
   - digest, expiry and revocation checks, plus a 5-minute same-bearer grace (359-403);
   - `checkExchangeConsentGate`, which also checks maintenance (405-416; implementation 214-261);
   - `waiting|in_progress` → reuse the room untouched (434-440); `created` → JIT `provisionRoomForCreatedSession('existing_session')` (441-474), 503 `screening_room_unavailable` on egress failure (462-468);
   - **browser worker gate**: `ensureReadyWorker(app 'project-hello-voice', pipeline 'browser')` + `createDispatch(room, 'browser-screener', {session_id, channel:'browser'})` (499-521; `lib/browser-orchestration.ts:105-176, 157-158`). It returns 202 `preparing` and leaves the invite unconsumed while the worker boots;
   - consume CAS (526-557); `createGrant` with the default 5-minute TTL (559-564; `candidate-access.ts:18`); `buildCandidateToken` with TTL `5m`, `canPublish/canSubscribe/canPublishData` and **no** `canPublishSources` (637-656).
   - The client polls up to 12 × 3 s (`CandidateJoinPage.tsx:62-63, 498-510`).
10. Live room (517-563):
    - `new Room({adaptiveStream, dynacast})`;
    - attaches remote **audio** only to a hidden `<audio>` (520-524, 677);
    - the agent's audio level drives the aura (525-532; `InterviewerAura.tsx:9-37`);
    - shows interviewer-only captions via `TranscriptionReceived` (533-556);
    - publishes the mic (562-563);
    - starts a local `MediaRecorder` of the mic only as fallback (369-389, 564).

**D. Worker** (`app/voice-livekit/agent.py`)
11. Boot: `cli.run_app(build_worker_options())` (12321-12322). `build_worker_options` (1946-2014) sets the named browser worker: `agent_name='browser-screener'`, `num_idle_processes=1`, `prewarm_fnc=_prewarm_post_machine_ready`. It returns at 2014, before the phone-only keys (2015-2067).
12. Prewarm (1877-1918) posts machine readiness to `/api/internal/voice-worker/ready-machine` (`worker_ready_api.py:44,166` → `app/api/src/routes/voice-worker.ts:183-257`).
13. `entrypoint(ctx)` (11837):
    - room ownership check (11844-11852);
    - **phone early return** (11854-11861);
    - `ctx.connect()` (11863);
    - `collect_prompt_metadata` is used only for room, session and correlation ids (11863-11873; `prompting.py:236-266`);
    - session id from metadata or `ROOM_SESSION_RE ^screening-<uuid>$` (78-81, 103-105).
14. Worker context: `_resolve_worker_context_with_retry` (11885-11905; 1609-1639; 3 attempts, 1.5 s backoff) calls `persistence.resolve_worker_context`, `POST {API_BASE}/api/livekit/worker-context` with bearer `WORKER_CONTEXT_SECRET` (`persistence.py:801-862`). The API side is `routes/livekit.ts:758-789` → `lib/worker-context.ts:129-199`: it checks `external_call_id==room_name` and status `waiting|in_progress`. On failure the worker calls `fail_session('worker_crash')` and returns.
15. `_run_session` (11913), sole caller at 11908:
    - provenance claim `set_session_provenance(screening_provenance(GEMINI_MODEL))` (11924-11937; `provenance.py:41,404-419`; CAS on `provenance IS NULL`, `persistence.py:238-290`); returns on anything except CLAIMED or ALREADY_MATCHING;
    - prompt `system_prompt(...)` + `opening_line()` (11941-11982); env-only fallback when there is no context (11967-11979);
    - `close_room_once` with 3 attempts of `_delete_livekit_room` (11986-12026; 1178-1216);
    - `activate_session` CAS `waiting→in_progress`, failing closed (12029-12034; `persistence.py:476-499`);
    - `participant_disconnected` sets `candidate_left_normally` (12040-12066);
    - parent span `voice_session` (12073).
16. Finalizer `complete_once` (12075-12135):
    - `drain_pending_writes`, bounded at 10 s (`persistence.py:74, 661-706`); any failed write → `fail_session('shutdown_forced')` (12097-12103);
    - otherwise `complete_session(conversation_complete)` (12113-12118), **then** `await trigger_scoring` (12119; `persistence.py:609-656`). The return value is ignored.
17. `_setup_session` (12169-12231): `session = _build_provider_session()` (12174 → 3375-3558, `phone_mode=False`):
    - Sarvam STT `saaras:v3`/`en-IN`; Sarvam TTS `bulbul:v3` `simran`, pace 1.0, temp 0.8; `openai.LLM(GEMINI_MODEL, GEMINI_API_KEY, GEMINI_BASE_URL)` (3501-3536);
    - `session_options={}` (3399);
    - handlers: `speech_created`, `user_state_changed`, `conversation_item_added` → `_record_turn_metrics(item,'webrtc')` + `tracked_write(record_turn)` + goodbye detection, `close` → finalizer (12176-12225);
    - `session.start(agent=Christy(system_text), room=ctx.room, record={'audio':True,'transcript':True,'traces':False,'logs':False})` (12227-12231), with no `room_options`.
18. Opener: `session.say(opening_text)` + `wait_for_playout`, then the bot turn is recorded (12238-12259).
19. Turns: free-form LLM. Each user or assistant item → `save_turn` into `transcript_turns {session_id, turn_index, speaker 'bot'|'candidate', text, turn_started_at_ms}` (12147-12162, 1236-1256; `persistence.py:423-473`). Interrupted assistant items and the duplicate opener are skipped (12186-12202).
20. Goodbye close: an assistant text matching `_FINAL_GOODBYE_RE` → cancel silence, `_close_after_playout` → `close_room_once` (12203-12218; 1060-1077).
21. Silence loop `_silence_termination_loop` (12261-12269; 1097-1146). Production values are 30 s prompt and 20 s end (`fly.toml:25-26`; code defaults 10/12 at 124-125). The copy is "Are you still there?…" then "…I'll end the screening here… goodbye." (1131-1145).
22. Residency cap `SESSION_MAX_RESIDENCY_SEC` (default 3600, range 60..21600, 389-391) → `residency_timeout` (12273-12288). Exception → `worker_crash` (12290-12296).
23. Close classification via `_classify_close_event` (1498-1606), overridden to `None` when the candidate left normally (12223).
24. The `finally` block cancels and gathers tasks and awaits the finalizer **unshielded** (12297-12318).

**E. After the call**
25. Scoring: `POST /api/internal/assess/:id` (`routes/assess.ts:41-58`, mounted at `app.ts:221`) → `runAssessment` (`services/assessment.ts:147+`). The handler keeps running if the worker disconnects (nothing wires req/res `close`).
26. Browser `/complete` (`livekit.ts:422-509`; client `CandidateJoinPage.tsx:431-471`, pagehide keepalive 251-272):
    - needs a valid grant and at least 1 transcript turn;
    - CAS `in_progress→completed`;
    - `setTimeout(runAssessment, 8000)` (495-499);
    - `finalizeAuthoritativeRecording`.

    It returns **403 after the 5-minute grant expires**.
27. Machine release: the terminal-release loop runs every ~15 s (`worker-orchestration-runtime.ts:56,173-193`). `list_terminal_session_leases` has no grace (`0083:175-199`) and leads to `fly.stopMachine` (`worker-orchestration.ts:655-752`). The reaper runs every 90 s with 180 s grace (`env.ts:295`). A missing room counts as dead (`worker-orchestration.ts:813-858, 1055-1066`). The browser app has no `kill_timeout`, so Fly's 5 s default applies.
28. Recording finalize:
    - triggered by the 0038 terminal-transition trigger into `recording.finalize` (`0038:190-205`), plus `lib/recording/finalize-worker.ts`, `sweeper.ts:106-208` and the recruiter-play on-demand path;
    - `finalizeAuthoritativeRecording` (`recording-egress.ts:1089-1340`) stops and polls egress, downloads the whole object, rejects empty or oversize files, hashes, and links via RPC with hard-coded `'audio/ogg'` for non-phone sessions (1150);
    - the phone branch is selected by `session.mode==='live'` (1156, 1225, 1284).
29. Recruiter playback: `GET /api/recordings/:id/download` (`routes/recordings.ts:392-655`) re-hashes the full object, then returns a 300 s signed URL. Players are `<audio>` only (`RecordingPlayer.tsx:309-324`, `RecordingCard.tsx:106-112`). Click-to-seek uses `turn_started_at_ms - recording_egress_started_at_ms` (`routes/screening.ts:95-170`).

---

## 4. Isolation boundary

### 4.1 Gating conditions that separate the lanes today

| Gate | Where | Strength |
|---|---|---|
| Fly app + env (`PHONE_AGENT_NAME` vs `BROWSER_AGENT_NAME`) | `fly.toml:51-52`, `fly.phone.toml:418`; validator rejects `PHONE_AGENT_NAME`/`PHONE_DRAIN_TIMEOUT_SEC`/`PHONE_PER_MACHINE_AGENT_NAME` in `fly.toml` (`validate-voice-worker-apps.mjs:298, 347-348, 390-391`) | Runtime; per-app env does not cross apps |
| Process-level early return | `agent.py:11854-11861` | Hard: code after 11862 and inside `_run_session` is browser-only |
| Room ownership | `_worker_handles_room` `agent.py:1932-1943`; `phone.is_phone_room` `phone.py:336-346` | Symmetric; the browser takes every non-phone, non-preflight room |
| Explicit named dispatch | API → `browser-screener` / `phone-screener[-<machine>]` | Runtime; name agreement is checked only at runtime (api `fly.toml` comment) |
| `phone_mode` kwarg | `_build_provider_session` `agent.py:3400-3499, 3514, 3519, 3528-3536, 3554` | In-function branch; browser branch is test-pinned |
| `name_unverified` flag | `prompting.system_prompt` `prompting.py:143-166`; phone call at `agent.py:3097` | Shared function with a phone-only block |
| Room prefix / session mode | `screening-` vs `phone-`; `call_sessions.mode` `'browser'` (`livekit.ts:189`, `ashby/runtime.ts:410`) vs `'live'` (`phone-runtime/read.ts:72`) | API-side; `recording-egress.ts` branches on `mode==='live'` |
| Scorer lane | `isPhone` from `external_call_id` prefix `phone-` (`assessment.ts:175-176, 912-914`) | Everything non-phone, **including text simulation** (`screening.ts:367`), takes the browser branch |
| Metric channel labels | `'webrtc'` (`agent.py:12193`) vs `'phone'` | Observability only |

### 4.2 Shared code and the risk of editing it

**voice-livekit (ships to both apps):**

| Symbol | Phone uses it at | Rule for R1 |
|---|---|---|
| `prompting.system_prompt / opening_line / DEFAULT_QUESTIONS / format_*` | `agent.py:3097-3111` (`_phone_instructions_text`) | **Do not edit.** Sha-pinned; phone-leak test `test_phone_gate.py:17587-17605` |
| `_build_provider_session` | `phone_mode=True` path; `_build_phone_provider_session` must call it (`test_phone_gate.py:5918-5928`) | Do not change the default branch. Any R1 parameter must default to today's behaviour; keep exactly one `AgentSession(` |
| `persistence.*` (lifecycle CAS, `save_turn`, `trigger_scoring`, `resolve_worker_context`, `WorkerContext`) | Phone pre-call `_phone_instruction_state` `agent.py:3135-3156` | Additive only; never rename or remove fields |
| `_classify_close_event`, `_delete_livekit_room`, `_record_turn_metrics`, `_record_provider_metrics` | `agent.py:9434, 11828`; metrics | Reuse; do not change |
| `CANDIDATE_SILENCE_*`, `SESSION_MAX_RESIDENCY_SEC` module constants | `agent.py:4314-4367, 8160` | Pass R1 values as parameters or R1-only env; do not change defaults |
| `build_worker_options`, `entrypoint` | Both | Byte-identity tests (`test_phone_drain.py:110-130`, `test_phone_agent_name.py:159-165, 235-256`) |
| `provenance.py` | **Imported** by `agent.py:53` (shared at import/deploy); **never executed** by the phone lane at runtime (correction, see §13) | Add a new R1 constant or helper; do not change `SCREENING_PROVENANCE_VERSION` |
| `closing.py` | Phone only (`agent.py:3805`) | Copy the pattern; do not edit |
| `phone.py` helpers (judge, validators, classifiers, warm-ups) | Phone | Copy the patterns into an R1 module; importing would bind R1 to `PHONE_*` env, a module-level breaker and transport (`phone.py:8708-8730, 4107-4108`) |

**API and DB (shared):**
- `lib/worker-context.ts` + `schemas/livekit.ts` (room regex `^(screening|phone)-<uuid>$`, :33) + OpenAPI `WorkerContext` (`additionalProperties:false`, `openapi.yaml:9011-9053`): R1 fields additive and **gated on R1 sessions** so the phone payload stays byte-identical.
- `services/assessment.ts`, `lib/scorecards/{prompt,scorer,domain,integrity,evidence,store}.ts`: these are the phone scorer as well (`phone-runtime/assessment-handler.ts:66-68`). Branch only on a field phone sessions can never carry.
- `lib/session-lifecycle.ts`: statuses and terminal reasons form a TS/Python/SQL parity contract (75-80).
- `lib/recording-egress.ts` `finalizeAuthoritativeRecording`, `routes/recordings.ts`, `recording-integrity.ts`, `RECORDING_MAX_BYTES`, `recordings_v2`, `chk_call_sessions_recording_content_type`, the 0038 queue and sweeper.
- **consent_templates.** The exchange gate takes the newest active row by version with no locale filter (`invites.ts:238-258`). The phone RPCs take the newest active row by `updated_at` (`0114:3304-3314, 4044-4094`). The template route filters by locale (`candidate-consent.ts:135-175`). **No unique index on `is_active`.** Activating a new template or adding a required consent type changes phone admission (risk of `consent_subset_missing`).
- `candidates.status` and the candidate list "latest assessment" (`routes/candidates.ts:228-233, 309-316`; funnel `0090:345-349`) do not distinguish lanes.
- Orchestration: `voice_worker_leases` (pipeline CHECK `('phone','browser')`, `0079:89`), a single org-scoped `FLY_API_TOKEN`, and per-app reaper room schemes (`worker-orchestration-runtime.ts:113`).
- LiveKit project quotas: egress concurrency, participant-minutes, agent sessions.

### 4.3 Blast-radius rules for R1

1. **New modules only.** Put R1 in new files, e.g. `app/voice-livekit/r1_session.py`, `r1_prompting.py`, `r1_phases.py`. Enter them only after the phone early return.
   - Keep the literal `session = _build_provider_session()` inside `_run_session` (`test_phone_gate.py:5924`; present at `agent.py:12174`).
   - A parallel `_run_r1_session` or module is **not** forbidden by any pin (§13, item 12).
   - Add the new files to `Dockerfile:102` COPY and to the `quality.yml:149` `py_compile` list.
2. **Never edit** `prompting.system_prompt/opening_line/DEFAULT_QUESTIONS`, `closing.py`, `phone.py`, `fly.phone.toml`, or `_build_provider_session`'s `phone_mode` branches. Never pass `room_options` from inside `_run_session` (`test_phone_noise_wiring.py:262-276`).
3. **Discriminator.** Select R1 from **server-verified context** (worker-context), not from client or room metadata (SEC-13). Dispatch metadata may carry a hint for observability only.
4. **API changes.** Additive, nullable, and gated on the R1 discriminator. Phone payloads and phone scoring prompts stay byte-identical.
5. **Config.** R1 env vars only in `app/voice-livekit/fly.toml`. Declare them in `config/environment.schema.json` + `app/voice-livekit/.env.example` (`scripts/check-env-contract.mjs:62-117`). Use `R1_*` names, never `PHONE_*`.
6. **DB.** New migration `0115+`, additive: new tables or nullable columns. Do not alter the active consent template. Widen the content-type CHECK only on `call_sessions`, never `phone_call_attempts` (`0107:53-60`).
7. **Role data.** Never modify the phone SPA role row's scorecard, `interviewer_instructions`, `jd` or `screening_template`.
8. **Deploy.** Every voice-livekit merge redeploys phone. Merge outside the IST calling window (`fly.phone.toml:395-396`; runbook `phone-worker-orchestration-activation.md:417-418`).

### 4.4 Tests that prove phone is untouched (must stay green, unmodified)

- `app/voice-livekit/tests/test_phone_*.py`: `test_phone_gate.py`, including browser pins 16294-16442, factory pin 5918-5928, `update_instructions` ban 7778-7784, prompt-leak 17587-17605; plus `test_phone_drain.py`, `test_phone_agent_name.py`, `test_phone_noise_wiring.py`, `test_phone_preloop_close.py`.
- `test_browser_prompt_pin.py` (sha `164e954c…`, :34). `test_instrumentation.py` runs the real browser entrypoint and pins the 5-histogram set, one counter, and finalize delta 4.0 (347-359, 437-498). `test_agent.py` pins silence, goodbye regex, Gemini model and URL, close mapping, and fail-closed activation (264-761). `test_prompting.py:90-96`. `test_docker_packaging.py:126-139`.
- Scripts and CI: `scripts/validate-voice-worker-apps.mjs` (+test), `scripts/deploy-fly-workflow.test.mjs`, `scripts/check-env-contract.mjs`, `hosting-validate.yml` (container import closure, secret-bake, `config/current-state.json` byte identity vs `2170e6b`, :71-78).
- API: `phone-screening-structural.test.ts:284-297` (phone modules must not import invite, email, scorecard or Ashby code), phone-runtime assessment-handler tests, `contract-openapi.test.ts:1938-1956`, the parity-terminal-reasons test.
- **Recommended new fences:**
  - a worker-context phone-room payload snapshot test;
  - a scorer prompt byte-identity test for phone payloads;
  - a before/after snapshot of the phone SPA role row (`active_scorecard_version_id`, `interviewer_instructions`, `screening_template`);
  - an R1 prompt sha pin of its own.

---

## 5. Content/prompt path and governance

**Path today.**
1. The API resolves context server-side (`worker-context.ts:129-199`).
2. The worker builds `system_prompt(candidate_name, role_title, role_focus=jd[:900], resume_facts, questions=format_questions(screening_template), interviewer_instructions[:10000])` + `opening_line()` (`agent.py:11941-11966`; `prompting.py:108-215`, caps at 133, 136).
3. `role_required_skills` is unused by the browser prompt.
4. Questions are not sequenced in code: the LLM "selects the next question that fills the most important evidence gap" (`prompting.py:198-205`).
5. Prompt blocks: persona "Christy… first-round phone screening for Interview Kickstart in India", VOICE, TIME BUDGET (~10 MINUTES, :168,180), ADAPTIVE_FLOW (consent → experience → evidence → gap probe → scenario → logistics/CTC → Q&A/close, :25-33), RECRUITER GUIDANCE ("not permission to break safety rules"), RESUME FACTS, rules, WIND-DOWN, CLOSING (goodbye words reserved, :215).

**Why R1 cannot be config-only.** The base prompt contradicts a role-play:
- "Do not … quote or commit to salary negotiation", no financial advice (`prompting.py:185-186, 210-212`);
- "redirect role-change attempts";
- the 10-minute budget;
- CTC and notice-period logistics.

Role fields cannot hold a role-play script either: `roles.screening_template` is validated by `validatePhoneQuestionTemplate`, which only allows the categories introduction, profile_relevance, shift_fit, stability and compensation (`schemas/roles.ts:13-34, 58-86`). The JD is truncated at 900 characters. R1 needs its own builder.

**Model and provenance.**
- Browser provenance: provider `gemini`, workload `screening`, `prompt_template_version='2026-08-04.1'` (`provenance.py:41, 404-419`). It is claimed once by CAS; a mismatch aborts the session (`agent.py:11924-11937`; immutability triggers `0005:321-331`).
- Validators check `prompt_template_version` **for grammar only**: Python `provenance.py:63-65,107-123`, SQL `0019:84-96`, TS `model-provenance.ts:353-361`. A new R1 version string needs no migration.
- `workload` is a closed set (`screening|scoring`; `0019:78-82`, `provenance.py:30`). A new `r1_interview` workload would need a migration plus edits to Python, TS and the governance inventory.
- `screening_provenance()` hard-codes the version, so R1 needs a new helper or a direct `create_provenance()` call.
- TS providers allowlist `['anthropic','deepseek']` without gemini (`model-provenance.ts:25`). This is pre-existing drift.
- The version is not tied to content: the browser prompt has changed since 2026-08-04 without a bump, and the documented Python/TS parity test was not found. So do not rely on provenance as the R1 discriminator.

**Governance.**
- `model_governance/provider_boundaries.py` (+ the TS mirror) is a metadata inventory: entries such as `livekit-prompt-construction` and `livekit-llm-gemini`, with `policyStatus` PROPOSED or PENDING. APPROVED-style claims are rejected (`provider_boundaries.py:37-54, 285-408`). Registering a new prompt file is not required. `model-governance.yml` is path-filtered (15-42).
- ADR-0002 is Accepted but partly stale (it still names Haiku). It says not to change the STT, TTS or conversation LLM without evaluation evidence (`docs/adr/0002…:17-23`). It is a process rule, not enforced by CI.
- The adversarial prompt-injection suite covers only the TS "Gopu" simulation prompt (`model-governance/adversarial.ts:6,34-36`). The Python LiveKit prompts get no automatic coverage.
- ADR format is enforced (`scripts/check-adrs.mjs:14-33`). The next free ADR is **0015** (latest is 0014).

**How an R1 script plugs in (options):**
- **(a) Recommended for v1: a versioned Python module.** `app/voice-livekit/r1_prompting.py` holds the persona, IK Data Science product facts ($9000 list; $500/$1000/$1500 discounts by payment plan; 6 months; modules), the objection bank, phase scripts, and the fixed role-play announcement line. Add an R1 sha pin test and an R1 `prompt_template_version` constant. The R1 role row carries only the title and JD.
  - Instructions go in the Agent constructor (stable prefix for implicit caching, `agent.py:9571-9576`).
  - Phase and tracker state ride in a per-turn developer message in `on_user_turn_completed` via `turn_ctx.add_message` (pattern at `agent.py:4404-4414`; `phone.py:4143-4191, 14351-14415`).
- **(b) Recruiter-editable content.** Use a new immutable-versioned table (e.g. `role_interview_configs`, following the 0088 pattern) served through worker-context. This adds UI, API, OpenAPI and governance surface.
- **(c) `roles.interviewer_instructions`** (up to 10k characters). This is fragile because it would be appended to the shared screening prompt. Not recommended.
- **Governance bookkeeping (recommended, not CI-required):** a boundary entry `livekit-r1-prompt-construction` in both inventories plus `docs/model-governance/provider-boundaries.md`, and an ADR-0015 for the R1 lane, any audio-only reversal, and any model or voice change.

---

## 6. Session lifecycle and data model

**API routes on the browser path:**

| Route | File | Notes |
|---|---|---|
| `POST /api/livekit/start` | `routes/livekit.ts:136-309` | Recruiter; `role_id = candidate.role_id`; provisions room + egress immediately; sets `candidates.status='screening'` |
| `POST /api/livekit/invite` | `routes/invites.ts:126-198` | Owner/admin; session must be `created`/`waiting`; 24 h digest |
| `POST /api/candidate-consent/status`, `GET /template`, `POST /submit` | `routes/candidate-consent.ts:68-286` | Invite-scoped |
| `POST /api/livekit/preflight` | `invites.ts:266-343` | `preflight-<uuid>`, mic-only, 2-minute token |
| `POST /api/livekit/exchange` | `invites.ts:348-591` | Consent gate, JIT provision, worker gate, grant, JWT |
| `POST /api/livekit/grant/recording` | `livekit.ts:348`; `invites.ts:596` | Grant-gated |
| `POST /api/livekit/:id/complete` | `livekit.ts:422-509` | Grant-gated; 8 s `setTimeout` scoring |
| `POST /api/livekit/:id/recording` | `livekit.ts:522-753` | Fallback upload; 409 when egress is authoritative (598-603) |
| `POST /api/livekit/worker-context` | `livekit.ts:758-789` | Worker bearer; shared with phone |
| `POST /api/internal/voice-worker/ready-machine` | `routes/voice-worker.ts:183-257` | Machine readiness |
| `POST /api/internal/assess/:id` | `routes/assess.ts:41-58` | Worker scoring trigger |
| `POST /api/assess/:id`, `/:id/rescore` | `assess.ts:62-91, 103-164` | Admin; rescore is API-only (no UI) |
| `GET /api/recordings/:id/download`, `POST /:id/revoke` | `routes/recordings.ts:392-655, 671-719` | Recruiter / admin |

Public allowlist: `lib/auth.ts:585-603`. Rate limit on `/api/livekit` is a strict 20/min per user and 300/min per IP globally (`app.ts:372`).

**Session state machine** (`lib/session-lifecycle.ts:53-114`; DB `0006`):
- Statuses: `created → waiting → in_progress → completed|failed|cancelled|expired`.
- `created` may only go to `cancelled` or `failed`, not `expired` (102-110).
- Terminal reasons (64) include `conversation_complete`, `assessment_done`, `shutdown_forced`, `provider_error`, `worker_crash`, `residency_timeout`, `recruiter_cancelled`. They have TS/Py/SQL parity (75-80).
- Worker authority: `activate_session` (`persistence.py:476-499`), `complete_session` (502-551), `fail_session` (554).
- The scorer flips `conversation_complete → assessment_done` (`assessment.ts:736-740`).
- Candidate statuses: `new, queued, screening, screened, advanced, rejected` (`0004_hardening.sql:135`).

**Tables relevant to R1 (migration of origin):**

| Table / column | Migration | R1 relevance |
|---|---|---|
| `roles` (title, jd, required_skills, screening_template) | 0001:16-24; +`interviewer_instructions` 0046; +`active_scorecard_version_id` 0088:81-84; +`agent_name` (unspoken, non-unique) 0100:31-45 | R1 role row; no kind/round column |
| `candidates` (single `role_id`, status) | 0001:38-57; status CHECK 0004:135 | Never repoint a phone candidate's role (`0114:3917-3923, 3936-3941` → identity_mismatch / mapping_not_enabled) |
| `call_sessions` (`role_id`, `mode` CHECK `browser|live|simulation`, provider default `'pipecat'`, API writes `'livekit'`) | 0001:63-76; 0004:141-144; 0006; `owner_id` 0007; recording cols 0014/0021/0025; `phone_engagement_id` 0107:24-28 + live-unique 0112:74-76 | Best place for an R1 marker (e.g. `interview_kind` or `r1_interview_id` FK) |
| `transcript_turns` (turn_index, speaker CHECK `bot|candidate`, text, `turn_started_at_ms`, `is_gate`, `source_item_id`) | 0001:80-88; 0004:145-148; 0026:70-87; 0067:70-78; 0071:52-63 | No phase/persona column; `is_gate` excludes turns from scoring (`assessment.ts:250-255`) |
| `assessments` (`source` `browser|phone`, v2 cols, `score_scale_max`, partial shape) | 0001; 0044:273-283 (unique only for phone, 320-322); 0088:143-181; 0091; 0093 | No unique index for browser rows (TOCTOU) |
| `candidate_invites`, `candidate_access_grants` (`room_name` CHECK `^screening-[0-9a-f-]{36}$`) | 0007:190-209, 238-256 (254) | Keep the `screening-` prefix |
| `consent_templates` / `consent_records` | 0001; 0013:25-37,125-160; 0017; 0069; phone use 0047:159-209, 0114 | Global active template |
| `job_queue` / `job_dlq` (no queue-name allowlist, `dedup_key`) | 0009:18-43 | Durable R1 scoring queue needs no CHECK change |
| `voice_worker_leases` (pipeline CHECK `phone|browser`) | 0079:89,196,259; 0083 | A separate R1 pipeline needs a migration |
| Scorecards: `scorecard_metric_library`, `role_scorecard_versions`, `role_scorecard_version_metrics` (10000 bps trigger, immutable) | 0088:19-141; defaults trigger 0089:56-80; partial 0091; 1-4 scale 0093 | R1 metrics are config-only |
| Ashby: `ashby_job_mappings` (one live per job), `ashby_application_links` (one per application; single `session_id`/`invite_id`), `ashby_operations` | 0029:35-131, 297-322; `screening_mode` 0047:9-22; cycles 0057; cycle scorecards 0059; archive/live-unique 0109:57-61 | Not usable for R1 v1 without schema work |
| `phone_engagements` | 0042:321-360 | Template for an R1 aggregate |

**Latest migration on main: `0114_phone_outcome_integrity.sql`. Next is `0115`.** (Listed in the worktree; HEAD `eec54af`.)

**Room and dispatch metadata.**
- Browser room metadata: `{session_id, room_name, correlation_id}`, no channel (`room-provisioning.ts:68-74`).
- Browser dispatch metadata: `{session_id, channel:'browser'}` (`browser-orchestration.ts:157-158`). The worker does not read `channel` today.
- Phone rooms carry `channel:'phone'` (`livekit-phone-dial/phone-room.ts:81-84,129-131`). Preflight rooms carry `channel:'preflight'` (`invites.ts:312`).

**Worker-context payload** (`worker-context.ts:22-42, 171-197`; `persistence.py:749-798`; `openapi.yaml:9011-9053`): `session_id, candidate_id, role_id, candidate_name, room_name, status, role_title (roles.title), role_focus (roles.jd), role_required_skills, screening_template, interviewer_instructions, candidate_evidence` (an allowlisted, bounded resume projection, 73-116).
- There is no interview kind, round, persona, voice, or language field.
- The role is resolved from **`call_sessions.role_id`** (133-180), not `candidates.role_id`.
- The Python parser ignores unknown keys. OpenAPI must be updated for any added field.

---

## 7. Candidate UI and recording/video

**What exists.**
- **Join flow** (`CandidateJoinPage.tsx`, `AudioReadinessStep.tsx`, `InterviewerAura.tsx`, `CandidateScreeningEndedPage.tsx`, `candidate-preflight-policy.ts`, `capability-check.ts`): fragment-only invite, server-held consent, mic readiness plus a network test in a disposable room, an exchange poll loop, the live room, keepalive completion, and an end page.
- The page uses plain `livekit-client ^2.20` (`app/web/package.json:25`), not `@livekit/components-react`.
- During the live call the candidate sees the role title, the IK-logo aura driven by the agent's audio level, interviewer-only captions, and Mute/Leave (`CandidateJoinPage.tsx:525-556, 663-667`).
- There is no timer, phase indicator, role-play banner, self-view, or video tile.
- There is no signalling from the worker to the page. The page recognises the agent via `ParticipantKind.AGENT` or attribute `hello_speaker`, but the browser worker never sets attributes, data, or RPC (`CandidateJoinPage.tsx:21, 525-539`; the only `set_attributes` is phone, `agent.py:1853`).
- **Recordings:**
  - Authoritative: API RoomComposite egress, audioOnly OGG, mixed candidate and bot audio (`recording-egress.ts:264-305`).
  - Fallback: candidate-mic-only `audio/webm` `MediaRecorder` (`CandidateJoinPage.tsx:369-389`), uploaded only on `fallback_required`. It is unreachable after 5 minutes because of the grant.
  - Separately, `session.start(record={'audio':True,'transcript':True})` is the LiveKit Agents session recorder. It writes a stereo OGG plus transcript, uploaded only to LiveKit Cloud observability when the URL is `*.livekit.cloud/.run` or `LIVEKIT_OBSERVABILITY_URL` is set (wheel `job.py:51-59, 298-309`; `recorder_io.py:155-169`). It never captures video and never reaches our storage.
  - The phone in-worker `RecorderIO` (`recording.py`, `recording_api.py`) is phone-only (`agent.py:9755-9766`).
- **Production config** (secret names read live on 2026-10-05; values not read):
  - `project-hello-api` has the secrets `RECORDING_EGRESS_ENABLED`, `RECORDING_EGRESS_REQUIRED`, `RECORDING_EGRESS_S3_*`, `RECORDING_FINALIZE_WORKER_ENABLED` and `RECORDING_PROVIDER`.
  - The boolean flags share a digest with `PHONE_SCREENING_ENABLED`, which must be `'true'` for phone to work (`phone-screening/config.ts:322`).
  - So browser egress is **probably** enabled and required in production (medium confidence). If so, today's browser recording is mixed-audio OGG.
- **Playback**: `<audio>` only, on Candidate Detail (`TranscriptionSyncWorkspace`, `CandidateDetailPage.tsx:393`), Ashby scoped review (`AshbyScopedReviewPage.tsx:146`) and Session Detail (`SessionDetailPage.tsx:44, 217-229`). The download filename map knows only `audio/ogg|mpeg` (`recordings.ts:602-622`).

**What is missing for "video call recording" (every item below is absent today):**
1. **Camera capture.** Needs `createLocalVideoTrack`/`setCameraEnabled`, a self-view, a camera picker and preview in readiness, camera `NotAllowedError` copy, an A/V preflight policy beyond `voice-v1`, and the CAMERA source on the preflight token (`invites.ts:320-327`).
   - `candidate-webrtc-structure.test.ts:10-13`, `docs/design/candidate-webrtc-visual-acceptance.md:11,28` and ADR-0014 all forbid camera capture. They must be deliberately scoped to the screening flow or superseded.
2. **Token.** Set explicit `canPublishSources` (MICROPHONE + CAMERA; SCREEN_SHARE only for future coding rounds). Today the token allows any source (`invites.ts:647-653`), so a candidate could publish extra tracks that a composite egress would record.
3. **Egress.** An R1-only branch in `startAuthoritativeRecording`: `audioOnly:false`, MP4, a chosen layout (speaker or grid) or a participant/track egress, key `<sid>-egress.mp4`. It must be selected per session, never through the global default.
4. **Finalize and integrity.**
   - Content type per kind instead of the hard-coded `'audio/ogg'` (1150), plus an MP4 `ftyp` sniff (501-531).
   - A video size cap separate from `RECORDING_MAX_BYTES` (25 MiB in production, 50 MiB hard max; `env.ts:253-259`, `api fly.toml:41`).
   - Streamed hashing instead of whole-object buffering at finalize (`recording-egress.ts:1192-1218`) and at download (`recording-integrity.ts:113-136`, `recordings.ts:79-108`). The API VM is shared-CPU with 2 GB.
   - A 20-30 min composite is roughly 100-300 MB (estimate).
5. **DB.** Widen `chk_call_sessions_recording_content_type` (`0014:71-86`) to `video/mp4`, on `call_sessions` only.
6. **Storage and retention.** `recordings_v2` has no size or MIME limits in migrations (`0001:186-187`). The Supabase free tier is 1 GB (`PROTOTYPE-APPROVAL-LIVEKIT.md:38,80`), and ADR-0006 points to R2. Other gaps:
   - retention and DSAR key derivation assume `-egress.ogg` (`lib/retention.ts:1016-1035`);
   - there is no automated erasure (`eraseRecording` has no caller, `retention.ts:828`);
   - the privacy notice is a placeholder (`PrivacyNoticePage.tsx:21-31`).
7. **Consent.** Current copy says "call audio may be recorded" and "audio recording and transcription" (`0017:20,35`; `0069:33-41`). The `consent_type` enum value `recording` is documented as audio/video (`0013:28,133`). R1 needs an **R1-scoped** template selected only by the R1 path, with no change to the global active row and no new required type. Ashby-synthesised consent currently auto-satisfies the browser gate (`0047:171-184`), so R1 needs an R1-specific consent check.
8. **Capacity.** The LiveKit Build plan allows 2 concurrent egress (`env.ts:143-150`; medium confidence). Phone most likely records in-worker (`RECORDING_PROVIDER=worker`, inferred from `agent.py:211-221` and `fly.phone.toml:47-55`), so the slots are likely browser-only today. With egress enabled, an egress start failure blocks the join with a 503.
9. **Recruiter UI.** `<video>` in `RecordingPlayer`/`RecordingCard` when `content_type` is `video/*`, plus the extension map. Click-to-seek keeps working because the anchor comes from `EgressInfo.startedAt` (`recording-egress.ts:1270-1280`).
10. **Bot visual presence (optional).** Avatar or video output would need the page to attach remote video (today it ignores remote video, 520-524) and a vendor plugin. Bot vision needs `RoomOptions(video_input=True)`, which is off by default (wheel `room_io/types.py:113-114, 144-148`), **and** manual frame injection (`ImageContent`, `llm/chat_context.py:182-205`). The SDK forwards frames only to Realtime models (`agent_activity.py:1178-1183`). Any `room_options` must live outside `_run_session` (`test_phone_noise_wiring.py`).

---

## 8. Scoring/scorecards

**Pipeline.**
- Browser triggers: the worker `trigger_scoring` HTTP call (180 s, breaker), the `/complete` 8 s `setTimeout`, and admin routes. Phone uses the durable `phone.assessment` queue (`phone-runtime/config.ts:57`; `assessment-handler.ts:63-110`).
- `runAssessmentImpl` (`assessment.ts:147`):
  1. eligibility: `completed` + `conversation_complete`, or rescore (189-243);
  2. loads `speaker,text` where `is_gate=false`, ordered by `turn_index`, without timestamps (250-260);
  3. loads the role's active scorecard by `session.role_id` (298-300 → `store.ts:93-129`);
  4. v2 `scoreWithScorecard` (`scorer.ts:170-254`) with DeepSeek `deepseek-v4-pro`, reasoning `high`, 120 s per call (`api fly.toml:26-38`, `deepseek.ts:278-310`): prompt (`scorecards/prompt.ts:60-121`), fail-closed validation with one repair (`scorer.ts:110-132, 211-229`), renormalised partial weights (`domain.ts:382-407`), 0-100 overall, and recommendations at 65 (advance) / 45 (hold) / reject, hard-coded (`domain.ts:423-428`);
  5. a fail-soft integrity pass for role_fit and resume_conflicts (`integrity.ts:98-144`; 406-411);
  6. insert a v2 row (412-454, 563-664);
  7. evidence grade: browser is always `decision/complete_call` (`evidence.ts:156-158`);
  8. candidate status write (708-727);
  9. Ashby observer (759-766).
- Production precedent: phone scoring took about 4 minutes (`phone.py:1487-1490`).
- The v1 weights (communication 0.5, motivation 0.2, tone 0.1, role_fit 0.2; `assessment.ts:1136-1142`) apply only when a role has no active scorecard. The 0089 trigger gives every role one, so v2 is the effective path.

**What configuration alone can do.**
- Admins create library metrics with 4-level rubrics, each level 500 characters or less (`routes/scorecards.ts:133-176`; `schemas/scorecards.ts:34-54`; `contracts.ts:5-16`).
- Admins and interviewers attach 1-20 metrics to a role, with weights summing to exactly 10000 bps (`scorecards.ts:410-533`; trigger `0088:124-141`).
- A role may override only the per-metric **instruction** (1000 characters or less). Rubric, name and key are copied from the library (`schemas/scorecards.ts:95-102`; `scorecards.ts:443-455`), so sales-specific anchors belong in sales-specific library rows.
- There is no "section" or grouping concept.
- Library edits never change role snapshots (`0088:104-119`).
- "Ask Hello" drafts assume a generic phone screen (`metric-draft.ts:151`), so write R1 rubrics by hand.

**What needs code for R1.**
1. **Scorecard per R1.** Use a dedicated R1 role row (configuration only; recommended) or per-session scorecard selection (shared code; riskier). Before any R1 session is scored, re-save the new role to replace the 0089 defaults (night_shift_fit, compensation_fit, …).
2. **Prompt framing.**
   - The preamble is hard-coded to "a FIRST-ROUND phone-screening transcript" (`prompt.ts:76`).
   - Every bot turn is labelled `Interviewer:` (40-45), so learner lines are indistinguishable.
   - `evidenceRefs` are not checked against candidate turns (`domain.ts:219-231`), so quotes of learner lines pass.
   - Needed: an R1 prompt variant (role-play framing; bot lines labelled "Learner (simulated)" inside the role-play; score only the candidate), gated so phone prompts stay byte-identical.
3. **Phase metadata.** Add a nullable `transcript_turns.phase` (e.g. `intro|roleplay|wrapup`), written by the R1 worker, read only on the R1 branch. This follows the `is_gate` precedent. Without it, phase awareness is a heuristic: per-metric instructions that point the model at the announcement line.
4. **Integrity pass.** Skip it, or give R1 its own prompt, because role-play talk would show up as résumé conflicts.
5. **Evidence and auto-reject.**
   - `canAutoReject` is true for any browser reject that is complete (`evidence.ts:217-225`), and the status write overwrites everything except `advanced`.
   - An R1 that ends during the icebreaker but closes as `conversation_complete` can be scored. With v2 it would likely be `incomplete_evidence` → `screened`; with v1 it could be `rejected`.
   - R1 needs its own coverage grading (role-play reached, at least N candidate role-play turns) and a no-auto-reject / no-status-write policy.
6. **"Latest assessment" views** (`candidates.ts:228-233, 309-316`; funnel `0090:345-349`) would show R1 over the phone score unless filtered by kind.
7. **Durability.** Add an `r1.assessment` job_queue handler modelled on the phone handler, plus a unique index for R1 assessments, plus `v_funnel_failures` visibility (today only `phone.assessment` DLQ rows appear, `0091:178-186`).
8. **Scoring provenance.** `SCORING_PROMPT_TEMPLATE_VERSION '2026-08-05.1'` is shared (`prompts.ts:9`). Add an R1 version.
9. **Thresholds.** Make 65/45 configurable per scorecard if R1 calibration differs.

**Candidate R1 metric set** (configuration): probing/discovery, objection handling, urgency creation, negotiation/discount discipline, communication/rapport, and optionally product knowledge. Anchor them on the HR mock-call prep doc, for example: do not lead with the maximum discount; tie discounts to payment plans; tie urgency to cohort start.

---

## 9. Ashby/orchestration

**Today.**
- Each Ashby job maps to one role (one live mapping per job, `0109:57-61`).
- New mappings default to the single "Hello Christy" stage (`2358dbcc…`) as both the AI and TA stage (`screening-stage.ts:8-27`; `ashby-mission-control.ts:552-563`). `screening_mode` defaults to `phone_primary` (`0047:9-22`). The upsert RPC and the UI never set it (`0109:123-151`).
- The signal worker imports only when the current stage equals the mapping's AI stage. Every other stage returns `stage_not_ai` with no work (`signal-worker.ts:394-408`), and the stage-interest pre-filter knows only AI stages (`runtime-workers.ts:279-291`).
- Ingestion-ready **always** calls `ensure_ashby_phone_engagement`, without checking `screening_mode` (`runtime-workers.ts:1305-1313`; current RPC `0114:3843-4113`). So `browser_primary` would give both a browser invite and a phone dial. It is not an R1 switch.
- `stage_move` is never executed and `applicationChangeStage` has no production caller (`operation-worker.ts:79`). `external_stage_id` is constant (`0098:54-77`).
- Scorecard writeback is hard-wired to the Hello Christy feedback form (`workflow-stores.ts:522`) and to phone sessions (`0059:49-55`).
- The completion observer finds a link via `link.session_id` or `phone_engagements.session_id` (`workflow-stores.ts:585-623`). An R1 session in neither gets no writeback, which is safe.
- There is no candidate-facing email, SMS or WhatsApp. The email gate is hard-coded closed (`runtime-workers.ts:755,1792`; `invite-delivery.ts:163-167`; `notification-intent.ts:29-34`).

**How R1 could be triggered (options):**
- **A. Manual (recommended for v1).** A new "Send R1 interview" card on `CandidateDetailPage` (the existing cards are frozen, `CandidateDetailPage.tsx:526-554`). It calls a new route, e.g. `POST /api/candidates/:id/r1-interviews`, which:
  - checks eligibility;
  - creates an R1 aggregate row plus a `created` browser session with `role_id` = the R1 role and `mode:'browser'`, provisioned JIT at exchange (avoids the 10-minute-empty-room risk of `/start`, `livekit.ts:205-209` vs `invites.ts:434-440`);
  - does **not** set `candidates.status`;
  - creates an invite and returns `join_url` once (pattern: `ashby-mission-control.ts:801-851`, no-store, token-free audit).

  Delivery is copy-link only. Note `/start` quota accounting: exchange-path sessions are outside quota (`invites.ts:451-457`).
- **B. Ashby stage trigger (later).** A signal-worker branch for a mapped R1 stage plus the stage-interest set, keyed by a sibling `r1_job_configs` table (keyed by mapping id) so the one-live-mapping index and RPC signatures stay untouched. R1 writeback needs a new verified feedback form whose Score field titles equal the R1 metric names (`scorecard-autobind.ts:15-28, 165-190`). Whether Ashby accepts a second feedback submission per application is unverified (`0059:4-7`).
- **C. Auto after phone "advance".** Requires A, plus a policy hook in the phone completion path. Higher blast radius.

**Aggregate model (if chosen).** An `r1_interviews` table: candidate, optional link, r1 role, trigger source, states `pending→invited→in_progress→completed|expired|cancelled|failed|declined`, session and current invite, `expires_at`, reminder counters, a partial-unique "one active per candidate", and `cycle_number`. Add `call_sessions.r1_interview_id` with a live-unique index (pattern `0107`/`0112`). An `r1.sweep` scheduler loop expires invites and cancels the `created` session with an approved terminal reason (`lib/scheduler.ts`).

**Other constraints.**
- The Ashby Live Jobs role picker offers every active role (`AshbyMissionControlPage.tsx:438-453`). An R1 role could be bound to a phone mapping, which would make phone dial with the R1 prompt. Filter roles by kind.
- Do not create an enabled Ashby mapping for the R1 role in v1: any enabled mapping causes phone dialling.

---

## 10. Reusable mechanisms

**From the browser lane** (reuse as-is or clone into an R1 session function):
- Server-verified context with fail-closed retry (`agent.py:1609-1639`).
- The lifecycle skeleton in `_run_session`: provenance → activate → span → `complete_once` (drain, CAS, scoring, bounded metrics) → residency cap → `finally` (`agent.py:11913-12318`).
- `tracked_write`/`record_turn` (`agent.py:11993-12002, 12147-12162`).
- The silence loop with an injectable `wait_for_activity` seam, parameterised wording and windows (`agent.py:1080-1146`).
- `close_room_once`/`_delete_livekit_room`/`_close_after_playout`, and `_classify_close_event`.
- `_record_turn_metrics(channel=…)` / `_record_provider_metrics`; use an `'r1'` label.
- The orchestration plumbing (named worker, ready-before-dispatch, 202 preparing).
- The egress, finalize and integrity machinery.
- `phone_canary.py:241-342`, which shows a different Agent class riding the shared factory through injected `session_factory`/`agent_factory`.

**Phone patterns to copy (not import):**
- `closing.ClosingStateMachine` (`closing.py:1-48`) as the template for a forward-only R1 phase machine: `ICEBREAKER → ROLEPLAY_ANNOUNCED → ROLEPLAY → ROLEPLAY_EXIT → WRAPUP_QNA → CLOSING_PENDING → CLOSING_PLAYED`, raising on invalid transitions.
- **Per-turn developer instruction** in `on_user_turn_completed` with a discard-sink failsafe (`agent.py:4404-4414`; `phone.py:4143-4191, 14351-14415`). This is the proven adherence seam.
- Byte-stable constructor prompt for prefix caching (`agent.py:9571-9576`).
- **Shadow tracker** shaped like `judge_phone_coverage` (`phone.py:12316-12426`): injectable infer, bounded timeout, fail-closed category, telemetry, off the speech path. Use a new payload and prompt ("which of probing / objection / urgency / negotiation has the candidate shown; what pressure point is still owed"). Findings feed an "owed move" latch consumed by the **next** learner turn (`agent.py:4035-4056, 7282-7385`). The existing judge cannot be reused: its payload and prompt are interviewer-coverage specific (`phone.py:12149-12169`).
- Deterministic scripted transition: speak the fixed "I'm going to role-play as a learner for evaluation" line via `session.say`. Optionally pre-render the TTS frames (`agent.py:10246-10340`). If variants are generated, use compose → validate → fixed fallback (`phone.py:8932-8969, 748-768`). Avoid a double question at the transition (`phone.py:707-718`).
- Background latency mask (`phone.py:7598-7611`), PII-free warm-ups (`phone.py:8800-8927`), `bounded_phone_chat_context` (32/20 items, `phone.py:4101-4140`), and the Sarvam first-fragment early-flush `tts_node`. Without the early flush, measured first audio is about 2.9 s (`phone.py:1384-1424, 3950-4019`); the browser pays this gap today.
- Do **not** reuse interviewer validators or regexes: the question-act ceiling and `compensation_drift` would fire on "package" or "salary" (`phone.py:11164-11265, 9023-9025`), and callback/withdrawal detectors misfire on sales vocabulary (`phone.py:12497-12566`). Persona needs an instruction-echo leak check scoped to R1 control text (`phone.py:10567-10605`).

**LiveKit Agents 1.6.4 features** (verified in the downloaded wheel; never used in the repo):

| Feature | Evidence (wheel) | R1 use |
|---|---|---|
| Per-Agent `stt/vad/turn_handling/llm/tts` | `voice/agent.py:39-60`; resolution `agent_activity.py:3995-3998, 4059-4072` | Learner Agent with its own `sarvam.TTS(speaker=<male voice>)` and LLM instance |
| Handoff via a `@function_tool` returning an Agent | `generation.py:839-879`; `agent_activity.py:3109-3116` | `begin_roleplay` / `end_roleplay` tools |
| `session.update_agent` | `agent_session.py:1347-1364, 1408-1505` (emits an `AgentHandoff` item) | Worker-side fallback if the LLM never calls the tool |
| `on_enter` | `agent_activity.py:652-665` | Learner's first line |
| **`AgentTask`** (pause parent, run task, `complete(result)` merges chat excluding instructions, resume parent) | `voice/agent.py:723-983` (966-976) | **Best fit**: interviewer → learner role-play → interviewer wrap-up |
| `TaskGroup` (beta) | `beta/workflows/task_group.py:46-61` | Avoid (beta) |
| New Agent has an **empty** `chat_ctx` unless one is passed | `voice/agent.py:80` | Pass a curated context to the learner |
| STT and turn-detector stream carry over only with the same objects and default `stt_node` | `agent_activity.py:668-692` | Override only tts/llm |
| `update_instructions` rewrites the top system message | `agent_activity.py:452-467` | Ignored behaviourally on live calls (`phone.py:4021-4028`); do not rely on it |
| Sarvam `bulbul:v3` speakers: 16 female (incl. `simran`), 14 male (`shubh, rahul, amit, ratan, rohan, dev, manan, sumit, aditya, kabir, varun, aayan, ashutosh, advait`); invalid speaker raises | `sarvam/tts.py:286-355, 540-546` | Distinct learner voice |
| `RoomOptions.video_input` off by default; frames only to RealtimeModel | `room_io/types.py:113-114`; `agent_activity.py:1178-1183` | Vision is custom work |

**Turn-taking defaults the browser actually runs** (1.6.4, checked against the tag):
- VAD `inference.VAD('silero')`;
- turn detector `inference.TurnDetector()`, which is local `v1-mini` when not hosted or in dev mode;
- streaming endpointing min 0.3 s / max 2.5 s;
- interruption min_duration 0.5 s, min_words 0, `resume_false_interruption` true, timeout 2.0 s;
- preemptive generation on (for speech of 10 s or less);
- AEC warmup 3.0 s.

Sarvam STT sends finals only, with `aligned_transcript=False`, so adaptive interruption is unavailable. Turn mechanics were read from the 1.6.9 copy, so re-check them against 1.6.4. Consequences for R1:
- multi-sentence pitches will be cut at 0.3 s pauses;
- a candidate "mm-hmm" pauses the learner.

R1 needs its own `turn_handling` (starting points: endpointing about 0.6-0.8 s / 3-4 s, `min_words` 2-3, `min_duration` 0.6-0.8 s), set only in R1 code. The phone tuning precedent is `phone.py:1953-2054`.

---

## 11. Legacy and prior intent in docs

- **`app/voice` (Pipecat SmallWebRTC, `server.py:166,202`, local port 7860) is legacy and undeployed.** It has no Dockerfile or Fly config, is outside the deploy path filters (`deploy-fly.yml:156-174`), the env contract and CI compile, and has only the bootstrap commit (`f160dd2`, 2026-07-27). Docs call it a stale rollback/reference (`app/README.md:19-21`; `config/current-state.json:36-41`; ADR-0002:19). **Do not use it as an R1 base.**
- **Prior intent.** Nothing in PLAN.md, the ADRs, docs, the `.gsd` M001-M009 roadmaps or REBUILD_PLAN.md mentions multi-round interviews, R1/R2, role-play, avatars, video interviews or coding rounds. The only hints:
  - "a casual screening, not an R1 interview"; role-fit "depth" belongs in R1 (`docs/design/phone-single-llm-revamp-plan.md:61`; `assessment.ts:1136`);
  - the browser prompt calls itself a "first-round phone screening" (`prompting.py:168`).
- **Role history.** A "Program Advisor - India" role dates from the Pipecat rebuild. The seed is `app/api/scripts/seed-program-advisor.ts:1-45`: IK JD, 8-item screening template, stale persona "Maya". It is a starting point for the R1 role's JD only.
- **Audio-only decisions.**
  - ADR-0014 (Proposed): audio-only LiveKit interview with a 4-stage journey (`docs/adr/0014…:15-26`).
  - Visual acceptance checklist: no camera wording (`candidate-webrtc-visual-acceptance.md:11,28`).
  - `docs/runbooks/browser-compatibility.md:65`.
- **Stale documents that will mislead planners:**
  - `fly.phone.toml:5-10` and `browser-orchestration.ts:6-7` say the browser worker is unnamed and auto-dispatched; it has been named since #249 (2026-09-06).
  - Runbook §8 calls browser screening "the PRIMARY live path" (`phone-worker-orchestration-activation.md:291-295`), which is outdated.
  - `recording-finalize-convergence.md:237-240` says Ashby is disabled; `ASHBY_RUNTIME_ENABLED` is now a secret.
  - `config/current-state.json` (browser-only, Anthropic Haiku active, `noTelephonyCurrent=true`) is stale but byte-pinned.
  - `openapi.yaml` says `candidate_evidence` is "empty for browser rooms".
  - `.gsd/*` and `REBUILD_PLAN.md` are untracked and quarantined (`docs/repository-inventory.md:24,38`).

---

## 12. Constraints and risks

**CI gates every R1 PR must pass:**
- `quality.yml` runs on every PR. Checks:
  - current-state drift (27-28)
  - env contract (31-32)
  - deploy-workflow contract (33-34)
  - voice-worker app validator (35-36)
  - ADR format (37-38)
  - HR design system (39-40)
  - API typecheck, tests and coverage (90-97)
  - web lint, test, build and coverage (114-120)
  - audits and SAST
  - migration rollback verifier
  - worker `py_compile` of a **fixed file list** (148-149)
  - bare-`python3` worker `unittest` with no pip install (150-151): new tests must stub `livekit.*` in `sys.modules`, as `test_phone_gate.py:3972-4096` does
  - RNNoise DSP (158-166)
- `hosting-validate.yml` on `app/voice-livekit/**`: secret-bake, the Dockerfile import closure (`docker_import_closure.py`, :71), and `config/current-state.json` byte identity vs `2170e6b` (76-78).
- `secret-scan.yml`; `supabase-ci.yml` (migrations); `model-governance.yml` (if governance files change).

**Deploy behaviour.**
- Migrations run first, with a production function-drift check, before **any** app deploy (`deploy-fly.yml:190-215`). A bad R1 migration blocks phone deploys.
- Any voice-livekit change → `voice=true` **and** `phone=true` (157-165).
- The browser deploys on the on-demand path (`deploy-fly.yml:311-327`; `scripts/deploy-voice-orchestration.sh`).
- The phone redeploys every time and drains for at most 90 s. Merge outside IST calling hours.
- Fly secrets shadow `[env]`. On `project-hello-voice`, a `GEMINI_MODEL` **secret overrides `fly.toml:18`**, so the real browser model is unknown from the repo. Silence timers 30/20 have no secret.
- A third R1 Fly app would need changes to:
  - `validate-voice-worker-apps.mjs`, which hard-codes exactly two apps (285-303, 420-424);
  - the deploy workflow and its contract test;
  - the lease pipeline CHECK (`0079:89`) and `provision-voice-worker-pool.mjs:42,106-107`;
  - `worker-orchestration-runtime.ts:43-44,113`;
  - a new deploy token.

**Runtime risks for 20-30 min R1 sessions:**
- The 5-minute grant kills browser `/complete` and the fallback upload. Extend or refresh grants for R1 (the cap is 15 min, `candidate-access.ts:19,62-64`), or rely on the worker only.
- The 5-minute LiveKit JWT on a late reconnect is unverified.
- Terminal-release with no grace plus Fly's default 5 s kill on the browser app can kill the in-flight scoring POST and, in theory, the finalizer.
  - The SDK cancels the entrypoint about 20 s after shutdown (`agent.py:2171-2179`; `recording.py:846-855`; exact value unverified).
  - Mitigations: durable scoring queue, `kill_timeout` 60-120 s plus a bounded browser drain (the validator already accepts a browser `kill_timeout`, `validate-voice-worker-apps.test.mjs:183-184`), `ctx.add_shutdown_callback` or shield for the finalizer.
- One failed `save_turn` out of more than 100 → `shutdown_forced`, no scoring (`agent.py:12097-12103`; no retry, `persistence.py:446-473`).
- The browser worker sends no per-session heartbeat (reaper grace is keyed on `started_at`). It is spared only while the room has participants.
- The browser registers one shared name (no per-machine names), so the M009 wrong-machine-stop hazard still applies (runbook 321-329; medium confidence).
- Capacity: the browser pool is **one stopped machine**, one call per machine (`worker-orchestration.ts:100-104`). Cold boot is about 29 s (phone measurement). R1 needs a pool size decision.
- CPU: VMs are pinned to performance-1x after a CPU-starvation incident killed a live room (`fly.toml:54-62`). Any in-worker vision or avatar needs load testing.

**Conversation risks:**
- goodbye-regex close;
- out-of-persona silence copy in the learner's voice (`session.say` speaks in the active agent's voice);
- `prompting.py:211` forbids negotiation;
- `gemini-3.1-flash-lite` persona consistency over 15-20 minutes is unmeasured;
- there is no bounded chat context on the browser;
- persona leak of control text.

**Latency.** Unmeasured. The production metric sink is a no-op (`observability.py:579`; `set_metric_sink` is called only in tests), so `channel='webrtc'` turn-stage histograms are dropped. Only `voice_provider_*` stdout logs survive (`agent.py:589-607`). Other unmeasured factors: workers run in `sin`, the LiveKit Cloud region is unknown, and Gemini runs with no thinking control. **Measure first**: wire the sink or add paired log lines, as phone does at `agent.py:687-690, 728-731`.

**Cost and quotas.** Shared LiveKit Build meters: 2 concurrent egress, 5,000 WebRTC participant-minutes/month, 5 concurrent agent sessions (2026-09-03 snapshot). A 25-minute R1 is roughly 50 participant-minutes (candidate + agent). Other costs: video storage, DeepSeek scoring with longer transcripts and 2-3 calls each, and possibly a stronger R1 LLM.

**Governance.**
- ADR-0002 expects evaluation evidence for any LLM, STT or TTS change.
- Closed provider and workload enums apply if a new vendor (avatar) or workload is added.
- DPDP consent (D-010) and retention (D-009) are still open per PLAN.md; video broadens the PII class.
- Legal must sign off consent copy and the privacy notice.

**Windows/dev quirks.**
- The local `.venv` is a broken WSL symlink. The parent checkout shows `M app/voice-livekit/.venv`; do not commit it. livekit-agents is not importable in local Windows Python, so SDK claims were checked against downloaded wheels.
- Run worker tests in CI or WSL.
- Project memory (not re-verified here) records:
  - 3 known CRLF-related test failures in the offline e2e harness on Windows (`npm run e2e`);
  - heredocs eating backslashes.

  Prefer file-based scripts over inline heredocs. Expect those 3 failures locally; they are not R1 regressions.
- The prompt sha pin hashes Python string output, and Python reads source with universal newlines, so CRLF checkouts should not change the hash (inference).

---

## 13. Corrections from verification

1. **Provenance is not shared at runtime with phone.** The only `set_session_provenance` call is `agent.py:11929`, inside browser-only `_run_session` (sole caller 11908, after the phone early return at 11854-11861). The `phone_primary_model` branch at 11924-11928 is dead code for phone. `provenance.py` is shared only at import/deploy (`agent.py:53`). The worker is also **not** the only provenance writer: the API simulation path (`routes/screening.ts:216-221`) and the scorer (`assessments.provenance`, `assessment.ts:388,453`) write it too. Ashby scorecards read the scorer's version (`scorecard-v2-adapter.ts:400-401`).
2. **The browser AgentSession does have a VAD and a turn detector at runtime.** The repo passes none, but SDK 1.6.4 defaults to Silero plus local v1-mini, streaming endpointing 0.3/2.5, interruption min_words 0 (confirmed), and preemptive generation on. "No VAD / no turn detector" was wrong; "pure SDK defaults" is right.
3. **Browser session `mode` is `'browser'`, not `'live'`.** `livekit.ts:189` and `ashby/runtime.ts:410` write `'browser'`. Phone writes `PHONE_SESSION_MODE='live'` (`phone-runtime/read.ts:72`). `livekit.ts:271` `mode:'live'` is a **quota** mode, not the session column. A follow-up claim that "both lanes use mode='live'" is wrong. Mode and room prefix both distinguish the lanes.
4. **The production browser worker is NAMED `browser-screener`** with explicit dispatch (`fly.toml:51-52`; `agent.py:2008-2014`; live machine env). The "unnamed browser worker" statement and the comments at `fly.phone.toml:5-10` and `browser-orchestration.ts:6-7` are stale.
5. **The "Sales Program Advisor live mapping" evidence was overstated.** The `// live` comment in `mapped-roles.test.ts:13-16` is a fixture status label, next to `// paused-only` and `// drift`, not a production claim. Stronger evidence: `ScreeningKpis.test.tsx:455-462` says "Production today: two roles titled 'Sales Program Advisor'". `phone.py:651-655, 12500, 12553` show SPA is the phone population. Which row is mapped is DB-only.
6. **The current `ensure_ashby_phone_engagement` body is `0114:3843-4113`**, not `0047:29-227` (superseded by 0057, then 0114). The conclusion holds: it never reads `screening_mode`.
7. **`update_instructions` is not a technical dead end.** It rewrites the top system message (wheel `agent_activity.py:452-467`). Live phone calls showed the model *behaviourally ignored* long post-start instruction blocks (`phone.py:4021-4028`). Per-turn developer messages are the proven steering.
8. **Egress cap sharing.** Phone uses room-composite egress only when `RECORDING_PROVIDER != 'worker'` (`phone-worker.ts:2408-2432`). Evidence suggests phone already records in-worker (`agent.py:211-221`; `fly.phone.toml:47-55`), so the 2 slots are likely browser-only today (the value is a secret; confirm). Also, `RECORDING_EGRESS_REQUIRED` matters only when `ENABLED=false` (then provisioning always throws). With `ENABLED=true`, **any** egress start failure blocks the join (`room-provisioning.ts:183-216`; `invites.ts:463-468`).
9. **Recording authority.** Egress is authoritative when enabled. The browser `MediaRecorder` upload is a fallback only on `fallback_required` (`livekit.ts:598-603`), and it is dead after 5 minutes because of the grant. Production egress values remain unread. Names are confirmed as API secrets, and the values are probably `true` (medium confidence).
10. **Scoring model.** The v1 weights (`assessment.ts:1136-1142`) are a fallback. The 0089 trigger attaches the 5-metric v2 default scorecard to every role, so v2 per-role scorecards are the effective path.
11. **"Single active consent template" is a convention, not a constraint.** There is no unique index on `is_active`. Three selection rules exist: exchange by version with no locale; phone RPCs by `updated_at`; the template route by locale.
12. **Source pins are narrower than claimed.**
    - `test_phone_gate.py:5918-5928` requires the literal `session = _build_provider_session()` in `_run_session`, one `AgentSession(` in the builder, and the phone builder calling it. It does **not** forbid a parallel `_run_r1_session` or `AgentSession(` elsewhere.
    - The `test_phone_noise_wiring.py` matcher (58-69) catches only receiver name `session` with the `room_options` keyword in `agent.py`.
    - `test_instrumentation.py` is behavioural (it runs the real entrypoint with a fake context); a gated R1 branch passes it.
    - The pins favour a separate R1 function or module plus a new prompt builder. They do not decide between those two.
13. **Role binding.** Worker-context (`worker-context.ts:133-180`) and scoring (`assessment.ts:298-300`) read **`call_sessions.role_id`**. Only `/start` hard-codes `candidate.role_id` (`livekit.ts:186-191`). An R1 session can point at an R1 role without touching `candidates.role_id` through a new creation path.
14. **Live traffic.** The claim that browser screening is "the PRIMARY live path" is out of date. Ashby defaults suppress browser invites, there have been no browser-specific commits since 2026-09-07 (only phone PRs #313 and #329), and the pool has 1 stopped machine whose last start was the 2026-10-04 deploy. The recruiter card remains a live entry point. Medium confidence; production SQL was blocked.
15. **The browser grant clock** starts at invite exchange (grant minted just before connect), not at session start. The pagehide keepalive `/complete` is also grant-gated.
16. **The candidate-ui "normal end path"** (`/complete` → `recording_status`) works only for calls under about 5 minutes. The landing copy promises "Approx. 20 minutes", so the documented end path silently fails today for normal-length sessions.
17. **Browser latency "profile" does not exist.** `webrtc` turn metrics are computed but dropped by the no-op sink. There are no documented browser latency numbers.

---

## 14. Code-informed open questions for the owner (ranked)

1. **Gate per session, or replace the browser lane?** Should today's browser screening (recruiter "Create invite" card; Ashby `browser_primary` if ever used) keep working unchanged, with R1 selected per session?
   - *Why it matters:* the lane shares the worker, exchange gate, egress and finalizer, and every voice-livekit merge redeploys phone.
   - *Recommended default:* gate per session inside the existing `browser-screener` app on a server-verified discriminator. Keep the default browser path byte-identical. No third Fly app.
   - Owner runs read-only SQL first: browser sessions in the last 60 days by room prefix; `ashby_job_mappings.screening_mode`; `voice_worker_leases where pipeline='browser'`.

2. **Which role row is R1?** Two production rows are titled "Sales Program Advisor". Is one idle and unmapped, or should we create a new one?
   - *Why:* scorecard and prompt are per `call_sessions.role_id`. Editing the phone SPA row changes phone scoring and prompts. New roles get phone default metrics.
   - *Default:* a new dedicated row, title "Sales Program Advisor", `agent_name` "R1 Role-play", R1 scorecard saved before the first session, never an Ashby mapping in v1.
   - SQL: `select id,title,agent_name,active_scorecard_version_id,created_at from screening_v2.roles;` plus the mappings query.

3. **What does "video call recordings" mean, and is it in v1?** Options: candidate camera plus bot in a composite MP4 for human review; the bot seeing the candidate (vision); an avatar for the bot.
   - *Why:* video means reversing ADR-0014 and the tests, an egress change, a migration, streamed hashing, storage (Supabase free 1 GB vs R2), a possible LiveKit plan upgrade (2-egress cap), and new legal consent. None of the SDK `record=` paths capture video.
   - *Default:* Phase A ships R1 conversation, scoring and **audio** recording. Phase B adds camera-on plus composite MP4 for human review only, with no vision and no avatar (keep the IK aura). Phase B is gated on plan, storage and legal approvals.

4. **How is an R1 triggered and delivered?**
   - *Why:* the schema supports manual creation only. Ashby stage triggers need signal-worker changes and a sibling config table. No email or SMS transport exists.
   - *Default:* manual "Send R1 interview" card on Candidate Detail, a copy-link once (HR pastes it into email or Ashby), link valid 72 h, one retake. Ashby trigger and writeback later.

5. **Target duration and phase budget?**
   - *Why:* this drives grant TTL (cap 15 min today), `kill_timeout`, residency cap (3600 s is fine), silence windows, recording size, scoring latency, and participant-minutes.
   - *Default:* about 25 minutes total: icebreaker 3-4 min, announcement, role-play 15-18 min, exit and wrap-up 3 min. Hard cap 35 min.

6. **Learner persona and negotiation rules.** One fixed persona or randomised variants? Which objections must appear? Discount ceiling? Should the learner ever enrol?
   - *Why:* this determines whether each scored trait reliably surfaces and whether scoring is comparable across candidates.
   - *Default:* one seeded persona (Indian working professional considering the IK Data Science course) with 2-3 seeded variants. Fixed objection set: price $9000; time commitment alongside a job; outcomes and placement doubts; "need to discuss with family"; "I'll start next quarter"; a competitor or cheaper option.
   - The learner pushes for the maximum discount and only concedes when the candidate creates urgency and ties discounts to payment plans. The role-play ends in a committed next step, not a closed sale.
   - Live competency tracker steers which pressure point is owed next.

7. **Learner voice and interviewer identity?**
   - *Why:* a distinct voice needs an Agent handoff or `AgentTask` with a per-Agent `sarvam.TTS`. That is supported in 1.6.4 but unproven in the repo, so plan a spike.
   - *Default:* the interviewer stays "Christy" (`simran`). The learner uses a distinct male `bulbul:v3` voice (e.g. `rahul`/`aditya`). Plus the explicit verbal announcement.

8. **Character-break and role-play exit rules?**
   - *Why:* this drives the phase machine and why the goodbye regex must be phase-gated or replaced by an explicit end tool.
   - *Default:* the learner stays in character. An explicit "pause / is this the test?" gets a one-line interviewer aside, then resume. The bot ends the role-play on a time or turn budget or on a candidate close attempt. The interview ends only through an explicit end tool in the wrap-up phase.

9. **Scoring policy.**
   - *Why:* the shared scorer frames transcripts as a phone screen, labels learner lines "Interviewer", auto-rejects browser sessions, and overwrites the candidate status and "latest" score.
   - *Default:* 5 hand-written metrics — probing/discovery, objection handling, urgency creation, negotiation/discount discipline, communication/rapport — equal or owner-set weights. Icebreaker scored only for communication. Learner lines are never evidence.
   - R1 never auto-rejects, never writes `candidates.status`, and is hidden from the "latest assessment" views. Recommendation is for human review. Scoring is durable (`r1.assessment` queue).

10. **LLM for R1.**
    - *Why:* persona consistency over 15+ turns on `gemini-3.1-flash-lite` is unmeasured. The browser `GEMINI_MODEL` is actually set by a secret. ADR-0002 expects evaluation evidence.
    - *Default:* a new `R1_LLM_MODEL` env var (browser app only), chosen by a small offline eval (flash-lite vs flash) on persona consistency, objection escalation and latency.

11. **Consent copy.**
    - *Why:* the global template is read by phone admission. Ashby consent auto-satisfies the browser gate. Copy says "audio".
    - *Default:* a separate R1 consent template (AI role-play evaluation, plus video if Phase B) selected only by the R1 path and shown to every R1 candidate. Legal approves the wording.

12. **Writeback and status after R1.** Write R1 results to Ashby or move stages?
    - *Default:* no in v1. HR reads the scorecard in our UI. Ashby writeback needs a new feedback form with Score fields named exactly like the R1 metrics.

13. **Future coding rounds.**
    - *Why:* decides whether to build a generic `interview_kind` plug-in now and whether the token should ever allow SCREEN_SHARE.
    - *Default:* introduce the discriminator and a per-kind module pattern now. Build only Sales R1. Keep `canPublishSources` to MICROPHONE (+ CAMERA in Phase B).

14. **Operational acceptances.** Do we accept:
    - merging R1 changes only outside the IST calling window, since phone redeploys every time;
    - adding `kill_timeout` and drain settings to the browser app;
    - provisioning a browser pool of 2;
    - a LiveKit plan upgrade if video ships?

    *Default:* yes to all four (the plan upgrade only with Phase B).

15. **Production facts the owner must confirm (cannot be read from the repo):**
    - API secret values: `RECORDING_EGRESS_ENABLED`/`REQUIRED`, `RECORDING_PROVIDER`;
    - the `GEMINI_MODEL` secret on `project-hello-voice`;
    - the LiveKit Cloud region and plan limits;
    - the `/api/livekit/:id/complete` 403 rate in logs.

    *Default:* treat these as pre-plan verification tasks. Owner runs `fly ssh console -a project-hello-api -C "printenv RECORDING_EGRESS_ENABLED RECORDING_EGRESS_REQUIRED"` and the SQL in Q1/Q2.