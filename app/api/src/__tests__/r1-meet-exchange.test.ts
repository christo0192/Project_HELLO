/**
 * `POST /api/r1/meet/exchange`: the Meet bridge's single-use ticket exchange (M034 S05 T4; plan
 * sections 1 and 2, D-S05-2..11, D-S05-21, D-S05-22; contracts section 9, S07 and S04 entries).
 *
 * The router under test is the real one, over the shared in-memory harness
 * (support/r1-candidate-harness.ts), whose `r1_meet_claim_ticket` and `r1_meet_bind_session`
 * doubles follow migration 0142 sections 17 and 15. `lib/supabase.js` is mocked to the same
 * database so the real room provisioning runs unmodified, as in r1-candidate-routes.test.ts.
 *
 * The cases, by plan number:
 *   1 flag off (no DB)           7 happy path (Cloud, R1 SFU)    13 admission refusals
 *   2 400 invalid_request        8 the nonce never leaves         14 consent
 *   3 keys missing (503)         9 single use + alert             15 bind answers
 *   4 404 / peek failure         10 202 + resume                  16 room answers
 *   5 window / not live (peek)   11 resume refusals               17 claim answers, profile
 *   6 pre-claim gates            12 re-arm rejoin                 18 no-store, exact bodies
 * and, from the PR #441 review:
 *   19 an admitted session that was never bound is recovered (S05-R2)
 *   20 no worker gate, or a disabled one, on any endpoint (S05-R3)
 *   21 every gate runs again on a resume (S05-R4)
 *   22 retry hints and the refusal log line (S05-R5)
 *   23 a first call never waits for a worker (S05-R6)
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
  R1_MEET_RESUME_TOKEN_PATTERN,
  R1_MEET_RESUME_TTL_SEC,
  mintR1MeetResumeToken,
} from '../lib/r1/meet/resume-token.js';
import {
  MEET_ADMISSION_REFUSALS,
  MEET_RETRY_AFTER_SEC,
  PREPARING_RETRY_AFTER_SEC,
  UNHEALTHY_RETRY_AFTER_SEC,
  r1MeetExchangeSchema,
  type R1CandidateDeps,
} from '../routes/r1-candidate.js';
import {
  CANDIDATE,
  MEET_BOOKING,
  MEET_TICKET,
  NOW,
  ROUND,
  SESSION,
  WORKER_SECRET,
  addMeetBooking,
  addSession,
  buildHarness,
  meetTicketDigest,
  seedMeetRound,
  seedTables,
  type Harness,
} from './support/r1-candidate-harness.js';
import type { Row, Tables } from './support/r1-candidate-fake-db.js';

const ROUTE = '/api/r1/meet/exchange';
const PROFILE = 'r1_dex_sales';
const R1_ENV = {
  url: 'wss://r1.example.test',
  key: 'r1-test-key',
  // Low-entropy fixture so the history secret scanner never flags it.
  secret: 's'.repeat(32),
};
const ENV_KEYS = [
  'R1_ENABLED',
  'WORKER_CONTEXT_SECRET',
  'BROWSER_LIVEKIT_TARGET',
  'R1_LIVEKIT_URL',
  'R1_LIVEKIT_API_KEY',
  'R1_LIVEKIT_API_SECRET',
  'R1_MEET_ENABLED',
];
const savedEnv: Record<string, string | undefined> = {};
const HEX64 = /[a-f0-9]{64}/;
/** The meeting's RPCs (the gate's own reads are not in the list). */
const MEET_RPCS = ['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session'];

let audits: AuditEntry[];
let originalSink: ReturnType<typeof getAuditSink>;
let h: Harness;
let clock: number;
let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
/** Every answer of the test, for the no-store and exact-body sweep (case 18). */
let answers: request.Response[];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  delete process.env.BROWSER_LIVEKIT_TARGET;
  delete process.env.R1_MEET_ENABLED;
  mocks.startRecording.mockReset();
  mocks.startRecording.mockResolvedValue({ status: 'started', egressId: 'egress-must-not-happen' });
  audits = [];
  answers = [];
  clock = NOW;
  originalSink = getAuditSink();
  setAuditSink((entry) => {
    audits.push(entry);
  });
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  use(meetTables());
});

