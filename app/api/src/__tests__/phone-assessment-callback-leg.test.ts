/**
 * 0113 (E4) — a leg that ends because the candidate CONFIRMED a callback is a
 * deferral, not a screening. End to end, with doubles.
 *
 * ── THE INCIDENT THIS PINS ────────────────────────────────────────────
 * The candidate confirmed a callback mid-call. ~180 s later the partial-
 * finalize sweep treated the leg as an ordinary hangup and queued it for
 * scoring; the handler scored 0/N covered (a provisional reject, published to
 * Ashby and consuming the one-per-link scorecard) and posted the stranded
 * `assessment.completed`, which terminated an engagement that had to stay
 * `scheduled` for the callback slot. And even had it not, the slot dial could
 * never have run: the engagement was still bound to the leg's session, so the
 * due pass handed `ensureSession` a terminal `existingSessionId` and skipped
 * the engagement `no_session`.
 *
 * ── WHAT IS REAL AND WHAT IS A DOUBLE ─────────────────────────────────
 * Real: `createPhoneStores(...).finalizePartialSessions` (the wire mapping),
 * the runtime's `phone-partial-finalize` tick, `createPhoneAssessmentHandler`,
 * `runPhoneDuePass` and `createPhoneSessionPort`.
 * Doubles: an in-memory model of the rows the SQL touches. Its confirm and
 * finalize implement the 0113 semantics (detach + claim release; exact
 * `confirmed_from_attempt_id` match for `callback_booked`); its session insert
 * enforces PR-A's live-only `uq_call_sessions_phone_engagement`; its
 * `start_phone_assessment` refuses `session_already_bound`. The SQL bodies
 * themselves are pinned by the 0113-E4-* cases in policy_tests.sql.
 *
 * All ids are synthetic; no candidate data appears anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPhoneStores } from '../lib/phone-screening/stores.js';
import { loadPhoneScreeningConfig } from '../lib/phone-screening/index.js';
import type { PhoneScreeningConfig } from '../lib/phone-screening/index.js';
import type { PhoneStores } from '../lib/phone-screening/ports.js';
import {
  createPhoneRuntime,
  createPhoneSessionPort,
  type PhoneRuntimeHandle,
  type PhoneSessionUnavailable,
  type PhoneSessionWriter,
} from '../lib/phone-runtime/runtime.js';
import {
  clearPhoneRuntimeRegistration,
  clearPhoneRuntimeStartFailure,
} from '../lib/phone-runtime/health.js';
import { runPhoneDuePass } from '../lib/phone-runtime/due-loop.js';
import type { PhoneRuntimeReader } from '../lib/phone-runtime/read.js';
import { createPhoneAssessmentHandler } from '../lib/phone-runtime/assessment-handler.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import type { SessionRow } from '../lib/session-lifecycle.js';
import type { Queue } from '../lib/queue/index.js';

// Synthetic ids only.
const ENGAGEMENT = 'e4e4e4e4-0000-4000-8000-0000000000e1';
const CANDIDATE = 'c4c4c4c4-0000-4000-8000-0000000000c1';
const ROLE = 'a4a4a4a4-0000-4000-8000-0000000000a1';
const LEG_SESSION = '5e5e5e5e-0000-4000-8000-000000000051';
const LEG_ATTEMPT = 'a7a7a7a7-0000-4000-8000-0000000000a1';
const SLOT_SESSION = '5e5e5e5e-0000-4000-8000-000000000052';
const APPOINTMENT = 'abababab-0000-4000-8000-0000000000b1';

/** The substrate's strict mobile form, assembled so no literal reads as one. */
const DIALABLE = ['+9', '1', '70', '1234', '5678'].join('');

// 11:30 IST on a weekday — inside the calling window.
const SLOT_START = '2026-08-24T06:00:00.000Z';
const PASS_NOW = new Date('2026-08-24T06:00:30.000Z');

const LIVE = new Set(['created', 'waiting', 'in_progress']);

interface SessionModel {
  status: string;
  phoneEngagementId: string | null;
  externalCallId: string | null;
}

/**
 * An in-memory model of exactly the rows E4 touches. `detachOnConfirm=false`
 * reproduces the pre-0113 confirm (0073), so the same script can show the
 * failure the migration removes.
 */
