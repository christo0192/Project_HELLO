/**
 * The Meet-channel guard (M034 S05 T3; contracts section 3; plan D-S05-12 and D-S05-13).
 *
 * A round held in Google Meet (`interview_rounds.channel = 'meet'`, migration 0142) never takes
 * the browser path: `/status` and `/attempts` (admission and the nonce rejoin) answer exactly
 * 409 `{ "error": "round_channel_meet" }` as soon as the link is recognised, whatever the
 * switches say; `/exchange` and `/ready` answer it once the attempt's session and round are
 * known to belong together. Nothing is admitted, provisioned, dispatched, audited or written.
 * `/preflight`, `/consent`, `/consent-template` and `/consent/withdraw` are not guarded.
 *
 * The other half is the browser proof: a round row carrying `channel: 'browser'` and the same
 * row without the column produce byte-identical answers, and no answer ever carries `channel`.
 *
 * The router under test is the real one, over the shared in-memory harness
 * (support/r1-candidate-harness.ts), as in r1-candidate-routes.test.ts.
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

import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { mintAttemptToken } from '../lib/r1/attempt-token.js';
import {
  CANDIDATE,
  LINK,
  NOW,
  REQUIRED,
  ROUND,
  SESSION,
  WORKER_SECRET,
  addAttempt,
  addSession,
  buildHarness,
  grantConsent,
  seedTables,
  sha256,
  type Harness,
} from './support/r1-candidate-harness.js';
import type { Tables } from './support/r1-candidate-fake-db.js';
import { parseYamlDocument, type YMap } from './support/openapi-schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC_TEXT = readFileSync(path.resolve(here, '../../openapi/openapi.yaml'), 'utf8')
  .replace(/\r\n/g, '\n');
const SPEC = parseYamlDocument(SPEC_TEXT);
const SOURCE = readFileSync(path.resolve(here, '../routes/r1-candidate.ts'), 'utf8');

const MEET_ERROR = { error: 'round_channel_meet' } as const;
const MEET_ERROR_TEXT = '{"error":"round_channel_meet"}';
/** The HR staff member who scheduled the Dex interview in Ashby (a fixture id, not a real one). */
const ATTESTER = '60000000-0000-4000-8000-0000000000f1';
/** The Meet session's nonce: it never leaves the server in production; here it is a fixture. */
const MEET_NONCE = 'c3'.repeat(32);

/** The `/status` 200 keys, in the order the handler writes them (no `channel`, D-S05-13). */
const STATUS_KEYS = [
  'round_status',
  'expires_at',
  'availability',
  'attempts_allowed',
  'attempts_remaining',
  'starts_remaining',
  'consent',
  'live_attempt',
  'can_start',
  'role_title',
  'format',
  'audience',
];
const ATTEMPT_CREATED_KEYS = [
  'attempt_id',
  'attempt_number',
  'attempt_token',
  'attempt_token_expires_at',
  'nonce',
  'rejoin',
];
const ATTEMPT_REJOIN_KEYS = [
  'attempt_id',
  'attempt_number',
  'attempt_token',
  'attempt_token_expires_at',
  'rejoin',
];
const EXCHANGE_KEYS = ['url', 'livekit_token', 'expires_at', 'attempt_id'];

const ENV_KEYS = ['R1_ENABLED', 'WORKER_CONTEXT_SECRET', 'BROWSER_LIVEKIT_TARGET', 'R1_MEET_ENABLED'];
const savedEnv: Record<string, string | undefined> = {};
let audits: AuditEntry[];
let originalSink: ReturnType<typeof getAuditSink>;
let h: Harness;
let maintenance: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  delete process.env.BROWSER_LIVEKIT_TARGET;
  delete process.env.R1_MEET_ENABLED;
  mocks.startRecording.mockReset();
  mocks.startRecording.mockResolvedValue({ status: 'started', egressId: 'egress-must-not-happen' });
  audits = [];
  originalSink = getAuditSink();
  setAuditSink((entry) => {
    audits.push(entry);
  });
  use(seedTables());
});