afterEach(() => {
  // Case 18: every answer is no-store, and every refusal body is exactly { error }, except the
  // maintenance envelope and a 503 that spent nothing: { error, retry_after_sec } + Retry-After
  // (3 s; 30 s for the cached DeepSeek probe).
  for (const response of answers) {
    expect(response.headers['cache-control'], response.text).toBe('no-store');
    if (response.status < 400) continue;
    const body = response.body as Record<string, unknown>;
    if (typeof body.error === 'object') {
      expect(body).toEqual({ error: { type: 'maintenance_mode', message: 'Service temporarily unavailable' } });
    } else if ('retry_after_sec' in body) {
      expect(response.status, response.text).toBe(503);
      expect(Object.keys(body), response.text).toEqual(['error', 'retry_after_sec']);
      expect([MEET_RETRY_AFTER_SEC, UNHEALTHY_RETRY_AFTER_SEC]).toContain(body.retry_after_sec);
      if (body.retry_after_sec === UNHEALTHY_RETRY_AFTER_SEC) expect(body.error).toBe('r1_unavailable');
      expect(response.headers['retry-after']).toBe(String(body.retry_after_sec));
      expect(body.error).not.toBe('meet_disabled');
    } else {
      expect(Object.keys(body), response.text).toEqual(['error']);
    }
  }
  vi.restoreAllMocks();
  setAuditSink(originalSink);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Rebuild the harness (and the mocked database) over `tables`, with the Meet flag on. */
function use(
  tables: Tables,
  overrides: Partial<R1CandidateDeps> = {},
  gateEnabled = true,
  failures?: Parameters<typeof buildHarness>[3],
): Harness {
  h = buildHarness(tables, { meetEnabled: () => true, now: () => clock, ...overrides }, gateEnabled, failures);
  mocks.db.current = h.db;
  return h;
}

/** The seeded round as a Meet round (HR-attested consent) with one armed booking. */
function meetTables(over: Partial<Row> = {}): Tables {
  const tables = seedMeetRound(seedTables());
  addMeetBooking(tables, over);
  return tables;
}

function booking(): Row {
  return h.tables.r1_meet_bookings![0]!;
}

async function call(body: unknown): Promise<request.Response> {
  const response = await request(h.app).post(ROUTE).send(body as object);
  answers.push(response);
  return response;
}

const first = (ticket: string = MEET_TICKET) => call({ ticket });
const resume = (resumeToken: string, ticket: string = MEET_TICKET) =>
  call({ ticket, resume_token: resumeToken });

/** A first call (202, the session bound) and its continuation, which is the join. */
async function join(ticket: string = MEET_TICKET): Promise<request.Response> {
  const opened = await first(ticket);
  expect(opened.status, opened.text).toBe(202);
  return resume(opened.body.resume_token, ticket);
}

/** S06's re-arm: a fresh ticket on the booking, unclaimed, as `r1_meet_arm_ticket` writes it. */
let arms = 0;
function rearm(): string {
  arms += 1;
  const ticket = 'mt' + 'r'.repeat(35) + String(arms).padStart(6, '0');
  Object.assign(booking(), {
    ticket_digest: meetTicketDigest(ticket),
    ticket_claimed_at: null,
    ticket_arms: booking().ticket_arms + 1,
  });
  return ticket;
}

/** Let the database double admit several live sessions (0131: the R1 SFU with a pool). */
function severalSlots(): void {
  selectR1Sfu();
  h.tables.r1_settings![0]!.max_concurrent_sessions = 3;
  h.tables.voice_worker_leases = [1, 2, 3].map((n) => ({
    app: 'project-hello-voice', pipeline: 'browser', machine_id: `machine-${n}`,
  }));
}

function rpcNames(): string[] {
  return h.db.rpcCalls.map((entry) => entry.fn).filter((fn) => MEET_RPCS.includes(fn));
}

/** The structured log lines written at `level`, parsed. */
function lines(level: 'error' | 'warn'): Array<Record<string, unknown>> {
  const spy = level === 'error' ? errors : warnings;
  return spy.mock.calls.flatMap((args: unknown[]) => {
    try {
      return [JSON.parse(String(args[0])) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function category(level: 'error' | 'warn', name: string): Array<Record<string, unknown>> {
  return lines(level).filter((line) => line.error_category === name);
}

function selectR1Sfu(): void {
  process.env.BROWSER_LIVEKIT_TARGET = 'r1';
  process.env.R1_LIVEKIT_URL = R1_ENV.url;
  process.env.R1_LIVEKIT_API_KEY = R1_ENV.key;
  process.env['R1_LIVEKIT_API_SECRET'] = R1_ENV.secret;
  h.tables.r1_settings![0]!.livekit_target = 'r1';
}

function claims(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

/** The session the admission double created (the last one). */
function admittedSession(): Row {
  const sessions = h.tables.call_sessions!;
  return sessions[sessions.length - 1]!;
}

/** Replace one RPC's answer, leaving the other doubles in place. */
function answerRpc(fn: string, answer: (args: any) => unknown): void {
  const original = h.db.rpc;
  h.db.rpc = async (name: string, args: any) => {
    if (name !== fn) return original(name, args);
    h.db.rpcCalls.push({ fn: name, args });
    return { data: answer(args), error: null };
  };
}

/** Nothing about the ticket was decided beyond the peek: no claim, no gate, no room, no start. */
function expectUnspent(response: request.Response, status: number, error: string): void {
  expect(response.status, response.text).toBe(status);
  // A 503 here spent nothing, so it says when to ask again (S05-R5).
  expect(response.body).toEqual(status === 503 ? { error, retry_after_sec: MEET_RETRY_AFTER_SEC } : { error });
  expect(rpcNames()).toEqual([]);
  expect(booking().ticket_claimed_at).toBeNull();
  expect(booking().session_id).toBeNull();
  expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
  expect(h.gate.dispatch).not.toHaveBeenCalled();
  expect(h.rooms.createRoom).not.toHaveBeenCalled();
  expect(h.tables.interview_rounds![0]!.starts_used).toBe(0);
}

/** The lines must not carry the ticket, its digest, an id or the Meet link. */
function expectQuietLines(): void {
  const text = [...errors.mock.calls, ...warnings.mock.calls].map((args) => String(args[0])).join('\n');
  for (const secret of [MEET_TICKET, meetTicketDigest(), MEET_BOOKING, ROUND, CANDIDATE, SESSION, 'meet.google.com']) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/50000000-0000-4000-8000/);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('1. the flag is off: 503 meet_disabled before anything is read', () => {
  it('answers every body the same, touching no table, RPC, room, gate or probe', async () => {
    use(meetTables(), { meetEnabled: () => false });
    for (const body of [{ ticket: MEET_TICKET }, { junk: true }, {}, { ticket: MEET_TICKET, resume_token: 'v1.1.' + 'a'.repeat(64) }]) {
      const response = await call(body);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'meet_disabled' });
      expect(response.text).toBe('{"error":"meet_disabled"}');
    }
    expect(h.db.touched.size).toBe(0);
    expect(h.db.rpcCalls).toEqual([]);
    expect(h.health).not.toHaveBeenCalled();
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('reads R1_MEET_ENABLED by default: unset or "false" is off, and R1_ENABLED does not matter', async () => {
    for (const flag of [undefined, 'false']) {
      if (flag === undefined) delete process.env.R1_MEET_ENABLED;
      else process.env.R1_MEET_ENABLED = flag;
      h = buildHarness(meetTables());
      mocks.db.current = h.db;
      const response = await first();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'meet_disabled' });
      expect(h.db.touched.size).toBe(0);
    }
    process.env.R1_ENABLED = 'false';
    const offR1 = await first();
    expect(offR1.body).toEqual({ error: 'meet_disabled' });
    expect(h.db.touched.size).toBe(0);
  });
});

describe('2. 400 invalid_request: the body is strict', () => {
  it('refuses every malformed body before any read', async () => {
    const bodies: unknown[] = [
      {},
      { ticket: 'mt' + 'k'.repeat(29) },
      { ticket: 'mt' + 'k'.repeat(127) },
      { ticket: 'mt' + 'k'.repeat(40) + '!' },
      { ticket: 'mt' + 'k'.repeat(40) + '=' },
      { ticket: 42 },
      { ticket: MEET_TICKET, extra: 1 },
      { ticket: MEET_TICKET, nonce: 'a'.repeat(64) },
      { ticket: MEET_TICKET, resume_token: 'v2.1.' + 'a'.repeat(64) },
      { ticket: MEET_TICKET, resume_token: 'v1.1.' + 'A'.repeat(64) },
      { ticket: MEET_TICKET, resume_token: 5 },
      { ticket: MEET_TICKET, resume_token: null },
    ];
    for (const body of bodies) {
      const response = await call(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
    }
    expect(h.db.touched.size).toBe(0);
    // The edges of the ticket shape pass the schema (32 and 128 characters).
    expect(r1MeetExchangeSchema.safeParse({ ticket: 'k'.repeat(32) }).success).toBe(true);
    expect(r1MeetExchangeSchema.safeParse({ ticket: 'k'.repeat(128) }).success).toBe(true);
    expect(r1MeetExchangeSchema.safeParse({ ticket: 'k'.repeat(31) }).success).toBe(false);
  });
});

describe('3. no bridge keys: 503 r1_unavailable before any read', () => {
  it('answers for a missing or a short WORKER_CONTEXT_SECRET', async () => {
    for (const secret of [undefined, 'short']) {
      if (secret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
      else process.env.WORKER_CONTEXT_SECRET = secret;
      const response = await first();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'r1_unavailable', retry_after_sec: MEET_RETRY_AFTER_SEC });
    }
    expect(h.db.touched.size).toBe(0);
  });
});

describe('4. the peek: unknown tickets and read failures', () => {
  it('answers 404 ticket_unknown for a ticket no booking holds, without a claim', async () => {
    const response = await first('mt' + 'q'.repeat(41));
    expectUnspent(response, 404, 'ticket_unknown');
    expect([...h.db.touched]).toEqual(['r1_meet_bookings']);
  });

  it('answers 503 service_unavailable when the booking cannot be read', async () => {
    use(meetTables(), {}, true, { r1_meet_bookings: { message: 'down' } });
    const response = await first();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable', retry_after_sec: MEET_RETRY_AFTER_SEC });
    expect(h.db.rpcCalls).toEqual([]);
    // The failed peek writes the closed refusal line (S05-R5), naming no ticket or id.
    expect(category('warn', 'r1_meet_exchange_refused').map((line) => line.error_type)).toEqual(['service_unavailable']);
    expectQuietLines();
  });
});

describe('5. decided from the peek, without spending the ticket', () => {
  it('425 before the window, 410 at its end, 409 for a booking that is not live', async () => {
    use(meetTables({ ticket_not_before: new Date(NOW + 1).toISOString() }));
    expectUnspent(await first(), 425, 'ticket_not_yet_valid');
    use(meetTables({ ticket_expires_at: new Date(NOW).toISOString() }));
    expectUnspent(await first(), 410, 'ticket_expired');
    for (const status of ['cancelled', 'failed', 'completed', 'pending']) {
      use(meetTables({ status }));
      expectUnspent(await first(), 409, 'round_not_live');
    }
    // None of them read a switch, the round or the settings.
    expect([...h.db.touched]).toEqual(['r1_meet_bookings']);
  });
});

describe('6. the new-work gates run before the claim and never consume the ticket', () => {
  it('R1 off, maintenance, paused, target mismatch, DeepSeek down, a lapsed round', async () => {
    process.env.R1_ENABLED = 'false';
    expectUnspent(await first(), 409, 'r1_disabled');
    process.env.R1_ENABLED = 'true';

    use(meetTables(), { maintenance: async () => ({ ok: true, enabled: true, reason: null, updatedAt: null }) });
    const maintenance = await first();
    expect(maintenance.status).toBe(503);
    expect(maintenance.body).toEqual({ error: { type: 'maintenance_mode', message: 'Service temporarily unavailable' } });
    expect(rpcNames()).toEqual([]);
    expect(booking().ticket_claimed_at).toBeNull();

    use(meetTables());
    h.tables.r1_settings![0]!.paused = true;
    expectUnspent(await first(), 409, 'r1_paused');

    use(meetTables());
    h.tables.r1_settings![0]!.enabled = false;
    expectUnspent(await first(), 409, 'r1_disabled');

    use(meetTables());
    h.tables.r1_settings![0]!.livekit_target = 'r1';
    expectUnspent(await first(), 503, 'r1_endpoint_mismatch');

    use(meetTables());
    h.health.mockResolvedValue(false);
    const unhealthy = await first();
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.body).toEqual({ error: 'r1_unavailable', retry_after_sec: UNHEALTHY_RETRY_AFTER_SEC });
    expect(unhealthy.headers['retry-after']).toBe(String(UNHEALTHY_RETRY_AFTER_SEC));
    expect(rpcNames()).toEqual([]);
    expect(booking().ticket_claimed_at).toBeNull();

    // The round lapsed, is not a Meet round, or is gone: round_not_live, unspent.
    for (const change of [
      (round: Row) => { round.expires_at = new Date(NOW).toISOString(); },
      (round: Row) => { round.status = 'cancelled'; },
      (round: Row) => { round.channel = 'browser'; },
      (round: Row) => { round.id = 'another-round'; },
    ]) {
      use(meetTables());
      change(h.tables.interview_rounds![0]!);
      expectUnspent(await first(), 409, 'round_not_live');
    }
  });

  it('fence 7: on the R1 SFU with no worker gate, 503 r1_unavailable and the log line, never a 202', async () => {
    use(meetTables(), {}, false);
    selectR1Sfu();
    const response = await first();
    expectUnspent(response, 503, 'r1_unavailable');
    expect(category('error', 'r1_worker_gate_missing')).toHaveLength(1);
    // The same holds for a resume of a waiting session.
    const tables = meetTables({ status: 'in_call', ticket_claimed_at: new Date(NOW - 10_000).toISOString(), session_id: SESSION });
    addSession(tables, { status: 'waiting' });
    use(tables, {}, false);
    selectR1Sfu();
    const token = mintR1MeetResumeToken({ bookingId: MEET_BOOKING, sessionId: SESSION }, NOW)!;
    const resumed = await resume(token);
    expect(resumed.status).toBe(503);
    expect(resumed.body).toEqual({ error: 'r1_unavailable', retry_after_sec: MEET_RETRY_AFTER_SEC });
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(answers.every((answer) => answer.status !== 202)).toBe(true);
  });
});

describe('7. the happy path', () => {
  async function expectBridgeJoin(response: request.Response, apiKey: string, apiSecret: string, url: string) {
    expect(response.status, response.text).toBe(200);
    expect(Object.keys(response.body)).toEqual(['url', 'livekit_token', 'expires_at']);
    expect(response.body.url).toBe(url);
    expect(response.body.expires_at).toBe(new Date(NOW + 600_000).toISOString());
    const session = admittedSession();
    const sessionId = String(session.id);
    const identity = `meet-${sessionId.slice(0, 8)}`;
    // The order: claim, then admission, then the bind.
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session']);
    expect(booking()).toMatchObject({
      status: 'in_call',
      reason: 'eligible',
      ticket_claimed_at: new Date(NOW).toISOString(),
      session_id: sessionId,
    });
    // The room mirrors the bridge identity; the dispatch carries it and the profile.
    const metadata = JSON.parse(String(h.rooms.createRoom.mock.calls[0]![0].metadata));
    expect(metadata).toMatchObject({ session_id: sessionId, lane: 'r1', channel: 'meet', candidate_identity: identity });
    expect(h.gate.dispatch).toHaveBeenCalledWith({
      sessionId,
      roomName: `screening-${sessionId}`,
      meet: { candidateIdentity: identity, profile: PROFILE },
    });
    // The token: microphone only, subscribe on, no data, no metadata, the bridge identity, 600 s.
    const verified = await new TokenVerifier(apiKey, apiSecret).verify(response.body.livekit_token);
    expect(verified.video).toEqual({
      room: `screening-${sessionId}`,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    const payload = claims(response.body.livekit_token);
    expect(payload.sub).toBe(identity);
    expect(payload.exp - payload.nbf).toBe(600);
    const claimText = JSON.stringify(payload);
    expect(claimText).not.toContain(CANDIDATE);
    expect(claimText).not.toContain('candidate-');
    // One admission audit, like /attempts.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'resource.create',
      statusCode: 201,
      path: '/api/r1/meet/exchange',
      metadata: { resource: 'interview_round_attempt', round_id: ROUND, attempt_number: 1 },
    });
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(1);
    expect(mocks.startRecording).not.toHaveBeenCalled();
  }

  it('on Cloud: claims, admits, binds, provisions the marked room, gates and mints the bridge token', async () => {
    const cloud = cloudLiveKitEndpoint();
    await expectBridgeJoin(await join(), cloud.apiKey, cloud.apiSecret, cloud.url);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    expect(order(h.health)).toBeLessThan(order(h.rooms.createRoom));
    expect(order(h.rooms.createRoom)).toBeLessThan(order(h.gate.ensureReadyWorker));
    expect(errors).not.toHaveBeenCalled();
  });

  it('on the R1 SFU: signs with the R1 secret only and returns the R1 URL', async () => {
    selectR1Sfu();
    const response = await join();
    await expectBridgeJoin(response, R1_ENV.key, R1_ENV.secret, R1_ENV.url);
    const cloud = cloudLiveKitEndpoint();
    await expect(new TokenVerifier(cloud.apiKey, cloud.apiSecret).verify(response.body.livekit_token))
      .rejects.toBeTruthy();
  });
});

describe('8. the nonce never leaves the server', () => {
  it('is in no body or header of a 202 or a 200, and no body carries a 64-hex string', async () => {
    const preparing = await first();
    expect(preparing.status).toBe(202);
    const done = await resume(preparing.body.resume_token);
    expect(done.status).toBe(200);
    const admission = h.db.rpcCalls.find((entry) => entry.fn === 'r1_admit_attempt')!;
    const digest = String(admission.args.p_nonce_digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    for (const response of [preparing, done]) {
      expect(response.text).not.toContain(digest);
      expect(JSON.stringify(response.headers)).not.toContain(digest);
      expect(JSON.stringify(response.body)).not.toMatch(/nonce/i);
      const { resume_token: _token, ...rest } = response.body as Record<string, unknown>;
      expect(JSON.stringify(rest)).not.toMatch(HEX64);
    }
    // Nor is it logged or audited.
    expect(JSON.stringify(audits)).not.toContain(digest);
    expectQuietLines();
  });
});

describe('9. single use', () => {
  it('a second call with the same ticket is 409 ticket_already_claimed, with one alert and no second start', async () => {
    expect((await join()).status).toBe(200);
    const again = await first();
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'ticket_already_claimed' });
    expect(rpcNames().filter((fn) => fn === 'r1_admit_attempt')).toHaveLength(1);
    // Decided from the peek: no second claim either.
    expect(rpcNames().filter((fn) => fn === 'r1_meet_claim_ticket')).toHaveLength(1);
    const alerts = category('error', 'r1_meet_ticket_already_claimed');
    expect(alerts).toHaveLength(1);
    expect(Object.keys(alerts[0]!).sort()).toEqual(['component', 'correlationId', 'error_category', 'event', 'level', 'timestamp']);
    expectQuietLines();
  });

  it('the race (peek unclaimed, claim already claimed) answers the same 409 and alert', async () => {
    answerRpc('r1_meet_claim_ticket', () => ({ status: 'ticket_already_claimed', booking_id: MEET_BOOKING }));
    const response = await first();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'ticket_already_claimed' });
    expect(category('error', 'r1_meet_ticket_already_claimed')).toHaveLength(1);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket']);
  });
});

describe('10. 202 and the resume token', () => {
  it('202 preparing carries a fresh resume token; the continuation claims and admits nothing again', async () => {
    const preparing = await first();
    expect(preparing.status).toBe(202);
    expect(preparing.body).toEqual({
      status: 'preparing',
      retry_after_sec: PREPARING_RETRY_AFTER_SEC,
      resume_token: expect.stringMatching(R1_MEET_RESUME_TOKEN_PATTERN),
    });
    expect(Object.keys(preparing.body)).toEqual(['status', 'retry_after_sec', 'resume_token']);
    expect(preparing.headers['retry-after']).toBe(String(PREPARING_RETRY_AFTER_SEC));
    // Bound before the room and the gate: the continuation has a session to find.
    const sessionId = String(admittedSession().id);
    expect(booking()).toMatchObject({ status: 'in_call', session_id: sessionId });
    const rpcsAfterFirst = rpcNames();
    expect(rpcsAfterFirst).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session']);

    // A second 202 (a second later: the worker is still booting) carries a different token.
    clock = NOW + 1_000;
    h.gate.ensureReadyWorker.mockResolvedValueOnce({ status: 'timeout' });
    const again = await resume(preparing.body.resume_token);
    expect(again.status).toBe(202);
    expect(again.body.resume_token).toMatch(R1_MEET_RESUME_TOKEN_PATTERN);
    expect(again.body.resume_token).not.toBe(preparing.body.resume_token);

    const done = await resume(again.body.resume_token);
    expect(done.status, done.text).toBe(200);
    expect(Object.keys(done.body)).toEqual(['url', 'livekit_token', 'expires_at']);
    expect(rpcNames()).toEqual(rpcsAfterFirst);
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(1);
    expect(h.tables.call_sessions).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(claims(done.body.livekit_token).sub).toBe(`meet-${sessionId.slice(0, 8)}`);
  });
});

/** A claimed booking bound to a `waiting` session, and a token for it minted at `NOW`. */
function boundBooking(
  over: Partial<Row> = {},
  sessionOver: Partial<Row> = {},
  deps: Partial<R1CandidateDeps> = {},
  gateEnabled = true,
  failures?: Parameters<typeof buildHarness>[3],
): string {
  const tables = meetTables({
    status: 'in_call',
    ticket_claimed_at: new Date(NOW - 10_000).toISOString(),
    session_id: SESSION,
    ...over,
  });
  addSession(tables, { status: 'waiting', ...sessionOver });
  tables.interview_rounds![0]!.status = 'in_progress';
  use(tables, deps, gateEnabled, failures);
  return mintR1MeetResumeToken({ bookingId: MEET_BOOKING, sessionId: SESSION }, NOW)!;
}

describe('11. resume refusals', () => {
  it('a forged token is 404 ticket_unknown with a warning, and an old one is 410', async () => {
    const token = boundBooking();
    const last = token.at(-1) === 'a' ? 'b' : 'a';
    const forged = await resume(token.slice(0, -1) + last);
    expect(forged.status).toBe(404);
    expect(forged.body).toEqual({ error: 'ticket_unknown' });
    expect(category('warn', 'r1_meet_resume_invalid')).toHaveLength(1);

    clock = NOW + (R1_MEET_RESUME_TTL_SEC + 1) * 1000;
    const old = await resume(token);
    expect(old.status).toBe(410);
    expect(old.body).toEqual({ error: 'ticket_expired' });
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.db.rpcCalls).toEqual([]);
    expectQuietLines();
  });

  it('a token for another booking or another session is 404', async () => {
    boundBooking();
    const otherBooking = mintR1MeetResumeToken({ bookingId: '70000000-0000-4000-8000-0000000000aa', sessionId: SESSION }, NOW)!;
    const otherSession = mintR1MeetResumeToken({ bookingId: MEET_BOOKING, sessionId: '30000000-0000-4000-8000-0000000000aa' }, NOW)!;
    for (const token of [otherBooking, otherSession]) {
      const response = await resume(token);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'ticket_unknown' });
    }
  });

  it('a booking no longer in the call, an unclaimed ticket, an ended session or a closed window', async () => {
    let token = boundBooking({ status: 'failed', reason: 'no_show' });
    expect((await resume(token)).body).toEqual({ error: 'round_not_live' });

    token = boundBooking({ ticket_claimed_at: null, status: 'human_present' });
    const unclaimed = await resume(token);
    expect(unclaimed.status).toBe(404);
    expect(unclaimed.body).toEqual({ error: 'ticket_unknown' });

    token = boundBooking({ session_id: null });
    expect((await resume(token)).status).toBe(404);

    token = boundBooking({}, { status: 'completed' });
    const ended = await resume(token);
    expect(ended.status).toBe(409);
    expect(ended.body).toEqual({ error: 'round_not_live' });

    token = boundBooking({ ticket_expires_at: new Date(NOW).toISOString() });
    const closed = await resume(token);
    expect(closed.status).toBe(410);
    expect(closed.body).toEqual({ error: 'ticket_expired' });
    expect(h.db.rpcCalls).toEqual([]);
  });

  it('a resume of a waiting session runs the gate and mints, with no claim or admission', async () => {
    const token = boundBooking();
    const response = await resume(token);
    expect(response.status, response.text).toBe(200);
    expect(rpcNames()).toEqual([]);
    expect(claims(response.body.livekit_token).sub).toBe(`meet-${SESSION.slice(0, 8)}`);
    expect(h.gate.dispatch).toHaveBeenCalledWith({
      sessionId: SESSION,
      roomName: `screening-${SESSION}`,
      meet: { candidateIdentity: `meet-${SESSION.slice(0, 8)}`, profile: PROFILE },
    });
  });
});

