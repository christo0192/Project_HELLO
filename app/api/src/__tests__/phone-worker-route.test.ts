/**
 * P5 — `createPhoneWorkerRouter`, the internal surface the phone voice worker
 * calls. Two endpoints, both POST, neither recruiter facing.
 *
 * Two properties carry this file.
 *
 * 1. THE EVENT ALLOWLIST IS CLOSED. `apply_phone_event` accepts an OPEN event
 *    FORMAT so an unrecognised provider event stays recordable — right for the
 *    ingress ledger, wrong here. The worker is our own code with exactly one
 *    vocabulary, and an event outside it must be refused BEFORE the database is
 *    touched.
 *
 * 2. THE SCHEDULING ENDPOINT NEVER REPORTS SUCCESS FOR A BOOKING THAT DID NOT
 *    HAPPEN. The worker speaks a confirmation aloud only when this endpoint
 *    says `ok`/`ok_prereqs_pending`, so a lenient answer becomes a bot
 *    confidently promising a callback that does not exist — on a call whose
 *    whole purpose is to be truthful.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPhoneWorkerRouter, WORKER_PHONE_EVENTS } from '../routes/phone-worker.js';
import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_SYSTEM_ACTOR,
  type ApplyPhoneEventResult,
  type PhoneStores,
  type SchedulePhoneAppointmentResult,
} from '../lib/phone-screening/index.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '99999999-8888-4777-8666-555555555555';

/** Exactly 40 chars — comfortably over the >=32 the auth gate demands. */
const SECRET = 'phone-worker-secret-0123456789abcdefghij';

/** `WORKER_CONTEXT_SECRET` is the EXISTING worker credential, not a phone var. */
let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.WORKER_CONTEXT_SECRET;
  process.env.WORKER_CONTEXT_SECRET = SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = savedSecret;
});

const ENABLED = { PHONE_SCREENING_ENABLED: 'true' } as NodeJS.ProcessEnv;
const DISABLED = {} as NodeJS.ProcessEnv;

/** The clock is injected everywhere; no test reads the host clock. */
const NOW = new Date('2026-08-01T00:00:00.000Z');

interface Harness {
  app: express.Express;
  applyEvent: ReturnType<typeof vi.fn>;
  scheduleAppointment: ReturnType<typeof vi.fn>;
  resolveEngagement: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  purgeRecordings: ReturnType<typeof vi.fn>;
  /** Every store method, so ANY database touch is observable. */
  storeCalls: () => number;
}

