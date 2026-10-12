/**
 * The shared erase routine of the R1 recording lane (retention, consent withdrawal, DSAR, purge
 * outbox). The invariant under test is VERIFY BEFORE TOMBSTONE: a row only becomes `deleted` after
 * its prefix lists empty, no multipart upload is left, and HEAD answers 404 for every key; any
 * failure or unreadable listing leaves the row alone for the retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuditSink, setAuditSink } from '../lib/audit.js';
import {
  BLOCKED_AUDIT_INTERVAL_MS,
  R1_SYSTEM_ACTOR_ID,
  eraseOutboxRow,
  eraseRecording,
  eraseRoundRecordings,
  eraseSessionRecording,
  isEraseReason,
  purgePrefix,
  sessionIdOfPrefix,
  withdrawalCutoffs,
  type R1EraseDeps,
  type R1PurgeRow,
} from '../lib/r1/recording/erase.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import type { R1RecordingRow } from '../lib/r1/recording/service.js';
import {
  FIXTURE_NOW_MS,
  createRecordingFakeDb,
  fixtureId,
  recordingRow,
  roundTables,
  type FakeRecordingDb,
  type Row,
  type Tables,
} from './support/r1-recording-fake-db.js';

const KEYS = recordingKeys(fixtureId('a', 1), fixtureId('b', 1));
const iso = (ms: number): string => new Date(ms).toISOString();
const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };

/** A store that claims to delete `stuckKey` but keeps it: the erase must NOT believe it. */
class StubbornStore extends MemoryR1ObjectStore {
  stuckKey = '';
  override async remove(keys: string[]): Promise<void> {
    await super.remove(keys.filter((key) => key !== this.stuckKey));
  }
}

interface Setup {
  db: FakeRecordingDb;
  store: MemoryR1ObjectStore;
  deps: R1EraseDeps;
  row: () => Row;
  tables: Tables;
}

function setup(options: { row?: Row; tables?: Tables; store?: MemoryR1ObjectStore; bucket?: string } = {}): Setup {
  const tables: Tables = {
    ...roundTables(1),
    interview_round_recordings: [recordingRow(1, options.row)],
    interview_round_consents: [],
    legal_holds: [],
    governance_audit: [],
    r1_recording_purge: [],
    job_queue: [],
    ...options.tables,
  };
  const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
  const store = options.store ?? new MemoryR1ObjectStore({ now: () => FIXTURE_NOW_MS });
  return {
    db,
    store,
    tables,
    deps: { db: db.client as never, store, bucket: options.bucket ?? 'ik-r1-recordings', now: () => new Date(FIXTURE_NOW_MS) },
    row: () => tables.interview_round_recordings![0]!,
  };
}

const hold = (entity_type: string, entity_id: string, extra: Row = {}): Row => ({
  id: `hold-${entity_type}`, entity_type, entity_id, hold_reason: 'case', hold_source: 'court_order',
  placed_by: 'u', placed_at: iso(FIXTURE_NOW_MS - 1000), released_at: null, expires_at: null, metadata: null, ...extra,
});

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

