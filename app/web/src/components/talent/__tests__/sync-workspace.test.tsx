/**
 * TranscriptionSyncWorkspace — the unified review workspace. Covers session
 * selection, transcript load, session context header, session scorecard,
 * seek sync, load-and-seek-before-load, retry, non-admin 403 fallback, axe.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import type { Session, Assessment } from '../../../types';

const SESSION_COMPLETED_LIVE: Session = {
  id: 'session-1',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'live',
  duration_sec: 120,
  created_at: '2026-01-01T00:00:00.000Z',
};

const SESSION_COMPLETED_SIM: Session = {
  id: 'session-2',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'simulation',
  created_at: '2026-01-02T00:00:00.000Z',
};

const ASSESSMENT: Assessment = {
  id: 'a1',
  overall_score: 78,
  recommendation: 'advance',
  summary: 'Solid.',
  tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: '' },
  role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: '' },
  raw: null,
};

const NO_ASSESSMENTS: Assessment[] = [];

const mockApi = { getSession: vi.fn() };
const mockRecordingApi = { getRecordingDownloadUrl: vi.fn() };

vi.mock('../../../api', () => ({
  api: {
    getSession: (...args: any[]) => mockApi.getSession(...args),
    getRecordingDownloadUrl: (...args: any[]) => mockRecordingApi.getRecordingDownloadUrl(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__allowConsole?.(/inside a test was not wrapped in act/);
  (globalThis as any).__allowConsole?.(/ReactDOMTestUtils/);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return 0; },
    set(_v: number) {},
  });
  // Default: a completed session with a transcript + no assessment.
  mockApi.getSession.mockResolvedValue({
    session: SESSION_COMPLETED_LIVE,
    transcript: [{ speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 }],
    assessment: null,
  });
});

describe('TranscriptionSyncWorkspace', () => {
  it('auto-loads transcript for the first completed session', async () => {
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    expect(await screen.findByText('Hello!')).toBeInTheDocument();
  });

  it('renders a session selector with completed sessions and context', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE, SESSION_COMPLETED_SIM]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('shows the session scorecard returned with the transcript', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [{ speaker: 'bot' as const, text: 'Hi', start_offset_sec: 0 }],
      assessment: ASSESSMENT,
    });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    expect(await screen.findByText('Scorecard for this session')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('does not auto-fetch the recording URL (explicit action only)', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION_COMPLETED_LIVE, transcript: [], assessment: null });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await screen.findByText(/no transcript lines/i);
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();
  });

  it('shows an error and a working retry when transcript load fails', async () => {
    mockApi.getSession.mockRejectedValueOnce({ message: 'transcript unavailable' });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    expect(await screen.findByText('transcript unavailable')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /try again/i });
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [{ speaker: 'bot' as const, text: 'Retried!', start_offset_sec: 0.0 }],
      assessment: null,
    });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Retried!')).toBeInTheDocument();
  });

  it('falls back to a permission note + latest scorecard for non-admins (403)', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={[ASSESSMENT]} blocked={false} />,
    );
    expect(
      await screen.findByText(/require admin access/i),
    ).toBeInTheDocument();
    // The viewer-visible latest scorecard is still shown.
    expect(screen.getByText('Latest scorecard')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('shows an empty state when no completed sessions exist', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[{ ...SESSION_COMPLETED_LIVE, status: 'in_progress' }]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(screen.getByText(/No completed sessions with recordings yet/i)).toBeInTheDocument();
  });

  it('suppresses the scorecard when appeal-blocked', () => {
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={true} />,
    );
    expect(
      screen.getByText(/Scorecards are suppressed while an appeal is under review/i),
    ).toBeInTheDocument();
  });

  it('mints the URL, waits for the audio, then seeks + plays on a click made BEFORE the recording is loaded', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [
        { speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 },
        { speaker: 'candidate' as const, text: 'Answer.', start_offset_sec: 5 },
      ],
      assessment: null,
    });
    mockRecordingApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() { return 2; },
    });
    const setCurrentTime = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return 0; },
      set: setCurrentTime,
    });

    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    const turnBtn = await screen.findByRole('button', { name: /Turn 2:.*Candidate/i });
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();

    fireEvent.click(turnBtn);

    await waitFor(() =>
      expect(mockRecordingApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
    );
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(setCurrentTime).toHaveBeenCalledWith(5);
  });

  it('has no axe violations', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [
        { speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 },
        { speaker: 'candidate' as const, text: 'Hi!', start_offset_sec: 3.5 },
      ],
      assessment: null,
    });
    const { container } = render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await screen.findByText('Hello!');
    await expect(container).toHaveNoViolations();
  });
});
