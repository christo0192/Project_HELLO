import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    video: null as unknown,
    audio: null as unknown,
    room: null as unknown,
    volume: 0.3,
    audioPackets: 120,
    videoFrames: 90,
    roomState: 'connected',
    /** When set, counters follow the time since publish instead of the fixed numbers. */
    rates: null as null | { videoFps: number; audioPps: number; dtxPps: number },
  };
  return {
    state,
    createLocalVideoTrack: vi.fn(),
    createLocalAudioTrack: vi.fn(),
    createAudioAnalyser: vi.fn(),
    preflight: vi.fn(),
    publishTrack: vi.fn(),
    roomConnect: vi.fn(),
    roomDisconnect: vi.fn(),
    roomOn: vi.fn(),
    analyserCleanup: vi.fn(),
  };
});

vi.mock('livekit-client', () => ({
  createLocalVideoTrack: h.createLocalVideoTrack,
  createLocalAudioTrack: h.createLocalAudioTrack,
  createAudioAnalyser: h.createAudioAnalyser,
  RoomEvent: { Reconnecting: 'reconnecting' },
  Room: class {
    state = h.state.roomState;
    localParticipant = { publishTrack: h.publishTrack };
    on = h.roomOn;
    connect = h.roomConnect;
    disconnect = h.roomDisconnect;
    constructor() {
      h.state.room = this;
    }
  },
}));

vi.mock('../../lib/r1/r1-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r1/r1-api')>()),
  r1Api: { preflight: h.preflight },
}));

import { ApiError } from '../../lib/api-client';
import {
  R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS,
  R1_VIDEO_PUBLISH_OPTIONS,
} from '../../lib/r1/r1-media';
import { R1ReadinessStep } from './R1ReadinessStep';

const LINK = 'c'.repeat(64);

interface FakeTrack {
  kind: 'audio' | 'video';
  stop: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  getSenderStats: ReturnType<typeof vi.fn>;
  publishedAt: number | null;
  publishOptions: { dtx?: boolean } | undefined;
}

/** Seconds since this track was published, on the faked clock. */
function publishedSeconds(track: FakeTrack): number {
  return track.publishedAt === null ? 0 : (performance.now() - track.publishedAt) / 1_000;
}

