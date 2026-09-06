# Phone worker — cost & scale plan (LiveKit egress + Fly on-demand orchestration)

**Status:** PLAN for approval. No implementation until approved. **Date:** 2026-09-03.
**Author:** engineering (with owner). **Scope:** phone screening path only; browser/WebRTC untouched unless noted.

---

## 0. Evidence baseline (measured, last 30 days, LiveKit dashboard)

Project is on the **Build (free)** plan. All *minute* meters are inside free limits; the pressure is **concurrency**:

- Concurrent **egress** requests: limit **2**, peaked **3/2 → OVER** (3rd simultaneous recording dropped). 🔴
- **Agents deployed on LiveKit Cloud**: limit **1**, at **1/1**. 🔴 (needs clarification — see §1.3)
- Agent recording/egress minutes: 613 / 1,000 ✅ · WebRTC participant min: 2,847 / 5,000 ✅ · third-party SIP: 223 / 1,000 ✅ · data: ~1.8 GB / 50 GB ✅ · concurrent agent sessions: ≤2 / 5 ✅.

Fly today: phone worker `performance-1x / 2 GB`, **ALWAYS_ON = $32.19/mo** running 24/7 even when idle. perf-1x is **pinned** after the 2026-08-29 CPU-starvation incident (shared CPU killed a live call). Stopped machine = only rootfs storage ~$0.15/GB/30d.

Code facts:
- Recording = `startRoomCompositeEgress(..., {audioOnly:true})` → our own S3 (`recordings_v2`), consumed via signed URL + SHA-256 re-verify (`app/api/src/routes/recordings.ts`, `app/api/src/lib/recording-egress.ts`, `.../livekit-phone-dial/egress-output.ts`).
- Dial = `admit_phone_attempt` RPC → `createSipParticipant(trunkId, number, room)` → `dispatch.createDispatch(room, "phone-screener")` (`app/api/src/lib/phone-runtime/livekit-clients.ts`).
- **No pre-dispatch worker-presence gate** — only post-hoc `worker_never_joined` canary detection (`app/api/src/lib/phone-canary1/`).

---

## 1. Plan 1 — get off the egress-concurrency wall without paying $50

### 1.1 Why not just pay Ship ($50)
Ship raises concurrent egress and agents, but the binding limit is **egress concurrency**, which we can remove for pennies. Minutes are not the problem.

