/**
 * M035 S05: the `calendar_sync` job (lib/r1/meet/calendar-sync.ts) that keeps Lexy's Google Calendar
 * event of a public-page booking in step with it, over the calendar world: the in-memory 0142/0143
 * port with both 0143 triggers, the REAL Google client over the Google fake, a scripted Ashby read
 * stub and one merged timeline.
 *
 * T3 pins the INVITE (D-S05-2, D-S05-3, D-S05-5, D-S05-8, D-S05-10..12):
 *  - the exact order (event read, Ashby read, digest stored, the one send, the state) and the exact
 *    send (only the on-file attendee and the description, `sendUpdates=all`, `conferenceDataVersion=1`),
 *    whose manage token digests to the stored digest;
 *  - idempotency (a re-run reads the event and writes nothing; an applied invite only repairs the
 *    state), the email sources and the Ashby fallback window, the undeliverable ends (no email, the
 *    deadline, the event gone) with their alert, bot release and trigger jobs;
 *  - every Google failure: the deferral and its bound, Retry-After clamping, `auth_revoked` with one
 *    alert and one token request per run, setup refusals, no Google settings, no manage key;
 *  - the refusals of the two RPCs, the Meet link check (calendar mode only), an Ashby-source booking
 *    (one read), the unwired build, and the PII and token canaries.
 *
 * T4 pins the MOVE (D-S05-4, D-S05-5, D-S05-12), the CANCEL (D-S05-6, through the shared
 * `cancelR1MeetPublicCalendarEvent`) and the PURGE (D-S05-7):
 *  - the move rotates the manage token (digest stored before the one send), sends the new slot and
 *    the description and NEVER the attendees, converges on the current row (a stale job sends the
 *    newest slot, the later one finds it done), repairs a lost invite answer, alerts a changed Meet
 *    link (calendar mode), handles a gone event, and skips terminal and finished bookings unread;
 *  - the cancel deletes with `sendUpdates=all` for `created` and `invited` before the slot only, never
 *    a live booking's event, counts 404/410 as done, and maps every Google failure as the invite;
 *  - the purge derives the event id (the row may be gone), tells the candidate only when the slot is
 *    still ahead, and writes nothing to the database when the row is gone;
 *  - end to end through the dispatcher and the real registry: HR's round cancel reaches ONE delete
 *    (`all`) through `cancelFlow` and the 0143 trigger; a delete of the row reaches ONE delete
 *    (`none`); every payload holds ids and closed words only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { isGoogleError } from '../integrations/google/errors.js';
import type { QueueJob } from '../lib/queue/types.js';
import {
  R1_MEET_CALENDAR_SYNC,
  R1_MEET_CALENDAR_UNWIRED,
  R1_MEET_PUBLIC_CALENDAR_ALERTS,
  cancelR1MeetPublicCalendarEvent,
  r1MeetCalendarEventId,
  r1MeetCalendarSyncDefinition,
  runR1MeetCalendarSync,
  type R1MeetCalendarGoogle,
} from '../lib/r1/meet/calendar-sync.js';
import { createR1MeetDispatcher } from '../lib/r1/meet/dispatcher.js';
import { R1MeetJobError, R1_MEET_QUEUE, r1MeetJobs, type R1MeetJobResult } from '../lib/r1/meet/jobs.js';
import { R1_MEET_MANAGE_TOKEN_PATTERN, r1MeetManageTokenDigest } from '../lib/r1/meet/public/manage-token.js';
import type { R1MeetFlowDeps } from '../lib/r1/meet/recall-actions.js';
import { BRIDGE_SOURCE, HARNESS_NOW, OTHER_MEET_URL, WEB_ORIGIN_FIXTURE } from './support/r1-meet-harness.js';
import {
  ASHBY_EMAIL,
  LOCAL_EMAIL,
  createR1MeetCalendarWorld,
  type CalendarWorld,
  type CalendarWorldGoogleRequest,
  type SeedPublicOptions,
  type SeededPublicBooking,
} from './support/r1-meet-calendar-world.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ALERTS = R1_MEET_PUBLIC_CALENDAR_ALERTS;

/** The manage token a send carried in its description (the plaintext exists in Google only). */
function tokenOf(request: CalendarWorldGoogleRequest | undefined): string {
  const description = (request?.body as { description?: unknown } | null)?.description;
  const match = typeof description === 'string' ? /#m=([A-Za-z0-9_-]+)$/m.exec(description) : null;
  if (match === null) throw new Error('no manage link in the send');
  return match[1]!;
}

const errorLines = (w: CalendarWorld) => w.h.logs.filter((line) => line.level === 'error').map((line) => line.meta);
const row = (w: CalendarWorld, id: string) => w.h.db.booking(id)!;

async function thrownBy(promise: Promise<unknown>): Promise<R1MeetJobError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(R1MeetJobError);
  return error as R1MeetJobError;
}

let world: CalendarWorld | null = null;
afterEach(() => {
  world = null;
});

async function setup(seed: SeedPublicOptions = {}, options: Parameters<typeof createR1MeetCalendarWorld>[0] = {}) {
  world = createR1MeetCalendarWorld(options);
  const booking = await world.seed(seed);
  return { w: world, b: booking };
}

const invited = (b: SeededPublicBooking, w: CalendarWorld) => ({
  attendees: (w.fake.events.get(b.eventId)!.fields.attendees as Array<{ email: string }>).map((a) => a.email),
});

