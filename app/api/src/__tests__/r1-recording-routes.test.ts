/**
 * The worker-facing R1 recording routes (IMPLEMENTER-RULES C4): the gate in order, then prepare,
 * part-url, object-url and complete, driven through the REAL router and gate with an in-memory
 * database and object store. A "worker" PUTs bytes to the presigned URLs the API hands out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getR1RecordingConfig } from '../lib/r1/recording/config.js';
import { createSessionLimiter } from '../lib/r1/recording/gate.js';
import { sanitizeCompleteReport } from '../lib/r1/recording/service.js';
import {
  ROOM_ROUND,
  ROOM_SESSION,
  START_MS,
  WORKER_SECRET,
  liveRecordingTables,
  makeHarness,
  parseMemoryUrl,
  prepared,
  putTo,
  enabledRecordingConfig,
} from './support/r1-recording-harness.js';

const PREFIX = `r1/${ROOM_ROUND}/${ROOM_SESSION}/`;
const SERVER_ONLY_FAILURES = ['worker_lost', 'nothing_uploaded', 'oversize', 'finalize_exhausted', 'object_missing', 'integrity'];

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warnings.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ROUTES = ['prepare', 'part-url', 'object-url', 'complete'] as const;
const validBody = (route: (typeof ROUTES)[number]): Record<string, unknown> =>
  route === 'prepare' ? { mode: 'av' }
    : route === 'part-url' ? { part_number: 1 }
      : route === 'object-url' ? { kind: 'audio_partial' }
        : { layout: 'combined', has_video: true };

describe('the gate, in order', () => {
  it('1. answers 503 r1_recording_disabled on every route, before any database read, while the storage config is off', async () => {
    for (const config of [
      { enabled: false, status: 'disabled' } as const,
      getR1RecordingConfig({ R1_RECORDING_S3_ENDPOINT: 'http://not-r2' }), // invalid
    ]) {
      const h = makeHarness({ config });
      for (const route of ROUTES) {
        const response = await h.post(route, validBody(route));
        expect(response.status, route).toBe(503);
        expect(response.body, route).toEqual({ error: 'r1_recording_disabled' });
      }
      expect(h.db.ops).toEqual([]);
    }
  });

  it('1. R1 itself being off is the same answer', async () => {
    const h = makeHarness({ r1Enabled: false });
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'r1_recording_disabled' });
    expect(h.db.ops).toEqual([]);
  });

  it('2. refuses a malformed room with 400 invalid_r1_room', async () => {
    const h = makeHarness();
    for (const room of ['not-a-room', 'screening-', `screening-${ROOM_SESSION}-x-y-z-extra-extra`, 7, null, undefined]) {
      const response = await h.post('prepare', { mode: 'av', room });
      expect(response.status, String(room)).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_r1_room' });
    }
  });

  it('2. refuses anything that is not a live R1 browser session with 409 r1_session', async () => {
    const cases: Array<[string, (row: Record<string, any>) => void]> = [
      ['a phone (live) session', (row) => { row.mode = 'live'; }],
      ['a session with no interview round', (row) => { row.interview_round_id = null; }],
      ['a completed session', (row) => { row.status = 'completed'; }],
      ['a failed session', (row) => { row.status = 'failed'; }],
      ['a cancelled session', (row) => { row.status = 'cancelled'; }],
    ];
    for (const [label, mutate] of cases) {
      const tables = liveRecordingTables();
      mutate(tables.call_sessions![0]!);
      const h = makeHarness({ tables });
      const response = await h.post('prepare', { mode: 'av' });
      expect(response.status, label).toBe(409);
      expect(response.body, label).toEqual({ error: 'r1_session' });
    }
    const h = makeHarness();
    const unknown = await h.post('prepare', { mode: 'av', room: 'screening-99999999-9999-4999-8999-999999999999' });
    expect(unknown.status).toBe(409);
    // waiting is live too.
    const waiting = liveRecordingTables();
    waiting.call_sessions![0]!.status = 'waiting';
    expect((await makeHarness({ tables: waiting }).post('prepare', { mode: 'av' })).status).toBe(200);
  });

  it('2. a failing session read is a retryable 503 service_unavailable', async () => {
    const h = makeHarness();
    h.db.failOn('call_sessions', 'select');
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
  });

  it('3. recording_mode off (or unreadable) refuses before the consent is even looked at', async () => {
    const off = makeHarness({ tables: liveRecordingTables({ recordingMode: 'off', consents: null }) });
    const response = await off.post('prepare', { mode: 'av' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'r1_recording_disabled' });
    expect(off.db.ops.some((o) => o.table === 'interview_round_consents')).toBe(false);

    const garbage = liveRecordingTables();
    garbage.r1_settings![0]!.recording_mode = 'video'; // not a mode
    expect((await makeHarness({ tables: garbage }).post('prepare', { mode: 'av' })).body).toEqual({ error: 'r1_recording_disabled' });

    const missing = liveRecordingTables();
    missing.r1_settings = [];
    expect((await makeHarness({ tables: missing }).post('prepare', { mode: 'av' })).body).toEqual({ error: 'service_unavailable' });

    const failing = makeHarness();
    failing.db.failOn('r1_settings', 'select');
    expect((await failing.post('prepare', { mode: 'av' })).body).toEqual({ error: 'service_unavailable' });
  });

  it('4. no live consent containing video_audio_recording is 409 r1_consent_withdrawn', async () => {
    const none = makeHarness({ tables: liveRecordingTables({ consents: null }) });
    const withoutItem = makeHarness({ tables: liveRecordingTables({ consents: ['ai_interview', 'ai_evaluation', 'data_processing'] }) });
    const withdrawn = liveRecordingTables();
    withdrawn.interview_round_consents![0]!.withdrawn_at = '2026-10-12T09:00:00.000Z';
    for (const h of [none, withoutItem, makeHarness({ tables: withdrawn })]) {
      for (const route of ROUTES) {
        const response = await h.post(route, validBody(route));
        expect(response.status, route).toBe(409);
        expect(response.body, route).toEqual({ error: 'r1_consent_withdrawn' });
      }
    }
    const failing = makeHarness();
    failing.db.failOn('interview_round_consents', 'select');
    expect((await failing.post('prepare', { mode: 'av' })).body).toEqual({ error: 'service_unavailable' });
  });

  it('4. a withdrawn consent marks an EXISTING recording for erasure and queues the erase job (and does nothing for a session with no recording)', async () => {
    const h = makeHarness();
    await prepared(h);
    h.db.tables.interview_round_consents![0]!.withdrawn_at = '2026-10-12T10:30:00.000Z';
    h.setNow(START_MS + 60_000);
    const response = await h.post('part-url', { part_number: 1 });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'r1_consent_withdrawn' });
    expect(h.row()).toMatchObject({ status: 'uploading', delete_reason: 'consent_withdrawn' });
    expect(h.row()!.delete_requested_at).toBe(new Date(START_MS + 60_000).toISOString());
    expect(h.enqueued).toEqual([{
      name: 'r1.recording.erase',
      payload: { session_id: ROOM_SESSION, reason: 'consent_withdrawn' },
      options: { dedupKey: `r1.recording.erase:session:${ROOM_SESSION}`, maxAttempts: 5 },
    }]);

    const fresh = makeHarness({ tables: liveRecordingTables({ consents: null }) });
    await fresh.post('prepare', { mode: 'av' });
    expect(fresh.enqueued).toEqual([]);
    expect(fresh.db.tables.interview_round_recordings).toEqual([]);
  });

  it('checks the config before the room, the mode before the consent, and the consent before any row check', async () => {
    const configFirst = makeHarness({ config: { enabled: false, status: 'disabled' } });
    expect((await configFirst.post('prepare', { room: 'bad', mode: 'av' })).body).toEqual({ error: 'r1_recording_disabled' });
    const roomBeforeMode = makeHarness({ tables: liveRecordingTables({ recordingMode: 'off' }) });
    expect((await roomBeforeMode.post('prepare', { room: 'bad', mode: 'av' })).body).toEqual({ error: 'invalid_r1_room' });
    const modeBeforeConsent = makeHarness({ tables: liveRecordingTables({ recordingMode: 'off', consents: null }) });
    expect((await modeBeforeConsent.post('prepare', { mode: 'av' })).body).toEqual({ error: 'r1_recording_disabled' });
    const consentBeforeRow = makeHarness({ tables: liveRecordingTables({ consents: null }) });
    expect((await consentBeforeRow.post('part-url', { part_number: 99 })).body).toEqual({ error: 'r1_consent_withdrawn' });
  });

  it('a per-session token bucket answers 429 rate_limited in addition to the database counters', async () => {
    const h = makeHarness({ limiter: createSessionLimiter({ capacity: 2, refillPerSec: 0, now: () => 0 }) });
    expect((await h.post('prepare', { mode: 'av' })).status).toBe(200);
    expect((await h.post('prepare', { mode: 'av' })).status).toBe(200);
    const limited = await h.post('prepare', { mode: 'av' });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
  });

  it('is behind the worker bearer secret', async () => {
    const saved = process.env.WORKER_CONTEXT_SECRET;
    process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
    try {
      const h = makeHarness({ realAuth: true, config: { enabled: false, status: 'disabled' } });
      expect((await h.post('prepare', { mode: 'av' }, { bearer: false })).status).toBe(401);
      expect((await h.post('prepare', { mode: 'av' }, { bearer: 'x'.repeat(32) })).status).toBe(403);
      const ok = await h.post('prepare', { mode: 'av' });
      expect(ok.status).toBe(503);
      expect(ok.body).toEqual({ error: 'r1_recording_disabled' });
      process.env.WORKER_CONTEXT_SECRET = 'short';
      expect((await h.post('prepare', { mode: 'av' })).status).toBe(503); // worker_auth_not_configured
    } finally {
      if (saved === undefined) delete process.env.WORKER_CONTEXT_SECRET;
      else process.env.WORKER_CONTEXT_SECRET = saved;
    }
  });

  it('every answer, success or error, is Cache-Control: no-store', async () => {
    const h = makeHarness();
    const answers = [
      await h.post('prepare', { mode: 'nope' }),
      await h.post('prepare', { mode: 'av' }),
      await h.post('part-url', { part_number: 1 }),
      await h.post('part-url', { part_number: 9 }),
      await h.post('object-url', { kind: 'audio' }),
      await h.post('complete', { layout: 'combined', has_video: true }),
      await h.post('prepare', { mode: 'av', room: 'bad' }),
    ];
    expect(answers.map((a) => a.status)).toEqual([400, 200, 200, 409, 200, 200, 400]);
    for (const answer of answers) expect(answer.headers['cache-control']).toBe('no-store');
    const disabled = await makeHarness({ config: { enabled: false, status: 'disabled' } }).post('prepare', { mode: 'av' });
    expect(disabled.headers['cache-control']).toBe('no-store');
  });
});

describe('prepare', () => {
  it('creates the row and the multipart upload and answers the worker contract (200, no secrets)', async () => {
    const h = makeHarness();
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      mode: 'av',
      content_type: 'video/mp4',
      part_size: 5_242_880,
      max_parts: 60,
      next_part: 1,
      checkpoint_interval_sec: 120,
      url_ttl_sec: 600,
    });
    const row = h.row()!;
    expect(row).toMatchObject({
      status: 'uploading',
      requested_mode: 'av',
      bucket: 'ik-r1-recordings',
      prefix: PREFIX,
      round_id: ROOM_ROUND,
      parts_issued: 0,
      urls_issued: 0,
    });
    expect(row.upload_id).toBe(h.store.openUploadIds()[0]);
    expect(h.store.uploadKey(row.upload_id)).toBe(`${PREFIX}stream.mp4`);
    expect(h.store.uploadContentType(row.upload_id)).toBe('video/mp4');
    expect(h.store.countCalls('createMultipart')).toBe(1);
    // delete_after is fixed now: created + 90 days.
    expect(Date.parse(row.delete_after) - START_MS).toBe(90 * 86_400_000);
    expect(row.created_at).toBe(new Date(START_MS).toISOString());
    // The answer never carries the upload id, a key, the bucket or an ETag.
    const text = JSON.stringify(response.body);
    for (const secret of [row.upload_id, 'r1/', 'ik-r1-recordings', 'stream.mp4', 'etag']) expect(text).not.toContain(secret);
    expect(h.audits).toEqual([{ resource: 'r1_recording', op: 'prepare', session_id: ROOM_SESSION, round_id: ROOM_ROUND, mode: 'av' }]);
  });

  it('an audio recording is created as audio/mp4; asking for LESS than the server mode is fine', async () => {
    const h = makeHarness();
    const response = await h.post('prepare', { mode: 'audio' });
    expect(response.body).toMatchObject({ mode: 'audio', content_type: 'audio/mp4' });
    expect(h.store.uploadContentType(h.row()!.upload_id)).toBe('audio/mp4');
    expect(h.row()!.requested_mode).toBe('audio');
  });

  it('refuses a mode ABOVE the server mode with 409 r1_recording_state and creates nothing', async () => {
    const h = makeHarness({ tables: liveRecordingTables({ recordingMode: 'audio' }) });
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'r1_recording_state' });
    expect(h.db.tables.interview_round_recordings).toEqual([]);
    expect(h.store.countCalls('createMultipart')).toBe(0);
  });

  it('refuses an unknown or missing mode with 400 invalid_recording_request', async () => {
    const h = makeHarness();
    for (const mode of ['video', 'off', 'AV', 1, null, undefined, ['av']]) {
      const response = await h.post('prepare', { mode });
      expect(response.status, String(mode)).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_recording_request' });
    }
    expect(h.db.tables.interview_round_recordings).toEqual([]);
  });

  it('is idempotent: a repeat answers the current state with no second upload', async () => {
    const h = makeHarness();
    const first = await h.post('prepare', { mode: 'av' });
    const again = await h.post('prepare', { mode: 'av' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(h.store.countCalls('createMultipart')).toBe(1);
    await h.post('part-url', { part_number: 1 });
    await h.post('part-url', { part_number: 2 });
    expect((await h.post('prepare', { mode: 'av' })).body).toMatchObject({ next_part: 3 });
    expect(h.store.countCalls('createMultipart')).toBe(1);
  });

  it('a repeat keeps the ORIGINAL mode (the upload was created with that content type)', async () => {
    const h = makeHarness();
    await h.post('prepare', { mode: 'audio' });
    const again = await h.post('prepare', { mode: 'av' });
    expect(again.body).toMatchObject({ mode: 'audio', content_type: 'audio/mp4' });
  });

  it('answers 409 once the recording is finishing or later, and 410 once it is deleted or leaving', async () => {
    for (const status of ['finishing', 'ready', 'partial', 'failed']) {
      const h = makeHarness();
      await prepared(h);
      h.row()!.status = status;
      const response = await h.post('prepare', { mode: 'av' });
      expect(response.status, status).toBe(409);
      expect(response.body, status).toEqual({ error: 'r1_recording_state' });
    }
    const tombstone = makeHarness();
    await prepared(tombstone);
    Object.assign(tombstone.row()!, { status: 'deleted', deleted_at: '2026-10-12T11:00:00.000Z', upload_id: null });
    expect((await tombstone.post('prepare', { mode: 'av' })).body).toEqual({ error: 'r1_recording_deleted' });
    const leaving = makeHarness();
    await prepared(leaving);
    leaving.row()!.delete_requested_at = '2026-10-12T11:00:00.000Z';
    const gone = await leaving.post('prepare', { mode: 'av' });
    expect(gone.status).toBe(410);
    expect(gone.body).toEqual({ error: 'r1_recording_deleted' });
  });

  it('two concurrent prepares make ONE upload and both answer 200', async () => {
    const h = makeHarness();
    const [a, b] = await Promise.all([h.post('prepare', { mode: 'av' }), h.post('prepare', { mode: 'av' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(h.store.countCalls('createMultipart')).toBe(1);
    expect(h.store.openUploadIds()).toHaveLength(1);
    expect(h.db.tables.interview_round_recordings).toHaveLength(1);
    expect(h.row()!.upload_id).toBe(h.store.openUploadIds()[0]);
  });

  it('losing the insert race (another call inserted first) re-reads instead of creating a second upload', async () => {
    const h = makeHarness();
    h.db.hooks.beforeWrite = (table, op) => {
      if (table !== 'interview_round_recordings' || op !== 'insert') return;
      h.db.hooks.beforeWrite = undefined;
      h.db.tables.interview_round_recordings!.push({
        session_id: ROOM_SESSION, round_id: ROOM_ROUND, bucket: 'ik-r1-recordings', prefix: PREFIX, requested_mode: 'av',
        status: 'uploading', upload_id: 'winner-upload', parts_issued: 0, urls_issued: 0, layout: null, has_video: null,
        created_at: new Date(START_MS).toISOString(), updated_at: new Date(START_MS).toISOString(),
        delete_after: new Date(START_MS + 90 * 86_400_000).toISOString(), deleted_at: null, delete_requested_at: null,
      });
    };
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(200);
    expect(h.store.countCalls('createMultipart')).toBe(0);
    expect(h.row()!.upload_id).toBe('winner-upload');
  });

  it('a compare-and-set loser aborts its OWN stray upload and answers the winner\'s state', async () => {
    const h = makeHarness();
    h.db.hooks.beforeWrite = (table, op, patch, matching) => {
      if (table !== 'interview_round_recordings' || op !== 'update' || patch?.upload_id === undefined) return;
      h.db.hooks.beforeWrite = undefined;
      Object.assign(matching[0]!, { upload_id: 'winner-upload', status: 'uploading' });
    };
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(200);
    expect(h.row()!.upload_id).toBe('winner-upload');
    expect(h.store.countCalls('createMultipart')).toBe(1);
    expect(h.store.callsOf('abortMultipart')).toEqual([{ op: 'abortMultipart', key: `${PREFIX}stream.mp4`, uploadId: 'mem-upload-1' }]);
    expect(h.store.openUploadIds()).toEqual([]);
  });

  it('a consent withdrawal that lands while the upload is being created (the compare-and-set sees delete_requested_at) aborts the upload and answers 410', async () => {
    const h = makeHarness();
    h.db.hooks.beforeWrite = (table, op, patch, matching) => {
      if (table !== 'interview_round_recordings' || op !== 'update' || patch?.upload_id === undefined) return;
      h.db.hooks.beforeWrite = undefined;
      matching[0]!.delete_requested_at = '2026-10-12T10:00:01.000Z';
    };
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: 'r1_recording_deleted' });
    expect(h.store.callsOf('abortMultipart')).toHaveLength(1);
    expect(h.store.openUploadIds()).toEqual([]);
    expect(h.row()!.upload_id).toBeNull();
  });

  it('re-claims a row abandoned in preparing for more than 60 s, exactly once between racing callers', async () => {
    const h = makeHarness();
    await h.post('prepare', { mode: 'av' });
    // Rewind to "the first call died after the insert".
    Object.assign(h.row()!, { status: 'preparing', upload_id: null, updated_at: new Date(START_MS - 61_000).toISOString() });
    await h.store.abortMultipart(`${PREFIX}stream.mp4`, 'mem-upload-1');
    const [a, b] = await Promise.all([h.post('prepare', { mode: 'av' }), h.post('prepare', { mode: 'av' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.store.countCalls('createMultipart')).toBe(2); // the original + ONE re-claim
    expect(h.row()).toMatchObject({ status: 'uploading' });
  });

  it('a row that is still being prepared (under 60 s, no upload yet) is waited for, then reported as a retryable 503', async () => {
    const h = makeHarness();
    h.db.tables.interview_round_recordings!.push({
      session_id: ROOM_SESSION, round_id: ROOM_ROUND, bucket: 'ik-r1-recordings', prefix: PREFIX, requested_mode: 'av',
      status: 'preparing', upload_id: null, parts_issued: 0, urls_issued: 0, layout: null, has_video: null,
      created_at: new Date(START_MS - 30_000).toISOString(), updated_at: new Date(START_MS - 30_000).toISOString(),
      delete_after: new Date(START_MS + 90 * 86_400_000).toISOString(), deleted_at: null, delete_requested_at: null,
    });
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
    expect(h.store.countCalls('createMultipart')).toBe(0);
  });

  it('a failed CreateMultipartUpload is a retryable 503 and releases the claim so the retry succeeds at once', async () => {
    const h = makeHarness();
    h.store.failNext('createMultipart', 'unavailable');
    const failed = await h.post('prepare', { mode: 'av' });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'service_unavailable' });
    expect(h.row()).toMatchObject({ status: 'preparing', upload_id: null });
    h.advance(1_000); // the worker retries about a second later
    const retry = await h.post('prepare', { mode: 'av' });
    expect(retry.status).toBe(200);
    expect(h.row()).toMatchObject({ status: 'uploading' });
    expect(h.store.countCalls('createMultipart')).toBe(2);
    expect(h.store.openUploadIds()).toHaveLength(1);
  });

  it('a database error is a retryable 503 and creates no upload', async () => {
    const h = makeHarness();
    h.db.failOn('interview_round_recordings', 'insert');
    const response = await h.post('prepare', { mode: 'av' });
    expect(response.status).toBe(503);
    expect(h.store.countCalls('createMultipart')).toBe(0);
  });

  it('the audit is fail-closed: an outage is a retryable 503, and the retry (idempotent) is audited', async () => {
    let failures = 1;
    const h = makeHarness({ auditFails: () => failures-- > 0 });
    const down = await h.post('prepare', { mode: 'av' });
    expect(down.status).toBe(503);
    expect(h.audits).toEqual([]);
    expect(h.row()).toMatchObject({ status: 'uploading' });
    const retry = await h.post('prepare', { mode: 'av' });
    expect(retry.status).toBe(200);
    expect(h.audits).toHaveLength(1);
    expect(h.store.countCalls('createMultipart')).toBe(1);
  });

  it('delete_after follows R1_RECORDING_RETENTION_DAYS and is fixed per row', async () => {
    const h = makeHarness({ config: enabledRecordingConfig({ R1_RECORDING_RETENTION_DAYS: '30' }) });
    await h.post('prepare', { mode: 'av' });
    const row = h.row()!;
    expect(Date.parse(row.delete_after) - START_MS).toBe(30 * 86_400_000);
    h.setConfig(enabledRecordingConfig({ R1_RECORDING_RETENTION_DAYS: '90' }));
    await h.post('prepare', { mode: 'av' });
    expect(Date.parse(h.row()!.delete_after) - START_MS).toBe(30 * 86_400_000);
  });
});

describe('part-url', () => {
  it('needs a prepared (uploading) recording: 409 before prepare', async () => {
    const h = makeHarness();
    const response = await h.post('part-url', { part_number: 1 });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'r1_recording_state' });
  });

  it('presigns UploadPart for the stream key with a 600 s TTL, advances the counters and lets the worker PUT the part', async () => {
    const h = makeHarness();
    const row = await prepared(h);
    const response = await h.post('part-url', { part_number: 1 });
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['expires_in_sec', 'part_number', 'url']);
    expect(response.body).toMatchObject({ part_number: 1, expires_in_sec: 600 });
    const url = parseMemoryUrl(response.body.url)!;
    expect(url).toMatchObject({ op: 'put-part', key: `${PREFIX}stream.mp4`, uploadId: row.upload_id, partNumber: 1 });
    expect(url.expiresAtSec).toBe(Math.floor(START_MS / 1000) + 600);
    expect(h.row()).toMatchObject({ parts_issued: 1, urls_issued: 1 });

    const put = await putTo(h.store, response.body.url, Buffer.alloc(100, 7));
    expect(put.status).toBe(200);
    expect(await h.store.listParts(`${PREFIX}stream.mp4`, row.upload_id)).toEqual([expect.objectContaining({ n: 1, size: 100 })]);
  });

  it('allows the next part and a re-request of an issued number, never skipping ahead, never above 60', async () => {
    const h = makeHarness();
    await prepared(h);
    for (const n of [3, 2, 61, 100]) expect((await h.post('part-url', { part_number: n })).status, `skip ${n}`).toBe(409);
    expect((await h.post('part-url', { part_number: 1 })).status).toBe(200);
    expect((await h.post('part-url', { part_number: 3 })).status).toBe(409);
    expect((await h.post('part-url', { part_number: 2 })).status).toBe(200);
    expect((await h.post('part-url', { part_number: 1 })).status).toBe(200); // re-request: a re-PUT replaces the part
    expect(h.row()).toMatchObject({ parts_issued: 2, urls_issued: 3 });

    Object.assign(h.row()!, { parts_issued: 59 });
    expect((await h.post('part-url', { part_number: 60 })).status).toBe(200);
    expect(h.row()!.parts_issued).toBe(60);
    const sixtyOne = await h.post('part-url', { part_number: 61 });
    expect(sixtyOne.status).toBe(409);
    expect(sixtyOne.body).toEqual({ error: 'r1_recording_state' });
  });

  it('refuses a bad part_number with 400 invalid_recording_request', async () => {
    const h = makeHarness();
    await prepared(h);
    for (const part_number of [0, -1, 1.5, '1', null, undefined, 10_001, [1]]) {
      const response = await h.post('part-url', { part_number });
      expect(response.status, String(part_number)).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_recording_request' });
    }
    expect(h.row()!.urls_issued).toBe(0);
  });

  it('caps the presigned URLs of one recording at 400', async () => {
    const h = makeHarness();
    await prepared(h);
    Object.assign(h.row()!, { urls_issued: 399, parts_issued: 1 });
    expect((await h.post('part-url', { part_number: 1 })).status).toBe(200);
    expect(h.row()!.urls_issued).toBe(400);
    const capped = await h.post('part-url', { part_number: 1 });
    expect(capped.status).toBe(409);
    expect(capped.body).toEqual({ error: 'r1_recording_state' });
    expect((await h.post('object-url', { kind: 'audio_partial' })).status).toBe(409);
    expect(h.row()!.urls_issued).toBe(400);
  });

  it('two concurrent requests both succeed and the counters count both (compare-and-set, no lost update)', async () => {
    const h = makeHarness();
    await prepared(h);
    const [a, b] = await Promise.all([h.post('part-url', { part_number: 1 }), h.post('part-url', { part_number: 1 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.row()).toMatchObject({ parts_issued: 1, urls_issued: 2 });
  });

  it('retries when the counters moved between the read and the write, and gives up with a retryable 503 if they keep moving', async () => {
    const h = makeHarness();
    await prepared(h);
    let bumps = 1;
    h.db.hooks.beforeWrite = (table, op, patch, matching) => {
      if (table === 'interview_round_recordings' && op === 'update' && patch?.urls_issued !== undefined && bumps-- > 0) matching[0]!.urls_issued += 1;
    };
    const response = await h.post('part-url', { part_number: 1 });
    expect(response.status).toBe(200);
    expect(h.row()!.urls_issued).toBe(2); // the interloper's + ours

    h.db.hooks.beforeWrite = (table, op, patch, matching) => {
      if (table === 'interview_round_recordings' && op === 'update' && patch?.urls_issued !== undefined) matching[0]!.urls_issued += 1;
    };
    const stuck = await h.post('part-url', { part_number: 1 });
    expect(stuck.status).toBe(503);
    expect(stuck.body).toEqual({ error: 'service_unavailable' });
  });

  it('refuses once the recording is finishing (409) or deleted/leaving (410)', async () => {
    const h = makeHarness();
    await prepared(h);
    h.row()!.status = 'finishing';
    expect((await h.post('part-url', { part_number: 1 })).body).toEqual({ error: 'r1_recording_state' });
    h.row()!.status = 'uploading';
    h.row()!.delete_requested_at = '2026-10-12T11:00:00.000Z';
    const leaving = await h.post('part-url', { part_number: 1 });
    expect(leaving.status).toBe(410);
    expect(leaving.body).toEqual({ error: 'r1_recording_deleted' });
  });

  it('a store failure while presigning is a retryable 503 with only a category in the log', async () => {
    const h = makeHarness();
    const row = await prepared(h);
    h.store.failNext('presignPart', 'unavailable');
    const response = await h.post('part-url', { part_number: 1 });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
    const log = warnings.join('\n');
    expect(log).toContain('r1_recording_store_unavailable');
    for (const secret of [row.upload_id, PREFIX, ROOM_SESSION, 'ik-r1-recordings']) expect(log).not.toContain(secret);
  });
});

describe('object-url', () => {
  it.each([
    ['audio_partial', 'audio.partial.ogg', 'audio/ogg'],
    ['audio', 'audio.ogg', 'audio/ogg'],
    ['video', 'video.mp4', 'video/mp4'],
  ])('signs the fixed key and Content-Type of %s', async (kind, file, contentType) => {
    const h = makeHarness();
    await prepared(h);
    const response = await h.post('object-url', { kind });
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['content_type', 'expires_in_sec', 'kind', 'url']);
    expect(response.body).toMatchObject({ kind, content_type: contentType, expires_in_sec: 600 });
    const url = parseMemoryUrl(response.body.url)!;
    expect(url).toMatchObject({ op: 'put', key: `${PREFIX}${file}`, contentType });
    expect(url.expiresAtSec).toBe(Math.floor(START_MS / 1000) + 600);
    expect(h.row()).toMatchObject({ urls_issued: 1, parts_issued: 0 });

    // The worker must send exactly the signed Content-Type.
    expect((await putTo(h.store, response.body.url, 'bytes', { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await putTo(h.store, response.body.url, 'bytes', { 'content-type': contentType })).status).toBe(200);
    expect(h.store.has(`${PREFIX}${file}`)).toBe(true);
  });

  it('the video object of an audio-only recording is audio/mp4', async () => {
    const h = makeHarness();
    await prepared(h, 'audio');
    const response = await h.post('object-url', { kind: 'video' });
    expect(response.body).toMatchObject({ content_type: 'audio/mp4' });
    expect(parseMemoryUrl(response.body.url)).toMatchObject({ contentType: 'audio/mp4' });
  });

  it('never signs a caller-chosen key: kind is an enum', async () => {
    const h = makeHarness();
    await prepared(h);
    for (const kind of ['stream', '../x', 'audio.ogg', 'r1/other/audio.ogg', '', 7, null, undefined, 'VIDEO']) {
      const response = await h.post('object-url', { kind, key: 'r1/other/session/video.mp4' });
      expect(response.status, String(kind)).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_recording_request' });
    }
    expect(h.row()!.urls_issued).toBe(0);
  });

  it('needs an uploading recording, honours the URL cap, and refuses a deleted one', async () => {
    const h = makeHarness();
    expect((await h.post('object-url', { kind: 'audio' })).body).toEqual({ error: 'r1_recording_state' });
    await prepared(h);
    h.row()!.status = 'finishing';
    expect((await h.post('object-url', { kind: 'audio' })).body).toEqual({ error: 'r1_recording_state' });
    h.row()!.status = 'uploading';
    h.row()!.urls_issued = 400;
    expect((await h.post('object-url', { kind: 'audio' })).body).toEqual({ error: 'r1_recording_state' });
    h.row()!.urls_issued = 0;
    h.row()!.delete_requested_at = '2026-10-12T11:00:00.000Z';
    expect((await h.post('object-url', { kind: 'audio' })).status).toBe(410);
  });
});

describe('complete', () => {
  const REPORT = {
    started_at_ms: 1_760_000_000_000,
    duration_ms: 600_000,
    width: 640,
    height: 360,
    fps: 15,
    frames_encoded: 9000,
    frames_dropped: 50,
    camera_off_ms: 1800,
    degraded_at_ms: 300_000,
    stream_bytes: 31_457_280,
    parts_uploaded: 6,
    faststart_uploaded: true,
    audio_final_uploaded: false,
    audio_partial_uploaded: true,
  };

  it('moves the recording to finishing, stores the sanitised report, and the trigger queues exactly one finalize job', async () => {
    const h = makeHarness();
    await prepared(h);
    const response = await h.post('complete', { layout: 'combined', has_video: true, degraded_reason: 'frame_drops', failure_reason: 'upload_failed', report: REPORT });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'finishing' });
    expect(h.row()).toMatchObject({
      status: 'finishing',
      layout: 'combined',
      has_video: true,
      degraded_reason: 'frame_drops',
      failure_reason: 'upload_failed',
      started_at_ms: 1_760_000_000_000,
      duration_ms: 600_000,
      width: 640,
      height: 360,
      fps: 15,
      frames_encoded: 9000,
      frames_dropped: 50,
      camera_off_ms: 1800,
      degraded_at_ms: 300_000,
      reported_stream_bytes: 31_457_280,
      reported_parts: 6,
      finalize_requested_at: new Date(START_MS).toISOString(),
    });
    expect(h.db.tables.job_queue).toEqual([expect.objectContaining({ name: 'r1.recording.finalize', payload: { session_id: ROOM_SESSION }, dedup_key: `r1.recording.finalize:${ROOM_SESSION}` })]);
    expect(h.audits.at(-1)).toEqual({ resource: 'r1_recording', op: 'complete', session_id: ROOM_SESSION, round_id: ROOM_ROUND, layout: 'combined', has_video: true });
  });

  it('drops out-of-window report values to NULL (never a 400, never a 500 from a CHECK) and unknown codes to NULL', async () => {
    const h = makeHarness();
    await prepared(h);
    const response = await h.post('complete', {
      layout: 'split',
      has_video: true,
      failure_reason: 'worker_lost',
      degraded_reason: 'sunspots',
      report: { started_at_ms: 5, duration_ms: 99_999_999_999, width: 5, height: 99_999, fps: 500, frames_encoded: -1, frames_dropped: 1e12, camera_off_ms: 1e15, degraded_at_ms: -3, stream_bytes: 2 ** 50, parts_uploaded: 61, junk: 'x' },
    });
    expect(response.status).toBe(200);
    expect(h.row()).toMatchObject({
      status: 'finishing',
      layout: 'split',
      failure_reason: null,
      degraded_reason: null,
      started_at_ms: null, duration_ms: null, width: null, height: null, fps: null,
      frames_encoded: null, frames_dropped: null, camera_off_ms: null, degraded_at_ms: null,
      reported_stream_bytes: null, reported_parts: null,
    });
  });

  it('accepts only the worker vocabulary of failure reasons, never a server-only one', async () => {
    for (const reason of SERVER_ONLY_FAILURES) {
      const h = makeHarness();
      await prepared(h);
      await h.post('complete', { layout: 'combined', has_video: true, failure_reason: reason });
      expect(h.row()!.failure_reason, reason).toBeNull();
    }
    for (const reason of ['encoder_unavailable', 'encoder_crashed', 'upload_failed', 'spool_disk_full', 'finish_timeout', 'prepare_failed']) {
      const h = makeHarness();
      await prepared(h);
      await h.post('complete', { layout: 'split', has_video: false, failure_reason: reason });
      expect(h.row()!.failure_reason, reason).toBe(reason);
    }
    for (const reason of ['cpu_loop_lag', 'cpu_vad_slow', 'frame_drops', 'upload_backlog', 'encoder_stalled', 'video_unavailable']) {
      const h = makeHarness();
      await prepared(h);
      await h.post('complete', { layout: 'combined', has_video: false, degraded_reason: reason });
      expect(h.row()!.degraded_reason, reason).toBe(reason);
    }
  });

  it('an audio-only recording never has video, whatever the worker claims', async () => {
    const h = makeHarness();
    await prepared(h, 'audio');
    await h.post('complete', { layout: 'combined', has_video: true });
    expect(h.row()!.has_video).toBe(false);
  });

  it('treats a missing or non-object report as empty', async () => {
    for (const report of [undefined, null, 5, 'x', [1, 2]]) {
      const h = makeHarness();
      await prepared(h);
      const response = await h.post('complete', { layout: 'audio_only', has_video: false, report });
      expect(response.status, String(report)).toBe(200);
      expect(h.row()).toMatchObject({ status: 'finishing', layout: 'audio_only', duration_ms: null, started_at_ms: null });
    }
  });

  it('refuses a bad layout or has_video with 400 invalid_recording_request', async () => {
    const h = makeHarness();
    await prepared(h);
    for (const body of [
      { layout: 'merged', has_video: true },
      { layout: 'COMBINED', has_video: true },
      { has_video: true },
      { layout: 'combined', has_video: 'yes' },
      { layout: 'combined' },
      { layout: ['combined'], has_video: true },
    ]) {
      const response = await h.post('complete', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_recording_request' });
    }
    expect(h.row()!.status).toBe('uploading');
  });

  it('is idempotent: a replay on finishing/ready/partial/failed answers 200 with the current status and changes nothing', async () => {
    const h = makeHarness();
    await prepared(h);
    await h.post('complete', { layout: 'combined', has_video: true, report: { duration_ms: 1000 } });
    const after = { ...h.row()! };
    const replay = await h.post('complete', { layout: 'audio_only', has_video: false, report: { duration_ms: 5 } });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ status: 'finishing' });
    expect(h.row()).toEqual(after);
    expect(h.db.tables.job_queue).toHaveLength(1);
    for (const status of ['ready', 'partial', 'failed']) {
      h.row()!.status = status;
      const response = await h.post('complete', { layout: 'combined', has_video: true });
      expect(response.status, status).toBe(200);
      expect(response.body).toEqual({ status });
    }
    expect(h.db.tables.job_queue).toHaveLength(1);
  });

  it('answers 409 without a prepared recording, 410 for a deleted one, and works from preparing', async () => {
    const none = makeHarness();
    expect((await none.post('complete', { layout: 'combined', has_video: true })).body).toEqual({ error: 'r1_recording_state' });

    const gone = makeHarness();
    await prepared(gone);
    Object.assign(gone.row()!, { status: 'deleted', deleted_at: '2026-10-12T11:00:00.000Z', upload_id: null });
    expect((await gone.post('complete', { layout: 'combined', has_video: true })).status).toBe(410);

    const early = makeHarness();
    await prepared(early);
    Object.assign(early.row()!, { status: 'preparing', upload_id: null });
    expect((await early.post('complete', { layout: 'audio_only', has_video: false })).body).toEqual({ status: 'finishing' });
  });

  it('a withdrawal between part-url and complete is 409 r1_consent_withdrawn, marks the recording for erasure and queues the erase job', async () => {
    const h = makeHarness();
    await prepared(h);
    expect((await h.post('part-url', { part_number: 1 })).status).toBe(200);
    h.db.tables.interview_round_consents![0]!.withdrawn_at = '2026-10-12T10:05:00.000Z';
    const response = await h.post('complete', { layout: 'combined', has_video: true });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'r1_consent_withdrawn' });
    expect(h.row()).toMatchObject({ status: 'uploading', delete_reason: 'consent_withdrawn' });
    expect(h.row()!.delete_requested_at).not.toBeNull();
    expect(h.enqueued.map((e) => e.name)).toEqual(['r1.recording.erase']);
    expect(h.db.tables.job_queue).toEqual([]); // no finalize job for a withdrawn recording
  });

  it('the audit is fail-closed: an outage is a retryable 503, the retry answers the replay and is audited', async () => {
    let failures = 0;
    const h = makeHarness({ auditFails: () => failures-- > 0 });
    await prepared(h);
    failures = 1;
    const down = await h.post('complete', { layout: 'combined', has_video: true });
    expect(down.status).toBe(503);
    expect(h.row()!.status).toBe('finishing');
    const retry = await h.post('complete', { layout: 'combined', has_video: true });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ status: 'finishing' });
    expect(h.audits.filter((a) => a.op === 'complete')).toHaveLength(1);
    expect(h.db.tables.job_queue).toHaveLength(1);
  });
});

describe('sanitizeCompleteReport', () => {
  it('keeps every in-window value and drops every out-of-window or non-numeric one to NULL', () => {
    expect(sanitizeCompleteReport({
      started_at_ms: 1_577_836_800_000, duration_ms: 1, width: 16, height: 4096, fps: 29.97, frames_encoded: 0, frames_dropped: 10_000_000,
      camera_off_ms: 86_400_000, degraded_at_ms: 0, stream_bytes: 1_099_511_627_776, parts_uploaded: 60,
    })).toEqual({
      started_at_ms: 1_577_836_800_000, duration_ms: 1, width: 16, height: 4096, fps: 29.97, frames_encoded: 0, frames_dropped: 10_000_000,
      camera_off_ms: 86_400_000, degraded_at_ms: 0, reported_stream_bytes: 1_099_511_627_776, reported_parts: 60,
    });
    const nulls = {
      started_at_ms: null, duration_ms: null, width: null, height: null, fps: null, frames_encoded: null, frames_dropped: null,
      camera_off_ms: null, degraded_at_ms: null, reported_stream_bytes: null, reported_parts: null,
    };
    expect(sanitizeCompleteReport(undefined)).toEqual(nulls);
    expect(sanitizeCompleteReport({ duration_ms: 0, width: 15, height: 4097, fps: 0.5, frames_encoded: -1, camera_off_ms: -1, parts_uploaded: 61, started_at_ms: 4_102_444_800_001 })).toEqual(nulls);
    expect(sanitizeCompleteReport({ duration_ms: '600000', width: NaN, height: Infinity, fps: null, frames_encoded: true, stream_bytes: {} })).toEqual(nulls);
    expect(sanitizeCompleteReport({ duration_ms: 1500.4, fps: 14.999 }).duration_ms).toBe(1500);
    expect(sanitizeCompleteReport({ fps: 14.999 }).fps).toBe(15);
  });
});

describe('a whole recording through the API, as the worker would drive it', () => {
  it('never puts the upload id, a key, the bucket or an ETag in an answer, an audit row or a log line', async () => {
    const h = makeHarness();
    const answers: Array<{ status: number; body: any }> = [];
    answers.push(await h.post('prepare', { mode: 'av' }));
    const uploadId = h.row()!.upload_id as string;
    for (const n of [1, 2]) {
      const part = await h.post('part-url', { part_number: n });
      answers.push(part);
      expect((await putTo(h.store, part.body.url, Buffer.alloc(64, n))).status).toBe(200);
    }
    const ogg = await h.post('object-url', { kind: 'audio_partial' });
    answers.push(ogg);
    const etag = (await putTo(h.store, ogg.body.url, 'OggS', { 'content-type': 'audio/ogg' })).headers.get('etag')!;
    answers.push(await h.post('complete', { layout: 'combined', has_video: true, report: { duration_ms: 1000 } }));
    answers.push(await h.post('complete', { layout: 'combined', has_video: true }));

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200]); // success is always exactly 200
    for (const answer of answers) {
      const { url: _url, ...rest } = answer.body;
      const text = JSON.stringify(rest);
      for (const secret of [uploadId, 'r1/', 'ik-r1-recordings', '.mp4', '.ogg', etag, ROOM_ROUND]) expect(text, secret).not.toContain(secret);
    }
    const everything = JSON.stringify(h.audits) + warnings.join('\n');
    for (const secret of [uploadId, 'https://', 'ik-r1-recordings', '.mp4', '.ogg', etag, 'X-Amz', 'mem-upload']) expect(everything, secret).not.toContain(secret);
  });
});
