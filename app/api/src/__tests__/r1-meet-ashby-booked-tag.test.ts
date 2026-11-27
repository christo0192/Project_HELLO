/**
 * M035 S11 T4: the `ashby_booked_tag` job (`lib/r1/meet/ashby-booked-tag.ts`), which keeps the Ashby
 * tag "Dex R1: Booked" on a public booking's candidate exactly while the database says the booking
 * stands. Driven through the REAL booked-tag store over the in-memory tables, the REAL tag port and
 * REAL Ashby client over the stateful fake transport, and (where it matters) the REAL dispatcher
 * (`support/r1-meet-ashby-tag-fake.ts`, `createR1MeetAshbyTagWorld`).
 *
 * Pinned (plan T4 item 5):
 *  - add once and repeat (one write across reruns); removes after a candidate cancel, an HR cancel, a
 *    failure or a drain before the start; kept after `completed`, a failure or drain after the start,
 *    and at `updated_at == start_at`; `op` is only a hint; cancel then rebook converges to present in
 *    either order; the rule is candidate-wide, with an overflow guard;
 *  - the Ashby candidate id from the link, else `application.info`; Ashby-scheduled and missing rows
 *    are ignored with no Ashby call; only the Dex tag is ever written, and never a create;
 *  - catalogue miss / ambiguous / truncated; every Ashby failure class; write refusals; contention
 *    (a recruiter and a booking changing mid-run); the switches, the key and the wiring; the run's
 *    time; a database fault;
 *  - after EVERY test: no log line, thrown message or result code carries a fixture id, a sentinel,
 *    the tag's title or the key; every `error_type` is a safe identifier; no request outside the five
 *    paths; no write to the 0142 port and no Recall request.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  R1_MEET_ASHBY_TAG_ALERT_TYPES,
  R1_MEET_ASHBY_TAG_INACTIVE_LOG,
  R1_MEET_ASHBY_TAG_UNWIRED,
  R1_MEET_ASHBY_TAG_WAITS,
  r1MeetAshbyBookedTagDefinition,
  r1MeetBookedTagWanted,
  runR1MeetAshbyBookedTag,
} from '../lib/r1/meet/ashby-booked-tag.js';
import { R1_MEET_ASHBY_TAG_MAX_REMOVES, R1_MEET_BOOKED_TAG_TITLE } from '../lib/r1/meet/ashby-booked-tag-ashby.js';
import { R1_MEET_BOOKED_TAG_MAX_APPLICATIONS } from '../lib/r1/meet/ashby-booked-tag-store.js';
import { R1_MEET_BOOKING_STATUSES } from '../lib/r1/meet/bookings-read.js';
import { R1_MEET_DEFINITIONS, createR1MeetDispatcher } from '../lib/r1/meet/dispatcher.js';
import {
  R1MeetJobError,
  R1_MEET_JOB_PARSERS,
  parseAshbyBookedTagJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetAshbyTagOp,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from '../lib/r1/meet/jobs.js';
import { R1_MEET_ALERTS, type R1MeetLogMeta } from '../lib/r1/meet/recall-actions.js';
import { R1_MEET_LIVE_STATUSES } from '../lib/r1/meet/runtime-store.js';
import {
  ASHBY_TAG_LANE_PATHS,
  ASHBY_TAG_SENTINELS,
  createR1MeetAshbyTagWorld,
  fakeAshbyTagKey,
  type AshbyTagWorldPerson,
  type R1MeetAshbyTagWorld,
  type SeedPersonOptions,
} from './support/r1-meet-ashby-tag-fake.js';
import { HARNESS_NOW } from './support/r1-meet-harness.js';

const NOW_MS = Date.parse(HARNESS_NOW);
const HOUR_MS = 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
/** The logger's own rule for a string value (`lib/logger.ts`): a safe identifier of at most 64. */
const LOG_SAFE = /^[a-zA-Z0-9_:.-]{1,64}$/;
/** A queue reason or error code (0037). */
const QUEUE_CODE = /^[a-z0-9_.:-]{1,64}$/;
const ALERT = R1_MEET_ALERTS.ashbyTagFailed;

// ── Every world of a test is scanned after it (PII, paths, nothing else written) ──

interface Tracked {
  readonly w: R1MeetAshbyTagWorld;
  readonly outcomes: unknown[];
}
let tracked: Tracked[] = [];

function newWorld(): R1MeetAshbyTagWorld {
  const w = createR1MeetAshbyTagWorld();
  tracked.push({ w, outcomes: [] });
  return w;
}

function outcomesOf(w: R1MeetAshbyTagWorld): unknown[] {
  const entry = tracked.find((item) => item.w === w);
  if (!entry) throw new Error('untracked world');
  return entry.outcomes;
}

/** Run the job directly and record its answer (or what it threw) for the scan. */
async function run(w: R1MeetAshbyTagWorld, op: R1MeetAshbyTagOp, bookingId: string, meta?: R1MeetJobMeta): Promise<R1MeetJobResult> {
  try {
    const result = await w.run(op, bookingId, meta);
    outcomesOf(w).push(result);
    return result;
  } catch (error) {
    outcomesOf(w).push({ thrown: (error as Error).message, code: (error as { code?: unknown }).code });
    throw error;
  }
}