describe('invite', () => {
  it('reads the event, reads Ashby, stores the digest, sends once, then sets the state (D-S05-2)', async () => {
    const { w, b } = await setup();
    const result = await w.run('invite', b.bookingId);
    expect(result).toEqual({ outcome: 'done', receipt: 'processed', code: 'invited' });

    expect(w.steps()).toEqual([
      'google:calendar.get',
      'ashby:candidate.info',
      'db:public_set_manage_digest',
      'google:calendar.patch',
      'db:public_set_calendar_state',
    ]);
    expect(w.ashby.calls).toEqual([{ op: 'candidate.info', id: b.ashbyCandidateId }]);

    // The one send: exactly the on-file attendee (Ashby's primary) and the description.
    const writes = w.writes();
    expect(writes).toHaveLength(1);
    const send = writes[0]!;
    expect(send.path.endsWith(`/events/${b.eventId}`)).toBe(true);
    expect(send.query).toEqual({ conferenceDataVersion: '1', sendUpdates: 'all' });
    const token = tokenOf(send);
    expect(token).toMatch(R1_MEET_MANAGE_TOKEN_PATTERN);
    expect(Object.keys(send.body as object).sort()).toEqual(['attendees', 'description']);
    expect((send.body as { attendees: unknown }).attendees).toEqual([{ email: ASHBY_EMAIL }]);
    const description = (send.body as { description: string }).description;
    expect(description).toContain(`${WEB_ORIGIN_FIXTURE}/book/manage#m=${token}`);
    expect(description).toContain('Lexy');
    expect(description).not.toContain(b.meetUrl);

    // Only the digest is stored, and it is the token's.
    const booking = row(w, b.bookingId);
    expect(booking.manage_token_digest).toBe(r1MeetManageTokenDigest(token, BRIDGE_SOURCE));
    expect(booking.calendar_state).toBe('invited');
    expect(booking.invite_sent_at).toBe(new Date(w.h.now()).toISOString());
    expect(booking.status).toBe('pending');
    expect(invited(b, w).attendees).toEqual([ASHBY_EMAIL]);
    expect(errorLines(w)).toEqual([]);
    expect(w.h.db.jobs()).toEqual([]);
  });

  it('is idempotent: a re-run reads the event and writes nothing (one Google write in total)', async () => {
    const { w, b } = await setup();
    await w.run('invite', b.bookingId);
    const digest = row(w, b.bookingId).manage_token_digest;
    const before = w.steps().length;
    expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'already_invited' }));
    expect(w.steps().slice(before)).toEqual(['google:calendar.get']);
    expect(w.writes()).toHaveLength(1);
    expect(w.ashby.calls).toHaveLength(1);
    expect(row(w, b.bookingId).manage_token_digest).toBe(digest);
  });

  it('an applied invite whose answer was lost only repairs the state: no token, no send, no Ashby read', async () => {
    const { w, b } = await setup();
    // Google has the attendee (the send landed), the row still says `created`.
    w.fake.events.get(b.eventId)!.fields.attendees = [{ email: ASHBY_EMAIL }];
    expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'processed', code: 'invite_confirmed' }));
    expect(w.steps()).toEqual(['google:calendar.get', 'db:public_set_calendar_state']);
    expect(w.writes()).toEqual([]);
    expect(w.ashby.calls).toEqual([]);
    const booking = row(w, b.bookingId);
    expect(booking.calendar_state).toBe('invited');
    expect(booking.manage_token_digest).toBeNull();
  });

  it('sends again when the row says invited but the event has no attendee', async () => {
    const { w, b } = await setup({ calendarState: 'invited' });
    expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
    expect(w.writes()).toHaveLength(1);
    expect(row(w, b.bookingId).calendar_state).toBe('invited');
  });

  describe('the on-file email (D-S05-3)', () => {
    it('without the link candidate id, reads application.info for the person, then candidate.info', async () => {
      const { w, b } = await setup({ linkAshbyCandidate: false });
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
      expect(w.ashby.calls).toEqual([
        { op: 'application.info', id: b.applicationId },
        { op: 'candidate.info', id: b.ashbyCandidateId },
      ]);
      expect((w.writes()[0]!.body as { attendees: unknown }).attendees).toEqual([{ email: ASHBY_EMAIL }]);
    });

    it('an Ashby person with no primary address falls back to candidates.email', async () => {
      const { w, b } = await setup({ ashbyEmail: null });
      await w.run('invite', b.bookingId);
      expect((w.writes()[0]!.body as { attendees: unknown }).attendees).toEqual([{ email: LOCAL_EMAIL }]);
      expect(errorLines(w)).toEqual([]);
    });

    it('an application.info that names no person uses candidates.email at once', async () => {
      const { w, b } = await setup({ linkAshbyCandidate: false, applicationNamesCandidate: false });
      await w.run('invite', b.bookingId);
      expect(w.ashby.calls).toEqual([{ op: 'application.info', id: b.applicationId }]);
      expect((w.writes()[0]!.body as { attendees: unknown }).attendees).toEqual([{ email: LOCAL_EMAIL }]);
    });

    it('an unusable Ashby address is not used: the local one is', async () => {
      const { w, b } = await setup({ ashbyEmail: 'not an address' });
      await w.run('invite', b.bookingId);
      expect((w.writes()[0]!.body as { attendees: unknown }).attendees).toEqual([{ email: LOCAL_EMAIL }]);
    });

    it('Ashby down before the fallback window: defer ashby_unavailable 120 s, no digest, no send', async () => {
      const { w, b } = await setup();
      w.ashby.failAll('http_server_error');
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'ashby_unavailable', delaySeconds: 120 });
      expect(w.steps()).toEqual(['google:calendar.get', 'ashby:candidate.info']);
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
      expect(w.writes()).toEqual([]);
      expect(errorLines(w)).toEqual([]);
    });

    it('no usable Ashby key counts as Ashby down: no Ashby call, the same deferral', async () => {
      const { w, b } = await setup();
      w.switches.ashby = false;
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'ashby_unavailable', delaySeconds: 120 });
      expect(w.ashby.calls).toEqual([]);
    });

    it('Ashby down past the deferral bound throws r1_meet_calendar_ashby_unavailable', async () => {
      const { w, b } = await setup();
      w.ashby.failAll('timeout');
      const error = await thrownBy(w.run('invite', b.bookingId, w.h.meta({ deferCount: 30 })));
      expect(error.code).toBe('r1_meet_calendar_ashby_unavailable');
      expect(error.message).toBe('r1_meet_calendar_ashby_unavailable');
      expect(w.writes()).toEqual([]);
    });

    it('Ashby down from 30 minutes before the slot: candidates.email alone, with the invite_fallback alert', async () => {
      const { w, b } = await setup({ startAt: new Date(Date.parse(HARNESS_NOW) + 30 * MINUTE).toISOString() });
      w.ashby.failAll('http_server_error');
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
      expect((w.writes()[0]!.body as { attendees: unknown }).attendees).toEqual([{ email: LOCAL_EMAIL }]);
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.ashbyUnavailable, error_type: 'invite_fallback' }]);
    });

    it('one millisecond before the window, Ashby down still waits', async () => {
      const start = Date.parse(HARNESS_NOW) + 30 * MINUTE + 1;
      const { w, b } = await setup({ startAt: new Date(start).toISOString() });
      w.ashby.failAll('http_server_error');
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ outcome: 'defer', code: 'ashby_unavailable' }));
    });

    it('Ashby down inside the window and no local email: invite_undeliverable (no_email)', async () => {
      const { w, b } = await setup({ localEmail: null, startAt: new Date(Date.parse(HARNESS_NOW) + 20 * MINUTE).toISOString() });
      w.ashby.failAll('network');
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'processed', code: 'invite_undeliverable' }));
      expect(errorLines(w)).toEqual([
        { error_category: ALERTS.ashbyUnavailable, error_type: 'invite_fallback' },
        { error_category: ALERTS.inviteUndeliverable, error_type: 'no_email' },
      ]);
      expect(row(w, b.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
      expect(w.writes()).toEqual([]);
    });
  });

  it('no email at all: failed/invite_undeliverable, one alert, the bot released, the two trigger jobs', async () => {
    const { w, b } = await setup({ status: 'bot_scheduled', ashbyEmail: null, localEmail: null });
    expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'invite_undeliverable' });
    expect(row(w, b.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable', calendar_state: 'created', manage_token_digest: null });
    expect(errorLines(w)).toEqual([{ error_category: ALERTS.inviteUndeliverable, error_type: 'no_email' }]);
    expect(w.writes()).toEqual([]);
    const jobs = w.h.db.jobs().map((job) => [job.payload, job.dedup_key, job.max_attempts]);
    expect(jobs).toEqual(
      expect.arrayContaining([
        [{ kind: 'calendar_sync', op: 'cancel', booking_id: b.bookingId }, `r1-meet:calendar:${b.bookingId}:cancel`, 10],
        [{ kind: 'ashby_booked_tag', op: 'remove', booking_id: b.bookingId }, `r1-meet:ashby-tag:${b.bookingId}:remove`, 10],
        [{ kind: 'bot_release', recall_bot_id: b.recallBotId, booking_id: b.bookingId }, `r1-meet:bot-release:${b.recallBotId}`, 10],
      ]),
    );
    expect(jobs).toHaveLength(3);
  });

  it('a booking that moved meanwhile is not failed twice: the undeliverable move answers status_conflict', async () => {
    const { w, b } = await setup({ ashbyEmail: null, localEmail: null });
    w.ashby.onCall = () => {
      Object.assign(row(w, b.bookingId), { status: 'blocked', reason: 'paused' });
    };
    expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invite_undeliverable' }));
    expect(row(w, b.bookingId)).toMatchObject({ status: 'blocked' });
    expect(errorLines(w)).toEqual([]);
  });

  describe('the deadline (15 minutes before the slot)', () => {
    it('no attendee at start - 15 min: invite_undeliverable (invite_deadline), no Ashby read, no send', async () => {
      const { w, b } = await setup({ startAt: new Date(Date.parse(HARNESS_NOW) + 15 * MINUTE).toISOString() });
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'processed', code: 'invite_undeliverable' }));
      expect(w.steps()).toEqual(['google:calendar.get', 'db:transition:failed', 'queue:calendar_sync', 'queue:ashby_booked_tag']);
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.inviteUndeliverable, error_type: 'invite_deadline' }]);
      expect(w.ashby.calls).toEqual([]);
      expect(w.writes()).toEqual([]);
    });

    it('one millisecond earlier the invite is still sent', async () => {
      const { w, b } = await setup({ startAt: new Date(Date.parse(HARNESS_NOW) + 15 * MINUTE + 1).toISOString() });
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
    });

    it('an applied invite is still confirmed after the deadline', async () => {
      const { w, b } = await setup({ startAt: new Date(Date.parse(HARNESS_NOW) + 5 * MINUTE).toISOString() });
      w.fake.events.get(b.eventId)!.fields.attendees = [{ email: ASHBY_EMAIL }];
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invite_confirmed' }));
      expect(row(w, b.bookingId).status).toBe('pending');
    });
  });

  describe('the event is gone (D-S05-5)', () => {
    const expectGone = (w: CalendarWorld, b: SeededPublicBooking, result: R1MeetJobResult) => {
      expect(result).toEqual({ outcome: 'done', receipt: 'processed', code: 'event_gone' });
      expect(row(w, b.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.inviteUndeliverable, error_type: 'event_gone' }]);
      expect(w.h.db.jobs('calendar_sync').map((job) => job.payload)).toEqual([{ kind: 'calendar_sync', op: 'cancel', booking_id: b.bookingId }]);
    };

    it('never inserted (404)', async () => {
      const { w, b } = await setup({ event: false });
      expectGone(w, b, await w.run('invite', b.bookingId));
      expect(w.writes()).toEqual([]);
      expect(w.ashby.calls).toEqual([]);
    });

    it('deleted on Lexy\'s calendar (410)', async () => {
      const { w, b } = await setup();
      w.fake.events.get(b.eventId)!.deleted = true;
      expectGone(w, b, await w.run('invite', b.bookingId));
      expect(w.writes()).toEqual([]);
    });

    it('cancelled on Lexy\'s calendar', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.get', { status: 200, body: { id: b.eventId, status: 'cancelled' } });
      expectGone(w, b, await w.run('invite', b.bookingId));
      expect(w.writes()).toEqual([]);
    });

    it.each([404, 410])('the send answers %i', async (status) => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.patch', { status, body: { error: { code: status, message: 'gone' } } });
      expectGone(w, b, await w.run('invite', b.bookingId));
      expect(w.writes()).toHaveLength(1);
    });
  });

  describe('Google failures (D-S05-8)', () => {
    it.each([
      ['a 503', { status: 503, body: { error: { code: 503 } } }, 'google_unavailable', 10],
      ['a 503 with Retry-After 2 (clamped up to 5)', { status: 503, headers: { 'Retry-After': '2' } }, 'google_unavailable', 5],
      ['a 503 with Retry-After 900 (clamped down to 300)', { status: 503, headers: { 'Retry-After': '900' } }, 'google_unavailable', 300],
      ['a 429', { status: 429 }, 'google_quota', 30],
      ['a 429 with Retry-After 120', { status: 429, headers: { 'Retry-After': '120' } }, 'google_quota', 120],
      ['a quota 403', { status: 403, body: { error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } } }, 'google_quota', 30],
      ['a body that is not JSON', { status: 200, body: 'not json' }, 'google_unavailable', 30],
      ['a network failure', 'network', 'google_unavailable', 5],
    ] as const)('the event read: %s defers %s for %i s', async (_label, response, code, seconds) => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.get', response);
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code, delaySeconds: seconds });
      expect(w.writes()).toEqual([]);
      expect(w.ashby.calls).toEqual([]);
      expect(errorLines(w)).toEqual([]);
      expect(row(w, b.bookingId)).toMatchObject({ status: 'pending', calendar_state: 'created', manage_token_digest: null });
    });

    it('a timeout defers google_unavailable for the client hint', async () => {
      const { w, b } = await setup({}, { googleTimeoutMs: 20 });
      w.interceptGoogle('calendar.get', 'hang');
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_unavailable', delaySeconds: 5 });
    });

    it('past the deferral bound the closed code is thrown', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.get', { status: 503 });
      const unavailable = await thrownBy(w.run('invite', b.bookingId, w.h.meta({ deferCount: 30 })));
      expect(unavailable.code).toBe('r1_meet_calendar_google_unavailable');
      w.interceptGoogle('calendar.get', { status: 429 });
      const streak = new Date(w.h.now() - HOUR).toISOString();
      const quota = await thrownBy(w.run('invite', b.bookingId, w.h.meta({ deferCount: 1, deferredAt: streak })));
      expect(quota.code).toBe('r1_meet_calendar_google_quota');
    });

    it('a failed send defers after the digest was stored; the next run sends with a NEW token and converges', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.patch', { status: 503 });
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ outcome: 'defer', code: 'google_unavailable' }));
      const first = row(w, b.bookingId).manage_token_digest;
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(row(w, b.bookingId).calendar_state).toBe('created');
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
      const sends = w.writes();
      expect(sends).toHaveLength(2);
      expect(tokenOf(sends[0])).not.toBe(tokenOf(sends[1]));
      expect(row(w, b.bookingId).manage_token_digest).toBe(r1MeetManageTokenDigest(tokenOf(sends[1]), BRIDGE_SOURCE));
      expect(row(w, b.bookingId).manage_token_digest).not.toBe(first);
    });

    it('auth_revoked (Lexy\'s refresh token died): one alert, defer 3600 s, one token request per run, never a loop', async () => {
      const { w, b } = await setup();
      w.fake.revokeRefreshToken();
      w.fake.expireAccessTokens();
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_auth_revoked', delaySeconds: 3600 });
      const alerts = errorLines(w);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ error_category: ALERTS.googleAuthFailed, error_type: 'calendar.get' });
      expect(w.tokenCalls()).toHaveLength(1);
      expect(w.apiCalls()).toHaveLength(1);

      // A second run inside the token source's refusal window: no request at all, one more alert.
      const streak = new Date(w.h.now()).toISOString();
      expect(await w.run('invite', b.bookingId, w.h.meta({ deferCount: 1, deferredAt: streak }))).toEqual({
        outcome: 'defer',
        code: 'google_auth_revoked',
        delaySeconds: 3600,
      });
      expect(w.tokenCalls()).toHaveLength(1);
      expect(w.apiCalls()).toHaveLength(1);
      expect(errorLines(w)).toHaveLength(2);

      // Past the bound (an hour into the streak): the closed code.
      const late = await thrownBy(
        w.run('invite', b.bookingId, w.h.meta({ deferCount: 1, deferredAt: new Date(w.h.now() - HOUR).toISOString() })),
      );
      expect(late.code).toBe('r1_meet_calendar_google_auth_revoked');
      expect(w.writes()).toEqual([]);
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
    });

    it('setup_forbidden: the setup alert and an hour\'s wait', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.get', { status: 403, body: { error: { code: 403, message: 'Forbidden', errors: [{ domain: 'global', reason: 'forbidden' }] } } });
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_setup', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'google_setup_forbidden', http_status: 403 }]);
    });

    it('unauthorized (401 twice, once after a fresh token): the setup alert and an hour\'s wait', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.get', { status: 401 });
      w.interceptGoogle('calendar.get', { status: 401 });
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_setup', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'google_unauthorized', http_status: 401 }]);
      expect(w.tokenCalls()).toHaveLength(1);
    });

    it('a 400 on the send is a bug: r1_meet_calendar_google_invalid_request', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.patch', { status: 400, body: { error: { code: 400 } } });
      expect((await thrownBy(w.run('invite', b.bookingId))).code).toBe('r1_meet_calendar_google_invalid_request');
    });

    it('no Google settings for Lexy: the setup alert google_unconfigured, an hour\'s wait, zero Google calls', async () => {
      const { w, b } = await setup();
      w.switches.google = false;
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_unconfigured', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'google_unconfigured' }]);
      expect(w.requests).toEqual([]);
      expect(w.ashby.calls).toEqual([]);
      const late = await thrownBy(w.run('invite', b.bookingId, w.h.meta({ deferCount: 30 })));
      expect(late.code).toBe('r1_meet_calendar_google_unconfigured');
    });
  });

  describe('the manage key', () => {
    it.each([
      ['absent', {}],
      ['shorter than 32 characters', { WORKER_CONTEXT_SECRET: 'w'.repeat(31) }],
    ])('%s: the setup alert manage_key_missing, an hour\'s wait, no Ashby read, no send', async (_label, source) => {
      const { w, b } = await setup({}, { harness: { ticketSource: source as NodeJS.ProcessEnv } });
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'defer', code: 'manage_key_missing', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'manage_key_missing' }]);
      expect(w.ashby.calls).toEqual([]);
      expect(w.writes()).toEqual([]);
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
      const late = await thrownBy(w.run('invite', b.bookingId, w.h.meta({ deferCount: 30 })));
      expect(late.code).toBe('r1_meet_calendar_manage_key_missing');
    });
  });

  it('an unknown objective profile alerts and throws before any Ashby read', async () => {
    const { w, b } = await setup();
    row(w, b.bookingId).objective_profile = 'r1_unknown_profile';
    expect((await thrownBy(w.run('invite', b.bookingId))).code).toBe('r1_meet_calendar_profile_unknown');
    expect(errorLines(w)).toEqual([{ error_category: 'r1_meet_profile_unknown' }]);
    expect(w.ashby.calls).toEqual([]);
    expect(w.writes()).toEqual([]);
  });

  describe('the manage token and the words (D-S05-10, D-S05-11)', () => {
    it('the token comes from the injected random source (32 bytes), and only its digest is stored', async () => {
      const sizes: number[] = [];
      const random = (bytes: number): Buffer => {
        sizes.push(bytes);
        return Buffer.alloc(bytes, 7);
      };
      const { w, b } = await setup({}, { harness: { random } });
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
      expect(sizes).toEqual([32]);
      const token = tokenOf(w.writes()[0]);
      expect(token).toBe(Buffer.alloc(32, 7).toString('base64url'));
      expect(row(w, b.bookingId).manage_token_digest).toBe(r1MeetManageTokenDigest(token, BRIDGE_SOURCE));
    });

    it('a random source of the wrong length throws r1_meet_calendar_mint_failed: nothing stored, no send', async () => {
      const { w, b } = await setup({}, { harness: { random: (bytes: number) => Buffer.alloc(bytes - 1, 1) } });
      const error = await thrownBy(w.run('invite', b.bookingId));
      expect(error.code).toBe('r1_meet_calendar_mint_failed');
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
      expect(w.writes()).toEqual([]);
    });

    it('a bridge page URL that is not a canonical origin throws r1_meet_calendar_copy_invalid: nothing stored, no send', async () => {
      const { w, b } = await setup({}, { harness: { config: { bridgePageUrl: 'http://hello.example.test/r1/meet/join' } } });
      const error = await thrownBy(w.run('invite', b.bookingId));
      expect(error.code).toBe('r1_meet_calendar_copy_invalid');
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
      expect(w.writes()).toEqual([]);
    });
  });

  describe('the refusals of the two RPCs', () => {
    it('set_manage_digest answers booking_terminal (the booking ended meanwhile): ignored, no send', async () => {
      const { w, b } = await setup();
      w.ashby.onCall = () => {
        Object.assign(row(w, b.bookingId), { status: 'cancelled', reason: 'candidate_cancelled' });
      };
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'booking_terminal' }));
      expect(w.writes()).toEqual([]);
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
    });

    it('set_manage_digest answers not_found (the row was deleted meanwhile): ignored, no send', async () => {
      const { w, b } = await setup();
      w.ashby.onCall = () => {
        w.h.db.deleteBooking(b.bookingId);
      };
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'booking_gone' }));
      expect(w.writes()).toEqual([]);
    });

    it('set_calendar_state answers state_conflict after the send: processed, nothing else', async () => {
      const { w, b } = await setup();
      w.afterGoogle = (call) => {
        if (call === 'calendar.patch') row(w, b.bookingId).calendar_state = 'cancelled';
      };
      expect(await w.run('invite', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'invited_state_conflict' });
      expect(row(w, b.bookingId).calendar_state).toBe('cancelled');
      expect(w.writes()).toHaveLength(1);
      expect(errorLines(w)).toEqual([]);
      expect(w.h.db.jobs()).toEqual([]);
    });
  });

  describe('the Meet link check (D-S05-12)', () => {
    it('calendar mode: a different Meet link on the event alerts meet_link_changed (invite) and changes nothing else', async () => {
      const { w, b } = await setup();
      row(w, b.bookingId).meet_url = OTHER_MEET_URL;
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.meetLinkChanged, error_type: 'invite' }]);
      expect(w.writes()).toHaveLength(1);
      expect(row(w, b.bookingId)).toMatchObject({ status: 'pending', calendar_state: 'invited', meet_url: OTHER_MEET_URL });
      expect(w.h.db.jobs()).toEqual([]);
    });

    it('space mode: the event carries no Meet link of its own, so nothing is compared', async () => {
      const { w, b } = await setup({}, { meetMode: 'space' });
      row(w, b.bookingId).meet_url = OTHER_MEET_URL;
      expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
      expect(errorLines(w)).toEqual([]);
      expect(w.writes()).toHaveLength(1);
    });
  });

  describe('what is never invited', () => {
    it('an Ashby-source booking: ignored after the one booking read (zero other reads, zero calls)', async () => {
      world = createR1MeetCalendarWorld();
      const w = world;
      const id = w.seedAshbyBooking();
      w.h.db.calls.length = 0;
      expect(await w.run('invite', id)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'ashby_booking' }));
      expect(w.h.db.calls).toEqual([{ kind: 'from', name: 'r1_meet_bookings' }]);
      expect(w.requests).toEqual([]);
      expect(w.ashby.calls).toEqual([]);
    });

    it('a booking that is gone, not live, dispatched, or whose event is cancelled or purged', async () => {
      world = createR1MeetCalendarWorld();
      const w = world;
      expect(await w.run('invite', '7f000000-0000-4000-8000-00000000ffff')).toEqual(expect.objectContaining({ code: 'booking_gone' }));
      const cases: Array<[SeedPublicOptions, string]> = [
        [{ status: 'bot_joining' }, 'booking_not_live'],
        [{ status: 'cancelled', reason: 'candidate_cancelled' }, 'booking_not_live'],
        [{ status: 'failed', reason: 'no_show' }, 'booking_not_live'],
        [{ calendarState: 'cancelled' }, 'calendar_cancelled'],
        [{ calendarState: 'purged' }, 'calendar_purged'],
      ];
      for (const [seed, code] of cases) {
        const b = await w.seed({ ...seed, ...(seed.status === 'bot_joining' ? { recallBotId: '7f000000-0000-4000-8000-00000000fffe' } : {}) });
        expect(await w.run('invite', b.bookingId), code).toEqual(expect.objectContaining({ receipt: 'ignored', code }));
      }
      expect(w.requests).toEqual([]);
      expect(w.ashby.calls).toEqual([]);
    });

    it('invites a blocked or bot_scheduled booking (live and not dispatched)', async () => {
      world = createR1MeetCalendarWorld();
      const w = world;
      for (const status of ['blocked', 'bot_scheduled']) {
        const b = await w.seed({ status });
        expect(await w.run('invite', b.bookingId), status).toEqual(expect.objectContaining({ code: 'invited' }));
      }
    });
  });

  it('unwired: throws r1_meet_calendar_unwired before anything is read', async () => {
    const { w, b } = await setup();
    const unwired: R1MeetFlowDeps = { ...w.deps, calendar: undefined };
    w.h.db.calls.length = 0;
    const error = await thrownBy(
      runR1MeetCalendarSync(unwired, { kind: 'calendar_sync', op: 'invite', bookingId: b.bookingId }, w.h.meta()),
    );
    expect(error.code).toBe(R1_MEET_CALENDAR_UNWIRED);
    expect(w.h.db.calls).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it('PII and token canaries: neither the email nor the token reaches a log line, a job, a stored row or an error', async () => {
    world = createR1MeetCalendarWorld();
    const w = world;
    const errors: string[] = [];
    const sent = await w.seed();
    await w.run('invite', sent.bookingId);
    const fallback = await w.seed({ startAt: new Date(w.h.now() + 20 * MINUTE).toISOString() });
    w.ashby.failAll('http_server_error');
    await w.run('invite', fallback.bookingId);
    w.ashby.failAll(null);
    const undeliverable = await w.seed({ status: 'bot_scheduled', ashbyEmail: null, localEmail: null });
    await w.run('invite', undeliverable.bookingId);
    const revoked = await w.seed();
    w.fake.revokeRefreshToken();
    w.fake.expireAccessTokens();
    await w.run('invite', revoked.bookingId);
    errors.push((await thrownBy(w.run('invite', revoked.bookingId, w.h.meta({ deferCount: 30 })))).message);

    const tokens = w.writes().map((request) => tokenOf(request));
    expect(tokens).toHaveLength(2);
    const digests = tokens.map((token) => r1MeetManageTokenDigest(token, BRIDGE_SOURCE)!);
    const logs = JSON.stringify(w.h.logs);
    const jobs = JSON.stringify(w.h.db.jobs());
    const stored = JSON.stringify(w.h.db.tables);
    for (const secret of [...tokens, ASHBY_EMAIL]) {
      expect(logs).not.toContain(secret);
      expect(jobs).not.toContain(secret);
      expect(stored).not.toContain(secret);
      for (const message of errors) expect(message).not.toContain(secret);
    }
    // The local address is in its own `candidates` row only: never in a log, a job or an error.
    expect(logs).not.toContain(LOCAL_EMAIL);
    expect(jobs).not.toContain(LOCAL_EMAIL);
    expect(logs).not.toContain('@');
    // No digest, no booking or event id, no Meet link in a log line either.
    for (const value of [...digests, sent.bookingId, sent.eventId, sent.meetUrl, 'meet.google.com']) {
      expect(logs).not.toContain(value);
    }
    // Every log value is a closed word, a Google operation or a status number.
    for (const line of w.h.logs) {
      expect(line.meta.error_category).toMatch(/^[a-z0-9_]{1,64}$/);
      if (line.meta.error_type !== undefined) expect(line.meta.error_type).toMatch(/^[a-zA-Z0-9_:.-]{1,64}$/);
    }
    // Every job payload holds ids and closed words only.
    for (const job of w.h.db.jobs()) {
      for (const value of Object.values(job.payload as Record<string, unknown>)) expect(String(value)).toMatch(/^[a-z0-9_-]+$/);
    }
    expect(errors).toEqual(['r1_meet_calendar_google_auth_revoked']);
  });

  it('the definition: kind calendar_sync, the strict parser, the event id derivation', () => {
    expect(r1MeetCalendarSyncDefinition.kind).toBe('calendar_sync');
    expect(Object.isFrozen(r1MeetCalendarSyncDefinition)).toBe(true);
    const id = '7f000000-0000-4000-8000-00000000AbCd';
    expect(r1MeetCalendarSyncDefinition.parse({ kind: 'calendar_sync', op: 'invite', booking_id: id })).toEqual({
      kind: 'calendar_sync',
      op: 'invite',
      bookingId: id.toLowerCase(),
    });
    expect(r1MeetCalendarSyncDefinition.parse({ kind: 'calendar_sync', op: 'delete', booking_id: id })).toBeNull();
    expect(r1MeetCalendarEventId(id)).toBe('7f00000000004000800000000000abcd');
    expect(r1MeetCalendarEventId(id)).toMatch(/^[0-9a-f]{32}$/);
    expect(R1_MEET_CALENDAR_SYNC).toEqual({
      inviteDeadlineMs: 15 * MINUTE,
      ashbyFallbackMs: 30 * MINUTE,
      ashbyDeferSec: 120,
      googleDeferDefaultSec: 30,
      googleDeferMinSec: 5,
      googleDeferMaxSec: 300,
      setupDeferSec: 3600,
    });
    expect(Object.isFrozen(R1_MEET_CALENDAR_SYNC) && Object.isFrozen(ALERTS)).toBe(true);
    expect(ALERTS).toEqual({
      inviteUndeliverable: 'r1_meet_public_invite_undeliverable',
      calendarDrift: 'r1_meet_public_calendar_drift',
      meetLinkChanged: 'r1_meet_public_meet_link_changed',
      googleAuthFailed: 'r1_meet_public_google_auth_failed',
      setupError: 'r1_meet_public_setup_error',
      ashbyUnavailable: 'r1_meet_public_ashby_unavailable',
    });
  });
});

