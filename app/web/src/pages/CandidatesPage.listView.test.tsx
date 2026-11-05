/**
 * The list as a place: page, size and sort live in the URL, Back returns to
 * them, shells being read step aside for named people, and every verdict is the
 * shared mark.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidatesPage } from './CandidatesPage';
import { pickOption } from '../components/design/__tests__/helpers';
import { mockCandidate, mockRole } from '../test/helpers';
import { EMPTY_FUNNEL_TOTALS } from '../test/funnel';

const mockApi = {
  listRoles: vi.fn(),
  listCandidates: vi.fn(),
  uploadResume: vi.fn(),
  getScreeningFunnel: vi.fn(),
};

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: new Proxy({}, { get: (_t, prop: string) => (mockApi as Record<string, unknown>)[prop] }),
  };
});

const row = (i: number, extra: object = {}) => ({
  ...mockCandidate,
  id: `c-${i}`,
  name: `Person ${i}`,
  email: `person${i}@example.com`,
  created_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
  ...extra,
});

function Where() {
  const { search, state } = useLocation();
  return (
    <>
      <span data-testid="search">{search}</span>
      <span data-testid="state">{JSON.stringify(state)}</span>
    </>
  );
}

function renderPage(entry = '/candidates') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CandidatesPage />
      <Where />
    </MemoryRouter>,
  );
}

const names = () =>
  within(screen.getByRole('table'))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
    .filter((text) => !/^(Review|Start screening)/.test(text));

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listRoles.mockResolvedValue([mockRole]);
  mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  mockApi.listCandidates.mockResolvedValue(Array.from({ length: 25 }, (_, i) => row(i)));
});

describe('page and size in the URL', () => {
  it('opens on the page the URL names', async () => {
    renderPage('/candidates?page=3');
    await screen.findByText('Person 20');
    expect(screen.getByRole('navigation', { name: 'candidates pagination' })).toHaveTextContent(/21–25/);
  });

  it('writes the next page to the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Person 0');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?page=2'));
    expect(screen.getByText('Person 10')).toBeInTheDocument();
  });

  it('writes the size, goes back to page 1 and keeps the filters', async () => {
    const user = userEvent.setup();
    renderPage('/candidates?status=new&page=2');
    await screen.findByText('Person 10');
    await pickOption(user, /^Rows per page/, '25');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?status=new&size=25'));
  });

  it('keeps the size and drops the page when a filter changes', async () => {
    const user = userEvent.setup();
    renderPage('/candidates?size=25&page=1');
    await screen.findByText('Person 0');
    await user.click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: /^New/ }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?status=new&size=25'));
  });

  it('keeps a size chosen on this page when a filter changes next', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Person 0');
    await pickOption(user, /^Rows per page/, '25');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?size=25'));
    await user.click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: /^New/ }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?status=new&size=25'));
  });

  it('ignores a page or size it cannot honour', async () => {
    renderPage('/candidates?page=-2&size=7');
    await screen.findByText('Person 0');
    expect(screen.getByRole('navigation', { name: 'candidates pagination' })).toHaveTextContent(/1–10/);
  });
});

describe('the way back', () => {
  it('hands every candidate link the address of the list', async () => {
    renderPage('/candidates?status=new&page=2');
    const link = await screen.findByRole('link', { name: 'Person 10' });
    await userEvent.setup().click(link);
    await waitFor(() =>
      expect(screen.getByTestId('state').textContent).toBe(JSON.stringify({ listSearch: '?status=new&page=2' })),
    );
  });
});

describe('sorting', () => {
  beforeEach(() => {
    mockApi.listCandidates.mockResolvedValue([
      row(1, { status: 'screened', latest_score: 40, latest_recommendation: 'reject' }),
      row(2, { status: 'screened', latest_score: 90, latest_recommendation: 'advance' }),
      row(3, { status: 'new', latest_score: null, latest_recommendation: null }),
      row(4, { status: 'screened', latest_score: 60, latest_recommendation: 'hold' }),
    ]);
  });

  const header = (name: RegExp) => screen.getByRole('columnheader', { name });

  it('sorts by score, highest first, with the unscored last, and says so', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Person 1');
    expect(header(/^Recommendation/)).toHaveAttribute('aria-sort', 'none');
    await user.click(within(header(/^Recommendation/)).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?sort=score'));
    expect(header(/^Recommendation/)).toHaveAttribute('aria-sort', 'descending');
    expect(names()).toEqual(['Person 2', 'Person 4', 'Person 1', 'Person 3']);
  });

  it('flips on the second press and hands the order back on the third', async () => {
    const user = userEvent.setup();
    renderPage('/candidates?sort=score');
    await screen.findByText('Person 1');
    await user.click(within(header(/^Recommendation/)).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?sort=score&dir=asc'));
    expect(names()).toEqual(['Person 1', 'Person 4', 'Person 2', 'Person 3']);
    await user.click(within(header(/^Recommendation/)).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
    expect(header(/^Recommendation/)).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts by waiting, longest first', async () => {
    renderPage('/candidates?sort=waiting');
    await screen.findByText('Person 1');
    expect(header(/^Waiting/)).toHaveAttribute('aria-sort', 'descending');
    expect(names()).toEqual(['Person 1', 'Person 2', 'Person 3', 'Person 4']);
  });
});

describe('waiting', () => {
  it('prints how long a candidate in progress has waited, and a dash once they are done', async () => {
    mockApi.listCandidates.mockResolvedValue([
      row(1, { status: 'screened', created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      row(2, { status: 'rejected' }),
    ]);
    renderPage();
    const waiting = (name: string) => {
      const cells = screen.getByRole('link', { name }).closest('tr')!.querySelectorAll('td');
      return cells[cells.length - 2].textContent;
    };
    await screen.findByText('Person 1');
    expect(waiting('Person 1')).toBe('3 d');
    expect(waiting('Person 2')).toBe('—');
  });
});

describe('arrivals', () => {
  const shell = (i: number, minutes: number, extra: object = {}) =>
    row(i, {
      name: null,
      email: null,
      status: 'queued',
      resume_review: 'processing',
      created_at: new Date(Date.now() - minutes * 60_000).toISOString(),
      ...extra,
    });

  it('says how many are being read and how old the oldest is, once, above the rows', async () => {
    mockApi.listCandidates.mockResolvedValue([shell(1, 3), shell(2, 22), row(3)]);
    renderPage();
    await screen.findByText('Person 3');
    expect(screen.getByText(/Arriving from Ashby: 2 candidates being read, oldest 22 min\./)).toBeInTheDocument();
  });

  it('starts the rows at a named person and leaves nobody out', async () => {
    mockApi.listCandidates.mockResolvedValue([shell(1, 3), row(2), shell(3, 5), row(4)]);
    renderPage();
    await screen.findByText('Person 2');
    expect(names()).toEqual(['Person 2', 'Person 4', 'Reading resume · 3 min', 'Reading resume · 5 min']);
  });

  it('links to the filter that shows every one of them, phone intakes included', async () => {
    const user = userEvent.setup();
    mockApi.listCandidates.mockResolvedValue([
      shell(1, 3),
      shell(2, 6, { resume_review: null, intake_type: 'phone_parsing' }),
      row(3),
    ]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?arriving=1'));
    expect(screen.queryByText(/Arriving from Ashby:/)).not.toBeInTheDocument();
    expect(names()).toEqual(['Reading resume · 3 min', 'Reading Ashby profile · 6 min']);
    await user.click(screen.getByRole('button', { name: 'Remove filter Arriving from Ashby' }));
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
  });

  it('counts only the rows under it, so a filter that hides them hides the line', async () => {
    mockApi.listCandidates.mockResolvedValue([shell(1, 3), row(2, { status: 'screened' })]);
    renderPage('/candidates?status=screened');
    await screen.findByText('Person 2');
    expect(screen.queryByText(/Arriving from Ashby/)).not.toBeInTheDocument();
  });

  it('prints nothing when nobody is arriving', async () => {
    renderPage();
    await screen.findByText('Person 0');
    expect(screen.queryByText(/Arriving from Ashby/)).not.toBeInTheDocument();
  });

  it('names a phone intake by what is being read', async () => {
    mockApi.listCandidates.mockResolvedValue([
      shell(1, 6, { resume_review: null, intake_type: 'phone_parsing' }),
      row(2),
    ]);
    renderPage();
    expect(await screen.findByRole('link', { name: 'Reading Ashby profile · 6 min' })).toBeInTheDocument();
  });

  it('counts a phone-intake batch, with its null resume review, and starts at a named person', async () => {
    mockApi.listCandidates.mockResolvedValue([
      shell(1, 8, { resume_review: null, intake_type: 'phone_parsing' }),
      shell(2, 9, { resume_review: null, intake_type: 'phone_parsing' }),
      row(3),
    ]);
    renderPage();
    await screen.findByText('Person 3');
    expect(screen.getByText(/Arriving from Ashby: 2 candidates being read, oldest 9 min\./)).toBeInTheDocument();
    expect(names()).toEqual(['Person 3', 'Reading Ashby profile · 8 min', 'Reading Ashby profile · 9 min']);
  });
});

describe('the page itself', () => {
  it('prints every verdict as the shared mark, in ink', async () => {
    mockApi.listCandidates.mockResolvedValue([
      row(1, { status: 'screened', latest_score: 72, latest_recommendation: 'advance' }),
      row(2, { status: 'screened', latest_score: 54, latest_recommendation: 'hold' }),
      row(3, { status: 'screened', latest_score: 31, latest_recommendation: 'reject' }),
    ]);
    const { container } = renderPage();
    await screen.findByText('Person 1');
    const marks = container.querySelectorAll('tbody [data-verdict-mark]');
    expect(Array.from(marks).map((m) => m.getAttribute('data-verdict-mark'))).toEqual(['full', 'half', 'empty']);
  });

  it('keeps no eyebrow or description, and Upload is not the filled action', async () => {
    renderPage();
    await screen.findByText('Person 0');
    expect(screen.queryByText('Talent workspace')).not.toBeInTheDocument();
    expect(screen.queryByText(/move candidates through screening/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload resume' }).className).not.toMatch(/bg-info\b/);
  });

  it('reads "Review", not a decision this page cannot make', async () => {
    mockApi.listCandidates.mockResolvedValue([row(1, { status: 'screened' })]);
    renderPage();
    expect(await screen.findByRole('link', { name: /^Review\s*, Person 1$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Review & decide/)).not.toBeInTheDocument();
  });
});

describe('a failed roles read', () => {
  it('says what is missing, with a Retry, and the rows stay', async () => {
    const user = userEvent.setup();
    mockApi.listRoles.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await screen.findByText('Person 0');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Roles couldn't load/);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mockApi.listRoles).toHaveBeenCalledTimes(2);
  });
});
