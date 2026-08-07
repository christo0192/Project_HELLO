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

const mockApi = {
  listRoles: vi.fn(),
  listCandidates: vi.fn(),
  uploadResume: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    listCandidates: (...args: any[]) => mockApi.listCandidates(...args),
    uploadResume: (...args: any[]) => mockApi.uploadResume(...args),
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
  mockCandidate, // status: new, email jane@example.com
  { ...mockCandidate, id: 'c-screened', name: 'Screened Sam', email: 'sam@example.com', status: 'screened' },
  { ...mockCandidate, id: 'c-screening', name: 'Screening Sara', email: 'sara@example.com', status: 'screening' },
];

function renderPage(entry = '/candidates', ui: ReactNode = <CandidatesPage />) {
  return render(<MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>);
}

describe('CandidatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
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
    expect(
      screen.getByText('Upload a resume above to parse a candidate and add them here.'),
    ).toBeInTheDocument();
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

  it('upload button is disabled without a file', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    renderPage();
    await screen.findByText('Upload a resume');
    expect(screen.getByRole('button', { name: 'Upload & Parse' })).toBeDisabled();
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