function build(options: {
  applyEvent?: (input: unknown) => Promise<ApplyPhoneEventResult>;
  scheduleAppointment?: (input: unknown) => Promise<SchedulePhoneAppointmentResult>;
  engagementState?: string | null;
  sessionId?: string | null;
  /** Omit the seam entirely, to prove the route works without a recorder. */
  withRecorder?: boolean;
  /** Omit the purge seam, to prove the terminal path is inert without it. */
  withPurge?: boolean;
  purgeStatus?: string;
  purgeSafe?: boolean;
  configSource?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Harness {
  const applyEvent = vi.fn(
    options.applyEvent ??
      (async () => ({ status: 'applied', applied: true, duplicate: false }) as ApplyPhoneEventResult),
  );
  const scheduleAppointment = vi.fn(
    options.scheduleAppointment ??
      (async () =>
        ({ status: 'ok', appointmentId: 'appt-1', version: 3 }) as SchedulePhoneAppointmentResult),
  );
  const resolveEngagement = vi.fn(async () =>
    options.engagementState === null
      ? null
      : {
          engagementId: ENGAGEMENT,
          engagementState: options.engagementState ?? 'eligible',
          version: 1,
          sessionId:
            options.sessionId === null ? undefined : (options.sessionId ?? SESSION),
        },
  );
  const startRecording = vi.fn(async () => ({ status: 'started', egressStarted: true }));
  const purgeRecordings = vi.fn(async () => ({
    status: options.purgeStatus ?? 'purged',
    safeToAcknowledge: options.purgeSafe ?? true,
  }));

  const stores = { applyEvent, scheduleAppointment } as unknown as PhoneStores;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/phone-worker',
    createPhoneWorkerRouter({
      stores,
      resolveEngagement: resolveEngagement as never,
      // Absent unless a test asks for it, so the default path proves the route
      // is correct with NO recorder configured — which is exactly how a
      // deployment without an egress destination runs.
      startRecording: options.withRecorder === true ? (startRecording as never) : undefined,
      purgeRecordings: options.withPurge === true ? (purgeRecordings as never) : undefined,
      configSource: options.configSource ?? ENABLED,
      now: () => options.now ?? NOW,
    }),
  );

  return {
    app,
    applyEvent,
    scheduleAppointment,
    resolveEngagement,
    startRecording,
    purgeRecordings,
    storeCalls: () => applyEvent.mock.calls.length + scheduleAppointment.mock.calls.length,
  };
}

function post(h: Harness, path: string, body: Record<string, unknown>) {
  return request(h.app)
    .post(`/api/internal/phone-worker${path}`)
    .set('Authorization', `Bearer ${SECRET}`)
    .send(body);
}

/** An instant well inside the IST window and comfortably in the future. */
const GOOD_SLOT = '2026-09-01T10:00:00Z'; // 15:30 IST

// ═══════════════════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════════════════

describe('P5 worker route — auth is the existing worker secret', () => {
  for (const path of ['/events', '/appointments']) {
    it(`${path}: an unset secret is 503, not a 401 that invites guessing`, async () => {
      delete process.env.WORKER_CONTEXT_SECRET;
      const h = build();
      const res = await request(h.app)
        .post(`/api/internal/phone-worker${path}`)
        .set('Authorization', `Bearer ${SECRET}`)
        .send({});
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'worker_auth_not_configured' });
      expect(h.storeCalls()).toBe(0);
    });

    it(`${path}: a short secret is refused as unconfigured, not honoured`, async () => {
      // A 31-character secret is a misconfiguration, and honouring it would
      // make the >=32 floor advisory rather than enforced.
      process.env.WORKER_CONTEXT_SECRET = 'a'.repeat(31);
      const h = build();
      const res = await request(h.app)
        .post(`/api/internal/phone-worker${path}`)
        .set('Authorization', `Bearer ${'a'.repeat(31)}`)
        .send({});
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'worker_auth_not_configured' });
      expect(h.storeCalls()).toBe(0);
    });

    it(`${path}: no bearer is 401`, async () => {
      const h = build();
      const res = await request(h.app).post(`/api/internal/phone-worker${path}`).send({});
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'authentication_required' });
      expect(h.storeCalls()).toBe(0);
    });

    it(`${path}: a non-Bearer scheme is 401`, async () => {
      const h = build();
      const res = await request(h.app)
        .post(`/api/internal/phone-worker${path}`)
        .set('Authorization', `Basic ${SECRET}`)
        .send({});
      expect(res.status).toBe(401);
      expect(h.storeCalls()).toBe(0);
    });

    it(`${path}: a wrong bearer is 403`, async () => {
      const h = build();
      const res = await request(h.app)
        .post(`/api/internal/phone-worker${path}`)
        .set('Authorization', `Bearer ${'z'.repeat(SECRET.length)}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'access_denied' });
      expect(h.storeCalls()).toBe(0);
    });

    it(`${path}: a bearer of the WRONG LENGTH is 403, not a crash`, async () => {
      // `timingSafeEqual` throws on unequal buffer lengths, so the length is
      // compared first. A crash here would be a 500 that leaks the length.
      const h = build();
      const res = await request(h.app)
        .post(`/api/internal/phone-worker${path}`)
        .set('Authorization', 'Bearer short')
        .send({});
      expect(res.status).toBe(403);
      expect(h.storeCalls()).toBe(0);
    });
  }

  it('the correct bearer proceeds past auth', async () => {
    const h = build();
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'classify.human',
    });
    expect(res.status).toBe(200);
    expect(h.applyEvent).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The master switch
// ═══════════════════════════════════════════════════════════════════════

describe('P5 worker route — disabled is indistinguishable from absent', () => {
  for (const [path, body] of [
    ['/events', { attempt_id: ATTEMPT, event_type: 'classify.human' }],
    ['/appointments', { attempt_id: ATTEMPT, starts_at: GOOD_SLOT, duration_seconds: 1800 }],
  ] as const) {
    it(`${path}: 503 phone_screening_disabled with NO store call at all`, async () => {
      const h = build({ configSource: DISABLED });
      const res = await post(h, path, body);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'phone_screening_disabled' });
      // Before any database work, not merely refusing more slowly.
      expect(h.storeCalls()).toBe(0);
      expect(h.resolveEngagement).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /events
// ═══════════════════════════════════════════════════════════════════════

describe('P5 worker route — /events forwards the whole worker vocabulary', () => {
  for (const eventType of WORKER_PHONE_EVENTS) {
    it(`accepts \`${eventType}\` and forwards it as source \`internal\``, async () => {
      const h = build();
      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: eventType });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(h.applyEvent).toHaveBeenCalledTimes(1);
      expect(h.applyEvent.mock.calls[0][0]).toMatchObject({
        // `internal` mints a deterministic synthetic provider id inside 0042,
        // so a worker retry converges on the original verdict rather than
        // writing a second ledger row.
        source: 'internal',
        eventType,
        attemptId: ATTEMPT,
        now: NOW,
      });
    });
  }

  it('passes an explicit epoch through, and omits it when absent', async () => {
    const withEpoch = build();
    await post(withEpoch, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'classify.human',
      epoch: 7,
    });
    expect(withEpoch.applyEvent.mock.calls[0][0].epoch).toBe(7);

    const without = build();
    await post(without, '/events', { attempt_id: ATTEMPT, event_type: 'classify.human' });
    expect(without.applyEvent.mock.calls[0][0].epoch).toBeUndefined();
  });
});

