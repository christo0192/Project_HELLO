/**
 * Shared fixture for the R1 candidate-route suites: a seeded in-memory
 * database whose RPC doubles reproduce the documented behaviour of
 * `r1_admit_attempt`, `r1_reserve_preflight` and `r1_withdraw_consent`, plus
 * fakes for the LiveKit room API, the browser worker gate and DeepSeek health.
 *
 * The router under test is the real one; only its edges are replaced.
 */

import { createHash } from 'node:crypto';
import express from 'express';
import { vi } from 'vitest';
import type { BrowserWorkerGate } from '../../lib/browser-orchestration.js';
import type { DispatchLike } from '../../lib/r1/worker-gate.js';
import type { R1CandidateDeps, R1RoomClient } from '../../routes/r1-candidate.js';
import { createR1CandidateRouter } from '../../routes/r1-candidate.js';
import { r1MeetTicketDigest } from '../../lib/r1/meet/ticket.js';
import {
  createFakeDb,
  type FakeDb,
  type FakeDbOptions,
  type Row,
  type Tables,
} from './r1-candidate-fake-db.js';

export const ROUND = '20000000-0000-4000-8000-0000000000a1';
export const CANDIDATE = '10000000-0000-4000-8000-0000000000b1';
export const ROLE = '10000000-0000-4000-8000-0000000000c1';
export const TEMPLATE = '40000000-0000-4000-8000-0000000000d1';
export const OLD_TEMPLATE = '40000000-0000-4000-8000-0000000000d0';
export const SESSION = '30000000-0000-4000-8000-0000000000e1';
export const LINK = 'a1'.repeat(32);
export const NOW = Date.parse('2030-01-01T00:00:00.000Z');
export const REQUIRED = ['ai_interview', 'recording', 'ai_evaluation'];
export const WORKER_SECRET = 'w'.repeat(40);

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

export function seedTables(): Tables {
  return {
    interview_rounds: [{
      id: ROUND,
      candidate_id: CANDIDATE,
      role_id: ROLE,
      status: 'invited',
      expires_at: new Date(NOW + 72 * 3600_000).toISOString(),
      attempts_allowed: 2,
      attempts_counted: 0,
      starts_used: 0,
      // The server-owned notice audience (migration 0120): the candidate notice by default.
      consent_locale: 'en-IN',
      link_token_digest: sha256(LINK),
    }],
    candidates: [{ id: CANDIDATE, name: 'Ava Candidate', resume_text: 'private resume text' }],
    roles: [{ id: ROLE, title: 'Sales Program Advisor', interview_kind: 'sales_r1' }],
    r1_settings: [{ singleton: true, enabled: true, paused: false, livekit_target: 'cloud' }],
    interview_round_consent_templates: [
      {
        id: OLD_TEMPLATE,
        version: '001',
        locale: 'en-IN',
        title: 'Old notice',
        body_md: 'old',
        required_consents: ['ai_interview'],
        is_active: false,
      },
      {
        id: TEMPLATE,
        version: '002',
        locale: 'en-IN',
        title: 'R1 notice',
        body_md: '# R1\nNotice body',
        required_consents: REQUIRED,
        is_active: true,
      },
    ],
    interview_round_consents: [],
    call_sessions: [],
    interview_round_attempts: [],
    r1_usage_ledger: [],
    audit_events: [],
  };
}

/** Add a live, valid consent for the seeded round. */
export function grantConsent(tables: Tables, over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `consent-${tables.interview_round_consents!.length + 1}`,
    round_id: ROUND,
    template_id: TEMPLATE,
    consents: [...REQUIRED],
    proof: { decision: 'granted' },
    granted_at: new Date(NOW - 60_000).toISOString(),
    withdrawn_at: null,
    ...over,
  };
  tables.interview_round_consents!.push(row);
  return row;
}

export function addSession(tables: Tables, over: Partial<Row> = {}): Row {
  const row: Row = {
    id: SESSION,
    candidate_id: CANDIDATE,
    status: 'created',
    external_call_id: `screening-${SESSION}`,
    interview_round_id: ROUND,
    mode: 'browser',
    ...over,
  };
  tables.call_sessions!.push(row);
  return row;
}

