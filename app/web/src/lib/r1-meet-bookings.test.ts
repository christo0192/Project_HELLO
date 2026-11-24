/**
 * The Meet bookings client (M034 S10): what it sends, what it accepts, and every word it says. The
 * words are written out here by hand from S10-PLAN 2.1 and 2.2, so a change to one is a decision and
 * not a typo. The last block compares the vocabularies with the API document across the package
 * boundary, which `tsc` cannot see.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { addIstDays, formatIstDayLabel, isIstDate } from './ist-datetime';
import {
  MEET_FILTER_FIRST_DATE,
  MEET_FILTER_LAST_DATE,
  R1_MEET_BOOKINGS_PATH,
  R1_MEET_BOOKING_REASONS,
  R1_MEET_BOOKING_STATUSES,
  R1_MEET_STATUS_OPTIONS,
  isMeetFilterDate,
  meetBookingReasonText,
  meetBookingSlot,
  meetBookingStamp,
  meetBookingTerm,
  meetBookingsQuery,
  meetDateError,
  meetFiltersAreDefault,
  meetFiltersFrom,
  mergeMeetBookings,
  r1MeetBookingsPath,
  readR1MeetBookings,
} from './r1-meet-bookings';
import type { R1MeetBooking, R1MeetBookingReason, R1MeetBookingStatus } from './r1-meet-bookings';

const TODAY = '2026-11-24';

function booking(over: Partial<R1MeetBooking> = {}): R1MeetBooking {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    candidate_id: '22222222-2222-4222-8222-222222222222',
    round_id: '33333333-3333-4333-8333-333333333333',
    status: 'bot_scheduled',
    reason: 'eligible',
    start_at: '2026-11-24T09:00:00.000Z',
    end_at: '2026-11-24T09:30:00.000Z',
    created_at: '2026-11-20T05:00:00.000Z',
    updated_at: '2026-11-21T06:15:00.000Z',
    version: 1,
    ...over,
  };
}

const other = (last: string, over: Partial<R1MeetBooking> = {}): R1MeetBooking =>
  booking({ id: `44444444-4444-4444-8444-44444444444${last}`, ...over });

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  meet_enabled: true,
  bookings: [booking()],
  next_cursor: null,
  ...over,
});

/* ── The words ────────────────────────────────────────────────────── */

const STATUS_WORDS: Record<R1MeetBookingStatus, readonly [label: string, tone: string]> = {
  pending: ['Booked', 'moving'],
  unmatched_application: ['No matching candidate', 'unresolved'],
  unmapped_scheduler: ['Scheduler not matched', 'unresolved'],
  blocked: ['Blocked', 'unresolved'],
  bot_scheduled: ['Dex scheduled', 'moving'],
  bot_joining: ['Dex joining', 'moving'],
  human_present: ['Someone has joined', 'moving'],
  in_call: ['Interview in progress', 'moving'],
  completed: ['Completed', 'ready'],
  cancelled: ['Cancelled', 'closed'],
  failed: ['Not completed', 'unresolved'],
  drained: ['Stopped', 'closed'],
};

const REASON_WORDS: Record<R1MeetBookingReason, string | null> = {
  eligible: null,
  dex_absent: 'Dex is no longer an interviewer in Ashby.',
  cancelled: 'Cancelled in Ashby.',
  in_past: 'The slot had already started.',
  not_scheduled: 'Ashby does not show this interview as scheduled.',
  no_attester: 'Ashby does not say who scheduled this interview.',
  no_meet_link: 'Ashby has no Google Meet link for this interview.',
  application_unknown: 'The Ashby application is not linked to a candidate in HELLO yet.',
  application_terminal: 'The Ashby application has ended.',
  scheduler_unmapped: 'The person who scheduled it in Ashby has no HELLO account.',
  created_by_unknown: 'The HELLO account for this booking could not be found.',
  disabled: 'R1 is switched off.',
  paused: 'R1 is paused.',
  candidate_ineligible: 'This candidate is not eligible for R1.',
  role_not_configured: 'The Sales Program Advisor role has not been set up yet.',
  round_active: 'The candidate already has an R1 round open.',
  phone_engagement_active: 'A phone screening is in progress or scheduled for this candidate.',
  phone_assessment_pending: 'The candidate’s phone screening is still being scored.',
  capacity_exhausted: 'This month’s R1 allowance is used up.',
  consent_template_unavailable: 'No active R1 notice is available.',
  slot_too_far: 'The slot is too far ahead to set up yet.',
  bot_cap_reached: 'The daily limit of Meet interviews was reached for that day.',
  bot_create_failed: 'The meeting bot could not be set up.',
  bot_fatal: 'The meeting bot stopped with an error.',
  event_removed: 'The interview was removed in Ashby.',
  round_cancelled: 'The R1 round was cancelled in HELLO.',
  round_expired: 'The R1 round expired first.',
  no_show: 'No one joined the meeting in time.',
  admission_refused: 'R1 did not let the interview start.',
  multiple_humans: 'More than one person was in the meeting.',
  attempt_settled: 'The interview has ended.',
  flag_off: 'Google Meet interviews were turned off.',
};

