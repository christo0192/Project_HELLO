/**
 * M009 C9-2 (PR-C) — the attempt row of a worker-inband recording converges.
 *
 * Prod 9f43090e / 76b3793c (2026-09-30): the session was linked
 * (`recording_object_key`, `worker_inband`, egress `complete`) while the
 * owning attempt row stayed `recording_ready=false` forever, because
 *   - the session finalizer linked `call_sessions` only, and
 *   - every later finalize hit the already-linked early return.
 *
 * Covered here:
 *   1. recording-egress: the best-effort attempt link after the session-link
 *      CAS (winner AND loser), on both already-linked early returns, its
 *      guards, and failure isolation (the session result never changes);
 *   2. the sweeper's enqueue-only attempt-link pass: predicate, caps,
 *      truncation log, halt, dedup, read/enqueue isolation;
 *   3. sweep -> job -> finalize convergence for the prod shape;
 *   4. the `/recording/complete` diagnostic `attempt_finalize:<status>` log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { testEnv } = vi.hoisted(() => ({
  testEnv: {
    livekitUrl: 'wss://synthetic.livekit.invalid',
    livekitApiKey: 'synthetic-key',
    livekitApiSecret: 'synthetic-secret',
    recordingsBucket: 'recordings_v2',
    recordingEgressEnabled: true,
    recordingEgressRequired: false,
    recordingEgressS3Endpoint: 'https://synthetic.storage.invalid/s3',
    recordingEgressS3Region: 'ap-south-1',
    recordingEgressS3AccessKeyId: 'synthetic-access',
    recordingEgressS3SecretAccessKey: 'synthetic-secret',
    recordingEgressFinalizeTimeoutMs: 2_000,
    recordingMaxBytes: 25 * 1024 * 1024,
    recordingFinalizeMaxAttempts: 5,
  },
}));

vi.mock('../lib/env.js', () => ({ env: testEnv }));
vi.mock('../lib/supabase.js', () => ({ supabase: {} }));

import {
  finalizeAuthoritativeRecording,
  finalizeWorkerInbandRecording,
} from '../lib/recording-egress.js';
import { ATTEMPT_LINK_PASS_LIMIT, runRecordingSweep } from '../lib/recording/sweeper.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { RECORDING_FINALIZE_QUEUE, recordingFinalizeDedupKey } from '../lib/recording/config.js';
import { createRecordingFinalizeHandler } from '../lib/recording/finalize-worker.js';

const SESSION = '99999999-8888-4777-8666-555555555555';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ATTEMPT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const WORKER_EGRESS_ID = `EG_worker_${ATTEMPT}`;
const OBJECT_KEY = `phone-${ATTEMPT}-egress.mp3`;
const MANIFEST_KEY = `${OBJECT_KEY}.json`;
const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.from('verified worker mp3 payload')]);

type Row = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════════════
// 1. recording-egress — a table-aware fake
// ═══════════════════════════════════════════════════════════════════════

interface EgressFakeOpts {
  /** call_sessions `.single()` reads, in order. */
  sessionSingles: Row[];
  /** phone_call_attempts `.maybeSingle()` reads, in order (lookup, then attempt finalizer read, then reread). */
  attemptReads?: Array<{ data: Row | null; error?: { message: string } | null } | 'throw'>;
  /** call_sessions `.maybeSingle()` parent reads (attempt finalizer lifecycle checks). */
  parentRow?: Row | null;
  /** Rows the call_sessions update CAS returns (winner = one row, loser = []). */
  sessionUpdateRows?: Row[];
  /** Rows the phone_call_attempts update CAS returns. */
  attemptUpdateRows?: Row[];
  bytes?: Buffer;
  attemptDownloadThrows?: boolean;
}

