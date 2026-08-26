/**
 * REGRESSION (production incident, 2026-08-26): the first live phone call
 * connected, the bot delivered its disclosure, the candidate spoke — and then
 * the agent hung up at the consent gate. Root cause was pure wiring: the
 * internal phone-worker router is mounted in `createApp` BEFORE the global
 * `express.json()` body parser, and — unlike the scoring callback mounted
 * beside it, which reads only `req.params` — every phone-worker route parses a
 * JSON body (`workerEventSchema.safeParse(req.body)`). With no parser ahead of
 * the router, `req.body` was `undefined`, schema validation returned a flat
 * `400 invalid_request`, and the worker read that 4xx as a `business_error`
 * and aborted the call on `classify.human`.
 *
 * Why no existing test caught it: `phone-worker-route.test.ts` mounts the
 * router behind its OWN `express.json()`, so the harness always supplied the
 * parser the real app lacked — a suite that provisions the environment cannot
 * test a program whose contract is that it does not need it. This test
 * therefore drives the REAL `createApp` assembly, not a hand-mounted router,
 * so the mount ORDER is exactly production's.
 *
 * The guard is a difference, not an absolute: a well-formed body must reach
 * the handler (schema passes → it proceeds past validation), and the ONLY way
 * it fails to reach the handler is the unparsed-body regression, whose visible
 * signature is `400 { error: 'invalid_request' }` for input that is in fact
 * valid. So the invariant is: a valid body is NEVER answered with
 * `invalid_request`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setRateLimitStore, MemoryRateLimitStore } from '../lib/rate-limit.js';

const SECRET = 'phone-worker-secret-0123456789abcdefghij'; // 40 chars, > 32
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let savedSecret: string | undefined;
let savedEnabled: string | undefined;

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore(100_000));
  savedSecret = process.env.WORKER_CONTEXT_SECRET;
  savedEnabled = process.env.PHONE_SCREENING_ENABLED;
  process.env.WORKER_CONTEXT_SECRET = SECRET;
  process.env.PHONE_SCREENING_ENABLED = 'true';
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = savedSecret;
  if (savedEnabled === undefined) delete process.env.PHONE_SCREENING_ENABLED;
  else process.env.PHONE_SCREENING_ENABLED = savedEnabled;
});

function app() {
  return createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173', auditSinkOverride: async () => {} });
}

describe('POST /api/internal/phone/events — body parser is wired at the real mount', () => {
  it('parses a valid JSON body (never answers a well-formed request with invalid_request)', async () => {
    const res = await request(app())
      .post('/api/internal/phone/events')
      .set('Authorization', `Bearer ${SECRET}`)
      .set('Content-Type', 'application/json')
      .send({ attempt_id: ATTEMPT, event_type: 'classify.human', epoch: 1 });

    // The regression returned 400 invalid_request for THIS well-formed body,
    // because req.body was undefined. With the parser wired it passes schema
    // and proceeds past validation (a downstream DB/store error is fine here —
    // it proves the body was read). So the one thing that must never happen is
    // the unparsed-body signature.
    expect(res.body?.error).not.toBe('invalid_request');
    expect(res.status).not.toBe(400);
  });

  it('still rejects a genuinely malformed body with invalid_request (the parser did run)', async () => {
    // Control: a parsed-but-schema-invalid body (bad event_type) MUST 400. This
    // proves the 400 path is still reachable — the fix widened nothing — and
    // that the previous test's non-400 is because the body was valid, not
    // because validation was bypassed.
    const res = await request(app())
      .post('/api/internal/phone/events')
      .set('Authorization', `Bearer ${SECRET}`)
      .set('Content-Type', 'application/json')
      .send({ attempt_id: ATTEMPT, event_type: 'not.a.real.event', epoch: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects the body-parser limit being absent by proving a JSON body round-trips at all', async () => {
    // A second positive control on a different route that also parses a body:
    // the heartbeat. Same wiring, same parser — if the mount ever loses its
    // json() again, both routes regress together and this fails too.
    const res = await request(app())
      .post('/api/internal/phone/attempt/heartbeat')
      .set('Authorization', `Bearer ${SECRET}`)
      .set('Content-Type', 'application/json')
      .send({ attempt_id: ATTEMPT, session_id: ATTEMPT, epoch: 1 });

    // The heartbeat route reports schema failure in `status`, not `error`.
    expect(res.body?.status).not.toBe('invalid_request');
  });
});
