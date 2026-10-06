/**
 * CandidatesPage — phone progress in the status column, filters and counts.
 *
 * `candidates.status` stays `queued` for a whole phone cycle; the list API
 * adds `dial_count` and the latest cycle's `phone_state`. The page reads both
 * through ONE helper (`candidateDisplayStatus`), so the row badge, its
 * tooltip, the next action, the status bar's counts and the status filter
 * always agree. Covers: "Queued (dialed N)", plain "Queued" when the count is
 * unknown or zero, "Abandoned: no answer" as its own always-offered filter
 * (with deep link), the other phone outcomes only when present or selected,
 * a decided status never overridden, and axe.
 */

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidatesPage } from './CandidatesPage';
import { mockCandidate, mockRole } from '../test/helpers';
import { EMPTY_FUNNEL_TOTALS } from '../test/funnel';

const mockApi = {
  listRoles: vi.fn(),
  listCandidates: vi.fn(),
  uploadResume: vi.fn(),
  getScreeningFunnel: vi.fn(),
  listAshbyMappings: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    listCandidates: (...args: any[]) => mockApi.listCandidates(...args),
    uploadResume: (...args: any[]) => mockApi.uploadResume(...args),
    getScreeningFunnel: (...args: any[]) => mockApi.getScreeningFunnel(...args),
    listAshbyMappings: (...args: any[]) => mockApi.listAshbyMappings(...args),
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const CANDIDATES = [
  { ...mockCandidate, id: 'c-new', name: 'New Nia', status: 'new', dial_count: 0, phone_state: null },
  {
    ...mockCandidate,
    id: 'c-dialled',
    name: 'Dialled Dee',
    status: 'queued',
    dial_count: 3,
    phone_state: 'awaiting_retry',
    phone_state_reason: null,
    last_dialed_at: '2026-10-01T09:30:00Z',
  },
  {
    ...mockCandidate,
    id: 'c-unknown',
    name: 'Unknown Uma',
    status: 'queued',
    // The server could not stand behind a count: plain "Queued".
    dial_count: null,
    phone_state: null,
  },
  {
    ...mockCandidate,
    id: 'c-abandoned',
    name: 'Abandoned Abe',
    status: 'queued',
    dial_count: 5,
    phone_state: 'abandoned_no_answer',
    phone_state_reason: 'no_answer_budget_exhausted',
    last_dialed_at: '2026-10-02T10:00:00Z',
  },
  {
    ...mockCandidate,
    id: 'c-screened',
    name: 'Screened Sam',
    // A later cycle failed, but the scored outcome wins.
    status: 'screened',
    dial_count: 4,
    phone_state: 'failed',
  },
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderPage(entry = '/candidates') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CandidatesPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const rowFor = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;
const statusGroup = () => screen.getByRole('group', { name: 'Filter by status' });
const rowNames = () =>
  Array.from(screen.getByRole('table').querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('a')?.textContent ?? '',
  );

describe('CandidatesPage phone status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('badges a dialled queued row with its reached-dial count', async () => {
    renderPage();
    await screen.findByText('Dialled Dee');
    const badge = within(rowFor('Dialled Dee')).getByText('Queued (dialed 3)');
    expect(badge).toHaveAttribute('title', expect.stringContaining('Status: queued'));
    expect(badge).toHaveAttribute('title', expect.stringContaining('Phone cycle – Awaiting retry'));
    expect(badge).toHaveAttribute('title', expect.stringContaining('Last dialed'));
  });

  it('shows plain "Queued" when the dial count is unknown', async () => {
    renderPage();
    await screen.findByText('Unknown Uma');
    const row = rowFor('Unknown Uma');
    expect(within(row).getByText('Queued')).toBeInTheDocument();
    expect(within(row).queryByText(/dialed/)).toBeNull();
    // ...and the page says once that some statuses may be the stored value,
    // so a failed phone read never silently turns "Abandoned" into "Queued".
    expect(screen.getByText(/Phone progress could not be loaded for some candidates/)).toBeInTheDocument();
    expect(within(row).getByText('Queued')).toHaveAttribute(
      'title',
      expect.stringContaining('Phone progress unavailable'),
    );
  });

  it('shows no phone-progress notice when every count is known', async () => {
    mockApi.listCandidates.mockResolvedValue(CANDIDATES.filter((c) => c.dial_count !== null));
    renderPage();
    await screen.findByText('Dialled Dee');
    expect(screen.queryByText(/Phone progress could not be loaded/)).toBeNull();
  });

  it('names an abandoned cycle, with the reason in the tooltip', async () => {
    renderPage();
    await screen.findByText('Abandoned Abe');
    const row = rowFor('Abandoned Abe');
    const badge = within(row).getByText('Abandoned: no answer');
    expect(badge).toHaveAttribute('title', expect.stringContaining('No answer after every attempt'));
    // The tooltip's facts reach a screen reader too (sr-only, beside the badge).
    expect(
      within(row).getByText(/^, No answer after every attempt · Phone reached 5 times/, { selector: '.sr-only' }),
    ).toBeInTheDocument();
    // Its next action restates the outcome; it is not a "Queued" row.
    expect(within(row).getByText('No answer after every attempt', { selector: '.sr-only' })).toBeInTheDocument();
    expect(within(row).queryByText('Queued for screening')).toBeNull();
  });

  it('never overrides a decided status with a later phone outcome', async () => {
    renderPage();
    await screen.findByText('Screened Sam');
    const row = rowFor('Screened Sam');
    expect(within(row).getByText('Screened')).toBeInTheDocument();
    expect(within(row).queryByText(/Phone screen failed|dialed/)).toBeNull();
    // The review link still goes to the Review tab.
    expect(within(row).getByRole('link', { name: /Review & decide/ })).toHaveAttribute(
      'href',
      '/candidates/c-screened?tab=review',
    );
  });

  it('counts by display status: abandoned leaves "Queued"', async () => {
    renderPage();
    await screen.findByText('Dialled Dee');
    const group = statusGroup();
    expect(group.querySelector('[data-segment-value="queued"]')?.textContent).toBe('2');
    expect(group.querySelector('[data-segment-value="abandoned_no_answer"]')?.textContent).toBe('1');
    expect(group.querySelector('[data-segment-value="screened"]')?.textContent).toBe('1');
    // The segments still partition the whole loaded set.
    expect(group.querySelector('[data-segment-value="__remainder"]')).toBeNull();
  });

  it('always offers "Abandoned: no answer", even at zero', async () => {
    mockApi.listCandidates.mockResolvedValue([CANDIDATES[0], CANDIDATES[1]]);
    renderPage();
    await screen.findByText('Dialled Dee');
    const toggle = within(statusGroup()).getByRole('button', { name: /^Abandoned: no answer/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(statusGroup().querySelector('[data-segment-value="abandoned_no_answer"]')?.textContent).toBe('0');
  });

  it('filters to abandoned candidates and writes ?status=abandoned_no_answer', async () => {
    renderPage();
    await screen.findByText('Dialled Dee');
    fireEvent.click(within(statusGroup()).getByRole('button', { name: /^Abandoned: no answer/ }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('?status=abandoned_no_answer'));
    expect(rowNames()).toEqual(['Abandoned Abe']);
    expect(screen.getByRole('button', { name: 'Remove filter Abandoned: no answer' })).toBeInTheDocument();
  });

  it('honours the deep link, and Queued no longer includes the abandoned row', async () => {
    renderPage('/candidates?status=abandoned_no_answer');
    await screen.findByText('Abandoned Abe');
    expect(rowNames()).toEqual(['Abandoned Abe']);
    expect(
      within(statusGroup()).getByRole('button', { name: /^Abandoned: no answer/ }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('a queued filter keeps dialled rows and drops the abandoned one', async () => {
    renderPage('/candidates?status=queued');
    await screen.findByText('Dialled Dee');
    expect(rowNames().sort()).toEqual(['Dialled Dee', 'Unknown Uma']);
  });

  it('shows the other phone outcomes only when present or selected', async () => {
    renderPage();
    await screen.findByText('Dialled Dee');
    for (const name of [/^Wrong number/, /^Opted out/, /^Phone screen failed/, /^Phone screen cancelled/]) {
      expect(within(statusGroup()).queryByRole('button', { name })).toBeNull();
    }
  });

  it('shows a present phone outcome, and a selected one at zero', async () => {
    mockApi.listCandidates.mockResolvedValue([
      ...CANDIDATES,
      { ...mockCandidate, id: 'c-wrong', name: 'Wrong Wes', status: 'queued', dial_count: 1, phone_state: 'wrong_number' },
    ]);
    const { unmount } = renderPage();
    await screen.findByText('Wrong Wes');
    expect(within(statusGroup()).getByRole('button', { name: /^Wrong number/ })).toBeInTheDocument();
    // The badge (its title starts with the raw status), not the next-action cell.
    expect(
      within(rowFor('Wrong Wes')).getByText('Wrong number', { selector: 'span[title^="Status:"]' }),
    ).toBeInTheDocument();
    unmount();

    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
    renderPage('/candidates?status=opted_out');
    await screen.findByText('No candidates match these filters');
    expect(within(statusGroup()).getByRole('button', { name: /^Opted out/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('M013 S02: names a dropped-before-screening cycle, never "Screening", with its own filter', async () => {
    mockApi.listCandidates.mockResolvedValue([
      ...CANDIDATES,
      {
        ...mockCandidate,
        id: 'c-dropped',
        name: 'Dropped Dora',
        // The 0118 relabel leaves the stored status `screening`, never `queued`.
        status: 'screening',
        dial_count: 2,
        phone_state: 'failed',
        phone_state_reason: 'screening_abandoned',
      },
    ]);
    renderPage();
    await screen.findByText('Dropped Dora');
    const row = rowFor('Dropped Dora');
    expect(
      within(row).getByText('Abandoned: dropped before screening', { selector: 'span[title^="Status:"]' }),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/^Screening/)).toBeNull();
    expect(within(row).queryByText('Screening in progress')).toBeNull();
    expect(within(row).queryByText(/Phone screen failed/)).toBeNull();
    const group = statusGroup();
    expect(group.querySelector('[data-segment-value="screening_abandoned"]')?.textContent).toBe('1');
    // Dora is not counted as Screening: nobody else here is either.
    expect(group.querySelector('[data-segment-value="screening"]')?.textContent).toBe('0');
    fireEvent.click(within(group).getByRole('button', { name: /^Abandoned: dropped before screening/ }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('?status=screening_abandoned'));
    expect(rowNames()).toEqual(['Dropped Dora']);
  });

  it('has no axe violations with phone outcomes', async () => {
    const { container } = renderPage();
    await screen.findByText('Abandoned Abe');
    await expect(container).toHaveNoViolations();
  });
});
