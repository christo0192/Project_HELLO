/**
 * CandidatesPage — free-text search (`?q=`).
 *
 * Covers: the labelled searchbox in a search landmark, debounced filtering
 * that is written to the URL with REPLACE, deep links, composition with the
 * other filters, every way of clearing it (chip ×, Clear all, the clear
 * button, Escape, the empty state's "Clear search"), URL → input sync on
 * Back, phone search only where the payload carries a phone, pagination
 * reset, the live region, axe, and — the privacy guard — that the query never
 * reaches the API.
 */

import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
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
  mockCandidate, // Jane Doe, jane@example.com, +1234567890, new
  {
    ...mockCandidate,
    id: 'c-screened',
    name: 'Screened Sam',
    email: 'sam@example.com',
    phone_e164: '+919876543210',
    status: 'screened',
    latest_recommendation: 'advance',
    latest_score: 82,
  },
  {
    ...mockCandidate,
    id: 'c-screening',
    name: 'Screening Sára',
    email: 'sara@acme.io',
    phone_e164: null,
    status: 'screening',
    latest_recommendation: 'reject',
    latest_score: 41,
  },
];

function LocationProbe() {
  const location = useLocation();
  const navType = useNavigationType();
  return (
    <>
      <output data-testid="location">{location.search}</output>
      <output data-testid="nav-type">{navType}</output>
    </>
  );
}

/** A Back button the test can press, standing in for the browser's. */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      test-back
    </button>
  );
}

function renderPage(entries: string[] = ['/candidates'], extra: ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <CandidatesPage />
      <LocationProbe />
      {extra}
    </MemoryRouter>,
  );
}

const searchbox = () => screen.getByRole('searchbox', { name: 'Search candidates' });
const location = () => screen.getByTestId('location').textContent;
const rowNames = () =>
  Array.from(screen.getByRole('table').querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('a')?.textContent ?? '',
  );

function type(value: string) {
  fireEvent.change(searchbox(), { target: { value } });
}