describe('P5 worker route — the event allowlist is CLOSED', () => {
  // THIS IS THE CONTROL that stops a worker manufacturing a PROVIDER verdict.
  // `sip.originate_*` are the carrier's verdicts and arrive through the signed
  // webhook, a different trust boundary. A worker that could post them could
  // manufacture a no-answer for a call that was actually answered — and a
  // no-answer CHARGES a real candidate's anti-harassment budget.
  for (const eventType of [
    'sip.originate_timeout',
    'sip.originate_rejected_busy',
    'hr.cancelled',
    'classify.alien',
  ]) {
    it(`refuses \`${eventType}\` with 400 BEFORE the database is touched`, async () => {
      const h = build();
      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: eventType });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'invalid_request' });
      expect(h.storeCalls()).toBe(0);
    });
  }

  it('the allowlist contains no `sip.originate_*` member at all', () => {
    expect(WORKER_PHONE_EVENTS.some((e) => e.startsWith('sip.originate'))).toBe(false);
    expect(WORKER_PHONE_EVENTS.some((e) => e.startsWith('hr.'))).toBe(false);
  });

  it('refuses a non-uuid attempt id', async () => {
    const h = build();
    const res = await post(h, '/events', { attempt_id: 'not-a-uuid', event_type: 'classify.human' });
    expect(res.status).toBe(400);
    expect(h.storeCalls()).toBe(0);
  });

  it('refuses an UPPERCASE uuid — the regex is the DB spelling, not a nicety', async () => {
    const h = build();
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT.toUpperCase(),
      event_type: 'classify.human',
    });
    expect(res.status).toBe(400);
    expect(h.storeCalls()).toBe(0);
  });

  it('refuses an extra unknown body key — the schema is .strict()', async () => {
    const h = build();
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'classify.human',
      // A key the route does not know is a key the route cannot have vetted.
      phone_number: '+919876543210',
    });
    expect(res.status).toBe(400);
    expect(h.storeCalls()).toBe(0);
  });

  it('refuses a missing event_type', async () => {
    const h = build();
    const res = await post(h, '/events', { attempt_id: ATTEMPT });
    expect(res.status).toBe(400);
    expect(h.storeCalls()).toBe(0);
  });
});

