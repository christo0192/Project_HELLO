/**
 * Phone calendar — where things sit (M007/S05 T6).
 *
 * The week grid used to share its row with a 24rem booking column, which
 * left room for Mon–Wed at 1440px and scrolled the rest of the week out of
 * view. These tests pin the layout that fixed it, in terms jsdom can see
 * (structure, classes that carry the layout, focus), since it cannot measure:
 *
 *   - the grid has the content width to itself: no side column in week view,
 *     a fixed-layout table, no per-day minimum width;
 *   - booking is the header's disclosure, rendered ABOVE the grid;
 *   - a selected appointment's detail opens INLINE, under its own band, and
 *     closing it returns focus to the chip;
 *   - the week controls survive a week change (they used to unmount with the
 *     rows, dropping a keyboard user's focus).
 *
 * The 1280/1440px "all seven days visible" measurement itself is taken in the
 * browser (Playwright), where layout exists.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  ADMIN_ME,
  INTERVIEWER_ME,
  PHONE_BOOKING_CANDIDATES,
  PHONE_ROLES,
  apiFns,
  appointment,
  calendarResponse,
  phoneApi,
  slotsResponse,
} from '../components/phone-calendar/__tests__/phoneFixtures';
import { stubMatchMedia } from '../components/design/__tests__/helpers';

vi.mock('../api', () => ({ api: phoneApi.api, ApiError: phoneApi.ApiError }));

import { PhoneCalendarPage } from './PhoneCalendarPage';

function renderPage(search = '?week=2026-08-24') {
  return render(
    <MemoryRouter initialEntries={[`/phone-calendar${search}`]}>
      <PhoneCalendarPage />
    </MemoryRouter>,
  );
}

/** Two calls in different bands: 14:30 IST Wednesday and 09:00 IST Monday. */
const TWO_BANDS = calendarResponse({
  appointments: [
    appointment({ id: 'wed', starts_at: '2026-08-26T09:00:00Z', ends_at: '2026-08-26T09:30:00Z' }),
    appointment({
      id: 'mon',
      starts_at: '2026-08-24T03:30:00Z',
      ends_at: '2026-08-24T04:00:00Z',
      status: 'cancelled',
      candidate: { id: 'c2', name: 'Ravi Menon', status: 'under_review', reference: 'ATS-9002' },
    }),
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  apiFns.getMe.mockResolvedValue(ADMIN_ME);
  apiFns.getPhoneCalendar.mockResolvedValue(TWO_BANDS);
  apiFns.getPhoneSlots.mockResolvedValue(slotsResponse());
  apiFns.listCandidates.mockResolvedValue(PHONE_BOOKING_CANDIDATES);
  apiFns.listRoles.mockResolvedValue(PHONE_ROLES);
  stubMatchMedia(false, '(max-width: 639px)');
});

describe('the week grid has the width to itself', () => {
  it('renders no side column beside the grid in week view', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('lays the seven days out as equal fixed columns, with no per-day minimum', async () => {
    const { container } = renderPage();
    const table = await screen.findByRole('table');
    expect(table.className).toMatch(/(^|\s)table-fixed(\s|$)/);
    // A fixed gutter plus one column per day.
    expect(container.querySelectorAll('colgroup col')).toHaveLength(8);
    // The old 9rem floor per day is what pushed Thu–Sun out of view.
    expect(container.querySelector('td[class*="min-w-"]')).toBeNull();
    // Below `sm` only, the grid keeps a floor and scrolls inside its panel.
    expect(table.className).toContain('max-sm:!min-w-[46rem]');
  });

  it('shows the band start on screen and speaks the whole band', async () => {
    renderPage();
    await screen.findByRole('table');
    const first = screen.getAllByRole('rowheader')[0];
    expect(first).toHaveAccessibleName('09:00 to 10:00 IST');
    const hidden = first.querySelector('.sr-only');
    expect(hidden?.textContent).toBe(' to 10:00 IST');
  });

  it('leads a chip with the candidate name, not a reference cut to fit', async () => {
    renderPage();
    await screen.findByRole('table');
    const chip = screen.getByRole('button', { name: /ATS-4417/ });
    // The accessible name still carries the reference in full…
    expect(chip).toHaveAccessibleName(/ATS-4417 — Asha Rao/);
    // …while the visible text names the person.
    expect(chip.textContent).toContain('Asha Rao');
    expect(chip.textContent).not.toContain('ATS-4417');
    // Times are tabular so a column of them lines up.
    expect(chip.querySelector('.tabular-nums')?.textContent).toMatch(/^14:30/);
  });
});

describe('booking opens from the page header, above the grid', () => {
  it('discloses the form below the header and returns focus on close', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    const book = screen.getByRole('button', { name: 'Book a screening' });
    expect(screen.queryByRole('region', { name: 'Book a phone screening' })).not.toBeInTheDocument();

    await userEvent.click(book);
    const panel = screen.getByRole('region', { name: 'Book a phone screening' });
    expect(book).toHaveAttribute('aria-expanded', 'true');
    expect(book).toHaveAttribute('aria-controls', panel.id);
    // Above the grid in document order, so it is also above it on screen.
    expect(panel.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(within(panel).getByRole('button', { name: 'Close booking form' }));
    expect(screen.queryByRole('region', { name: 'Book a phone screening' })).not.toBeInTheDocument();
    expect(book).toHaveFocus();
    expect(book).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers an interviewer no booking entry point at all', async () => {
    apiFns.getMe.mockResolvedValue(INTERVIEWER_ME);
    renderPage();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Book a screening' })).not.toBeInTheDocument();
  });
});

describe('the detail opens where the chip is', () => {
  it('renders the detail as a row directly under the band that holds the chip', async () => {
    renderPage();
    await screen.findByRole('table');
    const chip = screen.getByRole('button', { name: /ATS-4417/ });
    await userEvent.click(chip);

    const region = await screen.findByRole('region', { name: 'Selected appointment' });
    const detailRow = region.closest('tr');
    expect(detailRow).not.toBeNull();
    expect(region.closest('table')).toBe(screen.getByRole('table'));
    // The row above the detail is the band the chip sits in.
    expect(detailRow?.previousElementSibling?.contains(chip)).toBe(true);
    // One cell spanning the gutter and all seven days.
    expect(detailRow?.querySelector('td')?.getAttribute('colspan')).toBe('8');
  });

  it('moves with the selection to the other band', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    const other = screen.getByRole('button', { name: /ATS-9002/ });
    await userEvent.click(other);
    const regions = screen.getAllByRole('region', { name: 'Selected appointment' });
    expect(regions).toHaveLength(1);
    expect(regions[0].closest('tr')?.previousElementSibling?.contains(other)).toBe(true);
  });

  it('closes from its own button and hands focus back to the chip', async () => {
    renderPage();
    await screen.findByRole('table');
    const chip = screen.getByRole('button', { name: /ATS-4417/ });
    await userEvent.click(chip);
    const region = await screen.findByRole('region', { name: 'Selected appointment' });

    await userEvent.click(within(region).getByRole('button', { name: 'Close appointment details' }));
    expect(screen.queryByRole('region', { name: 'Selected appointment' })).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('treats the chip as a real toggle: pressing it again closes the detail', async () => {
    renderPage();
    await screen.findByRole('table');
    const chip = screen.getByRole('button', { name: /ATS-4417/ });
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('region', { name: 'Selected appointment' })).not.toBeInTheDocument();
  });

  it('names the person and shows the pipeline status in words, raw value on hover', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-9002/ }));
    const region = await screen.findByRole('region', { name: 'Selected appointment' });
    expect(within(region).getByRole('heading', { name: 'Ravi Menon' })).toBeInTheDocument();
    expect(within(region).getByText('ATS-9002')).toBeInTheDocument();
    const status = within(region).getByText('Under review');
    expect(status).toHaveAttribute('title', 'under_review');
    expect(region.textContent).not.toContain('under_review');
  });

  it('follows the grid instead of opening inside it on a phone, where the grid scrolls sideways', async () => {
    stubMatchMedia(true, '(max-width: 639px)');
    renderPage('?week=2026-08-24&view=week');
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    const region = await screen.findByRole('region', { name: 'Selected appointment' });
    expect(region.closest('table')).toBeNull();
  });
});

