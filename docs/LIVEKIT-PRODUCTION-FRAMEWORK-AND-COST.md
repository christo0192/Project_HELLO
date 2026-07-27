# Gopu Screening Bot — LiveKit Production Framework & End-to-End Cost Projection

**Status:** Prototype validated (turn-quality + latency approved on live voice test). Decision: productionize on LiveKit Agents.
**Date:** 2026-07-03 · **FX assumption:** ₹85 / US$1 · **Numbers are planning estimates at list price** (volume-negotiated rates for Sarvam/Twilio will be lower).

---

## 1. The Framework (end-to-end)

We are standardizing on **LiveKit Agents** as the voice runtime. The Pipecat build is retired (kept only as emergency rollback). Everything below is one coherent stack.

### Call flow — outbound screening call, end to end

```
  Dashboard "Start Screening"
        │  (creates room, dispatches agent, places call)
        ▼
  Node API ──► Twilio (PSTN outbound to candidate's phone, India)
        │                     │
        │                     ▼
        │            Twilio Elastic SIP Trunk
        │                     │  (SIP)
        ▼                     ▼
  LiveKit Server (SFU) ◄─── LiveKit SIP bridge ──► candidate audio
        │
        ▼
  LiveKit Agent worker  ── the brain, per call:
        ├─ Sarvam STT (saaras:v3, India)      → speech→text
        ├─ v1-mini turn detector (LOCAL, CPU) → when is the candidate done?
        ├─ Anthropic Haiku LLM                → Gopu's responses
        └─ Sarvam TTS (bulbul:v3, shubh)      → text→speech
        │
        ├─► LiveKit Egress ──► MP3 recording ──► Supabase Storage (recordings_v2)
        └─► session events  ──► Supabase screening_v2 (transcript_turns, call_sessions)
                                        │
                                        ▼
                            React dashboard (live transcript, scorecard)
                                        │
                            Node scoring API (claude -p) at call end
```

### Components & who pays what

| Layer | Technology | Cost type |
|---|---|---|
| **Telephony (PSTN)** | Twilio Elastic SIP Trunking → LiveKit SIP | **Per-minute** (outbound to India) + number rental |
| **Media server (SFU)** | LiveKit (self-hosted, open-source) | **Fixed** (Fly.io compute) |
| **SIP bridge** | LiveKit SIP (self-hosted) | **Fixed** (Fly.io compute) — no per-min when self-hosted |
| **Turn detection** | v1-mini MultilingualModel (local ONNX) | **Free** (runs on agent CPU) |
| **STT** | Sarvam saaras:v3 | **Per-minute** |
| **TTS** | Sarvam bulbul:v3 (shubh) | **Per-character** |
| **LLM** | Anthropic Haiku 4.5 | **Per-token** |
| **Recording** | LiveKit Egress → MP3 → Supabase Storage | Mostly **fixed** (compute) + tiny storage |
| **Database** | Supabase `screening_v2` | **Fixed** (plan) |
| **Scoring** | Node API (`claude -p`) | Per-token (small, at call end) |
| **Dashboard** | React (Vercel/Fly) | **Fixed** |

> **Self-hosting flips most costs from per-minute to fixed.** Twilio (PSTN) and the three AI APIs (STT/TTS/LLM) are the only true per-minute meters. LiveKit, SIP, turn detection, and recording become fixed Fly.io compute — so unit economics *improve as volume grows*.

---

## 2. Per-minute unit economics (the variable floor)

These scale directly with minutes talked, regardless of how many servers we run.

| Component | List rate | Per conversation-min | ₹ / min | $ / min |
|---|---|---|---|---|
| **Twilio outbound → India mobile** | ~$0.0075–0.015/min via Elastic SIP Trunking* | full call min | ₹0.6–1.3 | $0.0075–0.015 |
| **Sarvam STT** (saaras:v3) | ₹30/hour | candidate audio | ₹0.50 | $0.006 |
| **Sarvam TTS** (bulbul:v3) | ₹30 / 10K chars | ~400–600 chars/min | ₹1.5 | $0.018 |
| **Haiku 4.5 LLM** | $1/M in · $5/M out (w/ prompt caching) | ~3 turns/min | ₹0.8–1.2 | $0.010–0.014 |
| **Recording storage** (MP3→Supabase) | ~$0.021/GB-mo, ~1 MB/min | | ₹0.1 | $0.001 |
| **Variable subtotal** | | | **≈ ₹3.5–4.6 / min** | **≈ $0.042–0.055 / min** |

*\*Twilio India outbound rates vary by number type and route, and **outbound voice in India requires DLT registration** (regulatory — see §5). Treat Twilio as a verify-before-launch line. LiveKit's own SIP charge ($0.003–0.004/min) applies only if we use LiveKit **Cloud**; self-hosting the SIP bridge removes it.*

---

## 3. TIER 1 — Minimum Production Prototype

**Goal:** connect everything for real — real servers, real Twilio outbound calls, MP3 recording, end-to-end testing — at low volume before scaling. This is the "prove it works in production shape" tier.

**Assumptions:** ~500 test minutes/month (~50 ten-min calls), single region (Mumbai), low concurrency (1–3 calls), one combined server box.

### Fixed monthly (real servers)

