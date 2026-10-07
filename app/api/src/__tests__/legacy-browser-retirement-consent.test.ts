/**
 * PR-L review finding (P2): the candidate-consent status and submit routes.
 *
 * They are called only by the legacy browser join page, keyed by a legacy invite
 * token, and both go through validateInvite, which rejects a consumed invite. So
 * they can never serve an already-started session: they are NOT part of the
 * drain. Left open they let a dead link collect consent and write the
 * candidate's latest consent_records row, which phone admission reads, so a
 * decline through a dead link would stop phone dialing for that candidate.
 *
 * Retired (LEGACY_BROWSER_SCREENING_ENABLED=false) both answer 410
 * `browser_screening_retired` BEFORE validation and with no database access at
 * all. Enabled (the default) they behave exactly as before. GET /template is
 * invite-free and read-only, and is not gated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), insert: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  RESUME_BUCKET: 'resumes_v2',
}));

import { candidateConsentRouter } from '../routes/candidate-consent.js';
import { finalErrorHandler } from '../lib/validation.js';

const ENV_KEY = 'LEGACY_BROWSER_SCREENING_ENABLED';
const ORIGINAL_FLAG = process.env[ENV_KEY];

const TOKEN = 'a'.repeat(64);
const CANDIDATE = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const INVITE = '00000000-0000-4000-8000-000000000003';
const REQUIRED = ['ai_interview', 'recording'];
const GONE_BODY = { error: 'browser_screening_retired' };

const GRANT_BODY = {
  invite_token: TOKEN,
  template_version: '1.0',
  locale: 'en-IN',
  consents: REQUIRED,
  status: 'granted',
};
const DECLINE_BODY = { ...GRANT_BODY, consents: [], status: 'declined' };

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api/candidate-consent', candidateConsentRouter);
  a.use(finalErrorHandler);
  return a;
}

/** A thenable query chain that resolves to one canned result at any depth. */
function chain(result: unknown, table = ''): unknown {
  const self: Record<string, unknown> = {};
  const node: unknown = new Proxy(self, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown) => resolve(result);
      }
      if (prop === 'insert') {
        return (...args: unknown[]) => {
          mocks.insert(table, ...args);
          return node;
        };
      }
      return () => node;
    },
  });
  return node;
}

/** Table-aware double for an ACTIVE invite, an active template and a writable ledger. */
function wireActiveInvite(): void {
  const rows: Record<string, unknown> = {
    candidate_invites: {
      id: INVITE,
      candidate_id: CANDIDATE,
      session_id: SESSION,
      expires_at: '2999-01-01T00:00:00.000Z',
      consumed_at: null,
      revoked_at: null,
    },
    consent_templates: {
      version: '1.0',
      locale: 'en-IN',
      title: 'Privacy Notice',
      body_md: '# Privacy Notice',
      required_consents: REQUIRED,
    },
    consent_records: {
      id: 'record-1',
      status: 'granted',
      consents: REQUIRED,
      version: '1.0',
      created_at: '2026-10-06T00:00:00.000Z',
      expires_at: null,
    },
  };
  mocks.from.mockImplementation((table: string) =>
    chain({ data: rows[table] ?? null, error: null }, table));
}

/** The rows written to consent_records (the audit_events write is separate). */
function consentRows(): unknown[] {
  return mocks.insert.mock.calls
    .filter((call) => call[0] === 'consent_records')
    .map((call) => call[1]);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_FLAG;
  warnSpy.mockRestore();
});

describe('retired: POST /api/candidate-consent/status', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'false';
    wireActiveInvite();
  });

  it('answers 410 browser_screening_retired with no-store, even for an ACTIVE invite', async () => {
    const res = await request(app())
      .post('/api/candidate-consent/status')
      .send({ invite_token: TOKEN });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('answers 410 for an invalid body too, and touches no table', async () => {
    const res = await request(app()).post('/api/candidate-consent/status').send({});
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('reads no invite, template or consent record while retired', async () => {
    await request(app()).post('/api/candidate-consent/status').send({ invite_token: TOKEN });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('fails closed (410) for a malformed flag value', async () => {
    process.env[ENV_KEY] = 'maybe';
    const res = await request(app())
      .post('/api/candidate-consent/status')
      .send({ invite_token: TOKEN });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
  });
});

describe('retired: POST /api/candidate-consent/submit', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'false';
    wireActiveInvite();
  });

  it.each([
    ['a grant', GRANT_BODY],
    ['a DECLINE', DECLINE_BODY],
  ])('answers 410 for %s and writes NO consent_records row', async (_name, body) => {
    const res = await request(app()).post('/api/candidate-consent/submit').send(body);
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('answers 410 for an invalid body (the route is gone, not mis-called)', async () => {
    const res = await request(app()).post('/api/candidate-consent/submit').send({});
    expect(res.status).toBe(410);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe('retired: the rest of the consent router is untouched', () => {
  it('still serves GET /template (invite-free, read-only)', async () => {
    process.env[ENV_KEY] = 'false';
    wireActiveInvite();
    const res = await request(app()).get('/api/candidate-consent/template');
    expect(res.status).toBe(200);
    expect(res.body.required_consents).toEqual(REQUIRED);
    expect(mocks.from).toHaveBeenCalledWith('consent_templates');
  });
});

describe('enabled (the default): the consent routes behave exactly as before', () => {
  it('/status validates the invite and answers its bounded status', async () => {
    wireActiveInvite();
    const res = await request(app())
      .post('/api/candidate-consent/status')
      .send({ invite_token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      has_consent: true,
      template_version: '1.0',
      required_consents: REQUIRED,
    });
    expect(mocks.from).toHaveBeenCalledWith('candidate_invites');
  });

  it('/status answers the stable 404 for an unknown invite', async () => {
    mocks.from.mockImplementation(() => chain({ data: null, error: null }));
    const res = await request(app())
      .post('/api/candidate-consent/status')
      .send({ invite_token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'invite_token_invalid_or_expired' });
  });

  it('/submit validates the body: an empty one is 400, not 410', async () => {
    const res = await request(app()).post('/api/candidate-consent/submit').send({});
    expect(res.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['an explicit "true"', 'true'],
  ])('/submit records a grant against the invite when the flag is %s', async (_name, flag) => {
    if (flag !== undefined) process.env[ENV_KEY] = flag;
    wireActiveInvite();
    const res = await request(app()).post('/api/candidate-consent/submit').send(GRANT_BODY);
    expect(res.status).toBe(201);
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0]).toMatchObject({
      candidate_id: CANDIDATE,
      status: 'granted',
      consents: REQUIRED,
      source: 'candidate_portal',
    });
  });

  it('/submit records a decline against the invite while enabled', async () => {
    wireActiveInvite();
    const res = await request(app()).post('/api/candidate-consent/submit').send(DECLINE_BODY);
    expect(res.status).toBe(201);
    expect(consentRows()[0]).toMatchObject({ status: 'declined', consents: [] });
  });
});