function makeTrack(kind: 'audio' | 'video'): FakeTrack {
  const track: FakeTrack = {
    kind,
    stop: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    publishedAt: null,
    publishOptions: undefined,
    getSenderStats: vi.fn(async () => {
      const { rates } = h.state;
      if (kind === 'audio') {
        if (!rates) return { packetsSent: h.state.audioPackets };
        // Opus DTX: a quiet candidate sends a trickle unless the publish turned DTX off.
        const pps = track.publishOptions?.dtx === false ? rates.audioPps : rates.dtxPps;
        return { packetsSent: Math.floor(pps * publishedSeconds(track)) };
      }
      if (!rates) return [{ framesSent: h.state.videoFrames }];
      return [{ framesSent: Math.floor(rates.videoFps * publishedSeconds(track)) }];
    }),
  };
  return track;
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function renderStep() {
  const props = {
    linkToken: LINK,
    roleTitle: 'Sales Program Advisor',
    onReady: vi.fn(),
    onBack: vi.fn(),
    onConsentRequired: vi.fn(),
  };
  const view = render(<R1ReadinessStep {...props} />);
  return { ...view, props };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function runCheck() {
  fireEvent.click(screen.getByRole('button', { name: /Test camera, microphone and connection/ }));
  await advance(2_000); // the level window
  await advance(9_000); // the polled window: at most the 8 s deadline
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
  h.state.volume = 0.3;
  h.state.audioPackets = 120;
  h.state.videoFrames = 90;
  h.state.roomState = 'connected';
  h.state.rates = null;
  h.createLocalVideoTrack.mockImplementation(async () => {
    h.state.video = makeTrack('video');
    return h.state.video;
  });
  h.createLocalAudioTrack.mockImplementation(async () => {
    h.state.audio = makeTrack('audio');
    return h.state.audio;
  });
  h.createAudioAnalyser.mockImplementation(() => ({
    calculateVolume: () => h.state.volume,
    cleanup: h.analyserCleanup.mockResolvedValue(undefined),
  }));
  h.preflight.mockResolvedValue({
    url: 'wss://preflight.invalid',
    livekit_token: 'preflight-token',
    expires_at: null,
    policy_version: 'r1-av-v1',
  });
  h.publishTrack.mockImplementation(
    async (track: FakeTrack, options?: { dtx?: boolean }) => {
      track.publishedAt = performance.now();
      track.publishOptions = options;
    },
  );
  h.roomConnect.mockResolvedValue(undefined);
  h.roomDisconnect.mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime camera' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in microphone' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('R1ReadinessStep happy path', () => {
  it('captures at the budget, tests the connection and hands over both tracks', async () => {
    const { props } = renderStep();
    await runCheck();

    expect(h.createLocalVideoTrack).toHaveBeenCalledWith({
      facingMode: 'user',
      resolution: { width: 640, height: 360, frameRate: 15 },
    });
    expect(h.createLocalAudioTrack).toHaveBeenCalledWith({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    // Camera first: a candidate with no camera never spends a preflight.
    expect(h.createLocalVideoTrack.mock.invocationCallOrder[0]).toBeLessThan(
      h.createLocalAudioTrack.mock.invocationCallOrder[0],
    );
    expect(h.preflight).toHaveBeenCalledWith(LINK);
    expect(h.roomConnect).toHaveBeenCalledWith('wss://preflight.invalid', 'preflight-token');
    // The device check measures the uplink, so its microphone is published with DTX off.
    expect(h.publishTrack.mock.calls[0]).toEqual([
      h.state.audio,
      R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS,
    ]);
    expect(h.publishTrack.mock.calls[0][1]).toEqual({ dtx: false });
    expect(h.publishTrack.mock.calls[1]).toEqual([h.state.video, R1_VIDEO_PUBLISH_OPTIONS]);
    expect(h.roomDisconnect).toHaveBeenCalledWith(false);

    const proceed = screen.getByRole('button', { name: 'Continue to interview' });
    fireEvent.click(proceed);
    expect(props.onReady).toHaveBeenCalledWith({ audio: h.state.audio, video: h.state.video });
    expect((h.state.audio as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
  });

  it('shows the camera, microphone and connection checks as passed, with a self-view', async () => {
    renderStep();
    await runCheck();
    const video = h.state.video as { attach: ReturnType<typeof vi.fn> };
    expect(video.attach).toHaveBeenCalledWith(screen.getByLabelText('Your camera preview'));
    expect(screen.getByText('Stable')).toBeVisible();
    expect(screen.getAllByText('Ready')).toHaveLength(2);
  });

  it('does not stop the handed-over tracks when the step unmounts afterwards', async () => {
    const { unmount } = renderStep();
    await runCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to interview' }));
    unmount();
    await advance(0);
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
    expect((h.state.audio as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
  });

  it('lists the cameras and microphones once permission has been given', async () => {
    renderStep();
    await runCheck();
    expect(screen.getByRole('option', { name: 'FaceTime camera' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Built-in microphone' })).toBeInTheDocument();
  });
});

describe('R1ReadinessStep failures', () => {
  it.each([
    ['NotAllowedError', /Camera permission is blocked/],
    ['NotFoundError', /No usable camera was found/],
    ['NotReadableError', /could not start your camera/],
  ])('explains a camera %s and never reaches the network', async (name, copy) => {
    h.createLocalVideoTrack.mockRejectedValue(domError(name));
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Test camera, microphone and connection/ }));
    await advance(100);
    expect(screen.getByRole('alert')).toHaveTextContent(copy);
    expect(h.createLocalAudioTrack).not.toHaveBeenCalled();
    expect(h.preflight).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test again' })).toBeEnabled();
  });

  it('stops the camera when the microphone is refused', async () => {
    h.createLocalAudioTrack.mockRejectedValue(domError('NotAllowedError'));
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Test camera, microphone and connection/ }));
    await advance(100);
    expect(screen.getByRole('alert')).toHaveTextContent(/Microphone permission is blocked/);
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
    expect(h.preflight).not.toHaveBeenCalled();
  });

  it('asks for a clearer voice when the level meter hears nothing', async () => {
    h.state.volume = 0;
    renderStep();
    await runCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not hear a clear voice/);
    expect(h.preflight).not.toHaveBeenCalled();
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
    expect((h.state.audio as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it('fails the connection when too little video was actually sent', async () => {
    h.state.videoFrames = 44;
    renderStep();
    await runCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not send video from your camera/);
    expect(screen.queryByRole('button', { name: 'Continue to interview' })).toBeNull();
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it('fails the connection when too little audio was actually sent', async () => {
    h.state.audioPackets = 10;
    renderStep();
    await runCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not send audio/);
  });

  it('fails when the room is no longer connected after the stable window', async () => {
    h.state.roomState = 'reconnecting';
    renderStep();
    await runCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(/connection dropped/);
  });

  it('explains a rate limit without retrying on its own', async () => {
    h.preflight.mockRejectedValue(new ApiError('http_429', 429));
    renderStep();
    await runCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(/too many times/);
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it('keeps the link usable on an outage', async () => {
    h.preflight.mockRejectedValue(new ApiError('r1_unavailable', 503));
    renderStep();
    await runCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(/Your link is still valid/);
  });

  it('sends the candidate back to the notice when consent is no longer valid', async () => {
    h.preflight.mockRejectedValue(new ApiError('consent_required', 409));
    const { props } = renderStep();
    await runCheck();
    expect(props.onConsentRequired).toHaveBeenCalledTimes(1);
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it('times out a room that never connects', async () => {
    h.roomConnect.mockReturnValue(new Promise(() => undefined));
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Test camera, microphone and connection/ }));
    await advance(2_000);
    await advance(10_500);
    expect(screen.getByRole('alert')).toHaveTextContent(/did not meet the minimum/);
  });
});

describe('R1ReadinessStep polled connection test', () => {
  const startCheck = () =>
    fireEvent.click(screen.getByRole('button', { name: /Test camera, microphone and connection/ }));
  const continueButton = () => screen.queryByRole('button', { name: 'Continue to interview' });

  it('passes a slow camera ramp that a single reading at 4 s would have failed', async () => {
    // A dim-room camera at 8 fps: 32 frames after 4 s, 45 only after 5.6 s.
    h.state.rates = { videoFps: 8, audioPps: 50, dtxPps: 2.5 };
    renderStep();
    startCheck();
    await advance(2_000); // the level window
    await advance(4_100); // a little over 4 s of publishing
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueButton()).toBeNull();
    await advance(2_500); // past 6 s of publishing
    expect(continueButton()).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('publishes the check microphone with DTX off, so a quiet candidate still passes', async () => {
    // With DTX on the same candidate would send ~2.5 packets a second and never reach 50.
    h.state.rates = { videoFps: 15, audioPps: 50, dtxPps: 2.5 };
    renderStep();
    await runCheck();
    expect((h.state.audio as FakeTrack).publishOptions).toEqual({ dtx: false });
    expect(continueButton()).toBeVisible();
  });

  it('fails an audio shortfall only at the deadline, not after the first few seconds', async () => {
    h.state.rates = { videoFps: 15, audioPps: 2.5, dtxPps: 2.5 };
    renderStep();
    startCheck();
    await advance(2_000);
    await advance(6_500); // 6.5 s of publishing: still within the deadline
    expect(screen.queryByRole('alert')).toBeNull();
    await advance(3_000);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not send audio/);
  });

  it('fails a video shortfall only at the deadline too', async () => {
    h.state.videoFrames = 44;
    renderStep();
    startCheck();
    await advance(2_000);
    await advance(6_000);
    expect(screen.queryByRole('alert')).toBeNull();
    await advance(3_000);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not send video from your camera/);
  });

  it('fails at once when the room reconnects during the window', async () => {
    renderStep();
    startCheck();
    await advance(2_000);
    const onReconnecting = h.roomOn.mock.calls.find(([event]) => event === 'reconnecting')?.[1];
    expect(onReconnecting).toBeTypeOf('function');
    (onReconnecting as () => void)();
    await advance(1_000);
    expect(screen.getByRole('alert')).toHaveTextContent(/connection dropped/);
  });

  it('keeps asking the candidate to talk while the connection is tested', async () => {
    h.preflight.mockReturnValue(new Promise(() => undefined));
    renderStep();
    startCheck();
    await advance(100);
    expect(screen.getByText('Say a short sentence so we can hear you.')).toBeVisible();
    await advance(2_000);
    expect(screen.getByText('Keep talking naturally while we test your connection.')).toBeVisible();
    expect(screen.getByText('Testing your connection…')).toBeVisible();
  });
});

describe('R1ReadinessStep lifecycle', () => {
  it('stops any track it still owns when it unmounts mid-check', async () => {
    const { unmount } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Test camera, microphone and connection/ }));
    await advance(100);
    unmount();
    await advance(0);
    expect((h.state.video as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
    expect((h.state.audio as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it('goes back without touching any device', () => {
    const { props } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(h.createLocalVideoTrack).not.toHaveBeenCalled();
  });

  it('asks for the camera before anything else is shown to be needed', () => {
    renderStep();
    expect(screen.getByText(/camera and microphone must stay on/)).toBeVisible();
    expect(screen.getByLabelText('Camera')).toBeVisible();
    expect(screen.getByLabelText('Microphone')).toBeVisible();
  });
});
