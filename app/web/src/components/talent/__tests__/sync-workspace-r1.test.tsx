/**
 * TranscriptionSyncWorkspace, R1 branch: a session that belongs to an R1 round plays through
 * R1RecordingPlayer, never through the legacy RecordingPlayer (and never calls the legacy download),
 * its turns are placed on the recording from the attempt's anchor, a click seeks with the turn's own
 * time and lights its row through the lead-in, and a turn with no time stays untimed. Phone sessions
 * are untouched.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import type { Assessment, Session, TranscriptLine } from '../../../types';
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
  const state = { currentTime: 0, paused: true, sets: [] as number[], reloads: 0, play: vi.fn(), pause: vi.fn() };
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
  // A real element reloading for a new link stops with no `pause` event, jumps to 0 and reports that in a
  // queued task. The mock's link never changes, so the player's reload is `load()` here. An element whose
  // `src` was taken away is being let go: it stays quiet here on purpose, so that a test of a dropped hold
  // proves `onMediaDropped` ended it, not a report at 0.
  el.load = () => {
    if (!el.hasAttribute('src')) return;
    state.paused = true;
    state.currentTime = 0;
    setTimeout(() => {
      fireEvent.timeUpdate(el);
      state.reloads += 1;
    });
  };
  return state;
}

/** The mint has answered, and the driven element has reloaded and reported position 0. */
const reloaded = (state: ReturnType<typeof drive>) => waitFor(() => expect(state.reloads).toBe(1));

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

