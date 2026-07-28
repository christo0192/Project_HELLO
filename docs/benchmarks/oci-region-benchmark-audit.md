# OCI Region Benchmark — Assumptions vs. Measurements Audit

**Date:** 2026-07-28
**Status:** Draft — sources cited, no measurements yet
**PR scope:** PR 2 (OCI region/cost benchmark harness)
**Sources:** PLAN.md (v1.0, §DEP-01..03, §FND-08), ADR-0007, docs/repository-inventory.md, docs/LIVEKIT-PRODUCTION-FRAMEWORK-AND-COST.md, Oracle Always Free docs (docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

---

## 1. PLAN References Decomposed

### DEP-01 — Capacity Benchmark
| # | Statement | Classification | Evidence required |
|---|---|---|---|
| 1a | "Benchmark representative candidate infrastructure with realistic concurrent voice sessions" | **MEASUREMENT** | Must run probes in both Mumbai and Hyderabad, 5→10 concurrent sessions |
| 1b | "find saturation/failure points and resource/network/cost per session" | **MEASUREMENT** | CPU, memory, network per session; failure modes documented |
| 1c | "no free-tier/vendor capacity claim is accepted without measurement" | **ASSUMPTION (gate rule)** | This is the measurement rule itself — no claim is trusted until measured |
| 1d | Ampere A1 (2 OCPU, 12 GB RAM) can handle 5–10 concurrent voice sessions | **ASSUMPTION** | Must be measured; PLATFORM WARNING in PLAN.md: "Do not accept free-tier or vendor concurrency assumptions" |

### DEP-02 — Provisioning from Benchmark
| # | Statement | Classification | Evidence required |
|---|---|---|---|
| 2a | "provision target concurrency plus SRE-approved safety headroom" | **ASSUMPTION** (post-benchmark decision) | Not in this PR scope — depends on DEP-01 results |
| 2b | "isolate independently scaling/failing worker, API/web, queue and media responsibilities" | **ASSUMPTION** (architecture goal) | Service boundaries documented below; isolation design is future PR |
| 2c | Target concurrency is 5 sessions, tested to 10 | **ASSUMPTION** (from alignment) | Verifiable by benchmark harness |

### DEP-03 — HA Decision
| # | Statement | Classification | Evidence required |
|---|---|---|---|
| 3a | HA decision (multi-zone/multi-instance) depends on SLO and cost | **ASSUMPTION** (decision framework) | Not in this PR scope |
| 3b | Mumbai has multiple availability domains | **ASSUMPTION** | Must be verified during provisioning; Oracle docs state "In regions with multiple availability domains" |

### FND-08 — Launch-Blocking Policy Inputs
| # | Statement | Classification | Evidence required |
|---|---|---|---|
| 8a | "Resolve…tenancy (D-011), residency/data-flow constraints, initial RPO/RTO, launch concurrency and accountable owners" | **ASSUMPTION** (blocked gate) | All D-001..D-011 are OPEN; FND-08 is not resolved |
| 8b | "India data residency is an open legal/security requirement, not a confirmed fact" | **ASSUMPTION** (explicitly unresolved) | Legal must confirm before provisioning |
| 8c | "Mumbai is available from Supabase, LiveKit, and the compute provider" | **ASSUMPTION** | Each provider must be verified contractually and technically |

---

## 2. ADR-0007 Analysis

**Status:** Proposed — NOT accepted. Production provisioning is blocked.

| # | Statement | Classification | Evidence required |
|---|---|---|---|
| A7a | "Do not provision production compute or choose LiveKit hosting until FND-08 defines residency/data-flow constraints, RPO/RTO, concurrency, and owners" | **ASSUMPTION** (gate — binding) | FND-08 must be resolved |
| A7b | "Evaluate cloud and LiveKit options using contractual and technical region evidence, measured candidate-to-worker/provider latency, Egress support, quota/capacity, workload identity and secret-manager integration" | **MEASUREMENT** (required) | This PR builds the benchmark harness to partially address the "measured latency" requirement |
| A7c | OCI Mumbai and Hyderabad are the two candidate regions for compute | **ASSUMPTION** | Benchmarks must include both; this PR does not choose |
| A7d | Single-instance posture may be acceptable for launch | **ASSUMPTION** | DEP-03 not yet decided |

---

## 3. Application Service Boundaries

Current and target service boundaries from repository-inventory.md, LIVEKIT-PRODUCTION-FRAMEWORK-AND-COST.md, and PLAN.md §2:

| Service | Boundary | Runtime | Region-dependent | OCI-hosted (target) |
|---|---|---|---|---|
| API server | Express/TypeScript REST + scoring | Node.js | Yes — compute | Potentially |
| Web dashboard | React/Vite SPA | Browser + CDN | No (static assets) | No |
| Voice agent | LiveKit Agents pipeline (STT→LLM→TTS) | Python | Yes — compute + LiveKit SFU | Potentially |
| LiveKit SFU + SIP | Media server + SIP bridge | Self-hosted or Cloud | Yes — SFU region | Potentially |
| Supabase | Database, Auth, Storage, Realtime | Managed (ap-south-1) | Mumbai confirmed | No |
| Sarvam STT/TTS | External API (saaras:v3, bulbul:v3) | SaaS | India-proximate assumed | No |
| Anthropic Haiku | External API | SaaS | US/EU regions | No |
| Turn detection | v1-mini ONNX model | Local CPU | Co-located with agent | Potentially |
| Recording Egress | LiveKit Egress → MP3 → Supabase Storage | Compute + Storage | Co-located with SFU | Potentially |
| Queue (future) | Job queue for post-session scoring | Managed | **NOT** Always Free | OCI Queue (Option A) |
| Observability | Logging, Monitoring, APM, Notifications | Managed | Always Free eligible | OCI (Option A) |

### Boundary notes
- Benchmark probes must exercise **API server and Voice agent** boundaries as the OCI-hosted compute candidates.
- Supabase is Mumbai (`ap-south-1`) — all OCI-to-Supabase latency tests must target that region.
- External APIs (Sarvam, Anthropic) are not OCI-dependent but their latency from OCI regions matters.
- OCI Queue is the only Option A component **not in Always Free**.

---

## 4. OCI Always Free Allowances (Official, as of 2026-07-28)

Source: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

### Compute
| Resource | Always Free Limit | Notes |
|---|---|---|
| Ampere A1 (VM.Standard.A1.Flex) | 1,500 OCPU hrs + 9,000 GB hrs/month ≈ **2 OCPUs + 12 GB RAM** | Flexible: 1×2-OCPU or 2×1-OCPU instances |
| AMD Micro (VM.Standard.E2.1.Micro) | 2 instances, 1/8 OCPU + 1 GB RAM each | Separate from A1 allocation |
| Boot/block volume | 200 GB total | Minimum 47 GB boot volume per instance |
| Volume backups | 5 backups | |

### Observability & Management (Confirmed Always Free)
| Service | Always Free Limit | Notes |
|---|---|---|
| **Logging** | Always Free | No explicit quota in docs; free for all accounts |
| **Monitoring** | 500M ingestion data points, 1B retrieval data points/month | |
| **Notifications** | 1M HTTPS notifications/month + 1,000 email notifications/month | |
| **APM** | 1,000 tracing events/hour + 10 Synthetic Monitor runs/hour | Trace sampling required at volume |
| **Connector Hub** | 2 Always Free connectors | |

### Networking & Security (Confirmed Always Free)
| Service | Always Free Limit | Notes |
|---|---|---|
| VCN | Always Free | |
| Site-to-Site VPN | 50 IPSec connections | |
| Vault | Always Free | |
| Bastions | Always Free | |
| Resource Manager (Terraform) | Always Free | |
| Security Advisor | Always Free | |

### NOT Always Free — Requires Pricing
| Service | Status | Notes |
|---|---|---|
| **OCI Queue** | **NOT in Always Free tier** | Not listed on Always Free page; pay-per-request model applies |

**Critical finding:** OCI Queue is NOT an Always Free service. The alignment's Option A ("OCI Queue, Logging, Monitoring, APM, and Notifications, targeting documented free allowances") must treat Queue as a **measured cost component**, not a free assumption. Queue pricing must be verified and included in the free-allowance calculator (Step 5).

---

## 5. Assumptions → Measurements Mapping

| Assumption | Must be measured by | Blocked until |
|---|---|---|
| Ampere A1 handles 5→10 concurrent voice sessions | Benchmark probes in Mumbai + Hyderabad | Probes provisioned (operator opt-in) |
| OCI Mumbai latency ≤ OCI Hyderabad latency | DNS/TCP/TLS/HTTP latency measurements | Real endpoints supplied |
| OCI-to-Supabase-Mumbai latency is acceptable | Path measurement OCI→ap-south-1 | OCI compute + Supabase endpoint |
| OCI-to-Bangalore (candidate) latency is acceptable | Path measurement OCI→synthetic candidate endpoint | Operator-supplied endpoint |
| Free allowances cover 5-session steady state | Calculator with documented thresholds (Step 5) | Current OCI pricing |
| Queue costs are negligible at launch volume | Queue pricing + request model analysis | OCI Queue pricing page |
| Both Mumbai and Hyderabad have A1 capacity | Provisioning attempt | OCI account + region selection |

---

## 6. Explicitly Out of Scope (This PR)

- Resolving FND-08 or any D-001..D-011 decision
- Accepting, modifying, or creating any ADR (including ADR-0007)
- Provisioning any OCI or Supabase resource
- Choosing Mumbai over Hyderabad (or vice versa)
- Credentials, secrets, or production endpoints
- PLAN.md, docs/HANDOVER.md, app code, Supabase migrations, infra/oracle/**, root manifests/lockfiles, .env*, candidate data

---

## 7. Sources and Citation Dates

| Source | URL | Retrieved |
|---|---|---|
| Oracle Always Free Resources | `docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm` | 2026-07-28 |
| PLAN.md | `./PLAN.md` (v1.0, last updated 2026-07-27) | 2026-07-28 |
| ADR-0007 | `./docs/adr/0007-production-deployment-and-region.md` | 2026-07-28 |
| Repository Inventory | `./docs/repository-inventory.md` (2026-07-27) | 2026-07-28 |
| LiveKit Production Framework | `./docs/LIVEKIT-PRODUCTION-FRAMEWORK-AND-COST.md` (2026-07-03) | 2026-07-28 |