export function addAttempt(tables: Tables, nonce: string, over: Partial<Row> = {}): Row {
  const row: Row = {
    session_id: SESSION,
    round_id: ROUND,
    attempt_number: 1,
    nonce_digest: sha256(nonce),
    outcome: null,
    ...over,
  };
  tables.interview_round_attempts!.push(row);
  return row;
}

const LIVE = ['created', 'waiting', 'in_progress'];

/** The documented behaviour of the three DB functions, over the fake tables. */
export function rpcDoubles(tables: Tables, ids: () => string) {
  return {
    r1_admit_attempt: (args: { p_round_id: string; p_nonce_digest: string }) => {
      const round = tables.interview_rounds!.find((r) => r.id === args.p_round_id);
      if (!round) return { status: 'round_not_found' };
      const consented = tables.interview_round_consents!.some(
        (c) => c.round_id === round.id && !c.withdrawn_at,
      );
      if (!consented) return { status: 'consent_missing' };
      // 0131's limit: least(max_concurrent_sessions, browser pool, floor 1) on the self-hosted
      // target, 1 on Cloud. Above 1 the round's own live session answers round_live first.
      const settings = tables.r1_settings?.[0] ?? {};
      const pool = (tables.voice_worker_leases ?? []).filter(
        (l) => l.app === 'project-hello-voice' && l.pipeline === 'browser',
      ).length;
      const limit = settings.livekit_target === 'r1'
        ? Math.min(settings.max_concurrent_sessions ?? 1, Math.max(pool, 1))
        : 1;
      const live = tables.call_sessions!.filter((s) => s.interview_round_id && LIVE.includes(s.status));
      if (limit > 1 && live.some((s) => s.interview_round_id === round.id)) {
        return { status: 'round_live' };
      }
      if (live.length >= limit) return { status: 'r1_in_flight' };
      if (round.starts_used >= 3) return { status: 'starts_exhausted' };
      const sessionId = ids();
      tables.call_sessions!.push({
        id: sessionId,
        candidate_id: round.candidate_id,
        status: 'created',
        external_call_id: `screening-${sessionId}`,
        interview_round_id: round.id,
        mode: 'browser',
      });
      round.starts_used += 1;
      round.status = 'in_progress';
      tables.interview_round_attempts!.push({
        session_id: sessionId,
        round_id: round.id,
        attempt_number: round.attempts_counted + 1,
        persona_id: 'p3_data_analyst',
        nonce_digest: args.p_nonce_digest,
        outcome: null,
      });
      return {
        status: 'ok',
        session_id: sessionId,
        attempt_number: round.attempts_counted + 1,
        persona_id: 'p3_data_analyst',
      };
    },
    r1_reserve_preflight: (args: { p_round_id: string; p_event_key: string }) => {
      const used = tables.r1_usage_ledger!.filter(
        (l) => l.round_id === args.p_round_id && l.participant_kind === 'preflight',
      );
      if (used.length >= 10) return { status: 'preflight_limit' };
      const recent = used.filter((l) => l.occurred_at > NOW - 60_000);
      if (recent.length >= 3) return { status: 'preflight_rate_limited' };
      tables.r1_usage_ledger!.push({
        round_id: args.p_round_id,
        session_id: null,
        participant_kind: 'preflight',
        event: 'usage',
        seconds: 10,
        event_key: args.p_event_key,
        occurred_at: NOW,
      });
      return { status: 'ok', remaining: 9 - used.length };
    },
    r1_withdraw_consent: (args: {
      p_round_id: string;
      p_proof?: Row;
      p_decision?: string;
    }) => {
      const decision = args.p_decision ?? 'withdrawn';
      if (decision !== 'withdrawn' && decision !== 'declined') {
        return { status: 'invalid_decision' };
      }
      let withdrawn = 0;
      for (const row of tables.interview_round_consents!) {
        if (row.round_id === args.p_round_id && !row.withdrawn_at) {
          row.withdrawn_at = new Date(NOW).toISOString();
          // The grant evidence stays; the request context nests under `withdrawal`.
          row.proof = {
            ...(row.proof ?? {}),
            decision,
            withdrawn_at: new Date(NOW).toISOString(),
            withdrawal: args.p_proof ?? {},
          };
          withdrawn += 1;
        }
      }
      const live = tables.call_sessions!
        .filter((s) => s.interview_round_id === args.p_round_id && LIVE.includes(s.status))
        .map((s) => ({ session_id: s.id, status: s.status }));
      return { status: 'ok', withdrawn, live_sessions: live };
    },
    // M034 S05: the Meet bridge's two booking RPCs, as migration 0142 sections 17 and 15 define
    // them (the first refusal wins, in the SQL's order; the same writes; the same answers).
    r1_meet_claim_ticket: (args: { p_ticket_digest?: unknown; p_now?: unknown }) => {
      if (typeof args.p_ticket_digest !== 'string' || !/^[a-f0-9]{64}$/.test(args.p_ticket_digest)) {
        return { status: 'invalid_ticket' };
      }
      if (typeof args.p_now !== 'string') return { status: 'invalid_request', field: 'now' };
      const nowMs = Date.parse(args.p_now);
      const booking = (tables.r1_meet_bookings ?? []).find((b) => b.ticket_digest === args.p_ticket_digest);
      if (!booking) return { status: 'ticket_unknown' };
      if (booking.ticket_claimed_at) return { status: 'ticket_already_claimed', booking_id: booking.id };
      if (!MEET_CLAIMABLE.includes(booking.status)) {
        return { status: 'booking_not_claimable', booking_id: booking.id, booking_status: booking.status };
      }
      if (nowMs < Date.parse(booking.ticket_not_before)) {
        return { status: 'ticket_not_yet_valid', booking_id: booking.id };
      }
      if (nowMs >= Date.parse(booking.ticket_expires_at)) return { status: 'ticket_expired', booking_id: booking.id };
      const round = tables.interview_rounds!.find((r) => r.id === booking.round_id);
      if (
        !round
        || round.channel !== 'meet'
        || !['invited', 'in_progress'].includes(round.status)
        || Date.parse(round.expires_at) <= nowMs
      ) {
        return { status: 'round_not_live', booking_id: booking.id, round_id: booking.round_id };
      }
      booking.ticket_claimed_at = args.p_now;
      booking.status = 'in_call';
      booking.reason = 'eligible';
      booking.updated_at = args.p_now;
      return {
        status: 'ok',
        booking_id: booking.id,
        round_id: booking.round_id,
        candidate_id: booking.candidate_id,
        objective_profile: booking.objective_profile,
        ashby_interview_event_id: booking.ashby_interview_event_id,
        session_id: booking.session_id,
        start_at: booking.start_at,
        end_at: booking.end_at,
      };
    },
    r1_meet_bind_session: (args: { p_booking_id?: unknown; p_session_id?: unknown; p_now?: unknown }) => {
      if (typeof args.p_now !== 'string') return { status: 'invalid_request', field: 'now' };
      const booking = (tables.r1_meet_bookings ?? []).find((b) => b.id === args.p_booking_id);
      if (!booking) return { status: 'not_found' };
      if (booking.status !== 'in_call') {
        return { status: 'not_in_call', booking_id: booking.id, booking_status: booking.status };
      }
      const session = tables.call_sessions!.find((s) => s.id === args.p_session_id);
      if (!session || !session.interview_round_id || session.interview_round_id !== booking.round_id) {
        return { status: 'session_mismatch', booking_id: booking.id };
      }
      if (booking.session_id === args.p_session_id) {
        return { status: 'duplicate', booking_id: booking.id, session_id: booking.session_id };
      }
      const previous = booking.session_id ?? null;
      booking.session_id = args.p_session_id;
      booking.updated_at = args.p_now;
      return { status: 'ok', booking_id: booking.id, session_id: args.p_session_id, previous_session_id: previous };
    },
  };
}

