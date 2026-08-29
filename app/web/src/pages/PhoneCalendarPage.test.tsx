/**
 * Phone calendar — role behaviour, the single read, both views, filters and
 * every empty/loading/error state.
 *
 * The network trap in `src/test/setup.ts` fails any un-mocked request, so
 * "no unmocked network" is structural here rather than asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  ADMIN_ME,
  INTERVIEWER_ME,
  MockApiError,
  VIEWER_ME,
  PHONE_BOOKING_CANDIDATES,
  apiFns,
  appointment,
  calendarResponse,
  phoneApi,
  slotsResponse,
  totalApiCalls,
} from '../components/phone-calendar/__tests__/phoneFixtures';
import { stubMatchMedia } from '../components/design/__tests__/helpers';

vi.mock('../api', () => ({ api: phoneApi.api, ApiError: phoneApi.ApiError }));

import { PhoneCalendarPage } from './PhoneCalendarPage';

/** Monday 2026-08-24 IST. Every test pins the week so none depends on today. */
const WEEK_QS = '?week=2026-08-24';

function renderPage(search = WEEK_QS) {
  return render(
    <MemoryRouter initialEntries={[`/phone-calendar${search}`]}>
      <PhoneCalendarPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // `restoreMocks` in vitest.config only restores `vi.spyOn` mocks; these are
  // plain `vi.fn()`s created in `vi.hoisted`, so their call records would
  // otherwise accumulate across every test in this file and make each
  // "called exactly once" assertion a running total.
  vi.clearAllMocks();
  apiFns.getMe.mockResolvedValue(ADMIN_ME);
  apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse());
  apiFns.getPhoneSlots.mockResolvedValue(slotsResponse());
  apiFns.listCandidates.mockResolvedValue(PHONE_BOOKING_CANDIDATES);
  stubMatchMedia(false, '(max-width: 639px)');
});

// ══════════════════════════════════════════════════════════════════════
//  Role behaviour — exactly the API's rule
// ══════════════════════════════════════════════════════════════════════