// ── T4: the move, the cancel and the purge ──────────────────────────────────

/** The terminal ends a test puts a booking in directly (each a pair the status/reason CHECK accepts). */
const END_REASON = { cancelled: 'candidate_cancelled', failed: 'no_show', drained: 'flag_off', completed: 'attempt_settled' } as const;
type EndStatus = keyof typeof END_REASON;

function endBooking(w: CalendarWorld, id: string, status: EndStatus): void {
  Object.assign(row(w, id), { status, reason: END_REASON[status] });
}

/** What S06's move RPC leaves on the row: the new slot (45 minutes) and one more move. */
function moveBooking(w: CalendarWorld, id: string, startMs: number): { startAt: string; endAt: string } {
  const startAt = new Date(startMs).toISOString();
  const endAt = new Date(startMs + 45 * MINUTE).toISOString();
  const booking = row(w, id);
  Object.assign(booking, { start_at: startAt, end_at: endAt, move_count: (booking.move_count as number) + 1 });
  return { startAt, endAt };
}

const deletes = (w: CalendarWorld) => w.writes().filter((request) => request.method === 'DELETE');
const sent = (w: CalendarWorld) => w.writes().filter((request) => request.method === 'PATCH');
const eventSlot = (w: CalendarWorld, b: SeededPublicBooking) => {
  const fields = w.fake.events.get(b.eventId)!.fields as { start: { dateTime: string }; end: { dateTime: string } };
  return { startAt: fields.start.dateTime, endAt: fields.end.dateTime };
};
const attendeesOf = (w: CalendarWorld, b: SeededPublicBooking) =>
  ((w.fake.events.get(b.eventId)!.fields.attendees as Array<{ email: string }> | undefined) ?? []).map((a) => a.email);

