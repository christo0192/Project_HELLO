import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAudioAnalyser,
  createLocalAudioTrack,
  createLocalVideoTrack,
  Room,
  RoomEvent,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import { classifyR1Error, r1Api } from '../../lib/r1/r1-api';
import {
  publishR1Media,
  R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS,
  R1_ROOM_OPTIONS,
  r1AudioCaptureOptions,
  r1VideoCaptureOptions,
  stopR1Media,
  type R1LocalMedia,
} from '../../lib/r1/r1-media';
import {
  R1_PREFLIGHT_LIMITS,
  sumVideoFrames,
  waitForR1Preflight,
  type R1PreflightFailure,
} from '../../lib/r1/r1-preflight-policy';
import { Button } from '../ui';

type CheckState = 'idle' | 'active' | 'passed' | 'failed';
type ReadinessState = 'idle' | 'media' | 'network' | 'passed' | 'failed';

interface Checks {
  camera: CheckState;
  microphone: CheckState;
  connection: CheckState;
}

const IDLE_CHECKS: Checks = { camera: 'idle', microphone: 'idle', connection: 'idle' };
const LEVEL_WINDOW_MS = 1_800;
const AUDIBLE_VOLUME = 0.02;

interface R1ReadinessStepProps {
  linkToken: string;
  roleTitle: string;
  /** Hands over ownership of both live tracks; this step will not stop them afterwards. */
  onReady: (media: R1LocalMedia) => void;
  onBack: () => void;
  /** The preflight refused because consent is no longer valid. */
  onConsentRequired: () => void;
}

function cameraMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission is blocked. Allow camera access in your browser site '
      + 'settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable camera was found. Connect or enable a camera and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The browser could not start your camera. Close other apps that use it, '
      + 'then try again.';
  }
  return 'Your camera is required for this interview. Please allow camera access and try again.';
}

function microphoneMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission is blocked. Allow microphone access in your browser '
      + 'site settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable microphone was found. Connect a microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Your microphone could not be started. Close other apps using it and try again.';
  }
  return 'Your microphone is required for this interview. Please allow access and try again.';
}

const FAILURE_MESSAGES: Readonly<Record<R1PreflightFailure, string>> = {
  stable_window: 'Your connection was not steady enough. Check your internet and retry.',
  reconnects: 'Your connection dropped during the test. Check your internet and retry.',
  outbound_audio: 'We could not send audio from your microphone. Check it and retry.',
  outbound_video: 'We could not send video from your camera. Make sure nothing covers it '
    + 'and no other app is using it, then retry.',
  microphone: 'We could not hear a clear voice. Select the right microphone and say a '
    + 'short sentence.',
};