/** Run the job and answer what it threw (it must throw). */
async function runThrows(w: R1MeetAshbyTagWorld, op: R1MeetAshbyTagOp, bookingId: string, meta?: R1MeetJobMeta): Promise<R1MeetJobError> {
  const error = await run(w, op, bookingId, meta).then(
    () => {
      throw new Error('expected the job to throw');
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(R1MeetJobError);
  return error as R1MeetJobError;
}

afterEach(() => {
  try {
    for (const { w, outcomes } of tracked) {
      const forbidden = [
        ...w.ids,
        ...w.ids.map((id) => id.toUpperCase()),
        ASHBY_TAG_SENTINELS.name,
        ASHBY_TAG_SENTINELS.email,
        R1_MEET_BOOKED_TAG_TITLE,
        fakeAshbyTagKey(),
      ];
      const text = JSON.stringify(w.h.logs) + JSON.stringify(outcomes);
      for (const value of forbidden) expect(text).not.toContain(value);
      for (const line of w.h.logs) {
        expect(line.meta.error_category).toMatch(LOG_SAFE);
        if (line.meta.error_type !== undefined) expect(line.meta.error_type).toMatch(LOG_SAFE);
        expect(Object.keys(line.meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key))).toBe(true);
      }
      for (const outcome of outcomes) {
        const code = (outcome as { code?: unknown }).code;
        if (typeof code === 'string') expect(code).toMatch(QUEUE_CODE);
      }
      // Only the five calls of the lane: never a create, never another endpoint.
      for (const path of w.fake.paths()) expect(ASHBY_TAG_LANE_PATHS as readonly string[]).toContain(path);
      // The lane never touches the 0142 port or Recall, and the tables fake has no write at all.
      expect(w.h.db.calls).toEqual([]);
      expect(w.h.requests).toEqual([]);
      for (const call of w.tables.calls) expect(['r1_meet_bookings', 'ashby_application_links']).toContain(call.table);
    }
  } finally {
    tracked = [];
  }
});

// ── Small readers ───────────────────────────────────────────────────────────

const alerts = (w: R1MeetAshbyTagWorld): R1MeetLogMeta[] =>
  w.h.logs.filter((line) => line.level === 'error').map((line) => line.meta);
const warnings = (w: R1MeetAshbyTagWorld): string[] =>
  w.h.logs.filter((line) => line.level === 'warn' && line.meta.error_category !== 'r1_meet_ashby_failed').map((line) => line.meta.error_category);
const tagIdsOf = (w: R1MeetAshbyTagWorld, candidateId: string): string[] => (w.fake.tagsOf(candidateId) ?? []).map((tag) => tag.id);
const writeBodies = (w: R1MeetAshbyTagWorld): Array<[string, string]> => w.writes().map((request) => [request.path, request.raw]);
const body = (candidateId: string, tagId: string): string => JSON.stringify({ candidateId, tagId });
const walks = (w: R1MeetAshbyTagWorld): number => w.fake.requestsOf('/candidateTag.list').length;
const jobLines = (w: R1MeetAshbyTagWorld): Array<string | undefined> =>
  w.h.logs.filter((line) => line.meta.error_category === 'r1_meet_job').map((line) => line.meta.error_type);

/** A person whose booking is in the given state; the candidate holds the Dex tag unless `tags` says. */
function person(w: R1MeetAshbyTagWorld, options: SeedPersonOptions & { readonly withDex?: boolean } = {}): AshbyTagWorldPerson {
  const tags = options.tags ?? (options.withDex === false ? [] : [w.dexTag()]);
  return w.seedPerson({ ...options, tags });
}

/** Booking timings. */
const BEFORE_START = { startAt: iso(NOW_MS + 24 * HOUR_MS), updatedAt: HARNESS_NOW } as const;
const AFTER_START = { startAt: iso(NOW_MS - HOUR_MS), updatedAt: HARNESS_NOW } as const;
const AT_START = { startAt: HARNESS_NOW, updatedAt: HARNESS_NOW } as const;

// ── The rule itself ─────────────────────────────────────────────────────────

describe('r1MeetBookedTagWanted (D-S11-2, the per-application rule)', () => {
  it('wants the tag for every live status and completed; never for cancelled; failed and drained by the start', () => {
    for (const status of R1_MEET_BOOKING_STATUSES) {
      const before = r1MeetBookedTagWanted({ status, ...BEFORE_START });
      const after = r1MeetBookedTagWanted({ status, ...AFTER_START });
      if ((R1_MEET_LIVE_STATUSES as readonly string[]).includes(status) || status === 'completed') {
        expect([status, before, after]).toEqual([status, true, true]);
      } else if (status === 'failed' || status === 'drained') {
        expect([status, before, after]).toEqual([status, false, true]);
      } else {
        expect([status, before, after]).toEqual([status, false, false]);
      }
    }
  });

  it('counts updated_at == start_at as after the start, one millisecond before as before', () => {
    for (const status of ['failed', 'drained'] as const) {
      expect(r1MeetBookedTagWanted({ status, ...AT_START })).toBe(true);
      expect(r1MeetBookedTagWanted({ status, startAt: HARNESS_NOW, updatedAt: iso(NOW_MS - 1) })).toBe(false);
    }
  });

  it('fails closed on an instant that does not parse', () => {
    expect(r1MeetBookedTagWanted({ status: 'failed', startAt: 'not-a-time', updatedAt: HARNESS_NOW })).toBe(false);
    expect(r1MeetBookedTagWanted({ status: 'drained', startAt: HARNESS_NOW, updatedAt: '' })).toBe(false);
  });
});

describe('the frozen contract of the job', () => {
  it('has exactly the eight waits of the plan, each a closed code within the bounds', () => {
    expect(Object.isFrozen(R1_MEET_ASHBY_TAG_WAITS)).toBe(true);
    expect(R1_MEET_ASHBY_TAG_WAITS).toEqual({
      inactive: { code: 'ashby_inactive', seconds: 3600, thrown: 'r1_meet_ashby_tag_ashby_inactive' },
      keyMissing: { code: 'ashby_key_missing', seconds: 3600, thrown: 'r1_meet_ashby_tag_key_missing' },
      permission: { code: 'ashby_permission_denied', seconds: 3600, thrown: 'r1_meet_ashby_tag_permission_denied' },
      notFound: { code: 'tag_not_found', seconds: 3600, thrown: 'r1_meet_ashby_tag_not_found' },
      ambiguous: { code: 'tag_ambiguous', seconds: 3600, thrown: 'r1_meet_ashby_tag_ambiguous' },
      rateLimited: { code: 'ashby_rate_limited', seconds: 60, thrown: 'r1_meet_ashby_tag_rate_limited' },
      unavailable: { code: 'ashby_unavailable', seconds: 30, thrown: 'r1_meet_ashby_tag_unavailable' },
      contended: { code: 'tag_contended', seconds: 60, thrown: 'r1_meet_ashby_tag_contended' },
    });
    for (const wait of Object.values(R1_MEET_ASHBY_TAG_WAITS)) {
      expect(Object.isFrozen(wait)).toBe(true);
      expect(wait.code).toMatch(QUEUE_CODE);
      // The dispatcher logs `ashby_booked_tag:<code>`: it must stay a safe identifier of at most 64.
      expect(`ashby_booked_tag:${wait.thrown}`).toMatch(LOG_SAFE);
      expect(wait.seconds).toBeGreaterThanOrEqual(1);
      expect(wait.seconds).toBeLessThanOrEqual(3600);
    }
    expect(R1_MEET_ASHBY_TAG_UNWIRED).toBe('r1_meet_ashby_tag_unwired');
    expect(R1_MEET_ASHBY_TAG_INACTIVE_LOG).toBe('r1_meet_ashby_tag_ashby_inactive');
  });

  it('closes the alert words, and the alert is one word of R1_MEET_ALERTS', () => {
    expect(R1_MEET_ASHBY_TAG_ALERT_TYPES).toEqual([
      'ashby_key_missing',
      'candidate_id_missing',
      'candidate_links_overflow',
      'tag_not_found',
      'tag_ambiguous',
      'permission_denied',
      'write_rejected',
    ]);
    expect(Object.isFrozen(R1_MEET_ASHBY_TAG_ALERT_TYPES)).toBe(true);
    expect(R1_MEET_ALERTS.ashbyTagFailed).toBe('r1_meet_ashby_tag_failed');
    expect(Object.values(R1_MEET_ALERTS).filter((value) => value === 'r1_meet_ashby_tag_failed')).toHaveLength(1);
  });

  it('is a frozen definition with the registered parser, registered last in the dispatcher', () => {
    expect(Object.isFrozen(r1MeetAshbyBookedTagDefinition)).toBe(true);
    expect(r1MeetAshbyBookedTagDefinition.kind).toBe('ashby_booked_tag');
    expect(r1MeetAshbyBookedTagDefinition.parse).toBe(R1_MEET_JOB_PARSERS.ashby_booked_tag);
    expect(R1_MEET_DEFINITIONS.at(-1)).toBe(r1MeetAshbyBookedTagDefinition);
  });

  it('carries ids and the op only, in the payload and the parsed job', () => {
    const w = newWorld();
    const bookingId = w.newId();
    for (const op of ['add', 'remove'] as const) {
      const spec = r1MeetJobs.ashbyBookedTag(op, bookingId);
      expect(Object.keys(spec.payload)).toEqual(['kind', 'op', 'booking_id']);
      expect(spec.payload).toEqual({ kind: 'ashby_booked_tag', op, booking_id: bookingId });
      expect(parseAshbyBookedTagJob(spec.payload)).toEqual({ kind: 'ashby_booked_tag', op, bookingId });
    }
  });
});

// ── Add, remove, keep ───────────────────────────────────────────────────────

describe('add once and repeat (one write across reruns)', () => {
  it('adds the Dex tag once to a candidate without it, then answers tag_present on a rerun and a second job', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });

    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(writeBodies(w)).toEqual([['/candidate.addTag', body(p.candidateId, w.tagIds.dex)]]);
    expect(w.fake.paths()).toEqual(['/candidate.info', '/candidateTag.list', '/candidate.addTag', '/candidate.info']);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);

    // A rerun of the same job (its answer was lost), then a second job of the same booking.
    expect(await run(w, 'add', p.bookingId, w.h.meta({ attempts: 2 }))).toEqual(r1MeetProcessed('tag_present'));
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_present'));
    expect(w.writes()).toHaveLength(1);
    expect(alerts(w)).toEqual([]);
  });

  it('through the dispatcher the job completes and logs ashby_booked_tag:tag_added, then tag_present', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    const payload = r1MeetJobs.ashbyBookedTag('add', p.bookingId).payload;
    await expect(w.dispatch(payload)).resolves.toBeUndefined();
    await expect(w.dispatch(payload, { attempts: 2 })).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual(['ashby_booked_tag:tag_added', 'ashby_booked_tag:tag_present']);
    expect(w.writes()).toHaveLength(1);
  });

  it('a candidate who already holds it gets no write at all', async () => {
    const w = newWorld();
    const p = person(w);
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_present'));
    expect(w.fake.paths()).toEqual(['/candidate.info']);
  });
});

