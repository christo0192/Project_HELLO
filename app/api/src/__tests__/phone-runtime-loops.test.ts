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
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import {
  createPhoneRuntime,
  type PhoneRuntimeHandle,
  type PhoneRuntimeOptions,
} from '../lib/phone-runtime/runtime.js';
import {
  MIN_STALE_WINDOW_MS,
  STALE_TICK_MULTIPLIER,
  armPhoneRuntime,
  clearPhoneRuntimeRegistration,
  clearPhoneRuntimeStartFailure,
  phoneRuntimeDegradeReasons,
  phoneRuntimeView,
  recordPhoneRuntimeStartFailure,
  registerPhoneRuntime,
  type PhoneLoopHealthView,
  type PhoneRuntimeView,
} from '../lib/phone-runtime/health.js';
import {
  PHONE_DIAL_QUEUE,
  loadPhoneRuntimeConfig,
  type PhoneRuntimeConfig,
} from '../lib/phone-runtime/config.js';
import {
  PHONE_BOUNDS,
  loadPhoneScreeningConfig,
  type PhoneScreeningConfig,
  type PhoneStores,
} from '../lib/phone-screening/index.js';
import {
  isPhoneWebhookActive,
  loadLiveKitPhoneConfig,
} from '../integrations/livekit-phone/index.js';
import type { PhoneRuntimeReader } from '../lib/phone-runtime/read.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import { loadPhoneDialConfig } from '../integrations/livekit-phone-dial/index.js';
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

/**
 * THE ONE PLACE THE CURRENT LOOP SET IS PINNED.
 *
 * `runtime.ts` keeps the loops in a plain array and DERIVES `loopIntervalsMs`
 * from it, so the production side needs no count and no second list. A test
 * does need to pin the set — "no loop missing and no loop extra" is only
 * assertable against something — but it needs to pin it ONCE. Every assertion
 * below that names the set reads this table, so adding a loop is one entry
 * here plus its knob, and nothing else in this file moves.
 *
 * The map is name -> the `PhoneRuntimeConfig` knob that loop's cadence must
 * come from. That pairing is the regression guard: the dropped-webhook sweep
 * was once welded into `phone-maintain`, so `PHONE_RUNTIME_RECONCILE_MS`
 * parsed, clamped, appeared in the environment schema — and moved nothing.
 */
const LOOP_KNOBS = {
  'phone-dial': 'dueMs',
  'phone-due': 'dueMs',
  'phone-reclaim': 'reclaimMs',
  'phone-maintain': 'expireMs',
  'phone-reconcile': 'reconcileMs',
  // 0045. Both run on the EXPIRE cadence rather than knobs of their own: a
  // day boundary moves once a day, and a stranded engagement is not urgent.
  // They share `expireMs` DELIBERATELY, which is why the knob-mapping test
  // below asserts the reported map against this table rather than asserting
  // that every loop has a distinct cadence.
  'phone-dayroll': 'expireMs',
  'phone-stranded': 'expireMs',
} as const satisfies Readonly<Record<string, keyof PhoneRuntimeConfig>>;

const LOOP_NAMES = Object.keys(LOOP_KNOBS) as ReadonlyArray<keyof typeof LOOP_KNOBS>;

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
  /** 0045. Sweep names handed to `claimSweep`, in order. */
  sweepClaims: string[];
  dayRolls: number;
  strandedSweeps: number;
}

function counters(): Counters {
  return {
    duePasses: 0, backlogReads: 0, reclaims: 0, expires: 0, claims: [],
    sweepClaims: [], dayRolls: 0, strandedSweeps: 0,
  };
}

/**
 * The store calls the loops actually reach.
 *
 * `backlog` is read by TWO callers now — the due pass, and the dial loop's
 * fail-closed `shouldClaim` — so it counts into `backlogReads` and the due
 * pass is counted at the reader instead. See `Counters.duePasses`.
 */
