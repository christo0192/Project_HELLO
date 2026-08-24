/**
 * phone-runtime-loops.test.ts — the LOOP-level properties of the phone lane.
 *
 * Three claims are load-bearing here and each is proved rather than asserted
 * by comment:
 *
 *   1. THE GATE IS A PROPERTY OF CONSTRUCTION. With either switch off,
 *      `createPhoneRuntime` returns null having touched NO dependency at all —
 *      proved by handing it an options object whose every post-gate field is a
 *      getter that throws. An inverted case (both switches on ⇒ not null) stops
 *      the suite from passing merely because the factory always answers null.
 *   2. THE LOOPS DO NOT STORM, DO NOT OVERLAP AND DO NOT DIE. A cold start
 *      staggers rather than replaying a backlog; a due pass slower than its own
 *      interval is entered exactly once; a rejecting loop keeps its siblings
 *      ticking and comes back next interval.
 *   3. THE HEALTH VIEW LEAKS NO IDENTIFIER. A due pass is driven with
 *      recognisable sentinel ids and the whole serialized view is searched for
 *      each of them.
 *
 * Everything runs on `vi.useFakeTimers()`. The scheduler self-reschedules with
 * `setTimeout` + jitter, so time is moved with `advanceTimersByTimeAsync` and
 * every assertion is on a COUNT, never on a wall clock. No real sleep, no
 * Supabase client, no network, no SDK object.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  createPhoneRuntime,
  type PhoneRuntimeHandle,
  type PhoneRuntimeOptions,
} from '../lib/phone-runtime/runtime.js';
import {
  MIN_STALE_WINDOW_MS,
  STALE_TICK_MULTIPLIER,
  clearPhoneRuntimeRegistration,
  phoneRuntimeDegradeReasons,
  phoneRuntimeView,
  registerPhoneRuntime,
  type PhoneLoopHealthView,
  type PhoneRuntimeView,
} from '../lib/phone-runtime/health.js';
import { PHONE_DIAL_QUEUE, type PhoneRuntimeConfig } from '../lib/phone-runtime/config.js';
import {
  loadPhoneScreeningConfig,
  type PhoneScreeningConfig,
  type PhoneStores,
} from '../lib/phone-screening/index.js';
import type { PhoneRuntimeReader } from '../lib/phone-runtime/read.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import type { Queue } from '../lib/queue/index.js';
import type { QueueJob } from '../lib/queue/types.js';

// ── Sentinels ────────────────────────────────────────────────────────────────
// Deliberately NOT phone-shaped and NOT uuid-shaped, so a substring search for
// them cannot collide with a digest, a room name or a timestamp.
const SENTINEL_ENGAGEMENT = 'SENTINEL-ENGAGEMENT-aaa111';
const SENTINEL_ENGAGEMENT_2 = 'SENTINEL-ENGAGEMENT-bbb222';
const SENTINEL_CANDIDATE = 'SENTINEL-CANDIDATE-ccc333';
const SENTINEL_CANDIDATE_2 = 'SENTINEL-CANDIDATE-ddd444';
const SENTINEL_SESSION = 'SENTINEL-SESSION-eee555';
const SENTINEL_ATTEMPT = 'SENTINEL-ATTEMPT-fff666';
const SENTINEL_ROLE = 'SENTINEL-ROLE-ggg777';

/**
 * The one DIALABLE value this suite needs, assembled at runtime.
 *
 * `wrapDialableNumber` accepts only the substrate's strict Indian mobile form,
 * `^\+91[6-9][0-9]{9}$`. India publishes no reserved documentation range —
 * there is no +1-555 equivalent — so a literal of that form committed here
 * would be indistinguishable from a real subscriber's number, which is the
 * rule `phone-runtime-structural.test.ts` enforces over the source package.
 * The same risk lives in a test file, so the digits are joined from fragments
 * exactly as `phone-runtime-read.test.ts` does and nothing on disk matches the
 * gate. `DIALABLE_NATIONAL` is the ten-digit tail, used for the leak sweep.
 */
const DIALABLE = ['+9', '1', '70', '1234', '5678'].join('');
const DIALABLE_NATIONAL = DIALABLE.slice(3);

const LOOP_NAMES = [
  'phone-dial',
  'phone-due',
  'phone-reclaim',
  'phone-maintain',
  'phone-reconcile',
] as const;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A screening config with the two RUNTIME switches set explicitly.
 *
 * `dialMode` is `synthetic` rather than the shipped `off` because the two
 * gates are different gates and this suite exercises both sides of the
 * distinction. `isPhoneRuntimeActive` — the CONSTRUCTION gate proved in block
 * A — is the two switches and nothing else; `runPhoneDuePass` additionally
 * refuses a `dialMode` of `off`. A `synthetic` mode therefore lets the loops
 * be observed doing real work while still reaching no carrier: it resolves the
 * synthetic SIP client, which holds no SDK reference at all.
 *
 * The `off` case belongs to `runPhoneDuePass`'s own suite and is not
 * duplicated here.
 */
function screeningConfig(
  screeningEnabled: boolean,
  runtimeEnabled: boolean,
): PhoneScreeningConfig {
  return {
    ...loadPhoneScreeningConfig({} as NodeJS.ProcessEnv),
    screeningEnabled,
    runtimeEnabled,
    dialMode: 'synthetic',
  };
}

/** Fast, explicit cadences. Passed directly, so no env and no clamping. */
function runtimeConfig(over: Partial<PhoneRuntimeConfig> = {}): PhoneRuntimeConfig {
  return {
    dueMs: 1_000,
    reclaimMs: 5_000,
    reconcileMs: 30_000,
    expireMs: 10_000,
    dueLimit: 3,
    reclaimLimit: 25,
    jobLeaseSeconds: 60,
    ...over,
  };
}

