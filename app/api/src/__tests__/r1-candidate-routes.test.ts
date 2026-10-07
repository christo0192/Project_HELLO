/**
 * R1 candidate routes: status, consent (+ withdraw), preflight, attempts
 * (+ nonce) and exchange (plan sections 4, 7.8, 7.10, 8.3; v2 section 8).
 *
 * The router under test is the real one. Its edges are replaced: an in-memory
 * database whose RPC doubles follow the documented SQL behaviour, a fake
 * LiveKit room API, the browser worker gate and the DeepSeek health verdict.
 * `lib/supabase.js` is mocked to the same database so that the real
 * `transitionSession` and `provisionRoomForCreatedSession` run unmodified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { TokenVerifier } from 'livekit-server-sdk';

const mocks = vi.hoisted(() => ({
  db: { current: null as any },
  startRecording: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table: string) => mocks.db.current.from(table),
    rpc: (fn: string, args: unknown) => mocks.db.current.rpc(fn, args),
  },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/recording-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/recording-egress.js')>()),
  startAuthoritativeRecording: mocks.startRecording,
}));

import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { cloudLiveKitEndpoint } from '../lib/livekit-endpoints.js';
import {
  ATTEMPT_TOKEN_TTL_SEC,
  mintAttemptToken,
  verifyAttemptToken,
} from '../lib/r1/attempt-token.js';
import {
  CANDIDATE_TOKEN_TTL_SEC,
  PREFLIGHT_HARD_STOP_MS,
  STABLE_ATTEMPT_ERROR,
  STABLE_LINK_ERROR,
  UNHEALTHY_RETRY_AFTER_SEC,
  WITHDRAW_RETRY_AFTER_SEC,
} from '../routes/r1-candidate.js';
import {
  CANDIDATE,
  LINK,
  NOW,
  REQUIRED,
  ROUND,
  SESSION,
  TEMPLATE,
  WORKER_SECRET,
  addAttempt,
  addSession,
  buildHarness,
  dispatchCreatedAt,
  grantConsent,
  joblessDispatch,
  runningDispatch,
  seedTables,
  sha256,
  type Harness,
} from './support/r1-candidate-harness.js';

const R1_ENV = {
  url: 'wss://r1.example.test',
  key: 'r1-test-key',
  // Low-entropy fixture so the history secret scanner never flags it.
  secret: 's'.repeat(32),
};
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'R1_ENABLED',
  'WORKER_CONTEXT_SECRET',
  'BROWSER_LIVEKIT_TARGET',
  'R1_LIVEKIT_URL',
  'R1_LIVEKIT_API_KEY',
  'R1_LIVEKIT_API_SECRET',
];

function selectR1Sfu(h: Harness): void {
  process.env.BROWSER_LIVEKIT_TARGET = 'r1';
  process.env.R1_LIVEKIT_URL = R1_ENV.url;
  process.env.R1_LIVEKIT_API_KEY = R1_ENV.key;
  process.env['R1_LIVEKIT_API_SECRET'] = R1_ENV.secret;
  h.tables.r1_settings![0]!.livekit_target = 'r1';
}

function claims(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

const inMaintenance = async () => ({
  ok: true as const,
  enabled: true,
  reason: null,
  updatedAt: null,
});

let audits: AuditEntry[];
let originalSink: ReturnType<typeof getAuditSink>;
let h: Harness;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  delete process.env.BROWSER_LIVEKIT_TARGET;
  mocks.startRecording.mockReset();
  mocks.startRecording.mockResolvedValue({ status: 'started', egressId: 'egress-must-not-happen' });
  audits = [];
  originalSink = getAuditSink();
  setAuditSink((entry) => {
    audits.push(entry);
  });
  h = buildHarness();
  mocks.db.current = h.db;
});

afterEach(() => {
  setAuditSink(originalSink);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Rebuild the harness (and the mocked database) over modified tables. */
function use(
  tables = seedTables(),
  overrides = {},
  gateEnabled = true,
  failures?: Parameters<typeof buildHarness>[3],
): Harness {
  h = buildHarness(tables, overrides, gateEnabled, failures);
  mocks.db.current = h.db;
  return h;
}

const post = (path: string, body: unknown) => request(h.app)
  .post(`/api/r1${path}`)
  .send(body as object);

/** Admit an attempt through the route, returning the secrets the page would hold. */
async function admit(): Promise<{ attempt_token: string; nonce: string; attempt_id: string }> {
  const response = await post('/attempts', { token: LINK });
  expect(response.status).toBe(201);
  return response.body;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/r1/status', () => {
  it('answers one stable 404 for an unknown link and writes nothing', async () => {
    const response = await post('/status', { token: 'b2'.repeat(32) });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: STABLE_LINK_ERROR });
    expect(h.db.rpcCalls).toEqual([]);
  });

  it('rejects a malformed token and unknown keys before any lookup', async () => {
    expect((await post('/status', { token: 'not-hex' })).status).toBe(400);
    expect((await post('/status', { token: LINK, extra: 1 })).status).toBe(400);
    expect((await post('/status', {})).status).toBe(400);
    expect(h.db.touched.size).toBe(0);
  });

  it('reports state, attempts, consent need, format and no candidate data', async () => {
    const response = await post('/status', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      round_status: 'invited',
      expires_at: h.tables.interview_rounds![0]!.expires_at,
      availability: 'open',
      attempts_allowed: 2,
      attempts_remaining: 2,
      starts_remaining: 3,
      consent: { state: 'required', template_version: '002' },
      live_attempt: false,
      can_start: false,
      role_title: 'Sales Program Advisor',
      format: {
        duration_minutes: 20,
        camera_required: true,
        microphone_required: true,
        interviewer: 'ai',
        includes_role_play: true,
      },
      audience: 'candidate',
    });
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/Ava Candidate|private resume|digest|persona|p3_data/i);
  });

  it('tells the page whom it is talking to: staff for a dry run, otherwise the stricter candidate', async () => {
    expect((await post('/status', { token: LINK })).body.audience).toBe('candidate');
    h.tables.interview_rounds![0]!.consent_locale = 'en-IN-x-staff';
    expect((await post('/status', { token: LINK })).body.audience).toBe('staff');
    // A value outside the two audiences (the database check makes it unreachable) is never
    // read as staff: the candidate wording is the stricter one.
    for (const odd of ['hi-IN', 'en-IN-X-STAFF', 'en-IN-x-staff ']) {
      h.tables.interview_rounds![0]!.consent_locale = odd;
      expect((await post('/status', { token: LINK })).body.audience, odd).toBe('candidate');
    }
  });

  it('can_start only with valid consent on an open, unexpired, attempt-bearing round', async () => {
    grantConsent(h.tables);
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      consent: { state: 'granted' },
      can_start: true,
    });

    h.tables.r1_settings![0]!.paused = true;
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      availability: 'paused',
      can_start: false,
    });
    h.tables.r1_settings![0]!.paused = false;

    process.env.R1_ENABLED = 'false';
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      availability: 'disabled',
      can_start: false,
    });
    process.env.R1_ENABLED = 'true';

    h.tables.interview_rounds![0]!.starts_used = 3;
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      starts_remaining: 0,
      can_start: false,
    });
    h.tables.interview_rounds![0]!.starts_used = 0;

    h.tables.interview_rounds![0]!.attempts_counted = 2;
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      attempts_remaining: 0,
      can_start: false,
    });
    h.tables.interview_rounds![0]!.attempts_counted = 0;

    addSession(h.tables, { status: 'in_progress' });
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      live_attempt: true,
      can_start: false,
    });
  });

  it('reads a lapsed round as expired at once', async () => {
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1000).toISOString();
    const response = await post('/status', { token: LINK });
    expect(response.body).toMatchObject({ round_status: 'expired', can_start: false });
  });

  it('reflects declined and withdrawn consent', async () => {
    grantConsent(h.tables, {
      withdrawn_at: new Date(NOW).toISOString(),
      proof: { decision: 'declined' },
    });
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('declined');
    h.tables.interview_round_consents![0]!.proof = { decision: 'withdrawn' };
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('withdrawn');
  });

  it('requires consent again when its template is superseded or a type is missing', async () => {
    h.tables.interview_round_consent_templates!.find((t) => t.id === TEMPLATE)!.is_active = false;
    grantConsent(h.tables);
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('required');
    h.tables.interview_round_consent_templates!.find((t) => t.id === TEMPLATE)!.is_active = true;
    h.tables.interview_round_consents![0]!.consents = ['ai_interview'];
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('required');
  });

  it('answers 503, never 404, when the database fails', async () => {
    const real = h.db.from.bind(h.db);
    h.db.from = (table: string) => (table === 'interview_rounds'
      ? {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }),
        }),
      }
      : real(table));
    const response = await post('/status', { token: LINK });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
  });
});

/** The four agreements PR-CT's 0123 ships for both audiences. */
const PRCT_KEYS = ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'];
const STAFF_TEMPLATE = '40000000-0000-4000-8000-0000000000d2';

/** The staff dry-run notice, a second audience row; PR-CT ships it at the SAME version. */
function addStaffTemplate(tables: ReturnType<typeof seedTables>, version = '002'): void {
  tables.interview_round_consent_templates!.push({
    id: STAFF_TEMPLATE,
    version,
    locale: 'en-IN-x-staff',
    title: 'R1 staff dry run',
    body_md: '# R1 staff\nStaff notice body',
    required_consents: REQUIRED,
    is_active: true,
  });
}

/** Mark the seeded round as a staff dry run (what the Send R1 path or an operator does). */
function makeStaffRound(tables: ReturnType<typeof seedTables>): void {
  tables.interview_rounds![0]!.consent_locale = 'en-IN-x-staff';
}