describe('purgePrefix', () => {
  it.each([
    ['the whole namespace', 'r1/'],
    ['a round only', `r1/${fixtureId('a', 1)}/`],
    ['no trailing slash', `r1/${fixtureId('a', 1)}/${fixtureId('b', 1)}`],
    ['a foreign prefix', 'phone/recordings/'],
    ['the smoke prefix', 'r1/smoke/abc/'],
    ['an upper-case id', `r1/ABCDEF00-0000-4000-8000-000000000001/${fixtureId('b', 1)}/`],
    ['empty', ''],
  ])('refuses %s and never touches the store', async (_label, prefix) => {
    const store = new MemoryR1ObjectStore();
    store.putObject('r1/smoke/abc/keep.bin', 'x');
    await expect(purgePrefix(store, prefix)).rejects.toThrow('r1_erase_prefix_invalid');
    expect(store.calls).toEqual([]);
    expect(store.has('r1/smoke/abc/keep.bin')).toBe(true);
  });

  it('aborts the known and the listed uploads, deletes every key, then verifies in that order', async () => {
    const { store } = setup();
    store.putObject(KEYS.stream, mp4(100));
    store.putObject(KEYS.audioPartial, 'ogg');
    store.putObject('r1/someone-else/keep.bin', 'x');
    const known = await store.createMultipart(KEYS.stream, 'video/mp4');
    await store.createMultipart(`${KEYS.prefix}extra.bin`, 'application/octet-stream');
    store.calls.length = 0;

    const result = await purgePrefix(store, KEYS.prefix, [known]);

    expect(result).toEqual({ objects: 2, uploads: 2 });
    expect(store.objectKeys()).toEqual(['r1/someone-else/keep.bin']);
    expect(store.openUploadIds()).toEqual([]);
    const ops = store.calls.map((c) => c.op);
    expect(ops.indexOf('abortMultipart')).toBeLessThan(ops.indexOf('remove'));
    const lastRemove = ops.lastIndexOf('remove');
    expect(ops.slice(lastRemove + 1)).toContain('listPrefix');
    expect(ops.slice(lastRemove + 1)).toContain('listMultipartUploads');
    // HEAD for the removed keys and the four fixed names.
    expect(store.countCalls('head')).toBeGreaterThanOrEqual(4);
    // Nothing outside the prefix was listed for deletion.
    for (const call of store.callsOf('remove')) expect(call.keys!.every((k) => k.startsWith(KEYS.prefix))).toBe(true);
  });

  it('works through a prefix larger than one listing batch, pass by pass', async () => {
    const { store } = setup();
    for (let i = 0; i < 1050; i += 1) store.putObject(`${KEYS.prefix}straggler-${i}.bin`, 'x');
    await expect(purgePrefix(store, KEYS.prefix)).resolves.toMatchObject({ objects: 1050 });
    expect(store.objectKeys()).toEqual([]);
    expect(store.callsOf('remove').map((c) => c.keys!.length)).toEqual([1000, 50]);
  });

  it('is idempotent: an empty prefix is success with nothing to do', async () => {
    const { store } = setup();
    await expect(purgePrefix(store, KEYS.prefix)).resolves.toEqual({ objects: 0, uploads: 0 });
    await expect(purgePrefix(store, KEYS.prefix)).resolves.toEqual({ objects: 0, uploads: 0 });
  });

  it('throws r1_erase_unverified when the store keeps an object it said it deleted', async () => {
    const store = new StubbornStore({ now: () => FIXTURE_NOW_MS });
    store.putObject(KEYS.stream, mp4(100));
    store.putObject(KEYS.audio, 'ogg');
    store.stuckKey = KEYS.audio;
    await expect(purgePrefix(store, KEYS.prefix)).rejects.toThrow('r1_erase_unverified');
  });

  it('a straggler that lands during the last pass is caught by the verification listing', async () => {
    // Every delete is followed by a late PUT under a NEW name, so the final pass can never win the race.
    class LateWriterStore extends MemoryR1ObjectStore {
      late = 0;
      override async remove(keys: string[]): Promise<void> {
        await super.remove(keys);
        this.late += 1;
        this.putObject(`${KEYS.prefix}late-${this.late}.bin`, 'late');
      }
    }
    const store = new LateWriterStore({ now: () => FIXTURE_NOW_MS });
    store.putObject(KEYS.stream, mp4(100));
    await expect(purgePrefix(store, KEYS.prefix)).rejects.toThrow('r1_erase_unverified');
    expect(store.objectKeys().filter((k) => k.includes('late-'))).toHaveLength(1);
  });

  it('an unreadable listing is an error, never "empty"', async () => {
    const { store } = setup();
    store.putObject(KEYS.stream, mp4(100));
    store.failNext('listPrefix', 'unavailable');
    await expect(purgePrefix(store, KEYS.prefix)).rejects.toThrow('r1_storage_unavailable');
    expect(store.has(KEYS.stream)).toBe(true);
    const second = setup().store;
    second.putObject(KEYS.stream, mp4(100));
    second.failNext('listMultipartUploads', 'bad_response');
    await expect(purgePrefix(second, KEYS.prefix)).rejects.toThrow('r1_storage_error');
  });

  it('a failing verification listing is an error too (the first listings succeeded)', async () => {
    const { store } = setup();
    store.putObject(KEYS.stream, mp4(100));
    // listPrefix calls: pass 0 (finds the object), pass 1 (empty), verify. Fail the verify listing.
    store.failNext('listPrefix', 'unavailable', { skip: 2 });
    await expect(purgePrefix(store, KEYS.prefix)).rejects.toThrow('r1_storage_unavailable');
  });

  it('turns a failed delete into a closed code and keeps going on the retry', async () => {
    const { store } = setup();
    store.putObject(KEYS.stream, mp4(100));
    store.failNext('remove', 'delete_failed');
    await expect(purgePrefix(store, KEYS.prefix)).rejects.toThrow('r1_storage_error');
    await expect(purgePrefix(store, KEYS.prefix)).resolves.toMatchObject({ objects: 1 });
    expect(store.objectKeys()).toEqual([]);
  });
});

