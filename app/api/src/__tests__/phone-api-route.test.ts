/**
 * The phone operator API — authorization, validation, projection, delegation,
 * audit and the disabled default.
 *
 * Two harnesses, deliberately:
 *   * a BARE express app with an injected `authUser` and injected stores, for
 *     the status-to-HTTP matrix, the projections and the audit paths;
 *   * the REAL `createApp`, for the 401 boundary and the viewer read-only guard,
 *     because those live in middleware the bare harness does not have and a
 *     test that stubbed them would be asserting its own stub.
 *
 * No network, no database, no real Supabase client anywhere.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { createPhoneApiRouter, type PhoneApiDeps } from '../routes/phone.js';
import {
  PHONE_MAX_CONCURRENT,
  type PhoneAppointmentRow,
  type PhoneAttemptRow,
  type PhoneCandidateRow,
  type PhoneEngagementRow,
  type PhoneReadStore,
  type PhoneStores,
} from '../lib/phone-screening/index.js';
import {
  clearPhoneRuntimeRegistration,
  registerPhoneRuntime,
} from '../lib/phone-runtime/health.js';
import type {
  PhoneRuntimeHandle,
  PhoneRuntimeSnapshot,
} from '../lib/phone-runtime/runtime.js';

// ════════════════════════════════════════════════════════════════════
//  Fixtures
// ════════════════════════════════════════════════════════════════════

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_E = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_OTHER = '44444444-4444-4444-8444-444444444444';

/** Injected clock. Every assertion that depends on "now" pins it here. */
const NOW = new Date('2026-08-23T18:31:00Z');

const APPOINTMENT: PhoneAppointmentRow = {
  id: UUID_A,
  engagementId: UUID_E,
  startsAt: '2026-08-24T03:30:00.000Z',
  endsAt: '2026-08-24T04:00:00.000Z',
  istDate: '2026-08-24',
  status: 'scheduled',
  source: 'hr_manual',
  confirmedAt: null,
  cancelReason: null,
  version: 3,
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:00:00.000Z',
};

const ENGAGEMENT: PhoneEngagementRow = {
  id: UUID_E,
  candidateId: UUID_C,
  state: 'scheduled',
  stateReason: null,
  epoch: 0,
  version: 2,
  noAnswerAttempts: 2,
  reconnectsUsed: 0,
  providerFailures: 5,
  nextEligibleAt: '2026-08-25T03:30:00.000Z',
  lastAttemptAt: '2026-08-23T05:01:00.000Z',
  terminalAt: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-23T10:00:00.000Z',
};

const CANDIDATE: PhoneCandidateRow = {
  id: UUID_C,
  name: 'Priya Example',
  status: 'screening',
  reference: 'ATS-9001',
};

const ATTEMPT: PhoneAttemptRow = {
  id: '55555555-5555-4555-8555-555555555555',
  engagementId: UUID_E,
  attemptSeq: 1,
  epoch: 0,
  kind: 'initial',
  state: 'ended',
  outcomeClass: 'no_answer',
  istDate: '2026-08-23',
  priorEngagementState: 'eligible',
  admittedAt: '2026-08-23T05:00:00.000Z',
  answeredAt: null,
  classifiedAt: null,
  endedAt: '2026-08-23T05:01:00.000Z',
};

const HEALTHY_BACKLOG = {
  status: 'ok' as const,
  admission: { controlPresent: true, halted: false, haltReason: null },
  engagementsByState: { eligible: 3, scheduled: 1 },
  attempts: {
    live: 2,
    liveWithUnexpiredLease: 2,
    maxConcurrent: PHONE_MAX_CONCURRENT,
    oldestLiveAgeSeconds: 12,
  },
  appointments: { live: 1, overdue: 0 },
  events: {
    ignoredLast24h: 7,
    unknownAttemptLast24h: 2,
    staleEpochLast24h: 3,
    terminalLast24h: 1,
    unexpectedEventLast24h: 1,
  },
  windowOpen: true,
  istDate: '2026-08-24',
};

// ════════════════════════════════════════════════════════════════════
//  Fakes
// ════════════════════════════════════════════════════════════════════

/** Counts every call so a test can assert "zero database work". */
interface ReadSpy {
  store: PhoneReadStore;
  calls: string[];
}

function fakeReadStore(over: Partial<PhoneReadStore> = {}): ReadSpy {
  const calls: string[] = [];
  const track = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const base: PhoneReadStore = {
    listAppointmentsByStart: () => track('listAppointmentsByStart', [APPOINTMENT]),
    listLiveAppointmentsByStart: () => track('listLiveAppointmentsByStart', [APPOINTMENT]),
    getAppointment: () => track('getAppointment', APPOINTMENT),
    getLiveAppointmentForEngagement: () =>
      track('getLiveAppointmentForEngagement', APPOINTMENT),
    listEngagementsByIds: () => track('listEngagementsByIds', [ENGAGEMENT]),
    getEngagement: () => track('getEngagement', ENGAGEMENT),
    listCandidatesByIds: () => track('listCandidatesByIds', [CANDIDATE]),
    listAttemptsForEngagement: () => track('listAttemptsForEngagement', [ATTEMPT]),
    // 0043/P4. The operator calendar API never resolves an attempt to its
    // engagement — that bridge exists only for the internal worker surface —
    // so the default answers "unknown" rather than a plausible row.
    getAttemptContext: () => track('getAttemptContext', null),
  };
  const store = new Proxy({ ...base, ...over } as PhoneReadStore, {
    get(target, prop: string) {
      const fn = (target as unknown as Record<string, unknown>)[prop];
      if (typeof fn !== 'function') return fn;
      return (...args: unknown[]) => {
        if (!(prop in over)) return (fn as (...a: unknown[]) => unknown)(...args);
        calls.push(prop);
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
  return { store, calls };
}

interface WriteSpy {
  store: PhoneStores;
  calls: Array<{ op: string; input: unknown }>;
}

function fakeStores(over: Partial<PhoneStores> = {}): WriteSpy {
  const calls: Array<{ op: string; input: unknown }> = [];
  const defaults: PhoneStores = {
    admitAttempt: async () => ({ status: 'ok' }),
    stampSessionEgress: async () => ({ status: 'ok' as const, duplicate: false }),
    heartbeatAttempt: async () => ({ status: 'ok' }),
    heartbeatAttemptByEpoch: async () => ({ status: 'ok' as const }),
    sweepDayRolled: async () => ({ status: 'ok' as const, examined: 0, rolled: 0, skipped: 0 }),
    sweepStrandedSessions: async () => ({
      status: 'ok' as const, examined: 0, completed: 0, failed: 0, skipped: 0,
    }),
    claimSweep: async () => ({ status: 'ok' as const }),
    reclaimAttemptLeases: async () => ({ status: 'ok' }),
    applyEvent: async () => ({ status: 'applied' }),
    // 0043. The operator calendar API never binds or purges a recording, so
    // these default to a shape that would fail loudly if it ever did.
    attachAttemptRecording: async () => ({ status: 'not_found' }),
    // 0044. The operator calendar API never starts, reads or advances an
    // assessment either; a refusal shape here would fail loudly if it did.
    startAssessment: async () => ({ status: 'unknown_attempt' }),
    assessmentState: async () => ({ status: 'unknown_session' }),
    commitQuestionBoundary: async () => ({
      status: 'unknown_session', applied: false, duplicate: false,
    }),
    finalizeAttemptRecording: async () => ({ status: 'not_found' }),
    listEngagementRecordings: async () => ({ status: 'not_found' }),
    clearAttemptRecordings: async () => ({ status: 'not_found' }),
    // A reschedule (non-null expected version) supersedes the live row and
    // returns its id; a create supersedes nothing. The route treats a
    // reschedule that superseded NOTHING as a lost update, so the default fake
    // has to model the difference rather than always answering null.
    scheduleAppointment: async (input: { expectedVersion?: number | null }) => ({
      status: 'ok',
      appointmentId: UUID_A,
      version: 1,
      engagementState: 'scheduled',
      supersededAppointmentId: input.expectedVersion == null ? null : UUID_OTHER,
    }),
    requestRescreen: async () => ({ status: 'ok' as const, cycleNumber: 2 }),
    cancelAppointment: async () => ({ status: 'ok', appointmentId: UUID_A, version: 4 }),
    expireAppointments: async () => ({ status: 'ok' }),
    setHalt: async () => ({ status: 'ok', alreadyHalted: false }),
    clearHalt: async () => ({ status: 'ok', wasHalted: true }),
    backlog: async () => HEALTHY_BACKLOG,
  };
  const merged = { ...defaults, ...over } as PhoneStores;
  const store = new Proxy(merged, {
    get(target, prop: string) {
      const fn = (target as unknown as Record<string, unknown>)[prop];
      if (typeof fn !== 'function') return fn;
      return (input: unknown) => {
        calls.push({ op: prop, input });
        return (fn as (i: unknown) => unknown)(input);
      };
    },
  });
  return { store, calls };
}

/** `PHONE_SCREENING_ENABLED=true`, injected — never `process.env`. */
const ENABLED: NodeJS.ProcessEnv = { PHONE_SCREENING_ENABLED: 'true' };
/** The production default: absent, therefore off. */
const DISABLED: NodeJS.ProcessEnv = {};

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
  app.use(
    '/api/phone',
    createPhoneApiRouter({ configSource: ENABLED, now: () => NOW, ...deps }),
  );
  return app;
}

const RANGE = '?from=2026-08-24T00:00:00Z&to=2026-08-25T00:00:00Z';

let originalSink: ReturnType<typeof getAuditSink>;
let audited: AuditEntry[];

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore());
  originalSink = getAuditSink();
  audited = [];
  setAuditSink((entry) => {
    audited.push(entry);
  });
});

