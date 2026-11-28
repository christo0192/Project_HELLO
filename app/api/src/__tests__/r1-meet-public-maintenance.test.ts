/** M035 S05 T5: maintenance over the real stores and 0143 fake triggers; no network. */
import { describe, expect, it, vi } from 'vitest';
import { getR1MeetPublicConfig } from '../lib/r1/meet/config.js';
import { r1MeetJobs } from '../lib/r1/meet/jobs.js';
import {
  R1_MEET_MAINTENANCE_STEPS,
  R1_MEET_PUBLIC_MAINTENANCE,
  R1_MEET_PUBLIC_MAINTENANCE_STEPS,
  r1MeetMaintenanceDefinition,
  runR1MeetPublicMaintenance,
} from '../lib/r1/meet/maintenance.js';
import type { Row } from './support/r1-meet-fake-db.js';
import { createR1MeetCalendarWorld, calendarWorldGoogleSettings, type CalendarWorld, type SeedPublicOptions } from './support/r1-meet-calendar-world.js';
import { fixtureId } from './support/r1-meet-harness.js';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();
const run = (w: CalendarWorld, bucket = 1) => runR1MeetPublicMaintenance(w.deps, bucket);
const jobs = (w: CalendarWorld, op: string) => w.h.db.jobs('calendar_sync')
  .map((row) => row.payload as Record<string, unknown>).filter((payload) => payload.op === op);

function enable(w: CalendarWorld, options: { preSlotRecheck?: boolean; calendarRetentionDays?: number } = {}) {
  const google = calendarWorldGoogleSettings();
  if (google.authMode !== 'oauth_refresh') throw new Error('fixture auth mode');
  const config = getR1MeetPublicConfig({
    R1_MEET_PUBLIC_BOOKING_ENABLED: 'true', R1_MEET_ENABLED: 'true',
    RECALL_API_KEY: 'recall-canary-' + 'k'.repeat(20),
    RECALL_WEBHOOK_SECRET: ['whsec', Buffer.alloc(32, 1).toString('base64')].join('_'),
    R1_MEET_ASHBY_DEX_USER_ID: fixtureId(),
    R1_MEET_SERVICE_USER_ID: fixtureId(), R1_MEET_GOOGLE_DEX_EMAIL: google.dexEmail,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: google.clientId,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: google.refreshToken,
    WEB_ORIGIN: 'https://hello.example.test',
  });
  if (config.status !== 'on') throw new Error('fixture public config');
  w.switches.publicConfig = { ...config, ...options };
}

async function seed(w: CalendarWorld, options: SeedPublicOptions = {}, fields: Row = {}) {
  const row = await w.seed({ event: false, ...options });
  Object.assign(w.h.db.tables.r1_meet_bookings.find((b) => b.id === row.bookingId)!, fields);
  return row;
}

const REASONS: Record<string, string> = { blocked: 'bot_cap_reached', completed: 'attempt_settled', failed: 'in_past', cancelled: 'cancelled', drained: 'flag_off' };
async function statusRow(w: CalendarWorld, status: string, startMs: number, fields: Row = {}) {
  return seed(w, {
    status, reason: REASONS[status] ?? 'eligible', startAt: iso(w.h.now() + startMs),
    recallBotId: ['bot_scheduled', 'bot_joining', 'human_present', 'in_call'].includes(status) ? fixtureId() : null,
  }, fields);
}