describe('move', () => {
  /** A booking that was invited (attendee, digest, `invited`), then moved by S06 one day later. */
  async function invitedThenMoved(seed: SeedPublicOptions = {}, options: Parameters<typeof createR1MeetCalendarWorld>[0] = {}) {
    const { w, b } = await setup(seed, options);
    expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
    const inviteToken = tokenOf(sent(w)[0]);
    const inviteDigest = row(w, b.bookingId).manage_token_digest as string;
    const slot = moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
    const mark = w.steps().length;
    return { w, b, inviteToken, inviteDigest, slot, mark };
  }

  it('rotates the manage token (digest first), sends the new slot and the description once, never the attendees', async () => {
    const { w, b, inviteToken, inviteDigest, slot, mark } = await invitedThenMoved();
    expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'moved' });
    expect(w.steps().slice(mark)).toEqual(['google:calendar.get', 'db:public_set_manage_digest', 'google:calendar.patch']);

    const moves = sent(w);
    expect(moves).toHaveLength(2);
    const move = moves[1]!;
    expect(move.path.endsWith(`/events/${b.eventId}`)).toBe(true);
    expect(move.query).toEqual({ conferenceDataVersion: '1', sendUpdates: 'all' });
    // No `attendees` key: Google replaces arrays wholesale, so the move never touches them.
    expect(Object.keys(move.body as object).sort()).toEqual(['description', 'end', 'start']);
    expect((move.body as { start: unknown }).start).toEqual({ dateTime: slot.startAt, timeZone: 'Asia/Kolkata' });
    expect((move.body as { end: unknown }).end).toEqual({ dateTime: slot.endAt, timeZone: 'Asia/Kolkata' });

    // A NEW token, and the stored digest is the new token's.
    const token = tokenOf(move);
    expect(token).toMatch(R1_MEET_MANAGE_TOKEN_PATTERN);
    expect(token).not.toBe(inviteToken);
    const digest = row(w, b.bookingId).manage_token_digest;
    expect(digest).toBe(r1MeetManageTokenDigest(token, BRIDGE_SOURCE));
    expect(digest).not.toBe(inviteDigest);
    expect((move.body as { description: string }).description).toContain(`${WEB_ORIGIN_FIXTURE}/book/manage#m=${token}`);

    // Google kept the attendee and has the new slot; the row is unchanged otherwise.
    expect(attendeesOf(w, b)).toEqual([ASHBY_EMAIL]);
    expect(eventSlot(w, b)).toEqual(slot);
    expect(row(w, b.bookingId)).toMatchObject({ status: 'pending', calendar_state: 'invited' });
    expect(w.ashby.calls).toHaveLength(1);
    expect(errorLines(w)).toEqual([]);
    expect(w.h.db.jobs()).toEqual([]);
  });

  it('is idempotent: a re-run reads the event and writes nothing (already_moved, the digest kept)', async () => {
    const { w, b } = await invitedThenMoved();
    await w.run('move', b.bookingId);
    const digest = row(w, b.bookingId).manage_token_digest;
    const mark = w.steps().length;
    expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'already_moved' });
    expect(w.steps().slice(mark)).toEqual(['google:calendar.get']);
    expect(sent(w)).toHaveLength(2);
    expect(row(w, b.bookingId).manage_token_digest).toBe(digest);
  });

  it('a stale move:1 job converges on the CURRENT slot, and the move:2 job then finds it done', async () => {
    const { w, b } = await invitedThenMoved();
    const latest = moveBooking(w, b.bookingId, Date.parse(b.startAt) + 48 * HOUR);
    expect(row(w, b.bookingId).move_count).toBe(2);
    const first = r1MeetJobs.calendarSync('move', b.bookingId, 1);
    const second = r1MeetJobs.calendarSync('move', b.bookingId, 2);
    expect(first.dedupKey).not.toBe(second.dedupKey);
    expect(first.payload).toEqual(second.payload);

    const job = r1MeetCalendarSyncDefinition.parse(first.payload)!;
    expect(await r1MeetCalendarSyncDefinition.run(w.deps, job, w.h.meta())).toEqual(expect.objectContaining({ code: 'moved' }));
    expect(eventSlot(w, b)).toEqual(latest);
    const later = r1MeetCalendarSyncDefinition.parse(second.payload)!;
    expect(await r1MeetCalendarSyncDefinition.run(w.deps, later, w.h.meta())).toEqual(expect.objectContaining({ code: 'already_moved' }));
    // One send for the two moves (plus the invite's).
    expect(sent(w)).toHaveLength(2);
  });

  it('a move before the invite: the slot and the description only, no attendee, the state stays created', async () => {
    const { w, b } = await setup();
    const slot = moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
    expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'moved' }));
    expect(w.steps()).toEqual(['google:calendar.get', 'db:public_set_manage_digest', 'google:calendar.patch']);
    expect(attendeesOf(w, b)).toEqual([]);
    expect(eventSlot(w, b)).toEqual(slot);
    expect(row(w, b.bookingId).calendar_state).toBe('created');
    expect(w.ashby.calls).toEqual([]);
  });

  describe('the state repair (an invite whose answer was lost)', () => {
    it('after the send: the event lists an attendee and the row says created -> invited', async () => {
      const { w, b } = await setup();
      w.fake.events.get(b.eventId)!.fields.attendees = [{ email: ASHBY_EMAIL }];
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'moved' }));
      expect(w.steps()).toEqual([
        'google:calendar.get',
        'db:public_set_manage_digest',
        'google:calendar.patch',
        'db:public_set_calendar_state',
      ]);
      expect(row(w, b.bookingId).calendar_state).toBe('invited');
      expect(attendeesOf(w, b)).toEqual([ASHBY_EMAIL]);
    });

    it('already moved: the state is repaired with no write to Google', async () => {
      const { w, b } = await setup();
      w.fake.events.get(b.eventId)!.fields.attendees = [{ email: ASHBY_EMAIL }];
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'processed', code: 'already_moved' }));
      expect(w.steps()).toEqual(['google:calendar.get', 'db:public_set_calendar_state']);
      expect(w.writes()).toEqual([]);
      expect(row(w, b.bookingId)).toMatchObject({ calendar_state: 'invited', manage_token_digest: null });
    });
  });

  describe('the Meet link check (D-S05-12)', () => {
    it('calendar mode: a different Meet link on the moved event alerts meet_link_changed (move) and changes nothing else', async () => {
      const { w, b } = await invitedThenMoved();
      row(w, b.bookingId).meet_url = OTHER_MEET_URL;
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'moved' }));
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.meetLinkChanged, error_type: 'move' }]);
      expect(row(w, b.bookingId)).toMatchObject({ status: 'pending', calendar_state: 'invited', meet_url: OTHER_MEET_URL });
      expect(w.h.db.jobs()).toEqual([]);
    });

    it('space mode: nothing is compared', async () => {
      const { w, b } = await invitedThenMoved({}, { meetMode: 'space' });
      row(w, b.bookingId).meet_url = OTHER_MEET_URL;
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'moved' }));
      expect(errorLines(w)).toEqual([]);
    });
  });

  describe('the event is gone (D-S05-5)', () => {
    it('an undispatched booking: failed/invite_undeliverable, the alert, the trigger jobs, no send', async () => {
      const { w, b } = await setup({ event: false });
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'event_gone' });
      expect(row(w, b.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.inviteUndeliverable, error_type: 'event_gone' }]);
      expect(w.h.db.jobs('calendar_sync').map((job) => job.payload)).toEqual([{ kind: 'calendar_sync', op: 'cancel', booking_id: b.bookingId }]);
      expect(w.writes()).toEqual([]);
    });

    it('cancelled on Lexy\'s calendar counts as gone', async () => {
      const { w, b } = await setup();
      w.interceptGoogle('calendar.get', { status: 200, body: { id: b.eventId, status: 'cancelled' } });
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'event_gone' }));
      expect(row(w, b.bookingId).status).toBe('failed');
    });

    it.each([404, 410])('the send answers %i', async (status) => {
      const { w, b } = await setup();
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      w.interceptGoogle('calendar.patch', { status, body: { error: { code: status, message: 'gone' } } });
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'event_gone' }));
      expect(row(w, b.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
      expect(sent(w)).toHaveLength(1);
    });

    it('a dispatched booking is never cut: done, the booking untouched, no alert', async () => {
      const { w, b } = await setup({ status: 'bot_joining', recallBotId: '7f000000-0000-4000-8000-00000000fffd', event: false });
      expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'event_gone' });
      expect(row(w, b.bookingId)).toMatchObject({ status: 'bot_joining', reason: 'eligible' });
      expect(errorLines(w)).toEqual([]);
      expect(w.h.db.jobs()).toEqual([]);
    });
  });

  describe('what is never moved (zero Google calls)', () => {
    it.each(['cancelled', 'failed', 'drained', 'completed'] as const)('a %s booking: booking_terminal', async (status) => {
      const { w, b } = await setup();
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      endBooking(w, b.bookingId, status);
      expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'booking_terminal' });
      expect(w.requests).toEqual([]);
    });

    it('a live booking whose slot is over: slot_over (and one millisecond earlier it is moved)', async () => {
      const { w, b } = await setup();
      w.fake.events.get(b.eventId)!.fields.start = { dateTime: new Date(Date.parse(b.startAt) - HOUR).toISOString() };
      w.h.setNow(b.endAt);
      expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'slot_over' });
      expect(w.requests).toEqual([]);
      w.h.setNow(Date.parse(b.endAt) - 1);
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'moved' }));
    });

    it('an event that is cancelled or purged, a gone booking and an Ashby booking (one read)', async () => {
      world = createR1MeetCalendarWorld();
      const w = world;
      for (const state of ['cancelled', 'purged'] as const) {
        const b = await w.seed({ calendarState: state });
        expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'ignored', code: `calendar_${state}` }));
      }
      expect(await w.run('move', '7f000000-0000-4000-8000-00000000ffff')).toEqual(expect.objectContaining({ code: 'booking_gone' }));
      const ashby = w.seedAshbyBooking();
      w.h.db.calls.length = 0;
      expect(await w.run('move', ashby)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'ashby_booking' }));
      expect(w.h.db.calls).toEqual([{ kind: 'from', name: 'r1_meet_bookings' }]);
      expect(w.requests).toEqual([]);
    });
  });

  describe('failures', () => {
    it('the event read: a 503 defers google_unavailable, nothing stored, nothing sent', async () => {
      const { w, b } = await setup();
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      w.interceptGoogle('calendar.get', { status: 503 });
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ outcome: 'defer', code: 'google_unavailable' }));
      expect(row(w, b.bookingId).manage_token_digest).toBeNull();
      expect(w.writes()).toEqual([]);
    });

    it('a failed send defers after the digest was stored; the next run sends a NEW token and converges', async () => {
      const { w, b } = await setup();
      const slot = moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      w.interceptGoogle('calendar.patch', { status: 429 });
      expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_quota', delaySeconds: 30 });
      const first = row(w, b.bookingId).manage_token_digest;
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ code: 'moved' }));
      const moves = sent(w);
      expect(moves).toHaveLength(2);
      expect(tokenOf(moves[0])).not.toBe(tokenOf(moves[1]));
      expect(row(w, b.bookingId).manage_token_digest).toBe(r1MeetManageTokenDigest(tokenOf(moves[1]), BRIDGE_SOURCE));
      expect(eventSlot(w, b)).toEqual(slot);
    });

    it('auth_revoked: one alert naming the event read, an hour\'s wait, one token request', async () => {
      const { w, b } = await setup();
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      w.fake.revokeRefreshToken();
      w.fake.expireAccessTokens();
      expect(await w.run('move', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_auth_revoked', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([expect.objectContaining({ error_category: ALERTS.googleAuthFailed, error_type: 'calendar.get' })]);
      expect(w.tokenCalls()).toHaveLength(1);
      expect(w.writes()).toEqual([]);
    });

    it('no Google settings: google_unconfigured; no manage key: manage_key_missing, nothing stored or sent', async () => {
      const unconfigured = await setup();
      moveBooking(unconfigured.w, unconfigured.b.bookingId, Date.parse(unconfigured.b.startAt) + 24 * HOUR);
      unconfigured.w.switches.google = false;
      expect(await unconfigured.w.run('move', unconfigured.b.bookingId)).toEqual({
        outcome: 'defer',
        code: 'google_unconfigured',
        delaySeconds: 3600,
      });
      expect(unconfigured.w.requests).toEqual([]);

      const keyless = await setup({}, { harness: { ticketSource: {} as NodeJS.ProcessEnv } });
      moveBooking(keyless.w, keyless.b.bookingId, Date.parse(keyless.b.startAt) + 24 * HOUR);
      expect(await keyless.w.run('move', keyless.b.bookingId)).toEqual({ outcome: 'defer', code: 'manage_key_missing', delaySeconds: 3600 });
      expect(errorLines(keyless.w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'manage_key_missing' }]);
      expect(keyless.w.writes()).toEqual([]);
      expect(row(keyless.w, keyless.b.bookingId).manage_token_digest).toBeNull();
    });

    it('set_manage_digest answers booking_terminal (ended meanwhile): ignored, no send', async () => {
      const { w, b } = await setup();
      moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
      w.afterGoogle = (call) => {
        if (call === 'calendar.get') endBooking(w, b.bookingId, 'cancelled');
      };
      expect(await w.run('move', b.bookingId)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'booking_terminal' }));
      expect(w.writes()).toEqual([]);
    });
  });
});

