/**
 * The R1 candidate surface through the REAL application: public by exact path,
 * authenticated by the link inside the route, rate limited by its own buckets,
 * and never reaching the legacy browser or recruiter surfaces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ db: { current: null as any } }));
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table: string) => mocks.db.current.from(table),
    rpc: (fn: string, args: unknown) => mocks.db.current.rpc(fn, args),
    storage: { from: () => ({}) },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

process.env.RATE_LIMIT_IP = '100000';
process.env.RATE_LIMIT_DEFAULT = '100000';

import { createApp } from '../app.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import {
  R1_CANDIDATE_LIMIT,
  R1_CANDIDATE_START_LIMIT,
  r1StartKey,
} from '../lib/r1/rate-limit.js';
import { createFakeDb } from './support/r1-candidate-fake-db.js';
import { LINK, WORKER_SECRET, seedTables, sha256 } from './support/r1-candidate-harness.js';

function appWith(tables = seedTables()) {
  mocks.db.current = createFakeDb({ tables });
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    auditSinkOverride: async () => undefined,
  });
}

beforeEach(() => {
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  setRateLimitStore(new MemoryRateLimitStore());
});

describe('R1 candidate routes through createApp', () => {
  it('are reachable without a bearer token and answer from their own authentication', async () => {
    const app = appWith();
    const status = await request(app).post('/api/r1/status').send({ token: 'b2'.repeat(32) });
    expect(status.status).toBe(404);
    expect(status.body).toEqual({ error: 'r1_link_invalid_or_expired' });

    const known = await request(app).post('/api/r1/status').send({ token: LINK });
    expect(known.status).toBe(200);
    expect(known.headers['cache-control']).toBe('no-store');

    const template = await request(app).post('/api/r1/consent-template').send({ token: LINK });
    expect(template.status).toBe(200);
    expect(template.body.version).toBe('002');
    expect(template.body.locale).toBe('en-IN');

    for (const [path, body] of [
      ['/api/r1/consent', {
        token: 'b2'.repeat(32),
        template_version: '002',
        consents: [],
        status: 'declined',
      }],
      ['/api/r1/consent/withdraw', { token: 'b2'.repeat(32) }],
      ['/api/r1/preflight', { token: 'b2'.repeat(32) }],
      ['/api/r1/attempts', { token: 'b2'.repeat(32) }],
      ['/api/r1/exchange', { attempt_token: 'junk', nonce: 'c3'.repeat(32) }],
    ] as const) {
      const response = await request(app).post(path).send(body);
      expect(response.status, path).not.toBe(401);
      expect(response.body?.error?.type, path).not.toBe('authentication_error');
    }
  });

  it('keeps near misses behind recruiter authentication (401)', async () => {
    const app = appWith();
    const misses: Array<[string, string]> = [
      ['get', '/api/r1/status'],
      ['get', '/api/r1/consent-template'],
      ['post', '/api/r1/status/extra'],
      ['post', '/api/r1/unknown'],
      ['get', '/api/r1/exchange'],
      ['put', '/api/r1/preflight'],
    ];
    for (const [method, path] of misses) {
      const response = await (request(app) as any)[method](path).send({});
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.body.error.type).toBe('authentication_error');
    }
  });

  it('never exposes the worker-only routes or the recruiter surface to a link holder', async () => {
    const app = appWith();
    for (const path of [
      '/api/internal/r1/attempt-outcome',
      '/api/internal/r1/context',
      '/api/internal/r1/usage',
    ]) {
      const response = await request(app).post(path).send({ attempt_id: 'x', outcome: 'complete' });
      expect([401, 403]).toContain(response.status);
    }
    const recruiter = await request(app)
      .post('/api/candidates/10000000-0000-4000-8000-0000000000b1/interview-rounds')
      .send({ india_location_attested: true });
    expect(recruiter.status).toBe(401);
  });

  it('answers 400, never a server error, for malformed candidate bodies', async () => {
    const app = appWith();
    const paths = [
      'status',
      'consent-template',
      'consent',
      'consent/withdraw',
      'preflight',
      'attempts',
      'exchange',
    ];
    for (const path of paths) {
      const response = await request(app).post(`/api/r1/${path}`).send({ token: 'short' });
      expect(response.status, path).toBe(400);
    }
    const malformed = await request(app)
      .post('/api/r1/status')
      .set('content-type', 'application/json')
      .send('{"token":');
    expect(malformed.status).toBe(400);
  });
});

describe('R1 rate limiter', () => {
  // The bucket refills continuously. Freeze the clock so a slow machine cannot
  // refill a token between the last allowed request and the first refused one.
  let clock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  });
  afterEach(() => {
    clock.mockRestore();
  });

  it('throttles a client IP on its own bucket without touching other lanes', async () => {
    const app = appWith();
    let last = 200;
    for (let i = 0; i < R1_CANDIDATE_LIMIT; i += 1) {
      const response = await request(app).post('/api/r1/status').send({ token: 'b2'.repeat(32) });
      last = response.status;
      expect(response.status).toBe(404);
    }
    expect(last).toBe(404);
    const limited = await request(app).post('/api/r1/status').send({ token: 'b2'.repeat(32) });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.body.error.type).toBe('rate_limit_exceeded');
    // Another lane, and the public health probe, are unaffected.
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).post('/api/livekit/preflight').send({ invite_token: 'x' })).status)
      .not.toBe(429);
  });

  it('applies one tighter shared bucket to preflight and attempts only', async () => {
    const app = appWith();
    for (let i = 0; i < R1_CANDIDATE_START_LIMIT; i += 1) {
      const response = await request(app)
        .post('/api/r1/preflight')
        .send({ token: 'b2'.repeat(32) });
      expect(response.status).toBe(404);
    }
    const limited = await request(app).post('/api/r1/preflight').send({ token: 'b2'.repeat(32) });
    expect(limited.status).toBe(429);
    expect(limited.headers['x-ratelimit-limit']).toBe(String(R1_CANDIDATE_START_LIMIT));
    // Preflight and attempts share ONE start budget per IP, so neither can be
    // used to multiply the other; status and exchange never spend it.
    expect((await request(app).post('/api/r1/attempts').send({ token: 'b2'.repeat(32) })).status)
      .toBe(429);
    expect((await request(app).post('/api/r1/status').send({ token: 'b2'.repeat(32) })).status)
      .toBe(404);
    expect((await request(app).post('/api/r1/exchange').send({
      attempt_token: 'junk',
      nonce: 'c3'.repeat(32),
    })).status).toBe(404);
  });

  it('charges the start bucket to the LINK: junk cannot lock a real candidate out', async () => {
    const app = appWith();
    // Many unknown links and malformed bodies from ONE client address (behind a
    // proxy that hides the real address this is every client at once).
    for (let i = 0; i < R1_CANDIDATE_START_LIMIT * 2; i += 1) {
      const unknown = i.toString(16).padStart(2, '0').repeat(32);
      expect((await request(app).post('/api/r1/attempts').send({ token: unknown })).status)
        .toBe(404);
    }
    for (let i = 0; i < R1_CANDIDATE_START_LIMIT + 2; i += 1) {
      await request(app).post('/api/r1/preflight').send({ token: 'short' });
    }
    // A real link is on its own bucket: preflight answers, it is not throttled.
    const real = await request(app).post('/api/r1/preflight').send({ token: LINK });
    expect(real.status).toBe(409);
    expect(real.body.error).toBe('consent_required');
    expect(real.headers['x-ratelimit-remaining']).toBe(String(R1_CANDIDATE_START_LIMIT - 1));
  });

  it('still bounds ONE link across preflight and attempts, not other links', async () => {
    const app = appWith();
    const other = 'c4'.repeat(32);
    for (let i = 0; i < R1_CANDIDATE_START_LIMIT; i += 1) {
      const route = i % 2 === 0 ? 'preflight' : 'attempts';
      expect((await request(app).post(`/api/r1/${route}`).send({ token: LINK })).status)
        .not.toBe(429);
    }
    const limited = await request(app).post('/api/r1/attempts').send({ token: LINK });
    expect(limited.status).toBe(429);
    expect(limited.headers['x-ratelimit-limit']).toBe(String(R1_CANDIDATE_START_LIMIT));
    // Another link, and the polled routes of the throttled one, are untouched.
    expect((await request(app).post('/api/r1/attempts').send({ token: other })).status)
      .toBe(404);
    expect((await request(app).post('/api/r1/status').send({ token: LINK })).status).toBe(200);
  });

  it('never keys the bucket on the plaintext token', () => {
    const key = r1StartKey({ body: { token: LINK }, ip: '203.0.113.9', socket: {} } as any);
    expect(key).toBe(`link:${sha256(LINK)}`);
    expect(key).not.toContain(LINK);
    // No usable token: the IP is the only thing left to charge.
    expect(r1StartKey({ body: { token: 'nope' }, ip: '203.0.113.9', socket: {} } as any))
      .toBe('ip:203.0.113.9');
    expect(r1StartKey({ ip: '203.0.113.9', socket: {} } as any)).toBe('ip:203.0.113.9');
  });

  it('answers 400 for an unparseable start body, as the other candidate routes do', async () => {
    const app = appWith();
    for (const path of ['preflight', 'attempts']) {
      const malformed = await request(app)
        .post(`/api/r1/${path}`)
        .set('content-type', 'application/json')
        .send('{"token":');
      expect(malformed.status, path).toBe(400);
    }
  });

  it('is a fixed, environment-free configuration', () => {
    expect(R1_CANDIDATE_LIMIT).toBe(60);
    expect(R1_CANDIDATE_START_LIMIT).toBe(10);
  });
});
