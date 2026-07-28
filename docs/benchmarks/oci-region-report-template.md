# OCI Region Benchmark Report

> **TEMPLATE — fill in real measurements before making any region decision.**
> **Status:** NOT-YET-MEASURED
> **Template version:** 1.0.0

---

## 1. Benchmark Metadata

| Field | Value |
|---|---|
| **Benchmark ID** | `oci-region-bench-______-________` |
| **Date** | ________ |
| **Operator** | ________ |
| **OCI Account** | ________ (non-sensitive identifier) |
| **Schema version** | 1.0.0 |

---

## 2. Status

**Current status:** `NOT-YET-MEASURED`

> ⚠️  **This report contains no real measurements.** All sections below are
> placeholders. Do not use this document to select a region, provision production
> resources, or make latency or cost claims.

**Reason measurements are pending:**
_________________________________________________________________

**Prerequisites completed:**
- [ ] OCI account with access to both Mumbai and Hyderabad regions
- [ ] Ampere A1 availability verified in both regions
- [ ] Operator-supplied endpoints collected (Supabase, candidate)
- [ ] Benchmark CLI self-tests pass (`python3 scripts/oci-benchmark-run self-test`)

---

## 3. Region Selection Criteria

These criteria are **falsifiable** — each can be proven wrong by a real
measurement. The default prior is NOT-YET-MEASURED; no criterion is assumed
to pass without evidence.

### 3.1 Latency Criteria

| # | Criterion | Threshold | Mumbai | Hyderabad | Winner | Falsifiable by |
|---|---|---|---|---|---|---|
| L1 | OCI→Supabase HTTP p95 | < 100 ms | NOT YET | NOT YET | NONE | A single probe exceeding 100 ms p95 |
| L2 | OCI→Candidate HTTP p95 | < 150 ms | NOT YET | NOT YET | NONE | A single probe exceeding 150 ms p95 |
| L3 | OCI→Supabase DNS p95 | < 20 ms | NOT YET | NOT YET | NONE | DNS resolution above 20 ms p95 |
| L4 | Intra-region TCP p95 | < 50 ms | NOT YET | NOT YET | NONE | TCP connect above 50 ms p95 |
| L5 | TLS handshake p95 | < 50 ms | NOT YET | NOT YET | NONE | TLS handshake above 50 ms p95 |

All latency criteria reference **p95** to exclude worst-case outliers from the
comparison while still being stricter than p99.

### 3.2 Availability Criteria

| # | Criterion | Required | Mumbai | Hyderabad | Falsifiable by |
|---|---|---|---|---|---|
| A1 | Ampere A1 VM.Standard.A1.Flex provisionable | Yes | NOT YET | NOT YET | "Out of host capacity" error on 3 consecutive attempts |
| A2 | At least one AD has A1 capacity | Yes | NOT YET | NOT YET | All ADs in region return capacity errors |
| A3 | Instance reaches RUNNING state within 5 minutes | Yes | NOT YET | NOT YET | Instance stuck in PROVISIONING > 10 min |

### 3.3 Capacity Criteria

| # | Criterion | Threshold | Mumbai | Hyderabad | Falsifiable by |
|---|---|---|---|---|---|
| C1 | 5 concurrent synthetic sessions complete | All pass | NOT YET | NOT YET | Any session failure at 5 concurrency |
| C2 | 10 concurrent synthetic sessions complete | ≥ 90% pass | NOT YET | NOT YET | > 10% failure rate at 10 concurrency |
| C3 | Per-session CPU stays below 80% | < 80% | NOT YET | NOT YET | CPU > 80% for > 30s during test |
| C4 | Per-session memory stays below 80% | < 80% | NOT YET | NOT YET | Memory > 80% for > 30s during test |

### 3.4 Cost Criteria

| # | Criterion | Threshold | Mumbai | Hyderabad | Falsifiable by |
|---|---|---|---|---|---|
| $1 | All projected usage within Always Free | Yes | NOT YET | NOT YET | Any service exceeds Always Free limit at target concurrency |
| $2 | Queue costs < $5/month at target volume | < $5/mo | NOT YET | NOT YET | OCI pricing calculator shows > $5/mo at projected requests |
| $3 | Network egress within Always Free limits | Yes | NOT YET | NOT YET | Egress exceeds free tier in projected model |

---

## 4. Measurement Results

> **This section is empty until real probes run.**

### 4.1 Mumbai Region

```
[INSERT: mumbai-to-supabase.json results]
[INSERT: mumbai-to-candidate.json results]
[INSERT: compute availability report]
[INSERT: capacity test results]
```

### 4.2 Hyderabad Region

```
[INSERT: hyderabad-to-supabase.json results]
[INSERT: hyderabad-to-candidate.json results]
[INSERT: compute availability report]
[INSERT: capacity test results]
```

---

## 5. Free Allowance Projection

> **Run:** `python3 scripts/oci-benchmark-run calculator --sessions-per-month N -o json`

```
[INSERT: calculator output at target concurrency]
```

**Always Free services projected to be exceeded:**
- [ ] None identified
- [ ] ________________________________ (list services)

**NOT Always Free services requiring separate pricing:**
- OCI Queue — estimate: $______ / month

---

## 6. Region Selection Recommendation

> **This section MUST remain empty until ALL criteria in §3 are measured.**

**Status:** `NOT-YET-MEASURED`

**Preliminary recommendation:** NONE — insufficient data.

**Decision rationale:**
_________________________________________________________________

**Signed off by:**
- Operator: ________ Date: ________
- Reviewer: ________ Date: ________

---

## 7. Evidence Artifacts

| Artifact | Path | Status |
|---|---|---|
| Benchmark result JSON | `[INSERT PATH]` | NOT YET |
| Markdown report (generated) | `[INSERT PATH]` | NOT YET |
| Calculator output | `[INSERT PATH]` | NOT YET |
| OCI console screenshots | `[INSERT PATH]` | NOT YET |
| Operator notes | `[INSERT PATH]` | NOT YET |

---

## 8. Sources

| Source | Date Retrieved |
|---|---|
| Oracle Always Free Resources (docs.oracle.com) | 2026-07-28 |
| ADR-0007 (Production deployment and region) | 2026-07-28 — **Proposed status, NOT accepted** |
| PLAN.md DEP-01..03, FND-08 | 2026-07-28 |
| `scripts/oci-benchmark-run --help` | CLI version 1.0.0 |

---

## 9. Disclaimer

This document is a measurement template, not a decision. No claim about Mumbai,
Hyderabad, or any other region is accepted until real measurements are recorded
above. This PR does not create, accept, or modify ADR-0007 or any other
Architecture Decision Record. All cost projections are sourced from public
documentation as of 2026-07-28 and are not a guarantee of future pricing.
