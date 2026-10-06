# R1 WebRTC Interview Bot: Sales Program Advisor Role-Play — Implementation Plan v2

## 0. Header

| | |
|---|---|
| Date | 2026-10-06 |
| Base | `origin/main` @ `eec54af` (#332); do not use the parent checkout, which is about 50 commits behind. |
| Status | Plan only; implementation awaits the gates and owner actions below. |
| Scope | Sales Program Advisor R1 only. Phone remains on LiveKit Cloud. |
| Evidence | `R1-PLAN-final.md`, `R1-SELFHOST-LIVEKIT-FLY.md`, corrected `research/selfhost-verdicts.json`, and `R1-SCOUT-isolation-map.md`. Paths and line references are relative to `eec54af`. |

> **How to read this plan:** this file is the owner summary plus the self-hosted-LiveKit changes. Sections 5-8 adopt the full detail of `R1-PLAN-final.md` (persona cards, scripted lines, owed-move scheduler, earned close, rubrics, calibration, recording, data model) without semantic change; read both files together.

### 0.5 Owner summary

We will build a new, approximately 20-minute browser interview for the Sales Program Advisor role. A candidate checks camera and microphone, consents to recording and AI evaluation, then speaks to Christy. After a short introduction, Christy plays a prospective learner in a structured sales role-play. HR gets a one-time link, a recorded interview, a phase-labelled transcript, a scorecard, evidence, and a recommendation. Candidates get a clear explanation, a device check, a camera self-view, an appeal route, and a human-interview alternative if they decline.

The phone interview is not being changed: its LiveKit Cloud project, webhook, worker, credentials, recordings, scorer, and runtime continue as they are. Nor are we changing the phone routes or the phone role rows.

There are two delivery modes for the browser/R1 lane:

| Mode | Capacity and cost | Decision |
|---|---|---|
| Preferred: self-hosted R1 SFU | R1 uses **zero LiveKit Cloud participant-minutes**. One Fly Singapore (`sin`) server serves only browser R1 rooms. Estimated on-demand cost is about **$9–14/month**, including a required $2 dedicated IPv4; always-on performance-1x is about **$45/month**. | Use only after S0-F proves real joins and media quality from Indian home, mobile, and corporate networks. |
| Fallback: LiveKit Cloud Build | R1 shares the existing 5,000-minute Cloud pool with phone. The current measured-cap formula remains: roughly **40 R1/month** in steady state, about **2 per weekday**; less during testing. (The earlier rough ~4/weekday estimate assumed 43 min per R1 and no safety margin; the reviewed formula uses 55 min, an 80% pause line and a 1.2x phone reserve.) | Use immediately if S0-F fails. No LiveKit upgrade is authorized. |

Self-hosting removes R1's phone-starvation risk entirely, but it adds one-server operations and a Fly UDP risk. If S0-F requires an always-on performance-1x server, choose Cloud Ship ($50/month) or enforce the Cloud cap rather than pay nearly Ship price for a less resilient server.

Indicative timing: S0-F and the endpoint/isolation foundation run first; the earliest real candidate is the week of 2026-11-30 and the realistic target is the week of 2026-12-14. Automated status changes remain off until the calibration gate has at least 30 double-rated real interviews.

This week the owner must: (1) approve a dedicated Fly IPv4 and create the SFU/spike apps; (2) choose an IK domain versus `*.fly.dev` for production and certificate/DNS ownership; (3) recruit testers on Jio/Airtel 4G/5G, home broadband, and a corporate/strict network; (4) authorize S0-F and answer the remaining product/legal decisions; and (5) complete the existing CI, R2, production-readout, Legal, and sales-lead actions in §12.

---

## 1. Executive summary

R1 is a deterministic, one-at-a-time, browser-only interview: 3–4 minutes of icebreaker, a scripted role-play announcement and ready check, 12–14 minutes of sales role-play, and about two minutes of wrap-up. Four normalized US learner personas rotate. The worker, not the LLM, schedules every objection, controls progressive disclosure and the earned close, and records the administration log. DeepSeek Flash conducts the conversation with thinking disabled; a durable, isolated scorer produces the five-metric recommendation.

The worker records candidate camera and call audio to Cloudflare R2; no LiveKit Egress is used for R1. Video is HR-review-only: no bot vision and no avatar. The R1 page, consent, aggregate, queues, scorer, recording table, scorecard, and candidate-detail panel are R1-specific. Legacy browser screening is retired before staff dry runs.

### Capacity answer

Decision 14 is feasible in different ways by mode:

* **Self-hosted SFU:** “under 10/day, no LiveKit upgrade” is technically possible after S0-F, subject to one live R1 at a time and Fly/DeepSeek/Sarvam capacity. R1 has no Cloud-minute consumption and cannot starve phone.
* **Cloud fallback:** it is not feasible as “10/day.” A typical R1 costs about 45 participant-minutes (plan with 55; worst about 60), because both candidate and agent are billable. With phone use protected, the cap is about 40 per month, or about two per weekday. The guard blocks Send R1/starts above the cap.

The capacity guard is retained in both modes: in self-hosted mode it controls Fly, DeepSeek, Sarvam and operational load and preserves the immediately usable Cloud fallback cap; in Cloud mode it protects phone's shared quota.

---

## 2. Decisions

### 2.1 Locked owner decisions

Decisions 1–15 from `R1-PLAN-final.md §2.1` remain locked, including: R1-only browser lane; Sales Program Advisor scope; the phase budget; four normalized personas and four objection families; worker-controlled earned close; HR-owned facts sheet; camera for HR review only; 72-hour one-retake links; gated R1 scorecard/auto-recommendation; one TTS voice; DeepSeek Flash; R2 preference; the no-upgrade policy; and the safe merge policy.

| # | Additional/clarified decision | Plan treatment |
|---|---|---|
| 14 (clarified) | Stay on LiveKit Cloud Build today; agent workers are self-hosted on Fly and are billed as Cloud WebRTC participants. Measured seven-day use was 142 WebRTC minutes versus 53 SIP minutes, including browser idle. | Cloud fallback uses the §3 formula/cap. Build is never an unbounded R1 launch mode. |
| 16 | Prefer a **self-hosted LiveKit server on Fly `sin` for R1/browser rooms only**. Phone remains on LiveKit Cloud. `bom` cannot be used for new Machines. | S0-F is a hard go/no-go. The per-lane API seam exists from day one, so fallback is configuration plus a drained worker switch, not application rewrites. |

### 2.2 Open decisions and defaults

All D1–D14 in `R1-PLAN-final.md §2.2` remain open with their recommended defaults: counted-at-transition retakes; approved world facts; 24-hour cancellable pending reject; 90-day video retention; cap behavior; stated weights; women personas; phase label; `deepseek-flash`; performance-2x worker; Legal's PRC gate; retirement before Stage A; Sarvam tier; and India-only eligibility unless Legal widens it.

| ID | Question | Recommended default | Needed by |
|---|---|---|---|
| D15 | Fly dedicated IPv4 | Approve $2/month. It is required for public UDP; shared IPv4 and public IPv6 cannot carry it. | Before S0-F |
| D16 | SFU availability posture | On-demand, proxy-woken, one performance-1x/2GB Machine after S0-F proves 20/20 immediate UDP joins. If that fails, test always-on. If only always-on performance-1x works, prefer Cloud Ship or use the Cloud cap. | S0-F |
| D17 | Hostname/certificate | Use `*.fly.dev` only for spike; choose `rtc-r1.<IK domain>` with Fly-managed certificate for production unless S0-F proves a corporate filter makes it unsuitable. | Before production switch |
| D18 | Corporate-network reachability | Start with ICE/TCP 7881 and no embedded TURN. If corporate testing fails, external TURN (T3) is a launch prerequisite; embedded TURN/TLS is not assumed viable. | S0-F |

---

## 3. Capacity, cost, and guard

### 3.1 Common R1 budget

One R1 is 20.5–22 candidate minutes, 22–24.5 agent minutes, and short preflight/finish residency: approximately 45 typical, 55 planning, and 60 worst participant-minutes. R1 concurrency is one. Camera is 640×360/15fps, simulcast off, maximum 500 kbps; the worker is its only video subscriber.

`r1_admit_attempt` remains an atomic `SECURITY DEFINER` RPC. It locks the month row and checks R1 enabled/paused state, holds and cap, live R1 <1, combined live phone + R1 <4 where Cloud mode is selected, starts/retakes, and valid unwithdrawn consent. Phone admission is never gated. Holds reserve 55 minutes; actual use is ledgered from connection/disconnection and session timestamps.

### 3.2 Mode A — self-hosted R1 SFU

R1 uses no LiveKit Cloud WebRTC, egress, observability, or agent-session minutes. Therefore it cannot exhaust the phone project’s Cloud quota. The retained budget guard is an R1 cost/load guard and a standing Cloud-fallback cap:

* record candidate/agent time, preflight, tests, Fly uptime/egress, DeepSeek, Sarvam failures, and active sessions;
* pause at the owner-approved R1 operating cap or projected overload; keep one session maximum;
* retain the Cloud formula below in settings, so flipping fallback does not require a migration or policy redesign;
* reconcile R1 usage against Fly billing and provider dashboards daily in launch, then weekly.

Estimated Fly `sin` costs at 10 weekday sessions/day: on-demand performance-1x/2GB plus dedicated IPv4 and egress is **about $9–14/month**. A stopped root filesystem/certificate are cents. Always-on performance-1x/2GB is **about $45/month**. If S0-F forces that posture, use Cloud Ship ($50/month) if the owner permits it, otherwise use Build with the cap; do not treat self-hosting as a saving then. R2 is pennies at this volume; DeepSeek is about $0.18–0.33/R1; Sarvam remains to be measured.

### 3.3 Mode B — LiveKit Cloud fallback

Cloud Build is 5,000 shared WebRTC participant-minutes/month. The formula is unchanged:

`floor((pause line − 1.2 × measured trailing-30-day non-R1 minutes − planned Cloud test minutes) / 55)`.

Begin at a 4,000-minute (80%) pause line; move to 4,250 (85%) only after two dashboard reconciliations agree within 5%. With 1,500 measured non-R1 minutes and no tests: `(4,000 − 1,800)/55 = 40` sessions. At 85%, it is 44. Legacy browser traffic at the snapshot level reduces this to roughly 10, which is why PR-L precedes Stage A. Launch Cloud fallback at about 20 in a half month and about 40/month steady state, roughly two per weekday (about 9-10 a week), not 10/day.

The ledger includes R1, phone attempts plus one minute, legacy browser sessions ×2 plus one minute, preflights at ten seconds, and manual tests; apply 1.15 until reconciled. Auto-pause at the line or projected month-end ≥90%; warn at 60/75/90%, SIP ≥70%, quota/join failures, agent-alone >2 minutes, R1 >26 minutes, and any R1 egress. Pause through 12:00 UTC on the first until the reset behavior is evidenced.

### 3.4 Storage and recording cost

Use private R2 bucket `ik-r1-recordings`, bucket-scoped API credentials, 90-day deletion with a 97-day lifecycle backstop, streaming integrity checks, and presigned review/export URLs. At 85MB/R1 and 40/month, 90-day storage is about 10.2GB and essentially free. Do not use shared Supabase spend for R1 video. No R1 Egress is used in either mode.

---

## 4. Architecture and flow

```
Candidate /candidate/r1 -> project-hello-api (R1 routes, admission, R2 presign)
     | returned R1 endpoint + JWT
     v
project-hello-r1-rtc (Fly sin; one Machine; R1 browser rooms only)
     ^                  ^
     | dispatch/WSS     | UDP 7882 primary, TCP 7881 fallback
project-hello-voice (browser-screener; R1 LIVEKIT_* secrets; one R1 job)

Phone: project-hello-phone-voice <-> LiveKit Cloud <-> phone webhook/API Cloud triple
       unchanged and never routed through project-hello-r1-rtc.
```

`project-hello-r1-rtc` is a new single-Machine Fly app in `sin`, pinned to LiveKit server v1.13.7 by digest. It has a dedicated IPv4, WSS/Twirp/agent WS on 443→7880, ICE/TCP on raw 7881, and one ICE/UDP mux on 7882. It has no Redis, Egress, SIP, Ingress, Cloud observability, or webhook. `room.auto_create=false`; the API creates rooms. Set explicit `node_ip` to the dedicated IPv4 and `use_external_ip=false`. UDP binding to `fly-global-services` is an S0-F assertion, not an assumption. Run exactly one Machine: without Redis it is single-node, and Fly routes UDP per packet rather than by flow.

The existing web client already connects to the URL returned by the API (`CandidateJoinPage.tsx:562`; `AudioReadinessStep.tsx:157`), so endpoint selection is API-side. Production has no enforced CSP: `vite-csp-plugin.ts:83` applies only to serve/preview and `vercel.json` has no CSP headers. A future production CSP must allow both Cloud and R1 origins during fallback.

R1 end-to-end remains: HR Send R1 → fragment token → R1-specific consent → camera/mic and A/V preflight → atomic attempt/admission → endpoint-specific room and dispatch → phase worker → bounded recording finish → terminal session → durable assessment/finalize queues → HR panel/appeal. The room remains `screening-<uuid>`; dispatch metadata is only an observability hint, never authorization.

---

## 5. Conversation design

Section 5 of `R1-PLAN-final.md` is adopted without semantic change. It defines the forward-only phase machine and 24-minute hard cap; exact scripted lines; single `simran` voice; separate interviewer/learner contexts; progressive hidden-need disclosure; output guards; the HR-owned SHA-pinned facts sheet; four normalized personas; deterministic owed moves; deterministic negotiation and earned close; shadow tracker; injection/silence/rejoin behavior; fairness/equivalence gates; DeepSeek Flash configuration; and latency targets.

Implementation constraints remain: R1 uses a lazy, separate module after the phone early return (`agent.py:11854-11861`); it never changes `prompting.system_prompt`, `opening_line`, `DEFAULT_QUESTIONS`, `_build_provider_session`, `phone.py`, `closing.py`, or phone validators. The R1 context route and R1 persistence writer are separate. R1 uses `record=False`: on self-host it would otherwise create a local SDK OGG whose Cloud-observability upload silently does not occur.

---

## 6. Scoring design

Section 6 of `R1-PLAN-final.md` is adopted without semantic change: the five-metric scorecard; phase-aware candidate-only evidence; administration log; own R1 DeepSeek runner and breaker; three-run scoring; coverage/fidelity gate; configurable thresholds; audited status CAS with a cancellable 24-hour pending reject; durable `r1.assessment` queue; R1 dashboard; and the 30-session, two-rater calibration gate. Auto-status stays off through Stage B.

## 7. Recording

The §7 design in `R1-PLAN-final.md` remains the recording plan: worker-side candidate camera plus A/V, drop-oldest frame path, bounded/niced encoder, audio checkpoints, multipart R2 upload, streaming SHA-256 and MP4 sniff, R1-only table/player/DSAR/retention, and audio-only auto-degrade. `recording.py`, `recording_api.py`, legacy `recordings_v2`, `RECORDING_*`, and phone recording are untouched.

No LiveKit Egress is needed or allowed for R1. This is required on the Redis-less SFU, where Egress is unavailable, and avoids Cloud egress in fallback too. The API must explicitly return an R1 no-egress result before `startAuthoritativeRecording`; both `RECORDING_EGRESS_ENABLED=true` and `ENABLED=false/REQUIRED=true` otherwise make an R1 exchange fail with 503 (`room-provisioning.ts:186-216`; `recording-egress.ts:38-56,264-306`).

---

## 8. Data, API, and configuration

All R1 migrations/routes/tables in `R1-PLAN-final.md §8` remain additive: aggregate/attempt/consent/settings/budget tables; nullable `call_sessions.interview_round_id`; phase/interruption fields; R1 ledger/admin log/recording table; R1 assessment/finalize/sweep jobs; R1 routes; strict RLS, CAS, OpenAPI, and audit coverage. Do not alter phone terminal reasons, phone RPCs, active global consent templates, or phone scorecards.

### 8.1 Per-lane LiveKit seam

Add a side-effect-free `lib/livekit-endpoints.ts` and lazily read:

| Variable | Meaning |
|---|---|
| `R1_LIVEKIT_URL` | R1 SFU URL |
| `R1_LIVEKIT_API_KEY` / `R1_LIVEKIT_API_SECRET` | R1-only API credentials |
| `BROWSER_LIVEKIT_TARGET` | Exact `r1` selects R1; any other value selects Cloud |

`cloudLiveKitEndpoint()` continues to use the existing `env.livekitUrl/apiKey/apiSecret`, which permanently means Cloud. `browserLiveKitEndpoint()` returns the selected triple. `requireBrowserLiveKitConfigured()` fails closed when target is `r1` and any R1 credential is missing; it never silently falls back to Cloud. Register these names as secrets/config contracts without adding them to scripts that make every API secret mandatory.

Use the browser endpoint for browser-only room creation, preflight token, candidate token and returned URL (`room-provisioning.ts:124-130,161`; `routes/invites.ts:136,272,305-339,581,637-656`; `routes/livekit.ts:142,209,250`) and browser dispatch (`browser-orchestration.ts:129-140`). Explicit candidate source grants are microphone and camera only. Keep `recording-egress.ts` Cloud-only for legacy sessions.

### 8.2 Mandatory liveness and race fixes

* **Reaper/terminal release:** add an optional LiveKit endpoint override to `createDefaultWorkerOrchestrationService`; pass `browserLiveKitEndpoint()` only from browser orchestration. Otherwise its `ListParticipants` call checks Cloud, sees R1 rooms as missing/empty, and stops an active R1 worker about 180–270 seconds after readiness (`worker-orchestration.ts:809-858,1054-1066`; `worker-orchestration-runtime.ts:47`; `env.ts:295`). Phone orchestration continues with no override and hence Cloud.
* **Dispatch-before-registration:** worker readiness must be posted only after its LiveKit WebSocket registration and include `livekit_host`; the API accepts it only when the selected endpoint host matches. The current prewarm ping precedes registration (`agent.py:1877-1899`; livekit-agents `worker.py:784,831-833`) and OSS accepts a dispatch with no available worker. If moving the ping is infeasible, poll `ListParticipants` after dispatch and redispach once, but retain host matching.
* **Cutover:** drain all R1 `waiting`/`in_progress` sessions, set `project-hello-voice` `LIVEKIT_*` to the selected target, deploy/apply it, then set/deploy `BROWSER_LIVEKIT_TARGET`. An API-only flip is invalid because one worker registers with one server.

### 8.3 SFU/worker secrets and webhooks

Generate a distinct 32+ character server key/secret. Store server `LIVEKIT_KEYS` only on `project-hello-r1-rtc`; put matching `R1_LIVEKIT_*` on API; point browser `project-hello-voice` `LIVEKIT_URL/API_KEY/API_SECRET` to the selected R1 server at self-host cutover. Never reuse the Cloud key. R1 has **no webhook**. A future R1 webhook requires a separate receiver/key; the phone receiver must reject R1 signatures.

---

## 9. Isolation and safety

Phone configuration, phone webhook, phone runtime, phone API clients and phone worker stay on Cloud and must not change. Never edit `phone.py`, `closing.py`, `recording.py`, `recording_api.py`, `fly.phone.toml`, `integrations/livekit-phone/*`, `lib/phone-runtime/*`, `lib/phone-canary1/*`, `routes/phone*.ts`, phone worker orchestration, Cloud egress client, phone consent rows/RPCs, or phone scorer prompt.

Required fences, in addition to §9 of the prior plan:

1. No phone-only module imports `livekit-endpoints` or mentions `R1_LIVEKIT`/`r1Livekit`.
2. With R1 settings populated, `loadLiveKitPhoneConfig` and phone runtime credentials remain the Cloud triple.
3. R1 exchange/preflight returns the R1 URL; its JWT verifies only with the R1 secret. With target `cloud`, response behavior is byte-compatible with current browser behavior.
4. R1 provisioning uses R1 credentials and makes no Egress call; legacy Egress still uses Cloud.
5. Browser reaper checks R1 and spares a live R1 room; phone reaper still checks Cloud and stops a Cloud room that is absent.
6. Phone webhook rejects an R1-signed webhook.
7. Worker readiness has the registered `livekit_host`; target/host mismatch is rejected before a candidate token is issued.

The existing lazy imports, non-throwing R1 API config, dependency freeze, zero-live deployment gate, phone context/prompt/runtime snapshots, R1 content pins, and least-privilege logging rules remain mandatory.

---

## 10. Delivery plan

Every implementation PR still requires three independent adversarial reviews, green Quality/hosting/Supabase/secret/model checks where applicable, squash merge, and the zero-live deployment gate (`R1-PLAN-final.md` §9). Any API, voice-worker, or migration deployment remains outside the IST calling window and verifies a phone Canary-1 afterward.

### 10.1 S0-F: self-hosted SFU go/no-go

Create temporary `project-hello-r1-rtc-spike` in `sin`: one Machine (`--ha=false`), v1.13.7 digest pin, dedicated IPv4, `*.fly.dev`, one UDP mux on 7882, raw ICE/TCP 7881, 443 signaling, no Redis/Egress/SIP/TURN/webhooks. Use a minimal echo worker in `sin`, `browser-screener`, and a HTTPS Vercel-preview test page that publishes 640×360/15fps and uploads `getStats`. Mint test tokens with `lk`. The spike is five working days; it does not touch production phone or browser workers.

| Step | Test and pass criterion | Failure action |
|---|---|---|
| S0-F1 platform kill switch | On first Machine, prove `<fly-global-services>:7882` is bound (`ss -ulpn`); selected browser pair is UDP to dedicated-IP:7882. Test Config A first; Config B only if needed. | No UDP bind/pair: NO-GO; use Cloud fallback. |
| S0-F2 smoke/lifecycle | Laptop join and forced TCP join; 20 proxy stop→start cycles. UDP works on first join 20/20; wake p95 ≤5s. | Test always-on posture; if still poor, NO-GO. |
| S0-F3 agent | 20 cold plus 20 warm dispatches. Agent joins 40/40, worker-to-SFU RTT p95 <5ms. | W1 readiness/host fix is required before retry. |
| S0-F4 field matrix | At least 15 joins/cell and 150 total: Jio Fiber/Airtel/ACT on Chrome Windows/macOS and Safari macOS; Jio/Airtel/Vi 4G/5G on Android Chrome/iOS Safari; corporate or strict/TLS-inspecting network; matched Cloud baseline. Cover Bangalore/Chennai, Mumbai/Pune, Delhi/Hyderabad. | Corporate failure requires tested external TURN (T3) or NO-GO. |
| S0-F5 soak/drills | Five 25-minute sessions, three concurrent 25-minute sessions, mobility/reconnect, Cloud flip/back, deploy guard with a live room, key rotation. | Fix/retest or NO-GO. |

Pass thresholds: home/mobile join success ≥98% overall and no cell <93%; corporate 100% via ICE/TCP or T3; UDP selected for ≥90% home/mobile; RTT p95 ≤200ms and ≤30ms worse than Cloud; loss mean ≤2% and ≤5% in 95% of 30-second windows; jitter p95 ≤30ms; audio concealment ≤2%; blind A/B ≥4/5 and within 0.5 of Cloud; video ≥12fps in ≥95% samples, no >2s freeze, bandwidth limitation <10%, PLI <1/min; handover/short airplane resume ≥9/10; no >2s gap in long sessions; CPU throttle zero at three sessions; Cloud switch/back <15 minutes. Record every failure and its root cause.

On S0-F fail, destroy the spike app, release its IPv4, retain the inactive endpoint seam, and launch R1 on Cloud only under §3.3's cap. S0-F does not authorize a LiveKit upgrade.

### 10.2 PR order

| PR | Scope | Depends on |
|---|---|---|
| PR-pre, PR-dep, PR-0 | Existing CI expiry work, dependency freeze, ADR/runbooks/data classification | Owner/S0-A |
| PR-SFU-1 | `infra/livekit-r1/` Fly config, pinned Dockerfile, `livekit.yaml`, its validator, region-scope update, Quality wiring | D15, S0-F design |
| PR-SFU-2 | Manual-only SFU deploy workflow/token, zero-live-room precheck, health probe; update deploy validator/tests (currently hard-code two voice apps) | PR-SFU-1 |
| PR-LK-seam | Per-lane endpoint seam, browser call sites, no-egress branch, Cloud fallback tests, phone fences | PR-1 foundation |
| PR-LK-liveness | Endpoint-aware reaper/terminal release and W1 registration/host readiness fix | PR-LK-seam, S0-F3 |
| PR-1 through PR-10, PR-V | Prior-plan migrations, R1 routes/worker/conversation/scorer/UI/R2/recorder/player/video switch | Include seam/liveness prerequisites before R1 exchange/worker deployment |

Do not add the SFU to automatic `deploy-fly.yml` merely to reuse it. A separate manual workflow is the recommended safety control; deployments, upgrades, key rotations and secret changes require zero live R1 rooms. The existing SFU validator must include it in region validation, because the worker-app validator forbids `[[services]]` and hard-codes two apps.

### 10.3 Schedule

| Window | Work |
|---|---|
| Oct 5–9 | PR-pre, S0-A readouts, owner decisions, R2, Legal/sales kickoff, IPv4/domain/tester recruitment |
| Oct 12–23 | S0-F plus S0-B/C/D/E; PR-dep/0/1/2; SFU infra, seam, reaper/readiness work |
| Oct 26–Nov 13 | Legacy retirement; R1 API/worker/conversation/scorer/UI PRs; staff consent |
| Nov 16–Dec 4 | Stage A0/A, R2/recording/encoder/player work and real-stack self-host rehearsal |
| Dec 7–11 | Stage A2, candidate Legal approval, S0-F/S1 evidence review |
| Week of Dec 14 (realistic; Nov 30 earliest) | Stage B, first candidates, shadow mode; select self-host or capped Cloud |
| Late Jan 2027 | Stage C only if calibration passes |

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Fly UDP is unproven; `fly-global-services` enumeration/binding is not official | S0-F1/F4/F5, one Machine, single 7882 mux, UDP-pair telemetry, immediate Cloud fallback flag. |
| Strict corporate networks lack Cloud-managed TURN/TLS | Test corporate cell; ICE/TCP 7881 first; external TURN only if required and tested. Embedded TURN is not a v1 assumption. |
| Reaper kills a live R1 after 3–4.5 minutes | Endpoint override and liveness test before R1 switch. |
| Dispatch is accepted before worker is registered | Post-registration host-bound readiness, API mismatch rejection, dispatch test. |
| Ops burden, public UDP, certificate/key rotation, upgrades | Dedicated runbook, JSON info logs only, private metrics, manual zero-room deploys, monthly/security upgrade evaluation, two-key rotation. |
| One Machine/SFU is a SPOF; Fly migration/deploy can terminate rooms | Retake/infra-abandon handling, no-live deploy rule, Cloud fallback rehearsal in <15 minutes. |
| On-demand wake or UDP immediately after start is unreliable | 20-cycle S0 test; always-on only if cost rationale remains; otherwise Cloud fallback. |
| Cloud fallback exhausts phone quota | Atomic cap, daily dashboard reconciliation, 80→85% pause, R1 pause through reset. |
| Video/encoder harms live call | Perf-2x worker, niced/drop-oldest encoder, first-warning audio-only degrade, S0-C. |
| Legal, privacy, automated decisions | Existing Legal gates, R1-only consent, withdrawal/DSAR/retention, shadow calibration and cancellable pending rejects. |

## 12. Owner, HR, and Legal actions

### This week

1. Approve PR-pre and resolve the 2026-10-08/17/28 CI expiry work.
2. Approve dedicated Fly IPv4 and create `project-hello-r1-rtc-spike`; allocate IPv4, then release it if S0-F fails.
3. Decide production hostname: IK-controlled domain/certificate/DNS or explicitly accept `*.fly.dev` only for the spike.
4. Recruit field testers: Jio/Airtel/Vi 4G/5G, Jio Fiber/Airtel/ACT home broadband, and at least one corporate/strict/TLS-inspecting network; obtain Chrome, Safari, Android, and iOS coverage.
5. Run existing S0-A dashboard/config/SQL readouts; confirm R2, Sarvam, DeepSeek, production recording flags, and worker `pip freeze`/PyAV values.
6. Answer D1–D18; authorize only one R1 at a time for v1.
7. Enable R2 with billing alert; create/revoke throwaway S0-D resources and prepare private `ik-r1-recordings` only after Legal jurisdiction advice.
8. Engage Legal and sales lead for facts sheet, personas, rubric, R1 consent, DeepSeek PRC processing, AI-GATE supersession, retention, and human alternative.

### Before launch

Stage R1 keys only on the scopes named in §8.3; verify staged secrets on a stopped worker by starting one. Approve manual SFU deploy/upgrade and Cloud fallback runbooks. Provide two trained HR raters for Stage A and 30 Stage-B double ratings. The owner, not engineering, turns on `auto_status_enabled` after calibration.

---

## Appendix A. Review dispositions

All PI/CA/FC/SP/DT dispositions in Appendix A of `R1-PLAN-final.md` remain adopted. The material change is that FC-1/FC-5/DT-4 now have two operating modes: in self-hosted mode R1 does not consume the shared Cloud pool; in Cloud fallback they retain the original ledger, cap, pause, and legacy-retirement protections. New self-host dispositions appear in Appendix B.

## Appendix B. Self-host integration dispositions

| Memo condition / finding | Disposition in this plan |
|---|---|
| `sin`, not `bom`; single Machine | §§2, 4, 10; region policy is validated. `sin` is the nearest allowed region, not the only Fly region. |
| Dedicated IPv4 and explicit node IP | D15, §4, S0-F1; `use_external_ip=false`. |
| UDP binding to `fly-global-services` is likely, not proven | §4 and S0-F1 make it a kill switch; no claim that `rtc.ips.includes` alone proves media works. |
| Single-port UDP is low-risk; ranges are merely unproven | §4 uses one 7882 mux; it does not claim ranges are impossible. |
| TURN/TLS on 443 has possible in-machine/other-app workarounds | §2 D18, §10: v1 does not assume embedded TURN; external TURN is a tested contingency. |
| Proxy autostart is plausible through WSS/Twirp, not guaranteed for UDP | D16 and S0-F2 test it; API start/stop is not called a platform requirement. |
| No Redis means no Egress/SIP/Ingress | §7 explicitly skips R1 Egress; phone stays Cloud. |
| Per-lane endpoint seam required | §8.1 and PR-LK-seam; Cloud triple retains its meaning. |
| Reaper otherwise checks Cloud and stops R1 worker | §8.2 and PR-LK-liveness are mandatory before switch. |
| Dispatch-before-registration race | §8.2 host-bound post-registration readiness, plus S0-F3. |
| Worker is one-server-at-a-time; fallback cannot be API-only | §8.2 drained, coordinated switch procedure and tests. |
| Browser Cloud observability stops self-hosted | §5 uses `record=False`; R1 logging/R2 are authoritative. |
| No production CSP today | §4 records corrected fact; no Vercel rebuild is needed solely to flip endpoint. |
| SFU validation/deploy is not covered by two-worker assumptions | §10.2 adds SFU validator/region scope and manual workflow. |
| Fly ops, upgrades, certs, public UDP, single-node failure | §10 and §11 assign runbooks, cadence, keys, monitoring, S0 drills, and Cloud fallback. |