describe('the status words', () => {
  it.each(Object.entries(STATUS_WORDS))('%s reads as its word, in its family', (status, [label, tone]) => {
    expect(meetBookingTerm(status)).toEqual({ label, tone });
    expect(meetBookingTerm(status, 'eligible')).toEqual({ label, tone });
  });

  it('leaves no status out of the table above', () => {
    expect(Object.keys(STATUS_WORDS)).toEqual([...R1_MEET_BOOKING_STATUSES]);
  });

  it('says Failed only for a fault on our side, and only on a failed booking', () => {
    const ours = R1_MEET_BOOKING_REASONS.filter((reason) => meetBookingTerm('failed', reason).label === 'Failed');
    expect(ours).toEqual(['bot_create_failed', 'bot_fatal']);
    for (const reason of ours) {
      expect(meetBookingTerm('failed', reason)).toEqual({ label: 'Failed', tone: 'negative' });
      expect(meetBookingTerm('cancelled', reason)).toEqual({ label: 'Cancelled', tone: 'closed' });
      expect(meetBookingTerm('blocked', reason)).toEqual({ label: 'Blocked', tone: 'unresolved' });
    }
    expect(meetBookingTerm('failed', 'no_show')).toEqual({ label: 'Not completed', tone: 'unresolved' });
    expect(meetBookingTerm('failed', 'a_later_reason')).toEqual({ label: 'Not completed', tone: 'unresolved' });
  });

  it.each(['a_later_status', '', 'constructor', 'toString', '__proto__', 'PENDING'])(
    'never prints a status it does not know (%j)',
    (status) => {
      expect(meetBookingTerm(status)).toEqual({ label: 'Not recognised', tone: 'neutral' });
      expect(meetBookingTerm(status, 'bot_fatal')).toEqual({ label: 'Not recognised', tone: 'neutral' });
    },
  );

  it('offers every status in the filter, Any status first, and says both words of failed', () => {
    expect(R1_MEET_STATUS_OPTIONS[0]).toEqual({ value: '', label: 'Any status' });
    expect(R1_MEET_STATUS_OPTIONS.slice(1).map((option) => option.value)).toEqual([...R1_MEET_BOOKING_STATUSES]);
    for (const { value, label } of R1_MEET_STATUS_OPTIONS.slice(1)) {
      expect(label).toBe(value === 'failed' ? 'Not completed or failed' : STATUS_WORDS[value as R1MeetBookingStatus][0]);
    }
    // A list of twelve things to pick from is no use if two of them read the same.
    expect(new Set(R1_MEET_STATUS_OPTIONS.map((option) => option.label)).size).toBe(13);
  });
});

describe('the reason words', () => {
  it.each(Object.entries(REASON_WORDS))('%s reads as its sentence', (reason, text) => {
    expect(meetBookingReasonText(reason)).toBe(text);
  });

  it('leaves no reason out of the table above', () => {
    expect(Object.keys(REASON_WORDS).sort()).toEqual([...R1_MEET_BOOKING_REASONS].sort());
  });

  it('has nothing to say about an eligible booking, and only about that one', () => {
    expect(R1_MEET_BOOKING_REASONS.filter((reason) => meetBookingReasonText(reason) === null)).toEqual(['eligible']);
  });

  it.each(['a_later_reason', '', 'constructor', 'toString', '__proto__', 'NO_SHOW'])(
    'never prints a reason it does not know (%j)',
    (reason) => {
      expect(meetBookingReasonText(reason)).toBe('This page does not know the reason.');
    },
  );

  it('prints no code in any word it has', () => {
    const words = [
      ...R1_MEET_STATUS_OPTIONS.map((option) => option.label),
      ...R1_MEET_BOOKING_STATUSES.map((status) => meetBookingTerm(status).label),
      ...R1_MEET_BOOKING_REASONS.map((reason) => meetBookingReasonText(reason) ?? ''),
    ];
    for (const word of words) expect(word).not.toMatch(/_/);
  });
});