// ── M034 S05: the Meet bridge exchange ──────────────────────────────────

/** The booking statuses a ticket may be claimed in (0142 section 17). */
const MEET_CLAIMABLE = ['bot_scheduled', 'bot_joining', 'human_present', 'in_call'];

/** A version-4 booking id. */
export const MEET_BOOKING = '70000000-0000-4000-8000-0000000000f2';
/** The HR staff member who scheduled the Dex interview in Ashby (a fixture id, not a real one). */
export const MEET_ATTESTER = '60000000-0000-4000-8000-0000000000f1';
/** The bridge ticket, built at runtime from low-entropy parts (43 characters, the minted length). */
export const MEET_TICKET = 'mt' + 'k'.repeat(41);

/** The stored digest of `ticket`, computed by the real lib under the harness worker secret. */
export function meetTicketDigest(ticket: string = MEET_TICKET): string {
  const digest = r1MeetTicketDigest(ticket, { WORKER_CONTEXT_SECRET: WORKER_SECRET });
  if (digest === null) throw new Error('harness: the Meet ticket does not digest');
  return digest;
}

/** Make the seeded round a Meet round with its HR-attested consent (0142 sections 1 and 2). */
export function seedMeetRound(tables: Tables): Tables {
  tables.interview_rounds![0]!.channel = 'meet';
  grantConsent(tables, {
    method: 'hr_attested_ashby',
    attested_by_external_id: MEET_ATTESTER,
    attested_at: new Date(NOW - 3_600_000).toISOString(),
    india_location_attested: true,
    template_id: TEMPLATE,
  });
  return tables;
}