afterEach(() => {
  setAuditSink(originalSink);
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════
//  1. Authorization
// ════════════════════════════════════════════════════════════════════

describe('role scoping', () => {
  const READS: Array<[string, string]> = [
    ['get', `/api/phone/calendar${RANGE}`],
    ['get', '/api/phone/calendar/slots?date=2026-08-24'],
    ['get', `/api/phone/engagements/${UUID_E}`],
    ['get', '/api/phone/health'],
  ];
  const WRITES: Array<[string, string, unknown]> = [
    ['post', '/api/phone/appointments', {
      engagement_id: UUID_E,
      starts_at: '2026-08-24T04:00:00Z',
      ends_at: '2026-08-24T04:30:00Z',
    }],
    ['patch', `/api/phone/appointments/${UUID_A}`, {
      starts_at: '2026-08-24T04:00:00Z',
      ends_at: '2026-08-24T04:30:00Z',
      version: 3,
    }],
    ['delete', `/api/phone/appointments/${UUID_A}`, { reason: 'hr_cancelled', version: 3 }],
    ['post', '/api/phone/halt', { reason: 'operator_pause' }],
    ['post', '/api/phone/halt/clear', { reason: 'operator_pause' }],
  ];

  it('interviewers may read', async () => {
    for (const [, path] of READS) {
      const res = await request(appWith('interviewer', { readStore: fakeReadStore().store, stores: fakeStores().store })).get(path);
      expect(res.status, path).toBe(200);
    }
  });

  it('viewers may not read this surface at all', async () => {
    for (const [, path] of READS) {
      const res = await request(appWith('viewer')).get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.type).toBe('authorization_error');
    }
  });

  it('a request with no authenticated user is refused on every route', async () => {
    for (const [, path] of READS) {
      expect((await request(appWith(null)).get(path)).status, path).toBe(403);
    }
    for (const [method, path, body] of WRITES) {
      const res = await (request(appWith(null)) as never as Record<string, Function>)[method](path)
        .send(body);
      expect(res.status, path).toBe(403);
    }
  });

  it('interviewers may NOT write — every mutation is admin-only', async () => {
    const write = fakeStores();
    for (const [method, path, body] of WRITES) {
      const agent = request(appWith('interviewer', { stores: write.store, readStore: fakeReadStore().store }));
      const res = await (agent as never as Record<string, Function>)[method](path).send(body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // The gate runs BEFORE any delegation: nothing reached the substrate.
    expect(write.calls).toEqual([]);
  });

  it('admins may write', async () => {
    const read = fakeReadStore();
    const write = fakeStores();
    const app = appWith('admin', { stores: write.store, readStore: read.store });
    expect((await request(app).post('/api/phone/appointments').send({
      engagement_id: UUID_E,
      starts_at: '2026-08-24T04:00:00Z',
      ends_at: '2026-08-24T04:30:00Z',
    })).status).toBe(201);
    expect((await request(app).patch(`/api/phone/appointments/${UUID_A}`).send({
      starts_at: '2026-08-24T05:00:00Z',
      ends_at: '2026-08-24T05:30:00Z',
      version: 3,
    })).status).toBe(200);
    expect((await request(app).delete(`/api/phone/appointments/${UUID_A}`)
      .send({ reason: 'hr_cancelled', version: 3 })).status).toBe(200);
    expect((await request(app).post('/api/phone/halt').send({ reason: 'operator_pause' })).status)
      .toBe(200);
  });
});

describe('the real app enforces auth before the router is reached', () => {
  const ADMIN: AuthUser = {
    id: '77777777-7777-4777-8777-777777777777',
    email: 'admin@example.test',
    appRole: 'admin',
    active: true,
  } as unknown as AuthUser;
  const JWT = 'header.eyJhYWwiOiJhYWwyIn0.sig';

  it('answers 401 on every phone route without a bearer token', async () => {
    const app = createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });
    const paths: Array<[string, string]> = [
      ['get', `/api/phone/calendar${RANGE}`],
      ['get', '/api/phone/calendar/slots?date=2026-08-24'],
      ['get', `/api/phone/engagements/${UUID_E}`],
      ['get', '/api/phone/health'],
      ['post', '/api/phone/appointments'],
      ['patch', `/api/phone/appointments/${UUID_A}`],
      ['delete', `/api/phone/appointments/${UUID_A}`],
      ['post', '/api/phone/halt'],
      ['post', '/api/phone/halt/clear'],
    ];
    for (const [method, path] of paths) {
      const res = await (request(app) as never as Record<string, Function>)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    }
  });

  it('the viewer read-only guard rejects a viewer mutation before the role gate', async () => {
    const app = createApp({
      nodeEnv: 'test',
      webOrigin: 'http://localhost:5173',
      authDeps: {
        getUser: mockAuthGetUser({ ...ADMIN, appRole: 'viewer' } as AuthUser, JWT),
      },
      auditSinkOverride: async () => {},
    });
    const res = await request(app)
      .post('/api/phone/halt')
      .set('Authorization', `Bearer ${JWT}`)
      .send({ reason: 'operator_pause' });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });
});

// ════════════════════════════════════════════════════════════════════
//  2. Validation
// ════════════════════════════════════════════════════════════════════

describe('request validation is strict and UTC-only', () => {
  const app = () => appWith('admin', {
    readStore: fakeReadStore().store,
    stores: fakeStores().store,
  });

  it('refuses a calendar range that is not UTC ISO-8601', async () => {
    const bad = [
      'from=2026-08-24&to=2026-08-25',
      'from=2026-08-24T00:00:00%2B05:30&to=2026-08-25T00:00:00%2B05:30',
      'from=2026-08-24T00:00:00&to=2026-08-25T00:00:00',
      'from=2026-08-24 00:00:00Z&to=2026-08-25T00:00:00Z',
      'from=2026-02-30T00:00:00Z&to=2026-03-02T00:00:00Z',
    ];
    for (const q of bad) {
      const res = await request(app()).get(`/api/phone/calendar?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.type).toBe('validation_error');
    }
  });

  it('requires both bounds, in order, and no extra keys', async () => {
    const cases: Array<[string, string]> = [
      ['from=2026-08-24T00:00:00Z', 'missing to'],
      ['to=2026-08-25T00:00:00Z', 'missing from'],
      ['from=2026-08-25T00:00:00Z&to=2026-08-24T00:00:00Z', 'reversed'],
      ['from=2026-08-24T00:00:00Z&to=2026-08-24T00:00:00Z', 'empty range'],
      ['from=2026-08-24T00:00:00Z&to=2026-08-25T00:00:00Z&limit=5', 'extra key'],
    ];
    for (const [q, label] of cases) {
      expect((await request(app()).get(`/api/phone/calendar?${q}`)).status, label).toBe(400);
    }
  });

  it('caps the range at 31 days, inclusive of exactly 31', async () => {
    const ok = await request(app())
      .get('/api/phone/calendar?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z');
    expect(ok.status).toBe(200);
    const tooWide = await request(app())
      .get('/api/phone/calendar?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:01Z');
    expect(tooWide.status).toBe(400);
    expect(JSON.stringify(tooWide.body)).toContain('range_exceeds_max_days');
  });

  it('requires exactly one real IST date on the slots read', async () => {
    for (const q of ['', 'date=2026-8-24', 'date=2026-02-30', 'date=2026-08-24T00:00:00Z',
      'date=2026-08-24&date2=x']) {
      expect((await request(app()).get(`/api/phone/calendar/slots?${q}`)).status, q).toBe(400);
    }
    expect((await request(app()).get('/api/phone/calendar/slots?date=2026-08-24')).status).toBe(200);
  });

  it('refuses a non-uuid engagement or appointment id', async () => {
    expect((await request(app()).get('/api/phone/engagements/not-a-uuid')).status).toBe(400);
    expect((await request(app()).delete('/api/phone/appointments/nope')
      .send({ reason: 'hr_cancelled', version: 1 })).status).toBe(400);
  });

  it('rejects an unexpected body key on every mutation', async () => {
    const cases: Array<[string, string, unknown]> = [
      ['post', '/api/phone/appointments', {
        engagement_id: UUID_E,
        starts_at: '2026-08-24T04:00:00Z',
        ends_at: '2026-08-24T04:30:00Z',
        source: 'candidate_voice',
      }],
      ['patch', `/api/phone/appointments/${UUID_A}`, {
        starts_at: '2026-08-24T04:00:00Z',
        ends_at: '2026-08-24T04:30:00Z',
        version: 1,
        force: true,
      }],
      ['delete', `/api/phone/appointments/${UUID_A}`, {
        reason: 'hr_cancelled', version: 1, note: 'x',
      }],
      ['post', '/api/phone/halt', { reason: 'operator_pause', until: 'later' }],
      ['post', '/api/phone/halt/clear', { reason: 'operator_pause', why: 'x' }],
    ];
    for (const [method, path, body] of cases) {
      const res = await (request(app()) as never as Record<string, Function>)[method](path)
        .send(body);
      expect(res.status, `${method} ${path}`).toBe(400);
    }
  });

  it('requires a version on reschedule and on cancel', async () => {
    expect((await request(app()).patch(`/api/phone/appointments/${UUID_A}`).send({
      starts_at: '2026-08-24T04:00:00Z',
      ends_at: '2026-08-24T04:30:00Z',
    })).status).toBe(400);
    expect((await request(app()).delete(`/api/phone/appointments/${UUID_A}`)
      .send({ reason: 'hr_cancelled' })).status).toBe(400);
    for (const version of [0, -1, 1.5, '3', null]) {
      expect((await request(app()).delete(`/api/phone/appointments/${UUID_A}`)
        .send({ reason: 'hr_cancelled', version })).status, `version ${version}`).toBe(400);
    }
  });

  it('refuses a cancel reason only the substrate itself may write', async () => {
    for (const reason of ['superseded', 'system_deferral_expired']) {
      const res = await request(app()).delete(`/api/phone/appointments/${UUID_A}`)
        .send({ reason, version: 3 });
      expect(res.status, reason).toBe(400);
      expect(JSON.stringify(res.body)).toContain('reason_not_operator_initiated');
    }
    for (const reason of ['candidate_request', 'hr_cancelled', 'emergency_stop',
      'engagement_cancelled']) {
      expect((await request(app()).delete(`/api/phone/appointments/${UUID_A}`)
        .send({ reason, version: 3 })).status, reason).toBe(200);
    }
  });

  it('refuses a halt reason outside the 0042 vocabulary', async () => {
    for (const reason of ['because', 'OPERATOR_PAUSE', '', null]) {
      // Refused by the schema, so 400 stays exclusively a shape failure.
      expect((await request(app()).post('/api/phone/halt').send({ reason })).status).toBe(400);
    }
    // And a vocabulary DRIFT the schema could not have caught is a 409, not a
    // 400 — the payload was well formed and the substrate refused it.
    const drifted = fakeStores({ setHalt: async () => ({ status: 'invalid_reason' as never }) });
    const res = await request(appWith('admin', { stores: drifted.store }))
      .post('/api/phone/halt').send({ reason: 'operator_pause' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_reason');
  });
});

// ════════════════════════════════════════════════════════════════════
//  3. Projections
// ════════════════════════════════════════════════════════════════════

describe('the calendar projection', () => {
  it('joins candidate and engagement in THREE bounded queries, never N+1', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...APPOINTMENT,
      id: `${i}`,
      engagementId: `e${i}`,
    }));
    const engagements = many.map((a, i) => ({ ...ENGAGEMENT, id: a.engagementId, candidateId: `c${i}` }));
    const candidates = engagements.map((e) => ({ ...CANDIDATE, id: e.candidateId }));
    const read = fakeReadStore({
      listAppointmentsByStart: async () => many,
      listEngagementsByIds: async () => engagements,
      listCandidatesByIds: async () => candidates,
    });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get(`/api/phone/calendar${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(40);
    // Forty appointments, three queries. A per-row candidate lookup would make
    // this eighty-one.
    expect(read.calls).toEqual([
      'listAppointmentsByStart',
      'listEngagementsByIds',
      'listCandidatesByIds',
    ]);
  });

  it('reports truncation instead of silently dropping rows', async () => {
    const overflow = Array.from({ length: 201 }, (_, i) => ({ ...APPOINTMENT, id: `${i}` }));
    const read = fakeReadStore({ listAppointmentsByStart: async () => overflow });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get(`/api/phone/calendar${RANGE}`);
    expect(res.body.truncated).toBe(true);
    expect(res.body.count).toBe(200);
    expect(res.body.appointments).toHaveLength(200);
  });

  it('carries the reference, name, status, IST display and appointment source', async () => {
    const res = await request(appWith('interviewer', { readStore: fakeReadStore().store }))
      .get(`/api/phone/calendar${RANGE}`);
    const row = res.body.appointments[0];
    expect(row.candidate).toEqual({
      id: UUID_C,
      name: 'Priya Example',
      status: 'screening',
      reference: 'ATS-9001',
    });
    expect(row.ist_start).toBe('09:00');
    expect(row.ist_end).toBe('09:30');
    expect(row.source).toBe('hr_manual');
    expect(row.engagement_state).toBe('scheduled');
    expect(row.version).toBe(3);
    // Always null: nothing in 0042 writes it, and the field is reported rather
    // than dropped so the residual stays visible.
    expect(row.confirmed_at).toBeNull();
    expect(res.body.window).toEqual({
      time_zone: 'Asia/Kolkata',
      open_ist: '09:00:00',
      close_ist: '21:00:00',
      temporary_247_until_ist: '2026-09-06',
    });
  });

  it('reports a torn read as null rather than guessing a relationship', async () => {
    const read = fakeReadStore({ listEngagementsByIds: async () => [] });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get(`/api/phone/calendar${RANGE}`);
    expect(res.body.appointments[0].engagement_state).toBeNull();
    expect(res.body.appointments[0].candidate).toBeNull();
  });

  it('turns a read failure into a stable code, never a driver message', async () => {
    const read = fakeReadStore({
      listAppointmentsByStart: async () => {
        throw new Error('permission denied for relation phone_appointments');
      },
    });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get(`/api/phone/calendar${RANGE}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'phone_read_error' });
  });
});

describe('the engagement projection', () => {
  it('reports budgets against the mirrored 0042 ceilings', async () => {
    const res = await request(appWith('interviewer', { readStore: fakeReadStore().store }))
      .get(`/api/phone/engagements/${UUID_E}`);
    expect(res.status).toBe(200);
    expect(res.body.engagement.budgets).toEqual({
      no_answer: { used: 2, ceiling: 3, exhausted: false },
      reconnect: { used: 0, ceiling: 3, exhausted: false },
      provider_failure: { used: 5, ceiling: 5, exhausted: true },
    });
    // The provider-error residual made visible: five failures, and the next
    // legal instant is a whole IST day away.
    expect(res.body.engagement.next_eligible_at).toBe('2026-08-25T03:30:00.000Z');
    // WITH its IST date. The provider-error rule defers to the next legal
    // instant on the NEXT IST day, so a bare '09:00' would be ambiguous by
    // exactly one day on the one field that residual is about.
    expect(res.body.engagement.next_eligible_ist).toBe('2026-08-25 09:00');
  });

  it('shows attempt outcomes and nothing about the provider', async () => {
    const res = await request(appWith('interviewer', { readStore: fakeReadStore().store }))
      .get(`/api/phone/engagements/${UUID_E}`);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toEqual({
      id: ATTEMPT.id,
      attempt_seq: 1,
      epoch: 0,
      kind: 'initial',
      state: 'ended',
      outcome_class: 'no_answer',
      ist_date: '2026-08-23',
      prior_engagement_state: 'eligible',
      admitted_at: ATTEMPT.admittedAt,
      answered_at: null,
      classified_at: null,
      ended_at: ATTEMPT.endedAt,
    });
  });

  it('bounds the attempt list and says so', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...ATTEMPT, attemptSeq: i + 1 }));
    const read = fakeReadStore({ listAttemptsForEngagement: async () => many });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get(`/api/phone/engagements/${UUID_E}`);
    expect(res.body.attempts).toHaveLength(50);
    expect(res.body.attempts_truncated).toBe(true);
  });

  it('answers 404 for an unknown engagement', async () => {
    const read = fakeReadStore({ getEngagement: async () => null });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get(`/api/phone/engagements/${UUID_E}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('the slots projection', () => {
  it('returns the full IST day grid with the fleet cap and the booked total', async () => {
    const read = fakeReadStore({ listLiveAppointmentsByStart: async () => [APPOINTMENT] });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get('/api/phone/calendar/slots?date=2026-08-24');
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(47);
    expect(res.body.slot_seconds).toBe(1_800);
    expect(res.body.max_concurrent).toBe(PHONE_MAX_CONCURRENT);
    expect(res.body.booked_total).toBe(1);
    expect(res.body.slots[0]).toEqual({
      starts_at: '2026-08-23T18:30:00.000Z',
      ends_at: '2026-08-23T19:00:00.000Z',
      ist_start: '00:00',
      ist_end: '00:30',
      booked: 0,
      remaining: PHONE_MAX_CONCURRENT,
      bookable: false,
      refusals: ['slot_in_past'],
    });
    expect(res.body.slots[18]).toMatchObject({
      starts_at: '2026-08-24T03:30:00.000Z',
      ends_at: '2026-08-24T04:00:00.000Z',
      ist_start: '09:00',
      ist_end: '09:30',
      booked: 1,
      remaining: PHONE_MAX_CONCURRENT - 1,
    });
    // ONE query for the whole day.
    expect(read.calls).toEqual(['listLiveAppointmentsByStart']);
    expect(res.body.occupancy_truncated).toBe(false);
  });

  it('says so when the day held more bookings than it counted', async () => {
    // A silent truncation would under-count `booked` and therefore OVER-state
    // `remaining` — wrong in the unsafe direction. The flag turns the answer
    // into a stated lower bound.
    const overflow = Array.from({ length: 401 }, (_, i) => ({ ...APPOINTMENT, id: `${i}` }));
    const read = fakeReadStore({ listLiveAppointmentsByStart: async () => overflow });
    const res = await request(appWith('interviewer', { readStore: read.store }))
      .get('/api/phone/calendar/slots?date=2026-08-24');
    expect(res.body.occupancy_truncated).toBe(true);
    expect(res.body.booked_total).toBe(400);
    expect(res.body.slots[18].remaining).toBe(0);
    expect(res.body.slots[18].refusals).toEqual(['at_projected_capacity']);
  });
});

// ════════════════════════════════════════════════════════════════════
//  4. No PII on the wire
// ════════════════════════════════════════════════════════════════════

describe('nothing phone-bearing or provider-bearing is serialized', () => {
  const FORBIDDEN =
    /phone_e164|phone_raw|sip_call_id|room_name|participant_identity|egress|lease_token|lease_owner|provider_event_id|phone_sha256|transcript|bearer|@example\.test/i;

  it('holds on every read', async () => {
    const app = appWith('interviewer', {
      readStore: fakeReadStore().store,
      stores: fakeStores().store,
    });
    for (const path of [
      `/api/phone/calendar${RANGE}`,
      '/api/phone/calendar/slots?date=2026-08-24',
      `/api/phone/engagements/${UUID_E}`,
      '/api/phone/health',
    ]) {
      const res = await request(app).get(path);
      const body = JSON.stringify(res.body);
      expect(body, path).not.toMatch(FORBIDDEN);
      // A digit run of ten or more is what a subscriber number looks like.
      expect(body.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, ''), path)
        .not.toMatch(/\d{10,}/);
    }
  });

  it('holds in every audit record a mutation writes', async () => {
    const app = appWith('admin', {
      readStore: fakeReadStore().store,
      stores: fakeStores().store,
    });
    await request(app).post('/api/phone/appointments').send({
      engagement_id: UUID_E,
      starts_at: '2026-08-24T04:00:00Z',
      ends_at: '2026-08-24T04:30:00Z',
    });
    await request(app).delete(`/api/phone/appointments/${UUID_A}`)
      .send({ reason: 'hr_cancelled', version: 3 });
    await request(app).post('/api/phone/halt').send({ reason: 'operator_pause' });
    expect(audited.length).toBeGreaterThanOrEqual(3);
    for (const entry of audited) {
      const meta = JSON.stringify(entry.metadata ?? {});
      expect(meta).not.toMatch(FORBIDDEN);
      // No candidate identity of any kind: opaque ids, counts and stable
      // status strings only.
      expect(meta).not.toContain('Priya');
      expect(meta).not.toContain('ATS-9001');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  5. Delegation and the status matrix
// ════════════════════════════════════════════════════════════════════

describe('booking delegates to schedule_phone_appointment', () => {
  const body = {
    engagement_id: UUID_E,
    starts_at: '2026-08-24T04:00:00Z',
    ends_at: '2026-08-24T04:30:00Z',
  };

  it('always sends hr_manual, a null expected version and the injected instant', async () => {
    const write = fakeStores();
    await request(appWith('admin', { stores: write.store })).post('/api/phone/appointments')
      .send(body);
    expect(write.calls).toHaveLength(1);
    expect(write.calls[0].op).toBe('scheduleAppointment');
    const input = write.calls[0].input as Record<string, unknown>;
    expect(input.source).toBe('hr_manual');
    // A POST must never silently supersede a live appointment.
    expect(input.expectedVersion).toBeNull();
    expect(input.now).toEqual(NOW);
    expect(input.startsAt).toEqual(new Date('2026-08-24T04:00:00Z'));
  });

  it('reports ok_prereqs_pending as a success with a warning, not as ok', async () => {
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'ok_prereqs_pending',
        appointmentId: UUID_A,
        version: 1,
        engagementState: 'pending_prereqs',
        supersededAppointmentId: null,
      }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/appointments').send(body);
    expect(res.status).toBe(201);
    expect(res.body.prereqs_pending).toBe(true);
    expect(res.body.engagement_state).toBe('pending_prereqs');
  });

  it('maps every refusal onto a stable status', async () => {
    // Every refusal is a 409 carrying its own status as the error code, except
    // `not_found`. `slot_in_past` and `window_closed` are conflicts with the
    // state of the world, not malformed payloads — and keeping 400 exclusively
    // for shape validation is what lets a client tell the two apart.
    const cases: Array<[string, number]> = [
      ['not_found', 404],
      ['invalid_slot', 409],
      ['slot_duration_invalid', 409],
      ['slot_in_past', 409],
      ['window_closed', 409],
      ['slot_straddles_ist_midnight', 409],
      ['invalid_source', 409],
      ['appointment_exists', 409],
      ['attempt_in_flight', 409],
      ['engagement_terminal', 409],
      ['version_conflict', 409],
    ];
    for (const [status, expected] of cases) {
      const write = fakeStores({ scheduleAppointment: async () => ({ status: status as never }) });
      const res = await request(appWith('admin', { stores: write.store }))
        .post('/api/phone/appointments').send(body);
      expect(res.status, status).toBe(expected);
      expect(res.body.error, status).toBe(status === 'not_found' ? 'not_found' : status);
    }
  });

  it('treats unknown_status as "we do not know", never as a refusal', async () => {
    const write = fakeStores({
      scheduleAppointment: async () => ({ status: 'unknown_status' as never }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/appointments').send(body);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('phone_rpc_unknown_status');
  });

  it('sanitizes a thrown store error', async () => {
    const write = fakeStores({
      scheduleAppointment: async () => { throw new Error('phone_schedule_appointment_error'); },
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/appointments').send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'phone_action_error' });
  });
});

describe('rescheduling supersedes atomically through the same RPC', () => {
  const body = {
    starts_at: '2026-08-24T05:00:00Z',
    ends_at: '2026-08-24T05:30:00Z',
    version: 3,
  };

  it('resolves the engagement from the path id and forwards the expected version', async () => {
    const read = fakeReadStore();
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'ok',
        appointmentId: UUID_OTHER,
        version: 1,
        engagementState: 'scheduled',
        supersededAppointmentId: UUID_A,
      }),
    });
    const res = await request(appWith('admin', { readStore: read.store, stores: write.store }))
      .patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(200);
    const input = write.calls[0].input as Record<string, unknown>;
    expect(input.engagementId).toBe(UUID_E);
    expect(input.expectedVersion).toBe(3);
    expect(input.source).toBe('hr_manual');
    // There is no cancel-then-book here: exactly one RPC call, so there is no
    // window in which the candidate has no slot at all.
    expect(write.calls.map((c) => c.op)).toEqual(['scheduleAppointment']);
    expect(res.body.appointment_id).toBe(UUID_OTHER);
    expect(res.body.superseded_appointment_id).toBe(UUID_A);
  });

  it('returns the id the RPC actually superseded, not the one on the path', async () => {
    // If a concurrent write changed which appointment was live, the RPC is the
    // authority. Echoing the path id back would assert something we did not do.
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'ok',
        appointmentId: UUID_OTHER,
        version: 1,
        engagementState: 'scheduled',
        supersededAppointmentId: '99999999-9999-4999-8999-999999999999',
      }),
    });
    const res = await request(appWith('admin', {
      readStore: fakeReadStore().store, stores: write.store,
    })).patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.body.superseded_appointment_id).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('refuses a reschedule that superseded NOTHING — the lost update 0042 misses', async () => {
    // `schedule_phone_appointment` compares p_expected_version ONLY when it
    // finds a live appointment; when it finds none it skips the comparison and
    // INSERTS. So if the addressed row is cancelled between the pre-read and
    // the RPC, a reschedule silently becomes a create and resurrects a slot
    // another admin just cancelled. A reschedule always sends a non-null
    // expected version, so "superseded nothing" is exactly that case.
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'ok',
        appointmentId: UUID_OTHER,
        version: 1,
        engagementState: 'scheduled',
        supersededAppointmentId: null,
      }),
    });
    const res = await request(appWith('admin', {
      readStore: fakeReadStore().store, stores: write.store,
    })).patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(409);
    // NARROWER than `rolled_back`, deliberately: the appointment is cancelled
    // but the engagement's state and pacing stamp are not restored, and nothing
    // in 0042 can put them back.
    expect(res.body).toEqual({
      ok: false, error: 'version_conflict', appointment_rolled_back: true,
    });
    expect(res.body.rolled_back).toBeUndefined();
    // The insert is undone, addressed by the id the RPC actually created and
    // fenced on the version it actually returned.
    expect(write.calls.map((c) => c.op)).toEqual(['scheduleAppointment', 'cancelAppointment']);
    const undo = write.calls[1].input as Record<string, unknown>;
    expect(undo.appointmentId).toBe(UUID_OTHER);
    expect(undo.expectedVersion).toBe(1);
    expect(undo.reason).toBe('hr_cancelled');
    // Attributable to the admin who caused it, not stamped `system`.
    expect(undo.actorId).toBe('66666666-6666-4666-8666-666666666666');
    // AUDITED. This is the only path on the surface that mutates twice, so it
    // is the last one that should leave no trace.
    expect(audited).toHaveLength(1);
    expect(audited[0].statusCode).toBe(409);
    expect(audited[0].metadata).toMatchObject({
      resource: 'phone_appointment',
      outcome: 'lost_update_undone',
      appointment_rolled_back: true,
    });
  });

  it('undoes NOTHING when the superseded key is ABSENT rather than null', async () => {
    // Absent means 0042 renamed or dropped the key — a contract break, not a
    // lost update. Treating the two alike would cancel the freshly created
    // appointment on EVERY legitimate reschedule.
    const write = fakeStores({
      scheduleAppointment: async () => ({ status: 'ok', appointmentId: UUID_OTHER, version: 1 }),
    });
    const res = await request(appWith('admin', {
      readStore: fakeReadStore().store, stores: write.store,
    })).patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'phone_rpc_unknown_status' });
    expect(write.calls.map((c) => c.op)).toEqual(['scheduleAppointment']);
  });

  it('refuses to cancel unfenced when the RPC returned no version', async () => {
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'ok', appointmentId: UUID_OTHER, supersededAppointmentId: null,
      }),
    });
    const res = await request(appWith('admin', {
      readStore: fakeReadStore().store, stores: write.store,
    })).patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(409);
    // A null expected version is the "cancel regardless" this surface refuses
    // everywhere else; it is not safer here.
    expect(res.body.appointment_rolled_back).toBe(false);
    expect(write.calls.map((c) => c.op)).toEqual(['scheduleAppointment']);
  });

  it('says so when the compensating cancel itself fails', async () => {
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'ok', appointmentId: UUID_OTHER, version: 1, supersededAppointmentId: null,
      }),
      cancelAppointment: async () => { throw new Error('phone_cancel_appointment_error'); },
    });
    const res = await request(appWith('admin', {
      readStore: fakeReadStore().store, stores: write.store,
    })).patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(409);
    // A stray live appointment now exists; the operator is told rather than
    // left to find it on the calendar.
    expect(res.body.appointment_rolled_back).toBe(false);
  });

  it('refuses to reschedule an appointment that is no longer live', async () => {
    for (const status of ['cancelled', 'superseded', 'fulfilled', 'missed'] as const) {
      const read = fakeReadStore({ getAppointment: async () => ({ ...APPOINTMENT, status }) });
      const write = fakeStores();
      const res = await request(appWith('admin', { readStore: read.store, stores: write.store }))
        .patch(`/api/phone/appointments/${UUID_A}`).send(body);
      expect(res.status, status).toBe(409);
      expect(res.body.error).toBe('not_live');
      // Refused BEFORE delegation, so no other engagement's live slot could be
      // superseded by a request aimed at a dead row.
      expect(write.calls).toEqual([]);
    }
  });

  it('404s an unknown appointment id without delegating', async () => {
    const read = fakeReadStore({ getAppointment: async () => null });
    const write = fakeStores();
    const res = await request(appWith('admin', { readStore: read.store, stores: write.store }))
      .patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(404);
    expect(write.calls).toEqual([]);
  });

  it('surfaces a stale version as version_conflict', async () => {
    const write = fakeStores({
      scheduleAppointment: async () => ({
        status: 'version_conflict', appointmentId: UUID_A, version: 7,
      }),
    });
    const res = await request(appWith('admin', {
      readStore: fakeReadStore().store, stores: write.store,
    })).patch(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('version_conflict');
  });
});