describe('remove: a cancel, or a failure or drain before the start', () => {
  const cases = [
    { name: 'a candidate cancel', status: 'cancelled', reason: 'candidate_cancelled', ...BEFORE_START },
    { name: 'an HR cancel', status: 'cancelled', reason: 'cancelled', ...BEFORE_START },
    { name: 'a failure before the start', status: 'failed', reason: 'bot_create_failed', ...BEFORE_START },
    { name: 'a failure one millisecond before the start', status: 'failed', reason: 'bot_fatal', startAt: HARNESS_NOW, updatedAt: iso(NOW_MS - 1) },
    { name: 'a drain before the start', status: 'drained', reason: 'flag_off', ...BEFORE_START },
  ] as const;

  for (const c of cases) {
    it(`removes the Dex tag after ${c.name}`, async () => {
      const w = newWorld();
      const p = person(w, { booking: { status: c.status, startAt: c.startAt, updatedAt: c.updatedAt } });
      p.booking.reason = c.reason;
      expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
      expect(writeBodies(w)).toEqual([['/candidate.removeTag', body(p.candidateId, w.tagIds.dex)]]);
      expect(w.fake.paths()).toEqual(['/candidate.info', '/candidate.removeTag', '/candidate.info']);
      expect(tagIdsOf(w, p.candidateId)).toEqual([]);
      expect(alerts(w)).toEqual([]);
      // And again: nothing left to do.
      expect(await run(w, 'remove', p.bookingId, w.h.meta({ attempts: 2 }))).toEqual(r1MeetProcessed('tag_absent'));
      expect(w.writes()).toHaveLength(1);
    });
  }
});

describe('kept: completed, or a failure or drain at or after the start', () => {
  const cases = [
    { name: 'completed', status: 'completed', ...AFTER_START },
    { name: 'a no-show failure after the start', status: 'failed', ...AFTER_START },
    { name: 'a drain after the start', status: 'drained', ...AFTER_START },
    { name: 'a failure at exactly the start (updated_at == start_at)', status: 'failed', ...AT_START },
  ] as const;

  for (const c of cases) {
    for (const op of ['remove', 'add'] as const) {
      it(`keeps the tag after ${c.name} (${op} job): zero writes`, async () => {
        const w = newWorld();
        const p = person(w, { booking: { status: c.status, startAt: c.startAt, updatedAt: c.updatedAt } });
        if (c.status === 'failed' && c.name.includes('no-show')) p.booking.reason = 'no_show';
        expect(await run(w, op, p.bookingId)).toEqual(r1MeetProcessed('tag_present'));
        expect(w.writes()).toEqual([]);
        expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
      });
    }
  }
});

