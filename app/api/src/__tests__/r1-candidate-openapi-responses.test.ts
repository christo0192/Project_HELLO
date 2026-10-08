/**
 * The R1 candidate routes' REAL responses, held against openapi.yaml.
 *
 * The web client parses these bodies strictly and fails closed, and the spec's success
 * schemas are `additionalProperties: false`, so a field added to a handler (or dropped
 * from the spec) breaks every invited candidate while each suite still passes on its own
 * side. This suite drives the real router, through the same in-memory harness as
 * r1-candidate-routes.test.ts, into every response the spec documents, and checks that:
 *
 *   1. every status a route answers is a status the spec documents for it;
 *   2. every documented body schema accepts the real body (required keys, types, enums,
 *      formats, and no undocumented key where the schema is closed);
 *   3. every machine error code a route answers is named in that route's spec section,
 *      and every code the router source can answer is named somewhere in the spec;
 *   4. every status the spec documents for a route is exercised here, so a documented
 *      response nothing produces cannot linger.
 *
 * It uses the validator shared with contract-openapi.test.ts (support/openapi-schema.ts).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

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

import { getAuditSink, setAuditSink } from '../lib/audit.js';
import { createReadyLimiter } from '../lib/r1/ready-limiter.js';
import {
  LINK,
  NOW,
  REQUIRED,
  WORKER_SECRET,
  addSession,
  buildHarness,
  grantConsent,
  seedTables,
  type Harness,
} from './support/r1-candidate-harness.js';
import { parseYamlDocument, validateSchema, type YMap } from './support/openapi-schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC_TEXT = readFileSync(path.resolve(here, '../../openapi/openapi.yaml'), 'utf8')
  .replace(/\r\n/g, '\n');
const SPEC = parseYamlDocument(SPEC_TEXT);
const SOURCE = readFileSync(path.resolve(here, '../routes/r1-candidate.ts'), 'utf8');

const ROUTES = [
  '/api/r1/status',
  '/api/r1/consent-template',
  '/api/r1/consent',
  '/api/r1/consent/withdraw',
  '/api/r1/preflight',
  '/api/r1/attempts',
  '/api/r1/exchange',
  '/api/r1/ready',
] as const;
type Route = (typeof ROUTES)[number];

const FAKE_LINK = 'b7'.repeat(32);

function operation(route: Route): YMap {
  return ((SPEC.paths as YMap)[route] as YMap).post as YMap;
}

/** The spec text of one path: from its header line to the next path. */
function sectionFor(route: Route): string {
  const start = SPEC_TEXT.indexOf(`\n  ${route}:\n`);
  expect(start, `${route} is documented`).toBeGreaterThan(-1);
  const rest = SPEC_TEXT.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\/|\n {2}#/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function documentedStatuses(route: Route): string[] {
  return Object.keys(operation(route).responses as YMap);
}

function bodySchema(route: Route, status: number): unknown {
  const response = (operation(route).responses as YMap)[String(status)] as YMap | undefined;
  const content = response?.content as YMap | undefined;
  return (content?.['application/json'] as YMap | undefined)?.schema;
}

/** The statuses each route answered during THIS test, and what the spec took exception to. */
let seen: Map<Route, Set<number>>;
let problems: string[];

/** The test is over: nothing was wrong, and every documented status was produced. */
function finish(route: Route): void {
  expect(problems, route).toEqual([]);
  expect(
    [...(seen.get(route) ?? [])].map(String).sort(),
    `${route}: every documented status is exercised, and no other`,
  ).toEqual(documentedStatuses(route).sort());
}

const R1_ENV_KEYS = ['R1_ENABLED', 'WORKER_CONTEXT_SECRET', 'BROWSER_LIVEKIT_TARGET'];
const savedEnv: Record<string, string | undefined> = {};
let originalSink: ReturnType<typeof getAuditSink>;
let h: Harness;