describe('P5 worker route — /events reports which answer it got', () => {
  const IGNORED_REASONS = ['stale_epoch', 'terminal', 'unknown_attempt'] as const;

  for (const reason of IGNORED_REASONS) {
    it(`an \`ignored\` verdict (${reason}) is RECORDED but is NOT ok`, async () => {
      // `ok` MEANS APPLIED. The worker branches its SAFETY decisions on this
      // field — it reads a successful `disclosure.delivered` as permission to
      // assess and to record. `terminal` is exactly what an HR `emergency.stop`
      // or `hr.cancelled` produces, so reporting it as `ok` told the worker
      // that consent had been recorded at the moment the state machine declared
      // the conversation over, and the agent would have kept the candidate on
      // the line and run the whole screening.
      //
      // The verdict is still forwarded in full, so a caller that legitimately
      // wants to distinguish "recorded but not applied" from "never reached the
      // ledger" still can — it just cannot do it by reading `ok`.
      const h = build({
        applyEvent: async () =>
          ({
            status: 'ignored',
            applied: false,
            ignoredReason: reason,
            duplicate: false,
          }) as ApplyPhoneEventResult,
      });
      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: 'classify.human' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: false,
        status: 'ignored',
        ignored_reason: reason,
        duplicate: false,
      });
    });
  }

  it('a DUPLICATE of an already-applied event is still ok — idempotency survives', async () => {
    // The rule "ok means applied" must not break retries. 0042 answers a
    // redelivery with the ORIGINAL verdict, so a duplicate of an applied event
    // comes back `applied` and stays ok.
    const h = build({
      applyEvent: async () =>
        ({ status: 'applied', applied: true, duplicate: true }) as ApplyPhoneEventResult,
    });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.duplicate).toBe(true);
  });

  it('surfaces `duplicate` so a retry is not mistaken for a second event', async () => {
    const h = build({
      applyEvent: async () =>
        ({ status: 'applied', applied: true, duplicate: true }) as ApplyPhoneEventResult,
    });
    const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: 'classify.human' });
    expect(res.body).toEqual({
      ok: true,
      status: 'applied',
      ignored_reason: null,
      duplicate: true,
    });
  });

  it('a non-applied, non-ignored status is NOT ok', async () => {
    const h = build({
      applyEvent: async () => ({ status: 'attempt_required' }) as ApplyPhoneEventResult,
    });
    const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: 'classify.human' });
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('attempt_required');
  });

  it('a store throw is a bare, sanitized 500', async () => {
    const h = build({
      applyEvent: async () => {
        throw new Error('duplicate key value violates unique constraint on candidate +919876543210');
      },
    });
    const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: 'classify.human' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'phone_event_error' });
    expect(JSON.stringify(res.body)).not.toContain('9876543210');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /appointments — never confirm a booking that did not happen
// ═══════════════════════════════════════════════════════════════════════

describe('P5 worker route — /appointments confirms ONLY a real booking', () => {
  for (const status of ['ok', 'ok_prereqs_pending'] as const) {
    it(`\`${status}\` is a success`, async () => {
      const h = build({
        scheduleAppointment: async () =>
          ({ status, appointmentId: 'appt-1', version: 4 }) as SchedulePhoneAppointmentResult,
      });
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: GOOD_SLOT,
        duration_seconds: 1800,
      });
      expect(res.status).toBe(200);
      // `ok_prereqs_pending` IS a booking: the slot is real and HR can see it.
      expect(res.body).toEqual({
        ok: true,
        status,
        appointment_id: 'appt-1',
        version: 4,
      });
    });
  }

  // Every other answer the RPC can give, table-driven, including the sentinel
  // for "we never got an answer we understand".
  for (const status of [
    'attempt_in_flight',
    'slot_in_past',
    'window_closed',
    'slot_duration_invalid',
    'slot_straddles_ist_midnight',
    'version_conflict',
    'engagement_terminal',
    'not_found',
    'appointment_exists',
    'invalid_slot',
    'invalid_source',
    'unknown_status',
  ]) {
    it(`\`${status}\` is forwarded as a REFUSAL`, async () => {
      const h = build({
        scheduleAppointment: async () => ({ status }) as SchedulePhoneAppointmentResult,
      });
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: GOOD_SLOT,
        duration_seconds: 1800,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, status });
      expect(res.body.appointment_id).toBeUndefined();
    });
  }

  it('`unknown_status` is explicitly NOT success', async () => {
    // The load-bearing case. `unknown_status` means the RPC answered with
    // something this codebase does not recognise; treating that as a booking
    // would have the bot promise a callback nobody scheduled.
    const h = build({
      scheduleAppointment: async () => ({ status: 'unknown_status' }) as SchedulePhoneAppointmentResult,
    });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.ok).not.toBe(true);
    expect(res.body).not.toHaveProperty('appointment_id');
  });

  it('an unresolvable attempt is a refusal, and nothing is booked', async () => {
    const h = build({ engagementState: null });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    expect(res.body).toEqual({ ok: false, status: 'unknown_attempt' });
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
  });

  it('a store throw is a sanitized 500 that is still not a confirmation', async () => {
    const h = build({
      scheduleAppointment: async () => {
        throw new Error('pg: relation phone_appointments row 42');
      },
    });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, status: 'phone_schedule_error' });
  });
});