describe('eraseRecording', () => {
  it('erases, then tombstones: keys and upload id gone, bytes and hashes kept as evidence, audited', async () => {
    const { deps, store, row, tables } = setup({ row: { status: 'finishing', upload_id: 'will-be-replaced', audio_key: KEYS.audio, audio_bytes: 77, audio_sha256: 'b'.repeat(64) } });
    store.putObject(KEYS.stream, mp4(100));
    store.putObject(KEYS.audio, 'ogg');
    const uploadId = await store.createMultipart(KEYS.stream, 'video/mp4');
    tables.interview_round_recordings![0]!.upload_id = uploadId;

    const outcome = await eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention');

    expect(outcome).toEqual({ kind: 'erased', objects: 2 });
    expect(store.objectKeys()).toEqual([]);
    expect(store.openUploadIds()).toEqual([]);
    expect(row()).toMatchObject({
      status: 'deleted', deleted_at: iso(FIXTURE_NOW_MS), upload_id: null, video_key: null, audio_key: null,
      delete_reason: 'retention', delete_requested_at: iso(FIXTURE_NOW_MS),
      video_bytes: 4096, video_sha256: 'a'.repeat(64), audio_bytes: 77, audio_sha256: 'b'.repeat(64),
    });
    expect(tables.governance_audit).toEqual([
      expect.objectContaining({
        action: 'data_deleted', actor_id: R1_SYSTEM_ACTOR_ID, actor_type: 'system', entity_type: 'recording',
        entity_id: fixtureId('b', 1), outcome: 'success',
        details: expect.objectContaining({ resource: 'r1_recording', reason: 'retention', objects: 2, uploads_aborted: 1 }),
      }),
    ]);
    // Nothing in the audit row is a key, URL or upload id.
    expect(JSON.stringify(tables.governance_audit)).not.toMatch(/r1\/|https?:|mem-upload/);
  });

  it('uses erasure_completed for a withdrawal and keeps the FIRST reason on the row', async () => {
    const { deps, row, tables } = setup({ row: { delete_requested_at: iso(FIXTURE_NOW_MS - 5000), delete_reason: 'consent_withdrawn' } });
    await eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention');
    expect(row().delete_reason).toBe('consent_withdrawn');
    expect(row().delete_requested_at).toBe(iso(FIXTURE_NOW_MS - 5000));
    expect(tables.governance_audit![0]).toMatchObject({ action: 'data_deleted' });
    const second = setup();
    await eraseRecording(second.deps, second.row() as unknown as R1RecordingRow, 'consent_withdrawn');
    expect(second.tables.governance_audit![0]).toMatchObject({ action: 'erasure_completed' });
  });

  it('marks the row delete-requested BEFORE it touches the store', async () => {
    const { deps, store, row } = setup();
    let seenAtFirstStoreCall: unknown;
    const original = store.listMultipartUploads.bind(store);
    store.listMultipartUploads = (prefix: string) => {
      seenAtFirstStoreCall ??= row().delete_requested_at;
      return original(prefix);
    };
    await eraseRecording(deps, row() as unknown as R1RecordingRow, 'consent_withdrawn');
    expect(seenAtFirstStoreCall).toBe(iso(FIXTURE_NOW_MS));
  });

  it('an already-deleted row is a no-op (no store call, no audit)', async () => {
    const { deps, store, tables, row } = setup({ row: { status: 'deleted', deleted_at: iso(FIXTURE_NOW_MS - 1000), video_key: null } });
    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).resolves.toEqual({ kind: 'already_deleted' });
    expect(store.calls).toEqual([]);
    expect(tables.governance_audit).toEqual([]);
  });

  it('a remove that fails once leaves the row un-tombstoned (but delete-requested); the retry finishes', async () => {
    const { deps, store, row } = setup();
    store.putObject(KEYS.stream, mp4(100));
    store.failNext('remove', 'delete_failed');
    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).rejects.toThrow('r1_storage_error');
    expect(row()).toMatchObject({ status: 'ready', deleted_at: null, delete_requested_at: iso(FIXTURE_NOW_MS), delete_reason: 'retention' });
    expect(store.has(KEYS.stream)).toBe(true);

    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).resolves.toMatchObject({ kind: 'erased' });
    expect(row()).toMatchObject({ status: 'deleted', video_key: null });
    expect(store.objectKeys()).toEqual([]);
  });

  it('an unreadable listing never tombstones', async () => {
    const { deps, store, row } = setup();
    store.putObject(KEYS.stream, mp4(100));
    store.failNext('listPrefix', 'unavailable', { times: 10 });
    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).rejects.toThrow('r1_storage_unavailable');
    expect(row()).toMatchObject({ status: 'ready', deleted_at: null });
    expect(store.has(KEYS.stream)).toBe(true);
  });

  it('a verification that finds a survivor never tombstones', async () => {
    const stubborn = new StubbornStore({ now: () => FIXTURE_NOW_MS });
    stubborn.stuckKey = KEYS.stream;
    const { deps, row } = setup({ store: stubborn });
    stubborn.putObject(KEYS.stream, mp4(100));
    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).rejects.toThrow('r1_erase_unverified');
    expect(row()).toMatchObject({ status: 'ready', deleted_at: null });
  });

  it('a database failure on the tombstone leaves the (already empty) prefix and an un-tombstoned row for the retry', async () => {
    const { deps, db, row, store } = setup();
    store.putObject(KEYS.stream, mp4(100));
    // update #1 is the delete-requested mark, update #2 is the tombstone.
    db.failOn('interview_round_recordings', 'update', 1, 1);
    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).rejects.toThrow('r1_recording_db_error');
    expect(store.objectKeys()).toEqual([]);
    expect(row()).toMatchObject({ status: 'ready', deleted_at: null, delete_requested_at: iso(FIXTURE_NOW_MS) });
    await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).resolves.toMatchObject({ kind: 'erased' });
    expect(row().status).toBe('deleted');
  });

  it('refuses a row whose bucket is not the configured one, and a drifted prefix', async () => {
    const wrongBucket = setup({ row: { bucket: 'some-other-bucket' } });
    wrongBucket.store.putObject(KEYS.stream, mp4(10));
    await expect(eraseRecording(wrongBucket.deps, wrongBucket.row() as unknown as R1RecordingRow, 'retention')).rejects.toThrow('r1_erase_bucket_mismatch');
    expect(wrongBucket.store.calls).toEqual([]);

    const drifted = setup();
    const bad = { ...drifted.row(), prefix: 'r1/' } as unknown as R1RecordingRow;
    await expect(eraseRecording(drifted.deps, bad, 'retention')).rejects.toThrow('r1_erase_prefix_invalid');
    expect(drifted.store.calls).toEqual([]);
  });

  describe('legal holds', () => {
    it.each([
      ['candidate', fixtureId('c', 1)],
      ['session', fixtureId('b', 1)],
      ['recording', fixtureId('b', 1)],
    ])('a %s hold blocks the erase, keeps every object and audits it', async (type, id) => {
      const { deps, store, row, tables } = setup({ tables: { legal_holds: [hold(type, id)] } });
      store.putObject(KEYS.stream, mp4(100));
      const outcome = await eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention');
      expect(outcome).toEqual({ kind: 'blocked', holdIds: [`hold-${type}`] });
      expect(store.has(KEYS.stream)).toBe(true);
      expect(store.countCalls('remove')).toBe(0);
      expect(row()).toMatchObject({ status: 'ready', deleted_at: null });
      // Access is cut regardless: deletion HAS been requested, the hold only blocks the erase.
      expect(row().delete_requested_at).toBe(iso(FIXTURE_NOW_MS));
      expect(tables.governance_audit).toEqual([
        expect.objectContaining({ action: 'erasure_blocked_legal_hold', outcome: 'blocked', entity_id: fixtureId('b', 1) }),
      ]);
    });

    it('a released hold does not block', async () => {
      const { deps, row } = setup({ tables: { legal_holds: [hold('recording', fixtureId('b', 1), { released_at: iso(FIXTURE_NOW_MS - 1) })] } });
      await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).resolves.toMatchObject({ kind: 'erased' });
    });

    it('a hold on another recording does not block', async () => {
      const { deps, row } = setup({ tables: { legal_holds: [hold('recording', fixtureId('b', 9))] } });
      await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).resolves.toMatchObject({ kind: 'erased' });
    });

    it('audits a held recording at most once a day, however often it is retried', async () => {
      const { deps, row, tables } = setup({ tables: { legal_holds: [hold('recording', fixtureId('b', 1))] } });
      await eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention');
      expect(tables.governance_audit).toHaveLength(1);
      // The database stamps created_at; the fake does not, so stamp the entry at the fixture clock.
      tables.governance_audit![0]!.created_at = iso(FIXTURE_NOW_MS);
      await eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention');
      await eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention');
      expect(tables.governance_audit).toHaveLength(1);
      // A day later the block is audited again.
      const later = { ...deps, now: () => new Date(FIXTURE_NOW_MS + BLOCKED_AUDIT_INTERVAL_MS + 1000) };
      await eraseRecording(later, row() as unknown as R1RecordingRow, 'retention');
      expect(tables.governance_audit).toHaveLength(2);
    });

    it('an unreadable hold table FAILS CLOSED: nothing is erased', async () => {
      const { deps, db, store, row } = setup();
      store.putObject(KEYS.stream, mp4(100));
      db.failOn('legal_holds', 'select');
      await expect(eraseRecording(deps, row() as unknown as R1RecordingRow, 'retention')).rejects.toThrow('r1_recording_db_error');
      expect(store.has(KEYS.stream)).toBe(true);
      expect(row().status).toBe('ready');
    });
  });
});

