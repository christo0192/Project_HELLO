# ADR-0007: Production deployment and region

**Status:** Accepted

**Decision owner:** christo0192 (repository owner / sole Product/Engineering owner)

**Owner direction (2026-07-30):** The sole Product/Engineering owner has selected
Oracle Cloud Always-Free Mumbai ($0) as the compute provider and region. LiveKit
will be self-hosted in Mumbai, beginning with the free cloud tier for initial
evaluation. ADR-0007 is accepted as architecture. See
[`docs/decisions/fnd-08-owner-approval.md`](../decisions/fnd-08-owner-approval.md).

**Plan references:** D-003, D-005, FND-08, GOV-07, DEP-01, DEP-02, DEP-03

## Context

The system runs locally and depends on Supabase, LiveKit, and a future
queue/observability stack. Production cloud, compute region, LiveKit hosting,
launch concurrency, residency requirements, RPO/RTO, and HA posture are now
defined at the architecture level. India region (Mumbai) is the owner-selected
target.

**Owner direction (2026-07-30):** OCI Always-Free Mumbai ($0) selected. LiveKit
self-hosted Mumbai, begin free cloud tier. ADR-0007 accepted as architecture.

## Decision

Oracle Cloud Always-Free tier in Mumbai region is the selected compute
provider/region. LiveKit self-hosted Mumbai, beginning with free cloud tier for
initial evaluation. Production Supabase already exists unused in Mumbai
(`ap-south-1`). Target 5 concurrent sessions, validate to 10. This decision
accepts the architectural direction but does not authorize production
implementation. Production go-live additionally requires: DEP-01 region-latency
benchmark, provider region/DPA evidence, capacity/cost model, network/data-flow
diagram, backup and failover tests, HA decision, IaC review, and named
operators.

## Consequences

Production provisioning remains blocked for go-live, but the architecture
direction is now concrete: OCI Always-Free Mumbai, self-hosted LiveKit Mumbai.
This enables focused implementation work while production evidence gates remain.

## Evidence

Owner direction recorded in `docs/decisions/fnd-08-owner-approval.md`. ADR-0007
accepted as architecture. Production go-live additionally requires: signed FND-08
inputs, provider region/DPA evidence, latency and load benchmark, capacity/cost
model, network/data-flow diagram, backup and failover tests, HA decision, IaC
review, and named operators.

## Supersession

None. Production acceptance is a separate gate.