describe('public maintenance predicates and boundaries', () => {
  it('invite: only undispatched public created rows strictly older than two minutes and strictly beyond fifteen', async () => {
    const w = createR1MeetCalendarWorld();
    const old = { created_at: iso(w.h.now() - 2 * MINUTE - 1) };
    const yes = [];
    for (const status of ['pending', 'blocked', 'bot_scheduled']) yes.push(await statusRow(w, status, 60 * MINUTE, old));
    const edge = await statusRow(w, 'pending', 15 * MINUTE + 1, old);
    await statusRow(w, 'pending', 15 * MINUTE, old);
    await statusRow(w, 'pending', 60 * MINUTE, { created_at: iso(w.h.now() - 2 * MINUTE) });
    for (const state of ['invited', 'cancelled', 'purged']) await statusRow(w, 'pending', 60 * MINUTE, { ...old, calendar_state: state });
    for (const status of ['bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained']) await statusRow(w, status, 60 * MINUTE, old);
    const ashby = w.seedAshbyBooking();
    Object.assign(w.h.db.tables.r1_meet_bookings.find((b) => b.id === ashby)!, old);
    await w.deps.enqueue(r1MeetJobs.calendarSync('invite', edge.bookingId));
    expect((await run(w)).counts.invite).toBe(4);
    expect(jobs(w, 'invite').map((j) => j.booking_id)).toEqual([edge.bookingId, ...yes.map((r) => r.bookingId)]);
    await run(w);
    expect(jobs(w, 'invite')).toHaveLength(4);
    expect(w.requests).toEqual([]);
  });

  it('undeliverable: inclusive fifteen-minute cutoff, releases held bots, never cuts a dispatched call', async () => {
    const w = createR1MeetCalendarWorld();
    const yes = [];
    for (const status of ['pending', 'blocked', 'bot_scheduled']) yes.push(await statusRow(w, status, 15 * MINUTE));
    const no = [await statusRow(w, 'pending', 15 * MINUTE + 1)];
    for (const state of ['invited', 'cancelled', 'purged']) no.push(await statusRow(w, 'pending', MINUTE, { calendar_state: state }));
    for (const status of ['bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained']) no.push(await statusRow(w, status, MINUTE));
    const ashby = w.seedAshbyBooking();
    Object.assign(w.h.db.tables.r1_meet_bookings.find((b) => b.id === ashby)!, { start_at: iso(w.h.now()), end_at: iso(w.h.now() + 45 * MINUTE) });
    const before = structuredClone(no.map((r) => w.h.db.booking(r.bookingId)));
    expect((await run(w)).counts.undeliverable).toBe(3);
    for (const row of yes) expect(w.h.db.booking(row.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
    expect(no.map((r) => w.h.db.booking(r.bookingId))).toEqual(before);
    expect(w.h.db.booking(ashby)!.status).toBe('pending');
    expect(w.h.db.jobs('bot_release').map((r) => r.payload)).toEqual([
      { kind: 'bot_release', booking_id: yes[2]!.bookingId, recall_bot_id: yes[2]!.recallBotId },
    ]);
    expect(w.h.logs.filter((l) => l.meta.error_category === 'r1_meet_public_invite_undeliverable')).toEqual(
      yes.map(() => ({ level: 'error', meta: { error_category: 'r1_meet_public_invite_undeliverable', error_type: 'invite_deadline' } })),
    );
    expect(jobs(w, 'cancel')).toHaveLength(3); // 0143 terminal trigger
    expect(w.h.db.jobs('ashby_booked_tag')).toHaveLength(3);
  });

  it('drift: only ended unused events, future start, strictly beyond ten minutes; one aggregate alert', async () => {
    const w = createR1MeetCalendarWorld();
    const settled = { updated_at: iso(w.h.now() - 10 * MINUTE - 1) };
    const yes = [];
    for (const status of ['cancelled', 'failed', 'drained']) yes.push(await statusRow(w, status, MINUTE, settled));
    yes.push(await statusRow(w, 'failed', 1, { ...settled, calendar_state: 'invited' }));
    await statusRow(w, 'cancelled', 0, settled);
    await statusRow(w, 'cancelled', MINUTE, { updated_at: iso(w.h.now() - 10 * MINUTE) });
    for (const state of ['cancelled', 'purged']) await statusRow(w, 'failed', MINUTE, { ...settled, calendar_state: state });
    for (const status of ['pending', 'blocked', 'bot_scheduled', 'bot_joining', 'in_call', 'completed']) await statusRow(w, status, 60 * MINUTE, settled);
    w.h.db.seedBooking({ status: 'cancelled', reason: 'cancelled', start_at: iso(w.h.now() + MINUTE), end_at: iso(w.h.now() + 46 * MINUTE), ...settled });
    expect((await run(w)).counts.drift).toBe(4);
    expect(jobs(w, 'cancel').map((j) => j.booking_id)).toEqual([yes[3]!.bookingId, ...yes.slice(0, 3).map((r) => r.bookingId)]);
    expect(w.h.logs.filter((l) => l.meta.error_category === 'r1_meet_public_calendar_drift')).toEqual([
      { level: 'error', meta: { error_category: 'r1_meet_public_calendar_drift', error_type: 'queued_4' } },
    ]);
  });

  it.each([false, true])('retention: terminal existing events strictly beyond the cutoff, configured=%s', async (on) => {
    const w = createR1MeetCalendarWorld();
    if (on) enable(w, { calendarRetentionDays: 7 });
    const days = on ? 7 : 30;
    const old = -(days * DAY + 45 * MINUTE + 1);
    const yes = [];
    for (const status of ['completed', 'cancelled', 'failed', 'drained']) yes.push(await statusRow(w, status, old));
    await statusRow(w, 'failed', old + 1);
    for (const state of ['cancelled', 'purged']) await statusRow(w, 'failed', old, { calendar_state: state });
    for (const status of ['pending', 'blocked', 'bot_scheduled', 'bot_joining', 'in_call']) await statusRow(w, status, old, { calendar_state: 'invited' });
    w.h.db.seedBooking({ status: 'failed', reason: 'in_past', start_at: iso(w.h.now() + old), end_at: iso(w.h.now() + old + 45 * MINUTE) });
    expect((await run(w)).counts.retention).toBe(4);
    expect(jobs(w, 'purge').map((j) => j.booking_id)).toEqual(yes.map((r) => r.bookingId));
  });

  it('recheck: [105,120) minutes, undispatched public rows, every calendar state allowed', async () => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    const yes = [];
    for (const [index, state] of ['created', 'invited', 'cancelled', 'purged'].entries()) {
      yes.push(await statusRow(w, index === 0 ? 'pending' : index === 1 ? 'blocked' : 'bot_scheduled', 105 * MINUTE + index, { calendar_state: state }));
    }
    yes.push(await statusRow(w, 'pending', 120 * MINUTE - 1));
    await statusRow(w, 'pending', 105 * MINUTE - 1);
    await statusRow(w, 'pending', 120 * MINUTE);
    for (const status of ['bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained']) await statusRow(w, status, 110 * MINUTE);
    w.h.db.seedBooking({ status: 'pending', reason: 'eligible', round_id: w.h.db.addRound().id, start_at: iso(w.h.now() + 110 * MINUTE) });
    expect((await run(w)).counts.recheck).toBe(0); // all Active
    expect(w.ashby.calls).toEqual(yes.map((row) => ({ op: 'application.info', id: row.applicationId })));
  });

  it.each(['invite', 'undeliverable', 'drift', 'retention', 'recheck'] as const)('%s: at most twenty rows, oldest first', async (step) => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    const rows = [];
    for (let i = 24; i >= 0; i -= 1) {
      const start = (step === 'retention' ? -40 * DAY : step === 'undeliverable' ? MINUTE : step === 'recheck' ? 110 * MINUTE : 60 * MINUTE) + i * 1000;
      rows.push(await statusRow(w, ['drift', 'retention'].includes(step) ? 'failed' : 'pending', start, {
        created_at: iso(w.h.now() - 3 * MINUTE), updated_at: iso(w.h.now() - 11 * MINUTE),
      }));
    }
    const report = await run(w);
    const expected = rows.slice(5).reverse();
    if (step === 'recheck') expect(w.ashby.calls.map((c) => c.id)).toEqual(expected.map((r) => r.applicationId));
    else {
      expect(report.counts[step]).toBe(20);
      if (step === 'undeliverable') expect(rows.filter((r) => w.h.db.booking(r.bookingId)!.status === 'failed').map((r) => r.bookingId).sort()).toEqual(expected.map((r) => r.bookingId).sort());
      else expect(jobs(w, step === 'drift' ? 'cancel' : step === 'retention' ? 'purge' : 'invite').map((j) => j.booking_id)).toEqual(expected.map((r) => r.bookingId));
    }
  });
});

