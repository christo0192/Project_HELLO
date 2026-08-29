/**
 * P8B — the health-verdict and fail-closed GATE.
 *
 * Canary-0 rehearses the substrate. This file rehearses the OPERATOR SURFACE:
 * what `/api/phone/health` and `phoneRuntimeView` say in each state, and what
 * `runPhoneDuePass` does when the kill switch cannot be read. Those two are
 * the only things an operator has during an incident, so a change that turns a
 * fault into a healthy zero has to fail here.
 *
 * ── WHY A SEPARATE FILE, GIVEN THE OVERLAP ────────────────────────────
 * Parts of this are DELIBERATE RESTATEMENT. `phone-runtime-loops.test.ts` §F
 * already covers the `start_failed` exclusivity, its degrade-reason table
 * covers `phone_due_halted` / `phone_sweep_not_ok`, `phone-api-route.test.ts`
 * §6 covers the route's three branches, and `phone-runtime-core.test.ts`
 * covers the three halt shapes. Those files are organised around the UNIT
 * they test; this one is organised around the PROMISE P8B makes — "off is
 * healthy, broken is degraded, unreadable is a stop" — and a promise stated in
 * four places is a promise that can be half-deleted without anything going
 * red.
 *
 * So every restated assertion is marked RESTATED and strengthened where the
 * original was weaker (the halted due pass is asserted as a whole shape rather
 * than field by field; the `last_*` nulls are asserted individually with
 * `toBeNull`), and the genuinely new ones are marked NEW.
 *
 * No network, no database, no real Supabase client.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createPhoneApiRouter, type PhoneApiDeps } from '../routes/phone.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import {
  armPhoneRuntime,
  clearPhoneRuntimeRegistration,
  clearPhoneRuntimeStartFailure,
  phoneRuntimeDegradeReasons,
  phoneRuntimeView,
  recordPhoneRuntimeStartFailure,
  registerPhoneRuntime,
} from '../lib/phone-runtime/health.js';
import type {
  PhoneRuntimeHandle,
  PhoneRuntimeSnapshot,
} from '../lib/phone-runtime/runtime.js';
import {
  PHONE_ADMISSION_REFUSAL_DETAILS,
  runPhoneDuePass,
  type PhoneDialPort,
  type PhoneDueDeps,
  type PhoneSessionPort,
} from '../lib/phone-runtime/due-loop.js';
import type { DuePhoneEngagement, PhoneRuntimeReader } from '../lib/phone-runtime/read.js';
import {
  PHONE_MAX_CONCURRENT,
  type PhoneReadStore,
  type PhoneScreeningConfig,
  type PhoneStores,
} from '../lib/phone-screening/index.js';
import { functionStatuses } from './support/phone-migration.js';

// ═══════════════════════════════════════════════════════════════════════
//  Fixtures
// ═══════════════════════════════════════════════════════════════════════

/** 11:30 IST — inside the 09:00–21:00 calling window, so the window gate passes. */
const NOW = new Date('2026-09-01T06:00:00.000Z');

const UUID_E = '22222222-2222-4222-8222-222222222222';

const HEALTHY_BACKLOG = {
  status: 'ok' as const,
  admission: { controlPresent: true, halted: false, haltReason: null },
  engagementsByState: { eligible: 3 },
  attempts: {
    live: 1,
    liveWithUnexpiredLease: 1,
    maxConcurrent: PHONE_MAX_CONCURRENT,
    oldestLiveAgeSeconds: 9,
  },
  appointments: { live: 1, overdue: 0 },
  events: {
    ignoredLast24h: 0,
    unknownAttemptLast24h: 0,
    staleEpochLast24h: 0,
    terminalLast24h: 0,
    unexpectedEventLast24h: 0,
  },
  windowOpen: true,
  istDate: '2026-09-01',
};

type BacklogResult = Awaited<ReturnType<PhoneStores['backlog']>>;

/**
 * A read store that throws on every call.
 *
 * `GET /api/phone/health` reads only the WRITE store's `backlog`. A read store
 * that answered politely would hide a health handler that had quietly started
 * reading a projection, so this one fails loudly instead.
 */