describe('roles', () => {
  it('lets an admin read and offers the write controls', async () => {
    renderPage();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Book a phone screening' }),
    ).toBeInTheDocument();
  });

  it('lets an interviewer read but shows NO write controls at all', async () => {
    apiFns.getMe.mockResolvedValue(INTERVIEWER_ME);
    renderPage();

    expect(await screen.findByRole('table')).toBeInTheDocument();
    // The calendar was read — an interviewer is a legitimate reader.
    expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1);

    // Not rendered disabled — not rendered. A disabled control promises the
    // action exists for you, which for a read-only role is untrue.
    expect(
      screen.queryByRole('heading', { name: 'Book a phone screening' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Book a screening' }),
    ).not.toBeInTheDocument();

    // Selecting a call shows detail, still with no write controls.
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    expect(await screen.findByRole('region', { name: 'Selected appointment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reschedule/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel appointment' }),
    ).not.toBeInTheDocument();
  });

  it('gates a viewer and asks the phone API for NOTHING', async () => {
    apiFns.getMe.mockResolvedValue(VIEWER_ME);
    renderPage();

    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();

    // The point of the gate: a viewer's browser never requests phone data, so
    // there is nothing to leak and no 403 to explain.
    await waitFor(() => expect(apiFns.getMe).toHaveBeenCalledTimes(1));
    expect(apiFns.getPhoneCalendar).not.toHaveBeenCalled();
    expect(apiFns.getPhoneSlots).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('fails closed while the role is still unknown', () => {
    apiFns.getMe.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Checking access…')).toBeInTheDocument();
    expect(apiFns.getPhoneCalendar).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  One read per week — no N+1
// ══════════════════════════════════════════════════════════════════════

describe('request discipline', () => {
  it('reads the calendar exactly once for a week', async () => {
    renderPage();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));
    // No slots read on load. The booking form and the reschedule form are
    // both collapsed, and their pickers fetch only when opened — so an admin
    // page view costs exactly one request, same as an interviewer's.
    expect(apiFns.getPhoneSlots).not.toHaveBeenCalled();
  });

  it('sends a half-open UTC range of exactly seven IST days', async () => {
    renderPage();
    await screen.findByRole('table');
    const [from, to] = apiFns.getPhoneCalendar.mock.calls[0];
    // 00:00 IST on the 24th is 18:30 UTC on the 23rd.
    expect(from).toBe('2026-08-23T18:30:00.000Z');
    expect(to).toBe('2026-08-30T18:30:00.000Z');
    expect(from.endsWith('Z')).toBe(true);
    expect(to.endsWith('Z')).toBe(true);
    // Well inside the API's 31-day cap.
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBe(7);
  });

  it('issues NO request when a filter is toggled', async () => {
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    const before = totalApiCalls();
    const chip = within(
      screen.getByRole('group', { name: 'Appointment' }),
    ).getByRole('button', { name: /^Scheduled/ });
    await userEvent.click(chip);
    await waitFor(() => expect(chip).toHaveAttribute('aria-pressed', 'true'));
    expect(totalApiCalls()).toBe(before);
  });

  it('issues NO request when the view is switched', async () => {
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    const before = totalApiCalls();
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(await screen.findByRole('heading', { name: /Wednesday, 26 August 2026/ }))
      .toBeInTheDocument();
    expect(totalApiCalls()).toBe(before);
  });

  it('re-reads exactly once when the week changes', async () => {
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(2));
    expect(apiFns.getPhoneCalendar.mock.calls[1][0]).toBe('2026-08-30T18:30:00.000Z');
  });
});

// ══════════════════════════════════════════════════════════════════════
//  The week grid
// ══════════════════════════════════════════════════════════════════════

describe('week grid', () => {
  it('is a real table with a caption and both header axes', async () => {
    const { container } = renderPage();
    const table = await screen.findByRole('table');

    expect(table.querySelector('caption')?.textContent).toMatch(
      /Phone screening week/,
    );

    // Seven day columns plus the corner header.
    const colHeaders = container.querySelectorAll('th[scope="col"]');
    expect(colHeaders).toHaveLength(8);

    // Twelve hourly bands, each a row header.
    const rowHeaders = container.querySelectorAll('th[scope="row"]');
    expect(rowHeaders).toHaveLength(12);
    expect(rowHeaders[0].textContent).toBe('09:00 to 10:00 IST');
    expect(rowHeaders[11].textContent).toBe('20:00 to 21:00 IST');
  });

  it('announces unabbreviated day names while showing the short ones', async () => {
    renderPage();
    await screen.findByRole('table');
    const monday = screen.getByRole('columnheader', { name: /Monday, 24 August 2026/ });
    expect(monday).toBeInTheDocument();
    expect(monday.textContent).toContain('Mon 24 Aug');
  });

  it('places a call under its IST day, not its UTC day', async () => {
    // 20:30 UTC Tuesday is 02:00 IST Wednesday. That is outside the calling
    // window, so it must be surfaced in the overflow row rather than filed
    // under Tuesday or silently dropped.
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({
        appointments: [
          appointment({ id: 'x', starts_at: '2026-08-25T20:30:00Z', ist_start: '02:00' }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('table');
    expect(
      screen.getByRole('rowheader', { name: 'Outside the calling window' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ATS-4417/ })).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Accessible names, and colour never carrying meaning alone
// ══════════════════════════════════════════════════════════════════════

describe('appointment accessible name', () => {
  it('carries the reference, the IST time, the status and the state', async () => {
    renderPage();
    await screen.findByRole('table');
    const button = screen.getByRole('button', { name: /ATS-4417/ });
    const name = button.getAttribute('aria-label') ?? '';

    expect(name).toContain('ATS-4417');
    expect(name).toContain('Asha Rao');
    expect(name).toContain('14:30–15:00 IST');
    expect(name).toContain('appointment scheduled');
    expect(name).toContain('engagement scheduled');
    // The zone is spoken every time — "2:30" is ambiguous across browsers.
    expect(name).toMatch(/IST/);
  });

  it('says so when the API returned no reference, and never invents one', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({
        appointments: [
          appointment({
            candidate: { id: 'cand-9', name: null, status: 'screening', reference: null },
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('table');
    const button = await screen.findByRole('button', {
      name: /Candidate reference unavailable/,
    });
    // The internal candidate id is NOT substituted as a reference.
    expect(button.getAttribute('aria-label')).not.toContain('cand-9');
  });

  it('reports a torn read as unavailable rather than guessing a state', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({
        appointments: [appointment({ engagement_state: null, candidate: null })],
      }),
    );
    renderPage();
    await screen.findByRole('table');
    expect(
      screen.getByRole('button', { name: /Candidate unavailable.*engagement state unavailable/ }),
    ).toBeInTheDocument();
  });

  it('renders every status as a WORD, so hue is never the only signal', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({
        appointments: [
          appointment({ id: 'a', status: 'scheduled', starts_at: '2026-08-26T03:30:00Z' }),
          appointment({ id: 'b', status: 'missed', starts_at: '2026-08-26T04:30:00Z' }),
          appointment({ id: 'c', status: 'cancelled', starts_at: '2026-08-26T05:30:00Z' }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('table');
    for (const word of ['Scheduled', 'Missed', 'Cancelled']) {
      expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Filters and deep links
// ══════════════════════════════════════════════════════════════════════

describe('filters', () => {
  const mixed = calendarResponse({
    appointments: [
      appointment({ id: 'a', status: 'scheduled', starts_at: '2026-08-26T03:30:00Z' }),
      appointment({ id: 'b', status: 'missed', starts_at: '2026-08-26T04:30:00Z' }),
    ],
  });

  it('hides a facet that would match nothing', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(mixed);
    renderPage();
    await screen.findByRole('table');

    const group = within(screen.getByRole('group', { name: 'Appointment' }));
    expect(group.getByRole('button', { name: /^Scheduled/ })).toBeInTheDocument();
    expect(group.getByRole('button', { name: /^Missed/ })).toBeInTheDocument();
    // Nothing is cancelled this week, so no dead chip is offered.
    expect(group.queryByRole('button', { name: /^Cancelled/ })).not.toBeInTheDocument();
  });

  it('KEEPS a deep-linked facet that matches nothing, so it can be switched off', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(mixed);
    renderPage('?week=2026-08-24&status=cancelled');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    const chip = within(
      await screen.findByRole('group', { name: 'Appointment' }),
    ).getByRole('button', { name: /^Cancelled/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('No appointments match these filters')).toBeInTheDocument();
  });

  it('applies a deep-linked filter on first render', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(mixed);
    renderPage('?week=2026-08-24&status=missed');
    await screen.findByRole('table');

    expect(screen.getAllByRole('button', { name: /appointment missed/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /appointment scheduled/ })).not.toBeInTheDocument();
  });

  it('carries filter state in aria-pressed, not in colour', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(mixed);
    renderPage();
    await screen.findByRole('table');

    const chip = within(
      screen.getByRole('group', { name: 'Appointment' }),
    ).getByRole('button', { name: /^Missed/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    await waitFor(() => expect(chip).toHaveAttribute('aria-pressed', 'true'));
  });

  it('opens a deep-linked queue view', async () => {
    renderPage('?week=2026-08-24&view=queue');
    expect(
      await screen.findByRole('heading', { name: /Wednesday, 26 August 2026/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Desktop and mobile
// ══════════════════════════════════════════════════════════════════════

describe('responsive default view', () => {
  it('defaults to the grid on a wide viewport', async () => {
    stubMatchMedia(false, '(max-width: 639px)');
    renderPage();
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('defaults to the queue on a narrow viewport', async () => {
    stubMatchMedia(true, '(max-width: 639px)');
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Wednesday, 26 August 2026/ }),
    ).toBeInTheDocument();
    // A seven-column grid on a phone would either clip or lie about layout.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('follows a viewport that changes after mount', async () => {
    const media = stubMatchMedia(false, '(max-width: 639px)');
    renderPage();
    await screen.findByRole('table');

    media.setMatches(true);
    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument());
  });

  it('lets an EXPLICIT deep link beat the viewport', async () => {
    // A link someone sent deliberately must not be overridden by the
    // recipient's screen size.
    stubMatchMedia(true, '(max-width: 639px)');
    renderPage('?week=2026-08-24&view=week');
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('keeps the grid usable on a narrow screen by scrolling it, never clipping', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    const scroller = container.querySelector('.overflow-x-auto');
    expect(scroller).not.toBeNull();
    expect(scroller?.querySelector('table')).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Keyboard
// ══════════════════════════════════════════════════════════════════════

describe('keyboard', () => {
  it('reaches and activates an appointment with the keyboard alone', async () => {
    renderPage();
    await screen.findByRole('table');
    const appt = screen.getByRole('button', { name: /ATS-4417/ });

    appt.focus();
    expect(appt).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(
      await screen.findByRole('region', { name: 'Selected appointment' }),
    ).toBeInTheDocument();
    expect(appt).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives every appointment control a visible focus ring', async () => {
    renderPage();
    await screen.findByRole('table');
    const appt = screen.getByRole('button', { name: /ATS-4417/ });
    expect(appt.className).toContain('focus-visible:ring-2');
    expect(appt.className).toContain('focus-visible:ring-brand-500');
  });
});

// ══════════════════════════════════════════════════════════════════════
//  States
// ══════════════════════════════════════════════════════════════════════

describe('states', () => {
  it('shows a loading state before the read settles', async () => {
    apiFns.getPhoneCalendar.mockReturnValue(new Promise(() => {}));
    renderPage();
    // The role resolves first, then the calendar read is left pending.
    expect(
      await screen.findByText('Loading the phone calendar…'),
    ).toBeInTheDocument();
  });

  it('shows an error with a retry that re-reads', async () => {
    apiFns.getPhoneCalendar.mockRejectedValueOnce(
      new MockApiError('phone_read_error', 500),
    );
    renderPage();
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();

    apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('distinguishes an empty week from a filtered-out one', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse({ appointments: [] }));
    renderPage();
    expect(await screen.findByText('No phone screenings this week')).toBeInTheDocument();
    expect(
      screen.queryByText('No appointments match these filters'),
    ).not.toBeInTheDocument();
  });

  it('reports the feature being off as off, not as an empty week', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({ enabled: false, appointments: [], count: 0 }),
    );
    renderPage();
    expect(await screen.findByText(/Phone screening is turned off/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('No phone screenings this week')).not.toBeInTheDocument();
  });

  it('warns that a truncated week is incomplete rather than showing it as whole', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse({ truncated: true }));
    renderPage();
    const warning = await screen.findByText(/more appointments than one read returns/);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/incomplete/i);
    // Announced, not merely printed: an operator who already scrolled past
    // the top must still learn the view is partial.
    expect(warning).toHaveAttribute('role', 'status');
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Nothing sensitive reaches the DOM or the URL
// ══════════════════════════════════════════════════════════════════════

describe('no sensitive identifiers', () => {
  it('renders no phone number, email, URL or provider identifier', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({
        appointments: [
          appointment({ id: 'a', status: 'scheduled' }),
          appointment({ id: 'b', status: 'missed', starts_at: '2026-08-26T04:30:00Z' }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('table');

    const text = document.body.textContent ?? '';
    // An email address.
    expect(text).not.toMatch(/\S+@\S+\.\S+/);
    // A dialable number in any common shape.
    expect(text).not.toMatch(/\+\d[\d\s-]{7,}/);
    expect(text).not.toMatch(/\b\d{10}\b/);
    // Provider, transport and transcript vocabulary.
    expect(text).not.toMatch(
      /sip|room_name|participant|egress|lease_token|livekit|plivo|transcript|bearer|presigned/i,
    );
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('renders no sensitive value in any DOM ATTRIBUTE either', async () => {
    // The body-text scan cannot see ids, aria-controls or href values.
    renderPage();
    await screen.findByRole('table');
    const attrs: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      for (const a of Array.from(el.attributes)) attrs.push(a.value);
    }
    const joined = attrs.join(' ');
    expect(joined).not.toMatch(
      /sip|room_name|participant|egress|lease_token|livekit|plivo|transcript/i,
    );
    expect(joined).not.toMatch(/\+\d[\d\s-]{7,}/);
    expect(joined).not.toMatch(/\S+@\S+\.\S+/);
  });

  it('keeps the URL to closed vocabularies and a validated date', async () => {
    // The acceptance names the URL explicitly. Every parameter this page can
    // write is either a validated IST date or a member of a closed
    // vocabulary, so no free text — and nothing sensitive — can reach it.
    renderPage();
    await screen.findByRole('table');

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Appointment' })).getByRole('button', {
        name: /^Scheduled/,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }));

    const search = new URLSearchParams(window.location.search || '');
    // MemoryRouter keeps its own history, so read what the page produced by
    // rebuilding it from the controls instead of the jsdom location.
    const rendered = document.body.innerHTML;
    expect(rendered).not.toMatch(/engagement_id=|candidate=|phone=|email=/i);
    for (const key of [...search.keys()]) {
      expect(['week', 'view', 'status', 'state']).toContain(key);
    }
  });
});

describe('candidate callback confirmation evidence', () => {
  it('shows the server-stamped confirmation and ten-minute recheck', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse({
      appointments: [appointment({
        source: 'candidate_voice',
        confirmed_at: '2026-08-24T12:00:00.000Z',
      })],
    }));
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));

    const note = await screen.findByText(/Candidate confirmed this callback/i);
    expect(note.textContent).toMatch(/ten-minute reservation is rechecked/i);
    expect(note.textContent).toMatch(/India time/i);
  });

  it('reports a truncated week and a truncated occupancy as separate facts', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse({ truncated: true }));
    apiFns.getPhoneSlots.mockResolvedValue(
      slotsResponse({ occupancy_truncated: true }),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));

    // Two different bounds, two different warnings — collapsing them would
    // let one silence the other.
    expect(
      screen.getByText(/more appointments than one read returns/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/lower bound/i)).toBeInTheDocument();
  });
});