describe('pre-slot status recheck', () => {
  it.each(['Archived', 'Hired'])('%s cancels through cancelFlow, releases the bot and queues both terminal trigger jobs', async (status) => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    const row = await statusRow(w, 'bot_scheduled', 110 * MINUTE);
    w.ashby.applications.set(row.applicationId, { status });
    expect((await run(w)).counts.recheck).toBe(1);
    expect(w.h.db.booking(row.bookingId)).toMatchObject({ status: 'cancelled', reason: 'cancelled', recall_bot_id: null });
    expect(w.h.db.calls.some((c) => c.name === 'r1_meet_cancel_booking')).toBe(true);
    expect(jobs(w, 'cancel')).toHaveLength(1);
    expect(w.h.db.jobs('ashby_booked_tag')).toHaveLength(1);
    expect(w.h.logs).toContainEqual({ level: 'info', meta: { error_category: 'r1_meet_public_recheck', error_type: 'cancelled' } });
    expect(w.h.db.tables.interview_rounds.find((r) => r.id === row.roundId)!.status).toBe('invited'); // known hold limit
  });

  it('Recall unavailable: cancels without deferring, leaves the bot owed', async () => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    const row = await statusRow(w, 'bot_scheduled', 110 * MINUTE);
    w.ashby.applications.set(row.applicationId, { status: 'Archived' });
    w.h.intercept('get', { status: 503 });
    expect((await run(w)).failed).toEqual([]);
    expect(w.h.db.booking(row.bookingId)).toMatchObject({ status: 'cancelled', reason: 'cancelled', recall_bot_id: row.recallBotId });
    expect(w.h.alerts()).toContain('r1_meet_release_owed');
  });

  it.each(['error', 'missing', 'empty', 'unreadable', 'no_key'])('%s cancels nothing, reports failure, and continues other rows', async (mode) => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    const first = await statusRow(w, 'pending', 110 * MINUTE);
    const next = await statusRow(w, 'pending', 111 * MINUTE);
    w.ashby.applications.set(next.applicationId, { status: 'Hired' });
    if (mode === 'error') w.ashby.failNext('application.info');
    else if (mode === 'no_key') w.switches.ashby = false;
    else w.ashby.applications.set(first.applicationId, mode === 'missing' ? {} : { status: mode === 'empty' ? ' ' : 42 });
    const report = await run(w);
    expect(report.failed).toEqual(['recheck']);
    expect(w.h.db.booking(first.bookingId)!.status).toBe('pending');
    expect(w.h.db.booking(next.bookingId)!.status).toBe(mode === 'no_key' ? 'pending' : 'cancelled');
  });

  it('starts no further Ashby call at the twenty-second budget', async () => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    for (let i = 0; i < 6; i += 1) await statusRow(w, 'pending', 110 * MINUTE + i);
    w.ashby.onCall = () => w.h.advance(5000);
    await run(w);
    expect(w.ashby.calls).toHaveLength(4);
  });
});

