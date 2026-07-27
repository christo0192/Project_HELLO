# ADR-0007: Production deployment and region

**Status:** Proposed

**Decision owner:** Engineering Lead, Security Lead, and Legal Counsel (unassigned)

**Plan references:** D-003, D-005, FND-08, GOV-07, DEP-01, DEP-02, DEP-03

## Context

The system runs locally and depends on Supabase, LiveKit, Sarvam, Anthropic, and
a future queue/observability stack. Production cloud, compute region, LiveKit
Cloud versus self-hosting, launch concurrency, residency requirements, RPO/RTO,
and HA posture are all open. An India region is an unverified requirement and
must not be assumed from marketing labels or endpoint names.

## Decision

Do not provision production compute or choose LiveKit hosting until FND-08 defines
residency/data-flow constraints, RPO/RTO, concurrency, and owners. Evaluate cloud
and LiveKit options using contractual and technical region evidence, measured
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