function explodingReadStore(): PhoneReadStore {
  const explode = () => { throw new Error('health must not read a projection'); };
  return new Proxy({} as PhoneReadStore, { get: () => explode });
}

/** Only `backlog` is ever called; every other RPC throws if the surface reaches it. */
function healthStores(backlog: () => Promise<BacklogResult>): PhoneStores {
  const explode = () => { throw new Error('health must not call an RPC'); };
  return new Proxy({ backlog } as unknown as PhoneStores, {
    get(target, prop: string) {
      if (prop === 'backlog') return (target as unknown as Record<string, unknown>).backlog;
      return explode;
    },
  });
}

function appWith(deps: PhoneApiDeps, env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = {
      id: '66666666-6666-4666-8666-666666666666',
      appRole: 'interviewer',
    };
    next();
  });
  app.use('/api/phone', createPhoneApiRouter({ configSource: env, now: () => NOW, ...deps }));
  return app;
}

/** `PHONE_SCREENING_ENABLED` absent is the shipped production default. */
const DISABLED: NodeJS.ProcessEnv = {};
const ENABLED: NodeJS.ProcessEnv = { PHONE_SCREENING_ENABLED: 'true' };

function health(backlog: () => Promise<BacklogResult>, env = ENABLED) {
  return request(appWith(
    { stores: healthStores(backlog), readStore: explodingReadStore() },
    env,
  )).get('/api/phone/health');
}

/**
 * A registered runtime handle, hand-built. Only `scheduler.health()`,
 * `snapshot()` and `loopIntervalsMs` are consulted by the view; everything
 * else throws, because a fake kinder than production hides a reader we did
 * not intend.
 */
function fakeRuntime(over: {
  running?: boolean;
  lastTickAt?: string | null;
  consecutiveErrors?: number;
  snapshot?: Partial<PhoneRuntimeSnapshot>;
} = {}): PhoneRuntimeHandle {
  const explode = () => { throw new Error('unexpected_runtime_call'); };
  const running = over.running ?? true;
  return {
    config: { due_ms: 15_000 },
    scheduler: {
      running,
      health: () => ({
        running,
        loops: [{
          name: 'phone-due',
          running,
          lastTickAt: over.lastTickAt === undefined ? NOW.toISOString() : over.lastTickAt,
          ticks: 3,
          errors: over.consecutiveErrors ?? 0,
          consecutiveErrors: over.consecutiveErrors ?? 0,
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
      sweepNotOk: {},
      ...over.snapshot,
    }),
    tickAll: explode,
    stop: explode,
  };
}

let originalSink: ReturnType<typeof getAuditSink>;
let audited: AuditEntry[];

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore());
  originalSink = getAuditSink();
  audited = [];
  setAuditSink((entry) => { audited.push(entry); });
});

