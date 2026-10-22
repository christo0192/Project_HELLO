/**
 * `r1.sweep`: retention (A), requested erasures + the withdrawal backstop (B), crash salvage and
 * orphan uploads (C), stuck finalize (D), the purge outbox (E) and the post-delete re-verify (F).
 * Every task is bounded to 50 rows and isolated from the others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuditSink, setAuditSink } from '../lib/audit.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createR1SweepHandler } from '../lib/r1/recording/handlers.js';
import { createR1StorageRuntime } from '../lib/r1/runtime.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import {
  FINALIZE_GIVE_UP_MS,
  FINALIZE_STUCK_MS,
  ORPHAN_UPLOAD_MIN_AGE_MS,
  REVERIFY_WINDOW_MS,
  STALE_LIVE_MS,
  SWEEP_BATCH,
  runR1Sweep,
  sweepHadErrors,
  type R1SweepDeps,
} from '../lib/r1/recording/sweep.js';
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
import { enabledRecordingConfig } from './support/r1-recording-harness.js';

const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (ms: number): string => iso(FIXTURE_NOW_MS - ms);
const HOUR = 3_600_000;
const MIN = 60_000;
const keysOf = (n: number) => recordingKeys(fixtureId('a', n), fixtureId('b', n));
const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };

interface Setup {
  tables: Tables;
  db: FakeRecordingDb;
  store: MemoryR1ObjectStore;
  deps: R1SweepDeps;
  enqueued: Array<{ name: string; payload: any; options: { dedupKey: string; maxAttempts: number } }>;
  logs: string[];
  row: (n: number) => Row;
}

function sweepSetup(rows: Row[], extra: Tables = {}, storeClock: () => number = () => FIXTURE_NOW_MS): Setup {
  const tables: Tables = {
    interview_round_recordings: rows,
    interview_round_consents: [],
    interview_rounds: [],
    legal_holds: [],
    governance_audit: [],
    r1_recording_purge: [],
    job_queue: [],
    ...extra,
  };
  const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
  const store = new MemoryR1ObjectStore({ now: storeClock });
  const enqueued: Setup['enqueued'] = [];
  const logs: string[] = [];
  return {
    tables,
    db,
    store,
    enqueued,
    logs,
    deps: {
      db: db.client as never,
      store,
      bucket: 'ik-r1-recordings',
      now: () => new Date(FIXTURE_NOW_MS),
      enqueue: async (name, payload, options) => { enqueued.push({ name, payload, options }); },
      log: (category) => logs.push(category),
    },
    row: (n) => tables.interview_round_recordings!.find((r) => r.session_id === fixtureId('b', n))!,
  };
}

const consent = (id: string, n: number, decision: string | null, withdrawnAtMs: number | null): Row => ({
  id, round_id: fixtureId('a', n), withdrawn_at: withdrawnAtMs === null ? null : iso(withdrawnAtMs), proof: decision === null ? null : { decision },
});
const hold = (type: string, id: string): Row => ({
  id: `hold-${type}-${id.slice(-3)}`, entity_type: type, entity_id: id, hold_reason: 'case', hold_source: 'court_order',
  placed_by: 'u', placed_at: ago(HOUR), released_at: null, expires_at: null, metadata: null,
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

describe('A. retention', () => {
  it('erases a recording past delete_after and leaves one that is not due', async () => {
    const s = sweepSetup([
      recordingRow(1, { delete_after: ago(60_000) }),
      recordingRow(2, { delete_after: iso(FIXTURE_NOW_MS + 5 * 86_400_000) }),
    ]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.putObject(keysOf(2).stream, mp4(100));
    const report = await runR1Sweep(s.deps);
    expect(report.retention).toEqual({ erased: 1, blocked: 0, errors: 0 });
    expect(s.row(1)).toMatchObject({ status: 'deleted', delete_reason: 'retention', video_key: null });
    expect(s.row(2)).toMatchObject({ status: 'ready', deleted_at: null });
    expect(s.store.objectKeys()).toEqual([keysOf(2).stream]);
    expect(s.tables.governance_audit![0]).toMatchObject({ action: 'data_deleted', entity_id: fixtureId('b', 1) });
  });

  it('works through at most 50 rows a run, oldest first, and finishes on the next run', async () => {
    const rows = Array.from({ length: 55 }, (_v, i) => recordingRow(i + 1, { delete_after: ago((60 - i) * MIN) }));
    const s = sweepSetup(rows);
    const first = await runR1Sweep(s.deps);
    expect(SWEEP_BATCH).toBe(50);
    expect(first.retention.erased).toBe(50);
    expect(s.tables.interview_round_recordings!.filter((r) => r.status === 'deleted')).toHaveLength(50);
    // The five LEFT are the newest-due ones.
    expect(s.tables.interview_round_recordings!.filter((r) => r.status !== 'deleted').map((r) => r.session_id).sort())
      .toEqual([51, 52, 53, 54, 55].map((n) => fixtureId('b', n)));
    const second = await runR1Sweep(s.deps);
    expect(second.retention.erased).toBe(5);
    expect(s.tables.interview_round_recordings!.every((r) => r.status === 'deleted')).toBe(true);
  });

  it('a legal hold keeps it (audited), and the other due recordings are still erased', async () => {
    const s = sweepSetup(
      [recordingRow(1, { delete_after: ago(2 * HOUR) }), recordingRow(2, { delete_after: ago(HOUR) })],
      { ...roundTables(1), legal_holds: [hold('recording', fixtureId('b', 1))] },
    );
    s.store.putObject(keysOf(1).stream, mp4(100));
    const report = await runR1Sweep(s.deps);
    expect(report.retention).toEqual({ erased: 1, blocked: 1, errors: 0 });
    expect(s.row(1)).toMatchObject({ status: 'ready', deleted_at: null });
    expect(s.store.has(keysOf(1).stream)).toBe(true);
    expect(s.row(2).status).toBe('deleted');
    expect(s.tables.governance_audit!.filter((a) => a.action === 'erasure_blocked_legal_hold')).toHaveLength(1);
  });

  it('a recording that cannot be erased now is counted and does not stop the rest', async () => {
    const s = sweepSetup([recordingRow(1, { delete_after: ago(2 * HOUR) }), recordingRow(2, { delete_after: ago(HOUR) })]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    // Row 1's second multipart listing (pass 1 of its purge) fails; row 2 is erased regardless.
    s.store.failNext('listMultipartUploads', 'unavailable', { times: 1, skip: 1 });
    const report = await runR1Sweep(s.deps);
    expect(report.retention.errors + report.retention.erased).toBe(2);
    expect(report.retention.errors).toBe(1);
    expect(sweepHadErrors(report)).toBe(true);
  });
});

describe('B. requested erasures and the withdrawal backstop', () => {
  it('erases a recording the gate marked for deletion, with the reason it recorded, even when not due', async () => {
    const s = sweepSetup([recordingRow(1, { status: 'uploading', delete_requested_at: ago(MIN), delete_reason: 'consent_withdrawn' })]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    const report = await runR1Sweep(s.deps);
    expect(report.requested.erased).toBe(1);
    expect(s.row(1)).toMatchObject({ status: 'deleted', delete_reason: 'consent_withdrawn' });
    expect(s.store.objectKeys()).toEqual([]);
    expect(s.tables.governance_audit![0]).toMatchObject({ action: 'erasure_completed' });
  });

  it('backstop: a recording older than a later withdrawal is erased even though no erase job ran', async () => {
    const s = sweepSetup(
      [recordingRow(1, { created_at: ago(3 * HOUR) })],
      { interview_round_consents: [consent('c1', 1, 'withdrawn', FIXTURE_NOW_MS - HOUR)] },
    );
    s.store.putObject(keysOf(1).stream, mp4(100));
    const report = await runR1Sweep(s.deps);
    expect(report.requested.erased).toBe(1);
    expect(s.row(1)).toMatchObject({ status: 'deleted', delete_reason: 'consent_withdrawn' });
  });

  it('backstop: a superseded consent erases nothing, and a recording made after the withdrawal survives', async () => {
    const s = sweepSetup(
      [recordingRow(1, { created_at: ago(3 * HOUR) }), recordingRow(2, { created_at: ago(10 * MIN), round_id: fixtureId('a', 2) })],
      {
        interview_round_consents: [
          consent('c1', 1, 'superseded', FIXTURE_NOW_MS - HOUR), // round 1: only superseded
          consent('c2', 2, 'withdrawn', FIXTURE_NOW_MS - 2 * HOUR), // round 2: withdrawn BEFORE the recording was made
        ],
      },
    );
    const report = await runR1Sweep(s.deps);
    expect(report.requested.erased).toBe(0);
    expect(s.row(1).status).toBe('ready');
    expect(s.row(2).status).toBe('ready');
  });
});

describe('C. stale live recordings and orphan uploads', () => {
  it('salvages a recording whose worker vanished: finishing + worker_lost, and the trigger queues finalize', async () => {
    const s = sweepSetup([recordingRow(1, { status: 'uploading', layout: null, has_video: null, upload_id: 'up-1', updated_at: ago(STALE_LIVE_MS + MIN), parts_issued: 3, urls_issued: 4, video_key: null })]);
    const report = await runR1Sweep(s.deps);
    expect(report.stale).toMatchObject({ salvaged: 1, failed: 0 });
    expect(s.row(1)).toMatchObject({ status: 'finishing', failure_reason: 'worker_lost', layout: null, finalize_requested_at: iso(FIXTURE_NOW_MS) });
    expect(s.tables.job_queue).toEqual([expect.objectContaining({ name: 'r1.recording.finalize', payload: { session_id: fixtureId('b', 1) } })]);
  });

  it('fails a recording nothing could have been uploaded for, and aborts its upload', async () => {
    const s = sweepSetup([
      recordingRow(1, { status: 'uploading', layout: null, upload_id: null, updated_at: ago(3 * HOUR), parts_issued: 0, urls_issued: 0, video_key: null }),
      recordingRow(2, { status: 'preparing', layout: null, upload_id: null, updated_at: ago(3 * HOUR), parts_issued: 0, urls_issued: 0, video_key: null }),
    ]);
    const uploadId = await s.store.createMultipart(keysOf(1).stream, 'video/mp4');
    s.row(1).upload_id = uploadId;
    const report = await runR1Sweep(s.deps);
    expect(report.stale).toMatchObject({ salvaged: 0, failed: 2 });
    expect(s.row(1)).toMatchObject({ status: 'failed', failure_reason: 'nothing_uploaded', upload_id: null, finalized_at: iso(FIXTURE_NOW_MS) });
    expect(s.row(2)).toMatchObject({ status: 'failed', failure_reason: 'nothing_uploaded' });
    expect(s.store.openUploadIds()).toEqual([]);
    expect(s.tables.job_queue).toEqual([]);
  });

  it('leaves a recent recording and an erase-requested one alone', async () => {
    const s = sweepSetup([
      recordingRow(1, { status: 'uploading', layout: null, upload_id: 'up', updated_at: ago(STALE_LIVE_MS - 5 * MIN) }),
      recordingRow(2, { status: 'uploading', layout: null, upload_id: 'up', updated_at: ago(3 * HOUR), delete_requested_at: ago(HOUR), delete_reason: 'admin' }),
    ]);
    const report = await runR1Sweep(s.deps);
    expect(report.stale).toMatchObject({ salvaged: 0, failed: 0 });
    expect(s.row(1).status).toBe('uploading');
  });

  it('does not write when the row moved between the read and the write (compare-and-set)', async () => {
    const s = sweepSetup([recordingRow(1, { status: 'uploading', layout: null, upload_id: 'up-1', updated_at: ago(3 * HOUR), parts_issued: 2, urls_issued: 2 })]);
    s.db.hooks.beforeWrite = (table, op) => {
      if (table === 'interview_round_recordings' && op === 'update') s.row(1).updated_at = ago(MIN); // the worker came back
    };
    const report = await runR1Sweep(s.deps);
    expect(report.stale).toMatchObject({ salvaged: 0, failed: 0 });
    expect(s.row(1).status).toBe('uploading');
  });

  describe('orphan multipart uploads under r1/', () => {
    // Changed deliberately (incident 2026-10-21, session 482cb480): row 2 used to LOSE its upload here
    // because the listed id differed from `upload_id`. A live row's upload is now never aborted.
    it('aborts the ones of no row or a finished row, never a live row\'s, and never a young or foreign one', async () => {
      let clock = FIXTURE_NOW_MS - 30 * MIN;
      const s = sweepSetup(
        [
          recordingRow(2, { status: 'uploading', layout: null, upload_id: null, updated_at: ago(MIN), video_key: null }), // names a DIFFERENT id
          recordingRow(3, { status: 'uploading', layout: null, upload_id: null, updated_at: ago(MIN), video_key: null }), // names upOwned
          recordingRow(4, { status: 'ready' }), // a finished recording with a leftover upload
        ],
        {},
        () => clock,
      );
      const orphanNoRow = await s.store.createMultipart(keysOf(1).stream, 'video/mp4');
      const liveOther = await s.store.createMultipart(keysOf(2).stream, 'video/mp4');
      const upOwned = await s.store.createMultipart(keysOf(3).stream, 'video/mp4');
      const leftover = await s.store.createMultipart(keysOf(4).stream, 'video/mp4');
      s.row(2).upload_id = 'a-different-upload';
      s.row(3).upload_id = upOwned;
      // A young one (a prepare may still be recording its id) and foreign keys.
      clock = FIXTURE_NOW_MS - 2 * MIN;
      const young = await s.store.createMultipart(keysOf(5).stream, 'video/mp4');
      const smoke = await s.store.createMultipart('r1/smoke/abc/stream.mp4', 'video/mp4');
      const odd = await s.store.createMultipart(`${keysOf(6).prefix}other.bin`, 'application/octet-stream');
      clock = FIXTURE_NOW_MS - 30 * MIN;
      const smokeOld = await s.store.createMultipart('r1/smoke/abc/stream.mp4', 'video/mp4');
      const oddOld = await s.store.createMultipart(`${keysOf(6).prefix}other.bin`, 'application/octet-stream');
      clock = FIXTURE_NOW_MS;

      const report = await runR1Sweep(s.deps);

      expect(report.stale.orphan_uploads_aborted).toBe(2);
      expect(s.store.openUploadIds().sort()).toEqual([liveOther, upOwned, young, smoke, odd, smokeOld, oddOld].sort());
      expect([orphanNoRow, leftover].some((id) => s.store.openUploadIds().includes(id))).toBe(false);
      expect(ORPHAN_UPLOAD_MIN_AGE_MS).toBe(15 * MIN);
    });

    it('never aborts a 30-minute-old upload of a live row (preparing, uploading, finishing), whatever id string the row holds', async () => {
      let clock = FIXTURE_NOW_MS - 30 * MIN;
      const live = { layout: null, has_video: null, video_key: null, updated_at: ago(MIN) };
      const s = sweepSetup(
        [
          recordingRow(1, { ...live, status: 'preparing' }),
          recordingRow(2, { ...live, status: 'uploading' }),
          recordingRow(3, { ...live, status: 'finishing', finalize_requested_at: ago(MIN) }),
          recordingRow(4, { ...live, status: 'uploading' }),
          recordingRow(5, { ...live, status: 'preparing' }),
        ],
        {},
        () => clock,
      );
      const ids: string[] = [];
      for (let n = 1; n <= 5; n += 1) ids.push(await s.store.createMultipart(keysOf(n).stream, 'video/mp4'));
      clock = FIXTURE_NOW_MS;
      // The listing names each upload under a string that is NOT what the row recorded at prepare
      // (an encoding difference, say), except row 4, which matches, and row 5, which recorded none yet.
      s.row(1).upload_id = `${ids[0]}%3D`;
      s.row(2).upload_id = encodeURIComponent(`${ids[1]}+/=`);
      s.row(3).upload_id = 'not-the-listed-id';
      s.row(4).upload_id = ids[3];
      s.row(5).upload_id = null;

      const report = await runR1Sweep(s.deps);

      expect(report.stale).toMatchObject({ orphan_uploads_aborted: 0, errors: 0 });
      expect(s.store.openUploadIds().sort()).toEqual([...ids].sort());
      expect(s.store.callsOf('abortMultipart')).toEqual([]);
      expect((await runR1Sweep(s.deps)).stale.orphan_uploads_aborted).toBe(0); // and on the next run
    });

    it('still aborts a true orphan: no row, a deleted row, or a terminal row that names another upload or none', async () => {
      let clock = FIXTURE_NOW_MS - 30 * MIN;
      const s = sweepSetup(
        [
          // Deleted before the re-verify window (task F), so only the orphan scan can reach its upload.
          recordingRow(2, { status: 'deleted', deleted_at: ago(3 * HOUR), upload_id: null, video_key: null }),
          recordingRow(3, { status: 'ready' }),
          recordingRow(4, { status: 'partial', layout: 'audio_only', has_video: false, upload_id: null }),
          // A terminal row that still names its own upload (finalize gave up) keeps it for the erase job.
          recordingRow(5, { status: 'failed', failure_reason: 'finalize_exhausted', layout: null, video_key: null }),
        ],
        {},
        () => clock,
      );
      const noRow = await s.store.createMultipart(keysOf(1).stream, 'video/mp4');
      const ofDeleted = await s.store.createMultipart(keysOf(2).stream, 'video/mp4');
      const ofReady = await s.store.createMultipart(keysOf(3).stream, 'video/mp4');
      const ofPartial = await s.store.createMultipart(keysOf(4).stream, 'video/mp4');
      const ofExhausted = await s.store.createMultipart(keysOf(5).stream, 'video/mp4');
      clock = FIXTURE_NOW_MS;
      s.row(3).upload_id = 'not-the-listed-id';
      s.row(5).upload_id = ofExhausted;

      const report = await runR1Sweep(s.deps);

      expect(report.stale).toMatchObject({ orphan_uploads_aborted: 4, errors: 0 });
      expect(s.store.openUploadIds()).toEqual([ofExhausted]);
      for (const id of [noRow, ofDeleted, ofReady, ofPartial]) expect(s.store.openUploadIds()).not.toContain(id);
    });
  });
});

describe('C. many orphan uploads', () => {
  it('aborts a bounded batch per run (no error), and the next run takes the rest', async () => {
    let clock = FIXTURE_NOW_MS - 30 * MIN;
    const s = sweepSetup([], {}, () => clock);
    for (let i = 1; i <= 230; i += 1) await s.store.createMultipart(keysOf(i).stream, 'video/mp4');
    clock = FIXTURE_NOW_MS;
    const first = await runR1Sweep(s.deps);
    expect(first.stale).toMatchObject({ orphan_uploads_aborted: 200, errors: 0 });
    expect(s.store.openUploadIds()).toHaveLength(30);
    const second = await runR1Sweep(s.deps);
    expect(second.stale).toMatchObject({ orphan_uploads_aborted: 30, errors: 0 });
    expect(s.store.openUploadIds()).toEqual([]);
  });
});

describe('D. stuck finalize', () => {
  it('re-enqueues a finishing recording idle for 30 minutes (one job: the dedup key), not a fresher one', async () => {
    const s = sweepSetup([
      recordingRow(1, { status: 'finishing', updated_at: ago(FINALIZE_STUCK_MS + MIN), finalize_requested_at: ago(FINALIZE_STUCK_MS + MIN) }),
      recordingRow(2, { status: 'finishing', updated_at: ago(10 * MIN), finalize_requested_at: ago(10 * MIN) }),
    ]);
    const report = await runR1Sweep(s.deps);
    expect(report.finalize).toEqual({ redriven: 1, exhausted: 0, errors: 0 });
    expect(s.enqueued).toEqual([{
      name: 'r1.recording.finalize',
      payload: { session_id: fixtureId('b', 1) },
      options: { dedupKey: `r1.recording.finalize:${fixtureId('b', 1)}`, maxAttempts: 5 },
    }]);
    expect(s.row(1).status).toBe('finishing');
  });

  it('gives up after 3 hours: failed/finalize_exhausted, every object kept for the erase job', async () => {
    const s = sweepSetup([recordingRow(1, { status: 'finishing', layout: null, video_key: null, updated_at: ago(FINALIZE_STUCK_MS + MIN), finalize_requested_at: ago(FINALIZE_GIVE_UP_MS + MIN), failure_reason: 'worker_lost' })]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    const report = await runR1Sweep(s.deps);
    expect(report.finalize).toEqual({ redriven: 0, exhausted: 1, errors: 0 });
    expect(s.row(1)).toMatchObject({ status: 'failed', failure_reason: 'finalize_exhausted' });
    expect(s.enqueued).toEqual([]);
    expect(s.store.has(keysOf(1).stream)).toBe(true);
  });

  it('a failing enqueue is counted and does not stop the other recordings', async () => {
    const s = sweepSetup([
      recordingRow(1, { status: 'finishing', updated_at: ago(2 * HOUR), finalize_requested_at: ago(2 * HOUR) }),
      recordingRow(2, { status: 'finishing', updated_at: ago(2 * HOUR), finalize_requested_at: ago(2 * HOUR) }),
    ]);
    let calls = 0;
    const deps: R1SweepDeps = { ...s.deps, enqueue: async (...args) => { calls += 1; if (calls === 1) throw new Error('queue down'); s.enqueued.push({ name: args[0], payload: args[1], options: args[2] }); } };
    const report = await runR1Sweep(deps);
    expect(report.finalize).toEqual({ redriven: 1, exhausted: 0, errors: 1 });
  });
});

describe('E. the purge outbox', () => {
  const outbox = (n: number, extra: Row = {}): Row => ({
    id: `purge-${n}`, bucket: 'ik-r1-recordings', prefix: keysOf(n).prefix, upload_id: null, reason: 'row_deleted',
    queued_at: ago((100 - n) * MIN), attempts: 0, last_error_code: null, done_at: null, ...extra,
  });

  it('drains a row deleted without a tombstone: objects and uploads gone, verified, then done', async () => {
    const s = sweepSetup([], { r1_recording_purge: [outbox(1, { upload_id: 'x' })] });
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.putObject(keysOf(1).audioPartial, 'ogg');
    s.store.putObject(keysOf(2).stream, mp4(100));
    await s.store.createMultipart(keysOf(1).stream, 'video/mp4');
    const report = await runR1Sweep(s.deps);
    expect(report.purge).toEqual({ done: 1, blocked: 0, failed: 0, errors: 0 });
    expect(s.store.objectKeys()).toEqual([keysOf(2).stream]);
    expect(s.store.openUploadIds()).toEqual([]);
    expect(s.tables.r1_recording_purge![0]).toMatchObject({ done_at: iso(FIXTURE_NOW_MS), attempts: 1, last_error_code: null });
  });

  it('a candidate delete leaves exactly the outbox row the sweep then drains (end to end with the 0127 trigger)', async () => {
    const s = sweepSetup([recordingRow(1)]);
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.tables.interview_round_recordings!.length = 0; // simulate the cascade removing the row...
    s.tables.r1_recording_purge!.push(outbox(1)); // ...which the BEFORE DELETE trigger turns into this row
    await runR1Sweep(s.deps);
    expect(s.store.objectKeys()).toEqual([]);
  });

  it('keeps a row that fails (code on the row, attempts counted) and retries it next run', async () => {
    const s = sweepSetup([], { r1_recording_purge: [outbox(1)] });
    s.store.putObject(keysOf(1).stream, mp4(100));
    s.store.failNext('remove', 'unavailable');
    const first = await runR1Sweep(s.deps);
    expect(first.purge).toMatchObject({ done: 0, failed: 1 });
    expect(s.tables.r1_recording_purge![0]).toMatchObject({ done_at: null, attempts: 1, last_error_code: 'r1_storage_unavailable' });
    const second = await runR1Sweep(s.deps);
    expect(second.purge).toMatchObject({ done: 1, failed: 0 });
    expect(s.tables.r1_recording_purge![0]).toMatchObject({ attempts: 2, last_error_code: null });
  });

  it('never touches the store for a malformed prefix', async () => {
    const s = sweepSetup([], { r1_recording_purge: [outbox(1, { prefix: 'r1/' }), outbox(2, { prefix: '' })] });
    const report = await runR1Sweep(s.deps);
    expect(report.purge).toMatchObject({ done: 0, failed: 2 });
    expect(s.store.callsOf('listPrefix').every((c) => c.prefix === undefined || c.prefix.length > 3)).toBe(true);
    expect(s.store.countCalls('remove')).toBe(0);
  });

  it('works through 50 a run, fresh rows before ones that keep failing', async () => {
    const rows = Array.from({ length: 52 }, (_v, i) => outbox(i + 10, { queued_at: ago((200 - i) * MIN) }));
    rows.unshift(outbox(1, { queued_at: ago(1000 * MIN), attempts: 9, last_error_code: 'r1_storage_unavailable' }));
    const s = sweepSetup([], { r1_recording_purge: rows });
    const report = await runR1Sweep(s.deps);
    expect(report.purge.done).toBe(50);
    const open = s.tables.r1_recording_purge!.filter((r) => r.done_at === null).map((r) => r.id).sort();
    expect(open).toEqual(['purge-1', 'purge-60', 'purge-61'].sort());
  });
});

describe('F. post-delete re-verify', () => {
  it('removes an object a late PUT left under a prefix erased within the last 2 hours, and audits it', async () => {
    const s = sweepSetup([
      recordingRow(1, { status: 'deleted', deleted_at: ago(30 * MIN), video_key: null, delete_reason: 'consent_withdrawn' }),
      recordingRow(2, { status: 'deleted', deleted_at: ago(REVERIFY_WINDOW_MS + 10 * MIN), video_key: null }),
    ]);
    s.store.putObject(keysOf(1).audioPartial, 'late');
    s.store.putObject(keysOf(2).audioPartial, 'late but too old to look at');
    const report = await runR1Sweep(s.deps);
    expect(report.reverify).toEqual({ checked: 1, stragglers_removed: 1, errors: 0 });
    expect(s.store.objectKeys()).toEqual([keysOf(2).audioPartial]);
    expect(s.tables.governance_audit!.filter((a) => a.details?.reason === 'straggler')).toEqual([
      expect.objectContaining({ action: 'data_deleted', entity_id: fixtureId('b', 1) }),
    ]);
  });

  it('also covers a prefix the outbox drained within the window, and aborts a straggler upload', async () => {
    const s = sweepSetup([], { r1_recording_purge: [{
      id: 'purge-1', bucket: 'ik-r1-recordings', prefix: keysOf(1).prefix, upload_id: null, reason: 'row_deleted',
      queued_at: ago(HOUR), attempts: 1, last_error_code: null, done_at: ago(20 * MIN),
    }] });
    await s.store.createMultipart(keysOf(1).stream, 'video/mp4');
    const report = await runR1Sweep(s.deps);
    expect(report.reverify).toMatchObject({ checked: 1, stragglers_removed: 1 });
    expect(s.store.openUploadIds()).toEqual([]);
  });

  it('writes nothing when there is no straggler', async () => {
    const s = sweepSetup([recordingRow(1, { status: 'deleted', deleted_at: ago(MIN), video_key: null })]);
    const report = await runR1Sweep(s.deps);
    expect(report.reverify).toEqual({ checked: 1, stragglers_removed: 0, errors: 0 });
    expect(s.tables.governance_audit).toEqual([]);
    expect(s.store.countCalls('remove')).toBe(0);
  });
});

describe('isolation and the handler', () => {
  it('a task that fails outright does not stop the others, and never throws', async () => {
    const s = sweepSetup([
      recordingRow(1, { status: 'finishing', updated_at: ago(2 * HOUR), finalize_requested_at: ago(2 * HOUR) }),
    ]);
    s.db.failOn('interview_round_recordings', 'select', 1); // task A's read
    const report = await runR1Sweep(s.deps);
    expect(report.retention.errors).toBe(1);
    expect(s.logs).toContain('r1_sweep_retention_error');
    expect(report.finalize.redriven).toBe(1); // D still ran
    expect(sweepHadErrors(report)).toBe(true);
  });

  it('with the object store down, the database-only tasks still do their work', async () => {
    const s = sweepSetup([
      recordingRow(1, { delete_after: ago(HOUR) }),
      recordingRow(2, { status: 'uploading', layout: null, upload_id: 'up', updated_at: ago(3 * HOUR), parts_issued: 1, urls_issued: 1, video_key: null }),
      recordingRow(3, { status: 'finishing', updated_at: ago(2 * HOUR), finalize_requested_at: ago(2 * HOUR) }),
    ]);
    for (const op of ['listPrefix', 'listMultipartUploads', 'head', 'remove', 'abortMultipart'] as const) s.store.failNext(op, 'unavailable', { times: 1000 });
    const report = await runR1Sweep(s.deps);
    expect(report.retention.errors).toBe(1);
    expect(report.stale.salvaged).toBe(1);
    expect(report.stale.errors).toBe(1); // the orphan scan
    expect(report.finalize.redriven).toBe(1);
    expect(s.row(1).status).toBe('ready');
  });

  it('a quiet system costs one multipart listing and no deletes', async () => {
    const s = sweepSetup([recordingRow(1)]);
    const report = await runR1Sweep(s.deps);
    expect(sweepHadErrors(report)).toBe(false);
    expect(s.store.calls.map((c) => c.op)).toEqual(['listMultipartUploads']);
  });

  describe('createR1SweepHandler', () => {
    it('runs the sweep and returns normally even when a task had errors (the cadence is the retry)', async () => {
      const s = sweepSetup([recordingRow(1, { delete_after: ago(HOUR) })]);
      s.store.failNext('listPrefix', 'unavailable', { times: 1000 });
      const seen: unknown[] = [];
      const handler = createR1SweepHandler({
        db: s.db.client as never,
        recordingConfig: () => enabledRecordingConfig(),
        store: () => s.store,
        enqueue: s.deps.enqueue,
        now: s.deps.now,
        log: (category) => s.logs.push(category),
        onResult: (report) => seen.push(report),
      });
      await expect(handler({ id: 'j', name: 'r1.sweep', payload: { bucket: 1 } } as never)).resolves.toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(s.logs).toContain('r1_sweep_had_errors');
    });

    it('waits (defers, no attempt) while the storage config is not enabled', async () => {
      const s = sweepSetup([]);
      const handler = createR1SweepHandler({
        db: s.db.client as never,
        recordingConfig: () => ({ enabled: false, status: 'disabled' }),
        store: () => s.store,
        enqueue: s.deps.enqueue,
      });
      await expect(handler({ id: 'j', name: 'r1.sweep', payload: {} } as never)).resolves.toMatchObject({ outcome: 'defer', reasonCode: 'r1_storage_unconfigured' });
      expect(s.store.calls).toEqual([]);
      expect(s.db.ops).toEqual([]);
    });
  });

  describe('the runtime log line (lib/r1/runtime.ts)', () => {
    /** One sweep through the real `r1-storage` lane; returns the warn lines it wrote. */
    async function sweepThroughRuntime(s: Setup): Promise<string[]> {
      const warnings: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warnings.push(String(line)); });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true); // the info lines (r1_sweep_done, queue events)
      const clock = (): string => iso(FIXTURE_NOW_MS);
      const queue = new Queue(new MemoryAdapter({ clock }), { clock });
      const runtime = createR1StorageRuntime({
        client: s.db.client as never,
        queue,
        now: () => new Date(FIXTURE_NOW_MS),
        recordingConfig: () => enabledRecordingConfig(),
        recordingStore: () => s.store,
      })!;
      await runtime.tickAll(); // enqueues this bucket's r1.sweep and runs it
      await runtime.stop();
      expect(runtime.snapshot().storageJobEvents).toMatchObject({ claimed: 1, completed: 1 });
      return warnings;
    }

    it('reports the orphan scan\'s aborts as r1_sweep_orphan_aborted with the count, never a key or an id', async () => {
      let clock = FIXTURE_NOW_MS - 30 * MIN;
      const s = sweepSetup([recordingRow(3, { status: 'ready' })], {}, () => clock);
      const ids = [
        await s.store.createMultipart(keysOf(1).stream, 'video/mp4'), // no row
        await s.store.createMultipart(keysOf(3).stream, 'video/mp4'), // a finished row's stray
      ];
      clock = FIXTURE_NOW_MS;
      const warnings = await sweepThroughRuntime(s);
      expect(s.store.openUploadIds()).toEqual([]);
      const lines = warnings.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.error_category === 'r1_sweep_orphan_aborted');
      expect(lines).toEqual([expect.objectContaining({ level: 'warn', component: 'r1-runtime', error_type: '2' })]);
      const text = warnings.join('\n');
      for (const secret of [...ids, 'r1/', fixtureId('b', 1), fixtureId('b', 3)]) expect(text).not.toContain(secret);
    });

    it('writes no such line when nothing was aborted (a live row\'s upload is left alone)', async () => {
      let clock = FIXTURE_NOW_MS - 30 * MIN;
      const s = sweepSetup([recordingRow(1, { status: 'uploading', layout: null, video_key: null, updated_at: ago(MIN) })], {}, () => clock);
      const id = await s.store.createMultipart(keysOf(1).stream, 'video/mp4');
      s.row(1).upload_id = `${id}-as-recorded`;
      clock = FIXTURE_NOW_MS;
      const warnings = await sweepThroughRuntime(s);
      expect(s.store.openUploadIds()).toEqual([id]);
      expect(warnings.join('\n')).not.toContain('r1_sweep_orphan_aborted');
    });
  });
});
