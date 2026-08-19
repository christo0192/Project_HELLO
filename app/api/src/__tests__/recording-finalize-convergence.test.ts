/**
 * 0038 — durable authoritative-recording finalization convergence.
 *
 * THE DEFECT THESE COVER
 * ----------------------
 * `finalizeAuthoritativeRecording` had exactly two production callers: the
 * candidate browser's completion call and a recruiter pressing play. But THREE
 * code paths write `status = 'completed'`, and the primary voice path — the
 * Python worker — is not one of the callers. A session completed by the worker
 * had NO actor to finalize it and froze at `recording_egress_status = 'active'`
 * with a NULL object key, permanently. There was no webhook receiver, no
 * sweeper, no cron, and no health signal anywhere in the deployment.
 *
 * Everything here drives the REAL composition — the real `Queue`, the real
 * `createQueueRunner`, the real handler, the real sweeper — over the in-memory
 * queue adapter and a PostgREST-shaped in-memory database. No network, no
 * timers, no Docker.
 */

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import { createRecordingRuntime } from '../lib/recording/runtime.js';
import { createRecordingFinalizeHandler, deferDelaySeconds, sessionIdFromPayload } from '../lib/recording/finalize-worker.js';
import { runRecordingSweep } from '../lib/recording/sweeper.js';
import { createHaltReader } from '../lib/recording/halt.js';
import {
  RECORDING_FINALIZE_QUEUE,
  recordingFinalizeDedupKey,
  TERMINAL_SESSION_STATUSES,
  drainCapacityPerSweep,
  effectiveSweepAdmission,
  type RecordingRuntimeConfig,
} from '../lib/recording/config.js';
import { readRecordingBacklog } from '../lib/recording/health.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const NOW = '2026-08-19T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const ago = (sec: number): string => new Date(nowMs - sec * 1000).toISOString();