describe('POST /api/r1/consent-template', () => {
  it('returns the notice this round is owed, without internal fields', async () => {
    const response = await post('/consent-template', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      version: '002',
      locale: 'en-IN',
      title: 'R1 notice',
      body_md: '# R1\nNotice body',
      required_consents: REQUIRED,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(h.db.touched).not.toContain('consent_templates');
  });

  it('answers one stable 404 for an unknown link and reads no template', async () => {
    const response = await post('/consent-template', { token: 'b2'.repeat(32) });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: STABLE_LINK_ERROR });
    expect(h.db.touched).not.toContain('interview_round_consent_templates');
  });

  it('is a POST: the link token never rides in a URL, and a GET is not a route', async () => {
    expect((await request(h.app).get('/api/r1/consent-template')).status).toBe(404);
    expect((await request(h.app).get(`/api/r1/consent-template?token=${LINK}`)).status).toBe(404);
  });

  it('takes no locale from the client: a locale, or any other key, is a 400', async () => {
    for (const extra of [
      { locale: 'en-IN' },
      { locale: 'en-IN-x-staff' },
      { locale: '<script>' },
      { other: 1 },
    ]) {
      expect((await post('/consent-template', { token: LINK, ...extra })).status).toBe(400);
    }
    expect((await post('/consent-template', { token: 'not-hex' })).status).toBe(400);
    expect((await post('/consent-template', {})).status).toBe(400);
    expect(h.db.touched.size).toBe(0);
  });

  it('serves the candidate notice to a candidate round and the staff notice to a staff round', async () => {
    addStaffTemplate(h.tables);
    const candidate = await post('/consent-template', { token: LINK });
    expect(candidate.body).toMatchObject({ locale: 'en-IN', title: 'R1 notice' });

    makeStaffRound(h.tables);
    const staff = await post('/consent-template', { token: LINK });
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({
      version: '002',
      locale: 'en-IN-x-staff',
      title: 'R1 staff dry run',
    });
    expect(staff.body).not.toHaveProperty('id');
  });

  it('adds the audience wording of each agreement (consent_items) for the PR-CT keys', async () => {
    addStaffTemplate(h.tables);
    for (const row of h.tables.interview_round_consent_templates!) row.required_consents = PRCT_KEYS;

    const candidate = (await post('/consent-template', { token: LINK })).body;
    expect(candidate.consent_items.map((item: { type: string }) => item.type)).toEqual(PRCT_KEYS);
    expect(candidate.consent_items.find((item: any) => item.type === 'ai_evaluation').label)
      .toMatch(/may update my application status/);

    makeStaffRound(h.tables);
    const staff = (await post('/consent-template', { token: LINK })).body;
    expect(staff.locale).toBe('en-IN-x-staff');
    expect(staff.consent_items.map((item: { type: string }) => item.type)).toEqual(PRCT_KEYS);
    // The staff notice says no decision is made: its agreement never promises a status change.
    expect(staff.consent_items.find((item: any) => item.type === 'ai_evaluation').label)
      .toMatch(/not used to make any decision/);
    expect(JSON.stringify(staff.consent_items)).not.toMatch(/application status/);
  });

  it('omits consent_items when a required key has no wording', async () => {
    const response = await post('/consent-template', { token: LINK });
    expect(response.body.required_consents).toContain('recording');
    expect(response.body).not.toHaveProperty('consent_items');
  });

  it('fails closed with 503 when no active template exists for the audience', async () => {
    for (const row of h.tables.interview_round_consent_templates!) row.is_active = false;
    const none = await post('/consent-template', { token: LINK });
    expect(none.status).toBe(503);
    expect(none.body).toEqual({ error: 'consent_template_unavailable' });

    use();
    makeStaffRound(h.tables);
    // Only the candidate notice exists: a staff round never falls back to it.
    const staff = await post('/consent-template', { token: LINK });
    expect(staff.status).toBe(503);
    expect(staff.body).toEqual({ error: 'consent_template_unavailable' });
  });

  it('fails closed for a round whose audience is neither of the two', async () => {
    h.tables.interview_rounds![0]!.consent_locale = 'hi-IN';
    const response = await post('/consent-template', { token: LINK });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'consent_template_unavailable' });
  });

  it('serves no notice for an audience behind the newest overall (admission max)', async () => {
    addStaffTemplate(h.tables, '003');
    const stale = await post('/consent-template', { token: LINK });
    expect(stale.status).toBe(503);
    expect(stale.body).toEqual({ error: 'consent_template_unavailable' });
    makeStaffRound(h.tables);
    const current = await post('/consent-template', { token: LINK });
    expect(current.status).toBe(200);
    expect(current.body.version).toBe('003');
  });

  it('answers 503, never 404, when the round lookup fails', async () => {
    use(seedTables(), {}, true, { interview_rounds: { message: 'interview_rounds down' } });
    const response = await post('/consent-template', { token: LINK });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
    // The link was never authenticated, so no notice was looked up.
    expect(h.db.touched).not.toContain('interview_round_consent_templates');
  });

  it('answers 503, never 404 or an empty notice, when ONLY the template read fails', async () => {
    // The round lookup succeeds, so this reaches the template-read failure branch itself.
    use(seedTables(), {}, true, {
      interview_round_consent_templates: { message: 'interview_round_consent_templates down' },
    });
    const response = await post('/consent-template', { token: LINK });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
    expect(h.db.touched).toContain('interview_rounds');
    expect(h.db.touched).toContain('interview_round_consent_templates');

    // The same fault on a grant: nothing is recorded against a notice that could not be read.
    const grant = await post('/consent', {
      token: LINK,
      template_version: '002',
      consents: REQUIRED,
      status: 'granted',
    });
    expect(grant.status).toBe(503);
    expect(grant.body).toEqual({ error: 'service_unavailable' });
    expect(h.tables.interview_round_consents).toHaveLength(0);
  });
});

