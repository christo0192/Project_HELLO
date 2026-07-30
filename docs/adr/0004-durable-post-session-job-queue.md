# ADR-0004: Durable post-session job queue

**Status:** Accepted

**Decision owner:** christo0192 (repository owner / sole Product/Engineering owner)

**Owner direction (2026-07-30):** The sole Product/Engineering owner has selected
pg-boss (PostgreSQL-based job queue) in the existing Supabase/Postgres instance.
No separate queue infrastructure (OCI Queue, BullMQ+Redis, etc.) is introduced.
ADR-0004 is accepted as architecture. See
[`docs/decisions/fnd-08-owner-approval.md`](../decisions/fnd-08-owner-approval.md).

**Plan references:** D-002, REL-01, REL-02, REL-03

## Context

The LiveKit worker currently calls the assessment endpoint when a session closes.
That request is not durable: worker termination, API failure, or timeout can lose
the scorecard, and retries can duplicate side effects. Production requires a
transactional outbox, idempotent consumers, retry/backoff, dead-letter handling,
replay, and backlog observability.

**Owner direction (2026-07-30):** pg-boss in existing Supabase Postgres selected.
No new queue infrastructure. ADR-0004 accepted as architecture.

## Decision

pg-boss (PostgreSQL job queue) running in the existing Supabase/Postgres instance
is the selected queue architecture. This decision accepts the architectural
direction but does not authorize production implementation. Production go-live
additionally requires: durable outbox pattern, idempotent consumers,
retry/backoff/DLQ implementation, failure-injection prototype, backlog metrics,
and recovery runbook.

## Consequences

Scoring remains prototype-only until the queue and outbox are implemented.
No new queue infrastructure (OCI Queue, BullMQ+Redis) is introduced, keeping
cost and operational complexity near zero.

## Evidence

Owner direction recorded in `docs/decisions/fnd-08-owner-approval.md`. ADR-0004
accepted as architecture. Production go-live additionally requires: decision
matrix, failure-injection prototype, idempotency test, retry/DLQ/replay
demonstration, backlog metrics, regional and cost evidence, and recovery
runbook.

## Supersession

None. Production acceptance is a separate gate.
