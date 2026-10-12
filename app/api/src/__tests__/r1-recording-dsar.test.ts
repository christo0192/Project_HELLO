/**
 * DSAR and R1 recordings. The invariant: the objects in R2 are erased and VERIFIED gone before any
 * row of the cascade is deleted (the rows are the only index of those objects), a failure returns
 * before a single row is deleted and never marks the request fulfilled, and a missing store is a
 * failure, never a skip. The export lists metadata only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuditSink, setAuditSink } from '../lib/audit.js';
import { deleteDSAR, exportDSAR } from '../lib/dsar.js';
import { eraseCandidateR1Recordings, listCandidateR1Recordings } from '../lib/r1/recording/dsar-step.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import {
  FIXTURE_NOW_MS,
  createRecordingFakeDb,
  fixtureId,
  recordingRow,
  type FakeRecordingDb,
  type Row,
  type Tables,
} from './support/r1-recording-fake-db.js';
import { FAKE_S3_ENV, enabledRecordingConfig } from './support/r1-recording-harness.js';

const holder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../lib/r1/recording/store-factory.js', () => ({
  getR1RecordingStore: () => holder.store,
  resetR1RecordingStoreCache: () => undefined,
}));

const CANDIDATE = fixtureId('c', 1);
const OTHER_CANDIDATE = fixtureId('c', 2);
const DSAR_ID = 'dsar-00000000-0000-4000-8000-000000000001';
const iso = (ms: number): string => new Date(ms).toISOString();
const keysOf = (n: number) => recordingKeys(fixtureId('a', n), fixtureId('b', n));
const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };

/** Two rounds for candidate 1 (rounds 1 and 2), one for candidate 2 (round 3). */
function dsarTables(rows: Row[], extra: Tables = {}): Tables {
  return {
    data_subject_requests: [{
      id: DSAR_ID, candidate_id: CANDIDATE, request_type: 'delete', request_status: 'pending', requested_by: 'staff-1',
      requested_at: iso(FIXTURE_NOW_MS - 1000), legal_hold_blocked: false, notes: null, metadata: null,
      created_at: iso(FIXTURE_NOW_MS - 1000), updated_at: iso(FIXTURE_NOW_MS - 1000),
    }],
    candidates: [{ id: CANDIDATE, name: 'A', email: 'a@x.test', consent_source: 'job_application', owner_id: null }, { id: OTHER_CANDIDATE, owner_id: null }],
    call_sessions: [
      { id: fixtureId('b', 1), candidate_id: CANDIDATE },
      { id: fixtureId('b', 2), candidate_id: CANDIDATE },
      { id: fixtureId('b', 3), candidate_id: OTHER_CANDIDATE },
    ],
    transcript_turns: [{ id: 't1', candidate_id: CANDIDATE }],
    assessments: [],
    candidate_invites: [],
    resumes: [],
    interview_rounds: [
      { id: fixtureId('a', 1), candidate_id: CANDIDATE },
      { id: fixtureId('a', 2), candidate_id: CANDIDATE },
      { id: fixtureId('a', 3), candidate_id: OTHER_CANDIDATE },
    ],
    interview_round_attempts: [
      { session_id: fixtureId('b', 1), round_id: fixtureId('a', 1), attempt_number: 1 },
      { session_id: fixtureId('b', 2), round_id: fixtureId('a', 2), attempt_number: 1 },
      { session_id: fixtureId('b', 3), round_id: fixtureId('a', 3), attempt_number: 1 },
    ],
    interview_round_recordings: rows,
    legal_holds: [],
    erasure_exceptions: [],
    governance_audit: [],
    r1_recording_purge: [],
    ...extra,
  };
}

const hold = (type: string, id: string): Row => ({
  id: `hold-${type}`, entity_type: type, entity_id: id, hold_reason: 'litigation', hold_source: 'litigation_hold',
  placed_by: 'lawyer-1', placed_at: iso(FIXTURE_NOW_MS - 5000), released_at: null, released_by: null, release_reason: null, expires_at: null, metadata: null,
});