describe('withdrawalCutoffs', () => {
  const consent = (id: string, decision: string | null, withdrawnAt: string | null, round = fixtureId('a', 1)): Row => ({
    id, round_id: round, withdrawn_at: withdrawnAt, proof: decision === null ? null : { decision },
  });

  it('counts withdrawn and declined, never superseded, and takes the latest per round', async () => {
    const { db } = setup({ tables: { interview_round_consents: [
      consent('c1', 'withdrawn', iso(1_000)),
      consent('c2', 'superseded', iso(9_000)),
      consent('c3', 'declined', iso(5_000)),
      consent('c4', null, iso(8_000)),
      consent('c5', 'withdrawn', null),
      consent('c6', 'withdrawn', iso(2_000), fixtureId('a', 2)),
    ] } });
    const cutoffs = await withdrawalCutoffs(db.client as never, [fixtureId('a', 1), fixtureId('a', 2), fixtureId('a', 3)]);
    expect([...cutoffs.entries()]).toEqual([[fixtureId('a', 1), 5_000], [fixtureId('a', 2), 2_000]]);
  });

  it('throws on a read error rather than reporting "no withdrawal"', async () => {
    const { db } = setup();
    db.failOn('interview_round_consents', 'select');
    await expect(withdrawalCutoffs(db.client as never, [fixtureId('a', 1)])).rejects.toThrow('r1_recording_db_error');
  });
});