afterEach(() => {
  setAuditSink(originalSink);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Rebuild the harness (and the mocked database) over `tables`; maintenance is off unless asked. */
function use(tables: Tables, maintenanceOn = false): Harness {
  const read = vi.fn(async () => ({
    ok: true as const,
    enabled: maintenanceOn,
    reason: null,
    updatedAt: null,
  }));
  maintenance = read;
  h = buildHarness(tables, { maintenance: read });
  mocks.db.current = h.db;
  return h;
}

const post = (route: string, body: unknown) => request(h.app)
  .post(`/api/r1${route}`)
  .send(body as object);

/** The seeded round, held in Google Meet, with the HR-attested consent scheduling recorded. */
function meetTables(): Tables {
  const tables = seedTables();
  tables.interview_rounds![0]!.channel = 'meet';
  grantConsent(tables, {
    method: 'hr_attested_ashby',
    attested_by_external_id: ATTESTER,
    attested_at: new Date(NOW - 3_600_000).toISOString(),
    india_location_attested: true,
  });
  return tables;
}

/** A Meet round's live session and its attempt, plus the attempt token the server would hold. */
function meetSession(tables: Tables, status: string): { attempt_token: string; nonce: string } {
  addSession(tables, { status });
  addAttempt(tables, MEET_NONCE);
  tables.interview_rounds![0]!.status = 'in_progress';
  tables.interview_rounds![0]!.starts_used = 1;
  const minted = mintAttemptToken({ sessionId: SESSION, nonceDigest: sha256(MEET_NONCE) }, NOW);
  expect(minted).not.toBeNull();
  return { attempt_token: minted!.token, nonce: MEET_NONCE };
}

interface Switches {
  label: string;
  r1Enabled: 'true' | 'false';
  maintenance: boolean;
  settingsEnabled: boolean;
  paused: boolean;
  meetFlag: 'true' | 'false' | undefined;
}

const OPEN: Switches = {
  label: 'every switch open',
  r1Enabled: 'true',
  maintenance: false,
  settingsEnabled: true,
  paused: false,
  meetFlag: undefined,
};

/** Every switch the browser path reads, one at a time and all at once. */
const SWITCHES: Switches[] = [
  OPEN,
  { ...OPEN, label: 'R1_ENABLED=false', r1Enabled: 'false' },
  { ...OPEN, label: 'maintenance on', maintenance: true },
  { ...OPEN, label: 'r1_settings.enabled=false', settingsEnabled: false },
  { ...OPEN, label: 'r1_settings.paused=true', paused: true },
  { ...OPEN, label: 'Meet flag on', meetFlag: 'true' },
  { ...OPEN, label: 'Meet flag off', meetFlag: 'false' },
  {
    label: 'every switch shut, Meet flag on',
    r1Enabled: 'false',
    maintenance: true,
    settingsEnabled: false,
    paused: true,
    meetFlag: 'true',
  },
];

/** Apply `switches` to the environment and to `tables`, then build the harness over them. */
function arrange(switches: Switches, tables: Tables): Harness {
  process.env.R1_ENABLED = switches.r1Enabled;
  if (switches.meetFlag === undefined) delete process.env.R1_MEET_ENABLED;
  else process.env.R1_MEET_ENABLED = switches.meetFlag;
  tables.r1_settings![0]!.enabled = switches.settingsEnabled;
  tables.r1_settings![0]!.paused = switches.paused;
  return use(tables, switches.maintenance);
}

/** The exact Meet refusal, with nothing started, read beyond `reads`, or written anywhere. */
function expectRefusedUntouched(
  response: request.Response,
  before: string,
  reads: string[],
  label: string,
): void {
  expect(response.status, label).toBe(409);
  expect(response.body, label).toEqual(MEET_ERROR);
  expect(response.text, label).toBe(MEET_ERROR_TEXT);
  expect(response.headers['cache-control'], label).toBe('no-store');
  expect(response.headers['retry-after'], label).toBeUndefined();
  expect([...h.db.touched].sort(), label).toEqual([...reads].sort());
  expect(h.db.rpcCalls, label).toEqual([]);
  expect(JSON.stringify(h.tables), label).toBe(before);
  expect(audits, label).toEqual([]);
  expect(maintenance, label).not.toHaveBeenCalled();
  expect(h.health, label).not.toHaveBeenCalled();
  expect(h.rooms.createRoom, label).not.toHaveBeenCalled();
  expect(h.rooms.updateRoomMetadata, label).not.toHaveBeenCalled();
  expect(h.rooms.deleteRoom, label).not.toHaveBeenCalled();
  expect(h.rooms.listParticipants, label).not.toHaveBeenCalled();
  expect(h.rooms.sendData, label).not.toHaveBeenCalled();
  expect(h.gate.ensureReadyWorker, label).not.toHaveBeenCalled();
  expect(h.gate.dispatch, label).not.toHaveBeenCalled();
  expect(h.gate.releaseWorker, label).not.toHaveBeenCalled();
  expect(mocks.startRecording, label).not.toHaveBeenCalled();
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a Meet round never takes the browser path', () => {
  it('POST /status answers exactly 409 round_channel_meet, whatever the switches say', async () => {
    for (const switches of SWITCHES) {
      const tables = meetTables();
      arrange(switches, tables);
      const before = JSON.stringify(h.tables);
      const response = await post('/status', { token: LINK });
      // Only the link lookup ran: no settings, consent, live-session or role read.
      expectRefusedUntouched(response, before, ['interview_rounds'], `/status, ${switches.label}`);
    }
  });

  it('POST /status refuses a Meet round that has a live session or no consent the same way', async () => {
    const live = meetTables();
    addSession(live, { status: 'in_progress' });
    use(live);
    let before = JSON.stringify(h.tables);
    expectRefusedUntouched(await post('/status', { token: LINK }), before, ['interview_rounds'], 'live');

    const unconsented = seedTables();
    unconsented.interview_rounds![0]!.channel = 'meet';
    use(unconsented);
    before = JSON.stringify(h.tables);
    expectRefusedUntouched(
      await post('/status', { token: LINK }),
      before,
      ['interview_rounds'],
      'no consent',
    );
  });

  it('POST /attempts (admission) answers exactly 409 round_channel_meet, whatever the switches say', async () => {
    for (const switches of SWITCHES) {
      const tables = meetTables();
      arrange(switches, tables);
      const before = JSON.stringify(h.tables);
      const response = await post('/attempts', { token: LINK });
      expectRefusedUntouched(response, before, ['interview_rounds'], `/attempts, ${switches.label}`);
      expect(h.tables.interview_rounds![0]!.starts_used).toBe(0);
      expect(h.tables.call_sessions).toEqual([]);
    }
  });

  it('POST /attempts with a nonce (the rejoin branch) answers it too, before the live session is read', async () => {
    for (const switches of SWITCHES) {
      const tables = meetTables();
      meetSession(tables, 'waiting');
      arrange(switches, tables);
      const before = JSON.stringify(h.tables);
      const response = await post('/attempts', { token: LINK, nonce: MEET_NONCE });
      expectRefusedUntouched(
        response,
        before,
        ['interview_rounds'],
        `/attempts rejoin, ${switches.label}`,
      );
    }
  });

  it('POST /exchange answers it for a Meet session in every live state: no gate, no room, no token', async () => {
    const reachable = SWITCHES.filter((switches) => switches.r1Enabled === 'true');
    expect(reachable.length).toBeGreaterThanOrEqual(5);
    for (const status of ['created', 'waiting', 'in_progress']) {
      for (const switches of reachable) {
        const tables = meetTables();
        const secrets = meetSession(tables, status);
        arrange(switches, tables);
        const before = JSON.stringify(h.tables);
        const response = await post('/exchange', secrets);
        expectRefusedUntouched(
          response,
          before,
          ['interview_round_attempts', 'call_sessions', 'interview_rounds'],
          `/exchange ${status}, ${switches.label}`,
        );
        expect(response.body).not.toHaveProperty('livekit_token');
      }
    }
  });

  it('POST /ready answers it for a Meet session: nothing is relayed', async () => {
    const reachable = SWITCHES.filter((switches) => switches.r1Enabled === 'true');
    for (const status of ['waiting', 'in_progress']) {
      for (const switches of reachable) {
        const tables = meetTables();
        const secrets = meetSession(tables, status);
        arrange(switches, tables);
        const before = JSON.stringify(h.tables);
        const response = await post('/ready', secrets);
        expectRefusedUntouched(
          response,
          before,
          ['interview_round_attempts', 'call_sessions', 'interview_rounds'],
          `/ready ${status}, ${switches.label}`,
        );
      }
    }
  });

  it('keeps the attempt-token routes\' order: the kill switch is read once the attempt authenticates, before its round', async () => {
    // Invariant 1: /exchange and /ready report the switch right after the attempt token and
    // nonce verify, and only then load the session and round. With R1 switched off a Meet
    // session therefore meets r1_disabled first; both answers are terminal and start nothing.
    for (const route of ['/exchange', '/ready']) {
      const tables = meetTables();
      const secrets = meetSession(tables, 'waiting');
      arrange({ ...OPEN, label: 'R1_ENABLED=false', r1Enabled: 'false' }, tables);
      const before = JSON.stringify(h.tables);
      const response = await post(route, secrets);
      expect(response.status, route).toBe(409);
      expect(response.body, route).toEqual({ error: 'r1_disabled' });
      expect([...h.db.touched], route).toEqual(['interview_round_attempts']);
      expect(JSON.stringify(h.tables), route).toBe(before);
      expect(h.gate.dispatch, route).not.toHaveBeenCalled();
      expect(h.rooms.createRoom, route).not.toHaveBeenCalled();
      expect(h.rooms.sendData, route).not.toHaveBeenCalled();
    }
  });

  it('still authenticates first: an unknown link or a wrong nonce is answered as before', async () => {
    use(meetTables());
    expect((await post('/status', { token: 'b2'.repeat(32) })).body)
      .toEqual({ error: 'r1_link_invalid_or_expired' });
    expect((await post('/attempts', { token: 'b2'.repeat(32) })).body)
      .toEqual({ error: 'r1_link_invalid_or_expired' });
    const tables = meetTables();
    const secrets = meetSession(tables, 'waiting');
    use(tables);
    for (const route of ['/exchange', '/ready']) {
      const response = await post(route, { ...secrets, nonce: 'd4'.repeat(32) });
      expect(response.status, route).toBe(404);
      expect(response.body, route).toEqual({ error: 'r1_attempt_invalid' });
    }
  });
});

describe('the routes the guard leaves alone', () => {
  it('POST /consent/withdraw still withdraws for a Meet round and stops its live session (invariant 5)', async () => {
    const tables = meetTables();
    addSession(tables, { status: 'waiting' });
    use(tables, true);
    process.env.R1_ENABLED = 'false';
    const response = await post('/consent/withdraw', { token: LINK });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, withdrawn: true, sessions_stopped: 1 });
    expect(h.tables.interview_round_consents![0]!.withdrawn_at).toBeTruthy();
    expect(h.tables.interview_round_consents![0]!.method).toBe('hr_attested_ashby');
    expect(h.db.rpcCalls.map((call) => call.fn)).toEqual(['r1_withdraw_consent']);
    expect(h.tables.call_sessions![0]).toMatchObject({ status: 'cancelled' });
  });

  it('POST /consent-template answers a Meet round exactly as it answers a browser round', async () => {
    use(meetTables());
    const meet = await post('/consent-template', { token: LINK });
    use(seedTables());
    const browser = await post('/consent-template', { token: LINK });
    expect(meet.status).toBe(200);
    expect(meet.text).toBe(browser.text);
  });

  it('POST /preflight answers a Meet round as it answers a browser round', async () => {
    use(meetTables());
    const meet = await post('/preflight', { token: LINK });
    const browserTables = seedTables();
    grantConsent(browserTables);
    use(browserTables);
    const browser = await post('/preflight', { token: LINK });
    expect(meet.status).toBe(200);
    expect(browser.status).toBe(200);
    expect(Object.keys(meet.body)).toEqual(Object.keys(browser.body));
    expect(meet.body.url).toBe(browser.body.url);
    expect(meet.body).not.toHaveProperty('error');
  });

  it('POST /consent records a decision for a Meet round as it does for a browser round', async () => {
    const grant = { token: LINK, template_version: '002', consents: REQUIRED, status: 'granted' };
    const meet = seedTables();
    meet.interview_rounds![0]!.channel = 'meet';
    use(meet);
    const meetAnswer = await post('/consent', grant);
    use(seedTables());
    const browserAnswer = await post('/consent', grant);
    expect(meetAnswer.status).toBe(201);
    expect(browserAnswer.status).toBe(201);
    expect(Object.keys(meetAnswer.body)).toEqual(Object.keys(browserAnswer.body));
  });
});