describe('cancel', () => {
  /** A public booking that ended before its slot; `invited` runs the invite first (an attendee on Google). */
  async function ended(state: 'created' | 'invited', status: EndStatus = 'cancelled', seed: SeedPublicOptions = {}) {
    const { w, b } = await setup(seed);
    if (state === 'invited') expect(await w.run('invite', b.bookingId)).toEqual(expect.objectContaining({ code: 'invited' }));
    endBooking(w, b.bookingId, status);
    const mark = w.steps().length;
    const requests = w.requests.length;
    return { w, b, mark, requests };
  }

  it.each(['created', 'invited'] as const)('%s, before the slot: ONE delete with sendUpdates=all, then cancelled', async (state) => {
    const { w, b, mark } = await ended(state);
    expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'cancelled' });
    expect(w.steps().slice(mark)).toEqual(['google:calendar.delete', 'db:public_set_calendar_state']);
    const [drop, ...rest] = deletes(w);
    expect(rest).toEqual([]);
    expect(drop!.path.endsWith(`/events/${b.eventId}`)).toBe(true);
    expect(drop!.query).toEqual({ sendUpdates: 'all' });
    expect(drop!.body).toBeNull();
    expect(w.fake.events.get(b.eventId)!.deleted).toBe(true);
    expect(row(w, b.bookingId)).toMatchObject({ status: 'cancelled', calendar_state: 'cancelled' });
    expect(errorLines(w)).toEqual([]);
  });

  it.each(['failed', 'drained'] as const)('a %s booking owes the cancel too', async (status) => {
    const { w, b } = await ended('created', status);
    expect(await w.run('cancel', b.bookingId)).toEqual(expect.objectContaining({ code: 'cancelled' }));
    expect(deletes(w)).toHaveLength(1);
  });

  it('a re-run is ignored (not_owed) with zero calls', async () => {
    const { w, b } = await ended('invited');
    await w.run('cancel', b.bookingId);
    const requests = w.requests.length;
    expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'not_owed' });
    expect(w.requests).toHaveLength(requests);
    expect(deletes(w)).toHaveLength(1);
  });

  it('from the slot start: after_start, zero calls, the state unchanged (one millisecond earlier: cancelled)', async () => {
    const { w, b, requests } = await ended('invited');
    w.h.setNow(b.startAt);
    expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'after_start' });
    expect(w.requests).toHaveLength(requests);
    expect(row(w, b.bookingId).calendar_state).toBe('invited');
    w.h.setNow(Date.parse(b.startAt) - 1);
    expect(await w.run('cancel', b.bookingId)).toEqual(expect.objectContaining({ code: 'cancelled' }));
  });

  it('a LIVE booking\'s event is never deleted (booking_live, zero calls)', async () => {
    world = createR1MeetCalendarWorld();
    const w = world;
    const live: SeedPublicOptions[] = [
      { status: 'pending' },
      { status: 'blocked' },
      { status: 'bot_scheduled' },
      { status: 'bot_joining', recallBotId: '7f000000-0000-4000-8000-00000000fff1' },
      { status: 'human_present', recallBotId: '7f000000-0000-4000-8000-00000000fff2' },
      { status: 'in_call', recallBotId: '7f000000-0000-4000-8000-00000000fff3' },
    ];
    for (const seed of live) {
      const b = await w.seed(seed);
      expect(await w.run('cancel', b.bookingId), seed.status).toEqual({ outcome: 'done', receipt: 'ignored', code: 'booking_live' });
    }
    expect(w.requests).toEqual([]);
  });

  it.each([
    ['never on Google (404)', { event: false }],
    ['deleted on Lexy\'s calendar (410)', {}],
  ] as const)('%s: done, cancelled_gone', async (label, seed) => {
    const { w, b } = await ended('created', 'cancelled', seed);
    if (label.includes('410')) w.fake.events.get(b.eventId)!.deleted = true;
    expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'cancelled_gone' });
    expect(deletes(w)).toHaveLength(1);
    expect(row(w, b.bookingId).calendar_state).toBe('cancelled');
  });

  it('an Ashby booking (not_public) and a gone booking (booking_gone): ignored, one read, zero calls', async () => {
    world = createR1MeetCalendarWorld();
    const w = world;
    const ashby = w.seedAshbyBooking();
    Object.assign(row(w, ashby), { status: 'cancelled', reason: 'cancelled' });
    w.h.db.calls.length = 0;
    expect(await w.run('cancel', ashby)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'not_public' });
    expect(w.h.db.calls).toEqual([{ kind: 'from', name: 'r1_meet_bookings' }]);
    expect(await w.run('cancel', '7f000000-0000-4000-8000-00000000ffff')).toEqual(expect.objectContaining({ code: 'booking_gone' }));
    expect(w.requests).toEqual([]);
  });

  it('the state moved meanwhile (state_conflict): ignored after the one delete', async () => {
    const { w, b } = await ended('invited');
    w.afterGoogle = (call) => {
      if (call === 'calendar.delete') row(w, b.bookingId).calendar_state = 'purged';
    };
    expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'state_conflict' });
    expect(deletes(w)).toHaveLength(1);
  });

  describe('Google failures (as the invite)', () => {
    it.each([
      ['a 503', { status: 503, body: { error: { code: 503 } } }, 'google_unavailable', 10],
      ['a 429', { status: 429 }, 'google_quota', 30],
      ['a 429 with Retry-After 900 (clamped to 300)', { status: 429, headers: { 'Retry-After': '900' } }, 'google_quota', 300],
      ['a network failure', 'network', 'google_unavailable', 5],
    ] as const)('%s defers %s for %i s, the state kept', async (_label, response, code, seconds) => {
      const { w, b } = await ended('invited');
      w.interceptGoogle('calendar.delete', response);
      expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'defer', code, delaySeconds: seconds });
      expect(row(w, b.bookingId).calendar_state).toBe('invited');
      expect(errorLines(w)).toEqual([]);
    });

    it('past the deferral bound the closed code is thrown', async () => {
      const { w, b } = await ended('created');
      w.interceptGoogle('calendar.delete', { status: 503 });
      expect((await thrownBy(w.run('cancel', b.bookingId, w.h.meta({ deferCount: 30 })))).code).toBe('r1_meet_calendar_google_unavailable');
    });

    it('auth_revoked: one alert naming the delete, an hour\'s wait, one token request, never a loop', async () => {
      const { w, b } = await ended('created');
      w.fake.revokeRefreshToken();
      w.fake.expireAccessTokens();
      expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_auth_revoked', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([expect.objectContaining({ error_category: ALERTS.googleAuthFailed, error_type: 'calendar.delete' })]);
      // The cached token is tried once (401), the re-mint is refused: one delete attempt, one token request.
      expect(w.tokenCalls()).toHaveLength(1);
      expect(w.apiCalls()).toHaveLength(1);
      const late = await thrownBy(
        w.run('cancel', b.bookingId, w.h.meta({ deferCount: 1, deferredAt: new Date(w.h.now() - HOUR).toISOString() })),
      );
      expect(late.code).toBe('r1_meet_calendar_google_auth_revoked');
      // Inside the token source's refusal window: no request at all.
      expect(w.tokenCalls()).toHaveLength(1);
      expect(w.apiCalls()).toHaveLength(1);
      expect(row(w, b.bookingId).calendar_state).toBe('created');
    });

    it('setup_forbidden: the setup alert and an hour\'s wait', async () => {
      const { w, b } = await ended('created');
      w.interceptGoogle('calendar.delete', { status: 403, body: { error: { code: 403, message: 'Forbidden', errors: [{ domain: 'global', reason: 'forbidden' }] } } });
      expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_setup', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'google_setup_forbidden', http_status: 403 }]);
    });

    it('no Google settings: only an owed delete waits (google_unconfigured); a cancel that owes nothing ends ignored', async () => {
      const { w, b } = await ended('created');
      w.switches.google = false;
      expect(await w.run('cancel', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_unconfigured', delaySeconds: 3600 });
      expect(errorLines(w)).toEqual([{ error_category: ALERTS.setupError, error_type: 'google_unconfigured' }]);
      const live = await w.seed();
      expect(await w.run('cancel', live.bookingId)).toEqual(expect.objectContaining({ receipt: 'ignored', code: 'booking_live' }));
      expect(errorLines(w)).toHaveLength(1);
      expect(w.requests).toEqual([]);
    });

    it('a database failure is the closed database code', async () => {
      const { w, b } = await ended('created');
      w.h.db.failNext('r1_meet_public_set_calendar_state');
      expect((await thrownBy(w.run('cancel', b.bookingId))).code).toBe('r1_meet_db_error');
    });
  });

  describe('cancelR1MeetPublicCalendarEvent (the drain shares it)', () => {
    const settings = (w: CalendarWorld): R1MeetCalendarGoogle => ({ calendar: w.google.calendar, meetMode: w.meetMode });

    it('answers the outcome words and makes the one delete', async () => {
      const { w, b } = await ended('invited');
      expect(await cancelR1MeetPublicCalendarEvent(w.calendar, settings(w), b.bookingId, w.h.now())).toBe('cancelled');
      expect(await cancelR1MeetPublicCalendarEvent(w.calendar, settings(w), b.bookingId, w.h.now())).toBe('not_owed');
      const live = await w.seed();
      expect(await cancelR1MeetPublicCalendarEvent(w.calendar, settings(w), live.bookingId, w.h.now())).toBe('booking_live');
      const late = await w.seed();
      endBooking(w, late.bookingId, 'failed');
      expect(await cancelR1MeetPublicCalendarEvent(w.calendar, settings(w), late.bookingId, Date.parse(late.startAt))).toBe('after_start');
      expect(deletes(w)).toHaveLength(1);
    });

    it('throws the GoogleError of a failed delete (no alert: the caller decides) and leaves the state', async () => {
      const { w, b } = await ended('created');
      w.interceptGoogle('calendar.delete', { status: 503 });
      const error = await cancelR1MeetPublicCalendarEvent(w.calendar, settings(w), b.bookingId, w.h.now()).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(isGoogleError(error)).toBe(true);
      expect((error as Error).message).toBe('google_unavailable');
      expect(errorLines(w)).toEqual([]);
      expect(row(w, b.bookingId).calendar_state).toBe('created');
    });
  });
});