function makeDb(opts: { detachOnConfirm: boolean; reportCallbackBooked: boolean }) {
  const engagement = {
    state: 'in_call' as string,
    stateReason: null as string | null,
    sessionId: LEG_SESSION as string | null,
    terminalAt: null as string | null,
    version: 1,
  };
  const sessions = new Map<string, SessionModel>([
    [LEG_SESSION, {
      status: 'in_progress',
      phoneEngagementId: ENGAGEMENT,
      externalCallId: phoneRoomName(LEG_SESSION),
    }],
  ]);
  const attempts = new Map<string, { sessionId: string }>([
    [LEG_ATTEMPT, { sessionId: LEG_SESSION }],
  ]);
  const appointments: Array<{
    id: string;
    status: string;
    startsAt: string;
    confirmedFromAttemptId: string;
  }> = [];
  const audit: Array<Record<string, unknown>> = [];

  return {
    engagement,
    sessions,
    appointments,
    audit,

    /** confirm_candidate_voice_callback, 0113 semantics (or 0073's). */
    confirm(attemptId: string, startsAt: string) {
      const prior = appointments.find((a) => a.confirmedFromAttemptId === attemptId);
      if (prior) return { status: 'ok', appointmentId: prior.id, replay: true };
      const capturedSessionId = engagement.sessionId;
      engagement.state = 'scheduled';
      engagement.stateReason = 'candidate_callback_confirmed';
      engagement.version += 1;
      let released = 0;
      if (opts.detachOnConfirm) {
        engagement.sessionId = null;
        const attemptSession = attempts.get(attemptId)?.sessionId ?? null;
        for (const [id, s] of sessions) {
          if (s.phoneEngagementId === ENGAGEMENT && (id === capturedSessionId || id === attemptSession)) {
            s.phoneEngagementId = null;
            released += 1;
          }
        }
      }
      appointments.push({
        id: APPOINTMENT, status: 'confirmed', startsAt, confirmedFromAttemptId: attemptId,
      });
      audit.push({
        action: 'phone_callback_confirmed',
        session_detached: opts.detachOnConfirm && capturedSessionId !== null,
        claim_released: released > 0,
      });
      return { status: 'ok', appointmentId: APPOINTMENT, replay: false };
    },

    /** finalize_phone_partial_sessions, as the RPC's wire JSON. */
    finalizeWire() {
      const out: Array<Record<string, unknown>> = [];
      let finalized = 0;
      for (const [id, s] of sessions) {
        if (s.status !== 'in_progress') continue;
        s.status = 'completed';
        finalized += 1;
        const attemptId = [...attempts].find(([, a]) => a.sessionId === id)?.[0] ?? null;
        const row: Record<string, unknown> = {
          session_id: id,
          attempt_id: attemptId,
          engagement_id: ENGAGEMENT,
          covered: 2,
          total: 5,
          disconnect_reason: 'candidate_hangup',
          transitioned: true,
          assessment_present: false,
          recording_present: true,
          never_started: false,
        };
        if (opts.reportCallbackBooked) {
          // EXACT match, any status, no engagement-level fallback.
          row.callback_booked = appointments.some((a) => a.confirmedFromAttemptId === attemptId);
        }
        out.push(row);
      }
      return { status: 'ok', examined: out.length, finalized, skipped: 0, sessions: out };
    },

    /** start_phone_assessment's binding rule. */
    startAssessment(sessionId: string): 'ok' | 'session_already_bound' {
      if (engagement.sessionId !== null && engagement.sessionId !== sessionId) {
        return 'session_already_bound';
      }
      engagement.sessionId = sessionId;
      return 'ok';
    },

    /** A minimal Supabase client: the finalize RPC plus the appointment read. */
    client(): SupabaseClient {
      const self = this;
      return {
        rpc(name: string) {
          if (name === 'finalize_phone_partial_sessions') {
            return Promise.resolve({ data: self.finalizeWire(), error: null });
          }
          return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
        },
        from(table: string) {
          let attemptFilter: unknown;
          const builder = {
            select() { return builder; },
            eq(column: string, value: unknown) {
              if (column === 'confirmed_from_attempt_id') attemptFilter = value;
              return builder;
            },
            async maybeSingle() {
              if (table !== 'phone_appointments') {
                return { data: null, error: { message: `unexpected table ${table}` } };
              }
              const hit = appointments.find((a) => a.confirmedFromAttemptId === attemptFilter);
              return { data: hit ? { id: hit.id } : null, error: null };
            },
          };
          return builder;
        },
      } as unknown as SupabaseClient;
    },

    /** The due-pass reader, answering from the model. */
    reader(): PhoneRuntimeReader {
      return {
        async listDueEngagements() {
          if (engagement.state !== 'scheduled' || engagement.terminalAt !== null) return [];
          return [{
            engagementId: ENGAGEMENT,
            state: 'scheduled',
            candidateId: CANDIDATE,
            roleId: ROLE,
            sessionId: engagement.sessionId,
            nextEligibleAt: null,
            noAnswerAttempts: 0,
            updatedAt: null,
          }];
        },
        async listDialableNumbers() {
          return new Map([[CANDIDATE, wrapDialableNumber(DIALABLE)]]);
        },
        async readSessionForReuse(input: { sessionId: string }) {
          const s = sessions.get(input.sessionId);
          return s === undefined
            ? null
            : { status: s.status, roomVerified: s.externalCallId === phoneRoomName(input.sessionId) };
        },
        async findSessionForEngagement(input: { engagementId: string }) {
          for (const [id, s] of sessions) {
            if (
              s.phoneEngagementId === input.engagementId
              && (s.status === 'created' || s.status === 'waiting')
              && s.externalCallId === phoneRoomName(id)
            ) return id;
          }
          return null;
        },
        async findUnprovisionedSessionForEngagement() { return null; },
        async countLiveEngagements() { return 1; },
        async findReusableSession() { return null; },
        async engagementOwningSession() { return null; },
        consent: {
          async latestConsentRecord() { return null; },
          async activeConsentTemplate() { return null; },
        },
      } as unknown as PhoneRuntimeReader;
    },

    /** The session writer, enforcing the live-only claim index (PR-A, 0112). */
    writer(): PhoneSessionWriter {
      return {
        async createSession(fields) {
          const claim = (fields as { phone_engagement_id?: string }).phone_engagement_id ?? null;
          const clash = [...sessions.values()].some(
            (s) => claim !== null && s.phoneEngagementId === claim && LIVE.has(s.status),
          );
          if (clash) {
            return { data: null, error: { pgCode: '23505' } } as unknown as Awaited<
              ReturnType<PhoneSessionWriter['createSession']>
            >;
          }
          sessions.set(SLOT_SESSION, { status: 'created', phoneEngagementId: claim, externalCallId: null });
          const row: SessionRow = {
            id: SLOT_SESSION,
            status: 'created',
            terminal_reason: null,
            started_at: PASS_NOW.toISOString(),
            ended_at: null,
            waiting_at: null,
            candidate_id: CANDIDATE,
            role_id: ROLE,
          };
          return { data: row, error: null } as Awaited<ReturnType<PhoneSessionWriter['createSession']>>;
        },
        async transitionSession(id, from, to, _reason, extra) {
          const s = sessions.get(id);
          if (s === undefined || s.status !== from) {
            return { ok: false, conflict: true } as Awaited<
              ReturnType<PhoneSessionWriter['transitionSession']>
            >;
          }
          s.status = to;
          const ext = (extra as { external_call_id?: string } | undefined)?.external_call_id;
          if (ext !== undefined) s.externalCallId = ext;
          return { ok: true } as Awaited<ReturnType<PhoneSessionWriter['transitionSession']>>;
        },
      };
    },
  };
}