describe('P5 worker route — the instant must be absolute UTC', () => {
  for (const startsAt of [
    '2026-09-01T10:00:00', // naive: "10:00" means two different instants
    '2026-09-01T10:00:00+05:30', // an offset, even the RIGHT one, is refused
    '2026-09-01T10:00:00z', // lowercase z
    '2026-09-01 10:00:00Z', // space separator
    'tomorrow at 3',
  ]) {
    it(`refuses \`${startsAt}\` with 400 and no store call`, async () => {
      const h = build();
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: startsAt,
        duration_seconds: 1800,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
      expect(h.storeCalls()).toBe(0);
      expect(h.resolveEngagement).not.toHaveBeenCalled();
    });
  }

  it('accepts millisecond precision', async () => {
    const h = build();
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: '2026-09-01T10:00:00.500Z',
      duration_seconds: 1800,
    });
    expect(res.body.ok).toBe(true);
  });

  it('refuses an extra unknown key and a non-uuid attempt id', async () => {
    const h = build();
    for (const body of [
      { attempt_id: ATTEMPT, starts_at: GOOD_SLOT, duration_seconds: 1800, note: 'call me' },
      { attempt_id: 'nope', starts_at: GOOD_SLOT, duration_seconds: 1800 },
    ]) {
      const res = await post(h, '/appointments', body);
      expect(res.status).toBe(400);
    }
    expect(h.storeCalls()).toBe(0);
  });
});

describe('P5 worker route — the duration bounds are the DB bounds', () => {
  it('mirrors 0042: 900..3600 seconds', () => {
    expect(PHONE_APPOINTMENT_MIN_SECONDS).toBe(900);
    expect(PHONE_APPOINTMENT_MAX_SECONDS).toBe(3600);
  });

  for (const duration of [899, 3601, 0, -900, 1800.5]) {
    it(`refuses ${duration} with 400 and no store call`, async () => {
      const h = build();
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: GOOD_SLOT,
        duration_seconds: duration,
      });
      expect(res.status).toBe(400);
      // A duration refusal is DISTINCT from a booking refusal, so the worker
      // can say "I can't do that length" rather than "something went wrong".
      expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
      expect(h.storeCalls()).toBe(0);
    });
  }

  for (const duration of [900, 3600]) {
    it(`accepts the boundary ${duration}`, async () => {
      const h = build();
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: GOOD_SLOT,
        duration_seconds: duration,
      });
      expect(res.body.ok).toBe(true);
      expect(h.scheduleAppointment.mock.calls[0][0].endsAt).toEqual(
        new Date(new Date(GOOD_SLOT).getTime() + duration * 1000),
      );
    });
  }
});

describe('P5 worker route — the server revalidates the instant', () => {
  it('an instant in the past is refused with NO schedule RPC call', async () => {
    // An LLM-driven caller is exactly the sort of client that confidently
    // proposes a time that has already gone by.
    const h = build({ now: new Date('2026-09-02T00:00:00.000Z') });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    expect(res.body).toEqual({ ok: false, status: 'slot_in_past' });
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
    expect(h.resolveEngagement).not.toHaveBeenCalled();
  });

  it('an instant equal to now is in the past — the comparison is <=', async () => {
    const h = build({ now: new Date(GOOD_SLOT) });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    expect(res.body).toEqual({ ok: false, status: 'slot_in_past' });
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
  });
});

describe('P5 worker route — the IST window, 09:00 inclusive to 21:00 exclusive', () => {
  // IST is UTC+05:30, so an IST wall clock of HH:MM is (HH:MM - 5:30) UTC.
  const cases = [
    { label: '09:00 IST (open, inclusive)', utc: '2026-09-01T03:30:00Z', open: true },
    { label: '08:59 IST (one minute early)', utc: '2026-09-01T03:29:00Z', open: false },
    { label: '20:59 IST (last legal minute)', utc: '2026-09-01T15:29:00Z', open: true },
    { label: '21:00 IST (close, exclusive)', utc: '2026-09-01T15:30:00Z', open: false },
    { label: '03:00 IST (the middle of the night)', utc: '2026-08-31T21:30:00Z', open: false },
  ];

  for (const c of cases) {
    it(`${c.label} → ${c.open ? 'accepted' : 'window_closed'}`, async () => {
      const h = build();
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: c.utc,
        duration_seconds: 1800,
      });
      if (c.open) {
        expect(res.body.ok).toBe(true);
        expect(h.scheduleAppointment).toHaveBeenCalledTimes(1);
        expect(h.scheduleAppointment.mock.calls[0][0].startsAt).toEqual(new Date(c.utc));
      } else {
        expect(res.body).toEqual({ ok: false, status: 'window_closed' });
        // Refused in the API, before the RPC — the SQL would refuse too, but
        // a round trip to find that out is a round trip the caller waits on.
        expect(h.scheduleAppointment).not.toHaveBeenCalled();
        expect(h.resolveEngagement).not.toHaveBeenCalled();
      }
    });
  }
});

