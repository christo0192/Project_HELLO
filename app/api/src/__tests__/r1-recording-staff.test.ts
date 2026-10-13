/**
 * Staff access to R1 recordings: the playback mint (`GET /interview-rounds/:id/recording`) and the
 * admin health read. The router is driven directly with an injected database, store, clock and user,
 * so every branch is reachable; `r1-recording-staff-app.test.ts` proves the real app mounts it with
 * the right RBAC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { getR1RecordingConfig } from '../lib/r1/recording/config.js';
import { readRecordingHealth } from '../lib/r1/recording/health.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore, parseMemoryUrl } from '../lib/r1/recording/memory-store.js';
import { resolvePlayback } from '../lib/r1/recording/playback.js';
import { summarizeRecording, withRecordingAttempts } from '../lib/r1/recording/summary.js';
import { createR1RecordingStaffRouter } from '../routes/r1-recording.js';
import {
  FIXTURE_NOW_MS,
  createRecordingFakeDb,
  fixtureId,
  recordingRow,
  roundTables,
  type Row,
  type Tables,
} from './support/r1-recording-fake-db.js';
import { FAKE_S3_ENV, enabledRecordingConfig } from './support/r1-recording-harness.js';

const ROUND = fixtureId('a', 1);
const SESSION = fixtureId('b', 1);
const KEYS = recordingKeys(ROUND, SESSION);
const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (ms: number): string => iso(FIXTURE_NOW_MS - ms);
const MIN = 60_000;
const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };

type Role = 'admin' | 'interviewer' | 'viewer';
interface User { id: string; appRole: Role; active?: boolean }
const ADMIN: User = { id: 'admin-1', appRole: 'admin' };
const VIEWER: User = { id: 'viewer-1', appRole: 'viewer' };
const OWNER: User = { id: 'interviewer-owner', appRole: 'interviewer' };
const OTHER_INTERVIEWER: User = { id: 'interviewer-other', appRole: 'interviewer' };

function staffTables(rows: Row[], extra: Tables = {}): Tables {
  return {
    ...roundTables(1, { owner: OWNER.id }),
    interview_round_recordings: rows,
    r1_recording_purge: [],
    job_dlq: [],
    governance_audit: [],
    ...extra,
  };
}

let audits: AuditEntry[];
let originalSink: ReturnType<typeof getAuditSink>;
beforeEach(() => {
  audits = [];
  originalSink = getAuditSink();
  setAuditSink(async (entry) => { audits.push(entry); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setAuditSink(originalSink);
  vi.restoreAllMocks();
});

interface Rig {
  app: express.Express;
  tables: Tables;
  store: MemoryR1ObjectStore;
  mint: (options?: { round?: string; session?: string | null; raw?: string }) => Promise<request.Response>;
  row: () => Row;
  /** Make the stored ETags the ones the store currently reports (what finalize recorded). */
  alignEtags: () => Promise<void>;
}

function rig(options: { user?: User | null; rows?: Row[]; tables?: Tables; extraEnv?: Record<string, string>; configured?: boolean; keepEtags?: boolean } = {}): Rig {
  const tables = options.tables ?? staffTables(options.rows ?? [recordingRow(1)]);
  const db = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
  const store = new MemoryR1ObjectStore({ now: () => FIXTURE_NOW_MS });
  const config = options.configured === false ? ({ enabled: false, status: 'disabled' } as const) : enabledRecordingConfig(options.extraEnv);
  const router = createR1RecordingStaffRouter({ db: db.client as never, store: () => store, recordingConfig: () => config, now: () => new Date(FIXTURE_NOW_MS) });
  const app = express();
  const user = options.user === undefined ? ADMIN : options.user;
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as any).authUser = { email: null, aal: 'aal2', active: true, orgId: null, ...user };
    next();
  });
  app.use('/api', router);
  const alignEtags = async (): Promise<void> => {
    for (const row of tables.interview_round_recordings ?? []) {
      for (const [keyColumn, etagColumn] of [['video_key', 'video_etag'], ['audio_key', 'audio_etag']] as const) {
        const head = row[keyColumn] ? await store.head(row[keyColumn]) : null;
        if (head && row[etagColumn] !== null) row[etagColumn] = head.etag;
      }
    }
    store.calls.length = 0;
  };
  return {
    app,
    tables,
    store,
    alignEtags,
    // Seeded objects are what finalize verified, unless the test says otherwise (`keepEtags`).
    mint: async (o = {}) => {
      if (!options.keepEtags) await alignEtags();
      const round = o.round ?? ROUND;
      const query = o.raw ?? (o.session === null ? '' : `?session_id=${o.session ?? SESSION}`);
      return request(app).get(`/api/interview-rounds/${round}/recording${query}`);
    },
    row: () => tables.interview_round_recordings![0]!,
  };
}

