# ADR-0004: Durable post-session job queue

**Status:** Proposed

**Direction confirmed (2026-07-28):** OCI Queue selected as technical direction
with OCI Logging, Monitoring, APM, and Notifications for observability. Formal
owner approval and evidence pending. This is a selected direction, not
stakeholder sign-off, and does not constitute FND-08 acceptance.

**Decision owner:** Engineering Lead (unassigned)

**Plan references:** D-002, REL-01, REL-02, REL-03

## Context

The LiveKit worker currently calls the assessment endpoint when a session closes.
That request is not durable: worker termination, API failure, or timeout can lose
the scorecard, and retries can duplicate side effects. Production requires a
transactional outbox, idempotent consumers, retry/backoff, dead-letter handling,
replay, and backlog observability.

**Direction (2026-07-28):** OCI Queue (with OCI Logging, Monitoring, APM, and
Notifications) has been selected as the technical direction. Formal owner
approval, failure-injection prototype, and evidence are pending. See
`docs/decisions/fnd-08-inputs.md`.

## Decision

Do not commit to a final queue implementation until D-002 receives formal owner
approval. The OCI Queue direction informs architecture planning and the
foundation Terraform scaffold, but does not authorize production implementation.
The application contract remains provider-neutral: a durable session transition
writes an outbox event, and an idempotent scoring consumer owns the assessment
side effect. Benchmark OCI Queue against workload identity, ordering needs,
delayed retries, DLQ and replay support, local testability, regional
availability, cost, and operator burden before acceptance.

## Consequences

Scoring remains prototype-only until the queue and outbox are implemented.
Keeping the contract provider-neutral reduces lock-in but adds an adapter and
integration-test boundary.

## Evidence

Required before acceptance: decision matrix, failure-injection prototype,
idempotency test, retry/DLQ/replay demonstration, backlog metrics, regional and
cost evidence, and recovery runbook.

## Supersession

None. Update this ADR to Accepted only when D-002 receives approval.