function makeStores(
  c: Counters,
  over: Partial<
    Record<
      'backlog' | 'reclaimAttemptLeases' | 'expireAppointments' | 'admitAttempt'
      | 'claimSweep' | 'sweepDayRolled' | 'sweepStrandedSessions',
      unknown
    >
  > = {},
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
    // 0045. Present on the fake because the two new sweeps CALL them — a
    // fake missing a method the loop reaches does not fail, it makes the
    // loop throw on a tick no test happens to drive, which is how a wired
    // loop ends up with no coverage at all.
    async claimSweep(input: { sweep: string }) {
      c.sweepClaims.push(input.sweep);
      return { status: 'ok' as const };
    },
    async sweepDayRolled() {
      c.dayRolls += 1;
      return { status: 'ok' as const, examined: 0, rolled: 0, skipped: 0 };
    },
    async sweepStrandedSessions() {
      c.strandedSweeps += 1;
      return { status: 'ok' as const, examined: 0, completed: 0, failed: 0, skipped: 0 };
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
  // registry is process-global and `phoneRuntimeView` reads it directly. The
  // construction-failure flag is process-global for the same reason and is
  // cleared beside it, or one M-9 test would mark every later view degraded.
  clearPhoneRuntimeRegistration();
  clearPhoneRuntimeStartFailure();
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
  it('a started runtime registers exactly the loops LOOP_KNOBS names — no more, no fewer', () => {
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
    const knobs = runtimeConfig({
      dueMs: 1_000, reclaimMs: 2_000, expireMs: 3_000, reconcileMs: 4_000,
    });
    const runtime = buildRuntime({ config: knobs });

    // Built from LOOP_KNOBS rather than written out again: a second literal
    // list of loops is a second thing to keep in step with the runtime.
    const expected = Object.fromEntries(
      LOOP_NAMES.map((name) => [name, knobs[LOOP_KNOBS[name]]]),
    );
    expect(runtime.loopIntervalsMs).toEqual(expected);
    // The four DELIBERATELY DISTINCT values above are what makes "welded to
    // the wrong knob" visible at all, so the distinctness is asserted too.
    expect(new Set(Object.values(expected)).size)
      .toBe(new Set(LOOP_NAMES.map((n) => LOOP_KNOBS[n])).size);
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
    last_rolled: null,
    last_stranded: null,
    sweeps_not_ok: [],
    start_failed: false,
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
    last_rolled: null,
    last_stranded: null,
      // No sweep has run, so none has failed. Empty, never a fabricated name.
      sweeps_not_ok: [],
      // Nothing tried to construct a runtime, so nothing failed to. THE ONE
      // FIELD that separates "off" from "broken" — see M-9 below.
      start_failed: false,
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
    last_rolled: null,
    last_stranded: null,
      // No sweep has run, so none has failed. Empty, never a fabricated name.
      sweeps_not_ok: [],
      // Nothing tried to construct a runtime, so nothing failed to. THE ONE
      // FIELD that separates "off" from "broken" — see M-9 below.
      start_failed: false,
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

// ═════════════════════════════════════════════════════════════════════════════
// F. THE CADENCE AND HEALTH-TRUTH REPAIRS  (M-1, M-2, M-4, M-9)
// ═════════════════════════════════════════════════════════════════════════════
//
// Three of these four are about a claim that could not be falsified by the
// thing it claimed to bound:
//
//   * M-2 stated a correctness bound (`reclaimMs` against the attempt lease)
//     by comparing two constants in `config.ts`, while the SCHEDULER decided
//     the actual cadence and was not in the comparison at all. So the bound is
//     measured HERE, against a running scheduler, from the intervals it really
//     produced.
//   * M-4 is the same shape on `phone-due`, where the drift softens the
//     contract's "bounded reconnect approximately 120 seconds".
//   * M-1 and M-9 are health TRUTH: a sweep that is not running, and a runtime
//     that failed to construct, each used to be indistinguishable from the
//     healthy case they most resemble.

/** The gaps between successive recorded instants, in ms. */
function gaps(at: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < at.length; i++) out.push(at[i] - at[i - 1]);
  return out;
}

describe('F. the cadence bounds are measured against the scheduler that decides them', () => {
  it('M-2: an idle `phone-reclaim` never drifts past its own interval — a lapsed lease is seen within HALF a lease-lifetime', async () => {
    // THE STEADY STATE OF THIS SWEEP IS RECLAIMING NOTHING. That used to feed
    // the scheduler's idle backoff, which took the loop to its 60s ceiling
    // while `config.ts` claimed a 30s sweep. A lapsed lease could therefore go
    // unreclaimed for a FULL lease-lifetime, holding one of ten fleet slots
    // against every other candidate.
    //
    // The REAL defaults are used, not the fast fixtures, because the bound is
    // a claim about the shipped configuration. Jitter is pinned to its
    // WIDEST — `nextPollDelayMs` scales by `[0.5, 1.0)`, so `0.999` is the
    // worst (longest) interval the loop can produce.
    const c = counters();
    const at: number[] = [];
    const stores = makeStores(c, {
      async reclaimAttemptLeases() {
        c.reclaims += 1;
        at.push(Date.now());
        return { status: 'ok', reclaimed: 0 }; // nothing to do: the steady state
      },
    });

    const knobs = loadPhoneRuntimeConfig({});
    const runtime = buildRuntime({
      stores,
      queue: makeEmptyQueue(c),
      config: knobs,
      random: () => 0.999,
    });
    runtime.scheduler.start();

    const leaseMs = PHONE_BOUNDS.leaseSeconds!.def * 1_000;
    // Twenty lease-lifetimes: long enough that a backed-off loop has reached
    // and settled at the ceiling, so the two behaviours cannot be confused.
    await vi.advanceTimersByTimeAsync(leaseMs * 20);

    expect(at.length, 'the sweep never ran at all').toBeGreaterThan(2);
    const observed = gaps(at);
    const worst = Math.max(...observed);

    // THE BOUND, stated as the scheduler's own behaviour: every interval this
    // loop produced is at most its configured cadence.
    expect(worst, `worst observed reclaim interval ${worst}ms`)
      .toBeLessThanOrEqual(knobs.reclaimMs);
    // ...and that cadence is at most half the lease, so a lapsed lease is seen
    // within half a lease-lifetime. This is the sentence `config.ts` claims.
    expect(worst * 2).toBeLessThanOrEqual(leaseMs);
    // A count check as well as an interval check: an idle-backed-off loop
    // reaches the 60s ceiling and manages ~21 ticks over this window, against
    // ~40 held at the base cadence.
    expect(at.length).toBeGreaterThanOrEqual(35);
  });

  it('M-2 CONTROL: a THROWING reclaim still backs off — the fix does not create a hot spin', async () => {
    // `HOLD_BASE_CADENCE` is a `didWork` answer, and a tick that throws never
    // reaches it. If the fix had been applied by making the loop unconditional
    // in the scheduler, a broken sweep would hammer the database at its base
    // cadence forever. It must not.
    const c = counters();
    const at: number[] = [];
    const stores = makeStores(c, {
      async reclaimAttemptLeases() {
        at.push(Date.now());
        throw new Error('reclaim_boom');
      },
    });
    const runtime = buildRuntime({
      stores,
      queue: makeEmptyQueue(c),
      config: { dueMs: 60_000, reclaimMs: 1_000, expireMs: 60_000, reconcileMs: 60_000 },
      random: () => 0.999,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(at.length).toBeGreaterThan(2);
    // The gaps GROW: an erroring loop is exactly the case backoff exists for.
    const observed = gaps(at);
    expect(Math.max(...observed)).toBeGreaterThan(1_000);
    expect(loopHealth(runtime, 'phone-reclaim').consecutiveErrors).toBeGreaterThan(1);
  });

  it('M-4: an idle `phone-due` never drifts past its own interval — the reconnect bound is backoff + one due interval', async () => {
    // `return result.dialing > 0` let a pass that dialled nothing back off
    // toward the 60s ceiling. A dropped call becomes due
    // `reconnectBackoffSeconds` after the drop; the pass that would act on it
    // then waited that PLUS up to a fully backed-off due interval, so the
    // contract's "approximately 120 seconds" was bounded by nothing stated.
    const c = counters();
    const at: number[] = [];
    const reader = makeReader({
      async listDueEngagements() {
        c.duePasses += 1;
        at.push(Date.now());
        return []; // nothing due: the idle steady state
      },
    });

    const knobs = loadPhoneRuntimeConfig({});
    const runtime = buildRuntime({
      stores: makeStores(c),
      reader,
      queue: makeEmptyQueue(c),
      config: knobs,
      random: () => 0.999,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(at.length, 'the due pass never ran at all').toBeGreaterThan(2);
    const worst = Math.max(...gaps(at));
    expect(worst, `worst observed due interval ${worst}ms`).toBeLessThanOrEqual(knobs.dueMs);

    // THE BOUND THE CONTRACT ASKS FOR, written out: a reconnect is visible to
    // the pass `reconnectBackoffSeconds` after the drop, and the pass runs at
    // least once per `dueMs`, so the worst case is their sum.
    const config = screeningConfig(true, true);
    const reconnectBoundMs = config.reconnectBackoffSeconds * 1_000 + worst;
    expect(reconnectBoundMs).toBeLessThanOrEqual(config.reconnectBackoffSeconds * 1_000 + knobs.dueMs);
    // ...and that sum is inside a small margin of the contract's figure,
    // rather than the 180s a fully backed-off loop produced.
    expect(reconnectBoundMs).toBeLessThan(config.reconnectBackoffSeconds * 1_000 * 1.5);
  });

  // ═══════════════════════════════════════════════════════════════════
  // M-7 — THE HOLD MUST NOT SURVIVE A PERSISTENT NON-THROWING FAILURE
  // ═══════════════════════════════════════════════════════════════════
  //
  // `HOLD_BASE_CADENCE` is a `didWork` answer, and the scheduler backs off
  // unless `didWork && consecutiveErrors === 0`. The M-2/M-4 repairs returned
  // it UNCONDITIONALLY, and the comment beside it claimed only a THROW could
  // still cause backoff. That is incomplete: a non-`ok` RPC status and a due
  // pass answering `status: 'halted'` are both failures and neither throws.
  //
  // The concrete cost, from the review: with the `phone_control` singleton
  // missing, `runPhoneDuePass` answers `halted` on every pass, so instead of
  // backing off to the 60s ceiling the loop re-ran the halt and backlog RPCs
  // every ~7.5-15s indefinitely, on EVERY replica, for the whole length of an
  // incident. Below, each direction is measured against a control that
  // differs in exactly one thing: whether the pass succeeded.
  //
  // Tick COUNTS rather than gaps, because the halted pass returns before it
  // reaches the reader and `stores.backlog` is read by two callers — a
  // timestamp recorded there would conflate the due loop with the dial
  // loop's halt gate. `loopHealth(...).ticks` is per-loop and unambiguous.

  /** Ticks one named loop managed over `windowMs`, at the widest jitter. */
  async function ticksOver(
    runtime: PhoneRuntimeHandle,
    loop: string,
    windowMs: number,
  ): Promise<number> {
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(windowMs);
    return loopHealth(runtime, loop).ticks;
  }

  const SLOW = { dueMs: 1_000, reclaimMs: 600_000, expireMs: 600_000, reconcileMs: 600_000 };
  const WINDOW = 120_000;
  /**
   * Held at a 1s base cadence a loop ticks ~120 times in 120s; backed off to
   * the 60s ceiling it manages under ten. The threshold sits in the empty
   * space between, so neither direction is a near miss.
   */
  const BACKED_OFF = 15;
  const HELD = 90;

  it('M-7: a persistently HALTED due pass backs off — it does not pin the base cadence', async () => {
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c, {
        // The `phone_control` singleton is missing. `runPhoneDuePass` reads
        // an absent control row as HALTED and returns without throwing.
        async backlog() {
          c.backlogReads += 1;
          return {
            status: 'ok',
            admission: { controlPresent: false, halted: false, haltReason: null },
          };
        },
      }),
      queue: makeEmptyQueue(c),
      config: SLOW,
      random: () => 0.999,
    });
    registerPhoneRuntime(runtime);

    const ticks = await ticksOver(runtime, 'phone-due', WINDOW);

    // PREMISE, asserted rather than assumed: the pass really did halt, and
    // it really did not throw.
    expect(runtime.snapshot().lastDue?.status).toBe('halted');
    expect(loopHealth(runtime, 'phone-due').consecutiveErrors).toBe(0);
    // THE REPAIR: an incident does not become a hot loop on every replica.
    expect(ticks, `halted due ticks in ${WINDOW}ms`).toBeLessThan(BACKED_OFF);
    // And the halt is visible on the surface, so the quiet loop is explained.
    expect(phoneRuntimeDegradeReasons(phoneRuntimeView())).toContain('phone_due_halted');
  });

  it('M-7 CONTROL: a SUCCESSFUL due pass that dialled nothing still holds the base cadence', async () => {
    // The half of M-4 that must survive the repair. This is the reconnect
    // bound: a pass that found nothing is not a failed pass, and backing off
    // here is what made the contract's "approximately 120 seconds" unbounded.
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c),
      reader: makeReader({}, c),
      queue: makeEmptyQueue(c),
      config: SLOW,
      random: () => 0.999,
    });

    const ticks = await ticksOver(runtime, 'phone-due', WINDOW);

    expect(runtime.snapshot().lastDue?.status).toBe('ok');
    expect(runtime.snapshot().lastDue?.dialing).toBe(0);
    expect(ticks, `idle-but-ok due ticks in ${WINDOW}ms`).toBeGreaterThan(HELD);
  });

  it('M-7: a persistently NON-OK reclaim status backs off; an `ok` sweep that reclaimed nothing does not', async () => {
    // Same shape one loop over, and the same non-throwing failure: a sweep
    // RPC that answers a status we do not recognise.
    const cBroken = counters();
    const broken = buildRuntime({
      stores: makeStores(cBroken, {
        async reclaimAttemptLeases() {
          cBroken.reclaims += 1;
          return { status: 'unknown' as const };
        },
      }),
      queue: makeEmptyQueue(cBroken),
      config: { dueMs: 600_000, reclaimMs: 1_000, expireMs: 600_000, reconcileMs: 600_000 },
      random: () => 0.999,
    });
    const brokenTicks = await ticksOver(broken, 'phone-reclaim', WINDOW);

    expect(broken.snapshot().sweepNotOk.reclaim).toBe(true);
    expect(loopHealth(broken, 'phone-reclaim').consecutiveErrors).toBe(0);
    expect(brokenTicks, `non-ok reclaim ticks in ${WINDOW}ms`).toBeLessThan(BACKED_OFF);
    await broken.stop();

    // CONTROL: the M-2 bound. `reclaimed: 0` under `status: 'ok'` is this
    // sweep's steady state and must still hold the cadence.
    const cOk = counters();
    const healthy = buildRuntime({
      stores: makeStores(cOk),
      queue: makeEmptyQueue(cOk),
      config: { dueMs: 600_000, reclaimMs: 1_000, expireMs: 600_000, reconcileMs: 600_000 },
      random: () => 0.999,
    });
    const okTicks = await ticksOver(healthy, 'phone-reclaim', WINDOW);

    expect(healthy.snapshot().sweepNotOk.reclaim).toBe(false);
    expect(healthy.snapshot().lastReclaimed).toBe(0);
    expect(okTicks, `ok-but-idle reclaim ticks in ${WINDOW}ms`).toBeGreaterThan(HELD);
    await healthy.stop();
  });

  it('M-7: a BROKEN sweep claim backs off; a claim HELD BY ANOTHER replica does not', async () => {
    // A missed `grant execute` on `claim_phone_sweep` answers on every tick
    // for ever without throwing at the loop — the exact shape H-3 named. It
    // must not hot-spin. `held_by_other` is the opposite: it is the normal
    // answer every replica but one hears, and holding the cadence there is
    // what lets this replica take the claim over promptly when its holder
    // dies.
    const cBroken = counters();
    const broken = buildRuntime({
      stores: makeStores(cBroken, {
        async claimSweep() { throw new Error('claim_read_failed'); },
      }),
      queue: makeEmptyQueue(cBroken),
      config: { dueMs: 600_000, reclaimMs: 600_000, expireMs: 1_000, reconcileMs: 600_000 },
      random: () => 0.999,
    });
    const brokenTicks = await ticksOver(broken, 'phone-dayroll', WINDOW);

    expect(broken.snapshot().sweepNotOk.dayroll).toBe(true);
    expect(cBroken.dayRolls).toBe(0);
    expect(brokenTicks, `broken-claim dayroll ticks in ${WINDOW}ms`).toBeLessThan(BACKED_OFF);
    await broken.stop();

    const cTheirs = counters();
    const theirs = buildRuntime({
      stores: makeStores(cTheirs, {
        async claimSweep(input: { sweep: string }) {
          cTheirs.sweepClaims.push(input.sweep);
          return { status: 'held_by_other' as const };
        },
      }),
      queue: makeEmptyQueue(cTheirs),
      config: { dueMs: 600_000, reclaimMs: 600_000, expireMs: 1_000, reconcileMs: 600_000 },
      random: () => 0.999,
    });
    const theirsTicks = await ticksOver(theirs, 'phone-dayroll', WINDOW);

    // A healthy fleet is not amber, and it is not slow to take over either.
    expect(theirs.snapshot().sweepNotOk.dayroll).toBe(false);
    expect(cTheirs.dayRolls).toBe(0);
    expect(theirsTicks, `held-by-other dayroll ticks in ${WINDOW}ms`).toBeGreaterThan(HELD);
    await theirs.stop();
  });

  it('M-7: a non-ok STRANDED sweep backs off too — the pairing is at every site', async () => {
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c, {
        async sweepStrandedSessions() {
          c.strandedSweeps += 1;
          return { status: 'unknown' as const };
        },
      }),
      queue: makeEmptyQueue(c),
      config: { dueMs: 600_000, reclaimMs: 600_000, expireMs: 1_000, reconcileMs: 600_000 },
      random: () => 0.999,
    });
    const ticks = await ticksOver(runtime, 'phone-stranded', WINDOW);

    expect(runtime.snapshot().sweepNotOk.stranded).toBe(true);
    expect(runtime.snapshot().lastStranded).toBeNull();
    expect(ticks, `non-ok stranded ticks in ${WINDOW}ms`).toBeLessThan(BACKED_OFF);
    // CONTROL: its SIBLING on the same cadence answered `ok` and is still
    // held, so the backoff is the loop's own and not the whole scheduler's.
    expect(runtime.snapshot().sweepNotOk.dayroll).toBe(false);
    expect(loopHealth(runtime, 'phone-dayroll').ticks).toBeGreaterThan(HELD);
  });
});

