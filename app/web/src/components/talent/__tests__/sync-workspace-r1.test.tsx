/**
 * TranscriptionSyncWorkspace and R1: this is the phone workspace, so an R1 session is not in its
 * picker, nothing of R1 is read or played here, and "Latest scorecard" is never an R1 result. R1 has
 * its own review page and its own tab on the candidate page. Phone sessions are untouched.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import type { Assessment, Session } from '../../../types';

const mockApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  getCandidatePhoneAttempts: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  getAttemptRecordingDownloadUrl: vi.fn(),
  listR1Rounds: vi.fn(),
  getR1Recording: vi.fn(),
}));

vi.mock('../../../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const R1_SESSION: Session = {
  id: 'r1-session',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'browser',
  interview_round_id: 'round-1',
  duration_sec: 600,
  created_at: '2026-10-02T10:00:00.000Z',
};

const PHONE_SESSION: Session = {
  id: 'phone-session',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'live',
  duration_sec: 120,
  created_at: '2026-10-01T10:00:00.000Z',
};

function renderWorkspace(props: Partial<React.ComponentProps<typeof TranscriptionSyncWorkspace>> = {}) {
  return render(
    <TranscriptionSyncWorkspace
      sessions={[R1_SESSION, PHONE_SESSION]}
      assessments={[]}
      blocked={false}
      candidateId="c1"
      {...props}
    />,
  );
}

/** The rows lit right now, by turn number. */
const lit = () =>
  screen
    .queryAllByRole('button', { name: /^Turn/ })
    .filter((b) => b.getAttribute('aria-current') === 'true')
    .map((b) => /^Turn (\d+)/.exec(b.getAttribute('aria-label') ?? '')?.[1]);

beforeEach(() => {
  vi.clearAllMocks();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getSession.mockResolvedValue({ session: PHONE_SESSION, transcript: [], assessment: null });
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
});

describe('an R1 session', () => {
  it('is not in the session picker, and the phone session is what loads', async () => {
    renderWorkspace();
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('phone-session'));
    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options).toHaveLength(1);
    expect(options[0]).not.toMatch(/R1 role-play/);
    expect(mockApi.getSession).not.toHaveBeenCalledWith('r1-session');
  });

  it('reads and plays nothing of R1', async () => {
    renderWorkspace();
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalled());
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('alone leaves the workspace saying there is no completed screening', () => {
    renderWorkspace({ sessions: [R1_SESSION] });
    expect(screen.getByText(/No completed sessions with recordings yet/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(mockApi.getSession).not.toHaveBeenCalled();
  });
});

describe('the "Latest scorecard" fallback never shows an R1 assessment', () => {
  // Newest first, as the API orders them: the R1 result, then the phone screen.
  const SCORECARD: Pick<Assessment, 'summary' | 'tone' | 'role_fit' | 'raw'> = {
    summary: 'A summary.',
    tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: '' },
    role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: '' },
    raw: null,
  };
  const R1_ASSESSMENT: Assessment = { ...SCORECARD, id: 'a-r1', session_id: 'r1-session', overall_score: 91, recommendation: 'reject' };
  const PHONE_ASSESSMENT: Assessment = { ...SCORECARD, id: 'a-phone', session_id: 'phone-session', overall_score: 62, recommendation: 'advance' };

  beforeEach(() => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
  });

  it('a non-admin keeps the "Latest scorecard" heading, over the phone score', async () => {
    renderWorkspace({ assessments: [R1_ASSESSMENT, PHONE_ASSESSMENT] });
    expect(await screen.findByText('Latest scorecard')).toBeInTheDocument();
    expect(screen.getByText('62')).toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
  });

  it('a phone session\'s denied pane keeps its words', async () => {
    renderWorkspace({ sessions: [PHONE_SESSION] });
    expect(await screen.findByText(/require admin access.*The session scorecard is shown alongside\./i)).toBeInTheDocument();
    expect(screen.getByText(/^No scorecard for this session yet\./)).toBeInTheDocument();
  });

  it('no completed session yet: the empty state falls back to the phone scorecard, never the R1 one', () => {
    const open = (s: Session): Session => ({ ...s, status: 'in_progress' });
    renderWorkspace({ sessions: [open(R1_SESSION), open(PHONE_SESSION)], assessments: [R1_ASSESSMENT, PHONE_ASSESSMENT] });
    expect(screen.getByText('Latest scorecard')).toBeInTheDocument();
    expect(screen.getByText('62')).toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
  });

  it('no completed session and only an R1 assessment: no scorecard and no "Latest scorecard" heading', () => {
    renderWorkspace({ sessions: [{ ...R1_SESSION, status: 'in_progress' }], assessments: [R1_ASSESSMENT] });
    expect(screen.queryByText('Latest scorecard')).not.toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
  });

  it('only an R1 session completed: the R1 score still stays out', () => {
    renderWorkspace({ sessions: [R1_SESSION], assessments: [R1_ASSESSMENT] });
    expect(screen.queryByText('Latest scorecard')).not.toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
  });
});

describe('phone sessions are unchanged', () => {
  it('shows the phone player and seeks with the plain offset', async () => {
    mockApi.getSession.mockResolvedValue({
      session: PHONE_SESSION,
      transcript: [{ speaker: 'bot', text: 'Hello caller', start_offset_sec: 12 }],
      assessment: null,
    });
    renderWorkspace({ sessions: [PHONE_SESSION] });
    expect(await screen.findByText('Hello caller')).toBeInTheDocument();
    expect(await screen.findByText('Recording loads on request; the link expires automatically.')).toBeInTheDocument();
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    fireEvent.click(screen.getByRole('button', { name: /Turn 1:/ }));
    await waitFor(() => expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('phone-session'));
  });

  it('a click lights nothing by itself: the row waits for the playhead, a quarter-second early as ever', async () => {
    mockApi.getSession.mockResolvedValue({
      session: PHONE_SESSION,
      transcript: [
        { speaker: 'bot', text: 'Hello caller', start_offset_sec: 5 },
        { speaker: 'candidate', text: 'Hi there', start_offset_sec: 12 },
      ],
      assessment: null,
    });
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    renderWorkspace({ sessions: [PHONE_SESSION] });
    fireEvent.click(await screen.findByRole('button', { name: /^load recording/i }));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    const audio = document.querySelector('audio') as HTMLAudioElement;
    let playhead = 0;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => playhead, set: () => undefined });
    const at = (sec: number) => {
      playhead = sec;
      fireEvent.timeUpdate(audio);
    };

    at(8);
    expect(lit()).toEqual(['1']);
    fireEvent.click(screen.getByRole('button', { name: /Turn 2:/ }));
    expect(lit()).toEqual(['1']);
    at(11.7);
    expect(lit()).toEqual(['1']);
    at(11.8);
    expect(lit()).toEqual(['2']);
    // No hold either: a move away is the rule's at once.
    at(8);
    expect(lit()).toEqual(['1']);
  });

  it('a simulation session (no round id) is still a session here', async () => {
    const simulation: Session = { ...PHONE_SESSION, id: 'sim', mode: 'simulation', interview_round_id: null };
    mockApi.getSession.mockResolvedValue({ session: simulation, transcript: [], assessment: null });
    renderWorkspace({ sessions: [simulation] });
    expect(await screen.findByText(/no transcript lines/i)).toBeInTheDocument();
  });
});