describe('POST /api/r1/consent', () => {
  const grant = (over: object = {}) => post('/consent', {
    token: LINK,
    template_version: '002',
    consents: REQUIRED,
    status: 'granted',
    ...over,
  });

  it('records a grant in the R1 tables only, with proof and a token-free audit', async () => {
    const response = await grant({ consents: [...REQUIRED, 'recording'] });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'granted',
      consents: REQUIRED,
      template_version: '002',
      locale: 'en-IN',
    });
    const row = h.tables.interview_round_consents![0]!;
    expect(row).toMatchObject({ round_id: ROUND, template_id: TEMPLATE, consents: REQUIRED });
    expect(row.proof).toMatchObject({ decision: 'granted', template_version: '002' });
    expect(row.withdrawn_at).toBeUndefined();
    expect(h.db.touched).not.toContain('consent_records');
    expect(h.db.touched).not.toContain('consent_templates');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      resource: 'interview_round_consent',
      round_id: ROUND,
      consent_status: 'granted',
    });
    expect(JSON.stringify(audits)).not.toContain(LINK);
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('granted');
  });

  it('refuses a stale template version, and a grant missing a required consent', async () => {
    const stale = await grant({ template_version: '001' });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'consent_template_stale', template_version: '002' });

    const missing = await grant({ consents: ['ai_interview'] });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({
      error: 'required_consents_missing',
      missing_consents: ['recording', 'ai_evaluation'],
    });
    expect(h.tables.interview_round_consents).toHaveLength(0);
  });

  it('fails closed when the active template requires nothing or does not exist', async () => {
    h.tables.interview_round_consent_templates!.find((t) => t.id === TEMPLATE)!
      .required_consents = [];
    expect((await grant({ consents: [] })).status).toBe(503);
    for (const row of h.tables.interview_round_consent_templates!) row.is_active = false;
    const none = await grant();
    expect(none.status).toBe(503);
    expect(none.body.error).toBe('consent_template_unavailable');
  });

  it('takes no locale from the client: a locale, or any other key, is a 400 and writes nothing', async () => {
    addStaffTemplate(h.tables);
    for (const extra of [{ locale: 'en-IN' }, { locale: 'en-IN-x-staff' }, { other: 1 }]) {
      expect((await grant(extra)).status).toBe(400);
      expect((await grant({ ...extra, status: 'declined', consents: [] })).status).toBe(400);
    }
    expect(h.tables.interview_round_consents).toHaveLength(0);
    expect(h.db.rpcCalls).toEqual([]);
  });

  it('records a candidate round against the candidate notice, whatever else exists', async () => {
    addStaffTemplate(h.tables);
    const response = await grant();
    expect(response.status).toBe(201);
    expect(response.body.locale).toBe('en-IN');
    expect(h.tables.interview_round_consents![0]).toMatchObject({ template_id: TEMPLATE });
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({ locale: 'en-IN' });
  });

  it('records a staff round against the staff notice (en-IN-x-staff)', async () => {
    addStaffTemplate(h.tables);
    makeStaffRound(h.tables);
    const response = await grant();
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'granted', locale: 'en-IN-x-staff' });
    expect(h.tables.interview_round_consents![0]).toMatchObject({ template_id: STAFF_TEMPLATE });
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({
      decision: 'granted',
      locale: 'en-IN-x-staff',
    });
    // Both notices are authoritative at the same version, so admission accepts it.
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('granted');
    expect((await post('/attempts', { token: LINK })).status).toBe(201);
  });

  it('refuses a round whose audience is neither of the two', async () => {
    h.tables.interview_rounds![0]!.consent_locale = 'hi-IN';
    for (const over of [{}, { status: 'declined', consents: [] }]) {
      const response = await grant(over);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'consent_template_unavailable' });
    }
    expect(h.tables.interview_round_consents).toHaveLength(0);
  });

  it('refuses a grant no admission would accept: the audience is behind', async () => {
    addStaffTemplate(h.tables, '003');
    // The candidate notice's own newest is 002, but admission takes max(version)
    // across locales (003, staff). A recorded candidate grant would read
    // "required" forever.
    const response = await grant();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'consent_template_unavailable' });
    expect(h.tables.interview_round_consents).toHaveLength(0);
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('required');
  });

  it('accepts the grant in the audience that holds the authoritative version', async () => {
    addStaffTemplate(h.tables, '003');
    makeStaffRound(h.tables);
    const response = await grant({ template_version: '003' });
    expect(response.status).toBe(201);
    expect(h.tables.interview_round_consents![0]).toMatchObject({ template_id: STAFF_TEMPLATE });
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('granted');
  });

  it('still records a decline for an audience that is behind, or has no notice at all', async () => {
    addStaffTemplate(h.tables, '003');
    const behind = await grant({ status: 'declined', consents: [] });
    expect(behind.status).toBe(201);
    expect(behind.body.template_version).toBe('002');
    // The page repeats nothing here: a fresh round for the second decline.
    h.tables.interview_round_consents!.length = 0;
    // A staff round with no staff notice at all: the one in force carries the decline.
    h.tables.interview_round_consent_templates = h.tables.interview_round_consent_templates!
      .filter((row) => row.locale !== 'en-IN-x-staff');
    makeStaffRound(h.tables);
    const none = await grant({ status: 'declined', consents: [] });
    expect(none.status).toBe(201);
    expect(none.body.template_version).toBe('002');
    expect(h.tables.interview_round_consents![0]).toMatchObject({ template_id: TEMPLATE });
  });

  it('is idempotent for an already valid consent', async () => {
    await grant();
    const again = await grant();
    expect(again.status).toBe(200);
    expect(again.body.already_granted).toBe(true);
    expect(h.tables.interview_round_consents).toHaveLength(1);
  });

  it('supersedes a live consent for an older template, leaving exactly one live row', async () => {
    h.tables.interview_round_consent_templates!.find((t) => t.id === TEMPLATE)!.version = '003';
    grantConsent(h.tables, { template_id: 'old-template', consents: ['ai_interview'] });
    h.tables.interview_round_consent_templates!.push({
      id: 'old-template',
      version: '002',
      locale: 'en-IN',
      title: 'old',
      body_md: 'old',
      required_consents: ['ai_interview'],
      is_active: true,
    });
    const response = await grant({ template_version: '003' });
    expect(response.status).toBe(201);
    const rows = h.tables.interview_round_consents!;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.withdrawn_at)).toHaveLength(1);
    expect(rows[0]!.proof).toMatchObject({ decision: 'superseded' });
  });

  it('answers 409 when a concurrent grant wins the live-consent unique index', async () => {
    const real = h.db.from.bind(h.db);
    h.db.from = (table: string) => {
      const builder = real(table);
      if (table !== 'interview_round_consents') return builder;
      const insert = builder.insert;
      builder.insert = (row: any) => (row.consents?.length
        ? {
          select: () => ({
            single: async () => ({ data: null, error: { message: 'dup', code: '23505' } }),
          }),
        }
        : insert(row));
      return builder;
    };
    const response = await grant();
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('consent_conflict');
  });

  it('records a decline whatever template version the page held', async () => {
    const response = await grant({ status: 'declined', consents: [], template_version: '000' });
    expect(response.status).toBe(201);
    expect(response.body.template_version).toBe('002');
    expect(h.tables.interview_round_consents![0]!.template_id).toBe(TEMPLATE);
  });

  it('records a decline as an immediately-withdrawn row that flags the card', async () => {
    const response = await grant({ status: 'declined', consents: [] });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('declined');
    const row = h.tables.interview_round_consents![0]!;
    expect(row.consents).toEqual([]);
    expect(row.withdrawn_at).toBeTruthy();
    expect(row.proof).toMatchObject({ decision: 'declined' });
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('declined');
    // A decline never satisfies admission.
    expect((await post('/attempts', { token: LINK })).body.error).toBe('consent_required');
  });

  it('treats a decline after a grant as a withdrawal and stops the live session', async () => {
    grantConsent(h.tables);
    addSession(h.tables, { status: 'in_progress' });
    const response = await grant({ status: 'declined', consents: [] });
    expect(response.status).toBe(201);
    expect(h.tables.interview_round_consents!.every((row) => row.withdrawn_at)).toBe(true);
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith(`screening-${SESSION}`);
  });

  it('stores a decline after a grant as `declined`, which is what the HR card reads', async () => {
    grantConsent(h.tables);
    const response = await grant({ status: 'declined', consents: [] });
    expect(response.status).toBe(201);
    expect(h.db.rpcCalls.find((call) => call.fn === 'r1_withdraw_consent')!.args)
      .toMatchObject({ p_round_id: ROUND, p_decision: 'declined' });
    expect(h.tables.interview_round_consents).toHaveLength(1);
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({ decision: 'declined' });
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('declined');
  });

  it('refuses consent on an inactive round, and a GRANT when R1 is disabled', async () => {
    h.tables.interview_rounds![0]!.status = 'cancelled';
    expect((await grant()).body.error).toBe('round_not_admissible');
    h.tables.interview_rounds![0]!.status = 'invited';
    process.env.R1_ENABLED = 'false';
    expect((await grant()).body.error).toBe('r1_disabled');
  });

  it('records a decline even when R1 is off: the human alternative stays open', async () => {
    process.env.R1_ENABLED = 'false';
    const response = await grant({ status: 'declined', consents: [] });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('declined');
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({ decision: 'declined' });
    // A decline is never a back door to a grant.
    expect((await grant()).body.error).toBe('r1_disabled');
  });

  it('does not stack a second declined row when the page repeats a decline', async () => {
    expect((await grant({ status: 'declined', consents: [] })).status).toBe(201);
    expect((await grant({ status: 'declined', consents: [] })).status).toBe(201);
    expect(h.tables.interview_round_consents).toHaveLength(1);
  });

  it('answers 503 and keeps the decline when a live interview could not be stopped', async () => {
    grantConsent(h.tables);
    addSession(h.tables, { status: 'in_progress' });
    h.rooms.deleteRoom.mockRejectedValue(new Error('livekit down'));
    const failed = await grant({ status: 'declined', consents: [] });
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({
      error: 'r1_withdraw_incomplete',
      sessions_live: 1,
      sessions_stopped: 0,
    });
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({ decision: 'declined' });

    // The retry finds no live consent but is still handed the live session.
    h.rooms.deleteRoom.mockResolvedValue({});
    const retried = await grant({ status: 'declined', consents: [] });
    expect(retried.status).toBe(201);
    expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(2);
    expect(h.tables.interview_round_consents).toHaveLength(1);
  });

  it('answers the stable 404 for an unknown link and validates the body', async () => {
    expect((await grant({ token: 'c3'.repeat(32) })).body.error).toBe(STABLE_LINK_ERROR);
    expect((await grant({ consents: ['Not Valid'] })).status).toBe(400);
    expect((await grant({ status: 'maybe' })).status).toBe(400);
    expect((await grant({ extra: true })).status).toBe(400);
  });
});

describe('the notice audience is enforced on every read, not only when consent is captured', () => {
  const grantNotice = (over: object = {}) => post('/consent', {
    token: LINK,
    template_version: '002',
    consents: REQUIRED,
    status: 'granted',
    ...over,
  });

  /**
   * An operator marks the wrong round as a staff dry run (manual SQL is the staff workflow),
   * the real candidate consents to the STAFF notice ("no hiring decision is made about you"),
   * and the operator then sets the round back to the candidate notice.
   */
  async function consentAsStaffThenRemark(): Promise<void> {
    addStaffTemplate(h.tables);
    makeStaffRound(h.tables);
    const granted = await grantNotice();
    expect(granted.status).toBe(201);
    expect(granted.body.locale).toBe('en-IN-x-staff');
    h.tables.interview_rounds![0]!.consent_locale = 'en-IN';
  }

  it('reads a consent given to the staff notice as required once the round is re-marked', async () => {
    addStaffTemplate(h.tables);
    makeStaffRound(h.tables);
    expect((await grantNotice()).status).toBe(201);
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      consent: { state: 'granted', template_version: '002' },
      can_start: true,
    });

    h.tables.interview_rounds![0]!.consent_locale = 'en-IN';
    const after = await post('/status', { token: LINK });
    expect(after.body).toMatchObject({
      consent: { state: 'required', template_version: '002' },
      can_start: false,
    });
    // The consent row itself is untouched: only its standing for THIS audience changed.
    expect(h.tables.interview_round_consents).toHaveLength(1);
    expect(h.tables.interview_round_consents![0]!.withdrawn_at).toBeUndefined();
  });

  it('is symmetric: a candidate-notice consent never covers a round marked for staff', async () => {
    grantConsent(h.tables);
    addStaffTemplate(h.tables);
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('granted');
    makeStaffRound(h.tables);
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      consent: { state: 'required' },
      can_start: false,
    });
  });

  it('refuses a device check and a new attempt, spending nothing', async () => {
    await consentAsStaffThenRemark();

    const preflight = await post('/preflight', { token: LINK });
    expect(preflight.status).toBe(409);
    expect(preflight.body).toEqual({ error: 'consent_required' });
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.tables.r1_usage_ledger).toHaveLength(0);

    // Admission itself cannot tell the two notices apart (it would admit), so the route must.
    const attempt = await post('/attempts', { token: LINK });
    expect(attempt.status).toBe(409);
    expect(attempt.body).toEqual({ error: 'consent_required' });
    expect(h.db.rpcCalls.filter((call) => call.fn === 'r1_admit_attempt')).toHaveLength(0);
    expect(h.tables.call_sessions).toHaveLength(0);
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(0);
  });

  it('refuses a rejoin and an exchange for an attempt admitted before the re-mark', async () => {
    addStaffTemplate(h.tables);
    makeStaffRound(h.tables);
    expect((await grantNotice()).status).toBe(201);
    const secrets = await admit();
    h.tables.interview_rounds![0]!.consent_locale = 'en-IN';

    const rejoin = await post('/attempts', { token: LINK, nonce: secrets.nonce });
    expect(rejoin.status).toBe(409);
    expect(rejoin.body).toEqual({ error: 'consent_required' });

    const exchange = await post('/exchange', {
      attempt_token: secrets.attempt_token,
      nonce: secrets.nonce,
    });
    expect(exchange.status).toBe(409);
    expect(exchange.body).toEqual({ error: 'consent_required' });
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
  });

  it('lets the person consent to the notice they are now owed, superseding the old one', async () => {
    await consentAsStaffThenRemark();
    const response = await grantNotice();
    // Not `already_granted`: the staff consent did not count for this audience.
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'granted', locale: 'en-IN' });
    const rows = h.tables.interview_round_consents!;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.withdrawn_at)).toHaveLength(1);
    expect(rows[0]!.proof).toMatchObject({ decision: 'superseded' });
    expect(rows[1]).toMatchObject({ template_id: TEMPLATE });
    expect((await post('/status', { token: LINK })).body).toMatchObject({
      consent: { state: 'granted' },
      can_start: true,
    });
    expect((await post('/attempts', { token: LINK })).status).toBe(201);
  });
});