/**
 * An armed booking of the seeded round: a human is in the Meet, the slot is now-1 min .. now+40
 * min, the ticket window now-5 min .. now+55 min, the ticket unclaimed and no session bound.
 */
export function addMeetBooking(tables: Tables, over: Partial<Row> = {}): Row {
  const row: Row = {
    id: MEET_BOOKING,
    ashby_interview_event_id: '71000000-0000-4000-8000-0000000000f3',
    ashby_schedule_id: '72000000-0000-4000-8000-0000000000f4',
    ashby_application_id: '73000000-0000-4000-8000-0000000000f5',
    ashby_scheduled_by_user_id: MEET_ATTESTER,
    candidate_id: CANDIDATE,
    round_id: ROUND,
    objective_profile: 'r1_dex_sales',
    status: 'human_present',
    reason: 'eligible',
    version: 0,
    key_attempt: 0,
    meet_url: 'https://meet.google.com/abc-defg-hij',
    start_at: new Date(NOW - 60_000).toISOString(),
    end_at: new Date(NOW + 40 * 60_000).toISOString(),
    recall_bot_id: '74000000-0000-4000-8000-0000000000f6',
    ticket_digest: meetTicketDigest(),
    ticket_not_before: new Date(NOW - 5 * 60_000).toISOString(),
    ticket_expires_at: new Date(NOW + 55 * 60_000).toISOString(),
    ticket_claimed_at: null,
    ticket_arms: 1,
    session_id: null,
    created_at: new Date(NOW - 3_600_000).toISOString(),
    updated_at: new Date(NOW - 120_000).toISOString(),
    ...over,
  };
  (tables.r1_meet_bookings ??= []).push(row);
  return row;
}

export interface Harness {
  app: express.Express;
  db: FakeDb;
  tables: Tables;
  rooms: R1RoomClient & {
    createRoom: ReturnType<typeof vi.fn>;
    deleteRoom: ReturnType<typeof vi.fn>;
    updateRoomMetadata: ReturnType<typeof vi.fn>;
    listParticipants: ReturnType<typeof vi.fn>;
    sendData: ReturnType<typeof vi.fn>;
  };
  gate: BrowserWorkerGate & {
    ensureReadyWorker: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
    releaseWorker: ReturnType<typeof vi.fn>;
  };
  /** What LiveKit lists for the room: every dispatch the gate or a test made. */
  dispatched: DispatchLike[];
  deleteDispatch: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
  scheduled: Array<{ work: () => void; delayMs: number }>;
}

let uuidCounter = 0;
let dispatchCounter = 0;