/* ── The path ─────────────────────────────────────────────────────── */

describe('the path', () => {
  it('is bare when nothing is asked for', () => {
    expect(r1MeetBookingsPath()).toBe('/api/interview-rounds/meet-bookings');
    expect(r1MeetBookingsPath({})).toBe(R1_MEET_BOOKINGS_PATH);
    expect(r1MeetBookingsPath({ status: null, from: null, to: null, cursor: null })).toBe(R1_MEET_BOOKINGS_PATH);
    expect(r1MeetBookingsPath({ from: '', to: '', cursor: '' })).toBe(R1_MEET_BOOKINGS_PATH);
  });

  it('carries status, from, to and cursor, in that order, each encoded', () => {
    expect(
      r1MeetBookingsPath({
        cursor: 'a+b/c=',
        to: '2026-11-30T18:30:00.000Z',
        from: '2026-11-23T18:30:00.000Z',
        status: 'unmatched_application',
      }),
    ).toBe(
      '/api/interview-rounds/meet-bookings?status=unmatched_application' +
        '&from=2026-11-23T18%3A30%3A00.000Z&to=2026-11-30T18%3A30%3A00.000Z&cursor=a%2Bb%2Fc%3D',
    );
  });

  it('sends nothing else, since the API refuses a parameter it does not know', () => {
    const path = r1MeetBookingsPath({ status: 'pending', limit: 100, candidate: 'Ava' } as never);
    expect(path).toBe('/api/interview-rounds/meet-bookings?status=pending');
  });
});

/* ── The reader ───────────────────────────────────────────────────── */