describe('op is a hint: the database decides', () => {
  it('an add job of a cancelled booking removes the tag', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled' } });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
    expect(writeBodies(w)).toEqual([['/candidate.removeTag', body(p.candidateId, w.tagIds.dex)]]);
  });

  it('a remove job of a live booking whose candidate lacks the tag adds it', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false, booking: { status: 'bot_scheduled' } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(writeBodies(w)).toEqual([['/candidate.addTag', body(p.candidateId, w.tagIds.dex)]]);
  });
});

describe('cancel then rebook converges to present, in either order', () => {
  /** An application whose old booking was cancelled and whose newer booking is live. */
  function rebooked(w: R1MeetAshbyTagWorld, withDex: boolean) {
    const p = person(w, { withDex, booking: { status: 'cancelled', createdAt: iso(NOW_MS - 2 * HOUR_MS) } });
    const fresh = w.seedBooking(p.applicationId, { status: 'pending', createdAt: iso(NOW_MS - HOUR_MS) });
    return { ...p, oldId: p.bookingId, newId: fresh.id as string };
  }

  for (const withDex of [true, false]) {
    it(`remove(old) then add(new), the candidate ${withDex ? 'holding' : 'without'} the tag`, async () => {
      const w = newWorld();
      const p = rebooked(w, withDex);
      expect(await run(w, 'remove', p.oldId)).toEqual(r1MeetProcessed(withDex ? 'tag_present' : 'tag_added'));
      expect(await run(w, 'add', p.newId)).toEqual(r1MeetProcessed('tag_present'));
      expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
      expect(w.fake.requestsOf('/candidate.addTag')).toHaveLength(withDex ? 0 : 1);
      expect(w.fake.requestsOf('/candidate.removeTag')).toHaveLength(0);
    });

    it(`add(new) then remove(old), the candidate ${withDex ? 'holding' : 'without'} the tag`, async () => {
      const w = newWorld();
      const p = rebooked(w, withDex);
      expect(await run(w, 'add', p.newId)).toEqual(r1MeetProcessed(withDex ? 'tag_present' : 'tag_added'));
      expect(await run(w, 'remove', p.oldId)).toEqual(r1MeetProcessed('tag_present'));
      expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
      expect(w.fake.requestsOf('/candidate.addTag')).toHaveLength(withDex ? 0 : 1);
      expect(w.fake.requestsOf('/candidate.removeTag')).toHaveLength(0);
    });
  }

  it('a remove that ran before the rebook, then the rebook\'s add: present again', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled', createdAt: iso(NOW_MS - 2 * HOUR_MS) } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
    const fresh = w.seedBooking(p.applicationId, { status: 'pending', createdAt: iso(NOW_MS - HOUR_MS) });
    expect(await run(w, 'add', fresh.id as string)).toEqual(r1MeetProcessed('tag_added'));
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
  });

  it('the newest booking decides on a created_at tie by id', async () => {
    const w = newWorld();
    const p = person(w, { booking: { id: '7f000000-0000-4000-8000-0000ffffaa01', status: 'pending' } });
    w.seedBooking(p.applicationId, { id: '7f000000-0000-4000-8000-0000ffffaa02', status: 'cancelled' });
    w.ids.push('7f000000-0000-4000-8000-0000ffffaa01', '7f000000-0000-4000-8000-0000ffffaa02');
    // Same created_at: the larger id is the newest, and it is cancelled.
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
  });
});

describe('candidate-wide (D-S11-2)', () => {
  /** One Ashby candidate with two applications A and B, each with one public booking. */
  function twoApplications(w: R1MeetAshbyTagWorld, aStatus: 'completed' | 'cancelled', bStatus: 'cancelled' | 'pending') {
    const candidateId = w.seedCandidate([w.dexTag()]);
    const a = w.seedApplication(candidateId);
    const b = w.seedApplication(candidateId);
    const aBooking = w.seedBooking(a, { status: aStatus, ...(aStatus === 'completed' ? AFTER_START : {}) });
    const bBooking = w.seedBooking(b, { status: bStatus });
    return { candidateId, a, b, aBooking, bBookingId: bBooking.id as string };
  }

  it('a cancel of application B keeps the tag while application A\'s booking is completed', async () => {
    const w = newWorld();
    const s = twoApplications(w, 'completed', 'cancelled');
    expect(await run(w, 'remove', s.bBookingId)).toEqual(r1MeetProcessed('tag_present'));
    expect(w.writes()).toEqual([]);
  });

  it('with A cancelled too, B\'s remove removes it', async () => {
    const w = newWorld();
    const s = twoApplications(w, 'completed', 'cancelled');
    s.aBooking.status = 'cancelled';
    expect(await run(w, 'remove', s.bBookingId)).toEqual(r1MeetProcessed('tag_removed'));
    expect(writeBodies(w)).toEqual([['/candidate.removeTag', body(s.candidateId, w.tagIds.dex)]]);
  });

  it('an application with no public booking (or only an Ashby-scheduled one) wants nothing', async () => {
    const w = newWorld();
    const s = twoApplications(w, 'cancelled', 'cancelled');
    w.seedBooking(s.a, { status: 'pending', source: 'ashby' });
    w.seedApplication(s.candidateId);
    expect(await run(w, 'remove', s.bBookingId)).toEqual(r1MeetProcessed('tag_removed'));
  });

  it(`weighs ${R1_MEET_BOOKED_TAG_MAX_APPLICATIONS} linked applications; one more is an overflow: alert, ignored, zero Ashby calls`, async () => {
    const full = newWorld();
    const p = person(full, { booking: { status: 'cancelled' } });
    for (let i = 1; i < R1_MEET_BOOKED_TAG_MAX_APPLICATIONS; i++) full.seedApplication(p.candidateId);
    expect(await run(full, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));

    const over = newWorld();
    const q = person(over, { booking: { status: 'cancelled' } });
    for (let i = 0; i < R1_MEET_BOOKED_TAG_MAX_APPLICATIONS; i++) over.seedApplication(q.candidateId);
    expect(await run(over, 'remove', q.bookingId)).toEqual(r1MeetIgnored('candidate_links_overflow'));
    expect(alerts(over)).toEqual([{ error_category: ALERT, error_type: 'candidate_links_overflow' }]);
    expect(over.fake.requests).toEqual([]);
    expect(tagIdsOf(over, q.candidateId)).toEqual([over.tagIds.dex]);
  });
});

