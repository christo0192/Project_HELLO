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
import { createPhoneWorkerRouter, WORKER_PHONE_EVENTS, PURGE_BEFORE_EVENTS } from '../routes/phone-worker.js';
import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_SYSTEM_ACTOR,
  loadPhoneScreeningConfig,
  type ApplyPhoneEventResult,
  type ConfirmCandidateVoiceCallbackResult,
  type HeartbeatPhoneAttemptResult,
  type PhoneReadStore,
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
  confirmCandidateVoiceCallback: ReturnType<typeof vi.fn>;
  /** 0045's epoch-fenced renewal. Observable on BOTH doors that call it. */
  heartbeatAttemptByEpoch: ReturnType<typeof vi.fn>;
  resolveEngagement: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  verifySessionHint: ReturnType<typeof vi.fn>;
  purgeRecordings: ReturnType<typeof vi.fn>;
  /** Every store method, so ANY database touch is observable. */
  storeCalls: () => number;
}

function build(options: {
  applyEvent?: (input: unknown) => Promise<ApplyPhoneEventResult>;
  scheduleAppointment?: (input: unknown) => Promise<SchedulePhoneAppointmentResult>;
  confirmCandidateVoiceCallback?: (input: unknown) => Promise<ConfirmCandidateVoiceCallbackResult>;
  heartbeat?: (input: unknown) => Promise<HeartbeatPhoneAttemptResult>;
  engagementState?: string | null;
  sessionId?: string | null;
  /** Omit the seam entirely, to prove the route works without a recorder. */
  withRecorder?: boolean;
  /** Wire the session-hint verifier; absent = a hint is unusable (fail-closed). */
  withHintVerifier?: boolean;
  verifySessionHint?: (input: { sessionId: string; engagementId: string }) => Promise<boolean>;
  /** Omit the purge seam, to prove the terminal path is inert without it. */
  withPurge?: boolean;
  purgeStatus?: string;
  purgeSafe?: boolean;
  configSource?: NodeJS.ProcessEnv;
  readStore?: PhoneReadStore;
  now?: Date;
  /** Bounce answered-state read; absent = fail-closed (not answered). */
  readAnsweredState?: (attemptId: string) => Promise<{ answered: boolean; terminal: boolean }>;
  withAnsweredState?: boolean;
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
  const confirmCandidateVoiceCallback = vi.fn(
    options.confirmCandidateVoiceCallback ??
      (async () =>
        ({ status: 'ok', appointmentId: 'appt-voice-1', version: 1 }) as ConfirmCandidateVoiceCallbackResult),
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
  // 0045. A REAL default, so the /events renewal actually runs rather than
  // being swallowed by the route's best-effort catch because the seam is
  // missing — a test that passes only because the call throws proves nothing.
  const heartbeatAttemptByEpoch = vi.fn(
    options.heartbeat ?? (async () => ({ status: 'ok' }) as HeartbeatPhoneAttemptResult),
  );
  const startRecording = vi.fn(async () => ({ status: 'started', egressStarted: true }));
  const verifySessionHint = vi.fn(
    options.verifySessionHint ?? (async () => true),
  );
  const purgeRecordings = vi.fn(async () => ({
    status: options.purgeStatus ?? 'purged',
    safeToAcknowledge: options.purgeSafe ?? true,
  }));
  const readStore = options.readStore ?? ({
    listAttemptsForEngagement: async () => [],
    listLiveAppointmentsByStart: async () => [],
  } as unknown as PhoneReadStore);

  const stores = {
    applyEvent,
    scheduleAppointment,
    confirmCandidateVoiceCallback,
    heartbeatAttemptByEpoch,
  } as unknown as PhoneStores;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/phone-worker',
    createPhoneWorkerRouter({
      stores,
      readStore,
      resolveEngagement: resolveEngagement as never,
      // Absent unless a test asks for it, so the default path proves the route
      // is correct with NO recorder configured — which is exactly how a
      // deployment without an egress destination runs.
      startRecording: options.withRecorder === true ? (startRecording as never) : undefined,
      // The verifier is wired only when a test asks for it, so the DEFAULT
      // path proves a hint is unusable without one (fail-closed).
      verifySessionHint: options.withHintVerifier === true ? (verifySessionHint as never) : undefined,
      purgeRecordings: options.withPurge === true ? (purgeRecordings as never) : undefined,
      readAnsweredState:
        options.withAnsweredState === true
          ? (options.readAnsweredState ?? (async () => ({ answered: true, terminal: false })))
          : undefined,
      configSource: options.configSource ?? ENABLED,
      now: () => options.now ?? NOW,
    }),
  );

  return {
    app,
    applyEvent,
    scheduleAppointment,
    confirmCandidateVoiceCallback,
    heartbeatAttemptByEpoch,
    resolveEngagement,
    startRecording,
    verifySessionHint,
    purgeRecordings,
    // EVERY store method, so a "no database work" assertion means it.
    storeCalls: () =>
      applyEvent.mock.calls.length
      + scheduleAppointment.mock.calls.length
      + confirmCandidateVoiceCallback.mock.calls.length
      + heartbeatAttemptByEpoch.mock.calls.length,
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
// Explicit callback proposal/confirmation
// ═══════════════════════════════════════════════════════════════════════

describe('candidate voice callback proposal and confirmation', () => {
  it('validates and normalizes a proposal without touching a write store', async () => {
    const attempts = vi.fn(async () => []);
    const live = vi.fn(async () => []);
    const h = build({
      engagementState: 'in_call',
      readStore: {
        listAttemptsForEngagement: attempts,
        listLiveAppointmentsByStart: live,
      } as unknown as PhoneReadStore,
    });
    const res = await post(h, '/callbacks/propose', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: 'proposal_valid',
      starts_at: '2026-09-01T10:00:00.000Z',
      duration_seconds: 900,
      time_zone: 'Asia/Kolkata',
      ist_time: '15:30',
    });
    expect(attempts).toHaveBeenCalledOnce();
    expect(live).toHaveBeenCalledOnce();
    expect(h.confirmCandidateVoiceCallback).not.toHaveBeenCalled();
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
  });

  it('rejects a proposal with less than five minutes lead', async () => {
    const h = build({ now: new Date('2026-08-01T00:00:00.000Z') });
    const res = await post(h, '/callbacks/propose', {
      attempt_id: ATTEMPT,
      starts_at: '2026-08-01T00:04:59Z',
    });
    expect(res.body).toEqual({ ok: false, status: 'lead_time_too_short' });
    expect(h.resolveEngagement).toHaveBeenCalledOnce();
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
    expect(h.confirmCandidateVoiceCallback).not.toHaveBeenCalled();
  });

  it('confirms only through the dedicated idempotent callback seam', async () => {
    const confirm = vi.fn(async () =>
      ({ status: 'already_confirmed', appointmentId: 'appt-voice-1', version: 2 }) as ConfirmCandidateVoiceCallbackResult,
    );
    const h = build({ confirmCandidateVoiceCallback: confirm });
    const res = await post(h, '/callbacks/confirm', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 'already_confirmed',
      appointment_id: 'appt-voice-1',
      version: 2,
    });
    expect(confirm).toHaveBeenCalledWith({
      attemptId: ATTEMPT,
      startsAt: new Date(GOOD_SLOT),
      now: NOW,
    });
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
  });

  it('never turns a confirmation refusal into a success', async () => {
    const h = build({
      confirmCandidateVoiceCallback: async () =>
        ({ status: 'slot_full' }) as ConfirmCandidateVoiceCallbackResult,
    });
    const res = await post(h, '/callbacks/confirm', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT,
    });
    expect(res.body).toEqual({ ok: false, status: 'slot_full' });
  });

  it('returns nearest FREE alternatives on slot_full', async () => {
    // Ten live appointments all overlapping the requested 10:00-10:10Z slot
    // (15:30 IST) fill it to the fleet cap, so the requested time refuses
    // `slot_full`. The rest of the IST day is empty, so the projection can
    // still offer nearby free slots.
    const filled = Array.from({ length: 10 }, (_, i) => ({
      id: `appt-${i}`,
      engagementId: `other-eng-${i}`,
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T10:30:00.000Z',
      istDate: '2026-09-01',
      status: 'confirmed',
    }));
    const live = vi.fn(async () => filled);
    const h = build({
      engagementState: 'eligible',
      readStore: {
        listAttemptsForEngagement: async () => [],
        listLiveAppointmentsByStart: live,
      } as unknown as PhoneReadStore,
    });
    const res = await post(h, '/callbacks/propose', {
      attempt_id: ATTEMPT,
      starts_at: GOOD_SLOT, // 2026-09-01T10:00Z
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('slot_full');
    // Bounded set of nearest free slots, each with the fields the worker speaks.
    expect(Array.isArray(res.body.alternatives)).toBe(true);
    expect(res.body.alternatives.length).toBeGreaterThan(0);
    expect(res.body.alternatives.length).toBeLessThanOrEqual(3);
    for (const alt of res.body.alternatives) {
      expect(typeof alt.starts_at).toBe('string');
      expect(typeof alt.ends_at).toBe('string');
      expect(typeof alt.ist_time).toBe('string');
      expect(typeof alt.weekday).toBe('string');
      // Never offers the full slot itself.
      expect(alt.starts_at).not.toBe('2026-09-01T10:00:00.000Z');
    }
    // Occupancy read at least once for the overlap probe and once for the grid.
    expect(live.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Still a read-only refusal: no booking.
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
    expect(h.confirmCandidateVoiceCallback).not.toHaveBeenCalled();
  });
});

// Auth
// ═══════════════════════════════════════════════════════════════════════

describe('P5 worker route — auth is the existing worker secret', () => {
  for (const path of ['/events', '/appointments', '/attempt/heartbeat']) {
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
    // 0045. The renewal door is behind the SAME master switch, and a disabled
    // deployment must be indistinguishable from one that never had the route.
    ['/attempt/heartbeat', { attempt_id: ATTEMPT, session_id: SESSION, epoch: 0 }],
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

describe('P5 worker route — the IST window and temporary 24/7 override', () => {
  // IST is UTC+05:30, so an IST wall clock of HH:MM is (HH:MM - 5:30) UTC.
  // 2026-09-14 is the first post-cutoff IST day after the 0085-extended
  // temporary override (24/7 through 2026-09-13 inclusive).
  const cases = [
    { label: '09:00 IST (open, inclusive)', utc: '2026-09-14T03:30:00Z', open: true },
    { label: '08:59 IST (one minute early)', utc: '2026-09-14T03:29:00Z', open: false },
    { label: '20:59 IST (last legal minute)', utc: '2026-09-14T15:29:00Z', open: true },
    { label: '21:00 IST (close, exclusive)', utc: '2026-09-14T15:30:00Z', open: false },
    { label: '03:00 IST (the middle of the night)', utc: '2026-09-13T21:30:00Z', open: false },
  ];

  it('accepted a call-start at 03:00 IST on September 9 during the temporary window', async () => {
    const h = build();
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: '2026-09-08T21:30:00Z',
      duration_seconds: 1800,
    });
    expect(res.body.ok).toBe(true);
    expect(h.scheduleAppointment).toHaveBeenCalledTimes(1);
  });

  it('refuses a call-start at 03:00 IST on September 13 — the testing allowance ended on September 9 (0092)', async () => {
    const h = build();
    const res = await post(h, '/appointments', {
      attempt_id: ATTEMPT,
      starts_at: '2026-09-12T21:30:00Z',
      duration_seconds: 1800,
    });
    expect(res.body.ok).toBe(false);
    expect(h.scheduleAppointment).not.toHaveBeenCalled();
  });

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

  it('uses the worker\'s session HINT when the DB binding does not exist yet (the unrecorded-first-call incident)', async () => {
    // 2026-08-26: the session is bound to the attempt only at
    // /assessment/start, which is AFTER the disclosure — so the DB read here
    // found nothing and recording silently skipped on EVERY call. The worker
    // forwards the session it already holds; the route must use it.
    const h = build({ withRecorder: true, withHintVerifier: true, sessionId: null });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
      session_id: SESSION,
    });

    expect(res.status).toBe(200);
    expect(h.verifySessionHint).toHaveBeenCalledWith({
      sessionId: SESSION,
      engagementId: ENGAGEMENT,
    });
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.startRecording.mock.calls[0][0]).toMatchObject({
      engagementId: ENGAGEMENT,
      attemptId: ATTEMPT,
      roomName: `phone-${SESSION}`,
    });
  });

  it('refuses a valid-but-UNRELATED session hint (the server checks the association, not the shape)', async () => {
    // Independent review of the first draft: a UUID-shaped hint could point
    // the egress at another conversation's room. The verifier answers false
    // for a session that does not belong to this attempt's candidate, and the
    // recording must be refused — while the consent event itself still lands.
    const h = build({
      withRecorder: true,
      withHintVerifier: true,
      sessionId: null,
      verifySessionHint: async () => false,
    });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
      session_id: '77777777-6666-4555-8444-333333333333',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('a hint is unusable when NO verifier is wired (fail-closed by absence)', async () => {
    const h = build({ withRecorder: true, sessionId: null });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
      session_id: SESSION,
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('prefers the DB binding over the hint when both exist', async () => {
    // The database is the authority once /assessment/start has bound the
    // session; a worker hint that disagrees must not redirect the egress.
    const OTHER = '77777777-6666-4555-8444-333333333333';
    const h = build({ withRecorder: true, withHintVerifier: true });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
      session_id: OTHER,
    });

    expect(res.status).toBe(200);
    expect(h.startRecording.mock.calls[0][0]).toMatchObject({ roomName: `phone-${SESSION}` });
    // The bound session needs no verification, and consulting the verifier
    // for it would make the DB's own binding second-guess itself.
    expect(h.verifySessionHint).not.toHaveBeenCalled();
  });

  it('starts NO recording with neither a binding nor a hint (and the event still succeeds)', async () => {
    const h = build({ withRecorder: true, sessionId: null });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('refuses a malformed session hint with 400 before any database work', async () => {
    const h = build({ withRecorder: true });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
      session_id: 'not-a-uuid',
    });

    expect(res.status).toBe(400);
    expect(h.startRecording).not.toHaveBeenCalled();
    expect(h.storeCalls()).toBe(0);
  });

  // 0067: `call.answered` now ALSO starts a recording (the recording begins at
  // answer). Both recording events are excluded from this "starts NO recording"
  // sweep; each has its own positive coverage above/below.
  for (const event of WORKER_PHONE_EVENTS.filter(
    (e) => e !== 'disclosure.delivered' && e !== 'call.answered',
  )) {
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
// 0067 — the recording begins at ANSWER, not at disclosure.
//
// `call.answered` now starts the attach + egress + 0051 session stamp, so the
// greeting and consent exchange are captured. `disclosure.delivered` remains an
// idempotent FALLBACK. Both fire ONLY when the event was APPLIED, never on
// duplicate/ignored, and both apply the same session-hint verification.
// ═══════════════════════════════════════════════════════════════════════

describe('0067 — recording starts on an APPLIED call.answered', () => {
  it('starts the recording for the attempt on call.answered, in that session\'s room', async () => {
    const h = build({ withRecorder: true });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'call.answered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.startRecording.mock.calls[0][0]).toMatchObject({
      engagementId: ENGAGEMENT,
      attemptId: ATTEMPT,
      roomName: `phone-${SESSION}`,
    });
  });

  it('uses the worker session HINT on call.answered when the DB binding does not exist yet', async () => {
    // The session is bound to the attempt only at /assessment/start, which is
    // AFTER the answer — so the DB read here finds nothing and the worker's
    // hint (verified against the attempt's candidate) is used.
    const h = build({ withRecorder: true, withHintVerifier: true, sessionId: null });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'call.answered',
      session_id: SESSION,
    });

    expect(res.status).toBe(200);
    expect(h.verifySessionHint).toHaveBeenCalledWith({ sessionId: SESSION, engagementId: ENGAGEMENT });
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.startRecording.mock.calls[0][0]).toMatchObject({ roomName: `phone-${SESSION}` });
  });

  it('refuses an UNRELATED session hint on call.answered exactly as disclosure does', async () => {
    const h = build({
      withRecorder: true,
      withHintVerifier: true,
      sessionId: null,
      verifySessionHint: async () => false,
    });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'call.answered',
      session_id: '77777777-6666-4555-8444-333333333333',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('does NOT start a recording on a DUPLICATE call.answered', async () => {
    // A duplicate is a re-post of an already-applied event. 0067 begins the
    // recording only on the FIRST application; the attach/egress/stamp are
    // idempotent anyway, but the route must not re-drive them on a duplicate.
    const h = build({
      withRecorder: true,
      applyEvent: async () =>
        ({ status: 'applied', applied: true, duplicate: true }) as ApplyPhoneEventResult,
    });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'call.answered',
    });

    expect(res.status).toBe(200);
    // `duplicate` short-circuits the recording start: the guard is
    // `result.status === 'applied'`, and a duplicate returns `applied` — so
    // this asserts the route does not re-drive on a re-post.
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('does NOT start a recording on an IGNORED call.answered', async () => {
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
      event_type: 'call.answered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('disclosure.delivered STILL attaches as a fallback when the answer never recorded', async () => {
    // The two paths share ONE seam. Even if call.answered never arrived or its
    // attach failed, the disclosure path still starts the recording — the
    // attach/egress/stamp are idempotent, so this is a safe re-drive.
    const h = build({ withRecorder: true });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
    });

    expect(res.status).toBe(200);
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.startRecording.mock.calls[0][0]).toMatchObject({ roomName: `phone-${SESSION}` });
  });

  it('a call.answered recording failure stays LOUD-but-non-fatal (the event still applies)', async () => {
    const h = build({ withRecorder: true });
    h.startRecording.mockRejectedValueOnce(new Error('egress exploded'));
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'call.answered',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('applied');
    expect(JSON.stringify(res.body)).not.toContain('exploded');
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

// 0067: the purge set now also covers the two NON-consenting exits that can
// have pre-consent audio — a machine pickup and a pre-disclosure deferral —
// because the recording now starts at ANSWER, before consent. The behaviour is
// identical to the refusals: destroy and verify before the event posts.
const TERMINAL_REFUSALS = [
  'disclosure.refused',
  'candidate.opt_out',
  'candidate.wrong_number',
  'classify.machine',
  'candidate.deferred_pre_disclosure',
] as const;

describe('a terminal refusal purges the recordings BEFORE it is acknowledged', () => {
  it('the purge set is exactly the five non-consenting exits (record from answer, keep only if consented)', () => {
    expect([...PURGE_BEFORE_EVENTS].sort()).toEqual([...TERMINAL_REFUSALS].sort());
  });

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

// ═══════════════════════════════════════════════════════════════════════
// POST /attempt/heartbeat — 0045
//
// B-1: the attempt CONCURRENCY lease (the fleet-slot lease, not the 0028
// queue lease) is minted by admission and extended just far enough to cover
// the originate. Nothing renewed it, so it expired mid-call on EVERY answered
// call: the slot was handed to somebody else while the candidate was still
// talking, the reclaim sweep marked a live conversation `abandoned`, and the
// agent's eventual `assessment.completed` was ignored because that edge is
// gated on `in_call`. A screening that was conducted AND SCORED was lost,
// silently. This door is the renewal.
//
// Two properties carry every test below.
//
//   1. NO LEASE TOKEN EVER TRAVELS ON THIS ROUTE — not up, not down. The
//      conversation runs in the LiveKit agent, not in the process that
//      admitted the attempt, so a token-fenced renewal would mean shipping
//      the token onto dispatch metadata and into every log line that ever
//      printed a request body. 0045 added a second, EPOCH-fenced door
//      precisely so the token can stay where it was minted.
//   2. `lease_lost` IS NOT RETRYABLE. It is the one refusal this door has and
//      it means the slot is gone — possibly to another live call. A worker
//      that kept beating on a lost lease is the hazard, so the response must
//      carry no cadence at all.
// ═══════════════════════════════════════════════════════════════════════

/** A uuid-shaped string that must never be echoed back to the worker. */
const LEASE_TOKEN = '0de1ca7e-0000-4000-8000-abcdefabcdef';

/** The lease the ROUTE is configured with, read from the same source it reads. */
function leaseOf(source: NodeJS.ProcessEnv): number {
  return loadPhoneScreeningConfig(source).leaseSeconds;
}

function beat(h: Harness, body: Record<string, unknown>) {
  return post(h, '/attempt/heartbeat', body);
}

const GOOD_BEAT = { attempt_id: ATTEMPT, session_id: SESSION, epoch: 4 };

describe('P5 /attempt/heartbeat — the schema is STRICT and a token cannot ride on it', () => {
  // `.strict()` is the control, not a nicety. The whole reason 0045 added an
  // epoch-fenced RPC is so a lease token can never travel on this route; a
  // schema that quietly ignored an unknown key would let a worker start
  // sending one, and the first person to notice would be whoever read a log.
  for (const [label, body] of [
    ['missing attempt_id', { session_id: SESSION, epoch: 1 }],
    ['non-uuid attempt_id', { attempt_id: 'not-a-uuid', session_id: SESSION, epoch: 1 }],
    ['missing epoch', { attempt_id: ATTEMPT, session_id: SESSION }],
    ['negative epoch', { attempt_id: ATTEMPT, session_id: SESSION, epoch: -1 }],
    ['non-integer epoch', { attempt_id: ATTEMPT, session_id: SESSION, epoch: 1.5 }],
    ['missing session_id', { attempt_id: ATTEMPT, epoch: 1 }],
    ['an extra lease_token key', { ...GOOD_BEAT, lease_token: LEASE_TOKEN }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`refuses ${label} with a flat 400 and NO database work`, async () => {
      const h = build();
      const res = await beat(h, body);
      expect(res.status, label).toBe(400);
      expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
      expect(h.storeCalls(), label).toBe(0);
    });
  }

  it('the extra-key refusal is the load-bearing one: a token never reaches the store', async () => {
    const h = build();
    const res = await beat(h, { ...GOOD_BEAT, lease_token: LEASE_TOKEN });
    expect(res.status).toBe(400);
    expect(h.heartbeatAttemptByEpoch).not.toHaveBeenCalled();
    // And it is not echoed back either — a 400 that quoted the body would put
    // the token in the worker's own logs, which is the leak this schema exists
    // to prevent.
    expect(JSON.stringify(res.body)).not.toContain(LEASE_TOKEN);
  });
});

describe('P5 /attempt/heartbeat — the cadence is the SERVER\'s number', () => {
  // The response carries no token and no absolute expiry, only when to beat
  // next. The server owns that number so the lease length stays a server-side
  // knob and a worker cannot drift off it.
  for (const lease of [undefined, '5', '31', '90', '900'] as const) {
    const source = {
      PHONE_SCREENING_ENABLED: 'true',
      ...(lease === undefined ? {} : { PHONE_LEASE_SECONDS: lease }),
    } as NodeJS.ProcessEnv;

    it(`ok → 200 with a cadence at most HALF the configured lease (lease=${lease ?? 'default'})`, async () => {
      const h = build({ configSource: source });
      const res = await beat(h, GOOD_BEAT);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('ok');

      const next = res.body.next_heartbeat_seconds;
      expect(Number.isInteger(next), `${next} must be a whole number of seconds`).toBe(true);
      expect(next).toBeGreaterThan(0);
      // Asserted against the CONFIG, not against a number typed into this
      // file: the requirement is a RELATION. Beating at the lease length
      // renews exactly as the lease lapses, which is the bug, not the fix.
      expect(
        next,
        'a cadence at or above the lease length renews exactly as the lease dies',
      ).toBeLessThanOrEqual(leaseOf(source) / 2);
    });
  }

  it('forwards the CONFIGURED lease to the store, not a hardcoded one', async () => {
    const source = { PHONE_SCREENING_ENABLED: 'true', PHONE_LEASE_SECONDS: '120' } as NodeJS.ProcessEnv;
    const h = build({ configSource: source });
    await beat(h, GOOD_BEAT);
    expect(h.heartbeatAttemptByEpoch.mock.calls[0][0].leaseSeconds).toBe(leaseOf(source));
  });
});

describe('P5 /attempt/heartbeat — `lease_lost` carries NO cadence', () => {
  it('200 with status lease_lost and no next_heartbeat_seconds AT ALL', async () => {
    const h = build({ heartbeat: async () => ({ status: 'lease_lost' }) as HeartbeatPhoneAttemptResult });
    const res = await beat(h, GOOD_BEAT);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('lease_lost');
    // The ABSENCE is the assertion. `lease_lost` is not retryable — the slot
    // is gone and another call may already hold it — so a worker that kept
    // beating would be beating on somebody else's conversation. Handing it a
    // cadence is an invitation to do exactly that.
    expect(res.body).not.toHaveProperty('next_heartbeat_seconds');
    expect(res.body).toEqual({ ok: true, status: 'lease_lost' });
  });
});

describe('P5 /attempt/heartbeat — only the RPC may say `lease_lost`', () => {
  it('an unrecognised status is a retryable 500, NEVER a forwarded lease_lost', async () => {
    // `HeartbeatPhoneAttemptResult.status` is `OrUnknown<...>` precisely
    // because a future RPC revision can answer something this build does not
    // know. `lease_lost` is the one word that means "stop the conversation,
    // the slot is gone, do not retry" — so collapsing every non-`ok` status
    // into it would let an answer we did not UNDERSTAND silently terminate
    // live calls. An answer we did not understand is not evidence of loss.
    const h = build({
      heartbeat: async () => ({ status: 'unknown_status' }) as unknown as HeartbeatPhoneAttemptResult,
    });
    const res = await beat(h, GOOD_BEAT);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, status: 'phone_heartbeat_error' });
    expect(res.body.status).not.toBe('lease_lost');
  });

  it('`lease_lost` is forwarded only when the RPC actually said it', async () => {
    const h = build({ heartbeat: async () => ({ status: 'lease_lost' }) as HeartbeatPhoneAttemptResult });
    const res = await beat(h, GOOD_BEAT);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('lease_lost');
  });
});

describe('P5 /attempt/heartbeat — the response is a PROJECTION, not a pass-through', () => {
  it('no lease token reaches the worker even when the store hands one back', async () => {
    // The store is fed a DISHONEST result carrying a token under three
    // spellings. This is the response-projection property: whatever a future
    // migration adds to the RPC answer does not reach the worker — and
    // therefore does not reach a language model, dispatch metadata, or a log
    // line — until this route changes on purpose.
    const h = build({
      heartbeat: async () =>
        ({
          status: 'ok',
          leaseToken: LEASE_TOKEN,
          lease_token: LEASE_TOKEN,
          leaseExpiresAt: '2026-08-01T00:01:00.000Z',
        }) as unknown as HeartbeatPhoneAttemptResult,
    });
    const res = await beat(h, GOOD_BEAT);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(LEASE_TOKEN);
    expect(body).not.toContain('leaseToken');
    expect(body).not.toContain('lease_token');
    // Positively: the body is exactly the three documented keys.
    expect(Object.keys(res.body).sort()).toEqual(['next_heartbeat_seconds', 'ok', 'status']);
  });

  it('a lease_lost result carrying a token leaks nothing either', async () => {
    const h = build({
      heartbeat: async () =>
        ({ status: 'lease_lost', leaseToken: LEASE_TOKEN }) as unknown as HeartbeatPhoneAttemptResult,
    });
    const res = await beat(h, GOOD_BEAT);
    expect(JSON.stringify(res.body)).not.toContain(LEASE_TOKEN);
  });
});

describe('P5 /attempt/heartbeat — a store throw is a bare, sanitized 500', () => {
  it('500 phone_heartbeat_error with nothing of the error in the body', async () => {
    const h = build({
      heartbeat: async () => {
        throw new Error(
          `lease ${LEASE_TOKEN} for candidate +919876543210 violates unique constraint`,
        );
      },
    });
    const res = await beat(h, GOOD_BEAT);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, status: 'phone_heartbeat_error' });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(LEASE_TOKEN);
    expect(body).not.toContain('9876543210');
    expect(body).not.toContain('constraint');
  });
});

describe('P5 /attempt/heartbeat — the epoch is the FENCE and travels verbatim', () => {
  // 0042 starts an engagement at epoch 0 and bumps it on
  // `disclosure.delivered`, so a FIRST heartbeat legitimately carries zero. A
  // route that treated 0 as "absent" — the classic falsy bug — would fence the
  // opening minutes of every call against the wrong generation, which reads as
  // `lease_lost` on a perfectly healthy call.
  for (const epoch of [0, 1, 7, 1_000_000]) {
    it(`forwards epoch ${epoch} unchanged, alongside the attempt id and the clock`, async () => {
      const h = build();
      const res = await beat(h, { attempt_id: ATTEMPT, session_id: SESSION, epoch });

      expect(res.status).toBe(200);
      expect(h.heartbeatAttemptByEpoch).toHaveBeenCalledTimes(1);
      expect(h.heartbeatAttemptByEpoch.mock.calls[0][0]).toEqual({
        attemptId: ATTEMPT,
        epoch,
        // Part of the FENCE, not context. A field that is required at the
        // route and then discarded is worse than an absent one: it reads
        // like a binding check and binds nothing, so reviewers stop looking.
        sessionId: SESSION,
        leaseSeconds: leaseOf(ENABLED),
        now: NOW,
      });
    });
  }

  it('epoch 0 is accepted, not swallowed as a missing field', async () => {
    const h = build();
    const res = await beat(h, { attempt_id: ATTEMPT, session_id: SESSION, epoch: 0 });
    expect(res.status).toBe(200);
    expect(h.heartbeatAttemptByEpoch.mock.calls[0][0].epoch).toBe(0);
    expect(h.heartbeatAttemptByEpoch.mock.calls[0][0].epoch).not.toBeUndefined();
  });

  it('the session_id is forwarded as part of the fence, not parsed and dropped', async () => {
    const h = build();
    await beat(h, GOOD_BEAT);
    expect(h.heartbeatAttemptByEpoch.mock.calls[0][0].sessionId).toBe(SESSION);
  });

  it('the input the store receives carries NO token field under any spelling', async () => {
    const h = build();
    await beat(h, GOOD_BEAT);
    const input = h.heartbeatAttemptByEpoch.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      'attemptId',
      'epoch',
      'leaseSeconds',
      'now',
      'sessionId',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// /events RENEWS NOTHING — and that is now the invariant
//
// A draft of 0045 renewed the attempt lease here, on an applied
// `classify.human` or `disclosure.delivered`, to cover the window between "a
// human answered" and "the agent's own heartbeat has beaten once". It was
// REMOVED when the SESSION became part of the heartbeat fence: this route's
// payload carries an attempt id and an epoch but no session, so renewing from
// here would mean either passing a session the caller never named or making
// the fence optional — and a fence that is optional for one caller is a fence
// a reviewer stops trusting for all of them.
//
// So the tests below are the mirror image of the ones that were written for
// that draft. They exist because the removal is a DECISION, not an omission:
// re-adding the renewal is exactly the kind of well-meaning edit that would
// otherwise land unnoticed, and it would have to weaken the fence to work.
// The residual is bounded and LOUD — a lease that does lapse in that window
// makes the agent's first heartbeat answer `lease_lost` and the agent halts.
// B-1 was bad because it was SILENT; this is the same hazard with the silence
// removed, and closing it properly means sizing the admission lease, not
// opening a second renewal path on the hottest authenticated path in the lane.
// ═══════════════════════════════════════════════════════════════════════

describe('/events renews no lease, for any event, applied or not', () => {
  for (const eventType of WORKER_PHONE_EVENTS) {
    for (const [label, applyEvent] of [
      [
        'applied',
        async () =>
          ({ status: 'applied', applied: true, duplicate: false }) as ApplyPhoneEventResult,
      ],
      [
        'ignored',
        async () =>
          ({
            status: 'ignored',
            applied: false,
            ignoredReason: 'terminal',
            duplicate: false,
          }) as ApplyPhoneEventResult,
      ],
    ] as Array<[string, () => Promise<ApplyPhoneEventResult>]>) {
      it(`\`${eventType}\` (${label}) touches the renewal seam not at all`, async () => {
        const h = build({ applyEvent });
        const res = await post(h, '/events', {
          attempt_id: ATTEMPT,
          event_type: eventType,
          epoch: 2,
        });

        expect(res.status, eventType).toBe(200);
        expect(h.applyEvent, eventType).toHaveBeenCalledTimes(1);
        // The seam is WIRED — `build()` supplies a working
        // `heartbeatAttemptByEpoch` — so this asserts a route that chose not
        // to call it, not a route that could not.
        expect(h.heartbeatAttemptByEpoch, `${eventType} (${label})`).not.toHaveBeenCalled();
      });
    }
  }

  it('the two events the removed draft renewed on are the ones held down hardest', async () => {
    // Named explicitly as well as covered by the sweep above, because these
    // two are where a re-added renewal would go, and a reader deleting the
    // loop should still trip over the specific case.
    for (const eventType of ['classify.human', 'disclosure.delivered'] as const) {
      const h = build();
      await post(h, '/events', { attempt_id: ATTEMPT, event_type: eventType, epoch: 2 });
      expect(h.heartbeatAttemptByEpoch, eventType).not.toHaveBeenCalled();
    }
  });

  it('a renewal seam that THROWS on contact cannot affect /events at all', async () => {
    // Belt and braces on the same property from the other side: if some
    // future edit did reach the seam, this test says the request must still
    // be the normal applied answer — the event is already durable, and
    // failing the request would ask the worker to re-deliver a disclosure the
    // candidate has answered. Today it passes because nothing calls it.
    const h = build({
      heartbeat: async () => {
        throw new Error(`renewal must not be reachable from /events (${LEASE_TOKEN})`);
      },
    });
    const res = await post(h, '/events', {
      attempt_id: ATTEMPT,
      event_type: 'disclosure.delivered',
      epoch: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 'applied',
      ignored_reason: null,
      duplicate: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(LEASE_TOKEN);
  });

  it('/events accepts the session HINT, and the renewal fence still holds', async () => {
    // The previous pin was mechanical: the schema had no session field, so a
    // renewal could not live here — and that pin itself said a future widening
    // "is a visible change" that must re-argue the fence. The recording
    // ordering fix (2026-08-26) is that widening: `session_id` now exists as
    // an OPTIONAL hint whose only consumer is the recording starter. So the
    // fence is re-pinned at the invariant that actually matters: no event,
    // with or without a session in the payload, ever reaches the lease
    // renewal. Renewal still requires the /attempt/heartbeat door and its
    // epoch fence.
    const h = build({ withRecorder: true });
    for (const event_type of ['classify.human', 'disclosure.delivered']) {
      const res = await post(h, '/events', {
        attempt_id: ATTEMPT,
        event_type,
        epoch: 2,
        session_id: SESSION,
      });
      expect(res.status).toBe(200);
    }
    expect(h.heartbeatAttemptByEpoch).not.toHaveBeenCalled();
    // The hint's ONE consumer: the disclosure started a recording; nothing
    // else read it.
    expect(h.startRecording).toHaveBeenCalledTimes(1);
  });

  it('a router built with NO renewal seam behaves identically', async () => {
    // Nothing about /events depends on the seam existing, which is what
    // "renews nothing" has to mean to be worth asserting.
    const applyEvent = vi.fn(
      async () => ({ status: 'applied', applied: true, duplicate: false }) as ApplyPhoneEventResult,
    );
    const app = express();
    app.use(express.json());
    app.use(
      '/api/internal/phone-worker',
      createPhoneWorkerRouter({
        stores: { applyEvent } as unknown as PhoneStores,
        configSource: ENABLED,
        now: () => NOW,
      }),
    );
    const res = await request(app)
      .post('/api/internal/phone-worker/events')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ attempt_id: ATTEMPT, event_type: 'disclosure.delivered', epoch: 2 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 0067 — POST /assessment/gate-turns, the PRE-CONSENT transcript writer.
//
// `ok`/`already_recorded` are success (200). The DB refusals — `invalid_turns`,
// `unknown_session`, `session_not_active` — are 409, distinct from a transport
// fault (503). The turn TEXT is never echoed back.
// ═══════════════════════════════════════════════════════════════════════

const GATE_SECRET_TEXT = 'a-turn-of-transcript-text-that-must-never-echo';

function buildGate(options: {
  commitGateTurns?: (input: unknown) => Promise<{ status: string; turnsWritten?: number }>;
  configSource?: NodeJS.ProcessEnv;
  /** Omit the seam to prove the route is a flat 400 without it. */
  withSeam?: boolean;
} = {}) {
  const commitGateTurns = vi.fn(
    options.commitGateTurns ?? (async () => ({ status: 'ok', turnsWritten: 2 })),
  );
  const stores = (
    options.withSeam === false ? {} : { commitGateTurns }
  ) as unknown as PhoneStores;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/phone-worker',
    createPhoneWorkerRouter({
      stores,
      configSource: options.configSource ?? ENABLED,
      now: () => NOW,
    }),
  );
  return { app, commitGateTurns };
}

const GATE_BODY = {
  session_id: SESSION,
  source_event_id: 'gate:1',
  turns: [
    { speaker: 'bot', text: 'Hi, this call may be recorded. Is that ok?' },
    { speaker: 'candidate', text: 'Yes, that is fine.' },
  ],
};

function postGate(app: express.Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/internal/phone-worker/assessment/gate-turns')
    .set('Authorization', `Bearer ${SECRET}`)
    .send(body);
}

describe('POST /assessment/gate-turns — auth and the master switch', () => {
  it('requires the worker bearer', async () => {
    const { app } = buildGate();
    const res = await request(app)
      .post('/api/internal/phone-worker/assessment/gate-turns')
      .send(GATE_BODY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'authentication_required' });
  });

  it('a wrong bearer is 403', async () => {
    const { app } = buildGate();
    const res = await request(app)
      .post('/api/internal/phone-worker/assessment/gate-turns')
      .set('Authorization', `Bearer ${'z'.repeat(SECRET.length)}`)
      .send(GATE_BODY);
    expect(res.status).toBe(403);
  });

  it('is 503 and inert while phone screening is disabled', async () => {
    const { app, commitGateTurns } = buildGate({ configSource: DISABLED });
    const res = await postGate(app, GATE_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'phone_screening_disabled' });
    expect(commitGateTurns).not.toHaveBeenCalled();
  });
});

describe('POST /assessment/gate-turns — validation mirrors the RPC bounds', () => {
  for (const [label, body] of [
    ['a non-uuid session id', { ...GATE_BODY, session_id: 'nope' }],
    ['a missing session id', { source_event_id: 'g:1', turns: GATE_BODY.turns }],
    ['a bad source_event_id (spaces)', { ...GATE_BODY, source_event_id: 'has spaces' }],
    ['a source_event_id over 200 chars', { ...GATE_BODY, source_event_id: 'a'.repeat(201) }],
    ['zero turns', { ...GATE_BODY, turns: [] }],
    ['seven turns', { ...GATE_BODY, turns: Array.from({ length: 7 }, () => ({ speaker: 'bot', text: 'x' })) }],
    ['a bad speaker', { ...GATE_BODY, turns: [{ speaker: 'narrator', text: 'x' }] }],
    ['empty turn text', { ...GATE_BODY, turns: [{ speaker: 'bot', text: '   ' }] }],
    ['turn text over 8000 chars', { ...GATE_BODY, turns: [{ speaker: 'bot', text: 'x'.repeat(8001) }] }],
    ['an extra unknown key (.strict)', { ...GATE_BODY, phone_number: '+919876543210' }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`refuses ${label} with a 400 and NO store call`, async () => {
      const { app, commitGateTurns } = buildGate();
      const res = await postGate(app, body);
      expect(res.status, label).toBe(400);
      expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
      expect(commitGateTurns, label).not.toHaveBeenCalled();
    });
  }

  it('accepts the boundaries — 1 and 6 turns, 8000-char text', async () => {
    const { app, commitGateTurns } = buildGate();
    for (const turns of [
      [{ speaker: 'candidate', text: 'y'.repeat(8000) }],
      Array.from({ length: 6 }, (_, i) => ({ speaker: i % 2 ? 'candidate' : 'bot', text: 'ok' })),
    ]) {
      const res = await postGate(app, { ...GATE_BODY, turns });
      expect(res.status).toBe(200);
    }
    expect(commitGateTurns).toHaveBeenCalledTimes(2);
  });

  it('a router with NO gate seam is a flat 400, never a crash', async () => {
    const { app } = buildGate({ withSeam: false });
    const res = await postGate(app, GATE_BODY);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
  });
});

describe('POST /assessment/gate-turns — status mapping and no text echo', () => {
  for (const status of ['ok', 'already_recorded'] as const) {
    it(`\`${status}\` is a 200 success`, async () => {
      const { app } = buildGate({ commitGateTurns: async () => ({ status }) });
      const res = await postGate(app, GATE_BODY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, status });
      // `turns_written` is not echoed and the text never appears.
      expect(res.body).not.toHaveProperty('turns_written');
    });
  }

  for (const status of ['invalid_turns', 'unknown_session', 'session_not_active', 'unknown_status'] as const) {
    it(`\`${status}\` is a 409 refusal`, async () => {
      const { app } = buildGate({ commitGateTurns: async () => ({ status }) });
      const res = await postGate(app, GATE_BODY);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ok: false, status });
    });
  }

  it('an RPC transport error is a sanitized 503', async () => {
    const { app } = buildGate({
      commitGateTurns: async () => {
        throw new Error(`pg: transcript row for candidate +919876543210 — ${GATE_SECRET_TEXT}`);
      },
    });
    const res = await postGate(app, GATE_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, status: 'phone_gate_turns_error' });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('9876543210');
    expect(body).not.toContain(GATE_SECRET_TEXT);
  });

  it('the turn text is forwarded to the store but NEVER echoed in any response', async () => {
    const { app, commitGateTurns } = buildGate();
    const res = await postGate(app, {
      ...GATE_BODY,
      turns: [
        { speaker: 'bot', text: GATE_SECRET_TEXT },
        { speaker: 'candidate', text: 'yes' },
      ],
    });
    expect(res.status).toBe(200);
    // The store DID receive it (it must persist the transcript)…
    const gateInput = commitGateTurns.mock.calls[0][0] as {
      turns: Array<{ text: string }>;
    };
    expect(gateInput.turns[0].text).toBe(GATE_SECRET_TEXT);
    // …but the response body carries none of it.
    expect(JSON.stringify(res.body)).not.toContain(GATE_SECRET_TEXT);
    expect(res.body).toEqual({ ok: true, status: 'ok' });
  });

  it('forwards the session id, source event id, turns and clock to the store', async () => {
    const { app, commitGateTurns } = buildGate();
    await postGate(app, GATE_BODY);
    const input = commitGateTurns.mock.calls[0][0] as {
      sessionId: string; sourceEventId: string; now: Date; turns: unknown[];
    };
    expect(input).toMatchObject({
      sessionId: SESSION,
      sourceEventId: 'gate:1',
      now: NOW,
    });
    expect(input.turns).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /attempt/:attemptId/answered — the answer-first ("bounce") readiness poll
// ═══════════════════════════════════════════════════════════════════════

function getAnswered(h: Harness, attemptId: string) {
  return request(h.app)
    .get(`/api/internal/phone-worker/attempt/${attemptId}/answered`)
    .set('Authorization', `Bearer ${SECRET}`);
}

describe('P-answer GET /attempt/:id/answered', () => {
  it('requires the worker secret', async () => {
    const h = build({ withAnsweredState: true });
    const res = await request(h.app).get(`/api/internal/phone-worker/attempt/${ATTEMPT}/answered`);
    expect(res.status).toBe(401);
  });

  it('rejects a non-uuid attempt id with 400', async () => {
    const h = build({ withAnsweredState: true });
    const res = await getAnswered(h, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('returns the read seam answer verbatim', async () => {
    const readAnsweredState = vi.fn(async () => ({ answered: true, terminal: false }));
    const h = build({ withAnsweredState: true, readAnsweredState });
    const res = await getAnswered(h, ATTEMPT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, answered: true, terminal: false });
    expect(readAnsweredState).toHaveBeenCalledWith(ATTEMPT);
  });

  it('reports terminal true when the engagement is terminal', async () => {
    const h = build({
      withAnsweredState: true,
      readAnsweredState: async () => ({ answered: false, terminal: true }),
    });
    const res = await getAnswered(h, ATTEMPT);
    expect(res.body).toEqual({ ok: true, answered: false, terminal: true });
  });

  it('fails closed to not-answered when the seam is absent', async () => {
    const h = build({}); // no withAnsweredState
    const res = await getAnswered(h, ATTEMPT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, answered: false, terminal: false });
  });

  it('503s when screening is disabled', async () => {
    const h = build({ withAnsweredState: true, configSource: {} as NodeJS.ProcessEnv });
    const res = await getAnswered(h, ATTEMPT);
    expect(res.status).toBe(503);
  });
});
