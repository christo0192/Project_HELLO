/**
 * TranscriptionSyncWorkspace — session selection, transcript load, seek sync,
 * P0-1 load-and-seek, P1-1 retry, responsive classes, axe.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import type { Session, Assessment } from '../../../types';

// Minimal session/assessment fixtures
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

const NO_ASSESSMENTS: Assessment[] = [];

const mockApi = {
  getSession: vi.fn(),
};
const mockRecordingApi = {
  getRecordingDownloadUrl: vi.fn(),
};

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

// Allow console warnings for act()
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__allowConsole?.(/inside a test was not wrapped in act/);
  (globalThis as any).__allowConsole?.(/ReactDOMTestUtils/);
  // Stub media
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return 0; },
    set(_v: number) {},
  });
});

describe('TranscriptionSyncWorkspace', () => {
  it('auto-loads transcript for the first completed session', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [
        { speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 },
      ],
      assessment: null,
    });
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    expect(await screen.findByText('Hello!')).toBeInTheDocument();
  });

  it('renders session selector with completed sessions', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE, SESSION_COMPLETED_SIM]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
  });

  it('shows Load recording button (never auto-fetched)', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [],
      assessment: null,
    });
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    await screen.findByText(/no transcript lines/i);
    // Recording URL must NOT be fetched on mount
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    // "Load recording" button is present
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();
  });

  it('shows an error and retry button when transcript load fails', async () => {
    mockApi.getSession.mockRejectedValue({ message: 'transcript unavailable' });
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(await screen.findByText('transcript unavailable')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /try again/i });
    expect(retryBtn).toBeInTheDocument();

    // P1-1: clicking retry actually re-fetches
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [{ speaker: 'bot' as const, text: 'Retried!', start_offset_sec: 0.0 }],
      assessment: null,
    });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Retried!')).toBeInTheDocument();
  });

  it('shows empty state when no completed sessions exist', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[{ ...SESSION_COMPLETED_LIVE, status: 'in_progress' }]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(
      screen.getByText(/No completed sessions with recordings yet/i),
    ).toBeInTheDocument();
  });

  it('suppresses scorecards when blocked', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={true}
      />,
    );
    expect(
      screen.getByText(/Scorecards are suppressed while an appeal is under review/i),
    ).toBeInTheDocument();
  });

  it('mints the URL, waits for the audio to mount, then seeks + plays when a timed turn is clicked BEFORE the recording is loaded', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [
        { speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 },
        { speaker: 'candidate' as const, text: 'Answer.', start_offset_sec: 5 },
      ],
      assessment: null,
    });
    mockRecordingApi.getRecordingDownloadUrl.mockResolvedValue({
      url: 'https://x.invalid/rec',
    });
    // Media element must report readiness so the queued seek applies.
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() { return 2; /* HAVE_CURRENT_DATA */ },
    });
    const setCurrentTime = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return 0; },
      set: setCurrentTime,
    });

    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    const turnBtn = await screen.findByRole('button', { name: /Turn 2:.*Candidate/i });

    // MIG-06: URL is NOT minted until the explicit turn click.
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();

    fireEvent.click(turnBtn);

    // The click itself mints the short-lived URL…
    await waitFor(() =>
      expect(mockRecordingApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
    );
    // …the <audio> mounts…
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    // …then the queued seek applies and playback starts.
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
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    await screen.findByText('Hello!');
    await expect(container).toHaveNoViolations();
  });
});