describe('purge', () => {
  const RETENTION = 31 * 24 * HOUR;

  it('a past booking: ONE delete with sendUpdates=none, then purged', async () => {
    const { w, b } = await setup();
    await w.run('invite', b.bookingId);
    endBooking(w, b.bookingId, 'completed');
    w.h.setNow(Date.parse(b.endAt) + RETENTION);
    const mark = w.steps().length;
    expect(await w.run('purge', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'purged' });
    expect(w.steps().slice(mark)).toEqual(['google:calendar.delete', 'db:public_set_calendar_state']);
    expect(deletes(w).map((request) => [request.path.endsWith(`/events/${b.eventId}`), request.query])).toEqual([[true, { sendUpdates: 'none' }]]);
    expect(row(w, b.bookingId).calendar_state).toBe('purged');
    expect(w.fake.events.get(b.eventId)!.deleted).toBe(true);
  });

  it('a terminal booking whose slot is still ahead: the candidate is told (all)', async () => {
    const { w, b } = await setup();
    endBooking(w, b.bookingId, 'cancelled');
    expect(await w.run('purge', b.bookingId)).toEqual(expect.objectContaining({ code: 'purged' }));
    expect(deletes(w).map((request) => request.query)).toEqual([{ sendUpdates: 'all' }]);
  });

  it('the row is gone (a delete, the 0143 trigger): ONE delete with none on the derived id, no database write', async () => {
    const { w, b } = await setup();
    await w.run('invite', b.bookingId);
    w.h.db.deleteBooking(b.bookingId);
    expect(w.h.db.jobs('calendar_sync').map((job) => [job.payload, job.dedup_key, job.max_attempts])).toEqual([
      [{ kind: 'calendar_sync', op: 'purge', booking_id: b.bookingId }, `r1-meet:calendar:${b.bookingId}:purge`, 10],
    ]);
    w.h.db.calls.length = 0;
    expect(await w.run('purge', b.bookingId)).toEqual({ outcome: 'done', receipt: 'processed', code: 'purged_no_row' });
    expect(w.h.db.calls).toEqual([{ kind: 'from', name: 'r1_meet_bookings' }]);
    const [drop, ...rest] = deletes(w);
    expect(rest).toEqual([]);
    expect(drop!.path.endsWith(`/events/${r1MeetCalendarEventId(b.bookingId)}`)).toBe(true);
    expect(drop!.query).toEqual({ sendUpdates: 'none' });
    // A re-run has no row to remember it: one more delete, answered 410, still done.
    expect(await w.run('purge', b.bookingId)).toEqual(expect.objectContaining({ code: 'purged_no_row' }));
    expect(deletes(w)).toHaveLength(2);
  });

  it('a re-run with the row present is ignored (already_purged) with zero calls', async () => {
    const { w, b } = await setup();
    endBooking(w, b.bookingId, 'failed');
    await w.run('purge', b.bookingId);
    const requests = w.requests.length;
    expect(await w.run('purge', b.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'already_purged' });
    expect(w.requests).toHaveLength(requests);
  });

  it('a live booking and an Ashby booking are ignored with zero calls', async () => {
    world = createR1MeetCalendarWorld();
    const w = world;
    const live = await w.seed({ status: 'bot_scheduled' });
    expect(await w.run('purge', live.bookingId)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'booking_live' });
    const ashby = w.seedAshbyBooking();
    Object.assign(row(w, ashby), { status: 'cancelled', reason: 'cancelled' });
    expect(await w.run('purge', ashby)).toEqual({ outcome: 'done', receipt: 'ignored', code: 'ashby_booking' });
    expect(w.requests).toEqual([]);
  });

  it('410 is done; a cancelled event (already deleted) is purged too', async () => {
    const { w, b } = await setup();
    endBooking(w, b.bookingId, 'drained');
    w.fake.events.get(b.eventId)!.deleted = true;
    w.h.setNow(Date.parse(b.endAt) + RETENTION);
    expect(await w.run('purge', b.bookingId)).toEqual(expect.objectContaining({ code: 'purged' }));

    w.h.setNow(HARNESS_NOW);
    const cancelled = await w.seed();
    endBooking(w, cancelled.bookingId, 'cancelled');
    expect(await w.run('cancel', cancelled.bookingId)).toEqual(expect.objectContaining({ code: 'cancelled' }));
    expect(await w.run('purge', cancelled.bookingId)).toEqual(expect.objectContaining({ code: 'purged' }));
    expect(row(w, cancelled.bookingId).calendar_state).toBe('purged');
  });

  it('Google failures defer as the invite; no Google settings: google_unconfigured', async () => {
    const { w, b } = await setup();
    endBooking(w, b.bookingId, 'completed');
    w.interceptGoogle('calendar.delete', { status: 503 });
    expect(await w.run('purge', b.bookingId)).toEqual(expect.objectContaining({ outcome: 'defer', code: 'google_unavailable' }));
    expect(row(w, b.bookingId).calendar_state).toBe('created');
    w.switches.google = false;
    expect(await w.run('purge', b.bookingId)).toEqual({ outcome: 'defer', code: 'google_unconfigured', delaySeconds: 3600 });
  });
});

