/**
 * TST-10 — Deterministic chaos / failure-injection (Phase 6 lane L3).
 *
 * All chaos is injected at the I/O boundaries and driven through the REAL
 * public seams — L1 queue (Queue + MemoryAdapter retry/backoff/DLQ/replay),
 * durable ordered transcript events + outbox (REL-02/03), the session CAS
 * state machine (REL-07), and reconciliation (REL-09). Assertions are made
 * against real outputs (job statuses, deduped event rows, outbox states,
 * CAS transitions, quarantine/log rows) — never against harness internals.
 *
 * Scenario → mechanism map (also in /tmp/phase6-l3-handoff.md):
 *   worker-kill at boundaries        → REL-01/04 (retry, DLQ, replay) + dedup
 *   queue failure (enqueue/claim/    → REL-01/04 adapter semantics; no loss
 *     complete)
 *   DB failure (event insert / rpc)  → stable error codes; retry; no loss
 *   provider failure / hang /        → REL-05/06 circuit breaker + timeout
 *     breaker open / half-open
 *   network failure (outbox publish) → REL-02/03 failed rows visible + recoverable
 *   duplicate / reordered events     → 0010 UNIQUE(session_id, turn_index) dedup
 *   reconciliation + negative        → REL-09 detect/repair + CAS idempotency
 *     control
 *
 * No real DB/network/provider. Fixtures synthetic. No mutation leaks across
 * tests (fresh MemoryDb + queue per test).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { upsertTranscriptEvent, getTranscriptEvents, countPendingOutbox } from '../lib/outbox.js';
import { transitionSession } from '../lib/session-lifecycle.js';
import { Queue } from '../lib/queue/index.js';
import {
  MemoryDb,
  setActiveDb,
  bindClaudeHarness,
  getClaudeHarness,
  createScriptedRunner,
  createQueueHarness,
  enqueueDelivery,
  runWorkerPass,
  superviseStaleActive,
  drainDlq,
  FaultyQueueAdapter,
  makeMonotonicClock,
  makeTickableClock,
  makeAutoTimeoutTimers,
  drainOutbox,
  runReconciliation,
  seedSession,
  seedCandidate,
  seedRole,
  makeUuid,
  isoAgo,
  type DeliveryEvent,
} from './support/chaos.js';

// ── Module mocks (hoisted factories; async + dynamic import to avoid
//    import-order/TDZ issues with the harness module) ──────────────────
vi.mock('../lib/supabase.js', async () => {
  const c = await import('./support/chaos.js');
  return { supabase: c.supabaseProxy, RESUME_BUCKET: 'resumes_v2' };
});

vi.mock('../lib/claude.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/claude.js')>();
  const c = await import('./support/chaos.js');
  return c.bindClaudeHarness(real).exports;
});

// Force the claude.js mock factory to run (binding the harness) even though
// no module-under-test in this file imports claude.js at module load.
await import('../lib/claude.js');

// ── Per-test state ─────────────────────────────────────────────────────
let db: MemoryDb;
let sessionId: string;
let candidateId: string;

beforeEach(async () => {
  db = new MemoryDb();
  setActiveDb(db);
  const role = await seedRole(db, { id: makeUuid(910) });
  const candidate = await seedCandidate(db, { id: makeUuid(911), role_id: role.id as string });
  candidateId = candidate.id as string;
  sessionId = makeUuid(912);
});

afterEach(() => {
  db.reset();
  setActiveDb(db);
});

/** Apply a delivery event via the real durable ordered store. */
async function applyEvent(payload: DeliveryEvent): Promise<void> {
  const { error } = await upsertTranscriptEvent(payload.sessionId, payload.turnIndex, payload.speaker, payload.text);
  if (error) throw new Error(error);
}

function makeEvent(turnIndex: number, text = `turn ${turnIndex}`): DeliveryEvent {
  return { sessionId, turnIndex, speaker: 'candidate', text };
}

/** Advance a tickable clock past every delayed job's scheduledAt. */
// (backoff base 1000 ms, max 60 s; a 65 s jump clears any delayed job)

