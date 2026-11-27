/**
 * M035 S11 (PR #453 review S11-R2): the Meet-off catch-up of the "Lexy R1: Booked" tag
 * (`lib/r1/meet/ashby-booked-tag-meet-off.ts`) and its place in the `r1-sweep` tick (`runtime.ts`,
 * `createR1MeetSweepTick`). With `R1_MEET_ENABLED` deliberately off there is no `r1-meet` lane, so the
 * tag `remove` jobs 0143 queues for the drain backstop's moves wait; the catch-up removes the tag of
 * every public booking that ended before its slot without them. Driven through the REAL booked-tag
 * store over the in-memory tables, the REAL tag port and Ashby client over the stateful fake, and the
 * REAL sweep tick (`support/r1-meet-ashby-tag-fake.ts`, `createR1MeetAshbyTagWorld`).
 *
 * Pinned:
 *  - every way a public booking ends before its slot (candidate or HR cancel, a failure, a drain) loses
 *    the tag in one pass, one write each; a later pass reads the page again but asks Ashby nothing;
 *  - it NEVER adds and never removes a tag the candidate still wants (another booking stands), with no
 *    Ashby read at all; within the day back it decides as the queued job (a failure that was never an
 *    interview loses the tag, a drain after the start or a no-show keeps it); Ashby rows, live and
 *    completed bookings and slots more than a day back are never paged;
 *  - Ashby's switches off, a throwing switch or no usable key: not even a read;
 *  - pages of 10 from a cursor that wraps; the pass budget; a wait ends the pass and holds it for the
 *    wait's seconds (one permission alert per hour, not per bucket); a run that throws is one warning
 *    and is tried again after the wrap;
 *  - the sweep tick runs it after the drain, under the drain's gate only (status exactly `disabled`, a
 *    Recall key), once per bucket and again while there is more; never with an active lane, for an
 *    `invalid` flag, with Meet on, or without a key; it never throws;
 *  - after EVERY test: no log line or report carries a fixture id, a sentinel, the tag's title or the
 *    key; every `error_type` is a safe identifier; only the lane's Ashby paths, never an add.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  R1_MEET_ASHBY_TAG_MEET_OFF,
  R1_MEET_ASHBY_TAG_MEET_OFF_ERROR,
  R1_MEET_ASHBY_TAG_MEET_OFF_PASS,
  createR1MeetAshbyTagMeetOffPass,
  type R1MeetAshbyTagMeetOffReport,
} from '../lib/r1/meet/ashby-booked-tag-meet-off.js';
import { R1_MEET_ASHBY_TAG_WANTED_HELD, runR1MeetAshbyBookedTag } from '../lib/r1/meet/ashby-booked-tag.js';
import { R1_MEET_ASHBY_TAG_RUN_MS, R1_MEET_BOOKED_TAG_TITLE } from '../lib/r1/meet/ashby-booked-tag-ashby.js';
import { getR1MeetConfig, getR1MeetDrainConfig, type R1MeetConfig, type R1MeetDrainConfig } from '../lib/r1/meet/config.js';
import { R1_MEET_ALERTS } from '../lib/r1/meet/recall-actions.js';
import { createR1MeetSweepTick, type R1MeetLane } from '../lib/r1/meet/runtime.js';
import { FAKE_RECALL_API_KEY } from './support/recall-fake.js';
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
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const iso = (ms: number): string => new Date(ms).toISOString();
/** The logger's own rule for a string value (`lib/logger.ts`): a safe identifier of at most 64. */
const LOG_SAFE = /^[a-zA-Z0-9_:.-]{1,64}$/;

const DISABLED: R1MeetConfig = { enabled: false, status: 'disabled' };
const INVALID: R1MeetConfig = { enabled: false, status: 'invalid', reason: 'R1_MEET_ENABLED must be either "true" or "false"' };
const KEY: R1MeetDrainConfig = getR1MeetDrainConfig({ RECALL_API_KEY: FAKE_RECALL_API_KEY });
const NO_KEY: R1MeetDrainConfig = getR1MeetDrainConfig({});

/** A slot a day ahead: a booking that ended now ended before it. */
const AHEAD = { startAt: iso(NOW_MS + 24 * HOUR_MS), updatedAt: HARNESS_NOW } as const;