describe('end to end (the dispatcher, the real registry, the 0143 triggers)', () => {
  function queueJob(payload: unknown): QueueJob<unknown> {
    return {
      id: 'job-1',
      name: R1_MEET_QUEUE,
      payload,
      status: 'active',
      attempts: 1,
      maxAttempts: 10,
      priority: 0,
      scheduledAt: HARNESS_NOW,
      createdAt: HARNESS_NOW,
      deferCount: 0,
    };
  }

  /** Runs the one pending job of `kind` (and marks it completed, as the queue would). */
  async function dispatchOne(w: CalendarWorld, kind: string) {
    const dispatcher = createR1MeetDispatcher({ flowDeps: () => w.deps, active: () => true });
    const pending = w.h.db.jobs(kind).filter((job) => job.status === 'pending');
    expect(pending, kind).toHaveLength(1);
    const job = pending[0]!;
    const result = await dispatcher.handle(queueJob(job.payload));
    job.status = 'completed';
    return { result, payload: job.payload as Record<string, unknown> };
  }

  const jobLines = (w: CalendarWorld) =>
    w.h.logs.filter((line) => line.meta.error_category === 'r1_meet_job').map((line) => line.meta.error_type);

  function expectIdsOnly(w: CalendarWorld): void {
    for (const job of w.h.db.jobs()) {
      for (const value of Object.values(job.payload as Record<string, unknown>)) expect(String(value)).toMatch(/^[a-z0-9_-]+$/);
    }
  }

  it('HR cancels the round: round_cancelled -> cancelFlow -> the 0143 trigger -> calendar_sync cancel -> ONE delete (all)', async () => {
    const { w, b } = await setup();
    await w.deps.enqueue(r1MeetJobs.calendarSync('invite', b.bookingId));
    expect((await dispatchOne(w, 'calendar_sync')).result).toBeUndefined();
    expect(row(w, b.bookingId).calendar_state).toBe('invited');

    w.h.db.cancelRound(b.roundId);
    expect((await dispatchOne(w, 'round_cancelled')).result).toBeUndefined();
    expect(row(w, b.bookingId)).toMatchObject({ status: 'cancelled', reason: 'round_cancelled' });
    // The terminal trigger queued the calendar cancel (and the tag removal S11 handles).
    expect(w.h.db.jobs('ashby_booked_tag').map((job) => job.payload)).toEqual([{ kind: 'ashby_booked_tag', op: 'remove', booking_id: b.bookingId }]);

    const cancel = await dispatchOne(w, 'calendar_sync');
    expect(cancel.payload).toEqual({ kind: 'calendar_sync', op: 'cancel', booking_id: b.bookingId });
    expect(cancel.result).toBeUndefined();
    expect(deletes(w).map((request) => request.query)).toEqual([{ sendUpdates: 'all' }]);
    expect(row(w, b.bookingId).calendar_state).toBe('cancelled');
    expect(w.fake.events.get(b.eventId)!.deleted).toBe(true);

    // The same job again (a redelivery): no second call.
    const dispatcher = createR1MeetDispatcher({ flowDeps: () => w.deps, active: () => true });
    await dispatcher.handle(queueJob(cancel.payload));
    expect(deletes(w)).toHaveLength(1);
    expect(jobLines(w)).toEqual(['calendar_sync:invited', 'round_cancelled:cancelled', 'calendar_sync:cancelled', 'calendar_sync:not_owed']);
    expectIdsOnly(w);
  });

  it('a delete of the row (DSAR): the 0143 trigger -> calendar_sync purge -> ONE delete (none)', async () => {
    const { w, b } = await setup();
    await w.deps.enqueue(r1MeetJobs.calendarSync('invite', b.bookingId));
    await dispatchOne(w, 'calendar_sync');
    w.h.db.deleteBooking(b.bookingId);
    const purge = await dispatchOne(w, 'calendar_sync');
    expect(purge.payload).toEqual({ kind: 'calendar_sync', op: 'purge', booking_id: b.bookingId });
    expect(purge.result).toBeUndefined();
    expect(deletes(w).map((request) => [request.path.endsWith(`/events/${b.eventId}`), request.query])).toEqual([[true, { sendUpdates: 'none' }]]);
    expect(jobLines(w)).toEqual(['calendar_sync:invited', 'calendar_sync:purged_no_row']);
    expectIdsOnly(w);
  });

  it('a Google outage defers the cancel through the dispatcher (a directive, nothing written)', async () => {
    const { w, b } = await setup();
    endBooking(w, b.bookingId, 'cancelled');
    await w.deps.enqueue(r1MeetJobs.calendarSync('cancel', b.bookingId));
    w.interceptGoogle('calendar.delete', { status: 503 });
    const { result } = await dispatchOne(w, 'calendar_sync');
    expect(result).toEqual(expect.objectContaining({ outcome: 'defer', reasonCode: 'google_unavailable' }));
    expect(row(w, b.bookingId).calendar_state).toBe('created');
  });
});