describe('F. M-1 — a reconcile sweep that is NOT RUNNING is not a sweep that found nothing', () => {
  it('the reconcile tick reports its STATUS, and a disabled sweep publishes a null count', async () => {
    // PREMISE, asserted rather than assumed: in this environment the
    // reconciliation sweep is inactive, so `runPhoneReconciliation` answers
    // `status: 'disabled'` with `posted: 0`. That is the exact shape that used
    // to reach the surface as a healthy `last_reconciled: 0`.
    // Read from `process.env`, which is EXACTLY the call `runtime.ts` makes —
    // not from an empty map, which would prove something about a config the
    // runtime never sees.
    expect(
      isPhoneWebhookActive(loadLiveKitPhoneConfig()),
      'premise: the reconcile sweep must be inactive for this test to mean anything',
    ).toBe(false);

    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c),
      queue: makeEmptyQueue(c),
      config: { dueMs: 60_000, reclaimMs: 60_000, expireMs: 60_000, reconcileMs: 1_000 },
    });
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(loopHealth(runtime, 'phone-reconcile').ticks).toBeGreaterThan(0);

    const snapshot = runtime.snapshot();
    // NOT `false`, and NOT `0`.
    expect(snapshot.sweepNotOk.reconcile).toBe(true);
    expect(snapshot.lastReconciled).toBeNull();

    const v = phoneRuntimeView();
    expect(v.sweeps_not_ok).toContain('reconcile');
    expect(v.last_reconciled).toBeNull();
    // And it DEGRADES, which is the whole point: a dropped-webhook sweep that
    // has silently stopped means an attempt whose webhook never arrived is
    // invisible until its lease lapses.
    expect(phoneRuntimeDegradeReasons(v)).toContain('phone_sweep_not_ok');
  });

  it('the sweep-status map names EVERY sweep from construction, not only after a failure', async () => {
    // A map that grew its keys lazily would report an unrun sweep as absent
    // rather than as unknown, and `sweeps_not_ok` would look clean because
    // nothing had written to it yet.
    //
    // Five since 0045 added the day roll and the stranded resolution. Asserted
    // as an exact set both ways, so a sweep added without a key here — the
    // shape that makes an unrun sweep invisible — fails rather than passes.
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c) });
    expect(Object.keys(runtime.snapshot().sweepNotOk).sort())
      .toEqual(['dayroll', 'expire', 'reclaim', 'reconcile', 'stranded']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  0045 — the two sweeps 0042 assigned to P5, and the claim in front of them
// ═══════════════════════════════════════════════════════════════════════

describe('the day-roll and stranded sweeps run, and the claim gates them', () => {
  const FAST = { dueMs: 60_000, reclaimMs: 60_000, expireMs: 1_000, reconcileMs: 60_000 };

  it('both sweeps actually RUN, and each claims under its own name', async () => {
    // These two loops were wired with no test that ticked them. A loop the
    // suite never drives is indistinguishable from a loop that throws on
    // every tick — which is exactly what it would have done, since the store
    // fake had neither method.
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c), queue: makeEmptyQueue(c), config: FAST,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(c.dayRolls).toBeGreaterThan(0);
    expect(c.strandedSweeps).toBeGreaterThan(0);
    // Separate claim names: one sweep taking the other's claim would let a
    // single replica silently monopolise both.
    expect(new Set(c.sweepClaims)).toEqual(new Set(['dayroll', 'stranded']));
  });

  it('a claim HELD BY ANOTHER replica stops the sweep from running at all', async () => {
    // The point of the claim. Without this the fleet multiplies every sweep
    // by the replica count.
    const c = counters();
    // The override replaces the counting fake, so it records for itself —
    // otherwise "the claim was attempted" would be asserted against a
    // counter nothing writes, and the test would pass for the wrong reason.
    const asked: string[] = [];
    const runtime = buildRuntime({
      stores: makeStores(c, {
        claimSweep: async (input: { sweep: string }) => {
          asked.push(input.sweep);
          return { status: 'held_by_other' as const };
        },
      }),
      queue: makeEmptyQueue(c),
      config: FAST,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(asked.length).toBeGreaterThan(0);
    expect(c.dayRolls).toBe(0);
    expect(c.strandedSweeps).toBe(0);
  });

  it('"held by another replica" and "the claim is BROKEN" are different facts', async () => {
    // Collapsing them into one `false` is how a missed grant on
    // `claim_phone_sweep` silently disables BOTH new loops on EVERY replica
    // for ever — day.rolled never posted, the no-answer ladder still ending
    // at attempt 1 — while health reports `sweeps_not_ok: []` and
    // `status: ok`. This work already hit a missed revoke/grant pair once,
    // on a different function, so the failure mode is not hypothetical.
    const c = counters();
    const broken = buildRuntime({
      stores: makeStores(c, {
        claimSweep: async () => { throw new Error('claim_read_failed'); },
      }),
      queue: makeEmptyQueue(c),
      config: FAST,
    });
    broken.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const brokenSnap = broken.snapshot();
    expect(brokenSnap.sweepNotOk.dayroll).toBe(true);
    expect(brokenSnap.sweepNotOk.stranded).toBe(true);
    await broken.stop();

    // The NORMAL case every replica but one hears on every tick. It must be
    // silent, or a healthy fleet is permanently amber.
    const c2 = counters();
    const theirs = buildRuntime({
      stores: makeStores(c2, { claimSweep: async () => ({ status: 'held_by_other' as const }) }),
      queue: makeEmptyQueue(c2),
      config: FAST,
    });
    theirs.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const theirsSnap = theirs.snapshot();
    expect(theirsSnap.sweepNotOk.dayroll).toBe(false);
    expect(theirsSnap.sweepNotOk.stranded).toBe(false);
    await theirs.stop();
  });

  it('a replica that stops sweeping stops publishing its last count', async () => {
    // A stale `4` reads as a sweep that worked minutes ago rather than one
    // that has not run in days. Both non-running verdicts null the count.
    const c = counters();
    let grant = true;
    const runtime = buildRuntime({
      stores: makeStores(c, {
        claimSweep: async () => (grant
          ? { status: 'ok' as const }
          : { status: 'held_by_other' as const }),
        sweepDayRolled: async () => ({ status: 'ok' as const, rolled: 4 }),
      }),
      queue: makeEmptyQueue(c),
      config: FAST,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runtime.snapshot().lastRolled).toBe(4);

    grant = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtime.snapshot().lastRolled).toBeNull();
  });

  it('a claim that THROWS also stops the sweep — the claim fails closed', async () => {
    // A claim we could not read is not a claim we hold. Failing open here
    // would make a database blip the one moment every replica sweeps at once.
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c, {
        claimSweep: async () => { throw new Error('claim_read_failed'); },
      }),
      queue: makeEmptyQueue(c),
      config: FAST,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(c.dayRolls).toBe(0);
    expect(c.strandedSweeps).toBe(0);
    // And the scheduler survives it: a refused claim is a normal tick.
    expect(runtime.scheduler.health().running).toBe(true);
    expect(loopHealth(runtime, 'phone-dayroll').consecutiveErrors).toBe(0);
  });

  it('a non-ok sweep status nulls its count and names the sweep, like the other three', async () => {
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c, {
        sweepDayRolled: async () => ({ status: 'unknown' as const }),
      }),
      queue: makeEmptyQueue(c),
      config: FAST,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const snap = runtime.snapshot();
    // `null`, not `0`. "The sweep did not happen" and "it ran and rolled
    // nothing" are opposite operational facts and must not share a value.
    expect(snap.lastRolled).toBeNull();
    expect(snap.sweepNotOk.dayroll).toBe(true);
    // CONTROL: the sibling sweep in the same pass is unaffected.
    expect(snap.sweepNotOk.stranded).toBe(false);
    expect(snap.lastStranded).toBe(0);
  });

  it('the resolved counts reach the published view', async () => {
    const c = counters();
    const runtime = buildRuntime({
      stores: makeStores(c, {
        sweepDayRolled: async () => ({ status: 'ok' as const, rolled: 2, examined: 3, skipped: 1 }),
        sweepStrandedSessions: async () => ({
          status: 'ok' as const, examined: 4, completed: 3, failed: 1, skipped: 0,
        }),
      }),
      queue: makeEmptyQueue(c),
      config: FAST,
    });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const snap = runtime.snapshot();
    expect(snap.lastRolled).toBe(2);
    // Completed PLUS truthfully failed: both are resolutions, and an operator
    // watching this number wants "how many stopped being stranded".
    expect(snap.lastStranded).toBe(4);
  });
});