### 1.2 The fix: recorder-participant, not Cloud egress
You **cannot** register a self-hosted egress service against LiveKit **Cloud** (Cloud runs egress internally — that's the source of the 2-cap). Cloud-compatible options, in order of preference:

**Option A (recommended): record locally, drop the egress API.** Mix candidate audio + agent TTS → MP3 → upload to the **existing** `recordings_v2` bucket, preserving the SHA-256 + signed-URL contract. This never touches the egress-concurrency-2 limit. Two placements — and the choice hinges on **which shared meter recording consumes**:
- **A2 — in-worker recording (RECOMMENDED).** The worker is already a participant that subscribes to the candidate track and generates the TTS track, so it mixes/encodes from tracks it **already has** — **no new participant, 0 extra WebRTC participant-minutes, 0 extra concurrency slot.** Recording therefore does **not** compete with the candidate pipeline's WebRTC budget. Cost = mix+encode CPU on the pinned path → offload the MP3 encode to a subprocess/thread and **load-test on perf-1x** before trusting (Aug-29 incident).
- **A1 — separate recorder-participant** (sidecar/own LiveKit connection). CPU-isolated, but it **joins as a participant** → adds a concurrency slot and ~doubles WebRTC participant-minutes per call, **competing with the candidate pipeline's shared budget** (concurrent participants 100; WebRTC min 5,000/mo). Fallback only if A2's CPU proves too heavy.

**Recording guardrails (either placement):** (1) **fail-open** — if recording can't start/continue, skip it and log; never block the screening. (2) Alert at ~70%/90% of the WebRTC-minutes meter. Rationale on limits: LiveKit enforces the concurrent-participants (100) and monthly WebRTC-minutes (5,000) caps **at join time** — it rejects new connections, it does **not** terminate live sessions; recording is always secondary to the call proceeding.

**Option B (endgame, only at high volume): self-host the whole LiveKit stack** (server + SIP + egress) on Fly. Removes *all* Cloud limits/meters but is heavy; the existing `docs/LIVEKIT-PRODUCTION-FRAMEWORK-AND-COST.md` prices it at **$162–410/mo** — points up, not down. Not our sub-$50 path now.

**Recommendation:** Option **A1**. Scales 1:1 with workers, keeps us on **Build/free**, cost ≈ Fly per-second only.

### 1.3 Resolved / must-confirm
- **"$50" reconciliation — RESOLVED:** owner confirms the project is on **Build (free)** today; there is **no current $50 LiveKit charge**. Plan 1's goal is therefore **stay on free — never be forced to upgrade** as production scales.
- **"Agents deployed" — RESOLVED (Agents dashboard, 2026-09-03):** header shows **Agents deployed: 2**, **Agent session minutes: 0 / 1,000**, **concurrent agent sessions: 0**. Two healthy external agents are registered — `phone-screener` (phone worker, 1 worker, 9 days ago) and `A_CZisWtVRtdBV` (the **unnamed browser worker**, auto-assigned ID, 1 worker, a month ago). Conclusions: (1) **self-hosted workers consume ZERO agent-session minutes** — that cost meter is never a lever for us; (2) we **already run 2 agents on free and both work**, so the "1 agent" quota is a managed-deployment limit that is **not gating our external workers**. **⇒ The only real Build wall is concurrent egress (§1.2).** No fallback needed. (Naming the browser worker in §2.3b B-i just replaces the `A_CZisWtVRtdBV` auto-ID with a real name; still an external worker, still 0 agent-minutes.)
- **Egress offload — meter impact depends on placement:** **A2 (in-worker, recommended)** reuses tracks the worker already has → **no extra WebRTC participant-minutes and no extra concurrency slot**; recording is invisible to the candidate pipeline's budget. Only **A1 (separate recorder-participant)** shifts load onto WebRTC participant-minutes (5,000/mo free; currently 2,847) and a concurrency slot (100 cap). Recording is **fail-open** either way. LiveKit enforces both WebRTC caps at *join time* (rejects new connections; never kills live sessions).
- **Aug 27 participant spike (~90/day):** audit room-closed events for a teardown/participant leak (we have prior teardown-bug history).

---

## 2. Plan 2 — fail-safe on-demand Fly orchestration for BOTH pipelines (1 call per worker)

Two Fly apps, one orchestration model:
- **Phone** app `project-hello-phone-voice` — **named** worker (`phone-screener`), explicit dispatch, **outbound** (we control timing).
- **Browser/WebRTC** app `project-hello-voice` — today **unnamed / auto-dispatch**, **inbound** (a human is waiting live).

The core (pool + leases + readiness + reaper + Fly Machines API) is **identical** for both; only the **trigger** and the **cold-start-hiding** differ. See §2.3 (phone) and §2.3b (browser).

### 2.1 Two invariants ("fail-safe" = neither can fail silently)
1. **Never admit a caller/candidate without a confirmed-ready worker.** (No dispatch-into-silence / dead air.)
2. **Never leave a machine `started` without an active session.** (No cost leak — a stuck machine is the $32/mo failure.)

Everything below serves those two invariants, each with a **primary path** and an **independent backstop**.

### 2.2 Components (shared by both apps)
- **Warm pool (per app):** worker machines are **pre-created but `stopped`** (stopped ≈ free). Starting a stopped machine is much faster than creating one. Pool size = max desired concurrency per pipeline.
- **Control table** `voice_worker_leases` (Supabase, service-role only): `app, machine_id, pipeline(phone|browser), state(stopped|starting|ready|busy|draining), claimed_session_id, epoch, started_at, ready_at, last_heartbeat_at`. Fly Machines API + LiveKit RoomService are ground truth; this table is coordinator + audit trail.
- **Fly Machines API** (base `https://api.machines.dev/v1`, `Authorization: Bearer <FLY_API_TOKEN>` — ORG-scoped token, secret; *superseded by RCA 2026-09-06: this doc originally said `api.fly.io/v1` + an app-scoped deploy token — the former does not serve the Machines REST API and the latter 403s the other voice app; see runbook §1*): `POST /apps/{app}/machines/{id}/start`, `/stop`, `GET /…/wait?state=started`, `GET /apps/{app}/machines`.
- **Readiness handshake (new worker code, both workers):** on LiveKit registration, the worker `POST`s `/internal/voice-worker/ready {app, machine_id, agent_name, epoch}`; the API validates the agent identity (reuse PR100 names-agree). Only a `ready` machine may receive a caller/candidate.
- **Reaper (both apps):** the cost-safety backstop (§2.5).

### 2.3 Phone happy path (outbound — we control timing)
1. **Claim** a `stopped` phone machine atomically for this `attempt_id` (row lock; 1 call ⇒ 1 machine).
2. `POST /start` → `GET /wait?state=started&timeout=60`.
3. Wait for the **readiness ping** (registered as `phone-screener`, epoch matches) → `ready`. This hides all boot + model-load latency (~15–25 s cold) **before** any PSTN call is placed.
4. **Only now** `createSipParticipant` + `createDispatch`. Mark `busy`.
5. On terminal, mark `draining`; after a short grace `POST /stop` → `stopped`.

Scheduled calendar calls: start at **T-minus ~60 s**. Call-now: start-then-wait then dial. The candidate never experiences the cold start (no call exists until `ready`).

### 2.3b Browser/WebRTC happy path (inbound — a human is waiting live)
The difference: the candidate is **live at the screen**, so the cold start must be **hidden behind a "connecting" state**, not behind call-timing. The browser flow already passes through the API (to mint the room token), which is the pre-warm hook.

1. Candidate clicks **Start interview** → API shows **"Preparing your interview…"** and does NOT yet return a join token.
2. **Claim + `start` + `wait?state=started`** a browser machine for this `session_id` (1 session ⇒ 1 machine).
3. Wait for the **readiness ping** → `ready`.
4. **Only now** create the room + return the join token; candidate joins; worker dispatches to that room. Mark `busy`.
5. On session end, `draining` → grace → `stop`.

**Named vs unnamed decision (required):** to hold **1 call per worker** the browser worker must run `max_jobs=1`. With today's **unnamed auto-dispatch**, a second concurrent room would find no free worker → we must have already started a 2nd machine (the API knows, because every session goes through it). Two ways to make this deterministic:
- **B-i (recommended): convert the browser worker to NAMED + explicit dispatch**, exactly like phone → one uniform model, no auto-dispatch races. **Caveat (memory):** naming the browser worker silently stops auto-dispatch, so the explicit `createDispatch` for browser rooms must land in the **same** change — never name it without adding dispatch.
- **B-ii: keep unnamed**, but gate room creation on a `ready` machine and pre-start one machine per concurrent session-request. Works, but auto-dispatch + `max_jobs=1` is racier under burst; keep only if B-i is too invasive now.

**Cold-start UX:** default is scale-to-zero with the "Preparing…" screen (~15–25 s one-time). Optional **hot-standby knob**: keep `min_pool=1` warm during the IST window so the *first* candidate is instant, bursting on demand beyond that (small always-on cost; owner toggle). Same knob exists for phone.

### 2.4 Failure modes → guaranteed handling (both pipelines)
| # | Failure | Primary handling | Backstop |
|---|---|---|---|
| F1 | Machine won't start / start times out | abort admit, mark session **deferred** (never dialed / candidate shown a retry), alert | reaper releases the claim |
| F2 | Worker starts but never registers (crash/bad config) | readiness handshake times out → abort admit, `stop`, retry on a **fresh** machine or defer | reaper stops the orphan |
| F3 | Admitted but worker didn't join the room | phone: `worker_never_joined` canary → retry; browser: token withheld until `ready`, so this can't reach the candidate | — |
| F4 | Session ends but the "ended" event is lost | — | **Reaper** stops any `started` machine with **no active LiveKit room** > grace |
| F5 | Machine leaks `started`, no session | — | **Reaper** — the cost-safety guarantee |
| F6 | Two sessions race for one machine | atomic claim (row lock) — 1 session per machine | reaper detects double-claim drift |
| F7 | Fly API 5xx / rate-limit | retry w/ backoff; if still failing, **defer, do not admit** | reaper |
| F8 | Deploy resurrects always-on | §2.6 | CI posture check (both apps) |
| F9 | Epoch mismatch (stale re-dispatch) | readiness ping carries `epoch`; API rejects mismatched worker | reaper |
| F10 | Browser candidate abandons during warm-up (closes tab) | cancel the pending start / release claim once warmed; short TTL on the claim | reaper stops the machine |
| F11 | Browser burst: more concurrent sessions than pool | queue with "Preparing…", start additional machines up to cap; beyond cap, show a graceful wait; alert to grow pool | reaper trims after |

### 2.5 The reaper (cost-safety backstop — the core of "fail-proof")
A periodic API job (cron, every ~1–2 min) that is the **source of truth** for invariant #2:
- List Fly machines for `project-hello-phone-voice`; for each `started` machine, query **LiveKit RoomService** for an active room/session with that worker + matching lease.
- Any `started` machine with **no active session** and `age > grace` → `POST /stop` and release its lease.
- This means even if *every* orchestration event is lost, no machine bleeds cost beyond one grace window. It is the belt to §2.3's suspenders.

### 2.6 Deploy-gate reconciliation (must-do, or it regresses)
- The phone deploy workflow **fails closed without a CURRENT worker registration** (§6 watermark proof). A scaled-to-zero worker has none → deploys break. Fix: the deploy job must **start a machine → verify registration → deploy image → return machine to the stopped pool**, not drop the gate.
- `fly.phone.toml` documents that **`scale count 0` alone is undone by the next voice-source deploy**. So scale-to-zero must be the **durable posture**: the orchestrator owns lifecycle, the deploy must not set a permanent `count>0`, and a CI check asserts the app is not left ALWAYS_ON. (Refs: memory `auto-merge-hides-dropped-gates`, `blast-radius-vs-behaviour-claims`.)

### 2.7 Concurrency (1 session per worker, confirmed — both pipelines)
- N concurrent sessions ⇒ start N machines from that app's warm pool; each worker runs `max_jobs=1`. Cap at pool size; queue/defer beyond and alert to grow the pool.
- Each running machine stays **perf-1x** (incident pin). 1 session/worker keeps the VAD/EOU CPU path safe.
- Phone and browser pools are **independent** (separate apps, separate caps).

### 2.8 Cost after (per app)
Idle ≈ $0 (rootfs storage only). Per session ≈ perf-1x × (~8 min incl. warmup+drain) ≈ **$0.006**.
| Sessions/mo (per pipeline) | On-demand cost | vs $32 always-on |
|---|---|---|
| 200 | ~$1.2 | −96% |
| 500 | ~$3 | −91% |
| 2,000 | ~$12 | −63% |
Applying to **both** apps replaces **~$64/mo** of always-on with a usage-scaled bill (plus the Plan 1 recorder-participant, also on-demand). Optional hot-standby knob adds ~$16/mo per app if instant first-session is required.

### 2.9 Explicitly rejected
- **Fly native `auto_stop/auto_start`:** cannot wake either worker — no `[http_service]`, the proxy only sees inbound HTTP, dispatch is an outbound WS. Verified for both apps.
- **`fly-autoscaler` (metric pull):** lags the trigger; we need deterministic ready-before-admit.
- **Scheduled-only scaling:** ~50% savings for near-zero effort but no concurrency scaling and still needs §2.6. Interim only.

---

## 3. Sequencing & open decisions
1. Confirm the **$50 billing source** and the **"agents 1/1"** meaning (§1.3) — gates whether Plan 1 is "cancel a charge" or "avoid an upgrade," and whether the 1-agent cap is a second forcing function (note: converting the browser worker to **named** in §2.3b B-i means **2 named agents** — directly relevant to that cap).
2. Approve Plan 1 **Option A1** (sidecar recorder-participant) vs A2 (in-worker).
3. Approve Plan 2 target = **unified on-demand orchestration for both pipelines**, 1 session/worker; and the browser **named vs unnamed** choice (B-i recommended).
4. Choose the **hot-standby** policy per app (pure scale-to-zero vs 1 warm during the IST window).
5. Build order (post-approval): (a) shared scaffolding — readiness handshake + `voice_worker_leases` + reaper + Fly Machines client; (b) **phone** claim/start/ready/dial gate in `admit_phone_attempt`; (c) **browser** claim/start/ready/token gate + "Preparing…" UI (+ named-worker conversion if B-i); (d) deploy-gate reconciliation + CI posture check (both apps); (e) recorder-participant; (f) load-test perf-1x with recording.