describe('the Ashby candidate id (D-S11-4)', () => {
  it('comes from the link with no application.info call', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(w.fake.requestsOf('/application.info')).toEqual([]);
  });

  for (const link of ['without_candidate', 'none'] as const) {
    it(`comes from application.info when ${link === 'none' ? 'there is no link' : 'the link has no candidate id'}`, async () => {
      const w = newWorld();
      const p = person(w, { withDex: false, link });
      expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
      expect(w.fake.requestsOf('/application.info').map((request) => request.raw)).toEqual([
        JSON.stringify({ applicationId: p.applicationId }),
      ]);
      expect(writeBodies(w)).toEqual([['/candidate.addTag', body(p.candidateId, w.tagIds.dex)]]);
      // Nothing is written back: the lane makes no write to our database.
      expect(w.tables.rows.ashby_application_links.every((row) => row.external_candidate_id === null || row.external_candidate_id === p.candidateId)).toBe(true);
      if (link === 'without_candidate') expect(w.tables.rows.ashby_application_links[0]?.external_candidate_id).toBeNull();
    });
  }

  it('none anywhere: alert candidate_id_missing, ignored, zero writes', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false, link: 'without_candidate' });
    w.fake.next('/application.info', { status: 200, body: { success: true, results: { id: p.applicationId } } });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetIgnored('candidate_id_missing'));
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'candidate_id_missing' }]);
    expect(w.fake.paths()).toEqual(['/application.info']);
  });
});

describe('ignored rows', () => {
  it('an Ashby-scheduled booking: ignored before any other read, zero Ashby requests', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled', source: 'ashby' } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetIgnored('ashby_booking'));
    expect(w.fake.requests).toEqual([]);
    expect(w.tables.calls.map((call) => call.table)).toEqual(['r1_meet_bookings']);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
  });

  it('a missing booking: ignored, zero Ashby requests', async () => {
    const w = newWorld();
    expect(await run(w, 'add', w.newId())).toEqual(r1MeetIgnored('booking_missing'));
    expect(w.fake.requests).toEqual([]);
    expect(w.tables.calls).toHaveLength(1);
  });
});

describe('touches only the Dex tag, and never creates one', () => {
  it('a remove writes the Dex id only; Christy and Referral stay', async () => {
    const w = newWorld();
    const p = person(w, { tags: [w.christyTag(), w.referralTag(), w.dexTag()], booking: { status: 'cancelled' } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
    expect(writeBodies(w)).toEqual([['/candidate.removeTag', body(p.candidateId, w.tagIds.dex)]]);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.christy, w.tagIds.referral]);
  });

  it('an add names the Dex id only', async () => {
    const w = newWorld();
    const p = person(w, { tags: [w.christyTag(), w.referralTag()] });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(writeBodies(w)).toEqual([['/candidate.addTag', body(p.candidateId, w.tagIds.dex)]]);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.christy, w.tagIds.referral, w.tagIds.dex]);
  });

  it('an archived Dex duplicate on the candidate is removed too when the tag is not wanted', async () => {
    const w = newWorld();
    const duplicate = w.newId();
    const p = person(w, {
      tags: [w.dexTag(), { id: duplicate, title: R1_MEET_BOOKED_TAG_TITLE, isArchived: true }, w.christyTag()],
      booking: { status: 'cancelled' },
    });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
    expect(writeBodies(w)).toEqual([
      ['/candidate.removeTag', body(p.candidateId, w.tagIds.dex)],
      ['/candidate.removeTag', body(p.candidateId, duplicate)],
    ]);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.christy]);
  });

  it('only an archived Dex tag on the candidate does not count as holding: the active one is added', async () => {
    const w = newWorld();
    const duplicate = w.newId();
    const p = person(w, { tags: [{ id: duplicate, title: R1_MEET_BOOKED_TAG_TITLE, isArchived: true }] });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(writeBodies(w)).toEqual([['/candidate.addTag', body(p.candidateId, w.tagIds.dex)]]);
  });

  it(`removes at most ${R1_MEET_ASHBY_TAG_MAX_REMOVES} Dex tags per run, then converges on the next`, async () => {
    const w = newWorld();
    const extra = Array.from({ length: R1_MEET_ASHBY_TAG_MAX_REMOVES }, () => ({
      id: w.newId(),
      title: R1_MEET_BOOKED_TAG_TITLE,
      isArchived: true,
    }));
    const p = person(w, { tags: [w.dexTag(), ...extra], booking: { status: 'cancelled' } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetDefer('tag_contended', 60));
    expect(w.fake.requestsOf('/candidate.removeTag')).toHaveLength(R1_MEET_ASHBY_TAG_MAX_REMOVES);
    expect(await run(w, 'remove', p.bookingId, w.h.meta({ deferCount: 1 }))).toEqual(r1MeetProcessed('tag_removed'));
    expect(tagIdsOf(w, p.candidateId)).toEqual([]);
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('catalogue miss, ambiguous and truncated (D-S11-5)', () => {
  const pastTheBound = (w: R1MeetAshbyTagWorld): R1MeetJobMeta[] => [
    w.h.meta({ deferCount: 30 }),
    w.h.meta({ deferCount: 3, deferredAt: iso(w.h.now() - 61 * 60 * 1000) }),
  ];

  it('the Dex tag missing from the catalogue: two walks (cached, then fresh), alert, wait an hour, no write', async () => {
    const w = newWorld();
    w.fake.catalogue.splice(w.fake.catalogue.findIndex((tag) => tag.id === w.tagIds.dex), 1);
    const p = person(w, { withDex: false });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('tag_not_found', 3600));
    expect(walks(w)).toBe(2);
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'tag_not_found' }]);
    expect(w.writes()).toEqual([]);
    for (const meta of pastTheBound(w)) {
      expect((await runThrows(w, 'add', p.bookingId, meta)).code).toBe('r1_meet_ashby_tag_not_found');
    }
    expect(w.writes()).toEqual([]);
  });

  for (const ignoreIncludeArchived of [false, true]) {
    it(`a Dex tag present only archived is not found${ignoreIncludeArchived ? ' (a tenant that lists archived tags anyway)' : ''}`, async () => {
      const w = newWorld();
      w.fake.ignoreIncludeArchived = ignoreIncludeArchived;
      const entry = w.fake.catalogue.findIndex((tag) => tag.id === w.tagIds.dex);
      w.fake.catalogue[entry] = { ...w.fake.catalogue[entry]!, isArchived: true };
      const p = person(w, { withDex: false });
      expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('tag_not_found', 3600));
      expect(walks(w)).toBe(2);
      expect(w.writes()).toEqual([]);
    });
  }

  it('two active Dex tags: ambiguous, alert, wait an hour, no write; past the bound it throws', async () => {
    const w = newWorld();
    w.fake.catalogue.push({ id: w.newId(), title: ` ${R1_MEET_BOOKED_TAG_TITLE} `, isArchived: false });
    const p = person(w, { withDex: false });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('tag_ambiguous', 3600));
    expect(walks(w)).toBe(1);
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'tag_ambiguous' }]);
    for (const meta of pastTheBound(w)) {
      expect((await runThrows(w, 'add', p.bookingId, meta)).code).toBe('r1_meet_ashby_tag_ambiguous');
    }
    expect(w.writes()).toEqual([]);
  });

  it('a truncated catalogue waits ashby_unavailable, with no alert and no write', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidateTag.list', { status: 200, body: { success: true, results: { not: 'a list' } } });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_unavailable', 30));
    expect(walks(w)).toBe(1);
    expect(alerts(w)).toEqual([]);
    expect(w.writes()).toEqual([]);
  });

  it('a near title or another case never matches', async () => {
    const w = newWorld();
    const entry = w.fake.catalogue.findIndex((tag) => tag.id === w.tagIds.dex);
    w.fake.catalogue[entry] = { ...w.fake.catalogue[entry]!, title: 'dex r1: booked' };
    w.fake.catalogue.push({ id: w.newId(), title: `${R1_MEET_BOOKED_TAG_TITLE} (old)`, isArchived: false });
    const p = person(w, { withDex: false });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('tag_not_found', 3600));
    expect(w.writes()).toEqual([]);
  });

  it('a removal needs no catalogue at all', async () => {
    const w = newWorld();
    w.fake.catalogue.length = 0;
    const p = person(w, { booking: { status: 'cancelled' } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
    expect(walks(w)).toBe(0);
  });
});