describe('browser rounds are byte-identical (a `browser` channel and no channel column at all)', () => {
  /** The seeded round with `channel: 'browser'`, or without the field (the pre-0142 shape). */
  function browserTables(channel: 'browser' | 'absent'): Tables {
    const tables = seedTables();
    if (channel === 'browser') tables.interview_rounds![0]!.channel = 'browser';
    return tables;
  }

  it('the shared fixture has no channel column, so both shapes are really exercised', () => {
    expect(seedTables().interview_rounds![0]!).not.toHaveProperty('channel');
    expect(browserTables('browser').interview_rounds![0]!.channel).toBe('browser');
  });

  it('POST /status: the same bytes, exactly the documented keys and never a channel', async () => {
    const states: Array<{ label: string; arrange: (tables: Tables) => void }> = [
      { label: 'fresh link', arrange: () => undefined },
      { label: 'consent granted', arrange: (tables) => void grantConsent(tables) },
      {
        label: 'live attempt',
        arrange: (tables) => {
          grantConsent(tables);
          addSession(tables, { status: 'in_progress' });
        },
      },
      { label: 'paused', arrange: (tables) => void (tables.r1_settings![0]!.paused = true) },
      {
        label: 'lapsed round',
        arrange: (tables) => {
          tables.interview_rounds![0]!.expires_at = new Date(NOW - 1000).toISOString();
        },
      },
      {
        label: 'staff dry run',
        arrange: (tables) => {
          tables.interview_rounds![0]!.consent_locale = 'en-IN-x-staff';
        },
      },
    ];
    for (const state of states) {
      const answers: request.Response[] = [];
      for (const channel of ['browser', 'absent'] as const) {
        const tables = browserTables(channel);
        state.arrange(tables);
        use(tables);
        answers.push(await post('/status', { token: LINK }));
      }
      const [withChannel, without] = answers as [request.Response, request.Response];
      expect(withChannel.status, state.label).toBe(200);
      expect(withChannel.text, state.label).toBe(without.text);
      expect(Object.keys(withChannel.body), state.label).toEqual(STATUS_KEYS);
      expect(withChannel.body, state.label).not.toHaveProperty('channel');
    }

    process.env.R1_ENABLED = 'false';
    const off: string[] = [];
    for (const channel of ['browser', 'absent'] as const) {
      use(browserTables(channel));
      off.push((await post('/status', { token: LINK })).text);
    }
    expect(off[0]).toBe(off[1]);
    expect(JSON.parse(off[0]!).availability).toBe('disabled');
  });

  it('POST /status: the documented 200 schema is unchanged (required keys, and no channel property)', () => {
    const ok = ((((SPEC.paths as YMap)['/api/r1/status'] as YMap).post as YMap).responses as YMap)['200'] as YMap;
    const schema = ((ok.content as YMap)['application/json'] as YMap).schema as YMap;
    expect([...(schema.required as string[])].sort()).toEqual([...STATUS_KEYS].sort());
    expect(Object.keys(schema.properties as YMap)).not.toContain('channel');
    expect(schema.additionalProperties).toBe(false);
  });

  it('POST /attempts: the 201 admission and the 200 rejoin keep exactly their keys', async () => {
    for (const channel of ['browser', 'absent'] as const) {
      audits.length = 0;
      const tables = browserTables(channel);
      grantConsent(tables);
      use(tables);
      const created = await post('/attempts', { token: LINK });
      expect(created.status, channel).toBe(201);
      expect(Object.keys(created.body), channel).toEqual(ATTEMPT_CREATED_KEYS);
      expect(created.body.rejoin, channel).toBe(false);
      const rejoined = await post('/attempts', { token: LINK, nonce: created.body.nonce });
      expect(rejoined.status, channel).toBe(200);
      expect(Object.keys(rejoined.body), channel).toEqual(ATTEMPT_REJOIN_KEYS);
      expect(rejoined.body.rejoin, channel).toBe(true);
      // One admission audit row, as before; the rejoin writes none.
      expect(audits.filter((entry) => entry.metadata?.resource === 'interview_round_attempt'), channel)
        .toHaveLength(1);
      // The busy answer of a second start is the same bytes as before.
      const busy = await post('/attempts', { token: LINK });
      expect(busy.status, channel).toBe(409);
      expect(busy.body.error, channel).toBe('r1_busy');
    }
  });

  it('POST /exchange and POST /ready: the 200 keys, the dispatch call and the room metadata carry no Meet field', async () => {
    for (const channel of ['browser', 'absent'] as const) {
      const tables = browserTables(channel);
      grantConsent(tables);
      use(tables);
      const secrets = (await post('/attempts', { token: LINK })).body;
      const exchange = { attempt_token: secrets.attempt_token, nonce: secrets.nonce };
      const joined = await post('/exchange', exchange);
      expect(joined.status, channel).toBe(200);
      expect(Object.keys(joined.body), channel).toEqual(EXCHANGE_KEYS);
      expect(joined.body.attempt_id, channel).toBe(secrets.attempt_id);

      expect(h.gate.dispatch, channel).toHaveBeenCalledTimes(1);
      const dispatched = h.gate.dispatch.mock.calls[0]![0] as Record<string, unknown>;
      expect(dispatched, channel).not.toHaveProperty('meet');
      expect(dispatched, channel).toMatchObject({
        sessionId: secrets.attempt_id,
        roomName: `screening-${secrets.attempt_id}`,
      });
      expect(h.rooms.createRoom, channel).toHaveBeenCalled();
      for (const [options] of h.rooms.createRoom.mock.calls as Array<[{ metadata: string }]>) {
        const metadata = JSON.parse(options.metadata) as Record<string, unknown>;
        expect(metadata, channel).not.toHaveProperty('channel');
        expect(metadata, channel).not.toHaveProperty('candidate_identity');
        expect(metadata.lane, channel).toBe('r1');
      }

      const ready = await post('/ready', exchange);
      expect(ready.status, channel).toBe(200);
      expect(ready.text, channel).toBe('{"ok":true}');
    }
  });
});