describe('12. a re-arm while the bound session is live', () => {
  function rearmed(sessionStatus: string): void {
    const tables = meetTables({ status: 'in_call', session_id: SESSION });
    addSession(tables, { status: sessionStatus });
    tables.interview_rounds![0]!.status = 'in_progress';
    tables.interview_rounds![0]!.starts_used = 1;
    use(tables);
  }

  it('continues that session: no admission and no bind', async () => {
    rearmed('waiting');
    const response = await join();
    expect(response.status, response.text).toBe(200);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket']);
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(1);
    expect(audits).toEqual([]);
    expect(category('warn', 'r1_meet_session_adopted')).toEqual([]);
    expect(claims(response.body.livekit_token).sub).toBe(`meet-${SESSION.slice(0, 8)}`);
    // The marked room was re-asserted with the bridge identity.
    const metadata = JSON.parse(String(h.rooms.createRoom.mock.calls[0]![0].metadata));
    expect(metadata).toMatchObject({ channel: 'meet', candidate_identity: `meet-${SESSION.slice(0, 8)}` });
  });

  it('an in-progress bound session gets a token at once (no gate)', async () => {
    rearmed('in_progress');
    const response = await first();
    expect(response.status, response.text).toBe(200);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket']);
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
  });

  it('an ended bound session is a new start: admission, then a re-bind that names the previous session', async () => {
    rearmed('completed');
    const binds: unknown[] = [];
    const original = h.db.rpc;
    h.db.rpc = async (fn: string, args: any) => {
      const result = await original(fn, args);
      if (fn === 'r1_meet_bind_session') binds.push(result.data);
      return result;
    };
    const response = await join();
    expect(response.status, response.text).toBe(200);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session']);
    const sessionId = String(admittedSession().id);
    expect(sessionId).not.toBe(SESSION);
    expect(binds).toEqual([
      { status: 'ok', booking_id: MEET_BOOKING, session_id: sessionId, previous_session_id: SESSION },
    ]);
    expect(booking().session_id).toBe(sessionId);
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(2);
  });
});

