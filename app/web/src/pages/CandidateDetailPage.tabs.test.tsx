/**
 * CandidateDetailPage — tab semantics for the redesigned 2-tab workspace
 * (Overview + Review). Covers ARIA tablist + keyboard activation, the Review
 * workspace transcript load (empty/error), on-demand recording gating, and
 * axe with hidden panels.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  listR1Rounds: vi.fn().mockResolvedValue({ rounds: [] }),
  getR1Availability: vi.fn().mockResolvedValue({ state: 'disabled', hold_minutes: 55 }),
  getCandidatePhoneAttempts: vi.fn(),
  getAttemptRecordingDownloadUrl: vi.fn(),
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
    listR1Rounds: (...args: any[]) => mockApi.listR1Rounds(...args),
    getR1Availability: (...args: any[]) => mockApi.getR1Availability(...args),
    getCandidatePhoneAttempts: (...args: any[]) => mockApi.getCandidatePhoneAttempts(...args),
    getAttemptRecordingDownloadUrl: (...args: any[]) => mockApi.getAttemptRecordingDownloadUrl(...args),
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
    mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
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

  describe('call recordings before a completed screening (M011 F2)', () => {
    const PRE_CONSENT_ATTEMPT = {
      id: '00000000-0000-4000-8000-0000000000a1',
      attempt_seq: 1,
      admitted_at: '2026-09-25T13:00:00.000Z',
      answered_at: '2026-09-25T13:00:01.000Z',
      ended_at: '2026-09-25T13:00:09.000Z',
      state: 'ended',
      abandon_reason: null,
      outcome_class: 'abandoned_pre_disclosure',
      duration_sec: 8,
      recording: { state: 'ready' },
      consent_stage: 'before_consent',
      transcript: null,
    };

    beforeEach(() => {
      mockApi.getCandidate.mockResolvedValue({
        ...mockCandidateDetail,
        sessions: mockCandidateDetail.sessions.map((s) => ({ ...s, status: 'expired' })),
        assessments: [],
      });
      mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [PRE_CONSENT_ATTEMPT], next_cursor: null });
    });

    it('lists the recordings in the Review tab from ONE shared attempt fetch', async () => {
      renderDetailPage();
      await screen.findByText('Jane Doe');
      await waitFor(() => expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
      const review = screen.getByRole('tabpanel', { name: 'Review' });
      expect(await within(review).findByRole('heading', { name: 'Call recordings' })).toBeInTheDocument();
      expect(within(review).getByText('Recorded before consent')).toBeInTheDocument();
      expect(within(review).getByText(/No completed screening yet/i)).toBeInTheDocument();
      // The copies remount per tab, yet the list was fetched once.
      expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalledTimes(1);
      expect(mockApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
      // Switching back and forth never refetches either.
      fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
      await within(screen.getByRole('tabpanel', { name: 'Review' })).findByRole('heading', { name: 'Call recordings' });
      expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalledTimes(1);
    });

    it('has ONE attempt list (one player) on the page, and switching tabs stops the audio', async () => {
      mockApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://storage.invalid/a1', content_type: 'audio/mpeg' });
      const { container } = renderDetailPage();
      await screen.findByText('Jane Doe');
      // Overview open: its copy only; the hidden Review panel has none.
      const overviewPlay = await screen.findAllByRole('button', { name: 'Play recording' });
      expect(overviewPlay).toHaveLength(1);
      fireEvent.click(overviewPlay[0]);
      await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
      expect(container.querySelectorAll('audio')).toHaveLength(1);
      // Switching to Review unmounts the Overview player: no audio keeps
      // playing in a hidden panel, and Review starts with its player closed.
      fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
      const review = screen.getByRole('tabpanel', { name: 'Review' });
      await within(review).findByRole('button', { name: 'Play recording' });
      expect(container.querySelectorAll('audio')).toHaveLength(0);
      expect(screen.getAllByRole('button', { name: 'Play recording' })).toHaveLength(1);
    });

    it('plays a pre-consent recording inline from the Review tab only on click', async () => {
      mockApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://storage.invalid/a1', content_type: 'audio/mpeg' });
      renderDetailPage();
      await screen.findByText('Jane Doe');
      fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
      const review = screen.getByRole('tabpanel', { name: 'Review' });
      fireEvent.click(await within(review).findByRole('button', { name: 'Play recording' }));
      const player = await within(review).findByLabelText('Attempt 1 recording', { selector: 'audio' });
      expect(player).toHaveAttribute('src', 'https://storage.invalid/a1');
      expect(mockApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(1);
      expect(mockApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith(PRE_CONSENT_ATTEMPT.id);
    });
  });
});
