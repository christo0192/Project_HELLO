/**
 * The staff recording routes on the REAL app: they are mounted, authenticated, role-checked, rate
 * limited in the shared `/api/interview-rounds` bucket, and a viewer can read but never write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { MemoryR1ObjectStore, parseMemoryUrl } from '../lib/r1/recording/memory-store.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { createRecordingFakeDb, fixtureId, recordingRow, roundTables, type FakeRecordingDb, type Tables } from './support/r1-recording-fake-db.js';
import { FAKE_S3_ENV } from './support/r1-recording-harness.js';

const live = vi.hoisted(() => ({ db: null as unknown, store: null as unknown }));
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table: string) => (live.db as { client: { from: (t: string) => unknown } }).client.from(table),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({}) },
  },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/r1/recording/store-factory.js', () => ({
  getR1RecordingStore: () => live.store,
  resetR1RecordingStoreCache: () => undefined,
}));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const BEARER = `Bearer ${JWT}`;
const ROUND = fixtureId('a', 1);
const SESSION = fixtureId('b', 1);
const KEYS = recordingKeys(ROUND, SESSION);
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const mp4 = (size: number): Buffer => { const b = Buffer.alloc(size, 1); b.write('ftyp', 4, 'latin1'); return b; };

const user = (appRole: AuthUser['appRole'], id: string): AuthUser => ({ id, email: `${appRole}@example.com`, aal: 'aal2', active: true, appRole, orgId: appRole === 'viewer' ? null : 'org-0000-0000-0000-000000000001' });

const saved: Record<string, string | undefined> = {};
const ENV_NAMES = [...Object.keys(FAKE_S3_ENV), 'RATE_LIMIT_DEFAULT', 'RATE_LIMIT_IP'];
let audits: Array<{ event: string; metadata?: Record<string, unknown> }>;
let db: FakeRecordingDb;
let store: MemoryR1ObjectStore;
let tables: Tables;

function appFor(who: AuthUser) {
  setRateLimitStore(new MemoryRateLimitStore());
  return createApp({ authDeps: { getUser: mockAuthGetUser(who, JWT) }, auditSinkOverride: async (entry: any) => { audits.push(entry); } });
}

beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  Object.assign(process.env, FAKE_S3_ENV);
  process.env.RATE_LIMIT_DEFAULT = '100000';
  process.env.RATE_LIMIT_IP = '100000';
  audits = [];
  tables = {
    ...roundTables(1, { owner: OWNER_ID }),
    interview_round_recordings: [recordingRow(1)],
    r1_recording_purge: [],
    job_dlq: [],
    r1_settings: [{ singleton: true, enabled: true, recording_mode: 'av' }],
  };
  db = createRecordingFakeDb(tables);
  store = new MemoryR1ObjectStore();
  live.db = db;
  live.store = store;
  store.putObject(KEYS.stream, mp4(64), 'video/mp4');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

const url = (round = ROUND, session = SESSION): string => `/api/interview-rounds/${round}/recording?session_id=${session}`;

// The ETag finalize recorded is the one the store reports now.
async function align(): Promise<void> {
  tables.interview_round_recordings![0]!.video_etag = (await store.head(KEYS.stream))!.etag;
}

describe('staff recording routes on the real app', () => {
  it('an unauthenticated request is 401 for both routes', async () => {
    const app = appFor(user('admin', 'admin-1'));
    expect((await request(app).get(url())).status).toBe(401);
    expect((await request(app).get('/api/admin/r1/recording-health')).status).toBe(401);
  });

  it.each([
    ['admin', user('admin', 'admin-1')],
    ['viewer', user('viewer', 'viewer-1')],
    ['the owning interviewer', user('interviewer', OWNER_ID)],
  ])('%s can mint a playback URL (a GET, so even a viewer passes the read-only guard)', async (_label, who) => {
    await align();
    const response = await request(appFor(who)).get(url()).set('Authorization', BEARER);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ state: 'ready', mode: 'single', content_type: 'video/mp4' });
    expect(parseMemoryUrl(response.body.url)).toMatchObject({ op: 'get', key: KEYS.stream });
    expect(audits.filter((e) => e.event === 'recording.download')).toHaveLength(1);
  });

  it('an interviewer who does not own the candidate is refused with the uniform 403 and an access-denied audit', async () => {
    await align();
    const response = await request(appFor(user('interviewer', 'someone-else'))).get(url()).set('Authorization', BEARER);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'access_denied' });
    expect(audits.filter((e) => e.event === 'rbac.access_denied')).toHaveLength(1);
    expect(store.countCalls('presignGet')).toBe(0);
  });

  it('a viewer can read but still cannot write anywhere: a POST to the same path is 403', async () => {
    const viewer = appFor(user('viewer', 'viewer-1'));
    expect((await request(viewer).post(`/api/interview-rounds/${ROUND}/recording`).set('Authorization', BEARER).send({})).status).toBe(403);
    expect((await request(viewer).delete(`/api/interview-rounds/${ROUND}/recording`).set('Authorization', BEARER)).status).toBe(403);
    // And there is no write route at all for anyone else.
    const admin = appFor(user('admin', 'admin-1'));
    expect((await request(admin).post(`/api/interview-rounds/${ROUND}/recording`).set('Authorization', BEARER).send({})).status).toBe(404);
  });

  it('shares the default /api/interview-rounds rate bucket', async () => {
    process.env.RATE_LIMIT_DEFAULT = '3';
    await align();
    const app = appFor(user('admin', 'admin-1'));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await request(app).get(url()).set('Authorization', BEARER)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('the health route is admin-only', async () => {
    const admin = await request(appFor(user('admin', 'admin-1'))).get('/api/admin/r1/recording-health').set('Authorization', BEARER);
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ counts_by_status: expect.any(Object), purge_backlog: 0, finalize_failed: 0 });
    for (const who of [user('viewer', 'viewer-1'), user('interviewer', OWNER_ID)]) {
      const denied = await request(appFor(who)).get('/api/admin/r1/recording-health').set('Authorization', BEARER);
      expect(denied.status, who.appRole).toBe(403);
    }
  });

  it('the rounds list is unchanged for a caller with no R1 data and carries attempts when there is some', async () => {
    tables.interview_rounds![0] = { ...tables.interview_rounds![0], status: 'completed', created_at: '2026-10-12T09:00:00Z', created_by: 'x' };
    tables.candidates = [{ id: fixtureId('c', 1), owner_id: OWNER_ID, status: 'new', decision_use_blocked_at: null }];
    const response = await request(appFor(user('viewer', 'viewer-1'))).get(`/api/candidates/${fixtureId('c', 1)}/interview-rounds`).set('Authorization', BEARER);
    expect(response.status).toBe(200);
    expect(response.body.rounds).toHaveLength(1);
    expect(response.body.rounds[0].attempts).toEqual([
      expect.objectContaining({ session_id: SESSION, attempt_number: 1, recording: expect.objectContaining({ state: 'ready' }) }),
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/r1\/|etag|sha256|upload_id|ik-r1-recordings/);
  });
});