describe('13. admission refusals', () => {
  it('maps each to the bridge code with one alert, no Retry-After and a body of exactly { error }', async () => {
    const cases: Array<[string, number, string]> = [
      ['r1_in_flight', 409, 'r1_busy'],
      ['round_live', 409, 'r1_busy'],
      ['starts_exhausted', 409, 'starts_exhausted'],
      ['attempts_exhausted', 409, 'attempts_exhausted'],
      ['round_expired', 409, 'round_not_live'],
      ['round_not_admissible', 409, 'round_not_live'],
      ['round_not_found', 409, 'round_not_live'],
      ['consent_missing', 409, 'consent_required'],
      ['capacity_exhausted', 409, 'r1_capacity_exhausted'],
      ['r1_role_invalid', 503, 'r1_unavailable'],
    ];
    for (const [status, http, error] of cases) {
      use(meetTables());
      errors.mockClear();
      answerRpc('r1_admit_attempt', () => ({ status }));
      const response = await first();
      expect(response.status, status).toBe(http);
      expect(response.body, status).toEqual({ error });
      expect(response.headers['retry-after'], status).toBeUndefined();
      expect(MEET_ADMISSION_REFUSALS[status], status).toEqual({ status: http, error });
      const refused = category('error', 'r1_meet_admission_refused');
      expect(refused, status).toHaveLength(1);
      expect(refused[0]!.error_type).toBe(status);
      // The ticket is spent, nothing was bound, nothing started.
      expect(booking().ticket_claimed_at).not.toBeNull();
      expect(booking().session_id).toBeNull();
      expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt']);
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
    }
    // An unknown status is a 503 with the closed `unexpected_status` type.
    use(meetTables());
    errors.mockClear();
    answerRpc('r1_admit_attempt', () => ({ status: 'brand_new' }));
    const unknown = await first();
    expect(unknown.status).toBe(503);
    expect(unknown.body).toEqual({ error: 'service_unavailable' });
    expect(category('error', 'r1_meet_admission_refused')[0]!.error_type).toBe('unexpected_status');
    // The real double's own busy answer: another round's live session.
    use(meetTables());
    addSession(h.tables, { id: '30000000-0000-4000-8000-0000000000e2', interview_round_id: 'another-round', status: 'in_progress' });
    const busy = await first();
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: 'r1_busy' });
    expectQuietLines();
  });

  it('an admission RPC error (answered or thrown) is 503 service_unavailable, with no hint: the ticket is spent', async () => {
    for (const fail of [
      () => ({ data: null, error: { message: 'down' } }),
      () => { throw new Error('socket closed'); },
    ]) {
      use(meetTables());
      errors.mockClear();
      const original = h.db.rpc;
      h.db.rpc = async (fn: string, args: any) => (fn === 'r1_admit_attempt' ? fail() : original(fn, args));
      const response = await first();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'service_unavailable' });
      expect(response.headers['retry-after']).toBeUndefined();
      expect(category('error', 'r1_meet_admission_refused')[0]!.error_type).toBe('no_answer');
      expect(h.tables.call_sessions).toEqual([]);
    }
  });
});

