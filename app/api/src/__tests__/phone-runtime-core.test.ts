/**
 * P5 — the phone runtime's three decision surfaces, tested at the seams.
 *
 * ── WHAT IS ACTUALLY LOAD-BEARING HERE ────────────────────────────────
 * The runtime does not decide whether a candidate may be called;
 * `admit_phone_attempt` does, under the advisory lock. What the runtime
 * decides is narrower and, precisely because it is narrower, easier to break
 * without anyone noticing:
 *
 *   1. `config.ts` — a typo in an operator's environment must degrade to the
 *      documented default, never take the API down and never widen a bound.
 *   2. `due-loop.ts` — a halted lane must reach NO write, and the fail-closed
 *      direction (an unreadable control row, an unparseable timestamp) must
 *      stop a call rather than start one.
 *   3. `dial-handler.ts` — the handler must RESOLVE for every payload it can
 *      ever be handed, because resolving is what makes the runner complete the
 *      claim, and a job that is failed instead is retried against an attempt
 *      whose call may already be ringing.
 *
 * ── HOW THE SUITE IS BUILT ────────────────────────────────────────────
 * Every dependency of the due pass is a hand-written fake with a CALL COUNTER,
 * and `now` is injected. There is no real timer, no real network and no
 * Supabase client anywhere below: "nothing was called" is the assertion two of
 * these properties reduce to, and a counter is the only way to make that
 * assertion able to fail.
 *
 * Several tests are labelled CONTROL. They exist because the negative
 * assertions above ("no dial happened", "this id was not asked for") pass
 * trivially against a pass that does nothing at all, and a suite in which the
 * positives are absent is a suite that would stay green if the whole loop were
 * deleted.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PHONE_RUNTIME_BOUNDS,
  describePhoneRuntimeConfig,
  loadPhoneRuntimeConfig,
  type PhoneRuntimeConfig,
} from '../lib/phone-runtime/config.js';
import {
  dueAttemptKind,
  dueByClock,
  runPhoneDuePass,
  type PhoneDialPort,
  type PhoneDueDeps,
  type PhoneSessionPort,
} from '../lib/phone-runtime/due-loop.js';
import {
  createPhoneDialHandler,
  isPhoneDialPayload,
  type PhoneDialJobOutcome,
} from '../lib/phone-runtime/dial-handler.js';
import type { DuePhoneEngagement, PhoneRuntimeReader } from '../lib/phone-runtime/read.js';
import type { DialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import type { PhoneScreeningConfig, PhoneStores } from '../lib/phone-screening/index.js';
import type { QueueJob } from '../lib/queue/types.js';

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

/**
 * A stand-in `DialableNumber`, deliberately NOT produced by
 * `wrapDialableNumber`.
 *
 * That wrapper accepts only the substrate's strict Indian mobile form, and a
 * committed literal of that form is forbidden across this lane's tests — India
 * publishes no reserved documentation range, so any dialable-looking fixture
 * is indistinguishable from a real subscriber's number. The digits are safe to
 * omit because the due pass never reads them: it receives the opaque value
 * from the reader and hands it to the dial port unexamined, which is exactly
 * the path this stand-in exercises.
 */
const NUMBER = Object.freeze({
  digest: 'd'.repeat(64),
  toString: () => '[redacted]',
  toJSON: () => '[redacted]',
}) as unknown as DialableNumber;

const NOW = new Date('2026-09-01T06:00:00.000Z');

/** `NOW` shifted by whole seconds, so boundary cases read as arithmetic. */
function at(offsetSeconds: number): Date {
  return new Date(NOW.getTime() + offsetSeconds * 1_000);
}

function iso(offsetSeconds: number): string {
  return at(offsetSeconds).toISOString();
}

function engagement(over: Partial<DuePhoneEngagement> = {}): DuePhoneEngagement {
  return {
    engagementId: 'engagement-1',
    state: 'eligible',
    candidateId: 'candidate-1',
    roleId: 'role-1',
    sessionId: null,
    nextEligibleAt: null,
    noAnswerAttempts: 0,
    updatedAt: iso(-600),
    ...over,
  };
}