const SECRET_WORDS = ['upload_id', 'secret-upload', 'bucket', 'etag', 'sha256', 'video_key', 'audio_key', 'prefix', 'r1/', 'ik-r1-recordings', 'memory.invalid/ik'];
function expectNoLeak(body: unknown, allowUrls = false): void {
  const text = JSON.stringify(body, (key, value) => (allowUrls && /(^|_)url$/.test(key) ? '<url>' : value));
  for (const word of SECRET_WORDS) expect(text, word).not.toContain(word);
}

describe('summarizeRecording (what every staff role sees without minting)', () => {
  const NOW = FIXTURE_NOW_MS;
  const summary = (overrides: Row | null) => summarizeRecording(overrides === null ? null : (recordingRow(1, overrides) as never), NOW);

  it('maps the row to the six states and the deleted tombstone', () => {
    expect(summary(null)).toMatchObject({ state: 'none', reason: null, mode: null, retention_until: null });
    expect(summary({ status: 'preparing', updated_at: ago(2 * MIN) }).state).toBe('recording');
    expect(summary({ status: 'uploading', updated_at: ago(10 * MIN) }).state).toBe('recording');
    expect(summary({ status: 'uploading', updated_at: ago(10 * MIN + 1000) }).state).toBe('processing');
    expect(summary({ status: 'finishing' }).state).toBe('processing');
    expect(summary({ status: 'ready' }).state).toBe('ready');
    expect(summary({ status: 'partial' }).state).toBe('partial');
    expect(summary({ status: 'failed' }).state).toBe('failed');
    expect(summary({ status: 'deleted', deleted_at: ago(MIN) }).state).toBe('deleted');
    expect(summary({ status: 'mystery' }).state).toBe('processing'); // an unknown status is never a player
  });

  it('an erase that has been requested is already "deleted": no new access is given', () => {
    const s = summary({ status: 'ready', delete_requested_at: ago(MIN), delete_reason: 'consent_withdrawn' });
    expect(s).toMatchObject({ state: 'deleted', reason: 'consent_withdrawn', deleted_at: null, mode: null, duration_ms: null });
  });

  it.each([
    ['retention', 'retention'], ['consent_withdrawn', 'consent_withdrawn'], ['dsar', 'erasure'], ['row_deleted', 'erasure'], ['admin', 'erasure'], [null, null],
  ])('deleted by %s reads as %s', (deleteReason, reason) => {
    expect(summary({ status: 'deleted', deleted_at: ago(MIN), delete_reason: deleteReason }).reason).toBe(reason);
  });

  it.each([
    ['integrity', 'integrity'], ['oversize', 'oversize'], ['object_missing', 'object_missing'],
    ['worker_lost', 'crash_recovered'], ['encoder_crashed', 'crash_recovered'], ['encoder_stalled', 'crash_recovered'],
    ['upload_failed', 'capture_failed'], ['nothing_uploaded', 'capture_failed'], ['finalize_exhausted', 'capture_failed'], [null, 'capture_failed'],
  ])('failed with %s reads as %s', (failure, reason) => {
    expect(summary({ status: 'failed', failure_reason: failure }).reason).toBe(reason);
  });

  it('describes a playable recording: mode, video, timing, retention, and the reason it is degraded', () => {
    expect(summary({ status: 'ready' })).toEqual({
      state: 'ready', reason: null, mode: 'single', has_video: true, started_at_ms: FIXTURE_NOW_MS - 10 * MIN,
      duration_ms: 540_000, camera_off_ms: 0, degraded_at_ms: null,
      retention_until: iso(FIXTURE_NOW_MS - 10 * MIN + 90 * 86_400_000), deleted_at: null,
    });
    expect(summary({ status: 'partial', layout: 'split' })).toMatchObject({ mode: 'split', reason: 'crash_recovered' });
    expect(summary({ status: 'partial', degraded_reason: 'cpu_loop_lag', degraded_at_ms: 4000 })).toMatchObject({ reason: 'audio_only_degraded', degraded_at_ms: 4000 });
    for (const degraded of ['cpu_vad_slow', 'frame_drops', 'upload_backlog']) expect(summary({ status: 'partial', degraded_reason: degraded }).reason).toBe('audio_only_degraded');
    expect(summary({ status: 'partial', degraded_reason: 'video_unavailable' }).reason).toBe('video_unavailable');
    expect(summary({ status: 'partial', degraded_reason: 'encoder_stalled' }).reason).toBe('crash_recovered');
    expect(summary({ status: 'partial', failure_reason: 'upload_failed' }).reason).toBe('capture_failed');
    expect(summary({ status: 'ready', layout: 'audio_only', has_video: false })).toMatchObject({ has_video: false, mode: 'single' });
  });

  it('coerces database numerics and never carries a URL, key, hash, ETag or upload id', () => {
    const s = summary({ status: 'ready', duration_ms: '540000', camera_off_ms: '12', upload_id: 'secret-upload' });
    expect(s).toMatchObject({ duration_ms: 540_000, camera_off_ms: 12 });
    expectNoLeak(s);
    expect(Object.keys(s).sort()).toEqual(['camera_off_ms', 'deleted_at', 'degraded_at_ms', 'duration_ms', 'has_video', 'mode', 'reason', 'retention_until', 'started_at_ms', 'state'].sort());
  });
});

