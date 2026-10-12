/**
 * R1RecordingPlayer: when a link is minted (only on an explicit action), what is drawn for every
 * state, the expiry rules (one automatic re-mint after metadata, none before, a proactive re-mint
 * before the link dies), click-to-seek queueing, split playback, hidden-tab pausing, and the rule
 * that the signed link is never rendered anywhere but the media `src`.
 *
 * Media elements are driven by hand: jsdom plays nothing, so each test stubs the element's position
 * and fires the media events the browser would.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, createRef } from 'react';
import type { R1RecordingPlayback, R1RecordingSummary } from '../../../lib/r1-types';
import { R1RecordingPlayer } from '../R1RecordingPlayer';
import type { R1RecordingPlayerHandle, R1RecordingPlayerProps } from '../R1RecordingPlayer';

const mockApi = vi.hoisted(() => ({ getR1Recording: vi.fn() }));

vi.mock('../../../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

class TestApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const START = 1_790_000_000_000;
// Sentinels: the test greps the page for these, so a link leaking anywhere else is caught.
const SIG_ONE = 'SIGNATURE_ONE_9f31';
const SIG_TWO = 'SIGNATURE_TWO_77ab';
const link = (name: string, sig: string) =>
  `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/r1/${name}?X-Amz-Signature=${sig}`;
const URL_ONE = link('video.mp4', SIG_ONE);
const URL_TWO = link('video.mp4', SIG_TWO);

function listed(over: Partial<R1RecordingSummary> = {}): R1RecordingSummary {
  return {
    state: 'ready',
    reason: null,
    mode: 'single',
    has_video: true,
    started_at_ms: START,
    duration_ms: 423_000,
    camera_off_ms: 0,
    degraded_at_ms: null,
    retention_until: '2027-01-12T10:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

function minted(over: Partial<R1RecordingPlayback> = {}): R1RecordingPlayback {
  return { ...listed(), url: URL_ONE, content_type: 'video/mp4', expires_in_sec: 300, ...over };
}

/** A clock the expiry rules read through `performance.now()`. */
let nowMs = 1_000;
function setNow(ms: number) {
  nowMs = ms;
}

interface MediaState {
  currentTime: number;
  paused: boolean;
  sets: number[];
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
}

/** Give one element its own position, so a test can read what the player set. */
function drive(el: HTMLMediaElement, start: Partial<Pick<MediaState, 'currentTime' | 'paused'>> = {}): MediaState {
  const state: MediaState = {
    currentTime: start.currentTime ?? 0,
    paused: start.paused ?? true,
    sets: [],
    play: vi.fn(),
    pause: vi.fn(),
  };
  state.play.mockImplementation(() => {
    state.paused = false;
    return Promise.resolve();
  });
  state.pause.mockImplementation(() => {
    state.paused = true;
  });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => state.currentTime,
    set: (value: number) => {
      state.currentTime = value;
      state.sets.push(value);
    },
  });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => state.paused });
  el.play = state.play as unknown as HTMLMediaElement['play'];
  el.pause = state.pause as unknown as HTMLMediaElement['pause'];
  return state;
}

function failWith(el: HTMLMediaElement, code: number) {
  Object.defineProperty(el, 'error', { configurable: true, get: () => ({ code }) });
  fireEvent.error(el);
}

interface Rendered {
  ref: React.RefObject<R1RecordingPlayerHandle | null>;
  props: R1RecordingPlayerProps;
  view: ReturnType<typeof render>;
  rerender: (over?: Partial<R1RecordingPlayerProps>) => void;
}

function renderPlayer(over: Partial<R1RecordingPlayerProps> = {}): Rendered {
  const ref = createRef<R1RecordingPlayerHandle>();
  const props: R1RecordingPlayerProps = {
    roundId: 'round-1',
    sessionId: 'session-1',
    summary: listed(),
    label: 'Attempt 1 (counted)',
    onNeedRefresh: vi.fn(),
    onStateChange: vi.fn(),
    onTimeUpdate: vi.fn(),
    onPlayState: vi.fn(),
    ...over,
  };
  const view = render(<R1RecordingPlayer ref={ref} {...props} />);
  return {
    ref,
    props,
    view,
    rerender: (next = {}) => view.rerender(<R1RecordingPlayer ref={ref} {...props} {...next} />),
  };
}

const loadButton = () => screen.getByRole('button', { name: /^load recording/i });
const mediaEl = (view: Rendered['view'], selector = 'video, audio[controls]') =>
  view.container.querySelector(selector) as HTMLMediaElement | null;

/** Click Load and wait for the media element, driven and with metadata loaded unless told otherwise. */
async function loadIt(r: Rendered, opts: { metadata?: boolean; selector?: string } = {}) {
  fireEvent.click(loadButton());
  await waitFor(() => expect(mediaEl(r.view, opts.selector)).not.toBeNull());
  const el = mediaEl(r.view, opts.selector)!;
  const state = drive(el);
  if (opts.metadata !== false) fireEvent.loadedMetadata(el);
  return { el, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  setNow(1_000);
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getR1Recording.mockReset();
  mockApi.getR1Recording.mockResolvedValue(minted());
});

/* ── Minting ──────────────────────────────────────────────────────── */