describe('the kill switch is not revealed to a caller who has not authenticated', () => {
  beforeEach(() => {
    process.env.R1_ENABLED = 'false';
  });

  const FAKE_LINK = 'b9'.repeat(32);

  it('answers the stable 404 for a made-up link on every route that checks the switch', async () => {
    const responses = [
      await post('/consent', {
        token: FAKE_LINK,
        template_version: '002',
        consents: REQUIRED,
        status: 'granted',
      }),
      await post('/preflight', { token: FAKE_LINK }),
      await post('/attempts', { token: FAKE_LINK }),
      await post('/attempts', { token: FAKE_LINK, nonce: '7'.repeat(64) }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: STABLE_LINK_ERROR });
    }
    const exchange = await post('/exchange', {
      attempt_token: `${SESSION}.9999999999.${'0'.repeat(64)}`,
      nonce: '7'.repeat(64),
    });
    expect(exchange.status).toBe(404);
    expect(exchange.body).toEqual({ error: STABLE_ATTEMPT_ERROR });
  });

  it('reports only the bare code, never the configuration behind it, to the link holder', async () => {
    grantConsent(h.tables);
    const grantRefused = await post('/consent', {
      token: LINK,
      template_version: '002',
      consents: REQUIRED,
      status: 'granted',
    });
    for (const response of [
      grantRefused,
      await post('/preflight', { token: LINK }),
      await post('/attempts', { token: LINK }),
    ]) {
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'r1_disabled' });
    }
    expect(h.tables.call_sessions).toHaveLength(0);
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
  });

  it('still reports it for the holder of a valid attempt token, without the configuration', async () => {
    process.env.R1_ENABLED = 'true';
    grantConsent(h.tables);
    const secrets = await admit();
    process.env.R1_ENABLED = 'false';
    const response = await post('/exchange', {
      attempt_token: secrets.attempt_token,
      nonce: secrets.nonce,
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'r1_disabled' });
    // A wrong nonce is still just the stable 404: the switch is behind the authentication.
    const wrong = await post('/exchange', {
      attempt_token: secrets.attempt_token,
      nonce: '5'.repeat(64),
    });
    expect(wrong.status).toBe(404);
    expect(wrong.body).toEqual({ error: STABLE_ATTEMPT_ERROR });
  });

  it('keeps withdrawal and decline outside the switch, as before', async () => {
    grantConsent(h.tables);
    expect((await post('/consent/withdraw', { token: LINK })).status).toBe(200);
    expect((await post('/consent', {
      token: LINK,
      template_version: '002',
      consents: [],
      status: 'declined',
    })).status).toBe(201);
  });
});

describe('POST /api/r1/consent/withdraw', () => {
  it('withdraws, stops a live in-progress room without cancelling the session', async () => {
    grantConsent(h.tables);
    addSession(h.tables, { status: 'in_progress' });
    const response = await post('/consent/withdraw', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, withdrawn: true, sessions_stopped: 1 });
    expect(h.tables.interview_round_consents![0]!.withdrawn_at).toBeTruthy();
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({ decision: 'withdrawn' });
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith(`screening-${SESSION}`);
    // A worker owns an in-progress session; it settles its own terminal state.
    expect(h.tables.call_sessions![0]!.status).toBe('in_progress');
    expect(audits[0]!.metadata).toMatchObject({ consent_status: 'withdrawn', round_id: ROUND });
  });

  it('cancels a created or waiting session so the single R1 slot is freed at once', async () => {
    for (const status of ['created', 'waiting']) {
      use(seedTables());
      grantConsent(h.tables);
      addSession(h.tables, { status });
      const response = await post('/consent/withdraw', { token: LINK });
      expect(response.body.sessions_stopped).toBe(1);
      expect(h.tables.call_sessions![0]).toMatchObject({
        status: 'cancelled',
        terminal_reason: 'recruiter_cancelled',
      });
    }
  });

  it('blocks everything that depended on the consent', async () => {
    grantConsent(h.tables);
    await post('/consent/withdraw', { token: LINK });
    expect((await post('/status', { token: LINK })).body.consent.state).toBe('withdrawn');
    expect((await post('/preflight', { token: LINK })).body.error).toBe('consent_required');
    expect((await post('/attempts', { token: LINK })).body.error).toBe('consent_required');
  });

  it('blocks an exchange that admission already allowed', async () => {
    grantConsent(h.tables);
    const secrets = await admit();
    await post('/consent/withdraw', { token: LINK });
    h.tables.call_sessions![0]!.status = 'created';
    const response = await post('/exchange', {
      attempt_token: secrets.attempt_token,
      nonce: secrets.nonce,
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('consent_required');
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
  });

  it('always works: switch off, maintenance on, round expired, done or cancelled', async () => {
    for (const arrange of [
      () => { process.env.R1_ENABLED = 'false'; },
      () => { h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1).toISOString(); },
      () => { h.tables.interview_rounds![0]!.status = 'completed'; },
      () => { h.tables.interview_rounds![0]!.status = 'cancelled'; },
    ]) {
      use(seedTables(), {
        maintenance: async () => ({ ok: true, enabled: true, reason: 'x', updatedAt: null }),
      });
      grantConsent(h.tables);
      arrange();
      const response = await post('/consent/withdraw', { token: LINK });
      expect(response.status).toBe(200);
      expect(response.body.withdrawn).toBe(true);
      process.env.R1_ENABLED = 'true';
    }
  });

  it('is idempotent and still answers when no consent is live', async () => {
    const response = await post('/consent/withdraw', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, withdrawn: false, sessions_stopped: 0 });
  });

  it('withdraws but answers 503, not 200, when a live interview could not be stopped', async () => {
    grantConsent(h.tables);
    addSession(h.tables, { status: 'in_progress' });
    h.rooms.deleteRoom.mockRejectedValue(new Error('livekit down'));
    const response = await post('/consent/withdraw', { token: LINK });
    // The consent IS withdrawn, but a 200 would tell the page nothing was live.
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'r1_withdraw_incomplete',
      withdrawn: true,
      sessions_live: 1,
      sessions_stopped: 0,
      retry_after_sec: WITHDRAW_RETRY_AFTER_SEC,
    });
    expect(response.headers['retry-after']).toBe(String(WITHDRAW_RETRY_AFTER_SEC));
    expect(h.tables.interview_round_consents![0]!.withdrawn_at).toBeTruthy();
    expect(audits[0]!.metadata).toMatchObject({ sessions_live: 1, sessions_stopped: 0 });
  });

  it('retries the room delete: a repeated withdrawal stops what failed first', async () => {
    grantConsent(h.tables);
    addSession(h.tables, { status: 'in_progress' });
    h.rooms.deleteRoom.mockRejectedValueOnce(new Error('livekit blip'));
    expect((await post('/consent/withdraw', { token: LINK })).status).toBe(503);

    const retry = await post('/consent/withdraw', { token: LINK });
    expect(retry.status).toBe(200);
    // Nothing left to withdraw, one live room stopped this time.
    expect(retry.body).toEqual({ ok: true, withdrawn: false, sessions_stopped: 1 });
    expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(2);
  });

  it('counts a created session as stopped once cancelled, even without a room', async () => {
    grantConsent(h.tables);
    addSession(h.tables, { status: 'created' });
    h.rooms.deleteRoom.mockRejectedValue(new Error('no such room'));
    const response = await post('/consent/withdraw', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.body.sessions_stopped).toBe(1);
    expect(h.tables.call_sessions![0]!.status).toBe('cancelled');
  });

  it('keeps the grant evidence: the request context is sent apart from the decision', async () => {
    grantConsent(h.tables, {
      proof: { decision: 'granted', ip_prefix: '198.51.100.0/24', user_agent: 'grant-agent' },
    });
    await request(h.app)
      .post('/api/r1/consent/withdraw')
      .set('user-agent', 'withdraw-agent')
      .send({ token: LINK });
    const call = h.db.rpcCalls.find((entry) => entry.fn === 'r1_withdraw_consent')!;
    expect(call.args).toMatchObject({ p_round_id: ROUND, p_decision: 'withdrawn' });
    // Only the request context travels as `p_proof`; the decision is its own argument.
    expect(Object.keys(call.args.p_proof).sort()).toEqual(['ip_prefix', 'user_agent']);
    expect(call.args.p_proof.user_agent).toBe('withdraw-agent');
    expect(h.tables.interview_round_consents![0]!.proof).toMatchObject({
      decision: 'withdrawn',
      ip_prefix: '198.51.100.0/24',
      user_agent: 'grant-agent',
      withdrawal: { user_agent: 'withdraw-agent' },
    });
  });

  it('answers 503 when the withdrawal itself cannot be recorded', async () => {
    h.db.rpc = async () => ({ data: null, error: { message: 'down' } });
    expect((await post('/consent/withdraw', { token: LINK })).status).toBe(503);
  });

  it('answers the stable 404 for an unknown link', async () => {
    const response = await post('/consent/withdraw', { token: 'd4'.repeat(32) });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe(STABLE_LINK_ERROR);
  });
});

