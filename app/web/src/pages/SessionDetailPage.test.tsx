/**
 * SessionDetailPage — read-only post-session view:
 * loading/error/retry, transcript speaker labels + empty state, scorecard
 * presence/absence (truthful), on-demand signed-URL recording lifecycle,
 * and axe compliance.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionDetailPage } from './SessionDetailPage';
import { mockAssessment, mockTranscript } from '../test/helpers';

const getSession = vi.fn();
const getRecordingDownloadUrl = vi.fn();

vi.mock('../api', () => ({
  api: {
    getSession: (...args: any[]) => getSession(...args),
    getRecordingDownloadUrl: (...args: any[]) => getRecordingDownloadUrl(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const completedSessionDetail = {
  session: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    candidate_id: 'candidate-1',
    role_id: 'role-1',
    status: 'completed',
    mode: 'simulation',
    duration_sec: 360,
    created_at: '2026-06-01T00:00:00Z',
  },
  transcript: mockTranscript,
  assessment: mockAssessment,
};

function renderPage(sessionId = '550e8400-e29b-41d4-a716-446655440000') {
  return render(
    <MemoryRouter initialEntries={[`/screening/${sessionId}`]}>
      <Routes>
        <Route path="/screening/:sessionId" element={<SessionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SessionDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    getSession.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading session…')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    getSession.mockRejectedValueOnce({ message: 'Session not found' });
    renderPage();
    expect(await screen.findByText('Session not found')).toBeInTheDocument();
    getSession.mockResolvedValue(completedSessionDetail);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Transcript')).toBeInTheDocument();
  });

  it('renders read-only session meta and back link to the candidate', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    expect(await screen.findByText('← Back to candidate')).toBeInTheDocument();
    const back = screen.getByRole('link', { name: '← Back to candidate' });
    expect(back).toHaveAttribute('href', '/candidates/candidate-1');
    expect(screen.getByText('Session 550e8400')).toBeInTheDocument();
    expect(screen.getByText('6m 0s')).toBeInTheDocument(); // duration_sec 360
    // Read-only: no composer exists.
    expect(screen.queryByPlaceholderText(/candidate's answer/i)).not.toBeInTheDocument();
  });

  it('renders the transcript with speaker labels (no timestamps fabricated)', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
    expect(screen.getByText('Thank you!')).toBeInTheDocument();
    expect(screen.getAllByText('Bot').length).toBeGreaterThan(0);
    // Truthful turn count.
    expect(screen.getByText('3 speaker turns')).toBeInTheDocument();
  });

  it('shows an empty transcript state when none exists', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      transcript: [],
    });
    renderPage();
    expect(
      await screen.findByText(/No transcript lines recorded for this session yet/i),
    ).toBeInTheDocument();
  });

  it('renders the scorecard when an assessment exists', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    renderPage();
    expect(await screen.findByText('Scorecard')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getByText('Advance')).toBeInTheDocument();
  });

  it('shows a truthful no-scorecard state when completed without an assessment', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      assessment: null,
    });
    renderPage();
    expect(
      await screen.findByText(/No scorecard yet — assessment generation may still be running/i),
    ).toBeInTheDocument();
  });

  it('shows a no-scorecard state when the session has not completed', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      session: { ...completedSessionDetail.session, status: 'in_progress' },
      assessment: null,
    });
    renderPage();
    expect(
      await screen.findByText(/No scorecard — the session has not completed/i),
    ).toBeInTheDocument();
  });

  it('gates recording access behind an explicit click', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    renderPage();
    await screen.findByText('Recording');
    expect(getRecordingDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() =>
      expect(getRecordingDownloadUrl).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
      ),
    );
    await waitFor(() =>
      expect(document.querySelector('audio')).not.toBeNull(),
    );
    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(audio.src).toContain('x.invalid/rec');
  });

  it('refreshes an expired link on demand and reports errors inline', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    getRecordingDownloadUrl
      .mockResolvedValueOnce({ url: 'https://x.invalid/rec1' })
      .mockRejectedValueOnce({ message: 'link expired' });
    renderPage();
    await screen.findByText('Recording');
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /refresh link/i }));
    expect(await screen.findByText('link expired')).toBeInTheDocument();
  });

  it('does not offer recording access before completion', async () => {
    getSession.mockResolvedValue({
      ...completedSessionDetail,
      session: { ...completedSessionDetail.session, status: 'waiting' },
    });
    renderPage();
    expect(
      await screen.findByText(/Recording access is available once the session completes/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    getSession.mockResolvedValue(completedSessionDetail);
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    const { container } = renderPage();
    await screen.findByText('Scorecard');
    await expect(container).toHaveNoViolations();
  });
});
