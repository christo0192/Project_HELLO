/**
 * CandidateDetailPage — tab semantics for the redesigned 2-tab workspace
 * (Overview + Review). Covers ARIA tablist + keyboard activation, the Review
 * workspace transcript load (empty/error), on-demand recording gating, and
 * axe with hidden panels.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail, mockSessionDetail } from '../test/helpers';

const mockApi = {
  getCandidate: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  addNote: vi.fn().mockResolvedValue({ id: 'n1' }),
  listAppeals: vi.fn().mockResolvedValue({ appeals: [] }),
  issueAppealGrant: vi.fn(),
  exportCsv: vi.fn(),
  startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
  issueLiveKitInvite: vi.fn(),
  getSession: vi.fn(),
  getCandidateAshbyWorkflow: vi.fn().mockResolvedValue({ ok: true, workflow: null }),
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
    startLiveKitScreening: (...args: any[]) => mockApi.startLiveKitScreening(...args),
    issueLiveKitInvite: (...args: any[]) => mockApi.issueLiveKitInvite(...args),
    getSession: (...args: any[]) => mockApi.getSession(...args),
    getCandidateAshbyWorkflow: (...args: any[]) => mockApi.getCandidateAshbyWorkflow(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('../lib/supabase', () => {
  const makeChannel = () => {
    const channel: any = {};
    channel.on = () => channel;
    channel.subscribe = () => 'mock-sub';
    return channel;
  };
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

function renderDetailPage() {
  return render(
    <MemoryRouter initialEntries={['/candidates/candidate-1']}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CandidateDetailPage tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    mockApi.getSession.mockResolvedValue(mockSessionDetail);
  });

  it('renders a keyboard tablist with Overview + Review', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    const tablist = screen.getByRole('tablist', { name: 'Candidate sections' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Review']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('activates the Review tab on ArrowRight', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByText('Jane Doe');
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    const review = screen.getByRole('tab', { name: 'Review' });
    expect(review).toHaveFocus();
    expect(review).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Review' })).not.toHaveAttribute('hidden');
  });

  it('auto-loads the transcript for the first completed session', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
    expect(screen.getByText('Thank you!')).toBeInTheDocument();
  });

  it('shows a truthful empty transcript state', async () => {
    mockApi.getSession.mockResolvedValue({ ...mockSessionDetail, transcript: [] });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(
      await screen.findByText(/No transcript lines recorded for this session yet/i),
    ).toBeInTheDocument();
  });

  it('shows an inline transcript error with retry', async () => {
    mockApi.getSession.mockRejectedValue({ message: 'transcript unavailable' });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByText('transcript unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('gates recording access behind an explicit click', async () => {
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    const loadBtn = await screen.findByRole('button', { name: /load recording/i });
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(loadBtn);
    await waitFor(() =>
      expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
    );
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    expect(document.querySelector('audio')).toHaveAttribute('src', 'https://x.invalid/rec');
  });

  it('suppresses the scorecard across the appeal block', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        decision_use_blocked_at: '2026-01-02T00:00:00.000Z',
      },
    });
    renderDetailPage();
    expect(await screen.findByText(/Decision use is paused — open appeal/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(
      await screen.findByText(/Scorecards are suppressed while an appeal is under review/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('78')).not.toBeInTheDocument();
  });

  it('has no axe violations with hidden tab panels', async () => {
    const { container } = renderDetailPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });
});