describe('POST /api/r1/preflight', () => {
  beforeEach(() => {
    grantConsent(h.tables);
  });

  it('issues a camera+microphone-only, subscribe-less token for a disposable room', async () => {
    const response = await post('/preflight', { token: LINK });
    expect(response.status).toBe(200);
    const cloud = cloudLiveKitEndpoint();
    expect(response.body).toMatchObject({
      url: cloud.url,
      policy_version: 'r1-av-v1',
      max_seconds: 10,
      min_audio_packets: 50,
      min_video_frames: 45,
    });
    const verified = await new TokenVerifier(cloud.apiKey, cloud.apiSecret)
      .verify(response.body.livekit_token);
    expect(verified.video).toEqual({
      room: expect.stringMatching(/^preflight-/),
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone', 'camera'],
      canSubscribe: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    const payload = claims(response.body.livekit_token);
    expect(payload.exp - payload.nbf).toBeLessThanOrEqual(30);
    expect(payload.sub).toMatch(/^preflight-/);
    expect(h.rooms.createRoom).toHaveBeenCalledWith({
      name: verified.video!.room,
      emptyTimeout: 15,
      departureTimeout: 5,
      maxParticipants: 1,
      metadata: JSON.stringify({ channel: 'preflight', schema: 1 }),
    });
    expect(h.tables.r1_usage_ledger).toHaveLength(1);
    expect(h.tables.r1_usage_ledger![0]).toMatchObject({
      round_id: ROUND,
      participant_kind: 'preflight',
      seconds: 10,
    });
    expect(mocks.startRecording).not.toHaveBeenCalled();
  });

  it('cuts the room at the hard stop, because LiveKit only bounds the connection', async () => {
    await post('/preflight', { token: LINK });
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.delayMs).toBe(PREFLIGHT_HARD_STOP_MS);
    expect(PREFLIGHT_HARD_STOP_MS).toBeLessThanOrEqual(12_000);
    expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
    h.scheduled[0]!.work();
    expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(1);
  });

  it('signs with the R1 secret and returns the R1 URL when the R1 SFU is selected', async () => {
    selectR1Sfu(h);
    const response = await post('/preflight', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.body.url).toBe(R1_ENV.url);
    await expect(new TokenVerifier(R1_ENV.key, R1_ENV.secret).verify(response.body.livekit_token))
      .resolves.toBeTruthy();
    const cloud = cloudLiveKitEndpoint();
    await expect(new TokenVerifier(cloud.apiKey, cloud.apiSecret)
      .verify(response.body.livekit_token)).rejects.toBeTruthy();
  });

  it('enforces 3 per minute and 10 per link, creating no room when refused', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await post('/preflight', { token: LINK })).status).toBe(200);
    }
    const limited = await post('/preflight', { token: LINK });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('r1_preflight_rate_limited');
    expect(limited.headers['retry-after']).toBe('20');
    expect(h.rooms.createRoom).toHaveBeenCalledTimes(3);

    // Ten used in the past (outside the minute window): the lifetime cap holds.
    h.tables.r1_usage_ledger!.length = 0;
    for (let i = 0; i < 10; i += 1) {
      h.tables.r1_usage_ledger!.push({
        round_id: ROUND,
        participant_kind: 'preflight',
        occurred_at: NOW - 3_600_000,
      });
    }
    const exhausted = await post('/preflight', { token: LINK });
    expect(exhausted.status).toBe(429);
    expect(exhausted.body.error).toBe('r1_preflight_limit');
    expect(h.rooms.createRoom).toHaveBeenCalledTimes(3);
  });

  it('never lets a concurrent burst exceed the per-minute cap', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post('/preflight', { token: LINK })),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(5);
    expect(h.tables.r1_usage_ledger).toHaveLength(3);
    expect(h.rooms.createRoom).toHaveBeenCalledTimes(3);
  });

  it('requires valid consent, an open R1, no maintenance and a matching endpoint', async () => {
    h.tables.interview_round_consents!.length = 0;
    expect((await post('/preflight', { token: LINK })).body.error).toBe('consent_required');
    grantConsent(h.tables);

    h.tables.r1_settings![0]!.paused = true;
    expect((await post('/preflight', { token: LINK })).body.error).toBe('r1_paused');
    h.tables.r1_settings![0]!.paused = false;

    h.tables.r1_settings![0]!.livekit_target = 'r1';
    expect((await post('/preflight', { token: LINK })).body.error).toBe('r1_endpoint_mismatch');
    h.tables.r1_settings![0]!.livekit_target = 'cloud';

    process.env.R1_ENABLED = 'false';
    expect((await post('/preflight', { token: LINK })).body.error).toBe('r1_disabled');
    process.env.R1_ENABLED = 'true';

    h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1).toISOString();
    expect((await post('/preflight', { token: LINK })).body.error).toBe('round_not_admissible');
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.tables.r1_usage_ledger).toHaveLength(0);
  });

  it('is blocked by maintenance mode and by a maintenance read failure', async () => {
    use(h.tables, { maintenance: inMaintenance });
    expect((await post('/preflight', { token: LINK })).status).toBe(503);
    use(h.tables, { maintenance: async () => ({ ok: false }) });
    expect((await post('/preflight', { token: LINK })).status).toBe(503);
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
  });

  it('cleans up and answers 503 if the room cannot be created, spending the slot', async () => {
    h.rooms.createRoom.mockRejectedValueOnce(new Error('livekit down'));
    const response = await post('/preflight', { token: LINK });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'r1_room_unavailable' });
    expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(1);
    expect(h.tables.r1_usage_ledger).toHaveLength(1);
  });

  it('answers the stable 404 for an unknown link', async () => {
    expect((await post('/preflight', { token: 'e5'.repeat(32) })).body.error)
      .toBe(STABLE_LINK_ERROR);
  });
});

