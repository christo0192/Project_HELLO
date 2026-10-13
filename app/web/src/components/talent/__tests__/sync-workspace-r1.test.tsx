/**
 * TranscriptionSyncWorkspace, R1 branch: a session that belongs to an R1 round plays through
 * R1RecordingPlayer, never through the legacy RecordingPlayer (and never calls the legacy download),
 * its turns are placed on the recording from the attempt's anchor, a click seeks with the turn's own
 * time, and a turn with no time stays untimed. Phone sessions are untouched.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import type { Session, TranscriptLine } from '../../../types';
import type { R1RecordingSummary, R1Round } from '../../../lib/r1-types';

const mockApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  getCandidatePhoneAttempts: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  getAttemptRecordingDownloadUrl: vi.fn(),
  listR1Rounds: vi.fn() as ReturnType<typeof vi.fn> | undefined,
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

const START = 1_790_000_000_000;
const LINK = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/r1/x/video.mp4?X-Amz-Signature=SIG_WS_1';

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

const TURNS: TranscriptLine[] = [
  { speaker: 'bot', text: 'Welcome to the role-play.', start_offset_sec: null, started_at_ms: START + 5_000 },
  { speaker: 'candidate', text: 'Thanks, shall we begin?', start_offset_sec: null, started_at_ms: START + 125_000 },
  { speaker: 'candidate', text: 'A turn with no time at all.', start_offset_sec: null, started_at_ms: null },
];

function recording(over: Partial<R1RecordingSummary> = {}): R1RecordingSummary {
  return {
    state: 'ready',
    reason: null,
    mode: 'single',
    has_video: true,
    started_at_ms: START,
    duration_ms: 600_000,
    camera_off_ms: 0,
    degraded_at_ms: null,
    retention_until: '2027-01-12T10:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

function rounds(over: Partial<R1RecordingSummary> = {}): { rounds: R1Round[] } {
  return {
    rounds: [
      {
        id: 'round-1',
        status: 'completed',
        expires_at: '2026-10-09T10:00:00.000Z',
        attempts_allowed: 2,
        attempts_counted: 1,
        recommendation: null,
        overall: null,
        created_at: '2026-10-01T10:00:00.000Z',
        attempts: [
          { session_id: 'r1-session', attempt_number: 1, counted: true, outcome: 'completed', recording: recording(over) },
        ],
      },
    ],
  };
}

function drive(el: HTMLMediaElement) {
  const state = { currentTime: 0, paused: true, sets: [] as number[], play: vi.fn(), pause: vi.fn() };
  state.play.mockImplementation(() => {
    state.paused = false;
    return Promise.resolve();
  });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => state.currentTime,
    set: (v: number) => {
      state.currentTime = v;
      state.sets.push(v);
    },
  });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => state.paused });
  el.play = state.play as unknown as HTMLMediaElement['play'];
  el.pause = state.pause as unknown as HTMLMediaElement['pause'];
  return state;
}

function renderWorkspace(props: Partial<React.ComponentProps<typeof TranscriptionSyncWorkspace>> = {}) {
  return render(
    <TranscriptionSyncWorkspace
      sessions={[R1_SESSION]}
      assessments={[]}
      blocked={false}
      candidateId="c1"
      {...props}
    />,
  );
}

const loadButton = () => screen.findByRole('button', { name: /^load recording/i });

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __allowConsole?: (p: RegExp) => void }).__allowConsole?.(/inside a test was not wrapped in act/);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.listR1Rounds = vi.fn().mockResolvedValue(rounds());
  mockApi.getSession.mockResolvedValue({ session: R1_SESSION, transcript: TURNS, assessment: null });
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
  mockApi.getR1Recording.mockResolvedValue({ ...recording(), url: LINK, content_type: 'video/mp4', expires_in_sec: 300 });
});

describe('an R1 session on the Review tab', () => {
  it('plays through the R1 player and never touches the legacy recording player or its download', async () => {
    renderWorkspace();
    expect(await loadButton()).toBeInTheDocument();
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(mockApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(document.getElementById('sync-workspace-audio')).toBeNull();
    // Only one Load button, and it is the R1 one (named for the session, not "Recording").
    expect(screen.getAllByRole('button', { name: /load recording/i })).toHaveLength(1);
    expect(screen.queryByText('Recording loads on request; the link expires automatically.')).not.toBeInTheDocument();
  });

  it('reads the attempt\'s summary from the rounds list, once the transcript is in, and mints nothing yet', async () => {
    renderWorkspace();
    await loadButton();
    expect(mockApi.listR1Rounds).toHaveBeenCalledTimes(1);
    expect(mockApi.listR1Rounds).toHaveBeenCalledWith('c1');
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('names the session "R1 role-play" in the selector, not "Live voice"', async () => {
    renderWorkspace({ sessions: [R1_SESSION, PHONE_SESSION] });
    await loadButton();
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options.some((text) => text.includes('R1 role-play'))).toBe(true);
    expect(options.filter((text) => text.includes('R1 role-play'))).toHaveLength(1);
    expect(options.filter((text) => text.includes('Live voice'))).toHaveLength(1);
  });

  it('shows each turn at its place in the recording, and leaves a turn with no time untimed', async () => {
    renderWorkspace();
    await loadButton();
    const first = await screen.findByRole('button', { name: /Turn 1: .*At 0:05\./ });
    expect(first).toHaveTextContent('0:05');
    expect(screen.getByRole('button', { name: /Turn 2: .*At 2:05\./ })).toHaveTextContent('2:05');
    const untimed = screen.getByLabelText(/Turn 3: .*Timing data not available\./);
    expect(untimed.tagName).not.toBe('BUTTON');
    expect(within(untimed).getByText('no timing data')).toBeInTheDocument();
  });

  it('while the summary is loading the turns are untimed (no wrong time is shown first)', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockApi.listR1Rounds = vi.fn().mockReturnValue(new Promise((resolve) => (release = resolve)));
    renderWorkspace();
    expect(await screen.findByText('Loading recording details…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn 1:/ })).not.toBeInTheDocument();
    await act(async () => release(rounds()));
    expect(await screen.findByRole('button', { name: /Turn 1:/ })).toBeInTheDocument();
  });

  it('a click on a turn mints the recording and seeks to the turn less the one-second lead-in', async () => {
    renderWorkspace();
    await loadButton();
    fireEvent.click(await screen.findByRole('button', { name: /Turn 2:/ }));
    expect(mockApi.getR1Recording).toHaveBeenCalledWith('round-1', 'r1-session');
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    expect(state.sets).toEqual([124]);
    expect(state.play).toHaveBeenCalled();
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('a click on an early turn clamps the lead-in at the start, and the latest click wins', async () => {
    renderWorkspace();
    await loadButton();
    fireEvent.click(await screen.findByRole('button', { name: /Turn 1:/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Turn 2:/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    expect(state.sets).toEqual([124]);
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);

    state.sets.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /Turn 1:/ }));
    expect(state.sets).toEqual([4]);
  });

  it('highlights the turn that is playing', async () => {
    renderWorkspace();
    await loadButton();
    fireEvent.click(screen.getByRole('button', { name: /^Load recording/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    state.currentTime = 130;
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(screen.getByRole('button', { name: /Turn 2:/ })).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByRole('button', { name: /Turn 1:/ })).not.toHaveAttribute('aria-current');
  });

  it('a recording that is still processing: turns are timed but there is nothing to play', async () => {
    mockApi.listR1Rounds = vi.fn().mockResolvedValue(rounds({ state: 'processing' }));
    renderWorkspace();
    expect(await screen.findByText('The recording is being prepared. This usually takes a few minutes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Turn 2:/ }));
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('"Check again" re-reads the rounds and offers Load once it is ready', async () => {
    mockApi.listR1Rounds = vi.fn().mockResolvedValue(rounds({ state: 'processing' }));
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /check again/i }));
    mockApi.listR1Rounds.mockResolvedValue(rounds());
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalledTimes(2));
    expect(await loadButton()).toBeInTheDocument();
  });

  it('a Check again keeps the player that is on screen while the list is re-read', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockApi.listR1Rounds = vi.fn().mockResolvedValueOnce(rounds({ state: 'processing' }));
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /check again/i }));
    mockApi.listR1Rounds.mockReturnValue(new Promise((resolve) => (release = resolve)));
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalledTimes(2));
    // While the second read is out the player stays rather than flashing "Loading".
    expect(screen.queryByText('Loading recording details…')).not.toBeInTheDocument();
    await act(async () => release(rounds()));
    expect(await loadButton()).toBeInTheDocument();
  });

  it('active=false pauses a loaded R1 recording', async () => {
    const view = renderWorkspace({ active: true });
    await loadButton();
    fireEvent.click(screen.getByRole('button', { name: /^Load recording/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    view.rerender(
      <TranscriptionSyncWorkspace sessions={[R1_SESSION]} assessments={[]} blocked={false} candidateId="c1" active={false} />,
    );
    expect(state.pause).toHaveBeenCalled();
  });

  it('switching to another session drops the R1 player', async () => {
    renderWorkspace({ sessions: [R1_SESSION, PHONE_SESSION] });
    await loadButton();
    mockApi.getSession.mockResolvedValue({
      session: PHONE_SESSION,
      transcript: [{ speaker: 'bot', text: 'Phone hello', start_offset_sec: 3 }],
      assessment: null,
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'phone-session' } });
    expect(await screen.findByText('Phone hello')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load recording/i })).toBeInTheDocument();
    // The phone session shows the LEGACY player (no "Attempt"/R1 naming).
    expect(screen.getByText('Recording loads on request; the link expires automatically.')).toBeInTheDocument();
  });
});

describe('when the R1 summary cannot be had', () => {
  const POINTER = 'The recording for this R1 session is on the candidate page, under R1 interview.';

  it('a reduced API adapter without the rounds call degrades to a pointer, never an error', async () => {
    mockApi.listR1Rounds = undefined;
    renderWorkspace();
    expect(await screen.findByText(POINTER)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    // The transcript is still there, untimed.
    expect(screen.getByText('Welcome to the role-play.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn 1:/ })).not.toBeInTheDocument();
  });

  it('a host without a candidate id (the scoped Ashby page) gets the pointer and no read', async () => {
    renderWorkspace({ candidateId: undefined });
    expect(await screen.findByText(POINTER)).toBeInTheDocument();
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
  });

  it('a rounds call that throws synchronously does not unmount the transcript', async () => {
    mockApi.listR1Rounds = vi.fn().mockImplementation(() => {
      throw new TypeError('api.listR1Rounds is not a function');
    });
    renderWorkspace();
    expect(await screen.findByText(POINTER)).toBeInTheDocument();
    expect(screen.getByText('Welcome to the role-play.')).toBeInTheDocument();
  });

  it('a failed rounds read degrades to the pointer', async () => {
    mockApi.listR1Rounds = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    renderWorkspace();
    expect(await screen.findByText(POINTER)).toBeInTheDocument();
  });

  it('a round that does not list this session degrades to the pointer', async () => {
    mockApi.listR1Rounds = vi.fn().mockResolvedValue({
      rounds: [{ ...rounds().rounds[0], attempts: [] }],
    });
    renderWorkspace();
    expect(await screen.findByText(POINTER)).toBeInTheDocument();
  });

  it('an older API without attempts degrades to the pointer', async () => {
    const legacy = rounds().rounds[0];
    delete legacy.attempts;
    mockApi.listR1Rounds = vi.fn().mockResolvedValue({ rounds: [legacy] });
    renderWorkspace();
    expect(await screen.findByText(POINTER)).toBeInTheDocument();
  });
});

describe('a person who cannot read the transcript', () => {
  it('is pointed at the Overview tab, and the API is not asked for the recording summary', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWorkspace();
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(screen.getByText('The recording is on the Overview tab.')).toBeInTheDocument();
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
  });

  it('a phone session\'s denied pane says nothing about the Overview tab', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWorkspace({ sessions: [PHONE_SESSION] });
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(screen.queryByText('The recording is on the Overview tab.')).not.toBeInTheDocument();
  });
});

describe('phone sessions are unchanged', () => {
  it('shows the legacy player, reads no R1 rounds, and seeks with the plain offset', async () => {
    mockApi.getSession.mockResolvedValue({
      session: PHONE_SESSION,
      transcript: [{ speaker: 'bot', text: 'Hello caller', start_offset_sec: 12 }],
      assessment: null,
    });
    renderWorkspace({ sessions: [PHONE_SESSION], candidateId: 'c1' });
    expect(await screen.findByText('Hello caller')).toBeInTheDocument();
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
    expect(await screen.findByText('Recording loads on request; the link expires automatically.')).toBeInTheDocument();
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    fireEvent.click(screen.getByRole('button', { name: /Turn 1:/ }));
    await waitFor(() => expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('phone-session'));
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('a simulation session (no round id) is not mistaken for R1', async () => {
    const simulation: Session = { ...PHONE_SESSION, id: 'sim', mode: 'simulation', interview_round_id: null };
    mockApi.getSession.mockResolvedValue({ session: simulation, transcript: [], assessment: null });
    renderWorkspace({ sessions: [simulation] });
    expect(await screen.findByText(/no transcript lines/i)).toBeInTheDocument();
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
    expect(screen.queryByText(/R1 role-play/)).not.toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations for an R1 session (idle, then with the video loaded)', async () => {
    const { container } = renderWorkspace();
    await loadButton();
    await screen.findByRole('button', { name: /Turn 1:/ });
    await expect(container).toHaveNoViolations();
    fireEvent.click(screen.getByRole('button', { name: /^Load recording/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations for the pointer and the denied pane', async () => {
    mockApi.listR1Rounds = undefined;
    const pointer = renderWorkspace();
    await screen.findByText(/on the candidate page, under R1 interview/);
    await expect(pointer.container).toHaveNoViolations();
    pointer.unmount();

    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const denied = renderWorkspace();
    await screen.findByText('The recording is on the Overview tab.');
    await expect(denied.container).toHaveNoViolations();
  });
});
