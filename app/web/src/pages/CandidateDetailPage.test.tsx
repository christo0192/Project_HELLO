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

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail } from '../test/helpers';

const mockApi = {
  getCandidate: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  addNote: vi.fn().mockResolvedValue({ id: 'n1' }),
  listAppeals: vi.fn().mockResolvedValue({ appeals: [] }),
  issueAppealGrant: vi.fn().mockResolvedValue({
    appeal_grant_token: 'c'.repeat(64),
    expires_at: '2999-01-01T00:00:00.000Z',
  }),
  exportCsv: vi.fn().mockResolvedValue('\uFEFFcandidate_id,status\n'),
};

vi.mock('../api', () => ({
  api: {
    getCandidate: (...args: any[]) => mockApi.getCandidate(...args),
    getRecordingDownloadUrl: (...args: any[]) => mockApi.getRecordingDownloadUrl(...args),
    listNotes: (...args: any[]) => mockApi.listNotes(...args),
    addNote: (...args: any[]) => mockApi.addNote(...args),
    listAppeals: (...args: any[]) => mockApi.listAppeals(...args),
    issueAppealGrant: (...args: any[]) => mockApi.issueAppealGrant(...args),
    exportCsv: (...args: any[]) => mockApi.exportCsv(...args),
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

  // ── MIG-06: on-demand recording download (explicit user action only) ──
  describe('recording download (MIG-06)', () => {
    it('does NOT fetch a recording URL on render (no auto-fetch)', async () => {
      mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
      mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
      renderDetailPage();
      // Wait for a completed session (which renders the Play button) to appear.
      expect(await screen.findByText('Play recording')).toBeInTheDocument();
      // The signed URL must NOT be requested until the recruiter clicks.
      expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    });

    it('fetches the signed URL only when Play recording is clicked', async () => {
      mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
      mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
      renderDetailPage();
      const btn = await screen.findByText('Play recording');
      fireEvent.click(btn);
      await waitFor(() => expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledTimes(1));
    });

    it('shows an error when the recording fetch fails', async () => {
      mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
      mockApi.getRecordingDownloadUrl.mockRejectedValue({ message: 'expired' });
      renderDetailPage();
      const btn = await screen.findByText('Play recording');
      fireEvent.click(btn);
      expect(await screen.findByText('expired')).toBeInTheDocument();
    });
  });

  // ── Phase 9 L4: decision-use block, notes, appeals, CSV export ──────
  describe('Phase 9 additions', () => {
    it('shows a decision-use block banner and hides the automated scorecard', async () => {
      mockApi.getCandidate.mockResolvedValue({
        ...mockCandidateDetail,
        candidate: {
          ...mockCandidateDetail.candidate,
          decision_use_blocked_at: '2026-01-02T00:00:00.000Z',
        },
      });
      renderDetailPage();
      expect(
        await screen.findByText(/Decision use is paused — open appeal/i),
      ).toBeInTheDocument();
      // Scorecard (automated recommendation) is suppressed.
      expect(screen.queryByText('Latest assessment')).toBeInTheDocument();
      expect(screen.queryByText('78')).not.toBeInTheDocument();
      expect(
        screen.getByText(/Hidden while an appeal is under review/i),
      ).toBeInTheDocument();
    });

    it('renders the notes section and adds a note', async () => {
      mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
      mockApi.listNotes.mockResolvedValue({
        notes: [{ id: 'n1', candidate_id: 'candidate-1', author_id: 'u1', note: 'Call back next week', created_at: '2026-01-01T00:00:00Z' }],
      });
      renderDetailPage();
      expect(await screen.findByText('Call back next week')).toBeInTheDocument();
      await userEvent.type(screen.getByPlaceholderText('Add a note…'), 'Follow up');
      await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(mockApi.addNote).toHaveBeenCalledWith('candidate-1', 'Follow up'));
    });

    it('exports the scorecard CSV on click', async () => {
      mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
      const createObjSpy = vi
        .spyOn(URL, 'createObjectURL')
        .mockImplementation(() => 'blob:mock');
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      renderDetailPage();
      const btn = await screen.findByRole('button', {
        name: 'Export screening data (scorecard + transcript)',
      });
      fireEvent.click(btn);
      await waitFor(() => expect(mockApi.exportCsv).toHaveBeenCalledWith('candidate-1'));
      // The CSV text is turned into a transient blob URL for a same-tab download.
      await waitFor(() => expect(createObjSpy).toHaveBeenCalled());
      expect(revokeSpy).toHaveBeenCalled();
      createObjSpy.mockRestore();
      revokeSpy.mockRestore();
    });

    it('issues a one-time appeal grant and shows a fragment link', async () => {
      mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
      renderDetailPage();
      const issueBtn = await screen.findByRole('button', { name: 'Issue one-time appeal grant' });
      fireEvent.click(issueBtn);
      await waitFor(() => {
        expect(mockApi.issueAppealGrant).toHaveBeenCalledWith('candidate-1', 'session-1', 24);
      });
      // The link is a fragment link to /appeal — the token stays in the fragment.
      expect(await screen.findByText(/\/appeal#/)).toBeInTheDocument();
      expect(screen.queryByText(/\/appeal\?/)).not.toBeInTheDocument();
    });
  });
});