describe('F. M-9 — a construction failure and a deliberate disable are different facts', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  it('a deliberate disable is `enabled: false` with NO degrade reason', () => {
    const v = phoneRuntimeView();
    expect(v.enabled).toBe(false);
    expect(v.start_failed).toBe(false);
    // The shipped default. Marking every healthy deployment degraded would
    // make the surface useless, which is why this case stays reason-free.
    expect(phoneRuntimeDegradeReasons(v)).toEqual([]);
  });

  it('a construction failure is `enabled: false` WITH `phone_runtime_start_failed`', () => {
    recordPhoneRuntimeStartFailure();

    const v = phoneRuntimeView();
    // Still not enabled — the process genuinely has no runtime.
    expect(v.enabled).toBe(false);
    expect(v.running).toBe(false);
    // ...but no longer indistinguishable from the case above.
    expect(v.start_failed).toBe(true);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_runtime_start_failed']);
  });

  it('a successful registration clears the flag — a later lane failure cannot mark this one broken', async () => {
    recordPhoneRuntimeStartFailure();
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c) });
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const v = phoneRuntimeView();
    expect(v.enabled).toBe(true);
    expect(v.start_failed).toBe(false);
    expect(phoneRuntimeDegradeReasons(v)).not.toContain('phone_runtime_start_failed');
  });

  it('the flag is a BOOLEAN and carries nothing about why', () => {
    recordPhoneRuntimeStartFailure();
    const v = phoneRuntimeView();
    expect(typeof v.start_failed).toBe('boolean');
    // The whole view remains publishable: no message, no stack, no config text.
    expect(JSON.stringify(v)).not.toContain('Error');
  });

  it('THE WIRING: the composition root RECORDS the construction failure, not only logs it', () => {
    // The flag is inert unless `index.ts` sets it, and a log line on one
    // replica is not a signal anybody is watching. Deleting the call leaves
    // every assertion above green, so the call itself is asserted.
    const source = readFileSync(path.join(HERE, '..', 'index.ts'), 'utf8');
    expect(source).toContain('recordPhoneRuntimeStartFailure');

    const at = source.indexOf("error_category: 'phone_runtime_start_failed'");
    expect(at, 'the phone start-failure catch block was not found').toBeGreaterThan(0);
    // Inside the SAME catch block, not merely somewhere in the file.
    const block = source.slice(at, source.indexOf('\n}', at));
    expect(block).toContain('recordPhoneRuntimeStartFailure()');
    expect(block).toContain('phoneRuntime = null');
  });

  // ═══════════════════════════════════════════════════════════════════
  // M-5 — THE ARMING WAS OUTSIDE THE GUARDED REGION
  // ═══════════════════════════════════════════════════════════════════
  //
  // `recordPhoneRuntimeStartFailure` wrapped only `createPhoneRuntime`. The
  // ARMING — `scheduler.start()` then `registerPhoneRuntime` — sat in the
  // `server.listen` callback with no try/catch and no failure record. If
  // `start()` threw (a metric-name collision from the derived loop set, a
  // timer failure), `registerPhoneRuntime` never ran, `startFailed` stayed
  // false, and the view reported `enabled: false, start_failed: false` with
  // NO degrade reason on a fleet where both switches are on — the exact false
  // negative M-9 was supposed to close, left open one line later. The throw
  // also escaped the listen callback, where nothing catches it.
  //
  // ── AND THE OLD TEST OF THIS WIRING WAS VACUOUS ──────────────────
  // It was a `readFileSync` + `toContain` grep of `index.ts`. Rewriting the
  // call site to `if (Math.random() < -1) recordPhoneRuntimeStartFailure();`
  // — making the call dead code — left the suite green. A grep proves a
  // string is present, never that it runs. So the arming now lives in
  // `armPhoneRuntime` (in `health.ts`, because `index.ts` opens a socket on
  // import and cannot be unit-tested) and is EXERCISED below.

  /**
   * A handle whose `scheduler.start()` throws and whose every other member
   * is a trap. Nothing but `start()` may be reached on the failing path: a
   * `snapshot()` on an unarmed runtime would mean the failure had been
   * published as a live one.
   */
  function unstartableRuntime(): PhoneRuntimeHandle {
    return {
      config: {},
      loopIntervalsMs: {},
      scheduler: {
        start(): void { throw new Error('phone_metric_name_collision'); },
        stop(): void {},
        health(): never { throw new Error('an unarmed runtime must not be read'); },
      },
      runner: {} as never,
      queue: {} as never,
      snapshot(): never { throw new Error('an unarmed runtime must not be snapshotted'); },
      async tickAll(): Promise<void> {},
      async stop(): Promise<void> {},
    } as unknown as PhoneRuntimeHandle;
  }

  it('M-5: an ARMING that throws is recorded exactly as a construction failure is', () => {
    const armed = armPhoneRuntime(unstartableRuntime());
    expect(armed).toBe(false);

    const v = phoneRuntimeView();
    // Still not enabled — the runtime never reached the registry.
    expect(v.enabled).toBe(false);
    expect(v.running).toBe(false);
    // ...and NOT indistinguishable from a deliberately-disabled replica,
    // which is the whole defect.
    expect(v.start_failed).toBe(true);
    expect(phoneRuntimeDegradeReasons(v)).toEqual(['phone_runtime_start_failed']);
    // The view stays publishable: no message, no stack, no config text.
    expect(JSON.stringify(v)).not.toContain('phone_metric_name_collision');
  });

  it('M-5: the throw does not escape, and the process still LISTENS', async () => {
    // The second half of the defect: the bare `scheduler.start()` sat inside
    // the `server.listen` callback, so its throw escaped uncaught. Proved
    // against a real socket rather than by inspection — real timers, because
    // a listening socket is not a timer.
    vi.useRealTimers();
    const server = http.createServer((_req, res) => res.end('ok'));
    let armed: boolean | null = null;
    let threw: unknown = null;

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        // EXACTLY the shape `index.ts` uses.
        try {
          armed = armPhoneRuntime(unstartableRuntime());
        } catch (e) {
          threw = e;
        }
        resolve();
      });
    });

    try {
      expect(threw, 'the arming threw out of the listen callback').toBeNull();
      expect(armed).toBe(false);
      // THE POINT: the API is serving HTTP even though the phone lane is not.
      expect(server.listening).toBe(true);
      // ...and the failure is on the surface rather than only in a log line.
      expect(phoneRuntimeView().start_failed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('M-5 CONTROL: a runtime that arms cleanly is enabled, running and NOT failed', async () => {
    // Without this the pair above is satisfied by an `armPhoneRuntime` that
    // always answers false.
    const c = counters();
    const runtime = buildRuntime({ stores: makeStores(c), queue: makeEmptyQueue(c) });

    expect(armPhoneRuntime(runtime)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);

    const v = phoneRuntimeView();
    expect(v.enabled).toBe(true);
    expect(v.running).toBe(true);
    expect(v.start_failed).toBe(false);
    expect(phoneRuntimeDegradeReasons(v)).not.toContain('phone_runtime_start_failed');
    // The scheduler really was started, in the right ORDER: a handle
    // published before `start()` would report every loop `running: false`.
    expect(v.loops.length).toBeGreaterThan(0);
    expect(v.loops.every((l) => l.running)).toBe(true);
  });

  it('M-5: the composition root DELEGATES the arming rather than doing it bare', () => {
    // The behavioural tests above prove `armPhoneRuntime` is correct; this
    // proves `index.ts` is the caller. It is a source assertion and it is
    // deliberately NARROW — it pins the one line the defect was, inside the
    // phone branch of the listen callback, rather than grepping the file.
    const source = readFileSync(path.join(HERE, '..', 'index.ts'), 'utf8');
    const at = source.indexOf('if (phoneRuntime) {');
    expect(at, 'the phone arming branch was not found in index.ts').toBeGreaterThan(0);
    const branch = source.slice(at, source.indexOf('\n  }', at));

    expect(branch).toContain('armPhoneRuntime(phoneRuntime)');
    // THE REGRESSION: the bare, unguarded pair must not come back.
    expect(branch).not.toContain('phoneRuntime.scheduler.start()');
    expect(branch).not.toContain('registerPhoneRuntime(phoneRuntime)');
    // And the whole file no longer imports the unguarded registration at
    // all, so it cannot be reintroduced without a visible import change.
    expect(source).not.toContain('registerPhoneRuntime,');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. M-5 — THE ADMISSION DETAIL SURVIVES THE RUNTIME SEAM
// ═════════════════════════════════════════════════════════════════════════════
//
// `due-loop.ts`'s own suite proves that a detail handed to the pass becomes a
// per-detail bucket. It cannot prove that the detail ever ARRIVES: the place
// the value was lost is `runtime.ts`'s dialer adapter, which used to rebuild
// the result as `{ status, refusal }` and drop `detail` on the floor. A test
// that stops at the port is green against exactly the defect being repaired.
//
// So this one drives the REAL adapter — `createPhoneRuntime`'s `dialer.dial`,
// through `dialPhoneAttempt` and `admitPhoneEngagement` — and reads the answer
// off the published health view.

describe('G. the admission detail reaches the health view through the real dialer', () => {
  /**
   * A due pass that reaches admission and is refused there.
   *
   * Every gate before admission has to be genuinely satisfied, and each one is
   * satisfied the way production would satisfy it rather than stubbed past:
   * a configured SIP trunk (`isPhoneTransportReady`), ordered timeouts, a
   * `synthetic` dial mode that reaches no carrier, a resumable session already
   * named on the engagement, a dialable number, and a consent preflight that
   * raises no local objection. Admission then answers a refusal status, which
   * is what `detail` carries.
   */
  function refusedRuntime(admitStatus: string): PhoneRuntimeHandle {
    const c = counters();
    const reader = makeReader({
      async listDueEngagements() {
        c.duePasses += 1;
        return [{
          engagementId: SENTINEL_ENGAGEMENT,
          state: 'eligible',
          candidateId: SENTINEL_CANDIDATE,
          roleId: null,
          sessionId: SENTINEL_SESSION,
          nextEligibleAt: null,
          noAnswerAttempts: 0,
          updatedAt: null,
        }];
      },
      async listDialableNumbers() {
        return new Map([[SENTINEL_CANDIDATE, wrapDialableNumber(DIALABLE)]]);
      },
      // The engagement already names a session, so the pass takes the
      // VERIFIED `existingSessionId` branch and never reaches `createSession`.
      async readSessionForReuse() { return { status: 'waiting', roomVerified: true }; },
      consent: {
        async latestConsentRecord() {
          return { status: 'granted', consents: [], expiresAt: null };
        },
        async activeConsentTemplate() { return { requiredConsents: [] }; },
      },
    });

    const stores = makeStores(c, {
      // THE REFUSAL. `admitPhoneEngagement` surfaces the database's status
      // untranslated, and `dialPhoneAttempt` puts it in `detail` beside
      // `refusal: 'admission_refused'`.
      async admitAttempt() { return { status: admitStatus }; },
    });

    const handle = createPhoneRuntime({
      config: screeningConfig(true, true),
      runtimeConfig: runtimeConfig({ dueMs: 1_000 }),
      // A configured trunk, so `isPhoneTransportReady` passes and admission is
      // actually reached. The dial mode is still `synthetic`, so the SIP
      // client resolved holds no SDK reference and no carrier is touched.
      dialConfig: { ...loadPhoneDialConfig({} as NodeJS.ProcessEnv), sipTrunkId: 'ST_TEST_TRUNK' },
      client: {} as never,
      queue: makeEmptyQueue(c),
      stores,
      reader,
      owner: 'phone-test-owner',
      scheduler: { random: () => 0.5 },
    });
    expect(handle).not.toBeNull();
    live.push(handle!);
    return handle!;
  }

  it('M-5: an admission refusal arrives as `admission_refused:<detail>`, not as one collapsed bucket', async () => {
    const runtime = refusedRuntime('suppressed');
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const v = phoneRuntimeView();
    expect(v.last_due, 'the due pass never completed').not.toBeNull();
    expect(v.last_due!.status).toBe('ok');
    // It really reached admission — otherwise this would be
    // `transport_not_configured` or `room_unavailable`.
    expect(v.last_due!.offered).toBe(1);
    expect(v.last_due!.dialing).toBe(0);
    expect(v.last_due!.refusals).toEqual({ 'admission_refused:suppressed': 1 });
    // The collapsed bucket is gone, and the detail did not arrive as
    // `unknown` — which is what a seam that dropped it would produce.
    expect(v.last_due!.refusals.admission_refused).toBeUndefined();
    expect(v.last_due!.refusals['admission_refused:unknown']).toBeUndefined();
  });

  it('M-5: a DIFFERENT admission refusal is a different bucket end to end', async () => {
    // Two operationally opposite answers — "today's quota is spent" and
    // "consent is broken and nobody is being called" — must not be one number.
    const runtime = refusedRuntime('consent_missing');
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(phoneRuntimeView().last_due!.refusals)
      .toEqual({ 'admission_refused:consent_missing': 1 });
  });

  it('M-5: an admission status OUTSIDE the vocabulary still cannot reach the surface', async () => {
    // The closure holds through the whole chain, not only at the pure helper.
    const HOSTILE = 'SENTINEL-STATUS-<img src=x>-must-not-travel';
    const runtime = refusedRuntime(HOSTILE);
    registerPhoneRuntime(runtime);
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const v = phoneRuntimeView();
    expect(v.last_due!.refusals).toEqual({ 'admission_refused:unknown': 1 });
    expect(JSON.stringify(v)).not.toContain('SENTINEL-STATUS');
    expect(JSON.stringify(v)).not.toContain('img src');
  });
});
