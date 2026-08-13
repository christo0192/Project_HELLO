# Runbook — Lease-safe queue (0028)

Scope: the lease-safe claim model added to the L1 queue by migration
`0028_queue_leases.sql` and the `screening_v2` queue RPCs. This is
build-foundation infrastructure for Ashby Phase 1 (plan Step 2). It introduces
no Ashby product code, no external calls, and no production data. Queue payloads
remain generic opaque identifiers.

## Model

A worker **claims** a job instead of a fire-and-forget dequeue. A claim:

- selects one eligible (`pending`/`delayed`, due) job with
  `FOR UPDATE SKIP LOCKED` — two racing workers can never claim the same job;
- transitions it to `active` and increments `attempts` (a claim is a delivery);
- grants an unguessable `lease_token` (`gen_random_uuid()`), an opaque
  `lease_owner`, a bounded `lease_expires_at`, and an absolute
  `lease_deadline_at` (maximum total visibility).

Every subsequent worker mutation is a **compare-and-set** on
`(job id + status='active' + matching live lease_token + lease not expired)`:

| Operation | RPC | Guard |
|-----------|-----|-------|
| Claim | `claim_job` | `FOR UPDATE SKIP LOCKED` |
| Heartbeat | `heartbeat_job` | live matching lease; extension clamped to `lease_deadline_at` |
| Complete | `complete_job` | live matching lease; clears lease fields |
| Fail (retry or DLQ) | `fail_job` | live matching lease; retry while `attempts < max_attempts`, else single-transaction DLQ |
| Reclaim expired | `reclaim_expired_jobs` | `active` + `lease_expires_at <= now`; requeue while attempts remain, else DLQ |
| Legacy DLQ move | `dlq_job` | transactional insert-then-delete by id |
| Replay | `replay_dlq_job` | `FOR UPDATE SKIP LOCKED` on the DLQ row; one pending replacement |

A stale worker (expired lease, reclaimed job, or mismatched token) fails closed:
`complete`/`heartbeat` return false/`not_owned`, `fail` returns `not_owned`, and
nothing is mutated.

## Guarantees

- **Atomic claim** — exactly one worker wins a contested job.
- **Bounded visibility** — heartbeats never extend past `lease_deadline_at`.
- **No silent loss** — an expired active job is requeued (attempts remaining) or
  dead-lettered (attempts exhausted). Reclaim never bypasses `max_attempts`.
- **Atomic DLQ** — DLQ insertion and queue-row deletion happen in one function
  body (one transaction); a crash cannot leave both or neither record.
- **Concurrent-safe replay** — the DLQ row is locked with `SKIP LOCKED`, so two
  racing replays produce exactly one pending replacement.
- **Backend-only** — RLS stays enabled on `job_queue`/`job_dlq`; every queue RPC
  is revoked from `public`/`anon`/`authenticated` and granted only to
  `service_role`. Errors are stable sanitized codes; payloads and lease tokens
  are never logged.

## Operating notes

- Run `reclaim_expired_jobs(now, limit)` on a bounded cadence (a periodic sweep)
  to recover jobs from crashed workers. It is idempotent and safe to run
  concurrently (`SKIP LOCKED`).
- Choose `lease_seconds` slightly above the expected processing time and
  heartbeat well before expiry. The window is clamped to `[1, 900]` seconds and
  total visibility to `3600` seconds.
- `replay_dlq_job` resets `dedup_key` to `null`, so a replay never collides with
  the active-dedup unique index.

## Verification

- Deterministic unit + negative controls: `app/api/src/__tests__/queue-leases.test.ts`
  (worker race, stale-worker lockout, atomic DLQ, concurrent replay,
  max-attempts exhaustion, fail-closed token, dedup preserved).
- SQL policy assertions: `app/supabase/tests/policy_tests.sql`
  (lease columns present; every queue RPC service-role-only).
- Migration contract gate: `node scripts/migrate-rollback.test.mjs`
  (forward-only, non-destructive, contract-continuous).

## Non-goals

No Ashby client, webhook, resume ingestion, invitations, stage movement, or real
candidate data. Production go-live acceptance remains the separate ADR-0004 gate
(durable outbox wiring, failure-injection prototype on real Postgres, backlog
metrics, and recovery drill).
