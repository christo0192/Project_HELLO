# ADR-0004: Durable post-session job queue

**Status:** Proposed

**Decision owner:** Engineering Lead (unassigned)

**Plan references:** D-002, REL-01, REL-02, REL-03

## Context

The LiveKit worker currently calls the assessment endpoint when a session closes.
That request is not durable: worker termination, API failure, or timeout can lose
the scorecard, and retries can duplicate side effects. Production requires a
transactional outbox, idempotent consumers, retry/backoff, dead-letter handling,
replay, and backlog observability.

## Decision

Do not select Cloud Tasks, BullMQ/Redis, SQS, RabbitMQ, or another queue until
D-002 is approved. Benchmark the smallest operationally credible options against
the selected cloud, workload identity, ordering needs, delayed retries, DLQ and
replay support, local testability, regional availability, cost, and operator
burden. The application contract is provider-neutral: a durable session
transition writes an outbox event, and an idempotent scoring consumer owns the
assessment side effect.

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