describe('eraseRoundRecordings (the { round_id } job)', () => {
  const withdrawn = (at: number, decision = 'withdrawn'): Row => ({ id: `c-${at}`, round_id: fixtureId('a', 1), withdrawn_at: iso(at), proof: { decision } });

  function twoAttempts(consents: Row[]) {
    const first = recordingRow(1, { created_at: iso(FIXTURE_NOW_MS - 3 * 3600_000) });
    const second = recordingRow(2, { round_id: fixtureId('a', 1), prefix: `r1/${fixtureId('a', 1)}/${fixtureId('b', 2)}/`, video_key: `r1/${fixtureId('a', 1)}/${fixtureId('b', 2)}/stream.mp4`, created_at: iso(FIXTURE_NOW_MS - 600_000) });
    return setup({ tables: { interview_round_recordings: [first, second], interview_round_consents: consents } });
  }
  const k2 = recordingKeys(fixtureId('a', 1), fixtureId('b', 2));

  it('erases recordings made at or before the latest withdrawal, and keeps one made after a later re-consent', async () => {
    const { deps, store, tables } = twoAttempts([withdrawn(FIXTURE_NOW_MS - 3600_000)]);
    store.putObject(KEYS.stream, mp4(50));
    store.putObject(k2.stream, mp4(50));
    const result = await eraseRoundRecordings(deps, fixtureId('a', 1));
    expect(result).toMatchObject({ erased: 1, out_of_scope: 1, errors: 0 });
    expect(store.objectKeys()).toEqual([k2.stream]);
    const [first, second] = tables.interview_round_recordings!;
    expect(first).toMatchObject({ status: 'deleted' });
    expect(second).toMatchObject({ status: 'ready', deleted_at: null, delete_requested_at: null });
  });

  it('a superseded consent erases nothing', async () => {
    const { deps, store, tables } = twoAttempts([withdrawn(FIXTURE_NOW_MS - 60_000, 'superseded')]);
    store.putObject(KEYS.stream, mp4(50));
    await expect(eraseRoundRecordings(deps, fixtureId('a', 1))).resolves.toMatchObject({ erased: 0 });
    expect(store.has(KEYS.stream)).toBe(true);
    expect(tables.interview_round_recordings!.every((r) => r.status === 'ready')).toBe(true);
  });

  it('erases every recording of the round when the withdrawal is the latest event', async () => {
    const { deps, store } = twoAttempts([withdrawn(FIXTURE_NOW_MS - 60_000, 'declined')]);
    store.putObject(KEYS.stream, mp4(50));
    store.putObject(k2.stream, mp4(50));
    await expect(eraseRoundRecordings(deps, fixtureId('a', 1))).resolves.toMatchObject({ erased: 2, out_of_scope: 0 });
    expect(store.objectKeys()).toEqual([]);
  });

  it('attempts every row, then rethrows the first failure (one stuck recording does not strand the other)', async () => {
    const { deps, store, tables } = twoAttempts([withdrawn(FIXTURE_NOW_MS - 60_000)]);
    store.putObject(KEYS.stream, mp4(50));
    store.putObject(k2.stream, mp4(50));
    // Only the FIRST row's first listing fails; the second row is attempted regardless.
    store.failNext('listMultipartUploads', 'unavailable', { times: 1 });
    await expect(eraseRoundRecordings(deps, fixtureId('a', 1))).rejects.toThrow('r1_storage_unavailable');
    const statuses = tables.interview_round_recordings!.map((r) => r.status).sort();
    expect(statuses).toEqual(['deleted', 'ready']);
    // The retry finishes the other one.
    await expect(eraseRoundRecordings(deps, fixtureId('a', 1))).resolves.toMatchObject({ erased: 1 });
    expect(tables.interview_round_recordings!.every((r) => r.status === 'deleted')).toBe(true);
  });

  it('a round with no recordings, or no withdrawal, is a no-op', async () => {
    const { deps, store } = setup({ tables: { interview_round_recordings: [], interview_round_consents: [withdrawn(1_000)] } });
    await expect(eraseRoundRecordings(deps, fixtureId('a', 1))).resolves.toMatchObject({ erased: 0 });
    expect(store.calls).toEqual([]);
  });
});