describe('GET /interview-rounds/:id/recording', () => {
  describe('authorization matrix', () => {
    it.each([
      ['admin', ADMIN, 200],
      ['viewer', VIEWER, 200],
      ['the interviewer who owns the candidate', OWNER, 200],
      ['an interviewer who does not own the candidate', OTHER_INTERVIEWER, 403],
    ])('%s -> %s', async (_label, user, status) => {
      const r = rig({ user });
      r.store.putObject(KEYS.stream, mp4(64));
      const response = await r.mint();
      expect(response.status).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      if (status === 200) expect(response.body.state).toBe('ready');
      else expect(response.body).toEqual({ error: 'access_denied' });
    });

    it('a non-owner gets the SAME 403 for a missing round, and both are audited as access denied', async () => {
      const real = rig({ user: OTHER_INTERVIEWER });
      const missing = rig({ user: OTHER_INTERVIEWER });
      const a = await real.mint();
      const b = await missing.mint({ round: fixtureId('a', 9) });
      expect(a.status).toBe(403);
      expect(b.status).toBe(403);
      expect(b.body).toEqual(a.body);
      const denied = audits.filter((e) => e.event === 'rbac.access_denied');
      expect(denied).toHaveLength(2);
      expect(denied[0]!.metadata).toMatchObject({ reason: 'recording_access_denied' });
    });

    it('an interviewer owns nothing when the candidate has no owner', async () => {
      const r = rig({ user: OWNER, tables: staffTables([recordingRow(1)], { candidates: [{ id: fixtureId('c', 1), owner_id: null }] }) });
      expect((await r.mint()).status).toBe(403);
    });

    it('admin and viewer get a plain 404 for a round that does not exist', async () => {
      for (const user of [ADMIN, VIEWER]) {
        const r = rig({ user });
        const response = await r.mint({ round: fixtureId('a', 9) });
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'not_found' });
      }
    });

    it('an inactive user, or none at all, is refused before any data is read', async () => {
      const inactive = rig({ user: { ...ADMIN, active: false } });
      expect((await inactive.mint()).status).toBe(403);
      const nobody = rig({ user: null });
      expect((await nobody.mint()).status).toBe(403);
    });

    it('a failed ownership lookup is a 503, never a guess', async () => {
      const r = rig({ user: OWNER });
      const db = createRecordingFakeDb(r.tables);
      db.failOn('candidates', 'select');
      const router = createR1RecordingStaffRouter({ db: db.client as never, store: () => r.store, recordingConfig: () => enabledRecordingConfig(), now: () => new Date(FIXTURE_NOW_MS) });
      const app = express();
      app.use((req, _res, next) => { (req as any).authUser = { ...OWNER, active: true, email: null, aal: 'aal2', orgId: null }; next(); });
      app.use('/api', router);
      const response = await request(app).get(`/api/interview-rounds/${ROUND}/recording?session_id=${SESSION}`);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'service_unavailable' });
    });
  });

  describe('identifiers (IDOR)', () => {
    it('a session that belongs to ANOTHER round is a 404, for the admin and for the owner alike', async () => {
      const tables = staffTables([recordingRow(1), recordingRow(2)], {
        interview_rounds: [{ id: fixtureId('a', 1), candidate_id: fixtureId('c', 1) }, { id: fixtureId('a', 2), candidate_id: fixtureId('c', 2) }],
        interview_round_attempts: [
          { session_id: fixtureId('b', 1), round_id: fixtureId('a', 1), attempt_number: 1, counted: true, outcome: null },
          { session_id: fixtureId('b', 2), round_id: fixtureId('a', 2), attempt_number: 1, counted: true, outcome: null },
        ],
        candidates: [{ id: fixtureId('c', 1), owner_id: OWNER.id }, { id: fixtureId('c', 2), owner_id: 'someone-else' }],
      });
      for (const user of [ADMIN, OWNER]) {
        const r = rig({ user, tables });
        const response = await r.mint({ round: fixtureId('a', 1), session: fixtureId('b', 2) });
        expect(response.status, user.id).toBe(404);
        expect(response.body).toEqual({ error: 'not_found' });
        expectNoLeak(response.body);
      }
      // And the owner of candidate 1 cannot reach round 2 at all.
      const r = rig({ user: OWNER, tables });
      expect((await r.mint({ round: fixtureId('a', 2), session: fixtureId('b', 2) })).status).toBe(403);
    });

    it.each([
      ['a non-UUID round', { round: 'not-a-uuid' }],
      ['a non-UUID session', { session: 'nope' }],
      ['no session', { session: null }],
      ['an array of sessions', { raw: `?session_id=${SESSION}&session_id=${SESSION}` }],
      ['an empty session', { raw: '?session_id=' }],
      ['a path-traversal round', { round: '..%2F..%2Fx' }],
    ])('%s -> 400 invalid_id', async (_label, options) => {
      const r = rig();
      const response = await r.mint(options);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_id' });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('accepts an upper-case UUID', async () => {
      const r = rig();
      r.store.putObject(KEYS.stream, mp4(64));
      expect((await r.mint({ round: ROUND.toUpperCase(), session: SESSION.toUpperCase() })).status).toBe(200);
    });
  });

  describe('states without a URL (an expected condition is a 200)', () => {
    it.each([
      ['no recording row', [], 'none'],
      ['a live recording', [recordingRow(1, { status: 'uploading', layout: null, video_key: null, updated_at: ago(MIN) })], 'recording'],
      ['an abandoned one', [recordingRow(1, { status: 'uploading', layout: null, video_key: null, updated_at: ago(30 * MIN) })], 'processing'],
      ['finalizing', [recordingRow(1, { status: 'finishing', layout: 'combined' })], 'processing'],
      ['a failed one', [recordingRow(1, { status: 'failed', failure_reason: 'upload_failed' })], 'failed'],
      ['an erased one', [recordingRow(1, { status: 'deleted', deleted_at: ago(MIN), delete_reason: 'retention', video_key: null })], 'deleted'],
      ['one awaiting erasure', [recordingRow(1, { delete_requested_at: ago(MIN), delete_reason: 'consent_withdrawn' })], 'deleted'],
    ])('%s -> state %s, no URL, the object store untouched', async (_label, rows, state) => {
      const r = rig({ rows: rows as Row[] });
      r.store.putObject(KEYS.stream, mp4(64));
      r.store.calls.length = 0;
      const response = await r.mint();
      expect(response.status).toBe(200);
      expect(response.body.state).toBe(state);
      for (const key of ['url', 'video_url', 'audio_url', 'content_type', 'expires_in_sec']) expect(response.body, key).not.toHaveProperty(key);
      expect(r.store.calls).toEqual([]);
      expect(audits.filter((e) => e.event === 'recording.download')).toEqual([]);
      expectNoLeak(response.body);
    });
  });

  describe('a ready or partial recording', () => {
    it('mints a presigned GET for the single MP4: url + content_type + expiry, a signed response-content-type, audited without the URL', async () => {
      const r = rig({ user: VIEWER });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      r.tables.interview_round_recordings![0]!.video_etag = (await r.store.head(KEYS.stream))!.etag;
      const response = await r.mint();
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({ state: 'ready', mode: 'single', has_video: true, content_type: 'video/mp4', expires_in_sec: 300, duration_ms: 540_000 });
      const url = parseMemoryUrl(response.body.url);
      expect(url).toMatchObject({ op: 'get', key: KEYS.stream, responseContentType: 'video/mp4' });
      expect(url!.expiresAtSec).toBe(Math.floor(FIXTURE_NOW_MS / 1000) + 300);
      expect(response.body).not.toHaveProperty('video_url');
      expectNoLeak(response.body, true);

      const download = audits.filter((e) => e.event === 'recording.download');
      expect(download).toHaveLength(1);
      // The audit redactor masks the tail of UUIDs in metadata; the ids stay attributable by their prefix.
      expect(download[0]).toMatchObject({ userId: 'viewer-1', userRole: 'viewer', metadata: { resource: 'r1_recording', session_id: expect.stringMatching(/^30000000-0000-4000-8000-/), round_id: expect.stringMatching(/^20000000-0000-4000-8000-/), ttl_sec: 300, role: 'viewer', requested_by: 'viewer-1' } });
      expect(JSON.stringify(download[0])).not.toMatch(/r1\/|memory\.invalid|https?:/);
    });

    it('uses the configured TTL, and an audio-only request is audio/mp4', async () => {
      const r = rig({ rows: [recordingRow(1, { requested_mode: 'audio', video_content_type: 'audio/mp4', has_video: false })], extraEnv: { R1_RECORDING_DOWNLOAD_TTL_SEC: '120' } });
      r.store.putObject(KEYS.stream, mp4(64), 'audio/mp4');
      const response = await r.mint();
      expect(response.body).toMatchObject({ has_video: false, content_type: 'audio/mp4', expires_in_sec: 120 });
      expect(parseMemoryUrl(response.body.url)).toMatchObject({ responseContentType: 'audio/mp4', expiresAtSec: Math.floor(FIXTURE_NOW_MS / 1000) + 120 });
    });

    it('an audio-only layout (OGG only) is one URL with audio/ogg', async () => {
      const r = rig({ rows: [recordingRow(1, { layout: 'audio_only', has_video: false, video_key: null, video_bytes: null, video_etag: null, audio_key: KEYS.audio, audio_bytes: 5, audio_etag: null, status: 'partial' })] });
      r.store.putObject(KEYS.audio, 'OggS', 'audio/ogg');
      const response = await r.mint();
      expect(response.body).toMatchObject({ state: 'partial', mode: 'single', content_type: 'audio/ogg' });
      expect(parseMemoryUrl(response.body.url)).toMatchObject({ key: KEYS.audio, responseContentType: 'audio/ogg' });
    });

    it('a recovered (split) recording returns video_url + audio_url and says why', async () => {
      const r = rig({ rows: [recordingRow(1, { status: 'partial', layout: 'split', audio_key: KEYS.audioPartial, audio_bytes: 7, audio_etag: null })] });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      r.store.putObject(KEYS.audioPartial, 'OggS', 'audio/ogg');
      const response = await r.mint();
      expect(response.body).toMatchObject({ state: 'partial', mode: 'split', reason: 'crash_recovered', video_content_type: 'video/mp4', audio_content_type: 'audio/ogg', expires_in_sec: 300 });
      expect(response.body).not.toHaveProperty('url');
      expect(parseMemoryUrl(response.body.video_url)).toMatchObject({ key: KEYS.stream, responseContentType: 'video/mp4' });
      expect(parseMemoryUrl(response.body.audio_url)).toMatchObject({ key: KEYS.audioPartial, responseContentType: 'audio/ogg' });
      expectNoLeak(response.body, true);
    });

    it('HEADs before it signs, and a freshly minted URL really serves the object', async () => {
      const r = rig();
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      const response = await r.mint();
      const ops = r.store.calls.map((c) => c.op);
      expect(ops.indexOf('head')).toBeGreaterThanOrEqual(0);
      expect(ops.indexOf('head')).toBeLessThan(ops.indexOf('presignGet'));
      const fetched = await r.store.httpFetch(response.body.url, { headers: { range: 'bytes=0-7' } });
      expect(fetched.status).toBe(206);
      expect(fetched.headers.get('content-type')).toBe('video/mp4');
    });

    it('a stored ETag that matches is accepted whatever its quoting', async () => {
      const r = rig({ keepEtags: true });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      const etag = (await r.store.head(KEYS.stream))!.etag;
      r.tables.interview_round_recordings![0]!.video_etag = etag.replace(/"/g, '');
      expect((await r.mint()).body.state).toBe('ready');
    });
  });

  describe('verification before a URL', () => {
    it('a missing object quarantines the recording (failed/object_missing), audits it, and gives no URL, now or later', async () => {
      const r = rig({ keepEtags: true });
      const response = await r.mint();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ state: 'failed', reason: 'object_missing' });
      expect(response.body).not.toHaveProperty('url');
      expect(r.row()).toMatchObject({ status: 'failed', failure_reason: 'object_missing' });
      const quarantined = audits.filter((e) => e.event === 'recording.quarantined');
      expect(quarantined).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ resource: 'r1_recording', session_id: expect.stringMatching(/^30000000-0000-4000-8000-/), reason: 'object_missing', role: 'admin' }) })]);
      const callsBefore = r.store.calls.length;
      const again = await r.mint();
      expect(again.body.state).toBe('failed');
      expect(r.store.calls.length).toBe(callsBefore);
      expect(audits.filter((e) => e.event === 'recording.quarantined')).toHaveLength(1);
    });

    it('an ETag that is not the one finalize verified quarantines it (failed/integrity)', async () => {
      const r = rig({ rows: [recordingRow(1, { video_etag: '"the-original"' })], keepEtags: true });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      const response = await r.mint();
      expect(response.body).toMatchObject({ state: 'failed', reason: 'integrity' });
      expect(response.body).not.toHaveProperty('url');
      expect(r.row()).toMatchObject({ status: 'failed', failure_reason: 'integrity' });
      expect(audits.filter((e) => e.event === 'recording.quarantined')).toHaveLength(1);
    });

    it('every deliverable of a split recording is verified: a missing OGG quarantines the whole recording', async () => {
      const r = rig({ rows: [recordingRow(1, { status: 'partial', layout: 'split', audio_key: KEYS.audioPartial, audio_etag: null })] });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      const response = await r.mint();
      expect(response.body).toMatchObject({ state: 'failed', reason: 'object_missing' });
      expect(response.body).not.toHaveProperty('video_url');
    });

    it('a row that names no deliverable, or one outside its prefix, is an integrity failure, not a URL', async () => {
      const noKey = rig({ rows: [recordingRow(1, { video_key: null })] });
      expect((await noKey.mint()).body).toMatchObject({ state: 'failed', reason: 'integrity' });
      const stray = rig({ rows: [recordingRow(1, { video_key: 'r1/other/place/stream.mp4' })] });
      stray.store.putObject('r1/other/place/stream.mp4', mp4(8));
      const response = await stray.mint();
      expect(response.body).toMatchObject({ state: 'failed', reason: 'integrity' });
      expect(stray.store.countCalls('presignGet')).toBe(0);
    });

    it('a HEAD that cannot be answered is a 503 r1_recording_unavailable: never a URL, never a state change', async () => {
      const r = rig({ keepEtags: true });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      r.store.failNext('head', 'unavailable');
      const response = await r.mint();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_recording_unavailable' });
      expect(r.row().status).toBe('ready');
      expect(audits.filter((e) => e.event === 'recording.quarantined')).toEqual([]);
    });

    it('a presign that fails is the same 503', async () => {
      const r = rig();
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      r.store.failNext('presignGet', 'access_denied');
      const response = await r.mint();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_recording_unavailable' });
    });

    it('an unconfigured store is 503 r1_recording_unavailable for a playable recording, and still a 200 for the rest', async () => {
      const playable = rig({ configured: false });
      const unavailable = await playable.mint();
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toEqual({ error: 'r1_recording_unavailable' });
      const failed = rig({ configured: false, rows: [recordingRow(1, { status: 'failed', failure_reason: 'upload_failed' })] });
      expect((await failed.mint()).body.state).toBe('failed');
    });

    it('the quarantine audit is FAIL-CLOSED: if it cannot be written nothing changes and the answer is a 503', async () => {
      setAuditSink(async (entry) => { if (entry.event === 'recording.quarantined') throw new Error('sink down'); audits.push(entry); });
      const r = rig();
      const response = await r.mint();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'service_unavailable' });
      expect(r.row()).toMatchObject({ status: 'ready', failure_reason: null });
    });

    it('the download audit is FAIL-OPEN: a dead sink never costs the viewer the recording', async () => {
      setAuditSink(async () => { throw new Error('sink down'); });
      const r = rig();
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      const response = await r.mint();
      expect(response.status).toBe(200);
      expect(response.body.url).toBeTruthy();
    });

    it('losing the quarantine race to an erase answers whatever the row is now', async () => {
      const r = rig();
      const db = createRecordingFakeDb(r.tables, { now: () => FIXTURE_NOW_MS });
      db.hooks.beforeWrite = (table, op) => {
        if (table === 'interview_round_recordings' && op === 'update') Object.assign(r.row(), { status: 'deleted', deleted_at: ago(1), video_key: null });
      };
      const result = await resolvePlayback(
        { db: db.client as never, recordingConfig: () => enabledRecordingConfig(), store: () => r.store, now: () => new Date(FIXTURE_NOW_MS), auditDownload: async () => undefined, auditQuarantine: async () => undefined },
        { id: 'admin-1', appRole: 'admin', active: true },
        ROUND,
        SESSION,
      );
      expect(result).toMatchObject({ kind: 'ok', body: { state: 'deleted' } });
    });
  });

  it('never exposes a secret in any state it can return', async () => {
    const rows: Row[][] = [
      [recordingRow(1, { upload_id: 'secret-upload' })],
      [recordingRow(1, { status: 'uploading', upload_id: 'secret-upload', updated_at: ago(MIN) })],
      [recordingRow(1, { status: 'deleted', deleted_at: ago(1), upload_id: null, video_key: null })],
    ];
    for (const set of rows) {
      const r = rig({ rows: set });
      r.store.putObject(KEYS.stream, mp4(64), 'video/mp4');
      expectNoLeak((await r.mint()).body, true);
    }
  });
});