// ═══════════════════════════════════════════════════════════════════════
// 1. Worker termination at lifecycle boundaries (REL-01/04)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 worker termination at lifecycle boundaries', () => {
  it('kill after enqueue before dequeue: next worker pass delivers the event (no loss)', async () => {
    const qh = createQueueHarness();
    const evt = makeEvent(1);
    const job = await enqueueDelivery(qh, evt);
    // Worker dies before its first pass: job remains 'pending'.
    expect((await qh.queue.getById(job.id))!.status).toBe('pending');

    const pass = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass.processed).toBe(1);
    expect((await qh.queue.getById(job.id))!.status).toBe('completed');

    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(1);
  });

  it('kill after dequeue before apply: supervisor fails the stale active job → retry → exactly-once effect', async () => {
    const tickClock = makeTickableClock();
    const qh = createQueueHarness({ clock: tickClock.clock, defaultMaxAttempts: 3, backoffBaseMs: 1000 });
    const evt = makeEvent(1);
    const job = await enqueueDelivery(qh, evt);

    // Worker claims the job then dies before applying it.
    const pass = await runWorkerPass(qh, { apply: applyEvent, killAfterDequeue: [0] });
    expect(pass.killed).toBe(1);
    expect((await qh.queue.getById(job.id))!.status).toBe('active');

    // Supervisor detects the stale active job and fails it through the real
    // retry seam (attempts < maxAttempts → 'delayed' with backoff).
    const { failed } = await superviseStaleActive(qh, [job.id], 0, 'worker_kill');
    expect(failed).toBe(1);
    const delayed = await qh.queue.getById(job.id);
    expect(delayed!.status).toBe('delayed');

    // Advance past the backoff window; a fresh worker redelivers it.
    tickClock.tick(65_000);
    const pass2 = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass2.processed).toBe(1);
    expect((await qh.queue.getById(job.id))!.status).toBe('completed');

    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(1); // exactly-once durable effect
    expect((await qh.queue.getDlqJobs())).toHaveLength(0);
  });

  it('kill after apply before complete: redelivery is deduped → exactly-once durable effect', async () => {
    const tickClock = makeTickableClock();
    const qh = createQueueHarness({ clock: tickClock.clock, defaultMaxAttempts: 3, backoffBaseMs: 1000 });
    const evt = makeEvent(2);
    const job = await enqueueDelivery(qh, evt);

    // Worker applies the event (durable), then dies before complete().
    const pass = await runWorkerPass(qh, { apply: applyEvent, killAfterApply: [0] });
    expect(pass.killed).toBe(1);
    expect((await qh.queue.getById(job.id))!.status).toBe('active');

    // Recovery: supervisor fail → retry → redeliver → dedup no-op → complete.
    const { failed } = await superviseStaleActive(qh, [job.id], 0, 'worker_kill');
    expect(failed).toBe(1);
    tickClock.tick(65_000);
    const pass2 = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass2.processed).toBe(1);

    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(1); // 0010 dedup prevented double-apply
    expect((await qh.queue.getById(job.id))!.status).toBe('completed');
  });

  it('kill with exhausted retries: job lands in DLQ, replay recovers it (bounded loss)', async () => {
    const tickClock = makeTickableClock();
    const qh = createQueueHarness({ clock: tickClock.clock, defaultMaxAttempts: 1, backoffBaseMs: 1000 });
    const evt = makeEvent(3);
    const job = await enqueueDelivery(qh, evt);

    await runWorkerPass(qh, { apply: applyEvent, killAfterDequeue: [0] });
    expect((await qh.queue.getById(job.id))!.status).toBe('active');

    // attempts exhausted (1/1) → real fail() moves the job to the DLQ.
    const { failed } = await superviseStaleActive(qh, [job.id], 0, 'worker_kill');
    expect(failed).toBe(1);
    const dlq = await qh.queue.getDlqJobs();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].errorMessage).toBe('worker_kill');

    // Replay (real seam) → new pending job → delivered → completed.
    await drainDlq(qh);
    const pass = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass.processed).toBe(1);
    expect(await qh.queue.getDlqJobs()).toHaveLength(0);

    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(1);
    expect(events.data[0].turn_index).toBe(3);
  });

  it('bounded-loss accounting: scripted kills + retries + DLQ/replay deliver N events exactly once', async () => {
    const tickClock = makeTickableClock();
    const qh = createQueueHarness({ clock: tickClock.clock, defaultMaxAttempts: 3, backoffBaseMs: 1000 });
    const events = [1, 2, 3, 4, 5].map((i) => makeEvent(i, `answer ${i}`));
    const jobIds: string[] = [];
    for (const evt of events) jobIds.push((await enqueueDelivery(qh, evt)).id);

    // Pass 1: kill indices 1 and 3 after dequeue; process the rest.
    let pass = await runWorkerPass(qh, { apply: applyEvent, killAfterDequeue: [1, 3] });
    expect(pass.killed).toBe(2);
    expect(pass.processed).toBe(3);

    // Supervisor fails the 2 stale jobs → retry (attempts 1 < max 3 → delayed).
    const { failed } = await superviseStaleActive(qh, jobIds, 0, 'worker_kill');
    expect(failed).toBe(2);
    tickClock.tick(65_000);

    // Pass 2: both retried jobs are redelivered; exactly one dies AFTER apply
    // (the redelivery order of equal-priority delayed jobs is not contractual,
    // so assert the invariant instead of a specific index).
    pass = await runWorkerPass(qh, { apply: applyEvent, killAfterApply: [0] });
    expect(pass.killed).toBe(1);
    expect(pass.processed).toBe(1);
    const activeAfter: string[] = [];
    for (const id of jobIds) {
      const st = await qh.queue.getById(id);
      if (st!.status === 'active') activeAfter.push(id);
    }
    expect(activeAfter).toHaveLength(1);

    // Final recovery: fail → retry → redeliver → dedup no-op → complete.
    await superviseStaleActive(qh, activeAfter, 0, 'worker_kill');
    tickClock.tick(65_000);
    pass = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass.processed).toBe(1);

    // Bounded loss: all 5 events durable exactly once, no duplicates, no DLQ.
    const stored = await getTranscriptEvents(sessionId);
    expect(stored.data).toHaveLength(5);
    expect(new Set(stored.data.map((e) => e.turn_index)).size).toBe(5);
    expect(stored.data.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const id of jobIds) {
      expect((await qh.queue.getById(id))!.status).toBe('completed');
    }
    expect(await qh.queue.getDlqJobs()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Queue failure (adapter boundary)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 queue failure injection', () => {
  function faultyHarness(opts?: { clock?: () => string }) {
    const inner = createQueueHarness(opts);
    const faulty = new FaultyQueueAdapter(inner.adapter);
    const queue = new Queue(faulty, opts?.clock ? { clock: opts.clock } : {});
    return { inner, faulty, queue };
  }

  it('enqueue failure: producer retries and the job is not lost', async () => {
    const { inner, faulty, queue } = faultyHarness();

    faulty.fault.enqueue = 1;
    await expect(enqueueDelivery({ adapter: faulty, queue }, makeEvent(1))).rejects.toThrow('simulated queue failure');

    // Retry after the transient failure → job persists.
    const job = await enqueueDelivery({ adapter: faulty, queue }, makeEvent(1));
    expect((await queue.getById(job.id))!.status).toBe('pending');

    await runWorkerPass({ adapter: faulty, queue }, { apply: applyEvent });
    expect((await queue.getById(job.id))!.status).toBe('completed');
    expect((await getTranscriptEvents(sessionId)).data).toHaveLength(1);
  });

  it('dequeue failure: worker pass errors but the job stays pending (no loss)', async () => {
    const { faulty, queue } = faultyHarness();

    const job = await enqueueDelivery({ adapter: faulty, queue }, makeEvent(2));
    faulty.fault.dequeue = 1;
    await expect(runWorkerPass({ adapter: faulty, queue }, { apply: applyEvent })).rejects.toThrow('simulated queue failure');
    expect((await queue.getById(job.id))!.status).toBe('pending'); // untouched

    await runWorkerPass({ adapter: faulty, queue }, { apply: applyEvent });
    expect((await queue.getById(job.id))!.status).toBe('completed');
  });

  it('complete failure: job stays active; supervisor fail → retry → deduped reprocess → complete', async () => {
    const tickClock = makeTickableClock();
    const { faulty, queue } = faultyHarness({ clock: tickClock.clock });

    const job = await enqueueDelivery({ adapter: faulty, queue }, makeEvent(3));
    faulty.fault.complete = 1;
    await expect(runWorkerPass({ adapter: faulty, queue }, { apply: applyEvent })).rejects.toThrow('simulated queue failure');
    // Event already durable, job stuck active.
    expect((await queue.getById(job.id))!.status).toBe('active');
    expect((await getTranscriptEvents(sessionId)).data).toHaveLength(1);

    await superviseStaleActive({ adapter: faulty, queue }, [job.id], 0, 'complete_failure');
    tickClock.tick(65_000);
    await runWorkerPass({ adapter: faulty, queue }, { apply: applyEvent });
    expect((await queue.getById(job.id))!.status).toBe('completed');
    expect((await getTranscriptEvents(sessionId)).data).toHaveLength(1); // still exactly once
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. DB failure (stable error codes + retry)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 DB failure injection', () => {
  it('transcript-event insert failure: worker fails the job, retry succeeds after DB recovery (no loss)', async () => {
    const tickClock = makeTickableClock();
    const qh = createQueueHarness({ clock: tickClock.clock, defaultMaxAttempts: 3 });
    const evt = makeEvent(1);
    const job = await enqueueDelivery(qh, evt);

    db.injectFault('upsert', 'transcript_events', 1);
    await expect(runWorkerPass(qh, { apply: applyEvent })).rejects.toThrow('ERR_EVENT_UPSERT_FAILED');
    expect((await qh.queue.getById(job.id))!.status).toBe('active');

    // Supervisor fails the job; DB has recovered.
    await superviseStaleActive(qh, [job.id], 0, 'db_failure');
    tickClock.tick(65_000);
    const pass = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass.processed).toBe(1);
    expect((await qh.queue.getById(job.id))!.status).toBe('completed');
    expect((await getTranscriptEvents(sessionId)).data).toHaveLength(1);
  });

  it('reconciliation rpc failure: detector degrades gracefully, no throw, report complete', async () => {
    const stuck = await seedSession(db, {
      id: sessionId, candidateId, status: 'in_progress', startedAt: isoAgo(2 * 60 * 60 * 1000),
    });
    expect(stuck.status).toBe('in_progress');

    db.injectFault('rpc', 'stuck_sessions', 1);
    const { report } = await runReconciliation(makeUuid(600), {
      waitingTimeoutMs: 0, createdTimeoutMs: 0, progressTimeoutMs: 0,
    });
    // stuck_sessions detector failed → issue missed this run (real degrade path).
    expect(report.total).toBe(0);
    expect(report.summary.stuck_session).toBe(0);
    expect(db.count('reconciliation_log')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Provider failure (REL-05/06 circuit breaker + timeout)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 provider failure injection (real runner + real breaker)', () => {
  it('breaker opens after the failure threshold, rejects circuit_open before spawning, half-open probe recovers', async () => {
    const harness = getClaudeHarness();
    const mc = makeMonotonicClock();
    let spawnCount = 0;
    const script = [
      { exitCode: 2 },
      { exitCode: 2 },
      () => { spawnCount += 1; return { stdout: '{"value":42}' }; }, // would succeed if spawned
    ];
    const { runner, breaker } = createScriptedRunner({
      real: harness.getReal(),
      script,
      failureThreshold: 2,
      cooldownMs: 1000,
      clock: mc.clock,
    });

    await expect(runner.runClaudeJSON('p1')).rejects.toMatchObject({ category: 'non_zero_exit' });
    expect(breaker.getState()).toBe('CLOSED');

    await expect(runner.runClaudeJSON('p2')).rejects.toMatchObject({ category: 'non_zero_exit' });
    expect(breaker.getState()).toBe('OPEN');

    // While OPEN (inside cooldown), the call is rejected WITHOUT spawning.
    await expect(runner.runClaudeJSON('p3')).rejects.toMatchObject({ category: 'circuit_open' });
    expect(spawnCount).toBe(0); // never reached the provider

    // After cooldown elapses the breaker half-opens; a success resets it.
    mc.advance(1000);
    const ok = await runner.runClaudeJSON('p4');
    expect(ok).toEqual({ value: 42 });
    expect(spawnCount).toBe(1);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('hung provider: deadline fires → ClaudeError(timeout) counted as provider failure', async () => {
    const harness = getClaudeHarness();
    const mc = makeMonotonicClock();
    const { runner, breaker } = createScriptedRunner({
      real: harness.getReal(),
      script: [{ hang: true }],
      failureThreshold: 3,
      cooldownMs: 1000,
      clock: mc.clock,
      timers: makeAutoTimeoutTimers(),
    });

    await expect(runner.runClaudeJSON('hang')).rejects.toMatchObject({ category: 'timeout' });
    expect(breaker.getFailureCount()).toBe(1); // timeout counts toward the breaker
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Network failure (outbox publish boundary, REL-02/03)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 network failure on outbox publish', () => {
  it('publish failure records failed status + last_error; supervisor re-publishes (no row lost)', async () => {
    for (const i of [1, 2, 3]) {
      const { error } = await upsertTranscriptEvent(sessionId, i, 'candidate', `t${i}`);
      expect(error).toBeNull();
    }
    const rows = db.rows('outbox');
    expect(rows).toHaveLength(3);
    const aggTarget = rows[0].aggregate_id as string;

    // First delivery pass: network unreachable for one aggregate.
    const first = await drainOutbox({ failAggregateIds: new Set([aggTarget]), failTimesPerRow: 1 });
    expect(first.published).toBe(2);
    expect(first.failed).toBe(1);

    const failedRow = db.findOne('outbox', (r) => r.aggregate_id === aggTarget)!;
    expect(failedRow.status).toBe('failed');
    expect(failedRow.last_error).toBe('network_unreachable');

    // Supervisor recovery: re-publish the failed row through the real seam.
    const { markOutboxEntry } = await import('../lib/outbox.js');
    await markOutboxEntry(failedRow.id as string, 'published');

    const { data: pending } = await countPendingOutbox();
    expect(pending).toBe(0);
    const all = db.rows('outbox');
    expect(all.filter((r) => r.status === 'published')).toHaveLength(3);
    // Durable event store unaffected by the network fault.
    expect((await getTranscriptEvents(sessionId)).data).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Duplicate / reordered events (0010 dedup + ordered replay)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 duplicate and reordered events', () => {
  it('queue-level duplicate (same dedupKey) returns the same job — no duplicate delivery', async () => {
    const qh = createQueueHarness();
    const evt = makeEvent(1);
    const j1 = await enqueueDelivery(qh, evt);
    const j2 = await enqueueDelivery(qh, evt); // same key
    expect(j2.id).toBe(j1.id);
    await runWorkerPass(qh, { apply: applyEvent });
    expect((await getTranscriptEvents(sessionId)).data).toHaveLength(1);
  });

  it('duplicate event delivery (distinct jobs, same turn): durable store dedups to one row', async () => {
    const qh = createQueueHarness();
    const evt = makeEvent(1);
    // Two producers deliver the same turn under different dedup keys.
    await enqueueDelivery(qh, evt, { dedupKey: 'producer-a' });
    await enqueueDelivery(qh, evt, { dedupKey: 'producer-b' });
    const pass = await runWorkerPass(qh, { apply: applyEvent });
    expect(pass.processed).toBe(2);

    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(1); // 0010 UNIQUE(session_id, turn_index)
    expect(events.data[0].turn_index).toBe(1);

    // Each delivery produced its own outbox row (at-least-once publish), but
    // the durable event row is unique.
    const outbox = db.rows('outbox');
    expect(outbox).toHaveLength(2);
    expect(new Set(outbox.map((r) => r.aggregate_id)).size).toBe(1);
  });

  it('reordered delivery: turns 1,3,2 land once each; ordered replay recovers canonical order', async () => {
    const qh = createQueueHarness();
    const events = [makeEvent(1, 'first'), makeEvent(3, 'third'), makeEvent(2, 'second')];
    for (const evt of events) await enqueueDelivery(qh, evt);
    await runWorkerPass(qh, { apply: applyEvent });

    const stored = await getTranscriptEvents(sessionId);
    expect(stored.data).toHaveLength(3);
    // Sequence reflects durable arrival order; strictly increasing per event.
    expect(stored.data.map((e) => e.sequence)).toEqual([1, 2, 3]);
    // Reassembling by turn_index recovers the canonical conversation order.
    const byTurn = [...stored.data].sort((a, b) => a.turn_index - b.turn_index);
    expect(byTurn.map((e) => e.text)).toEqual(['first', 'second', 'third']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Reconciliation (REL-09) + negative control
// ═══════════════════════════════════════════════════════════════════════

describe('TST-10 reconciliation and negative control', () => {
  const ZERO_TIMEOUTS = { waitingTimeoutMs: 0, createdTimeoutMs: 0, progressTimeoutMs: 0 };

  it('stuck in_progress session: reconcile detects + repairs via real CAS transition to expired', async () => {
    await seedSession(db, {
      id: sessionId, candidateId, status: 'in_progress', startedAt: isoAgo(2 * 60 * 60 * 1000),
    });

    const { report, repairs } = await runReconciliation(makeUuid(610), ZERO_TIMEOUTS);
    expect(report.summary.stuck_session).toBe(1);
    expect(repairs[0].plan.action).toBe('transition_to_expired');

    const session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('expired');
    expect(session.terminal_reason).toBe('idle_timeout');
    // Audited in reconciliation_log.
    expect(db.rows('reconciliation_log').filter((l) => l.session_id === sessionId).length).toBe(1);
  });

  it('orphan room (waiting, no worker): reconcile detects + expires the session', async () => {
    await seedSession(db, {
      id: sessionId, candidateId, status: 'waiting',
      waitingAt: isoAgo(10 * 60 * 1000), startedAt: isoAgo(10 * 60 * 1000),
    });

    const { report, repairs } = await runReconciliation(makeUuid(620), ZERO_TIMEOUTS);
    expect(report.summary.orphan_room).toBe(1);
    expect(repairs.some((r) => r.result.action === 'transition_to_expired')).toBe(true);

    const session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('expired');
  });

  it('transcript gap (completed with zero turns): reconcile quarantines for human review', async () => {
    await seedSession(db, {
      id: sessionId, candidateId, status: 'completed',
      endedAt: isoAgo(60 * 1000), startedAt: isoAgo(10 * 60 * 1000),
    });
    // Worker died before writing any turns → no transcript_turns rows.

    const { report, repairs } = await runReconciliation(makeUuid(630), ZERO_TIMEOUTS);
    expect(report.summary.transcript_gap).toBe(1);
    expect(repairs.some((r) => r.result.action === 'quarantine_session')).toBe(true);

    const quarantined = db.findOne('quarantined_sessions', (r) => r.session_id === sessionId);
    expect(quarantined).not.toBeNull();
    const details = quarantined!.details as Record<string, unknown>;
    expect(details.issue_category).toBe('transcript_gap');
    expect(quarantined!.reason).toContain('zero transcript turns');
  });

  it('reconciliation is idempotent: re-running after repair produces no new mutations', async () => {
    await seedSession(db, {
      id: sessionId, candidateId, status: 'in_progress', startedAt: isoAgo(2 * 60 * 60 * 1000),
    });

    const first = await runReconciliation(makeUuid(640), ZERO_TIMEOUTS);
    expect(first.report.total).toBeGreaterThan(0);
    expect(db.findOne('call_sessions', (r) => r.id === sessionId)!.status).toBe('expired');
    const logAfterFirst = db.rows('reconciliation_log').length;

    const second = await runReconciliation(makeUuid(641), ZERO_TIMEOUTS);
    expect(second.report.total).toBe(0); // no longer stuck
    expect(db.rows('reconciliation_log').length).toBe(logAfterFirst); // no duplicate audit rows
    expect(db.findOne('call_sessions', (r) => r.id === sessionId)!.status).toBe('expired');
  });

  it('NEGATIVE CONTROL — reconciliation disabled: stuck session is NOT recovered and no mutation occurs', async () => {
    await seedSession(db, {
      id: sessionId, candidateId, status: 'waiting',
      waitingAt: isoAgo(10 * 60 * 1000), startedAt: isoAgo(10 * 60 * 1000),
    });

    // Reconciliation is DISABLED: nothing runs the real reconcile()/executeRepair().
    const session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('waiting'); // still stuck — no recovery mechanism ran

    // No audit/quarantine side effects were produced by the disabled path.
    expect(db.count('reconciliation_log')).toBe(0);
    expect(db.count('quarantined_sessions')).toBe(0);
    expect(session.terminal_reason).toBeNull();

    // The exact same scenario WITH reconciliation enabled recovers (positive
    // evidence that the real reconciler is the sole recovery mechanism).
    const { report } = await runReconciliation(makeUuid(650), ZERO_TIMEOUTS);
    expect(report.summary.orphan_room).toBe(1);
    expect(db.findOne('call_sessions', (r) => r.id === sessionId)!.status).toBe('expired');
  });

  it('session lifecycle CAS still rejects cross-state transitions under fault (stable codes)', async () => {
    // Invalid transition is rejected before any DB access.
    const result = await transitionSession(sessionId, 'created', 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ERR_INVALID_TRANSITION');

    // DB failure during CAS update maps to the stable ERR_DB_FAILED code.
    const seeded = await seedSession(db, { id: sessionId, candidateId, status: 'in_progress' });
    expect(seeded.status).toBe('in_progress');
    db.injectFault('update', 'call_sessions', 1);
    const failed = await transitionSession(sessionId, 'in_progress', 'completed', 'conversation_complete');
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.conflict).toBe(false);
      expect(failed.code).toBe('ERR_DB_FAILED');
    }
  });
});