/** An epoch-nanosecond `createdAt` `ageMs` before the harness clock, as LiveKit writes it. */
export function dispatchCreatedAt(ageMs: number): bigint {
  return BigInt(NOW - ageMs) * 1_000_000n;
}

/** A dispatch a worker has accepted (it has a job): the interviewer is running. */
export function runningDispatch(over: Partial<DispatchLike> = {}): DispatchLike {
  dispatchCounter += 1;
  return {
    id: `AD_${dispatchCounter}`,
    agentName: 'browser-screener',
    state: { jobs: [{ id: `AJ_${dispatchCounter}` }], createdAt: dispatchCreatedAt(60_000) },
    ...over,
  };
}

/** A dispatch no worker has picked up, created `ageMs` ago. */
export function joblessDispatch(ageMs: number, over: Partial<DispatchLike> = {}): DispatchLike {
  dispatchCounter += 1;
  return {
    id: `AD_${dispatchCounter}`,
    agentName: 'browser-screener',
    state: { jobs: [], createdAt: dispatchCreatedAt(ageMs) },
    ...over,
  };
}

/** Deterministic version-4 UUIDs, so transitionSession's id check accepts them. */
export function nextUuid(): string {
  uuidCounter += 1;
  return `50000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

export function buildHarness(
  tables: Tables = seedTables(),
  overrides: Partial<R1CandidateDeps> = {},
  gateEnabled = true,
  /** table -> error returned for EVERY operation on that table (and only that table). */
  failures: FakeDbOptions['failures'] = undefined,
): Harness {
  const db = createFakeDb({
    tables,
    ...(failures ? { failures } : {}),
    rpc: rpcDoubles(tables, nextUuid),
    unique: {
      // uq_interview_round_consents_live_round
      interview_round_consents: (existing, candidate) =>
        !candidate.withdrawn_at
        && existing.some((row) => row.round_id === candidate.round_id && !row.withdrawn_at),
    },
  });
  const rooms = {
    createRoom: vi.fn(async () => ({})),
    updateRoomMetadata: vi.fn(async () => ({})),
    deleteRoom: vi.fn(async () => ({})),
    // The "I'm ready" relay: the room holds the candidate (kind 0) and the interviewer (AGENT = 4).
    listParticipants: vi.fn(async () => [
      { identity: 'candidate-10000000-30000000', kind: 0 },
      { identity: 'agent-AJ_test', kind: 4 },
    ]),
    sendData: vi.fn(async () => undefined),
  } as unknown as Harness['rooms'];
  const dispatched: DispatchLike[] = [];
  const deleteDispatch = vi.fn(async (id: string) => {
    const at = dispatched.findIndex((item) => item.id === id);
    if (at >= 0) dispatched.splice(at, 1);
  });
  const gate = {
    app: 'project-hello-voice',
    agentName: 'browser-screener',
    ensureReadyWorker: vi.fn(async () => ({
      status: 'ready',
      machineId: 'machine-1',
      epoch: 1,
      agentName: 'browser-screener',
    })),
    dispatch: vi.fn(async () => {
      dispatched.push(runningDispatch());
      return true;
    }),
    releaseWorker: vi.fn(async () => undefined),
  } as unknown as Harness['gate'];
  const health = vi.fn(async () => true);
  const scheduled: Harness['scheduled'] = [];
  const router = createR1CandidateRouter({
    db: db as unknown as R1CandidateDeps['db'],
    now: () => NOW,
    uuid: nextUuid,
    rooms: () => rooms,
    dispatches: () => ({ listDispatch: async () => [...dispatched], deleteDispatch }),
    resolveGate: () => (gateEnabled ? gate : null),
    // The Cloud-fallback guard refuses R1 on Cloud while the legacy browser lane is
    // enabled; the default fixture is the retired-legacy configuration (production's).
    legacyBrowserEnabled: () => false,
    health,
    maintenance: async () => ({ ok: true, enabled: false, reason: null, updatedAt: null }),
    schedule: (work, delayMs) => {
      scheduled.push({ work, delayMs });
    },
    ...overrides,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/r1', router);
  return { app, db, tables, rooms, gate, dispatched, deleteDispatch, health, scheduled };
}