function expectMalformed(value: unknown): void {
  let caught: unknown;
  try {
    readR1MeetBookings(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect(caught).toMatchObject({
    message: 'r1_meet_bookings_malformed',
    code: 'r1_meet_bookings_malformed',
    status: 200,
  });
}

const FIELDS = [
  'id', 'candidate_id', 'round_id', 'status', 'reason', 'start_at', 'end_at', 'created_at', 'updated_at', 'version',
];

const without = (field: string): Record<string, unknown> => {
  const row: Record<string, unknown> = { ...booking() };
  delete row[field];
  return row;
};

describe('the reader', () => {
  it('reads a page', () => {
    const second = other('1', { candidate_id: null, round_id: null, status: 'unmatched_application', reason: 'application_unknown' });
    expect(readR1MeetBookings(body({ bookings: [booking(), second], next_cursor: 'abc' }))).toEqual({
      meet_enabled: true,
      bookings: [booking(), second],
      next_cursor: 'abc',
    });
  });

  it('reads an empty page', () => {
    expect(readR1MeetBookings(body({ bookings: [] }))).toEqual({ meet_enabled: true, bookings: [], next_cursor: null });
  });

  it('accepts an upper-case id and an instant with an offset or no seconds', () => {
    const row = booking({
      id: 'ABCDEF01-2345-4678-9ABC-DEF012345678',
      start_at: '2026-11-24T14:30:00+05:30',
      end_at: '2026-11-24T09:30Z',
      created_at: '2026-11-20T05:00:00.123456Z',
      version: 0,
    });
    expect(readR1MeetBookings(body({ bookings: [row] })).bookings).toEqual([row]);
  });

  it('keeps a row whose status or reason is newer than this page', () => {
    const row = booking({ status: 'a_later_status', reason: 'a_later_reason' });
    expect(readR1MeetBookings(body({ bookings: [row] })).bookings).toEqual([row]);
  });

  it('copies the ten fields and nothing else', () => {
    const poisoned = Object.assign(booking(), {
      meet_url: 'https://example.test/poison',
      recall_bot_id: 'poison',
      ticket_digest: 'poison',
      candidate_name: 'poison',
    });
    const read = readR1MeetBookings(body({ bookings: [poisoned], attester: 'poison' }));
    expect(Object.keys(read)).toEqual(['meet_enabled', 'bookings', 'next_cursor']);
    expect(read.bookings).toEqual([booking()]);
    expect(Object.keys(read.bookings[0])).toEqual(FIELDS);
    expect(JSON.stringify(read)).not.toContain('poison');
  });

  it.each([
    ['as the API answers it', { meet_enabled: false, bookings: [], next_cursor: null }],
    ['with rows it should not carry', { meet_enabled: false, bookings: [booking()], next_cursor: 'abc' }],
    ['with a row nobody could read', { meet_enabled: false, bookings: [null], next_cursor: null }],
  ])('reads Meet off as an empty page, %s', (_name, value) => {
    expect(readR1MeetBookings(value)).toEqual({ meet_enabled: false, bookings: [], next_cursor: null });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['text', 'off'],
    ['a list', [booking()]],
    ['an empty object', {}],
    ['no meet_enabled', { bookings: [], next_cursor: null }],
    ['meet_enabled as text', body({ meet_enabled: 'false' })],
    ['meet_enabled as null', body({ meet_enabled: null })],
    ['no bookings', { meet_enabled: true, next_cursor: null }],
    ['bookings as an object', body({ bookings: {} })],
    ['bookings as null', body({ bookings: null })],
    ['no next_cursor', { meet_enabled: true, bookings: [] }],
    ['an empty next_cursor', body({ next_cursor: '' })],
    ['a numeric next_cursor', body({ next_cursor: 2 })],
    ['an off answer with no list', { meet_enabled: false }],
  ])('refuses a body with %s', (_name, value) => {
    expectMalformed(value);
  });

  it.each([
    ['null', null],
    ['text', 'booking'],
    ['a list', []],
    ...FIELDS.map((field) => [`no ${field}`, without(field)] as const),
    ['an id that is not a uuid', { ...booking(), id: '../poison' }],
    ['an id with text around the uuid', { ...booking(), id: `${booking().id}/x` }],
    ['a null id', { ...booking(), id: null }],
    ['a candidate_id that is not a uuid', { ...booking(), candidate_id: 'c-1' }],
    ['an empty candidate_id', { ...booking(), candidate_id: '' }],
    ['a round_id that is not a uuid', { ...booking(), round_id: 7 }],
    ['an empty status', { ...booking(), status: '' }],
    ['a numeric status', { ...booking(), status: 3 }],
    ['a null reason', { ...booking(), reason: null }],
    ['an empty reason', { ...booking(), reason: '' }],
    ['a start_at that is not a time', { ...booking(), start_at: 'tomorrow' }],
    ['a start_at with no zone', { ...booking(), start_at: '2026-11-24T09:00:00' }],
    ['a start_at that is only a day', { ...booking(), start_at: '2026-11-24' }],
    ['an end_at with an impossible month', { ...booking(), end_at: '2026-13-24T09:30:00.000Z' }],
    ['a null created_at', { ...booking(), created_at: null }],
    ['a numeric updated_at', { ...booking(), updated_at: 1_700_000_000_000 }],
    ['a negative version', { ...booking(), version: -1 }],
    ['a fractional version', { ...booking(), version: 1.5 }],
    ['a version as text', { ...booking(), version: '1' }],
    ['a version that is not a number', { ...booking(), version: Number.NaN }],
  ] as ReadonlyArray<readonly [string, unknown]>)('refuses the whole page for a row with %s', (_name, row) => {
    expectMalformed(body({ bookings: [booking(), row] }));
  });
});

/* ── The times ────────────────────────────────────────────────────── */

describe('a slot, in India time', () => {
  it('reads as a day with its year and a range', () => {
    const slot = meetBookingSlot('2026-11-24T09:00:00.000Z', '2026-11-24T09:30:00.000Z');
    expect(slot.day).toBe(`${formatIstDayLabel('2026-11-24')} 2026`);
    // ICU versions disagree about the comma after the weekday, and about nothing else here.
    expect(slot.day).toMatch(/^Tue,? 24 Nov 2026$/);
    expect(slot.time).toBe('14:30–15:00 IST');
    // A link's name says "to": a screen reader reads an en dash as a pause or not at all (ist-datetime).
    expect(slot.text).toBe(`${slot.day}, 14:30 to 15:00 IST`);
    expect(slot.text).not.toContain('–');
  });

  it('takes its day and year from India, not from UTC', () => {
    const slot = meetBookingSlot('2026-12-31T19:00:00.000Z', '2026-12-31T19:30:00.000Z');
    expect(slot.day).toMatch(/^Fri,? 01 Jan 2027$/);
    expect(slot.time).toBe('00:30–01:00 IST');
  });

  it('names the day it ends on when it crosses midnight in India', () => {
    const slot = meetBookingSlot('2026-11-24T18:00:00.000Z', '2026-11-24T18:45:00.000Z');
    expect(slot.day).toMatch(/^Tue,? 24 Nov 2026$/);
    expect(slot.time).toBe(`23:30 IST to ${formatIstDayLabel('2026-11-25')} 2026, 00:15 IST`);
    expect(slot.time).toMatch(/^23:30 IST to Wed,? 25 Nov 2026, 00:15 IST$/);
    expect(slot.text).toBe(`${slot.day}, ${slot.time}`);
  });

  it('crosses no midnight when only UTC does', () => {
    const slot = meetBookingSlot('2026-11-24T23:30:00.000Z', '2026-11-25T00:15:00.000Z');
    expect(slot.time).toBe('05:00–05:45 IST');
    expect(slot.text).toBe(`${slot.day}, 05:00 to 05:45 IST`);
  });

  it('says so when a time cannot be read, and never prints Invalid Date', () => {
    expect(meetBookingSlot('nonsense', 'nonsense')).toEqual({
      day: 'date unavailable',
      time: 'time unavailable',
      text: 'date unavailable, time unavailable',
    });
    const halfRead = meetBookingSlot('2026-11-24T09:00:00.000Z', '');
    expect(halfRead.day).toMatch(/^Tue,? 24 Nov 2026$/);
    expect(halfRead.time).toBe('time unavailable');
    expect(meetBookingSlot('', '2026-11-24T09:30:00.000Z').text).toBe('date unavailable, time unavailable');
    // The last hours of the year 9999 are already the next year in India, which has five digits.
    expect(meetBookingSlot('9999-12-31T23:00:00.000Z', '9999-12-31T23:30:00.000Z').day).toBe('date unavailable');
  });
});

describe('a stamp, in India time', () => {
  it('reads as a day, a time and its zone', () => {
    expect(meetBookingStamp('2026-11-20T05:00:00.000Z')).toBe('20 Nov 2026, 10:30 IST');
    // The hour as every other date and time in the app prints it, and the day it is in India.
    expect(meetBookingStamp('2026-09-16T03:35:00.000Z')).toBe('16 Sep 2026, 9:05 IST');
    expect(meetBookingStamp('2026-09-16T18:45:00.000Z')).toBe('17 Sep 2026, 0:15 IST');
  });

  it.each(['', 'nonsense'])('says Not available for %j, with no zone after it', (iso) => {
    expect(meetBookingStamp(iso)).toBe('Not available');
  });
});

/* ── The address ──────────────────────────────────────────────────── */

const filtersOf = (search: string) => meetFiltersFrom(new URLSearchParams(search), TODAY);
const isDefault = (search: string) => meetFiltersAreDefault(new URLSearchParams(search));

describe('the filters in the address', () => {
  it('opens from today on, in every status', () => {
    expect(filtersOf('')).toEqual({ status: null, from: TODAY, to: null });
  });

  it('reads what the address says', () => {
    expect(filtersOf('status=blocked&from=2026-11-01&to=2026-11-30')).toEqual({
      status: 'blocked',
      from: '2026-11-01',
      to: '2026-11-30',
    });
  });

  it('reads an empty From as no lower bound, and an empty To as no upper bound', () => {
    expect(filtersOf('from=&to=')).toEqual({ status: null, from: null, to: null });
  });

  it('reads no From with a To before today as no lower bound: a From nobody chose never refuses a To', () => {
    expect(filtersOf('to=2026-11-23')).toEqual({ status: null, from: null, to: '2026-11-23' });
    expect(filtersOf('status=failed&to=2026-09-01')).toEqual({ status: 'failed', from: null, to: '2026-09-01' });
    // A To of today or later leaves the From the page opens on.
    expect(filtersOf(`to=${TODAY}`)).toEqual({ status: null, from: TODAY, to: TODAY });
    expect(filtersOf('to=2026-11-30')).toEqual({ status: null, from: TODAY, to: '2026-11-30' });
    // A From that was chosen, or emptied, is kept as it is.
    expect(filtersOf('from=2026-11-24&to=2026-11-23')).toEqual({ status: null, from: '2026-11-24', to: '2026-11-23' });
    expect(filtersOf('from=&to=2026-11-23')).toEqual({ status: null, from: null, to: '2026-11-23' });
    // A From the page cannot read is absent, so it yields to the To as well.
    expect(filtersOf('from=nonsense&to=2026-11-23')).toEqual({ status: null, from: null, to: '2026-11-23' });
  });

  it.each(['tomorrow', '2026-02-30', '2026-11', '24-11-2026', '2019-12-31', '2100-01-01', '9999-12-31', '0001-01-01'])(
    'reads a date it does not take (%s) as absent',
    (date) => {
      expect(isMeetFilterDate(date)).toBe(false);
      expect(filtersOf(`from=${date}&to=${date}`)).toEqual({ status: null, from: TODAY, to: null });
    },
  );

  it('takes the first and the last day it offers', () => {
    expect([MEET_FILTER_FIRST_DATE, MEET_FILTER_LAST_DATE]).toEqual(['2020-01-01', '2099-12-31']);
    expect(isMeetFilterDate(MEET_FILTER_FIRST_DATE)).toBe(true);
    expect(isMeetFilterDate(MEET_FILTER_LAST_DATE)).toBe(true);
    for (const value of [null, undefined, '', 20261124, new Date()]) expect(isMeetFilterDate(value)).toBe(false);
  });

  it.each(['a_later_status', 'constructor', '__proto__', ''])('reads an unknown status (%j) as any status', (status) => {
    expect(filtersOf(`status=${status}`).status).toBeNull();
  });

  it.each([
    ['', true],
    ['status=&to=', true],
    ['status=nonsense&from=nonsense&to=9999-12-31', true],
    ['page=2', true],
    ['status=failed', false],
    ['from=', false],
    [`from=${TODAY}`, false],
    ['to=2026-11-30', false],
  ])('%j is the page as it opens: %s', (search, expected) => {
    expect(isDefault(search)).toBe(expected);
  });

  it('is the page as it opens exactly when the filters are the ones it opens with', () => {
    for (const search of ['', 'status=x', 'from=x', 'to=x', 'to=', 'from=', 'from=2026-01-01', 'to=2026-12-01', 'status=drained']) {
      const opens = JSON.stringify(filtersOf(search)) === JSON.stringify(filtersOf(''));
      expect(isDefault(search), search).toBe(opens);
    }
  });
});

describe('the request the filters make', () => {
  it('sends the start of the From day in India', () => {
    expect(meetBookingsQuery(filtersOf(''))).toEqual({
      status: null,
      from: '2026-11-23T18:30:00.000Z',
      to: null,
      cursor: null,
    });
  });

  it('includes the To day: the API takes the start of the next one, exclusive', () => {
    const query = meetBookingsQuery({ status: 'completed', from: '2026-11-24', to: '2026-11-24' }, 'abc');
    expect(query).toEqual({
      status: 'completed',
      from: '2026-11-23T18:30:00.000Z',
      to: '2026-11-24T18:30:00.000Z',
      cursor: 'abc',
    });
    // One whole India day: the API needs `from` before `to`.
    expect(Date.parse(query.to!) - Date.parse(query.from!)).toBe(24 * 60 * 60 * 1000);
  });

  it('sends no bound that was cleared', () => {
    expect(r1MeetBookingsPath(meetBookingsQuery(filtersOf('from=')))).toBe(R1_MEET_BOOKINGS_PATH);
  });

  it('can ask for the last day it offers, which the year 9999 could not', () => {
    const query = meetBookingsQuery({ status: null, from: MEET_FILTER_FIRST_DATE, to: MEET_FILTER_LAST_DATE });
    expect(query).toMatchObject({ from: '2019-12-31T18:30:00.000Z', to: '2099-12-31T18:30:00.000Z' });
    // The day after 9999-12-31 is no day an engine has to read back.
    expect(isIstDate(addIstDays(MEET_FILTER_LAST_DATE, 1))).toBe(true);
    expect(isIstDate(addIstDays('9999-12-31', 1))).toBe(false);
  });

  it('refuses a To before the From, and nothing else', () => {
    const error = 'The To date is before the From date.';
    expect(meetDateError({ status: null, from: '2026-11-24', to: '2026-11-23' })).toBe(error);
    expect(meetDateError({ status: null, from: '2026-11-24', to: '2026-11-24' })).toBeNull();
    expect(meetDateError({ status: null, from: '2026-11-24', to: '2026-11-25' })).toBeNull();
    expect(meetDateError({ status: null, from: null, to: '2020-01-01' })).toBeNull();
    expect(meetDateError({ status: null, from: '2099-12-31', to: null })).toBeNull();
    // A To in the past against a From that was chosen.
    expect(meetDateError(filtersOf('from=2026-11-24&to=2026-11-23'))).toBe(error);
    // A To in the past with no From in the address: nobody chose today, so nothing is refused.
    expect(meetDateError(filtersOf('to=2026-11-23'))).toBeNull();
  });

  it('asks for everything up to a past To when no From was chosen', () => {
    expect(meetBookingsQuery(filtersOf('to=2026-11-23'))).toEqual({
      status: null,
      from: null,
      to: '2026-11-23T18:30:00.000Z',
      cursor: null,
    });
  });
});

describe('one more page', () => {
  it('appends what is new, in the order it came', () => {
    const shown = [other('1'), other('2')];
    const merged = mergeMeetBookings(shown, [other('3'), other('4')]);
    expect(merged).toEqual([other('1'), other('2'), other('3'), other('4')]);
  });

  it('keeps the copy just read, so no booking shows twice, and puts it where its slot now falls', () => {
    const moved = other('1', { start_at: '2026-12-01T09:00:00.000Z', end_at: '2026-12-01T09:30:00.000Z' });
    const merged = mergeMeetBookings([other('1'), other('2')], [other('3'), moved]);
    expect(merged).toEqual([other('2'), other('3'), moved]);
  });

  it('stays earliest first, as the count line says, when a booking was moved later between two reads', () => {
    const at = (hhmm: string) => `2026-11-24T${hhmm}:00.000Z`;
    const slot = (n: string, start: string, end: string) => other(n, { start_at: at(start), end_at: at(end) });
    // Page one runs to 09:30 UTC (15:00 IST); then A is moved from 04:30 to 14:30 UTC in Ashby.
    const shown = [slot('1', '04:30', '05:00'), slot('2', '05:30', '06:00'), slot('3', '09:30', '10:00')];
    const movedA = slot('1', '14:30', '15:00');
    const next = [slot('4', '10:30', '11:00'), movedA, slot('5', '15:30', '16:00')];
    const merged = mergeMeetBookings(shown, next);
    expect(merged.map((booking) => booking.id.slice(-1))).toEqual(['2', '3', '4', '1', '5']);
    expect(merged[3]).toBe(movedA);
    const starts = merged.map((booking) => Date.parse(booking.start_at));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('breaks a tie on the slot by id, as the API orders them, whatever the letter case', () => {
    const upper = other('b'.toUpperCase());
    const merged = mergeMeetBookings([other('c')], [other('a'), upper]);
    expect(merged.map((booking) => booking.id.slice(-1))).toEqual(['a', 'B', 'c']);
  });

  it('takes the copy just read whatever its version: that counts bots, not changes to the row', () => {
    const settled = other('1', { status: 'completed', reason: 'attempt_settled', version: 1 });
    expect(mergeMeetBookings([other('1', { version: 1 })], [settled])).toEqual([settled]);
  });

  it('changes neither list', () => {
    const shown = [other('1')];
    const next = [other('1', { status: 'cancelled' }), other('2')];
    mergeMeetBookings(shown, next);
    expect(shown).toEqual([other('1')]);
    expect(next).toHaveLength(2);
    expect(mergeMeetBookings([], [])).toEqual([]);
  });
});

/* ── Drift guard against the API document ─────────────────────────── */

const openapi = readFileSync(resolve(__dirname, '../../../api/openapi/openapi.yaml'), 'utf8').replace(/\r\n/g, '\n');

/** The list read's own block: from its path to the next path, so the detail read cannot answer for it. */
function pathBlock(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === '  /api/interview-rounds/meet-bookings:');
  if (start === -1) throw new Error('path not found in openapi.yaml');
  const after = lines.slice(start + 1).findIndex((line) => /^ {0,2}\S/.test(line));
  return lines.slice(start, after === -1 ? lines.length : start + 1 + after);
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines under the first line that matches `head`, down to the next one at its indent or less. */
function under(lines: readonly string[], head: RegExp): string[] {
  const start = lines.findIndex((line) => head.test(line));
  if (start === -1) throw new Error(`not found: ${head}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() !== '' && indentOf(line) <= indentOf(lines[start]));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The members of the first `key: [a, b]` in these lines. Throws rather than answer an empty list. */
function listOf(lines: readonly string[], key: string): string[] {
  const line = lines.find((candidate) => new RegExp(`^ +${key}: \\[.*\\]\\s*$`).test(candidate));
  if (!line) throw new Error(`no ${key} list`);
  const members = /\[(.*)\]/.exec(line)![1].split(',').map((member) => member.trim()).filter(Boolean);
  if (members.length === 0) throw new Error(`empty ${key} list`);
  return members;
}

function apiVocabulary(yaml: string) {
  const block = pathBlock(yaml);
  const item = under(block, /^ +items:\s*$/);
  return {
    queryParameters: block.flatMap((line) => /^ +- name: (\w+)\s*$/.exec(line)?.[1] ?? []),
    statusFilter: listOf(under(block, /^ +- name: status\s*$/), 'enum'),
    status: listOf(under(item, /^ +status:\s*$/), 'enum'),
    reason: listOf(under(item, /^ +reason:\s*$/), 'enum'),
    fields: listOf(item, 'required'),
    frame: listOf(under(block, /^ +application\/json:\s*$/), 'required'),
  };
}

const web = {
  queryParameters: ['status', 'from', 'to', 'limit', 'cursor'],
  statusFilter: [...R1_MEET_BOOKING_STATUSES] as string[],
  status: [...R1_MEET_BOOKING_STATUSES] as string[],
  reason: [...R1_MEET_BOOKING_REASONS] as string[],
  // What the reader really copies, not a second list of it.
  fields: Object.keys(readR1MeetBookings(body()).bookings[0]),
  frame: Object.keys(readR1MeetBookings(body())),
};

describe('the vocabularies agree with the API document', () => {
  it('has the same statuses, reasons and fields, in the same order', () => {
    expect(apiVocabulary(openapi)).toEqual(web);
  });

  it('really found them in the file', () => {
    const api = apiVocabulary(openapi);
    expect(api.statusFilter).toHaveLength(12);
    expect(api.status).toHaveLength(12);
    expect(api.reason).toHaveLength(32);
    expect(api.fields).toHaveLength(10);
    expect(new Set(api.status).size).toBe(12);
    expect(new Set(api.reason).size).toBe(32);
    const block = pathBlock(openapi).join('\n');
    expect(block).toContain('operationId: listR1MeetBookings');
    expect(block).not.toContain('operationId: getR1MeetBooking\n');
  });

  it('has a word for every status and reason the API can send', () => {
    const api = apiVocabulary(openapi);
    for (const status of api.status) expect(meetBookingTerm(status).label, status).not.toBe('Not recognised');
    for (const reason of api.reason) {
      expect(meetBookingReasonText(reason), reason).not.toBe('This page does not know the reason.');
    }
  });

  /** One edit to the list read's own block, in memory: the rest of the document stays as it is. */
  function mutated(edit: (block: string) => string): string {
    const block = pathBlock(openapi).join('\n');
    const edited = edit(block);
    expect(edited).not.toBe(block);
    const doc = openapi.replace(block, () => edited);
    expect(doc).not.toBe(openapi);
    return doc;
  }

  const lastReplace = (text: string, from: string, to: string): string => {
    const at = text.lastIndexOf(from);
    return at === -1 ? text : text.slice(0, at) + to + text.slice(at + from.length);
  };

  it.each([
    ['gains a status', 'status', (block: string) => lastReplace(block, 'failed, drained]', 'failed, drained, parked]')],
    ['drops a status', 'status', (block: string) => lastReplace(block, 'failed, drained]', 'failed]')],
    ['filters on a status less', 'statusFilter', (block: string) => block.replace('failed, drained]', 'failed]')],
    ['gains a reason', 'reason', (block: string) => block.replace('attempt_settled, flag_off]', 'attempt_settled, flag_off, parked]')],
    ['renames a reason', 'reason', (block: string) => block.replace('no_show, admission_refused', 'nobody_came, admission_refused')],
    ['gains a field', 'fields', (block: string) => block.replace('updated_at, version]', 'updated_at, version, meet_url]')],
    ['drops a field', 'fields', (block: string) => block.replace('required: [id, candidate_id, round_id,', 'required: [id, candidate_id,')],
    ['renames a parameter', 'queryParameters', (block: string) => block.replace('- name: limit', '- name: page_size')],
    ['renames the frame', 'frame', (block: string) => block.replace('required: [meet_enabled, bookings, next_cursor]', 'required: [meet_on, bookings, next_cursor]')],
  ] as ReadonlyArray<readonly [string, keyof typeof web, (block: string) => string]>)(
    'goes red when the API %s',
    (_name, part, edit) => {
      const api = apiVocabulary(mutated(edit));
      expect(api).not.toEqual(web);
      // Only the part that changed: each extractor reads its own lines and no other's.
      expect({ ...api, [part]: web[part] }).toEqual(web);
      expect(api[part]).not.toEqual(web[part]);
    },
  );

  it('throws rather than compare nothing when the document moves', () => {
    expect(() => apiVocabulary(openapi.replace('  /api/interview-rounds/meet-bookings:\n', '  /api/interview-rounds/meet:\n'))).toThrow(
      /path not found/,
    );
    expect(() => apiVocabulary(mutated((block) => block.replace(/^ +reason:$/m, '                        why:')))).toThrow(/not found/);
    expect(() => apiVocabulary(mutated((block) => block.replaceAll(/enum: \[.*\]/g, 'enum: []')))).toThrow(/empty enum list/);
  });
});