describe('POST /api/r1/attempts', () => {
  beforeEach(() => {
    grantConsent(h.tables);
  });

  it('admits an attempt and returns the attempt token and a nonce, never the persona', async () => {
    const response = await post('/attempts', { token: LINK });
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body).sort()).toEqual([
      'attempt_id',
      'attempt_number',
      'attempt_token',
      'attempt_token_expires_at',
      'nonce',
      'rejoin',
    ]);
    expect(response.body).toMatchObject({ attempt_number: 1, rejoin: false });
    expect(response.body.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.body)).not.toMatch(/p3_data|persona/);
    const stored = h.tables.interview_round_attempts![0]!;
    expect(stored.nonce_digest).toBe(sha256(response.body.nonce));
    expect(verifyAttemptToken(response.body.attempt_token, stored.nonce_digest, NOW)).toBe(true);
    expect(new Date(response.body.attempt_token_expires_at).getTime())
      .toBe(NOW + ATTEMPT_TOKEN_TTL_SEC * 1000);
    expect(JSON.stringify(audits)).not.toContain(response.body.nonce);
    expect(JSON.stringify(audits)).not.toContain(response.body.attempt_token);
    expect(JSON.stringify(audits)).not.toContain(LINK);
  });

  it('admits exactly one of two simultaneous requests; the other is told R1 is busy', async () => {
    const [a, b] = await Promise.all([
      post('/attempts', { token: LINK }),
      post('/attempts', { token: LINK }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const busy = a.status === 409 ? a : b;
    expect(busy.body).toEqual({ error: 'r1_busy', retry_after_sec: 1200 });
    expect(busy.headers['retry-after']).toBe('1200');
    expect(h.tables.call_sessions).toHaveLength(1);
  });

  it.each([
    ['disabled', 409, 'r1_disabled'],
    ['paused', 409, 'r1_paused'],
    ['capacity_exhausted', 409, 'r1_capacity_exhausted'],
    ['consent_missing', 409, 'consent_required'],
    ['cloud_capacity_exhausted', 409, 'r1_busy'],
    ['round_not_admissible', 409, 'round_not_admissible'],
    ['round_expired', 409, 'round_expired'],
    ['starts_exhausted', 409, 'starts_exhausted'],
    ['attempts_exhausted', 409, 'attempts_exhausted'],
    ['round_not_found', 404, STABLE_LINK_ERROR],
    ['r1_role_invalid', 503, 'r1_unavailable'],
    ['something_new', 503, 'service_unavailable'],
  ])('maps the admission refusal %s to %i %s', async (status, http, error) => {
    h.db.rpc = async () => ({ data: { status }, error: null });
    const response = await post('/attempts', { token: LINK });
    expect(response.status).toBe(http);
    expect(response.body.error).toBe(error);
  });

  it('answers 503 when admission itself fails', async () => {
    h.db.rpc = async () => ({ data: null, error: { message: 'down' } });
    expect((await post('/attempts', { token: LINK })).status).toBe(503);
  });

  it('refuses while DeepSeek is unhealthy, BEFORE admission spends a start', async () => {
    h.health.mockResolvedValue(false);
    const response = await post('/attempts', { token: LINK });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'r1_unavailable',
      retry_after_sec: UNHEALTHY_RETRY_AFTER_SEC,
    });
    expect(response.headers['retry-after']).toBe(String(UNHEALTHY_RETRY_AFTER_SEC));
    expect(h.db.rpcCalls.filter((call) => call.fn === 'r1_admit_attempt')).toHaveLength(0);
    expect(h.tables.call_sessions).toHaveLength(0);
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(0);

    h.health.mockResolvedValue(true);
    expect((await post('/attempts', { token: LINK })).status).toBe(201);
  });

  it('does not consult DeepSeek for a rejoin, which admits nothing', async () => {
    const first = await admit();
    h.health.mockClear();
    h.health.mockResolvedValue(false);
    const rejoin = await post('/attempts', { token: LINK, nonce: first.nonce });
    expect(rejoin.status).toBe(200);
    expect(h.health).not.toHaveBeenCalled();
  });

  it('refuses before spending a start: paused, mismatched, maintenance, unsigned', async () => {
    h.tables.r1_settings![0]!.paused = true;
    expect((await post('/attempts', { token: LINK })).body.error).toBe('r1_paused');
    h.tables.r1_settings![0]!.paused = false;

    h.tables.r1_settings![0]!.livekit_target = 'r1';
    expect((await post('/attempts', { token: LINK })).body.error).toBe('r1_endpoint_mismatch');
    h.tables.r1_settings![0]!.livekit_target = 'cloud';

    process.env.WORKER_CONTEXT_SECRET = 'short';
    expect((await post('/attempts', { token: LINK })).body.error).toBe('r1_unavailable');
    process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;

    use(h.tables, { maintenance: inMaintenance });
    expect((await post('/attempts', { token: LINK })).status).toBe(503);

    expect(h.db.rpcCalls.filter((call) => call.fn === 'r1_admit_attempt')).toHaveLength(0);
    expect(h.tables.call_sessions).toHaveLength(0);
  });

  it('distinguishes an expired round from a finished one and rejects an unknown link', async () => {
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1).toISOString();
    expect((await post('/attempts', { token: LINK })).body.error).toBe('round_expired');
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW + 1e9).toISOString();
    h.tables.interview_rounds![0]!.status = 'completed';
    expect((await post('/attempts', { token: LINK })).body.error).toBe('round_not_admissible');
    expect((await post('/attempts', { token: 'f6'.repeat(32) })).body.error)
      .toBe(STABLE_LINK_ERROR);
  });

  it('rejoins a live attempt with link + nonce, minting a fresh token only', async () => {
    const first = await admit();
    const rejoin = await post('/attempts', { token: LINK, nonce: first.nonce });
    expect(rejoin.status).toBe(200);
    expect(rejoin.body).toMatchObject({
      attempt_id: first.attempt_id,
      attempt_number: 1,
      rejoin: true,
    });
    expect(rejoin.body.nonce).toBeUndefined();
    expect(verifyAttemptToken(
      rejoin.body.attempt_token,
      h.tables.interview_round_attempts![0]!.nonce_digest,
      NOW,
    )).toBe(true);
    expect(h.tables.call_sessions).toHaveLength(1);
    expect(h.db.rpcCalls.filter((call) => call.fn === 'r1_admit_attempt')).toHaveLength(1);
  });

  it('never admits on a rejoin: wrong nonce, nothing live, withdrawn consent', async () => {
    const first = await admit();
    const wrong = await post('/attempts', { token: LINK, nonce: '9'.repeat(64) });
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toBe(STABLE_ATTEMPT_ERROR);

    h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW).toISOString();
    expect((await post('/attempts', { token: LINK, nonce: first.nonce })).body.error)
      .toBe('consent_required');
    h.tables.interview_round_consents![0]!.withdrawn_at = null;

    h.tables.call_sessions![0]!.status = 'completed';
    const gone = await post('/attempts', { token: LINK, nonce: first.nonce });
    expect(gone.status).toBe(409);
    expect(gone.body.error).toBe('r1_attempt_not_live');
    expect(h.db.rpcCalls.filter((call) => call.fn === 'r1_admit_attempt')).toHaveLength(1);
  });

  it('does not let one link rejoin another round\'s attempt', async () => {
    const first = await admit();
    h.tables.interview_rounds!.push({
      ...h.tables.interview_rounds![0]!,
      id: '20000000-0000-4000-8000-0000000000a2',
      link_token_digest: sha256('a2'.repeat(32)),
    });
    const other = await post('/attempts', { token: 'a2'.repeat(32), nonce: first.nonce });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('r1_attempt_not_live');
  });
});