afterEach(() => {
  // `health.ts` keeps MODULE-GLOBAL state — a registered handle and a
  // start-failure flag — and neither is reset between files by vitest. Both
  // are cleared here, and `registry hygiene` below is the test that fails if
  // this ever stops happening.
  clearPhoneRuntimeRegistration();
  clearPhoneRuntimeStartFailure();
  setAuditSink(originalSink);
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
//  A. `off` is HEALTHY-disabled — never a fault, never a zero
// ═══════════════════════════════════════════════════════════════════════

describe('A. a process with no runtime is off, not broken', () => {
  it('NEW: every sweep count is null, asserted INDIVIDUALLY and as null', () => {
    const v = phoneRuntimeView(NOW);

    expect(v.enabled).toBe(false);
    expect(v.running).toBe(false);
    expect(v.loops).toEqual([]);
    expect(v.last_due).toBeNull();
    expect(v.config).toEqual({});
    expect(v.dial_jobs).toEqual({});
    expect(v.sweeps_not_ok).toEqual([]);
    expect(v.start_failed).toBe(false);

    // `toBeNull`, one field at a time, and deliberately NOT `toBeFalsy`.
    // `0` is falsy, and `0` is the precise lie this surface exists to avoid:
    // "the reclaim sweep ran and found nothing" and "no reclaim sweep has
    // ever run in this process" are opposite operational facts. A matcher
    // that accepted both would let a future edit collapse them silently.
    expect(v.last_reclaimed).toBeNull();
    expect(v.last_expired).toBeNull();
    expect(v.last_reconciled).toBeNull();
    expect(v.last_rolled).toBeNull();
    expect(v.last_stranded).toBeNull();
  });

  it('RESTATED: it contributes EXACTLY no degrade reason', () => {
    // Exact-array, not `not.toContain`. The shipped default is both switches
    // off, so marking every healthy deployment degraded would make the whole
    // surface unreadable — and a reason list that merely lacked one specific
    // code would still allow that.
    expect(phoneRuntimeDegradeReasons(phoneRuntimeView(NOW))).toEqual([]);
  });

  it('NEW: the disabled route branch answers null, never an empty object or a zero', async () => {
    const res = await health(async () => HEALTHY_BACKLOG, DISABLED);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.status).toBe('disabled');
    expect(res.body.reasons).toEqual(['phone_screening_disabled']);

    // Each block individually, because an operator reads them individually.
    // `{}` here would say "no engagements in any state" and `0` would say
    // "nothing is live" — both are claims this branch has not earned, since
    // it never read the database at all.
    expect(res.body.admission).toBeNull();
    expect(res.body.concurrency).toBeNull();
    expect(res.body.engagements_by_state).toBeNull();
    expect(res.body.appointments).toBeNull();
    expect(res.body.ingress).toBeNull();
    // Not "unavailable": the backlog was never attempted, which is a
    // different fact from a backlog that could not be read.
    expect(res.body.backlog_unavailable).toBe(false);
  });

  it('NEW: the disabled branch performs no database work at all', async () => {
    let reads = 0;
    const res = await health(async () => { reads += 1; return HEALTHY_BACKLOG; }, DISABLED);
    expect(res.status).toBe(200);
    // Without this the assertions above are satisfied by a handler that read
    // the backlog and then discarded it — which would still be a query per
    // health poll on every disabled replica in the fleet.
    expect(reads).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  B. `start_failed` is a FAULT, and it is EXCLUSIVE
// ═══════════════════════════════════════════════════════════════════════

describe('B. off and broken must not look the same', () => {
  it('RESTATED: a recorded start failure yields exactly one reason and nothing else', () => {
    recordPhoneRuntimeStartFailure();
    const v = phoneRuntimeView(NOW);

    // The view is otherwise IDENTICAL to the disabled one — same `enabled`,
    // same empty loops, same nulls. `start_failed` is the only field that
    // distinguishes them, which is why it has to carry the whole verdict.
    expect(v.enabled).toBe(false);
    expect(v.running).toBe(false);
    expect(v.loops).toEqual([]);
    expect(v.start_failed).toBe(true);

    // EXACT. `phone_runtime_start_failed` is returned on its own and nothing
    // else is evaluated: a runtime that never constructed has no loops to be
    // stale and no sweeps to have failed, so any other reason would be noise
    // about a process that is not running.
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_runtime_start_failed']);
  });

  it('RESTATED: a successful registration clears the flag', () => {
    recordPhoneRuntimeStartFailure();
    expect(phoneRuntimeView(NOW).start_failed).toBe(true);

    registerPhoneRuntime(fakeRuntime());
    const v = phoneRuntimeView(NOW);
    // A live handle is direct evidence that construction succeeded, so the
    // recorded failure is stale and must not outlive it.
    expect(v.enabled).toBe(true);
    expect(v.start_failed).toBe(false);
    expect(phoneRuntimeDegradeReasons(v)).toEqual([]);
  });

  it('NEW: clearing the REGISTRATION does not clear the FAILURE — deliberately', () => {
    // Shutdown clears the registration. It does not un-break a construction
    // that threw, and a process that failed to arm and then shut down its
    // other lanes is still a process that failed to arm. Pinning this stops
    // a future "tidy up the globals together" edit from making a fault
    // vanish at shutdown.
    recordPhoneRuntimeStartFailure();
    registerPhoneRuntime(fakeRuntime());
    expect(phoneRuntimeView(NOW).start_failed).toBe(false);

    recordPhoneRuntimeStartFailure();
    clearPhoneRuntimeRegistration();
    const v = phoneRuntimeView(NOW);
    expect(v.enabled).toBe(false);
    expect(v.start_failed).toBe(true);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_runtime_start_failed']);
  });

  it('RESTATED: arming a runtime whose scheduler throws returns false and never throws', () => {
    const broken = fakeRuntime();
    (broken.scheduler as unknown as { start: () => void }).start = () => {
      throw new Error('metric name collision');
    };

    // No `expect(...).toThrow` wrapper: the assertion is that the call
    // RETURNS. No lane may prevent the API from serving HTTP, so an arming
    // failure has to be a return value rather than an exception.
    const armed = armPhoneRuntime(broken);

    expect(armed).toBe(false);
    const v = phoneRuntimeView(NOW);
    // Nothing partially-armed stays published.
    expect(v.enabled).toBe(false);
    expect(v.start_failed).toBe(true);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_runtime_start_failed']);
  });

  it('NEW: CONTROL — arming a working runtime registers it and records no failure', () => {
    // Without this the test above passes on an `armPhoneRuntime` that always
    // returns false and always records a failure.
    let started = 0;
    const good = fakeRuntime();
    (good.scheduler as unknown as { start: () => void }).start = () => { started += 1; };

    expect(armPhoneRuntime(good)).toBe(true);
    expect(started).toBe(1);
    const v = phoneRuntimeView(NOW);
    expect(v.enabled).toBe(true);
    expect(v.start_failed).toBe(false);
  });

  it('NEW: registry hygiene — this file leaves the module globals clean', () => {
    // Placed after every test that registers a handle or records a failure.
    // If `afterEach` ever stops clearing both, this reads the leak from the
    // PREVIOUS test and fails — which is the only way a module-global suite
    // can catch its own contamination.
    const v = phoneRuntimeView(NOW);
    expect(v.enabled).toBe(false);
    expect(v.start_failed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  C. halt, unreadable control and sweep errors degrade TRUTHFULLY
// ═══════════════════════════════════════════════════════════════════════

describe('C. an armed runtime reports its faults by name', () => {
  it('RESTATED: a halted due pass degrades as phone_due_halted', () => {
    registerPhoneRuntime(fakeRuntime({
      snapshot: {
        lastDue: {
          status: 'halted', examined: 0, offered: 0, dialing: 0, skipped: {}, refusals: {},
        },
      },
    }));
    const v = phoneRuntimeView(NOW);
    expect(v.last_due?.status).toBe('halted');
    expect(phoneRuntimeDegradeReasons(v)).toContain('phone_due_halted');
  });

  it('RESTATED: a registered but stopped runtime is `stopped`, and NOT also `stale`', () => {
    // `isLoopStale` returns false for a stopped loop BY DESIGN: a loop that
    // is not running is stopped, not stale, and reporting both would be two
    // reasons for one fact.
    registerPhoneRuntime(fakeRuntime({ running: false, lastTickAt: null }));
    const v = phoneRuntimeView(NOW);
    expect(v.enabled).toBe(true);
    expect(v.running).toBe(false);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_runtime_stopped']);
  });

  it('RESTATED: a running loop that has not ticked inside its window is stale', () => {
    registerPhoneRuntime(fakeRuntime({
      running: true,
      lastTickAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    }));
    const v = phoneRuntimeView(NOW);
    expect(v.loops[0].stale).toBe(true);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_loop_stale']);
  });

  it('RESTATED: a loop with consecutive errors is erroring', () => {
    registerPhoneRuntime(fakeRuntime({ running: true, consecutiveErrors: 2 }));
    const v = phoneRuntimeView(NOW);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_loop_erroring']);
  });

  it('NEW: sweeps_not_ok names exactly the failing sweeps, SORTED', () => {
    // Sorted matters because this list is published. An unsorted list is
    // whatever order `Object.entries` happened to produce, which makes two
    // health polls of the same process differ for no reason and makes the
    // field useless for diffing an incident timeline.
    registerPhoneRuntime(fakeRuntime({
      running: true,
      snapshot: {
        lastReclaimed: null,
        lastExpired: null,
        sweepNotOk: { stranded: true, reclaim: true, expire: false, dayroll: true },
      },
    }));
    const v = phoneRuntimeView(NOW);
    expect(v.sweeps_not_ok).toEqual(['dayroll', 'reclaim', 'stranded']);
    // `expire: false` is not a failure and must not appear.
    expect(v.sweeps_not_ok).not.toContain('expire');
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_sweep_not_ok']);
  });

  it('NEW: 0 means "swept, found nothing"; null + a named sweep means "did not sweep"', () => {
    // The two are OPPOSITE operational signals and the count alone cannot
    // carry the difference — which is the entire reason `phone_sweep_not_ok`
    // exists. Both directions are pinned here in one test so neither can be
    // changed without the other being looked at.
    registerPhoneRuntime(fakeRuntime({
      running: true,
      snapshot: { lastReclaimed: 0, sweepNotOk: {} },
    }));
    const swept = phoneRuntimeView(NOW);
    expect(swept.last_reclaimed).toBe(0);
    expect(swept.sweeps_not_ok).toEqual([]);
    expect(phoneRuntimeDegradeReasons(swept)).toEqual([]);

    clearPhoneRuntimeRegistration();
    registerPhoneRuntime(fakeRuntime({
      running: true,
      snapshot: { lastReclaimed: null, sweepNotOk: { reclaim: true } },
    }));
    const notSwept = phoneRuntimeView(NOW);
    expect(notSwept.last_reclaimed).toBeNull();
    expect(notSwept.sweeps_not_ok).toEqual(['reclaim']);
    expect(phoneRuntimeDegradeReasons(notSwept)).toEqual(['phone_sweep_not_ok']);
  });

  it('NEW: CONTROL — a wholly healthy surface is `ok` with an EMPTY reason list', async () => {
    // Without this every degraded assertion in this section could be passing
    // because the surface reports that reason unconditionally.
    const res = await health(async () => HEALTHY_BACKLOG);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.reasons).toEqual([]);
    expect(res.body.backlog_unavailable).toBe(false);
  });

  it('RESTATED: a missing control singleton reads as halt_unreadable AND halted', async () => {
    // 0042 fails closed on an unreadable kill switch, so `phone_backlog`
    // reports a missing singleton as halted; the surface says BOTH, because
    // "somebody pulled the switch" and "the switch cannot be read" call for
    // different actions — the second is a database problem.
    const res = await health(async () => ({
      ...HEALTHY_BACKLOG,
      admission: { controlPresent: false, halted: true, haltReason: 'halt_unreadable' },
    }) as BacklogResult);
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toEqual(['halt_unreadable', 'admission_halted']);
    expect(res.body.admission).toEqual({
      control_present: false, halted: true, halt_reason: 'halt_unreadable',
    });
  });

  it('NEW: an explicit halt degrades as admission_halted alone', async () => {
    const res = await health(async () => ({
      ...HEALTHY_BACKLOG,
      admission: { controlPresent: true, halted: true, haltReason: 'operator_pause' },
    }) as BacklogResult);
    expect(res.body.status).toBe('degraded');
    // Exactly one reason: the control row was perfectly readable.
    expect(res.body.reasons).toEqual(['admission_halted']);
    expect(res.body.admission.halt_reason).toBe('operator_pause');
  });

  it('RESTATED: a backlog read that THROWS degrades with nulls, never a healthy zero', async () => {
    const res = await health(async () => { throw new Error('phone_backlog_error'); });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toEqual(['backlog_unavailable']);
    expect(res.body.backlog_unavailable).toBe(true);
    // "We could not read it" and "there is none" are different answers and
    // only one of them means everything is fine.
    expect(res.body.admission).toBeNull();
    expect(res.body.concurrency).toBeNull();
    expect(res.body.engagements_by_state).toBeNull();
    expect(res.body.appointments).toBeNull();
    expect(res.body.ingress).toBeNull();
  });

  it('NEW: an INCOMPLETE backlog is treated as unreadable, not rendered as empty', async () => {
    // The RPC answered `ok` but one block is absent. Rendering
    // `engagements_by_state` as `{}` would say "no engagements in any state",
    // which is the exact healthy zero every sibling block refuses to emit.
    const partial = { ...HEALTHY_BACKLOG } as Record<string, unknown>;
    delete partial.engagementsByState;
    const res = await health(async () => partial as unknown as BacklogResult);
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toEqual(['backlog_unavailable']);
    expect(res.body.engagements_by_state).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  D. the due pass is FAIL-CLOSED on the halt, three ways
// ═══════════════════════════════════════════════════════════════════════

/** Every seam the pass could touch, counted. "Nothing ran" is only assertable this way. */
interface DueHarness {
  deps: PhoneDueDeps;
  calls: { backlog: number; listDue: number; listNumbers: number; ensureSession: number; dial: number };
}

function dueHarness(over: {
  backlog?: BacklogResult;
  backlogThrows?: boolean;
  due?: readonly DuePhoneEngagement[];
} = {}): DueHarness {
  const calls = { backlog: 0, listDue: 0, listNumbers: 0, ensureSession: 0, dial: 0 };
  const due = over.due ?? [];

  const reader = {
    async listDueEngagements() { calls.listDue += 1; return due; },
    async listDialableNumbers(input: { candidateIds: readonly string[] }) {
      calls.listNumbers += 1;
      const out = new Map<string, unknown>();
      for (const id of input.candidateIds) out.set(id, { e164: '+919999900001' });
      return out as never;
    },
    async findReusableSession() { throw new Error('unexpected_session_lookup'); },
    async countLiveEngagements() { throw new Error('unexpected_live_engagement_count'); },
    async engagementOwningSession() { throw new Error('unexpected_owning_session_read'); },
    async readSessionForReuse() { throw new Error('unexpected_session_reuse_read'); },
    consent: {
      async latestConsentRecord() { throw new Error('unexpected_consent_read'); },
      async activeConsentTemplate() { throw new Error('unexpected_consent_read'); },
    },
  } as unknown as PhoneRuntimeReader;

  const sessions: PhoneSessionPort = {
    async ensureSession(input) { calls.ensureSession += 1; return `session-${input.candidateId}`; },
  };
  const dialer: PhoneDialPort = {
    async dial() { calls.dial += 1; return { status: 'dialing' }; },
  };

  const config: PhoneScreeningConfig = {
    screeningEnabled: true,
    runtimeEnabled: true,
    dialMode: 'synthetic',
    dialAllowlist: [],
    slotSeconds: 1_800,
    reconnectBackoffSeconds: 120,
    ringTimeoutSeconds: 45,
    leaseSeconds: 180,
    webhookMaxBytes: 65_536,
    webhookToleranceSeconds: 300,
  };

  return {
    calls,
    deps: {
      config,
      reader,
      stores: {
        async backlog() {
          calls.backlog += 1;
          if (over.backlogThrows === true) throw new Error('phone_backlog_error');
          return over.backlog ?? ({
            status: 'ok',
            admission: { controlPresent: true, halted: false, haltReason: null },
          } as BacklogResult);
        },
      },
      sessions,
      dialer,
      async liveAppointmentStart() { throw new Error('unexpected_appointment_read'); },
    },
  };
}

function dueRow(): DuePhoneEngagement {
  return {
    engagementId: UUID_E,
    state: 'eligible',
    candidateId: 'candidate-1',
    roleId: 'role-1',
    sessionId: null,
    nextEligibleAt: null,
    noAnswerAttempts: 0,
    updatedAt: new Date(NOW.getTime() - 600_000).toISOString(),
  };
}

describe('D. a lane whose kill switch cannot be read is STOPPED', () => {
  const cases: Array<[string, Parameters<typeof dueHarness>[0]]> = [
    ['the switch is pulled', {
      backlog: {
        status: 'ok',
        admission: { controlPresent: true, halted: true, haltReason: 'operator_pause' },
      } as BacklogResult,
    }],
    ['the control singleton is ABSENT', {
      backlog: {
        status: 'ok',
        admission: { controlPresent: false, halted: false, haltReason: null },
      } as BacklogResult,
    }],
    // The one that matters. The first two are the halt as the RPC reports it,
    // and any implementation that reads the field at all gets them right.
    // This is what happens when the row cannot be read AT ALL, and it is the
    // only case where a plausible implementation — a bare `await` with no
    // `try` — fails OPEN and dials into a lane an operator switched off.
    ['the backlog read THROWS — the fail-closed case', { backlogThrows: true }],
  ];

  for (const [label, over] of cases) {
    it(`RESTATED+: ${label} ⇒ the whole result shape is the halted zero`, async () => {
      const h = dueHarness({ ...over, due: [dueRow()] });
      const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10 });

      // The WHOLE shape, not field by field. `examined`, `skipped` and
      // `refusals` are the fields a partial assertion leaves free, and a pass
      // that read the due list and then reported `halted` would satisfy a
      // status-only check while having already done the read.
      expect(result).toEqual({
        status: 'halted',
        examined: 0,
        offered: 0,
        dialing: 0,
        skipped: {},
        refusals: {},
      });

      // It asked, exactly once. Otherwise a pass that skipped the check
      // entirely satisfies every assertion below.
      expect(h.calls.backlog).toBe(1);
      // And then stopped. A halted lane must not even READ the due list, let
      // alone mint a `call_sessions` row on the way to a refusal it already
      // knows it will get.
      expect(h.calls.listDue).toBe(0);
      expect(h.calls.listNumbers).toBe(0);
      expect(h.calls.ensureSession).toBe(0);
      expect(h.calls.dial).toBe(0);
    });
  }

  it('NEW: CONTROL — an explicitly RUNNING control row reaches every seam', async () => {
    // Without this the three cases above are satisfied by a `runPhoneDuePass`
    // that never does anything at all.
    const h = dueHarness({ due: [dueRow()] });
    const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10 });

    expect(result.status).toBe('ok');
    expect(result.examined).toBe(1);
    expect(result.dialing).toBe(1);
    expect(h.calls.backlog).toBe(1);
    expect(h.calls.listDue).toBe(1);
    expect(h.calls.listNumbers).toBe(1);
    expect(h.calls.ensureSession).toBe(1);
    expect(h.calls.dial).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  E. the admission refusal vocabulary cannot drift away from the migration
// ═══════════════════════════════════════════════════════════════════════

describe('E. `halted` and `halt_unreadable` survive from 0042 to the health surface', () => {
  it('NEW: both are declared by admit_phone_attempt and both are countable codes', () => {
    const statuses = functionStatuses('admit_phone_attempt');

    // FIRST. Everything below is a membership test, and a membership test
    // against an empty set is a tautology — the extractor silently returning
    // nothing would leave this whole file green while the vocabulary drifted.
    expect(statuses.size).toBeGreaterThan(0);

    for (const status of ['halted', 'halt_unreadable'] as const) {
      // The migration really declares it...
      expect(statuses.has(status), `0042 declares ${status}`).toBe(true);
      // ...and the runtime can count it under its own name rather than
      // collapsing it into `admission_refused:unknown`, which is what an
      // operator would see if the two vocabularies drifted apart.
      expect(PHONE_ADMISSION_REFUSAL_DETAILS, status).toContain(status);
    }

    // `ok` is never a refusal, and its presence would mean the detail
    // vocabulary had been built by copying the status list wholesale.
    expect(PHONE_ADMISSION_REFUSAL_DETAILS).not.toContain('ok');
  });
});
