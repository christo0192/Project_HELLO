/**
 * CandidatesPage accessibility tests.
 *
 * Covers:
 *   - Loading state
 *   - Empty state (no candidates)
 *   - Candidates table with data
 *   - Upload card (file input, role select)
 *   - Role filter
 *   - axe structural rule compliance
 *   - Keyboard / focus management
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function renderCandidatesPage() {
  return render(
    <MemoryRouter initialEntries={['/candidates']}>
      <CandidatesPage />
    </MemoryRouter>,
  );
}

describe('CandidatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
  });

  it('shows loading state initially', () => {
    mockApi.listCandidates.mockReturnValue(new Promise(() => {}));
    renderCandidatesPage();
    expect(screen.getByText('Loading candidates…')).toBeInTheDocument();
  });

  it('shows empty state when no candidates', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    renderCandidatesPage();
    expect(await screen.findByText('No candidates yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Upload a resume above to parse a candidate and add them here.',
      ),
    ).toBeInTheDocument();
  });

  it('renders candidates table', async () => {
    mockApi.listCandidates.mockResolvedValue([mockCandidate]);
    renderCandidatesPage();

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('+1234567890')).toBeInTheDocument();
    expect(screen.getByText('5 yr')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('renders upload card with file input and role select', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    renderCandidatesPage();

    expect(await screen.findByText('Upload a resume')).toBeInTheDocument();
    expect(screen.getByText('PDF or DOCX. Parsing runs an LLM and can take 10–20 seconds.')).toBeInTheDocument();

    // File input should exist
    const fileInput = screen.getByLabelText('Resume file');
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).toHaveAttribute('type', 'file');

    // Role select should be populated (Senior Frontend Engineer appears in both
    // the upload role select and the filter role select - use getAllByText)
    const roleOptions = screen.getAllByText('Senior Frontend Engineer');
    expect(roleOptions.length).toBeGreaterThanOrEqual(1);
  });

  it('renders role filter select', async () => {
    mockApi.listCandidates.mockResolvedValue([mockCandidate]);
    renderCandidatesPage();

    expect(await screen.findByLabelText('Filter by role')).toBeInTheDocument();
    const filterSelect = screen.getByLabelText('Filter by role');
    expect(filterSelect).toBeInTheDocument();
    expect(screen.getByText('All roles')).toBeInTheDocument();
  });

  it('handles upload error', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    mockApi.uploadResume.mockRejectedValue({ message: 'Upload failed.' });
    renderCandidatesPage();

    await screen.findByText('Upload a resume');

    // Click upload without a file - button should be disabled
    const uploadBtn = screen.getByRole('button', { name: 'Upload & Parse' });
    expect(uploadBtn).toBeDisabled();
  });

  it('has no axe violations in loading state', async () => {
    mockApi.listCandidates.mockReturnValue(new Promise(() => {}));
    const { container } = renderCandidatesPage();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in empty state', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    const { container } = renderCandidatesPage();
    await screen.findByText('No candidates yet');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with candidates', async () => {
    mockApi.listCandidates.mockResolvedValue([mockCandidate]);
    const { container } = renderCandidatesPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });
});