/** A minimal PostgREST-shaped in-memory client covering exactly what we call. */
function makeDb(tables: Record<string, Row[]>, rpc?: (name: string, args: Row) => unknown) {
  const rpcSpy = vi.fn(async (name: string, args: Row) => ({
    data: rpc ? rpc(name, args) : null,
    error: null,
  }));
  let failReads = false;

  function query(rows: Row[], head: boolean) {
    const preds: Array<(r: Row) => boolean> = [];
    let orderKey: string | null = null;
    let ascending = true;
    let lim = Infinity;

    const settle = () => {
      if (failReads) return { data: null, count: null, error: { message: 'db down' } };
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (orderKey) {
        const k = orderKey;
        out = [...out].sort((a, b) => {
          const av = String(a[k] ?? '');
          const bv = String(b[k] ?? '');
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      const count = out.length;
      if (lim !== Infinity) out = out.slice(0, lim);
      return { data: head ? null : out, count, error: null };
    };

    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return chain; },
      in: (c: string, v: unknown[]) => { preds.push((r) => v.includes(r[c])); return chain; },
      is: (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return chain; },
      not: (c: string, op: string, v: unknown) => {
        preds.push((r) => (op === 'is' && v === null ? (r[c] ?? null) !== null : true));
        return chain;
      },
      gt: (c: string, v: string) => { preds.push((r) => String(r[c] ?? '') > v); return chain; },
      lt: (c: string, v: string) => { preds.push((r) => String(r[c] ?? '') < v); return chain; },
      order: (c: string, o: { ascending?: boolean }) => {
        orderKey = c; ascending = o?.ascending !== false; return chain;
      },
      limit: (n: number) => { lim = n; return chain; },
      maybeSingle: async () => {
        const r = settle();
        return { data: r.error ? null : ((r.data as Row[] | null)?.[0] ?? null), error: r.error };
      },
      single: async () => {
        const r = settle();
        return { data: r.error ? null : ((r.data as Row[] | null)?.[0] ?? null), error: r.error };
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return chain;
  }

  return {
    client: {
      from: (table: string) => ({
        select: (_cols: string, opts?: { head?: boolean }) =>
          query(tables[table] ?? (tables[table] = []), opts?.head === true),
      }),
      rpc: rpcSpy,
    } as never,
    rpcSpy,
    breakReads: () => { failReads = true; },
  };
}

/**
 * A deterministic synthetic session UUID. The handler REFUSES a payload whose
 * session id is not a UUID (a job we cannot address belongs in the DLQ, not in
 * a retry loop), so fixtures must be real UUIDs.
 */
function sid(label: string): string {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000001`;
}

/** The exact stuck shape: terminal, egress linked, no key, still 'active'. */
function stuckSession(id: string, over: Row = {}): Row {
  return {
    id: sid(id),
    status: 'completed',
    ended_at: ago(600),
    recording_egress_id: 'EG_synthetic123',
    recording_object_key: null,
    recording_egress_status: 'active',
    recording_finalize_exhausted_at: null,
    recording_finalize_attempts: 0,
    recording_finalize_defer_reason: null,
    recording_deleted_at: null,
    recording_revoked_at: null,
    recording_quarantined: false,
    ...over,
  };
}

function makeQueue(start = NOW) {
  let current = start;
  const clock = (): string => current;
  const queue = new Queue(new MemoryAdapter({ clock }), { clock, defaultMaxAttempts: 5 });
  return { queue, setNow: (iso: string) => { current = iso; }, clock };
}

const baseConfig: RecordingRuntimeConfig = {
  enabled: true,
  graceSec: 60,
  maxAttempts: 5,
  concurrency: 4,
  sweepAdmission: 20,
  sweepMaxAgeSec: 604_800,
  pollMs: 60_000,
  sweepMs: 300_000,
  reclaimMs: 60_000,
  reclaimLimit: 25,
  leaseSeconds: 180,
  haltTtlMs: 5_000,
  reapMs: 900_000,
  reapAgeSec: 604_800,
  reapLimit: 500,
};

const noHalt = { read: async () => ({ halted: false, reason: null, since: null, degraded: false }), admits: async () => true, invalidate: () => {} };

async function until(pred: () => boolean, turns = 2000): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The worker converges the exact stuck shape
// ═══════════════════════════════════════════════════════════════════════

describe('convergence: the actor that did not exist', () => {
  it('converges a worker-completed session end to end, browser call never made', async () => {
    const { queue } = makeQueue();
    const { client } = makeDb({ call_sessions: [stuckSession('s1')] });
    const finalized: string[] = [];

    const runtime = createRecordingRuntime({
      client, queue, config: baseConfig,
      configured: () => true,
      finalize: async (id) => { finalized.push(id); return 'ready'; },
      // Never started; ticks are driven explicitly.
      scheduler: { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} },
    })!;
    expect(runtime).not.toBeNull();

    // The sweeper is the only producer here: NO browser call, NO trigger, just
    // a row that has been stuck since before this build existed.
    const sweep = await runRecordingSweep({
      client, queue, halt: noHalt, admission: 20, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    expect(sweep).toMatchObject({ scanned: 1, enqueued: 1, truncated: false, stop: 'ok' });

    await runtime.runner.tick();
    await until(() => runtime.runner.inFlight() === 0);
    await runtime.stop();

    expect(finalized).toEqual([sid('s1')]);
    // Exactly one job, and it completed — not deferred, not failed, not DLQ'd.
    const jobs = await queue.getDlqJobs();
    expect(jobs).toHaveLength(0);
  });

  it('finalize runs exactly ONCE for one row even across repeated sweeps', async () => {
    const { queue } = makeQueue();
    const { client } = makeDb({ call_sessions: [stuckSession('s1')] });
    const finalized: string[] = [];
    const runtime = createRecordingRuntime({
      client, queue, config: baseConfig, configured: () => true,
      finalize: async (id) => { finalized.push(id); return 'ready'; },
      scheduler: { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} },
    })!;

    // Three sweeps before any drain: the dedup key must collapse them.
    for (let i = 0; i < 3; i++) {
      await runRecordingSweep({
        client, queue, halt: noHalt, admission: 20, graceSec: 60,
        maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
      });
    }
    await runtime.runner.tick();
    await until(() => runtime.runner.inFlight() === 0);
    await runtime.stop();

    expect(finalized).toEqual([sid('s1')]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Ashby independence — the regression that matters for the paused canary
// ═══════════════════════════════════════════════════════════════════════

describe('convergence is Ashby-INDEPENDENT', () => {
  it('no recording module imports anything from integrations/ashby', async () => {
    // A static assertion, because this is a structural property and a runtime
    // test can only prove it for the paths it happens to take. The deployment
    // this repair exists for has the Ashby runtime PAUSED.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'recording');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/ashby/i);
      }
      // And no Ashby environment variable is read anywhere in the subsystem.
      expect(src).not.toMatch(/ASHBY_/);
    }
    // The shared scheduler must be reachable WITHOUT the Ashby module.
    const shared = readFileSync(join(dir, '..', 'scheduler.ts'), 'utf8');
    // IMPORT specifiers only — the module header legitimately explains where it
    // moved from, and a prose mention is not a dependency.
    const sharedImports = [...shared.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of sharedImports) {
      expect(spec, `lib/scheduler.ts imports ${spec}`).not.toMatch(/ashby/i);
    }
  });

  it('converges with every Ashby gate closed and no Ashby runtime constructed', async () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('ASHBY_')) delete process.env[k];
    }
    try {
      const { createAshbyRuntime } = await import('../integrations/ashby/runtime.js');
      // Precondition: there is genuinely no Ashby runtime to lean on.
      expect(createAshbyRuntime({ supabase: {} as never })).toBeNull();

      const { queue } = makeQueue();
      const { client } = makeDb({ call_sessions: [stuckSession('s1')] });
      const finalized: string[] = [];
      const runtime = createRecordingRuntime({
        client, queue, config: baseConfig, configured: () => true,
        finalize: async (id) => { finalized.push(id); return 'ready'; },
        scheduler: { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} },
      })!;
      expect(runtime).not.toBeNull();

      await runRecordingSweep({
        client, queue, halt: noHalt, admission: 20, graceSec: 60,
        maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
      });
      await runtime.runner.tick();
      await until(() => runtime.runner.inFlight() === 0);
      await runtime.stop();
      expect(finalized).toEqual([sid('s1')]);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('is not constructed at all when the gate is closed', () => {
    expect(createRecordingRuntime({ config: { ...baseConfig, enabled: false } })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The sweeper never claims what it must not touch
// ═══════════════════════════════════════════════════════════════════════

describe('sweeper selection', () => {
  it('skips every row that is not the stuck shape', async () => {
    const { queue } = makeQueue();
    const { client } = makeDb({
      call_sessions: [
        stuckSession('keep'),
        stuckSession('skip-failed', { recording_egress_status: 'failed' }),
        stuckSession('skip-complete', { recording_egress_status: 'complete' }),
        stuckSession('skip-in-progress', { status: 'in_progress' }),
        stuckSession('skip-no-egress', { recording_egress_id: null }),
        stuckSession('skip-linked', { recording_object_key: 'x-egress.ogg' }),
        stuckSession('skip-deleted', { recording_deleted_at: ago(10) }),
        stuckSession('skip-revoked', { recording_revoked_at: ago(10) }),
        stuckSession('skip-quarantined', { recording_quarantined: true }),
        stuckSession('skip-exhausted', { recording_finalize_exhausted_at: ago(10) }),
        // Inside the grace window: the trigger has it, the sweep must not race it.
        stuckSession('skip-too-fresh', { ended_at: ago(5) }),
        // Beyond the max-age reach.
        stuckSession('skip-too-old', { ended_at: ago(30 * 24 * 3600) }),
      ],
    });

    const r = await runRecordingSweep({
      client, queue, halt: noHalt, admission: 50, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    expect(r.scanned).toBe(1);
    expect(r.enqueued).toBe(1);
    const job = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'w' });
    expect((job!.payload as Row).session_id).toBe(sid('keep'));
  });

  it('CLAIMS expired and cancelled sessions — not only completed ones', async () => {
    // B-2. `lib/reconciliation.ts` transitions a stale session to
    // 'expired'/'idle_timeout' — the existing repair for a candidate who
    // closed the tab, i.e. precisely the population with a live egress, a NULL
    // key, and nobody to finalize it. A trigger and index over `completed`
    // alone would never enqueue and never sweep them.
    expect([...TERMINAL_SESSION_STATUSES].sort())
      .toEqual(['cancelled', 'completed', 'expired', 'failed']);

    const { queue } = makeQueue();
    const { client } = makeDb({
      call_sessions: [
        stuckSession('expired-row', { status: 'expired' }),
        stuckSession('cancelled-row', { status: 'cancelled' }),
        stuckSession('failed-row', { status: 'failed' }),
      ],
    });
    const r = await runRecordingSweep({
      client, queue, halt: noHalt, admission: 50, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    expect(r.scanned).toBe(3);
    expect(r.enqueued).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Bounded admission, the drain invariant, and the halt flag
// ═══════════════════════════════════════════════════════════════════════

describe('bounds', () => {
  it('admission caps the pass at exactly the budget and LOGS the truncation', async () => {
    const { queue } = makeQueue();
    const rows = Array.from({ length: 500 }, (_, i) =>
      stuckSession(`s${String(i).padStart(4, '0')}`, { ended_at: ago(600 + i) }));
    const { client } = makeDb({ call_sessions: rows });

    const r = await runRecordingSweep({
      client, queue, halt: noHalt, admission: 20, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    expect(r.scanned).toBe(20);
    expect(r.enqueued).toBe(20);
    // A silent cap reads as "covered everything".
    expect(r.truncated).toBe(true);
  });

  it('the DRAIN INVARIANT holds at the shipped defaults', () => {
    // B-4: the three sweeper bounds all bound the PRODUCER. Nothing bounded
    // the consumer, and at the runner's default concurrency of 2 the sweeper
    // would enqueue 4 rows/min against a 2 rows/min drain — a backlog that
    // grows for as long as the sweep runs, invisibly.
    expect(drainCapacityPerSweep(baseConfig)).toBe(20);
    expect(baseConfig.sweepAdmission).toBeLessThanOrEqual(drainCapacityPerSweep(baseConfig));
    expect(effectiveSweepAdmission(baseConfig)).toEqual({ admission: 20, clamped: false });
  });

  it('an admission raised past the drain capacity is CLAMPED, not silently honoured', () => {
    const over = { ...baseConfig, sweepAdmission: 200 };
    expect(effectiveSweepAdmission(over)).toEqual({ admission: 20, clamped: true });
  });

  it('the halt flag freezes the SWEEP', async () => {
    const { queue } = makeQueue();
    const { client } = makeDb({ call_sessions: [stuckSession('s1')] });
    const halted = {
      read: async () => ({ halted: true, reason: 'operator_pause', since: NOW, degraded: false }),
      admits: async () => false,
      invalidate: () => {},
    };
    const r = await runRecordingSweep({
      client, queue, halt: halted, admission: 20, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    expect(r).toMatchObject({ scanned: 0, enqueued: 0, stop: 'halted' });
  });

  it('the halt flag freezes the CLAIM as well, so a backlog freezes at both ends', async () => {
    const { queue } = makeQueue();
    await queue.enqueue(RECORDING_FINALIZE_QUEUE, { session_id: 's1' },
      { dedupKey: recordingFinalizeDedupKey('s1') });
    let ran = false;
    const runner = createQueueRunner({
      queue,
      handlers: { [RECORDING_FINALIZE_QUEUE]: async () => { ran = true; } },
      owner: 'w', leaseSeconds: 30, pollMs: 10,
      shouldClaim: async () => false,
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    expect(ran).toBe(false);
    // The job is untouched: still pending, no attempt spent.
    const jobs = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 5, owner: 'x' });
    expect(jobs).not.toBeNull();
    expect(jobs!.attempts).toBe(1);
  });

  it('an unreadable halt flag FAILS OPEN rather than freezing the fleet', async () => {
    // B-3(d): `shouldClaim` treats a throw as do-not-claim, so a fail-closed
    // read would turn one transient DB error into a fleet-wide claim freeze —
    // while buying nothing, since the handler's own first act is a DB read
    // that would fail anyway.
    const { client, breakReads } = makeDb({ recording_finalize_control: [] });
    breakReads();
    const reader = createHaltReader({ client, ttlMs: 1_000 });
    const state = await reader.read();
    expect(state).toMatchObject({ halted: false, degraded: true });
    expect(await reader.admits()).toBe(true);
  });

  it('a halted flag read from the DB freezes admission', async () => {
    const { client } = makeDb({
      recording_finalize_control: [
        { control_key: 'default', sweep_halted_at: NOW, sweep_halt_reason: 'storage_incident' },
      ],
    });
    const reader = createHaltReader({ client, ttlMs: 1_000 });
    expect(await reader.admits()).toBe(false);
    expect(await reader.read()).toMatchObject({ halted: true, reason: 'storage_incident' });
  });

  it('the halt read is CACHED, because the admission gate runs on every poll', async () => {
    let reads = 0;
    const rows: Row[] = [{ control_key: 'default', sweep_halted_at: null, sweep_halt_reason: null }];
    const { client } = makeDb({
      get recording_finalize_control() { reads += 1; return rows; },
    } as never);
    const reader = createHaltReader({ client, ttlMs: 10_000, now: () => nowMs });
    await reader.admits();
    await reader.admits();
    await reader.admits();
    expect(reads).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Deferral is a THIRD outcome, and it terminates
// ═══════════════════════════════════════════════════════════════════════

describe('deferral semantics', () => {
  const jobFor = (id: string) => ({
    id: 'j1', name: RECORDING_FINALIZE_QUEUE, payload: { session_id: id },
    attempts: 1, maxAttempts: 5, createdAt: NOW,
  }) as never;

  const SESSION = '00000000-0000-4000-8000-000000000001';

  it("a 'pending' finalize returns a DEFER DIRECTIVE, never a throw", async () => {
    // PR#66's lesson, applied: a WAIT charged against a FAILURE budget
    // dead-letters a session whose only problem is that storage had not caught
    // up yet.
    const { client } = makeDb({
      call_sessions: [{
        id: SESSION,
        recording_finalize_attempts: 2,
        recording_finalize_defer_reason: 'object_unreadable',
        recording_finalize_exhausted_at: null,
      }],
    });
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client, configured: () => true,
      finalize: async () => 'pending',
      recordDeferral: async () => ({ attempts: 2, exhausted: false }),
    });
    const result = await handler(jobFor(SESSION));
    expect(result).toMatchObject({ outcome: 'defer', reasonCode: 'object_unreadable' });
  });

  it('a deferral does NOT consume the queue failure budget', async () => {
    const { queue } = makeQueue();
    const job = await queue.enqueue(RECORDING_FINALIZE_QUEUE, { session_id: SESSION },
      { dedupKey: recordingFinalizeDedupKey(SESSION), maxAttempts: 5 });
    const { client } = makeDb({
      call_sessions: [{ id: SESSION, recording_finalize_attempts: 1, recording_finalize_defer_reason: 'poll_timeout', recording_finalize_exhausted_at: null }],
    });
    const runner = createQueueRunner({
      queue,
      handlers: {
        [RECORDING_FINALIZE_QUEUE]: createRecordingFinalizeHandler({
          maxAttempts: 5, client, configured: () => true,
          finalize: async () => 'pending',
          recordDeferral: async () => ({ attempts: 1, exhausted: false }),
        }),
      },
      owner: 'w', leaseSeconds: 30, pollMs: 10,
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();

    const after = await queue.getById(job.id);
    // Net zero attempts: the claim charged one, the deferral refunded it.
    expect(after!.attempts).toBe(0);
    expect(after!.status).toBe('delayed');
    expect(after!.errorMessage).toBeUndefined();
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('EXHAUSTION ends the loop: the job completes and the terminus lives on the row', async () => {
    // Without a terminus a deferral is an unbounded poll against a row that
    // has already given up.
    const { client } = makeDb({
      call_sessions: [{
        id: SESSION,
        recording_finalize_attempts: 5,
        recording_finalize_defer_reason: 'object_unreadable',
        recording_finalize_exhausted_at: NOW,
      }],
    });
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client, configured: () => true,
      finalize: async () => 'pending',
      recordDeferral: async () => ({ attempts: 5, exhausted: true }),
    });
    // Undefined = complete the claim. The stuck state is durable on the session.
    expect(await handler(jobFor(SESSION))).toBeUndefined();
  });

  it('an exhausted row stops being selected by the sweeper', async () => {
    const { queue } = makeQueue();
    const { client } = makeDb({
      call_sessions: [stuckSession('done', { recording_finalize_exhausted_at: ago(1) })],
    });
    const r = await runRecordingSweep({
      client, queue, halt: noHalt, admission: 20, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    expect(r.scanned).toBe(0);
  });

  it('DISABLED egress defers — it must never dead-letter a legacy row', async () => {
    // With RECORDING_EGRESS_ENABLED=false but legacy rows still carrying an
    // egress id, the finalizer would construct an EgressClient against an
    // empty URL and THROW; five of those dead-letter a job whose only problem
    // is that the feature is switched off.
    const { client } = makeDb({ call_sessions: [{ id: SESSION }] });
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client,
      configured: () => false,
      finalize: async () => { throw new Error('must_not_be_called'); },
      recordDeferral: async () => ({ attempts: 1, exhausted: false }),
    });
    expect(await handler(jobFor(SESSION))).toMatchObject({
      outcome: 'defer', reasonCode: 'egress_disabled',
    });
  });

  it('a THROWN provider error defers (recorded), it does not fail the job', async () => {
    const { client } = makeDb({ call_sessions: [{ id: SESSION }] });
    const recorded: string[] = [];
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client, configured: () => true,
      finalize: async () => { throw new Error('provider boom'); },
      recordDeferral: async (_id, reason) => { recorded.push(reason); return { attempts: 1, exhausted: false }; },
    });
    expect(await handler(jobFor(SESSION))).toMatchObject({
      outcome: 'defer', reasonCode: 'provider_error',
    });
    expect(recorded).toEqual(['provider_error']);
  });

  it('a MALFORMED payload throws — a job we cannot address belongs in the DLQ', async () => {
    const { client } = makeDb({});
    const handler = createRecordingFinalizeHandler({ maxAttempts: 5, client, configured: () => true });
    await expect(handler({ id: 'j', name: RECORDING_FINALIZE_QUEUE, payload: { session_id: 'not-a-uuid' } } as never))
      .rejects.toThrow('malformed_recording_finalize_payload');
    expect(sessionIdFromPayload({ session_id: 'nope' })).toBeNull();
    expect(sessionIdFromPayload({ session_id: SESSION })).toBe(SESSION);
  });

  it('the defer delay grows geometrically off the SESSION counter, not the job counter', () => {
    // `defer_job` REFUNDS the job's attempt, so `job_queue.attempts` is flat
    // across a hundred deferrals and cannot serve as an exponent.
    expect(deferDelaySeconds(1)).toBe(30);
    expect(deferDelaySeconds(2)).toBe(60);
    expect(deferDelaySeconds(3)).toBe(120);
    expect(deferDelaySeconds(null)).toBe(30);
    // Bounded — and well inside the queue's own 3600s clamp.
    expect(deferDelaySeconds(99)).toBe(900);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Concurrency: two runners, one row
// ═══════════════════════════════════════════════════════════════════════

describe('multi-machine safety', () => {
  it('two runners racing one row produce exactly ONE finalize', async () => {
    const { queue } = makeQueue();
    await queue.enqueue(RECORDING_FINALIZE_QUEUE, { session_id: '00000000-0000-4000-8000-000000000001' },
      { dedupKey: recordingFinalizeDedupKey('00000000-0000-4000-8000-000000000001'), maxAttempts: 5 });

    const { client } = makeDb({ call_sessions: [] });
    let calls = 0;
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client, configured: () => true,
      finalize: async () => { calls += 1; return 'ready'; },
    });
    const mk = (owner: string) => createQueueRunner({
      queue, handlers: { [RECORDING_FINALIZE_QUEUE]: handler },
      owner, leaseSeconds: 30, pollMs: 10,
    });
    const a = mk('m1');
    const b = mk('m2');
    await Promise.all([a.tick(), b.tick()]);
    await until(() => a.inFlight() === 0 && b.inFlight() === 0);
    await Promise.all([a.stop(), b.stop()]);

    // `claim` is FOR UPDATE SKIP LOCKED: only one runner can hold the lease.
    expect(calls).toBe(1);
  });

  it('a duplicate enqueue while a job is live returns the SAME job', async () => {
    const { queue } = makeQueue();
    const id = '00000000-0000-4000-8000-000000000009';
    const first = await queue.enqueue(RECORDING_FINALIZE_QUEUE, { session_id: id },
      { dedupKey: recordingFinalizeDedupKey(id) });
    const second = await queue.enqueue(RECORDING_FINALIZE_QUEUE, { session_id: id },
      { dedupKey: recordingFinalizeDedupKey(id) });
    expect(second.id).toBe(first.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. B-1 — the reclaim loop. Without it, the SAME defect one level up.
// ═══════════════════════════════════════════════════════════════════════

describe('reclaim: a crashed finalize must not strand the session forever', () => {
  it('a job left ACTIVE with an expired lease blocks re-enqueue until reclaimed', async () => {
    const { queue, setNow } = makeQueue();
    const { client } = makeDb({ call_sessions: [stuckSession('s1')] });

    // The sweeper enqueues, a machine claims, and then that machine dies.
    await runRecordingSweep({
      client, queue, halt: noHalt, admission: 20, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs,
    });
    const claimed = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'dead-machine' });
    expect(claimed).not.toBeNull();

    // Lease expires; nobody committed anything.
    setNow(new Date(nowMs + 120_000).toISOString());

    // `uq_job_queue_dedup_active` covers ACTIVE, so the sweeper's dedup-keyed
    // enqueue is a silent no-op and NOTHING would ever re-drive this session.
    const again = await runRecordingSweep({
      client, queue, halt: noHalt, admission: 20, graceSec: 60,
      maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs + 120_000,
    });
    expect(again.enqueued).toBe(1); // enqueue "succeeded" — by returning the stuck job
    expect(await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'live-machine' }))
      .toBeNull();

    // The reclaim loop is the ONLY recovery, and its sole production caller
    // was the ASHBY scheduler — which is paused on this deployment.
    const r = await queue.reclaimExpired({ limit: 25 });
    expect(r.requeued.length).toBe(1);

    const recovered = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'live-machine' });
    expect(recovered).not.toBeNull();
    expect((recovered!.payload as Row).session_id).toBe(sid('s1'));
  });

  it('the recording runtime owns a reclaim loop of its own', () => {
    const { queue } = makeQueue();
    const { client } = makeDb({ call_sessions: [] });
    const runtime = createRecordingRuntime({
      client, queue, config: baseConfig, configured: () => true,
      scheduler: { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} },
    })!;
    const names = runtime.scheduler.health().loops.map((l) => l.name).sort();
    expect(names).toEqual([
      'recording-finalize', 'recording-reap', 'recording-reclaim', 'recording-sweep',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. B-7 — terminal job_queue growth is bounded
// ═══════════════════════════════════════════════════════════════════════

describe('terminal job growth', () => {
  it('the REAP LOOP itself calls the bounded reaper with the configured window', async () => {
    // Driven through the real scheduler, not by calling the RPC by hand: the
    // thing worth asserting is that the loop is WIRED, since an unwired reaper
    // leaves the growth this section exists to bound.
    const { queue } = makeQueue();
    const calls: Array<{ name: string; args: Row }> = [];
    const { client } = makeDb({ call_sessions: [] }, (name, args) => {
      calls.push({ name, args });
      return { status: 'ok', deleted: 3, truncated: false };
    });

    // A timer seam that CAPTURES callbacks so we can fire exactly one round.
    let pending: Array<() => void> = [];
    const runtime = createRecordingRuntime({
      client, queue, config: baseConfig, configured: () => true,
      scheduler: {
        setTimer: (fn: () => void) => { pending.push(fn); return { unref: () => {} }; },
        clearTimer: () => {},
        random: () => 0,
      },
    })!;

    runtime.scheduler.start();
    const round = pending;
    pending = [];
    for (const fire of round) fire();
    // Let the ticks settle (each loop reschedules itself afterwards).
    await until(() => calls.some((c) => c.name === 'reap_completed_jobs'));
    await runtime.stop();

    const reap = calls.find((c) => c.name === 'reap_completed_jobs');
    expect(reap, 'the recording-reap loop never called the reaper').toBeDefined();
    expect(reap!.args).toMatchObject({
      p_older_than_seconds: baseConfig.reapAgeSec,
      p_limit: baseConfig.reapLimit,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. Health reports the DURABLE backlog, never a counter-derived zero
// ═══════════════════════════════════════════════════════════════════════

describe('health surface', () => {
  it('counts the stuck backlog, the exhausted terminus, and the QUEUE', async () => {
    const { client } = makeDb({
      call_sessions: [
        stuckSession('a', { ended_at: ago(7200) }),
        stuckSession('b'),
        stuckSession('gone', { recording_finalize_exhausted_at: ago(60) }),
        stuckSession('waiting', { recording_finalize_defer_reason: 'object_unreadable' }),
      ],
      job_queue: [
        { name: RECORDING_FINALIZE_QUEUE, status: 'pending', scheduled_at: ago(300) },
        { name: RECORDING_FINALIZE_QUEUE, status: 'delayed', scheduled_at: ago(60) },
        { name: 'ashby.signal', status: 'pending', scheduled_at: ago(9999) },
      ],
      job_dlq: [{ name: RECORDING_FINALIZE_QUEUE }],
    });

    const backlog = await readRecordingBacklog(client, nowMs);
    // 'gone' is excluded (exhausted); 'a', 'b' and 'waiting' are the stuck shape.
    expect(backlog.stuckCount).toBe(3);
    expect(backlog.oldestStuckAgeSec).toBe(7200);
    expect(backlog.exhaustedCount).toBe(1);
    // B-4: without the QUEUE numbers, "converging slowly" and "not converging"
    // are the same picture. The unrelated Ashby job must not be counted.
    expect(backlog.queueDepth).toBe(2);
    expect(backlog.oldestQueuedAgeSec).toBe(300);
    expect(backlog.dlqDepth).toBe(1);
    expect(backlog.deferredByReason.object_unreadable).toBe(1);
    expect(backlog.deferredByReason.poll_timeout).toBe(0);
  });

  it('N-1: exhausted_count means "still needs a human", not "ever exhausted"', async () => {
    // This count drives `degraded` at a threshold of 1, so without a
    // qualifying predicate it is a RATCHET: one historically exhausted row
    // pins the surface to degraded forever. Worse, a row that converged
    // through the recruiter play path could never clear it —
    // `reopen_recording_finalize` refuses an already-linked key. An alarm that
    // cannot be acknowledged trains operators to ignore it.
    const { client } = makeDb({
      call_sessions: [
        // Still genuinely stuck and exhausted — this is the only one that counts.
        stuckSession('needs-a-human', { recording_finalize_exhausted_at: ago(60) }),
        // Exhausted, then CONVERGED (recruiter pressed play). Not a problem.
        stuckSession('converged', {
          recording_finalize_exhausted_at: ago(600),
          recording_object_key: 'x-egress.ogg',
          recording_egress_status: 'complete',
        }),
        // Exhausted, then ERASED. Not a problem.
        stuckSession('erased', {
          recording_finalize_exhausted_at: ago(600),
          recording_deleted_at: ago(300),
        }),
        // Exhausted, then REVOKED. Not a problem.
        stuckSession('revoked', {
          recording_finalize_exhausted_at: ago(600),
          recording_revoked_at: ago(300),
        }),
      ],
    });

    const backlog = await readRecordingBacklog(client, nowMs);
    expect(backlog.exhaustedCount).toBe(1);
  });

  it('a failed backlog read THROWS rather than reporting a confident zero', async () => {
    // `lib/metrics.ts` is a no-op sink by default, so a counter-derived gauge
    // would report zero — the most dangerous possible answer for a subsystem
    // whose failure mode is silence. The caller turns this throw into
    // `degraded` + `backlog_unavailable`.
    const { client, breakReads } = makeDb({ call_sessions: [stuckSession('s1')] });
    breakReads();
    await expect(readRecordingBacklog(client, nowMs)).rejects.toThrow('recording_health_count_error');
  });
});
