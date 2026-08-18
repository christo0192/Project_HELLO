# ADR-0012: Ashby runtime execution topology

**Status:** Accepted
**Decision owner:** christo0192
**Plan references:** Ashby Wave 2 Step 6 (runtime activation spine); ADR-0007 (production deployment and region); ADR-0010 (hosting topology); migration 0032.

## Context

Wave 2 delivered the complete Ashby domain layer — webhook ingress, transactional
outbox, signal worker, import/ingestion/invite orchestration, reconciliation, and
the scorecard→stage saga — as pure modules over injected seams. None of it ran.
The API process (`app/api/src/index.ts`) started an HTTP server and nothing else:
there was no queue consumer, no scheduler, no reclaim sweeper, and no production
construction of the Ashby client or its stores. A signed webhook durably enqueued
an `ashby.signal` job that no process would ever claim.

Turning that into an executable pipeline requires choosing WHERE the recurring
work runs. Three options were considered:

1. **In-process loops inside the existing API app.** No new deploy surface.
2. **A second Fly process group** (`[processes] worker = "node dist/src/worker.js"`).
   Isolates worker CPU from request handling.
3. **A separate Fly app** for the worker. Strongest isolation; independent scaling.

Constraints that shaped the choice:

- `app/api/fly.toml` sets `min_machines_running = 1` (a deliberate fix from #48:
  scale-to-zero broke the voice worker's `worker-context` lookup), plus
  `auto_start_machines`/`auto_stop_machines = true`. So a warm machine already
  exists, and the number of concurrently running machines is **not fixed** and
  must not be assumed.
- `scripts/deploy-fly-workflow.test.mjs` is a Quality gate that contract-tests the
  deploy workflow. Adding a process group changes that contract.
- The queue and operation outbox are already lease-safe: `claim_job` and
  `claim_ashby_operation` both use `FOR UPDATE SKIP LOCKED` with an unguessable
  lease token, and every mutation is a compare-and-set on the live lease.

## Decision

**Run the Ashby workers and scheduler in-process inside the existing API app,
gated behind an independent `ASHBY_RUNTIME_ENABLED` flag that defaults to false.**

- `createAshbyRuntime()` returns `null` unless `ASHBY_INTEGRATION_ENABLED`, a
  usable `ASHBY_WEBHOOK_SECRET`, `ASHBY_RUNTIME_ENABLED`, and `ASHBY_API_KEY` are
  ALL present. With the shipped defaults nothing is constructed — no client, no
  timer, no DB poll, no network call — so merging and deploying this change is a
  no-op for the running system.
- `index.ts` constructs the runtime and starts the scheduler after `listen`, and
  awaits `workers.stop()` inside the `shutdown.boot(...)` continuation before
  `process.exit`. `lib/shutdown.ts` exposes no drain hook and is deliberately left
  untouched (it has its own dedicated suite); the sequencing lives in the
  entrypoint instead.
- `app.ts` is NOT modified for scheduling: HTTP construction stays side-effect
  free, so every existing `createApp()` test is unaffected.
- **Correctness across machines comes from the database leases, never from an
  assumption about process count.** The scheduler jitters every timer so N
  machines de-synchronise rather than forming a thundering herd, and
  reconciliation additionally takes a DB single-flight lease (0032
  `begin_ashby_sync_run`) so two schedulers can never both page the provider and
  both advance the cursor.

## Consequences

**Accepted costs.**

- Worker capacity is coupled to HTTP capacity: a burst of screening work and a
  burst of recruiter traffic contend for the same 1 shared CPU / 2048 MB machine.
- `auto_stop_machines` can stop a machine mid-tick. This is safe but not free: the
  job's lease expires and the new reclaim loop (`reclaimExpired`, which nothing
  called before) requeues or dead-letters it on the next sweep, so recovery is
  delayed by up to `ASHBY_RECLAIM_INTERVAL_MS`.
- Scaling the API for request load also scales the number of schedulers. That is
  correct by construction but increases claim contention and provider read volume.

**Rejected alternatives.**

- A Fly process group (option 2) would isolate CPU but changes the deploy contract
  asserted by `scripts/deploy-fly-workflow.test.mjs`, and would need its own
  health/restart semantics — cost not justified while the runtime is disabled by
  default and unproven against a real tenant.
- A separate Fly app (option 3) adds a second deploy pipeline, a second secret
  set, and version-skew risk between the API and the worker for zero benefit at
  this stage.

**Migration trigger.** Move to option 2 when any of these hold, and record the
move as a superseding ADR:

- signal-to-import lag exceeds the runbook threshold under normal load;
- the reclaim loop is regularly recovering work because machines stop mid-tick;
- Ashby read volume from duplicate scheduler ticks becomes a rate-limit concern;
- worker CPU measurably degrades p95 API latency.

## Evidence

- `app/api/src/integrations/ashby/runtime.ts` — fail-closed composition root;
  returns `null` while any gate is closed.
- `app/api/src/integrations/ashby/scheduler.ts` — jittered, single-flight,
  self-rescheduling loops with an idempotent `stop()` that awaits in-flight ticks.
- `app/api/src/lib/queue/runner.ts` — bounded-concurrency leased consumer; every
  commit is a CAS on the live lease.
- `app/supabase/migrations/0032_ashby_runtime_activation.sql` —
  `begin_ashby_sync_run` / `end_ashby_sync_run` single-flight lease and the
  `no_progress_runs` counter.
- Tests: `ashby-runtime-config.test.ts` (no client/timer/DB when disabled),
  `ashby-scheduler.test.ts` (injected timers; 30 start/stop cycles leak nothing),
  `queue-runner.test.ts` (two concurrent runners process each job exactly once),
  `ashby-runtime-chain.test.ts` (duplicate webhook, reconciliation recovery,
  enqueue failure, lost lease, and two concurrent runners all converge to exactly
  one import/link/ingestion/invite),
  `ashby-reconcile-single-flight.test.ts` (only one of two overlapping runs
  advances the checkpoint).
- Real Docker `scripts/supabase-test.sh`: migrations 0001–0032 apply clean with
  zero drift; 349 policy tests pass (330 before the independent-review repair).
- Post-review repair: `runtime-health.ts` registers the live scheduler so the
  health surface reports real tick bookkeeping plus a fleet-wide durable
  backlog, rather than configuration. The heartbeat is deliberately
  process-local — `registeredInThisProcess: false` is never treated as evidence
  that the fleet has no scheduler, which is exactly the multi-machine
  assumption this ADR refuses to make.

## Supersession

Supersedes nothing. Extends ADR-0010 (hosting topology) with the execution
location for Ashby background work. Will be superseded if the migration trigger
above is met and the worker moves to its own Fly process group or app.