function networkMessage(error: unknown): string {
  switch (classifyR1Error(error)) {
    case 'rate_limited':
      return 'You have run the connection test too many times. Wait a minute and try again.';
    case 'unavailable':
      return 'The connection test is unavailable right now. Your link is still valid; '
        + 'please retry.';
    case 'network':
      return 'We could not reach the server. Check your internet and retry.';
    default:
      return 'Your connection did not meet the minimum requirements. Check your camera, '
        + 'microphone and internet, then retry.';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * What the meter card asks of the candidate. It keeps asking during the connection
 * test too: the check does not depend on speech (DTX is off), but a candidate who
 * falls silent while a spinner runs should not wonder what the test is waiting for.
 */
const INSTRUCTIONS = {
  idle: 'Speak briefly to test your microphone.',
  media: 'Say a short sentence so we can hear you.',
  network: 'Keep talking naturally while we test your connection.',
} as const;

const METER_STATUS = {
  idle: 'Microphone check',
  media: 'Listening…',
  network: 'Testing your connection…',
} as const;

const CHECK_WORDS: Readonly<Record<CheckState, string>> = {
  idle: 'Waiting',
  active: 'Checking',
  passed: 'Ready',
  failed: 'Try again',
};

/**
 * Step 2: camera, microphone and connection (plan sections 4 step 5 and 7.10).
 *
 * `getUserMedia` runs FIRST, before any network call, so a candidate who cannot
 * give a camera never spends a preflight. The self-view is mirrored. The tracks
 * created here use the same capture constants as the live interview and are
 * handed to the page on success, so the interview tests and sends exactly what
 * the candidate just saw and no second permission prompt appears.
 */
export function R1ReadinessStep({
  linkToken,
  roleTitle,
  onReady,
  onBack,
  onConsentRequired,
}: R1ReadinessStepProps) {
  const [state, setState] = useState<ReadinessState>('idle');
  const [checks, setChecks] = useState<Checks>(IDLE_CHECKS);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [microphoneId, setMicrophoneId] = useState('');
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocalVideoTrack | null>(null);
  const videoElementRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<Partial<R1LocalMedia>>({});
  const analyserCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const frameRef = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(null);
  const runRef = useRef(0);

  const releaseAnalyser = useCallback(async () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (analyserCleanupRef.current) await analyserCleanupRef.current().catch(() => undefined);
    analyserCleanupRef.current = null;
  }, []);

  const cleanup = useCallback(async () => {
    runRef.current += 1;
    await releaseAnalyser();
    stopR1Media(mediaRef.current);
    mediaRef.current = {};
    setPreview(null);
    const room = roomRef.current;
    roomRef.current = null;
    await room?.disconnect(false).catch(() => undefined);
  }, [releaseAnalyser]);

  useEffect(() => () => {
    void cleanup();
  }, [cleanup]);

  useEffect(() => {
    const element = videoElementRef.current;
    if (!preview || !element) return undefined;
    preview.attach(element);
    return () => {
      preview.detach(element);
    };
  }, [preview]);

  const loadDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    setCameras(list.filter((device) => device.kind === 'videoinput'));
    setMicrophones(list.filter((device) => device.kind === 'audioinput'));
  }, []);

  useEffect(() => {
    const onChange = () => {
      void loadDevices().catch(() => undefined);
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, [loadDevices]);

  const fail = useCallback(
    async (text: string, next: Partial<Checks>) => {
      await cleanup();
      setChecks((previous) => ({ ...previous, ...next }));
      setState('failed');
      setMessage(text);
    },
    [cleanup],
  );

  async function runConnectionTest(run: number, audibleMs: number): Promise<void> {
    const { audio, video } = mediaRef.current;
    if (!audio || !video) return;
    setState('network');
    setChecks((previous) => ({ ...previous, microphone: 'passed', connection: 'active' }));
    let reconnects = 0;
    try {
      const grant = await r1Api.preflight(linkToken);
      if (run !== runRef.current) return;
      const room = new Room(R1_ROOM_OPTIONS);
      roomRef.current = room;
      room.on(RoomEvent.Reconnecting, () => {
        reconnects += 1;
      });
      await Promise.race([
        room.connect(grant.url, grant.livekit_token),
        sleep(R1_PREFLIGHT_LIMITS.connectTimeoutMs).then(() => {
          throw new Error('preflight_timeout');
        }),
      ]);
      await publishR1Media(room, { audio, video }, R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS);
      // Poll the sender counters and pass as soon as both thresholds are met; fail only at
      // the deadline, so a slow encoder ramp or a dim-room camera does not cost a retry.
      const verdict = await waitForR1Preflight({
        now: () => performance.now(),
        sleep,
        readCounters: async () => ({
          audioPackets: (await audio.getSenderStats())?.packetsSent ?? 0,
          videoFrames: sumVideoFrames(await video.getSenderStats()),
        }),
        reconnects: () => reconnects,
        audibleMs,
        cancelled: () => run !== runRef.current,
      });
      if (!verdict || run !== runRef.current) return;
      if (!verdict.ok) {
        await fail(FAILURE_MESSAGES[verdict.reason], { connection: 'failed' });
        return;
      }
      if (room.state !== 'connected') {
        await fail(FAILURE_MESSAGES.reconnects, { connection: 'failed' });
        return;
      }
      await room.disconnect(false);
      roomRef.current = null;
      setLevel(0);
      setChecks({ camera: 'passed', microphone: 'passed', connection: 'passed' });
      setState('passed');
      await releaseAnalyser();
    } catch (error) {
      if (run !== runRef.current) return;
      if (classifyR1Error(error) === 'consent_required') {
        await cleanup();
        onConsentRequired();
        return;
      }
      await fail(networkMessage(error), { connection: 'failed' });
    }
  }

  async function startCheck(): Promise<void> {
    await cleanup();
    const run = runRef.current;
    setMessage(null);
    setLevel(0);
    setState('media');
    setChecks({ camera: 'active', microphone: 'idle', connection: 'idle' });

    let video: LocalVideoTrack;
    try {
      video = await createLocalVideoTrack(r1VideoCaptureOptions(cameraId || undefined));
    } catch (error) {
      if (run === runRef.current) await fail(cameraMessage(error), { camera: 'failed' });
      return;
    }
    if (run !== runRef.current) {
      video.stop();
      return;
    }
    mediaRef.current = { video };
    setPreview(video);
    setChecks({ camera: 'passed', microphone: 'active', connection: 'idle' });

    let audio: LocalAudioTrack;
    try {
      audio = await createLocalAudioTrack(r1AudioCaptureOptions(microphoneId || undefined));
    } catch (error) {
      if (run === runRef.current) await fail(microphoneMessage(error), { microphone: 'failed' });
      return;
    }
    if (run !== runRef.current) {
      audio.stop();
      return;
    }
    mediaRef.current = { video, audio };
    await loadDevices().catch(() => undefined);

    const analyser = createAudioAnalyser(audio, {
      cloneTrack: true,
      smoothingTimeConstant: 0.78,
      minDecibels: -90,
      maxDecibels: -10,
    });
    analyserCleanupRef.current = analyser.cleanup;
    const startedAt = performance.now();
    let audibleMs = 0;
    let previous = startedAt;
    const sample = (now: number): void => {
      if (run !== runRef.current) return;
      const volume = analyser.calculateVolume();
      setLevel(Math.min(1, volume * 8));
      if (volume >= AUDIBLE_VOLUME) audibleMs += Math.max(0, now - previous);
      previous = now;
      if (now - startedAt >= LEVEL_WINDOW_MS) {
        if (audibleMs < R1_PREFLIGHT_LIMITS.audibleMs) {
          void fail(FAILURE_MESSAGES.microphone, { microphone: 'failed' });
          return;
        }
        void runConnectionTest(run, audibleMs);
        return;
      }
      frameRef.current = requestAnimationFrame(sample);
    };
    frameRef.current = requestAnimationFrame(sample);
  }

  async function chooseCamera(deviceId: string): Promise<void> {
    setCameraId(deviceId);
    setState('idle');
    setChecks(IDLE_CHECKS);
    setMessage(null);
    setLevel(0);
    await cleanup();
  }

  async function chooseMicrophone(deviceId: string): Promise<void> {
    setMicrophoneId(deviceId);
    setState('idle');
    setChecks(IDLE_CHECKS);
    setMessage(null);
    setLevel(0);
    await cleanup();
  }

  function continueToInterview(): void {
    const { audio, video } = mediaRef.current;
    if (!audio || !video) {
      setState('failed');
      setMessage('Your device check expired. Please test again before continuing.');
      return;
    }
    mediaRef.current = {};
    setPreview(null);
    onReady({ audio, video });
  }

  const busy = state === 'media' || state === 'network';
  const meterMode = state === 'network' || state === 'media' ? state : 'idle';
  return (
    <section className="candidate-glass-card candidate-readiness" aria-labelledby="r1-ready-title">
      <button type="button" className="candidate-back" onClick={onBack}>
        ← Back
      </button>
      <p className="candidate-eyebrow">Step 2 of 3 · Camera and microphone</p>
      <h1 id="r1-ready-title">Let’s make sure you’re ready</h1>
      <p className="candidate-muted">
        Video interview for <strong>{roleTitle}</strong>. Your camera and microphone must stay on.
      </p>

      <div className="r1-devices">
        <div>
          <label className="candidate-field-label" htmlFor="r1-camera">
            Camera
          </label>
          <select
            id="r1-camera"
            className="candidate-select"
            value={cameraId}
            disabled={busy}
            onChange={(event) => void chooseCamera(event.target.value)}
          >
            <option value="">Default camera</option>
            {cameras.map((device, index) => (
              <option key={device.deviceId || `camera-${index}`} value={device.deviceId}>
                {device.label || `Camera ${index + 1}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="candidate-field-label" htmlFor="r1-microphone">
            Microphone
          </label>
          <select
            id="r1-microphone"
            className="candidate-select"
            value={microphoneId}
            disabled={busy}
            onChange={(event) => void chooseMicrophone(event.target.value)}
          >
            <option value="">Default microphone</option>
            {microphones.map((device, index) => (
              <option key={device.deviceId || `microphone-${index}`} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="r1-selfview">
        <video ref={videoElementRef} autoPlay muted playsInline aria-label="Your camera preview">
          <track kind="captions" />
        </video>
        {!preview && (
          <p className="r1-selfview__placeholder">Your camera preview appears here.</p>
        )}
      </div>

      <div className="candidate-meter-card" role="group" aria-label="Microphone level">
        <p className="candidate-instruction">{INSTRUCTIONS[meterMode]}</p>
        <div className="candidate-level-meter" aria-hidden="true">
          {Array.from({ length: 18 }, (_, index) => (
            <i key={index} data-on={index / 18 < level} />
          ))}
        </div>
        <p className="candidate-meter-status">{METER_STATUS[meterMode]}</p>
      </div>

      <div className="candidate-check-list" aria-live="polite">
        <div data-state={checks.camera}>
          <span>01</span>
          <b>Camera</b>
          <em>{CHECK_WORDS[checks.camera]}</em>
        </div>
        <div data-state={checks.microphone}>
          <span>02</span>
          <b>Microphone</b>
          <em>{CHECK_WORDS[checks.microphone]}</em>
        </div>
        <div data-state={checks.connection}>
          <span>03</span>
          <b>Connection</b>
          <em>{checks.connection === 'passed' ? 'Stable' : CHECK_WORDS[checks.connection]}</em>
        </div>
      </div>

      {message && (
        <p className="candidate-error" role="alert">
          {message}
        </p>
      )}
      {state === 'passed' ? (
        <Button className="candidate-primary-cta" onClick={continueToInterview}>
          Continue to interview
        </Button>
      ) : (
        <Button className="candidate-primary-cta" loading={busy} onClick={() => void startCheck()}>
          {state === 'failed' ? 'Test again' : 'Test camera, microphone and connection'}
        </Button>
      )}
      <p className="candidate-privacy-note">
        Your device names stay in your browser and are never shared.
      </p>
    </section>
  );
}
