# R1 WebRTC Interview Bot: Sales Program Advisor Role-Play — Implementation Plan (final)

## 0. Header

| | |
|---|---|
| Title | R1 WebRTC interview bot: Sales Program Advisor role-play (Interview Kickstart) |
| Date | 2026-10-05 |
| Base commit | `origin/main` @ `eec54af` (#332). Do not base work on the parent checkout `fix/phone-consent-latency-opener`; it is about 50 commits behind. |
| Status | APPROVED by owner 2026-10-06 (all decisions D1-D18 at recommended defaults); implementation in progress |
| Inputs | <ul><li>Scout isolation report, including its §13 corrections.</li><li>Research on four topics: the LiveKit free plan, storage pricing, in-worker A/V recording, and DeepSeek.</li><li>Fact-check dated 2026-10-05. Where it differs from the research, its corrected values are used.</li><li>The draft plan.</li><li>Five adversarial critiques: phone isolation, conversation/assessment, free-plan capacity, security/privacy, and delivery/testability. Every finding is dispositioned in Appendix A.</li></ul> |
| Conventions | <ul><li>Paths are relative to the repo root at `eec54af`.</li><li>"est." means an estimate, not a measurement.</li><li>"Deploys" values come from the path rules in `deploy-fly.yml:156-174`.</li><li>"IST window" means 09:00-21:00 IST.</li></ul> |

---

## 1. Executive summary

### What we build
- **A ~20-minute AI interview on the existing WebRTC lane** (Fly app `project-hello-voice`, worker `browser-screener`). The lane becomes **R1-only**. The interview has four parts:
  - 3-4 min icebreaker;
  - a scripted ~1 min announcement that the bot will now role-play a learner for evaluation, plus a ready check;
  - 12-14 min sales role-play;
  - ~2 min wrap-up.
- **The learner** is one of 4 rotating, US-based, calibrated personas.
  - All four objection families are delivered through a deterministic, worker-owned schedule.
  - The close is earned. The worker decides the commitment level and a guard enforces it; the LLM can neither give the close away nor end the call.
- **One TTS voice throughout.** Only scripted lines mark the switch.
- **Conversation LLM:** DeepSeek V4.1 Flash (`deepseek-flash`) with thinking off.
- **Recording:** the candidate's camera and the call audio are recorded **inside the worker** to **Cloudflare R2**. LiveKit egress is not used.
- **Scoring:** a durable R1 scorer on its own queue runtime and DeepSeek runner. It produces a 5-metric scorecard and an auto-recommendation (advance/hold/reject) that writes candidate status, behind:
  - coverage and fidelity gates;
  - 3-run stability;
  - a calibration switch.
- **Extensibility:** an `interview_kind` seam (`sales_r1`) lets future coding rounds plug in.

### What changes for HR and candidates
- **HR, Candidate Detail:**
  - a **Send R1** card: link shown once, valid 72 h, one retake (rules in D1);
  - an **R1 panel** with recommendation, scorecard and evidence, a phase-labelled transcript, an MP4 player, and the monthly budget.
- **Candidates** get a new `/candidate/r1` page:
  - R1 consent (video, AI evaluation, automated status effect, providers);
  - camera and mic check with self-view;
  - A/V preflight;
  - the live interview, with a lead card and phase label;
  - an end page with a contest/appeal route.
- **Legacy browser screening** (the "Create invite" card, `/api/livekit/start|invite|exchange`) is **retired before internal dry runs start** (D12).

### What stays untouched
- **Phone (SIP) lane, byte for byte:**
  - files: `phone.py`, `closing.py`, `recording.py`, `recording_api.py`, `fly.phone.toml`;
  - the phone SQL RPCs and the phone LiveKit webhook (`app.ts:270-279`, `integrations/livekit-phone/*`);
  - the phone scorer prompt, the phone runtime handler set, and the phone SPA role rows.
- **Shared code that R1 deliberately does not edit:**
  - `prompting.system_prompt`, `opening_line` and `DEFAULT_QUESTIONS`. They are kept; phone imports them and R1 never calls them;
  - `_build_provider_session` and `_run_session` (unreachable after cutover);
  - the shared `worker-context` route, `room-provisioning.ts`, `persistence.py` and `provenance.py`;
  - `recordings_v2`, the `RECORDING_*` env vars, `consent_templates` and `consent_records`.
- **Dependencies:** the worker's transitive dependencies are frozen before the first R1 worker merge (PR-dep), so phone's runtime libraries cannot drift.

### The capacity answer the owner needs to hear

> **Locked decision 14 cannot be met as stated: the free LiveKit plan cannot carry "under 10 R1/day".**
>
> - **Per-R1 cost:** each R1 uses about **45 WebRTC participant-minutes** (typical), **55** for planning and about **60** worst case. Both the candidate and our self-hosted agent are billed.
> - **The pool:** LiveKit Build has **5,000 minutes a month**, as a hard cap **shared with phone**. When it runs out, the phone agent cannot join calls until the 1st of the next month.
> - **The demand:** 10 a day is about 220 sessions, roughly 10,000-12,000 minutes, or 2-2.4 times the whole pool.
> - **Realistic free-plan capacity** after legacy browser screening is switched off:
>   - **about 40 R1 sessions a month** (about 2 per weekday, retakes included);
>   - about **20-25** in a month that also carries test sessions;
>   - about **10** if legacy browser screening kept running.
> - A second free LiveKit project adds nothing, because free allowances are pooled per user.
>
> **Owner choice:**
>
> | Option | What it means |
> |---|---|
> | **A (recommended default, honours "no upgrade")** | Stay on Build. Derive the monthly cap from measured usage (§3.2), starting at **40 a month in steady state**, and review after 2 months. |
> | **B** | Move to LiveKit Ship ($50/month, 150,000 minutes) if HR needs more than about 40 a month. This reverses decision 14, so only the owner can choose it. |
> | **C** | Option A now, plus a written trigger: if HR demand exceeds the cap in 2 consecutive months, the owner revisits B. |

### Needs the owner this week
1. **CI will go red for every PR, including phone hotfixes**, in three steps, and deploys run only after a green Quality run (`deploy-fly.yml:89-93`):
   - the API audit exceptions expire **2026-10-08** (`.github/audit-exceptions.json`; `scripts/check-audit-exceptions.mjs:14`);
   - the web exceptions expire **2026-10-17**;
   - `config/current-state.json` `evidenceDate` 2026-07-30 passes the 90-day check on **2026-10-28** (`scripts/check-current-state.mjs:55`).

   PR-pre (§10) needs owner approval. It includes an approved exception to "never edit `current-state.json`".
2. **S0-A readouts (§12):**
   - the LiveKit dashboard meters;
   - production recording flags;
   - the Sarvam plan tier;
   - the `pip freeze` and `av` version from the running phone image;
   - the read-only SQL checks.
3. **Cloudflare R2 account and a throwaway bucket**, so S0-D can run.
4. **Answer D1-D14 (§2.2).** Engage **Legal** (consent, DeepSeek PRC processing, the supersession of AI-GATE) and the **sales lead** (world-facts sheet, personas).

### Top 5 risks
1. **Phone starvation through the shared LiveKit minutes.**
   - Mitigations: a DB-enforced R1 budget; atomic admission; legacy cutover first; auto-pause at 80-85% of total and on a projected run-rate; self-metering with daily, then weekly, dashboard reconciliation.
2. **Shared-image and shared-API blast radius.** Every worker or API merge restarts phone and any live R1.
   - Mitigations: a zero-live-phone and zero-live-R1 gate before **any** such merge, including phone hotfixes; lazy R1 imports; a dependency lock; R1 config that never throws; an R1-only DeepSeek breaker and queue runtime.
3. **Unfair or wrong automated decisions** (persona drift, scorer instability, auto-reject).
   - Mitigations: deterministic test administration; a fidelity gate; 3-run scoring; a ≥30-session double-rated calibration before switching on; a 24-hour pending-reject window; an override-rate auto-disable.
4. **Legal and privacy exposure:** video PII; live transcripts sent to the official DeepSeek API (PRC processing, no DPA); automated decisions against PLAN.md's AI-GATE; DSAR gaps.
   - Mitigations: Legal gates before Stage A and Stage B; an itemised notice; R1-only consent tables; DSAR coverage; a withdrawal path.
5. **In-worker video starving the live call of CPU** (the 2026-08-29 incident class).
   - Mitigations: performance-2x; a niced encoder subprocess; drop-oldest queues; auto-degrade to audio-only on the first warning; spike gates.

### Timeline (est.; §10)
- **First real candidate:** earliest week of 2026-11-30; **realistic week of 2026-12-14** (Legal sign-off and video recording are on the critical path).
- **Auto-status switched on:** after ≥30 double-rated sessions, about **late January 2027**.

---

## 2. Decisions

### 2.1 Locked owner decisions (2026-10-05)

| # | Decision | How the plan honours it | Flag |
|---|---|---|---|
| 1 | Replace browser screening. The WebRTC lane becomes R1-only; phone is untouched; `prompting.system_prompt` is kept; leave a seam for coding rounds. | <ul><li>`R1_LANE_MODE=r1_only` on the browser app routes every browser room to a lazily imported `r1_session`, immediately after the phone early return (`agent.py:11854-11861`).</li><li>Legacy `_run_session` stays in the code but is unreachable.</li><li>Legacy creation returns 410 (PR-L).</li><li>Seam: `interview_rounds.kind` and the per-kind worker module.</li></ul> | Legacy retirement moves **before Stage A** (D12), so browser screening is unavailable from early November even if R1 slips. Deleting legacy code later would mean editing phone test pins; we recommend never deleting it. |
| 2 | Sales Program Advisor only | One new R1 role row (`roles.interview_kind='sales_r1'`) and one kind, `sales_r1` | The R1 role is blocked from Ashby mappings by a DB trigger plus a server 400. |
| 3 | ~20 min: 3-4 icebreaker / ~1 transition / 12-14 role-play / ~2 wrap-up | Phase machine and timing arithmetic in §5.1. Role-play hard exit 14:00; session hard cap 24:00; residency backstop 1,800 s. | — |
| 4 | Rotating pool of 3-4 US personas at the same difficulty | 4 normalised persona cards (§5.5), a simulated-candidate equivalence study before Stage B, and surface variants | The single TTS voice is female (`simran`, `fly.toml:23`), so all personas are women (D7). |
| 5 | All four objection families | Primary line plus an unconditional push for every family, and an F1 counter. Delivered deterministically by the worker (§5.6). Missing any family blocks auto-status. | — |
| 6 | Earned close; needs revealed only when probed | <ul><li>Progressive disclosure: deep needs reach the LLM only after a probe.</li><li>The commitment level is computed by the worker.</li><li>Commitment lines are spoken by script.</li><li>A commitment and concession guard backs this up (§5.3, §5.8).</li></ul> | — |
| 7 | Product facts come from HR's prep deck | One sha-pinned **world-facts sheet** (§5.4), seeded from the deck and completed by the sales lead | The deck lacks the discount↔plan mapping, cohort and deadline facts, class format and weekly hours (D2). |
| 8 | Camera video in v1, for HR review only | In-worker A/V to R2 (§7). No vision, no avatar. | Reverses ADR-0014 for R1; ADR-0016 records this. |
| 9 | Send R1 → link shown once, 72 h, one retake | `interview_rounds` aggregate plus the link token (§8) | Which attempts count, and which attempt decides status: D1. |
| 10 | R1 scorecard plus auto-recommend that writes candidate status | R1 scorer, gates, status rule and calibration (§6) | <ul><li>Conflicts with PLAN.md AI-GATE ("System must not auto-reject", `PLAN.md:740, 1151`). ADR-0015 must explicitly supersede it for R1, with owner and Legal sign-off.</li><li>If HR has already moved a candidate to `advanced`, R1's **only** status effect is rejection.</li><li>Recommended pending-reject window (D3).</li></ul> |
| 11 | Same TTS voice; only the announcement marks the switch | Single voice; scripted transition and exit lines | Optional on-screen phase label and lead card (D8). |
| 12 | DeepSeek V4 Flash, reusing existing wiring | `livekit.plugins.openai.LLM` against the official endpoint with `DEEPSEEK_API_KEY` (§5.14), plus the smoke harness (S0-B) | <ul><li>The canonical id is `deepseek-flash`; `deepseek-v4-flash` is a temporary alias for the same model (D9).</li><li>Legal must accept PRC processing (D11).</li></ul> |
| 13 | Storage: R2 preferred, Supabase Pro acceptable; how much does each give? | Verified numbers in §3.5. **Recommendation: R2.** | — |
| 14 | Under 10 R1/day at launch; stay on the free Build plan | Budget guard and measured cap (§3) | **Infeasible as stated.** About 40 a month (Option A/B/C, §1). |
| 15 | Planning only; 3 adversarial reviews per PR; squash-merge on green CI; merge outside the IST window; migrations auto-apply | Merge gate in §10. Additions: a zero-live-phone and zero-live-R1 check before **any** `app/api`, `app/voice-livekit` or migration merge; latest merge 08:00 IST in the 07:00-08:30 slot; CI hygiene first (PR-pre). | — |

### 2.2 Open decisions (recommended defaults)

| ID | Question | Recommended default | Needed by |
|---|---|---|---|
| D1 | Retake semantics | <ul><li>An attempt **counts once TRANSITION starts** (when the persona is revealed).</li><li>No-shows, exits before TRANSITION, and system failures (`worker_crash`, `provider_error`, `shutdown_forced`, a deploy) never count.</li><li>The persona stays fixed across uncounted restarts. At most 3 starts per link.</li><li>The retake is offered automatically only if attempt 1 produced **no valid gated score**. Otherwise HR can grant the one retake manually.</li><li>Status is written only when the round is final (a valid scored attempt, the retake used, or expiry).</li></ul> | PR-1 |
| D2 | World-facts sheet (sales lead) | <ul><li>Discount↔plan mapping; cohort start; enrolment deadline; seats statement; active seasonal offer (if any); weekly hours; class format.</li><li>A "does NOT offer" list: job guarantee, refunds beyond policy, discounts above $1,500.</li><li>Shared with candidates through the prep guide and with the scorer, never with the learner LLM.</li></ul> | PR-4b |
| D3 | What R1 writes to `candidates.status` | <ul><li>**Advance** → `advanced` immediately (CAS).</li><li>**Reject** → "R1 reject pending" for **24 h**, which HR can cancel, then `rejected`.</li><li>**Hold** → no write; an "R1 hold" flag.</li><li>Every write goes to `audit_events`.</li><li>Auto-status stays **off** until the calibration in §6.6 passes.</li></ul> | PR-5 |
| D4 | Retention | <ul><li>Video: 90 days, deleted by the app, with an R2 lifecycle rule at 97 days as backstop.</li><li>R1 transcripts and scores: follow D-009 (indefinite today, not Legal-approved) unless Legal sets a shorter R1 period, which `r1.sweep` would then implement.</li><li>The notice states whichever applies.</li></ul> | PR-3 (notice), PR-8 |
| D5 | Monthly cap and behaviour when exhausted | <ul><li>Cap = formula in §3.2 (steady state about 40). Auto-pause at 80% of estimated total until two monthly reconciliations agree within 5%, then 85%.</li><li>Send R1 is blocked at the cap.</li><li>A link already sent shows "temporarily unavailable, your link stays valid", and its expiry is extended by the pause (at most +7 days).</li></ul> | PR-2 |
| D6 | Metric weights | Probing 25 / Objections 25 / Communication 20 / Urgency & close 15 / Negotiation 15. Product knowledge off in v1. | PR-2 seed |
| D7 | Persona gender | All 4 personas are women (single female voice) | PR-4b |
| D8 | On-screen phase label and lead card | Yes, for accessibility and task clarity; the voice is unchanged | PR-6 |
| D9 | Model id | `R1_LLM_MODEL=deepseek-flash` | PR-4a |
| D10 | Browser VM | **performance-2x mandatory for v1** (about +$1/month at 40 R1); perf-1x only with production evidence | PR-9b |
| D11 | Live R1 transcripts on the official DeepSeek API (PRC processing, no DPA, PRC law) | A **Legal gate**: staff dry-run use is approved before Stage A, candidates before Stage B. If Legal refuses, the owner chooses: a self-hosted or gateway DeepSeek (the original intent of D-004), or a pause. | Stage A |
| D12 | When legacy browser screening is retired | **Before Stage A** (PR-L, early November). Prerequisite: read-only SQL shows negligible use. | PR-L |
| D13 | Sarvam plan tier (rate limits are per account and shared with phone) | If on Starter (30 TTS req/min, 20 concurrent STT), upgrade before Stage B, or confirm by measurement that phone plus one R1 fits | Stage B |
| D14 | Access and scope | <ul><li>Video visible to admin and the owning interviewer; the `viewer` role only with owner approval.</li><li>Send R1 only for India-located candidates (HR attests) unless Legal widens it.</li><li>Candidates who decline camera or AI evaluation get an HR-arranged human interview.</li></ul> | PR-2 |

---

## 3. Free-plan capacity and cost

### 3.1 LiveKit meters per R1 (Build plan, verified 2026-10-05)

| Meter | Build cap (shared, hard) | Per R1 | Basis |
|---|---|---|---|
| WebRTC participant-minutes | 5,000/month | **~45 typical / 55 planning / ~60 worst** | See below |
| Downstream data | 50 GB | ~0.10 GB (360p15, ≤500 kbps, simulcast off); about 0.016 GB audio-only | The agent subscribes to the camera to record it. A 720p simulcast slip would be about 0.3 GB. |
| Agent audio recordings (observability) | 1,000 min | **0** | `record=False`, all keys off. Today's browser lane uses `record={"audio":True,"transcript":True,...}` (`agent.py:12227-12231`). |
| Observability events | 100,000 | 0 | Same |
| Transcode / track egress | 60 / 60 min | **0** | R1 creates its own rooms and never calls `startAuthoritativeRecording`. Egress would hold at most 2 or 1 R1 a month. |
| Concurrent egress | 2 | 0 | — |
| Third-party SIP | 1,000 | 0 | Phone only |
| Concurrent connections / agent sessions | 100 / 5 | 2-3 / 1 | R1 live concurrency **1**. Combined R1 + live phone ≤4, enforced at admission. |

WebRTC participant-minutes, per participant:
- candidate 20.5-22 min;
- agent 22-24.5 min. The agent is dispatched before the token, and stays alone in the room for ≤1.5 min while the recording finishes;
- preflight 0.2-0.5 min (10 s minimum per attempt);
- worst case adds PRE_JOIN 2 min, the 24:00 hard cap and one rejoin.

Metering facts:
- per-second billing with a 10 s minimum (since 2026-08-24);
- reset on the 1st, **timezone undocumented**, so we assume UTC and keep R1 paused until 12:00 UTC on the 1st;
- free projects pool their allowances;
- the Analytics API needs Scale, so we self-meter;
- at the cap, "new requests fail"; whether live sessions survive is **undocumented**.

### 3.2 Monthly allocation and the cap formula

| Bucket | Minutes | Note |
|---|---|---|
| Auto-pause line | 4,000 (80%), then 4,250 (85%) | 85% only after two monthly dashboard reconciliations agree with our estimate within 5% |
| Phone allocation | 1,500 × 1.2 = 1,800 | An assumption, **not a ceiling**. Unanswered dials bill agent minutes (`PHONE_PARTICIPANT_WAIT_SEC=60`, `fly.phone.toml:441`), and so do canary rooms. S0-A measures it. |
| Planned test minutes | Per month (calendar below) | Logged as ledger entries |
| **R1 cap (sessions)** | **floor((pause line − 1.2 × measured trailing-30-day non-R1 minutes − planned test minutes) / 55)** | Recomputed monthly; the owner approves it |

Worked values:
- non-R1 = 1,500, no tests: (4,000 − 1,800) / 55 = **40**; at 85%, 44;
- with legacy browser still running at the snapshot level (2,847): (4,000 − 3,416) / 55 = **10**. **That is why legacy cutover comes first.**

**Capacity calendar (est.):**

| Month | Planned Cloud test minutes | Real R1 | Cap |
|---|---|---|---|
| Oct 2026 | ~150 (S0-E; 1-2 S0-C confirmation runs; S0-C matrix runs on a self-hosted `livekit-server`) | 0 | 0 |
| Nov 2026 | ~550 (Stage A0 + A, ≥12 sessions) | 0 | 0 |
| Dec 2026 | ~360 (Stage A2 + PR-9 confirmation) | Stage B from about Dec 14 | 20 (half month; the formula gives 33) |
| Jan 2027 onward | ~50 | steady | ~40 (from the formula) |

Demand against the pool: 10/day on weekdays is about 220/month, about 9,500-12,000 minutes. **The supportable average is about 2 R1 per weekday.**

### 3.3 Budget guard that protects phone (PR-1, PR-2, PR-3)

1. **Atomic admission.**
   - One `SECURITY DEFINER` RPC, `r1_admit_attempt`, modelled on `admit_phone_attempt`.
   - It takes `FOR UPDATE` on the current month's budget row and checks:
     - R1 enabled and not paused;
     - session count and estimated minutes plus the hold within the cap;
     - live R1 < 1;
     - live R1 + live phone attempts < 4;
     - starts used < 3; attempts counted < allowed;
     - consent valid and not withdrawn.
   - Then it inserts the session, the attempt and the hold.
   - **Phone admission is never gated.**
   - Concurrency test in the `recovery_concurrency_*` style.
2. **Holds are month-agnostic.**
   - Send R1 holds 55 minutes. Attempt start converts the hold; expiry or cancellation releases it. A retake holds 55 more when it starts.
   - Actual minutes are attributed by ledger timestamp.
3. **Self-metered estimate.** The view `v_webrtc_minutes_estimate` sums:
   - R1 ledger rows (the worker posts agent connect and disconnect plus candidate connected seconds; falls back to session timestamps when rows are missing);
   - phone attempts: admitted→ended + 1 min, from the timestamps at `0042:425-428`, read only;
   - legacy browser `call_sessions` (`mode='browser'`, `interview_round_id IS NULL`): started→ended × 2 + 1 min;
   - preflight starts × 10 s;
   - manual test entries.

   It is multiplied by **1.15** until reconciled.
   - **No phone code change.**
   - No webhook ledger: the LiveKit webhook URL belongs to phone (`app.ts:270-279`) and is on the never-touch list.
4. **Reconciliation.** The owner enters the dashboard's month-to-date figure **daily** during S0 through Stage B, then weekly. The guard uses max(dashboard + estimate since then, the pure estimate).
5. **Auto-pause and alerts.**
   - Auto-pause at the pause line, **or** when the projected month-end total at the current run-rate reaches ≥90%.
   - Mission Control tiles plus structured logs (there is no paging transport, `notification-intent.ts:29-34`):
     - total use at 60/75/90%;
     - the R1 allocation;
     - SIP ≥70%;
     - any quota or join failure;
     - an R1 past 26 min;
     - an agent alone in an R1 room for more than 2 min;
     - any egress on an R1 room.
6. **Savers:**
   - camera and mic acquired before exchange;
   - R1 preflight ≤10 s, at most 10 per link lifetime and 3 per minute;
   - residency 1,800 s instead of 3,600;
   - no live-listen participants;
   - development and S0-C on local or self-hosted `livekit-server`.

### 3.4 Video data-transfer budget

- **Publish settings:** the candidate publishes 640x360 at 15 fps, simulcast off, `maxBitrate` 500 kbps, all set explicitly. The worker also calls `set_video_quality` as a backstop.
- **Usage:** about 0.10 GB per R1, about 4 GB/month at 40, against 50 GB (about 1.8 GB used in the snapshot).
- **Video off:** with `R1_VIDEO_RECORDING=off` the worker subscribes to audio only.

### 3.5 Storage: the owner's question answered (verified 2026-10-05)

| | **Supabase Pro** | **Cloudflare R2** |
|---|---|---|
| Base price | From **$25/month** (includes $10 compute credits) | $0. A card is required; a ~$5 hold is reported only on a community forum (unverified). |
| **Included storage** | **100 GB** | **10 GB-month per month** (Standard class) |
| Storage overage | $0.0213/GB-month | $0.015/GB-month |
| Egress | 250 GB uncached + 250 GB cached, then $0.09 / $0.03 per GB; storage downloads count | **Free** |
| Operations | — | 1M Class A + 10M Class B free per month |
| Max object | 500 GB (**Free plan: 50 MB**) | ~5 TiB; multipart parts 5 MiB-5 GiB, uniform size |
| Lifecycle / CORS | **Not supported** via S3 | Supported |
| Spend cap | On by default. When storage or egress hits quota, **use is blocked project-wide**, phone recordings included. | None; set a billing alert |

- **The repo records Supabase Free** (`docs/decisions/fnd-08-owner-approval.md:19,41,223`). Free cannot hold a typical R1 file: 52-77 MB at 22 minutes, up to 93 MB at maxrate.
- **R2 cost** (85 MB per R1, a conservative upper figure; operations and egress $0; transient partials are deleted after finalize):

| Volume | 90-day steady state | R2 $/month | 180-day | R2 $/month |
|---|---|---|---|---|
| 40/month (steady cap) | 10.2 GB | ~$0.00 | 20.4 GB | $0.16 |
| 60/month | 15.3 GB | $0.08 | 30.6 GB | $0.31 |
| 150/month (reference) | 38.1 GB | $0.42 | 76.1 GB | $0.99 |
| 300/month (reference) | 76.1 GB | $0.99 | 152.3 GB | $2.13 |

**Recommendation: Cloudflare R2.** Use a dedicated bucket `ik-r1-recordings` with a token scoped to that bucket, held only by `project-hello-api`.
- **Cost:** pennies, against at least $25/month for Supabase Pro.
- **Isolation:** no shared spend cap that could block phone uploads.
- **Retention:** lifecycle rules work.
- **Consistency:** ADR-0006 already picks R2 (`docs/adr/0006-recording-capture-and-storage.md:7-10,23-34`).
- **Cost of the choice:** a new S3 adapter (`@aws-sdk/client-s3` plus the presigner) and erasure wiring.

### 3.6 DeepSeek cost per R1 (official price list 2026-10-05)

Peak hours are 01:00-04:00 and 06:00-10:00 UTC on weekdays, excluding PRC holidays; off-peak is half price.

| Item | Cost |
|---|---|
| Conversation, `deepseek-flash` (~45 turns, ~8k input, ~90% cache hits) | $0.016 (fact-checked) |
| Tracker (~25-30 calls, mostly cached) | ~$0.01 (est.) |
| Scoring: 3 runs on `deepseek-v4-pro`, reasoning high, plus repairs | ~$0.15-0.30 (est.) |
| Admission health probe | ~$0 |
| **Total** | **~$0.18-0.33 per R1, about $7-13/month at 40** |

### 3.7 Fly and other run costs
- **Fly VM:** performance-2x, on demand, about $0.037 per 25-minute R1 (perf-1x in sin is $32.19/month, `phone-cost-and-scale-plan.md:16`; perf-2x is 2×). About $1.5/month at 40. Pool: 1 stopped machine.
- **LiveKit:** $0. **R2:** about $0.
- **Sarvam STT/TTS:** not researched; the owner reads the plan and price (D13).
- **Total marginal cost:** under about $15/month plus Sarvam.

---

## 4. Target architecture and end-to-end flow

```
 HR (Vercel SPA: Candidate Detail)                 Candidate (Vercel SPA: /candidate/r1#<link>)
   | Send R1 -> link shown once                       | R1 consent -> camera/mic check -> R1 preflight
   v                                                  v  -> attempt (+nonce) -> R1 exchange -> live room
 +------------------------------------------------------------------------------------------+
 | project-hello-api (Fly sin) -- shared with phone; all R1 code additive + lazily loaded   |
 |  r1-config (lazy, never throws) | r1_admit_attempt RPC (budget, concurrency, starts)     |
 |  /api/r1/* own preflight + exchange: R1 room WITHOUT egress, MIC+CAMERA, no data, 10m JWT|
 |  /api/internal/r1/{context,usage,admin-log,recording/*} (worker bearer + R1 checks)      |
 |  R1 queue runtime (own runner): r1.assessment | r1.recording.finalize | r1.sweep         |
 |  own DeepSeek runner + breaker (scoring, health probe) | R2 presign (creds ONLY here)    |
 |  legacy /api/livekit/{start,invite,exchange,preflight} -> 410; legacy scorer refuses R1  |
 +------+------------------------------------------+----------------------------------------+
        | start machine + dispatch                 | presigned part/PUT URLs     ^ presigned GET (HR)
        v 'browser-screener'                       v                             |
 +--------------------------+  WebRTC  +--------------------------------+  +-----+-------------+
 | LiveKit Cloud (Build)    |<-------->| project-hello-voice (sin)      |->| Cloudflare R2     |
 | SHARED 5,000 min/month   |          | perf-2x, pool 1, R1_LANE_MODE= |  | ik-r1-recordings  |
 | room screening-<uuid>    |          |  r1_only; entrypoint: phone    |  | r1/<round>/<sess>/|
 +--------------------------+          |  return -> lazy r1_session     |  | lifecycle 97 d    |
                                       |  phases | persona | guards     |  +-------------------+
                                       |  RecorderIO (audio) + camera   |--> DeepSeek flash (learner, tracker)
                                       |  -> niced x264 subprocess fMP4 |--> Sarvam STT/TTS (account shared w/ phone)
                                       +---------------+----------------+
                                                       | turns(+phase), lifecycle CAS, ledger, admin log
                                                       v
 Supabase screening_v2: interview_rounds, interview_round_attempts, interview_round_consent_*,
 r1_settings, r1_usage_ledger, interview_round_recordings, call_sessions(+interview_round_id),
 transcript_turns(+phase,+interrupted), job_queue (WHEN-gated trigger -> r1.assessment), assessments, audit_events
 UNTOUCHED: project-hello-phone-voice; phone.py/closing.py/recording*.py/fly.phone.toml; phone RPCs + webhook;
 worker-context route; room-provisioning.ts; consent_templates/records; recordings_v2; RECORDING_*.
```

**End-to-end flow**

1. **Send R1.** `POST /api/candidates/:id/interview-rounds` (admin, or the owning interviewer, claimed by CAS) checks:
   - `R1_ENABLED` and the settings;
   - budget headroom (a 55-minute hold);
   - no active round;
   - `decision_use_blocked_at IS NULL`;
   - **no non-terminal phone engagement and no pending `phone.assessment`** (a later phone score would overwrite R1, `assessment.ts:718-727`);
   - the India-location attestation (D14).

   It creates `interview_rounds` (`invited`, 72 h, `candidate_status_at_send`, `created_by`) and a 256-bit link token (digest stored only, following `invite-token.ts:21-39`). It returns `join_url` **once**, no-store, with a token-free audit (`ashby-mission-control.ts:801-851`). It does not touch `candidates.status`.
2. **Delivery.** HR pastes the link and a provided message template into email or Ashby.
3. **Landing.** The token is read from the fragment and stripped (`CandidateJoinPage.tsx:196-219` pattern). `POST /api/r1/status` returns the state, the attempts left, whether consent is needed, the format description, and a budget-paused notice.
4. **Consent.** An itemised R1 notice and per-purpose consents (§7.8), stored in **R1-only tables**. Declining offers the HR-arranged alternative and flags the card.
5. **Device check.**
   - `getUserMedia` for camera and mic, a mirrored self-view and a level meter.
   - Then `POST /api/r1/preflight`: link-token auth, R1 consent check, a 10 s room, MIC+CAMERA, `canSubscribe:false`, `canPublishData:false`, ≥50 audio packets and ≥45 video frames, at most 10 per link and 3 per minute, counted in the ledger.
6. **Attempt.** `POST /api/r1/attempts` runs `r1_admit_attempt`, which creates a `created` session:
   - `mode:'browser'`, `provider:'livekit'`, `role_id` = the R1 role, `interview_round_id` set;
   - `owner_id = round.created_by`;
   - the attempt row with its fixed persona.

   It returns an attempt token plus a per-attempt **nonce** (kept in sessionStorage). A rejoin within 90 s needs the link plus the nonce. If R1 is busy: `409 r1_busy` ("another interview is finishing, try again in about 20 minutes; your link stays valid").
7. **Exchange.** `POST /api/r1/exchange`:
   - DeepSeek health probe (`GET /user/balance` `is_available` plus a 1-token completion, 3 s deadline, cached 60 s). On failure, "temporarily unavailable" at zero LiveKit cost.
   - Create room `screening-<sessionId>` (emptyTimeout 180 s, maxParticipants 3, **no egress**) and CAS created→waiting.
   - `ensureReadyWorker` plus `createDispatch(room,'browser-screener',{session_id, channel:'browser', kind:'sales_r1'})`. The kind is an observability hint only.
   - 202 while preparing.
   - Token: TTL 10 min; `canPublishSources=[MICROPHONE,CAMERA]`; `canPublishData:false`; `canUpdateOwnMetadata:false`.
   - **No `candidate_invites`, no `candidate_access_grants`.**
8. **Worker.**
   - Phone early return, then `R1_LANE_MODE=r1_only`, then a lazy import of `r1_session`.
   - `POST /api/internal/r1/context` returns sanitised first name, persona and settings.
   - R1 provenance claim, then `activate_session`.
   - The phase machine runs. Turns are written with `phase`. Ledger and admin-log rows are posted. A/V is recorded to R2 through URLs the API mints.
9. **Close.**
   - Every exit takes the same path:
     1. bounded, shielded recording finish (≤60 s target, 90 s max) while the agent stays in the room;
     2. post the ledger disconnect;
     3. terminal write;
     4. room delete.
   - The DB trigger enqueues `r1.assessment`; no scoring HTTP call goes from the worker.
10. **Scoring.** The R1 runtime runs:
    - the R1 scorer ×3 with the administration log;
    - the coverage and fidelity gate;
    - the recommendation.

    Then, if `auto_status_enabled` is on and the round is final, a status CAS (D3).
11. **Finalize.** `r1.recording.finalize`: streaming SHA-256, `ftyp` sniff, size cap → `ready`; then partials are deleted.
12. **HR review.** The R1 panel: recommendation, scorecard with candidate-turn evidence, an administration-quality line, the phase-labelled transcript, the video (presigned GET, click-to-seek).
13. **Contest.** The candidate end page links to the existing appeals flow (`routes/appeals.ts`, `decision_use_blocked_at`).

---

## 5. Conversation design

### 5.1 Phase machine (forward-only; modelled on `closing.py:1-48`; raises on an invalid transition)

Clocks:
- **S** = session clock, from activation.
- **R** = role-play clock, from the end of L-PICKUP. R is **paused** during ASIDE, silence-ladder step 2 and later, the mute aside, and PAUSED_DISCONNECTED.

| State | Entry | Exit | Budget |
|---|---|---|---|
| `PRE_JOIN` | Agent connected | Candidate mic track subscribed | ≤120 s → `no_show` (not counted) |
| `OPENING` | Candidate present | L-OPEN played | ~40 s |
| `ICEBREAKER` | After L-OPEN | Soft: S ≥ 3:30 and ≥4 candidate turns, at the next bot-turn boundary. Hard: S = 4:30. | 3-4 min |
| `TRANSITION` | Icebreaker exit (**attempt counted**, D1) | L-TRANSITION → `READY` (candidate says "ready", or 20 s) → L-PICKUP | ≤90 s |
| `ROLEPLAY` | After L-PICKUP | Soft: R ≥ 13:00 at a turn boundary. Early: R ≥ 10:00 and commitment resolved. **Hard: R = 14:00 or S = 20:00.** | 12-14 min |
| `ASIDE` (sub-state) | Coaching, confusion, silence step 2, or mute | Aside played → `ROLEPLAY` | ≤3 per session; R paused |
| `ROLEPLAY_EXIT` | Role-play exit | L-EXIT played | ~12 s |
| `WRAPUP` | After L-EXIT | 2 questions answered, "no questions", 2:00 elapsed, or 20 s silence | ≤2:00 |
| `CLOSING` | Wrap-up exit, or **any forced close** (S = 24:00, residency, drain) | L-CLOSE / L-SYSTEM-STOP played (not interruptible) | ≤15 s |
| `FINISHING` | Close played, or candidate gone | Recorder finish → ledger → `complete_session` / `fail_session` → room delete | ≤60 s target, 90 s max |
| `PAUSED_DISCONNECTED` | Candidate left | Rejoin (link + nonce) within 90 s → previous phase; otherwise `FINISHING` (outcome `candidate_left`) | 90 s |
| `ABORTED` | 3 consecutive LLM/TTS failures, any 401/402, or worker drain | L-SYSTEM-STOP → `FINISHING` → `fail(provider_error \| shutdown_forced)`, not counted | — |

**Timing arithmetic** (pinned by a unit test):
- Normal path: icebreaker hard 4:30 + transition ≤1:30 → role-play ends by S 20:00 → exit 0:12 + wrap-up 2:00 + close 0:15 = **S ≤ 22:27**.
- Disconnects pause R; the S = 24:00 hard cap absorbs them.
- Maximum agent residency = PRE_JOIN 2:00 + 24:00 + CLOSING 0:15 + FINISHING 1:30 = 27:45 < `R1_SESSION_MAX_RESIDENCY_SEC=1800`, leaving 2:15 margin.
- A residency or hard-cap expiry always goes through CLOSING → FINISHING, never straight to a terminal write.
- The R1 session never installs the goodbye regex (`agent.py:1060-1065, 12203-12218`).

### 5.2 Deterministic scripted lines

- **Delivery:** spoken with `session.say` and stored in the sha-pinned R1 content file.
- **Synthesis:** name-free lines are synthesised once per machine during the first job's `PRE_JOIN` and cached on local disk by sha + voice. `{first_name}` lines are synthesised per session, lazily. Both go through an R1 token bucket (≤5 syntheses/min) with backoff on 429. Nothing runs in prewarm (§9).
- **PII:** `{first_name}` is sanitised server-side (letters, space, hyphen, apostrophe; ≤24 characters; otherwise "there") and is the only candidate PII in any prompt.

| ID | Exact text |
|---|---|
| L-OPEN | "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart, and I'll be running your first-round interview for the Sales Program Advisor role. It takes about twenty minutes. We'll spend a few minutes getting to know you, then I'll switch into a short sales role-play where I play a prospective learner, and we'll finish with a couple of minutes for your questions. Let's start: could you walk me through your background, especially any sales or customer-facing work you've done?" |
| L-TRANSITION | "Thank you, {first_name}. We'll now move to the role-play. I'll play a prospective learner so we can evaluate how you handle a real sales call. The learner is {lead_name} from {lead_city}, who filled in a form on our website about the Data Science course a few days ago. You're the Program Advisor calling her back. Your goal is to understand her needs and help her reach a decision, as you would on a real call, using the course details from your preparation guide. It will run for about twelve to fourteen minutes, and I'll stay in character until I say, 'Let's pause the role-play here.' When you're ready, just say 'ready' and she'll pick up." |
| L-PICKUP | Per persona, e.g. "Hello? Yes, this is Meera speaking." |
| L-TIME-CUE (learner, R ≈ 11:00) | "Just so you know, I've only got a couple of minutes before my next call." |
| L-EXIT | "Let's pause the role-play here. I'm stepping out of the learner's role now; this is Christy, your interviewer, again. Thank you, that's the end of the role-play." |
| L-WRAP | "Before we finish, do you have any questions about the role or the next steps?" |
| L-NO-FEEDBACK | "I'm not able to share how it went. The hiring team will review the full interview and get back to you." |
| L-FAQ-DEFER | "That's a good question for the hiring team; they'll follow up with you on it." |
| L-CLOSE | "Thank you for your time today, {first_name}. The hiring team will review your interview and get back to you. You can close this window now. Goodbye." |
| L-ASIDE-COACH | "Quick note from Christy, your interviewer: in this role-play you're the Program Advisor and I'm the learner, {lead_name}. She enquired about the Data Science course and you're calling her back. Please carry on as you would on a real call." |
| L-MUTE | "This is Christy. It looks like your microphone may be muted. Please unmute when you're ready." |
| L-SIL-IB | "Are you still with me, {first_name}?" |
| L-SIL-RP1 (learner) | "Hello? Are you still there?" |
| L-SIL-RP2 | "This is Christy, your interviewer. It sounds like we may have lost you. I'll wait a few more seconds." |
| L-SIL-END | "I'm going to end the interview here as we seem to have lost the connection. The hiring team will be in touch. Goodbye." |
| L-REJOIN | "Welcome back, {first_name}. Let's pick up where we left off." In role-play this is followed by "The learner is back on the line." |
| L-SYSTEM-STOP | "I'm sorry, {first_name}, we need to stop here because of a technical problem on our side. This won't count against you, and the hiring team will send you a new link. Goodbye." |
| L-FILLER | Interviewer: "Let me think about that for a second." Learner: "Hmm, one second..." |

### 5.3 Same voice, separated knowledge

- **One voice.** `bulbul:v3`, `simran`, pace and temperature as the browser uses today (`agent.py:3501-3536`). The switch is marked by L-TRANSITION and L-EXIT, plus the on-screen label and lead card (D8).
- **Two byte-stable system prefixes, never rewritten mid-call:**
  - **Interviewer prefix:** interviewer rules; the HR-approved **role FAQ allowlist** (shift Mon-Fri 10 PM-8 AM IST, work mode, training, next-step timeline); prohibitions:
    - no feedback or debrief;
    - no questions about age, marital status, children, religion, caste or health;
    - no hiring or compensation commitments.

    It contains **no persona, objection, discount or close content**.
  - **Learner prefix:** non-secret behaviour rules (realistic prospect; 1-3 sentences, ≤45 words; never state product facts; never correct the advisor; never mention being an AI or the test) plus the persona's **public card** (profile, surface answers, fact Q&A). **No hidden needs, no grading or commitment criteria, no other personas.**
- **Progressive disclosure, carried in a per-turn reminder.**
  - The reminder is an ephemeral `system`-role message added in `on_user_turn_completed`. This is the proven seam (`agent.py:4404-4414`; `phone.py:4143-4191`), sent as `system` because DeepSeek rejects `developer` (commit ea3d579).
  - It carries:
    - mode and R;
    - the **exact text** of any owed line ("after briefly responding, say naturally: '…'");
    - deep needs **only for topics the advisor has already probed**, with "reveal only if the advisor follows up on this";
    - the pre-computed commitment response (§5.8).
  - It never carries rubric text.
- **Context filter (R1 `llm_node`).**
  - `ROLEPLAY` calls see: learner prefix + role-play turns + reminder.
  - Interviewer-phase calls see: interviewer prefix + icebreaker turns + (in WRAPUP) the note "the role-play has ended".
  - Each phase keeps a stable, growing prefix for DeepSeek caching, at the cost of one cache miss per phase boundary.
- **Output guard in `llm_node`, before the transcription/TTS tee (`agent_activity.py:2454-2457`)**, so captions, `transcript_turns` and scorer input are filtered as well as speech. It runs per sentence in **every** phase and blocks:
  - control vocabulary (`CONTROL`, `OWED`, `H1-H3`, `F1-F4`, `rubric`, `system prompt`, "as an AI", "language model");
  - in interviewer phases, persona-secret vocabulary: persona names, need keywords, "$7,000", "objection", "hidden need";
  - in WRAPUP, feedback phrasing ("you did well", "your score");
  - in ROLEPLAY, commitment and concession phrasing outside the permitted level (§5.8).

  Replacement: "Sorry, what were you saying?", L-NO-FEEDBACK, or the persona's WEAK stall. Every hit logs `r1_guard_*`. The phone echo check (`phone.py:10567-10605`) is copied, not imported.
- **Phone validators are not reused.** `compensation_drift` and the question-act ceiling would fire on "price" and "package" (`phone.py:11164-11265, 9023-9025`).

### 5.4 World-facts sheet (D2; sales lead owns it)

- **Content:** versioned and sha-pinned (`r1_world_facts_vN`). Seeded from the prep deck:
  - IK founded 2014; interview prep across 18 engineering domains, plus ML/DS career-transition courses;
  - 750+ instructors from Google, Facebook, Amazon and Netflix;
  - the Data Science course and its modules (Python Fundamentals, Database & SQL, Math for DS & ML, EDA, Classical ML, Advanced ML & DL, Big Data Analysis, Data Visualization & Storytelling, Capstone);
  - list price $9,000; 6 months; the target audience and career outcomes;
  - course USPs; urgency levers.
- **The sales lead adds:**
  - the **discount↔plan mapping** ($500/$1,000/$1,500);
  - cohort start; enrolment deadline; seats statement; any active seasonal offer;
  - weekly hours range; live vs recorded format; what projects look like;
  - a **"does NOT offer"** list.
- **Who sees it:**
  - **Candidates**, through the prep guide, so the role-play tests selling skill rather than guessing.
  - **The scorer** (§6.2).
  - **Never the learner LLM.**
- **Scoring rule:**
  - claims consistent with the sheet are legitimate;
  - plausible specifics the sheet does not cover are neutral unless coercive;
  - promises in the "does NOT offer" list, or that contradict the sheet, are violations.

### 5.5 Persona pool (4 normalised cards; reviewed by the sales lead before PR-4b)

**Calibration constants for every persona**
- **Lead:** inbound (website form, a few days ago). Knows only "around $9,000 on the website, about 6 months".
- **Three hidden needs, same shape.** Each has a surface answer on the first related question and a deep need revealed only on a follow-up after the probe:
  - **H1 why now:** a dated trigger, which is the urgency hook;
  - **H2 doubt / past setback:** the value hook;
  - **H3 practical constraint:** schedule, money ("would need instalments") and the decision-maker.
- **Objections, the same for every persona:**
  - **F3 value:** primary "There's so much free stuff on YouTube and Coursera — why pay?"; push "Will this actually get me a job, with all these layoffs?"
  - **F2 time:** primary "My schedule is already packed; I'm not sure I can keep up for six months"; push "What happens if I fall behind?"
  - **F1 price:** anchor "$9,000 is a lot. I've heard people got it for around $7,000 — can you do that?"; **counter** after the advisor's first concession or refusal: "Can you do a little better than that?"
  - **F4 stall:** primary "Let me think about it — maybe I'll join the next cohort"; push "I'd also need to talk to my {decision_maker}."
- **Two neutral prospect questions,** answered by the advisor from the sheet:
  - Q-A "Is it live classes or recorded?"
  - Q-B "What would I actually build in the course?"
- **Commitment lines,** structurally identical:
  - **STRONG:** "Okay, let's do it. Send me the enrolment link for that plan and I'll pay the deposit today."
  - **MEDIUM:** "Let's book a call on Thursday at 7 PM with my {decision_maker} so we can decide."
  - **WEAK:** "Let me think about it. Just email me the details and I'll get back to you."
- **Fact Q&A (public card):**
  - manageable monthly budget: "around $500-700 a month";
  - decision timeline: "within a couple of weeks";
  - prior learning;
  - competitors: "looked at a couple of bootcamps, didn't compare in detail";
  - how she heard: "a webinar";
  - what success means: "a data role within a year".

  Anything not on the card gets a consistent, vague answer: "I'm not sure, I haven't thought about that."
- **Surface variants:** 3 per persona (name, city, employer type), chosen at random and recorded as `persona_variant`. The structure stays fixed.

**P1 Career switcher: Meera Iyer, 33, Edison NJ.** Eight years in pharma operations and quality; Excel-heavy; no coding.

| Need | Surface answer | Deep need |
|---|---|---|
| H1 | "Just exploring options." | Plant consolidation is due next year; her role has been stagnant for 3 years. |
| H2 | "I've tried a bit of online stuff." | She quit a free Python course after 3 weeks without structure and fears she is "too old to start coding". |
| H3 | "My schedule is pretty packed." | Two kids, so evenings and weekends only; shared finances; needs monthly instalments. Decision-maker: husband. |

**P2 Recent graduate: Ananya Rao, 24, Austin TX.** MS in Information Systems (May); working as a contract reporting analyst; 150+ data-scientist applications; two final-round losses.

| Need | Surface answer | Deep need |
|---|---|---|
| H1 | "The job search is okay." | Her contract renewal is decided in about 6 months and she wants a DS role by then. |
| H2 | "I get some interviews." | She keeps failing the ML and technical rounds; self-study isn't working. |
| H3 | "Money's a bit tight." | Student loans, so instalments only. Decision-maker: father. |

**P3 Working data analyst: Kavya Menon, 29, Charlotte NC.** Four years as an analyst at a bank (SQL, Excel, Tableau, some Python).

| Need | Surface answer | Deep need |
|---|---|---|
| H1 | "Thinking about my next step." | Passed over for an internal DS role ("not enough ML depth"); next opening in 6-8 months. |
| H2 | "I already know a lot of the basics." | Fears the course will repeat SQL basics; restructuring rumours make her doubt DS is a safe bet. |
| H3 | "Work gets crazy sometimes." | Quarter-end crunches; she pays herself and needs instalments. Decision-maker: husband. |

**P4 Research scholar: Shalini Verma, PhD, 31, Boston MA.** Postdoc in computational biology; strong Python, R and statistics.

| Need | Surface answer | Deep need |
|---|---|---|
| H1 | "Weighing a few paths." | Her funding ends in about 8 months and the academic market is bleak. |
| H2 | "Industry interviews are different." | Rejected after an industry case round; lacks production ML, SQL and interview skills; feels like an outsider. |
| H3 | "I'm still running experiments." | Tight postdoc budget, so instalments. Decision-maker: partner. |

**Assignment rules**
- Least-used persona first, with a random tie-break.
- The persona is fixed for the round across uncounted restarts.
- A counted retake gets a different persona.
- `persona_id`, `persona_version` and `persona_variant` are stored on the attempt.
- Retakes are excluded from persona-equivalence statistics.

### 5.6 Owed-move scheduler (deterministic, worker-side, on clock R)

| Move | Opens | Deadline (forced at the next learner turn) |
|---|---|---|
| Discovery (protected): the learner answers only what is asked | 0:00 | — |
| Q-A | 2:00, if format not yet covered | 3:30 |
| F3 primary, then push (unconditional, next learner turn) | Advisor's first value or pitch statement, or 3:30 | 5:00 |
| F2 primary, then push | ≥2 candidate turns after the F3 push was answered | 7:00 |
| F1 anchor, then counter (after the first concession or refusal) | ≥2 candidate turns after F2; immediately if the advisor quotes a price first | 9:00 |
| Q-B | After F1 resolved, if not covered | 9:45 |
| F4 primary, then push | ≥2 candidate turns after F1/Q-B | 10:30 |
| L-TIME-CUE | 11:00 | — |
| Commitment window | All 4 families (primary + push + counter) delivered **and** R ≥ 9:00 | If no ask by 13:00 → the WEAK line |

Rules:
- At most **one owed move per learner turn**.
- Never open a family until the previous exchange is answered; later deadlines shift instead.
- Delivery is confirmed by fuzzy match of the exact line on the learner text. If it was missed, it stays owed. The delivery time and any slip are logged.
- **Any family slipping more than 60 s, or never delivered, excludes the session from auto-status.**
- An early close attempt before R = 10:00 gets "Oh wait, before you go…" plus the next owed move, **once**. On a second attempt the call goes to `ROLEPLAY_EXIT`.

Escalation if S0-B shows poor adherence: the learner's primaries are spoken verbatim via `session.say` after a short LLM acknowledgement.

### 5.7 Negotiation (learner side, the same for everyone)

1. Anchor at $7,000.
2. After the advisor's **first** answer (concession or refusal), one counter.
3. After the second answer, "Okay, that's helpful" and move on. Commitment is governed separately (§5.8).

The learner never states plan or discount facts. If the advisor goes past $1,500 off, or invents offers, the learner **accepts happily and never corrects them**; the scorer catches it.

### 5.8 Earned close (decided by the worker, enforced deterministically)

**Grade**, computed from the worker's own reveal log (ground truth, because the worker gates reveals), deterministic `$` parsing of candidate text, and the tracker latch:

| Grade | Criteria (all must hold) | Learner |
|---|---|---|
| STRONG | <ul><li>Commitment asked.</li><li>≥2 of 3 deep needs revealed.</li><li>All 4 families answered with tracker quality ≥1, including F1.</li><li>Discount discipline intact: any discount ≤$1,500, conditional, not offered before a value statement.</li><li>A legitimate urgency lever used.</li></ul> | STRONG line |
| MEDIUM | Commitment asked; ≥1 deep need revealed; ≥2 families answered with quality ≥1 | MEDIUM line |
| WEAK | Otherwise | WEAK line |

**Enforcement**
- In `on_user_turn_completed`, a deterministic **ask detector** runs on the candidate's text (enrol, sign up, deposit, payment link, "shall I send", "can we book", "are you ready to"). If it fires and commitment is permitted, the worker stops the LLM reply and **speaks the scripted line for the current grade**. Before R ≥ 9:00, or before all families are delivered, it speaks the WEAK stall.
- Every reminder also pre-states "IF the advisor asks you to commit, respond exactly: <line>" as defence in depth.
- The guard in §5.3 replaces any LLM commitment or "you've convinced me" phrasing outside the permitted level.
- Before R ≥ 9:00 the learner may acknowledge a point but never says it is resolved.
- The commitment outcome is logged and is **not** scoring evidence; the scorer sees a masked placeholder.

### 5.9 Live coverage tracker

A shadow judge modelled on `judge_phone_coverage` (`phone.py:12316-12426`), with a new payload and prompt.
- **Timing:** runs after each `ROLEPLAY` candidate turn, concurrently and off the speech path, with a 4 s deadline. Its output feeds the next reminder (one-turn lag; `agent.py:4035-4056` pattern).
- **Model:** `deepseek-flash`, thinking off. JSON is requested in the prompt; no `response_format` (commit 05fba17).
- **Safety:** candidate text is fenced with a sentinel; the output is schema-validated; failure is fail-closed (no state change).
- **Output:**
  - `probed_topics[]`
  - `family_handled_quality{F1..F4: 0|1|2|null}`
  - `discount_offered_usd`, `discount_conditional`, `value_before_discount`
  - `invented_offer`
  - `urgency_lever`
  - `candidate_out_of_role`
  - `injection_attempt`
- **Probe detection:** a deterministic keyword matcher per need topic runs in parallel as the fast path. Either source marks a topic probed.
- **Flag use:** `injection_attempt` and `candidate_out_of_role` are shown to HR as "model-detected, unverified" and are **never** used in scoring or status.

### 5.10 Character breaks and prompt injection

- **"Are you an AI?" or "Is this the test?":** one in-character deflection. If repeated, or if the candidate asks to be coached, L-ASIDE-COACH plays once (phase `aside`, excluded from evidence).
- **Injection:**
  - the LLM has **no tools** and cannot change phase, commitment level or end the call;
  - candidate text is dialogue only;
  - the reminder repeats the ignore rule;
  - the guard runs in all phases.
- **Typed injection is closed:** R1 starts with `room_options` `text_input=False` (livekit-agents 1.6.4 defaults it on and registers an `lk.chat` handler, `room_io/types.py:109,132-136`), and tokens carry `canPublishData:false`.
- **Bot breaks character:** the guard replaces the sentence. ≥3 hits flags the session for HR and fails the fidelity gate.

### 5.11 Silence, no-show, mute, monologue, disconnect

| Situation | Handling |
|---|---|
| No candidate within 120 s | `no_show`; not counted; the hold is kept for the link |
| Silence in `ICEBREAKER` | 30 s → L-SIL-IB; 20 s more → L-SIL-END (production values 30/20, `fly.toml:25-26`) |
| Silence in `ROLEPLAY` | 20 s → L-SIL-RP1 (learner); 20 s → L-SIL-RP2 (aside; R paused); 15 s → L-SIL-END |
| Silence in `WRAPUP` | 20 s → `CLOSING` |
| Candidate mic muted (track muted event) | L-MUTE instead of the silence ladder; R paused; that time not counted |
| Candidate turn > 60 s | The reminder carries `CANDIDATE_MONOLOGUE=<s>` so the learner reacts the same way for every candidate; monologue length is logged for communication |
| Disconnect | `PAUSED_DISCONNECTED` for 90 s; rejoin needs link + nonce; L-REJOIN; R paused; otherwise `candidate_left` (counted only per D1) |
| LLM / TTS failure | First-audio watchdog 4 s → L-FILLER plus one retry. **Wall-clock deadline 12 s per turn** (asyncio-cancelled, because DeepSeek SSE keep-alives defeat inactivity timeouts). 3 consecutive failures or any 401/402 → `ABORTED` (not counted). |

The silence loop is copied with R1 wording and windows; the shared constants are unchanged (`agent.py:1080-1146`).

### 5.12 Ending rules and the exit invariant

- **Invariant for every exit** (completed, candidate_left, no_show, silence end, ABORTED, residency, drain):
  1. shielded, bounded recording finish;
  2. ledger disconnect;
  3. terminal write using an **existing** terminal reason (the TS/Python/SQL parity set is unchanged, `session-lifecycle.ts:75-80`);
  4. `close_room_once`.

  The R1 outcome goes on `interview_round_attempts.outcome`.
- **Counting contract (PR-4a worker, PR-8 `r1.sweep`; capacity model, migration 0119).** The worker writes `attempts_counted` (and `interview_round_attempts.counted`) **while the session is still live**, at TRANSITION (D1), never after the terminal write. The capacity model treats a round with `charged_attempt_number > attempts_counted` and no live session as a hold kept for the link, and the sweep, cancel and expiry refund it for good once the link is dead (three starts used, a lapsed link, or a terminal status). A count written afterwards can lose that race: a counted third start, or a session that ends just before the link expires, is refunded before it is counted and its 55 minutes are lost from `minutes_used`. An **uncount after a system failure** (`worker_crash`, `provider_error`, `shutdown_forced`) is written in the **same transaction** that terminalizes the session; crash recovery below does the same. Cancelling a round during a live session refunds nothing for the same reason. See `docs/runbooks/r1-operations.md`, "Worker contract for counting".
- **Normal close:** L-CLOSE sets the participant attribute `phase=ended`, using a plain lowercase key (camel-casing trap, #332), so the page leaves.
- **Crash recovery:** `r1.sweep` turns any attempt still `in_progress` after residency + 5 min into `fail(worker_crash)` (not counted; the terminal write and any uncount are one transaction, see the counting contract above). It then:
  - completes the multipart upload;
  - computes minutes from session timestamps;
  - releases the hold;
  - enqueues finalize.

### 5.13 Fairness and comparability

- **The same for everyone:** phase budgets, owed-move schedule, push and counter, anchor, commitment criteria, scripted lines, temperature and token cap. No résumé in prompts.
- **Candidate preparation:** the landing page and prep guide describe the format; the time cue is the same for everyone.
- **Scorer rule:** ignore accent, grammar, speech-to-text artefacts and any protected information disclosed.
- **Pre-launch equivalence study (gate for Stage B):**
  - LLM-driven simulated candidates at 3 scripted skill tiers × 4 personas × ≥10 runs, scored by the R1 scorer;
  - accept only if per-persona mean overall is within ±5 points and per-metric means within ±0.3 level at each tier;
  - otherwise fix the cards, bump `persona_version`, and re-run.
- **Post-launch:**
  - pooled persona comparison at n ≥ 20 per persona (retakes excluded);
  - a persona that drifts is recalibrated with a `persona_version` bump, and **auto-reject is suspended for that persona** until it is re-equated;
  - pass rates by STT-quality band are monitored for accent or ASR adverse impact.

### 5.14 DeepSeek configuration (`app/voice-livekit/r1_llm.py`; not in `_build_provider_session`)

```python
openai.LLM(model=os.getenv("R1_LLM_MODEL") or "deepseek-flash",
           base_url=os.getenv("R1_LLM_BASE_URL") or "https://api.deepseek.com/v1",
           api_key=os.getenv("DEEPSEEK_API_KEY"), temperature=0.6, reasoning_effort="none",
           extra_body={"thinking": {"type": "disabled"}, "max_tokens": 300},
           timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0))
# llm_conn_options=APIConnectOptions(max_retry=1, retry_interval=0.5, timeout=10.0) + asyncio wall-clock deadline
```

- **Thinking is hard-coded off.** A tripwire logs an error if `reasoning_tokens > 0`.
- **Fail closed per session, never crash-loop:** exact-host check (pattern `phone.py:8378-8387`) and a `startswith("deepseek")` model check.
- **Messages:** roles system, user and assistant only; no tools; no `response_format`, `prompt_cache_key`, `user` or `metadata`. `finish_reason=length` is logged.
- **Warm-up (optional):** an identical `system` message with `max_tokens:1`. Not a `user` message; the phone warm-up likely misses the cache (`phone.py:8768`).
- **Key:** reuse `DEEPSEEK_API_KEY`, declared at `config/environment.schema.json:177`. **It is not set on `project-hello-voice` today**; the owner stages it before PR-4a. A dedicated R1 key is optional, for blast radius.
- **Provenance:** `r1_provenance()` lives in `r1_llm.py` and calls `provenance.create_provenance`, so `provenance.py` is unchanged. Provider `deepseek`, workload `screening`, and an R1 template version that PR-4a's test proves passes the existing validators.

### 5.15 Latency plan (measure first)

1. **Measure.** The metric sink is a no-op (`observability.py:579`), so R1 emits paired log lines per turn on channel `r1`: end-of-speech → LLM first token → TTS first frame → first audio (pattern `agent.py:687-690, 728-731`). The cache log (`agent.py:642`) gains an `r1` channel.
2. **Early flush.** Copy the Sarvam first-fragment early-flush `tts_node` (`phone.py:3950-4019`); without it first audio is about 2.9 s (`phone.py:1384-1424`).
3. **R1 `turn_handling`** (the SDK defaults are 0.3/2.5 s and `min_words` 0): endpointing 0.7 / 3.5 s; interruption `min_duration` 0.7 s; `min_words` 2. Preemptive generation stays on only if S0-B shows the reminder is still honoured.
4. **Short replies.** Scripted lines are pre-synthesised; learner replies are ≤45 words / 300 tokens.
5. **Fast start.** Camera and mic are acquired before exchange.
6. **Targets** (confirmed in Stage A): end-of-speech → first audio p50 ≤1.8 s, p95 ≤3.0 s; scripted lines start within 0.5 s.

### 5.16 Spike alternative: `AgentTask` / handoff

- An Interviewer and a Learner `Agent` (same TTS), switched by the worker with `session.update_agent`, or `AgentTask` for the role-play (`voice/agent.py:723-983`).
- Verified in the SDK wheel, never used in the repo.
- S0-B compares it with the single-agent design plus context filter. v1 ships single-agent unless S0-B shows a clear adherence gap.

---

## 6. Scoring design

### 6.1 R1 scorecard (1-4 scale; anchors ≤500 characters, `schemas/scorecards.ts:34-54`; countable behaviours)

The metrics are hand-written library rows, seeded by a reviewed script (`seed-r1-role.ts`, precedent `seed-program-advisor.ts`). They replace the 0089 default metrics on the R1 role **before** the first session. Probing, objection, urgency and negotiation evidence must come from **ROLEPLAY candidate turns**.

| Metric (weight) | 4 | 3 | 2 | 1 |
|---|---|---|---|---|
| Probing & discovery (25%) | ≥4 open questions before the first pitch or price; ≥2 follow-ups that build on the learner's answers; ≥2 deep needs revealed (per the admin log); summarises needs back; the pitch references ≥2 stated needs | ≥2 open questions before pitching; ≥1 follow-up; ≥1 deep need revealed and linked to the pitch | Mostly closed questions or an early pitch; needs surface only when the learner raises them | No discovery; opens with features or price |
| Objection handling (25%; objections actually raised) | For each: acknowledges, clarifies or reframes, answers with sheet/prep facts tied to a stated need, checks resolution; no false claims | Answers most with relevant facts; sometimes skips clarifying or checking | Generic or defensive; ≥1 objection ignored or unresolved | Argues or dismisses, or promises something on the "does NOT offer" list |
| Urgency & close (15%) | Urgency tied to a need the learner stated, using a lever consistent with the sheet, not coercive; asks for a commitment or a dated next step with the decision-maker. A reasoned "not right now" with a dated next step counts. | Some relevant urgency; asks for a next step | Vague urgency or no clear ask | Coercive or fabricated pressure, or contradicts the sheet |
| Negotiation & discount discipline (15%) | Defends value before any discount; never opens with one; any discount ≤$1,500, tied to a sheet plan or deadline, traded for a commitment; holds or trades after the counter | Within the ladder and conditional, but concedes on the first ask or without a trade | Offers the maximum quickly or unconditionally | Exceeds $1,500, accepts the $7,000 anchor, or invents discounts or freebies |
| Communication & rapport (20%; all phases; worker-computed facts) | Clear, structured icebreaker answers; refers back to the learner's words ≥2 times; talk share 40-65%; no monologue >90 s; professional | Clear and polite; one monologue >90 s, or talk share slightly outside the range | Frequent monologues, ≥3 barge-ins over the learner, or disorganised | Rude, incoherent or unprofessional |
| Product knowledge (0% in v1, D6) | Accurate, relevant use of sheet facts | Mostly accurate | Vague or minor errors | Wrong facts |

### 6.2 Scorer inputs

- **Phase-aware transcript**, with turn indices.
  - Role-play bot lines are labelled **"Learner (simulated by the AI; never evidence)"**; other bot lines "Interviewer"; role-play candidate lines "Candidate (as Program Advisor)". Today every bot line is labelled `Interviewer:` (`prompt.ts:40-45`).
  - Commitment lines are masked.
  - Interrupted learner turns are included with an `interrupted` flag. Today they are dropped (`agent.py:12194-12195`); R1 has its own writer.
  - The candidate's name is masked.
- **Trusted administration log**, from the worker via `/api/internal/r1/admin-log`:
  - the persona's needs, with the turn each was probed and revealed;
  - families, pushes and the counter, with turn indices and slip;
  - discounts detected;
  - time cue; guard hits.
- **Worker-computed communication facts:** candidate talk share, longest monologue, barge-in count, question count, interruptions.
- **The world-facts sheet.**
- **Fencing:** all inputs sit inside the existing sentinel-fenced untrusted-transcript pattern (`prompt.ts:16-83`), reused in `r1-prompt.ts`.
- **Evidence contract (R1-only):** each evidence ref carries a `turnIndex`, validated to be a candidate turn in the allowed phase. Today refs are ≤80-character excerpts that are not speaker-checked (`prompt.ts:101,113`; `domain.ts:219-231`). On a violation: one repair, then `human_review`.

### 6.3 R1 scorer isolation

- **Code:** new `lib/scorecards/r1-prompt.ts` and `services/r1-assessment.ts`, selected only when `call_sessions.interview_round_id IS NOT NULL`.
  - The phone prompt builder is not edited.
  - A **phone scorer prompt byte-identity fence** is added anyway.
  - The integrity pass is skipped for R1 (`integrity.ts:98-144`).
  - Scoring provenance version `r1-scoring-2026-1x.1`; `prompts.ts:9` is unchanged.
- **Own DeepSeek runner:** `createDeepseekRunner({ breaker: new CircuitBreaker(R1 thresholds) })`. It never calls the default exports, whose single breaker is shared with résumé parsing and phone scoring (`deepseek.ts:260-270, 374-377`; hazard documented at `app.ts:339-342`). A test drives R1 failures past the threshold and asserts the default breaker stays CLOSED. The R1 timeout comes from R1 config (≤300 s).
- **Three runs per transcript** (in parallel; V4-Pro concurrency 500).
  - Per-metric median.
  - If the recommendation differs across runs, or any metric spreads by more than 1 level → `human_review`.
  - S0-B measures V4-Pro latency on a 20-minute transcript.
- **Legacy scorer closed to R1:** `runAssessment`, `/api/livekit/:id/complete`, `/:id/recording`, `/grant/recording` and `/api/internal/assess/:id` return **409 `r1_session`** when `interview_round_id IS NOT NULL` (`livekit.ts:422-509, 594-606`; `assess.ts:41-58`). Phone sessions never carry that field.

### 6.4 Coverage and fidelity gate (all must hold before any auto-status; otherwise `human_review`)

- R ≥ 10:00 reached; ≥8 candidate role-play turns of ≥3 words.
- **All 4 families delivered** (primary + push), plus the F1 counter. Every family slip ≤60 s.
- No deep need revealed without a logged probe; no commitment or concession outside the permitted level; fewer than 3 guard hits.
- Learner end-of-speech → first-audio p95 ≤3.0 s.
- STT sanity: <10% of candidate role-play turns are ≤2 words or non-lexical.
- Scoring complete; the 3 runs agree; evidence validated.
- No system-failure outcome; the round is final (D1).
- HR sees an **"administration quality"** line for each session.

### 6.5 Recommendation and status (D3)

- **Thresholds:** start at advance ≥65 and hold ≥45 (held in `r1_settings`; `domain.ts:423-428` unchanged), then **re-fit on the calibration set**.
- **Integrity floor:** level 1 on objection handling or negotiation caps the result at `hold`.
- **Status writes:** a CAS on `candidates.status = candidate_status_at_send AND decision_use_blocked_at IS NULL`, so a human change made after sending wins.
  - **Advance** → `advanced`.
  - **Reject** → pending 24 h (visible and cancellable on the card), then `rejected`.
  - **Hold** → no write, plus a flag.
- **Audit:** every write (and every cancelled pending reject) goes to `audit_events`: actor `system:r1`, `assessment_id`, scorer and prompt versions, thresholds version, prior and new status. There is no status-history table today.
- **Owner must know:** if HR already moved a candidate to `advanced` before R1, R1's **only** possible status effect is rejection. The false-reject rate is therefore the error that matters.
- **Identity:** HR is advised to check identity on the video before acting on an advance.

### 6.6 Calibration and switching auto-status on

1. Write a **rater guide** with worked anchor examples and train HR raters.
2. Build a **gold set** of ≥20 transcripts across skill tiers (from the S0-B harness). Use it to check scorer validity and test-retest stability **before Stage B**.
3. **Stage B in shadow mode:** ≥30 real R1s, each rated blind by **2** HR raters. Measure human-human agreement first (quadratic-weighted kappa per metric).
4. **Switch-on criteria:**
   - bot vs rater consensus QWK ≥0.6 per metric, and no more than 0.05 below human-human;
   - exact-level agreement ≥60%;
   - **zero** bot-reject / human-advance cases;
   - bot-reject precision ≥90%. With fewer than 15 bot rejects, report the 95% CI and let the owner decide.
   - Thresholds are re-fitted on this set.
5. The owner flips `auto_status_enabled` on the admin page (audited by a DB trigger on `r1_settings`).
6. **After go-live:** track the HR override rate on R1 rejects. **Auto-disable auto-status at >10% over a rolling 20.**

### 6.7 Durable `r1.assessment` queue

- **Trigger:** `enqueue_r1_assessment` on `call_sessions`, `AFTER UPDATE OF status … WHEN (new.interview_round_id IS NOT NULL AND new.status='completed' AND old.status IS DISTINCT FROM 'completed')`. It does nothing for phone. Dedup key `r1.assessment:<session_id>`; `max_attempts` 5. No queue allowlist exists (`0009:18-43`).
- **Dedicated R1 queue runtime:** its own `createQueueRunner`, concurrency 1, and a `shouldClaim` gate on `r1_settings.enabled`. It hosts `r1.assessment`, `r1.recording.finalize` and `r1.sweep`. **Never** registered in the phone runtime (handlers `{phone.dial, phone.assessment}`, concurrency 1, `phone-runtime/runtime.ts:838-852`) or in the recording runtime. A structural test asserts the phone handler set is exactly those two.
- **Idempotency:** CAS on `interview_rounds.assessment_id IS NULL`.
- **Failures:** DLQ rows go into `v_funnel_failures` (`0091:178-186`), with a snapshot test that phone rows are unchanged. Repeated fail-closed scorer validation (a known flake) ends in `human_review` plus a Mission Control alert.

### 6.8 Dashboard

- **R1 panel:** state, expiry, attempts, persona and variant; recommendation and overall score; per-metric levels with candidate quotes (click to seek the video); flags (unverified); administration quality; camera-off time; pending reject; the phase-labelled transcript.
- **Candidate list and funnel:** the "latest assessment" (`candidates.ts:228-233, 309-316`; `0090:345-349`) **excludes R1**; a separate R1 column is added.
- **Mission Control:** budget, queue, DLQ, per-persona means, override rate, guard-hit rate, latency p95.

---

## 7. Video recording within the free plan

### 7.1 Approach

**In-worker A/V recording:** 0 extra participant-minutes, 0 egress slots, about 0.1 GB downstream per R1.

Rejected alternatives:
- **LiveKit egress:** 60/60 minutes a month, so at most 2 or 1 R1.
- **Browser MediaRecorder:** the candidate can tamper with it; it doubles uplink and encoding load; ADR-0006 rules browser capture out as a production mechanism (`:35-36`).

### 7.2 Pipeline (new `r1_recorder.py`, `r1_video_encoder.py`; `recording.py`/`recording_api.py` untouched)

- **Audio:** import the SDK `RecorderIO` and wire it after `session.start` (pattern `recording.py:573-688`). It writes a stereo OGG spool locally; the session uses `record=False`.
- **Video:**
  - `rtc.VideoStream.from_participant(SOURCE_CAMERA, format=I420, capacity=3)`; capacity >0 drops the oldest frame.
  - Drop to 15 fps, reformat to 640x360, PTS from the monotonic clock relative to RecorderIO's t0.
  - Frames go over a **non-blocking, frame-dropping pipe** to `python -m r1_video_encoder`, spawned at R1 job start with `os.nice(10)`.
  - The encoder runs PyAV `libx264` (preset from S0-C, `tune=zerolatency`, `threads=1`, CRF 28, `maxrate` 500k, GOP 2 s) and writes **fragmented MP4**.
  - Camera off or republished: re-attach to the same encoder; black frames at 1 fps while off; `camera_off_ms` recorded.
- **Finish:**
  1. close RecorderIO (bounded at 3 s);
  2. flush the encoder;
  3. complete the multipart upload;
  4. in the subprocess, remux into a **faststart `video/mp4`**: copy H.264, transcode Opus → AAC-LC 64 kbps **mono** (about 5-10 s of CPU);
  5. one presigned PUT.

  If S0-D shows the fMP4 seeks well in Chrome and Safari, the remux is dropped and the streamed fMP4 (with audio muxed live) becomes the deliverable.
- **Dependencies:**
  - PR-dep freezes the current image's transitive set (`constraints.txt` from `pip freeze` of the running phone image).
  - A startup self-test inside the R1 job checks the `libx264` and `aac` encoders, wrapped in try/except. On failure: audio-only plus an alert.
  - `r1_video_encoder.py` is appended to the `Dockerfile:102` COPY line **after** the prefix `COPY agent.py closing.py noise_suppression.py `, which `test_phone_noise_wiring.py:337` pins.
  - `r1_recorder.py` contains a real (function-local) `import r1_video_encoder`, so the import-closure check covers it.
- **Licensing:** libx264 is GPL and already ships in the image's PyAV wheel. VP8/WebM is the fallback if Legal objects (Safari playback unverified).

### 7.3 CPU isolation and VM

- **Isolation:**
  - The encoder is a niced subprocess. Decode and frame copies stay in the job process, and S0-C measures them separately.
  - **Auto-degrade** on the **first** VAD "slower than realtime" warning, or loop-lag max >250 ms within any 5 s window: kill the encoder, unsubscribe the camera, continue audio-only (`audio_only_degraded`).
  - `R1_VIDEO_RECORDING=off` (the default in PR-9a) means audio-only subscription and no decode.
- **VM:** **performance-2x mandatory** (D10). The `[[vm]]` change in `app/voice-livekit/fly.toml:59-62` affects only `project-hello-voice`.
- **Pool:** 1 machine. **R1 live concurrency is 1.** The browser lane registers one shared name with no one-job load gate (`agent.py:2008-2014`; `browser-orchestration.ts:157`), which brings back the M009 wrong-machine-stop hazard (`phone-worker-orchestration-activation.md:319-329`). Concurrency 2 needs a later reviewed PR (PR-C2) with per-machine names plus a one-job `load_fnc`.

### 7.4 Upload, durability, finish and crash recovery

- **Video:**
  - The API creates an R2 multipart upload (one `upload_id` per session).
  - The worker requests **one presigned UploadPart URL at a time** (TTL ≤10 min) for uniform **5 MiB** parts and returns the ETags. Part numbers are capped server-side (60).
  - Loss window: one part, about **2-4 min** at 200-350 kbps.
- **Audio:** the OGG is checkpointed every **2 min** by presigned PUT to `audio.partial.ogg` (about 1 MB per checkpoint).
- **Credentials:** **no R2 credentials ever reach the worker image**, which phone shares.
- **Finish:** the agent stays alone in the room (≤1.5 min billed). The reaper spares rooms with participants (`worker-orchestration.ts:1055-1066`), so the finish completes before the terminal write.
- **Shutdown budget**, set only when R1 env is present on the named-browser branch:
  - `drain_timeout = R1_DRAIN_TIMEOUT_SEC` (60) and `shutdown_process_timeout = R1_SHUTDOWN_PROCESS_TIMEOUT_SEC` (90), each probed with `_worker_options_accepts`;
  - `kill_timeout = 300` in `fly.toml` (validator accepts it, `validate-voice-worker-apps.test.mjs:183-184`);
  - **validator rule:** `R1_DRAIN + 2×R1_SHUTDOWN + 30 ≤ kill_timeout`, matching phone's 90 + 2×90 + 30 = 300 (`agent.py:2044-2055`);
  - tests run with R1 env absent, so `test_phone_drain.py:110-130` passes unmodified.
  - On drain, R1 goes to forced CLOSING (L-SYSTEM-STOP), then FINISHING (≤ shutdown − 15 s), then `fail(shutdown_forced)`, not counted.
- **Orphan rescue:**
  - A job crash leaves the spool on the rootfs, which is reset only when the machine starts. At the next R1 job start and on SIGTERM, the worker uploads any orphaned spool under its session's keys.
  - `r1.sweep` completes orphaned multipart uploads (ListParts + Complete) and aborts empty ones.
  - Crash artifacts can be split (video fMP4 plus audio OGG). The player has a "recovered recording" split mode (§7.7).

### 7.5 Integrity and finalize (`r1.recording.finalize`)

- HEAD the object, then reject anything over `R1_RECORDING_MAX_BYTES` (400 MiB).
- **Streaming SHA-256** over a GetObject stream. Today's finalizers buffer whole objects (`recording-egress.ts:896, 1197`) on a shared-CPU 2 GB API that also runs ClamAV (`app/api/fly.toml:61-62, 157-160`). A memory test enforces streaming.
- Sniff `ftyp` at offset 4; compare with the worker's advisory sha.
- Set status `ready`, `partial` or `failed`, then delete the partials.
- **Verify once:** playback does HEAD plus an ETag check only. The legacy route re-hashes on every play (`recordings.ts:79-100`).

### 7.6 Database: a separate table; `call_sessions` recording columns untouched

- **`interview_round_recordings`** (PR-8):
  - `session_id` (primary key, ON DELETE CASCADE), `bucket`, `object_key`, `partial_keys`, `upload_id`, `status`;
  - `sha256`, `bytes`, `duration_ms`, `content_type` CHECK `('video/mp4')`;
  - `width`, `height`, `fps`, `frames_encoded`, `frames_dropped`, `camera_off_ms`;
  - `started_at_ms` (click-to-seek anchor), `finalized_at`, `revoked_at`, `deleted_at`, `legal_hold`.
- **What stays unchanged:** `chk_call_sessions_recording_content_type` (`0014:71-86`), `phone_call_attempts`, the shared finalize/download/retention code, `recordings_v2` and `RECORDING_MAX_BYTES`.
- **Legacy finalize:** the shared 0038 `recording.finalize` still fires for R1 terminal sessions, finds no egress, and completes harmlessly (`recording-egress.ts:1089-1150`). The legacy upload route now returns 409 for R1. R1 sessions are filtered out of the legacy recording panels.

### 7.7 Player

- **`R1VideoPlayer`:** a `<video>` element. It gets a presigned GET from `GET /api/interview-rounds/:id/recording`, with TTL `R1_RECORDING_DOWNLOAD_TTL_SEC` (bounded 60-900, default 300), and re-requests the URL on a 403.
- **Click-to-seek:** `turn_started_at_ms − started_at_ms`.
- **Split mode:** a muted `<video>` plus `<audio>`, synced on play and seek, labelled "recovered recording; audio and video may drift".
- **CSP:** the R2 S3 origin is added to `media-src`/`connect-src` via `vite-csp-plugin`. Today `media-src` allows Supabase only (`docs/csp-lifecycle.md:44,57`).
- **Untouched:** `RecordingPlayer` and `RecordingCard`.

### 7.8 Consent and notice (R1-specific; Legal signs off)

- **Storage:** R1 consent never touches `consent_templates` or `consent_records`. Exchange reads the newest active template with no locale filter (`invites.ts:238-258`), and the phone RPCs read the candidate's latest `consent_records` row (`0114:4031-4035, 4044-4094`). R1 uses `interview_round_consent_templates` (immutable, versioned) and `interview_round_consents`. Legal-approved text ships as a new versioned row by migration.
- **Itemised notice (draft for Legal):**
  - data: camera video, voice, transcript, scores, device and IP;
  - purposes, each consented separately: (1) AI-conducted interview including a sales role-play; (2) video and audio recording for review by the hiring team; (3) AI evaluation that may automatically update the application status, which the hiring team can review and change, and which the candidate can contest;
  - processors and locations: Sarvam AI (speech); **DeepSeek, which processes and stores data in the People's Republic of China** (language model); LiveKit Cloud (media relay); Cloudflare R2 (video storage, jurisdiction per Legal); Fly.io in Singapore (processing); Supabase ap-south-1 (records);
  - retention per data type (D4), stated truthfully (video [90] days; transcripts and scores per policy; processor-held copies per their policies);
  - withdrawal link, grievance officer contact, the Data Protection Board route, and the alternative path.

  DPDP Rules 2025 itemised-notice obligations are taken from secondary sources only; Legal confirms.
- **Withdrawal:** `POST /api/r1/consent/withdraw` stops a live session (the API deletes the room, and the worker goes to FINISHING with no upload), deletes the video, and blocks scoring and status writes. `prepare` and exchange re-check the consent version and that it has not been withdrawn.
- **Decline:** a card flag; HR arranges a human interview.
- **Staff dry runs:** Stage A and A2 participants consent through the same flow, using a Legal-approved staff version.

### 7.9 Retention, deletion, DSAR and access

- **Retention:** `r1.sweep` deletes video at N days (D4), tombstones the row with evidence, and respects `legal_hold`. Backstop: an R2 lifecycle rule on prefix `r1/` (N+7 days; abort incomplete multipart after 1 day). Legal holds use a bucket lock or a `legal-hold/` prefix outside the lifecycle rule.
- **DSAR (PR-8):**
  - `dsar.ts` gains R1 steps: delete R2 objects (final, partials, held copies, plus AbortMultipartUpload) **before** rows.
  - Each R1 step is error-checked, and a failure **prevents `fulfilled`**. The existing step semantics are not changed in v1: today it ignores errors and always marks fulfilled (`dsar.ts:579-631`), which is noted as a follow-up.
  - DSAR export includes the R1 tables plus a presigned video export (`dsar.ts:312-360`).
  - Processor-held copies (DeepSeek, Sarvam, LiveKit) are recorded in the erasure evidence.
  - Acceptance test: zero R1 rows, R2 HEAD 404 for every key, and only then `fulfilled`.
- **Access** (roles are admin, interviewer and viewer, `rbac.ts:18`):
  - Send, cancel, reissue and grant-retake: admin or the owning interviewer (claim CAS as in `livekit.ts:162-200`).
  - Panel and video: admin and the owning interviewer; `viewer` only if the owner approves (D14).
  - R1 settings: admin only.
  - Uniform 403 plus `auditAccessDenied`; IDOR tests; every presign audited.
- **Bucket:** private; token scoped to the bucket and held only by the API; CORS GET/HEAD with `Range` from `https://ib-ik-project-hello.vercel.app` only. Keys contain UUIDs only.

### 7.10 Candidate camera UX and token

- **Landing:** camera and mic required; the format is described; a lead card is shown during role-play.
- **Device check:** `getUserMedia` first, mirrored self-view, camera picker, copy for `NotAllowedError` and `NotFoundError`.
- **Preflight `r1-av-v1`:** see §4 step 5.
- **Live view:** small self-view, bot aura, captions, phase label, and a "camera is off" banner.
- **Publish:** `{640x360, 15 fps}`, `simulcast:false`, `maxBitrate:500_000`. No MediaRecorder fallback and no `/complete` keepalive on the R1 page.
- **Token:**
  - `canPublishSources=[MICROPHONE,CAMERA]` (SCREEN_SHARE reserved for future coding rounds);
  - `canPublishData:false`, `canUpdateOwnMetadata:false`;
  - **TTL 10 min.** LiveKit token expiry affects only the initial connection, and the server refreshes tokens for connected clients (docs.livekit.io/frontends/authentication/tokens, seen 2026-10-05).
  - Rejoin gets a fresh token from `/api/r1/attempts` with link + nonce.
  - The page trusts `phase` only from the agent identity.

---

## 8. Data model and API

### 8.1 Migrations

- **Numbering:** the next free number at implementation time (0115+; `0114_phone_outcome_integrity.sql` is the latest on `eec54af`).
- **Conventions:**
  - every R1 migration sets `set local lock_timeout = '10s'` (`0112:38`);
  - DDL on shared tables goes in its own small migration;
  - `supabase db push --dry-run` against production before merge;
  - rehearsed in supabase-ci;
  - SQL tests (`scripts/test-r1-*.sh` + `app/supabase/tests/*_assert.sql`) with a supabase-ci path filter;
  - revoke/grant plus `security_invoker` views as in `0090:279-280, 457-458`;
  - every FK `ON DELETE CASCADE`;
  - new columns classified in `docs/data-classification.md`; `link_token_digest` is Secret-class and never returned.

| Migration | PR | Contents |
|---|---|---|
| M1 | PR-1 | <ul><li>`interview_rounds`: kind CHECK `('sales_r1')`; status; `link_token_digest` unique; `expires_at`; attempts allowed/counted; `starts_used`; `candidate_status_at_send`; `recommendation`; `overall`; `assessment_id`; `status_written_at`; `pending_reject_until`; `created_by`; `version`. One non-terminal round per (candidate, kind).</li><li>`interview_round_attempts`: `session_id` primary key; `round_id`; `attempt_number`; persona id, version and variant; `content_sha`; `counted`; `outcome`; `nonce_digest`.</li><li>`interview_round_consent_templates` and `interview_round_consents` (with `withdrawn_at`).</li><li>`r1_settings` singleton (`enabled=false`, caps, pause line, `auto_status_enabled=false`, thresholds, `paused`, dashboard reading) plus an audit trigger.</li><li>`r1_budget_month`.</li><li>`roles.interview_kind` plus a trigger on `ashby_job_mappings` rejecting any role whose `interview_kind IS NOT NULL`.</li><li>RPC `r1_admit_attempt`.</li></ul> |
| M1b | PR-1 | `call_sessions.interview_round_id` (nullable FK plus live-unique index, pattern `0107:24-28`); `transcript_turns.phase` (CHECK `opening\|icebreaker\|transition\|roleplay\|aside\|roleplay_exit\|wrapup\|closing`) and `transcript_turns.interrupted`, both nullable and written only by R1; trigger `enqueue_r1_assessment` with the WHEN clause |
| M2 | PR-2 | `r1_usage_ledger`; `r1_admin_log`; views `v_r1_budget_month`, `v_webrtc_minutes_estimate` (read-only over phone and legacy tables) |
| M3 | PR-5 | "Latest assessment" and funnel views (`0090:345-349`) exclude R1; `v_funnel_failures` includes `r1.*` DLQ rows (snapshot test: phone rows unchanged) |
| M4 | PR-8 | `interview_round_recordings` |
| M-CT | PR-CT | Legal-approved consent template row(s) |

**Not changed:**
- `candidates.status` CHECK (`0004:135`);
- terminal reasons;
- the `voice_worker_leases` pipeline (R1 uses `browser`);
- `assessments.source` (`browser`);
- the provenance workload enum.

### 8.2 R1 context: the shared `worker-context` route is not touched

- The shared route (`worker-context.ts:126-131`) is on phone's fail-closed pre-call path (`agent.py:3670-3683`), and the Python parser drops unknown keys (`persistence.py:780-798`). So **R1 does not extend them**.
- The R1 worker calls `POST /api/internal/r1/context`. It checks:
  - the room matches `screening-<uuid>`;
  - `interview_round_id` is set;
  - status is `waiting` or `in_progress`;
  - `external_call_id` equals the room;
  - the lease pipeline is `browser`.

  It returns the sanitised first name, round and attempt, persona, content version and settings snapshot. **No full name, no résumé.**
- **Turn writes:** done by an R1 writer in `r1_persistence.py` using persistence's client by import. The shared `save_turn` insert shape stays pinned (`tests/test_lifecycle.py:233-248`).
- **Fence:** a phone-room snapshot asserts the exact PostgREST call log and payload of the shared route.

### 8.3 Routes

| Method and path | Auth | Purpose | PR |
|---|---|---|---|
| `POST /api/candidates/:id/interview-rounds` | admin / owning interviewer | Send R1; eligibility; hold; `join_url` once | PR-2 |
| `GET /api/candidates/:id/interview-rounds` | admin, owning interviewer, viewer (no video) | Card and panel | PR-2 |
| `POST /api/interview-rounds/:id/{cancel,reissue,grant-retake,cancel-pending-reject}` | admin / owning interviewer | Lifecycle (reissue invalidates the old digest; attempts not reset) | PR-2 / PR-5 |
| `GET/PUT /api/admin/r1/settings` | admin | Caps, pause, thresholds, auto-status, dashboard reading | PR-2 |
| `POST /api/r1/status`; `GET /api/r1/consent-template`; `POST /api/r1/consent`; `POST /api/r1/consent/withdraw` | link token (public allowlist, `auth.ts:585-603`) | Landing and consent | PR-3 |
| `POST /api/r1/preflight` | link token + consent | A/V preflight (≤10 per link, 3/min) | PR-3 |
| `POST /api/r1/attempts` | link token (+ nonce for rejoin) | Admission RPC; attempt token + nonce | PR-3 |
| `POST /api/r1/exchange` | attempt token + nonce | Health probe; room without egress; worker gate; token | PR-3 |
| `POST /api/internal/r1/{context,usage,admin-log}` | worker bearer + R1-session checks | Context, ledger, administration log | PR-2 / PR-4a |
| `POST /api/internal/r1/recording/{prepare,part-url,checkpoint-url,complete,failed}` | worker bearer + R1-session checks; rate-limited per session | Multipart and checkpoint presign; enqueue finalize | PR-8 |
| `GET /api/interview-rounds/:id/recording`; `POST …/recording/revoke` | admin / owning interviewer | Presigned GET; revoke | PR-8 |

- **Internal routes** share `WORKER_CONTEXT_SECRET` with phone (`phone-worker.ts:807-828`). They therefore also verify that the session is an R1 session in an allowed state, on the browser pipeline, and derive all keys server-side.
- **Rate limits:** R1 candidate routes get their own limiter (`app.ts:372`).
- **OpenAPI:** every route is in `openapi.yaml`, with additive `contract-openapi.test.ts` fixtures (`:13-15`).

### 8.4 Config (lazy; never throws at API boot)

- **The API env helpers throw at import** (`env.ts:55-80`), which would crash-loop the API that also runs phone dialing and scoring. So R1 config lives in a lazily loaded `lib/r1/config.ts` that **never throws**: an invalid value disables R1, logs an error and turns a Mission Control tile red. No R1 key goes into the exported `env`. A test boots `app.ts` with malformed `R1_*` values and asserts the phone routes mount.
- **Variables by PR** (each lands with the PR that first reads it; each is registered in `config/environment.schema.json`, `infra/deployment-contracts/manifest.json`, `parity-manifest.json` and `.env.example`; `requiredInProduction:false`):

| PR | App | Variables |
|---|---|---|
| PR-2 | API | `R1_ENABLED` |
| PR-L | API | `LEGACY_BROWSER_SCREENING_ENABLED` |
| PR-4a | worker (`app/voice-livekit/fly.toml` only) | `R1_LANE_MODE`, `R1_LLM_MODEL`, `R1_LLM_BASE_URL`, `R1_SESSION_MAX_RESIDENCY_SEC`, `R1_REJOIN_GRACE_SEC`, `R1_DRAIN_TIMEOUT_SEC`, `R1_SHUTDOWN_PROCESS_TIMEOUT_SEC` |
| PR-8 | API | `R1_RECORDING_S3_{ENDPOINT,REGION=auto,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`, `R1_RECORDING_MAX_BYTES`, `R1_RECORDING_DOWNLOAD_TTL_SEC` |
| PR-9a | worker | `R1_VIDEO_RECORDING` |

- **Never** reuse `RECORDING_EGRESS_S3_*` or `RECORDING_PROVIDER`, which are shared with phone.
- **Validator** (`scripts/validate-voice-worker-apps.mjs`):
  - `DEEPSEEK_API_KEY` joins `FORBIDDEN_SECRET_KEYS` (`:312-320`);
  - `fly.phone.toml` may not contain any `R1_*` key;
  - the drain-budget rule for `fly.toml` (§7.4).

### 8.5 Retiring legacy browser screening (PR-L, before Stage A; D12)

1. Read-only SQL (§12) confirms negligible use and no `browser_primary` mappings.
2. With `LEGACY_BROWSER_SCREENING_ENABLED=false`, `/api/livekit/start`, `/invite`, `/exchange` and `/preflight` return **410 `browser_screening_retired`**. Ashby `materializeInvite` for `browser_primary` logs and skips (`orchestration.ts:508-525`). The web app hides `LiveKitCallCard` (`CandidateDetailPage.tsx:526-545`); the component file is unchanged.
3. Wait 24 h for outstanding invites to expire (`invite-token.ts:21-39`). Then list leftover `created` and `waiting` legacy sessions read-only and cancel them through the admin path (`recruiter_cancelled`).
4. Only then does PR-4a set `R1_LANE_MODE=r1_only`. A non-R1 context then fails closed. Tests run without the env var, so `test_instrumentation.py` is unaffected.
5. Legacy `_run_session` and `prompting.system_prompt` stay unreachable.
6. Stale docs are fixed (`fly.phone.toml:5-10` comment, runbook §8, the `openapi.yaml` `candidate_evidence` note).

### 8.6 Legacy endpoints closed to R1 sessions (PR-2)

- R1 never creates `candidate_invites` or `candidate_access_grants`, so the `candidate-consent` routes and the legacy exchange cannot see R1 by construction (`candidate-consent.ts:194-245`).
- `/complete`, `/:id/recording`, `/grant/recording`, `/api/internal/assess/:id` and `runAssessment` return 409 for R1 (§6.3).
- Negative tests per route prove that a held R1 token cannot write `consent_records`, complete a session, upload audio or trigger the legacy scorer.

---

## 9. Isolation and safety

**Never touch**
- `phone.py`, `closing.py`, `recording.py`, `recording_api.py`, `fly.phone.toml`;
- `prompting.system_prompt`, `opening_line`, `DEFAULT_QUESTIONS`; `_build_provider_session`; the `_run_session` body;
- the phone keys in `build_worker_options`;
- `persistence.py`, `provenance.py`; `worker-context.ts` and its route; `room-provisioning.ts` (phone imports it, `phone-room.ts:40`);
- the phone SQL RPCs; the `phone_call_attempts` CHECK; the phone webhook (`app.ts:270-279`, `integrations/livekit-phone/*`, `phone-webhook.ts`);
- the phone runtime handler set; the active `consent_templates` row and `consent_records`;
- the phone SPA role rows; `RECORDING_*`; `recordings_v2`;
- the phone scorer prompt, `domain.ts` thresholds, `evidence.canAutoReject`; Ashby mappings.

`config/current-state.json` is edited **only** in owner-approved PR-pre.

**Phone-shared path tier.** Touching any of these requires a phone-impact section in the PR, the full phone test suite, and the diff rules below.

| File | Rule |
|---|---|
| `agent.py` | Entrypoint additions only **below** the `_phone_agent_name()` return. `build_worker_options` keys only when R1 env is present. No new top-level imports (R1 modules are imported lazily inside the branch). No R1 work in prewarm. |
| `Dockerfile` | COPY append after the pinned prefix |
| `requirements.txt` / `constraints.txt` | — |
| `quality.yml`, `deploy-fly.yml` | Additive only |
| `assessment.ts`, `livekit.ts`, `invites.ts`, `app.ts` | Additive only; guards keyed on `interview_round_id`; mount R1 routes and runtime |
| `dsar.ts` | Additive R1 steps only |
| env schema, validator | Additive only |

R1 copies phone patterns and never imports `phone.py` helpers (`PHONE_*` env, module-level breaker, `phone.py:8708-8730`).

**Tests that stay green and unmodified**
- `test_phone_*.py`, including:
  - the browser pins `test_phone_gate.py:5855-5869, 5918-5928, 16294-16442`;
  - the prompt-leak test `17587-17605`;
  - `test_phone_drain.py:110-130` and `test_phone_agent_name.py`;
  - `test_phone_noise_wiring.py` (COPY prefix at `:337`) and `test_phone_preloop_close.py`.
- `test_browser_prompt_pin.py:34`, `test_instrumentation.py`, `test_agent.py`, `test_prompting.py`, `test_lifecycle.py`, `test_docker_packaging.py`.
- `deploy-fly-workflow.test.mjs`, `check-env-contract`, `hosting-validate.yml`.
- `phone-screening-structural.test.ts:284-297`, the phone-runtime handler tests, the terminal-reason parity test.
- **Additive edits are expected** (the draft's claim of "no existing test modified" is withdrawn): `contract-openapi.test.ts` fixtures, `validate-voice-worker-apps.test.mjs` cases, the funnel-view SQL tests, `deploy-fly-workflow.test.mjs` (deploy-guard step). Each PR lists its additive test edits.

**New fences**
1. Phone `worker-context` call log and payload snapshot (PR-1).
2. Phone scorer prompt byte-identity (PR-5).
3. Phone runtime handler set is exactly `{phone.dial, phone.assessment}` (PR-5).
4. Phone SPA role-row snapshot (read-only SQL before and after each migration or deploy, recorded in the PR).
5. R1 content, prompt and world-facts sha pin (PR-4b).
6. The phone entrypoint never imports `r1_*` (PR-4a).
7. R1 code never writes `consent_records` or `consent_templates` (PR-3).
8. Default DeepSeek breaker stays closed under R1 failures (PR-5).
9. API boots with malformed `R1_*` (PR-2).
10. `r1_*.py` use only `StructuredLogger` (no stdlib logging or print) and never log presigned URLs, utterances or first names (PR-4a).
11. CI "R1 touches phone-only files" check, keyed on the `r1/` branch prefix or PR label so it never blocks phone hotfixes.
12. Validator rules (§8.4).

**Kill switches**

| Switch | Where | Effect |
|---|---|---|
| `R1_ENABLED` | API env (lazy) | Master off |
| `r1_settings.enabled` / `paused` | DB, instant | Blocks Send R1 and new attempts; live sessions finish |
| `r1_settings.auto_status_enabled` | DB, audited | Status writes on or off |
| Override-rate monitor | Automatic | Disables auto-status at >10% over a rolling 20 |
| `R1_VIDEO_RECORDING` | Worker env | Audio-only |
| Auto-pause (pause line / run-rate) | Automatic | Protects phone minutes |

**Pre-merge gate for ANY merge touching `app/voice-livekit/`, `app/api/` or migrations — R1 PRs and phone hotfixes alike**
- Merge in **07:00-08:30 IST**; latest merge 08:00; no Quality re-run or deploy dispatch after 08:15.
- `r1_settings.paused=true` at least 30 minutes ahead.
- Read-only checks, all zero, otherwise abort:
  - live R1 sessions;
  - `phone_call_attempts` in admitted, ringing, answered_unclassified, human or machine state with `lease_expires_at > now()`;
  - `phone.dial` jobs or booked callbacks due in the next 30 minutes;
  - for API deploys, an active `phone.assessment` job.

  The dialing window restricts only call **start** (`0111:28-52`), and a deploy cuts a live phone call after the 90 s drain.
- Automation: a pre-step in the deploy job runs these SQL checks and fails closed (additive case in `deploy-fly-workflow.test.mjs`). The phone runbooks gain the R1 pause step.
- Web-only (Vercel) merges: any time with zero live R1.
- Sessions killed by a deploy are recorded as `shutdown_forced` and do not consume the retake.

**Post-deploy verification (named)**
- The deploy job's watermarked worker registration (automatic).
- A phone Canary-1 dry run showing `worker_present_before_originate|PASS` (`phone-worker-orchestration-activation.md:378-379`), run by the owner at about 08:30 IST; its minutes go in the test ledger.
- The phone role-row snapshot is unchanged.
- R1: a worker-context-only dry call on the R1 context endpoint (no 20-minute room).

**Rollback**
1. **Pause R1 first** (DB).
2. Squash-revert inside the window; this redeploys both workers. If phone is affected, roll back the phone Fly release per the runbook (§5).
3. Migrations are additive and are disabled, not dropped. R2 objects are kept.
4. A reverted worker must not route R1 rooms to legacy `_run_session`: the lane mode stays `r1_only` (the 409 guards also block legacy scoring).

---

## 10. Delivery plan

**Merge gate for every PR**
1. 3 independent adversarial reviews.
2. Every finding fixed or dispositioned in the PR.
3. Green CI: `quality.yml` (including the `py_compile` list `:149`, bare-`python3` unittest with `livekit.*` stubs, and the new PyAV job), `hosting-validate`, `supabase-ci`, `secret-scan`, `model-governance` where applicable.
4. Squash-merge under §9's gate.
5. Post-deploy verification (§9).

A dependency means **"deployed and post-deploy verified"**, not merely merged. Vercel deploys on merge, while Fly follows 10-15 minutes later.

### 10.1 Spikes (Phase 0; harnesses on branches; only result docs merged)

| ID | Scope | Exit criteria | Effort / infra | If it fails |
|---|---|---|---|---|
| S0-A | Owner readouts (§12): LiveKit meters and the "613/1,000" line; recording flags; `GEMINI_MODEL`/`DEEPSEEK_API_KEY` secrets; Sarvam tier; `pip freeze` + `av` version of both voice apps; read-only SQL | Baseline in `phone-cost-and-scale-plan.md`; cap formula inputs | 0.5 owner-day | — |
| S0-B | DeepSeek persona and latency. Text harness `r1_deepseek_smoke.py`, owner-run, from a **Fly `sin` machine**, never in CI. Covers: thinking off; `system` accepted mid-call and `developer` → 400; TTFT over ≥30 turns; cache ≥80%; ≥10 replays per persona; an adversarial battery (≥20 runs per persona: early closer, rambler, one-word answers, silence, rude, jailbreak, "you already agreed", meta, Hindi code-switching, price-first, "$1,500 immediately"); a probe-trigger matrix (≥10 paraphrased probes and ≥10 near-misses per need); fixed fact Q&A consistency; context-bleed checks; single agent vs `AgentTask`; V4-Pro scoring latency on a 20-minute transcript; the gold set and equivalence study | TTFT p50 ≤1.0 s, p95 ≤2.0 s. All 4 families delivered in ≥95% of replays within slip. Volunteering ≤5%. Correct unlock ≥90%. Premature commitment or concession 0%. Leaks 0 in every phase. 0 fact contradictions. Scoring <120 s per run. | ~5 engineering-days; ~$5 DeepSeek; 0 LiveKit | Escalation (decision 12 forbids a bake-off): (1) verbatim scripted primaries via `session.say`; (2) `AgentTask`; (3) if still failing, the owner decides whether to revisit the model |
| S0-C | A/V CPU. Throwaway Fly app with agent name **`r1-spike`** and separate secrets, against a **self-hosted `livekit-server` on Fly `sin`**. Offline micro-benchmark plus ≤8 end-to-end runs (headless Chrome, fake 360p media). Matrix: {perf-1x, perf-2x} × {no video, decode only, x264 ultrafast, x264 veryfast, 720p received}. Faults: camera off/on, reconnect, SIGTERM, `kill -9`, two jobs on one machine. 1-2 confirmation runs on Cloud. | Loop lag p99 <50 ms and max <250 ms; 0 VAD-lag warnings; turn p95 regression <100 ms; CPU p95 <60%; drops <2%; A/V skew <150 ms; finish <60 s | ~5 engineering-days; ~90 Cloud min | (1) 240p/10 fps; (2) VP8; (3) lower frame rate. Shipping v1 audio-only would reverse decision 8 and is the owner's call. |
| S0-D | R2 (throwaway bucket and token, revoked afterwards): presigned **UploadPart**; complete with a prefix after a simulated crash; presigned GET with `Range` via CORS from the web origin; lifecycle and abort rules; **fMP4 and faststart seeking in Chrome and Safari** | All pass | ~2 engineering-days; needs the owner's R2 account early | Checkpoint PUT fallback; keep the remux |
| S0-E | Local `livekit-server --dev`: Python `set_attributes` key received unchanged by JS (#332 trap; use `phase`); `set_video_quality`; `text_input=False` closes `lk.chat`; `record=False` (and confirmed absent from Agent Observability on Cloud with one short session); track-muted events | Each item pass/fail | ~1.5 engineering-days; ~20 Cloud min | Per item |

The S0-E webhook question is already answered (phone uses webhooks) and needs no spike.

### 10.2 PRs (in order; "Deploys" derived from `deploy-fly.yml:156-174`)

| PR | Scope | Acceptance and tests | Size | Depends on | Deploys |
|---|---|---|---|---|---|
| **PR-pre** (owner-approved) | <ul><li>Renew or resolve the API audit exceptions **before 2026-10-08** and the web exceptions before 2026-10-17.</li><li>Refresh `current-state.json` `evidenceDate` and update the `hosting-validate` baseline SHA before 2026-10-28.</li><li>Add a "CI expiry calendar" to the runbook.</li></ul> | Quality and hosting-validate green | S | Owner approval | Per path rules (verify; expected none) |
| **PR-dep** | `constraints.txt` from the running phone image's `pip freeze`; `pip install -r requirements.txt -c constraints.txt`; CI step diffing the built `pip freeze` (explicit phone sign-off for any difference) | Built freeze equals the running image | S | S0-A | both workers + db |
| **PR-0** | Docs only: ADR-0015 (R1 lane; DeepSeek; D-004 drift; supersedes AI-GATE for R1), ADR-0016 (R1 camera video; R2); deploy, budget and R1 incident runbooks; credential inventory and rotation entries; data classification. *Owner accepted ADR-0015/0016/0017 on 2026-10-06; S0 evidence is appended to the ADRs as it lands, and implementation steps remain gated on S0 results.* | `check-adrs.mjs` passes. The D-004 wording check (`check-phase0-2-build-status.mjs:210-221`) changes only with an owner decision, in the same PR. Evidence sections are updated after S0. | S | S0-A | none |
| **PR-1** | M1 + M1b; SQL tests plus supabase-ci wiring; phone `worker-context` fence | Migrations apply and rollback verifies; WHEN-trigger tests (a phone update creates no job); admission RPC concurrency test; Ashby guard trigger test; RLS and grants | M | PR-0 | **database + api** (the fence is an API test) |
| **PR-2** | <ul><li>`lib/r1/config.ts` (lazy, never throws).</li><li>Send R1, list, cancel, reissue and grant-retake; admin settings.</li><li>M2 ledger and estimate views; the usage and context internal routes.</li><li>Legacy endpoint and scorer guards (§8.6); Ashby mapping server 400.</li><li>`seed-r1-role.ts` (run by the owner after deploy).</li></ul> | Hold and release; cap and pause; link shown once; eligibility (phone engagement, jurisdiction); RBAC and IDOR; boot with malformed `R1_*`; 409 guards; contract tests | L | PR-1 | api + db |
| **PR-L** | Legacy retirement (§8.5 steps 2-3); web hides the card | 410 paths tested; drain runbook executed | M | PR-2; D12 | api + db + Vercel |
| **PR-3** | `/api/r1/*`: status, consent (+ withdraw), preflight, attempts (+ nonce), exchange (health probe, R1 room without egress, worker gate, tokens); R1 rate limiter | R1 room creation never calls egress (spy); token grants pinned; preflight caps; combined concurrency; consent fence; withdrawal | L | PR-2 | api + db |
| **PR-4a** | <ul><li>Worker core: lane-mode branch with lazy import; `r1_session` lifecycle, context client, phase machine, scripted lines, silence/mute/rejoin, exit invariant; counts the attempt at TRANSITION while the session is live (§5.12 counting contract).</li><li>Drain and shutdown options plus `kill_timeout=300`; R1 turn writer and ledger; `r1_llm.py` and provenance.</li><li>Governance inventory entries (`provider_boundaries.py`, TS mirror, md).</li><li>Env, schema, validator, Dockerfile COPY, `quality.yml:149` list.</li><li>**Integration test:** the full phase machine with fake STT, LLM and TTS through an injected session factory (pattern `phone_canary.py:241-342`).</li></ul> **Owner stages `DEEPSEEK_API_KEY` first.** | Phase timing arithmetic pinned; guards (host, thinking); phone entrypoint never imports `r1_*`; all phone and browser pins unchanged | L | PR-3, PR-L drained, S0-B, S0-E | both workers + db |
| **PR-4b** | Persona content plus world sheet (sha pin); scheduler; tracker; commitment ask-detector and scripted lines; `llm_node` context filter and output guard; admin-log posting; fidelity record | Unit tests: owed-move deadlines and slip; one move per turn; pushes and counter; disclosure gating; guard coverage in every phase; injection cannot change phase; commitment determinism | L | PR-4a, D2 | both workers |
| **PR-4c** | Early-flush `tts_node`; R1 `turn_handling`; `r1` latency log lines; Sarvam token bucket and line cache; 429 counter by lane | Unit tests; Stage A latency targets | M | PR-4a | both workers |
| **PR-5** | M3; R1 queue runtime; own DeepSeek runner; 3-run scorer; admin-log intake; gate; recommendation; status CAS (flag off) plus 24 h pending reject; `audit_events`; override monitor; DLQ | Phone scorer byte-identity; breaker isolation; phone handler set; gate matrix; CAS respects human change; idempotent re-run; fail-closed → `human_review` | L | PR-1, PR-4a | api + db |
| **PR-6** | `R1JoinPage` (new readiness component; never edits the three files scanned by `candidate-webrtc-structure.test.ts:5-7`); R1 notice page; lead card and phase label; e2e harness extension (candidate fixtures, `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, permissions, mocked `livekit-client`); **an e2e job on Linux in CI with zero tolerated failures** | Vitest + e2e green | L | PR-3 | Vercel |
| **PR-7** | Send R1 card (disabled state from settings); R1 panel; admin settings page; Mission Control tiles; Ashby picker filter | Component tests; design-system check (`quality.yml:39-40`); a11y | L | PR-2, PR-5 | Vercel |
| **PR-CT** | Legal-approved staff and candidate consent template rows | Migration test | S | Legal | database |
| **PR-8** | M4; S3 adapter; R2 env; recording internal routes (part caps, one `upload_id`, TTLs, abort); finalize (streaming); playback presign and revoke; `r1.sweep` (expiry, retention, crash recovery: terminal write and uncount in one transaction, §5.12); **DSAR coverage** | S3 mock tests; memory test; TTL bounds; audit; DSAR acceptance; env contract | L | PR-1, PR-5, S0-D | api + db |
| **PR-9a** | Encoder and recorder modules; **PyAV CI job** (isolated venv like RNNoise `quality.yml:158-166`: real encode → fMP4 → AAC → faststart → reopen; encoders present; `av.__version__` equals the constraint; fails on skips); `R1_VIDEO_RECORDING=off` | Unit tests (drop-oldest, pipe full, degrade) | L | PR-dep, PR-8 | both workers |
| **PR-9b** | Multipart streaming; audio checkpoints; finish ordering; orphan rescue; perf-2x `[[vm]]` | S0-C gates re-run on the final build (2 end-to-end runs) | M | PR-9a, S0-C | both workers |
| **PR-10** | `R1VideoPlayer` (with split mode); click-to-seek; CSP | Chrome and Safari playback | M | PR-8 | Vercel |
| **PR-V** | `R1_VIDEO_RECORDING=on` | After S0-D and the R2 smoke test pass | S | PR-9b, PR-10 | both workers |
| Owner step | `provision-voice-worker-pool.mjs --size 1` after PR-9b; confirm the machine reports performance-2x (`:9-11`: the runtime never creates pool machines) | — | — | PR-9b | — |
| **PR-C2** (post-launch) | Per-machine browser agent names plus one-job `load_fnc`, gated on `BROWSER_AGENT_NAME` + R1 env; then pool 2 and concurrency 2 | `test_phone_drain`/`agent_name` unchanged | M | Stage C | both workers + api |

### 10.3 Schedule (est.; one merge slot per working day; buffer for repair PRs)

| Window | Work |
|---|---|
| **Oct 5-9** | PR-pre (audit exceptions by **Oct 7**); S0-A; owner answers D1-D14; R2 account; Legal and sales-lead kick-off (world sheet, personas) |
| Oct 12-23 | S0-B, S0-C, S0-D, S0-E; PR-dep; PR-0; PR-1; PR-2 |
| Oct 26-Nov 13 | PR-L (+24 h drain); PR-3; PR-4a/b/c; PR-5; PR-6; PR-7; Legal approves staff consent and D11 for staff; PR-CT (staff) |
| Nov 16-20 | **Stage A0/A** (Cloud test minutes in November) |
| Nov 16-Dec 4 | PR-8; PR-9a/b; PR-10; PR-V |
| Dec 7-11 | **Stage A2** (recording on); Legal approves candidate notice and consent; PR-CT (candidate) |
| **Dec 14 (realistic)** / Nov 30 (earliest) | **Stage B**, first real candidates, shadow mode; December cap 20 |
| ~late Jan 2027 | Stage C, if calibration passes with ≥30 double-rated sessions |

### 10.4 Stage exits (numeric)

- **Stage A0** (owner smoke, ≥2 sessions after PR-3/4a/6): round created through the PR-2 route; all phases run; turns carry `phase`; ledger rows written; room deleted; no phone regression.
- **Stage A** (≥12 sessions: all 4 personas × 3 scripted skill levels by HR and the sales lead):
  - every phase within budget ±60 s;
  - all 4 families delivered in 100% of runs;
  - 0 unprobed reveals, 0 unearned commitments, 0 guard misses;
  - end-of-speech → first audio p50 ≤1.8 s, p95 ≤3.0 s;
  - 0 worker crashes;
  - scorecard complete and 3-run stable ≥90%;
  - realism rated ≥4/5;
  - no phone canary regression;
  - measured minutes per R1 ≤55.
- **Stage A2** (≥6 sessions with recording):
  - 100% `ready`; A/V skew <150 ms; finish p95 ≤60 s;
  - 0 VAD-lag warnings; CPU p95 <60%; drops <2%;
  - Chrome and Safari playback and seek;
  - DSAR delete test passes on a staff record.
- **Stage B** (shadow; ≥30 real candidates; daily review):
  - average minutes per R1 ≤55;
  - budget estimate within 10% of the dashboard;
  - double ratings collected;
  - gold-set and equivalence gates already passed.
- **Stage C:** calibration criteria (§6.6) met; the owner flips `auto_status_enabled`.

### 10.5 Launch checklist (before Stage B)

- [ ] S0 gates passed; equivalence study passed; gold set passed.
- [ ] Legal approved: notice and consent, D11, the AI-GATE supersession in ADR-0015, retention (D4), R2 jurisdiction.
- [ ] Legacy retired; `R1_LANE_MODE=r1_only`; leftovers cancelled.
- [ ] `DEEPSEEK_API_KEY` staged on `project-hello-voice`; DeepSeek balance alert covers ≥7 days of combined spend.
- [ ] R1 role seeded with the R1 scorecard; the Ashby guard tested.
- [ ] Cap set from the formula; pause line 80%; auto-status **off**.
- [ ] Dashboard baseline recorded; Mission Control tiles live.
- [ ] Sarvam tier confirmed (D13).
- [ ] Deploy-guard step live; runbook rehearsed (pause, zero-live checks, 07:00-08:00 merge).
- [ ] Phone role snapshot unchanged.
- [ ] CI expiry calendar clear for the next 30 days.

---

## 11. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Shared 5,000-minute WebRTC cap exhausted | Phone agents cannot join; phone stops until the 1st | Legacy cutover first; atomic admission; measured cap; 80→85% pause plus run-rate pause; daily reconciliation; S0-C off Cloud |
| 2 | Demand (10/day) far above capacity (~40/month) | HR frustration | Owner Option A/B/C in writing; budget visible on the card; links extend while paused |
| 3 | Phone reserve not a hard ceiling | Less R1 headroom | Estimate includes phone attempts ×1.2; pause line is the real protection |
| 4 | Every worker or API merge restarts phone and live R1 | Dropped calls or interviews | Zero-live gate for all merges, automated in the deploy job; 07:00-08:00 slot; drain arithmetic |
| 5 | R1 code or config crashes the shared worker or API at boot | Phone outage | Lazy imports; non-throwing R1 config; boot tests; no prewarm work |
| 6 | Dependency drift on rebuild | Phone runtime changes | PR-dep constraints + freeze diff |
| 7 | R1 scoring opens the shared DeepSeek breaker or starves the phone queue | Phone scoring and dials fail | Own runner and breaker; own queue runtime; structural tests |
| 8 | Video encoding starves VAD/STT | Live call degraded | perf-2x; niced subprocess; degrade on first warning; S0-C |
| 9 | Wrong-machine stop with a shared browser name | Live R1 killed | Concurrency 1, pool 1; PR-C2 before raising |
| 10 | Persona drift or inequity | Scores not comparable | Deterministic schedule and close; progressive disclosure; equivalence study; per-persona monitoring and suspension |
| 11 | Uncalibrated or unstable auto-reject | Wrong rejections | Fidelity gate; 3 runs; ≥30 double-rated calibration; 24 h pending reject; override auto-disable; appeals |
| 12 | Legacy paths score or complete R1 sessions | Status written outside the R1 rules | 409 guards; no invites or grants for R1; negative tests |
| 13 | Typed or spoken injection; leaks into captions and transcript | Test integrity | `text_input=False`; `canPublishData:false`; guard in `llm_node` across all phases; no tools |
| 14 | Legal/privacy: video PII, DeepSeek PRC, AI-GATE, DSAR | Launch blocker or exposure | Legal gates (Stage A, B); itemised notice; withdrawal; DSAR coverage; jurisdiction gate |
| 15 | Recording lost on crash or deploy | No video for HR | 5 MiB streamed parts; 2-minute audio checkpoints; orphan rescue; sweep completion; split player |
| 16 | R2 presigned UploadPart undocumented | Streaming blocked | S0-D; checkpoint PUT fallback |
| 17 | DeepSeek outage, 402/429, alias withdrawal, V4.1 behaviour change | R1 (and phone and API) down | Admission health probe; wall-clock deadlines; failures don't count; `deepseek-flash`; balance alert; S0-B re-verification |
| 18 | Sarvam account limits shared with phone | Phone TTS 429s | S0-A tier check; R1 token bucket and cache; 429 counter; D13 |
| 19 | CI expiries (Oct 8, Oct 17, Oct 28) | No merges, including phone hotfixes | PR-pre; expiry calendar |
| 20 | Live sessions at the cap, and the reset timezone, are undocumented | Surprise failures | Pause before the cap; R1 paused until 12:00 UTC on the 1st |
| 21 | Bearer link forwarded or taken over | Impersonation | Per-attempt nonce; audited rejoins; HR identity check on video |
| 22 | Schedule slips (Legal, sales lead, repair PRs) | Later launch | Dated owner dependencies; split PR-4 and PR-9; buffer |

---

## 12. Owner, HR and Legal action items

**This week (by 2026-10-09)**
1. Approve PR-pre. API audit exceptions expire **2026-10-08**.
2. LiveKit dashboard (Usage/Billing): record month-to-date WebRTC minutes, agent audio recordings, observability events, transcode, track egress, downstream GB and SIP. Confirm which meter "613/1,000" was.
3. Production config, by name or boolean only:
   - `fly ssh console -a project-hello-api -C "printenv RECORDING_EGRESS_ENABLED RECORDING_EGRESS_REQUIRED RECORDING_PROVIDER"`
   - `fly secrets list -a project-hello-voice`
   - `fly ssh console` on both voice apps: `python -c "import av;print(av.__version__)"` and `pip freeze` (for PR-dep).
4. Read-only SQL:
   - `select date_trunc('week',created_at) wk, count(*) from screening_v2.call_sessions where mode='browser' and created_at > now()-interval '60 days' group by 1 order by 1;`
   - `select screening_mode, count(*) from screening_v2.ashby_job_mappings group by 1;`
   - `select pipeline, count(*) from screening_v2.voice_worker_leases group by 1;`
   - `select id,title,agent_name,active_scorecard_version_id,created_at from screening_v2.roles;`
   - `select id,status,created_at from screening_v2.call_sessions where mode='browser' and status in ('created','waiting','in_progress');`
   - `select id,version,locale,is_active,updated_at from screening_v2.consent_templates order by updated_at desc;`
5. Record the Supabase plan and usage; the Sarvam plan tier, limits and credit balance; DeepSeek balance.
6. Answer D1-D14. Choose capacity Option A, B or C in writing.
7. Cloudflare R2:
   - enable R2 with a card and a billing alert;
   - create a **throwaway** bucket and token for S0-D (revoked afterwards);
   - create `ik-r1-recordings`: Standard class, APAC hint, **jurisdiction decided with Legal (immutable)**, public access off;
   - create a bucket-scoped Object Read & Write token. The Admin token is used **interactively only** for the lifecycle rule (prefix `r1/`, N+7 days, abort multipart after 1 day) and CORS (GET/HEAD, `Range`, expose `Content-Length, Content-Range, Accept-Ranges, ETag`, origin `https://ib-ik-project-hello.vercel.app`). Never store it as a Fly secret.
8. Engage Legal and the sales lead (items 12-17).

**Before PR-4a and PR-8**

9. Stage `DEEPSEEK_API_KEY` on `project-hello-voice` only (`fly secrets set --stage`), outside the IST window. Optionally use a dedicated R1 key.
10. Stage the `R1_RECORDING_S3_*` secrets on `project-hello-api` **only**, outside the IST window. Setting a secret restarts the API, so apply the §9 gate.
11. ADR-0015, ADR-0016, and ADR-0017 were accepted by the owner on 2026-10-06. *Owner accepted ADR-0015/0016/0017 on 2026-10-06; S0 evidence is appended to the ADRs as it lands, and implementation steps remain gated on S0 results.* The D-004 wording change remains separately owner-controlled.

**HR and the sales lead**

12. Write the world-facts sheet (D2), including the "does NOT offer" list, and add it to the candidate prep guide.
13. Review the persona cards, variants, objection lines, pushes, counter, the $7,000 anchor, commitment lines and fact Q&A.
14. Review the rubric anchors and weights (D6); approve the role FAQ allowlist.
15. Provide ≥2 trained raters: Stage A (≥12 sessions, plus ≥6 in A2) and blind double-rating of the first ≥30 real R1s; write the rater guide with engineering.

**Legal**

16. **Before Stage A:** staff dry-run consent (video and transcripts); the DeepSeek PRC position for staff data (D11).
17. **Before Stage B:**
    - the itemised candidate notice and per-purpose consents (§7.8), including withdrawal, the grievance route and the alternative path;
    - D11 for candidates;
    - the ADR-0015 supersession of AI-GATE and the pending-reject policy (D3);
    - retention (D4; overrides "indefinite" D-009 `0012:80` for video);
    - the R2 jurisdiction and vendor DPA/region evidence (LiveKit, R2, Sarvam, DeepSeek; PLAN.md GOV-07, ADR-0006);
    - the privacy notice page (`PrivacyNoticePage.tsx` is a placeholder);
    - libx264 GPL licensing;
    - the jurisdiction scope (D14).

---

## Appendix A. Review dispositions

Codes: PI = phone isolation, CA = conversation/assessment, FC = free-plan capacity, SP = security/privacy, DT = delivery/testability.

| ID | Finding | Disposition | Where / reason |
|---|---|---|---|
| PI-1 | R1 scorer shares the API's DeepSeek breaker | Fixed | §6.3: own `createDeepseekRunner` with its own breaker; isolation test |
| PI-2 | No queue runtime named; phone runner is concurrency 1 | Fixed | §6.7: dedicated R1 runtime; structural test |
| PI-3 | R1 env could crash the API at boot | Fixed | §8.4: lazy, never-throwing config; boot test |
| PI-4 | Top-level R1 imports could crash-loop phone; COPY prefix pin | Fixed | §9 tier rules; lazy import; COPY append after the pinned prefix (§7.2) |
| PI-5 | No transitive dependency lock | Fixed | PR-dep constraints and freeze diff |
| PI-6 | Wrong "Deploys" (PR-0, PR-1) | Fixed | §10.2 derived from path rules; governance entries moved to PR-4a |
| PI-7 | Deploy gate ignored live phone calls after 21:00 | Fixed | §9 zero-live-phone, dial, callback and assessment checks |
| PI-8 | Shared browser name plus pool 2 → wrong-machine stop | Fixed | §7.3: pool 1, concurrency 1; PR-C2 later |
| PI-9 | Incomplete shutdown budget | Fixed | §7.4: drain and shutdown options, `kill_timeout` 300, validator rule |
| PI-10 | Sarvam account limits shared; pre-synthesis burst | Fixed (variant) | §5.2: cached lines, token bucket, 429 counter, D13. Synthesis at R1 job start, not prewarm (isolation). |
| PI-11 | Budget guard ignores legacy, preflight and canary minutes | Fixed | §3.3 estimate view; legacy retired before Stage A; run-rate pause |
| PI-12 | Legacy scorer can score R1 | Fixed | §6.3/§8.6 409 guards; rollback keeps `r1_only` |
| PI-13 | Changing the shared worker-context query | Fixed (differently) | §8.2: shared route untouched; R1 context endpoint |
| PI-14 | Python parser drops unknown keys | Fixed | §8.2: own endpoint; `persistence.py` untouched |
| PI-15 | `save_turn` phase would break the insert pin | Fixed | R1-only writer (§8.2) |
| PI-16 | Webhooks already used by phone | Fixed | S0-E item removed; webhook on never-touch list; no webhook ledger |
| PI-17 | Combined concurrency not enforced | Fixed | Admission RPC: R1 + phone live <4 |
| PI-18 | Ashby mapping of the R1 role only blocked in the UI | Fixed | DB trigger (PR-1) + server 400 (PR-2) + picker filter |
| PI-19 | Migrations without lock_timeout | Fixed | §8.1 conventions; split DDL; dry-run |
| PI-20 | Later phone score overwrites an R1 reject | Fixed | Send R1 eligibility (§4 step 1) |
| PI-21 | CI fence misses phone-shared files | Fixed | §9 phone-shared tier |
| CA-1 | Calibration gate statistically weak; reject is the only effect | Fixed | §6.6 (≥30 sessions, 2 raters, QWK, precision, refit); 3-run scoring; override monitor; stated in §6.5 and §2.1 |
| CA-2 | No shared world-facts sheet | Fixed | §5.4 (D2); numbers not on the sheet removed |
| CA-3 | Persona secrets in a static prefix | Fixed | §5.3 progressive disclosure; exact owed lines in the reminder |
| CA-4 | Context bleed between modes | Fixed | §5.3 `llm_node` context filter; no-feedback rule; S0-B checks |
| CA-5 | Commitment not enforced at the ask turn | Fixed | §5.8 deterministic ask detector, scripted lines, guard |
| CA-6 | Weak and contradictory negotiation pressure | Fixed | §5.5/§5.7: unconditional pushes, deterministic F1 counter |
| CA-7 | Persona inequity; weak drift monitor | Fixed | Normalised cards; equivalence study; pooled n ≥ 20; per-persona suspension |
| CA-8 | Fixed-clock scheduler unfair | Fixed | §5.6: paused R clock, one move per turn, spacing, protected discovery, time cue, slip exclusion |
| CA-9 | Rubric anchors not observable | Fixed | §6.1 countable anchors; admin log; communication facts; `turnIndex` evidence |
| CA-10 | Gate weaker than decision 5; no fidelity checks | Fixed | §6.4 |
| CA-11 | Retake and persona shopping; which attempt decides | Fixed via owner decision | D1: count at TRANSITION; fixed persona; status at round-final. The automatic retake is limited to invalid attempts with a manual HR grant otherwise, offered as the default for the owner to confirm rather than silently overriding decision 9. |
| CA-12 | S0-B too weak | Fixed | §10.1 S0-B battery, matrix, gates; Stage A ≥12 |
| CA-13 | Transition lacks goal; no ready check | Fixed | L-TRANSITION; READY; lead card; recap aside |
| CA-14 | Mute and monologue | Fixed | §5.11 |
| CA-15 | Interrupted learner turns lost | Fixed | R1 writer stores them with `interrupted` |
| CA-16 | Wrap-up FAQ improvisation | Fixed | Role FAQ allowlist; L-FAQ-DEFER |
| CA-17 | Fully passive learner | Fixed | Q-A and Q-B neutral questions |
| CA-18 | Test security erosion | Fixed | 3 surface variants per persona; versioning |
| CA-19 | Hard exit 14:30 exceeds 12-14 | Fixed | R hard exit 14:00 |
| FC-1 | Concurrency 2 on a shared name (blocker) | Fixed | Concurrency 1; PR-C2; S0-C two-job fault case |
| FC-2 | Phase maxima exceed the residency cap | Fixed | §5.1 arithmetic plus unit test; residency 1,800 s; expiries go through CLOSING |
| FC-3 | Non-happy exits skip the finish; no crash recovery | Fixed | §5.12 invariant; shutdown budget; `r1.sweep` recovery; orphan rescue |
| FC-4 | Durable artifact is silent video; loss window larger than stated | Partially accepted | 5 MiB parts (2-4 min window); 2-minute audio checkpoints; split player. The final remux is kept until S0-D proves fMP4 seeking; live AAC muxing is adopted only if remux is dropped, keeping proven RecorderIO alignment. |
| FC-5 | Budget guard gaps (legacy, lag, 10 s minimums, atomicity, month boundary) | Fixed | §3.3: ×1.15, daily reconciliation, 80% line, atomic RPC, month-agnostic holds, 12:00 UTC, legacy first |
| FC-6 | Launch-month capacity overstated | Fixed | §1 box; cap formula; capacity calendar; S0-C off Cloud |
| FC-7 | No DeepSeek health check; inactivity timeouts | Fixed | Admission probe; wall-clock deadlines; own breaker; S0-B from sin; failures don't count |
| FC-8 | CPU isolation partial; slow degrade | Fixed (pre-spawn rejected) | Decode-only arm; degrade on first warning; audio-only subscribe; perf-2x mandatory. Spawning at prewarm rejected (no R1 work in shared prewarm); spawn at job start during PRE_JOIN. |
| FC-9 | Sarvam limits | Fixed | As PI-10 |
| FC-10 | Preflight before an invite exists; unlimited preflights | Fixed | `/api/r1/preflight`, link-token auth, per-link caps, ledger |
| FC-11 | Transcript still uploaded; 30-minute JWT pointless | Fixed | `record=False`; TTL 10 min |
| SP-1 | Legacy endpoints accept R1 invites and grants (blocker) | Fixed | No invites or grants for R1; 409 guards; negative tests |
| SP-2 | DSAR and erasure broken by R1 (blocker) | Fixed | CASCADE FKs; PR-8 DSAR steps with error checks; export; acceptance test. Pre-existing ignore-errors behaviour noted as a follow-up, not changed for phone. |
| SP-3 | Typed text input open | Fixed | `text_input=False`; `canPublishData:false` |
| SP-4 | Transcript to LiveKit Cloud | Fixed | `record=False`; S0-E verification; LiveKit in the notice |
| SP-5 | RBAC wrong or underspecified | Fixed | §7.9 roles; `owner_id`; IDOR tests (D14 for viewer) |
| SP-6 | Consent and notice inaccurate or incomplete | Fixed | §7.8 itemised notice; withdrawal; alternative path; staff consent; Legal before Stage A |
| SP-7 | DeepSeek legal posture over-claimed | Fixed | D11 Legal gate; ADR records but cannot approve; name masking; no sensitive questions |
| SP-8 | AI-GATE conflict; audit; weak calibration | Fixed (partly as owner option) | ADR-0015 supersession with sign-off; `audit_events`; calibration; 24 h pending reject (D3; the owner may choose 48 h or HR confirmation); identity check advised for HR, not a system gate (would contradict decision 10) |
| SP-9 | Guard in the wrong node; learner holds secrets | Fixed | Guard in `llm_node`; least-privilege prompts; sentinel fencing; injection regressions |
| SP-10 | JWT TTL rationale wrong | Fixed | 10-minute TTL |
| SP-11 | Link takeover | Fixed | Per-attempt nonce; audited rejoin |
| SP-12 | Worker gets full name and résumé; unsanitised name | Fixed | R1 context endpoint returns a sanitised first name only |
| SP-13 | R2 presign, logging, CSP hygiene | Fixed | §7.4/§7.7/§9 fence 10 |
| SP-14 | Shared worker secret | Fixed | Per-route R1 session and pipeline checks; settings audit trigger |
| SP-15 | Privileges and classification | Fixed | §8.1 conventions |
| SP-16 | Credential inventory | Fixed | PR-0 entries; Admin token interactive; throwaway S0-D |
| SP-17 | Protected attributes and employment promises | Fixed | Interviewer prefix prohibitions; scripted FAQ; scorer instruction |
| SP-18 | Jurisdiction gate | Fixed | D14: India-only attestation unless Legal widens |
| DT-1 | CI expiries (blocker) | Fixed | PR-pre; current-state edit as an owner-approved exception; expiry calendar |
| DT-2 | Deploys column wrong | Fixed | As PI-6 |
| DT-3 | Phone hotfixes kill live R1 | Fixed | §9 gate applies to all merges; automated in the deploy job |
| DT-4 | Test minutes exceed the reserve | Fixed | Capacity calendar; S0-C self-hosted; Stage A in a different month from Stage B; no per-deploy 20-minute smoke |
| DT-5 | Legacy invisible to the budget until cutover | Fixed | PR-L before Stage A; estimate includes legacy |
| DT-6 | Codec path untested in CI | Fixed | PyAV CI job; version assert; real import for the closure check |
| DT-7 | E2E not in CI; no fake media | Fixed | PR-6 e2e job and harness extension; post-deploy check redefined |
| DT-8 | Spike criteria incomplete | Fixed | §10.1: effort, samples, infra (`r1-spike`, sin), escalation paths |
| DT-9 | Stage acceptance not measurable; late first end-to-end run | Fixed | §10.4 numeric exits; PR-4a integration test; Stage A0 |
| DT-10 | API boot safety | Fixed | As PI-3 |
| DT-11 | Missing work items | Fixed | Ashby guard PR-1/2; PR-CT; credential rotation in PR-0; notice in PR-6; SQL tests PR-1; env vars by PR; incident runbook PR-0 |
| DT-12 | No schedule; PRs too large | Fixed | §10.3 dated schedule; PR-4 and PR-9 split; 08:00 latest merge |
| DT-13 | M1 creates tables that depend on spike results | Fixed | Ledger in PR-2, recordings in PR-8 (§8.1) |
| DT-14 | Phone canary undefined | Fixed | §9 named post-deploy check, owner, minutes |
| DT-15 | Concurrency 2 versus pool 1 | Fixed | Concurrency 1; owner pool step |
| DT-16 | Video on by default at the PR-9 merge | Fixed | PR-9a ships off; PR-V flips |
| DT-17 | "Merged" versus "deployed" dependencies; HR card disabled state | Fixed | §10 dependency definition; PR-7 disabled state |
| DT-18 | D-004 check and ADR evidence timing | Fixed | ADR-0015/0016/0017 were accepted by the owner on 2026-10-06 (PR-0). S0 evidence is appended as it lands, and the S0, Legal and calibration gates still bind implementation steps. The D-004 wording changes only with an owner decision, in the same PR. |
| DT-19 | "No existing test modified" inaccurate; fence keying | Fixed | §9 additive test edits listed; fence keyed on the `r1/` prefix or label |
| DT-20 | S0-D needs R2 early | Fixed | §12 item 7 moved to this week |