/** The rows lit right now, by turn number. */
const lit = () =>
  screen
    .queryAllByRole('button', { name: /^Turn/ })
    .filter((b) => b.getAttribute('aria-current') === 'true')
    .map((b) => /^Turn (\d+)/.exec(b.getAttribute('aria-label') ?? '')?.[1]);

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

  it('a click on a turn mints the recording and seeks to the turn less the quarter-second lead-in', async () => {
    renderWorkspace();
    await loadButton();
    fireEvent.click(await screen.findByRole('button', { name: /Turn 2:/ }));
    expect(mockApi.getR1Recording).toHaveBeenCalledWith('round-1', 'r1-session');
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    expect(state.sets).toEqual([124.75]);
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
    expect(state.sets).toEqual([124.75]);
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);

    state.sets.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /Turn 1:/ }));
    expect(state.sets).toEqual([4.75]);
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

  it('does not light a turn before its start: R1 has no early tolerance', async () => {
    renderWorkspace();
    await loadButton();
    fireEvent.click(screen.getByRole('button', { name: /^Load recording/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    state.currentTime = 124.9;
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(screen.getByRole('button', { name: /Turn 1:/ })).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByRole('button', { name: /Turn 2:/ })).not.toHaveAttribute('aria-current');
    state.currentTime = 125;
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(screen.getByRole('button', { name: /Turn 2:/ })).toHaveAttribute('aria-current', 'true'));
  });

  it('out-of-order turns, a merged acknowledgement and untimed turns: each row lights at its own start', async () => {
    // Real-shape data: every turn has `start_offset_sec` NULL and carries `started_at_ms`, two have
    // neither. Row 2 (the learner, index first) starts AFTER row 3, whose index was reserved at its
    // first transcript but whose start is the earlier voice activity: the candidate's held "Okay",
    // merged into their next question.
    mockApi.getSession.mockResolvedValue({
      session: R1_SESSION,
      transcript: [
        { speaker: 'bot', text: 'Hello there.', start_offset_sec: null, started_at_ms: START + 12_000 },
        { speaker: 'bot', text: 'Tell me about the course.', start_offset_sec: null, started_at_ms: START + 30_000 },
        { speaker: 'candidate', text: 'Okay What is the fee?', start_offset_sec: null, started_at_ms: START + 29_500 },
        { speaker: 'candidate', text: 'Saved with no time.', start_offset_sec: null, started_at_ms: null },
        { speaker: 'bot', text: 'It is nine thousand.', start_offset_sec: null, started_at_ms: START + 45_000 },
        { speaker: 'bot', text: 'Also with no time.', start_offset_sec: null, started_at_ms: null },
      ] satisfies TranscriptLine[],
      assessment: null,
    });
    renderWorkspace();
    await loadButton();
    fireEvent.click(screen.getByRole('button', { name: /^Load recording/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const state = drive(video);
    fireEvent.loadedMetadata(video);

    const at = (t: number) => {
      state.currentTime = t;
      fireEvent.timeUpdate(video);
    };

    at(5);
    await waitFor(() => expect(lit()).toEqual([]));
    at(12);
    await waitFor(() => expect(lit()).toEqual(['1']));
    at(29.5);
    await waitFor(() => expect(lit()).toEqual(['3']));
    at(30);
    await waitFor(() => expect(lit()).toEqual(['2']));
    at(44.9);
    await waitFor(() => expect(lit()).toEqual(['2']));
    at(45);
    await waitFor(() => expect(lit()).toEqual(['5']));
    // The untimed rows stay unclickable and never light.
    expect(screen.getByLabelText(/Turn 4: .*Timing data not available\./).tagName).not.toBe('BUTTON');
    expect(screen.getByLabelText(/Turn 6: .*Timing data not available\./).tagName).not.toBe('BUTTON');
  });

  describe('driven by animation frames while playing', () => {
    let frames: Map<number, FrameRequestCallback>;
    const runFrame = () => {
      const due = [...frames.values()];
      frames.clear();
      act(() => {
        for (const callback of due) callback(0);
      });
    };

    beforeEach(() => {
      frames = new Map();
      let id = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        id += 1;
        frames.set(id, callback);
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        frames.delete(handle);
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function playingVideo(onCommit?: () => void) {
      render(
        <Profiler id="workspace" onRender={() => onCommit?.()}>
          <TranscriptionSyncWorkspace sessions={[R1_SESSION]} assessments={[]} blocked={false} candidateId="c1" />
        </Profiler>,
      );
      fireEvent.click(await loadButton());
      await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
      const video = document.querySelector('video') as HTMLVideoElement;
      const state = drive(video);
      fireEvent.loadedMetadata(video);
      state.paused = false;
      fireEvent.play(video);
      return { video, state };
    }

    it('the highlight moves on a frame, with no timeupdate at all', async () => {
      const { state } = await playingVideo();
      state.currentTime = 6;
      runFrame();
      expect(screen.getByRole('button', { name: /Turn 1:/ })).toHaveAttribute('aria-current', 'true');
      state.currentTime = 125;
      runFrame();
      expect(screen.getByRole('button', { name: /Turn 2:/ })).toHaveAttribute('aria-current', 'true');
      expect(screen.getByRole('button', { name: /Turn 1:/ })).not.toHaveAttribute('aria-current');
    });

    it('renders only when the active turn changes, not on every frame', async () => {
      let commits = 0;
      const { state } = await playingVideo(() => {
        commits += 1;
      });
      state.currentTime = 6;
      runFrame();
      expect(screen.getByRole('button', { name: /Turn 1:/ })).toHaveAttribute('aria-current', 'true');
      // SeekableTranscript's own announcement effect commits once more after the change; let it settle.
      await act(async () => undefined);
      const settled = commits;
      for (let t = 6.016; t < 7; t += 0.016) {
        state.currentTime = t;
        runFrame();
      }
      expect(commits).toBe(settled);
      state.currentTime = 125;
      runFrame();
      expect(commits).toBeGreaterThan(settled);
    });

    it('a click holds its row through the lead-in on frames, and those frames render nothing', async () => {
      let commits = 0;
      const { state } = await playingVideo(() => {
        commits += 1;
      });
      state.currentTime = 30;
      runFrame();
      expect(lit()).toEqual(['1']);

      fireEvent.click(screen.getByRole('button', { name: /Turn 2:/ }));
      expect(lit()).toEqual(['2']);
      await act(async () => undefined);
      const settled = commits;
      for (let t = 124.75; t < 125; t += 0.016) {
        state.currentTime = t;
        runFrame();
        expect(lit()).toEqual(['2']);
      }
      // Reaching the start hands over to the row the rule picks, which is the same row: no render.
      state.currentTime = 125.01;
      runFrame();
      expect(lit()).toEqual(['2']);
      expect(commits).toBe(settled);
    });

    it('the loop stops on pause and when the workspace unmounts', async () => {
      const { video, state } = await playingVideo();
      expect(frames.size).toBe(1);
      state.paused = true;
      fireEvent.pause(video);
      expect(frames.size).toBe(0);
      state.paused = false;
      fireEvent.play(video);
      expect(frames.size).toBe(1);
      cleanup();
      expect(frames.size).toBe(0);
    });

    it('a session change drops the loop with its player', async () => {
      const view = render(
        <TranscriptionSyncWorkspace sessions={[R1_SESSION, PHONE_SESSION]} assessments={[]} blocked={false} candidateId="c1" />,
      );
      fireEvent.click(await loadButton());
      await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
      const video = document.querySelector('video') as HTMLVideoElement;
      const state = drive(video);
      fireEvent.loadedMetadata(video);
      state.paused = false;
      fireEvent.play(video);
      expect(frames.size).toBe(1);
      mockApi.getSession.mockResolvedValue({ session: PHONE_SESSION, transcript: [], assessment: null });
      fireEvent.change(within(view.container).getByRole('combobox'), { target: { value: 'phone-session' } });
      await screen.findByText(/no transcript lines/i);
      expect(frames.size).toBe(0);
    });
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

describe('a clicked turn lights at once and holds through the lead-in', () => {
  const turn = (n: number) => screen.getByRole('button', { name: new RegExp(`^Turn ${n}:`) });
  const mediaOnScreen = async () => {
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    return document.querySelector('video') as HTMLVideoElement;
  };

  /** A loaded, paused recording with the playhead in the test's hands. */
  async function loaded() {
    fireEvent.click(await loadButton());
    const video = await mediaOnScreen();
    const state = drive(video);
    fireEvent.loadedMetadata(video);
    const at = (sec: number) => {
      state.currentTime = sec;
      fireEvent.timeUpdate(video);
    };
    return { video, state, at };
  }

  /** Past the age at which the next click replaces the link (300 s, replaced 15 s early). */
  function ageTheLink() {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_000);
    onTestFinished(() => clock.mockRestore());
  }

  describe('the row that lights', () => {
    it('is the clicked row at start - 0.25 s, never the row before it', async () => {
      renderWorkspace();
      const { state, at } = await loaded();
      at(30);
      expect(lit()).toEqual(['1']);

      fireEvent.click(turn(2));
      expect(state.sets).toEqual([124.75]);
      expect(lit()).toEqual(['2']);
      at(124.75);
      expect(lit()).toEqual(['2']);
      at(124.9);
      expect(lit()).toEqual(['2']);
    });

    it('does not blink off when there is no earlier turn to fall back to', async () => {
      renderWorkspace();
      const { state, at } = await loaded();
      fireEvent.click(turn(1));
      expect(state.sets).toEqual([4.75]);
      expect(lit()).toEqual(['1']);
      at(4.75);
      expect(lit()).toEqual(['1']);
    });

    it('is the clicked row when two turns share a start', async () => {
      mockApi.getSession.mockResolvedValue({
        session: R1_SESSION,
        transcript: [
          { speaker: 'bot', text: 'One.', start_offset_sec: null, started_at_ms: START + 5_000 },
          { speaker: 'candidate', text: 'Two.', start_offset_sec: null, started_at_ms: START + 5_000 },
        ] satisfies TranscriptLine[],
        assessment: null,
      });
      renderWorkspace();
      const { at } = await loaded();
      fireEvent.click(turn(1));
      expect(lit()).toEqual(['1']);
      at(4.75);
      expect(lit()).toEqual(['1']);
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);
      at(4.75);
      expect(lit()).toEqual(['2']);
    });

    it('is the clicked row when an earlier-starting turn sits below it', async () => {
      mockApi.getSession.mockResolvedValue({
        session: R1_SESSION,
        transcript: [
          { speaker: 'bot', text: 'Hello there.', start_offset_sec: null, started_at_ms: START + 12_000 },
          { speaker: 'bot', text: 'Tell me about the course.', start_offset_sec: null, started_at_ms: START + 30_000 },
          { speaker: 'candidate', text: 'Okay What is the fee?', start_offset_sec: null, started_at_ms: START + 29_500 },
        ] satisfies TranscriptLine[],
        assessment: null,
      });
      renderWorkspace();
      const { at } = await loaded();
      fireEvent.click(turn(2));
      at(29.75);
      expect(lit()).toEqual(['2']);
      at(30);
      expect(lit()).toEqual(['2']);
    });

    it('lights on a click before the recording is loaded, and holds through the mint and the metadata', async () => {
      renderWorkspace();
      await loadButton();
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);

      const video = await mediaOnScreen();
      const state = drive(video);
      // The element sits at 0 until the queued seek is applied: that says nothing about the click.
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
      state.currentTime = 125;
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
    });

    it('lights on a click that lands the moment the row becomes clickable, before that render has settled', async () => {
      // React runs a render's passive effects in a later task, so a click queued behind that render lands
      // between the two. A mutation observer is a microtask: this click lands there every time.
      const watcher = new MutationObserver(() => {
        const row = document.querySelector<HTMLButtonElement>('button[aria-label^="Turn 2:"]');
        if (!row) return;
        watcher.disconnect();
        row.click();
      });
      watcher.observe(document.body, { childList: true, subtree: true });
      onTestFinished(() => watcher.disconnect());

      renderWorkspace();
      expect(await screen.findByText(/^Now playing turn 2/)).toBeInTheDocument();
      expect(lit()).toEqual(['2']);

      // Without the hold, the lead-in would light the row before the one that was clicked.
      const video = await mediaOnScreen();
      const state = drive(video);
      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
    });

    it('follows the latest of two clicks made before the recording is loaded', async () => {
      renderWorkspace();
      await loadButton();
      fireEvent.click(turn(1));
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);
      const video = await mediaOnScreen();
      const state = drive(video);
      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
    });

    it('holds while a stale link is replaced, though the old file keeps reporting its own position', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      at(30);
      ageTheLink();

      fireEvent.click(turn(2));
      expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
      expect(state.sets).toEqual([]);
      at(30.5);
      expect(lit()).toEqual(['2']);

      await reloaded(state);
      expect(lit()).toEqual(['2']);

      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
    });

    it('holds through a double-click on an aged link, and playback lands on the row', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      at(30);
      ageTheLink();

      fireEvent.click(turn(2));
      fireEvent.click(turn(2));
      expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
      await reloaded(state);
      expect(lit()).toEqual(['2']);

      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
      // Landed, so the hold is an ordinary one again: a scrub away ends it.
      at(30);
      expect(lit()).toEqual(['1']);
    });

    it('follows a second row clicked while the link is being replaced', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      at(30);
      ageTheLink();

      fireEvent.click(turn(1));
      fireEvent.click(turn(2));
      expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
      await reloaded(state);
      expect(lit()).toEqual(['2']);

      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
    });

    it('holds through a media error inside the lead-in, and the position comes back', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      fireEvent.click(turn(2));
      at(124.8);
      state.sets.length = 0;

      fireEvent.error(video);
      expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
      await reloaded(state);
      expect(lit()).toEqual(['2']);

      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([124.8]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
      at(30);
      expect(lit()).toEqual(['1']);
    });

    it('holds when the old file ends while the link is being replaced', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      at(590);
      ageTheLink();

      fireEvent.click(turn(1));
      state.currentTime = 600;
      fireEvent.ended(video);
      expect(lit()).toEqual(['1']);

      await reloaded(state);
      expect(lit()).toEqual(['1']);
      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([4.75]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['1']);
    });

    it('stays lit through a re-mint with no click behind it, and is not announced again', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      at(130);
      expect(lit()).toEqual(['2']);
      const announced = screen.getByText(/^Now playing turn 2/);

      fireEvent.error(video);
      await reloaded(state);
      expect(lit()).toEqual(['2']);
      // A live region that blanks and refills is read out again.
      expect(announced).toHaveTextContent(/^Now playing turn 2/);

      fireEvent.loadedMetadata(video);
      expect(state.sets).toEqual([130]);
      fireEvent.timeUpdate(video);
      expect(lit()).toEqual(['2']);
    });

    it('holds on a click while paused when playing does not start, and a paused scrub still releases it', async () => {
      renderWorkspace();
      const { state, at } = await loaded();
      state.play.mockRejectedValue(new Error('NotAllowedError'));
      at(30);
      fireEvent.click(turn(2));
      expect(state.paused).toBe(true);
      expect(lit()).toEqual(['2']);
      at(124.75);
      expect(lit()).toEqual(['2']);
      at(30);
      expect(lit()).toEqual(['1']);
    });
  });

  describe('the hold ends', () => {
    it('when the playhead reaches the row, and the next row can then light', async () => {
      renderWorkspace();
      const { at } = await loaded();
      fireEvent.click(turn(1));
      at(4.8);
      expect(lit()).toEqual(['1']);
      at(5);
      expect(lit()).toEqual(['1']);
      at(125);
      expect(lit()).toEqual(['2']);
    });

    it('for good at the start: a scrub back into the lead-in goes by the rule again', async () => {
      renderWorkspace();
      const { at } = await loaded();
      fireEvent.click(turn(2));
      at(125);
      expect(lit()).toEqual(['2']);
      at(124.9);
      expect(lit()).toEqual(['1']);
    });

    it.each([
      ['back to an earlier turn', 30, ['1']],
      ['back to before any turn', 2, []],
      ['just short of the lead-in', 124.5, ['1']],
      ['forward past the turn', 400, ['2']],
    ])('when the reviewer scrubs %s', async (_where, sec, rows) => {
      renderWorkspace();
      const { at } = await loaded();
      fireEvent.click(turn(2));
      at(124.75);
      expect(lit()).toEqual(['2']);
      at(sec);
      expect(lit()).toEqual(rows);
    });

    it('for good when the reviewer scrubs away: coming back to the lead-in goes by the rule', async () => {
      renderWorkspace();
      const { at } = await loaded();
      fireEvent.click(turn(2));
      at(30);
      at(124.9);
      expect(lit()).toEqual(['1']);
    });

    it('when playback ends inside the lead-in', async () => {
      renderWorkspace();
      const { video, state } = await loaded();
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);
      state.currentTime = 124.9;
      fireEvent.ended(video);
      expect(lit()).toEqual(['1']);
    });

    it('when the session changes, and it does not follow the reviewer to the next one', async () => {
      const other: Session = { ...R1_SESSION, id: 'r1-session-2', created_at: '2026-10-03T10:00:00.000Z' };
      const listed = rounds();
      listed.rounds[0].attempts?.push({
        session_id: other.id,
        attempt_number: 2,
        counted: true,
        outcome: 'completed',
        recording: recording(),
      });
      mockApi.listR1Rounds = vi.fn().mockResolvedValue(listed);
      mockApi.getSession.mockImplementation((id: string) =>
        Promise.resolve({ session: id === other.id ? other : R1_SESSION, transcript: TURNS, assessment: null }),
      );
      renderWorkspace({ sessions: [R1_SESSION, other] });
      await loaded();
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);

      fireEvent.change(screen.getByRole('combobox'), { target: { value: other.id } });
      const { at } = await loaded();
      expect(lit()).toEqual([]);
      at(124.9);
      expect(lit()).toEqual(['1']);
    });
  });

  describe('no row is left lit', () => {
    it('by a turn the player ignores because there is nothing to play', async () => {
      mockApi.listR1Rounds = vi.fn().mockResolvedValue(rounds({ state: 'processing' }));
      renderWorkspace();
      fireEvent.click(await screen.findByRole('button', { name: /Turn 2:/ }));
      expect(mockApi.getR1Recording).not.toHaveBeenCalled();
      expect(lit()).toEqual([]);
    });

    it('by a turn the player cannot place: the row the playhead lit stays, and the playhead still moves it', async () => {
      // The mint has the last word on the anchor, so a timed row can be one the player will not place.
      mockApi.getR1Recording.mockResolvedValue({
        ...recording({ started_at_ms: null }),
        url: LINK,
        content_type: 'video/mp4',
        expires_in_sec: 300,
      });
      renderWorkspace();
      const { state, at } = await loaded();
      at(30);
      fireEvent.click(turn(2));
      expect(state.sets).toEqual([]);
      expect(lit()).toEqual(['1']);
      at(2);
      expect(lit()).toEqual([]);
    });

    it('by a click whose mint fails', async () => {
      mockApi.getR1Recording.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
      renderWorkspace();
      await loadButton();
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(lit()).toEqual([]);
    });

    it('nor left announced as playing, by a click whose mint fails', async () => {
      mockApi.getR1Recording.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
      renderWorkspace();
      await loadButton();
      fireEvent.click(turn(2));
      expect(screen.getByText(/^Now playing turn 2/)).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText(/^Now playing/)).not.toBeInTheDocument());
    });

    it('by a click whose mint finds the recording deleted', async () => {
      mockApi.getR1Recording.mockResolvedValue(recording({ state: 'deleted', reason: 'retention' }));
      renderWorkspace();
      await loadButton();
      fireEvent.click(turn(2));
      expect(lit()).toEqual(['2']);
      expect(await screen.findByText(/This recording was deleted/)).toBeInTheDocument();
      expect(lit()).toEqual([]);
    });

    it('by a click on a first link that cannot be played', async () => {
      renderWorkspace();
      await loadButton();
      fireEvent.click(turn(2));
      fireEvent.error(await mediaOnScreen());
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(lit()).toEqual([]);
    });

    it('when the media is lost inside the lead-in, after the seek has landed', async () => {
      renderWorkspace();
      const { video, state, at } = await loaded();
      fireEvent.click(turn(2));
      at(124.8);
      fireEvent.error(video);
      await reloaded(state);
      // The new link loaded, so this second error is the one that gives up, not a bad first link.
      fireEvent.loadedMetadata(video);
      fireEvent.error(video);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(lit()).toEqual([]);
    });
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
    // The transcript is still there, untimed. The pointer shows before it arrives, so wait for it.
    expect(await screen.findByText('Welcome to the role-play.')).toBeInTheDocument();
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
  const POINTER = 'This role-play’s result and recording are on the Overview tab, under R1 interview.';

  it('is pointed at the R1 card for the result and the recording, and the API is not asked for the recording summary', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWorkspace();
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(screen.getByText(POINTER)).toBeInTheDocument();
    // Nothing alongside is this session's scorecard, so the pane must not say one is.
    expect(screen.queryByText(/shown alongside/)).not.toBeInTheDocument();
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
  });

  it('while an appeal blocks decision use only the recording is pointed at: the result is withheld there too', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWorkspace({ blocked: true });
    expect(await screen.findByText('This role-play’s recording is on the Overview tab, under R1 interview.')).toBeInTheDocument();
    expect(screen.queryByText(POINTER)).not.toBeInTheDocument();
    expect(screen.getByText('Scorecards are suppressed while an appeal is under review.')).toBeInTheDocument();
  });

  it.each([false, true])('a host with no R1 card (the scoped Ashby page) points at the candidate page, not at its own Overview tab (blocked: %s)', async (blocked) => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWorkspace({ candidateId: undefined, blocked });
    // The transcript pane says the same while the load is out, so wait for the denied pane itself.
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(screen.getByText('The recording for this R1 session is on the candidate page, under R1 interview.')).toBeInTheDocument();
    expect(screen.queryByText(/Overview tab/)).not.toBeInTheDocument();
    expect(mockApi.listR1Rounds).not.toHaveBeenCalled();
  });

  it('a phone session\'s denied pane keeps its words and says nothing about the Overview tab', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWorkspace({ sessions: [PHONE_SESSION] });
    expect(await screen.findByText(/require admin access.*The session scorecard is shown alongside\./i)).toBeInTheDocument();
    expect(screen.queryByText(/Overview tab/)).not.toBeInTheDocument();
    expect(screen.getByText(/^No scorecard for this session yet\./)).toBeInTheDocument();
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

  it('a non-admin, with an R1 session selected, gets the newest PHONE scorecard, labelled as the phone screening', async () => {
    renderWorkspace({ sessions: [R1_SESSION, PHONE_SESSION], assessments: [R1_ASSESSMENT, PHONE_ASSESSMENT] });
    // A bare "Latest scorecard" beside an R1 session would read as this role-play's result.
    expect(await screen.findByText('Latest phone screening scorecard')).toBeInTheDocument();
    expect(screen.queryByText('Latest scorecard')).not.toBeInTheDocument();
    expect(screen.getByText('62')).toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
  });

  it('a non-admin, with a phone session selected, keeps the "Latest scorecard" heading', async () => {
    renderWorkspace({ sessions: [PHONE_SESSION, R1_SESSION], assessments: [R1_ASSESSMENT, PHONE_ASSESSMENT] });
    expect(await screen.findByText('Latest scorecard')).toBeInTheDocument();
    expect(screen.getByText('62')).toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
  });

  it('a non-admin whose only assessment is R1 gets no scorecard and is not told the session has none', async () => {
    renderWorkspace({ sessions: [R1_SESSION], assessments: [R1_ASSESSMENT] });
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(screen.queryByText('Latest scorecard')).not.toBeInTheDocument();
    expect(screen.queryByText('Latest phone screening scorecard')).not.toBeInTheDocument();
    expect(screen.queryByText('91')).not.toBeInTheDocument();
    // The attempt may well be scored; its result is on the R1 card the denied pane points at.
    expect(screen.queryByText(/No scorecard for this session/)).not.toBeInTheDocument();
    expect(screen.getByText('No phone screening scorecard yet.')).toBeInTheDocument();
  });

  it('a non-admin with an R1 session selected sees only the labelled scorecard: the phone conflicts, role fit and summary wait for the phone session', async () => {
    const narrated: Assessment = {
      ...PHONE_ASSESSMENT,
      summary: 'A phone screening summary.',
      role_fit: { score: 8, matched_skills: ['SQL'], gaps: [], red_flags: [], notes: 'A phone role-fit note.' },
      resume_conflicts: [{ topic: 'Employment dates', resume_says: 'Two years', candidate_said: 'One year', resolved: false, note: '' }],
    };
    const headings = () => screen.getAllByRole('heading').map((h) => h.textContent ?? '');
    renderWorkspace({ sessions: [R1_SESSION, PHONE_SESSION], assessments: [R1_ASSESSMENT, narrated] });
    expect(await screen.findByText('Latest phone screening scorecard')).toBeInTheDocument();
    expect(headings().filter((h) => /^(Resume conflicts|Role fit|Summary)/.test(h))).toEqual([]);
    expect(screen.queryByText('A phone screening summary.')).not.toBeInTheDocument();
    expect(screen.queryByText('A phone role-fit note.')).not.toBeInTheDocument();
    expect(screen.queryByText('Employment dates')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'phone-session' } });
    expect(await screen.findByText('A phone screening summary.')).toBeInTheDocument();
    expect(screen.getByText('A phone role-fit note.')).toBeInTheDocument();
    expect(screen.getByText('Employment dates')).toBeInTheDocument();
    expect(screen.getByText('Latest scorecard')).toBeInTheDocument();
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

  it('an admin still reads the selected R1 session\'s own scorecard: R1 stays in the picker for now', async () => {
    mockApi.getSession.mockResolvedValue({ session: R1_SESSION, transcript: TURNS, assessment: R1_ASSESSMENT });
    renderWorkspace({ sessions: [R1_SESSION, PHONE_SESSION], assessments: [R1_ASSESSMENT, PHONE_ASSESSMENT] });
    expect(await screen.findByText('Scorecard for this session')).toBeInTheDocument();
    expect(screen.getByText('91')).toBeInTheDocument();
    expect(screen.getAllByRole('option').filter((o) => /R1 role-play/.test(o.textContent ?? ''))).toHaveLength(1);
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
    await screen.findByText(/on the Overview tab, under R1 interview/);
    await expect(denied.container).toHaveNoViolations();
  });
});