function egressFake(opts: EgressFakeOpts) {
  const updates: Array<{ table: string; payload: Row }> = [];
  const selects: Array<{ table: string; cols: string }> = [];
  const downloads: string[] = [];
  const uploads: string[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: { attempts: 1, exhausted: false }, error: null });
  const attemptReads = [...(opts.attemptReads ?? [])];
  let objectDownloads = 0;

  const from = vi.fn((table: string) => {
    let operation = 'select';
    const chain: any = {
      select: vi.fn((cols: string) => { selects.push({ table, cols }); return chain; }),
      update: vi.fn((payload: Row) => { operation = 'update'; updates.push({ table, payload }); return chain; }),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      not: vi.fn(() => chain),
      or: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(async () => ({ data: opts.sessionSingles.shift() ?? null, error: null })),
      maybeSingle: vi.fn(async () => {
        if (table === 'phone_call_attempts') {
          const next = attemptReads.shift();
          if (next === 'throw') throw new Error('synthetic attempt read failure');
          return next ?? { data: null, error: null };
        }
        return { data: opts.parentRow ?? null, error: null };
      }),
      then: (resolve: (value: unknown) => void) => resolve(
        operation === 'update'
          ? {
            data: table === 'call_sessions'
              ? (opts.sessionUpdateRows ?? [{ id: SESSION }])
              : (opts.attemptUpdateRows ?? [{ id: ATTEMPT }]),
            error: null,
          }
          : { data: [], error: null },
      ),
    };
    return chain;
  });

  // `upsert:false` semantics: the first manifest write wins; a second writer
  // gets a conflict and must verify the stored bytes (the real path when the
  // session finalizer wrote the manifest before the attempt link runs).
  const stored = new Map<string, Buffer>();
  const storage = {
    from: vi.fn(() => ({
      upload: vi.fn(async (key: string, body: Buffer) => {
        uploads.push(key);
        if (stored.has(key)) return { data: null, error: { message: 'The resource already exists' } };
        stored.set(key, Buffer.from(body));
        return { data: { path: key }, error: null };
      }),
      download: vi.fn(async (key: string) => {
        downloads.push(key);
        if (key === MANIFEST_KEY) {
          const body = stored.get(key);
          return body
            ? { data: new Blob([new Uint8Array(body)]), error: null }
            : { data: null, error: { message: 'not found' } };
        }
        if (key === OBJECT_KEY) {
          objectDownloads += 1;
          if (opts.attemptDownloadThrows) throw new Error('synthetic storage outage');
        }
        return { data: new Blob([new Uint8Array(opts.bytes ?? AUDIO)]), error: null };
      }),
    })),
  };
  return {
    db: { from, rpc, storage } as any,
    updates,
    selects,
    downloads,
    uploads,
    rpc,
    objectDownloads: () => objectDownloads,
  };
}

const linkedSession = (over: Row = {}): Row => ({
  recording_object_key: OBJECT_KEY,
  recording_provenance: 'worker_inband',
  recording_egress_id: WORKER_EGRESS_ID,
  recording_egress_status: 'complete',
  recording_revoked_at: null,
  recording_quarantined: false,
  recording_deleted_at: null,
  mode: 'live',
  ...over,
});

const unlinkedSession = (over: Row = {}): Row => linkedSession({
  recording_object_key: null,
  recording_egress_status: 'active',
  ...over,
});

/** The attempt row as `finalizeWorkerInbandAttemptRecording` reads it. */
const attemptRow = (over: Row = {}): Row => ({
  session_id: SESSION,
  recording_session_id: SESSION,
  recording_object_key: OBJECT_KEY,
  recording_manifest_key: MANIFEST_KEY,
  recording_ready: false,
  recording_quarantined: false,
  recording_deleted_at: null,
  egress_id: WORKER_EGRESS_ID,
  egress_status: 'complete',
  ...over,
});

const okParent: Row = { recording_revoked_at: null, recording_quarantined: false, recording_deleted_at: null };

const attemptReadyWrite = (updates: Array<{ table: string; payload: Row }>) =>
  updates.filter((u) => u.table === 'phone_call_attempts' && u.payload.recording_ready === true);
const sessionWrites = (updates: Array<{ table: string; payload: Row }>) =>
  updates.filter((u) => u.table === 'call_sessions');

