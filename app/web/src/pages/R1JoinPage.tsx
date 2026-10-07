import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import { R1Landing } from '../components/candidate-r1/R1Landing';
import { R1LiveView } from '../components/candidate-r1/R1LiveView';
import { R1NoticeConsent } from '../components/candidate-r1/R1NoticeConsent';
import { R1ReadinessStep } from '../components/candidate-r1/R1ReadinessStep';
import type { R1ClosedKind, R1EndedKind } from '../components/candidate-r1/r1-copy';
import { R1ClosedCard, R1EndedCard, R1Shell } from '../components/candidate-r1/R1Screens';
import { useCapabilitySupport } from '../lib/capability-check';
import {
  classifyR1Error,
  r1Api,
  type R1ConsentTemplate,
  type R1ErrorKind,
  type R1LeadCard,
  type R1Status,
} from '../lib/r1/r1-api';
import { captureLinkToken, clearNonce, readNonce, saveNonce } from '../lib/r1/r1-link';
import { stopR1Media, type R1LocalMedia } from '../lib/r1/r1-media';
import {
  captionSpeakerFor,
  isLeadCardVisible,
  mergeCaptions,
  type R1Caption,
  type R1Phase,
} from '../lib/r1/r1-phase';
import { createR1Room, type R1RoomController, type R1RoomHandlers } from '../lib/r1/r1-room';

/**
 * The R1 candidate page, `/candidate/r1#<link token>` (plan sections 4, 7.8, 7.10).
 *
 * Flow: link -> notice and per-purpose consent -> camera, microphone and
 * connection check -> attempt -> exchange -> live room -> leave.
 *
 * Invariants:
 *   - The link token is captured from the URL fragment into a ref, the
 *     fragment is removed at once, and the token never reaches state, storage,
 *     the URL or a log. Missing or malformed means no API call at all.
 *   - Consent is server-authoritative: the page only trusts `consent_required`
 *     from the status route and re-checks it whenever the server reports the
 *     consent as stale. Declining makes no media request.
 *   - Nothing here records or uploads. There is no MediaRecorder and no
 *     completion call; leaving the room is the whole client-side ending.
 *   - A failure after the device check stops every track and returns to the
 *     landing page with the link still valid, so no camera light is left on.
 *   - The link token is fetched from the fragment at once but used only after
 *     the browser is known to support the interview: an unsupported browser
 *     makes no API call at all.
 *   - The rejoin nonce survives every failure except the server refusing the
 *     link or the nonce itself (401/403/404/410 and 400). A timeout, a failed
 *     connect or a 5xx leaves the attempt live on the server, and the nonce is
 *     the only thing that lets this candidate back into it instead of being
 *     refused as busy by their own session.
 *   - The 90 second rejoin is taken from THIS tab through the "Rejoin interview"
 *     button, which re-runs the status and device checks and then sends the
 *     stored nonce. The fragment was stripped from the address bar, so reloading
 *     or reopening the email link cannot do it.
 */

type Stage =
  | { name: 'loading' }
  | { name: 'closed'; kind: R1ClosedKind }
  | { name: 'notice' }
  | { name: 'landing' }
  | { name: 'readiness' }
  | { name: 'joining'; preparing: boolean }
  | { name: 'live' }
  | { name: 'ended'; kind: R1EndedKind };

const LOCALE = 'en-IN';
const DEFAULT_ROLE_TITLE = 'Sales Program Advisor';
const DEFAULT_MINUTES = 20;
/** A cold worker takes 15-25 s to boot; poll the exchange for at most about 36 s. */
const PREPARING_ATTEMPTS = 12;
const PREPARING_RETRY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function closedKindFor(kind: R1ErrorKind): R1ClosedKind {
  if (kind === 'link_invalid') return 'invalid';
  if (kind === 'link_expired') return 'expired';
  return 'unavailable';
}