type Db = ReturnType<typeof makeDb>;

function screeningConfig(): PhoneScreeningConfig {
  return {
    ...loadPhoneScreeningConfig({} as NodeJS.ProcessEnv),
    screeningEnabled: true,
    runtimeEnabled: true,
    dialMode: 'synthetic',
  };
}

/** Every store method a runtime loop may reach, stubbed harmless — except finalize. */
function runtimeStores(db: Db): PhoneStores {
  const real = createPhoneStores(db.client());
  return {
    async backlog() {
      return { status: 'ok', admission: { controlPresent: true, halted: false, haltReason: null } };
    },
    async reclaimAttemptLeases() { return { status: 'ok', reclaimed: 0 }; },
    async expireAppointments() { return { status: 'ok', expired: 0 }; },
    async claimSweep() { return { status: 'ok' as const }; },
    async sweepDayRolled() { return { status: 'ok' as const, examined: 0, rolled: 0, skipped: 0 }; },
    async sweepStrandedSessions() {
      return { status: 'ok' as const, examined: 0, completed: 0, failed: 0, skipped: 0 };
    },
    async sweepStrandedRecordings() {
      return { status: 'ok' as const, examined: 0, finalized: 0, skipped: 0 };
    },
    async sweepSameDayRetry() {
      return { status: 'ok' as const, examined: 0, released: 0, skipped: 0 };
    },
    async applyEvent() { return { status: 'applied' as const, applied: true }; },
    finalizePartialSessions: real.finalizePartialSessions,
  } as unknown as PhoneStores;
}