// ── Every world of a test is scanned after it ──────────────────────────────

let worlds: Array<{ readonly w: R1MeetAshbyTagWorld; readonly reports: unknown[] }> = [];

function newWorld(): R1MeetAshbyTagWorld {
  const w = createR1MeetAshbyTagWorld();
  worlds.push({ w, reports: [] });
  return w;
}

function record(w: R1MeetAshbyTagWorld, value: unknown): void {
  worlds.find((entry) => entry.w === w)?.reports.push(value);
}

afterEach(() => {
  try {
    for (const { w, reports } of worlds) {
      const forbidden = [
        ...w.ids,
        ...w.ids.map((id) => id.toUpperCase()),
        ASHBY_TAG_SENTINELS.name,
        ASHBY_TAG_SENTINELS.email,
        R1_MEET_BOOKED_TAG_TITLE,
        fakeAshbyTagKey(),
      ];
      const text = JSON.stringify(w.h.logs) + JSON.stringify(reports);
      for (const value of forbidden) expect(text).not.toContain(value);
      for (const line of w.h.logs) {
        expect(line.meta.error_category).toMatch(LOG_SAFE);
        if (line.meta.error_type !== undefined) expect(line.meta.error_type).toMatch(LOG_SAFE);
        expect(Object.keys(line.meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key))).toBe(true);
      }
      for (const path of w.fake.paths()) expect(ASHBY_TAG_LANE_PATHS as readonly string[]).toContain(path);
      // Remove-only: never an add, never a catalogue walk (a remove matches the title on the candidate).
      expect(w.fake.requestsOf('/candidate.addTag')).toEqual([]);
      expect(w.fake.requestsOf('/candidateTag.list')).toEqual([]);
      expect(w.h.requests).toEqual([]);
      for (const call of w.tables.calls) expect(['r1_meet_bookings', 'ashby_application_links']).toContain(call.table);
    }
  } finally {
    worlds = [];
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A person whose booking is as given; the candidate holds the Lexy tag unless `withDex` is false. */
function person(w: R1MeetAshbyTagWorld, options: SeedPersonOptions & { readonly withDex?: boolean } = {}): AshbyTagWorldPerson {
  const tags = options.tags ?? (options.withDex === false ? [] : [w.dexTag()]);
  return w.seedPerson({ ...options, tags });
}

/** A person whose public booking was drained before its slot (the backstop's move). */
const drainedPerson = (w: R1MeetAshbyTagWorld): AshbyTagWorldPerson =>
  person(w, { booking: { status: 'drained', ...AHEAD } });

function catchUp(w: R1MeetAshbyTagWorld): () => Promise<R1MeetAshbyTagMeetOffReport> {
  const pass = createR1MeetAshbyTagMeetOffPass({ ashbyTag: w.ashbyTag, now: w.h.now, log: w.h.deps.log });
  return async () => {
    const report = await pass();
    record(w, report);
    return report;
  };
}

const hasDex = (w: R1MeetAshbyTagWorld, candidateId: string): boolean =>
  (w.fake.tagsOf(candidateId) ?? []).some((tag) => tag.id === w.tagIds.dex);
const pages = (w: R1MeetAshbyTagWorld) =>
  w.tables.callsOf('r1_meet_bookings').filter((call) => call.orders.length === 1 && call.orders[0]!.column === 'id');
const removes = (w: R1MeetAshbyTagWorld) => w.fake.requestsOf('/candidate.removeTag');
const report = (removed: number, settled: number, failed: number, more: boolean): R1MeetAshbyTagMeetOffReport => ({
  removed,
  settled,
  failed,
  more,
});

// ── The pass ────────────────────────────────────────────────────────────────

describe('the Meet-off catch-up pass (PR #453 review S11-R2)', () => {
  it('removes the tag of every public booking that ended before its slot, one write each, and asks Ashby once', async () => {
    const w = newWorld();
    const ended = [
      person(w, { booking: { status: 'cancelled', reason: 'candidate_cancelled', ...AHEAD } }),
      person(w, { booking: { status: 'cancelled', ...AHEAD } }),
      person(w, { booking: { status: 'failed', reason: 'invite_undeliverable', ...AHEAD } }),
      person(w, { booking: { status: 'failed', ...AHEAD } }),
      drainedPerson(w),
    ];
    // Other tags on the candidate stay.
    const withOthers = person(w, { tags: [w.christyTag(), w.dexTag(), w.referralTag()], booking: { status: 'drained', ...AHEAD } });
    const pass = catchUp(w);
    expect(await pass()).toEqual(report(6, 6, 0, false));
    for (const p of [...ended, withOthers]) expect(hasDex(w, p.candidateId)).toBe(false);
    expect((w.fake.tagsOf(withOthers.candidateId) ?? []).map((tag) => tag.id)).toEqual([w.tagIds.christy, w.tagIds.referral]);
    expect(removes(w)).toHaveLength(6);
    for (const request of removes(w)) expect(request.body.tagId).toBe(w.tagIds.dex);

    // A later pass reads the page again, but never asks Ashby about a settled booking again.
    const requests = w.fake.requests.length;
    expect(await pass()).toEqual(report(0, 0, 0, false));
    expect(w.fake.requests).toHaveLength(requests);
    expect(pages(w)).toHaveLength(2);
    // No booking row was changed and nothing was queued: the queued jobs later find `tag_absent`.
    expect(w.h.db.calls).toEqual([]);
  });

  it('a booking already without the tag is one read and no write', async () => {
    const w = newWorld();
    const p = person(w, { withDex: false, booking: { status: 'drained', ...AHEAD } });
    expect(await catchUp(w)()).toEqual(report(0, 1, 0, false));
    expect(w.fake.paths()).toEqual(['/candidate.info']);
    expect(hasDex(w, p.candidateId)).toBe(false);
  });

  it('never adds, and never removes a tag the candidate still wants: no Ashby read at all', async () => {
    const w = newWorld();
    // A candidate with a drained booking on one application and a completed interview on another.
    const kept = person(w, { booking: { status: 'drained', ...AHEAD } });
    const other = w.seedApplication(kept.candidateId);
    w.seedBooking(other, { status: 'completed', startAt: iso(NOW_MS - HOUR_MS) });
    // A candidate without the tag whose other application still has a live booking.
    const missing = person(w, { withDex: false, booking: { status: 'cancelled', ...AHEAD } });
    w.seedBooking(w.seedApplication(missing.candidateId), { status: 'pending', ...AHEAD });
    expect(await catchUp(w)()).toEqual(report(0, 2, 0, false));
    expect(hasDex(w, kept.candidateId)).toBe(true);
    expect(hasDex(w, missing.candidateId)).toBe(false);
    expect(w.fake.requests).toEqual([]);

    // The run itself: remove-only answers `tag_wanted_held` where the queue's run would add.
    const job = { kind: 'ashby_booked_tag' as const, op: 'remove' as const, bookingId: missing.bookingId };
    const held = await runR1MeetAshbyBookedTag(w.deps, job, w.h.meta(), { removeOnly: true });
    record(w, held);
    expect(held).toEqual({ outcome: 'done', receipt: 'ignored', code: R1_MEET_ASHBY_TAG_WANTED_HELD });
    expect(w.fake.requests).toEqual([]);
  });

  it('pages only public bookings that ended, their slot at most a day back', async () => {
    const w = newWorld();
    person(w, { booking: { status: 'drained', ...AHEAD, source: 'ashby' } });
    person(w, { booking: { status: 'pending', ...AHEAD } });
    person(w, { booking: { status: 'completed', ...AHEAD } });
    // A slot that began more than a day ago is left to the queued job.
    const old = person(w, { booking: { status: 'failed', reason: 'in_past', startAt: iso(NOW_MS - 25 * HOUR_MS), updatedAt: HARNESS_NOW } });
    expect(await catchUp(w)()).toEqual(report(0, 0, 0, false));
    expect(w.fake.requests).toEqual([]);
    expect(w.tables.calls).toHaveLength(1);
    expect(w.tables.calls[0]!.filters).toContainEqual({ op: 'gt', column: 'start_at', value: iso(NOW_MS - 24 * HOUR_MS) });
    expect(hasDex(w, old.candidateId)).toBe(true);
  });

  it('within the day back it decides as the queued job: never an interview loses the tag, a started one keeps it', async () => {
    const w = newWorld();
    // Maintenance failed a booking that never got a bot `in_past`, 30 minutes after its slot ended.
    const neverInterviewed = person(w, {
      booking: { status: 'failed', reason: 'in_past', startAt: iso(NOW_MS - 2 * HOUR_MS), updatedAt: HARNESS_NOW },
    });
    // The interview's time had come: a drain after the start, a no-show (a bot was sent).
    const drainedLate = person(w, { booking: { status: 'drained', startAt: iso(NOW_MS - MINUTE_MS), updatedAt: HARNESS_NOW } });
    const noShow = person(w, { booking: { status: 'failed', startAt: iso(NOW_MS - HOUR_MS), updatedAt: HARNESS_NOW } });
    expect(await catchUp(w)()).toEqual(report(1, 3, 0, false));
    expect(hasDex(w, neverInterviewed.candidateId)).toBe(false);
    expect([hasDex(w, drainedLate.candidateId), hasDex(w, noShow.candidateId)]).toEqual([true, true]);
    // The two kept ones cost no Ashby call at all.
    for (const request of w.fake.requests) expect(request.body.id ?? request.body.candidateId).toBe(neverInterviewed.candidateId);
  });

  it("does nothing at all while Ashby's switches are off, a switch throws, or no key is usable", async () => {
    for (const setup of [
      (w: R1MeetAshbyTagWorld) => w.setAshbyActive(false),
      (w: R1MeetAshbyTagWorld) => w.setAshbyActive('throw'),
      (w: R1MeetAshbyTagWorld) => w.setKeyConfigured(false),
    ]) {
      const w = newWorld();
      const p = drainedPerson(w);
      setup(w);
      expect(await catchUp(w)()).toEqual(report(0, 0, 0, false));
      expect(w.tables.calls).toEqual([]);
      expect(w.fake.requests).toEqual([]);
      expect(w.h.logs).toEqual([]);
      expect(hasDex(w, p.candidateId)).toBe(true);
    }
  });

  it('pages ten at a time from a cursor, and wraps to the first booking after a short page', async () => {
    const w = newWorld();
    const people = Array.from({ length: 12 }, () => drainedPerson(w));
    const pass = catchUp(w);
    expect(R1_MEET_ASHBY_TAG_MEET_OFF.limit).toBe(10);
    expect(await pass()).toEqual(report(10, 10, 0, true));
    expect(await pass()).toEqual(report(2, 2, 0, false));
    for (const p of people) expect(hasDex(w, p.candidateId)).toBe(false);
    // The wrap: the first page again (all settled, no Ashby call), then the short one.
    const requests = w.fake.requests.length;
    expect(await pass()).toEqual(report(0, 0, 0, true));
    expect(await pass()).toEqual(report(0, 0, 0, false));
    expect(w.fake.requests).toHaveLength(requests);
    const cursors = pages(w).map((call) => call.filters.find((filter) => filter.column === 'id')?.value ?? null);
    expect(cursors).toEqual([null, people[9]!.bookingId, null, people[9]!.bookingId]);
    expect(removes(w)).toHaveLength(12);
  });

  it('starts no run unless a whole run still fits the pass budget; the next pass goes on from there', async () => {
    const w = newWorld();
    const [first, second] = [drainedPerson(w), drainedPerson(w)];
    // The first run's final look takes 25 s: a second run (20 s) no longer fits the 40 s pass.
    expect(R1_MEET_ASHBY_TAG_MEET_OFF.budgetMs).toBe(40 * SECOND_MS);
    expect(R1_MEET_ASHBY_TAG_RUN_MS).toBe(20 * SECOND_MS);
    let infos = 0;
    w.fake.onRequest((request) => {
      if (request.path === '/candidate.info' && request.body.id === first.candidateId && ++infos === 2) w.h.advance(25 * SECOND_MS);
    });
    const pass = catchUp(w);
    expect(await pass()).toEqual(report(1, 1, 0, true));
    expect(hasDex(w, second.candidateId)).toBe(true);
    expect(await pass()).toEqual(report(1, 1, 0, false));
    expect(hasDex(w, second.candidateId)).toBe(false);
    expect(pages(w)[1]!.filters).toContainEqual({ op: 'gt', column: 'id', value: first.bookingId });
  });

  it("a wait ends the pass and holds it for the wait's seconds; the cursor stays on that booking", async () => {
    const w = newWorld();
    const [first, second] = [drainedPerson(w), drainedPerson(w)];
    w.fake.next('/candidate.info', { status: 429 });
    const pass = catchUp(w);
    expect(await pass()).toEqual(report(0, 0, 0, false));
    expect(hasDex(w, first.candidateId)).toBe(true);
    // Held for the run's own wait (`ashby_rate_limited`, 60 s): not even a read.
    const calls = w.tables.calls.length;
    w.h.advance(59 * SECOND_MS);
    expect(await pass()).toEqual(report(0, 0, 0, false));
    expect(w.tables.calls).toHaveLength(calls);
    w.h.advance(SECOND_MS);
    expect(await pass()).toEqual(report(2, 2, 0, false));
    expect([hasDex(w, first.candidateId), hasDex(w, second.candidateId)]).toEqual([false, false]);
    // The page after the wait started from the first booking again.
    expect(pages(w).map((call) => call.filters.some((filter) => filter.column === 'id'))).toEqual([false, false]);
  });

  it('a permission fault alerts once per hour of hold, not once per bucket', async () => {
    const w = newWorld();
    const p = drainedPerson(w);
    w.fake.next('/candidate.info', { status: 403 });
    const pass = catchUp(w);
    expect(await pass()).toEqual(report(0, 0, 0, false));
    const permission = () =>
      w.h.logs.filter((line) => line.level === 'error' && line.meta.error_category === R1_MEET_ALERTS.ashbyTagFailed);
    expect(permission().map((line) => [line.meta.error_type, line.meta.http_status])).toEqual([['permission_denied', 403]]);
    for (let bucket = 1; bucket < 4; bucket += 1) {
      w.h.advance(15 * MINUTE_MS);
      expect(await pass()).toEqual(report(0, 0, 0, false));
    }
    expect(permission()).toHaveLength(1);
    w.h.advance(15 * MINUTE_MS);
    expect(await pass()).toEqual(report(1, 1, 0, false));
    expect(hasDex(w, p.candidateId)).toBe(false);
  });

  it('a run that throws is one warning with its closed code; the others go on and it is tried after the wrap', async () => {
    const w = newWorld();
    const [first, second] = [drainedPerson(w), drainedPerson(w)];
    // The first run's link read fails (a database fault, `r1_meet_db_error`).
    w.tables.failNext('ashby_application_links');
    const pass = catchUp(w);
    expect(await pass()).toEqual(report(1, 1, 1, false));
    expect(w.h.logs.filter((line) => line.meta.error_category === R1_MEET_ASHBY_TAG_MEET_OFF_ERROR).map((line) => [line.level, line.meta.error_type])).toEqual([
      ['warn', 'r1_meet_db_error'],
    ]);
    expect([hasDex(w, first.candidateId), hasDex(w, second.candidateId)]).toEqual([true, false]);
    expect(await pass()).toEqual(report(1, 1, 0, false));
    expect(hasDex(w, first.candidateId)).toBe(false);
  });

  it('a page that cannot be read throws the closed code, and the cursor is kept', async () => {
    const w = newWorld();
    drainedPerson(w);
    w.tables.failNext('r1_meet_bookings');
    const pass = catchUp(w);
    await expect(pass()).rejects.toMatchObject({ code: 'r1_meet_db_error', message: 'r1_meet_db_error' });
    expect(await pass()).toEqual(report(1, 1, 0, false));
  });

  it('its bounds are frozen: 10 a page, 40 s a pass, 1000 settled bookings remembered, a day of slots back', () => {
    expect(R1_MEET_ASHBY_TAG_MEET_OFF).toEqual({ limit: 10, budgetMs: 40 * SECOND_MS, rememberMax: 1000, lookbackMs: 24 * HOUR_MS });
    expect(Object.isFrozen(R1_MEET_ASHBY_TAG_MEET_OFF)).toBe(true);
  });
});

// ── The r1-sweep tick ───────────────────────────────────────────────────────

describe('the r1-sweep tick runs the catch-up after the drain, under the drain gate', () => {
  function sweep(
    w: R1MeetAshbyTagWorld,
    meet: () => R1MeetConfig,
    drain: () => R1MeetDrainConfig = () => KEY,
    lane: R1MeetLane | null = null,
  ) {
    return createR1MeetSweepTick({
      lane,
      meetConfig: meet,
      drainConfig: drain,
      client: w.h.db.client,
      now: w.h.now,
      recall: w.h.client,
      log: w.h.deps.log,
      ashbyTag: w.ashbyTag,
    });
  }

  it('with the flag deliberately off and a key: removes the tag, once per bucket, with one pass line', async () => {
    const w = newWorld();
    const p = drainedPerson(w);
    const tick = sweep(w, () => DISABLED);
    expect(await tick()).toBe(true);
    expect(hasDex(w, p.candidateId)).toBe(false);
    expect(w.h.logs.filter((line) => line.meta.error_category === R1_MEET_ASHBY_TAG_MEET_OFF_PASS).map((line) => [line.level, line.meta.error_type])).toEqual([
      ['info', 'removed_1'],
    ]);
    // Same bucket, nothing more: no page read.
    const calls = w.tables.calls.length;
    w.h.advance(MINUTE_MS);
    expect(await tick()).toBe(false);
    expect(w.tables.calls).toHaveLength(calls);
    // The next bucket reads one page and asks Ashby nothing (settled).
    const requests = w.fake.requests.length;
    w.h.advance(15 * MINUTE_MS);
    expect(await tick()).toBe(false);
    expect(pages(w)).toHaveLength(2);
    expect(w.fake.requests).toHaveLength(requests);
  });

  it('runs again on the next tick within the bucket while a page was full', async () => {
    const w = newWorld();
    const people = Array.from({ length: 12 }, () => drainedPerson(w));
    const tick = sweep(w, () => DISABLED);
    expect(await tick()).toBe(true);
    expect(people.filter((p) => !hasDex(w, p.candidateId))).toHaveLength(10);
    expect(await tick()).toBe(true);
    expect(people.filter((p) => !hasDex(w, p.candidateId))).toHaveLength(12);
    expect(await tick()).toBe(false);
  });

  it('never for `invalid`, with Meet on and no lane, without a Recall key, or with an active lane: zero reads', async () => {
    const enabled = getR1MeetConfig({
      R1_MEET_ENABLED: 'true',
      RECALL_API_KEY: FAKE_RECALL_API_KEY,
      RECALL_WEBHOOK_SECRET: 'whsec' + '_' + Buffer.alloc(32, 7).toString('base64'),
      R1_MEET_ASHBY_DEX_USER_ID: '7f000000-0000-4000-8000-0000000000d1',
      WEB_ORIGIN: 'https://hello.example.test',
    });
    expect(enabled.status).toBe('enabled');
    const lane = { active: () => true, enqueue: async () => {} } as unknown as R1MeetLane;
    for (const make of [
      (w: R1MeetAshbyTagWorld) => sweep(w, () => INVALID),
      (w: R1MeetAshbyTagWorld) => sweep(w, () => enabled),
      (w: R1MeetAshbyTagWorld) => sweep(w, () => DISABLED, () => NO_KEY),
      (w: R1MeetAshbyTagWorld) => sweep(w, () => DISABLED, () => KEY, lane),
    ]) {
      const w = newWorld();
      const p = drainedPerson(w);
      const tick = make(w);
      await tick();
      w.h.advance(15 * MINUTE_MS);
      await tick();
      expect(w.tables.calls).toEqual([]);
      expect(w.fake.requests).toEqual([]);
      expect(hasDex(w, p.candidateId)).toBe(true);
    }
  });

  it('never throws: an unreadable page is one warning, and the next bucket tries again', async () => {
    const w = newWorld();
    const p = drainedPerson(w);
    w.tables.failNext('r1_meet_bookings');
    const tick = sweep(w, () => DISABLED);
    await expect(tick()).resolves.toBe(false);
    expect(w.h.logs.filter((line) => line.meta.error_category === R1_MEET_ASHBY_TAG_MEET_OFF_ERROR).map((line) => [line.level, line.meta.error_type])).toEqual([
      ['warn', 'page'],
    ]);
    // Not a drain alert: the drain's pass is its own.
    expect(w.h.alerts()).toEqual([]);
    w.h.advance(15 * MINUTE_MS);
    await expect(tick()).resolves.toBe(true);
    expect(hasDex(w, p.candidateId)).toBe(false);
  });
});
