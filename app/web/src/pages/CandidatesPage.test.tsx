/**
 * CandidatesPage — pipeline list with URL-addressable drill-down filters.
 *
 * Covers: loading/empty states, table + next-action, upload card, role filter,
 * URL status deep-link + toggle + clear (deep link / back-forward friendly),
 * keyboard/axe.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { CandidatesPage } from './CandidatesPage';
import { mockCandidate, mockRole } from '../test/helpers';
import { EMPTY_FUNNEL_TOTALS } from '../test/funnel';

const mockApi = {
  listRoles: vi.fn(),
  listCandidates: vi.fn(),
  uploadResume: vi.fn(),
  // See EMPTY_FUNNEL_TOTALS: the per-role pipeline chart calls this on mount.
  getScreeningFunnel: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    listCandidates: (...args: any[]) => mockApi.listCandidates(...args),
    uploadResume: (...args: any[]) => mockApi.uploadResume(...args),
    getScreeningFunnel: (...args: any[]) => mockApi.getScreeningFunnel(...args),
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
  mockCandidate, // status: new, email jane@example.com, unassessed
  {
    ...mockCandidate,
    id: 'c-screened',
    name: 'Screened Sam',
    email: 'sam@example.com',
    status: 'screened',
    latest_recommendation: 'advance',
    latest_score: 82,
  },
  {
    ...mockCandidate,
    id: 'c-screening',
    name: 'Screening Sara',
    email: 'sara@example.com',
    status: 'screening',
    latest_recommendation: 'reject',
    latest_score: 41,
  },
];

function renderPage(entry = '/candidates', ui: ReactNode = <CandidatesPage />) {
  return render(<MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>);
}

describe('CandidatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('shows loading state initially', () => {
    mockApi.listCandidates.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading candidates…')).toBeInTheDocument();
  });

  it('shows empty state when no candidates', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No candidates yet')).toBeInTheDocument();
    // The hint no longer says "above": the upload form is collapsed by
    // default, so pointing at it in prose would point off screen. The empty
    // state carries a button that OPENS it instead.
    expect(
      screen.getByText('Upload a resume to parse a candidate and add them here.'),
    ).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Upload a resume' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(open);
    expect(await screen.findByRole('button', { name: 'Upload & Parse' })).toBeInTheDocument();
  });

  it('keeps the upload form COLLAPSED until asked for', async () => {
    // Owner request 2026-09-22: candidates arrive from Ashby, so an
    // always-open upload form pushed the pipeline below the fold.
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.queryByRole('button', { name: 'Upload & Parse' })).not.toBeInTheDocument();

    const toggle = screen.getAllByRole('button', { name: 'Upload resume' })[0];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(await screen.findByRole('button', { name: 'Upload & Parse' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the candidates table with status badge + next action', async () => {
    renderPage();
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('5 yr').length).toBeGreaterThanOrEqual(1);
    // Status vocabulary label + actionable next step for a "new" candidate.
    expect(screen.getAllByText('New').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Start screening')).toBeInTheDocument();
  });

  it('links each candidate name to its workspace', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: 'Jane Doe' });
    expect(link).toHaveAttribute('href', '/candidates/candidate-1');
  });

  it('renders the upload card with file input and role select', async () => {
    renderPage();
    expect(await screen.findByText('Upload a resume')).toBeInTheDocument();
    expect(
      screen.getByText('PDF or DOCX. Parsing runs an LLM and can take 10–20 seconds.'),
    ).toBeInTheDocument();
    const fileInput = screen.getByLabelText('Resume file');
    expect(fileInput).toHaveAttribute('type', 'file');
    expect(screen.getAllByText('Senior Frontend Engineer').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the role filter select', async () => {
    renderPage();
    expect(await screen.findByLabelText('Filter by role')).toBeInTheDocument();
    expect(screen.getByText('All roles')).toBeInTheDocument();
  });

  it('applies a status filter from the URL (deep link)', async () => {
    renderPage('/candidates?status=screened');
    // Only the screened candidate is visible.
    expect(await screen.findByText('Screened Sam')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(screen.queryByText('Screening Sara')).not.toBeInTheDocument();
    // Count summary reflects the filtered subset.
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    // Active filter chip is shown.
    expect(screen.getByText('Active filters:')).toBeInTheDocument();
  });

  it('toggles a status filter into the URL and clears it', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by status' });
    const screenedToggle = within(group).getByRole('button', { name: /Screened/i });
    fireEvent.click(screenedToggle);
    // After toggling, only the screened candidate remains.
    expect(await screen.findByText('Screened Sam')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    // Clear all restores the full list.
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows a truthful empty state when filters match nothing', async () => {
    renderPage('/candidates?status=rejected');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
  });

  it('shows the recommendation column and applies a recommendation deep link', async () => {
    renderPage('/candidates?recommendation=advance');
    // Only the advance-recommended candidate is visible.
    expect(await screen.findByText('Screened Sam')).toBeInTheDocument();
    expect(screen.queryByText('Screening Sara')).not.toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    // The recommendation is visibly shown (badge + score) in the table.
    const table = screen.getByRole('table', { name: /candidates in your pipeline/i });
    expect(within(table).getByText('Advance')).toBeInTheDocument();
    expect(within(table).getByText('82')).toBeInTheDocument();
    expect(screen.getByText('Rec: Advance')).toBeInTheDocument();
  });

  it('applies the assessed deep link (average-score cohort)', async () => {
    renderPage('/candidates?assessed=1');
    // Only candidates with a latest score remain (Sam + Sara), not the unassessed Jane.
    expect(await screen.findByText('Screened Sam')).toBeInTheDocument();
    expect(screen.getByText('Screening Sara')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(screen.getByText('Assessed')).toBeInTheDocument();
  });

  it('toggles a recommendation filter into the URL', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by recommendation' });
    fireEvent.click(within(group).getByRole('button', { name: /Reject/i }));
    expect(await screen.findByText('Screening Sara')).toBeInTheDocument();
    expect(screen.queryByText('Screened Sam')).not.toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
  });

  it('upload button is disabled without a file', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    renderPage();
    // The panel is collapsed by default now, so it has to be opened before
    // its submit button exists to assert on.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Upload resume' }))[0]);
    expect(screen.getByRole('button', { name: 'Upload & Parse' })).toBeDisabled();
  });

  it('shows the ROLE each candidate applied for', async () => {
    mockApi.listRoles.mockResolvedValue([
      mockRole,
      { ...mockRole, id: 'role-2', title: 'Backend Engineer' },
    ]);
    mockApi.listCandidates.mockResolvedValue([
      CANDIDATES[0],
      CANDIDATES[1],
      { ...CANDIDATES[2], role_id: 'role-2' },
    ]);
    renderPage();
    await screen.findByText('Jane Doe');
    const header = screen.getByRole('columnheader', { name: 'Role' });
    expect(header).toBeInTheDocument();
    // Scoped to the TABLE: the role title also appears in the role-filter
    // dropdown, so an unscoped query would pass on the wrong element.
    // TWO roles in the fixture, deliberately: with every candidate on one role
    // a component that rendered a CONSTANT would pass this test.
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Senior Frontend Engineer').length).toBe(2);
    expect(within(table).getByText('Backend Engineer')).toBeInTheDocument();
    // Resolved to the role's TITLE, never the raw uuid.
    expect(table.innerHTML).not.toContain('role-2');
  });

  it('says "No role" rather than leaving the cell blank', async () => {
    mockApi.listCandidates.mockResolvedValue([{ ...mockCandidate, role_id: null }]);
    renderPage();
    await screen.findByText('Jane Doe');
    expect(within(screen.getByRole('table')).getByText('No role')).toBeInTheDocument();
  });

  it('says "—", NOT "Unknown role", until the roles request settles', async () => {
    // The two fetches race. Whenever candidates won, `roleTitleById` was empty
    // and every row claimed its role had been deleted.
    let releaseRoles: (r: unknown) => void = () => {};
    mockApi.listRoles.mockReturnValue(
      new Promise((res) => {
        releaseRoles = res;
      }),
    );
    renderPage();
    await screen.findByText('Jane Doe');
    const table = screen.getByRole('table');
    expect(within(table).queryByText('Unknown role')).not.toBeInTheDocument();
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);

    releaseRoles([mockRole]);
    expect(await within(table).findAllByText('Senior Frontend Engineer')).toHaveLength(3);
  });

  it('marks a role the roles list does not carry, instead of showing its uuid', async () => {
    // Reachable when a role is deleted, or filtered out of the caller's
    // scope. A raw uuid in the cell is worse than useless to a recruiter.
    mockApi.listCandidates.mockResolvedValue([{ ...mockCandidate, role_id: 'role-gone' }]);
    renderPage();
    await screen.findByText('Jane Doe');
    const table = screen.getByRole('table');
    expect(within(table).getByText('Unknown role')).toBeInTheDocument();
    // Checked against the MARKUP: the uuid used to ship in a data- attribute,
    // which `queryByText` would never have found — confirming the id of a role
    // the viewer may have no scope to see.
    expect(table.innerHTML).not.toContain('role-gone');
  });

  it('COUNTS EVERY STATUS, including the one the old pill row omitted', async () => {
    // `consent_declined` is terminal and URL-only, so the pill row justifiably
    // left it out. A bar claiming to partition the whole list cannot: those
    // candidates used to land in an unnamed "Unaccounted" block, and for this
    // product a consent refusal is the outcome people most need to see.
    //
    // This fixture is also what makes the DENOMINATOR testable at all. With
    // the default three candidates the segment counts sum to exactly
    // `candidates.length`, so a correct `total` and a bar that rescales to its
    // own parts are indistinguishable.
    mockApi.listCandidates.mockResolvedValue([
      ...CANDIDATES,
      { ...mockCandidate, id: 'c-declined', name: 'Declined Dana', status: 'consent_declined' },
    ]);
    renderPage();
    await screen.findByText('Declined Dana');

    const group = screen.getByRole('group', { name: 'Filter by status' });
    expect(
      group.querySelector('[data-segment-value="consent_declined"]')?.textContent,
    ).toBe('1');
    // ...and therefore no unnamed hole.
    expect(group.querySelector('[data-segment-value="__remainder"]')).toBeNull();
    expect(within(group).queryByText('Unaccounted')).not.toBeInTheDocument();
  });

  it('charts each status with its own figure', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by status' });
    // Read off the data hook, not `parentElement.textContent`: `toContain('1')`
    // also passes for 10, 11 and 21.
    expect(group.querySelector('[data-segment-value="new"]')?.textContent).toBe('1');
    expect(group.querySelector('[data-segment-value="screening"]')?.textContent).toBe('1');
    expect(group.querySelector('[data-segment-value="screened"]')?.textContent).toBe('1');
    expect(group.querySelector('[data-segment-value="advanced"]')?.textContent).toBe('0');
  });

  it('measures RECOMMENDATION against those that HAVE one, not the whole list', async () => {
    // Two of three candidates carry a recommendation. Against all three the bar
    // would sit a third empty and imply the unscreened candidate was "not
    // recommended" rather than "not yet screened" — which shows up as a
    // remainder, so that is what this asserts.
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by recommendation' });
    expect(screen.getByText('Of 2 with a recommendation.')).toBeInTheDocument();
    expect(group.querySelector('[data-segment-value="advance"]')?.textContent).toBe('1');
    expect(group.querySelector('[data-segment-value="reject"]')?.textContent).toBe('1');
    // 1 + 1 against a denominator of 2 leaves nothing unaccounted.
    expect(group.querySelector('[data-segment-value="__remainder"]')).toBeNull();
  });

  it('keeps the recommendation filter REACHABLE with nothing assessed yet', async () => {
    // Gating the control on "some candidate has a recommendation" made the
    // filter disappear in a fresh workspace. The pill row it replaced was
    // always present.
    mockApi.listCandidates.mockResolvedValue([
      { ...mockCandidate, latest_recommendation: null, latest_score: null },
    ]);
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by recommendation' });
    expect(within(group).getByRole('button', { name: /Advance/i })).toBeInTheDocument();
    // No denominator claim when there is no denominator.
    expect(screen.queryByText(/with a recommendation\./)).not.toBeInTheDocument();
  });

  it('draws no status control at all when the list is empty', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    renderPage();
    await screen.findByText('No candidates yet');
    expect(screen.queryByRole('group', { name: 'Filter by status' })).not.toBeInTheDocument();
  });

  it('THE BAR IS THE FILTER — one surface, and the URL contract survives', async () => {
    // The chip row is gone; the legend entries are the toggles. Deep links,
    // aria-pressed and "Clear all" all still hang off this group.
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by status' });
    const screened = within(group).getByRole('button', { name: /Screened/i });
    expect(screened).toHaveAttribute('aria-pressed', 'false');
    expect(screened.className).toContain('min-h-11');

    fireEvent.click(screened);
    expect(await screen.findByText('Screened Sam')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', {
        name: /Screened/i,
      }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('says the bar describes the LOADED set, not the filtered one', async () => {
    // The heading two lines above can read "1 of 3", and a picture under it is
    // taken to be a picture of the 1. The role filter narrows this bar
    // server-side; the status filter does not.
    renderPage('/candidates?status=screened');
    await screen.findByText('Screened Sam');
    expect(screen.getByText(/Across all 3 loaded candidates/)).toBeInTheDocument();
  });

  it('has no axe violations with candidates', async () => {
    const { container } = renderPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in empty state', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    const { container } = renderPage();
    await screen.findByText('No candidates yet');
    await expect(container).toHaveNoViolations();
  });
});