describe('eraseSessionRecording (the { session_id } job)', () => {
  it('erases that recording without a scope test and ignores an unknown session', async () => {
    const { deps, store, row } = setup();
    store.putObject(KEYS.stream, mp4(50));
    await expect(eraseSessionRecording(deps, fixtureId('b', 9))).resolves.toMatchObject({ erased: 0 });
    expect(store.has(KEYS.stream)).toBe(true);
    await expect(eraseSessionRecording(deps, fixtureId('b', 1), 'consent_withdrawn')).resolves.toMatchObject({ erased: 1 });
    expect(row()).toMatchObject({ status: 'deleted', delete_reason: 'consent_withdrawn' });
  });
});

describe('eraseOutboxRow (rows deleted without a tombstone)', () => {
  const purgeRow = (overrides: Partial<R1PurgeRow> = {}): R1PurgeRow => ({
    id: 'purge-1', bucket: 'ik-r1-recordings', prefix: KEYS.prefix, upload_id: null, reason: 'row_deleted',
    queued_at: iso(FIXTURE_NOW_MS - 60_000), attempts: 0, last_error_code: null, done_at: null, ...overrides,
  });
  const withOutbox = (overrides: Partial<R1PurgeRow> = {}) => {
    const s = setup({ tables: { interview_round_recordings: [], r1_recording_purge: [purgeRow(overrides) as unknown as Row] } });
    return { ...s, outbox: () => s.tables.r1_recording_purge![0]! };
  };

  it('erases by prefix, verifies, marks done and audits', async () => {
    const { deps, store, outbox, tables } = withOutbox();
    store.putObject(KEYS.stream, mp4(50));
    const uploadId = await store.createMultipart(KEYS.stream, 'video/mp4');
    await expect(eraseOutboxRow(deps, { ...purgeRow(), upload_id: uploadId })).resolves.toEqual({ kind: 'done', objects: 1 });
    expect(store.objectKeys()).toEqual([]);
    expect(store.openUploadIds()).toEqual([]);
    expect(outbox()).toMatchObject({ done_at: iso(FIXTURE_NOW_MS), attempts: 1, last_error_code: null });
    expect(tables.governance_audit![0]).toMatchObject({ action: 'data_deleted', entity_id: fixtureId('b', 1), details: expect.objectContaining({ source: 'purge_outbox' }) });
  });

  it('never lists or deletes for a malformed prefix, and records why', async () => {
    const { deps, store, outbox } = withOutbox({ prefix: 'r1/' });
    store.putObject('r1/keep/x', 'x');
    await expect(eraseOutboxRow(deps, purgeRow({ prefix: 'r1/' }))).resolves.toEqual({ kind: 'failed', code: 'r1_erase_prefix_invalid' });
    expect(store.calls).toEqual([]);
    expect(outbox()).toMatchObject({ attempts: 1, last_error_code: 'r1_erase_prefix_invalid', done_at: null });
  });

  it('a row for another bucket stays in the outbox (this store cannot erase it)', async () => {
    const { deps, outbox, store } = withOutbox({ bucket: 'old-bucket' });
    await expect(eraseOutboxRow(deps, purgeRow({ bucket: 'old-bucket' }))).resolves.toEqual({ kind: 'failed', code: 'r1_erase_bucket_mismatch' });
    expect(store.calls).toEqual([]);
    expect(outbox().done_at).toBeNull();
  });

  it('a legal hold on the session blocks it and says so on the row', async () => {
    const s = setup({ tables: { interview_round_recordings: [], r1_recording_purge: [purgeRow() as unknown as Row], legal_holds: [hold('session', fixtureId('b', 1))] } });
    s.store.putObject(KEYS.stream, mp4(50));
    await expect(eraseOutboxRow(s.deps, purgeRow())).resolves.toEqual({ kind: 'blocked' });
    expect(s.store.has(KEYS.stream)).toBe(true);
    expect(s.tables.r1_recording_purge![0]).toMatchObject({ last_error_code: 'legal_hold', attempts: 1, done_at: null });
    expect(s.tables.governance_audit![0]).toMatchObject({ action: 'erasure_blocked_legal_hold' });
  });

  it('a store failure is recorded on the row and returned, never thrown', async () => {
    const { deps, store, outbox } = withOutbox();
    store.putObject(KEYS.stream, mp4(50));
    store.failNext('remove', 'unavailable');
    await expect(eraseOutboxRow(deps, purgeRow())).resolves.toEqual({ kind: 'failed', code: 'r1_storage_unavailable' });
    expect(outbox()).toMatchObject({ attempts: 1, last_error_code: 'r1_storage_unavailable', done_at: null });
    await expect(eraseOutboxRow(deps, purgeRow({ attempts: 1 }))).resolves.toMatchObject({ kind: 'done' });
    expect(outbox()).toMatchObject({ attempts: 2, last_error_code: null });
    expect(outbox().done_at).not.toBeNull();
  });
});

describe('helpers', () => {
  it('knows the reasons the row accepts and reads the session out of a prefix', () => {
    for (const reason of ['retention', 'consent_withdrawn', 'dsar', 'row_deleted', 'admin']) expect(isEraseReason(reason)).toBe(true);
    for (const reason of ['', 'other', null, undefined, 7]) expect(isEraseReason(reason)).toBe(false);
    expect(sessionIdOfPrefix(KEYS.prefix)).toBe(fixtureId('b', 1));
    expect(sessionIdOfPrefix('r1/')).toBeNull();
    expect(sessionIdOfPrefix('r1/smoke/x/')).toBeNull();
  });
});