function fresh(
  tables = seedTables(),
  overrides: Parameters<typeof buildHarness>[1] = {},
  failures?: Parameters<typeof buildHarness>[3],
): Harness {
  h = buildHarness(tables, overrides, true, failures);
  mocks.db.current = h.db;
  return h;
}

beforeEach(() => {
  seen = new Map();
  problems = [];
  for (const key of R1_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  delete process.env.BROWSER_LIVEKIT_TARGET;
  mocks.startRecording.mockReset();
  originalSink = getAuditSink();
  setAuditSink(() => undefined);
  fresh();
});

afterEach(() => {
  setAuditSink(originalSink);
  for (const key of R1_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/**
 * Send one request to a route, check the answer against the spec, and return it.
 * `expectedStatus` is asserted so a scenario that drifts into another state fails loudly
 * instead of silently validating the wrong response.
 */
async function hit(
  route: Route,
  body: unknown,
  expectedStatus: number,
  expectedCode?: string,
): Promise<request.Response> {
  const response = await request(h.app).post(route).send(body as object);
  expect(response.status, `${route} ${JSON.stringify(response.body)}`).toBe(expectedStatus);
  seen.set(route, (seen.get(route) ?? new Set()).add(response.status));

  const where = `${route} ${response.status}`;
  if (!documentedStatuses(route).includes(String(response.status))) {
    problems.push(`${where}: the spec does not document this status`);
  }
  const schema = bodySchema(route, response.status);
  if (schema !== undefined) {
    for (const error of validateSchema(response.body, schema, SPEC)) {
      problems.push(`${where}: ${error}`);
    }
  }
  const code = (response.body as { error?: unknown }).error;
  if (typeof code === 'string') {
    if (!new RegExp(`\\b${code}\\b`).test(sectionFor(route))) {
      problems.push(`${where}: the error code ${code} is not named in the spec for this route`);
    }
    if (expectedCode) expect(code).toBe(expectedCode);
  } else if (expectedCode) {
    problems.push(`${where}: expected the error code ${expectedCode}, got ${JSON.stringify(code)}`);
  }
  return response;
}

const grant = (over: object = {}) => ({
  token: LINK,
  template_version: '002',
  consents: REQUIRED,
  status: 'granted',
  ...over,
});

describe('R1 candidate routes: real responses against openapi.yaml', () => {
  it('POST /api/r1/status', async () => {
    await hit('/api/r1/status', { token: LINK }, 200);
    grantConsent(h.tables);
    const granted = await hit('/api/r1/status', { token: LINK }, 200);
    expect(granted.body.consent.state).toBe('granted');
    await hit('/api/r1/status', { token: 'nope' }, 400);
    await hit('/api/r1/status', { token: FAKE_LINK }, 404, 'r1_link_invalid_or_expired');
    fresh(seedTables(), {}, { interview_rounds: { message: 'down' } });
    await hit('/api/r1/status', { token: LINK }, 503, 'service_unavailable');
    finish('/api/r1/status');
  });

  it('POST /api/r1/consent-template', async () => {
    await hit('/api/r1/consent-template', { token: LINK }, 200);
    await hit('/api/r1/consent-template', { token: LINK, locale: 'en-IN' }, 400);
    await hit('/api/r1/consent-template', { token: FAKE_LINK }, 404);
    const tables = seedTables();
    for (const row of tables.interview_round_consent_templates!) row.is_active = false;
    fresh(tables);
    await hit('/api/r1/consent-template', { token: LINK }, 503, 'consent_template_unavailable');
    fresh(seedTables(), {}, {
      interview_round_consent_templates: { message: 'down' },
    });
    await hit('/api/r1/consent-template', { token: LINK }, 503, 'service_unavailable');
    finish('/api/r1/consent-template');
  });

  it('POST /api/r1/consent', async () => {
    await hit('/api/r1/consent', grant(), 201);
    await hit('/api/r1/consent', grant(), 200);
    fresh();
    await hit('/api/r1/consent', grant({ status: 'declined', consents: [] }), 201);
    fresh();
    await hit('/api/r1/consent', grant({ extra: true }), 400);
    await hit('/api/r1/consent', grant({ consents: ['ai_interview'] }), 400, 'required_consents_missing');
    await hit('/api/r1/consent', grant({ token: FAKE_LINK }), 404);
    await hit('/api/r1/consent', grant({ template_version: '001' }), 409, 'consent_template_stale');
    process.env.R1_ENABLED = 'false';
    await hit('/api/r1/consent', grant(), 409, 'r1_disabled');
    process.env.R1_ENABLED = 'true';
    const tables = seedTables();
    for (const row of tables.interview_round_consent_templates!) row.is_active = false;
    fresh(tables);
    await hit('/api/r1/consent', grant(), 503, 'consent_template_unavailable');
    // A decline that could not stop a live interview: same body as the withdrawal's.
    const live = seedTables();
    grantConsent(live);
    addSession(live, { status: 'in_progress' });
    fresh(live);
    h.rooms.deleteRoom.mockRejectedValue(new Error('livekit down'));
    const incomplete = await hit(
      '/api/r1/consent',
      grant({ status: 'declined', consents: [] }),
      503,
      'r1_withdraw_incomplete',
    );
    expect(incomplete.body).toMatchObject({ sessions_live: 1, sessions_stopped: 0 });
    finish('/api/r1/consent');
  });

  it('POST /api/r1/consent/withdraw', async () => {
    const live = seedTables();
    grantConsent(live);
    addSession(live, { status: 'in_progress' });
    fresh(live);
    await hit('/api/r1/consent/withdraw', { token: LINK }, 200);
    // Nothing live any more: still a clean 200.
    const again = await hit('/api/r1/consent/withdraw', { token: LINK }, 200);
    expect(again.body.withdrawn).toBe(false);
    await hit('/api/r1/consent/withdraw', { token: 'nope' }, 400);
    await hit('/api/r1/consent/withdraw', { token: FAKE_LINK }, 404);

    const stuck = seedTables();
    grantConsent(stuck);
    addSession(stuck, { status: 'in_progress' });
    fresh(stuck);
    h.rooms.deleteRoom.mockRejectedValue(new Error('livekit down'));
    await hit('/api/r1/consent/withdraw', { token: LINK }, 503, 'r1_withdraw_incomplete');
    fresh();
    h.db.rpc = async () => ({ data: null, error: { message: 'down' } });
    await hit('/api/r1/consent/withdraw', { token: LINK }, 503, 'service_unavailable');
    finish('/api/r1/consent/withdraw');
  });

  it('POST /api/r1/preflight', async () => {
    grantConsent(h.tables);
    await hit('/api/r1/preflight', { token: LINK }, 200);
    await hit('/api/r1/preflight', { token: 'nope' }, 400);
    await hit('/api/r1/preflight', { token: FAKE_LINK }, 404);
    // Three in a minute, then the per-minute cap.
    await hit('/api/r1/preflight', { token: LINK }, 200);
    await hit('/api/r1/preflight', { token: LINK }, 200);
    await hit('/api/r1/preflight', { token: LINK }, 429, 'r1_preflight_rate_limited');
    // Ten spent long ago: the lifetime cap.
    h.tables.r1_usage_ledger!.length = 0;
    for (let i = 0; i < 10; i += 1) {
      h.tables.r1_usage_ledger!.push({
        round_id: '20000000-0000-4000-8000-0000000000a1',
        participant_kind: 'preflight',
        occurred_at: NOW - 3_600_000,
      });
    }
    await hit('/api/r1/preflight', { token: LINK }, 429, 'r1_preflight_limit');

    fresh();
    await hit('/api/r1/preflight', { token: LINK }, 409, 'consent_required');
    grantConsent(h.tables);
    h.tables.r1_settings![0]!.paused = true;
    await hit('/api/r1/preflight', { token: LINK }, 409, 'r1_paused');
    h.tables.r1_settings![0]!.paused = false;
    h.rooms.createRoom.mockRejectedValue(new Error('livekit down'));
    await hit('/api/r1/preflight', { token: LINK }, 503, 'r1_room_unavailable');
    fresh(seedTables(), {
      maintenance: async () => ({ ok: true, enabled: true, reason: null, updatedAt: null }),
    });
    grantConsent(h.tables);
    // Maintenance answers the shared envelope (an object, not a code), still a documented 503.
    const maintenance = await hit('/api/r1/preflight', { token: LINK }, 503);
    expect(maintenance.body).toEqual({
      error: { type: 'maintenance_mode', message: 'Service temporarily unavailable' },
    });
    finish('/api/r1/preflight');
  });

  it('POST /api/r1/attempts', async () => {
    grantConsent(h.tables);
    const created = await hit('/api/r1/attempts', { token: LINK }, 201);
    const rejoined = await hit(
      '/api/r1/attempts',
      { token: LINK, nonce: created.body.nonce },
      200,
    );
    expect(rejoined.body.nonce).toBeUndefined();
    await hit('/api/r1/attempts', { token: 'nope' }, 400);
    await hit('/api/r1/attempts', { token: FAKE_LINK }, 404);
    await hit('/api/r1/attempts', { token: LINK, nonce: '9'.repeat(64) }, 404, 'r1_attempt_invalid');
    // The one live attempt blocks a second start.
    await hit('/api/r1/attempts', { token: LINK }, 409, 'r1_busy');

    h.tables.call_sessions![0]!.status = 'completed';
    await hit('/api/r1/attempts', { token: LINK, nonce: created.body.nonce }, 409, 'r1_attempt_not_live');
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1).toISOString();
    await hit('/api/r1/attempts', { token: LINK }, 409, 'round_expired');
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW + 1e9).toISOString();
    h.tables.interview_rounds![0]!.status = 'completed';
    await hit('/api/r1/attempts', { token: LINK }, 409, 'round_not_admissible');

    fresh();
    await hit('/api/r1/attempts', { token: LINK }, 409, 'consent_required');
    grantConsent(h.tables);
    h.health.mockResolvedValue(false);
    const unhealthy = await hit('/api/r1/attempts', { token: LINK }, 503, 'r1_unavailable');
    expect(unhealthy.body.retry_after_sec).toBeGreaterThan(0);
    h.health.mockResolvedValue(true);
    h.tables.r1_settings![0]!.paused = true;
    await hit('/api/r1/attempts', { token: LINK }, 409, 'r1_paused');
    finish('/api/r1/attempts');
  });

  it('POST /api/r1/exchange', async () => {
    grantConsent(h.tables);
    const secrets = (await hit('/api/r1/attempts', { token: LINK }, 201)).body;
    const exchange = { attempt_token: secrets.attempt_token, nonce: secrets.nonce };

    h.gate.ensureReadyWorker.mockResolvedValueOnce({ status: 'timeout' });
    const preparing = await hit('/api/r1/exchange', exchange, 202);
    expect(preparing.body.status).toBe('preparing');
    await hit('/api/r1/exchange', exchange, 200);
    await hit('/api/r1/exchange', { attempt_token: 'junk' }, 400);
    await hit('/api/r1/exchange', { ...exchange, nonce: '8'.repeat(64) }, 404, 'r1_attempt_invalid');

    h.tables.call_sessions![0]!.status = 'completed';
    await hit('/api/r1/exchange', exchange, 409, 'r1_attempt_ended');
    h.tables.call_sessions![0]!.status = 'created';
    h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW).toISOString();
    await hit('/api/r1/exchange', exchange, 409, 'consent_required');
    h.tables.interview_round_consents![0]!.withdrawn_at = null;

    h.health.mockResolvedValueOnce(false);
    await hit('/api/r1/exchange', exchange, 503, 'r1_unavailable');
    h.rooms.createRoom.mockRejectedValue(new Error('livekit down'));
    h.rooms.updateRoomMetadata.mockRejectedValue(new Error('livekit down'));
    await hit('/api/r1/exchange', exchange, 503, 'r1_room_unavailable');
    finish('/api/r1/exchange');
  });

  it('POST /api/r1/ready', async () => {
    grantConsent(h.tables);
    const secrets = (await hit('/api/r1/attempts', { token: LINK }, 201)).body;
    const ready = { attempt_token: secrets.attempt_token, nonce: secrets.nonce };

    // `created`: no room has been provisioned, so there is nobody to tell.
    await hit('/api/r1/ready', ready, 409, 'not_live');
    await hit('/api/r1/exchange', ready, 200);
    const relayed = await hit('/api/r1/ready', ready, 200);
    expect(relayed.body).toEqual({ ok: true });
    await hit('/api/r1/ready', { attempt_token: 'junk' }, 400);
    await hit('/api/r1/ready', { ...ready, nonce: '8'.repeat(64) }, 404, 'r1_attempt_invalid');

    h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW).toISOString();
    await hit('/api/r1/ready', ready, 409, 'consent_required');
    h.tables.interview_round_consents![0]!.withdrawn_at = null;
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW - 1).toISOString();
    await hit('/api/r1/ready', ready, 409, 'round_not_admissible');
    h.tables.interview_rounds![0]!.expires_at = new Date(NOW + 1e9).toISOString();
    process.env.R1_ENABLED = 'false';
    await hit('/api/r1/ready', ready, 409, 'r1_disabled');
    process.env.R1_ENABLED = 'true';

    h.rooms.sendData.mockRejectedValueOnce(new Error('livekit down'));
    await hit('/api/r1/ready', ready, 503, 'r1_room_unavailable');
    process.env.WORKER_CONTEXT_SECRET = 'short';
    await hit('/api/r1/ready', ready, 503, 'r1_unavailable');
    process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;

    // The per-attempt allowance: the second press inside the window is refused.
    fresh(seedTables(), { readyLimiter: createReadyLimiter(1, 60_000) });
    grantConsent(h.tables);
    const second = (await hit('/api/r1/attempts', { token: LINK }, 201)).body;
    const again = { attempt_token: second.attempt_token, nonce: second.nonce };
    await hit('/api/r1/exchange', again, 200);
    await hit('/api/r1/ready', again, 200);
    const limited = await hit('/api/r1/ready', again, 429, 'r1_ready_rate_limited');
    expect(limited.body.retry_after_sec).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBe(String(limited.body.retry_after_sec));
    finish('/api/r1/ready');
  });
});

describe('the error codes the router can answer, and the spec', () => {
  it('names, somewhere in the spec, every error code the router source can answer', () => {
    const codes = new Set<string>();
    for (const match of SOURCE.matchAll(/refuse\(\s*res,\s*[^,]+,\s*'([a-z0-9_]+)'/g)) {
      codes.add(match[1]!);
    }
    for (const match of SOURCE.matchAll(/error:\s*'([a-z0-9_]+)'/g)) codes.add(match[1]!);
    for (const match of SOURCE.matchAll(/STABLE_(?:LINK|ATTEMPT)_ERROR\s*=\s*'([a-z0-9_]+)'/g)) {
      codes.add(match[1]!);
    }
    // consent_conflict (a lost race on the live-consent unique index) is chosen by a
    // conditional expression, so it is named here rather than lifted from the source.
    codes.add('consent_conflict');
    expect(codes.size).toBeGreaterThan(20);
    const missing = [...codes].filter((code) => !new RegExp(`\\b${code}\\b`).test(SPEC_TEXT));
    expect(missing).toEqual([]);
  });
});