describe('CandidatesPage search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('is a labelled searchbox inside a search landmark', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const landmark = screen.getByRole('search');
    expect(within(landmark).getByRole('searchbox', { name: 'Search candidates' })).toBe(searchbox());
    expect(searchbox()).toHaveAttribute('maxLength', '100');
    expect(searchbox()).toHaveAccessibleDescription(/results update as you type/i);
    // Not a form: Enter has nothing to submit.
    expect(searchbox().closest('form')).toBeNull();
  });

  it('filters as you type, then writes ?q= to the URL with REPLACE', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    type('sam');
    await waitFor(() => expect(location()).toBe('?q=sam'));
    expect(screen.getByTestId('nav-type').textContent).toBe('REPLACE');
    expect(rowNames()).toEqual(['Screened Sam']);
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('matches email and is case/accent-insensitive', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    type('ACME.io');
    await waitFor(() => expect(rowNames()).toEqual(['Screening Sára']));
    type('sara');
    await waitFor(() => expect(location()).toBe('?q=sara'));
    expect(rowNames()).toEqual(['Screening Sára']);
  });

  it('applies a ?q= deep link: prefilled input, count, and a removable chip', async () => {
    renderPage(['/candidates?q=sam']);
    await screen.findByText('Screened Sam');
    expect(searchbox()).toHaveValue('sam');
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Search: “sam”')).toBeInTheDocument();
  });

  it('composes with the other filters (AND)', async () => {
    renderPage(['/candidates?status=screened&q=sara']);
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('keeps q when a status toggle rebuilds the URL', async () => {
    renderPage(['/candidates?q=s']);
    await screen.findByText('Screened Sam');
    const group = screen.getByRole('group', { name: 'Filter by status' });
    fireEvent.click(within(group).getByRole('button', { name: /^Screened/ }));
    await waitFor(() => expect(location()).toBe('?status=screened&q=s'));
    expect(rowNames()).toEqual(['Screened Sam']);
    expect(searchbox()).toHaveValue('s');
  });

  it('says what was searched when the search alone matches nothing, and "Clear search" restores', async () => {
    renderPage(['/candidates?q=zzz']);
    expect(await screen.findByText('No candidates match “zzz”')).toBeInTheDocument();
    expect(screen.getByText('Search covers name, email and phone.')).toBeInTheDocument();
    // The empty state's button, not the one inside the search box.
    const landmark = screen.getByRole('search');
    const emptyStateClear = screen
      .getAllByRole('button', { name: 'Clear search' })
      .find((b) => !landmark.contains(b))!;
    expect(emptyStateClear).toBeTruthy();
    fireEvent.click(emptyStateClear);
    await waitFor(() => expect(location()).toBe(''));
    expect(searchbox()).toHaveValue('');
    expect(rowNames()).toEqual(['Jane Doe', 'Screened Sam', 'Screening Sára']);
  });

  it('clears from the chip ×, input and URL both', async () => {
    renderPage(['/candidates?q=sam']);
    await screen.findByText('Screened Sam');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: “sam”' }));
    await waitFor(() => expect(location()).toBe(''));
    expect(searchbox()).toHaveValue('');
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('clears from "Clear all", input included', async () => {
    renderPage(['/candidates?status=screened&q=sam']);
    await screen.findByText('Screened Sam');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(location()).toBe(''));
    expect(searchbox()).toHaveValue('');
  });

  it('clears from the clear button, returning focus to the box', async () => {
    renderPage(['/candidates?q=sam']);
    await screen.findByText('Screened Sam');
    const landmark = screen.getByRole('search');
    fireEvent.click(within(landmark).getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(location()).toBe(''));
    expect(searchbox()).toHaveValue('');
    expect(searchbox()).toHaveFocus();
    // Nothing to clear, so no clear button.
    expect(within(landmark).queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('clears on Escape', async () => {
    renderPage(['/candidates?q=sam']);
    await screen.findByText('Screened Sam');
    fireEvent.keyDown(searchbox(), { key: 'Escape' });
    await waitFor(() => expect(location()).toBe(''));
    expect(searchbox()).toHaveValue('');
  });

  it('follows the URL on Back (URL → input)', async () => {
    renderPage(['/candidates?q=sam', '/candidates'], <BackButton />);
    await screen.findByText('Jane Doe');
    expect(searchbox()).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'test-back' }));
    await waitFor(() => expect(searchbox()).toHaveValue('sam'));
    expect(rowNames()).toEqual(['Screened Sam']);
  });

  it('does not eat a trailing space while typing', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    type('jane ');
    await waitFor(() => expect(location()).toBe('?q=jane'));
    expect(searchbox()).toHaveValue('jane ');
  });

  describe('phone', () => {
    it('matches phone digits when the payload carries a phone', async () => {
      renderPage();
      await screen.findByText('Jane Doe');
      expect(searchbox()).toHaveAttribute('placeholder', 'Name, email or phone');
      type('+91 98765 43210');
      await waitFor(() => expect(rowNames()).toEqual(['Screened Sam']));
    });

    it('never offers or matches phone when every phone is redacted', async () => {
      mockApi.listCandidates.mockResolvedValue(
        CANDIDATES.map((c) => ({ ...c, phone_e164: null })),
      );
      renderPage(['/candidates?q=98765']);
      expect(await screen.findByText('No candidates match “98765”')).toBeInTheDocument();
      expect(searchbox()).toHaveAttribute('placeholder', 'Name or email');
      expect(screen.getByText('Search covers name and email.')).toBeInTheDocument();
    });
  });

  it('never sends the query to the API', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    type('sam');
    await waitFor(() => expect(location()).toBe('?q=sam'));
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);
    expect(mockApi.listCandidates).toHaveBeenCalledWith(undefined);
    const everyArg = Object.values(mockApi).flatMap((fn) => fn.mock.calls.flat());
    expect(JSON.stringify(everyArg)).not.toContain('sam');
  });

  it('returns to page 1 when the search changes', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ...mockCandidate,
      id: `p-${i}`,
      name: `Person ${String(i + 1).padStart(2, '0')}`,
      email: `p${i}@example.com`,
    }));
    mockApi.listCandidates.mockResolvedValue(many);
    renderPage();
    await screen.findByText('Person 01');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Person 11');
    type('person');
    await waitFor(() => expect(location()).toBe('?q=person'));
    expect(await screen.findByText('Person 01')).toBeInTheDocument();
    expect(screen.queryByText('Person 11')).not.toBeInTheDocument();
  });

  it('announces the match count (never the query) in a live region', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const live = Array.from(document.querySelectorAll('p[role="status"]')).find((p) =>
      p.classList.contains('sr-only'),
    )!;
    expect(live).toBeTruthy();
    expect(live.textContent).toBe('');
    type('sam');
    await waitFor(() => expect(live.textContent).toBe('1 candidate matches'));
    type('zzz');
    await waitFor(() => expect(live.textContent).toBe('No candidates match'));
    expect(live.textContent).not.toContain('zzz');
  });

  it('has no axe violations with a search active, and in the no-match state', async () => {
    const { container, unmount } = renderPage(['/candidates?q=sam']);
    await screen.findByText('Screened Sam');
    await expect(container).toHaveNoViolations();
    unmount();
    const second = renderPage(['/candidates?q=zzz']);
    await screen.findByText('No candidates match “zzz”');
    await act(async () => {});
    await expect(second.container).toHaveNoViolations();
  });
});
