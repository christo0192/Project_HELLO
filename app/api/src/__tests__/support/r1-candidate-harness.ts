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
      if (tables.call_sessions!.some((s) => s.interview_round_id && LIVE.includes(s.status))) {
        return { status: 'r1_in_flight' };
      }
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
  };
}

export interface Harness {
  app: express.Express;
  db: FakeDb;
  tables: Tables;
  rooms: R1RoomClient & {
    createRoom: ReturnType<typeof vi.fn>;
    deleteRoom: ReturnType<typeof vi.fn>;
    updateRoomMetadata: ReturnType<typeof vi.fn>;
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