describe('14. consent', () => {
  it('a withdrawn consent stops the exchange before the claim, so the ticket is not spent', async () => {
    h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW - 1_000).toISOString();
    expectUnspent(await first(), 409, 'consent_required');
  });

  it('a withdrawal while the worker gate runs stops the join: no token', async () => {
    h.gate.ensureReadyWorker.mockImplementationOnce(async () => {
      h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW).toISOString();
      return { status: 'ready', machineId: 'machine-1', epoch: 1, agentName: 'browser-screener' };
    });
    const response = await join();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'consent_required' });
    expect(h.gate.dispatch).toHaveBeenCalledTimes(1);
  });

  it('the HR-attested consent row (method hr_attested_ashby) is enough', async () => {
    expect(h.tables.interview_round_consents).toHaveLength(1);
    expect(h.tables.interview_round_consents![0]).toMatchObject({ method: 'hr_attested_ashby', india_location_attested: true });
    expect((await join()).status).toBe(200);
  });
});

describe('15. the bind', () => {
  it('not_in_call or not_found is 409 round_not_live; anything else is 503 with the alert', async () => {
    for (const reason of ['not_in_call', 'not_found']) {
      use(meetTables());
      answerRpc('r1_meet_bind_session', () => ({ status: reason }));
      const response = await first();
      expect(response.status, reason).toBe(409);
      expect(response.body).toEqual({ error: 'round_not_live' });
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
    }
    for (const reason of ['session_mismatch', 'invalid_request', 'surprise']) {
      use(meetTables());
      errors.mockClear();
      answerRpc('r1_meet_bind_session', () => ({ status: reason }));
      const response = await first();
      expect(response.status, reason).toBe(503);
      expect(response.body).toEqual({ error: 'service_unavailable' });
      const failed = category('error', 'r1_meet_bind_failed');
      expect(failed, reason).toHaveLength(1);
      expect(failed[0]!.error_type).toBe(reason === 'surprise' ? 'error' : reason);
      expect(h.rooms.createRoom).not.toHaveBeenCalled();
    }
    // `duplicate` continues.
    use(meetTables());
    answerRpc('r1_meet_bind_session', () => ({ status: 'duplicate', booking_id: MEET_BOOKING }));
    expect((await first()).status).toBe(202);
    expectQuietLines();
  });
});

describe('16. the room', () => {
  it('a provider failure on a created session is a 202 with a resume token; the resume provisions and joins', async () => {
    h.rooms.createRoom.mockRejectedValue(new Error('livekit down'));
    h.rooms.updateRoomMetadata.mockRejectedValue(new Error('livekit down'));
    const preparing = await join();
    expect(preparing.status, preparing.text).toBe(202);
    expect(preparing.body.resume_token).toMatch(R1_MEET_RESUME_TOKEN_PATTERN);
    expect(h.rooms.createRoom).toHaveBeenCalled();
    expect(admittedSession().status).toBe('created');
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();

    h.rooms.createRoom.mockResolvedValue({});
    h.rooms.updateRoomMetadata.mockResolvedValue({});
    const healthCalls = h.health.mock.calls.length;
    const done = await resume(preparing.body.resume_token);
    expect(done.status, done.text).toBe(200);
    // Still a new start: the gates ran again.
    expect(h.health.mock.calls.length).toBe(healthCalls + 1);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session']);
  });

  it('a session the room can no longer be made for is 409 round_not_live', async () => {
    const provisionRoom = vi.fn(async () => ({ ok: false, code: 'not_joinable', roomName: 'x' }));
    use(meetTables(), { provisionRoom: provisionRoom as unknown as R1CandidateDeps['provisionRoom'] });
    const response = await join();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'round_not_live' });
    expect(provisionRoom).toHaveBeenCalledTimes(1);
    expect(provisionRoom.mock.calls[0]).toEqual([
      String(admittedSession().id),
      'existing_session',
      expect.objectContaining({ lane: 'r1', meet: { candidateIdentity: `meet-${String(admittedSession().id).slice(0, 8)}` } }),
    ]);
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
  });
});