describe('cancelling', () => {
  const body = { reason: 'hr_cancelled', version: 3 };

  it('forwards the required version — never a null the RPC would treat as force', async () => {
    const write = fakeStores();
    await request(appWith('admin', { stores: write.store }))
      .delete(`/api/phone/appointments/${UUID_A}`).send(body);
    const input = write.calls[0].input as Record<string, unknown>;
    expect(input.expectedVersion).toBe(3);
    expect(input.reason).toBe('hr_cancelled');
    expect(input.appointmentId).toBe(UUID_A);
  });

  it('treats already_cancelled as idempotent success, not as a conflict', async () => {
    const write = fakeStores({
      cancelAppointment: async () => ({
        status: 'already_cancelled', appointmentId: UUID_A, version: 4,
      }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .delete(`/api/phone/appointments/${UUID_A}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.already_cancelled).toBe(true);
  });

  it('maps the remaining refusals', async () => {
    const cases: Array<[string, number]> = [
      ['not_found', 404],
      ['invalid_reason', 409],
      ['not_live', 409],
      ['version_conflict', 409],
      ['unknown_status', 500],
    ];
    for (const [status, expected] of cases) {
      const write = fakeStores({ cancelAppointment: async () => ({ status: status as never }) });
      const res = await request(appWith('admin', { stores: write.store }))
        .delete(`/api/phone/appointments/${UUID_A}`).send(body);
      expect(res.status, status).toBe(expected);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  6. Health
// ════════════════════════════════════════════════════════════════════

/**
 * A registered runtime handle, hand-built.
 *
 * The view is read through `scheduler.health()`, `snapshot()` and
 * `loopIntervalsMs`; nothing else on the handle is consulted, so the rest is
 * stubbed to throw. A fake that silently answered every call would be kinder
 * than production and would hide a reader we did not intend.
 */
function fakeRuntime(over: {
  running?: boolean;
  lastTickAt?: string | null;
  snapshot?: Partial<PhoneRuntimeSnapshot>;
  /**
   * Extra fields welded onto the loop-health record the scheduler reports.
   *
   * `phoneRuntimeView` projects each loop through an EXPLICIT field list; this
   * seam exists so a test can put a value there that the list does not name
   * and prove it does not reach the response. A future edit that adds a
   * debugging field to `SchedulerLoopHealth` is exactly the change this
   * guards, so the fixture has to be able to model one.
   */
  loopExtra?: Record<string, unknown>;
} = {}): PhoneRuntimeHandle {
  const explode = () => { throw new Error('unexpected_runtime_call'); };
  return {
    config: { due_ms: 15_000, reclaim_ms: 30_000 },
    scheduler: {
      running: over.running ?? false,
      health: () => ({
        running: over.running ?? false,
        loops: [{
          name: 'phone-due',
          running: over.running ?? false,
          lastTickAt: over.lastTickAt === undefined ? null : over.lastTickAt,
          ticks: 4,
          errors: 0,
          consecutiveErrors: 0,
          ...over.loopExtra,
        }],
      }),
      start: explode,
      stop: explode,
    } as unknown as PhoneRuntimeHandle['scheduler'],
    runner: explode as unknown as PhoneRuntimeHandle['runner'],
    queue: explode as unknown as PhoneRuntimeHandle['queue'],
    loopIntervalsMs: { 'phone-due': 15_000 },
    snapshot: () => ({
      lastDue: null,
      dialJobOutcomes: {},
      lastReclaimed: null,
      lastExpired: null,
      lastReconciled: null,
      lastRolled: null,
      lastStranded: null,
      lastRecStranded: null,
      // No sweep has answered non-`ok`. Empty rather than absent: the view
      // reads this map, and a fake that omitted it would be a fake the real
      // runtime can never produce.
      sweepNotOk: {},
      ...over.snapshot,
    }),
    tickAll: explode,
    stop: explode,
  };
}

/**
 * RUNNING, but its one loop last ticked far longer ago than its own stale
 * window (interval 15s, so the window is the 30s floor).
 *
 * Running is not incidental. `isLoopStale` returns false for a stopped loop
 * BY DESIGN — a loop that is not running is stopped, not stale, and reporting
 * both would be two reasons for one fact. So a stale loop can only be
 * exhibited on a running scheduler.
 */
function runningRuntimeWithStaleLoop(): PhoneRuntimeHandle {
  return fakeRuntime({
    running: true,
    lastTickAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
  });
}

/**
 * Values that must never reach an operator's screen. They are not decoration:
 * each is placed BELOW the health surface, in a field a real leak would use,
 * and the test that names them fails if the surface starts copying it.
 */
const LEASE_TOKEN_SENTINEL = 'lease-token-sentinel';
const SIP_TRUNK_SENTINEL = 'sip-trunk-sentinel';

/**
 * Running and healthy, carrying a due summary with codes in it — and, welded
 * onto the SAME objects, four values the view is required to drop.
 *
 * The point of the cast: `PhoneDueResult` does not declare these fields today,
 * so a fixture cannot carry them without one. That is precisely the leak being
 * guarded. `phoneRuntimeView` re-projects the due summary through an explicit
 * six-field list rather than spreading the snapshot, and it projects each loop
 * through a seven-field list rather than spreading the loop health. Both lists
 * are the only thing standing between "someone adds an engagement id to the
 * due result for debugging" and that id appearing in `GET /api/phone/health`.
 * The fixture models that future field; the assertions below prove the lists
 * still hold.
 *
 * NOT covered here, deliberately: an identifier used as a SKIP or REFUSAL
 * KEY. The view copies those maps verbatim by design (they are stable codes),
 * so no view-level fixture can catch it — that property is proved by
 * `phone-runtime-loops.test.ts`'s `NO IDENTIFIER LEAKS`, which drives real
 * sentinel rows through a real due pass and searches the whole serialized view.
 */
function runtimeWithDueSummary(): PhoneRuntimeHandle {
  return fakeRuntime({
    running: true,
    lastTickAt: NOW.toISOString(),
    snapshot: {
      lastDue: {
        status: 'ok',
        examined: 4,
        offered: 2,
        dialing: 1,
        skipped: { no_dialable_number: 1, appointment_not_due: 1 },
        refusals: { outside_window: 1 },
        // ── Not part of the shape. Present anyway. ──────────────────────
        engagementId: UUID_E,
        candidateId: UUID_C,
        attemptId: UUID_A,
        leaseToken: LEASE_TOKEN_SENTINEL,
      } as unknown as PhoneRuntimeSnapshot['lastDue'],
    },
    // The provider payload a loop would be holding if anyone ever put one on
    // the scheduler's health record.
    loopExtra: { sipTrunk: SIP_TRUNK_SENTINEL, lastEngagementId: UUID_E },
  });
}

describe('the health surface', () => {
  it('reports ok with split ingress counts when everything is nominal', async () => {
    const res = await request(appWith('interviewer', { stores: fakeStores().store }))
      .get('/api/phone/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.reasons).toEqual([]);
    // The five ingress verdicts stay SEPARATE: a stale epoch is fencing working
    // as designed, an unknown attempt is an ingress talking about a call we
    // have no record of. Collapsing them would hide opposite signals.
    expect(res.body.ingress).toEqual({
      ignored_last_24h: 7,
      unknown_attempt_last_24h: 2,
      stale_epoch_last_24h: 3,
      terminal_last_24h: 1,
      unexpected_event_last_24h: 1,
    });
    expect(res.body.concurrency).toEqual({
      live: 2,
      live_with_unexpired_lease: 2,
      max_concurrent: PHONE_MAX_CONCURRENT,
      oldest_live_age_seconds: 12,
    });
    expect(res.body.window.open_now).toBe(true);
    expect(res.body.window.ist_date).toBe('2026-08-24');
    expect(res.body.engagements_by_state).toEqual({ eligible: 3, scheduled: 1 });
  });

  it('degrades with nulls — never a healthy zero — when the backlog is unreadable', async () => {
    for (const stores of [
      fakeStores({ backlog: async () => { throw new Error('phone_backlog_error'); } }),
      fakeStores({ backlog: async () => ({ status: 'unknown_status' as never }) }),
    ]) {
      const res = await request(appWith('interviewer', { stores: stores.store }))
        .get('/api/phone/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.reasons).toEqual(['backlog_unavailable']);
      expect(res.body.backlog_unavailable).toBe(true);
      // "We could not read it" and "there is none" are different answers, and
      // only one of them means everything is fine.
      expect(res.body.admission).toBeNull();
      expect(res.body.concurrency).toBeNull();
      expect(res.body.appointments).toBeNull();
      expect(res.body.ingress).toBeNull();
      expect(res.body.engagements_by_state).toBeNull();
    }
  });

  it('degrades when the state histogram is absent, rather than reporting an empty one', () => {
    // `engagementsByState` is optional on PhoneBacklogResult. Rendering an
    // absent map as {} would say "no engagements in any state" — the exact
    // healthy zero every sibling block refuses to emit.
    const { engagementsByState, ...withoutHistogram } = HEALTHY_BACKLOG;
    expect(engagementsByState).toBeDefined();
    const stores = fakeStores({ backlog: async () => withoutHistogram as never });
    return request(appWith('interviewer', { stores: stores.store }))
      .get('/api/phone/health')
      .then((res) => {
        expect(res.body.status).toBe('degraded');
        expect(res.body.reasons).toEqual(['backlog_unavailable']);
        expect(res.body.engagements_by_state).toBeNull();
      });
  });

  it('reports a MISSING control singleton as halted and unreadable', async () => {
    const stores = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: false, halted: true, haltReason: 'halt_unreadable' },
      }),
    });
    const res = await request(appWith('interviewer', { stores: stores.store }))
      .get('/api/phone/health');
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toEqual(['halt_unreadable', 'admission_halted']);
    expect(res.body.admission.halted).toBe(true);
  });

  it('raises the operational reasons the counts imply', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ admission: { controlPresent: true, halted: true, haltReason: 'cost_control' } },
        'admission_halted'],
      [{ attempts: { ...HEALTHY_BACKLOG.attempts, live: 5, liveWithUnexpiredLease: 2 } },
        'attempt_leases_expired'],
      [{ attempts: { ...HEALTHY_BACKLOG.attempts, live: 10, liveWithUnexpiredLease: 10 } },
        'fleet_at_capacity'],
      [{ appointments: { live: 4, overdue: 2 } }, 'appointments_overdue'],
    ];
    for (const [patch, reason] of cases) {
      const stores = fakeStores({ backlog: async () => ({ ...HEALTHY_BACKLOG, ...patch }) });
      const res = await request(appWith('interviewer', { stores: stores.store }))
        .get('/api/phone/health');
      expect(res.body.reasons, reason).toContain(reason);
      expect(res.body.status).toBe('degraded');
    }
  });

  it('answers rather than hanging if the handler itself throws', async () => {
    // Express 4 does not catch a rejected promise from an async handler — an
    // unguarded throw would leave the request open until the client gave up.
    const exploding = new Proxy({} as NodeJS.ProcessEnv, {
      get() { throw new Error('config source unavailable'); },
    });
    const res = await request(appWith('interviewer', {
      stores: fakeStores().store,
      configSource: exploding,
    })).get('/api/phone/health');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'phone_read_error' });
  });

  it('always publishes the four P1 residuals', async () => {
    const res = await request(appWith('interviewer', { stores: fakeStores().store }))
      .get('/api/phone/health');
    const codes = res.body.residuals.map((r: { code: string }) => r.code);
    expect(codes).toEqual([
      'appointment_confirmed_has_no_writer',
      'appointment_fulfilled_written_by_admission',
      'appointment_missed_written_by_expiry_sweep',
      'provider_error_costs_one_ist_day',
    ]);
    expect(res.body.residuals[0].writer).toBeNull();
  });

  it('reports the configuration as booleans and counts, never as secrets', async () => {
    const res = await request(appWith('interviewer', { stores: fakeStores().store }))
      .get('/api/phone/health');
    expect(res.body.config).toEqual({
      screeningEnabled: true,
      runtimeEnabled: false,
      runtimeActive: false,
      dialMode: 'off',
      dialAllowlistSize: 0,
      liveDialPermitted: false,
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  The P5 runtime block
  //
  //  The block is PROCESS-LOCAL: it answers for the loops in THIS api
  //  process and makes no claim about any other replica. That is why the
  //  unregistered shape below is `enabled: false` with NO reason code — a
  //  process that is not running the loops is the shipped default, not a
  //  fault, and a surface that degraded on it would be permanently amber
  //  on every machine in the fleet.
  // ──────────────────────────────────────────────────────────────────

  describe('the runtime block', () => {
    afterEach(() => {
      // Registration is module-global. Left behind, it would leak into every
      // later test in this file and make their assertions depend on order.
      clearPhoneRuntimeRegistration();
    });

    it('is present on ALL THREE health branches, not only the healthy one', async () => {
      // An operator needs to know whether the loops are turning precisely
      // when something else is wrong, so the block cannot be a property of
      // the happy path alone.
      const branches: Array<[string, PhoneApiDeps]> = [
        ['healthy', { stores: fakeStores().store }],
        ['backlog unreadable', {
          stores: fakeStores({ backlog: async () => { throw new Error('phone_backlog_error'); } }).store,
        }],
        ['screening disabled', { stores: fakeStores().store, configSource: DISABLED }],
      ];
      for (const [label, deps] of branches) {
        const res = await request(appWith('interviewer', deps)).get('/api/phone/health');
        expect(res.status, label).toBe(200);
        expect(res.body.runtime, label).toEqual({
          enabled: false,
          running: false,
          loops: [],
          last_due: null,
          config: {},
          dial_jobs: {},
          // No sweep has run in a process with no runtime, so none has failed.
          sweeps_not_ok: [],
          last_reclaimed: null,
          last_expired: null,
          last_reconciled: null,
          last_rolled: null,
          last_stranded: null,
          last_rec_stranded: null,
          // FALSE, not absent. A process that was deliberately not armed and
          // one whose arming THREW both report `enabled: false`; this boolean
          // is the only thing that separates them, so it must be present on
          // the disabled branch or it separates nothing.
          start_failed: false,
        });
      }
    });

    it('does not degrade the surface merely because this process runs no loops', async () => {
      const res = await request(appWith('interviewer', { stores: fakeStores().store }))
        .get('/api/phone/health');
      expect(res.body.status).toBe('ok');
      expect(res.body.reasons).toEqual([]);
    });

    it('appends runtime reasons WITHOUT displacing the backlog reasons', async () => {
      // Ordering matters: the backlog reasons are the pre-existing contract
      // and keep their positions. A stale loop is ADDITIVE — a healthy
      // backlog with nothing turning is exactly the silent-stall case, so it
      // must degrade even though every count is nominal.
      registerPhoneRuntime(runningRuntimeWithStaleLoop());
      const res = await request(appWith('interviewer', { stores: fakeStores().store }))
        .get('/api/phone/health');
      expect(res.body.status).toBe('degraded');
      expect(res.body.reasons).toEqual(['phone_loop_stale']);
      expect(res.body.runtime.enabled).toBe(true);
    });

    it('CONTROL: the same registration on a halted backlog keeps BOTH reason families', async () => {
      // Without this control the previous test would still pass if runtime
      // reasons REPLACED the backlog reasons rather than appending to them.
      registerPhoneRuntime(runningRuntimeWithStaleLoop());
      const stores = fakeStores({
        backlog: async () => ({
          ...HEALTHY_BACKLOG,
          admission: { controlPresent: true, halted: true, haltReason: 'operator' },
        }),
      });
      const res = await request(appWith('interviewer', { stores: stores.store }))
        .get('/api/phone/health');
      expect(res.body.reasons).toEqual([
        'admission_halted',
        'phone_loop_stale',
      ]);
    });

    it('reports a stopped runtime as stopped, and NOT also as stale', async () => {
      // Two reasons for one fact would be noise. `isLoopStale` fails to false
      // for a stopped loop precisely so a halted process reports one cause.
      registerPhoneRuntime(fakeRuntime({
        running: false,
        lastTickAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      }));
      const res = await request(appWith('interviewer', { stores: fakeStores().store }))
        .get('/api/phone/health');
      expect(res.body.reasons).toEqual(['phone_runtime_stopped']);
    });

    it("a sweep that did not run reports null and 'phone_sweep_not_ok' — not a quiet 0", async () => {
      // The whole point of the distinction. `last_expired: 0` means the sweep
      // RAN and found nothing; `last_reclaimed: null` with `reclaim` named in
      // `sweeps_not_ok` means it did not run at all. Before the split these
      // were the same number, and a reclaim sweep that had silently stopped
      // reported `status: ok` with `last_reclaimed: 0` while expired attempt
      // leases piled up holding fleet slots.
      registerPhoneRuntime(fakeRuntime({
        running: true,
        lastTickAt: NOW.toISOString(),
        snapshot: {
          lastReclaimed: null,
          lastExpired: 0,
          sweepNotOk: { reclaim: true, expire: false },
        },
      }));
      const res = await request(appWith('interviewer', { stores: fakeStores().store }))
        .get('/api/phone/health');

      expect(res.status).toBe(200);
      // `toBeNull`, never `toBeFalsy` — `0` is falsy and `0` is precisely the
      // value this repair exists to stop meaning "did not run".
      expect(res.body.runtime.last_reclaimed).toBeNull();
      expect(res.body.runtime.last_expired).toBe(0);
      // Only the sweep that failed is named, and it is named by CODE.
      expect(res.body.runtime.sweeps_not_ok).toEqual(['reclaim']);
      expect(res.body.reasons).toContain('phone_sweep_not_ok');
      expect(res.body.status).toBe('degraded');
    });

    it('drops identifiers and provider payload carried on the objects it projects', async () => {
      // The runtime registered here CARRIES all five secrets, on the two
      // objects the view reads: the due summary and the loop health record.
      // The view must re-project both through its field lists and drop the
      // rest — if it ever spreads either object instead, every assertion in
      // this test goes red at once.
      registerPhoneRuntime(runtimeWithDueSummary());
      const res = await request(appWith('interviewer', { stores: fakeStores().store }))
        .get('/api/phone/health');

      // Non-vacuity: the secrets really are below the surface. Without this,
      // a fixture that quietly stopped carrying them would leave the sweep
      // below asserting nothing at all — which is the defect this test had.
      const beneath = JSON.stringify(runtimeWithDueSummary().snapshot())
        + JSON.stringify(runtimeWithDueSummary().scheduler.health());
      for (const secret of [UUID_A, UUID_E, UUID_C, LEASE_TOKEN_SENTINEL, SIP_TRUNK_SENTINEL]) {
        expect(beneath, `fixture must carry ${secret}`).toContain(secret);
      }

      const serialized = JSON.stringify(res.body.runtime);
      for (const secret of [UUID_A, UUID_E, UUID_C, LEASE_TOKEN_SENTINEL, SIP_TRUNK_SENTINEL]) {
        expect(serialized, secret).not.toContain(secret);
      }

      // The whitelists themselves, stated positively. `toEqual` is exact, so
      // an extra field survives as a failure rather than as silence.
      expect(res.body.runtime.last_due).toEqual({
        status: 'ok',
        examined: 4,
        offered: 2,
        dialing: 1,
        skipped: { no_dialable_number: 1, appointment_not_due: 1 },
        refusals: { outside_window: 1 },
      });
      expect(Object.keys(res.body.runtime.loops[0]).sort()).toEqual([
        'consecutiveErrors', 'errors', 'lastTickAt', 'name', 'running', 'stale', 'ticks',
      ]);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
//  7. The kill switch, and audit fail-closed
// ════════════════════════════════════════════════════════════════════

describe('halt', () => {
  it('delegates to set_phone_halt and reports whether it was already in force', async () => {
    const write = fakeStores({ setHalt: async () => ({ status: 'ok', alreadyHalted: true }) });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt').send({ reason: 'provider_incident' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, halted: true, already_halted: true, reason: 'provider_incident',
    });
    expect((write.calls[0].input as Record<string, unknown>).reason).toBe('provider_incident');
  });

  it('NEVER lifts the halt when the audit write fails — the stop stands', async () => {
    // Undoing a raised kill switch means resuming the dialer. Compensating here
    // would fail OPEN on the one control whose purpose is to stop billable
    // calls to real candidates, on the strength of OUR sink outage — which is
    // plausibly the same outage the operator halted for. And it is not needed:
    // 0042's set_phone_halt writes its own audit_events row inside the same
    // transaction, so the halt is durably audited either way.
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    for (const alreadyHalted of [false, true, undefined]) {
      const write = fakeStores({
        setHalt: async () => ({
          status: 'ok',
          ...(alreadyHalted === undefined ? {} : { alreadyHalted }),
        }),
      });
      const res = await request(appWith('admin', { stores: write.store }))
        .post('/api/phone/halt').send({ reason: 'operator_pause' });
      expect(res.status, `alreadyHalted ${alreadyHalted}`).toBe(500);
      expect(res.body).toEqual({
        ok: false, error: 'phone_audit_write_failed', rolled_back: false,
      });
      // The decisive assertion: no clearHalt, ever.
      expect(write.calls.map((c) => c.op)).toEqual(['setHalt']);
    }
  });

  it('a concurrent second halt is never lifted by the first admin rolling back', async () => {
    // Admin A halts, admin B halts a moment later and is told the dialer is
    // stopped, then A's audit fails. A rollback would lift the halt B is
    // relying on. There is no rollback, so it cannot happen.
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    const write = fakeStores({ setHalt: async () => ({ status: 'ok', alreadyHalted: false }) });
    await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt').send({ reason: 'provider_incident' });
    expect(write.calls.every((c) => c.op !== 'clearHalt')).toBe(true);
  });
});

describe('halt/clear', () => {
  it('requires the reason to name the halt currently in force', async () => {
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'legal_hold' },
      }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'cost_control' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('halt_reason_mismatch');
    // Refused before delegation.
    expect(write.calls.map((c) => c.op)).toEqual(['backlog']);
    // AUDITED. Five reasons and a distinguishing refusal means brute force
    // costs five requests — what the interlock actually buys is that every
    // attempt leaves a trail. And the row must NOT hand the answer to whoever
    // reads the log later.
    expect(audited).toHaveLength(1);
    expect(audited[0].statusCode).toBe(409);
    expect(audited[0].metadata).toEqual({
      resource: 'phone_control',
      action: 'halt_clear_refused',
      outcome: 'halt_reason_mismatch',
    });
    expect(JSON.stringify(audited[0].metadata)).not.toContain('legal_hold');
  });

  it('a refused clear that cannot be audited is a 500, not a silent 409', async () => {
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'legal_hold' },
      }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'cost_control' });
    expect(res.status).toBe(500);
    // Nothing happened, so there is nothing to roll back.
    expect(res.body).toEqual({
      ok: false, error: 'phone_audit_write_failed', rolled_back: false,
    });
    expect(write.calls.map((c) => c.op)).toEqual(['backlog']);
  });

  it('clears when the reason matches', async () => {
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'legal_hold' },
      }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'legal_hold' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, halted: false, was_halted: true, previous_reason: 'legal_hold',
    });
    expect(write.calls.map((c) => c.op)).toEqual(['backlog', 'clearHalt']);
  });

  it('refuses to lift a halt it cannot describe', async () => {
    const unreadable = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: false, halted: true, haltReason: 'halt_unreadable' },
      }),
    });
    const res = await request(appWith('admin', { stores: unreadable.store }))
      .post('/api/phone/halt/clear').send({ reason: 'operator_pause' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('halt_unreadable');
    expect(unreadable.calls.map((c) => c.op)).toEqual(['backlog']);

    const blind = fakeStores({ backlog: async () => { throw new Error('phone_backlog_error'); } });
    const res2 = await request(appWith('admin', { stores: blind.store }))
      .post('/api/phone/halt/clear').send({ reason: 'operator_pause' });
    expect(res2.status).toBe(500);
  });

  it('re-halts with the verified reason when the audit write fails', async () => {
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'emergency_stop' },
      }),
      clearHalt: async () => ({ status: 'ok', wasHalted: true }),
    });
    let seen = 0;
    setAuditSink(() => {
      seen += 1;
      throw new Error('audit db insert failed');
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'emergency_stop' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'phone_audit_write_failed', rolled_back: true });
    expect(seen).toBe(1);
    expect(write.calls.map((c) => c.op)).toEqual(['backlog', 'clearHalt', 'setHalt']);
    // Restored with the reason that was VERIFIED against the control row, not
    // one this route guessed.
    expect((write.calls[2].input as Record<string, unknown>).reason).toBe('emergency_stop');
  });

  it('refuses to clear when the control read itself fails', async () => {
    // The backlog RPC answered, but not with `ok`. That is not "nothing is
    // halted" — it is "we do not know", and lifting a kill switch on a guess is
    // the one thing this route must never do.
    const write = fakeStores({ backlog: async () => ({ status: 'unknown_status' as never }) });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'operator_pause' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('halt_state_unavailable');
    expect(write.calls.map((c) => c.op)).toEqual(['backlog']);
  });

  it('surfaces a halt_unreadable from the RPC itself as a 503', async () => {
    // The singleton can vanish between the pre-read and the clear. 0042
    // refuses to invent a cleared row and neither does this route.
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'cost_control' },
      }),
      clearHalt: async () => ({ status: 'halt_unreadable' }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'cost_control' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('halt_unreadable');
    expect(audited).toEqual([]);
  });

  it('treats an unrecognised clear answer as "we do not know"', async () => {
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'cost_control' },
      }),
      clearHalt: async () => ({ status: 'unknown_status' as never }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'cost_control' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('phone_rpc_unknown_status');
  });

  it('falls back to the control row it already read when was_halted is absent', async () => {
    // A missing field must not skip the compensating re-halt and leave the
    // dialer running unaudited. The pre-read is a real fact, not a guess.
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: true, haltReason: 'legal_hold' },
      }),
      clearHalt: async () => ({ status: 'ok' }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'legal_hold' });
    expect(res.status).toBe(500);
    expect(res.body.rolled_back).toBe(true);
    expect(write.calls.map((c) => c.op)).toEqual(['backlog', 'clearHalt', 'setHalt']);
    expect((write.calls[2].input as Record<string, unknown>).reason).toBe('legal_hold');
  });

  it('does not re-halt when the clear was already a no-op', async () => {
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    const write = fakeStores({
      backlog: async () => ({
        ...HEALTHY_BACKLOG,
        admission: { controlPresent: true, halted: false, haltReason: null },
      }),
      clearHalt: async () => ({ status: 'ok', wasHalted: false }),
    });
    const res = await request(appWith('admin', { stores: write.store }))
      .post('/api/phone/halt/clear').send({ reason: 'operator_pause' });
    expect(res.status).toBe(500);
    expect(res.body.rolled_back).toBe(false);
    expect(write.calls.map((c) => c.op)).toEqual(['backlog', 'clearHalt']);
  });
});

describe('audit is fail-closed on every appointment mutation', () => {
  it('returns 500 without claiming a rollback the substrate cannot give', async () => {
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    const app = appWith('admin', {
      readStore: fakeReadStore().store,
      stores: fakeStores().store,
    });
    const create = await request(app).post('/api/phone/appointments').send({
      engagement_id: UUID_E,
      starts_at: '2026-08-24T04:00:00Z',
      ends_at: '2026-08-24T04:30:00Z',
    });
    expect(create.status).toBe(500);
    expect(create.body).toEqual({
      ok: false, error: 'phone_audit_write_failed', rolled_back: false,
    });
    const patch = await request(app).patch(`/api/phone/appointments/${UUID_A}`).send({
      starts_at: '2026-08-24T05:00:00Z',
      ends_at: '2026-08-24T05:30:00Z',
      version: 3,
    });
    expect(patch.status).toBe(500);
    const cancel = await request(app).delete(`/api/phone/appointments/${UUID_A}`)
      .send({ reason: 'hr_cancelled', version: 3 });
    expect(cancel.status).toBe(500);
  });

  it('a failing audit on a READ never turns a 200 into a 500', async () => {
    // `resource.read`/`resource.list` are fail-open by policy: an audit sink
    // outage must not take the operator's calendar down.
    setAuditSink(() => { throw new Error('audit db insert failed'); });
    const app = appWith('interviewer', {
      readStore: fakeReadStore().store,
      stores: fakeStores().store,
    });
    for (const path of [
      `/api/phone/calendar${RANGE}`,
      '/api/phone/calendar/slots?date=2026-08-24',
      `/api/phone/engagements/${UUID_E}`,
      '/api/phone/health',
    ]) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  8. The disabled default
// ════════════════════════════════════════════════════════════════════

describe('while PHONE_SCREENING_ENABLED is off', () => {
  const disabled = (deps: PhoneApiDeps = {}) =>
    appWith('admin', { configSource: DISABLED, now: () => NOW, ...deps });

  it('reads report the feature as disabled and touch NO store', async () => {
    const read = fakeReadStore();
    const write = fakeStores();
    const app = disabled({ readStore: read.store, stores: write.store });
    const calendar = await request(app).get(`/api/phone/calendar${RANGE}`);
    expect(calendar.status).toBe(200);
    expect(calendar.body).toMatchObject({
      ok: true, enabled: false, count: 0, truncated: false, appointments: [],
    });
    const slots = await request(app).get('/api/phone/calendar/slots?date=2026-08-24');
    expect(slots.body).toMatchObject({
      enabled: false, slots: [], max_concurrent: null, occupancy_truncated: false,
    });
    const engagement = await request(app).get(`/api/phone/engagements/${UUID_E}`);
    expect(engagement.status).toBe(200);
    expect(engagement.body).toMatchObject({ enabled: false, engagement: null, attempts: [] });
    const health = await request(app).get('/api/phone/health');
    expect(health.body.status).toBe('disabled');
    expect(health.body.reasons).toEqual(['phone_screening_disabled']);
    expect(health.body.admission).toBeNull();
    // The residuals are still true while the feature is off.
    expect(health.body.residuals).toHaveLength(4);
    expect(read.calls).toEqual([]);
    expect(write.calls).toEqual([]);
  });

  it('every write is refused with 503 and performs ZERO work', async () => {
    const read = fakeReadStore();
    const write = fakeStores();
    const app = disabled({ readStore: read.store, stores: write.store });
    const cases: Array<[string, string, unknown]> = [
      ['post', '/api/phone/appointments', {
        engagement_id: UUID_E,
        starts_at: '2026-08-24T04:00:00Z',
        ends_at: '2026-08-24T04:30:00Z',
      }],
      ['patch', `/api/phone/appointments/${UUID_A}`, {
        starts_at: '2026-08-24T04:00:00Z',
        ends_at: '2026-08-24T04:30:00Z',
        version: 3,
      }],
      ['delete', `/api/phone/appointments/${UUID_A}`, { reason: 'hr_cancelled', version: 3 }],
      ['post', '/api/phone/halt', { reason: 'operator_pause' }],
      ['post', '/api/phone/halt/clear', { reason: 'operator_pause' }],
    ];
    for (const [method, path, body] of cases) {
      const res = await (request(app) as never as Record<string, Function>)[method](path)
        .send(body);
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'phone_screening_disabled' });
    }
    expect(write.calls).toEqual([]);
    expect(read.calls).toEqual([]);
    expect(audited).toEqual([]);
  });
});