describe('minting the link', () => {
  it('does NOT mint on mount, for any state', () => {
    for (const state of ['ready', 'partial', 'processing', 'failed', 'deleted', 'none', 'recording'] as const) {
      const { view } = renderPlayer({ summary: listed({ state }) });
      view.unmount();
    }
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('offers a Load button named for the attempt, and nothing to play yet', () => {
    const r = renderPlayer();
    expect(screen.getByRole('button', { name: 'Load recording, Attempt 1 (counted)' })).toBeInTheDocument();
    expect(mediaEl(r.view)).toBeNull();
  });

  it('mints with (roundId, sessionId) only when Load is pressed, then shows a video', async () => {
    const r = renderPlayer();
    fireEvent.click(loadButton());
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    expect(mockApi.getR1Recording).toHaveBeenCalledWith('round-1', 'session-1');
    expect(screen.getByText('Loading recording…')).toBeInTheDocument();

    const video = (await waitFor(() => {
      const el = r.view.container.querySelector('video');
      expect(el).not.toBeNull();
      return el;
    })) as HTMLVideoElement;
    expect(video).toHaveAttribute('src', URL_ONE);
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('controlslist', 'nodownload');
    expect(video).not.toHaveAttribute('crossorigin');
    expect(video).not.toHaveAttribute('autoplay');
    expect(video.querySelector('track')).toBeNull();
    expect(video).toHaveAccessibleName('Interview recording, Attempt 1 (counted)');
    expect(screen.queryByText('Loading recording…')).not.toBeInTheDocument();
    expect(r.ref.current?.hasUrl).toBe(true);
  });

  it('two requests for the link at once make one request', async () => {
    const r = renderPlayer();
    // The button gives way to "Loading…" at once; the handle (click-to-seek) can still ask twice.
    act(() => {
      void r.ref.current!.load();
      void r.ref.current!.load();
      r.ref.current!.playFrom(5);
    });
    await waitFor(() => expect(mediaEl(r.view)).not.toBeNull());
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
  });

  it('the Load button gives way to a status line while the link is being minted', () => {
    mockApi.getR1Recording.mockReturnValue(new Promise(() => undefined));
    renderPlayer();
    fireEvent.click(loadButton());
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading recording…');
  });

  it('exposes hasUrl=false before and after a failed mint', async () => {
    mockApi.getR1Recording.mockRejectedValue(new TestApiError('service_unavailable', 503));
    const r = renderPlayer();
    expect(r.ref.current?.hasUrl).toBe(false);
    fireEvent.click(loadButton());
    await screen.findByRole('alert');
    expect(r.ref.current?.hasUrl).toBe(false);
  });

  it('load() on the handle mints once and resolves after the mint settles', async () => {
    const r = renderPlayer();
    await act(async () => {
      await r.ref.current!.load();
    });
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    expect(mediaEl(r.view)).not.toBeNull();
    await act(async () => {
      await r.ref.current!.load();
    });
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
  });

  it('load() does nothing for a recording that has no file', async () => {
    const r = renderPlayer({ summary: listed({ state: 'processing' }) });
    await act(async () => {
      await r.ref.current!.load();
    });
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });
});

/* ── States without a player ──────────────────────────────────────── */

describe('a recording that cannot be played renders no media element', () => {
  it.each([
    ['processing', 'The recording is being prepared. This usually takes a few minutes.'],
    ['recording', 'In progress. It can be played a few minutes after the interview ends.'],
    ['failed', 'The recording is unavailable.'],
    ['deleted', 'This recording was deleted.'],
    ['none', 'No recording was made for this attempt.'],
  ] as const)('%s', (state, words) => {
    const r = renderPlayer({ summary: listed({ state, reason: null }) });
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
  });

  it('an unknown state fails closed: a status line, a re-read, never a Load', () => {
    const r = renderPlayer({ summary: { state: 'revoked' } as unknown as R1RecordingSummary });
    expect(screen.getByText('Recording status unknown.')).toBeInTheDocument();
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again, Attempt 1 (counted)' }));
    expect(r.props.onNeedRefresh).toHaveBeenCalledTimes(1);
  });

  it('processing offers "Check again", which asks the host to re-read', () => {
    const r = renderPlayer({ summary: listed({ state: 'processing' }) });
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(r.props.onNeedRefresh).toHaveBeenCalledTimes(1);
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('offers no "Check again" when the host cannot re-read', () => {
    renderPlayer({ summary: listed({ state: 'processing' }), onNeedRefresh: undefined });
    expect(screen.queryByRole('button', { name: /check again/i })).not.toBeInTheDocument();
  });

  it('names the reason for a failed or deleted recording', () => {
    const failed = renderPlayer({ summary: listed({ state: 'failed', reason: 'integrity' }) });
    expect(screen.getByText('It failed an integrity check and is withheld.')).toBeInTheDocument();
    failed.view.unmount();
    renderPlayer({ summary: listed({ state: 'deleted', reason: 'consent_withdrawn', deleted_at: '2026-12-01T08:00:00.000Z' }) });
    expect(screen.getByText(/deleted on .*2026 because consent was withdrawn\./)).toBeInTheDocument();
  });

  it('a mint that answers with such a state replaces the Load button with that state', async () => {
    mockApi.getR1Recording.mockResolvedValue({ state: 'failed', reason: 'object_missing' });
    const r = renderPlayer();
    fireEvent.click(loadButton());
    expect(await screen.findByText('The recording file is missing, so it is withheld.')).toBeInTheDocument();
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    expect(r.props.onStateChange).toHaveBeenCalledWith('failed');
  });

  it('a mint that says ready/partial with no usable link is a fault, not a player', async () => {
    mockApi.getR1Recording.mockResolvedValue(minted({ url: undefined }));
    const r = renderPlayer();
    fireEvent.click(loadButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the recording. Try again.');
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
  });

  it('refuses a link that is not a web or data URL', async () => {
    mockApi.getR1Recording.mockResolvedValue(minted({ url: 'javascript:alert(1)' }));
    const r = renderPlayer();
    fireEvent.click(loadButton());
    await screen.findByRole('alert');
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
  });
});

/* ── What a ready / partial recording says ────────────────────────── */

describe('ready and partial', () => {
  it('says how long it is, when it is kept until, and how long the camera was off', () => {
    renderPlayer({ summary: listed({ camera_off_ms: 80_000 }) });
    expect(screen.getByText(/Length 7m 3s · Kept until .*2027 · Camera was off for 1m 20s/)).toBeInTheDocument();
  });

  it('explains a partial recording by its reason', () => {
    renderPlayer({ summary: listed({ state: 'partial', reason: 'audio_only_degraded', degraded_at_ms: 125_000 }) });
    expect(screen.getByText('Video stopped at 2:05 to protect the interview; the rest is audio only.')).toBeInTheDocument();
    expect(screen.getByText('Partial')).toBeInTheDocument();
  });

  it('keeps its facts and notice after the media loads', async () => {
    mockApi.getR1Recording.mockResolvedValue(minted({ state: 'partial', reason: 'crash_recovered' }));
    const r = renderPlayer({ summary: listed({ state: 'partial', reason: 'crash_recovered' }) });
    await loadIt(r);
    expect(screen.getByText('Recovered after an interruption; it may end early.')).toBeInTheDocument();
    expect(screen.getByText(/Length 7m 3s/)).toBeInTheDocument();
  });

  it('the mint answer overrides the list (retention date, state)', async () => {
    mockApi.getR1Recording.mockResolvedValue(minted({ retention_until: '2027-03-03T10:00:00.000Z' }));
    const r = renderPlayer();
    await loadIt(r);
    expect(screen.getByText(/Kept until .*Mar.*2027|Kept until 3 .*2027/)).toBeInTheDocument();
  });
});

/* ── Audio only ───────────────────────────────────────────────────── */

describe('audio only', () => {
  it('has_video=false renders an <audio>, never a black <video>', async () => {
    mockApi.getR1Recording.mockResolvedValue(
      minted({ has_video: false, content_type: 'audio/mp4', url: link('stream.mp4', SIG_ONE) }),
    );
    const r = renderPlayer({ summary: listed({ has_video: false }) });
    fireEvent.click(loadButton());
    await waitFor(() => expect(r.view.container.querySelector('audio')).not.toBeNull());
    expect(r.view.container.querySelector('video')).toBeNull();
    const audio = r.view.container.querySelector('audio')!;
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('preload', 'metadata');
    expect(audio).toHaveAccessibleName('Interview audio recording, Attempt 1 (counted)');
  });

  it('an OGG recording (audio_only layout) plays as audio', async () => {
    mockApi.getR1Recording.mockResolvedValue(
      minted({ has_video: false, content_type: 'audio/ogg', mode: 'single', url: link('audio.ogg', SIG_ONE) }),
    );
    const r = renderPlayer();
    fireEvent.click(loadButton());
    await waitFor(() => expect(r.view.container.querySelector('audio')).not.toBeNull());
    expect(r.view.container.querySelector('video')).toBeNull();
  });
});

/* ── Expiry ───────────────────────────────────────────────────────── */

describe('an error after metadata (the link most likely expired)', () => {
  it('re-mints exactly once and restores the position and play state', async () => {
    mockApi.getR1Recording.mockResolvedValueOnce(minted()).mockResolvedValueOnce(minted({ url: URL_TWO }));
    const r = renderPlayer();
    const { el, state } = await loadIt(r);
    state.currentTime = 100;
    state.paused = false;

    failWith(el, 2);

    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    // The new link loads: the saved position and the playing state come back.
    state.play.mockClear();
    fireEvent.loadedMetadata(el);
    expect(state.sets.at(-1)).toBe(100);
    expect(state.play).toHaveBeenCalledTimes(1);
    // No error block was ever shown.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restores a paused position without playing', async () => {
    mockApi.getR1Recording.mockResolvedValueOnce(minted()).mockResolvedValueOnce(minted({ url: URL_TWO }));
    const r = renderPlayer();
    const { el, state } = await loadIt(r);
    state.currentTime = 55.5;
    state.paused = true;
    failWith(el, 2);
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    state.play.mockClear();
    fireEvent.loadedMetadata(el);
    expect(state.sets.at(-1)).toBe(55.5);
    expect(state.play).not.toHaveBeenCalled();
  });

  it('a second error inside 30 s shows the error block, with Try again', async () => {
    mockApi.getR1Recording.mockResolvedValueOnce(minted()).mockResolvedValueOnce(minted({ url: URL_TWO }));
    const r = renderPlayer();
    const { el } = await loadIt(r);
    failWith(el, 2);
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    fireEvent.loadedMetadata(el);

    setNow(1_000 + 29_000);
    failWith(el, 2);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The recording could not be played. Try again.');
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again, Attempt 1 (counted)' })).toBeInTheDocument();
  });

  it('allows another automatic re-mint once 30 s have passed', async () => {
    mockApi.getR1Recording
      .mockResolvedValueOnce(minted())
      .mockResolvedValueOnce(minted({ url: URL_TWO }))
      .mockResolvedValueOnce(minted({ url: link('video.mp4', 'SIGNATURE_THREE') }));
    const r = renderPlayer();
    const { el } = await loadIt(r);
    failWith(el, 2);
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    fireEvent.loadedMetadata(el);

    setNow(1_000 + 30_000);
    failWith(el, 2);
    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Try again after the error block mints a fresh link and puts the playhead back', async () => {
    mockApi.getR1Recording
      .mockResolvedValueOnce(minted())
      .mockResolvedValueOnce(minted({ url: URL_TWO }))
      .mockResolvedValueOnce(minted({ url: link('video.mp4', 'SIGNATURE_THREE') }));
    const r = renderPlayer();
    const { el, state } = await loadIt(r);
    failWith(el, 2);
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    fireEvent.loadedMetadata(el);
    state.currentTime = 200;
    fireEvent.timeUpdate(el);
    setNow(1_000 + 5_000);
    failWith(el, 2);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenCalledTimes(3));
    const next = await waitFor(() => {
      const found = mediaEl(r.view)!;
      expect(found).not.toBeNull();
      return found;
    });
    const nextState = drive(next);
    fireEvent.loadedMetadata(next);
    expect(nextState.sets.at(-1)).toBe(200);
    expect(nextState.play).not.toHaveBeenCalled();
  });
});

describe('an error before metadata (a bad first link)', () => {
  it('shows the error block at once and does NOT retry on its own', async () => {
    const r = renderPlayer();
    const { el } = await loadIt(r, { metadata: false });
    failWith(el, 2);
    expect(await screen.findByRole('alert')).toHaveTextContent('The recording could not be played. Try again.');
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('an unsupported-format error with a decodable type is still a plain failure', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    const r = renderPlayer();
    const { el } = await loadIt(r, { metadata: false });
    failWith(el, 4);
    expect(await screen.findByRole('alert')).toHaveTextContent('The recording could not be played. Try again.');
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
  });

  it('says the browser cannot play it when it says it cannot decode that type', async () => {
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const r = renderPlayer();
    const { el } = await loadIt(r, { metadata: false });
    failWith(el, 4);
    expect(await screen.findByRole('alert')).toHaveTextContent('This browser cannot play this recording.');
    expect(canPlayType).toHaveBeenCalledWith('video/mp4');
    // Not retryable: another link would not change what the browser can decode.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('Try again mints a fresh link', async () => {
    const r = renderPlayer();
    const { el } = await loadIt(r, { metadata: false });
    failWith(el, 2);
    await screen.findByRole('alert');
    mockApi.getR1Recording.mockResolvedValueOnce(minted({ url: URL_TWO }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(mediaEl(r.view)).toHaveAttribute('src', URL_TWO));
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
  });
});

describe('a link close to expiry is replaced before the request fails', () => {
  async function loadedAt(r: Rendered) {
    mockApi.getR1Recording.mockResolvedValueOnce(minted({ expires_in_sec: 300 }));
    return loadIt(r);
  }

  it('play(): re-mints first, then resumes where it was', async () => {
    const r = renderPlayer();
    const { el, state } = await loadedAt(r);
    state.currentTime = 42;
    mockApi.getR1Recording.mockResolvedValueOnce(minted({ url: URL_TWO }));
    setNow(1_000 + 286_000);

    act(() => r.ref.current!.play());
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
    expect(state.play).not.toHaveBeenCalled();
    fireEvent.loadedMetadata(el);
    expect(state.sets.at(-1)).toBe(42);
    expect(state.play).toHaveBeenCalledTimes(1);
  });

  it('does not re-mint while the link has time left', async () => {
    const r = renderPlayer();
    const { state } = await loadedAt(r);
    setNow(1_000 + 284_000);
    act(() => r.ref.current!.play());
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    expect(state.play).toHaveBeenCalledTimes(1);
  });

  it('seek(): re-mints and lands on the requested time', async () => {
    const r = renderPlayer();
    const { el, state } = await loadedAt(r);
    mockApi.getR1Recording.mockResolvedValueOnce(minted({ url: URL_TWO }));
    setNow(1_000 + 290_000);
    act(() => r.ref.current!.seek(300));
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    fireEvent.loadedMetadata(el);
    expect(state.sets.at(-1)).toBe(300);
  });

  it('the native Play and a native seek are covered too', async () => {
    const r = renderPlayer();
    const { el, state } = await loadedAt(r);
    mockApi.getR1Recording.mockResolvedValueOnce(minted({ url: URL_TWO }));
    setNow(1_000 + 290_000);
    state.currentTime = 12;
    fireEvent.play(el);
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);

    // Fresh link: a seek right after does not re-mint again.
    fireEvent.loadedMetadata(el);
    state.currentTime = 80;
    fireEvent.seeking(el);
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
  });

  it('is measured on one monotonic clock, from the response', async () => {
    const r = renderPlayer();
    let release: (value: R1RecordingPlayback) => void = () => undefined;
    mockApi.getR1Recording.mockReturnValueOnce(new Promise<R1RecordingPlayback>((resolve) => (release = resolve)));
    fireEvent.click(loadButton());
    // The request took 10 s: the link's age starts at the response, not at the click.
    setNow(11_000);
    await act(async () => release(minted({ expires_in_sec: 60 })));
    const el = mediaEl(r.view)!;
    drive(el);
    fireEvent.loadedMetadata(el);
    setNow(11_000 + 44_000);
    act(() => r.ref.current!.play());
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    setNow(11_000 + 45_000);
    mockApi.getR1Recording.mockResolvedValueOnce(minted({ url: URL_TWO }));
    act(() => r.ref.current!.play());
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
  });
});

/* ── Click to seek ────────────────────────────────────────────────── */

describe('playFrom / playFromTurn', () => {
  it('before the link exists: mints, waits for metadata, seeks and plays', async () => {
    const r = renderPlayer();
    act(() => r.ref.current!.playFrom(75));
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mediaEl(r.view)).not.toBeNull());
    const el = mediaEl(r.view)!;
    const state = drive(el);
    const focus = vi.spyOn(el, 'focus');
    // Not yet: setting the time before metadata would be ignored by Safari.
    expect(state.sets).toEqual([]);
    fireEvent.loadedMetadata(el);
    expect(state.sets).toEqual([75]);
    expect(state.play).toHaveBeenCalledTimes(1);
    // Keyboard users land on the controls (a transcript click moved them away).
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('the latest queued offset wins', async () => {
    const r = renderPlayer();
    act(() => {
      r.ref.current!.playFrom(10);
      r.ref.current!.playFrom(20);
      r.ref.current!.playFrom(30);
    });
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mediaEl(r.view)).not.toBeNull());
    const el = mediaEl(r.view)!;
    const state = drive(el);
    fireEvent.loadedMetadata(el);
    expect(state.sets).toEqual([30]);
  });

  it('with the link loaded: seeks and plays at once', async () => {
    const r = renderPlayer();
    const { state } = await loadIt(r);
    state.sets.length = 0;
    act(() => r.ref.current!.playFrom(120));
    expect(state.sets).toEqual([120]);
    expect(state.play).toHaveBeenCalled();
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
  });

  it('a negative offset clamps to 0', async () => {
    const r = renderPlayer();
    const { state } = await loadIt(r);
    state.sets.length = 0;
    act(() => r.ref.current!.playFrom(-5));
    expect(state.sets).toEqual([0]);
  });

  it('ignores a non-finite offset', async () => {
    const r = renderPlayer();
    const { state } = await loadIt(r);
    state.sets.length = 0;
    act(() => r.ref.current!.playFrom(Number.NaN));
    expect(state.sets).toEqual([]);
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
  });

  it('playFromTurn applies the anchor and the one-second lead-in', async () => {
    const r = renderPlayer();
    const { state } = await loadIt(r);
    state.sets.length = 0;
    act(() => r.ref.current!.playFromTurn(START + 125_000));
    expect(state.sets).toEqual([124]);
  });

  it('playFromTurn uses the mint answer\'s anchor when the list had none', async () => {
    mockApi.getR1Recording.mockResolvedValue(minted({ started_at_ms: START + 10_000 }));
    const r = renderPlayer({ summary: listed({ started_at_ms: null }) });
    const { state } = await loadIt(r);
    state.sets.length = 0;
    act(() => r.ref.current!.playFromTurn(START + 70_000));
    expect(state.sets).toEqual([59]);
  });

  it('playFromTurn with no anchor does nothing (an untimed turn stays untimed)', async () => {
    const r = renderPlayer({ summary: listed({ started_at_ms: null }) });
    act(() => r.ref.current!.playFromTurn(START + 5_000));
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
    act(() => r.ref.current!.playFromTurn(Number.NaN));
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('playFrom on a recording without a file does not mint', () => {
    const r = renderPlayer({ summary: listed({ state: 'failed' }) });
    act(() => r.ref.current!.playFrom(10));
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('a queued offset is dropped when the mint fails', async () => {
    mockApi.getR1Recording.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    const r = renderPlayer();
    act(() => r.ref.current!.playFrom(99));
    await screen.findByRole('alert');
    mockApi.getR1Recording.mockResolvedValueOnce(minted());
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(mediaEl(r.view)).not.toBeNull());
    const el = mediaEl(r.view)!;
    const state = drive(el);
    fireEvent.loadedMetadata(el);
    expect(state.sets).toEqual([]);
  });

  it('exposes currentTime and pause', async () => {
    const r = renderPlayer();
    expect(r.ref.current!.currentTime).toBe(0);
    const { state } = await loadIt(r);
    state.currentTime = 33;
    expect(r.ref.current!.currentTime).toBe(33);
    act(() => r.ref.current!.pause());
    expect(state.pause).toHaveBeenCalled();
  });
});

/* ── Mint failures ────────────────────────────────────────────────── */

describe('a failed mint', () => {
  it.each([
    [403, 'access_denied', 'You do not have access to this recording.', false],
    [404, 'not_found', 'This recording no longer exists.', false],
    [429, '429 Too Many Requests', 'Too many requests. Try again in a moment.', true],
    [500, 'internal', 'Could not load the recording. Try again.', true],
    [503, 'r1_recording_unavailable', 'Could not load the recording. Try again.', true],
    [0, 'Could not reach the server. Is the API running on http://x?', 'Could not load the recording. Try again.', true],
  ])('%s %s is shown in words, never the code', async (status, code, words, retryable) => {
    mockApi.getR1Recording.mockRejectedValue(new TestApiError(code, status));
    renderPlayer();
    fireEvent.click(loadButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(words);
    expect(alert.textContent).not.toContain(code);
    expect(screen.queryByRole('button', { name: /try again/i }) !== null).toBe(retryable);
  });

  it('an error with no status is treated as unreachable', async () => {
    mockApi.getR1Recording.mockRejectedValue(new Error('boom'));
    renderPlayer();
    fireEvent.click(loadButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the recording. Try again.');
    expect(alert.textContent).not.toContain('boom');
  });

  it('a mint that throws synchronously is an ordinary error, not a crash', async () => {
    mockApi.getR1Recording.mockImplementation(() => {
      throw new TypeError('api.getR1Recording is not a function');
    });
    renderPlayer();
    fireEvent.click(loadButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the recording. Try again.');
  });

  it('a re-mint that answers deleted replaces the player with that state', async () => {
    mockApi.getR1Recording
      .mockResolvedValueOnce(minted())
      .mockResolvedValueOnce({ state: 'deleted', reason: 'consent_withdrawn', deleted_at: '2026-12-01T08:00:00.000Z' });
    const r = renderPlayer();
    const { el } = await loadIt(r);
    failWith(el, 2);
    expect(await screen.findByText(/deleted on .*2026 because consent was withdrawn\./)).toBeInTheDocument();
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(r.props.onStateChange).toHaveBeenCalledWith('deleted');
    expect(r.ref.current!.hasUrl).toBe(false);
  });

  it('a re-mint that is refused (403) ends in "no access" and does not retry', async () => {
    mockApi.getR1Recording
      .mockResolvedValueOnce(minted())
      .mockRejectedValueOnce(new TestApiError('access_denied', 403));
    const r = renderPlayer();
    const { el } = await loadIt(r);
    failWith(el, 2);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have access to this recording.');
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2);
  });
});

/* ── Lifecycle ────────────────────────────────────────────────────── */

describe('lifecycle', () => {
  it('ignores a mint answer that arrives after unmount', async () => {
    let release: (value: R1RecordingPlayback) => void = () => undefined;
    mockApi.getR1Recording.mockReturnValue(new Promise<R1RecordingPlayback>((resolve) => (release = resolve)));
    const r = renderPlayer();
    fireEvent.click(loadButton());
    r.view.unmount();
    await act(async () => release({ state: 'deleted', reason: 'retention' }));
    expect(r.props.onStateChange).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('deleted');
  });

  it('ignores a late answer after the recording changed (another attempt)', async () => {
    let release: (value: R1RecordingPlayback) => void = () => undefined;
    mockApi.getR1Recording.mockReturnValue(new Promise<R1RecordingPlayback>((resolve) => (release = resolve)));
    const r = renderPlayer();
    fireEvent.click(loadButton());
    r.rerender({ sessionId: 'session-2', summary: listed() });
    await act(async () => release(minted()));
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(loadButton()).toBeInTheDocument();
  });

  it('a different attempt starts over and drops a queued seek', async () => {
    const r = renderPlayer();
    const { el } = await loadIt(r);
    expect(el).toBeTruthy();
    r.rerender({ sessionId: 'session-2' });
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(loadButton()).toBeInTheDocument();
    expect(r.ref.current!.hasUrl).toBe(false);
  });

  it('when the list says the state changed, the old link is dropped', async () => {
    const r = renderPlayer();
    await loadIt(r);
    r.rerender({ summary: listed({ state: 'deleted', reason: 'retention' }) });
    expect(mediaEl(r.view, 'video, audio')).toBeNull();
    expect(screen.getByText(/This recording was deleted/)).toBeInTheDocument();
  });

  it('a processing recording that becomes ready on re-read offers Load', async () => {
    const r = renderPlayer({ summary: listed({ state: 'processing' }) });
    expect(screen.queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    r.rerender({ summary: listed({ state: 'ready' }) });
    expect(loadButton()).toBeInTheDocument();
  });

  it('a list refresh with the same state keeps the loaded player', async () => {
    const r = renderPlayer();
    const { el } = await loadIt(r);
    r.rerender({ summary: listed({ duration_ms: 500_000 }) });
    expect(mediaEl(r.view)).toBe(el);
  });

  it('releases the media connection when it goes away', async () => {
    const r = renderPlayer();
    const { el } = await loadIt(r);
    const load = vi.spyOn(el, 'load');
    r.view.unmount();
    expect(load).toHaveBeenCalled();
    expect(el.getAttribute('src')).toBeNull();
  });

  it('keeps a healthy player\'s src under React StrictMode (it detaches and re-attaches refs)', async () => {
    render(
      <StrictMode>
        <R1RecordingPlayer roundId="round-1" sessionId="session-1" summary={listed()} label="Attempt 1 (counted)" />
      </StrictMode>,
    );
    fireEvent.click(loadButton());
    const video = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    expect(video).toHaveAttribute('src', URL_ONE);
    // …and a re-render does not strip it either.
    expect(document.querySelector('video')).toHaveAttribute('src', URL_ONE);
  });

  it('lets go of the download when the player drops its media (an error block replaces it)', async () => {
    const r = renderPlayer();
    const { el } = await loadIt(r, { metadata: false });
    const load = vi.spyOn(el, 'load');
    failWith(el, 2);
    await screen.findByRole('alert');
    expect(load).toHaveBeenCalled();
    expect(el.getAttribute('src')).toBeNull();
  });

  it('lets go of it when a re-mint finds the recording gone', async () => {
    mockApi.getR1Recording.mockResolvedValueOnce(minted()).mockResolvedValueOnce({ state: 'deleted', reason: 'retention' });
    const r = renderPlayer();
    const { el } = await loadIt(r);
    failWith(el, 2);
    await screen.findByText(/This recording was deleted/);
    expect(el.getAttribute('src')).toBeNull();
  });

  it('active=false pauses; position and link survive', async () => {
    const r = renderPlayer();
    const { el, state } = await loadIt(r);
    state.currentTime = 64;
    state.paused = false;
    r.rerender({ active: false });
    expect(state.pause).toHaveBeenCalled();
    expect(mediaEl(r.view)).toBe(el);
    expect(state.currentTime).toBe(64);
    expect(el).toHaveAttribute('src', URL_ONE);
  });

  it('a hidden player is not restarted by a re-mint that was playing', async () => {
    mockApi.getR1Recording.mockResolvedValueOnce(minted()).mockResolvedValueOnce(minted({ url: URL_TWO }));
    const r = renderPlayer();
    const { el, state } = await loadIt(r);
    state.paused = false;
    failWith(el, 2);
    r.rerender({ active: false });
    await waitFor(() => expect(el).toHaveAttribute('src', URL_TWO));
    state.play.mockClear();
    fireEvent.loadedMetadata(el);
    expect(state.play).not.toHaveBeenCalled();
  });
});

/* ── Events to the host ───────────────────────────────────────────── */

describe('events to the host', () => {
  it('reports time and play state', async () => {
    const r = renderPlayer();
    const { el, state } = await loadIt(r);
    state.currentTime = 12.5;
    fireEvent.timeUpdate(el);
    expect(r.props.onTimeUpdate).toHaveBeenLastCalledWith(12.5);
    fireEvent.play(el);
    expect(r.props.onPlayState).toHaveBeenLastCalledWith(true);
    fireEvent.pause(el);
    expect(r.props.onPlayState).toHaveBeenLastCalledWith(false);
    fireEvent.play(el);
    fireEvent.ended(el);
    expect(r.props.onPlayState).toHaveBeenLastCalledWith(false);
  });

  it('reports a state change only when the mint disagrees with the list', async () => {
    const r = renderPlayer();
    await loadIt(r);
    expect(r.props.onStateChange).not.toHaveBeenCalled();
  });
});

/* ── Split (recovered) recordings ─────────────────────────────────── */

describe('a recovered pair (split)', () => {
  const VIDEO_URL = link('video.mp4', SIG_ONE);
  const AUDIO_URL = link('audio.ogg', SIG_TWO);
  const split = (over: Partial<R1RecordingPlayback> = {}): R1RecordingPlayback => ({
    ...listed({ state: 'partial', reason: 'crash_recovered', mode: 'split' }),
    video_url: VIDEO_URL,
    audio_url: AUDIO_URL,
    video_content_type: 'video/mp4',
    audio_content_type: 'audio/ogg',
    expires_in_sec: 300,
    ...over,
  });

  async function loadSplit() {
    mockApi.getR1Recording.mockResolvedValue(split());
    const r = renderPlayer({ summary: listed({ state: 'partial', reason: 'crash_recovered', mode: 'split' }) });
    fireEvent.click(loadButton());
    await waitFor(() => expect(r.view.container.querySelector('audio[controls]')).not.toBeNull());
    const audio = r.view.container.querySelector('audio')!;
    const video = r.view.container.querySelector('video')!;
    const a = drive(audio);
    const v = drive(video);
    fireEvent.loadedMetadata(audio);
    return { r, audio, video, a, v };
  }

  it('renders the audio as the master with controls and a muted, control-less picture', async () => {
    const { audio, video } = await loadSplit();
    expect(audio).toHaveAttribute('src', AUDIO_URL);
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAccessibleName('Interview recording, Attempt 1 (counted)');
    expect(video).toHaveAttribute('src', VIDEO_URL);
    expect(video).not.toHaveAttribute('controls');
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('aria-hidden', 'true');
  });

  it('says plainly that audio and video may drift', async () => {
    await loadSplit();
    expect(screen.getByRole('note')).toHaveTextContent('Recovered recording: audio and video may drift.');
  });

  it('plays, pauses and rates the picture with the audio', async () => {
    const { audio, v } = await loadSplit();
    fireEvent.play(audio);
    expect(v.play).toHaveBeenCalled();
    fireEvent.pause(audio);
    expect(v.pause).toHaveBeenCalled();
    v.play.mockClear();
    v.pause.mockClear();
    fireEvent.waiting(audio);
    expect(v.pause).toHaveBeenCalled();
    fireEvent.playing(audio);
    expect(v.play).toHaveBeenCalled();
    audio.playbackRate = 1.5;
    fireEvent.rateChange(audio);
    expect(screen.getByRole('note').closest('div')!.querySelector('video')!.playbackRate).toBe(1.5);
  });

  it('puts the picture where the audio is after a seek', async () => {
    const { audio, a, v } = await loadSplit();
    a.currentTime = 40;
    fireEvent.seeking(audio);
    expect(v.currentTime).toBe(40);
    a.currentTime = 90;
    fireEvent.seeked(audio);
    expect(v.currentTime).toBe(90);
  });

  it('corrects drift beyond 0.3 s while playing, and leaves 0.3 s alone', async () => {
    const { audio, a, v } = await loadSplit();
    a.paused = false;
    a.currentTime = 20;
    v.currentTime = 20.3;
    v.sets.length = 0;
    fireEvent.timeUpdate(audio);
    expect(v.sets).toEqual([]);
    v.currentTime = 20.31;
    fireEvent.timeUpdate(audio);
    expect(v.sets).toEqual([20]);
    v.currentTime = 19.5;
    fireEvent.timeUpdate(audio);
    expect(v.sets).toEqual([20, 20]);
  });

  it('does not chase the picture while paused', async () => {
    const { audio, a, v } = await loadSplit();
    a.paused = true;
    a.currentTime = 20;
    v.currentTime = 25;
    v.sets.length = 0;
    fireEvent.timeUpdate(audio);
    expect(v.sets).toEqual([]);
  });

  it('click-to-seek moves both', async () => {
    const { r, a, v } = await loadSplit();
    a.sets.length = 0;
    act(() => r.ref.current!.playFrom(77));
    expect(a.sets).toEqual([77]);
    expect(v.sets).toContain(77);
    expect(a.play).toHaveBeenCalled();
  });

  it('a re-mint replaces both links', async () => {
    const { r, audio, video } = await loadSplit();
    mockApi.getR1Recording.mockResolvedValueOnce(
      split({ video_url: link('video.mp4', 'SIGNATURE_THREE'), audio_url: link('audio.ogg', 'SIGNATURE_FOUR') }),
    );
    failWith(audio, 2);
    await waitFor(() => expect(audio.getAttribute('src')).toContain('SIGNATURE_FOUR'));
    expect(video.getAttribute('src')).toContain('SIGNATURE_THREE');
    expect(r.view.container.querySelectorAll('audio').length).toBe(1);
  });

  it('a picture that cannot load leaves the audio playing, and says so', async () => {
    const { r, video } = await loadSplit();
    fireEvent.error(video);
    await waitFor(() => expect(r.view.container.querySelector('video')).toBeNull());
    expect(r.view.container.querySelector('audio[controls]')).not.toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('The picture could not be loaded; the audio is playing.');
  });

  it('a split answer missing one half is a fault', async () => {
    mockApi.getR1Recording.mockResolvedValue(split({ audio_url: undefined }));
    renderPlayer({ summary: listed({ state: 'partial', mode: 'split' }) });
    fireEvent.click(loadButton());
    await screen.findByRole('alert');
  });
});

/* ── The link never leaks ─────────────────────────────────────────── */

describe('the signed link is shown nowhere but the media src', () => {
  /** Every attribute value and the text of the page, minus the `src` of a media element. */
  function leaks(container: HTMLElement, needles: string[]): string[] {
    const found: string[] = [];
    const text = `${container.textContent ?? ''} ${document.body.textContent ?? ''}`;
    for (const needle of needles) if (text.includes(needle)) found.push(`text:${needle}`);
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        const mediaSrc = attr.name === 'src' && /^(VIDEO|AUDIO)$/.test(el.tagName);
        if (mediaSrc) continue;
        for (const needle of needles) {
          if (attr.value.includes(needle)) found.push(`${el.tagName}[${attr.name}]:${needle}`);
        }
      }
    }
    return found;
  }

  it('single, audio, split, and the error block', async () => {
    const needles = [SIG_ONE, SIG_TWO, 'X-Amz', 'r2.cloudflarestorage.com'];

    const single = renderPlayer();
    const { el } = await loadIt(single);
    expect(leaks(single.view.container, needles)).toEqual([]);
    failWith(el, 2);
    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2));
    expect(leaks(single.view.container, needles)).toEqual([]);
    single.view.unmount();

    mockApi.getR1Recording.mockResolvedValue(
      minted({ has_video: false, content_type: 'audio/ogg', url: link('audio.ogg', SIG_TWO) }),
    );
    const audioOnly = renderPlayer();
    fireEvent.click(loadButton());
    await waitFor(() => expect(audioOnly.view.container.querySelector('audio')).not.toBeNull());
    expect(leaks(audioOnly.view.container, needles)).toEqual([]);
    audioOnly.view.unmount();

    mockApi.getR1Recording.mockResolvedValue({
      ...listed({ state: 'partial', mode: 'split' }),
      video_url: link('video.mp4', SIG_ONE),
      audio_url: link('audio.ogg', SIG_TWO),
    });
    const pair = renderPlayer({ summary: listed({ state: 'partial', mode: 'split' }) });
    fireEvent.click(loadButton());
    await waitFor(() => expect(pair.view.container.querySelector('audio')).not.toBeNull());
    expect(leaks(pair.view.container, needles)).toEqual([]);
  });

  it('never calls the console (the test setup fails on console.error / console.warn)', async () => {
    const log = vi.spyOn(console, 'log');
    const info = vi.spyOn(console, 'info');
    const debug = vi.spyOn(console, 'debug');
    const r = renderPlayer();
    const { el } = await loadIt(r);
    failWith(el, 2);
    await waitFor(() => expect(mockApi.getR1Recording).toHaveBeenCalledTimes(2));
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('the leak detector itself catches a link in an attribute and in text', () => {
    const host = document.createElement('div');
    host.innerHTML = `<p data-x="${URL_ONE}">hello ${URL_TWO}</p><video src="${URL_ONE}"></video>`;
    document.body.appendChild(host);
    const found = leaks(host, [SIG_ONE, SIG_TWO]);
    host.remove();
    expect(found).toContain(`P[data-x]:${SIG_ONE}`);
    expect(found).toContain(`text:${SIG_TWO}`);
    expect(found.some((entry) => entry.startsWith('VIDEO'))).toBe(false);
  });
});

/* ── Accessibility ────────────────────────────────────────────────── */

describe('accessibility (axe, every state)', () => {
  it('idle ready', async () => {
    const { view } = renderPlayer();
    await expect(view.container).toHaveNoViolations();
  });

  it.each(['processing', 'recording', 'failed', 'deleted', 'none'] as const)('%s', async (state) => {
    const { view } = renderPlayer({ summary: listed({ state, reason: state === 'failed' ? 'integrity' : null }) });
    await expect(view.container).toHaveNoViolations();
  });

  it('unknown state', async () => {
    const { view } = renderPlayer({ summary: { state: 'x' } as unknown as R1RecordingSummary });
    await expect(view.container).toHaveNoViolations();
  });

  it('partial with a notice', async () => {
    const { view } = renderPlayer({ summary: listed({ state: 'partial', reason: 'audio_only_degraded', degraded_at_ms: 90_000 }) });
    await expect(view.container).toHaveNoViolations();
  });

  it('loading', async () => {
    mockApi.getR1Recording.mockReturnValue(new Promise(() => undefined));
    const { view } = renderPlayer();
    fireEvent.click(loadButton());
    expect(screen.getByText('Loading recording…')).toBeInTheDocument();
    await expect(view.container).toHaveNoViolations();
  });

  it('a loaded video', async () => {
    const r = renderPlayer();
    await loadIt(r);
    await expect(r.view.container).toHaveNoViolations();
  });

  it('a loaded audio-only recording', async () => {
    mockApi.getR1Recording.mockResolvedValue(minted({ has_video: false, content_type: 'audio/mp4' }));
    const r = renderPlayer({ summary: listed({ has_video: false }) });
    fireEvent.click(loadButton());
    await waitFor(() => expect(r.view.container.querySelector('audio')).not.toBeNull());
    await expect(r.view.container).toHaveNoViolations();
  });

  it('a loaded recovered pair', async () => {
    mockApi.getR1Recording.mockResolvedValue({
      ...listed({ state: 'partial', reason: 'crash_recovered', mode: 'split' }),
      video_url: URL_ONE,
      audio_url: URL_TWO,
    });
    const r = renderPlayer({ summary: listed({ state: 'partial', mode: 'split' }) });
    fireEvent.click(loadButton());
    await waitFor(() => expect(r.view.container.querySelector('audio')).not.toBeNull());
    await expect(r.view.container).toHaveNoViolations();
  });

  it('an error with Try again, and one without', async () => {
    mockApi.getR1Recording.mockRejectedValueOnce(new TestApiError('service_unavailable', 503));
    const r = renderPlayer();
    fireEvent.click(loadButton());
    await screen.findByRole('alert');
    await expect(r.view.container).toHaveNoViolations();
    r.view.unmount();

    mockApi.getR1Recording.mockRejectedValueOnce(new TestApiError('access_denied', 403));
    const denied = renderPlayer();
    fireEvent.click(loadButton());
    await screen.findByRole('alert');
    await expect(denied.view.container).toHaveNoViolations();
  });

  it('several players on one page have distinct names', () => {
    render(
      <>
        <R1RecordingPlayer roundId="r" sessionId="s1" summary={listed()} label="Attempt 1 (counted)" />
        <R1RecordingPlayer roundId="r" sessionId="s2" summary={listed()} label="Attempt 2 (retake)" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Load recording, Attempt 1 (counted)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load recording, Attempt 2 (retake)' })).toBeInTheDocument();
  });
});