it('T4 PII and token canaries: no token or email in a log, a job, a row or an error across move, cancel and purge', async () => {
  world = createR1MeetCalendarWorld();
  const w = world;
  const errors: string[] = [];
  const b = await w.seed();
  await w.run('invite', b.bookingId);
  moveBooking(w, b.bookingId, Date.parse(b.startAt) + 24 * HOUR);
  await w.run('move', b.bookingId);
  w.interceptGoogle('calendar.patch', { status: 400, body: { error: { code: 400 } } });
  moveBooking(w, b.bookingId, Date.parse(b.startAt) + 48 * HOUR);
  errors.push((await thrownBy(w.run('move', b.bookingId))).message);
  endBooking(w, b.bookingId, 'cancelled');
  await w.run('cancel', b.bookingId);
  w.h.db.deleteBooking(b.bookingId);
  await w.run('purge', b.bookingId);

  const tokens = sent(w).map((request) => tokenOf(request));
  expect(tokens).toHaveLength(3);
  const logs = JSON.stringify(w.h.logs);
  const jobs = JSON.stringify(w.h.db.jobs());
  const stored = JSON.stringify(w.h.db.tables);
  for (const secret of [...tokens, ASHBY_EMAIL, LOCAL_EMAIL]) {
    expect(logs).not.toContain(secret);
    expect(jobs).not.toContain(secret);
    for (const message of errors) expect(message).not.toContain(secret);
  }
  for (const token of tokens) expect(stored).not.toContain(token);
  for (const value of [b.bookingId, b.eventId, b.meetUrl, '@']) expect(logs).not.toContain(value);
  for (const line of w.h.logs) {
    expect(line.meta.error_category).toMatch(/^[a-z0-9_]{1,64}$/);
    if (line.meta.error_type !== undefined) expect(line.meta.error_type).toMatch(/^[a-zA-Z0-9_:.-]{1,64}$/);
  }
  expect(errors).toEqual(['r1_meet_calendar_google_invalid_request']);
});