describe('P5 worker route — the pre-disclosure path ends the attempt FIRST', () => {
  it('posts `candidate.deferred_pre_disclosure` BEFORE it schedules', async () => {
    const order: string[] = [];
    const applyEvent = vi.fn(async (_input: unknown) => {
      order.push('applyEvent');
      return { status: 'applied', applied: true } as ApplyPhoneEventResult;
    });
    const scheduleAppointment = vi.fn(async (_input: unknown) => {
      order.push('scheduleAppointment');
      return { status: 'ok', appointmentId: 'appt-1', version: 1 } as SchedulePhoneAppointmentResult;
    });
    const h = build({
      engagementState: 'dialing',
      applyEvent,
      scheduleAppointment,
    });

    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });

    expect(res.body.ok).toBe(true);
    // `schedule_phone_appointment` refuses outright while the engagement is
    // `dialing`, and "call me later" is MOST likely said during the
    // identity/disclosure exchange — i.e. exactly while it IS `dialing`. So
    // the attempt is ended truthfully and WITHOUT CHARGE first.
    expect(order).toEqual(['applyEvent', 'scheduleAppointment']);
    expect(applyEvent.mock.calls[0][0]).toMatchObject({
      source: 'internal',
      eventType: 'candidate.deferred_pre_disclosure',
      attemptId: ATTEMPT,
      now: NOW,
    });
  });

  it('does NOT post the deferral when the engagement is not `dialing`', async () => {
    const h = build({ engagementState: 'eligible' });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    expect(res.body.ok).toBe(true);
    expect(h.applyEvent).not.toHaveBeenCalled();
    expect(h.scheduleAppointment).toHaveBeenCalledTimes(1);
  });

  for (const ended of [
    { status: 'ignored', ignoredReason: 'terminal' },
    { status: 'ignored', ignoredReason: 'stale_epoch' },
    { status: 'attempt_required' },
    { status: 'unknown_status' },
  ]) {
    it(`refuses with attempt_in_flight and books NOTHING when the deferral answers \`${ended.status}/${ended.ignoredReason ?? '-'}\``, async () => {
      const h = build({
        engagementState: 'dialing',
        applyEvent: async () => ended as ApplyPhoneEventResult,
      });
      const res = await post(h, '/appointments', {
        attempt_id: ATTEMPT,
        starts_at: GOOD_SLOT,
        duration_seconds: 1800,
      });
      // If the first step did not succeed we do NOT book, and we do NOT
      // confirm. `ignored` is a fine answer for /events and is NOT good
      // enough to book under: the live dial still owns the engagement.
      expect(res.body).toEqual({ ok: false, status: 'attempt_in_flight' });
      expect(h.scheduleAppointment).not.toHaveBeenCalled();
    });
  }
});

describe('P5 worker route — the booking is attributed to the SYSTEM, not a recruiter', () => {
  it('uses source `candidate_voice` and the system actor sentinel', async () => {
    const h = build();
    await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
      duration_seconds: 1800,
    });
    const call = h.scheduleAppointment.mock.calls[0][0];
    expect(call).toMatchObject({
      engagementId: ENGAGEMENT,
      startsAt: new Date(GOOD_SLOT),
      endsAt: new Date(new Date(GOOD_SLOT).getTime() + 1_800_000),
      source: 'candidate_voice',
      // 0042 falls back to the RECRUITER sentinel for a null actor, which
      // would misattribute a candidate's spoken request to a human recruiter.
      actorId: PHONE_SYSTEM_ACTOR,
      now: NOW,
    });
    expect(call.actorId).not.toBeNull();
    expect(call.actorId).not.toBeUndefined();
  });
});