describe('17. the claim answer and the profile', () => {
  it('maps every claim refusal; a server fault is 503 with the claim alert', async () => {
    const cases: Array<[string, number, string]> = [
      ['round_not_live', 409, 'round_not_live'],
      ['booking_not_claimable', 409, 'round_not_live'],
      ['ticket_unknown', 404, 'ticket_unknown'],
      ['ticket_not_yet_valid', 425, 'ticket_not_yet_valid'],
      ['ticket_expired', 410, 'ticket_expired'],
      ['invalid_ticket', 503, 'service_unavailable'],
      ['invalid_request', 503, 'service_unavailable'],
      ['surprise', 503, 'service_unavailable'],
    ];
    for (const [status, http, error] of cases) {
      use(meetTables());
      errors.mockClear();
      answerRpc('r1_meet_claim_ticket', () => ({ status, booking_id: MEET_BOOKING }));
      const response = await first();
      expect(response.status, status).toBe(http);
      expect(response.body, status).toEqual({ error });
      expect(rpcNames(), status).toEqual(['r1_meet_claim_ticket']);
      expect(category('error', 'r1_meet_claim_failed'), status).toHaveLength(http === 503 ? 1 : 0);
    }
  });

  it('the real double answers round_not_live when the round lapsed between the peek and the claim', async () => {
    const original = h.db.rpc;
    h.db.rpc = async (fn: string, args: any) => {
      if (fn === 'r1_meet_claim_ticket') h.tables.interview_rounds![0]!.expires_at = new Date(NOW).toISOString();
      return original(fn, args);
    };
    const response = await first();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'round_not_live' });
    expect(booking().ticket_claimed_at).toBeNull();
  });

  it('a claim that names another booking or round is 503 with the claim alert', async () => {
    answerRpc('r1_meet_claim_ticket', () => ({
      status: 'ok',
      booking_id: MEET_BOOKING,
      round_id: '20000000-0000-4000-8000-0000000000ff',
      candidate_id: CANDIDATE,
      objective_profile: PROFILE,
      session_id: null,
      start_at: new Date(NOW).toISOString(),
      end_at: new Date(NOW + 1).toISOString(),
    }));
    const response = await first();
    expect(response.status).toBe(503);
    expect(category('error', 'r1_meet_claim_failed')).toHaveLength(1);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket']);
  });

  it('an unknown objective profile fails closed: before the claim from the booking, after it from the binding', async () => {
    use(meetTables({ objective_profile: 'r1_unknown_profile' }));
    expectUnspent(await first(), 503, 'service_unavailable');
    expect(category('error', 'r1_meet_profile_unknown')).toHaveLength(1);

    use(meetTables());
    errors.mockClear();
    answerRpc('r1_meet_claim_ticket', () => ({
      status: 'ok',
      booking_id: MEET_BOOKING,
      round_id: ROUND,
      candidate_id: CANDIDATE,
      objective_profile: 'r1_unknown_profile',
      session_id: null,
      start_at: new Date(NOW).toISOString(),
      end_at: new Date(NOW + 1).toISOString(),
    }));
    const response = await first();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
    expect(category('error', 'r1_meet_profile_unknown')).toHaveLength(1);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket']);
  });
});

describe('18. every answer is no-store, with exact refusal bodies', () => {
  it('holds across a mix of answers (the sweep in afterEach checks each one)', async () => {
    await call({});
    await first('mt' + 'q'.repeat(41));
    const preparing = await first();
    await resume(preparing.body.resume_token);
    await first();
    expect(answers.map((answer) => answer.status)).toEqual([400, 404, 202, 200, 409]);
  });
});

// ── The PR #441 review ───────────────────────────────────────────────

describe('19. an admitted session that was never bound is recovered by the next claim (S05-R2)', () => {
  /** Run `fail` for the next `count` calls of `fn`; the double runs again after that. */
  function failRpc(fn: string, fail: (original: () => Promise<unknown>) => unknown, count = 1): void {
    const original = h.db.rpc;
    let left = count;
    h.db.rpc = async (name: string, args: any) => {
      if (name !== fn || left === 0) return original(name, args);
      left -= 1;
      return (await fail(() => original(name, args))) as { data: any; error: any };
    };
  }
  const DOWN = { data: null, error: { message: 'down' } };

  /** The one live session is bound and joinable: one start, one admission audit at most. */
  async function expectRecovered(opened: request.Response, ticket: string): Promise<void> {
    expect(opened.status, opened.text).toBe(202);
    expect(h.tables.call_sessions).toHaveLength(1);
    const sessionId = String(admittedSession().id);
    expect(booking()).toMatchObject({ status: 'in_call', session_id: sessionId });
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(1);
    const done = await resume(opened.body.resume_token, ticket);
    expect(done.status, done.text).toBe(200);
    expect(claims(done.body.livekit_token).sub).toBe(`meet-${sessionId.slice(0, 8)}`);
    expect(h.tables.call_sessions).toHaveLength(1);
    expectQuietLines();
  }

  for (const [name, slots] of [['a limit of one', false], ['several slots', true]] as const) {
    it(`a bind that failed once (${name}): the re-armed ticket binds that session, with no second admission`, async () => {
      if (slots) severalSlots();
      failRpc('r1_meet_bind_session', () => DOWN);
      const failed = await first();
      expect(failed.status).toBe(503);
      expect(failed.body).toEqual({ error: 'service_unavailable' });
      expect(booking()).toMatchObject({ status: 'in_call', session_id: null });
      expect(category('error', 'r1_meet_bind_failed')).toHaveLength(1);
      // The start was spent, so it is audited all the same.
      expect(audits).toHaveLength(1);

      const ticket = rearm();
      h.db.rpcCalls.length = 0;
      const opened = await first(ticket);
      expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_meet_bind_session']);
      expect(category('warn', 'r1_meet_session_adopted')).toHaveLength(1);
      await expectRecovered(opened, ticket);
      expect(audits).toHaveLength(1);
    });
  }

  it('a lost admission answer: the same call finds the session it made, binds it and continues', async () => {
    failRpc('r1_admit_attempt', async (original) => {
      await original();
      return DOWN;
    });
    const opened = await first();
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session']);
    expect(category('warn', 'r1_meet_session_adopted')).toHaveLength(1);
    expect(category('error', 'r1_meet_admission_refused')).toEqual([]);
    await expectRecovered(opened, MEET_TICKET);
  });

  it('a lost admission answer that commits after the call gave up: the re-armed ticket recovers it', async () => {
    let commit: (() => Promise<unknown>) | null = null;
    failRpc('r1_admit_attempt', (original) => {
      commit = original;
      return DOWN;
    });
    expect((await first()).status).toBe(503);
    await commit!();
    expect(h.tables.call_sessions).toHaveLength(1);
    const ticket = rearm();
    await expectRecovered(await first(ticket), ticket);
  });

  for (const refused of ['r1_in_flight', 'round_live', 'starts_exhausted']) {
    it(`a re-armed page that races the first page's admission (${refused}) continues its session`, async () => {
      // The first page's admission commits while this page's own one waits for its locks.
      failRpc('r1_admit_attempt', async (original) => {
        await original();
        return { data: { status: refused }, error: null };
      });
      const opened = await first();
      expect(category('error', 'r1_meet_admission_refused')).toEqual([]);
      await expectRecovered(opened, MEET_TICKET);
    });
  }

  it('the last start, admitted but not bound, is still recovered (admission would say starts_exhausted)', async () => {
    const tables = meetTables({ status: 'in_call' });
    addSession(tables, { status: 'created' });
    tables.interview_rounds![0]!.status = 'in_progress';
    tables.interview_rounds![0]!.starts_used = 3;
    use(tables);
    const opened = await first();
    expect(opened.status, opened.text).toBe(202);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_meet_bind_session']);
    expect(booking().session_id).toBe(SESSION);
    expect(h.tables.interview_rounds![0]!.starts_used).toBe(3);
  });

  it('an unbound session already in progress is bound and joined at once', async () => {
    const tables = meetTables({ status: 'in_call' });
    addSession(tables, { status: 'in_progress' });
    tables.interview_rounds![0]!.status = 'in_progress';
    use(tables);
    const response = await first();
    expect(response.status, response.text).toBe(200);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_meet_bind_session']);
    expect(booking().session_id).toBe(SESSION);
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
  });

  it('a failed look-up does not refuse: admission decides, and never makes a second session', async () => {
    // Every read of call_sessions fails; the RPC double still sees the live session.
    const tables = meetTables({ status: 'in_call' });
    addSession(tables, { status: 'created' });
    use(tables, {}, true, { call_sessions: { message: 'down' } });
    const busy = await first();
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: 'r1_busy' });
    expect(h.tables.call_sessions).toHaveLength(1);
    // With no live session the same failure still starts the interview.
    use(meetTables(), {}, true, { call_sessions: { message: 'down' } });
    const opened = await first();
    expect(opened.status, opened.text).toBe(202);
    expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt', 'r1_meet_bind_session']);
  });

  it('never continues a session it could not join: another round, another mode, a foreign room', async () => {
    const strange: Array<Partial<Row>> = [
      { id: '30000000-0000-4000-8000-0000000000e2', interview_round_id: 'another-round', status: 'waiting' },
      { mode: 'live', status: 'waiting' },
      { external_call_id: 'screening-somebody-else', status: 'waiting' },
    ];
    for (const over of strange) {
      const tables = meetTables({ status: 'in_call' });
      addSession(tables, over);
      use(tables);
      const response = await first();
      expect(response.status, JSON.stringify(over)).toBe(409);
      expect(response.body).toEqual({ error: 'r1_busy' });
      expect(booking().session_id).toBeNull();
      expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_admit_attempt']);
    }
  });

  it('an adopted session that cannot be bound is refused like any other bind, with no hint', async () => {
    for (const [answer, status, error] of [
      [{ status: 'not_in_call' }, 409, 'round_not_live'],
      [{ status: 'session_mismatch' }, 503, 'service_unavailable'],
    ] as const) {
      const tables = meetTables({ status: 'in_call' });
      addSession(tables, { status: 'created' });
      use(tables);
      answerRpc('r1_meet_bind_session', () => answer);
      const response = await first();
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ error });
      expect(rpcNames()).toEqual(['r1_meet_claim_ticket', 'r1_meet_bind_session']);
    }
  });

  it('nothing is awaited between admission and the bind: the audit follows the bind', async () => {
    const order: string[] = [];
    setAuditSink(() => {
      order.push('audit');
    });
    const originalRpc = h.db.rpc;
    h.db.rpc = async (fn: string, args: any) => {
      order.push(fn);
      return originalRpc(fn, args);
    };
    const originalFrom = h.db.from;
    h.db.from = (table: string) => {
      order.push(`from:${table}`);
      return originalFrom(table);
    };
    expect((await first()).status).toBe(202);
    const admission = order.indexOf('r1_admit_attempt');
    expect(admission).toBeGreaterThan(-1);
    expect(order.slice(admission, admission + 3)).toEqual(['r1_admit_attempt', 'r1_meet_bind_session', 'audit']);
  });
});

