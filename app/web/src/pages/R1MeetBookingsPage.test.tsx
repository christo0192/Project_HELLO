/**
 * The Meet bookings page: what it asks, what a row says, every state it can be in, and the pages.
 * The words themselves, the reader and the query are lib/r1-meet-bookings.test.ts's; here they are
 * checked as they reach the page. Only `Date` is faked, so today is a Tuesday in India.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { optionsOf, pickOption } from '../components/design/__tests__/helpers';
import {
  R1_MEET_BOOKING_REASONS,
  R1_MEET_BOOKING_STATUSES,
  R1_MEET_STATUS_OPTIONS,
  meetBookingReasonText,
  meetBookingSlot,
  meetBookingStamp,
  meetBookingTerm,
} from '../lib/r1-meet-bookings';
import type { R1MeetBooking, R1MeetBookingsBody } from '../lib/r1-meet-bookings';
import { R1MeetBookingsPage } from './R1MeetBookingsPage';

const mockApi = vi.hoisted(() => ({ listR1MeetBookings: vi.fn() }));

vi.mock('../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status = 0;
  },
}));

/** 10:30 on Tuesday 24 November 2026 in India. */
const NOW = new Date('2026-11-24T05:00:00.000Z');
/** Where that day starts. */
const TODAY_STARTS = '2026-11-23T18:30:00.000Z';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const ROUND = '33333333-3333-4333-8333-333333333333';

const booking = (over: Partial<R1MeetBooking> = {}): R1MeetBooking => ({
  id: uuid(1),
  candidate_id: CANDIDATE,
  round_id: null,
  status: 'bot_scheduled',
  reason: 'eligible',
  start_at: '2026-11-25T09:00:00.000Z',
  end_at: '2026-11-25T09:30:00.000Z',
  created_at: '2026-11-20T05:00:00.000Z',
  updated_at: '2026-11-21T06:15:00.000Z',
  version: 1,
  source: 'ashby',
  ...over,
});

const body = (over: Partial<R1MeetBookingsBody> = {}): R1MeetBookingsBody => ({
  meet_enabled: true,
  bookings: [booking()],
  next_cursor: null,
  ...over,
});

const OFF: R1MeetBookingsBody = { meet_enabled: false, bookings: [], next_cursor: null };

const failure = (status: number, code: string) => Object.assign(new Error(code), { status, code });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function Address() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="address">{`${pathname}${search}`}</output>
      <button type="button" onClick={() => void navigate('/interviews/meet-bookings?unrelated=1')}>Unrelated address</button>
    </>
  );
}

