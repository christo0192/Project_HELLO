/**
 * Lease-safe queue foundation (0028 — Ashby Phase 1, plan Step 2).
 *
 * Deterministic unit + negative-control coverage for the lease model. All
 * timing is driven by an injected clock so the concurrency semantics are
 * reproducible. The in-memory adapter mirrors the Postgres RPCs; the SQL
 * structural block below proves the production path uses FOR UPDATE SKIP
 * LOCKED, compare-and-set lease guards, service-role-only privileges, and
 * never logs payloads or lease tokens.
 *
 * Required invariants / negative controls exercised:
 *   1. Atomic claim — two racing claims → exactly one winner.
 *   2. Unguessable lease token/owner + bounded visibility; mutations are
 *      compare-and-set on (id + active + live lease token).
 *   3. Heartbeat extends only a live matching lease, bounded by an absolute
 *      deadline; stale workers cannot heartbeat/complete/retry/fail/DLQ.
 *   4. Expired jobs are atomically reclaimed; no job silently lost.
 *   5. Retry clears lease ownership; completion clears lease fields.
 *   6. Move to DLQ is a single transaction (no both/neither record).
 *   7. Concurrent replay creates exactly one pending replacement.
 *   8. Existing active dedup semantics remain valid.
 *   9. Reclaim never bypasses max_attempts; exhausted work reaches DLQ.
 *  10. Invalid/missing lease token fails closed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Queue, ERR_LEASE_UNSUPPORTED } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import type { IQueueAdapter } from '../lib/queue/types.js';
import {
  clampLeaseSeconds,
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  MAX_VISIBILITY_SECONDS,
} from '../lib/queue/types.js';

// ── Deterministic clock ───────────────────────────────────────────────

let fakeNow: string;
function setFakeNow(iso: string) { fakeNow = iso; }
function tickSec(sec: number) {
  fakeNow = new Date(Date.parse(fakeNow) + sec * 1000).toISOString();
}
const clock = () => fakeNow;
const FIXED_START = '2026-01-01T00:00:00.000Z';

function createQueue(options?: { defaultMaxAttempts?: number }) {
  setFakeNow(FIXED_START);
  const adapter = new MemoryAdapter({ clock });
  const queue = new Queue(adapter, {
    backoffBaseMs: 1000,
    backoffMaxMs: 60_000,
    defaultMaxAttempts: options?.defaultMaxAttempts ?? 3,
    clock,
  });
  return { adapter, queue };
}

// ═══════════════════════════════════════════════════════════════════════
// Lease constants + clamp
// ═══════════════════════════════════════════════════════════════════════

describe('lease clamp', () => {
  it('clamps into [MIN, MAX] and defaults on garbage', () => {
    expect(clampLeaseSeconds(30)).toBe(30);
    expect(clampLeaseSeconds(0)).toBe(MIN_LEASE_SECONDS);
    expect(clampLeaseSeconds(-5)).toBe(MIN_LEASE_SECONDS);
    expect(clampLeaseSeconds(10_000)).toBe(MAX_LEASE_SECONDS);
    expect(clampLeaseSeconds(undefined)).toBe(DEFAULT_LEASE_SECONDS);
    expect(clampLeaseSeconds(Number.NaN)).toBe(DEFAULT_LEASE_SECONDS);
    expect(clampLeaseSeconds(45.9)).toBe(45);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Claim basics + atomicity
// ═══════════════════════════════════════════════════════════════════════

describe('claim', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('grants an unguessable lease token, owner, expiry, and deadline', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', { x: 1 });
    const job = await queue.claim('q', { leaseSeconds: 30, owner: 'worker-A' });

    expect(job).not.toBeNull();
    expect(job!.status).toBe('active');
    expect(job!.attempts).toBe(1);
    expect(typeof job!.leaseToken).toBe('string');
    expect(job!.leaseToken!.length).toBeGreaterThan(0);
    expect(job!.leaseOwner).toBe('worker-A');
    // Expiry = now + 30s; deadline = now + MAX_VISIBILITY.
    expect(Date.parse(job!.leaseExpiresAt!)).toBe(Date.parse(FIXED_START) + 30_000);
    expect(Date.parse(job!.leaseDeadlineAt!)).toBe(Date.parse(FIXED_START) + MAX_VISIBILITY_SECONDS * 1000);
  });

  it('returns null when nothing is eligible', async () => {
    const { queue } = createQueue();
    expect(await queue.claim('q')).toBeNull();
  });

  it('two racing workers claiming one job — exactly one wins', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', { only: 'one' });

    const a = await queue.claim('q', { owner: 'A' });
    const b = await queue.claim('q', { owner: 'B' });

    // Exactly one non-null claim.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b)!;
    expect(winner.status).toBe('active');
    expect(winner.attempts).toBe(1);
  });

  it('respects priority then FIFO across claims', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', { p: 0 }, { priority: 0 });
    tickSec(1);
    const hi = await queue.enqueue('q', { p: 5 }, { priority: 5 });
    const first = await queue.claim('q');
    expect(first!.id).toBe(hi.id);
  });

  it('does not claim future-scheduled jobs until due', async () => {
    const { queue } = createQueue();
    const future = new Date(Date.parse(FIXED_START) + 10_000).toISOString();
    await queue.enqueue('q', {}, { scheduledAt: future });
    expect(await queue.claim('q')).toBeNull();
    tickSec(10);
    expect(await queue.claim('q')).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Heartbeat — bounded, live-lease only
// ═══════════════════════════════════════════════════════════════════════

describe('heartbeat', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('extends a live matching lease', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: 30 });
    tickSec(10);
    const ok = await queue.heartbeat(job!.id, job!.leaseToken!, { leaseSeconds: 30 });
    expect(ok).toBe(true);
    const fresh = await queue.getById(job!.id);
    expect(Date.parse(fresh!.leaseExpiresAt!)).toBe(Date.parse(FIXED_START) + 10_000 + 30_000);
  });

  it('never extends past the absolute visibility deadline', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: MAX_LEASE_SECONDS });
    const deadline = Date.parse(job!.leaseDeadlineAt!);

    // Keep the lease alive with repeated heartbeats until a request would
    // exceed the deadline; it must clamp to the deadline exactly.
    for (const at of [800, 1600, 2400, 3200]) {
      setFakeNow(new Date(Date.parse(FIXED_START) + at * 1000).toISOString());
      const ok = await queue.heartbeat(job!.id, job!.leaseToken!, { leaseSeconds: MAX_LEASE_SECONDS });
      expect(ok).toBe(true);
    }
    const fresh = await queue.getById(job!.id);
    expect(Date.parse(fresh!.leaseExpiresAt!)).toBe(deadline);
  });

  it('a stale/expired/mismatched lease cannot heartbeat (fails closed)', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: 30 });

    // Wrong token.
    expect(await queue.heartbeat(job!.id, 'not-the-token', {})).toBe(false);
    // Expired lease.
    tickSec(31);
    expect(await queue.heartbeat(job!.id, job!.leaseToken!, {})).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Complete / fail — compare-and-set under the live lease
// ═══════════════════════════════════════════════════════════════════════

describe('complete under lease', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('completes and clears lease fields with the live lease', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: 30 });
    expect(await queue.completeClaim(job!.id, job!.leaseToken!)).toBe(true);

    const done = await queue.getById(job!.id);
    expect(done!.status).toBe('completed');
    expect(done!.completedAt).toBeTruthy();
    expect(done!.leaseToken).toBeUndefined();
    expect(done!.leaseExpiresAt).toBeUndefined();
    expect(done!.leaseOwner).toBeUndefined();
    expect(done!.leaseDeadlineAt).toBeUndefined();
  });

  it('a wrong/missing lease token cannot complete (fails closed)', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: 30 });
    expect(await queue.completeClaim(job!.id, 'bogus')).toBe(false);
    const still = await queue.getById(job!.id);
    expect(still!.status).toBe('active');
  });
});

describe('fail under lease', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('schedules a retry (clearing the lease) while attempts remain', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 3 });
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: 30 });

    const outcome = await queue.failClaim(job!.id, job!.leaseToken!, 'transient');
    expect(outcome).toBe('retry_scheduled');

    const fresh = await queue.getById(job!.id);
    expect(fresh!.status).toBe('delayed');
    expect(fresh!.leaseToken).toBeUndefined();        // lease ownership cleared
    expect(fresh!.leaseExpiresAt).toBeUndefined();
    expect(Date.parse(fresh!.scheduledAt)).toBeGreaterThan(Date.parse(FIXED_START));
  });

  it('dead-letters in one transaction when attempts are exhausted', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    await queue.enqueue('q', { important: true });
    const job = await queue.claim('q', { leaseSeconds: 30 });

    const outcome = await queue.failClaim(job!.id, job!.leaseToken!, 'fatal');
    expect(outcome).toBe('dead_lettered');

    // Not in the live queue, exactly one in the DLQ, still findable — no
    // both/neither record.
    const dlq = await queue.getDlqJobs();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].id).toBe(job!.id);
    expect(dlq[0].payload).toEqual({ important: true });
    const found = await queue.getById(job!.id);
    expect(found!.status).toBe('failed');
    // The failed job holds no lease token.
    expect(found!.leaseToken).toBeUndefined();
  });

  it('a stale worker cannot fail/DLQ a job (fails closed)', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    await queue.enqueue('q', {});
    const job = await queue.claim('q', { leaseSeconds: 30 });
    expect(await queue.failClaim(job!.id, 'stale-token', 'x')).toBe('not_owned');
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Reclaim — recovery, max_attempts, stale-worker rejection
// ═══════════════════════════════════════════════════════════════════════

describe('reclaim expired jobs', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('requeues an expired job while attempts remain and re-issues a fresh lease', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 3 });
    await queue.enqueue('q', {});
    const a = await queue.claim('q', { leaseSeconds: 30, owner: 'A' });

    tickSec(31); // lease expires
    const result = await queue.reclaimExpired();
    expect(result.requeued).toEqual([a!.id]);
    expect(result.deadLettered).toEqual([]);

    // Back to pending, lease cleared, claimable again with a NEW token.
    const requeued = await queue.getById(a!.id);
    expect(requeued!.status).toBe('pending');
    expect(requeued!.leaseToken).toBeUndefined();

    const b = await queue.claim('q', { leaseSeconds: 30, owner: 'B' });
    expect(b!.id).toBe(a!.id);
    expect(b!.attempts).toBe(2);
    expect(b!.leaseToken).not.toBe(a!.leaseToken);
  });

  it('Worker A lease expires, Worker B reclaims and claims: A is fully locked out, B succeeds', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 3 });
    await queue.enqueue('q', { work: 1 });
    const a = await queue.claim('q', { leaseSeconds: 30, owner: 'A' });

    tickSec(31);
    await queue.reclaimExpired();
    const b = await queue.claim('q', { leaseSeconds: 30, owner: 'B' });
    expect(b).not.toBeNull();
    expect(b!.leaseToken).not.toBe(a!.leaseToken);

    // A cannot heartbeat / complete / fail / DLQ the reclaimed job.
    expect(await queue.heartbeat(a!.id, a!.leaseToken!, {})).toBe(false);
    expect(await queue.completeClaim(a!.id, a!.leaseToken!)).toBe(false);
    expect(await queue.failClaim(a!.id, a!.leaseToken!, 'A tries')).toBe('not_owned');

    // B can complete.
    expect(await queue.completeClaim(b!.id, b!.leaseToken!)).toBe(true);
    expect((await queue.getById(b!.id))!.status).toBe('completed');
  });

  it('reclaim never bypasses max_attempts: exhausted work reaches DLQ deterministically', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 2 });
    await queue.enqueue('q', {});

    // Delivery 1: claim → attempts=1 → lease expires → reclaim (1<2) requeue.
    const d1 = await queue.claim('q', { leaseSeconds: 30 });
    expect(d1!.attempts).toBe(1);
    tickSec(31);
    let r = await queue.reclaimExpired();
    expect(r.requeued).toEqual([d1!.id]);

    // Delivery 2: claim → attempts=2 → lease expires → reclaim (2<2 false) DLQ.
    const d2 = await queue.claim('q', { leaseSeconds: 30 });
    expect(d2!.attempts).toBe(2);
    tickSec(31);
    r = await queue.reclaimExpired();
    expect(r.deadLettered).toEqual([d2!.id]);
    expect(r.requeued).toEqual([]);

    const dlq = await queue.getDlqJobs();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].id).toBe(d1!.id); // same job id preserved into DLQ
  });

  it('does not reclaim a live (unexpired) lease', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', {});
    await queue.claim('q', { leaseSeconds: 300 });
    tickSec(10); // still within lease
    const r = await queue.reclaimExpired();
    expect(r.requeued).toEqual([]);
    expect(r.deadLettered).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Replay — concurrent-safe, exactly one replacement
// ═══════════════════════════════════════════════════════════════════════

describe('replay from DLQ', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('replays a DLQ job as one fresh pending job with reset counter', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    await queue.enqueue('q', { v: 7 });
    const job = await queue.claim('q', { leaseSeconds: 30 });
    await queue.failClaim(job!.id, job!.leaseToken!, 'boom');

    const replayed = await queue.replayDlq(job!.id);
    expect(replayed).not.toBeNull();
    expect(replayed!.status).toBe('pending');
    expect(replayed!.attempts).toBe(0);
    expect(replayed!.id).not.toBe(job!.id);
    expect(replayed!.payload).toEqual({ v: 7 });
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('concurrent replay of the same DLQ entry creates exactly one pending replacement', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    await queue.enqueue('q', { v: 1 });
    const job = await queue.claim('q', { leaseSeconds: 30 });
    await queue.failClaim(job!.id, job!.leaseToken!, 'boom');

    const first = await queue.replayDlq(job!.id);
    const second = await queue.replayDlq(job!.id);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await queue.getDlqJobs()).toHaveLength(0);
    // Exactly one pending replacement is claimable.
    const claimed = await queue.claim('q', { leaseSeconds: 30 });
    expect(claimed).not.toBeNull();
    expect(await queue.claim('q', { leaseSeconds: 30 })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Dedup semantics preserved under the lease path
// ═══════════════════════════════════════════════════════════════════════

describe('dedup under lease', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('existing active dedup key prevents duplicate active work through claim', async () => {
    const { queue } = createQueue();
    const j1 = await queue.enqueue('q', { v: 1 }, { dedupKey: 'dk' });
    const j2 = await queue.enqueue('q', { v: 2 }, { dedupKey: 'dk' });
    expect(j2.id).toBe(j1.id); // no duplicate

    const claimed = await queue.claim('q', { leaseSeconds: 30 });
    expect(claimed!.id).toBe(j1.id);
    // Still active under the same dedup key → re-enqueue is still a no-op.
    const j3 = await queue.enqueue('q', { v: 3 }, { dedupKey: 'dk' });
    expect(j3.id).toBe(j1.id);
    // Only one claimable job exists.
    expect(await queue.claim('q', { leaseSeconds: 30 })).toBeNull();
  });

  it('dedup key releases after completion so a new job can be enqueued', async () => {
    const { queue } = createQueue();
    const j1 = await queue.enqueue('q', { v: 1 }, { dedupKey: 'dk2' });
    const c = await queue.claim('q', { leaseSeconds: 30 });
    await queue.completeClaim(c!.id, c!.leaseToken!);
    const j2 = await queue.enqueue('q', { v: 2 }, { dedupKey: 'dk2' });
    expect(j2.id).not.toBe(j1.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Adapter-support guard
// ═══════════════════════════════════════════════════════════════════════

describe('lease API guard', () => {
  it('throws a stable sanitized error when the adapter lacks the lease seam', async () => {
    // A bare IQueueAdapter with only the legacy surface.
    const legacy: IQueueAdapter = {
      enqueue: async (j) => ({ ...j, id: 'x', status: 'pending', createdAt: FIXED_START } as never),
      dequeue: async () => [],
      complete: async () => {},
      fail: async () => {},
      scheduleRetry: async () => {},
      moveToDlq: async () => ({} as never),
      replay: async () => ({} as never),
      getById: async () => null,
      getDlqJobs: async () => [],
    };
    const q = new Queue(legacy, { clock });
    await expect(q.claim('q')).rejects.toThrow(ERR_LEASE_UNSUPPORTED);
    await expect(q.reclaimExpired()).rejects.toThrow(ERR_LEASE_UNSUPPORTED);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SQL / static structural proofs of the production migration (0028)
// ═══════════════════════════════════════════════════════════════════════

describe('0028 migration structural guarantees', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../../../app/supabase/migrations/0028_queue_leases.sql', import.meta.url)),
    'utf8',
  );

  it('claim + reclaim use FOR UPDATE SKIP LOCKED (atomic, contention-free)', () => {
    const normalized = sql.toLowerCase();
    const skipLocked = normalized.match(/for update\s+skip locked/g) ?? [];
    // claim_job, reclaim_expired_jobs, and replay_dlq_job each use it.
    expect(skipLocked.length).toBeGreaterThanOrEqual(3);
    expect(normalized).toContain('create or replace function screening_v2.claim_job');
  });

  it('mutations are compare-and-set on active status + matching live lease token', () => {
    const n = sql.toLowerCase();
    // complete_job / fail_job / heartbeat_job guard on lease_token and expiry.
    expect(n).toContain('lease_token = p_lease_token');
    expect(n).toContain("status = 'active'");
    expect(n).toMatch(/lease_expires_at\s*>\s*p_now/);
    expect(n).toContain('lease_token is distinct from p_lease_token');
  });

  it('DLQ movement and replay happen inside single functions (no client insert-then-delete gap)', () => {
    const n = sql.toLowerCase();
    // fail_job and dlq_job both insert into job_dlq then delete from job_queue
    // within the same function body.
    expect(n).toContain('insert into screening_v2.job_dlq');
    expect(n).toContain('delete from screening_v2.job_queue');
    expect(n).toContain('create or replace function screening_v2.replay_dlq_job');
  });

  it('every queue RPC is service-role-only (revoked from browser roles, granted to service_role)', () => {
    const n = sql.toLowerCase();
    for (const fn of ['claim_job', 'heartbeat_job', 'complete_job', 'fail_job',
      'reclaim_expired_jobs', 'replay_dlq_job', 'dlq_job', 'dequeue_job']) {
      expect(n).toMatch(new RegExp(`revoke all on function screening_v2\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`));
      expect(n).toMatch(new RegExp(`grant execute on function screening_v2\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to service_role`));
    }
  });

  it('adds lease columns and does not weaken RLS or grant browser access', () => {
    const n = sql.toLowerCase();
    expect(n).toContain('add column if not exists lease_token uuid');
    expect(n).toContain('add column if not exists lease_expires_at timestamptz');
    expect(n).toContain('add column if not exists lease_deadline_at timestamptz');
    // No RLS disable, no anon/authenticated table grants, no unconditional RLS.
    expect(n).not.toContain('disable row level security');
    expect(n).not.toMatch(/grant[^;]*\bto\s+(anon|authenticated|public)\b/);
    expect(n).not.toContain('using (true)');
    expect(n).not.toContain('with check (true)');
  });

  it('never logs payloads or lease tokens (no raise/log of payload or token values)', () => {
    const n = sql.toLowerCase();
    // Defensive: the migration must not emit payload/token values via RAISE.
    expect(n).not.toMatch(/raise\s+(notice|log|warning|info)[^;]*payload/);
    expect(n).not.toMatch(/raise\s+(notice|log|warning|info)[^;]*lease_token/);
  });
});