interface Counters {
  /**
   * Due passes ENTERED, counted at the reader's `listDueEngagements`.
   *
   * It used to be counted at `stores.backlog`, on the reasoning that the
   * backlog read is the first thing `runPhoneDuePass` awaits. That stopped
   * being true when the dial loop grew a fail-closed `shouldClaim` that reads
   * the same halt row: one `backlog()` no longer means one due pass, and a
   * counter that conflates two callers reports a number no assertion can
   * interpret. `listDueEngagements` is reached by the due pass and by nothing
   * else, so it counts passes and only passes.
   *
   * It counts passes that got PAST the halt gate — a halted pass returns
   * before the reader is touched. This suite always runs with the halt clear;
   * the halted case is `runPhoneDuePass`'s own suite.
   */
  duePasses: number;
  /** Every `stores.backlog()`, from the due pass AND from the dial loop's halt gate. */
  backlogReads: number;
  reclaims: number;
  expires: number;
  claims: string[];
}

function counters(): Counters {
  return { duePasses: 0, backlogReads: 0, reclaims: 0, expires: 0, claims: [] };
}

/**
 * The three store calls the four loops actually reach.
 *
 * `backlog` is read by TWO callers now — the due pass, and the dial loop's
 * fail-closed `shouldClaim` — so it counts into `backlogReads` and the due
 * pass is counted at the reader instead. See `Counters.duePasses`.
 */
function makeStores(
  c: Counters,
  over: Partial<Record<'backlog' | 'reclaimAttemptLeases' | 'expireAppointments', unknown>> = {},
): PhoneStores {
  return {
    async backlog() {
      c.backlogReads += 1;
      return {
        status: 'ok',
        admission: { controlPresent: true, halted: false, haltReason: null },
      };
    },
    async reclaimAttemptLeases() {
      c.reclaims += 1;
      return { status: 'ok', reclaimed: 0 };
    },
    async expireAppointments() {
      c.expires += 1;
      return { status: 'ok', expired: 0 };
    },
    ...over,
  } as unknown as PhoneStores;
}

/**
 * The reader port, shaped by the COMPILER rather than by a cast.
 *
 * `Partial<PhoneRuntimeReader>` and a plain return type are load-bearing: this
 * fake used to be built with `readRecord`/`readTemplate` behind an
 * `as unknown as PhoneRuntimeReader`, which are not the names `ConsentReader`
 * declares (`latestConsentRecord`/`activeConsentTemplate`). Nothing here
 * reaches consent today, so the mismatch was inert — but the first loops-level
 * test to go through the consent preflight would have called a method that
 * does not exist and baselined whatever came back. A fake that is shaped
 * differently from production is the definition of a fake that is kinder than
 * production, so the cast is gone and every method below is checked against
 * the real port.
 */
function makeReader(over: Partial<PhoneRuntimeReader> = {}, c?: Counters): PhoneRuntimeReader {
  return {
    async listDueEngagements() {
      if (c !== undefined) c.duePasses += 1;
      return [];
    },
    async listDialableNumbers() { return new Map(); },
    async findReusableSession() { return null; },
    // No session is owned and none is reusable by default: the default fixture
    // has no engagement carrying one, and a fake that answered otherwise would
    // let a pass adopt a session this suite never created.
    async countLiveEngagements() { return 1; },
    async engagementOwningSession() { return null; },
    async readSessionForReuse() { return null; },
    consent: {
      async latestConsentRecord() { return null; },
      async activeConsentTemplate() { return null; },
    },
    ...over,
  };
}

/** An always-empty queue that records every queue name it is asked to claim. */
function makeEmptyQueue(c: Counters): Queue {
  return {
    async claim(name: string) { c.claims.push(name); return null; },
    async completeClaim() { return true; },
    async failClaim() { return 'failed'; },
    async heartbeat() { return true; },
    async deferClaim() { return 'deferred'; },
  } as unknown as Queue;
}

const live: PhoneRuntimeHandle[] = [];

/** Build a REAL runtime with both switches on and every dependency injected. */
function buildRuntime(opts: {
  stores?: PhoneStores;
  reader?: PhoneRuntimeReader;
  queue?: Queue;
  config?: Partial<PhoneRuntimeConfig>;
  random?: () => number;
  /** Supply to count due-pass entries; the default reader counts nothing. */
  counters?: Counters;
} = {}): PhoneRuntimeHandle {
  const handle = createPhoneRuntime({
    config: screeningConfig(true, true),
    runtimeConfig: runtimeConfig(opts.config),
    // A bare object is enough: every consumer of the client in this package is
    // a closure factory that performs no I/O at construction, and no loop in
    // this suite reaches a query.
    client: {} as never,
    queue: opts.queue ?? makeEmptyQueue(counters()),
    stores: opts.stores ?? makeStores(counters()),
    reader: opts.reader ?? makeReader({}, opts.counters),
    owner: 'phone-test-owner',
    scheduler: { random: opts.random ?? (() => 0.5) },
  });
  expect(handle).not.toBeNull();
  live.push(handle!);
  return handle!;
}

function loopHealth(runtime: PhoneRuntimeHandle, name: string) {
  return runtime.scheduler.health().loops.find((l) => l.name === name)!;
}

function totalTicks(runtime: PhoneRuntimeHandle): number {
  return runtime.scheduler.health().loops.reduce((n, l) => n + l.ticks, 0);
}