| Item | Spec | $/mo |
|---|---|---|
| Fly.io — LiveKit SFU + SIP + agent + egress | one `performance-4x` (CPU headroom for egress transcode) | ~$124 |
| Fly.io — bandwidth | media + recording egress at test volume | ~$5 |
| Supabase | Pro (needed for recording storage + realtime) | $25 |
| Twilio | 1 number rental + carrier fees | ~$3 |
| Dashboard + Node API | Vercel free / Fly shared | ~$5 |
| **Fixed subtotal** | | **≈ $162 / mo (₹13,800)** |

### Variable at 500 test-min

| | $ |
|---|---|
| Twilio (500 × ~$0.012) | ~$6 |
| STT+TTS+LLM (500 × ~$0.036) | ~$18 |
| Recording storage | ~$1 |
| **Variable subtotal** | **≈ $25 (₹2,100)** |

### **Tier 1 total: ≈ $185–190 / month (₹16,000)** · effective ~$0.37/min at this low test volume (hosting-dominated — expected, and it collapses at scale — see Tier 2).

> At prototype volume the **fixed servers dominate** — that's normal. You're paying to have production infrastructure standing, not for the minutes. The per-minute number only becomes meaningful once volume fills the servers you're already paying for.

---

## 4. TIER 2 — Scalable Production

**Goal:** steady-state operation at real hiring volume. Same architecture, more headroom and reliability; fixed cost spread across far more minutes.

**Assumptions:** 20,000–50,000 min/month, moderate concurrency (up to ~20 simultaneous calls), HA-minded infra.

### Fixed monthly (scaled)

| Item | Spec | $/mo |
|---|---|---|
| Fly.io — LiveKit SFU + SIP | dedicated `performance-4x` | ~$124 |
| Fly.io — agent workers | `performance-2x` ×2 (concurrency) | ~$124 |
| Fly.io — egress/recording | `performance-2x` | ~$62 |
| Fly.io — bandwidth | media + recording at volume | ~$20–40 |
| Supabase | Pro (+ usage) | ~$35 |
| Twilio | numbers + carrier | ~$10 |
| Dashboard + API | Fly/Vercel | ~$15 |
| **Fixed subtotal** | | **≈ $390–410 / mo (₹34,000)** |

### All-in per-minute at volume (fixed amortized + variable)

| Volume/mo | Fixed /min | Variable /min | **All-in /min** | vs Retell ($0.12) |
|---|---|---|---|---|
| 20,000 min | ₹1.7 ($0.020) | ₹4.0 ($0.048) | **≈ ₹5.7 ($0.068)** | **~1.8× cheaper** |
| 50,000 min | ₹0.7 ($0.008) | ₹4.0 ($0.048) | **≈ ₹4.7 ($0.056)** | **~2.1× cheaper** |

### Monthly totals at volume

| Volume/mo | **Monthly all-in** |
|---|---|
| 20,000 min | **≈ $1,360 (₹116,000)** |
| 50,000 min | **≈ $2,800 (₹238,000)** |

> **The scaling story:** fixed infra ($390–410) amortizes toward zero per minute as volume grows, so the all-in cost *falls* toward the variable floor of ~₹4/min. You never pay a per-minute platform tax the way you did with Retell.

---

## 5. Assumptions, levers & caveats

**Cost-reduction levers (not yet applied — future upside):**
- **LLM: Haiku → Gemini Flash-Lite (Google Mumbai region)** — ~10× cheaper LLM + lower India latency. Drops the LLM line from ~₹1/min toward ~₹0.1/min.
- **Sarvam volume pricing** — at 20k+ min/month, STT/TTS list rates are negotiable; TTS is the largest AI line.
- **Prompt caching** on Gopu's system prompt + candidate resume — keeps Haiku input cost flat as transcripts grow (built into how we call the API).

**Caveats / must-verify before launch:**
- **India DLT / regulatory:** outbound voice calling in India requires DLT registration and consent handling. This is a **compliance blocker**, not a cost line — it gates go-live for outbound. Confirm status before scaling telephony.
- **Twilio India route rates vary** — verify account-specific per-minute against Twilio's India pricing once the trunk is provisioned.
- **Recording:** production adds **LiveKit Egress → MP3 → Supabase `recordings_v2`**. The prototype's spike agent did **not** record — recording is a production addition (see build plan). MP3 requires a transcode step in egress (CPU — sized into the Fly boxes above).
- **Concurrency drives server count**, not minutes — a spike of simultaneous calls needs more agent workers even if total minutes are modest.

**Sources:** [Twilio Voice pricing – India](https://www.twilio.com/en-us/voice/pricing/in) · [Twilio SIP Trunking – India](https://www.twilio.com/en-us/sip-trunking/pricing/in) · [LiveKit pricing](https://livekit.com/pricing) · [Sarvam API pricing](https://www.sarvam.ai/api-pricing) · Haiku 4.5 $1/$5 per MTok (Anthropic).

---

## 6. Bottom line for the decision

| | Minimum Prototype | Scalable Production (50k min) |
|---|---|---|
| **Monthly** | ~$185 (₹16,000) | ~$2,800 (₹238,000) |
| **Per minute** | ~$0.37 (test volume) | ~$0.056 (₹4.7) |
| **vs Retell $0.12/min** | n/a (proving stage) | **~2× cheaper, and falling with volume** |

Self-hosting on Fly.io + Twilio + Sarvam + local v1-mini gives you **ownership, India-proximate latency, MP3 recordings you control, and a per-minute cost that improves as you grow** — the opposite of a per-minute platform tax.