function joinErrorMessage(kind: R1ErrorKind): string {
  switch (kind) {
    case 'busy':
      return 'Another interview is finishing. Please try again in about 20 minutes. '
        + 'Your link stays valid.';
    case 'rate_limited':
      return 'Too many tries in a short time. Please wait a minute and try again.';
    case 'unavailable':
      return 'The interview service is temporarily unavailable. Please try again in a few '
        + 'minutes. Your link stays valid.';
    case 'network':
      return 'We could not reach the server. Check your internet and try again.';
    default:
      return 'We could not start your interview. Please try again, or contact the hiring team.';
  }
}

export function R1JoinPage() {
  const capability = useCapabilitySupport();
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  const [status, setStatus] = useState<R1Status | null>(null);
  const [template, setTemplate] = useState<R1ConsentTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [landingError, setLandingError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [lead, setLead] = useState<R1LeadCard | null>(null);
  const [phase, setPhase] = useState<R1Phase | null>(null);
  const [agentPresent, setAgentPresent] = useState(false);
  const [lastActive, setLastActive] = useState<R1Phase | null>(null);
  const [level, setLevel] = useState(0);
  const [captions, setCaptions] = useState<R1Caption[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [liveVideo, setLiveVideo] = useState<LocalVideoTrack | null>(null);

  const linkRef = useRef<string | null>(null);
  const controllerRef = useRef<R1RoomController | null>(null);
  const mediaRef = useRef<R1LocalMedia | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const loadRunRef = useRef(0);
  const mountedRef = useRef(false);
  const endedRef = useRef(false);

  const loadStatus = useCallback(async (token: string) => {
    loadRunRef.current += 1;
    const run = loadRunRef.current;
    const show = (next: Stage): void => {
      if (run === loadRunRef.current) setStage(next);
    };
    show({ name: 'loading' });
    try {
      const next = await r1Api.status(token);
      if (run !== loadRunRef.current) return;
      setStatus(next);
      const spent = next.attempts_left <= 0 && next.state !== 'in_progress';
      if (next.state === 'expired') show({ name: 'closed', kind: 'expired' });
      else if (next.state === 'cancelled') show({ name: 'closed', kind: 'cancelled' });
      else if (next.state === 'completed' || spent) show({ name: 'closed', kind: 'completed' });
      else if (next.budget_paused) show({ name: 'closed', kind: 'paused' });
      else if (!next.consent_required) show({ name: 'landing' });
      else {
        const notice = await r1Api.consentTemplate(token, LOCALE);
        if (run !== loadRunRef.current) return;
        setTemplate(notice);
        show({ name: 'notice' });
      }
    } catch (error) {
      show({ name: 'closed', kind: closedKindFor(classifyR1Error(error)) });
    }
  }, []);

  // Link capture. The fragment is stripped at once, whatever the browser can do. Safe
  // under StrictMode's double effect: the second capture finds the fragment already
  // stripped and must not overwrite the token the first one kept.
  useEffect(() => {
    const captured = captureLinkToken();
    if (captured) linkRef.current = captured;
    if (!linkRef.current) setStage({ name: 'closed', kind: 'invalid' });
  }, []);

  // The first status read, only once the browser is known to be able to run the
  // interview: an unsupported browser sends the link token nowhere.
  useEffect(() => {
    if (capability !== 'supported' || !linkRef.current) return undefined;
    void loadStatus(linkRef.current);
    return () => {
      loadRunRef.current += 1;
    };
  }, [capability, loadStatus]);

  // A join is a chain of awaits. Once the page is gone nothing further may connect a
  // room or publish a track, so every step checks `mountedRef` before it acts.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      stopR1Media(mediaRef.current);
      mediaRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (stage.name === 'live' && window.scrollY > 0) window.scrollTo(0, 0);
  }, [stage.name]);

  async function submitConsent(granted: boolean, consents: string[]): Promise<void> {
    const token = linkRef.current;
    if (!token || !template) return;
    setBusy(true);
    setConsentError(null);
    try {
      await r1Api.submitConsent(token, {
        template_version: template.version,
        locale: template.locale,
        consents,
        status: granted ? 'granted' : 'declined',
      });
      setStage(granted ? { name: 'landing' } : { name: 'closed', kind: 'declined' });
    } catch (error) {
      setConsentError(
        classifyR1Error(error) === 'link_invalid'
          ? 'This link is no longer valid. Please contact the hiring team.'
          : 'We could not record your choice. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(): Promise<void> {
    const token = linkRef.current;
    if (!token) return;
    setBusy(true);
    setLandingError(null);
    try {
      await r1Api.withdrawConsent(token);
      clearNonce();
      setStage({ name: 'closed', kind: 'withdrawn' });
    } catch {
      setLandingError('We could not record your withdrawal. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function resetLive(): void {
    setPhase(null);
    setAgentPresent(false);
    setLastActive(null);
    setLevel(0);
    setCaptions([]);
    setMicMuted(false);
    setCameraOn(true);
    setLiveError(null);
  }

  function endInterview(reason: R1EndedKind): void {
    endedRef.current = true;
    // Only a finished or stopped interview forgets the nonce; a dropped one may rejoin.
    if (reason === 'agent_ended' || reason === 'aborted') clearNonce();
    stopR1Media(mediaRef.current);
    mediaRef.current = null;
    controllerRef.current = null;
    setLiveVideo(null);
    setStage({ name: 'ended', kind: reason });
  }

  function abandonJoin(media: R1LocalMedia): void {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    stopR1Media(media);
    mediaRef.current = null;
    setLiveVideo(null);
  }

  async function join(media: R1LocalMedia): Promise<void> {
    const token = linkRef.current;
    if (!token) return;
    mediaRef.current = media;
    endedRef.current = false;
    resetLive();
    setLandingError(null);
    setStage({ name: 'joining', preparing: false });
    try {
      const attempt = await r1Api.createAttempt(token, readNonce(token));
      if (!mountedRef.current) return;
      saveNonce(token, attempt.nonce);
      setLead(attempt.lead);
      let room = await r1Api.exchange(attempt.attempt_token, attempt.nonce);
      for (let tries = 0; room.status === 'preparing'; tries += 1) {
        if (!mountedRef.current) return;
        if (tries >= PREPARING_ATTEMPTS) throw new Error('r1_preparing_timeout');
        setStage({ name: 'joining', preparing: true });
        await sleep(PREPARING_RETRY_MS);
        room = await r1Api.exchange(attempt.attempt_token, attempt.nonce);
      }
      if (!mountedRef.current) return;
      const handlers: R1RoomHandlers = {
        onPhase: (next) => {
          setPhase(next);
          if (next !== 'paused_disconnected' && next !== 'ended') setLastActive(next);
        },
        onAgentPresent: setAgentPresent,
        onAgentLevel: setLevel,
        onCaptions: (segments, current) => {
          setCaptions((previous) => mergeCaptions(previous, segments, captionSpeakerFor(current)));
        },
        onCameraOn: setCameraOn,
        onEnded: endInterview,
      };
      const controller = createR1Room(handlers, () => audioElementRef.current);
      controllerRef.current = controller;
      await controller.connect(room.url, room.livekit_token, media);
      // The room may have ended while connecting: never replace an ending with a live view.
      if (endedRef.current || !mountedRef.current) return;
      setLiveVideo(media.video);
      setStage({ name: 'live' });
    } catch (error) {
      if (endedRef.current || !mountedRef.current) return;
      abandonJoin(media);
      const kind = classifyR1Error(error);
      if (kind === 'consent_required') {
        void loadStatus(token);
        return;
      }
      // Forget the nonce only when the server refused the link or the nonce itself. A
      // timeout, a failed connect or a 5xx leaves the attempt live, and without the nonce the
      // retry would be refused as busy by this candidate's own session.
      if (kind === 'link_invalid' || kind === 'link_expired') clearNonce();
      setLandingError(joinErrorMessage(kind));
      setStage({ name: 'landing' });
    }
  }

  async function toggleMicrophone(): Promise<void> {
    try {
      setMicMuted(await (controllerRef.current?.setMicMuted(!micMuted) ?? micMuted));
    } catch {
      setLiveError('We could not change your microphone. Please try again.');
    }
  }

  async function toggleCamera(): Promise<void> {
    try {
      setCameraOn(await (controllerRef.current?.setCameraOn(!cameraOn) ?? cameraOn));
    } catch {
      setLiveError('We could not change your camera. Please try again.');
    }
  }

  if (capability === 'unsupported') {
    return (
      <R1Shell>
        <R1ClosedCard kind="unsupported" />
      </R1Shell>
    );
  }

  const roleTitle = status?.role_title ?? DEFAULT_ROLE_TITLE;
  const minutes = status?.format.duration_minutes ?? DEFAULT_MINUTES;
  const pills = [`About ${minutes} minutes`, 'Camera and microphone on', 'Private and secure'];
  const facts = [
    `About ${minutes} minutes with an AI interviewer`,
    'Your camera and microphone stay on throughout',
    'Includes a short sales role-play in which the interviewer plays a prospective learner',
  ];
  const retryable = stage.name === 'closed'
    && (stage.kind === 'paused' || stage.kind === 'unavailable');

  return (
    <R1Shell>
      {(stage.name === 'loading' || capability === 'checking') && (
        <p className="candidate-glass-card candidate-status-card" role="status">
          Checking your interview link…
        </p>
      )}

      {stage.name === 'closed' && capability !== 'checking' && (
        <R1ClosedCard
          kind={stage.kind}
          onRetry={
            retryable && linkRef.current
              ? () => void loadStatus(linkRef.current as string)
              : undefined
          }
        />
      )}

      {stage.name === 'notice' && template && (
        <R1NoticeConsent
          template={template}
          roleTitle={roleTitle}
          facts={facts}
          busy={busy}
          error={consentError}
          onGrant={(consents) => void submitConsent(true, consents)}
          onDecline={() => void submitConsent(false, [])}
        />
      )}

      {stage.name === 'landing' && (
        <R1Landing
          roleTitle={roleTitle}
          pills={pills}
          attemptsLeft={status?.attempts_left ?? 0}
          error={landingError}
          busy={busy}
          onContinue={() => {
            setLandingError(null);
            setStage({ name: 'readiness' });
          }}
          onWithdraw={() => void withdraw()}
        />
      )}

      {stage.name === 'readiness' && linkRef.current && (
        <R1ReadinessStep
          linkToken={linkRef.current}
          roleTitle={roleTitle}
          onBack={() => setStage({ name: 'landing' })}
          onConsentRequired={() => void loadStatus(linkRef.current as string)}
          onReady={(media) => void join(media)}
        />
      )}

      {stage.name === 'joining' && (
        <div
          className="candidate-glass-card candidate-landing candidate-status-card"
          role="status"
          aria-live="polite"
        >
          <p className="candidate-eyebrow">Almost ready</p>
          <h1>{stage.preparing ? 'Preparing your interview…' : 'Joining your interview…'}</h1>
          <p className="candidate-muted">
            We are getting your private interviewer ready. This can take a few moments, so
            please keep this tab open.
          </p>
        </div>
      )}

      {stage.name === 'live' && (
        <R1LiveView
          roleTitle={roleTitle}
          phase={phase}
          agentPresent={agentPresent}
          leadVisible={isLeadCardVisible(phase, lastActive)}
          lead={lead}
          level={level}
          captions={captions}
          micMuted={micMuted}
          cameraOn={cameraOn}
          video={liveVideo}
          error={liveError}
          onToggleMic={() => void toggleMicrophone()}
          onToggleCamera={() => void toggleCamera()}
          onLeave={() => void controllerRef.current?.leave()}
        />
      )}

      {stage.name === 'ended' && (
        <R1EndedCard
          kind={stage.kind}
          onRejoin={linkRef.current ? () => void loadStatus(linkRef.current as string) : undefined}
        />
      )}

      <audio ref={audioElementRef} autoPlay playsInline className="hidden" />
    </R1Shell>
  );
}