describe('POST /api/r1/exchange', () => {
  async function ready(): Promise<{ attempt_token: string; nonce: string; attempt_id: string }> {
    grantConsent(h.tables);
    return admit();
  }
  const exchange = (secrets: { attempt_token: string; nonce: string }, over: object = {}) =>
    post('/exchange', { attempt_token: secrets.attempt_token, nonce: secrets.nonce, ...over });

  it('creates an egress-free R1 room, gates the worker, mints a camera+mic token', async () => {
    const secrets = await ready();
    const response = await exchange(secrets);
    expect(response.status).toBe(200);
    const cloud = cloudLiveKitEndpoint();
    expect(Object.keys(response.body).sort())
      .toEqual(['attempt_id', 'expires_at', 'livekit_token', 'url']);
    expect(response.body.url).toBe(cloud.url);
    expect(response.body.attempt_id).toBe(secrets.attempt_id);

    const room = `screening-${secrets.attempt_id}`;
    const verified = await new TokenVerifier(cloud.apiKey, cloud.apiSecret)
      .verify(response.body.livekit_token);
    expect(verified.video).toEqual({
      room,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone', 'camera'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    const payload = claims(response.body.livekit_token);
    expect(payload.exp - payload.nbf).toBe(CANDIDATE_TOKEN_TTL_SEC);
    expect(payload.sub)
      .toBe(`candidate-${CANDIDATE.slice(0, 8)}-${secrets.attempt_id.slice(0, 8)}`);
    expect(payload.name).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/Ava Candidate|private resume/i);

    // The room is the server-authored R1 room: marked, R1 limits, and no egress.
    expect(h.rooms.createRoom).toHaveBeenCalledTimes(1);
    const options = h.rooms.createRoom.mock.calls[0]![0] as any;
    expect(options).toMatchObject({ name: room, emptyTimeout: 180, maxParticipants: 3 });
    expect(JSON.parse(options.metadata)).toMatchObject({
      session_id: secrets.attempt_id,
      room_name: room,
      lane: 'r1',
    });
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(h.tables.call_sessions![0]).toMatchObject({ status: 'waiting', external_call_id: room });
    expect(h.tables.interview_round_attempts![0]!.nonce_digest)
      .toBe(sha256(secrets.nonce));
  });

  it('runs the cheapest gate first: health, room, worker, then dispatch', async () => {
    const secrets = await ready();
    await exchange(secrets);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]!;
    expect(order(h.health)).toBeLessThan(order(h.rooms.createRoom));
    expect(order(h.rooms.createRoom)).toBeLessThan(order(h.gate.ensureReadyWorker));
    expect(order(h.gate.ensureReadyWorker)).toBeLessThan(order(h.gate.dispatch));
    expect(h.gate.dispatch).toHaveBeenCalledWith({
      sessionId: secrets.attempt_id,
      roomName: `screening-${secrets.attempt_id}`,
    });
  });

  it('signs with the R1 secret only, returns the R1 URL, keeps the marked room', async () => {
    selectR1Sfu(h);
    const secrets = await ready();
    const response = await exchange(secrets);
    expect(response.status).toBe(200);
    expect(response.body.url).toBe(R1_ENV.url);
    await expect(new TokenVerifier(R1_ENV.key, R1_ENV.secret).verify(response.body.livekit_token))
      .resolves.toBeTruthy();
    const cloud = cloudLiveKitEndpoint();
    await expect(new TokenVerifier(cloud.apiKey, cloud.apiSecret)
      .verify(response.body.livekit_token)).rejects.toBeTruthy();
    expect(JSON.parse((h.rooms.createRoom.mock.calls[0]![0] as any).metadata).lane).toBe('r1');
    expect(mocks.startRecording).not.toHaveBeenCalled();
  });

  it('fails closed with zero LiveKit cost when DeepSeek is unhealthy, then recovers', async () => {
    const secrets = await ready();
    h.health.mockResolvedValueOnce(false);
    const down = await exchange(secrets);
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: 'r1_unavailable', retry_after_sec: 30 });
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.tables.call_sessions![0]!.status).toBe('created');
    expect((await exchange(secrets)).status).toBe(200);
  });

  it('answers 202 while the worker boots, keeps the attempt valid, dispatches once', async () => {
    const secrets = await ready();
    h.gate.ensureReadyWorker.mockResolvedValueOnce({ status: 'timeout' });
    const preparing = await exchange(secrets);
    expect(preparing.status).toBe(202);
    expect(preparing.body).toEqual({ status: 'preparing', retry_after_sec: 3 });
    expect(preparing.headers['retry-after']).toBe('3');
    expect(preparing.body.livekit_token).toBeUndefined();
    expect(h.gate.dispatch).not.toHaveBeenCalled();
    expect(h.tables.call_sessions![0]!.status).toBe('waiting');

    expect((await exchange(secrets)).status).toBe(200);
    expect(h.gate.dispatch).toHaveBeenCalledTimes(1);
    // The retry is a `waiting` rejoin: it re-asserts the (idempotent) marked room
    // once before the worker gate, and nothing else is created.
    expect(h.rooms.createRoom).toHaveBeenCalledTimes(2);
  });

  it('releases the worker and defers when the dispatch fails', async () => {
    const secrets = await ready();
    h.gate.dispatch.mockResolvedValueOnce(false);
    const response = await exchange(secrets);
    expect(response.status).toBe(202);
    expect(h.gate.releaseWorker).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: secrets.attempt_id,
    });
    expect((await exchange(secrets)).status).toBe(200);
  });

  it('never dispatches a second interviewer on retry, refresh or a simultaneous pair', async () => {
    const secrets = await ready();
    const [a, b] = await Promise.all([exchange(secrets), exchange(secrets)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await exchange(secrets)).status).toBe(200);
    expect(h.gate.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatched).toHaveLength(1);
  });

  it('never re-gates a dispatched interviewer: a rejoin readies no worker', async () => {
    const secrets = await ready();
    expect((await exchange(secrets)).status).toBe(200);
    expect(h.tables.call_sessions![0]!.status).toBe('waiting');
    expect(h.gate.ensureReadyWorker).toHaveBeenCalledTimes(1);

    // R1 sessions stay `waiting` while the interview runs, so every rejoin
    // (refresh, dropped connection) lands here. A Fly start failure on the
    // machine that hosts the live interview must never be reachable.
    h.gate.ensureReadyWorker.mockClear();
    h.gate.ensureReadyWorker.mockResolvedValue({ status: 'error' });
    for (let rejoin = 0; rejoin < 3; rejoin += 1) {
      const again = await exchange(secrets);
      expect(again.status).toBe(200);
      expect(again.body.livekit_token).toBeTruthy();
    }
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.gate.releaseWorker).not.toHaveBeenCalled();
    expect(h.gate.dispatch).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale job-less dispatch instead of minting into an agent-less room', async () => {
    const secrets = await ready();
    // What lk-liveness leaves behind after two dropped dispatches.
    h.dispatched.push(joblessDispatch(5 * 60_000, { id: 'AD_stale' }));
    const response = await exchange(secrets);
    expect(response.status).toBe(200);
    expect(h.deleteDispatch).toHaveBeenCalledWith('AD_stale', `screening-${secrets.attempt_id}`);
    expect(h.gate.ensureReadyWorker).toHaveBeenCalledTimes(1);
    expect(h.gate.dispatch).toHaveBeenCalledTimes(1);
    // Exactly one dispatch is left, and it is the one with a job.
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.state!.jobs).toHaveLength(1);
  });

  it('defers on a job-less dispatch another exchange is still making', async () => {
    const secrets = await ready();
    h.dispatched.push(joblessDispatch(3_000));
    const response = await exchange(secrets);
    expect(response.status).toBe(202);
    expect(response.body.livekit_token).toBeUndefined();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.gate.dispatch).not.toHaveBeenCalled();
    expect(h.deleteDispatch).not.toHaveBeenCalled();
  });

  it('proceeds on a dispatch that already has a job, readying no worker', async () => {
    const secrets = await ready();
    h.dispatched.push(runningDispatch());
    const response = await exchange(secrets);
    expect(response.status).toBe(200);
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.gate.dispatch).not.toHaveBeenCalled();
  });

  it('stops the join when consent is withdrawn while the worker boots', async () => {
    const secrets = await ready();
    h.gate.ensureReadyWorker.mockImplementationOnce(async () => {
      await post('/consent/withdraw', { token: LINK });
      return { status: 'ready', machineId: 'machine-1', epoch: 1, agentName: 'browser-screener' };
    });
    const response = await exchange(secrets);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('consent_required');
    expect(response.body.livekit_token).toBeUndefined();
  });

  it('defers instead of guessing when the dispatch list cannot be read', async () => {
    const secrets = await ready();
    use(h.tables, {
      dispatches: () => ({ listDispatch: async () => { throw new Error('list failed'); } }),
    });
    const response = await exchange(secrets);
    expect(response.status).toBe(202);
    expect(h.gate.dispatch).not.toHaveBeenCalled();
  });

  it('proceeds without a dispatch when on-demand orchestration is off', async () => {
    use(seedTables(), {}, false);
    const secrets = await ready();
    const response = await exchange(secrets);
    expect(response.status).toBe(200);
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.gate.dispatch).not.toHaveBeenCalled();
  });

  it('re-mints for an in-progress attempt without LiveKit, worker or DeepSeek', async () => {
    const secrets = await ready();
    expect((await exchange(secrets)).status).toBe(200);
    h.tables.call_sessions![0]!.status = 'in_progress';
    for (const fn of [h.health, h.rooms.createRoom, h.gate.ensureReadyWorker, h.gate.dispatch]) {
      fn.mockClear();
    }
    const response = await exchange(secrets);
    expect(response.status).toBe(200);
    expect(h.health).not.toHaveBeenCalled();
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.gate.dispatch).not.toHaveBeenCalled();
  });

  it('gives one stable 404 for a wrong nonce, foreign or expired token, and junk', async () => {
    const secrets = await ready();
    const checks = [
      { nonce: '8'.repeat(64) },
      { attempt_token: 'junk' },
      { attempt_token: `${secrets.attempt_id}.9999999999.${'0'.repeat(64)}` },
      {
        attempt_token: `30000000-0000-4000-8000-0000000000ff.${Math.floor(NOW / 1000) + 99}.`
          + '1'.repeat(64),
      },
    ];
    for (const over of checks) {
      const response = await exchange(secrets, over);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: STABLE_ATTEMPT_ERROR });
    }
    const stored = h.tables.interview_round_attempts![0]!;
    const expired = mintAttemptToken(
      { sessionId: secrets.attempt_id, nonceDigest: stored.nonce_digest },
      NOW - (ATTEMPT_TOKEN_TTL_SEC + 5) * 1000,
    )!;
    expect((await exchange(secrets, { attempt_token: expired.token })).body)
      .toEqual({ error: STABLE_ATTEMPT_ERROR });
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect((await post('/exchange', { attempt_token: secrets.attempt_token })).status).toBe(400);
  });

  it('binds a token to its own attempt: another attempt\'s nonce never opens it', async () => {
    const secrets = await ready();
    addSession(h.tables, {
      id: '30000000-0000-4000-8000-0000000000e2',
      external_call_id: 'screening-30000000-0000-4000-8000-0000000000e2',
      status: 'completed',
    });
    addAttempt(h.tables, 'other-nonce', { session_id: '30000000-0000-4000-8000-0000000000e2' });
    const forged = mintAttemptToken({
      sessionId: '30000000-0000-4000-8000-0000000000e2',
      nonceDigest: sha256(secrets.nonce),
    }, NOW)!;
    const response = await exchange(secrets, { attempt_token: forged.token });
    expect(response.status).toBe(404);
  });

  it('refuses sessions that are ended, not R1 browser sessions, or on a lapsed round', async () => {
    const secrets = await ready();
    h.tables.call_sessions![0]!.status = 'completed';
    expect((await exchange(secrets)).body.error).toBe('r1_attempt_ended');
    h.tables.call_sessions![0]!.status = 'created';

    h.tables.call_sessions![0]!.mode = 'live';
    expect((await exchange(secrets)).status).toBe(404);
    h.tables.call_sessions![0]!.mode = 'browser';

    h.tables.call_sessions![0]!.external_call_id = 'screening-someone-else';
    expect((await exchange(secrets)).status).toBe(404);
    h.tables.call_sessions![0]!.external_call_id = `screening-${secrets.attempt_id}`;

    h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1).toISOString();
    expect((await exchange(secrets)).body.error).toBe('round_not_admissible');
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
  });

  it('does not start a NEW room while paused, in maintenance or on a wrong endpoint', async () => {
    const secrets = await ready();
    h.tables.r1_settings![0]!.paused = true;
    expect((await exchange(secrets)).body.error).toBe('r1_paused');
    h.tables.r1_settings![0]!.paused = false;

    h.tables.r1_settings![0]!.livekit_target = 'r1';
    expect((await exchange(secrets)).body.error).toBe('r1_endpoint_mismatch');
    h.tables.r1_settings![0]!.livekit_target = 'cloud';

    use(h.tables, { maintenance: inMaintenance });
    expect((await exchange(secrets)).status).toBe(503);
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.health).not.toHaveBeenCalled();
  });

  it('answers 503 and leaves the attempt retryable when the room cannot be created', async () => {
    const secrets = await ready();
    h.rooms.createRoom.mockRejectedValue(new Error('livekit down'));
    h.rooms.updateRoomMetadata.mockRejectedValue(new Error('livekit down'));
    const response = await exchange(secrets);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('r1_room_unavailable');
    expect(h.tables.call_sessions![0]!.status).toBe('created');
    expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
  });

  it('is off with the master switch', async () => {
    const secrets = await ready();
    process.env.R1_ENABLED = 'false';
    expect((await exchange(secrets)).body.error).toBe('r1_disabled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-3 adversarial-review fixes: fence 7 on the R1 SFU, the waiting re-assert, the
// Cloud-fallback guard, the session/round binding and the live-job rejoin rule.

describe('POST /api/r1/exchange: review hardening', () => {
  const OTHER_ROUND = '20000000-0000-4000-8000-0000000000a2';
  const ROOM_OF = (id: string) => `screening-${id}`;

  async function ready(): Promise<{ attempt_token: string; nonce: string; attempt_id: string }> {
    grantConsent(h.tables);
    return admit();
  }
  const exchange = (secrets: { attempt_token: string; nonce: string }) =>
    post('/exchange', { attempt_token: secrets.attempt_token, nonce: secrets.nonce });
  const sessionRow = () => h.tables.call_sessions![0]!;

  describe('fence 7: the R1 SFU never mints a token without the worker gate', () => {
    it('answers 503 r1_unavailable BEFORE any room, recording or token when the gate is null', async () => {
      selectR1Sfu(h);
      const secrets = await ready();
      // Orchestration off, or BROWSER_AGENT_NAME empty or malformed: resolveGate() is null.
      use(h.tables, { resolveGate: () => null });
      const response = await exchange(secrets);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_unavailable' });
      expect(response.body.livekit_token).toBeUndefined();
      expect(h.health).not.toHaveBeenCalled();
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
      expect(h.rooms.updateRoomMetadata).not.toHaveBeenCalled();
      expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
      expect(mocks.startRecording).not.toHaveBeenCalled();
      expect(sessionRow()).toMatchObject({ status: 'created' });
    });

    it('treats a gate that cannot be built as missing, not as a proceed', async () => {
      selectR1Sfu(h);
      const secrets = await ready();
      use(h.tables, {
        resolveGate: () => {
          throw new Error('gate config exploded');
        },
      });
      const response = await exchange(secrets);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_unavailable' });
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
    });

    it('also refuses a waiting rejoin before it re-provisions anything', async () => {
      selectR1Sfu(h);
      const secrets = await ready();
      expect((await exchange(secrets)).status).toBe(200);
      expect(sessionRow().status).toBe('waiting');
      use(h.tables, { resolveGate: () => null });
      const response = await exchange(secrets);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_unavailable' });
      expect(response.body.livekit_token).toBeUndefined();
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
      expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    });

    it('refuses new work before admission spends a start or capacity', async () => {
      selectR1Sfu(h);
      grantConsent(h.tables);
      use(h.tables, { resolveGate: () => null });
      const attempts = await post('/attempts', { token: LINK });
      expect(attempts.status).toBe(503);
      expect(attempts.body).toEqual({ error: 'r1_unavailable' });
      expect(h.tables.interview_rounds![0]!.starts_used).toBe(0);
      expect(h.tables.call_sessions).toHaveLength(0);
      const preflight = await post('/preflight', { token: LINK });
      expect(preflight.status).toBe(503);
      expect(preflight.body).toEqual({ error: 'r1_unavailable' });
      expect(h.tables.r1_usage_ledger).toHaveLength(0);
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
    });

    it('answers 202 preparing, never a token, for a disabled verdict on the R1 SFU', async () => {
      selectR1Sfu(h);
      const secrets = await ready();
      h.gate.ensureReadyWorker.mockResolvedValueOnce({ status: 'disabled' });
      const response = await exchange(secrets);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'preparing', retry_after_sec: 3 });
      expect(response.headers['retry-after']).toBe('3');
      expect(response.body.livekit_token).toBeUndefined();
      expect(h.gate.dispatch).not.toHaveBeenCalled();
      // The attempt stays valid: the next exchange (gate enabled again) joins.
      expect((await exchange(secrets)).status).toBe(200);
    });

    it('leaves Cloud as it was: a disabled verdict still proceeds on the unnamed worker', async () => {
      const secrets = await ready();
      h.gate.ensureReadyWorker.mockResolvedValueOnce({ status: 'disabled' });
      const response = await exchange(secrets);
      expect(response.status).toBe(200);
      expect(response.body.livekit_token).toBeTruthy();
      expect(h.gate.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('the Cloud fallback is refused while the legacy browser lane is enabled', () => {
    it('answers 503 r1_unavailable before a room, a recording or any spend', async () => {
      const secrets = await ready();
      use(h.tables, { legacyBrowserEnabled: () => true });
      const response = await exchange(secrets);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_unavailable' });
      expect(response.body.livekit_token).toBeUndefined();
      expect(h.health).not.toHaveBeenCalled();
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
      expect(mocks.startRecording).not.toHaveBeenCalled();
      expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
      expect(sessionRow().status).toBe('created');
    });

    it('refuses /attempts and /preflight first, so no start or capacity is spent', async () => {
      grantConsent(h.tables);
      use(h.tables, { legacyBrowserEnabled: () => true });
      const attempts = await post('/attempts', { token: LINK });
      expect(attempts.status).toBe(503);
      expect(attempts.body).toEqual({ error: 'r1_unavailable' });
      expect(h.tables.interview_rounds![0]!.starts_used).toBe(0);
      expect(h.tables.call_sessions).toHaveLength(0);
      const preflight = await post('/preflight', { token: LINK });
      expect(preflight.status).toBe(503);
      expect(h.tables.r1_usage_ledger).toHaveLength(0);
    });

    it('does not apply to the R1 SFU, which has no Cloud worker to refuse the room', async () => {
      selectR1Sfu(h);
      const secrets = await ready();
      use(h.tables, { legacyBrowserEnabled: () => true });
      expect((await exchange(secrets)).status).toBe(200);
    });

    it('reads the PR-L switch by default: enabled refuses, retired lets R1 through', async () => {
      const saved = process.env.LEGACY_BROWSER_SCREENING_ENABLED;
      try {
        const secrets = await ready();
        use(h.tables, { legacyBrowserEnabled: undefined });
        process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'true';
        expect((await exchange(secrets)).body).toEqual({ error: 'r1_unavailable' });
        process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'false';
        expect((await exchange(secrets)).status).toBe(200);
      } finally {
        if (saved === undefined) delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
        else process.env.LEGACY_BROWSER_SCREENING_ENABLED = saved;
      }
    });
  });

  describe.each([
    ['the Cloud fallback', false],
    ['the R1 SFU', true],
  ])('a waiting attempt re-asserts its marked room (%s)', (_label, r1) => {
    beforeEach(() => {
      if (r1) selectR1Sfu(h);
    });

    it('re-provisions the marked, egress-free room BEFORE the worker gate dispatches', async () => {
      const secrets = await ready();
      expect((await exchange(secrets)).status).toBe(200);
      expect(sessionRow()).toMatchObject({
        status: 'waiting',
        external_call_id: ROOM_OF(secrets.attempt_id),
      });

      // The room lapsed (180 s empty) or a refusing worker deleted it, and the
      // interviewer that was dispatched into it is gone.
      h.dispatched.splice(0);
      for (const fn of [h.rooms.createRoom, h.gate.ensureReadyWorker, h.gate.dispatch]) {
        fn.mockClear();
      }
      const again = await exchange(secrets);
      expect(again.status).toBe(200);
      expect(again.body.livekit_token).toBeTruthy();

      expect(h.rooms.createRoom).toHaveBeenCalledTimes(1);
      const options = h.rooms.createRoom.mock.calls[0]![0] as any;
      expect(options).toMatchObject({
        name: ROOM_OF(secrets.attempt_id),
        emptyTimeout: 180,
        maxParticipants: 3,
        departureTimeout: 120,
      });
      expect(JSON.parse(options.metadata)).toMatchObject({
        session_id: secrets.attempt_id,
        lane: 'r1',
      });
      expect(mocks.startRecording).not.toHaveBeenCalled();
      const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
        fn.mock.invocationCallOrder[0]!;
      expect(order(h.rooms.createRoom)).toBeLessThan(order(h.gate.ensureReadyWorker));
      expect(order(h.gate.ensureReadyWorker)).toBeLessThan(order(h.gate.dispatch));
      // Adopting a `waiting` session changes nothing about it.
      expect(sessionRow()).toMatchObject({
        status: 'waiting',
        external_call_id: ROOM_OF(secrets.attempt_id),
      });
    });

    it('answers 503 r1_room_unavailable with no token when the room cannot be re-asserted', async () => {
      const secrets = await ready();
      expect((await exchange(secrets)).status).toBe(200);
      h.dispatched.splice(0);
      for (const fn of [h.gate.ensureReadyWorker, h.gate.dispatch]) fn.mockClear();
      h.rooms.createRoom.mockRejectedValue(new Error('livekit down'));
      h.rooms.updateRoomMetadata.mockRejectedValue(new Error('livekit down'));
      const response = await exchange(secrets);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_room_unavailable' });
      expect(response.body.livekit_token).toBeUndefined();
      expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
      expect(h.gate.dispatch).not.toHaveBeenCalled();
      expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
      expect(sessionRow().status).toBe('waiting');

      // LiveKit recovers: the same attempt converges.
      h.rooms.createRoom.mockResolvedValue({});
      expect((await exchange(secrets)).status).toBe(200);
    });

    it('leaves an in_progress attempt alone: no room, worker or gate', async () => {
      const secrets = await ready();
      expect((await exchange(secrets)).status).toBe(200);
      sessionRow().status = 'in_progress';
      for (const fn of [h.rooms.createRoom, h.gate.ensureReadyWorker, h.gate.dispatch]) {
        fn.mockClear();
      }
      expect((await exchange(secrets)).status).toBe(200);
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
      expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['no round (interview_round_id null)', null],
    ['another round id', OTHER_ROUND],
  ])('a session bound to %s is never provisioned or joined', (_label, roundId) => {
    it.each(['created', 'waiting'])('answers the stable 404 on the %s path', async (status) => {
      const secrets = await ready();
      sessionRow().interview_round_id = roundId;
      sessionRow().status = status;
      sessionRow().external_call_id = ROOM_OF(secrets.attempt_id);
      h.health.mockClear(); // admission probed DeepSeek; the exchange must not
      const response = await exchange(secrets);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: STABLE_ATTEMPT_ERROR });
      expect(response.body.livekit_token).toBeUndefined();
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
      expect(h.rooms.updateRoomMetadata).not.toHaveBeenCalled();
      expect(h.health).not.toHaveBeenCalled();
      expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
      expect(mocks.startRecording).not.toHaveBeenCalled();
    });
  });

  describe('a finished job is not a running interviewer', () => {
    const deadDispatch = (state: Record<string, unknown>) => ({
      id: 'AD_dead',
      agentName: 'browser-screener',
      state: {
        jobs: [{ id: 'AJ_dead', state }],
        createdAt: dispatchCreatedAt(5 * 60_000),
      },
    });

    it.each([
      ['JS_FAILED', { status: 'JS_FAILED' }],
      ['JS_SUCCESS', { status: 'JS_SUCCESS' }],
      ['an endedAt stamp', { status: 'JS_RUNNING', endedAt: BigInt(NOW) * 1_000_000n }],
    ])('replaces a rejoin room whose only job ended (%s) instead of minting into it', async (_l, state) => {
      const secrets = await ready();
      expect((await exchange(secrets)).status).toBe(200);
      h.dispatched.splice(0, h.dispatched.length, deadDispatch(state));
      for (const fn of [h.gate.ensureReadyWorker, h.gate.dispatch]) fn.mockClear();
      const response = await exchange(secrets);
      expect(response.status).toBe(200);
      expect(h.deleteDispatch).toHaveBeenCalledWith('AD_dead', ROOM_OF(secrets.attempt_id));
      expect(h.gate.ensureReadyWorker).toHaveBeenCalledTimes(1);
      expect(h.gate.dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