describe('20. no worker gate, or a disabled one, on any endpoint: no token (S05-R3)', () => {
  it('Cloud with no gate: 503 r1_unavailable before the claim, with the log line', async () => {
    use(meetTables(), {}, false);
    expectUnspent(await first(), 503, 'r1_unavailable');
    expect(category('error', 'r1_worker_gate_missing')).toHaveLength(1);
  });

  it('Cloud with no gate: a resume of a created or a waiting session is 503 before any room', async () => {
    for (const status of ['created', 'waiting']) {
      const token = boundBooking({}, { status }, {}, false);
      errors.mockClear();
      const response = await resume(token);
      expect(response.status, status).toBe(503);
      expect(response.body, status).toEqual({ error: 'r1_unavailable', retry_after_sec: MEET_RETRY_AFTER_SEC });
      expect(h.rooms.createRoom, status).not.toHaveBeenCalled();
      expect(category('error', 'r1_worker_gate_missing'), status).toHaveLength(1);
    }
  });

  it('a gate that cannot be built counts as missing on Cloud too', async () => {
    use(meetTables(), { resolveGate: () => { throw new Error('unbuildable'); } });
    expectUnspent(await first(), 503, 'r1_unavailable');
  });

  it('a disabled worker service is a 202, never a token, on Cloud and on the R1 SFU', async () => {
    for (const target of ['cloud', 'r1']) {
      use(meetTables());
      if (target === 'r1') selectR1Sfu();
      h.gate.ensureReadyWorker.mockResolvedValue({ status: 'disabled' });
      const response = await join();
      expect(response.status, target).toBe(202);
      expect('livekit_token' in response.body, target).toBe(false);
      expect(h.gate.dispatch, target).not.toHaveBeenCalled();
      delete process.env.BROWSER_LIVEKIT_TARGET;
    }
  });
});

describe('21. every gate runs again on a resume (S05-R4)', () => {
  const ROUND_CHANGES: Array<[string, (round: Row) => void]> = [
    ['cancelled', (round) => { round.status = 'cancelled'; }],
    ['lapsed', (round) => { round.expires_at = new Date(NOW).toISOString(); }],
    ['not a Meet round', (round) => { round.channel = 'browser'; }],
    ['gone', (round) => { round.id = 'another-round'; }],
  ];

  /** Refused before any room, gate or token, and nothing was claimed or admitted. */
  function expectStopped(response: request.Response, status: number, body: unknown): void {
    expect(response.status, response.text).toBe(status);
    expect(response.body).toEqual(body);
    expect(h.db.rpcCalls).toEqual([]);
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.gate.dispatch).not.toHaveBeenCalled();
  }
  const HINTED = (error: string) => ({ error, retry_after_sec: MEET_RETRY_AFTER_SEC });

  for (const status of ['created', 'waiting', 'in_progress']) {
    it(`${status}: the kill switch, the round, the profile, the session read and consent`, async () => {
      let token = boundBooking({}, { status });
      process.env.R1_ENABLED = 'false';
      expectStopped(await resume(token), 409, { error: 'r1_disabled' });
      process.env.R1_ENABLED = 'true';

      for (const [name, change] of ROUND_CHANGES) {
        token = boundBooking({}, { status });
        change(h.tables.interview_rounds![0]!);
        const response = await resume(token);
        expect(response.status, name).toBe(409);
        expectStopped(response, 409, { error: 'round_not_live' });
      }

      token = boundBooking({ objective_profile: 'r1_unknown_profile' }, { status });
      expectStopped(await resume(token), 503, HINTED('service_unavailable'));

      token = boundBooking({}, { status }, {}, true, { call_sessions: { message: 'down' } });
      expectStopped(await resume(token), 503, HINTED('service_unavailable'));

      token = boundBooking({}, { status });
      h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW - 1_000).toISOString();
      expectStopped(await resume(token), 409, { error: 'consent_required' });

      token = boundBooking({}, { status }, {}, true, { interview_round_consents: { message: 'down' } });
      expectStopped(await resume(token), 503, HINTED('service_unavailable'));
    });

    it(`${status}: the bound session must be a live browser-mode session of this round, in its own room`, async () => {
      for (const over of [
        { mode: 'live' },
        { interview_round_id: 'another-round' },
        { external_call_id: 'screening-somebody-else' },
      ]) {
        const token = boundBooking({}, { status, ...over });
        const response = await resume(token);
        expect(response.status, JSON.stringify(over)).toBe(409);
        expectStopped(response, 409, { error: 'round_not_live' });
      }
    });
  }

  it('an ended bound session that never got a room is refused too: the live check, not the room, stops it', async () => {
    // An admitted session that lapsed before its room existed: the booking still says in_call and
    // no room refusal would catch it (external_call_id is null), so only the live-status check does.
    for (const status of ['completed', 'failed']) {
      const token = boundBooking({}, { status, external_call_id: null });
      expectStopped(await resume(token), 409, { error: 'round_not_live' });
      expect(category('warn', 'r1_meet_exchange_refused').at(-1)?.error_type, status).toBe('round_not_live');
    }
  });

  it('created is still a new start: maintenance, the settings, the endpoint and DeepSeek', async () => {
    let token = boundBooking({}, { status: 'created' }, {
      maintenance: async () => ({ ok: true, enabled: true, reason: null, updatedAt: null }),
    });
    expectStopped(await resume(token), 503, {
      error: { type: 'maintenance_mode', message: 'Service temporarily unavailable' },
    });

    token = boundBooking({}, { status: 'created' });
    h.tables.r1_settings![0]!.paused = true;
    expectStopped(await resume(token), 409, { error: 'r1_paused' });

    token = boundBooking({}, { status: 'created' });
    h.tables.r1_settings![0]!.livekit_target = 'r1';
    expectStopped(await resume(token), 503, HINTED('r1_endpoint_mismatch'));

    token = boundBooking({}, { status: 'created' });
    h.health.mockResolvedValue(false);
    expectStopped(await resume(token), 503, { error: 'r1_unavailable', retry_after_sec: UNHEALTHY_RETRY_AFTER_SEC });
  });

  it('waiting and in_progress are not new starts: maintenance and a pause do not stop them', async () => {
    for (const status of ['waiting', 'in_progress']) {
      const token = boundBooking({}, { status }, {
        maintenance: async () => ({ ok: true, enabled: true, reason: null, updatedAt: null }),
      });
      h.tables.r1_settings![0]!.paused = true;
      const response = await resume(token);
      expect(response.status, response.text).toBe(200);
      expect(h.health).not.toHaveBeenCalled();
    }
  });

  it('waiting: the session is touched (the orphan lapse reads updated_at) before the gate runs', async () => {
    const token = boundBooking({}, { updated_at: new Date(NOW - 19 * 60_000).toISOString() });
    let atGate: unknown = null;
    h.gate.ensureReadyWorker.mockImplementationOnce(async () => {
      atGate = h.tables.call_sessions![0]!.updated_at;
      return { status: 'no_capacity' };
    });
    expect((await resume(token)).status).toBe(202);
    expect(atGate).toBe(new Date(NOW).toISOString());
  });
});

