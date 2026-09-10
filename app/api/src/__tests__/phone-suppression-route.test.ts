/**
 * The do-not-call surface: `GET|POST|DELETE /api/phone/suppressions/:candidateId`.
 *
 * These three routes are the only "never call this person" mechanism once
 * `PHONE_DIAL_SCOPE=pipeline` retires the hand-maintained dial allowlist, and
 * they shipped in the same change. The contract test proves they are mounted
 * and documented; it says nothing about who may call them or what a refusal
 * becomes, which is what this file is for.
 *
 * Two properties get the most attention because they are the ones that fail in
 * the direction that CAUSES CALLS:
 *   * the DELETE's refusals — `not_suppressed` and `suppressed_by_other_candidate`
 *     must not read as success, and must not read as each other;
 *   * the DELETE's audit compensation — the row is already gone when the audit
 *     is written, so an audit failure that did NOT re-suppress would lift a
 *     do-not-call promise on the strength of a bookkeeping error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createPhoneApiRouter,
  type PhoneApiDeps,
} from '../routes/phone.js';
import type { PhoneStores } from '../lib/phone-screening/index.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';

const NOW = new Date('2026-08-24T09:30:00.000Z');
const ENABLED: NodeJS.ProcessEnv = {
  PHONE_SCREENING_ENABLED: 'true',
  PHONE_RUNTIME_ENABLED: 'true',
};
const CANDIDATE = '11111111-1111-4111-8111-111111111111';

interface SuppressionSpy {
  readonly stores: PhoneStores;
  readonly calls: Array<{ op: string; input: unknown }>;
}

/**
 * A store carrying ONLY the three suppression methods. Every other member of
 * `PhoneStores` is absent, which is legitimate — the interface declares them
 * optional — and proves these routes reach nothing else.
 */
function suppressionStores(over: Partial<PhoneStores> = {}): SuppressionSpy {
  const calls: Array<{ op: string; input: unknown }> = [];
  const stores = {
    async suppressCandidatePhone(input) {
      calls.push({ op: 'suppress', input });
      return { status: 'ok' as const, alreadySuppressed: false, dialsStopped: 0 };
    },
    async releaseCandidatePhoneSuppression(input) {
      calls.push({ op: 'release', input });
      return {
        status: 'ok' as const,
        released: 1,
        releasedReason: 'candidate_opt_out' as const,
        releasedSource: 'candidate' as const,
      };
    },
    async phoneSuppressionState(input) {
      calls.push({ op: 'state', input });
      return { status: 'ok' as const, suppressed: false, owned: false };
    },
    ...over,
  } as unknown as PhoneStores;
  return { stores, calls };
}

function appWith(role: string | null, deps: PhoneApiDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) {
      (req as unknown as { authUser: unknown }).authUser = {
        id: '66666666-6666-4666-8666-666666666666',
        appRole: role,
      };
    }
    next();
  });
  app.use('/api/phone', createPhoneApiRouter({
    configSource: ENABLED, now: () => NOW, ...deps,
  }));
  return app;
}

let originalSink: ReturnType<typeof getAuditSink>;
let audited: AuditEntry[];

beforeEach(() => {
  originalSink = getAuditSink();
  audited = [];
  setAuditSink(async (entry) => { audited.push(entry); });
});

afterEach(() => { setAuditSink(originalSink); });

