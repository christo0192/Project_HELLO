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
  type R1AttemptGrant,
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
 *   - Consent is server-authoritative: the page only trusts `consent.state` from the
 *     status route and re-checks it whenever the server reports the consent as stale.
 *     Declining makes no media request. A `declined` or `withdrawn` state is the person's
 *     own final choice on this page: it shows the closed card that says so, never the
 *     notice again.
 *   - A consent can always be ended from the page, as it can from the API (PR-3
 *     invariant 5): withdrawal is offered wherever consent is on file (the landing page,
 *     R1 paused or switched off, a finished, lapsed or cancelled link, the live room and
 *     the closing screens), and a decline wherever consent is not yet given, even while R1
 *     is paused or switched off.
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

const DEFAULT_ROLE_TITLE = 'Sales Program Advisor';
const DEFAULT_MINUTES = 20;
/** A cold worker takes 15-25 s to boot; poll the exchange for at most about 36 s. */
const PREPARING_ATTEMPTS = 12;
const PREPARING_RETRY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** The closed cards a person can still take a consent back from. */
const WITHDRAWABLE_KINDS: readonly R1ClosedKind[] = [
  'paused',
  'completed',
  'starts_exhausted',
  'expired',
  'cancelled',
];

const OPEN_ELSEWHERE =
  'Your interview is open on another device or browser tab. Return to it there, or close it '
  + 'and try again in a few minutes.';

/**
 * What starting again means after the interview the stored nonce named has ended. It is a NEW
 * admission (it spends one of the link's starts and takes the next attempt), so the person is
 * told before it happens instead of finding out from the attempts count.
 */
function restartNote(status: R1Status): string {
  const allowed = status.attempts_allowed;
  const next = allowed === null ? null : allowed - status.attempts_left + 1;
  const which = allowed !== null && next !== null && next >= 1 && next <= allowed
    ? `attempt ${next} of ${allowed}`
    : 'a new attempt';
  return `Your previous interview has ended and cannot be rejoined. Starting again begins ${which}.`;
}

function closedKindFor(kind: R1ErrorKind): R1ClosedKind {
  if (kind === 'link_invalid') return 'invalid';
  if (kind === 'link_expired') return 'expired';
  return 'unavailable';
}

