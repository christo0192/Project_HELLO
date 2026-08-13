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

Build-foundation progress (Ashby Phase 1, plan Step 2): migration
`0028_queue_leases.sql` adds a lease-safe claim model to the L1 queue —
`FOR UPDATE SKIP LOCKED` atomic claim, unguessable lease tokens with a bounded
visibility window and absolute deadline, heartbeat extension, expired-lease
reclaim that never bypasses `max_attempts`, compare-and-set completion/failure,
single-transaction DLQ movement, and concurrent-safe replay. Queue and DLQ
remain service-role-only. Deterministic unit and negative-control tests cover
the worker-race, stale-worker-lockout, atomic-DLQ, concurrent-replay,
max-attempts-exhaustion, and fail-closed-token cases
(`app/api/src/__tests__/queue-leases.test.ts`); operations are described in
`docs/runbooks/queue-leases.md`. This is build-foundation only; production
go-live acceptance remains the separate gate described above.

## Supersession

None. Production acceptance is a separate gate.