describe('who may touch the do-not-call list', () => {
  it('a read needs interviewer or above; a write needs admin', async () => {
    const spy = suppressionStores();
    // Reads: interviewer is enough.
    expect((await request(appWith('interviewer', { stores: spy.stores }))
      .get(`/api/phone/suppressions/${CANDIDATE}`)).status).toBe(200);
    // Writes: interviewer is NOT. Suppression is a compliance record and
    // lifting one can cause a call, so both verbs sit behind admin.
    expect((await request(appWith('interviewer', { stores: spy.stores }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' })).status).toBe(403);
    expect((await request(appWith('interviewer', { stores: spy.stores }))
      .delete(`/api/phone/suppressions/${CANDIDATE}`)).status).toBe(403);
    // A refused write reached NO store method — the role gate runs first.
    expect(spy.calls.filter((c) => c.op !== 'state')).toHaveLength(0);
  });

  it('a viewer cannot even read, and an anonymous caller gets nothing', async () => {
    const spy = suppressionStores();
    expect((await request(appWith('viewer', { stores: spy.stores }))
      .get(`/api/phone/suppressions/${CANDIDATE}`)).status).toBe(403);
    expect((await request(appWith(null, { stores: spy.stores }))
      .get(`/api/phone/suppressions/${CANDIDATE}`)).status).toBe(403);
  });
});

describe('the disabled default and the absent seam both refuse, and differently', () => {
  it('every verb is 503 phone_screening_disabled while the domain is off', async () => {
    const spy = suppressionStores();
    const off = { configSource: {}, stores: spy.stores };
    for (const res of [
      await request(appWith('admin', off)).get(`/api/phone/suppressions/${CANDIDATE}`),
      await request(appWith('admin', off)).post(`/api/phone/suppressions/${CANDIDATE}`)
        .send({ reason: 'operator' }),
      await request(appWith('admin', off)).delete(`/api/phone/suppressions/${CANDIDATE}`),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('phone_screening_disabled');
    }
    expect(spy.calls).toHaveLength(0);
  });

  it('a store missing the seam is 503, never a silent success', async () => {
    // The three methods are OPTIONAL on `PhoneStores` so the many hand-written
    // doubles keep compiling. Absence must therefore be loud: answering `ok`
    // for a suppression nothing recorded is the worst failure this surface has.
    const bare = {} as unknown as PhoneStores;
    for (const res of [
      await request(appWith('admin', { stores: bare })).get(`/api/phone/suppressions/${CANDIDATE}`),
      await request(appWith('admin', { stores: bare })).post(`/api/phone/suppressions/${CANDIDATE}`)
        .send({ reason: 'operator' }),
      await request(appWith('admin', { stores: bare })).delete(`/api/phone/suppressions/${CANDIDATE}`),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('phone_suppression_unavailable');
    }
  });

  it('a PARTIAL seam is refused too — all three or none', async () => {
    const partial = {
      async suppressCandidatePhone() { return { status: 'ok' as const }; },
    } as unknown as PhoneStores;
    const res = await request(appWith('admin', { stores: partial }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' });
    expect(res.status).toBe(503);
  });
});

describe('shape validation runs before the store', () => {
  it('a bad uuid, a bad reason and an unknown field are all 400', async () => {
    const spy = suppressionStores();
    const app = appWith('admin', { stores: spy.stores });
    expect((await request(app).post('/api/phone/suppressions/not-a-uuid')
      .send({ reason: 'operator' })).status).toBe(400);
    expect((await request(app).post(`/api/phone/suppressions/${CANDIDATE}`)
      .send({ reason: 'because_i_said_so' })).status).toBe(400);
    expect((await request(app).post(`/api/phone/suppressions/${CANDIDATE}`)
      .send({ reason: 'operator', source: 'telepathy' })).status).toBe(400);
    expect((await request(app).post(`/api/phone/suppressions/${CANDIDATE}`)
      .send({ reason: 'operator', note: 'hello' })).status).toBe(400);
    // …so the RPC's own `invalid_reason` / `invalid_source` are unreachable
    // through this API, which is what the OpenAPI description now says.
    expect(spy.calls).toHaveLength(0);
  });

  it('`source` defaults to operator, because this IS the operator surface', async () => {
    const spy = suppressionStores();
    await request(appWith('admin', { stores: spy.stores }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'wrong_number' });
    expect(spy.calls[0]!.input).toMatchObject({
      candidateId: CANDIDATE, reason: 'wrong_number', source: 'operator',
    });
  });
});

describe('refusals become the right status code', () => {
  it('candidate_not_found is 404, not 409 — a client can fix that one', async () => {
    for (const [method, store] of [
      ['get', { phoneSuppressionState: async () => ({ status: 'candidate_not_found' as const }) }],
      ['post', { suppressCandidatePhone: async () => ({ status: 'candidate_not_found' as const }) }],
      ['delete', {
        releaseCandidatePhoneSuppression: async () => ({ status: 'candidate_not_found' as const }),
      }],
    ] as const) {
      const spy = suppressionStores(store as Partial<PhoneStores>);
      const app = appWith('admin', { stores: spy.stores });
      const res = method === 'post'
        ? await request(app).post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' })
        : method === 'delete'
          ? await request(app).delete(`/api/phone/suppressions/${CANDIDATE}`)
          : await request(app).get(`/api/phone/suppressions/${CANDIDATE}`);
      expect(res.status, method).toBe(404);
      expect(res.body.error, method).toBe('candidate_not_found');
    }
  });

  it('not_suppressed is 409 — lifting nothing must not read as lifting', async () => {
    // Deliberately NOT folded into success the way `already_cancelled` is on
    // the calendar. This verb can cause a call: an operator who believes they
    // lifted a suppression that was never there has a wrong model of who is
    // about to be rung.
    const spy = suppressionStores({
      releaseCandidatePhoneSuppression: async () => ({ status: 'not_suppressed' as const }),
    });
    const res = await request(appWith('admin', { stores: spy.stores }))
      .delete(`/api/phone/suppressions/${CANDIDATE}`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'not_suppressed' });
  });

  it('suppressed_by_other_candidate is its OWN 409, never not_suppressed', async () => {
    // The shared-line case. Folding it into `not_suppressed` would tell an
    // operator the line is free when it is not.
    const spy = suppressionStores({
      releaseCandidatePhoneSuppression: async () => ({
        status: 'suppressed_by_other_candidate' as const,
      }),
    });
    const res = await request(appWith('admin', { stores: spy.stores }))
      .delete(`/api/phone/suppressions/${CANDIDATE}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('suppressed_by_other_candidate');
  });

  it('an unrecognised answer is 500, never an optimistic 200', async () => {
    const spy = suppressionStores({
      suppressCandidatePhone: async () => ({ status: 'unknown_status' as const }),
    });
    const res = await request(appWith('admin', { stores: spy.stores }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('phone_rpc_unknown_status');
  });

  it('a throwing store is a sanitized 500', async () => {
    const spy = suppressionStores({
      suppressCandidatePhone: async () => { throw new Error('pg said something detailed'); },
    });
    const res = await request(appWith('admin', { stores: spy.stores }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('phone_action_error');
    expect(JSON.stringify(res.body)).not.toContain('detailed');
  });
});

describe('what the successful bodies carry', () => {
  it('the read reports state, ownership — and never a digest or a number', async () => {
    const spy = suppressionStores({
      phoneSuppressionState: async () => ({
        status: 'ok' as const,
        suppressed: true,
        owned: false,
        reason: 'candidate_opt_out' as const,
        source: 'candidate' as const,
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
    });
    const res = await request(appWith('interviewer', { stores: spy.stores }))
      .get(`/api/phone/suppressions/${CANDIDATE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      candidate_id: CANDIDATE,
      suppressed: true,
      // The promise belongs to another candidate sharing the line, so it may
      // not be lifted here. Surfacing it is what stops an operator meeting
      // `suppressed_by_other_candidate` with no way to have anticipated it.
      owned: false,
      reason: 'candidate_opt_out',
      source: 'candidate',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    expect(JSON.stringify(res.body)).not.toContain('+91');
  });

  it('the write reports idempotency AND the dials it stopped', async () => {
    const spy = suppressionStores({
      suppressCandidatePhone: async () => ({
        status: 'ok' as const, alreadySuppressed: true, dialsStopped: 2,
      }),
    });
    const res = await request(appWith('admin', { stores: spy.stores }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'candidate_opt_out' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      candidate_id: CANDIDATE,
      suppressed: true,
      already_suppressed: true,
      dials_stopped: 2,
    });
  });

  it('the release reports WHAT it lifted, not just a count', async () => {
    const spy = suppressionStores();
    const res = await request(appWith('admin', { stores: spy.stores }))
      .delete(`/api/phone/suppressions/${CANDIDATE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      candidate_id: CANDIDATE,
      suppressed: false,
      released: 1,
      released_reason: 'candidate_opt_out',
      released_source: 'candidate',
    });
  });
});

describe('the audit trail', () => {
  it('all three verbs are audited, the READ included', async () => {
    const spy = suppressionStores();
    const app = appWith('admin', { stores: spy.stores });
    await request(app).get(`/api/phone/suppressions/${CANDIDATE}`);
    await request(app).post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' });
    await request(app).delete(`/api/phone/suppressions/${CANDIDATE}`);
    // Asking whether a named person is on the do-not-call list is a
    // per-person compliance read; it was the only read on this surface that
    // left no trace.
    expect(audited.map((a) => a.event)).toEqual([
      'resource.read', 'resource.create', 'resource.delete',
    ]);
    for (const entry of audited) {
      expect(JSON.stringify(entry)).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it('a failed audit on POST does NOT undo the suppression', async () => {
    // Undoing a do-not-call promise because our own audit sink failed would
    // fail open in the direction that causes calls. The RPC has already
    // written its own audit row, so the act is recorded regardless.
    setAuditSink(async () => { throw new Error('sink down'); });
    const spy = suppressionStores();
    const res = await request(appWith('admin', { stores: spy.stores }))
      .post(`/api/phone/suppressions/${CANDIDATE}`).send({ reason: 'operator' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'phone_audit_write_failed', rolled_back: false });
    expect(spy.calls.filter((c) => c.op === 'suppress')).toHaveLength(1);
  });

  it('a failed audit on DELETE DOES re-suppress — the row is already gone', async () => {
    // The mirror image, and the reason the POST's rule must not be copied
    // here by reflex. On DELETE, not compensating is what lifts the promise.
    setAuditSink(async () => { throw new Error('sink down'); });
    const spy = suppressionStores();
    const res = await request(appWith('admin', { stores: spy.stores }))
      .delete(`/api/phone/suppressions/${CANDIDATE}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'phone_audit_write_failed', rolled_back: true });
    // Re-suppressed with the reason and source it destroyed, so the person is
    // no more dialable than before the release started.
    const undo = spy.calls.filter((c) => c.op === 'suppress');
    expect(undo).toHaveLength(1);
    expect(undo[0]!.input).toMatchObject({
      candidateId: CANDIDATE, reason: 'candidate_opt_out', source: 'candidate',
    });
  });

  it('…and reports rolled_back FALSE when it cannot reconstruct what it lifted', async () => {
    // A release that did not report a reason cannot be undone faithfully, and
    // guessing one would write a promise nobody made. Saying so is the honest
    // answer; the operator then knows the state needs a human.
    setAuditSink(async () => { throw new Error('sink down'); });
    const spy = suppressionStores({
      releaseCandidatePhoneSuppression: async () => ({ status: 'ok' as const, released: 1 }),
    });
    const res = await request(appWith('admin', { stores: spy.stores }))
      .delete(`/api/phone/suppressions/${CANDIDATE}`);
    expect(res.body).toMatchObject({ error: 'phone_audit_write_failed', rolled_back: false });
    expect(spy.calls.filter((c) => c.op === 'suppress')).toHaveLength(0);
  });
});
