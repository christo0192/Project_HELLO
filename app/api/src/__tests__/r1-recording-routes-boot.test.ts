/**
 * The recording routes are mounted on the real app and are inert until every lock is open: with the
 * storage secrets unset OR malformed, `createApp()` still boots, the phone and R1 worker routes still
 * mount, and every recording route answers 503 `r1_recording_disabled` behind the worker bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { getR1RecordingConfig } from '../lib/r1/recording/config.js';

const SECRET = 'b'.repeat(32);
const ROOM = 'screening-30000000-0000-4000-8000-000000000001';
const NAMES = [
  'R1_ENABLED', 'WORKER_CONTEXT_SECRET',
  'R1_RECORDING_S3_ENDPOINT', 'R1_RECORDING_S3_REGION', 'R1_RECORDING_S3_BUCKET',
  'R1_RECORDING_S3_ACCESS_KEY_ID', 'R1_RECORDING_S3_SECRET_ACCESS_KEY',
  'R1_RECORDING_MAX_BYTES', 'R1_RECORDING_DOWNLOAD_TTL_SEC', 'R1_RECORDING_RETENTION_DAYS',
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of NAMES) { saved[name] = process.env[name]; delete process.env[name]; }
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = SECRET;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  vi.restoreAllMocks();
});

const app = () => createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
const post = (a: ReturnType<typeof app>, route: string, body: object, bearer: string | false = SECRET) => {
  const call = request(a).post(`/api/internal/r1/recording/${route}`);
  return (bearer === false ? call : call.set('authorization', `Bearer ${bearer}`)).send(body);
};

describe('recording routes on the real app', () => {
  it.each([
    ['unset', {}],
    ['malformed endpoint and region', { R1_RECORDING_S3_ENDPOINT: 'http://not-r2', R1_RECORDING_S3_REGION: 'nowhere' }],
    ['a malformed knob alone', { R1_RECORDING_MAX_BYTES: 'lots' }],
    ['half configured', { R1_RECORDING_S3_BUCKET: 'ik-r1-recordings' }],
  ])('%s: the app boots, the phone and R1 routes mount, and every recording route is 503 r1_recording_disabled', async (_label, env) => {
    Object.assign(process.env, env);
    expect(getR1RecordingConfig().enabled).toBe(false);
    const a = app();
    expect((await request(a).get('/api/health')).status).toBe(200);

    for (const [route, body] of [['prepare', { room: ROOM, mode: 'av' }], ['part-url', { room: ROOM, part_number: 1 }], ['object-url', { room: ROOM, kind: 'audio' }], ['complete', { room: ROOM, layout: 'combined', has_video: true }]] as const) {
      const response = await post(a, route, body);
      expect(response.status, route).toBe(503);
      expect(response.body, route).toEqual({ error: 'r1_recording_disabled' });
      expect(response.headers['cache-control'], route).toBe('no-store');
    }

    // Behind the worker bearer, like every other R1 worker route.
    expect((await post(a, 'prepare', { room: ROOM, mode: 'av' }, false)).status).toBe(401);
    expect((await post(a, 'prepare', { room: ROOM, mode: 'av' }, 'x'.repeat(32))).status).toBe(403);

    // The neighbours are still mounted: the R1 worker routes answer (a bad room is 400) and so do the phone ones.
    const context = await request(a).post('/api/internal/r1/context').set('authorization', `Bearer ${SECRET}`).send({ room: 'nope' });
    expect(context.status).toBe(400);
    expect(context.body).toEqual({ error: 'invalid_r1_room' });
    const phone = await request(a).post('/api/internal/phone/events').send({});
    expect(phone.status).not.toBe(404);
  });

  it('R1 itself off is the same answer', async () => {
    process.env.R1_ENABLED = 'false';
    const response = await post(app(), 'prepare', { room: ROOM, mode: 'av' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'r1_recording_disabled' });
  });
});