describe('the queue keeps its detail beside the list', () => {
  it('invites a selection, then shows the detail in the side column', async () => {
    renderPage('?week=2026-08-24&view=queue');
    await screen.findByRole('heading', { name: /Monday, 24 August 2026/ });
    expect(screen.getByText(/Select an appointment to see its details/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    const region = await screen.findByRole('region', { name: 'Selected appointment' });
    expect(region.closest('aside')).not.toBeNull();
    expect(screen.queryByText(/Select an appointment to see its details/)).not.toBeInTheDocument();
  });

  it('reads each queue row as one line: time, name, reference, status', async () => {
    renderPage('?week=2026-08-24&view=queue');
    await screen.findByRole('heading', { name: /Monday, 24 August 2026/ });
    const row = screen.getByRole('button', { name: /ATS-4417/ });
    expect(row.textContent).toMatch(/14:30–15:00.*Asha Rao.*ATS-4417.*Scheduled/);
  });
});

describe('the week controls never unmount under the operator', () => {
  it('keeps "Next week" mounted and focused while the next week loads', async () => {
    renderPage();
    await screen.findByRole('table');
    apiFns.getPhoneCalendar.mockReturnValue(new Promise(() => {}));

    const next = screen.getByRole('button', { name: 'Next week' });
    await userEvent.click(next);
    await screen.findByText('Loading the phone calendar…');
    expect(next).toBeInTheDocument();
    expect(next).toHaveFocus();
    // The filter band waits for rows; the week band stays.
    expect(screen.queryByRole('group', { name: 'Appointment' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Week' })).toBeInTheDocument();
  });

  it('names the week in the one date format the page uses', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(screen.getByRole('heading', { name: /^Mon 24 Aug – Sun 30 Aug( \d{4})?$/ })).toBeInTheDocument();
  });

  it('shows the week controls even when the read fails', async () => {
    apiFns.getPhoneCalendar.mockRejectedValue(new phoneApi.ApiError('phone_read_error', 500));
    renderPage();
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Previous week' })).toBeInTheDocument();
  });
});