describe('the rounds list gains attempts[]', () => {
  const db = (tables: Tables) => createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });

  it('adds one summary per attempt, ordered by attempt number, with no secret column read', async () => {
    const tables: Tables = {
      interview_round_attempts: [
        { session_id: fixtureId('b', 2), round_id: ROUND, attempt_number: 2, counted: false, outcome: 'candidate_left' },
        { session_id: SESSION, round_id: ROUND, attempt_number: 1, counted: true, outcome: 'complete' },
      ],
      interview_round_recordings: [recordingRow(1, { upload_id: 'secret-upload' })],
    };
    const fake = db(tables);
    const result = await withRecordingAttempts(fake.client as never, [{ id: ROUND, status: 'completed' }, { id: fixtureId('a', 5), status: 'invited' }], FIXTURE_NOW_MS);
    const first = result[0] as any;
    expect(first.status).toBe('completed');
    expect(first.attempts.map((a: any) => [a.attempt_number, a.counted, a.outcome, a.recording.state])).toEqual([[1, true, 'complete', 'ready'], [2, false, 'candidate_left', 'none']]);
    expect((result[1] as any).attempts).toEqual([]);
    expectNoLeak(result);
    // One query on the attempts, one on the recordings: no N+1.
    expect(fake.ops.filter((o) => o.table === 'interview_round_attempts')).toHaveLength(1);
    expect(fake.ops.filter((o) => o.table === 'interview_round_recordings')).toHaveLength(1);
  });

  it('reads only the columns a summary needs: no key, hash, ETag, bucket, prefix or upload id is ever selected', async () => {
    const fake = db({ interview_round_attempts: [], interview_round_recordings: [recordingRow(1, { upload_id: 'secret-upload' })] });
    const selected: Array<[string, string]> = [];
    const spying = {
      from: (table: string) => {
        const query = fake.client.from(table);
        const select = query.select.bind(query);
        query.select = (columns?: string, options?: unknown) => { selected.push([table, String(columns)]); return select(columns, options); };
        return query;
      },
    };
    await withRecordingAttempts(spying as never, [{ id: ROUND }], FIXTURE_NOW_MS);
    const recordingColumns = selected.find(([table]) => table === 'interview_round_recordings')![1];
    expect(recordingColumns).not.toBe('*');
    for (const secret of ['upload_id', 'video_key', 'audio_key', 'etag', 'sha256', 'bucket', 'prefix']) expect(recordingColumns, secret).not.toContain(secret);
    expect(recordingColumns.split(',')).toEqual(expect.arrayContaining(['session_id', 'status', 'layout', 'delete_after']));
  });

  it('never breaks the list: if either read fails the rounds come back unchanged, without attempts', async () => {
    for (const table of ['interview_round_attempts', 'interview_round_recordings']) {
      const fake = db({ interview_round_attempts: [], interview_round_recordings: [] });
      fake.failOn(table, 'select');
      const result = await withRecordingAttempts(fake.client as never, [{ id: ROUND, status: 'completed' }], FIXTURE_NOW_MS);
      expect(result).toEqual([{ id: ROUND, status: 'completed' }]);
    }
    const empty = db({});
    await expect(withRecordingAttempts(empty.client as never, [], FIXTURE_NOW_MS)).resolves.toEqual([]);
    expect(empty.ops).toEqual([]);
  });
});