describe('gates, pruning, and independent failures', () => {
  it('no calendar ports: no reads or lines', async () => {
    const w = createR1MeetCalendarWorld();
    expect((await runR1MeetPublicMaintenance(w.h.deps, 24)).skipped).toBe(true);
    expect(w.h.db.calls).toEqual([]);
    expect(w.h.logs).toEqual([]);
  });

  it.each(['off', 'invalid', 'knob_off'] as const)('recheck is inert when %s, Google absent means zero reads', async (mode) => {
    const w = createR1MeetCalendarWorld();
    enable(w, { preSlotRecheck: false });
    if (mode === 'off') w.switches.publicConfig = { status: 'off' };
    if (mode === 'invalid') w.switches.publicConfig = { status: 'invalid', reason: 'test' };
    await statusRow(w, 'pending', 110 * MINUTE);
    await run(w);
    expect(w.ashby.calls).toEqual([]);
    w.switches.google = false;
    w.h.db.calls.length = 0;
    expect((await run(w, 24)).skipped).toBe(true);
    expect(w.h.db.calls).toEqual([]);
    expect(w.h.logs).toEqual([]);
  });

  it('Google absent: only enabled recheck may read or act', async () => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    w.switches.google = false;
    await statusRow(w, 'pending', 110 * MINUTE);
    w.h.db.calls.length = 0;
    expect((await run(w, 24)).skipped).toBe(false);
    expect(w.h.db.calls).toHaveLength(1);
    expect(w.ashby.calls).toHaveLength(1);
    expect(w.requests).toEqual([]);
  });

  it.each([1, 23, 25])('prune is inert in bucket %i', async (bucket) => {
    const w = createR1MeetCalendarWorld();
    await run(w, bucket);
    expect(w.h.db.calls.filter((c) => c.name === 'r1_meet_public_throttle_prune')).toEqual([]);
  });

  it.each([0, 24, 48])('prune bucket %i passes the exact two-day cutoff and limit', async (bucket) => {
    const w = createR1MeetCalendarWorld();
    await run(w, bucket);
    expect(w.h.db.calls.filter((c) => c.name === 'r1_meet_public_throttle_prune').map((c) => c.args)).toEqual([
      { p_older_than_sec: 172800, p_limit: 5000, p_now: iso(w.h.now()) },
    ]);
  });

  it('prune removes only buckets strictly older than two days', async () => {
    const w = createR1MeetCalendarWorld();
    const THROTTLE_DIGEST = 'a'.repeat(64);
    for (const offset of [-2 * DAY - 1, -2 * DAY, -2 * DAY + 1]) {
      w.h.db.seedThrottle({ key_digest: THROTTLE_DIGEST, bucket_start: iso(w.h.now() + offset), hits: 1 });
    }
    expect((await run(w, 24)).counts.throttle_prune).toBe(1);
    expect(w.h.db.tables.r1_meet_public_throttle.map((r) => r.bucket_start)).toEqual([
      iso(w.h.now() - 2 * DAY), iso(w.h.now() - 2 * DAY + 1),
    ]);
  });

  it.each([[5000, 5000, 4], [5000, 5000, 5000, 5000, 1]])('prune repeats full batches, caps at four: %j', async (...answers) => {
    const w = createR1MeetCalendarWorld();
    const prune = vi.fn(async () => answers.shift()!);
    const deps = { ...w.deps, calendar: { ...w.calendar, store: { ...w.calendar.store, throttlePrune: prune } } };
    const original = [...answers];
    const report = await runR1MeetPublicMaintenance(deps, 24);
    expect(prune).toHaveBeenCalledTimes(Math.min(original.length, 4));
    expect(report.counts.throttle_prune).toBe(original.slice(0, 4).reduce((a, b) => a + b, 0));
  });

  it('one failed invite row does not stop the next, or the following steps', async () => {
    const w = createR1MeetCalendarWorld();
    const first = await statusRow(w, 'pending', 60 * MINUTE, { created_at: iso(w.h.now() - 3 * MINUTE) });
    const next = await statusRow(w, 'pending', 61 * MINUTE, { created_at: iso(w.h.now() - 3 * MINUTE) });
    const deadline = await statusRow(w, 'pending', MINUTE);
    const enqueue = async (...args: Parameters<typeof w.deps.enqueue>) => {
      if (args[0].payload.booking_id === first.bookingId) throw new Error('test failure');
      return w.deps.enqueue(...args);
    };
    const report = await runR1MeetPublicMaintenance({ ...w.deps, enqueue }, 24);
    expect(report.failed).toEqual(['invite']);
    expect(report.counts.invite).toBe(1);
    expect(jobs(w, 'invite').map((j) => j.booking_id)).toEqual([next.bookingId]);
    expect(w.h.db.booking(deadline.bookingId)!.reason).toBe('invite_undeliverable');
    expect(w.h.db.calls.some((c) => c.name === 'r1_meet_public_throttle_prune')).toBe(true);
  });

  it('all public failures use closed words <=64 characters beside the byte-identical classic warning', async () => {
    const w = createR1MeetCalendarWorld();
    enable(w);
    const fail = async (): Promise<never> => { throw new Error('never logged @example.test'); };
    const deps = {
      ...w.deps, store: { ...w.deps.store, listOwedReleases: fail },
      calendar: { ...w.calendar, store: { ...w.calendar.store, listInviteOwed: fail, listInviteDeadline: fail,
        listCalendarDrift: fail, listRetention: fail, listRecheck: fail, throttlePrune: fail } },
    };
    expect(await r1MeetMaintenanceDefinition.run(deps, { kind: 'maintenance', bucket: 24 }, w.h.meta())).toMatchObject({ code: 'maintenance_had_errors' });
    expect(w.h.logs).toEqual([
      { level: 'warn', meta: { error_category: 'r1_meet_maintenance_had_errors', error_type: 'owed' } },
      { level: 'warn', meta: { error_category: 'r1_meet_public_maintenance_had_errors', error_type: R1_MEET_PUBLIC_MAINTENANCE_STEPS.join(':') } },
    ]);
    const words = R1_MEET_PUBLIC_MAINTENANCE_STEPS.join(':');
    expect(words).toMatch(/^[a-z_:]{1,64}$/);
    expect(R1_MEET_MAINTENANCE_STEPS).toEqual(['owed', 'overdue', 'ended', 'stuck', 'capped', 'prune_receipts', 'prune_bookings']);
    expect(R1_MEET_PUBLIC_MAINTENANCE.listLimit).toBe(20);
  });

  it('definition reports public-only errors and clean runs correctly', async () => {
    const w = createR1MeetCalendarWorld();
    expect(await r1MeetMaintenanceDefinition.run(w.deps, { kind: 'maintenance', bucket: 1 }, w.h.meta())).toMatchObject({ code: 'maintenance' });
    const deps = { ...w.deps, calendar: { ...w.calendar, store: { ...w.calendar.store,
      listInviteOwed: async (): Promise<never> => { throw new Error('test'); },
    } } };
    expect(await r1MeetMaintenanceDefinition.run(deps, { kind: 'maintenance', bucket: 1 }, w.h.meta())).toMatchObject({ code: 'maintenance_had_errors' });
    expect(w.h.logs).toEqual([{ level: 'warn', meta: { error_category: 'r1_meet_public_maintenance_had_errors', error_type: 'invite' } }]);
  });
});
