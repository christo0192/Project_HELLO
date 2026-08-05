# Gopu Screening Bot — Production Prototype: Approval & Build Plan

**Purpose:** Approval to build the end-to-end production prototype on LiveKit.
**Prepared:** 2026-07-03 · **FX:** ₹85 / US$1 · List-price planning estimates.
**Prototype validated:** turn-quality + latency approved on live voice test. This doc is to greenlight the "make it a real product (lean)" build.

---

## 1. What we're building

A complete, production-shaped screening-call product — thin but real, end to end:

```
Dashboard "Start Screening"
   → outbound call to candidate (Twilio, India)
   → Gopu interviews them (Sarvam voice + Gemini brain + local turn-detection)
   → live transcript on the dashboard (Supabase)
   → MP3 recording saved (the piece the old build was missing)
   → auto-scorecard at call end
```

Everything runs on **free tiers + one tiny India server**, so we can screen real candidates and test the full flow for **under ~$25/month**.

---

## 2. The stack (final decisions)

| Layer | Choice | Why |
|---|---|---|
| **Voice runtime** | LiveKit Agents | Validated; only legal route to the v1-mini turn detector |
| **Media server + SIP + MP3 egress** | **LiveKit Cloud — free tier** | 1,000 agent-min/mo, SIP + recording **built-in, $0**. No media server to run |
| **Turn detection** | v1-mini (local, on-device) | Free, India-fast, transcript-independent |
| **Speech-to-text** | Sarvam saaras:v3 (India) | Fast, India-hosted |
| **Text-to-speech** | Sarvam bulbul:v3 (shubh) | Matches current production voice |
| **LLM (the brain)** | **Gemini 3.1 Flash-Lite — Google Developer API** | Low-cost, strong instruction-following via Google's global endpoint; strict regional processing would require Vertex AI |
| **Agent worker host** | **Oracle Cloud free (Mumbai)** or DigitalOcean Bangalore (~$6) | Tiny India box runs Gopu's brain |
| **Recording** | Open-source MP3 (LiveKit egress / ffmpeg) → storage | The MP3 the previous build didn't save |
| **Recording storage** | Supabase Storage free (1GB) → Cloudflare R2 later | Free for prototype |
| **Database** | Supabase free (`screening_v2`, existing) | Transcripts, sessions, scores — dashboard reads it |
| **Telephony** | Twilio Elastic SIP Trunking → LiveKit SIP | Real outbound calls |
| **Dashboard + scoring** | Existing React + Node (`claude -p`) | Reused unchanged |

---

## 3. Prototype cost

### Fixed infra — per month

| Item | Choice | $/mo |
|---|---|---|
| Media (SFU + SIP + MP3 egress) | LiveKit Cloud free tier | **$0** |
| Agent worker | Oracle free Mumbai ($0) or DO Bangalore (~$6) | **$0–6** |
| Database | Supabase free | **$0** |
| Recording storage | Supabase free 1GB | **$0** |
| Twilio | 1 number rental | **~$3** |
| Dashboard + API | Vercel free / existing | **$0** |
| **Fixed total** | | **≈ $3–9 / month** |

### Per-minute usage (only when calls happen)

| Component | ₹/min | $/min |
|---|---|---|
| Twilio outbound (India) | ₹1.0 | $0.012 |
| Sarvam STT | ₹0.50 | $0.006 |
| Sarvam TTS | ₹1.5 | $0.018 |
| **Gemini Flash-Lite LLM** | ₹0.1 | $0.0012 |
| Recording storage | ₹0.1 | $0.001 |
| **Total** | **≈ ₹3.2 / min** | **≈ $0.038 / min** |

**A 10-minute screening call ≈ ₹32 (~$0.38).**

### Prototype month, all-in (≈500 test minutes)

| | Amount |
|---|---|
| Fixed infra | ~$6 |
| Usage (500 min × ₹3.2) | ~$19 (₹1,600) |
| **Total** | **≈ $25 / month (₹2,100)** |

> **500 test minutes fits inside the free tiers** (LiveKit Cloud 1,000 agent-min, Supabase 1GB ≈ 1,000 min of recordings). So media, database, and storage are genuinely **$0** — you're only paying for the phone calls and a tiny server.

---

## 4. What I need to greenlight the build

| # | Need | Who | Notes |
|---|---|---|---|
| 1 | **LiveKit Cloud account** (free) | You sign up → I get URL + API key/secret | cloud.livekit.io, no card |
| 2 | **Google AI / Gemini API key** (Mumbai) | You create key | for the LLM |
| 3 | **Twilio account + 1 number** | You | for outbound calls |
| 4 | **India DLT registration** ⚠️ | You / legal | **Regulatory requirement for outbound voice in India.** Gates real outbound calls — see note below |
| 5 | **India server** (Oracle free / DO) | You create → I deploy, or I guide setup | tiny box for the agent worker |
| 6 | Supabase | Already have (`screening_v2`) | reuse free/existing |

> ⚠️ **DLT is the one real blocker.** India requires DLT registration + consent before outbound automated voice calls. If it isn't ready, we **build browser-first** (candidate joins from a link — works today, no DLT) and bolt on Twilio the moment DLT clears. This keeps the build moving with zero regulatory risk.

---

## 5. Build plan

| Step | What | Needs |
|---|---|---|
| 1 | Port Gopu's full screening script + resume/role context | — |
| 2 | Wire Supabase persistence (transcript_turns, call_sessions) | Supabase |
| 3 | **Add MP3 recording → storage** (the missing piece) | — |
| 4 | Swap LLM to pluggable Gemini/Haiku/Groq switch | Gemini key |
| 5 | Browser "Start Screening" flow (test end-to-end, no telephony) | LiveKit Cloud |
| 6 | Scoring trigger + live dashboard | — |
| 7 | Twilio SIP → real outbound calls | Twilio + DLT |
| 8 | Deploy to India box + LiveKit Cloud; end-to-end test | server |

Steps 1–6 need **no telephony and no DLT** — we can have a fully working, recorded, scored screening call (browser-based) before Twilio is even touched.

---

## 6. Where it goes when we scale (context for approval)

This is the *lean* tier. When call volume/concurrency grows, we self-host the media stack on a bigger India box and add redundancy — at which point the per-minute cost **drops toward ~₹4/min all-in** (~2× cheaper than the old Retell $0.12/min, and falling with volume). Full detail in `LIVEKIT-PRODUCTION-FRAMEWORK-AND-COST.md`.

The lean prototype is designed so **nothing is throwaway** — the same code and schema scale up; we just move the media stack from Cloud-free to self-hosted when volume justifies it.

---

## 7. Approval summary

| | |
|---|---|
| **Monthly cost to run the prototype** | **~$25 (₹2,100)** — mostly the phone calls |
| **Fixed infra** | **~$3–9/mo** (free tiers + tiny server) |
| **Per call (10 min)** | **~₹32 ($0.38)** |
| **One blocker** | India DLT for outbound (workaround: browser-first) |
| **Reused as-is** | Supabase schema, dashboard, scoring API |
| **New capability** | MP3 recordings (previously missing) |

**Ask:** approve accounts #1–5 above (or #1–2, #5 + browser-first if DLT isn't ready), and I'll build Steps 1–8.
