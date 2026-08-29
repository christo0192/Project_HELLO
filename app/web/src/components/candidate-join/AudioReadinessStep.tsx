import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAudioAnalyser,
  createLocalAudioTrack,
  LocalAudioTrack,
  Room,
  RoomEvent,
} from 'livekit-client';
import { api, ApiError } from '../../api';
import type { CandidatePreflightResult } from '../../types';
import { Button } from '../ui';
import { evaluateCandidatePreflight, PREFLIGHT_LIMITS } from '../../lib/candidate-preflight-policy';

const STABLE_WINDOW_MS = PREFLIGHT_LIMITS.stableMs;
const AUDIO_THRESHOLD = 0.02;
const AUDIO_REQUIRED_MS = PREFLIGHT_LIMITS.audibleMs;

type ReadinessState = 'idle' | 'microphone' | 'network' | 'passed' | 'failed';

interface AudioReadinessStepProps {
  inviteToken: string;
  roleTitle: string;
  onReady: (track: LocalAudioTrack) => void;
  onBack: () => void;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.message === 'consent_required') {
    return 'Your consent is no longer valid. Please return and review it again.';
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission is blocked. Allow microphone access in your browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable microphone was found. Connect a microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Your microphone could not be started. Close other apps using it and try again.';
  }
  if (error instanceof ApiError && error.message === 'screening_room_unavailable') {
    return 'The connection test is unavailable right now. Your invite is still valid; please retry.';
  }
  return 'Your connection did not meet the minimum requirements. Check your microphone and internet, then retry.';
}

async function makeTrack(deviceId?: string): Promise<LocalAudioTrack> {
  return createLocalAudioTrack({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  });
}