function recordingQueue(jobs: Array<{ name: string; payload: unknown }>): Queue {
  return {
    async enqueue(name: string, payload: unknown) {
      jobs.push({ name, payload });
      return { id: 'job', name, payload } as never;
    },
    async claim() { return null; },
    async completeClaim() { return true; },
    async failClaim() { return 'failed'; },
    async heartbeat() { return true; },
    async deferClaim() { return 'deferred'; },
  } as unknown as Queue;
}

const live: PhoneRuntimeHandle[] = [];

/** Run the real partial-finalize tick once against the model. */
async function runFinalizeTick(db: Db): Promise<Array<{ name: string; payload: unknown }>> {
  const jobs: Array<{ name: string; payload: unknown }> = [];
  let finalized = false;
  const stores = runtimeStores(db);
  const realFinalize = stores.finalizePartialSessions!;
  (stores as { finalizePartialSessions: typeof realFinalize }).finalizePartialSessions =
    async (input) => {
      const r = await realFinalize(input);
      finalized = true;
      return r;
    };
  const handle = createPhoneRuntime({
    config: screeningConfig(),
    runtimeConfig: {
      dueMs: 600_000,
      reclaimMs: 600_000,
      reconcileMs: 600_000,
      expireMs: 1_000,
      dueLimit: 3,
      reclaimLimit: 25,
      jobLeaseSeconds: 60,
      partialFinalizeGraceSec: 180,
    },
    client: {} as never,
    queue: recordingQueue(jobs),
    stores,
    // The runtime's OWN due loop must find nothing: its session port would
    // reach the real writer. The slot dial is driven explicitly below.
    reader: { ...db.reader(), async listDueEngagements() { return []; } } as PhoneRuntimeReader,
    owner: 'phone-callback-leg-test',
    scheduler: { random: () => 0.5 },
  });
  expect(handle).not.toBeNull();
  live.push(handle!);
  handle!.scheduler.start();
  await vi.advanceTimersByTimeAsync(1_000);
  for (let i = 0; i < 500 && !finalized; i++) await Promise.resolve();
  // Let the loop body after the RPC finish too.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await handle!.stop();
  live.splice(live.indexOf(handle!), 1);
  expect(finalized).toBe(true);
  return jobs;
}

async function runDuePass(db: Db) {
  const dials: Array<{ sessionId: string; kind: string }> = [];
  const unavailable: PhoneSessionUnavailable[] = [];
  const result = await runPhoneDuePass(
    {
      config: screeningConfig(),
      reader: db.reader(),
      stores: {
        async backlog() {
          return { status: 'ok', admission: { controlPresent: true, halted: false, haltReason: null } };
        },
      } as never,
      sessions: createPhoneSessionPort(db.reader(), db.writer(), (e) => { unavailable.push(e); }),
      dialer: {
        async dial(input) {
          dials.push({ sessionId: input.sessionId, kind: input.kind });
          return { status: 'dialing' };
        },
      },
      liveAppointmentStart: async () => db.appointments.find((a) => a.status === 'confirmed')?.startsAt ?? null,
    },
    { now: PASS_NOW, limit: 5, clock: () => PASS_NOW },
  );
  return { result, dials, unavailable };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T05:58:00.000Z'));
});