describe('GET /admin/r1/recording-health', () => {
  function healthRig(user: User = ADMIN) {
    const rows = [
      recordingRow(1, { status: 'ready' }),
      recordingRow(2, { status: 'ready', delete_after: ago(2 * 3_600_000) }), // overdue
      recordingRow(3, { status: 'ready', delete_after: ago(10 * MIN) }), // within the grace
      recordingRow(4, { status: 'uploading', created_at: ago(3 * 3_600_000) }),
      recordingRow(5, { status: 'finishing', created_at: ago(20 * MIN) }),
      recordingRow(6, { status: 'failed', delete_after: ago(5 * 3_600_000) }), // overdue too
      recordingRow(7, { status: 'deleted', deleted_at: ago(MIN), delete_after: ago(5 * 3_600_000) }), // erased: not overdue
    ];
    return rig({
      user,
      tables: staffTables(rows, {
        r1_recording_purge: [{ id: 'p1', done_at: null }, { id: 'p2', done_at: null }, { id: 'p3', done_at: ago(MIN) }],
        job_dlq: [{ id: 'd1', name: 'r1.recording.finalize' }, { id: 'd2', name: 'r1.assessment' }, { id: 'd3', name: 'r1.recording.finalize' }],
      }),
    });
  }

  it('reports counts and ages for an admin, and nothing identifying', async () => {
    const response = await request(healthRig().app).get('/api/admin/r1/recording-health');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      counts_by_status: { preparing: 0, uploading: 1, finishing: 1, ready: 3, partial: 0, failed: 1, deleted: 1 },
      oldest_live_seconds: 3 * 3600,
      retention_overdue: 2,
      purge_backlog: 2,
      finalize_failed: 2,
    });
  });

  it('oldest_live_seconds is null when nothing is in flight', async () => {
    const r = rig({ tables: staffTables([recordingRow(1)]) });
    const response = await request(r.app).get('/api/admin/r1/recording-health');
    expect(response.body).toMatchObject({ oldest_live_seconds: null, purge_backlog: 0, finalize_failed: 0, retention_overdue: 0 });
  });

  it.each([['viewer', VIEWER], ['interviewer', OWNER]])('is admin-only: a %s gets 403', async (_label, user) => {
    const response = await request(healthRig(user).app).get('/api/admin/r1/recording-health');
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('counts_by_status');
  });

  it('a failing read is a 503 service_unavailable, not a healthy zero', async () => {
    const tables = healthRig().tables;
    for (const [table, operation] of [['interview_round_recordings', 'select'], ['r1_recording_purge', 'select'], ['job_dlq', 'select']] as const) {
      const failing = createRecordingFakeDb(tables, { now: () => FIXTURE_NOW_MS });
      failing.failOn(table, operation, 100);
      await expect(readRecordingHealth(failing.client as never, FIXTURE_NOW_MS), table).rejects.toThrow('r1_recording_db_error');
      const app = express();
      app.use((req, _res, next) => { (req as any).authUser = { ...ADMIN, active: true }; next(); });
      app.use('/api', createR1RecordingStaffRouter({ db: failing.client as never }));
      const response = await request(app).get('/api/admin/r1/recording-health');
      expect(response.status, table).toBe(503);
      expect(response.body, table).toEqual({ error: 'service_unavailable' });
    }
  });
});

describe('the default config the router reads', () => {
  it('uses the shared fake storage environment', () => {
    expect(getR1RecordingConfig({ ...FAKE_S3_ENV }).enabled).toBe(true);
  });
});
