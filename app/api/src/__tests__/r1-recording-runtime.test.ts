/**
 * The recording lane of the R1 runtime (R1-REC): the finalize handler, its deferral bounds, and the
 * second runner `r1-storage` that claims it. The claim gate is the storage config, NOT
 * `r1_settings.enabled`: a paused or disabled R1 must still finish a recording in flight, and the
 * jobs wait (no attempt spent) while the R2 secrets are not configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import type { QueueJob } from '../lib/queue/types.js';
import { getAuditSink, setAuditSink } from '../lib/audit.js';
import { createR1Runtime } from '../lib/r1/runtime.js';
import {
  R1_RECORDING_FINALIZE_QUEUE,
  R1_STORAGE_DEFER_MAX_COUNT,
  R1_STORAGE_DEFER_MAX_MS,
  R1_STORAGE_DEFER_REASON,
  R1_STORAGE_DEFER_SECONDS,
  R1_STORAGE_UNCONFIGURED_REASON,
  R1_STORAGE_UNCONFIGURED_SECONDS,
  createR1RecordingFinalizeHandler,
  storageDeferAllowed,
} from '../lib/r1/recording/handlers.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import { createRecordingFakeDb, ROOM_ROUND, ROOM_SESSION, liveRecordingTables } from './support/r1-recording-fake-db.js';
import { START_MS, enabledRecordingConfig } from './support/r1-recording-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYS = recordingKeys(ROOM_ROUND, ROOM_SESSION);

const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };
const NOW = (): Date => new Date(START_MS);

function makeQueue(): Queue {
  const clock = (): string => new Date(START_MS).toISOString();
  return new Queue(new MemoryAdapter({ clock }), { clock });
}

function finishingTables(extra: Record<string, unknown> = {}) {
  const tables = liveRecordingTables();
  tables.interview_round_recordings!.push({
    session_id: ROOM_SESSION, round_id: ROOM_ROUND, bucket: 'ik-r1-recordings', prefix: KEYS.prefix, requested_mode: 'av',
    status: 'finishing', layout: 'combined', has_video: true, upload_id: null, parts_issued: 2, urls_issued: 2,
    video_key: null, video_bytes: null, video_sha256: null, video_etag: null, video_content_type: null,
    audio_key: null, audio_bytes: null, audio_sha256: null, audio_etag: null,
    started_at_ms: null, duration_ms: null, width: null, height: null, fps: null, frames_encoded: null, frames_dropped: null,
    camera_off_ms: null, degraded_at_ms: null, reported_stream_bytes: null, reported_parts: null, degraded_reason: null, failure_reason: null,
    finalize_attempts: 0, created_at: new Date(START_MS - 600_000).toISOString(), updated_at: new Date(START_MS - 1000).toISOString(),
    finalize_requested_at: new Date(START_MS - 1000).toISOString(), finalized_at: null,
    delete_after: new Date(START_MS + 90 * 86_400_000).toISOString(), delete_requested_at: null, delete_reason: null, deleted_at: null,
    ...extra,
  });
  return tables;
}

function job(patch: Partial<QueueJob<unknown>> = {}): QueueJob<unknown> {
  return {
    id: 'job-1', name: R1_RECORDING_FINALIZE_QUEUE, payload: { session_id: ROOM_SESSION }, status: 'active',
    attempts: 1, maxAttempts: 5, priority: 0, scheduledAt: new Date(START_MS).toISOString(), createdAt: new Date(START_MS).toISOString(),
    ...patch,
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

describe('the finalize handler', () => {
  function handlerFor(options: { tables?: ReturnType<typeof finishingTables>; config?: ReturnType<typeof enabledRecordingConfig> | { enabled: false; status: 'disabled' }; store?: MemoryR1ObjectStore } = {}) {
    const tables = options.tables ?? finishingTables();
    const db = createRecordingFakeDb(tables);
    const store = options.store ?? new MemoryR1ObjectStore({ now: () => START_MS });
    const results: unknown[] = [];
    const handler = createR1RecordingFinalizeHandler({
      db: db.client as never,
      recordingConfig: () => options.config ?? enabledRecordingConfig(),
      store: () => store,
      enqueue: async () => undefined,
      now: NOW,
      onResult: (outcome) => results.push(outcome),
    });
    return { handler, db, store, results };
  }

  it('rejects a payload without a valid session_id with a stable code (and accepts an upper-case UUID)', async () => {
    const { handler } = handlerFor();
    for (const payload of [null, undefined, 'x', {}, { session_id: 7 }, { session_id: 'not-a-uuid' }, { session: ROOM_SESSION }]) {
      await expect(handler(job({ payload }))).rejects.toThrow('malformed_r1_recording_payload');
    }
    const upper = handlerFor();
    upper.store.putObject(KEYS.stream, mp4(2000), 'video/mp4');
    await expect(upper.handler(job({ payload: { session_id: ROOM_SESSION.toUpperCase() } }))).resolves.toBeUndefined();
    expect(upper.results).toEqual([{ kind: 'finalized', status: 'ready', layout: 'combined' }]);
  });

  it('finalizes and reports the outcome', async () => {
    const { handler, db, store, results } = handlerFor();
    store.putObject(KEYS.stream, mp4(3000), 'video/mp4');
    await expect(handler(job())).resolves.toBeUndefined();
    expect(results).toEqual([{ kind: 'finalized', status: 'ready', layout: 'combined' }]);
    expect(db.tables.interview_round_recordings![0]).toMatchObject({ status: 'ready', video_key: KEYS.stream });
  });

  it('a replay of an already finalized recording is a no-op success', async () => {
    const { handler, store, results } = handlerFor({ tables: finishingTables({ status: 'ready' }) });
    await expect(handler(job())).resolves.toBeUndefined();
    expect(results).toEqual([{ kind: 'skipped', reason: 'not_finishing' }]);
    expect(store.calls).toEqual([]);
  });

  it('WAITS (defers, no attempt spent) while the storage config is not enabled on this machine', async () => {
    const { handler, store, db } = handlerFor({ config: { enabled: false, status: 'disabled' } });
    await expect(handler(job())).resolves.toEqual({
      outcome: 'defer', reasonCode: R1_STORAGE_UNCONFIGURED_REASON, delaySeconds: R1_STORAGE_UNCONFIGURED_SECONDS,
    });
    expect(store.calls).toEqual([]);
    expect(db.ops).toEqual([]);
  });

  it('defers a transient object-store failure for a minute, with a sanitized reason', async () => {
    const { handler, store } = handlerFor();
    store.putObject(KEYS.stream, mp4(2000), 'video/mp4');
    store.failNext('head', 'unavailable');
    await expect(handler(job({ attempts: 3 }))).resolves.toEqual({
      outcome: 'defer', reasonCode: R1_STORAGE_DEFER_REASON, delaySeconds: R1_STORAGE_DEFER_SECONDS,
    });
    expect(R1_STORAGE_DEFER_REASON).toBe('r1_storage_unavailable');
    expect(R1_STORAGE_DEFER_SECONDS).toBe(60);
  });

  it('stops deferring after the streak bound or the total count, and then fails like any other error', async () => {
    const { handler, store } = handlerFor();
    store.putObject(KEYS.stream, mp4(2000), 'video/mp4');
    store.failNext('head', 'unavailable', { times: 10 });
    await expect(handler(job({ deferCount: R1_STORAGE_DEFER_MAX_COUNT - 1 }))).resolves.toMatchObject({ outcome: 'defer' });
    await expect(handler(job({ deferCount: R1_STORAGE_DEFER_MAX_COUNT }))).rejects.toThrow('r1_storage_unavailable');
    const justInside = new Date(START_MS - R1_STORAGE_DEFER_MAX_MS + 1000).toISOString();
    const tooOld = new Date(START_MS - R1_STORAGE_DEFER_MAX_MS - 1000).toISOString();
    await expect(handler(job({ deferCount: 3, deferredAt: justInside }))).resolves.toMatchObject({ outcome: 'defer' });
    await expect(handler(job({ deferCount: 3, deferredAt: tooOld }))).rejects.toThrow('r1_storage_unavailable');
    // A job that was never deferred (no columns) may defer.
    expect(storageDeferAllowed(job(), START_MS)).toBe(true);
    expect(storageDeferAllowed(job({ deferCount: 0, deferredAt: undefined }), START_MS)).toBe(true);
  });

  it('does NOT defer what waiting cannot fix: rejected credentials, a refused completion, a database error', async () => {
    const { handler, store, db } = handlerFor();
    store.putObject(KEYS.stream, mp4(2000), 'video/mp4');
    store.failNext('head', 'access_denied');
    await expect(handler(job())).rejects.toThrow('r1_storage_access');
    db.failOn('interview_round_recordings', 'select');
    await expect(handler(job())).rejects.toThrow('r1_recording_db_error');
  });
});

describe('the r1-storage runner of the R1 runtime', () => {
  const ENABLED = { enabled: true, status: 'enabled' as const };

  async function runtimeFor(options: { r1SettingsEnabled?: boolean; recordingEnabled?: boolean; store?: MemoryR1ObjectStore; maxAttempts?: number } = {}) {
    const tables = finishingTables();
    tables.r1_settings![0]!.enabled = options.r1SettingsEnabled ?? true;
    const db = createRecordingFakeDb(tables);
    const queue = makeQueue();
    const store = options.store ?? new MemoryR1ObjectStore({ now: () => START_MS });
    const queued = await queue.enqueue(R1_RECORDING_FINALIZE_QUEUE, { session_id: ROOM_SESSION }, { maxAttempts: options.maxAttempts ?? 5, dedupKey: `${R1_RECORDING_FINALIZE_QUEUE}:${ROOM_SESSION}` });
    const runtime = createR1Runtime({
      config: ENABLED,
      client: db.client as never,
      queue,
      now: NOW,
      recordingConfig: () => (options.recordingEnabled === false ? { enabled: false, status: 'disabled' } : enabledRecordingConfig()),
      recordingStore: () => store,
    })!;
    return { runtime, db, queue, queued, store, tables };
  }

  it('finalizes a queued recording while r1_settings.enabled is FALSE (a disabled R1 still finishes what is in flight)', async () => {
    const { runtime, db, queue, queued, store } = await runtimeFor({ r1SettingsEnabled: false });
    store.putObject(KEYS.stream, mp4(4000), 'video/mp4');
    await runtime.tickAll();
    await runtime.stop();
    expect(db.tables.interview_round_recordings![0]).toMatchObject({ status: 'ready', video_key: KEYS.stream });
    expect(await queue.getById(queued.id)).toMatchObject({ status: 'completed' });
    expect(runtime.snapshot().storageJobEvents).toMatchObject({ claimed: 1, completed: 1 });
    // The scoring runner saw nothing and its counters are separate.
    expect(runtime.snapshot().jobEvents.claimed ?? 0).toBe(0);
  });

  it('leaves the job PENDING with no attempt spent while the storage config is not enabled', async () => {
    const { runtime, db, queue, queued, store } = await runtimeFor({ recordingEnabled: false });
    store.putObject(KEYS.stream, mp4(4000), 'video/mp4');
    await runtime.tickAll();
    await runtime.tickAll();
    await runtime.stop();
    expect(await queue.getById(queued.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(db.tables.interview_round_recordings![0]).toMatchObject({ status: 'finishing' });
    expect(runtime.snapshot().storageJobEvents.not_admitted).toBeGreaterThanOrEqual(2);
    expect(runtime.snapshot().storageJobEvents.claimed ?? 0).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it('does not write a log line for the idle not-admitted poll (recording is off by default)', async () => {
    const info = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { runtime } = await runtimeFor({ recordingEnabled: false });
    await runtime.tickAll();
    await runtime.stop();
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('r1_storage_queue_'))).toEqual([]);
  });

  it('a transient R2 failure returns the job to delayed with its attempt refunded, nothing dead-lettered', async () => {
    const { runtime, queue, queued, store } = await runtimeFor();
    store.putObject(KEYS.stream, mp4(4000), 'video/mp4');
    store.failNext('head', 'unavailable');
    await runtime.tickAll();
    await runtime.stop();
    expect(await queue.getById(queued.id)).toMatchObject({ status: 'delayed', attempts: 0, deferReason: R1_STORAGE_DEFER_REASON });
    expect(await queue.getDlqJobs()).toHaveLength(0);
    expect(runtime.snapshot().storageJobEvents.deferred).toBe(1);
  });

  it('a permanent failure dead-letters with the sanitized code after its attempts', async () => {
    const { runtime, queue, queued, store } = await runtimeFor({ maxAttempts: 1 });
    store.putObject(KEYS.stream, mp4(4000), 'video/mp4');
    store.failNext('head', 'access_denied');
    await runtime.tickAll();
    await runtime.stop();
    const dlq = await queue.getDlqJobs();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ id: queued.id, errorMessage: 'r1_storage_access' });
  });

  it('never claims a phone job or an assessment job, and the assessment runner never claims the finalize job', async () => {
    const { runtime, queue, queued } = await runtimeFor({ recordingEnabled: false });
    await queue.enqueue('phone.assessment', { session_id: ROOM_SESSION, attempt_id: ROOM_SESSION });
    await queue.enqueue('phone.dial', { engagement_id: ROOM_SESSION });
    await runtime.tickAll();
    await runtime.stop();
    expect(await queue.claim('phone.assessment', { leaseSeconds: 30, owner: 'phone' })).not.toBeNull();
    expect(await queue.claim('phone.dial', { leaseSeconds: 30, owner: 'phone' })).not.toBeNull();
    expect(await queue.getById(queued.id)).toMatchObject({ status: 'pending' });
    // With recording on, the finalize job is still never an assessment-runner job.
    const on = await runtimeFor();
    await on.runtime.runner.tick();
    expect(await on.queue.getById(on.queued.id)).toMatchObject({ status: 'pending', attempts: 0 });
    await on.runtime.stop();
  });

  it('stops both runners and the scheduler', async () => {
    const { runtime } = await runtimeFor();
    await runtime.stop();
    expect(runtime.runner.stopped()).toBe(true);
    expect(runtime.storageRunner.stopped()).toBe(true);
    expect(runtime.scheduler.running()).toBe(false);
  });
});

describe('structural fences for the recording lane', () => {
  const read = (relative: string) => readFileSync(path.join(path.resolve(here, '..'), relative), 'utf8').replace(/\r\n/g, '\n');

  it('the queue name is the one the 0127 trigger enqueues', () => {
    const migration = readFileSync(path.resolve(here, '../../../supabase/migrations/0127_r1_recordings.sql'), 'utf8');
    expect(migration).toContain(`'${R1_RECORDING_FINALIZE_QUEUE}'`);
    expect(R1_RECORDING_FINALIZE_QUEUE).toBe('r1.recording.finalize');
  });

  it('the phone runtime and the other runtimes never mention the recording lane', () => {
    for (const file of ['lib/phone-runtime/runtime.ts', 'lib/phone-runtime/assessment-handler.ts', 'lib/phone-runtime/config.ts', 'lib/recording/runtime.ts', 'lib/funnel/runtime.ts']) {
      expect(read(file), file).not.toMatch(/r1\.recording|r1-storage|recording\/handlers|lib\/r1/);
    }
  });

  it('the storage runner is gated on the recording config alone, never on r1_settings.enabled or R1_ENABLED', () => {
    const runtime = read('lib/r1/runtime.ts');
    // The lane is one function, shared by the full runtime and the standalone one.
    const start = runtime.indexOf('const storageRunner = createQueueRunner');
    expect(start).toBeGreaterThan(0);
    const end = runtime.indexOf('return { runner: storageRunner', start);
    expect(end).toBeGreaterThan(start);
    const block = runtime.slice(start, end);
    expect(block).toContain('recordingConfig().enabled');
    expect(block).not.toMatch(/r1Enabled|getR1Config|config\.enabled/);
  });

  it('the standalone storage runtime hosts the lane only: no assessment handler, no status loop, no R1 gate', () => {
    const runtime = read('lib/r1/runtime.ts');
    const start = runtime.indexOf('export function createR1StorageRuntime');
    expect(start).toBeGreaterThan(0);
    const code = runtime.slice(start).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('if (!recordingConfig().enabled) return null;');
    expect(code).not.toMatch(/r1Enabled|getR1Config|R1_ASSESSMENT_QUEUE|createR1AssessmentHandler|statusTick|lapseOrphans|r1_settings/);
  });

  it('index.ts builds the storage runtime only when the full R1 runtime is absent, in its own try/catch, and starts and stops it', () => {
    const index = read('index.ts');
    expect(index).toMatch(/let r1StorageRuntime: R1StorageRuntimeHandle \| null = null;\nif \(!r1Runtime\) \{\n  try \{\n    r1StorageRuntime = createR1StorageRuntime\(\);\n  \} catch \{/);
    expect(index).toContain("error_category: 'r1_storage_runtime_start_failed'");
    expect(index).toContain('r1StorageRuntime.scheduler.start();');
    expect(index).toContain('await r1StorageRuntime.stop();');
    // After the full runtime's own block, so a throw from one never decides the other.
    expect(index.indexOf('let r1StorageRuntime')).toBeGreaterThan(index.indexOf('let r1Runtime'));
  });
});