let originalSink: ReturnType<typeof getAuditSink>;
const savedEnv: Record<string, string | undefined> = {};
function setStorageEnv(on: boolean): void {
  for (const [name, value] of Object.entries(FAKE_S3_ENV)) {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
}
beforeEach(() => {
  originalSink = getAuditSink();
  setAuditSink(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.store = new MemoryR1ObjectStore({ now: () => FIXTURE_NOW_MS });
});
afterEach(() => {
  setAuditSink(originalSink);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe('eraseCandidateR1Recordings', () => {
  function stepFor(tables: Tables, options: { enabled?: boolean } = {}) {
    const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
    const store = new MemoryR1ObjectStore({ now: () => FIXTURE_NOW_MS });
    const configReads = vi.fn(() => (options.enabled === false ? ({ enabled: false, status: 'disabled' } as const) : enabledRecordingConfig()));
    return {
      db,
      store,
      configReads,
      tables,
      run: () => eraseCandidateR1Recordings(CANDIDATE, db.client as never, { recordingConfig: configReads, store: () => store, now: () => new Date(FIXTURE_NOW_MS) }),
    };
  }

  it('does nothing and never reads the config or touches the store when the candidate has no R1 recording', async () => {
    const s = stepFor(dsarTables([recordingRow(3, { status: 'ready' })])); // someone else's
    await expect(s.run()).resolves.toEqual({ ok: true, erased: [] });
    expect(s.configReads).not.toHaveBeenCalled();
    expect(s.store.calls).toEqual([]);
    const none = stepFor(dsarTables([]));
    await expect(none.run()).resolves.toEqual({ ok: true, erased: [] });
  });

  it('erases every non-deleted recording of the candidate (any status) and no one else\'s', async () => {
    const s = stepFor(dsarTables([
      recordingRow(1, { status: 'ready' }),
      recordingRow(2, { status: 'preparing', layout: null, video_key: null, upload_id: null }),
      recordingRow(3, { status: 'ready' }),
      recordingRow(1, { status: 'deleted', deleted_at: iso(FIXTURE_NOW_MS - 1000), session_id: fixtureId('b', 9), video_key: null, prefix: `r1/${fixtureId('a', 1)}/${fixtureId('b', 9)}/` }),
    ]));
    for (const n of [1, 2, 3]) s.store.putObject(keysOf(n).stream, mp4(100));
    const result = await s.run();
    expect(result).toEqual({ ok: true, erased: [fixtureId('b', 1), fixtureId('b', 2)] });
    expect(s.store.objectKeys()).toEqual([keysOf(3).stream]);
    const [r1, r2, r3] = s.tables.interview_round_recordings!;
    expect([r1!.status, r2!.status, r3!.status]).toEqual(['deleted', 'deleted', 'ready']);
    expect(r1!.delete_reason).toBe('dsar');
  });

  it('drains the candidate\'s open outbox rows too, not another candidate\'s', async () => {
    const outbox = (n: number, extra: Row = {}): Row => ({
      id: `purge-${n}`, bucket: 'ik-r1-recordings', prefix: keysOf(n).prefix, upload_id: null, reason: 'row_deleted',
      queued_at: iso(FIXTURE_NOW_MS - 60_000), attempts: 0, last_error_code: null, done_at: null, ...extra,
    });
    const s = stepFor(dsarTables([], { r1_recording_purge: [outbox(1), outbox(3), outbox(2, { done_at: iso(FIXTURE_NOW_MS - 1) })] }));
    for (const n of [1, 2, 3]) s.store.putObject(keysOf(n).stream, mp4(100));
    await expect(s.run()).resolves.toEqual({ ok: true, erased: [fixtureId('b', 1)] });
    expect(s.store.objectKeys()).toEqual([keysOf(2).stream, keysOf(3).stream]);
    expect(s.tables.r1_recording_purge!.map((r) => r.done_at !== null)).toEqual([true, false, true]);
  });

  it('an unconfigured store with recordings present is a FAILURE, never a skip', async () => {
    const s = stepFor(dsarTables([recordingRow(1)]), { enabled: false });
    await expect(s.run()).resolves.toEqual({ ok: false, kind: 'failed', code: 'r1_storage_unconfigured' });
    expect(s.tables.interview_round_recordings![0]!.status).toBe('ready');
    expect(s.store.calls).toEqual([]);
  });

  it('a legal hold on ANY of the recordings blocks the whole request before anything is erased', async () => {
    const s = stepFor(dsarTables(
      [recordingRow(1), recordingRow(2)],
      { legal_holds: [hold('recording', fixtureId('b', 2))] },
    ));
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.putObject(keysOf(2).stream, mp4(100));
    const result = await s.run();
    expect(result).toMatchObject({ ok: false, kind: 'blocked' });
    if (result.ok || result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.holds).toEqual([expect.objectContaining({ id: 'hold-recording', entityType: 'recording', entityId: fixtureId('b', 2), holdReason: 'litigation', holdSource: 'litigation_hold' })]);
    expect(s.store.objectKeys()).toEqual([keysOf(1).stream, keysOf(2).stream]);
    expect(s.tables.interview_round_recordings!.every((r) => r.status === 'ready')).toBe(true);
  });

  it('a failure part-way is reported with a closed code and leaves the failing row un-tombstoned', async () => {
    const s = stepFor(dsarTables([recordingRow(1), recordingRow(2)]));
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.putObject(keysOf(2).stream, mp4(100));
    s.store.failNext('remove', 'unavailable', { skip: 1 });
    await expect(s.run()).resolves.toEqual({ ok: false, kind: 'failed', code: 'r1_storage_unavailable' });
    expect(s.tables.interview_round_recordings!.map((r) => r.status)).toEqual(['deleted', 'ready']);
    expect(s.store.has(keysOf(2).stream)).toBe(true);
  });

  it('an unreadable hold table or recordings table fails closed', async () => {
    const holds = stepFor(dsarTables([recordingRow(1)]));
    holds.db.failOn('legal_holds', 'select');
    await expect(holds.run()).resolves.toEqual({ ok: false, kind: 'failed', code: 'r1_recording_db_error' });
    expect(holds.tables.interview_round_recordings![0]!.status).toBe('ready');
    const rows = stepFor(dsarTables([recordingRow(1)]));
    rows.db.failOn('interview_round_recordings', 'select');
    await expect(rows.run()).resolves.toEqual({ ok: false, kind: 'failed', code: 'r1_recording_db_error' });
  });
});

describe('deleteDSAR with R1 recordings', () => {
  function dsarFor(rows: Row[], extra: Tables = {}) {
    const tables = dsarTables(rows, extra);
    const db: FakeRecordingDb = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
    const store = holder.store as MemoryR1ObjectStore;
    return { tables, db, store, run: () => deleteDSAR(DSAR_ID, 'staff-1', db.client as never) };
  }
  const dsarRow = (tables: Tables) => tables.data_subject_requests![0]!;

  beforeEach(() => setStorageEnv(true));

  it('erases and verifies the objects BEFORE any row is deleted, then deletes and fulfils', async () => {
    const s = dsarFor([recordingRow(1), recordingRow(2)]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.putObject(keysOf(2).audioPartial, 'ogg');
    s.store.putObject(keysOf(3).stream, mp4(100));
    let atFirstDelete: { keys: string[]; statuses: unknown[] } | null = null;
    s.db.hooks.beforeWrite = (table, op) => {
      if (op === 'delete' && atFirstDelete === null) {
        atFirstDelete = { keys: s.store.objectKeys(), statuses: s.tables.interview_round_recordings!.map((r) => r.status) };
      }
    };
    const result = await s.run();
    expect(result.success).toBe(true);
    expect(atFirstDelete).toEqual({ keys: [keysOf(3).stream], statuses: ['deleted', 'deleted'] });
    expect(result.deletedEntities).toEqual(expect.arrayContaining([`r1_recording:${fixtureId('b', 1)}`, `r1_recording:${fixtureId('b', 2)}`, `candidate:${CANDIDATE}`]));
    expect(dsarRow(s.tables)).toMatchObject({ request_status: 'fulfilled' });
    expect(s.tables.candidates!.map((c) => c.id)).toEqual([OTHER_CANDIDATE]);
    // Evidence: the governance trail names the recordings and the DSAR, never an object key.
    expect(JSON.stringify(s.tables.governance_audit)).not.toMatch(/r1\/[0-9a-f]{8}-/);
  });

  it('a store failure returns BEFORE a single row is deleted, leaves the request in progress with a failure audit, and a retry completes', async () => {
    const s = dsarFor([recordingRow(1)]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.failNext('remove', 'unavailable');
    const deletes: string[] = [];
    s.db.hooks.beforeWrite = (table, op) => { if (op === 'delete') deletes.push(table); };

    const failed = await s.run();
    expect(failed).toMatchObject({ success: false, deletedEntities: [], blockedByLegalHolds: [] });
    expect(deletes).toEqual([]);
    expect(s.tables.call_sessions).toHaveLength(3);
    expect(s.tables.transcript_turns).toHaveLength(1);
    expect(s.tables.candidates).toHaveLength(2);
    expect(dsarRow(s.tables)).toMatchObject({ request_status: 'in_progress' });
    expect(dsarRow(s.tables).request_status).not.toBe('fulfilled');
    expect(s.tables.governance_audit).toEqual([
      expect.objectContaining({ action: 'data_deleted', outcome: 'failure', entity_id: CANDIDATE, details: expect.objectContaining({ stage: 'r1_recordings', code: 'r1_storage_unavailable' }) }),
    ]);
    expect(s.tables.interview_round_recordings![0]!.status).toBe('ready');

    const retried = await s.run();
    expect(retried.success).toBe(true);
    expect(dsarRow(s.tables)).toMatchObject({ request_status: 'fulfilled' });
    expect(s.store.objectKeys()).toEqual([]);
  });

  it('an unconfigured store with R1 recordings present fails the request and deletes nothing', async () => {
    setStorageEnv(false);
    const s = dsarFor([recordingRow(1)]);
    const deletes: string[] = [];
    s.db.hooks.beforeWrite = (table, op) => { if (op === 'delete') deletes.push(table); };
    const result = await s.run();
    expect(result).toMatchObject({ success: false, deletedEntities: [] });
    expect(deletes).toEqual([]);
    expect(dsarRow(s.tables)).toMatchObject({ request_status: 'in_progress', notes: expect.stringContaining('r1_storage_unconfigured') });
  });

  it('a legal hold on a recording blocks like the candidate and session holds do (409 shape), erasing nothing', async () => {
    const s = dsarFor([recordingRow(1)], { legal_holds: [hold('recording', fixtureId('b', 1))] });
    s.store.putObject(keysOf(1).stream, mp4(100));
    const result = await s.run();
    expect(result.success).toBe(false);
    expect(result.blockedByLegalHolds).toEqual([expect.objectContaining({ id: 'hold-recording', holdReason: 'litigation' })]);
    expect(s.store.has(keysOf(1).stream)).toBe(true);
    expect(dsarRow(s.tables)).toMatchObject({ legal_hold_blocked: true, request_status: 'pending' });
    expect(s.tables.governance_audit).toEqual([expect.objectContaining({ action: 'erasure_blocked_legal_hold', outcome: 'blocked', details: expect.objectContaining({ stage: 'r1_recordings' }) })]);
    expect(s.tables.candidates).toHaveLength(2);
  });

  it('a candidate with no R1 data deletes exactly as before and never touches the store', async () => {
    const s = dsarFor([]);
    const result = await s.run();
    expect(result.success).toBe(true);
    expect(result.deletedEntities.some((e) => e.startsWith('r1_recording:'))).toBe(false);
    expect(s.store.calls).toEqual([]);
  });

  it('a tombstoned recording is not a purge-outbox row when its parent rows go (the trigger skips deleted_at)', async () => {
    const s = dsarFor([recordingRow(1)]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    await s.run();
    // The fake cascade does not run, but the BEFORE DELETE simulation is exercised by deleting the row now.
    await s.db.client.from('interview_round_recordings').delete().eq('session_id', fixtureId('b', 1));
    expect(s.tables.r1_recording_purge).toEqual([]);
  });
});

describe('the DSAR export', () => {
  it('lists R1 recording metadata only: no URL, key, bucket, hash, ETag or upload id', async () => {
    const tables = dsarTables([
      recordingRow(1, { video_bytes: 4000, audio_bytes: 96, started_at_ms: FIXTURE_NOW_MS - 600_000, upload_id: 'secret-upload-id', video_etag: '"abc"' }),
      recordingRow(2, { status: 'deleted', deleted_at: iso(FIXTURE_NOW_MS - 5), video_key: null, video_bytes: null, audio_bytes: null, layout: null, duration_ms: null }),
      recordingRow(3),
    ]);
    tables.data_subject_requests![0]!.request_type = 'export';
    const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
    const result = await exportDSAR(DSAR_ID, db.client as never);
    expect(result).not.toBeNull();
    const r1 = (result as unknown as { r1_recordings: Array<Record<string, unknown>> }).r1_recordings;
    expect(r1).toEqual([
      { session_id: fixtureId('b', 1), attempt_number: 1, status: 'ready', layout: 'combined', duration_ms: 540_000, bytes: 4096, recorded_at: iso(FIXTURE_NOW_MS - 600_000), delete_after: expect.any(String) },
      expect.objectContaining({ session_id: fixtureId('b', 2), status: 'deleted', bytes: null, layout: null }),
    ]);
    const text = JSON.stringify(r1);
    for (const secret of ['secret-upload-id', 'etag', 'sha256', 'bucket', 'https://', 'stream.mp4', 'r1/', 'video_key', 'prefix']) expect(text).not.toContain(secret);
    expect(result!.r1_recordings).toBeDefined();
  });

  it('omits the field entirely when the candidate has none (an export without R1 is unchanged)', async () => {
    const tables = dsarTables([recordingRow(3)]);
    tables.data_subject_requests![0]!.request_type = 'export';
    const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
    const result = await exportDSAR(DSAR_ID, db.client as never);
    expect(result).not.toBeNull();
    expect('r1_recordings' in result!).toBe(false);
  });

  it('a failed read leaves the section out rather than failing the export', async () => {
    const tables = dsarTables([recordingRow(1)]);
    tables.data_subject_requests![0]!.request_type = 'export';
    const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
    db.failOn('interview_round_recordings', 'select');
    const result = await exportDSAR(DSAR_ID, db.client as never);
    expect(result).not.toBeNull();
    expect('r1_recordings' in result!).toBe(false);
    await expect(listCandidateR1Recordings(CANDIDATE, createRecordingFakeDb(dsarTables([]), {}).client as never)).resolves.toEqual([]);
  });
});
