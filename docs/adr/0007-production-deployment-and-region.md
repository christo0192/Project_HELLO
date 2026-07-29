# ADR-0007: Production deployment and region

**Status:** Proposed

**Direction confirmed (2026-07-28):** OCI selected as cloud provider. Mumbai
(`ap-mumbai-1`) and Hyderabad (`ap-hyderabad-1`) must be benchmarked (DEP-01)
before region selection; measured latency and contractual/legal evidence
required. Production Supabase is Mumbai `ap-south-1`. Target 5 concurrent
sessions, validate to 10. Formal owner approval and evidence pending. This is
a selected direction, not stakeholder sign-off, and does not constitute FND-08
acceptance.

**Decision owner:** Engineering Lead, Security Lead, and Legal Counsel (unassigned)

**Plan references:** D-003, D-005, FND-08, GOV-07, DEP-01, DEP-02, DEP-03

## Context

The system runs locally and depends on Supabase, LiveKit, Sarvam, Anthropic, and
a future queue/observability stack. Production cloud, compute region, LiveKit
Cloud versus self-hosting, launch concurrency, residency requirements, RPO/RTO,
and HA posture are all open. An India region is an unverified requirement and
must not be assumed from marketing labels or endpoint names.

**Direction (2026-07-28):** OCI has been selected as the cloud provider.
Compute-region selection requires preliminary Mumbai (`ap-mumbai-1`) and
Hyderabad (`ap-hyderabad-1`) measured/legal evidence. Formal DEP-01 acceptance
depends on TST-09 (load/soak), REL-01 (durable queue), and OBS-03 (metrics).
Production Supabase already exists unused in Mumbai (`ap-south-1`). Target 5
concurrent sessions, validate to 10. These are selected directions, not
stakeholder sign-off. Production provisioning remains blocked. See
`docs/decisions/fnd-08-inputs.md`.

## Decision

Do not provision production compute or choose LiveKit hosting until FND-08 defines
residency/data-flow constraints, RPO/RTO, concurrency, and owners. The OCI cloud
direction informs architecture planning, and a preliminary owner-approved
Mumbai/Hyderabad synthetic probe with teardown may run for region discovery, but
does not constitute formal DEP-01 acceptance. Production provisioning still
requires contractual and technical region evidence, measured
candidate-to-worker/provider latency, Egress support, quota/capacity, workload
identity and secret-manager integration, backup/restore, failure domains,
operations burden, support, and cost. Document the explicit HA or accepted
single-instance posture before launch.

## Consequences

Production provisioning is blocked, but the project avoids an expensive move or
non-compliant data flow. Staging can still use isolated non-production resources
that contain no production data.

## Evidence

Required before acceptance: signed FND-08 inputs, provider region/DPA evidence,
latency and load benchmark, capacity/cost model, network/data-flow diagram,
backup and failover tests, HA decision, IaC review, and named operators.

## Supersession

None. Update this ADR to Accepted only when D-003 and D-005 receive approval.