function joinErrorMessage(kind: R1ErrorKind, liveElsewhere: boolean): string {
  switch (kind) {
    case 'busy':
      // The link's own interview is live and this tab holds no nonce for it: it is the
      // person's, not "another interview", and 20 minutes is the wrong thing to wait for.
      if (liveElsewhere) return `${OPEN_ELSEWHERE} Your link stays valid.`;
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
  const [landingNote, setLandingNote] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [liveElsewhere, setLiveElsewhere] = useState(false);
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
  /** A withdrawal from the live room is in flight: the room ending is its doing, not news. */
  const withdrawingRef = useRef(false);
  /** An ending the room reported while a withdrawal was in flight, applied if it fails. */
  const deferredEndRef = useRef<R1EndedKind | null>(null);
  /** The next status read follows a rejoin that found its interview over. */
  const restartPendingRef = useRef(false);

  const loadStatus = useCallback(async (token: string) => {
    loadRunRef.current += 1;
    const run = loadRunRef.current;
    const show = (next: Stage): void => {
      if (run === loadRunRef.current) setStage(next);
    };
    const restarting = restartPendingRef.current;
    restartPendingRef.current = false;
    show({ name: 'loading' });
    try {
      const next = await r1Api.status(token);
      if (run !== loadRunRef.current) return;
      setStatus(next);
      setTemplate(null);
      setWithdrawError(null);
      setConsentError(null);
      // This link's interview is live and this tab holds no nonce for it: it is open somewhere else.
      const elsewhere = next.live_attempt === true && readNonce(token) === null;
      setLiveElsewhere(elsewhere);
      setLandingNote(null);
      const spent = next.attempts_left <= 0 && next.state !== 'in_progress';
      // Every start used, and nothing live to rejoin: the interview can never be started
      // again from this link, so say so instead of letting each try spend a device check.
      const noStarts = next.can_start === false
        && next.starts_left === 0
        && next.live_attempt === false;
      // The person's own decision comes first: whatever else the link is, they chose that no
      // interview is held with it, and the card says what they were told when they chose.
      if (next.consent_state === 'withdrawn') show({ name: 'closed', kind: 'withdrawn' });
      else if (next.consent_state === 'declined') show({ name: 'closed', kind: 'declined' });
      else if (next.state === 'expired') show({ name: 'closed', kind: 'expired' });
      else if (next.state === 'cancelled') show({ name: 'closed', kind: 'cancelled' });
      else if (next.state === 'completed' || spent) show({ name: 'closed', kind: 'completed' });
      else if (noStarts) show({ name: 'closed', kind: 'starts_exhausted' });
      else if (next.availability !== 'open') {
        // R1 is off for now. Someone who has not agreed can still say no: the notice is not
        // gated by availability, and the decline needs its version. Without a notice, no decline.
        if (next.consent_state === 'required') {
          try {
            const notice = await r1Api.consentTemplate(token);
            if (run !== loadRunRef.current) return;
            setTemplate(notice);
          } catch {
            if (run !== loadRunRef.current) return;
          }
        }
        show({ name: 'closed', kind: 'paused' });
      } else if (next.consent_state === 'granted') {
        setLandingNote(restarting ? restartNote(next) : elsewhere ? OPEN_ELSEWHERE : null);
        show({ name: 'landing' });
      } else {
        // No locale is sent: the server picks the notice this link's audience is owed.
        const notice = await r1Api.consentTemplate(token);
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
        consents,
        status: granted ? 'granted' : 'declined',
      });
      setStage(granted ? { name: 'landing' } : { name: 'closed', kind: 'declined' });
    } catch (error) {
      const kind = classifyR1Error(error);
      if (kind === 'consent_required') {
        // The notice was superseded while it was open: read the current one and ask again.
        void loadStatus(token);
        return;
      }
      setConsentError(
        kind === 'link_invalid'
          ? 'This link is no longer valid. Please contact the hiring team.'
          : 'We could not record your choice. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Take the consent back, from wherever the person is. From the live room the server stops
   * the interview itself, so the room ending is part of this and not a connection loss to
   * offer a rejoin for: its ending is held back until the withdrawal is known to have worked.
   */
  async function withdraw(): Promise<void> {
    const token = linkRef.current;
    if (!token) return;
    const inRoom = controllerRef.current !== null;
    setBusy(true);
    setWithdrawError(null);
    withdrawingRef.current = inRoom;
    try {
      await r1Api.withdrawConsent(token);
      clearNonce();
      deferredEndRef.current = null;
      if (inRoom) {
        endedRef.current = true;
        abandonJoin(mediaRef.current);
      }
      setStatus((current) => (current ? { ...current, consent_state: 'withdrawn' } : current));
      setStage({ name: 'closed', kind: 'withdrawn' });
    } catch {
      setWithdrawError('We could not record your withdrawal. Please try again.');
      // The room may have ended while this was in flight; the person sees that ending now.
      withdrawingRef.current = false;
      const deferred = deferredEndRef.current;
      deferredEndRef.current = null;
      if (deferred) endInterview(deferred);
    } finally {
      withdrawingRef.current = false;
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
    if (withdrawingRef.current) {
      deferredEndRef.current = reason;
      return;
    }
    endedRef.current = true;
    // Only a finished or stopped interview forgets the nonce; a dropped one may rejoin.
    if (reason === 'agent_ended' || reason === 'aborted') clearNonce();
    stopR1Media(mediaRef.current);
    mediaRef.current = null;
    controllerRef.current = null;
    setLiveVideo(null);
    setStage({ name: 'ended', kind: reason });
  }

  function abandonJoin(media: R1LocalMedia | null): void {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    stopR1Media(media);
    mediaRef.current = null;
    setLiveVideo(null);
  }

  /**
   * Ask for an attempt, presenting the stored nonce to rejoin one. When the server says
   * that attempt is no longer live (it ended, or was cut), the nonce is spent: forget it,
   * and answer null so the page can say that starting again is a NEW interview (it spends
   * one of the link's starts and takes the next attempt) and let the person choose it,
   * rather than quietly admitting one the moment a rejoin fails.
   */
  async function requestAttempt(token: string): Promise<R1AttemptGrant | null> {
    const held = readNonce(token);
    try {
      return await r1Api.createAttempt(token, held);
    } catch (error) {
      if (held === null || classifyR1Error(error) !== 'attempt_not_live') throw error;
      clearNonce();
      return null;
    }
  }

  async function join(media: R1LocalMedia): Promise<void> {
    const token = linkRef.current;
    if (!token) return;
    mediaRef.current = media;
    endedRef.current = false;
    resetLive();
    setLandingError(null);
    setLandingNote(null);
    setStage({ name: 'joining', preparing: false });
    try {
      const attempt = await requestAttempt(token);
      if (!mountedRef.current) return;
      if (attempt === null) {
        // The interview this tab was in is over. Stop the camera and read the link again: the
        // landing page then says what starting again means, and the counts it shows are fresh.
        abandonJoin(media);
        restartPendingRef.current = true;
        void loadStatus(token);
        return;
      }
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
      // The link has nothing left to start: say so, rather than a generic "could not start".
      if (kind === 'starts_exhausted') {
        setStage({ name: 'closed', kind: 'starts_exhausted' });
        return;
      }
      if (kind === 'attempts_exhausted') {
        setStage({ name: 'closed', kind: 'completed' });
        return;
      }
      // Forget the nonce only when the server refused the link or the nonce itself. A
      // timeout, a failed connect or a 5xx leaves the attempt live, and without the nonce the
      // retry would be refused as busy by this candidate's own session.
      if (kind === 'link_invalid' || kind === 'link_expired') clearNonce();
      setLandingError(joinErrorMessage(kind, liveElsewhere));
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
  const audience = status?.audience ?? 'candidate';
  const withdrawControl = {
    busy,
    error: withdrawError,
    onConfirm: () => void withdraw(),
  };
  // Withdraw where a consent is on file; decline where none is, but only with a notice to
  // name (the paused card fetches it for exactly this).
  const closedWithdraw = stage.name === 'closed'
    && WITHDRAWABLE_KINDS.includes(stage.kind)
    && status?.consent_state === 'granted';
  const closedDecline = stage.name === 'closed'
    && stage.kind === 'paused'
    && status?.consent_state === 'required'
    && template !== null;

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
          audience={audience}
          onRetry={
            retryable && linkRef.current
              ? () => void loadStatus(linkRef.current as string)
              : undefined
          }
          withdraw={closedWithdraw ? withdrawControl : undefined}
          decline={
            closedDecline
              ? { busy, error: consentError, onConfirm: () => void submitConsent(false, []) }
              : undefined
          }
        />
      )}

      {stage.name === 'notice' && template && (
        <R1NoticeConsent
          // A new notice version starts from unticked boxes: agreements never carry over.
          key={template.version}
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
          notice={landingNote}
          withdrawError={withdrawError}
          busy={busy}
          onContinue={() => {
            setLandingError(null);
            setLandingNote(null);
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
          onWithdraw={() => void withdraw()}
          withdrawBusy={busy}
          withdrawError={withdrawError}
        />
      )}

      {stage.name === 'ended' && (
        <R1EndedCard
          kind={stage.kind}
          audience={audience}
          withdraw={withdrawControl}
          onRejoin={linkRef.current ? () => void loadStatus(linkRef.current as string) : undefined}
        />
      )}

      <audio ref={audioElementRef} autoPlay playsInline className="hidden" />
    </R1Shell>
  );
}