describe('C9-2 recording-egress: best-effort attempt link', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('WINNER: after the session-link CAS the owning attempt is linked to the same verified bytes', async () => {
    const { db, updates, uploads } = egressFake({
      sessionSingles: [unlinkedSession()],
      attemptReads: [
        { data: { id: ATTEMPT, recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY } },
        { data: attemptRow() },
      ],
      parentRow: okParent,
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    const sessionLink = sessionWrites(updates).find((u) => 'recording_object_key' in u.payload);
    expect(sessionLink?.payload.recording_provenance).toBe('worker_inband');
    const att = attemptReadyWrite(updates);
    expect(att).toHaveLength(1);
    expect(att[0].payload).toMatchObject({
      recording_ready: true,
      egress_status: 'complete',
      recording_sha256: createHash('sha256').update(AUDIO).digest('hex'),
      recording_size_bytes: AUDIO.length,
      recording_content_type: 'audio/mpeg',
    });
    // The session wrote the manifest; the attempt pass hit the upsert:false
    // conflict and VERIFIED the stored manifest instead of overwriting it.
    expect(uploads).toEqual([MANIFEST_KEY, MANIFEST_KEY]);
  });

  it('LOSER: a CAS that matched zero session rows still links the attempt, and the result is still ready', async () => {
    const { db, updates } = egressFake({
      sessionSingles: [unlinkedSession()],
      sessionUpdateRows: [],
      attemptReads: [
        { data: { id: ATTEMPT, recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY } },
        { data: attemptRow() },
      ],
      parentRow: okParent,
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(attemptReadyWrite(updates)).toHaveLength(1);
  });

  it('EARLY RETURN (worker branch): an already-linked session converges its unlinked attempt (the 9f43090e shape)', async () => {
    const { db, updates, downloads } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [
        { data: { id: ATTEMPT, recording_ready: false } },
        { data: attemptRow() },
      ],
      parentRow: okParent,
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(attemptReadyWrite(updates)).toHaveLength(1);
    // The session row is NOT rewritten: no status flip, no deferral clear.
    expect(sessionWrites(updates)).toHaveLength(0);
    expect(downloads).toEqual([OBJECT_KEY]);
  });

  it('EARLY RETURN (dispatcher): the queue/play re-finalize of a linked worker session links the attempt', async () => {
    const { db, updates } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [
        { data: { id: ATTEMPT, recording_ready: false } },
        { data: attemptRow() },
      ],
      parentRow: okParent,
    });
    const client = { startRoomCompositeEgress: vi.fn(), stopEgress: vi.fn(), listEgress: vi.fn() } as any;
    await expect(finalizeAuthoritativeRecording(SESSION, { db, client })).resolves.toBe('ready');
    expect(attemptReadyWrite(updates)).toHaveLength(1);
    expect(sessionWrites(updates)).toHaveLength(0);
    expect(client.stopEgress).not.toHaveBeenCalled();
    expect(client.listEgress).not.toHaveBeenCalled();
  });

  it('an attempt that is already ready is not re-downloaded or rewritten', async () => {
    const { db, updates, downloads } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [{ data: { id: ATTEMPT, recording_ready: true } }],
      parentRow: okParent,
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(downloads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('GUARD: a non-worker egress id never queries attempts from the early return', async () => {
    const { db, selects, updates } = egressFake({
      sessionSingles: [linkedSession({ recording_egress_id: 'EG_realegress123' })],
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(selects.some((s) => s.table === 'phone_call_attempts')).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('GUARD: an attempt bound to ANOTHER session is never marked ready', async () => {
    const { db, updates } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [
        { data: { id: ATTEMPT, recording_ready: false } },
        { data: attemptRow({ recording_session_id: '11111111-2222-4333-8444-555555555555' }) },
      ],
      parentRow: okParent,
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(updates).toHaveLength(0);
  });

  it('GUARD: a quarantined attempt, or a revoked parent, is never marked ready', async () => {
    for (const shape of [
      { attempt: attemptRow({ recording_quarantined: true }), parent: okParent },
      { attempt: attemptRow(), parent: { ...okParent, recording_revoked_at: '2026-09-30T00:00:00Z' } },
    ]) {
      const { db, updates } = egressFake({
        sessionSingles: [linkedSession()],
        attemptReads: [{ data: { id: ATTEMPT, recording_ready: false } }, { data: shape.attempt }],
        parentRow: shape.parent,
      });
      await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
      expect(updates).toHaveLength(0);
    }
  });

  it('ISOLATION: a throwing attempt read never changes the session result (early return)', async () => {
    const { db, rpc } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: ['throw'],
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    // No deferral was recorded against the session.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('ISOLATION: an attempt lookup error is logged and the session result is unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, updates } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [{ data: null, error: { message: 'db down' } }],
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(updates).toHaveLength(0);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('worker_attempt_link_failed'))).toBe(true);
    // Sanitised: no session id, attempt id or object key in the log line.
    for (const l of lines) {
      expect(l).not.toContain(SESSION);
      expect(l).not.toContain(ATTEMPT);
    }
  });

  it('ISOLATION: the attempt finalizer throwing after the session CAS still returns ready, with the session linked', async () => {
    const { db, updates, rpc } = egressFake({
      sessionSingles: [unlinkedSession()],
      attemptReads: [
        { data: { id: ATTEMPT, recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY } },
        'throw',
      ],
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(sessionWrites(updates).some((u) => u.payload.recording_object_key === OBJECT_KEY)).toBe(true);
    expect(attemptReadyWrite(updates)).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('ISOLATION: an attempt storage outage (pending) leaves the session ready and unlatched', async () => {
    const { db, updates, rpc } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [{ data: { id: ATTEMPT, recording_ready: false } }, { data: attemptRow() }],
      parentRow: okParent,
      attemptDownloadThrows: true,
    });
    await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('ready');
    expect(updates).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a session latch path is unchanged: oversize still latches failed and never links the attempt', async () => {
    testEnv.recordingMaxBytes = 8;
    try {
      const { db, updates } = egressFake({
        sessionSingles: [unlinkedSession()],
        attemptReads: [{ data: { id: ATTEMPT, recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY } }],
      });
      await expect(finalizeWorkerInbandRecording(SESSION, { db })).resolves.toBe('fallback_required');
      expect(sessionWrites(updates).map((u) => u.payload)).toEqual([{ recording_egress_status: 'failed' }]);
      expect(attemptReadyWrite(updates)).toHaveLength(0);
    } finally {
      testEnv.recordingMaxBytes = 25 * 1024 * 1024;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The sweeper's attempt-link pass — a predicate-evaluating PostgREST fake
// ═══════════════════════════════════════════════════════════════════════

const NOW = '2026-10-03T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const ago = (sec: number): string => new Date(nowMs - sec * 1000).toISOString();

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`);
}

function sweepDb(tables: Record<string, Row[]>, failTable?: string | ((table: string, nth: number) => boolean)) {
  const reads: string[] = [];
  function query(table: string) {
    const nth = reads.filter((t) => t === table).length - 1;
    const fails = typeof failTable === 'function' ? failTable(table, nth) : failTable === table;
    const rows = tables[table] ?? [];
    const preds: Array<(r: Row) => boolean> = [];
    let orderKey: string | null = null;
    let lim = Infinity;
    const settle = () => {
      if (fails) return { data: null, error: { message: 'db down' } };
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (orderKey) {
        const k = orderKey;
        out = [...out].sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? '')));
      }
      if (lim !== Infinity) out = out.slice(0, lim);
      return { data: out, error: null };
    };
    const chain: any = {
      eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return chain; },
      neq: (c: string, v: unknown) => { preds.push((r) => r[c] !== v && r[c] != null); return chain; },
      in: (c: string, v: unknown[]) => { preds.push((r) => v.includes(r[c])); return chain; },
      is: (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return chain; },
      not: (c: string, op: string, v: unknown) => {
        preds.push((r) => (op === 'is' && v === null ? (r[c] ?? null) !== null : true));
        return chain;
      },
      like: (c: string, p: string) => { const re = likeToRegex(p); preds.push((r) => typeof r[c] === 'string' && re.test(r[c] as string)); return chain; },
      or: (expr: string) => {
        const alts = expr.split(',').map((part) => {
          const [col, op, ...rest] = part.split('.');
          const val = rest.join('.');
          return (r: Row) => {
            if (op === 'is' && val === 'null') return (r[col] ?? null) === null;
            if (op === 'neq') return r[col] != null && String(r[col]) !== val;
            if (op === 'eq') return String(r[col]) === val;
            throw new Error(`unsupported or-op ${op}`);
          };
        });
        preds.push((r) => alts.some((a) => a(r)));
        return chain;
      },
      gt: (c: string, v: string) => { preds.push((r) => String(r[c] ?? '') > v); return chain; },
      lt: (c: string, v: string) => { preds.push((r) => String(r[c] ?? '') < v); return chain; },
      order: (c: string) => { orderKey = c; return chain; },
      limit: (n: number) => { lim = n; return chain; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return chain;
  }
  return {
    client: {
      from: (table: string) => ({
        select: (_cols: string) => { reads.push(table); return query(table); },
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as never,
    reads,
  };
}

/** The prod 9f43090e attempt shape (ids synthetic). */
function stuckAttempt(n: number, over: Row = {}): Row {
  const id = uuid(n);
  return {
    id,
    egress_id: `EG_worker_${id}`,
    recording_session_id: uuid(1000 + n),
    recording_object_key: `phone-${id}-egress.mp3`,
    recording_ready: false,
    recording_quarantined: false,
    recording_deleted_at: null,
    egress_status: 'complete',
    ended_at: ago(600 + n),
    ...over,
  };
}

/** Its already-linked session. */
function linkedSessionRow(n: number, over: Row = {}): Row {
  return {
    id: uuid(1000 + n),
    status: 'completed',
    ended_at: ago(600 + n),
    recording_egress_id: `EG_worker_${uuid(n)}`,
    recording_object_key: `phone-${uuid(n)}-egress.mp3`,
    recording_provenance: 'worker_inband',
    recording_egress_status: 'complete',
    recording_finalize_exhausted_at: null,
    recording_deleted_at: null,
    recording_revoked_at: null,
    recording_quarantined: false,
    ...over,
  };
}

function makeQueue() {
  const clock = (): string => NOW;
  return new Queue(new MemoryAdapter({ clock }), { clock, defaultMaxAttempts: 5 });
}

const noHalt = { read: async () => ({ halted: false, reason: null, since: null, degraded: false }), admits: async () => true, invalidate: () => {} };
const halted = { read: async () => ({ halted: true, reason: 'x', since: null, degraded: false }), admits: async () => false, invalidate: () => {} };

const sweepOpts = { admission: 20, graceSec: 60, maxAgeSec: 604_800, maxAttempts: 5, now: () => nowMs };

async function claimAll(queue: Queue): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const job = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'w' });
    if (!job) return out;
    out.push(String((job.payload as Row).session_id));
  }
}

describe('C9-2 sweeper: enqueue-only attempt-link pass', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('enqueues the SAME session finalize job (same dedup key) for the prod shape, leaving pass-1 fields untouched', async () => {
    const queue = makeQueue();
    const enqueue = vi.spyOn(queue, 'enqueue');
    const { client } = sweepDb({ phone_call_attempts: [stuckAttempt(1)], call_sessions: [linkedSessionRow(1)] });
    const r = await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    expect(r).toMatchObject({ scanned: 0, enqueued: 0, truncated: false, stop: 'ok' });
    expect(r.attemptLink).toEqual({ scanned: 1, enqueued: 1, truncated: false, stop: 'ok' });
    expect(enqueue).toHaveBeenCalledWith(
      RECORDING_FINALIZE_QUEUE,
      { session_id: uuid(1001) },
      { dedupKey: recordingFinalizeDedupKey(uuid(1001)), maxAttempts: 5 },
    );
    expect(await claimAll(queue)).toEqual([uuid(1001)]);
  });

  it('selects ONLY the stuck shape', async () => {
    const queue = makeQueue();
    const attempts = [
      stuckAttempt(1),
      stuckAttempt(2, { recording_ready: true }),
      stuckAttempt(3, { recording_quarantined: true }),
      stuckAttempt(4, { recording_deleted_at: ago(10) }),
      stuckAttempt(5, { recording_object_key: null }),
      stuckAttempt(6, { recording_session_id: null }),
      stuckAttempt(7, { egress_status: 'failed' }),
      stuckAttempt(8, { egress_id: 'EG_realegress123' }),
      // A worker id, but another attempt's: never ours to link.
      stuckAttempt(9, { egress_id: `EG_worker_${OTHER_ATTEMPT}` }),
      stuckAttempt(10, { ended_at: ago(5) }), // inside grace
      stuckAttempt(11, { ended_at: ago(30 * 24 * 3600) }), // beyond max age
      stuckAttempt(12), // session NOT linked -> pass 1's job
      stuckAttempt(13), // session stamped with another egress
      stuckAttempt(14), // session quarantined
      stuckAttempt(15), // session revoked
      stuckAttempt(16), // session deleted
      stuckAttempt(17), // session provenance not worker_inband
      stuckAttempt(18, { egress_status: null }), // NULL egress status is still eligible
    ];
    const sessions = [
      linkedSessionRow(1),
      ...[2, 3, 4, 5, 7, 8, 9, 10, 11].map((n) => linkedSessionRow(n)),
      linkedSessionRow(12, { recording_object_key: null, recording_egress_status: 'complete' }),
      linkedSessionRow(13, { recording_egress_id: `EG_worker_${OTHER_ATTEMPT}` }),
      linkedSessionRow(14, { recording_quarantined: true }),
      linkedSessionRow(15, { recording_revoked_at: ago(10) }),
      linkedSessionRow(16, { recording_deleted_at: ago(10) }),
      linkedSessionRow(17, { recording_provenance: 'livekit_egress' }),
      linkedSessionRow(18),
    ];
    const { client } = sweepDb({ phone_call_attempts: attempts, call_sessions: sessions });
    const r = await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    expect(r.attemptLink?.stop).toBe('ok');
    expect((await claimAll(queue)).sort()).toEqual([uuid(1001), uuid(1018)].sort());
  });

  it(`caps the read at ATTEMPT_LINK_PASS_LIMIT (${ATTEMPT_LINK_PASS_LIMIT}) and LOGS the truncation`, async () => {
    expect(ATTEMPT_LINK_PASS_LIMIT).toBe(10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queue = makeQueue();
    const n = 25;
    const attempts = Array.from({ length: n }, (_, i) => stuckAttempt(i + 1));
    const sessions = Array.from({ length: n }, (_, i) => linkedSessionRow(i + 1));
    const { client } = sweepDb({ phone_call_attempts: attempts, call_sessions: sessions });
    const r = await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    expect(r.attemptLink).toEqual({ scanned: 10, enqueued: 10, truncated: true, stop: 'ok' });
    expect(await claimAll(queue)).toHaveLength(10);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('recording_attempt_link_truncated'))).toBe(true);
  });

  it('is HALT-aware: a halted sweep reads no attempts and enqueues nothing', async () => {
    const queue = makeQueue();
    const { client, reads } = sweepDb({ phone_call_attempts: [stuckAttempt(1)], call_sessions: [linkedSessionRow(1)] });
    const r = await runRecordingSweep({ client, queue, halt: halted, ...sweepOpts });
    expect(r.stop).toBe('halted');
    expect(r.attemptLink).toBeUndefined();
    expect(reads).not.toContain('phone_call_attempts');
    expect(await claimAll(queue)).toEqual([]);
  });

  it('collapses two attempts on one session to one job, and repeated sweeps to one live job', async () => {
    const queue = makeQueue();
    const sessionId = uuid(1001);
    const second = stuckAttempt(2, { recording_session_id: sessionId });
    const { client } = sweepDb({
      phone_call_attempts: [stuckAttempt(1), second],
      call_sessions: [linkedSessionRow(1)],
    });
    for (let i = 0; i < 3; i++) await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    expect(await claimAll(queue)).toEqual([sessionId]);
  });

  it('an attempt read error is isolated: pass 1 still enqueues and the sweep stop stays ok', async () => {
    const queue = makeQueue();
    const stuckSession: Row = {
      id: uuid(77), status: 'completed', ended_at: ago(600), recording_egress_id: 'EG_x',
      recording_object_key: null, recording_egress_status: 'active', recording_finalize_exhausted_at: null,
      recording_deleted_at: null, recording_revoked_at: null, recording_quarantined: false,
    };
    const { client } = sweepDb({ phone_call_attempts: [stuckAttempt(1)], call_sessions: [stuckSession] }, 'phone_call_attempts');
    const r = await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    expect(r).toMatchObject({ scanned: 1, enqueued: 1, stop: 'ok' });
    expect(r.attemptLink).toEqual({ scanned: 0, enqueued: 0, truncated: false, stop: 'read_error' });
  });

  it('a session cross-check read error is isolated too', async () => {
    const queue = makeQueue();
    // Read #0 of call_sessions is pass 1; read #1 is the attempt pass cross-check.
    const { client } = sweepDb(
      { phone_call_attempts: [stuckAttempt(1)], call_sessions: [linkedSessionRow(1)] },
      (table, nth) => table === 'call_sessions' && nth === 1,
    );
    const r = await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    expect(r.stop).toBe('ok');
    expect(r.attemptLink).toEqual({ scanned: 0, enqueued: 0, truncated: false, stop: 'read_error' });
    expect(await claimAll(queue)).toEqual([]);
  });

  it('skips the attempt pass when pass 1 hit an enqueue error, and reports its own enqueue error', async () => {
    const stuckSession: Row = {
      id: uuid(77), status: 'completed', ended_at: ago(600), recording_egress_id: 'EG_x',
      recording_object_key: null, recording_egress_status: 'active', recording_finalize_exhausted_at: null,
      recording_deleted_at: null, recording_revoked_at: null, recording_quarantined: false,
    };
    const failing = { enqueue: vi.fn(async () => { throw new Error('queue down'); }) };
    const db1 = sweepDb({ phone_call_attempts: [stuckAttempt(1)], call_sessions: [stuckSession, linkedSessionRow(1)] });
    const r1 = await runRecordingSweep({ client: db1.client, queue: failing as never, halt: noHalt, ...sweepOpts });
    expect(r1.stop).toBe('enqueue_error');
    expect(r1.attemptLink?.stop).toBe('skipped');
    expect(db1.reads).not.toContain('phone_call_attempts');

    const db2 = sweepDb({ phone_call_attempts: [stuckAttempt(1)], call_sessions: [linkedSessionRow(1)] });
    const r2 = await runRecordingSweep({ client: db2.client, queue: failing as never, halt: noHalt, ...sweepOpts });
    expect(r2.stop).toBe('ok');
    expect(r2.attemptLink).toMatchObject({ enqueued: 0, stop: 'enqueue_error' });
  });

  it('logs no ids, keys or egress ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const queue = makeQueue();
    const attempts = Array.from({ length: 12 }, (_, i) => stuckAttempt(i + 1));
    const sessions = Array.from({ length: 12 }, (_, i) => linkedSessionRow(i + 1));
    const { client } = sweepDb({ phone_call_attempts: attempts, call_sessions: sessions });
    await runRecordingSweep({ client, queue, halt: noHalt, ...sweepOpts });
    const all = [...warn.mock.calls, ...err.mock.calls, ...out.mock.calls].map((c) => String(c[0])).join('\n');
    expect(all).not.toMatch(/EG_worker_/);
    expect(all).not.toMatch(/[0-9a-f]{8}-0000-4000-8000-000000000001/);
    out.mockRestore();
  });

  it('the module stays free of the provider SDK and the egress module (enqueue-only)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'recording', 'sweeper.ts'), 'utf8');
    expect(src).not.toMatch(/from '[^']*recording-egress/);
    expect(src).not.toMatch(/livekit/);
    expect(src).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(/);
    expect(src).not.toMatch(/finalizeAuthoritativeRecording|finalizeWorkerInband/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Sweep -> job -> finalize: the prod shape converges end to end
// ═══════════════════════════════════════════════════════════════════════

describe('C9-2 convergence: sweeper job links the stuck attempt through the real finalizer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('9f43090e shape: one sweep + one job run -> attempt recording_ready=true, session untouched', async () => {
    const queue = makeQueue();
    const sweepRows = sweepDb({
      phone_call_attempts: [stuckAttempt(1, { id: ATTEMPT, egress_id: WORKER_EGRESS_ID, recording_session_id: SESSION })],
      call_sessions: [linkedSessionRow(1, { id: SESSION, recording_egress_id: WORKER_EGRESS_ID, recording_object_key: OBJECT_KEY })],
    });
    const r = await runRecordingSweep({ client: sweepRows.client, queue, halt: noHalt, ...sweepOpts });
    expect(r.attemptLink?.enqueued).toBe(1);

    const { db, updates } = egressFake({
      sessionSingles: [linkedSession()],
      attemptReads: [{ data: { id: ATTEMPT, recording_ready: false } }, { data: attemptRow() }],
      parentRow: okParent,
    });
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5,
      configured: () => true,
      finalize: (id: string) => finalizeAuthoritativeRecording(id, { db }),
      client: sweepRows.client as never,
    } as never);
    const job = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'w' });
    expect(job).not.toBeNull();
    await expect(handler(job!)).resolves.toBeUndefined();
    expect(attemptReadyWrite(updates)).toHaveLength(1);
    expect(sessionWrites(updates)).toHaveLength(0);
  });
});