// ── Ashby failures ──────────────────────────────────────────────────────────

describe('error classes (D-S11-9)', () => {
  const pastTheBound = (w: R1MeetAshbyTagWorld): R1MeetJobMeta => w.h.meta({ deferCount: 30 });

  it('a 429 on candidate.info waits ashby_rate_limited 60 s after exactly one request; past the bound it throws', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.info', { status: 429, headers: { 'Retry-After': '1' } });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_rate_limited', 60));
    expect(w.fake.paths()).toEqual(['/candidate.info']);
    expect(alerts(w)).toEqual([]);
    w.fake.next('/candidate.info', { status: 429 });
    expect((await runThrows(w, 'add', p.bookingId, pastTheBound(w))).code).toBe('r1_meet_ashby_tag_rate_limited');
  });

  for (const step of [{ status: 503 }, { status: 500 }, 'timeout', 'network'] as const) {
    const name = typeof step === 'string' ? step : `HTTP ${step.status}`;
    it(`a ${name} on candidate.info waits ashby_unavailable 30 s; past the bound it throws`, async () => {
      const w = newWorld();
      const p = person(w, { withDex: false });
      w.fake.next('/candidate.info', step);
      expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_unavailable', 30));
      expect(w.fake.paths()).toEqual(['/candidate.info']);
      expect(alerts(w)).toEqual([]);
      w.fake.next('/candidate.info', step);
      expect((await runThrows(w, 'add', p.bookingId, pastTheBound(w))).code).toBe('r1_meet_ashby_tag_unavailable');
    });
  }

  it('a 503 on the add waits, and drops the cached tag id (the next run walks the catalogue again)', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.addTag', { status: 503 });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_unavailable', 30));
    expect(walks(w)).toBe(1);
    expect(await run(w, 'add', p.bookingId, w.h.meta({ deferCount: 1 }))).toEqual(r1MeetProcessed('tag_added'));
    expect(walks(w)).toBe(2);
  });

  const permissionCases = [
    { name: 'a 403 on candidate.info', path: '/candidate.info', step: { status: 403 }, httpStatus: 403 },
    { name: 'a 401 on candidateTag.list', path: '/candidateTag.list', step: { status: 401 }, httpStatus: 401 },
    {
      name: 'a 200 missing_endpoint_permission on candidate.addTag',
      path: '/candidate.addTag',
      step: { status: 200, body: { success: false, errorInfo: { code: 'missing_endpoint_permission' } } },
      httpStatus: 200,
    },
    {
      name: 'a 403 MISSING_ENDPOINT_PERMISSION on candidate.removeTag',
      path: '/candidate.removeTag',
      step: { status: 403, body: { success: false, errors: ['MISSING_ENDPOINT_PERMISSION'] } },
      httpStatus: 403,
    },
  ] as const;

  for (const c of permissionCases) {
    it(`${c.name}: alert permission_denied, wait an hour, no write after it; past the bound it throws`, async () => {
      const w = newWorld();
      const removing = c.path === '/candidate.removeTag';
      const p = person(w, removing ? { booking: { status: 'cancelled' } } : { withDex: false });
      w.fake.next(c.path, c.step);
      expect(await run(w, removing ? 'remove' : 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_permission_denied', 3600));
      expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'permission_denied', http_status: c.httpStatus }]);
      // The failing request is the last one: nothing was written after it.
      expect(w.fake.paths().at(-1)).toBe(c.path);
      expect(w.writes().length).toBeLessThanOrEqual(c.path.includes('Tag') && c.path !== '/candidateTag.list' ? 1 : 0);
      w.fake.next(c.path, c.step);
      expect((await runThrows(w, removing ? 'remove' : 'add', p.bookingId, pastTheBound(w))).code).toBe(
        'r1_meet_ashby_tag_permission_denied',
      );
    });
  }

  it('a 404 on candidate.info (a refused READ): alert http_client_error with its status, ignored', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.info', { status: 404 });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetIgnored('ashby_rejected'));
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'http_client_error', http_status: 404 }]);
    expect(w.writes()).toEqual([]);
  });

  it('an unknown application in application.info (success:false): alert its detail, ignored', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false, link: 'without_candidate' });
    w.fake.applications.delete(p.applicationId);
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetIgnored('ashby_rejected'));
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'logical_failure:application_not_found', http_status: 200 }]);
    expect(w.writes()).toEqual([]);
  });

  it('the client\'s own request validation (a candidate id it will not send): alert, ignored, nothing sent', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    const linkRow = w.tables.rows.ashby_application_links.find((row) => row.external_application_id === p.applicationId)!;
    linkRow.external_candidate_id = `bad${String.fromCharCode(1)}candidate`;
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetIgnored('ashby_request_invalid'));
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'invalid_request' }]);
    expect(w.fake.requests).toEqual([]);
  });

  it('a malformed candidate.info answer waits ashby_unavailable', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.info', { status: 200, body: { success: true, results: { id: p.candidateId, tags: 'not a list' } } });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_unavailable', 30));
    expect(w.writes()).toEqual([]);
  });
});

