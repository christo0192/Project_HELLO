/**
 * Phase 9 L3 — /api/candidate-consent/* (invariant 1).
 * Invite-opaque pre-join consent: every route validates the invite before
 * any candidate DB write; failures are stable; responses never carry
 * candidate_id/PII/token/digest; granted requires all template required
 * types; decline is append-only and never consumes/revokes the invite;
 * template absence fails closed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { candidateConsentRouter } from '../routes/candidate-consent.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const TOKEN = 'a'.repeat(64);
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const INVITE_ID = '00000000-0000-4000-8000-000000000003';
const TEMPLATE_VERSION = '1.0';
const REQUIRED = ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'];

let inserted: any[] = [];
let updated: any[] = [];

function chainable(value: any): any {
  const fn = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.order = () => chainable(value);
  fn.limit = () => chainable(value);
  fn.select = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  fn.is = () => chainable(value);
  fn.in = () => chainable(value);
  fn.insert = (...args: any[]) => { inserted.push(args); return chainable(value); };
  fn.update = (...args: any[]) => { updated.push(args); return chainable(value); };
  fn.gt = () => chainable(value);
  return fn;
}

let mockFrom: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
  inserted = [];
  updated = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/candidate-consent', candidateConsentRouter);
  app.use(finalErrorHandler);
  return app;
}

const ACTIVE_INVITE = {
  data: {
    id: INVITE_ID,
    candidate_id: CANDIDATE_ID,
    session_id: SESSION_ID,
    expires_at: '2999-01-01T00:00:00.000Z',
    consumed_at: null,
    revoked_at: null,
  },
  error: null,
};

const ACTIVE_TEMPLATE = {
  data: {
    version: TEMPLATE_VERSION,
    locale: 'en-IN',
    title: 'Privacy Notice',
    body_md: '# Privacy Notice',
    required_consents: REQUIRED,
  },
  error: null,
};

function grantedRecord(overrides: Record<string, unknown> = {}) {
  return chainable({
    data: {
      status: 'granted',
      consents: [...REQUIRED],
      version: TEMPLATE_VERSION,
      expires_at: null,
      ...overrides,
    },
    error: null,
  });
}

describe('POST /api/candidate-consent/status', () => {
  it('bounded status for a valid invite — no candidate_id, no token', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_INVITE))
      .mockReturnValueOnce(grantedRecord())
      .mockReturnValueOnce(chainable(ACTIVE_TEMPLATE));
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      has_consent: true,
      template_version: TEMPLATE_VERSION,
      locale: 'en-IN',
      required_consents: REQUIRED,
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(CANDIDATE_ID);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(INVITE_ID);
  });

  it('has_consent false when no granted record exists', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_INVITE))
      .mockReturnValueOnce(chainable({ data: null, error: null }))
      .mockReturnValueOnce(chainable(ACTIVE_TEMPLATE));
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.has_consent).toBe(false);
  });

  it('unknown invite → stable 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invite_token_invalid_or_expired');
  });

  it('expired invite → stable 404 (indistinguishable)', async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: { ...ACTIVE_INVITE.data, expires_at: '2000-01-01T00:00:00.000Z' }, error: null }),
    );
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invite_token_invalid_or_expired');
  });

  it('revoked invite → stable 404', async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: { ...ACTIVE_INVITE.data, revoked_at: '2025-01-01T00:00:00.000Z' }, error: null }),
    );
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(res.status).toBe(404);
  });

  it('consumed invite → stable 404', async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: { ...ACTIVE_INVITE.data, consumed_at: '2025-01-01T00:00:00.000Z' }, error: null }),
    );
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(res.status).toBe(404);
  });

  it('malformed token → 400 (bounded schema)', async () => {
    const res = await request(makeApp()).post('/api/candidate-consent/status').send({ invite_token: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/candidate-consent/template', () => {
  it('returns an active versioned template for the locale', async () => {
    mockFrom.mockReturnValueOnce(chainable(ACTIVE_TEMPLATE));
    const res = await request(makeApp()).get('/api/candidate-consent/template?locale=en-IN');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: TEMPLATE_VERSION,
      locale: 'en-IN',
      title: 'Privacy Notice',
      body_md: '# Privacy Notice',
      required_consents: REQUIRED,
    });
  });

  it('absence fails closed (404) — no pretend Legal copy', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp()).get('/api/candidate-consent/template?locale=fr-FR');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('consent_template_unavailable');
  });

  it('rejects a malformed locale shape (400)', async () => {
    const res = await request(makeApp()).get('/api/candidate-consent/template?locale=../../etc/passwd');
    expect(res.status).toBe(400);
  });

  it('defaults to en-IN when locale is absent', async () => {
    mockFrom.mockReturnValueOnce(chainable(ACTIVE_TEMPLATE));
    const res = await request(makeApp()).get('/api/candidate-consent/template');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/candidate-consent/submit', () => {
  const grantBody = (overrides: Record<string, unknown> = {}) => ({
    invite_token: TOKEN,
    template_version: TEMPLATE_VERSION,
    locale: 'en-IN',
    consents: [...REQUIRED],
    status: 'granted',
    ...overrides,
  });

  it('granted with all required types → 201; proof = invite/session binding only', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_INVITE))
      .mockReturnValueOnce(chainable(ACTIVE_TEMPLATE))
      .mockReturnValueOnce(
        chainable({
          data: { id: '00000000-0000-4000-8000-0000000000b1', status: 'granted', consents: [...REQUIRED], version: TEMPLATE_VERSION, created_at: '2025-01-01T00:00:00.000Z' },
          error: null,
        }),
      )
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp()).post('/api/candidate-consent/submit').send(grantBody());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('granted');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(CANDIDATE_ID);
    expect(body).not.toContain(TOKEN);

    const consentInsert = inserted.find((a) => JSON.stringify(a).includes('candidate_portal'));
    expect(consentInsert).toBeTruthy();
    const payload = JSON.stringify(consentInsert);
    expect(payload).toContain('invite_id');
    expect(payload).toContain(INVITE_ID);
    expect(payload).toContain('session_id');
    expect(payload).toContain(SESSION_ID);
    // Never the token/digest in the stored proof.
    expect(payload).not.toContain(TOKEN);
  });

  it('granted missing a required consent type → 400', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_INVITE))
      .mockReturnValueOnce(chainable(ACTIVE_TEMPLATE));
    const res = await request(makeApp())
      .post('/api/candidate-consent/submit')
      .send(grantBody({ consents: ['recording', 'purpose'] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('required_consents_missing');
    expect(inserted).toHaveLength(0);
  });

  it('missing/inactive/wrong-version template fails closed (503, no consent insert)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_INVITE))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp())
      .post('/api/candidate-consent/submit')
      .send(grantBody({ template_version: '9.9' }));
    // Stable non-500, no raw internals (invariant 12): the invite is left
    // unconsumed so a later submit can succeed once an active template exists.
    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('consent_template_unavailable');
    expect(res.body.error.message).toBe('Consent template unavailable');
    expect(inserted).toHaveLength(0);
  });

  it('invalid invite → 404 and NO consent write happens', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp()).post('/api/candidate-consent/submit').send(grantBody());
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('decline is append-only and does NOT consume/revoke the invite', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_INVITE))
      .mockReturnValueOnce(chainable(ACTIVE_TEMPLATE))
      .mockReturnValueOnce(
        chainable({
          data: { id: '00000000-0000-4000-8000-0000000000b2', status: 'declined', consents: [], version: TEMPLATE_VERSION, created_at: '2025-01-01T00:00:00.000Z' },
          error: null,
        }),
      )
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp())
      .post('/api/candidate-consent/submit')
      .send(grantBody({ status: 'declined', consents: [] }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('declined');
    // The invite row is never UPDATED (no consume/revoke) — only read.
    expect(updated).toHaveLength(0);
  });

  it('strict schema: client-supplied candidate_id/unknown keys rejected (400)', async () => {
    const res = await request(makeApp())
      .post('/api/candidate-consent/submit')
      .send({ ...grantBody(), candidate_id: CANDIDATE_ID });
    expect(res.status).toBe(400);
  });

  it('strict schema: unknown status rejected (400)', async () => {
    const res = await request(makeApp())
      .post('/api/candidate-consent/submit')
      .send(grantBody({ status: 'withdrawn' }));
    expect(res.status).toBe(400);
  });
});
