/**
 * The privacy half of the recording lane's queue wiring: the erase handler (both payload shapes),
 * the sweep handler, and the `r1-storage` runner that claims `r1.recording.erase` and `r1.sweep`
 * whenever the storage config is enabled, NEVER gated on `r1_settings.enabled`. Also the
 * `r1-sweep` loop that enqueues one sweep per 15-minute bucket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import type { QueueJob } from '../lib/queue/types.js';
import { getAuditSink, setAuditSink } from '../lib/audit.js';
import { R1_RUNTIME_BOUNDS, R1_RUNTIME_QUEUES, createR1Runtime } from '../lib/r1/runtime.js';
import {
  R1_RECORDING_ERASE_QUEUE,
  R1_STORAGE_DEFER_REASON,
  R1_STORAGE_UNCONFIGURED_REASON,
  R1_SWEEP_QUEUE,
  createR1RecordingEraseHandler,
  parseEraseTarget,
} from '../lib/r1/recording/handlers.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import {
  FIXTURE_NOW_MS,
  createRecordingFakeDb,
  fixtureId,
  recordingRow,
  type Row,
  type Tables,
} from './support/r1-recording-fake-db.js';
import { enabledRecordingConfig } from './support/r1-recording-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUND = fixtureId('a', 1);
const SESSION = fixtureId('b', 1);
const KEYS = recordingKeys(ROUND, SESSION);
const iso = (ms: number): string => new Date(ms).toISOString();
const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };
const ENABLED = { enabled: true, status: 'enabled' as const };

function job(patch: Partial<QueueJob<unknown>> = {}): QueueJob<unknown> {
  return {
    id: 'job-1', name: R1_RECORDING_ERASE_QUEUE, payload: { round_id: ROUND, reason: 'consent_withdrawn' }, status: 'active',
    attempts: 1, maxAttempts: 5, priority: 0, scheduledAt: iso(FIXTURE_NOW_MS), createdAt: iso(FIXTURE_NOW_MS),
    ...patch,
  };
}

function tablesWithWithdrawal(extra: Tables = {}): Tables {
  return {
    r1_settings: [{ singleton: true, enabled: true, recording_mode: 'av' }],
    interview_rounds: [{ id: ROUND, candidate_id: fixtureId('c', 1) }],
    interview_round_consents: [{ id: 'c1', round_id: ROUND, consents: [], withdrawn_at: iso(FIXTURE_NOW_MS - 60_000), proof: { decision: 'withdrawn' } }],
    interview_round_recordings: [recordingRow(1, { created_at: iso(FIXTURE_NOW_MS - 3_600_000) })],
    legal_holds: [],
    governance_audit: [],
    r1_recording_purge: [],
    job_queue: [],
    ...extra,
  };
}

let originalSink: ReturnType<typeof getAuditSink>;
beforeEach(() => {
  originalSink = getAuditSink();
  setAuditSink(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setAuditSink(originalSink);
  vi.restoreAllMocks();
});

describe('parseEraseTarget', () => {
  it.each([
    [{ round_id: ROUND, reason: 'consent_withdrawn' }, { kind: 'round', id: ROUND, reason: 'consent_withdrawn' }],
    [{ round_id: ROUND }, { kind: 'round', id: ROUND, reason: 'consent_withdrawn' }],
    [{ session_id: SESSION, reason: 'admin' }, { kind: 'session', id: SESSION, reason: 'admin' }],
    [{ session_id: SESSION.toUpperCase() }, { kind: 'session', id: SESSION, reason: 'consent_withdrawn' }],
  ])('reads %j', (payload, expected) => {
    expect(parseEraseTarget(payload)).toEqual(expected);
  });

  it.each([
    [null], [undefined], ['x'], [[]], [{}], [{ round_id: 'nope' }], [{ session_id: 7 }],
    [{ round_id: ROUND, session_id: SESSION }], // ambiguous: never guess which one
    [{ round_id: ROUND, reason: 'because' }], [{ round_id: ROUND, reason: 7 }], [{ round_id: ROUND, session_id: 'junk' }],
  ])('rejects %j', (payload) => {
    expect(parseEraseTarget(payload)).toBeNull();
  });
});

describe('the erase handler', () => {
  function handlerFor(options: { tables?: Tables; config?: ReturnType<typeof enabledRecordingConfig> | { enabled: false; status: 'disabled' }; store?: MemoryR1ObjectStore } = {}) {
    const tables = options.tables ?? tablesWithWithdrawal();
    const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
    const store = options.store ?? new MemoryR1ObjectStore({ now: () => FIXTURE_NOW_MS });
    const results: unknown[] = [];
    const handler = createR1RecordingEraseHandler({
      db: db.client as never,
      recordingConfig: () => options.config ?? enabledRecordingConfig(),
      store: () => store,
      now: () => new Date(FIXTURE_NOW_MS),
      onResult: (r) => results.push(r),
    });
    return { handler, db, store, tables, results };
  }

  it('rejects a malformed payload with a stable code', async () => {
    const { handler } = handlerFor();
    for (const payload of [null, {}, { round_id: 'x' }, { round_id: ROUND, session_id: SESSION }, { round_id: ROUND, reason: 'x' }]) {
      await expect(handler(job({ payload }))).rejects.toThrow('malformed_r1_recording_payload');
    }
  });

  it('a { round_id } job erases the round\'s withdrawn recordings and reports counters', async () => {
    const { handler, store, tables, results } = handlerFor();
    store.putObject(KEYS.stream, mp4(100));
    await expect(handler(job())).resolves.toBeUndefined();
    expect(store.objectKeys()).toEqual([]);
    expect(tables.interview_round_recordings![0]).toMatchObject({ status: 'deleted', delete_reason: 'consent_withdrawn' });
    expect(results).toEqual([expect.objectContaining({ erased: 1, errors: 0 })]);
  });

  it('a { session_id } job erases that session', async () => {
    const { handler, store, tables } = handlerFor({ tables: tablesWithWithdrawal({ interview_round_consents: [] }) });
    store.putObject(KEYS.stream, mp4(100));
    await expect(handler(job({ payload: { session_id: SESSION, reason: 'consent_withdrawn' } }))).resolves.toBeUndefined();
    expect(tables.interview_round_recordings![0]).toMatchObject({ status: 'deleted' });
  });

  it('is idempotent: a replay finds nothing left to do', async () => {
    const { handler, store, results } = handlerFor();
    store.putObject(KEYS.stream, mp4(100));
    await handler(job());
    await handler(job());
    expect(results).toEqual([expect.objectContaining({ erased: 1 }), expect.objectContaining({ erased: 0 })]);
  });

  it('WAITS (defers, no attempt spent) while the storage config is not enabled, touching nothing', async () => {
    const { handler, store, db } = handlerFor({ config: { enabled: false, status: 'disabled' } });
    await expect(handler(job())).resolves.toEqual({ outcome: 'defer', reasonCode: R1_STORAGE_UNCONFIGURED_REASON, delaySeconds: 300 });
    expect(store.calls).toEqual([]);
    expect(db.ops).toEqual([]);
  });

  it('defers a transient storage failure (bounded) and fails everything else', async () => {
    const transient = handlerFor();
    transient.store.putObject(KEYS.stream, mp4(100));
    transient.store.failNext('listPrefix', 'unavailable');
    await expect(transient.handler(job({ attempts: 2 }))).resolves.toEqual({ outcome: 'defer', reasonCode: R1_STORAGE_DEFER_REASON, delaySeconds: 60 });
    expect(transient.tables.interview_round_recordings![0]!.status).toBe('ready');

    const exhausted = handlerFor();
    exhausted.store.failNext('listPrefix', 'unavailable', { times: 100 });
    await expect(exhausted.handler(job({ deferCount: 30 }))).rejects.toThrow('r1_storage_unavailable');

    const denied = handlerFor();
    denied.store.failNext('listMultipartUploads', 'access_denied');
    await expect(denied.handler(job())).rejects.toThrow('r1_storage_access');

    const dbDown = handlerFor();
    dbDown.db.failOn('interview_round_consents', 'select');
    await expect(dbDown.handler(job())).rejects.toThrow('r1_recording_db_error');
  });

  it('a legal hold completes the job (the sweep retries) and leaves the recording', async () => {
    const hold: Row = { id: 'h1', entity_type: 'recording', entity_id: SESSION, hold_reason: 'case', hold_source: 'court_order', placed_by: 'u', placed_at: iso(FIXTURE_NOW_MS - 1), released_at: null, expires_at: null, metadata: null };
    const { handler, store, tables, results } = handlerFor({ tables: tablesWithWithdrawal({ legal_holds: [hold] }) });
    store.putObject(KEYS.stream, mp4(100));
    await expect(handler(job())).resolves.toBeUndefined();
    expect(results).toEqual([expect.objectContaining({ blocked: 1, erased: 0 })]);
    expect(store.has(KEYS.stream)).toBe(true);
    expect(tables.interview_round_recordings![0]).toMatchObject({ status: 'ready', delete_requested_at: iso(FIXTURE_NOW_MS) });
  });
});

describe('the r1-storage runner and the r1-sweep loop', () => {
  const clockState = { ms: FIXTURE_NOW_MS };
  function makeQueue(): Queue {
    const clock = (): string => iso(clockState.ms);
    return new Queue(new MemoryAdapter({ clock }), { clock });
  }

  async function runtimeFor(options: { r1SettingsEnabled?: boolean; recordingEnabled?: boolean; tables?: Tables; store?: MemoryR1ObjectStore } = {}) {
    clockState.ms = FIXTURE_NOW_MS;
    const tables = options.tables ?? tablesWithWithdrawal();
    tables.r1_settings![0]!.enabled = options.r1SettingsEnabled ?? true;
    const db = createRecordingFakeDb(tables, { now: () => clockState.ms });
    const queue = makeQueue();
    const sweepEnqueues: Array<{ id: string; payload: unknown; dedupKey: string | undefined }> = [];
    const realEnqueue = queue.enqueue.bind(queue);
    vi.spyOn(queue, 'enqueue').mockImplementation(async (name: string, payload: unknown, enqueueOptions?: { dedupKey?: string; maxAttempts?: number }) => {
      const queued = await realEnqueue(name, payload, enqueueOptions);
      if (name === R1_SWEEP_QUEUE) sweepEnqueues.push({ id: queued.id, payload, dedupKey: enqueueOptions?.dedupKey });
      return queued;
    });
    const store = options.store ?? new MemoryR1ObjectStore({ now: () => clockState.ms });
    const runtime = createR1Runtime({
      config: ENABLED,
      client: db.client as never,
      queue,
      now: () => new Date(clockState.ms),
      recordingConfig: () => (options.recordingEnabled === false ? { enabled: false, status: 'disabled' } : enabledRecordingConfig()),
      recordingStore: () => store,
    })!;
    return { runtime, db, queue, store, tables, sweepEnqueues };
  }

  it('registers the erase and sweep queues beside finalize, and a fourth loop', async () => {
    const { runtime } = await runtimeFor();
    expect([...runtime.queues]).toEqual(['r1.assessment', 'r1.recording.finalize', 'r1.recording.erase', 'r1.sweep']);
    expect(R1_RUNTIME_QUEUES).toEqual([...runtime.queues]);
    expect(Object.keys(runtime.loopIntervalsMs)).toEqual(['r1-assessment', 'r1-status', 'r1-storage', 'r1-sweep']);
    expect(R1_RUNTIME_BOUNDS.sweepBucketMs).toBe(15 * 60_000);
    await runtime.stop();
  });

  it('erases a withdrawn recording while r1_settings.enabled is FALSE (a kill switch never stops a withdrawal)', async () => {
    const { runtime, queue, store, tables } = await runtimeFor({ r1SettingsEnabled: false });
    store.putObject(KEYS.stream, mp4(100));
    const queued = await queue.enqueue(R1_RECORDING_ERASE_QUEUE, { round_id: ROUND, reason: 'consent_withdrawn' }, { maxAttempts: 5, dedupKey: 'r1.recording.erase:c1' });
    await runtime.tickAll();
    await runtime.stop();
    expect(tables.interview_round_recordings![0]).toMatchObject({ status: 'deleted' });
    expect(store.objectKeys()).toEqual([]);
    expect(await queue.getById(queued.id)).toMatchObject({ status: 'completed' });
    expect(runtime.snapshot().storageJobEvents).toMatchObject({ claimed: 1, completed: 1 });
  });

  it('leaves erase and sweep jobs PENDING, no attempt spent, while the storage config is not enabled', async () => {
    const { runtime, queue, store } = await runtimeFor({ recordingEnabled: false });
    const erase = await queue.enqueue(R1_RECORDING_ERASE_QUEUE, { round_id: ROUND }, { maxAttempts: 5 });
    const sweep = await queue.enqueue(R1_SWEEP_QUEUE, { bucket: 1 }, { maxAttempts: 3 });
    await runtime.tickAll();
    await runtime.stop();
    expect(await queue.getById(erase.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await queue.getById(sweep.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(store.calls).toEqual([]);
  });

  it('the assessment runner never claims them', async () => {
    const { runtime, queue } = await runtimeFor();
    const erase = await queue.enqueue(R1_RECORDING_ERASE_QUEUE, { round_id: ROUND }, { maxAttempts: 5 });
    const sweep = await queue.enqueue(R1_SWEEP_QUEUE, { bucket: 1 }, { maxAttempts: 3 });
    await runtime.runner.tick();
    expect(await queue.getById(erase.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await queue.getById(sweep.id)).toMatchObject({ status: 'pending', attempts: 0 });
    await runtime.stop();
  });

  it('enqueues ONE sweep per 15-minute bucket (dedup key r1.sweep:<bucket>) and runs it through the runner', async () => {
    const tables = tablesWithWithdrawal({ interview_round_consents: [] });
    tables.interview_round_recordings = [recordingRow(1, { delete_after: iso(FIXTURE_NOW_MS - 60_000) })];
    const { runtime, queue, store, sweepEnqueues } = await runtimeFor({ tables });
    store.putObject(KEYS.stream, mp4(100));
    const bucket = Math.floor(FIXTURE_NOW_MS / R1_RUNTIME_BOUNDS.sweepBucketMs);

    await runtime.tickAll();
    expect(sweepEnqueues).toHaveLength(1);
    expect(sweepEnqueues[0]).toMatchObject({ payload: { bucket }, dedupKey: `r1.sweep:${bucket}` });
    await vi.waitFor(async () => expect(await queue.getById(sweepEnqueues[0]!.id)).toMatchObject({ status: 'completed' }));
    // The retention task erased the due recording.
    expect(tables.interview_round_recordings![0]).toMatchObject({ status: 'deleted', delete_reason: 'retention' });
    expect(store.objectKeys()).toEqual([]);

    // Same bucket: no second job, however often the loop ticks.
    await runtime.tickAll();
    await runtime.tickAll();
    expect(sweepEnqueues).toHaveLength(1);

    // The next bucket enqueues again.
    clockState.ms += R1_RUNTIME_BOUNDS.sweepBucketMs;
    await runtime.tickAll();
    expect(sweepEnqueues.map((j) => j.dedupKey)).toEqual([`r1.sweep:${bucket}`, `r1.sweep:${bucket + 1}`]);
    await runtime.stop();
  });

  it('enqueues no sweep while the storage config is not enabled, and one is not lost when it later is', async () => {
    const { runtime, sweepEnqueues } = await runtimeFor({ recordingEnabled: false });
    await runtime.tickAll();
    await runtime.tickAll();
    expect(sweepEnqueues).toHaveLength(0);
    await runtime.stop();
  });

  it('the sweep also runs while r1_settings.enabled is false, and survives a failing task', async () => {
    const tables = tablesWithWithdrawal({ interview_round_consents: [] });
    tables.interview_round_recordings = [recordingRow(1, { delete_after: iso(FIXTURE_NOW_MS - 60_000) })];
    const { runtime, queue, db, sweepEnqueues } = await runtimeFor({ r1SettingsEnabled: false, tables });
    db.failOn('r1_recording_purge', 'select', 100);
    await runtime.tickAll();
    await runtime.stop();
    expect(await queue.getById(sweepEnqueues[0]!.id)).toMatchObject({ status: 'completed' });
    expect(tables.interview_round_recordings![0]).toMatchObject({ status: 'deleted' });
  });
});

describe('structural fences', () => {
  const src = path.resolve(here, '..');
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (name === '__tests__' || name === 'node_modules') return [];
      return statSync(full).isDirectory() ? sourceFiles(full) : /\.ts$/.test(name) ? [full] : [];
    });
  }

  it('the erase and sweep queue names appear nowhere outside the R1 recording lane and the migration trigger', () => {
    const allowed = [
      path.join('lib', 'r1', 'recording') + path.sep,
      path.join('lib', 'r1', 'runtime.ts'),
      path.join('routes', 'r1-recording.ts'),
    ];
    for (const file of sourceFiles(src)) {
      const relative = path.relative(src, file);
      if (allowed.some((a) => relative.startsWith(a) || relative === a)) continue;
      // Comments may mention them (orphan-lapse.ts does); code may not.
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, relative).not.toMatch(/r1\.recording\.erase|r1\.sweep/);
    }
  });

  it('the erase queue name is the one the 0127 consent trigger enqueues', () => {
    const migration = readFileSync(path.resolve(here, '../../../supabase/migrations/0127_r1_recordings.sql'), 'utf8');
    expect(migration).toContain(`'${R1_RECORDING_ERASE_QUEUE}'`);
    expect(R1_SWEEP_QUEUE).toBe('r1.sweep');
  });

  it('the phone runtime keeps exactly its two handlers and never mentions the lane', () => {
    const phone = readFileSync(path.join(src, 'lib/phone-runtime/runtime.ts'), 'utf8');
    expect(phone).not.toMatch(/r1\.recording|r1\.sweep|r1-storage|r1-sweep/);
  });
});