describe('the guard is documented and answered where the web expects it', () => {
  /** The spec text of one path: from its header line to the next path. */
  function sectionFor(route: string): string {
    const start = SPEC_TEXT.indexOf(`\n  ${route}:\n`);
    expect(start, `${route} is documented`).toBeGreaterThan(-1);
    const rest = SPEC_TEXT.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}\/|\n {2}#/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  it('names round_channel_meet in the 409 of status, attempts, exchange and ready, and not for the unguarded routes', () => {
    for (const route of ['/api/r1/status', '/api/r1/attempts', '/api/r1/exchange', '/api/r1/ready']) {
      const responses = (((SPEC.paths as YMap)[route] as YMap).post as YMap).responses as YMap;
      const conflict = responses['409'] as YMap | undefined;
      expect(conflict, `${route} documents a 409`).toBeDefined();
      expect(String(conflict!.description), route).toMatch(/\bround_channel_meet\b/);
      expect(sectionFor(route), route).toMatch(/\bround_channel_meet\b/);
    }
    for (const route of [
      '/api/r1/consent-template',
      '/api/r1/consent',
      '/api/r1/consent/withdraw',
      '/api/r1/preflight',
    ]) {
      expect(sectionFor(route), route).not.toMatch(/\bround_channel_meet\b/);
    }
  });

  it('quotes the code in the router source, once, where the guard writes it', () => {
    // The web contract test (S07) greps the router for the quoted literal.
    expect(SOURCE.match(/'round_channel_meet'/g)).toHaveLength(1);
    expect(SOURCE).toContain("refuse(res, 409, 'round_channel_meet')");
  });

  it('says nothing but the code: no round, candidate, attester or Meet detail in the refusal', async () => {
    const tables = meetTables();
    const secrets = meetSession(tables, 'waiting');
    use(tables);
    for (const [route, body] of [
      ['/status', { token: LINK }],
      ['/attempts', { token: LINK }],
      ['/exchange', secrets],
      ['/ready', secrets],
    ] as const) {
      const response = await post(route, body);
      expect(response.text, route).toBe(MEET_ERROR_TEXT);
      for (const secret of [ROUND, CANDIDATE, SESSION, ATTESTER, LINK, MEET_NONCE]) {
        expect(response.text, route).not.toContain(secret);
      }
    }
  });
});