function open(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/interviews/meet-bookings${search}`]}>
      <Routes>
        <Route path="/interviews" element={<p>The queue</p>} />
        <Route path="/interviews/meet-bookings" element={<R1MeetBookingsPage />} />
        <Route path="/interviews/:roundId" element={<p>The review</p>} />
        <Route path="/candidates/:id" element={<p>The candidate</p>} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';
const lastAsked = () => mockApi.listR1MeetBookings.mock.calls.at(-1)?.[0];
const asked = () => mockApi.listR1MeetBookings.mock.calls.length;
const table = () => screen.findByRole('table', { name: 'Meet bookings' });
const bodyRows = () => within(screen.getByRole('table', { name: 'Meet bookings' })).getAllByRole('row').slice(1);
const fromField = () => screen.getByLabelText('From (IST)') as HTMLInputElement;
const toField = () => screen.getByLabelText('To (IST)') as HTMLInputElement;
const typeDate = (field: HTMLInputElement, value: string) => fireEvent.change(field, { target: { value } });
const countLine = () => screen.getByText(/^Showing/);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mockApi.listR1MeetBookings.mockReset();
  mockApi.listR1MeetBookings.mockResolvedValue(body());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening the page', () => {
  it('asks once, for every status from the start of today in India on', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'Meet bookings' })).toBeInTheDocument();
    await table();
    expect(asked()).toBe(1);
    expect(lastAsked()).toEqual({ status: null, from: TODAY_STARTS, to: null, cursor: null });
    expect(fromField()).toHaveValue('2026-11-24');
    expect(toField()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Status Any status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull();
  });

  it('takes today from India, not from the browser: after 18:30 UTC it is tomorrow there', async () => {
    vi.setSystemTime(new Date('2026-11-24T19:00:00.000Z'));
    open();
    await table();
    expect(lastAsked()).toMatchObject({ from: '2026-11-24T18:30:00.000Z' });
    expect(fromField()).toHaveValue('2026-11-25');
  });

  it('says what the page is and that its times are India time', async () => {
    open();
    await table();
    expect(
      screen.getByText('Interviews with Lexy over Google Meet, scheduled in Ashby. Times are India Standard Time.'),
    ).toBeInTheDocument();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail).toHaveTextContent('R1 interviews / Meet bookings');
    expect(within(trail).getByRole('link', { name: 'R1 interviews' })).toHaveAttribute('href', '/interviews');
  });

  it('asks the API what the address names', async () => {
    open('?status=unmapped_scheduler&from=2026-11-01&to=2026-11-30');
    await table();
    expect(asked()).toBe(1);
    // The To day is included, so the API's exclusive end is where the next day starts in India.
    expect(lastAsked()).toEqual({
      status: 'unmapped_scheduler', from: '2026-10-31T18:30:00.000Z', to: '2026-11-30T18:30:00.000Z', cursor: null,
    });
    expect(screen.getByRole('button', { name: 'Status Scheduler not matched' })).toBeInTheDocument();
    expect(fromField()).toHaveValue('2026-11-01');
    expect(toField()).toHaveValue('2026-11-30');
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument();
  });

  it('reads an empty From as no lower bound, and what it cannot read as absent', async () => {
    const { unmount } = open('?from=');
    await table();
    expect(lastAsked()).toEqual({ status: null, from: null, to: null, cursor: null });
    expect(fromField()).toHaveValue('');
    unmount();
    open('?status=nonsense&from=9999-12-31&to=tomorrow');
    await table();
    expect(lastAsked()).toEqual({ status: null, from: TODAY_STARTS, to: null, cursor: null });
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull();
  });

  it('reads nothing again by itself: not on focus, not on coming back, not for an address that asks the same', async () => {
    open();
    await table();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await userEvent.click(screen.getByRole('button', { name: 'Unrelated address' }));
    await settle();
    expect(address()).toBe('/interviews/meet-bookings?unrelated=1');
    expect(asked()).toBe(1);
    expect(bodyRows()).toHaveLength(1);
  });

  it('goes back to R1 interviews by the breadcrumb', async () => {
    open();
    await userEvent.click(screen.getByRole('link', { name: 'R1 interviews' }));
    expect(await screen.findByText('The queue')).toBeInTheDocument();
    expect(address()).toBe('/interviews');
  });
});

describe('a row', () => {
  it('gives the slot, the way to the candidate, the status and why, and when it was made and changed', async () => {
    const row = booking({ status: 'blocked', reason: 'round_active', round_id: ROUND });
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [row] }));
    open();
    await table();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Slot (IST)', 'Candidate', 'Status', 'Created and updated',
    ]);
    const slot = meetBookingSlot(row.start_at, row.end_at);
    const [line] = bodyRows();
    const cells = within(line).getAllByRole('cell');
    expect(cells).toHaveLength(4);
    // The link's name says "to", which a screen reader speaks; the cell keeps the dash, which the eye reads.
    expect(slot.text).toMatch(/^Wed,? 25 Nov 2026, 14:30 to 15:00 IST$/);
    expect(cells[0]).toHaveTextContent(slot.day);
    expect(cells[0]).toHaveTextContent('14:30–15:00 IST');
    for (const link of within(cells[1]).getAllByRole('link')) expect(link.textContent).not.toContain('–');
    const candidate = within(cells[1]).getByRole('link', { name: `Open candidate for ${slot.text}` });
    expect(candidate).toHaveAttribute('href', `/candidates/${CANDIDATE}?tab=r1`);
    const review = within(cells[1]).getByRole('link', { name: `Open R1 review for ${slot.text}` });
    expect(review).toHaveAttribute('href', `/interviews/${ROUND}`);
    expect(cells[2]).toHaveTextContent('Status: BlockedThe candidate already has an R1 round open.');
    expect(cells[3]).toHaveTextContent('Created 20 Nov 2026, 10:30 IST');
    expect(cells[3]).toHaveTextContent('Updated 21 Nov 2026, 11:45 IST');
    // The same two stamps sit under the slot at the width that has no fourth column.
    expect(cells[0]).toHaveTextContent('Created 20 Nov 2026, 10:30 IST');
    expect(cells[3]).toHaveClass('hidden', 'md:table-cell');
  });

  it('says when no candidate matched, and has no review to open without a round', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(
      body({ bookings: [booking({ candidate_id: null, status: 'unmatched_application', reason: 'application_unknown' })] }),
    );
    open();
    await table();
    const [line] = bodyRows();
    expect(line).toHaveTextContent('No candidate matched');
    expect(line).toHaveTextContent('Status: No matching candidate');
    expect(line).toHaveTextContent('The Ashby application is not linked to a candidate in HELLO yet.');
    expect(within(line).queryByRole('link')).toBeNull();
  });

  it('offers the candidate and no review while a booking has no round', async () => {
    open();
    await table();
    expect(screen.getByRole('link', { name: /^Open candidate/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Open R1 review/ })).toBeNull();
  });

  it.each([
    ['Open candidate', `/candidates/${CANDIDATE}?tab=r1`, 'The candidate'],
    ['Open R1 review', `/interviews/${ROUND}`, 'The review'],
  ])('%s goes there', async (name, href, words) => {
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [booking({ round_id: ROUND })] }));
    open();
    await userEvent.click(await screen.findByRole('link', { name: new RegExp(`^${name}`) }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(address()).toBe(href);
  });

  it('tells two rows\' links apart by their slots', async () => {
    const later = booking({ id: uuid(2), start_at: '2026-11-26T09:00:00.000Z', end_at: '2026-11-26T09:30:00.000Z' });
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [booking(), later] }));
    open();
    await table();
    const names = screen.getAllByRole('link', { name: /^Open candidate/ }).map((link) => link.textContent);
    expect(new Set(names).size).toBe(2);
  });

  it('names both days of a slot that crosses midnight in India', async () => {
    const night = booking({ start_at: '2026-11-24T18:00:00.000Z', end_at: '2026-11-24T18:45:00.000Z' });
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [night] }));
    open();
    await table();
    expect(bodyRows()[0]).toHaveTextContent(/Tue,? 24 Nov 2026\s*23:30 IST to Wed,? 25 Nov 2026, 00:15 IST/);
  });

  it('says one time, once, for a booking nobody has changed since', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(
      body({ bookings: [booking({ updated_at: '2026-11-20T05:00:41.000Z' })] }),
    );
    open();
    await table();
    expect(bodyRows()[0]).toHaveTextContent('Created 20 Nov 2026, 10:30 IST');
    expect(bodyRows()[0]).not.toHaveTextContent('Updated');
  });

  it.each([
    ['pending', 'eligible', 'Booked', 'bg-moving-soft'],
    ['bot_scheduled', 'eligible', 'Lexy scheduled', 'bg-moving-soft'],
    ['completed', 'attempt_settled', 'Completed', 'bg-ready-soft'],
    ['blocked', 'slot_too_far', 'Blocked', 'bg-unresolved-soft'],
    ['unmapped_scheduler', 'scheduler_unmapped', 'Scheduler not matched', 'bg-unresolved-soft'],
    ['cancelled', 'cancelled', 'Cancelled', 'bg-closed-soft'],
    ['failed', 'no_show', 'Not completed', 'bg-unresolved-soft'],
  ])('prints %s (%s) as "%s" on its family\'s wash, with the word that says what it is', async (status, reason, word, wash) => {
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [booking({ status, reason })] }));
    open();
    await table();
    const tag = within(bodyRows()[0]).getByText(word);
    expect(tag).toHaveClass(wash);
    expect(tag).toHaveTextContent(`Status: ${word}`);
  });

  it('keeps Failed for a fault on our side', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [booking({ status: 'failed', reason: 'bot_fatal' })] }));
    open();
    await table();
    const tag = within(bodyRows()[0]).getByText('Failed');
    expect(tag.className).toContain('--c-negative');
    expect(bodyRows()[0]).toHaveTextContent('The meeting bot stopped with an error.');
  });

  it('has no reason line when there is nothing to say', async () => {
    open();
    await table();
    const status = within(bodyRows()[0]).getAllByRole('cell')[2];
    expect(status.textContent).toBe('Status: Lexy scheduled');
  });

  it('keeps a booking this page has no words for, in words that print no code', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [booking({ status: 'bot_resting', reason: 'new_moon' })] }));
    open();
    await table();
    expect(bodyRows()[0]).toHaveTextContent('Status: Not recognised');
    expect(bodyRows()[0]).toHaveTextContent('This page does not know the reason.');
    expect(bodyRows()[0]).not.toHaveTextContent(/bot_resting|new_moon/);
  });
});

describe('what never reaches the page', () => {
  it('prints no id, version, status code or reason code, whichever of them a booking has', async () => {
    const VERSION = 987654321;
    const bookings = R1_MEET_BOOKING_REASONS.map((reason, index) =>
      booking({
        id: uuid(500 + index),
        round_id: ROUND,
        status: R1_MEET_BOOKING_STATUSES[index % R1_MEET_BOOKING_STATUSES.length],
        reason,
        version: VERSION,
      }));
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings }));
    const { container } = open();
    await table();
    const text = container.querySelector('[data-candidate-shell]')!.textContent ?? '';
    expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    expect(text).not.toContain(CANDIDATE);
    expect(text).not.toContain(ROUND);
    // A candidate and a round are in their links, and nowhere else; a booking's own id and version nowhere.
    expect(container.innerHTML).not.toContain(String(VERSION));
    expect(container.innerHTML).not.toContain('00000000-0000-4000-8000');
    // Not vacuous: every status and reason is on the page, in its words.
    for (const { status, reason } of bookings) {
      expect(text).toContain(meetBookingTerm(status, reason).label);
      expect(text).toContain(meetBookingReasonText(reason) ?? '');
    }
  });

  it('prints nothing of a field it was never meant to have', async () => {
    const poisoned = Object.assign(booking(), {
      meet_url: 'https://example.invalid/poison-link',
      recall_bot_id: 'poison-bot',
      ticket_digest: 'poison-digest',
      attested_by: 'poison-person',
    });
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [poisoned] }));
    const { container } = open();
    await table();
    expect(container.innerHTML).not.toContain('poison');
  });
});

describe('whether Meet is on', () => {
  it('says it is on, from the answer, and offers no way to switch it', async () => {
    open();
    await table();
    expect(screen.getByTestId('meet-status')).toHaveTextContent(/^Google Meet interviews are on\.$/);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('holds the line\'s place until the answer is in, and says nothing it was not told', async () => {
    mockApi.listR1MeetBookings.mockReturnValue(new Promise(() => undefined));
    open();
    const line = screen.getByTestId('meet-status');
    expect(line).toHaveTextContent('');
    expect(line.querySelector('.skeleton')).not.toBeNull();
    await settle();
    expect(line).toHaveTextContent('');
  });

  it('says nothing about it when the read fails', async () => {
    mockApi.listR1MeetBookings.mockRejectedValue(failure(503, 'service_unavailable'));
    open();
    await screen.findByRole('alert');
    expect(screen.getByTestId('meet-status')).toBeEmptyDOMElement();
  });

  it('keeps the line through a change of filter: it is about the server, not the list', async () => {
    open();
    await table();
    mockApi.listR1MeetBookings.mockReturnValue(new Promise(() => undefined));
    await pickOption(userEvent.setup(), /^Status/, 'Blocked');
    await screen.findByRole('status', { name: 'Loading Meet bookings' });
    expect(screen.getByTestId('meet-status')).toHaveTextContent('Google Meet interviews are on.');
  });

  it('is calm while it is off: says so once, names no setting, hides the filters and asks no more', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(OFF);
    const { container } = open();
    expect(await screen.findByText('Google Meet interviews are off.')).toBe(screen.getByTestId('meet-status'));
    expect(screen.getByText('This page lists bookings only while they are on.')).toBeInTheDocument();
    expect(screen.getByText('It is a server setting; R1 settings cannot change it.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Bookings to show' })).toBeNull();
    expect(screen.queryByLabelText('From (IST)')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(screen.getByTestId('meet-status').parentElement!).queryByRole('button')).toBeNull();
    expect(container.textContent).not.toMatch(/R1_MEET|_ENABLED|VITE_|\benv\b|\bflag\b/i);
    await settle();
    expect(asked()).toBe(1);
  });
});

describe('the filters', () => {
  it('offers every status in its words, and one for all of them', async () => {
    open();
    await table();
    expect(await optionsOf(userEvent.setup(), /^Status/)).toEqual(R1_MEET_STATUS_OPTIONS.map((option) => option.label));
  });

  it('a status goes into the address and is read, and Any status takes it out again', async () => {
    const user = userEvent.setup();
    open();
    await table();
    await pickOption(user, /^Status/, 'Not completed or failed');
    await waitFor(() => expect(lastAsked()).toEqual({ status: 'failed', from: TODAY_STARTS, to: null, cursor: null }));
    expect(address()).toBe('/interviews/meet-bookings?status=failed');
    expect(asked()).toBe(2);
    await table();
    await pickOption(user, /^Status/, 'Any status');
    await waitFor(() => expect(lastAsked()).toMatchObject({ status: null }));
    expect(address()).toBe('/interviews/meet-bookings');
    expect(asked()).toBe(3);
  });

  it('dates go into the address and are read, the To day included', async () => {
    open();
    await table();
    typeDate(fromField(), '2026-11-20');
    await waitFor(() => expect(lastAsked()).toMatchObject({ from: '2026-11-19T18:30:00.000Z', to: null }));
    expect(address()).toBe('/interviews/meet-bookings?from=2026-11-20');
    typeDate(toField(), '2026-11-20');
    await waitFor(() => expect(lastAsked()).toMatchObject({ from: '2026-11-19T18:30:00.000Z', to: '2026-11-20T18:30:00.000Z' }));
    expect(address()).toBe('/interviews/meet-bookings?from=2026-11-20&to=2026-11-20');
    expect(asked()).toBe(3);
  });

  it('an emptied From asks with no lower bound, and an emptied To leaves the address', async () => {
    open('?to=2026-11-30');
    await table();
    typeDate(fromField(), '');
    await waitFor(() => expect(lastAsked()).toMatchObject({ from: null, to: '2026-11-30T18:30:00.000Z' }));
    expect(address()).toBe('/interviews/meet-bookings?to=2026-11-30&from=');
    typeDate(toField(), '');
    await waitFor(() => expect(lastAsked()).toMatchObject({ from: null, to: null }));
    expect(address()).toBe('/interviews/meet-bookings?from=');
  });

  it('keeps a date that is still being typed in its box, and asks for nothing until it is one', async () => {
    open();
    await table();
    for (const typed of ['0002-11-28', '0020-11-28', '0202-11-28']) {
      typeDate(toField(), typed);
      expect(toField()).toHaveValue(typed);
    }
    await settle();
    expect(asked()).toBe(1);
    expect(address()).toBe('/interviews/meet-bookings');
    typeDate(toField(), '2026-11-28');
    await waitFor(() => expect(lastAsked()).toMatchObject({ to: '2026-11-28T18:30:00.000Z' }));
    expect(asked()).toBe(2);
  });

  it('does not take a half typed date for an emptied field, and puts the date back on the way out', async () => {
    open();
    await table();
    const field = fromField();
    // As a browser reports a date with a part taken out: no value, and bad input.
    Object.defineProperty(field, 'validity', { configurable: true, value: { badInput: true } });
    field.focus();
    typeDate(field, '');
    await settle();
    expect(field).toHaveValue('');
    expect(asked()).toBe(1);
    expect(address()).toBe('/interviews/meet-bookings');
    fireEvent.blur(field);
    expect(field).toHaveValue('2026-11-24');
  });

  it('does not keep a date out of range once the field is left', async () => {
    open('?to=2026-11-30');
    await table();
    const field = toField();
    typeDate(field, '2150-01-01');
    expect(field).toHaveValue('2150-01-01');
    fireEvent.blur(field);
    expect(field).toHaveValue('2026-11-30');
    await settle();
    expect(asked()).toBe(1);
  });

  it('a To before today with no From chosen asks for everything up to it, and empties the From box', async () => {
    open();
    await table();
    expect(fromField()).toHaveValue('2026-11-24');
    typeDate(toField(), '2026-11-20');
    await waitFor(() => expect(lastAsked()).toEqual({ status: null, from: null, to: '2026-11-20T18:30:00.000Z', cursor: null }));
    expect(address()).toBe('/interviews/meet-bookings?to=2026-11-20');
    expect(fromField()).toHaveValue('');
    expect(screen.queryByText('The To date is before the From date.')).toBeNull();
    expect(toField()).not.toHaveAttribute('aria-invalid');
    await table();
    expect(asked()).toBe(2);
  });

  it('says a To before the From on its field, shows no list and asks nothing, until they agree', async () => {
    open('?from=2026-11-24');
    await table();
    typeDate(toField(), '2026-11-20');
    const message = await screen.findByText('The To date is before the From date.');
    expect(toField()).toHaveAttribute('aria-invalid', 'true');
    expect(toField().getAttribute('aria-describedby')).toBe(message.id);
    expect(fromField()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading Meet bookings' })).toBeNull();
    await settle();
    expect(asked()).toBe(1);
    typeDate(fromField(), '2026-11-19');
    await table();
    expect(screen.queryByText('The To date is before the From date.')).toBeNull();
    expect(lastAsked()).toMatchObject({ from: '2026-11-18T18:30:00.000Z', to: '2026-11-20T18:30:00.000Z' });
    expect(asked()).toBe(2);
  });

  it('asks nothing at all when the address itself is that, and waits for nothing', async () => {
    open('?from=2026-11-24&to=2026-11-20');
    expect(screen.getByText('The To date is before the From date.')).toBeInTheDocument();
    await settle();
    expect(asked()).toBe(0);
    expect(screen.queryByRole('status', { name: 'Loading Meet bookings' })).toBeNull();
    expect(screen.getByTestId('meet-status')).toBeEmptyDOMElement();
  });

  it('Reset goes back to the page as it opens, boxes and all, and keeps the focus on the filters', async () => {
    const user = userEvent.setup();
    open('?status=blocked&from=&to=2026-11-30');
    await table();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(lastAsked()).toEqual({ status: null, from: TODAY_STARTS, to: null, cursor: null }));
    expect(address()).toBe('/interviews/meet-bookings');
    expect(fromField()).toHaveValue('2026-11-24');
    expect(toField()).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Status Any status' })).toHaveFocus();
    expect(asked()).toBe(2);
  });

  it('opens on the day it now is when it is reset in a tab left open past midnight', async () => {
    open('?status=blocked');
    await table();
    vi.setSystemTime(new Date('2026-11-24T18:45:00.000Z'));
    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(lastAsked()).toMatchObject({ status: null, from: '2026-11-24T18:30:00.000Z' }));
    expect(fromField()).toHaveValue('2026-11-25');
  });

  it('never shows the last filter\'s rows under the new one', async () => {
    open();
    await table();
    mockApi.listR1MeetBookings.mockReturnValue(new Promise(() => undefined));
    await pickOption(userEvent.setup(), /^Status/, 'Completed');
    expect(await screen.findByRole('status', { name: 'Loading Meet bookings' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a slow answer to an older read does not replace a newer one', async () => {
    const slow = deferred<R1MeetBookingsBody>();
    mockApi.listR1MeetBookings.mockReturnValueOnce(slow.promise);
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [booking({ status: 'completed', reason: 'attempt_settled' })] }));
    open();
    await settle();
    await pickOption(userEvent.setup(), /^Status/, 'Completed');
    await table();
    await act(async () => { slow.resolve(body({ bookings: [booking({ status: 'cancelled', reason: 'cancelled' })] })); });
    await settle();
    expect(bodyRows()[0]).toHaveTextContent('Status: Completed');
  });
});

describe('loading, empty and failed', () => {
  it('holds its place while the answer is out, then shows the rows', async () => {
    const first = deferred<R1MeetBookingsBody>();
    mockApi.listR1MeetBookings.mockReturnValue(first.promise);
    open();
    expect(screen.getByRole('status', { name: 'Loading Meet bookings' })).toBeInTheDocument();
    await act(async () => { first.resolve(body()); });
    await table();
    expect(screen.queryByRole('status', { name: 'Loading Meet bookings' })).toBeNull();
  });

  it('says there is no booking from today on, and what makes one', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [] }));
    open();
    expect(await screen.findByText('No Meet booking from today on.')).toBeInTheDocument();
    expect(
      screen.getByText('A booking appears when an interview is scheduled in Ashby with Lexy as an interviewer.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('meet-status')).toHaveTextContent('Google Meet interviews are on.');
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it('says no booking matches when a filter is on, and Reset goes back to every booking from today', async () => {
    mockApi.listR1MeetBookings.mockResolvedValueOnce(body({ bookings: [] }));
    open('?status=drained');
    const words = await screen.findByText('No booking matches these filters.');
    expect(screen.queryByText('No Meet booking from today on.')).toBeNull();
    await userEvent.click(within(words.parentElement!).getByRole('button', { name: 'Reset filters' }));
    await table();
    expect(address()).toBe('/interviews/meet-bookings');
    expect(lastAsked()).toEqual({ status: null, from: TODAY_STARTS, to: null, cursor: null });
  });

  it('says a failed read in plain words, and Try again reads again', async () => {
    mockApi.listR1MeetBookings.mockRejectedValueOnce(failure(503, 'service_unavailable'));
    open();
    const panel = await screen.findByRole('alert');
    expect(panel).not.toHaveTextContent('service_unavailable');
    expect(panel).toHaveTextContent('HELLO could not complete this just now.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    await table();
    expect(asked()).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says an answer it cannot read in plain words, never its code', async () => {
    mockApi.listR1MeetBookings.mockRejectedValue(failure(200, 'r1_meet_bookings_malformed'));
    open();
    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent('Something went wrong.');
    expect(panel).not.toHaveTextContent('malformed');
  });

  it('offers no Try again to someone the API refuses', async () => {
    mockApi.listR1MeetBookings.mockRejectedValue(failure(403, 'access_denied'));
    open();
    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent('Your role does not give you access to this.');
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('says a refused filter is one, and Reset filters opens the page again', async () => {
    mockApi.listR1MeetBookings.mockRejectedValueOnce(failure(400, 'invalid_query'));
    open('?status=blocked&to=2026-11-30');
    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent('These filters were not accepted.');
    expect(panel).not.toHaveTextContent('invalid_query');
    expect(within(panel).queryByRole('button', { name: 'Try again' })).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Reset filters' }));
    await table();
    expect(address()).toBe('/interviews/meet-bookings');
    expect(lastAsked()).toEqual({ status: null, from: TODAY_STARTS, to: null, cursor: null });
    expect(asked()).toBe(2);
  });

  it.each([
    ['that names no filter', ''],
    ['that writes today out', '?from=2026-11-24'],
  ])('reads again on Reset even from an address %s, which asks nothing new', async (_what, search) => {
    mockApi.listR1MeetBookings.mockRejectedValueOnce(failure(400, 'invalid_query'));
    open(search);
    const panel = await screen.findByRole('alert');
    await userEvent.click(within(panel).getByRole('button', { name: 'Reset filters' }));
    await table();
    expect(address()).toBe('/interviews/meet-bookings');
    expect(asked()).toBe(2);
  });

  it('survives an API adapter without the call', async () => {
    mockApi.listR1MeetBookings.mockImplementation(() => {
      throw new TypeError('not a function');
    });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});

describe('the pages', () => {
  const row = (n: number, over: Partial<R1MeetBooking> = {}) => booking({ id: uuid(n), ...over });
  const pageOne = () => body({ bookings: [row(1), row(2)], next_cursor: 'cursor-1' });
  const loadMoreButton = () => screen.getByRole('button', { name: 'Load more' });

  it('counts what is shown and says when there is more', async () => {
    mockApi.listR1MeetBookings.mockResolvedValue(pageOne());
    open();
    await table();
    expect(countLine()).toHaveTextContent('Showing 2 bookings, earliest first. More are available.');
    expect(countLine()).toHaveAttribute('aria-live', 'polite');
    expect(loadMoreButton()).toBeEnabled();
  });

  it('has no Load more on the only page, and counts one as one', async () => {
    open();
    await table();
    expect(countLine()).toHaveTextContent(/^Showing 1 booking, earliest first\.$/);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('adds the next page, with the same filters and the cursor as it was given', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockResolvedValueOnce(body({ bookings: [row(3)], next_cursor: 'cursor-2' }));
    open('?status=bot_scheduled&to=2026-12-31');
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(lastAsked()).toEqual({
      status: 'bot_scheduled', from: TODAY_STARTS, to: '2026-12-31T18:30:00.000Z', cursor: 'cursor-1',
    });
    expect(asked()).toBe(2);
    expect(address()).toBe('/interviews/meet-bookings?status=bot_scheduled&to=2026-12-31');
    expect(countLine()).toHaveTextContent('Showing 3 bookings, earliest first. More are available.');
    expect(loadMoreButton()).toBeEnabled();
  });

  it('sends the newest cursor on the page after', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockResolvedValueOnce(body({ bookings: [row(3)], next_cursor: 'cursor-2' }))
      .mockResolvedValueOnce(body({ bookings: [row(4)] }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    expect(lastAsked()).toMatchObject({ cursor: 'cursor-2' });
  });

  it('shows a booking that came back on a later page once, as it is now', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockResolvedValueOnce(body({ bookings: [row(2, { status: 'cancelled', reason: 'cancelled' }), row(3)] }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(countLine()).toHaveTextContent('Showing 3 bookings');
    expect(bodyRows()[1]).toHaveTextContent('Status: Cancelled');
  });

  it('keeps the list earliest first when a booking came back moved to a later slot', async () => {
    const at = (hhmm: string) => `2026-11-25T${hhmm}:00.000Z`;
    const slotted = (n: number, start: string, end: string) => row(n, { start_at: at(start), end_at: at(end) });
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(body({ bookings: [slotted(1, '04:30', '05:00'), slotted(2, '05:30', '06:00')], next_cursor: 'cursor-1' }))
      // Booking 1 was moved from 10:00 to 16:00 IST in Ashby between the two reads.
      .mockResolvedValueOnce(body({ bookings: [slotted(3, '07:30', '08:00'), slotted(1, '10:30', '11:00')] }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(countLine()).toHaveTextContent(/^Showing 3 bookings, earliest first\.$/));
    expect(bodyRows().map((line) => within(line).getAllByRole('cell')[0].textContent)).toEqual([
      expect.stringContaining('11:00–11:30 IST'),
      expect.stringContaining('13:00–13:30 IST'),
      expect.stringContaining('16:00–16:30 IST'),
    ]);
  });

  it('keeps the rows up and the button busy while the page is on its way, and asks for it once', async () => {
    const next = deferred<R1MeetBookingsBody>();
    mockApi.listR1MeetBookings.mockResolvedValueOnce(pageOne()).mockReturnValueOnce(next.promise);
    open();
    await table();
    await userEvent.click(loadMoreButton());
    expect(loadMoreButton()).toBeDisabled();
    expect(loadMoreButton()).toHaveAttribute('aria-busy', 'true');
    expect(bodyRows()).toHaveLength(2);
    await userEvent.click(loadMoreButton());
    expect(asked()).toBe(2);
    await act(async () => { next.resolve(body({ bookings: [row(3)] })); });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
  });

  it('keeps the focus on the button while there is another page', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockResolvedValueOnce(body({ bookings: [row(3)], next_cursor: 'cursor-2' }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(loadMoreButton()).toHaveFocus();
  });

  it('moves it to the count line when the last page takes the button away', async () => {
    mockApi.listR1MeetBookings.mockResolvedValueOnce(pageOne()).mockResolvedValueOnce(body({ bookings: [row(3)] }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(countLine()).toHaveTextContent(/^Showing 3 bookings, earliest first\.$/);
    expect(countLine()).toHaveFocus();
    expect(countLine()).toHaveAttribute('tabindex', '-1');
  });

  it('takes the focus from nobody who has moved on', async () => {
    const next = deferred<R1MeetBookingsBody>();
    mockApi.listR1MeetBookings.mockResolvedValueOnce(pageOne()).mockReturnValueOnce(next.promise);
    open();
    await table();
    await userEvent.click(loadMoreButton());
    fromField().focus();
    await act(async () => { next.resolve(body({ bookings: [row(3)] })); });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(fromField()).toHaveFocus();
  });

  it('ignores a page that arrives for filters no longer on', async () => {
    const next = deferred<R1MeetBookingsBody>();
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce(body({ bookings: [row(9, { status: 'completed', reason: 'attempt_settled' })] }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await pickOption(userEvent.setup(), /^Status/, 'Completed');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await act(async () => { next.resolve(body({ bookings: [row(3), row(4)], next_cursor: 'cursor-9' })); });
    await settle();
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('Status: Completed');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it.each([
    ['an answer', (late: ReturnType<typeof deferred<R1MeetBookingsBody>>) => late.resolve(body({ bookings: [row(3)], next_cursor: 'cursor-2' }))],
    ['a failure', (late: ReturnType<typeof deferred<R1MeetBookingsBody>>) => late.reject(failure(503, 'service_unavailable'))],
  ])('ignores %s, and leaves a working button, when the filter went and came back meanwhile', async (_what, arrive) => {
    const user = userEvent.setup();
    const next = deferred<R1MeetBookingsBody>();
    const again = deferred<R1MeetBookingsBody>();
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockReturnValueOnce(next.promise)
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockReturnValueOnce(again.promise);
    open();
    await table();
    await user.click(loadMoreButton());
    await pickOption(user, /^Status/, 'Completed');
    await waitFor(() => expect(asked()).toBe(3));
    await pickOption(user, /^Status/, 'Any status');
    await waitFor(() => expect(asked()).toBe(4));
    await act(async () => { arrive(next); });
    await settle();
    // The list these filters had is up again while it is read again: nothing is added to it, and nothing said.
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { again.resolve(pageOne()); });
    await settle();
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loadMoreButton()).toBeEnabled();
  });

  it('keeps the rows when a page fails, says so in words, and Try again asks for the same page', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockRejectedValueOnce(failure(503, 'service_unavailable'))
      .mockResolvedValueOnce(body({ bookings: [row(3)] }));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('More bookings couldn’t load. HELLO could not complete this just now.');
    expect(notice).not.toHaveTextContent('service_unavailable');
    expect(bodyRows()).toHaveLength(2);
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    await userEvent.click(retry);
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(lastAsked()).toMatchObject({ cursor: 'cursor-1' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers to start again when the API refuses the place in the list, and does', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(pageOne())
      .mockRejectedValueOnce(failure(400, 'invalid_query'))
      .mockResolvedValueOnce(body({ bookings: [row(7)] }));
    open('?status=bot_scheduled');
    await table();
    await userEvent.click(loadMoreButton());
    const notice = await screen.findByRole('alert');
    expect(notice).not.toHaveTextContent('invalid_query');
    expect(bodyRows()).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Start again from the first page' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(lastAsked()).toEqual({ status: 'bot_scheduled', from: TODAY_STARTS, to: null, cursor: null });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(address()).toBe('/interviews/meet-bookings?status=bot_scheduled');
  });

  it('offers nothing more to someone the API no longer answers, and keeps the rows it gave', async () => {
    mockApi.listR1MeetBookings.mockResolvedValueOnce(pageOne()).mockRejectedValueOnce(failure(403, 'access_denied'));
    open();
    await table();
    await userEvent.click(loadMoreButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role does not give you access to this.');
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Load more|Try again|Start again/ })).toBeNull();
    expect(countLine()).toHaveFocus();
  });

  it('goes off when Meet was turned off between two pages', async () => {
    mockApi.listR1MeetBookings.mockResolvedValueOnce(pageOne()).mockResolvedValueOnce(OFF);
    open();
    await table();
    await userEvent.click(loadMoreButton());
    await waitFor(() => expect(screen.getByTestId('meet-status')).toHaveTextContent('Google Meet interviews are off.'));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Bookings to show' })).toBeNull();
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(screen.getByTestId('meet-status')).toHaveFocus();
    expect(asked()).toBe(2);
  });
});

describe('accessibility', () => {
  it('has no axe violations with rows, with more to load and after a page that failed', async () => {
    mockApi.listR1MeetBookings
      .mockResolvedValueOnce(
        body({
          bookings: [
            booking({ round_id: ROUND, status: 'completed', reason: 'attempt_settled' }),
            booking({ id: uuid(2), candidate_id: null, status: 'unmatched_application', reason: 'application_unknown' }),
          ],
          next_cursor: 'cursor-1',
        }),
      )
      .mockRejectedValueOnce(failure(503, 'service_unavailable'));
    const { container } = open();
    await table();
    await expect(container).toHaveNoViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('alert');
    await expect(container).toHaveNoViolations();
  });

  it('has none while it loads, or with dates that cannot be asked for', async () => {
    mockApi.listR1MeetBookings.mockReturnValue(new Promise(() => undefined));
    const { container, unmount } = open();
    await expect(container).toHaveNoViolations();
    unmount();
    const dates = open('?from=2026-11-24&to=2026-11-20');
    await expect(dates.container).toHaveNoViolations();
  });

  it.each([
    ['with no booking from today on', '', () => mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [] })), 'No Meet booking from today on.'],
    ['with no booking for a filter', '?status=blocked', () => mockApi.listR1MeetBookings.mockResolvedValue(body({ bookings: [] })), 'No booking matches these filters.'],
    ['while Meet is off', '', () => mockApi.listR1MeetBookings.mockResolvedValue(OFF), 'Google Meet interviews are off.'],
    ['when the read fails', '', () => mockApi.listR1MeetBookings.mockRejectedValue(failure(503, 'service_unavailable')), /^HELLO could not complete this/],
  ] as const)('has none %s', async (_what, search, answer, words) => {
    answer();
    const { container } = open(search);
    await screen.findByText(words);
    await expect(container).toHaveNoViolations();
  });
});

describe('the stamps are India time wherever the browser is', () => {
  it('prints what the one formatter gives', async () => {
    open();
    await table();
    const { created_at, updated_at } = booking();
    expect(screen.getAllByText(`Created ${meetBookingStamp(created_at)}`)).toHaveLength(2);
    expect(screen.getAllByText(`Updated ${meetBookingStamp(updated_at)}`)).toHaveLength(2);
  });
});