function screeningConfig(over: Partial<PhoneScreeningConfig> = {}): PhoneScreeningConfig {
  return {
    screeningEnabled: true,
    runtimeEnabled: true,
    dialMode: 'synthetic',
    dialAllowlist: [],
    slotSeconds: 1_800,
    reconnectBackoffSeconds: 120,
    ringTimeoutSeconds: 45,
    leaseSeconds: 60,
    webhookMaxBytes: 65_536,
    webhookToleranceSeconds: 300,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CONFIG — every knob clamps, nothing is fatal, the health view is integers
// ═══════════════════════════════════════════════════════════════════════

/**
 * The knob -> environment variable map, asserted to be a BIJECTION with
 * `PHONE_RUNTIME_BOUNDS` below. Without that assertion a knob added to the
 * bounds table would simply never be exercised, and the clamp suite would
 * report full coverage of a table it had stopped covering.
 */
const KNOB_ENV: Readonly<Record<keyof PhoneRuntimeConfig, string>> = {
  dueMs: 'PHONE_RUNTIME_DUE_MS',
  reclaimMs: 'PHONE_RUNTIME_RECLAIM_MS',
  reconcileMs: 'PHONE_RUNTIME_RECONCILE_MS',
  expireMs: 'PHONE_RUNTIME_EXPIRE_MS',
  dueLimit: 'PHONE_RUNTIME_DUE_LIMIT',
  reclaimLimit: 'PHONE_RUNTIME_RECLAIM_LIMIT',
  jobLeaseSeconds: 'PHONE_RUNTIME_JOB_LEASE_SECONDS',
};

const KNOBS = Object.keys(KNOB_ENV) as (keyof PhoneRuntimeConfig)[];

describe('phone runtime config: an empty source yields the documented defaults', () => {
  it('every knob reads its own bound default', () => {
    const c = loadPhoneRuntimeConfig({});
    for (const knob of KNOBS) {
      expect(c[knob], knob).toBe(PHONE_RUNTIME_BOUNDS[knob]!.def);
    }
  });

  it('the defaults are the values 0042 was reviewed against', () => {
    // Pinned literally rather than read back from the table: asserting a
    // default equals itself proves nothing, and these particular numbers are
    // the cadence an operator was told to expect.
    const c = loadPhoneRuntimeConfig({});
    expect(c.dueMs).toBe(15_000);
    expect(c.reclaimMs).toBe(30_000);
    expect(c.reconcileMs).toBe(60_000);
    expect(c.expireMs).toBe(120_000);
    expect(c.dueLimit).toBe(3);
    expect(c.reclaimLimit).toBe(25);
    expect(c.jobLeaseSeconds).toBe(60);
  });

  it('reclaiming is never slower than dialling is fast', () => {
    // The stated ordering rule of the table: a lapsed lease holds one of ten
    // fleet slots, a deferred dial costs nothing. If the two defaults are ever
    // inverted the lane starves itself, so the relation is asserted, not
    // trusted to the comment that states it.
    expect(PHONE_RUNTIME_BOUNDS.reclaimMs!.def).toBeLessThanOrEqual(
      PHONE_RUNTIME_BOUNDS.reconcileMs!.def,
    );
    expect(PHONE_RUNTIME_BOUNDS.dueLimit!.max).toBeLessThan(
      PHONE_RUNTIME_BOUNDS.reclaimLimit!.max,
    );
  });
});

describe('phone runtime config: every knob clamps at BOTH ends', () => {
  it('the case table covers PHONE_RUNTIME_BOUNDS exactly, in both directions', () => {
    // A knob added to the bounds table without a case here would otherwise be
    // silently untested; a case left behind after a knob is removed would
    // silently test nothing.
    expect(new Set(KNOBS)).toEqual(new Set(Object.keys(PHONE_RUNTIME_BOUNDS)));
    expect(KNOBS.length).toBe(7);
  });

  for (const knob of KNOBS) {
    const name = KNOB_ENV[knob];
    it(`${name} clamps low, clamps high, and passes its bounds through`, () => {
      const bound = PHONE_RUNTIME_BOUNDS[knob]!;
      // Below the floor -> the floor. `min - 1` rather than `0`, so the test
      // still bites on a knob whose floor is already 1.
      expect(loadPhoneRuntimeConfig({ [name]: String(bound.min - 1) })[knob]).toBe(bound.min);
      // Above the ceiling -> the ceiling.
      expect(loadPhoneRuntimeConfig({ [name]: String(bound.max + 1) })[knob]).toBe(bound.max);
      // And the endpoints themselves survive, which is what makes the two
      // assertions above clamps rather than a constant.
      expect(loadPhoneRuntimeConfig({ [name]: String(bound.min) })[knob]).toBe(bound.min);
      expect(loadPhoneRuntimeConfig({ [name]: String(bound.max) })[knob]).toBe(bound.max);
    });

    it(`${name} falls back to its default on a malformed value and never throws`, () => {
      const bound = PHONE_RUNTIME_BOUNDS[knob]!;
      // A runtime that refuses to start because someone typed `fast` is a
      // runtime that stops reclaiming leases, and a stuck lease holds a fleet
      // slot until a human notices. So every one of these is a DEFAULT, and
      // none of them is an exception.
      for (const bad of ['', 'abc', '12x', '-5', '1.5', '9'.repeat(20), ' ', '1e3', '0x10']) {
        expect(() => loadPhoneRuntimeConfig({ [name]: bad })).not.toThrow();
        expect(loadPhoneRuntimeConfig({ [name]: bad })[knob], `${name}=${bad}`).toBe(bound.def);
      }
    });
  }

  it('CONTROL — a well-formed in-range value is NOT overwritten by the default', () => {
    // Every assertion above expects either a bound or a default. Without this
    // one, an implementation that ignored `source` entirely and returned the
    // defaults would satisfy the malformed suite outright and the clamp suite
    // for any knob whose default happened to sit on a bound.
    const bound = PHONE_RUNTIME_BOUNDS.dueMs!;
    const inRange = Math.floor((bound.min + bound.max) / 2);
    expect(inRange).not.toBe(bound.def);
    expect(loadPhoneRuntimeConfig({ PHONE_RUNTIME_DUE_MS: String(inRange) }).dueMs).toBe(inRange);
  });

  it('one malformed knob does not disturb its neighbours', () => {
    const c = loadPhoneRuntimeConfig({
      PHONE_RUNTIME_DUE_MS: 'fast',
      PHONE_RUNTIME_RECLAIM_MS: '7000',
    });
    expect(c.dueMs).toBe(PHONE_RUNTIME_BOUNDS.dueMs!.def);
    expect(c.reclaimMs).toBe(7_000);
  });
});

describe('phone runtime config: the published shape is integers and nothing else', () => {
  it('every value is a finite integer, whatever the source said', () => {
    const described = describePhoneRuntimeConfig(
      loadPhoneRuntimeConfig({
        PHONE_RUNTIME_DUE_MS: '1.5',
        PHONE_RUNTIME_DUE_LIMIT: '9'.repeat(20),
        PHONE_RUNTIME_RECLAIM_LIMIT: String(PHONE_RUNTIME_BOUNDS.reclaimLimit!.max + 5_000),
      }),
    );
    const entries = Object.entries(described as Record<string, unknown>);
    // Fail closed: an empty projection would make the loop below vacuous.
    expect(entries).toHaveLength(7);
    for (const [key, value] of entries) {
      expect(typeof value, key).toBe('number');
      expect(Number.isInteger(value as number), key).toBe(true);
      expect(Number.isFinite(value as number), key).toBe(true);
    }
  });

  it('no key carries a string, an object, an array or a null', () => {
    // The projection reaches a health surface. A nested object is how an
    // identifier, a credential or a candidate-derived value would arrive
    // there, so the assertion is on the SHAPE rather than on a denylist of
    // field names that a future field would not be on.
    const described = describePhoneRuntimeConfig(loadPhoneRuntimeConfig({})) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(described)) {
      expect(typeof value === 'string', `${key} is a string`).toBe(false);
      expect(typeof value === 'object', `${key} is an object or null`).toBe(false);
      expect(Array.isArray(value), `${key} is an array`).toBe(false);
    }
    expect(described).toEqual({
      due_ms: 15_000,
      reclaim_ms: 30_000,
      reconcile_ms: 60_000,
      expire_ms: 120_000,
      due_limit: 3,
      reclaim_limit: 25,
      job_lease_seconds: 60,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DUE-LOOP — the two pure helpers
// ═══════════════════════════════════════════════════════════════════════

describe('dueAttemptKind: the state decides the kind, and an unknown state decides nothing', () => {
  const cases: Array<[string, DuePhoneEngagement, string | null]> = [
    [
      'eligible with no no-answers is the FIRST call',
      engagement({ state: 'eligible', noAnswerAttempts: 0 }),
      'initial',
    ],
    [
      'eligible after one no-answer is a RETRY',
      engagement({ state: 'eligible', noAnswerAttempts: 1 }),
      'no_answer_retry',
    ],
    [
      'eligible after many no-answers is still a retry',
      engagement({ state: 'eligible', noAnswerAttempts: 7 }),
      'no_answer_retry',
    ],
    ['reconnecting', engagement({ state: 'reconnecting' }), 'reconnect'],
    ['scheduled', engagement({ state: 'scheduled' }), 'scheduled'],
    [
      'an unknown state yields NULL rather than a guess',
      // Cast: the reader can only ever produce a `PhoneDueState`, but the
      // helper is the last line of defence if that ever stops being true, and
      // `admit_phone_attempt` refuses `kind_not_admissible` for a mismatched
      // pair — so guessing a kind here would manufacture a refusal instead of
      // a skip.
      { ...engagement(), state: 'in_call' as DuePhoneEngagement['state'] },
      null,
    ],
  ];

  for (const [label, row, expected] of cases) {
    it(label, () => {
      expect(dueAttemptKind(row)).toBe(expected);
    });
  }

  it('the no-answer counter is the ONLY thing separating initial from retry', () => {
    // Control on the table above: if the two eligible cases disagreed for any
    // other reason the table would still pass, so the pair is compared
    // directly with everything else held equal.
    const base = engagement({ state: 'eligible' });
    expect(dueAttemptKind({ ...base, noAnswerAttempts: 0 })).toBe('initial');
    expect(dueAttemptKind({ ...base, noAnswerAttempts: 1 })).toBe('no_answer_retry');
  });
});

describe('dueByClock: reconnecting is a WORKER clock, everything else is a database fact', () => {
  const BACKOFF = 120;

  describe('reconnecting uses updatedAt + reconnectBackoffSeconds', () => {
    const row = (updatedAt: string | null): DuePhoneEngagement =>
      engagement({ state: 'reconnecting', updatedAt, nextEligibleAt: null });

    it('one second BEFORE the boundary is not due', () => {
      expect(dueByClock(row(iso(-BACKOFF + 1)), NOW, BACKOFF)).toBe(false);
    });

    it('exactly ON the boundary is due', () => {
      // `>=`, not `>`: the boundary instant belongs to the due side, and a
      // strict comparison here would defer every reconnect by one tick.
      expect(dueByClock(row(iso(-BACKOFF)), NOW, BACKOFF)).toBe(true);
    });

    it('one second AFTER the boundary is due', () => {
      expect(dueByClock(row(iso(-BACKOFF - 1)), NOW, BACKOFF)).toBe(true);
    });

    it('a null updatedAt is NOT due — the fail-closed direction', () => {
      // There is no instant to measure the backoff from, so the only safe
      // reading is "wait". Dialling a dropped call back instantly is both
      // useless and hostile, and a missing timestamp must not be the way it
      // happens.
      expect(dueByClock(row(null), NOW, BACKOFF)).toBe(false);
    });

    it('an unparseable updatedAt is NOT due', () => {
      expect(dueByClock(row('not-a-timestamp'), NOW, BACKOFF)).toBe(false);
      expect(dueByClock(row(''), NOW, BACKOFF)).toBe(false);
    });

    it('the backoff is actually read from the argument, not hard-coded', () => {
      // CONTROL for the boundary tests: the same row flips answer when only
      // the configured backoff changes, which is impossible if the helper
      // ignores its third parameter.
      const r = row(iso(-60));
      expect(dueByClock(r, NOW, 30)).toBe(true);
      expect(dueByClock(r, NOW, 120)).toBe(false);
    });

    it('reconnecting IGNORES nextEligibleAt entirely', () => {
      // 0042 puts the reconnect backoff on a worker clock rather than a
      // database fact, so a stale `next_eligible_at` must neither block nor
      // release a reconnect.
      const blocked = engagement({
        state: 'reconnecting',
        updatedAt: iso(-BACKOFF),
        nextEligibleAt: iso(86_400),
      });
      expect(dueByClock(blocked, NOW, BACKOFF)).toBe(true);
    });
  });

  describe('every other state defers to nextEligibleAt', () => {
    const cases: Array<[string, string | null, boolean]> = [
      ['a null nextEligibleAt means nothing is deferring it', null, true],
      ['an unparseable nextEligibleAt reads as due', 'soon-ish', true],
      ['an empty nextEligibleAt reads as due', '', true],
      ['a FUTURE nextEligibleAt is not due yet', iso(3_600), false],
      ['one second in the future is still not due', iso(1), false],
      ['exactly now is due', iso(0), true],
      ['a PAST nextEligibleAt is due', iso(-3_600), true],
    ];

    for (const state of ['eligible', 'scheduled'] as const) {
      for (const [label, nextEligibleAt, expected] of cases) {
        it(`${state}: ${label}`, () => {
          const row = engagement({ state, nextEligibleAt, updatedAt: iso(-1) });
          expect(dueByClock(row, NOW, BACKOFF)).toBe(expected);
        });
      }
    }

    it('an unparseable value reads as DUE, not as blocked, and that is deliberate', () => {
      // The opposite inversion from `reconnecting`, and it is the safe one
      // here: `admit_phone_attempt` re-checks eligibility under the advisory
      // lock, so an unreadable local hint at worst costs one refused round
      // trip — whereas treating it as "never due" would strand the engagement
      // with nothing to ever release it.
      expect(dueByClock(engagement({ nextEligibleAt: 'garbage' }), NOW, BACKOFF)).toBe(true);
      expect(dueByClock(engagement({ nextEligibleAt: iso(60) }), NOW, BACKOFF)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DUE PASS — hand-written fakes, injected clock, call counters
// ═══════════════════════════════════════════════════════════════════════

type BacklogResult = Awaited<ReturnType<PhoneStores['backlog']>>;

const RUNNING: BacklogResult = {
  status: 'ok',
  admission: { controlPresent: true, halted: false, haltReason: null },
} as BacklogResult;

interface Harness {
  readonly deps: PhoneDueDeps;
  /** Every seam, counted. "Nothing was called" is only assertable this way. */
  readonly calls: {
    listDue: number;
    listNumbers: number;
    findSession: number;
    consent: number;
    backlog: number;
    ensureSession: number;
    dial: number;
    appointment: number;
  };
  /** The candidate id lists handed to `listDialableNumbers`, in order. */
  readonly numberRequests: string[][];
  /** The engagement ids actually dialled, in order. */
  readonly dialled: string[];
}

function harness(options: {
  due?: readonly DuePhoneEngagement[];
  backlog?: BacklogResult;
  backlogThrows?: boolean;
  /** Candidate ids that HAVE a dialable number. Default: all of them. */
  dialableCandidates?: readonly string[];
  /** Session id per candidate; `null` means "could not provision". */
  session?: (candidateId: string) => string | null;
  /** Appointment start per engagement, for the `scheduled` branch. */
  appointmentStart?: (engagementId: string) => string | null;
  dial?: (engagementId: string) => { status: 'dialing' | 'refused'; refusal?: string };
  config?: Partial<PhoneScreeningConfig>;
} = {}): Harness {
  const calls = {
    listDue: 0,
    listNumbers: 0,
    findSession: 0,
    consent: 0,
    backlog: 0,
    ensureSession: 0,
    dial: 0,
    appointment: 0,
  };
  const numberRequests: string[][] = [];
  const dialled: string[] = [];
  const due = options.due ?? [];

  const reader: PhoneRuntimeReader = {
    async listDueEngagements() {
      calls.listDue += 1;
      return due;
    },
    async listDialableNumbers(input) {
      calls.listNumbers += 1;
      numberRequests.push([...input.candidateIds]);
      const allowed = options.dialableCandidates ?? input.candidateIds;
      const out = new Map<string, DialableNumber>();
      for (const id of input.candidateIds) {
        if (allowed.includes(id)) out.set(id, NUMBER);
      }
      return out;
    },
    async findReusableSession() {
      calls.findSession += 1;
      return null;
    },
    consent: {
      async latestConsentRecord() {
        calls.consent += 1;
        return null;
      },
      async activeConsentTemplate() {
        calls.consent += 1;
        return null;
      },
    },
  };

  const sessions: PhoneSessionPort = {
    async ensureSession(input) {
      calls.ensureSession += 1;
      return options.session ? options.session(input.candidateId) : `session-${input.candidateId}`;
    },
  };

  const dialer: PhoneDialPort = {
    async dial(input) {
      calls.dial += 1;
      dialled.push(input.engagementId);
      return options.dial ? options.dial(input.engagementId) : { status: 'dialing' };
    },
  };

  const deps: PhoneDueDeps = {
    config: screeningConfig(options.config),
    reader,
    stores: {
      async backlog() {
        calls.backlog += 1;
        if (options.backlogThrows === true) throw new Error('phone_backlog_error');
        return options.backlog ?? RUNNING;
      },
    },
    sessions,
    dialer,
    async liveAppointmentStart(engagementId) {
      calls.appointment += 1;
      return options.appointmentStart ? options.appointmentStart(engagementId) : iso(-60);
    },
  };

  return { deps, calls, numberRequests, dialled };
}

function options(limit = 10): { now: Date; limit: number } {
  return { now: NOW, limit };
}

describe('the due pass does NOTHING at all when either switch is off', () => {
  const offCases: Array<[string, Partial<PhoneScreeningConfig>]> = [
    ['screening disabled', { screeningEnabled: false, runtimeEnabled: true }],
    ['runtime disabled', { screeningEnabled: true, runtimeEnabled: false }],
    ['both disabled', { screeningEnabled: false, runtimeEnabled: false }],
    // `dialMode: 'off'` is the THIRD switch, and it is inert for a reason the
    // other two do not share. `off` already reaches no carrier — the dial
    // controller resolves the synthetic client for it. What it would NOT stop,
    // without this gate, is SPENDING: admission writes a real attempt row,
    // takes one of the ten fleet slots, and charges the candidate's IST-day
    // index and no-answer budget. An operator arming the runtime with `off`
    // expecting a dry run would burn a day of every due candidate's budget on
    // calls that never happened.
    ['dial mode off', { screeningEnabled: true, runtimeEnabled: true, dialMode: 'off' }],
  ];

  for (const [label, config] of offCases) {
    it(`${label}: status is 'disabled' and no seam is touched`, async () => {
      const h = harness({ config, due: [engagement()] });
      const result = await runPhoneDuePass(h.deps, options());

      expect(result.status).toBe('disabled');
      expect(result).toEqual({
        status: 'disabled',
        examined: 0,
        offered: 0,
        dialing: 0,
        skipped: {},
        refusals: {},
      });
      // The reason this is asserted with counters rather than by the returned
      // shape: a pass that read the backlog, listed the due rows and then
      // decided to report zero would return exactly the object above. The only
      // evidence that a disabled lane is INERT is that nothing was called.
      expect(h.calls).toEqual({
        listDue: 0,
        listNumbers: 0,
        findSession: 0,
        consent: 0,
        backlog: 0,
        ensureSession: 0,
        dial: 0,
        appointment: 0,
      });
    });
  }

  it('CONTROL — `synthetic` is NOT gated: rehearsing admission is its purpose', async () => {
    // The distinction is the whole point of the mode. If `off` and `synthetic`
    // behaved alike, the gate above would be indistinguishable from one that
    // refused every non-live mode — which would make the Canary-0 rehearsal
    // impossible and would leave the previous test passing for the wrong
    // reason.
    const h = harness({
      config: { screeningEnabled: true, runtimeEnabled: true, dialMode: 'synthetic' },
      due: [engagement()],
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.status).toBe('ok');
    expect(h.calls.dial).toBe(1);
  });

  it('CONTROL — the SAME harness with both switches on does reach every seam', async () => {
    // Without this the three tests above are satisfied by a `runPhoneDuePass`
    // that returns `disabled` unconditionally.
    const h = harness({ due: [engagement()] });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.status).toBe('ok');
    expect(h.calls.backlog).toBe(1);
    expect(h.calls.listDue).toBe(1);
    expect(h.calls.listNumbers).toBe(1);
    expect(h.calls.ensureSession).toBe(1);
    expect(h.calls.dial).toBe(1);
  });
});

describe('a halted lane mints no session and places no call', () => {
  /**
   * Three shapes, one verdict. The third is the important one: the first two
   * are the halt as the RPC reports it, and any implementation that reads the
   * field at all will get them right. The third is what happens when the
   * control row cannot be read AT ALL, and it is the only one where a
   * plausible implementation — a bare `await` with no `try` — fails open and
   * dials into a lane an operator has switched off.
   */
  const haltCases: Array<[string, Parameters<typeof harness>[0]]> = [
    [
      'the halt switch is pulled',
      {
        backlog: {
          status: 'ok',
          admission: { controlPresent: true, halted: true, haltReason: 'operator' },
        } as BacklogResult,
      },
    ],
    [
      'the control row is ABSENT',
      {
        backlog: {
          status: 'ok',
          admission: { controlPresent: false, halted: false, haltReason: null },
        } as BacklogResult,
      },
    ],
    ['the backlog read THROWS — the fail-closed case', { backlogThrows: true }],
  ];

  for (const [label, over] of haltCases) {
    it(`${label}: status 'halted', no session, no dial`, async () => {
      const h = harness({ ...over, due: [engagement(), engagement({ engagementId: 'e2' })] });
      const result = await runPhoneDuePass(h.deps, options());

      expect(result.status).toBe('halted');
      expect(result.offered).toBe(0);
      expect(result.dialing).toBe(0);
      // A halted lane must not be minting `call_sessions` rows on the way to a
      // refusal it already knows it will get.
      expect(h.calls.ensureSession).toBe(0);
      expect(h.calls.dial).toBe(0);
      expect(h.dialled).toEqual([]);
      // Nor should it read anything past the switch.
      expect(h.calls.listDue).toBe(0);
      expect(h.calls.listNumbers).toBe(0);
      // It did ask, exactly once. Otherwise a pass that skipped the check
      // entirely would satisfy every assertion above.
      expect(h.calls.backlog).toBe(1);
    });
  }

  it('CONTROL — an explicitly RUNNING control row does not halt the same rows', async () => {
    const h = harness({
      backlog: {
        status: 'ok',
        admission: { controlPresent: true, halted: false, haltReason: null },
      } as BacklogResult,
      due: [engagement()],
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.status).toBe('ok');
    expect(result.dialing).toBe(1);
  });
});

describe('the happy path offers every ready row and counts what happened', () => {
  it('two due engagements produce two dials, two offers and two dialing', async () => {
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1' }),
        engagement({ engagementId: 'e2', candidateId: 'c2', noAnswerAttempts: 2 }),
      ],
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.status).toBe('ok');
    expect(result.examined).toBe(2);
    expect(result.offered).toBe(2);
    expect(result.dialing).toBe(2);
    expect(result.skipped).toEqual({});
    expect(result.refusals).toEqual({});
    expect(h.dialled).toEqual(['e1', 'e2']);
    expect(h.calls.dial).toBe(2);
    // One batched read for both candidates, not one per row.
    expect(h.calls.listNumbers).toBe(1);
    expect(h.numberRequests).toEqual([['c1', 'c2']]);
  });

  it('the kind carried to the dial port is the one the state demands', async () => {
    // `admit_phone_attempt` refuses `kind_not_admissible` on a mismatch, so
    // this is not a preference — it is the only admissible pairing, and the
    // pass is the thing that chooses it.
    const seen: string[] = [];
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1', noAnswerAttempts: 0 }),
        engagement({ engagementId: 'e2', candidateId: 'c2', noAnswerAttempts: 3 }),
        engagement({
          engagementId: 'e3',
          candidateId: 'c3',
          state: 'reconnecting',
          updatedAt: iso(-3_600),
        }),
      ],
    });
    const original = h.deps.dialer.dial.bind(h.deps.dialer);
    (h.deps.dialer as { dial: PhoneDialPort['dial'] }).dial = async (input) => {
      seen.push(input.kind);
      return original(input);
    };
    await runPhoneDuePass(h.deps, options());
    expect(seen).toEqual(['initial', 'no_answer_retry', 'reconnect']);
  });
});

describe('a row that cannot be dialled is skipped by NAME, not dialled blind', () => {
  it('no dialable number: counted `no_dialable_number` and never dialled', async () => {
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1' }),
        engagement({ engagementId: 'e2', candidateId: 'c2' }),
      ],
      // `c2`'s number is absent, invalid or unwrappable — the reader simply
      // does not put it in the map, and the pass has nothing to dial with.
      dialableCandidates: ['c1'],
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.skipped).toEqual({ no_dialable_number: 1 });
    expect(result.offered).toBe(1);
    expect(result.dialing).toBe(1);
    expect(h.dialled).toEqual(['e1']);
    // A number-less row must not even reach the session port: provisioning
    // one would leave an orphan `call_sessions` row per pass, forever.
    expect(h.calls.ensureSession).toBe(1);
  });

  it('no session: counted `no_session` and never dialled', async () => {
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1' }),
        engagement({ engagementId: 'e2', candidateId: 'c2' }),
      ],
      session: (candidateId) => (candidateId === 'c2' ? null : `session-${candidateId}`),
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.skipped).toEqual({ no_session: 1 });
    expect(result.offered).toBe(1);
    expect(result.dialing).toBe(1);
    // The load-bearing half: a null session id must stop the call, not be
    // passed through as an empty room binding.
    expect(h.dialled).toEqual(['e1']);
    expect(h.calls.dial).toBe(1);
  });

  it('CONTROL — with a number and a session the same two rows both dial', async () => {
    // Both tests above assert that ONE of two rows was dialled. Without this
    // control, a pass that dialled only ever the first row would pass both.
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1' }),
        engagement({ engagementId: 'e2', candidateId: 'c2' }),
      ],
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.skipped).toEqual({});
    expect(h.dialled).toEqual(['e1', 'e2']);
  });
});

describe('a scheduled row waits for its appointment to actually start', () => {
  const scheduled = (engagementId: string, candidateId: string): DuePhoneEngagement =>
    engagement({ engagementId, candidateId, state: 'scheduled', nextEligibleAt: null });

  it('an appointment that has not started yet is `appointment_not_due`', async () => {
    const h = harness({
      due: [scheduled('e1', 'c1')],
      appointmentStart: () => iso(600),
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.skipped).toEqual({ appointment_not_due: 1 });
    expect(result.offered).toBe(0);
    expect(h.dialled).toEqual([]);
    expect(h.calls.ensureSession).toBe(0);
    // It did look the appointment up — otherwise the skip above could come
    // from any other branch entirely.
    expect(h.calls.appointment).toBe(1);
  });

  it('an appointment whose start has passed IS dialled', async () => {
    const h = harness({
      due: [scheduled('e1', 'c1')],
      appointmentStart: () => iso(-1),
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.skipped).toEqual({});
    expect(result.offered).toBe(1);
    expect(result.dialing).toBe(1);
    expect(h.dialled).toEqual(['e1']);
  });

  it('an absent or unparseable appointment start is NOT due — fail closed', async () => {
    for (const start of [null, 'sometime']) {
      const h = harness({ due: [scheduled('e1', 'c1')], appointmentStart: () => start });
      const result = await runPhoneDuePass(h.deps, options());
      expect(result.skipped, String(start)).toEqual({ appointment_not_due: 1 });
      expect(h.dialled).toEqual([]);
    }
  });

  it('a NON-scheduled row never consults the appointment reader at all', async () => {
    // The appointment read exists only for the `scheduled` branch; performing
    // it for every row would be a per-pass round trip nothing consumes.
    const h = harness({ due: [engagement({ state: 'eligible' })] });
    await runPhoneDuePass(h.deps, options());
    expect(h.calls.appointment).toBe(0);
    expect(h.calls.dial).toBe(1);
  });
});

describe('a refusal is counted by its stable code and is not a dial', () => {
  it('the refusal code is the key, and `dialing` does not move', async () => {
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1' }),
        engagement({ engagementId: 'e2', candidateId: 'c2' }),
        engagement({ engagementId: 'e3', candidateId: 'c3' }),
      ],
      dial: (engagementId) =>
        engagementId === 'e3'
          ? { status: 'dialing' }
          : { status: 'refused', refusal: 'at_capacity' },
    });
    const result = await runPhoneDuePass(h.deps, options());

    // Offered counts what reached admission; `dialing` counts what became a
    // call. Conflating them is how a lane that refuses everything reports a
    // healthy dial rate.
    expect(result.offered).toBe(3);
    expect(result.dialing).toBe(1);
    expect(result.refusals).toEqual({ at_capacity: 2 });
    expect(result.skipped).toEqual({});
  });

  it('distinct refusal codes are counted separately', async () => {
    const codes: Record<string, string> = { e1: 'window_closed', e2: 'consent_not_granted' };
    const h = harness({
      due: [
        engagement({ engagementId: 'e1', candidateId: 'c1' }),
        engagement({ engagementId: 'e2', candidateId: 'c2' }),
      ],
      dial: (engagementId) => ({ status: 'refused', refusal: codes[engagementId] }),
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.refusals).toEqual({ window_closed: 1, consent_not_granted: 1 });
    expect(result.dialing).toBe(0);
  });

  it('a refusal with no code is counted as `unknown` rather than dropped', async () => {
    // A refusal that vanishes from the counters is worse than one labelled
    // vaguely: an operator looking at a lane that dials nothing needs to see
    // that something refused it.
    const h = harness({
      due: [engagement()],
      dial: () => ({ status: 'refused' }),
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.refusals).toEqual({ unknown: 1 });
    expect(result.offered).toBe(1);
    expect(result.dialing).toBe(0);
  });
});

describe('CONTROL — the number read is asked ONLY for rows that passed the clock', () => {
  it('a not-yet-due candidate id is absent from the listDialableNumbers request', async () => {
    const h = harness({
      due: [
        engagement({ engagementId: 'ready', candidateId: 'c-ready', nextEligibleAt: iso(-60) }),
        engagement({
          engagementId: 'waiting',
          candidateId: 'c-waiting',
          nextEligibleAt: iso(3_600),
        }),
      ],
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.skipped).toEqual({ not_yet_due: 1 });
    expect(h.calls.listNumbers).toBe(1);
    // The whole point of the filter: a candidate's number is the one value in
    // this lane worth not fetching speculatively, so a row that cannot be
    // dialled this pass must not cause its number to be read.
    expect(h.numberRequests).toEqual([['c-ready']]);
    expect(h.numberRequests[0]).not.toContain('c-waiting');
    expect(h.dialled).toEqual(['ready']);
  });

  it('a scheduled row whose slot has not started is absent from the request too', async () => {
    // EVERY time-based gate must run before a number is read, not merely the
    // `next_eligible_at` one. An earlier draft filtered on the clock, fetched
    // numbers, and only THEN consulted the appointment — so a `scheduled` row
    // whose slot was an hour away had its number read for nothing. The read
    // could not change that row's outcome, and a read that cannot change an
    // outcome is one an operator will eventually mistake for a gate.
    const h = harness({
      due: [
        engagement({ engagementId: 'ready', candidateId: 'c-ready', nextEligibleAt: iso(-60) }),
        engagement({
          engagementId: 'later',
          candidateId: 'c-later',
          state: 'scheduled',
          nextEligibleAt: null,
        }),
      ],
      appointmentStart: () => iso(3_600),
    });
    const result = await runPhoneDuePass(h.deps, options());

    expect(result.skipped).toEqual({ appointment_not_due: 1 });
    expect(h.numberRequests).toEqual([['c-ready']]);
    expect(h.numberRequests[0]).not.toContain('c-later');
    expect(h.dialled).toEqual(['ready']);
  });

  it('CONTROL — the same candidate IS asked for once its clock passes', async () => {
    // Without this, an implementation that passed an EMPTY id list every time
    // would satisfy the exclusion assertion above perfectly.
    const h = harness({
      due: [
        engagement({ engagementId: 'ready', candidateId: 'c-ready', nextEligibleAt: iso(-60) }),
        engagement({
          engagementId: 'waiting',
          candidateId: 'c-waiting',
          nextEligibleAt: iso(-1),
        }),
      ],
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.skipped).toEqual({});
    expect(h.numberRequests).toEqual([['c-ready', 'c-waiting']]);
  });

  it('a row in an unknown state is skipped before the clock and before the number', async () => {
    const h = harness({
      due: [
        { ...engagement({ candidateId: 'c-bad' }), state: 'in_call' as DuePhoneEngagement['state'] },
      ],
    });
    const result = await runPhoneDuePass(h.deps, options());
    expect(result.skipped).toEqual({ unknown_state: 1 });
    expect(h.numberRequests).toEqual([[]]);
    expect(h.calls.dial).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DIAL HANDLER — the payload guard and the never-throw contract
// ═══════════════════════════════════════════════════════════════════════

const GOOD_ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GOOD_PAYLOAD = { provider: 'phone', attemptId: GOOD_ATTEMPT };

function job(payload: unknown): QueueJob<unknown> {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'phone.dial',
    payload,
    status: 'active',
    attempts: 1,
    maxAttempts: 3,
    priority: 0,
    scheduledAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  };
}

describe('isPhoneDialPayload accepts exactly the shape 0042 writes', () => {
  it('the canonical payload is accepted', () => {
    expect(isPhoneDialPayload(GOOD_PAYLOAD)).toBe(true);
  });

  it('an uppercase uuid is accepted — PostgREST may render either casing', () => {
    expect(
      isPhoneDialPayload({ provider: 'phone', attemptId: GOOD_ATTEMPT.toUpperCase() }),
    ).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'phone'],
    ['a number', 7],
    ['an array', [GOOD_PAYLOAD]],
    ['an empty object', {}],
    ['a missing provider', { attemptId: GOOD_ATTEMPT }],
    ['the wrong provider', { provider: 'browser', attemptId: GOOD_ATTEMPT }],
    ['a provider that is not a string', { provider: 1, attemptId: GOOD_ATTEMPT }],
    ['a missing attemptId', { provider: 'phone' }],
    ['a null attemptId', { provider: 'phone', attemptId: null }],
    ['a non-string attemptId', { provider: 'phone', attemptId: 12345 }],
    ['a non-uuid attemptId', { provider: 'phone', attemptId: 'not-a-uuid' }],
    ['a uuid one character SHORT', { provider: 'phone', attemptId: GOOD_ATTEMPT.slice(0, -1) }],
    ['a uuid one character LONG', { provider: 'phone', attemptId: `${GOOD_ATTEMPT}a` }],
    ['a uuid with its dashes stripped', { provider: 'phone', attemptId: GOOD_ATTEMPT.replace(/-/g, '') }],
    ['a uuid with a non-hex character', { provider: 'phone', attemptId: GOOD_ATTEMPT.replace('a', 'z') }],
    ['a uuid with surrounding whitespace', { provider: 'phone', attemptId: ` ${GOOD_ATTEMPT} ` }],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label}`, () => {
      expect(isPhoneDialPayload(payload)).toBe(false);
    });
  }

  it('CONTROL — the rejections are about the FIELDS, not about extra keys', () => {
    // Without this the table above is satisfied by a guard that rejects
    // everything, and the accept case would be the only thing holding it up.
    expect(isPhoneDialPayload({ ...GOOD_PAYLOAD, enqueuedAt: NOW.toISOString() })).toBe(true);
  });
});

describe('the dial handler RESOLVES for every payload — the whole contract', () => {
  it('resolves for a well-formed payload', async () => {
    const handler = createPhoneDialHandler({});
    // `resolves.toBeUndefined()` rather than a bare await: the runner calls
    // `completeClaim` only when the handler resolves, and it must resolve with
    // nothing — a returned value would be the start of a result protocol this
    // handler deliberately does not have.
    await expect(handler(job(GOOD_PAYLOAD))).resolves.toBeUndefined();
  });

  it('resolves for a MALFORMED payload — it is never failed and never retried', async () => {
    // This is the load-bearing property of the file. A payload the handler
    // cannot read is not a transient fault: throwing would fail the job, the
    // runner would retry it to `max_attempts`, and the retries would land
    // against an attempt whose call may already be ringing. So a malformed
    // payload is COMPLETED and counted.
    const handler = createPhoneDialHandler({});
    for (const bad of [null, undefined, 'phone', 42, {}, { provider: 'phone' }, []]) {
      await expect(handler(job(bad))).resolves.toBeUndefined();
    }
  });

  it('resolves even when the outcome sink is absent', async () => {
    const handler = createPhoneDialHandler();
    await expect(handler(job(GOOD_PAYLOAD))).resolves.toBeUndefined();
    await expect(handler(job('nonsense'))).resolves.toBeUndefined();
  });
});

describe('onOutcome reports which of the two states the handler found', () => {
  it('a good payload is `completed`, a bad one is `malformed_payload`', async () => {
    const seen: PhoneDialJobOutcome[] = [];
    const handler = createPhoneDialHandler({ onOutcome: (o) => seen.push(o) });

    await handler(job(GOOD_PAYLOAD));
    expect(seen).toEqual(['completed']);

    await handler(job({ provider: 'browser', attemptId: GOOD_ATTEMPT }));
    // Both outcomes appear, so neither branch is a constant.
    expect(seen).toEqual(['completed', 'malformed_payload']);
  });

  it('every job produces exactly one outcome', async () => {
    const seen: PhoneDialJobOutcome[] = [];
    const handler = createPhoneDialHandler({ onOutcome: (o) => seen.push(o) });
    for (const payload of [GOOD_PAYLOAD, null, GOOD_PAYLOAD, 'x']) {
      await handler(job(payload));
    }
    expect(seen).toEqual(['completed', 'malformed_payload', 'completed', 'malformed_payload']);
  });

  it('the outcome sink never receives the payload itself', async () => {
    // The counter is for a health surface. An attempt id is an identifier and
    // has no business on one, so the sink's arity is part of the contract.
    const args: unknown[][] = [];
    const handler = createPhoneDialHandler({
      onOutcome: (...rest: unknown[]) => {
        args.push(rest);
      },
    });
    await handler(job(GOOD_PAYLOAD));
    expect(args).toEqual([['completed']]);
    expect(JSON.stringify(args)).not.toContain(GOOD_ATTEMPT);
  });
});

describe('CONTROL — the handler performs no I/O whatsoever', () => {
  it('built with NO client and no deps at all, it still resolves', async () => {
    // The handler deliberately reads nothing: the action is identical whether
    // the attempt is live or long finished, and a read that cannot change an
    // outcome is a read a later editor mistakes for a gate. Constructing it
    // with no client is the strongest available proof — there is nothing for
    // it to read WITH.
    const timers = {
      setTimeout: vi.spyOn(globalThis, 'setTimeout'),
      setInterval: vi.spyOn(globalThis, 'setInterval'),
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => {
        throw new Error('network access from the phone.dial handler');
      });
    try {
      const handler = createPhoneDialHandler();
      await expect(handler(job(GOOD_PAYLOAD))).resolves.toBeUndefined();
      await expect(handler(job({ provider: 'phone' }))).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(timers.setTimeout).not.toHaveBeenCalled();
      expect(timers.setInterval).not.toHaveBeenCalled();
    } finally {
      timers.setTimeout.mockRestore();
      timers.setInterval.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('the factory itself constructs nothing and arms nothing', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    try {
      expect(typeof createPhoneDialHandler()).toBe('function');
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
    }
  });
});