describe('22. retry hints and the refusal log line (S05-R5)', () => {
  const refusedLines = () => category('warn', 'r1_meet_exchange_refused').map((line) => line.error_type);

  it('a failed read before the claim is a hinted 503: the next call with the same ticket still joins', async () => {
    for (const table of ['r1_meet_bookings', 'interview_rounds', 'r1_settings', 'interview_round_consents']) {
      const failures: NonNullable<Parameters<typeof buildHarness>[3]> = { [table]: { message: 'down' } };
      use(meetTables(), {}, true, failures);
      warnings.mockClear();
      const response = await first();
      expectUnspent(response, 503, 'service_unavailable');
      expect(response.headers['retry-after'], table).toBe(String(MEET_RETRY_AFTER_SEC));
      expect(refusedLines(), table).toEqual(['service_unavailable']);
      // The blip is over: nothing was spent, so the same ticket is claimed now.
      delete failures[table];
      expect((await join()).status, table).toBe(200);
    }
  });

  it('every refusal of an authenticated ticket before the claim is one closed line', async () => {
    const cases: Array<[string, () => void]> = [
      ['ticket_not_yet_valid', () => use(meetTables({ ticket_not_before: new Date(NOW + 1).toISOString() }))],
      ['ticket_expired', () => use(meetTables({ ticket_expires_at: new Date(NOW).toISOString() }))],
      ['round_not_live', () => use(meetTables({ status: 'cancelled' }))],
      ['r1_paused', () => { use(meetTables()); h.tables.r1_settings![0]!.paused = true; }],
      ['r1_disabled', () => { use(meetTables()); h.tables.r1_settings![0]!.enabled = false; }],
      ['r1_endpoint_mismatch', () => { use(meetTables()); h.tables.r1_settings![0]!.livekit_target = 'r1'; }],
      ['r1_unavailable', () => { use(meetTables()); h.health.mockResolvedValue(false); }],
      ['consent_required', () => {
        use(meetTables());
        h.tables.interview_round_consents![0]!.withdrawn_at = new Date(NOW - 1_000).toISOString();
      }],
      ['maintenance_mode', () => use(meetTables(), {
        maintenance: async () => ({ ok: true, enabled: true, reason: null, updatedAt: null }),
      })],
    ];
    for (const [code, arrange] of cases) {
      arrange();
      warnings.mockClear();
      expect((await first()).status, code).toBeGreaterThanOrEqual(400);
      expect(refusedLines(), code).toEqual([code]);
      expect(booking().ticket_claimed_at, code).toBeNull();
      const line = category('warn', 'r1_meet_exchange_refused')[0]!;
      expect(Object.keys(line).sort()).toEqual([
        'component', 'correlationId', 'error_category', 'error_type', 'event', 'level', 'timestamp',
      ]);
    }
    expectQuietLines();
  });

  it('a claim the database refused, and a refused resume, are logged the same way', async () => {
    answerRpc('r1_meet_claim_ticket', () => ({ status: 'round_not_live', booking_id: MEET_BOOKING }));
    expect((await first()).status).toBe(409);
    expect(refusedLines()).toEqual(['round_not_live']);

    warnings.mockClear();
    const token = boundBooking({}, { status: 'completed' });
    expect((await resume(token)).status).toBe(409);
    expect(refusedLines()).toEqual(['round_not_live']);
  });

  it('an unknown ticket, a replay, a forged token, a malformed body and the dark route log no such line', async () => {
    await first('mt' + 'q'.repeat(41));
    await call({});
    await join();
    await first();
    const token = boundBooking();
    await resume(token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a'));
    use(meetTables(), { meetEnabled: () => false });
    await first();
    expect(refusedLines()).toEqual([]);
  });

  it('after the claim of a fresh ticket no 503 carries a hint', async () => {
    const spent: Array<() => void> = [
      () => answerRpc('r1_meet_claim_ticket', () => ({ status: 'surprise' })),
      () => answerRpc('r1_admit_attempt', () => ({ status: 'r1_role_invalid' })),
      () => answerRpc('r1_admit_attempt', () => ({ status: 'brand_new' })),
      () => answerRpc('r1_meet_bind_session', () => ({ status: 'session_mismatch' })),
    ];
    for (const arrange of spent) {
      use(meetTables());
      arrange();
      const response = await first();
      expect(response.status).toBe(503);
      expect(Object.keys(response.body)).toEqual(['error']);
      expect(response.headers['retry-after']).toBeUndefined();
    }
  });
});

describe('23. a first call never waits for a worker (S05-R6)', () => {
  it('a fresh ticket is 202 right after the bind: no room, no gate, no token yet', async () => {
    h.gate.ensureReadyWorker.mockImplementation(() => new Promise(() => undefined));
    const opened = await first();
    expect(opened.status, opened.text).toBe(202);
    expect(opened.body.resume_token).toMatch(R1_MEET_RESUME_TOKEN_PATTERN);
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(booking().session_id).toBe(String(admittedSession().id));
  });

  it('so is a re-arm of a created or a waiting session; its continuation is repeatable', async () => {
    for (const status of ['created', 'waiting']) {
      const tables = meetTables({ status: 'in_call', session_id: SESSION });
      addSession(tables, { status });
      tables.interview_rounds![0]!.status = 'in_progress';
      use(tables);
      const opened = await first();
      expect(opened.status, status).toBe(202);
      expect(h.gate.ensureReadyWorker, status).not.toHaveBeenCalled();
      expect(h.rooms.createRoom, status).not.toHaveBeenCalled();
      expect(rpcNames(), status).toEqual(['r1_meet_claim_ticket']);
      // The slow call's answer is lost on the wire: the page asks again with the token it holds.
      expect((await resume(opened.body.resume_token)).status, status).toBe(200);
      const again = await resume(opened.body.resume_token);
      expect(again.status, status).toBe(200);
      expect(rpcNames(), status).toEqual(['r1_meet_claim_ticket']);
    }
  });
});