describe('write refusals (D-S11-7)', () => {
  const refusal = { status: 200, body: { success: false, errors: ['tag_refused'] } } as const;

  it('an add refused twice with the tag still absent: cache dropped, fresh walk, one retry, then alert write_rejected, ignored', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.addTag', refusal);
    w.fake.next('/candidate.addTag', refusal);
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetIgnored('tag_write_rejected'));
    expect(w.fake.paths()).toEqual([
      '/candidate.info',
      '/candidateTag.list',
      '/candidate.addTag',
      '/candidate.info',
      '/candidateTag.list',
      '/candidate.addTag',
      '/candidate.info',
    ]);
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'write_rejected' }]);
    expect(tagIdsOf(w, p.candidateId)).toEqual([]);
  });

  it('a refused add that a recruiter made meanwhile: done (tag_added)', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.addTag', refusal);
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.addTag') w.fake.candidates.get(p.candidateId)!.push(w.dexTag());
    });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(w.fake.requestsOf('/candidate.addTag')).toHaveLength(1);
    expect(alerts(w)).toEqual([]);
  });

  it('an add refused once, then accepted with the fresh id: done', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.next('/candidate.addTag', { status: 404 });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    expect(w.fake.requestsOf('/candidate.addTag')).toHaveLength(2);
    expect(walks(w)).toBe(2);
    expect(alerts(w)).toEqual([]);
  });

  it('a refused remove whose tag is already gone: done (tag_removed)', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled' } });
    w.fake.next('/candidate.removeTag', refusal);
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.removeTag') w.fake.candidates.get(p.candidateId)!.length = 0;
    });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetProcessed('tag_removed'));
    expect(alerts(w)).toEqual([]);
  });

  it('a refused remove whose tag is still there: alert write_rejected, ignored', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled' } });
    w.fake.next('/candidate.removeTag', refusal);
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetIgnored('tag_write_rejected'));
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'write_rejected' }]);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
  });
});

describe('contended: the final look (D-S11-7)', () => {
  it('a recruiter removes the tag right after the add: wait tag_contended, cache dropped; the next run adds again', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    let infos = 0;
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.info' && ++infos === 2) w.fake.candidates.get(p.candidateId)!.length = 0;
    });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('tag_contended', 60));
    expect(walks(w)).toBe(1);
    expect(await run(w, 'add', p.bookingId, w.h.meta({ deferCount: 1 }))).toEqual(r1MeetProcessed('tag_added'));
    // The cache was dropped: the second run walked the catalogue again, within five minutes.
    expect(walks(w)).toBe(2);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
  });

  it('a new live booking lands while a remove runs: the recomputed wanted differs, wait; the next run adds', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled', createdAt: iso(NOW_MS - HOUR_MS) } });
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.removeTag') w.seedBooking(p.applicationId, { status: 'pending', createdAt: HARNESS_NOW });
    });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetDefer('tag_contended', 60));
    expect(tagIdsOf(w, p.candidateId)).toEqual([]);
    expect(await run(w, 'remove', p.bookingId, w.h.meta({ deferCount: 1 }))).toEqual(r1MeetProcessed('tag_added'));
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
  });

  it('past the bound a contended run throws its code', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    let infos = 0;
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.info' && ++infos === 2) w.fake.candidates.get(p.candidateId)!.length = 0;
    });
    expect((await runThrows(w, 'add', p.bookingId, w.h.meta({ deferCount: 30 }))).code).toBe('r1_meet_ashby_tag_contended');
  });
});

// ── Switches, key, wiring, time, database ───────────────────────────────────

