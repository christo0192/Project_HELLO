/**
 * CandidateDetailPage accessibility tests.
 *
 * Covers:
 *   - Loading state
 *   - Error state
 *   - Candidate profile, sessions, assessment rendering
 *   - axe structural rule compliance
 *   - Heading hierarchy, landmark regions
 *   - LiveKit call card and LiveCallPanel integration
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail } from '../test/helpers';

const mockApi = {
  getCandidate: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    getCandidate: (...args: any[]) => mockApi.getCandidate(...args),
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
    getSession: vi.fn().mockResolvedValue({
      session: { status: 'completed' },
      transcript: [],
      assessment: null,
    }),
    listCandidates: vi.fn().mockResolvedValue([]),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

// Mock supabase to prevent channel subscriptions
vi.mock('../lib/supabase', () => {
  // A channel object that supports chaining on().on().subscribe()
  const makeChannel = () => {
    const channel: any = {};
    channel.on = () => channel;
    channel.subscribe = () => 'mock-sub';
    return channel;
  };

  // A query builder that supports from().select().eq().order().limit()
  const makeQuery = () => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: null, error: null });
    return q;
  };

  return {
    supabase: {
      from: () => makeQuery(),
      channel: () => makeChannel(),
      removeChannel: () => {},
    },
  };
});

function renderDetailPage(id = 'candidate-1') {
  return render(
    <MemoryRouter initialEntries={[`/candidates/${id}`]}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CandidateDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockApi.getCandidate.mockReturnValue(new Promise(() => {}));
    renderDetailPage();
    expect(screen.getByText('Loading candidate…')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockApi.getCandidate.mockRejectedValue({ message: 'Candidate not found' });
    renderDetailPage();
    expect(await screen.findByText('Candidate not found')).toBeInTheDocument();
  });

  it('renders candidate profile', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('5 years')).toBeInTheDocument();
  });

  it('renders Back to candidates link', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();
    expect(await screen.findByText('← Back to candidates')).toBeInTheDocument();
  });

  it('renders Profile section', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();
    expect(await screen.findByText('Profile')).toBeInTheDocument();
  });

  it('renders LiveKit voice screening card', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();
    expect(await screen.findByText('LiveKit voice screening')).toBeInTheDocument();
  });

  it('renders LiveCallPanel', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();
    expect(await screen.findByText('Live call')).toBeInTheDocument();
  });

  it('renders screening sessions', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();
    expect(await screen.findByText('Screening sessions')).toBeInTheDocument();
    // Session should show with status
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('renders latest assessment when available', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    renderDetailPage();
    expect(await screen.findByText('Latest assessment')).toBeInTheDocument();
    // Scorecard renders the overall score
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    const { container } = renderDetailPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });
});