/** Drain already-resolved promises. No timers, no sleeps. */
async function until(pred: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  // 11:30 IST — inside the calling window, which `runPhoneDuePass` now checks
  // before it reads a number or provisions a session. Left on the wall clock
  // this suite would offer dials in the morning and skip them at midnight, so
  // the instant is pinned rather than inherited.
  vi.setSystemTime(new Date('2026-08-24T06:00:00.000Z'));
});

afterEach(async () => {
  // Every registration is cleared so no test can leak one into the next — the
  // registry is process-global and `phoneRuntimeView` reads it directly.
  clearPhoneRuntimeRegistration();
  while (live.length > 0) {
    const handle = live.pop()!;
    await handle.stop();
  }
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// A. THE DISABLED GATE  (RED MUTATION PROOF #1)
// ═════════════════════════════════════════════════════════════════════════════
//
// MUTATION CONTROL. Every assertion in this block turns RED if this ONE line
// is deleted from `lib/phone-runtime/runtime.ts`:
//
//     if (!isPhoneRuntimeActive(config)) return null;
//
//   * the three table rows fail because `createPhoneRuntime` would return a
//     handle instead of null;
//   * the booby-trap case fails because construction would read
//     `options.runtimeConfig` and the throwing getter would escape;
//   * and the inverted row (both switches on ⇒ NOT null) is what stops the
//     suite from passing against a factory that has been mutated to
//     `return null` unconditionally.
//
describe('A. the disabled gate — nothing is constructed when either switch is off', () => {
  const table: ReadonlyArray<{
    label: string;
    screening: boolean;
    runtime: boolean;
    expectNull: boolean;
  }> = [
    { label: 'both off (the shipped default)', screening: false, runtime: false, expectNull: true },
    { label: 'screening on, runtime off', screening: true, runtime: false, expectNull: true },
    { label: 'screening off, runtime on', screening: false, runtime: true, expectNull: true },
    { label: 'both on (the inverted control)', screening: true, runtime: true, expectNull: false },
  ];

  for (const row of table) {
    it(`${row.label} ⇒ ${row.expectNull ? 'null' : 'a handle'}`, () => {
      if (row.expectNull) {
        const handle = createPhoneRuntime({ config: screeningConfig(row.screening, row.runtime) });
        expect(handle).toBeNull();
        return;
      }
      // The inverted control. Fully injected so it constructs no client and
      // arms no timer (nothing is armed until `start()`).
      const handle = buildRuntime();
      expect(handle).not.toBeNull();
      expect(handle.loopIntervalsMs).toBeTruthy();
    });
  }

  it('touches NO dependency before the gate — every post-gate option throws if read', () => {
    // Each of these is read only AFTER `isPhoneRuntimeActive`. A getter that
    // throws therefore proves the gate short-circuits the whole composition
    // root, rather than merely proving that a null was returned at the end.
    const touched: string[] = [];
    const options = { config: screeningConfig(false, false) } as PhoneRuntimeOptions;
    for (const key of ['runtimeConfig', 'dialConfig', 'client', 'queue', 'owner', 'reader', 'stores', 'scheduler']) {
      Object.defineProperty(options, key, {
        enumerable: true,
        configurable: true,
        get() {
          touched.push(key);
          throw new Error(`phone_runtime_constructed_${key}`);
        },
      });
    }

    expect(() => createPhoneRuntime(options)).not.toThrow();
    expect(createPhoneRuntime(options)).toBeNull();
    expect(touched).toEqual([]);
  });

  it('the same booby-trapped options DO get read once the gate opens (the trap is real)', () => {
    // Negative control for the control: if the getters were never wired up,
    // the previous test would pass vacuously.
    const options = { config: screeningConfig(true, true) } as PhoneRuntimeOptions;
    Object.defineProperty(options, 'runtimeConfig', {
      enumerable: true,
      configurable: true,
      get() { throw new Error('phone_runtime_constructed_runtimeConfig'); },
    });
    expect(() => createPhoneRuntime(options)).toThrow(/phone_runtime_constructed_runtimeConfig/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. LOOP LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

describe('B. loop lifecycle', () => {
  it('a started runtime registers exactly the five named loops', () => {
    const runtime = buildRuntime();
    runtime.scheduler.start();

    const names = runtime.scheduler.health().loops.map((l) => l.name).sort();
    // Both directions: no loop missing, and no loop extra.
    expect(names).toEqual([...LOOP_NAMES].sort());
    expect(Object.keys(runtime.loopIntervalsMs).sort()).toEqual([...LOOP_NAMES].sort());
    for (const name of LOOP_NAMES) {
      expect(loopHealth(runtime, name).running).toBe(true);
    }
  });

  it('each loop reads the knob it is NAMED for — no two cadences are welded together', () => {
    // REGRESSION GUARD. The dropped-webhook sweep was once welded into
    // `phone-maintain`, so `PHONE_RUNTIME_RECONCILE_MS` parsed, clamped,
    // appeared in the environment schema — and moved nothing, because the
    // sweep ran at `expireMs`. The loop NAMES differed; the cadences did not,
    // and no name-level assertion could see it. So the mapping is asserted
    // against four DELIBERATELY DISTINCT values, which is the only shape in
    // which "welded to the wrong knob" is visible.
    const knobs = { dueMs: 1_000, reclaimMs: 2_000, expireMs: 3_000, reconcileMs: 4_000 };
    const runtime = buildRuntime({ config: knobs });

    expect(runtime.loopIntervalsMs).toEqual({
      'phone-dial': knobs.dueMs,
      'phone-due': knobs.dueMs,
      'phone-reclaim': knobs.reclaimMs,
      'phone-maintain': knobs.expireMs,
      'phone-reconcile': knobs.reconcileMs,
    });
    expect(runtime.loopIntervalsMs['phone-maintain']).toBe(knobs.expireMs);
    expect(runtime.loopIntervalsMs['phone-reconcile']).toBe(knobs.reconcileMs);
    // The two that were welded must be able to differ.
    expect(runtime.loopIntervalsMs['phone-maintain'])
      .not.toBe(runtime.loopIntervalsMs['phone-reconcile']);
  });

  it('the reconcile knob really drives the scheduler, not just the reported map', async () => {
    // `loopIntervalsMs` is a REPORT. A map that says 4 000 while the scheduler
    // was armed at `expireMs` would satisfy the test above and still be the
    // original defect, so the cadence is also observed as a TICK RATIO: with
    // reconcile twenty times faster than maintain, it must tick many times
    // more often.
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c),
      queue: makeEmptyQueue(c),
      config: { dueMs: 60_000, reclaimMs: 60_000, expireMs: 20_000, reconcileMs: 1_000 },
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);

    const reconcileTicks = loopHealth(runtime, 'phone-reconcile').ticks;
    const maintainTicks = loopHealth(runtime, 'phone-maintain').ticks;
    expect(reconcileTicks).toBeGreaterThanOrEqual(4);
    expect(maintainTicks).toBeLessThanOrEqual(1);
    expect(reconcileTicks).toBeGreaterThan(maintainTicks);
  });

  it('stop() stops EVERY loop — ticks are frozen across many further intervals', async () => {
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c), counters: c });
    runtime.scheduler.start();

    await vi.advanceTimersByTimeAsync(20_000);
    const before = runtime.scheduler.health().loops.map((l) => [l.name, l.ticks] as const);
    expect(totalTicks(runtime)).toBeGreaterThan(0);

    await runtime.stop();
    const dueBefore = c.duePasses;

    await vi.advanceTimersByTimeAsync(200_000);

    expect(runtime.scheduler.health().loops.map((l) => [l.name, l.ticks] as const)).toEqual(before);
    expect(c.duePasses).toBe(dueBefore);
    expect(runtime.scheduler.running()).toBe(false);
    for (const name of LOOP_NAMES) expect(loopHealth(runtime, name).running).toBe(false);
  });

  it('stop() is idempotent — twice does not throw and does not double-count', async () => {
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c), counters: c });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    await runtime.stop();
    const snapshot = runtime.scheduler.health().loops.map((l) => [l.name, l.ticks] as const);
    const dueAfterFirstStop = c.duePasses;

    await expect(runtime.stop()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(50_000);

    expect(runtime.scheduler.health().loops.map((l) => [l.name, l.ticks] as const)).toEqual(snapshot);
    expect(c.duePasses).toBe(dueAfterFirstStop);
  });

  it('cold start is anchored to NOW — no historical storm, and the first tick is staggered', async () => {
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c),
      queue: makeEmptyQueue(c),
      counters: c,
      config: { dueMs: 1_000, reclaimMs: 5_000, expireMs: 10_000, reconcileMs: 30_000 },
      random: () => 0.5, // mid-stagger: first tick at half an interval
    });
    runtime.scheduler.start();

    // t = 0: armed, but nothing has run. A backlog-replaying restart would
    // fire every loop here.
    await vi.advanceTimersByTimeAsync(0);
    expect(c.duePasses).toBeLessThanOrEqual(1);
    expect(c.duePasses).toBe(0);
    expect(totalTicks(runtime)).toBe(0);

    // Across the FIRST FULL due interval every loop is bounded by one tick —
    // a self-rescheduling loop cannot replay the backlog it "missed".
    await vi.advanceTimersByTimeAsync(1_000);
    for (const loop of runtime.scheduler.health().loops) {
      expect(loop.ticks).toBeLessThanOrEqual(1);
    }
    // ...and the two `dueMs` loops have in fact ticked exactly once, so the
    // bound above is not satisfied by a scheduler that never runs at all.
    expect(loopHealth(runtime, 'phone-due').ticks).toBe(1);
    expect(loopHealth(runtime, 'phone-dial').ticks).toBe(1);
    expect(c.duePasses).toBe(1);
    // The slower loops have not yet reached their own stagger.
    expect(c.reclaims).toBe(0);
    expect(c.expires).toBe(0);
    expect(loopHealth(runtime, 'phone-reconcile').ticks).toBe(0);
  });

  it('a due pass slower than its interval is entered exactly ONCE — no overlap', async () => {
    const c = counters();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    // Held open INSIDE the pass rather than at the backlog read: the dial
    // loop's halt gate reads the backlog too, so gating there would stall a
    // second loop and count a second caller. `listDueEngagements` is the due
    // pass and nothing else.
    const reader = makeReader({
      async listDueEngagements() {
        c.duePasses += 1;
        await gate; // held open far longer than `dueMs`
        return [];
      },
    });

    const runtime = buildRuntime({
      stores: makeStores(c),
      reader,
      queue: makeEmptyQueue(c),
      config: { dueMs: 1_000 },
    });
    runtime.scheduler.start();

    // Twenty intervals go by while the first pass is still in flight.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.duePasses).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    // Only after it settles does the loop schedule its next pass.
    expect(c.duePasses).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.duePasses).toBeGreaterThan(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. ERROR ISOLATION
// ═════════════════════════════════════════════════════════════════════════════

describe('C. a rejecting loop never kills the scheduler', () => {
  it('the failing loop counts errors and retries; its siblings keep ticking', async () => {
    const c = counters();
    let reclaimCalls = 0;
    const stores = makeStores(c, {
      async reclaimAttemptLeases() {
        reclaimCalls += 1;
        throw new Error('reclaim_boom');
      },
    });

    const runtime = buildRuntime({
      stores,
      queue: makeEmptyQueue(c),
      counters: c,
      config: { dueMs: 1_000, reclaimMs: 1_000, expireMs: 1_000 },
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);

    const reclaim = loopHealth(runtime, 'phone-reclaim');
    expect(reclaimCalls).toBeGreaterThanOrEqual(2);
    expect(reclaim.errors).toBeGreaterThanOrEqual(2);
    expect(reclaim.consecutiveErrors).toBeGreaterThanOrEqual(2);
    expect(reclaim.errors).toBe(reclaimCalls);
    // It ticked AGAIN after the first rejection — the loop was not torn down.
    expect(reclaim.ticks).toBeGreaterThanOrEqual(2);
    expect(reclaim.running).toBe(true);

    // The siblings are unaffected.
    expect(runtime.scheduler.running()).toBe(true);
    expect(c.duePasses).toBeGreaterThanOrEqual(2);
    expect(c.expires).toBeGreaterThanOrEqual(2);
    expect(loopHealth(runtime, 'phone-due').errors).toBe(0);
    expect(loopHealth(runtime, 'phone-maintain').errors).toBe(0);
    expect(loopHealth(runtime, 'phone-reconcile').errors).toBe(0);
  });

  it('consecutiveErrors RESETS after a success, while the lifetime error count stands', async () => {
    const c = counters();
    let calls = 0;
    const stores = makeStores(c, {
      async reclaimAttemptLeases() {
        calls += 1;
        if (calls <= 2) throw new Error('reclaim_boom');
        return { status: 'ok', reclaimed: 1 };
      },
    });

    const runtime = buildRuntime({
      stores,
      queue: makeEmptyQueue(c),
      config: { dueMs: 60_000, reclaimMs: 1_000, expireMs: 60_000 },
    });
    runtime.scheduler.start();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(loopHealth(runtime, 'phone-reclaim').consecutiveErrors).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(30_000);
    const reclaim = loopHealth(runtime, 'phone-reclaim');
    expect(calls).toBeGreaterThan(2);
    expect(reclaim.errors).toBe(2);          // lifetime count is not rewritten
    expect(reclaim.consecutiveErrors).toBe(0); // but the streak is cleared
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. HEALTH VIEW
// ═════════════════════════════════════════════════════════════════════════════

function loopView(over: Partial<PhoneLoopHealthView> = {}): PhoneLoopHealthView {
  return {
    name: 'phone-due',
    running: true,
    lastTickAt: null,
    ticks: 1,
    errors: 0,
    consecutiveErrors: 0,
    stale: false,
    ...over,
  };
}

function makeView(over: Partial<PhoneRuntimeView> = {}): PhoneRuntimeView {
  return {
    enabled: true,
    running: true,
    loops: [],
    last_due: null,
    config: {},
    dial_jobs: {},
    last_reclaimed: null,
    last_expired: null,
    last_reconciled: null,
    sweeps_not_ok: [],
    ...over,
  };
}

describe('D. the health view', () => {
  it('with nothing registered the view is the unregistered shape', () => {
    const v = phoneRuntimeView();
    expect(v).toEqual({
      enabled: false,
      running: false,
      loops: [],
      last_due: null,
      // The published cadence map is empty too — an unregistered process has
      // resolved no knobs and must not imply it has.
      config: {},
      dial_jobs: {},
      last_reclaimed: null,
      last_expired: null,
      last_reconciled: null,
      // No sweep has run, so none has failed. Empty, never a fabricated name.
      sweeps_not_ok: [],
    });

    // AND IT IS NOT A FAULT. A process that is not running the phone loops is
    // the SHIPPED DEFAULT — both switches are false out of the box, and most
    // machines in the fleet will never construct a runtime. Reporting that as
    // degradation would mark every healthy deployment degraded, so the
    // process-local view contributes NOTHING when it is disabled. The durable
    // backlog in `phone_backlog` is where "is the fleet dialling?" is answered.
    expect(phoneRuntimeDegradeReasons(v)).toEqual([]);
  });

  it('after register + start the view is enabled and the loop list is populated', async () => {
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c) });
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const v = phoneRuntimeView();
    expect(v.enabled).toBe(true);
    expect(v.running).toBe(true);
    expect(v.loops.map((l) => l.name).sort()).toEqual([...LOOP_NAMES].sort());
    expect(v.loops.every((l) => l.running)).toBe(true);
    expect(v.last_due).not.toBeNull();
    expect(v.last_due!.status).toBe('ok');

    // The published cadence map: integers and nothing else. This is the whole
    // disclosure claim for `config` — no identifier, credential or digest can
    // be an integer.
    expect(Object.keys(v.config).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(v.config)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(v.config.due_ms).toBe(runtime.loopIntervalsMs['phone-due']);
    expect(v.config.expire_ms).toBe(runtime.loopIntervalsMs['phone-maintain']);
    expect(v.config.reconcile_ms).toBe(runtime.loopIntervalsMs['phone-reconcile']);
  });

  it('clearPhoneRuntimeRegistration() returns the view to the unregistered shape', async () => {
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c) });
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(phoneRuntimeView().enabled).toBe(true);

    clearPhoneRuntimeRegistration();

    expect(phoneRuntimeView()).toEqual({
      enabled: false,
      running: false,
      loops: [],
      last_due: null,
      // The published cadence map is empty too — an unregistered process has
      // resolved no knobs and must not imply it has.
      config: {},
      dial_jobs: {},
      last_reclaimed: null,
      last_expired: null,
      last_reconciled: null,
      // No sweep has run, so none has failed. Empty, never a fabricated name.
      sweeps_not_ok: [],
    });
  });

  describe('phoneRuntimeDegradeReasons is a pure function of a view', () => {
    const table: ReadonlyArray<{ label: string; view: PhoneRuntimeView; expected: string[] }> = [
      {
        label: 'disabled contributes nothing (the shipped default, not a fault)',
        view: makeView({ enabled: false, running: false }),
        expected: [],
      },
      {
        label: 'enabled and healthy',
        view: makeView({ loops: [loopView()] }),
        expected: [],
      },
      {
        label: 'stopped ⇒ phone_runtime_stopped',
        view: makeView({ running: false, loops: [loopView({ running: false })] }),
        expected: ['phone_runtime_stopped'],
      },
      {
        label: 'a stale loop ⇒ phone_loop_stale',
        view: makeView({ loops: [loopView(), loopView({ name: 'phone-reclaim', stale: true })] }),
        expected: ['phone_loop_stale'],
      },
      {
        label: 'consecutiveErrors > 0 ⇒ phone_loop_erroring',
        view: makeView({ loops: [loopView({ errors: 3, consecutiveErrors: 1 })] }),
        expected: ['phone_loop_erroring'],
      },
      {
        label: 'lifetime errors with a cleared streak is NOT degradation',
        view: makeView({ loops: [loopView({ errors: 9, consecutiveErrors: 0 })] }),
        expected: [],
      },
      {
        label: "last due status 'halted' ⇒ phone_due_halted",
        view: makeView({
          loops: [loopView()],
          last_due: { status: 'halted', examined: 0, offered: 0, dialing: 0, skipped: {}, refusals: {} },
        }),
        expected: ['phone_due_halted'],
      },
      {
        // A sweep that did not run is not a sweep that found nothing. The
        // count alone cannot carry that difference, which is why the reason
        // exists at all.
        label: 'a non-ok sweep ⇒ phone_sweep_not_ok',
        view: makeView({ loops: [loopView()], sweeps_not_ok: ['reclaim'] }),
        expected: ['phone_sweep_not_ok'],
      },
      {
        label: 'every reason at once, in declaration order',
        view: makeView({
          running: false,
          loops: [loopView({ stale: true, errors: 2, consecutiveErrors: 2 })],
          last_due: { status: 'halted', examined: 0, offered: 0, dialing: 0, skipped: {}, refusals: {} },
          sweeps_not_ok: ['reclaim', 'expire'],
        }),
        expected: [
          'phone_runtime_stopped',
          'phone_loop_stale',
          'phone_loop_erroring',
          'phone_due_halted',
          'phone_sweep_not_ok',
        ],
      },
    ];

    for (const row of table) {
      it(row.label, () => {
        expect(phoneRuntimeDegradeReasons(row.view)).toEqual(row.expected);
      });
    }
  });

  it('staleness uses the real window: max(MIN_STALE_WINDOW_MS, interval × STALE_TICK_MULTIPLIER)', async () => {
    const c = counters();
    // `phone-due` at 1 s floors to MIN_STALE_WINDOW_MS (30 s); `phone-maintain`
    // at 20 s multiplies to 60 s. One clock reading therefore exercises BOTH
    // arms of the Math.max at once.
    const runtime = buildRuntime({
      stores: makeStores(c),
      queue: makeEmptyQueue(c),
      config: { dueMs: 1_000, reclaimMs: 1_000, expireMs: 20_000, reconcileMs: 20_000 },
    });
    registerPhoneRuntime(runtime);
    runtime.scheduler.start(); // armed; timers deliberately NOT advanced

    const dueWindow = Math.max(MIN_STALE_WINDOW_MS, 1_000 * STALE_TICK_MULTIPLIER);
    const slowWindow = Math.max(MIN_STALE_WINDOW_MS, 20_000 * STALE_TICK_MULTIPLIER);
    expect(dueWindow).toBe(MIN_STALE_WINDOW_MS);
    expect(slowWindow).toBe(20_000 * STALE_TICK_MULTIPLIER);

    const t0 = Date.now();
    const inside = phoneRuntimeView(new Date(t0 + dueWindow - 1));
    expect(inside.loops.every((l) => l.stale)).toBe(false);

    const between = phoneRuntimeView(new Date(t0 + dueWindow + 1_000));
    expect(between.loops.find((l) => l.name === 'phone-due')!.stale).toBe(true);
    expect(between.loops.find((l) => l.name === 'phone-maintain')!.stale).toBe(false);
    expect(between.loops.find((l) => l.name === 'phone-reconcile')!.stale).toBe(false);
    expect(phoneRuntimeDegradeReasons(between)).toContain('phone_loop_stale');

    const past = phoneRuntimeView(new Date(t0 + slowWindow + 1_000));
    expect(past.loops.every((l) => l.stale)).toBe(true);
  });

  it('NO IDENTIFIER LEAKS: a due pass with sentinel ids leaves none of them in the view', async () => {
    const c = counters();
    const reader = makeReader({
      async listDueEngagements() {
        return [
          {
            engagementId: SENTINEL_ENGAGEMENT,
            state: 'eligible',
            candidateId: SENTINEL_CANDIDATE,
            roleId: SENTINEL_ROLE,
            sessionId: SENTINEL_SESSION,
            nextEligibleAt: null,
            noAnswerAttempts: 0,
            updatedAt: null,
          },
          {
            // No dialable number ⇒ a `no_dialable_number` SKIP code.
            engagementId: SENTINEL_ENGAGEMENT_2,
            state: 'eligible',
            candidateId: SENTINEL_CANDIDATE_2,
            roleId: null,
            sessionId: null,
            nextEligibleAt: null,
            noAnswerAttempts: 0,
            updatedAt: null,
          },
        ];
      },
      async listDialableNumbers() {
        // Only the first candidate is dialable, so exactly one row is OFFERED
        // and produces a REFUSAL code, and one row produces a SKIP code.
        return new Map([[SENTINEL_CANDIDATE, wrapDialableNumber(DIALABLE)]]);
      },
      // Reusing an existing session keeps the pass off `createSession`, which
      // would reach the real Supabase client. Both reuse paths are answered
      // because the first row names a session on the engagement (the VERIFIED
      // `existingSessionId` path) while the second does not (the adoption
      // path), and the port refuses either unless the session is resumable,
      // carries its own derived room name, and is owned by nobody else.
      async readSessionForReuse() { return { status: 'waiting', roomVerified: true }; },
      async findReusableSession() { return SENTINEL_SESSION; },
      async engagementOwningSession() { return null; },
    });

    // One `phone.dial` job carrying the sentinel attempt id, so the dial-job
    // outcome path is exercised with an identifier in hand too.
    let offered = false;
    const queue = {
      async claim(name: string): Promise<QueueJob<unknown> | null> {
        c.claims.push(name);
        if (offered || name !== PHONE_DIAL_QUEUE) return null;
        offered = true;
        return {
          id: SENTINEL_ATTEMPT,
          name,
          payload: { provider: 'phone', attemptId: SENTINEL_ATTEMPT },
          status: 'active',
          attempts: 1,
          maxAttempts: 5,
          priority: 0,
          scheduledAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          leaseToken: 'lease-token',
        } as unknown as QueueJob<unknown>;
      },
      async completeClaim() { return true; },
      async failClaim() { return 'failed'; },
      async heartbeat() { return true; },
      async deferClaim() { return 'deferred'; },
    } as unknown as Queue;

    const runtime = buildRuntime({
      stores: makeStores(c),
      reader,
      queue,
      config: { dueMs: 1_000 },
    });
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await until(() => runtime.runner.inFlight() === 0);

    const v = phoneRuntimeView();

    // The pass really did run and really did produce codes — otherwise the
    // leak assertion below would be vacuous.
    expect(v.last_due).not.toBeNull();
    expect(v.last_due!.status).toBe('ok');
    expect(v.last_due!.examined).toBe(2);
    expect(v.last_due!.offered).toBe(1);
    expect(v.last_due!.skipped.no_dialable_number).toBe(1);
    expect(Object.keys(v.last_due!.refusals)).toHaveLength(1);
    expect(Object.values(v.dial_jobs).reduce((a, b) => a + b, 0)).toBe(1);

    const serialized = JSON.stringify(v);
    for (const id of [
      SENTINEL_ENGAGEMENT,
      SENTINEL_ENGAGEMENT_2,
      SENTINEL_CANDIDATE,
      SENTINEL_CANDIDATE_2,
      SENTINEL_SESSION,
      SENTINEL_ATTEMPT,
      SENTINEL_ROLE,
    ]) {
      expect(serialized).not.toContain(id);
    }
    // Nor the number, nor its digest.
    expect(serialized).not.toContain(DIALABLE_NATIONAL);
    expect(serialized).not.toContain(wrapDialableNumber(DIALABLE).digest);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. QUEUE / DIAL LOOP  (RED MUTATION PROOF #2)
// ═════════════════════════════════════════════════════════════════════════════
//
// MUTATION CONTROL — stated as what a PRODUCTION edit can actually do.
//
// Injecting a second `runJob(job, job.leaseToken)` alongside the tracked one
// in `createQueueRunner`'s fill loop turns THREE assertions red, and they were
// each run against that mutation rather than assumed:
//
//   * `outcomes(a) + outcomes(b)` becomes 2 in `two concurrent claimers ...`;
//   * `world.completeLog` becomes `['job-once','job-once']` in `a resolving
//     handler completes the job ...`;
//   * the `dial_jobs` total becomes 2 in block D's `NO IDENTIFIER LEAKS`.
//
// That is the property this block proves: ONE CLAIM ⇒ ONE HANDLER RUN ⇒ ONE
// COMPLETION. No double-PROCESSING inside a runner.
//
// What they do NOT prove, said plainly so nobody reads more into the green:
//
//   * `expect(world.handedOut).toEqual(['job-single'])` is decided entirely
//     by the fake's own `lockedBy`/`completed` bookkeeping — `jobs.find(...)`
//     cannot return a row that is already locked or completed, whatever the
//     runner does. No production mutation can turn that assertion red, so it
//     is a PRECONDITION on the fake, not a proof about the code.
//   * The `!job.leaseToken` half of `if (!job || !job.leaseToken) break;` is
//     unreachable from here: `skipLockedQueue` attaches a lease token to
//     every row it hands out, so the fence's second half is never exercised.
//     Removing it leaves this suite green. (Verified.)
//   * Double-CLAIMING ACROSS REPLICAS is a `FOR UPDATE SKIP LOCKED` + CAS
//     guarantee that lives in SQL, not in TypeScript. It is modelled here,
//     never tested here. Its real proof is
//     `app/supabase/tests/phone_admission_concurrency_setup.sql` /
//     `_assert.sql`, and the acceptance item "concurrent claims ⇒ one winner"
//     is discharged there.
//
// The fake still earns its place: it is what lets one claimed row be offered
// to two runners at once so the one-handler-run property can be observed at
// all.

/**
 * A queue that models `FOR UPDATE SKIP LOCKED`: a claimed row is INVISIBLE to
 * every other claimer, and a completed row is gone for good. The `await` before
 * the select is what makes two concurrent claims genuinely interleave.
 */
function skipLockedQueue(jobs: Array<{ id: string; name: string; payload: unknown }>) {
  const lockedBy = new Map<string, string>();
  const completed = new Set<string>();
  const claimLog: Array<{ queueName: string; owner: string; jobId: string | null }> = [];
  const completeLog: string[] = [];
  const handedOut: string[] = [];

  const queue = {
    async claim(name: string, options: { owner: string }): Promise<QueueJob<unknown> | null> {
      await Promise.resolve(); // the round trip a real claim makes
      const job = jobs.find(
        (j) => j.name === name && !lockedBy.has(j.id) && !completed.has(j.id),
      );
      if (!job) {
        claimLog.push({ queueName: name, owner: options.owner, jobId: null });
        return null;
      }
      lockedBy.set(job.id, options.owner);
      claimLog.push({ queueName: name, owner: options.owner, jobId: job.id });
      handedOut.push(job.id);
      return {
        id: job.id,
        name: job.name,
        payload: job.payload,
        status: 'active',
        attempts: 1,
        maxAttempts: 5,
        priority: 0,
        scheduledAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        leaseToken: `lease-${job.id}`,
        leaseOwner: options.owner,
      } as unknown as QueueJob<unknown>;
    },
    async completeClaim(jobId: string, leaseToken: string): Promise<boolean> {
      if (leaseToken !== `lease-${jobId}`) return false; // the CAS
      completed.add(jobId);
      lockedBy.delete(jobId);
      completeLog.push(jobId);
      return true;
    },
    async failClaim() { return 'failed'; },
    async heartbeat() { return true; },
    async deferClaim() { return 'deferred'; },
  } as unknown as Queue;

  return { queue, claimLog, completeLog, handedOut, completed };
}

describe('E. the dial loop', () => {
  it('claims from `phone.dial` and from no other queue', async () => {
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c) });

    await runtime.tickAll();
    await until(() => runtime.runner.inFlight() === 0);

    expect(PHONE_DIAL_QUEUE).toBe('phone.dial');
    expect(c.claims).toEqual([PHONE_DIAL_QUEUE]);
    expect([...new Set(c.claims)]).toEqual(['phone.dial']);
  });

  it('two concurrent claimers over one job ⇒ the handler runs EXACTLY ONCE', async () => {
    const world = skipLockedQueue([
      {
        id: 'job-single',
        name: PHONE_DIAL_QUEUE,
        payload: { provider: 'phone', attemptId: '11111111-1111-4111-8111-111111111111' },
      },
    ]);

    const a = buildRuntime({ stores: makeStores(counters()), queue: world.queue });
    const b = buildRuntime({ stores: makeStores(counters()), queue: world.queue });

    await Promise.all([a.tickAll(), b.tickAll()]);
    await until(() => a.runner.inFlight() === 0 && b.runner.inFlight() === 0);

    const outcomes = (h: PhoneRuntimeHandle): number =>
      Object.values(h.snapshot().dialJobOutcomes).reduce((x, y) => x + y, 0);

    // PRECONDITION, not a proof: the fake models SKIP LOCKED, so a locked row
    // is invisible to the second claimer by construction. Asserted to show the
    // world behaved as designed — no production edit can make this line fail.
    expect(world.handedOut).toEqual(['job-single']);
    // THE PROPERTY: exactly one handler ran, across BOTH runtimes. This is the
    // line a duplicate `runJob` invocation in `createQueueRunner` turns red.
    expect(outcomes(a) + outcomes(b)).toBe(1);
    // ...and the loser did no work at all.
    const winner = outcomes(a) === 1 ? a : b;
    const loser = winner === a ? b : a;
    expect(outcomes(winner)).toBe(1);
    expect(outcomes(loser)).toBe(0);
    expect(loser.snapshot().dialJobOutcomes).toEqual({});
    // Both nonetheless asked, and both asked only `phone.dial`.
    expect(world.claimLog.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(world.claimLog.map((e) => e.queueName))]).toEqual([PHONE_DIAL_QUEUE]);
    expect(world.completeLog).toEqual(['job-single']);
  });

  it('a resolving handler completes the job, and it is never re-offered', async () => {
    const world = skipLockedQueue([
      {
        id: 'job-once',
        name: PHONE_DIAL_QUEUE,
        payload: { provider: 'phone', attemptId: '22222222-2222-4222-8222-222222222222' },
      },
    ]);
    const runtime = buildRuntime({ stores: makeStores(counters()), queue: world.queue });

    await runtime.tickAll();
    await until(() => runtime.runner.inFlight() === 0);
    expect(world.completeLog).toEqual(['job-once']);
    expect(runtime.snapshot().dialJobOutcomes).toEqual({ completed: 1 });

    // Several more ticks: a completed job must never come back.
    for (let i = 0; i < 5; i++) {
      await runtime.tickAll();
      await until(() => runtime.runner.inFlight() === 0);
    }

    expect(world.handedOut).toEqual(['job-once']);           // handed out ONCE
    expect(world.completeLog).toEqual(['job-once']);          // completed ONCE
    expect(runtime.snapshot().dialJobOutcomes).toEqual({ completed: 1 });
    expect(world.claimLog.filter((e) => e.jobId === null).length).toBeGreaterThanOrEqual(5);
  });
});