describe('switches and wiring (D-S11-11, D-S11-12)', () => {
  for (const value of [false, 'throw'] as const) {
    it(`Ashby's switches ${value === false ? 'off' : 'unreadable'}: warn, wait an hour, no Ashby call, no read beyond the booking`, async () => {
      const w = newWorld();
      const p = person(w, { withDex: false });
      w.setAshbyActive(value);
      expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_inactive', 3600));
      expect(warnings(w)).toEqual([R1_MEET_ASHBY_TAG_INACTIVE_LOG]);
      expect(alerts(w)).toEqual([]);
      expect(w.fake.requests).toEqual([]);
      expect(w.tables.calls.map((call) => call.table)).toEqual(['r1_meet_bookings']);
      expect((await runThrows(w, 'add', p.bookingId, w.h.meta({ deferCount: 30 }))).code).toBe('r1_meet_ashby_tag_ashby_inactive');
    });
  }

  it('no usable key: alert ashby_key_missing, wait an hour, zero requests; past the bound it throws', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled' } });
    w.setKeyConfigured(false);
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetDefer('ashby_key_missing', 3600));
    expect(alerts(w)).toEqual([{ error_category: ALERT, error_type: 'ashby_key_missing' }]);
    expect(w.fake.requests).toEqual([]);
    expect((await runThrows(w, 'remove', p.bookingId, w.h.meta({ deferCount: 30 }))).code).toBe('r1_meet_ashby_tag_key_missing');
    // The key set later is honoured on the next run.
    w.setKeyConfigured(true);
    expect(await run(w, 'remove', p.bookingId, w.h.meta({ deferCount: 2 }))).toEqual(r1MeetProcessed('tag_removed'));
  });

  it('deps.ashbyTag absent: throws r1_meet_ashby_tag_unwired before any read', async () => {
    const w = newWorld();
    const p = person(w);
    const job = parseAshbyBookedTagJob(r1MeetJobs.ashbyBookedTag('add', p.bookingId).payload)!;
    const error = await runR1MeetAshbyBookedTag(w.h.deps, job, w.h.meta()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(R1MeetJobError);
    expect((error as R1MeetJobError).message).toBe(R1_MEET_ASHBY_TAG_UNWIRED);
    expect(w.tables.calls).toEqual([]);
    expect(w.fake.requests).toEqual([]);
  });

  it('unwired through the dispatcher: bounded; on the final attempt it also alerts r1_meet_job_failed', async () => {
    const w = newWorld();
    const p = person(w);
    const dispatcher = createR1MeetDispatcher({ flowDeps: () => w.h.deps, active: () => true });
    const payload = r1MeetJobs.ashbyBookedTag('remove', p.bookingId).payload;
    await expect(dispatcher.handle(w.queueJob(payload, { attempts: 9 }))).rejects.toThrow(R1_MEET_ASHBY_TAG_UNWIRED);
    expect(alerts(w)).toEqual([]);
    await expect(dispatcher.handle(w.queueJob(payload, { attempts: 10 }))).rejects.toThrow(R1_MEET_ASHBY_TAG_UNWIRED);
    expect(alerts(w)).toEqual([{ error_category: 'r1_meet_job_failed', error_type: 'ashby_booked_tag:r1_meet_ashby_tag_unwired' }]);
    expect(jobLines(w)).toEqual(['ashby_booked_tag:r1_meet_ashby_tag_unwired', 'ashby_booked_tag:r1_meet_ashby_tag_unwired']);
    expect(w.fake.requests).toEqual([]);
  });

  it('a wait through the dispatcher passes as a deferral with its code', async () => {
    const w = newWorld();
    const p = person(w);
    w.setAshbyActive(false);
    await expect(w.dispatch(r1MeetJobs.ashbyBookedTag('add', p.bookingId).payload)).resolves.toEqual({
      outcome: 'defer',
      reasonCode: 'ashby_inactive',
      delaySeconds: 3600,
    });
    expect(jobLines(w)).toEqual(['ashby_booked_tag:ashby_inactive']);
  });
});

describe('the run\'s time (D-S11-8)', () => {
  it('a clock that runs 28 s during candidate.info: the next call is not sent, wait ashby_unavailable', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.info') w.h.advance(28_000);
    });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetDefer('ashby_unavailable', 30));
    expect(w.fake.paths()).toEqual(['/candidate.info']);
    expect(alerts(w)).toEqual([]);
  });

  it('out of time before a remove: the remove is never sent, nothing is half-written', async () => {
    const w = newWorld();
    const p = person(w, { booking: { status: 'cancelled' } });
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.info') w.h.advance(28_000);
    });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetDefer('ashby_unavailable', 30));
    expect(w.writes()).toEqual([]);
    expect(tagIdsOf(w, p.candidateId)).toEqual([w.tagIds.dex]);
  });
});

describe('database faults', () => {
  it('the booking read fails: r1_meet_db_error, zero Ashby requests', async () => {
    const w = newWorld();
    const p = person(w);
    w.tables.failNext('r1_meet_bookings');
    expect((await runThrows(w, 'add', p.bookingId)).code).toBe('r1_meet_db_error');
    expect(w.fake.requests).toEqual([]);
  });

  it('the link read fails: r1_meet_db_error before any Ashby call', async () => {
    const w = newWorld();
    const p = person(w);
    w.tables.failNext('ashby_application_links', 'reject');
    expect((await runThrows(w, 'add', p.bookingId)).code).toBe('r1_meet_db_error');
    expect(w.fake.requests).toEqual([]);
  });

  it('the final look\'s read fails after the add: r1_meet_db_error; the rerun converges with no second write', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false });
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.addTag') w.tables.failNext('ashby_application_links', 'throw');
    });
    expect((await runThrows(w, 'add', p.bookingId)).code).toBe('r1_meet_db_error');
    expect(await run(w, 'add', p.bookingId, w.h.meta({ attempts: 2 }))).toEqual(r1MeetProcessed('tag_present'));
    expect(w.writes()).toHaveLength(1);
  });
});

describe('PII (D-S11-15)', () => {
  it('a busy world (every alert, a write, a refusal) leaks nothing: scanned after each test', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false, link: 'without_candidate' });
    expect(await run(w, 'add', p.bookingId)).toEqual(r1MeetProcessed('tag_added'));
    p.booking.status = 'cancelled';
    w.fake.next('/candidate.removeTag', { status: 200, body: { success: false, errors: ['tag_refused'] } });
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetIgnored('tag_write_rejected'));
    w.setKeyConfigured(false);
    expect(await run(w, 'remove', p.bookingId)).toEqual(r1MeetDefer('ashby_key_missing', 3600));
    expect(w.h.logs.length).toBeGreaterThan(5);
    // The client's own lines are metadata only.
    for (const line of w.h.logs.filter((entry) => /^r1_meet_ashby_(ok|failed)$/.test(entry.meta.error_category))) {
      expect(Object.keys(line.meta).sort()).toEqual(
        line.meta.http_status === undefined ? ['error_category', 'error_type'] : ['error_category', 'error_type', 'http_status'],
      );
    }
    // The write bodies are exactly the two ids, never a name or an email.
    for (const request of w.writes()) {
      expect(Object.keys(request.body)).toEqual(['candidateId', 'tagId']);
      expect(request.raw).not.toContain(ASHBY_TAG_SENTINELS.name);
      expect(request.raw).not.toContain(ASHBY_TAG_SENTINELS.email);
    }
  });
});