afterEach(async () => {
  clearPhoneRuntimeRegistration();
  clearPhoneRuntimeStartFailure();
  while (live.length > 0) await live.pop()!.stop();
  vi.useRealTimers();
});

describe('0113 (E4) — confirm, then finalize, then the slot dial (doubles)', () => {
  it('the callback leg is never scored and the slot dial mints a FRESH session that binds', async () => {
    const db = makeDb({ detachOnConfirm: true, reportCallbackBooked: true });

    // 1. The candidate confirms a callback on the live leg.
    expect(db.confirm(LEG_ATTEMPT, SLOT_START).status).toBe('ok');
    expect(db.engagement.state).toBe('scheduled');
    expect(db.engagement.sessionId).toBeNull();
    expect(db.sessions.get(LEG_SESSION)!.phoneEngagementId).toBeNull();
    expect(db.audit.at(-1)).toMatchObject({ session_detached: true, claim_released: true });

    // 2. The partial-finalize tick finalizes the leg but queues NO scoring.
    const jobs = await runFinalizeTick(db);
    expect(db.sessions.get(LEG_SESSION)!.status).toBe('completed');
    expect(jobs).toHaveLength(0);

    // 2b. Belt: a phone.assessment job for that leg queued before the deploy
    //     is dropped by the handler without scoring or posting.
    let scored = 0;
    const handler = createPhoneAssessmentHandler({
      client: db.client(),
      score: async () => { scored += 1; },
    });
    await handler({
      payload: {
        session_id: LEG_SESSION, attempt_id: LEG_ATTEMPT,
        partial: true, covered: 2, total: 5, disconnect_reason: 'candidate_hangup',
      },
    } as never);
    expect(scored).toBe(0);
    expect(db.engagement.state).toBe('scheduled');
    expect(db.engagement.terminalAt).toBeNull();

    // 3. At the slot, the due pass asks for a session with NO existing id and
    //    gets a NEW one — the released claim lets the live-only index admit it.
    const { result, dials, unavailable } = await runDuePass(db);
    expect(unavailable).toEqual([]);
    expect(result.skipped).toEqual({});
    expect(dials).toEqual([{ sessionId: SLOT_SESSION, kind: 'scheduled' }]);
    expect(SLOT_SESSION).not.toBe(LEG_SESSION);
    expect(db.sessions.get(SLOT_SESSION)).toMatchObject({
      status: 'waiting',
      phoneEngagementId: ENGAGEMENT,
      externalCallId: phoneRoomName(SLOT_SESSION),
    });

    // 4. start_phone_assessment binds the fresh session.
    expect(db.startAssessment(SLOT_SESSION)).toBe('ok');
    expect(db.engagement.sessionId).toBe(SLOT_SESSION);
  });

  it('a confirm replay is idempotent: no second detach, the same appointment', () => {
    const db = makeDb({ detachOnConfirm: true, reportCallbackBooked: true });
    const first = db.confirm(LEG_ATTEMPT, SLOT_START);
    const version = db.engagement.version;
    const replay = db.confirm(LEG_ATTEMPT, SLOT_START);
    expect(replay.appointmentId).toBe(first.appointmentId);
    expect(replay.replay).toBe(true);
    expect(db.engagement.version).toBe(version);
    expect(db.appointments).toHaveLength(1);
  });

  it('CONTRAST (pre-0113 shape): without the detach the leg is queued and the slot dial is no_session', async () => {
    // The same script against 0073's confirm and 0095's finalize. This is the
    // failure the migration removes — kept so a regression reads as itself.
    const db = makeDb({ detachOnConfirm: false, reportCallbackBooked: false });
    db.confirm(LEG_ATTEMPT, SLOT_START);
    expect(db.engagement.sessionId).toBe(LEG_SESSION);

    const jobs = await runFinalizeTick(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ session_id: LEG_SESSION, attempt_id: LEG_ATTEMPT });

    const { result, dials, unavailable } = await runDuePass(db);
    expect(dials).toHaveLength(0);
    expect(result.skipped).toEqual({ no_session: 1 });
    expect(unavailable.map((e) => e.reason)).toEqual(['existing_terminal']);
    expect(db.startAssessment(SLOT_SESSION)).toBe('session_already_bound');
  });
});