export function AudioReadinessStep({ inviteToken, roleTitle, onReady, onBack }: AudioReadinessStepProps) {
  const [state, setState] = useState<ReadinessState>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const trackRef = useRef<LocalAudioTrack | null>(null);
  const analyserCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const frameRef = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(null);
  const failedRef = useRef(false);

  const cleanupTrack = useCallback(async () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (analyserCleanupRef.current) await analyserCleanupRef.current().catch(() => undefined);
    analyserCleanupRef.current = null;
    trackRef.current?.stop();
    trackRef.current = null;
  }, []);

  useEffect(() => () => {
    void cleanupTrack();
    void roomRef.current?.disconnect();
  }, [cleanupTrack]);

  const loadDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    const microphones = list.filter((device) => device.kind === 'audioinput');
    setDevices(microphones);
    if (!selectedDevice && microphones[0]) setSelectedDevice(microphones[0].deviceId);
  }, [selectedDevice]);

  useEffect(() => {
    const onDeviceChange = () => { void loadDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  }, [loadDevices]);

  const startAudioTest = useCallback(async () => {
    setMessage(null);
    setState('microphone');
    failedRef.current = false;
    await cleanupTrack();
    let track: LocalAudioTrack | null = null;
    try {
      track = await makeTrack(selectedDevice || undefined);
      trackRef.current = track;
      await loadDevices();
      const analyser = createAudioAnalyser(track, {
        cloneTrack: true,
        smoothingTimeConstant: 0.78,
        minDecibels: -90,
        maxDecibels: -10,
      });
      analyserCleanupRef.current = analyser.cleanup;
      const startedAt = performance.now();
      let audibleMs = 0;
      let previous = startedAt;
      const sample = (now: number) => {
        const volume = analyser.calculateVolume();
        setLevel(Math.min(1, volume * 8));
        if (volume >= AUDIO_THRESHOLD) audibleMs += Math.max(0, now - previous);
        previous = now;
        if (now - startedAt >= 1_800) {
          if (audibleMs < AUDIO_REQUIRED_MS) {
            failedRef.current = true;
            setState('failed');
            setMessage('We could not hear a clear voice. Select the correct microphone and say a short sentence.');
            return;
          }
          void runNetworkTest(track!);
          return;
        }
        frameRef.current = requestAnimationFrame(sample);
      };
      frameRef.current = requestAnimationFrame(sample);
    } catch (error) {
      setState('failed');
      setMessage(messageFor(error));
      await cleanupTrack();
    }
    // runNetworkTest is declared below and intentionally kept out of this
    // callback's identity; this handler is recreated only when the selected
    // device or cleanup adapter changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupTrack, loadDevices, selectedDevice]);

  const runNetworkTest = useCallback(async (track: LocalAudioTrack) => {
    if (failedRef.current) return;
    setState('network');
    setMessage(null);
    let room: Room | null = null;
    let reconnected = false;
    try {
      const preflight: CandidatePreflightResult = await api.candidateLiveKitPreflight(inviteToken);
      room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;
      const onReconnect = () => { reconnected = true; };
      room.on(RoomEvent.Reconnecting, onReconnect);
      await Promise.race([
        room.connect(preflight.url, preflight.livekit_token),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('preflight_timeout')), 10_000)),
      ]);
      await room.localParticipant.publishTrack(track);
      await new Promise((resolve) => window.setTimeout(resolve, STABLE_WINDOW_MS));
      const stats = await track.getSenderStats();
      const packets = stats?.packetsSent ?? 0;
      const evaluation = evaluateCandidatePreflight({
        stableMs: STABLE_WINDOW_MS,
        reconnects: reconnected ? 1 : 0,
        outboundAudioPackets: packets,
        audibleMs: AUDIO_REQUIRED_MS,
      });
      if (!evaluation.ok || room.state !== 'connected') throw new Error('unstable_connection');
      await room.disconnect(false);
      roomRef.current = null;
      setLevel(0);
      setState('passed');
      onReady(track);
      trackRef.current = null;
      if (analyserCleanupRef.current) await analyserCleanupRef.current().catch(() => undefined);
      analyserCleanupRef.current = null;
    } catch (error) {
      await room?.disconnect(false).catch(() => undefined);
      roomRef.current = null;
      await cleanupTrack();
      setState('failed');
      setMessage(messageFor(error));
    }
  }, [cleanupTrack, inviteToken, onReady]);

  async function chooseDevice(deviceId: string) {
    setSelectedDevice(deviceId);
    setState('idle');
    setMessage(null);
    setLevel(0);
    await cleanupTrack();
  }

  return (
    <section className="candidate-glass-card candidate-readiness" aria-labelledby="readiness-title">
      <button type="button" className="candidate-back" onClick={onBack}>← Back</button>
      <p className="candidate-eyebrow">Step 3 of 4 · Prepare your audio</p>
      <h1 id="readiness-title">Let’s make sure you’re ready</h1>
      <p className="candidate-muted">Audio screening for <strong>{roleTitle}</strong>. No camera is needed.</p>

      <label className="candidate-field-label" htmlFor="candidate-microphone">Microphone</label>
      <select
        id="candidate-microphone"
        className="candidate-select"
        value={selectedDevice}
        onChange={(event) => void chooseDevice(event.target.value)}
        disabled={state === 'microphone' || state === 'network'}
      >
        <option value="">Choose a microphone</option>
        {devices.map((device, index) => (
          <option key={device.deviceId || `microphone-${index}`} value={device.deviceId}>
            {device.label || `Microphone ${index + 1}`}
          </option>
        ))}
      </select>

      <div className="candidate-meter-card" aria-label={`Microphone level ${Math.round(level * 100)} percent`}>
        <p className="candidate-instruction">
          {state === 'microphone' ? 'Say a short sentence so we can hear you.' : 'Speak briefly to test your microphone.'}
        </p>
        <div className="candidate-level-meter" aria-hidden="true">
          {Array.from({ length: 18 }, (_, index) => <i key={index} data-on={index / 18 < level} />)}
        </div>
        <p className="candidate-meter-status">{state === 'microphone' ? 'Listening…' : 'Microphone check'}</p>
      </div>

      <div className="candidate-check-list" aria-live="polite">
        <div data-state={state === 'microphone' ? 'active' : state === 'failed' ? 'failed' : state === 'passed' || state === 'network' ? 'passed' : 'idle'}><span>01</span><b>Microphone</b><em>{state === 'microphone' ? 'Checking' : state === 'failed' ? 'Try again' : state === 'passed' || state === 'network' ? 'Ready' : 'Waiting'}</em></div>
        <div data-state={state === 'network' ? 'active' : state === 'passed' ? 'passed' : 'idle'}><span>02</span><b>Connection</b><em>{state === 'network' ? 'Testing' : state === 'passed' ? 'Stable' : 'Waiting'}</em></div>
      </div>

      {message && <p className="candidate-error" role="alert">{message}</p>}
      {state === 'passed' ? (
        <Button className="candidate-primary-cta" onClick={() => trackRef.current && onReady(trackRef.current)}>Continue to interview</Button>
      ) : (
        <Button className="candidate-primary-cta" onClick={() => void startAudioTest()} loading={state === 'microphone' || state === 'network'}>
          {state === 'failed' ? 'Test again' : 'Test microphone and connection'}
        </Button>
      )}
      <p className="candidate-privacy-note">Your device name stays in your browser and is never shared.</p>
    </section>
  );
}
