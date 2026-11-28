/** M035 S05: both drain doors cancel public events over real stores and vendor fakes only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getR1MeetDrainConfig } from '../lib/r1/meet/config.js';
import { drainR1Meet, r1MeetDrainDefinition, r1MeetDrainFinished } from '../lib/r1/meet/drain.js';
import { createR1MeetSweepTick } from '../lib/r1/meet/runtime.js';
import { createR1MeetDispatcher } from '../lib/r1/meet/dispatcher.js';
import { R1_MEET_PUBLIC_CALENDAR_ALERTS } from '../lib/r1/meet/calendar-sync.js';
import { FAKE_RECALL_API_KEY } from './support/recall-fake.js';
import { createR1MeetCalendarWorld, type CalendarWorld } from './support/r1-meet-calendar-world.js';

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const OPTIONS = { limit: 25, untouchedForMs: null, force: false, budgetMs: 40_000 };
const REPORT = { drained: 1, completed: 0, released: 0, skipped: 0, failed: 0, more: false };
const driftAlerts = (w: CalendarWorld) => w.h.logs.filter((l) => l.meta.error_category === R1_MEET_PUBLIC_CALENDAR_ALERTS.calendarDrift);
const tickFor = (w: CalendarWorld, calendar = w.calendar) => createR1MeetSweepTick({
  lane: null,
  meetConfig: () => ({ enabled: false, status: 'disabled' }),
  drainConfig: () => getR1MeetDrainConfig({ RECALL_API_KEY: FAKE_RECALL_API_KEY }),
  client: w.h.db.client,
  now: w.h.now,
  recall: w.deps.recall,
  log: w.deps.log,
  calendar,
});

afterEach(() => vi.restoreAllMocks());

describe('door (b): public calendar cleanup with Meet disabled and no lane', () => {
  it.each(['created', 'invited'] as const)('cancels a future %s event with all updates after the booking is drained', async (calendarState) => {
    const w = createR1MeetCalendarWorld();
    const b = await w.seed({ calendarState });
    w.h.advance(6 * MINUTE);
    const tick = tickFor(w);
    expect(await tick()).toBe(true);
    expect(w.h.db.booking(b.bookingId)).toMatchObject({ status: 'drained', reason: 'flag_off', calendar_state: 'cancelled' });
    expect(w.writes()).toMatchObject([{ call: 'calendar.delete', query: { sendUpdates: 'all' } }]);
    expect(w.steps().indexOf('db:transition:drained')).toBeLessThan(w.steps().indexOf('google:calendar.delete'));
    expect(await tick()).toBe(false);
    expect(w.writes()).toHaveLength(1);
    expect(w.ashby.calls).toEqual([]);
    expect(w.h.requests).toEqual([]);
  });

  it.each([0, -1])('at or after start (%s ms) drains with no Google call', async (delta) => {
    const w = createR1MeetCalendarWorld();
    const b = await w.seed({ startAt: iso(w.h.now() + 6 * MINUTE + delta) });
    w.h.advance(6 * MINUTE);
    expect(await tickFor(w)()).toBe(true);
    expect(w.h.db.booking(b.bookingId)).toMatchObject({ status: 'drained', calendar_state: 'created' });
    expect(w.requests).toEqual([]);
  });

  it('Google down still drains, alerts once, and the next bucket catches up the owed event', async () => {
    const w = createR1MeetCalendarWorld();
    const bookings = [await w.seed(), await w.seed()];
    w.interceptGoogle('calendar.delete', { status: 503 });
    w.interceptGoogle('calendar.delete', { status: 503 });
    w.h.advance(6 * MINUTE);
    const tick = tickFor(w);
    expect(await tick()).toBe(true);
    for (const b of bookings) expect(w.h.db.booking(b.bookingId)).toMatchObject({ status: 'drained', calendar_state: 'created' });
    expect(driftAlerts(w)).toHaveLength(1);
    expect(driftAlerts(w)[0]!.meta.error_type).toBe('drain:unavailable');
    w.h.advance(15 * MINUTE);
    await tick();
    for (const b of bookings) expect(w.h.db.booking(b.bookingId)!.calendar_state).toBe('cancelled');
    expect(w.writes()).toHaveLength(4);
    expect(w.ashby.calls).toEqual([]);
  });

  it('an Ashby booking has no calendar booking read or Google call (only the public catch-up list)', async () => {
    const w = createR1MeetCalendarWorld();
    w.seedAshbyBooking();
    const read = vi.fn(w.calendar.store.getBooking);
    w.h.advance(6 * MINUTE);
    await tickFor(w, { ...w.calendar, store: { ...w.calendar.store, getBooking: read } })();
    expect(read).not.toHaveBeenCalled();
    expect(w.requests).toEqual([]);
  });

  it('no Google config makes exactly the original database calls, with the original report', async () => {
    const w = createR1MeetCalendarWorld();
    const b = await w.seed();
    w.switches.google = false;
    w.h.db.calls.length = 0;
    expect(await drainR1Meet(w.deps, OPTIONS)).toEqual(REPORT);
    expect(w.h.db.calls.map((c) => c.name)).toEqual(['r1_meet_bookings', 'r1_meet_bookings', 'r1_meet_transition_booking']);
    expect(w.h.db.booking(b.bookingId)!.calendar_state).toBe('created');
    expect(w.requests).toEqual([]);
    expect(driftAlerts(w)).toEqual([]);
  });
});

describe('door (a) and bounded calendar catch-up', () => {
  it('the operator cancels inline; the trigger cancel job then finds not_owed with one DELETE total', async () => {
    const w = createR1MeetCalendarWorld();
    const b = await w.seed();
    expect(await r1MeetDrainDefinition.run(w.deps, { kind: 'drain', force: false }, w.h.meta())).toMatchObject({ code: 'drained' });
    const payload = w.h.db.jobs('calendar_sync')[0]!.payload;
    expect(payload).toEqual({ kind: 'calendar_sync', op: 'cancel', booking_id: b.bookingId });
    await createR1MeetDispatcher({ flowDeps: () => w.deps, active: () => true }).handle({
      id: 'job-1', name: 'r1-meet', payload, status: 'active', attempts: 1, maxAttempts: 10,
      priority: 0, scheduledAt: iso(w.h.now()), createdAt: iso(w.h.now()), deferCount: 0,
    });
    expect(w.writes()).toHaveLength(1);
    expect(await w.run('cancel', b.bookingId)).toMatchObject({ code: 'not_owed' });
  });

  it('calendar failure never fails the drain or changes its report shape', async () => {
    const w = createR1MeetCalendarWorld();
    await w.seed();
    w.interceptGoogle('calendar.delete', 'network');
    const report = await drainR1Meet(w.deps, OPTIONS);
    expect(report).toEqual(REPORT);
    expect(r1MeetDrainFinished(report)).toBe(true);
    expect(driftAlerts(w)).toHaveLength(1);
  });

  it('a lost state answer is repaired by a gone DELETE in the next pass', async () => {
    const w = createR1MeetCalendarWorld();
    const b = await w.seed();
    w.h.db.failNext('r1_meet_public_set_calendar_state');
    expect(await drainR1Meet(w.deps, OPTIONS)).toEqual(REPORT);
    expect(driftAlerts(w)[0]!.meta.error_type).toBe('drain:database');
    expect(w.h.db.booking(b.bookingId)!.calendar_state).toBe('created');
    w.h.advance(11 * MINUTE);
    await drainR1Meet(w.deps, OPTIONS);
    expect(w.h.db.booking(b.bookingId)!.calendar_state).toBe('cancelled');
    expect(w.writes()).toHaveLength(2);
  });

  it('catch-up is bounded, sets more on a full page, and consumes remaining pages', async () => {
    const w = createR1MeetCalendarWorld();
    for (let i = 0; i < 3; i++) await w.seed({ status: 'drained', reason: 'flag_off' });
    w.h.advance(11 * MINUTE);
    expect(await drainR1Meet(w.deps, { ...OPTIONS, limit: 2 })).toEqual({ ...REPORT, drained: 0, more: true });
    expect(w.writes()).toHaveLength(2);
    expect(await drainR1Meet(w.deps, { ...OPTIONS, limit: 2 })).toEqual({ ...REPORT, drained: 0 });
    expect(w.writes()).toHaveLength(3);
  });

  it('catch-up keeps the ten-minute settling window and never cancels live or past rows', async () => {
    const w = createR1MeetCalendarWorld();
    const recent = await w.seed({ status: 'drained', reason: 'flag_off' });
    const past = await w.seed({ status: 'drained', reason: 'flag_off', startAt: iso(w.h.now() - MINUTE) });
    w.h.advance(10 * MINUTE);
    await drainR1Meet(w.deps, OPTIONS);
    expect(w.requests).toEqual([]);
    w.h.advance(1);
    await drainR1Meet(w.deps, OPTIONS);
    expect(w.h.db.booking(recent.bookingId)!.calendar_state).toBe('cancelled');
    expect(w.h.db.booking(past.bookingId)!.calendar_state).toBe('created');
  });

  it('starts no catch-up cancellation once the pass deadline is reached', async () => {
    const w = createR1MeetCalendarWorld();
    for (let i = 0; i < 3; i++) await w.seed({ status: 'drained', reason: 'flag_off' });
    w.h.advance(11 * MINUTE);
    w.afterGoogle = (call) => { if (call === 'calendar.delete') w.h.advance(40_000); };
    expect(await drainR1Meet(w.deps, OPTIONS)).toEqual({ ...REPORT, drained: 0, more: true });
    expect(w.writes()).toHaveLength(1);
  });

  it('a catch-up list failure is one closed drift alert and no drain failure', async () => {
    const w = createR1MeetCalendarWorld();
    const deps = { ...w.deps, calendar: { ...w.calendar, store: { ...w.calendar.store,
      listCalendarDrift: async () => { throw new Error('private value must never escape'); },
    } } };
    expect(await drainR1Meet(deps, OPTIONS)).toEqual({ ...REPORT, drained: 0 });
    expect(driftAlerts(w)).toHaveLength(1);
    expect(driftAlerts(w)[0]!.meta.error_type).toBe('drain:database');
    expect(JSON.stringify(w.h.logs)).not.toContain('private value');
  });

  it('a losing terminal move never cancels a still-live booking', async () => {
    const w = createR1MeetCalendarWorld();
    const b = await w.seed();
    const deps = { ...w.deps, store: { ...w.deps.store,
      transition: async () => ({ status: 'status_conflict' as const, bookingId: b.bookingId, current: 'pending' as const }),
    } };
    expect(await drainR1Meet(deps, OPTIONS)).toEqual({ ...REPORT, drained: 0, skipped: 1 });
    expect(w.h.db.booking(b.bookingId)!.status).toBe('pending');
    expect(w.requests).toEqual([]);
  });

  it('one failed catch-up cancellation does not stop later rows', async () => {
    const w = createR1MeetCalendarWorld();
    const first = await w.seed({ status: 'drained', reason: 'flag_off' });
    const second = await w.seed({ status: 'drained', reason: 'flag_off', startAt: iso(w.h.now() + 25 * 60 * MINUTE) });
    w.h.advance(11 * MINUTE);
    w.interceptGoogle('calendar.delete', { status: 503 });
    expect(await drainR1Meet(w.deps, OPTIONS)).toEqual({ ...REPORT, drained: 0 });
    expect(w.h.db.booking(first.bookingId)!.calendar_state).toBe('created');
    expect(w.h.db.booking(second.bookingId)!.calendar_state).toBe('cancelled');
    expect(driftAlerts(w)).toHaveLength(1);
  });
});