// ═══════════════════════════════════════════════════════════════════════
// The ONE event that may start a recording.
//
// This is the API half of the disclosure gate. 0043's
// `attach_phone_attempt_recording` independently refuses unless the engagement
// is already `in_call`, so these assertions are the SECOND of two locks — but
// they are the one that would catch a call site being moved or duplicated,
// which the database cannot see.
// ═══════════════════════════════════════════════════════════════════════

describe('recording starts on disclosure.delivered, and on nothing else', () => {
  it('starts the recording for the attempt, in that attempt\'s session room', async () => {
    const h = build({ withRecorder: true });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.startRecording.mock.calls[0][0]).toMatchObject({
      engagementId: ENGAGEMENT,
      attemptId: ATTEMPT,
      // Keyed by SESSION, not by attempt: one session spans every reconnect,
      // so a reconnect records into the room the conversation is already in.
      roomName: `phone-${SESSION}`,
    });
  });

  for (const event of WORKER_PHONE_EVENTS.filter((e) => e !== 'disclosure.delivered')) {
    it(`starts NO recording on ${event}`, async () => {
      const h = build({ withRecorder: true });
      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: event });

      expect(res.status).toBe(200);
      expect(h.startRecording).not.toHaveBeenCalled();
    });
  }

  it('starts NO recording when disclosure.delivered was IGNORED rather than applied', async () => {
    // A stale-epoch or terminal disclosure is not a disclosure. Recording on a
    // merely-POSTED event rather than an APPLIED one would record a
    // conversation the state machine has already declared over.
    const h = build({
      withRecorder: true,
      applyEvent: async () =>
        ({
          status: 'ignored',
          applied: false,
          ignoredReason: 'stale_epoch',
          duplicate: false,
        }) as ApplyPhoneEventResult,
    });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('still answers 200 when no recorder is configured at all', async () => {
    // A deployment with no egress destination simply does not record. That is
    // the safe direction: recording LESS than promised harms nobody, while
    // failing the event would ask the worker to re-deliver a disclosure the
    // candidate has already answered.
    const h = build();
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('still answers 200 when the recorder THROWS', async () => {
    const h = build({ withRecorder: true });
    h.startRecording.mockRejectedValueOnce(new Error('egress exploded'));
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    // The transition is durable and must not be undone by a recording failure.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('applied');
    // And nothing about the failure leaks to the worker, which could not act
    // on it and must not say anything to the candidate about it.
    expect(JSON.stringify(res.body)).not.toContain('exploded');
  });

  it('starts NO recording when the attempt has no session bound', async () => {
    const h = build({ withRecorder: true, sessionId: null });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });
});


// ═══════════════════════════════════════════════════════════════════════
// B-3 — the purge runs BEFORE any terminal refusal is acknowledged.
//
// `disclosure.refused`, `candidate.opt_out` and `candidate.wrong_number` are
// TERMINAL in 0042, and the terminal transition writes the suppression in the
// SAME transaction. Posting one before the audio is gone commits "this line is
// suppressed and this engagement is over" on top of a recording still sitting
// in the bucket — and it is invisible afterwards, because the engagement reads
// as correctly opted out.
// ═══════════════════════════════════════════════════════════════════════

const TERMINAL_REFUSALS = [
  'disclosure.refused',
  'candidate.opt_out',
  'candidate.wrong_number',
] as const;

describe('a terminal refusal purges the recordings BEFORE it is acknowledged', () => {
  for (const event of TERMINAL_REFUSALS) {
    it(`${event}: purges first, then posts the event`, async () => {
      const h = build({ withPurge: true });
      const order: string[] = [];
      h.purgeRecordings.mockImplementation(async () => {
        order.push('purge');
        return { status: 'purged', safeToAcknowledge: true };
      });
      h.applyEvent.mockImplementation(async () => {
        order.push('event');
        return { status: 'applied', applied: true, duplicate: false } as ApplyPhoneEventResult;
      });

      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: event });

      expect(res.status).toBe(200);
      expect(order).toEqual(['purge', 'event']);
      expect(h.purgeRecordings).toHaveBeenCalledWith({ engagementId: ENGAGEMENT, now: NOW });
    });

    it(`${event}: an UNSAFE purge posts NOTHING and stays retryable`, async () => {
      // The whole point. If the deletion could not be verified, the terminal
      // event — and the suppression that rides in its transaction — must not
      // commit. A 503 is retryable; a 200 would be an acknowledgement.
      const h = build({ withPurge: true, purgeStatus: 'still_present', purgeSafe: false });
      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: event });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'phone_purge_incomplete' });
      expect(h.applyEvent).not.toHaveBeenCalled();
    });
  }

  for (const status of ['enumeration_failed', 'egress_still_running', 'delete_failed', 'clear_failed']) {
    it(`does not acknowledge on ${status}`, async () => {
      const h = build({ withPurge: true, purgeStatus: status, purgeSafe: false });
      const res = await post(h, '/events', {
        attempt_id: ATTEMPT,
        event_type: 'candidate.opt_out',
      });
      expect(res.status).toBe(503);
      expect(h.applyEvent).not.toHaveBeenCalled();
    });
  }

  it('a purge that THROWS also posts nothing', async () => {
    const h = build({ withPurge: true });
    h.purgeRecordings.mockRejectedValueOnce(new Error('storage exploded'));
    const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: 'candidate.opt_out' });

    expect(res.status).toBe(503);
    expect(h.applyEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('exploded');
  });

  it('an engagement that cannot be RESOLVED posts nothing', async () => {
    // We cannot name what to purge, so we cannot claim it is gone.
    const h = build({ withPurge: true, engagementState: null });
    const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: 'candidate.opt_out' });

    expect(res.status).toBe(503);
    expect(h.applyEvent).not.toHaveBeenCalled();
  });

  it('NON-terminal events do not purge at all', async () => {
    for (const event of WORKER_PHONE_EVENTS.filter((e) => !TERMINAL_REFUSALS.includes(e as never))) {
      const h = build({ withPurge: true });
      const res = await post(h, '/events', { attempt_id: ATTEMPT, event_type: event });
      expect(res.status).toBe(200);
      expect(h.purgeRecordings, `${event} triggered a purge`).not.toHaveBeenCalled();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════
// H-3 — never confirm a slot admission cannot dial.
//
// 0043's pre-disclosure edge moves `next_eligible_at` to the NEXT IST day, and
// the ended attempt keeps TODAY's `ist_date` and its non-reconnect kind — so
// `admit_phone_attempt` would refuse a same-day retry twice over
// (`not_yet_eligible`, then `daily_attempt_exists`). `schedule_phone_appointment`
// checks neither field, so it would happily book 16:00 today and this endpoint
// would report success — and the bot would say "I've got that booked" for a
// call nothing will ever place.
//
// "Call me back this afternoon" is the MOST likely deferral there is.
// ═══════════════════════════════════════════════════════════════════════

describe('a pre-disclosure deferral cannot book a SAME-DAY slot', () => {
  // 2026-09-01T10:00:00Z is 15:30 IST on 2026-09-01.
  const SAME_IST_DAY = '2026-09-01T10:00:00Z';
  // 2026-09-02T05:00:00Z is 10:30 IST on 2026-09-02 — the next IST day.
  const NEXT_IST_DAY = '2026-09-02T05:00:00Z';
  const BEFORE = new Date('2026-09-01T04:00:00.000Z'); // 09:30 IST, window open

  it('refuses a same-day slot with its own code and books NOTHING', async () => {
    const h = build({ engagementState: 'dialing', now: BEFORE });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: SAME_IST_DAY,
      duration_seconds: 1800,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('slot_not_yet_eligible');
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
  });

  it('accepts the NEXT IST day, which admission can actually reach', async () => {
    const h = build({ engagementState: 'dialing', now: BEFORE });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: NEXT_IST_DAY,
      duration_seconds: 1800,
    });

    expect(res.body.ok).toBe(true);
    expect(h.scheduleAppointment).toHaveBeenCalledTimes(1);
  });

  it('the rule applies ONLY after a deferral — an in_call booking is unaffected', async () => {
    // An `in_call` engagement has no deferral and no ended attempt, so a
    // same-day slot is perfectly dialable. Over-applying the rule would break
    // the ordinary "later today" reschedule.
    const h = build({ engagementState: 'in_call', now: BEFORE });
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: SAME_IST_DAY,
      duration_seconds: 1800,
    });

    expect(res.body.ok).toBe(true);
    expect(h.scheduleAppointment).toHaveBeenCalledTimes(1);
  });
});
