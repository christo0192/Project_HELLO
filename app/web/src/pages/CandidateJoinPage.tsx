import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createLocalAudioTrack,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  ParticipantKind,
  type TranscriptionSegment,
} from 'livekit-client';
import { api, ApiError } from '../api';
import type { CandidateConsentTemplate } from '../types';
import { Button } from '../components/ui';
import { AudioReadinessStep } from '../components/candidate-join/AudioReadinessStep';
import { InterviewerAura } from '../components/candidate-join/InterviewerAura';
import { useCapabilitySupport } from '../lib/capability-check';
import '../styles/candidate-experience.css';

const AGENT_PARTICIPANT_KIND = (ParticipantKind as unknown as { AGENT?: unknown } | undefined)?.AGENT;
const MODERN_CANDIDATE_EXPERIENCE = import.meta.env.VITE_CANDIDATE_WEBRTC_V2 !== 'false';

/**
 * Phase 9 L4 — candidate join with SERVER-AUTHORITATIVE consent.
 *
 * Flow (invariant 3 / consistency #2):
 *   1. The one-time invite token is read from the URL FRAGMENT only and kept
 *      ONLY in memory (inviteRef). The fragment is removed immediately. It is
 *      never placed in query params, path, session/local storage, or logs.
 *   2. POST /api/candidate-consent/status { invite_token } → bounded
 *      has_consent / template_version / locale / required_consents.
 *   3. No consent → fetch the active template (GET /api/candidate-consent/
 *      template) and render a plain-text, safe, accessible mobile consent
 *      form with an exact checkbox per required type.
 *   4. Grant → POST /api/candidate-consent/submit {status:'granted'} → the
 *      join button appears. Decline → POST submit {status:'declined'} → a
 *      permanent decline screen with NO join/exchange/createLocalAudioTrack.
 *   5. Join → POST /api/livekit/exchange — the server re-validates the LATEST
 *      consent record + active template before consuming the invite (409
 *      consent_required leaves the invite unconsumed).
 *
 * Negative controls: missing/malformed fragment → NO consent API call and the
 * fragment is still removed immediately; declined/latest-withdrawn → join
 * button absent; granted only after ALL required checkboxes are checked.
 */

type JoinPhase =
  | 'loading'        // consent status + template being resolved
  | 'need-consent'   // consent form shown
  | 'granted'        // join enabled
  | 'declined'       // candidate declined — no join, ever
  | 'error';         // invite missing/malformed or server error

const LOCALE = 'en-IN';
const CANDIDATE_FINALIZE_ATTEMPTS = 6;
const CANDIDATE_FINALIZE_RETRY_MS = 2000;
const MAX_LIVE_TRANSCRIPT_SEGMENTS = 100;

interface LiveTranscriptSegment {
  id: string;
  text: string;
  final: boolean;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Invites issued by the API are 256-bit tokens serialized as 64 hex chars. */
const INVITE_TOKEN_RE = /^[a-f0-9]{64}$/;

async function acquireLocalAudioTrack(): Promise<LocalAudioTrack> {
  const preferredAudioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  try {
    return await createLocalAudioTrack(preferredAudioConstraints);
  } catch (primaryError) {
    const mediaDevices = window.navigator?.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw primaryError;
    }

    let lastError = primaryError;
    for (const constraints of [
      { audio: preferredAudioConstraints },
      { audio: true },
    ] satisfies MediaStreamConstraints[]) {
      try {
        const stream = await mediaDevices.getUserMedia(constraints);
        const [track] = stream.getAudioTracks();
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          throw new DOMException('No audio track returned by browser', 'NotFoundError');
        }
        return new LocalAudioTrack(track);
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }
    throw lastError;
  }
}

/**
 * Stable server codes surfaced by POST /api/livekit/exchange, mapped to
 * candidate-facing copy. Each of these leaves the one-time invite UNCONSUMED
 * server-side, so the join button stays usable and a retry is meaningful.
 */
function exchangeErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.message : '';
  if (code === 'screening_room_unavailable') {
    return 'We could not open your screening room just now. Please try again in a moment — your invite is still valid.';
  }
  if (code === 'consent_required') {
    return 'Your consent is missing or no longer valid. Please review and accept the consent form, then try again.';
  }
  if (code === 'invite_token_invalid_or_expired') {
    return 'This invite is missing, expired, revoked, or already used.';
  }
  if (error instanceof ApiError && error.message.trim()) return error.message;
  return 'Unable to join this screening.';
}

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission is blocked. Please allow microphone access in your browser site settings and try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable microphone was found. Please connect or enable a microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The browser could not start the microphone. Close other apps using the mic, check OS microphone privacy settings, then try again.';
  }
  if (name === 'TypeError') {
    return 'This browser could not start microphone capture. Please try Chrome or Edge over HTTPS.';
  }
  return 'Microphone access is required before this invite can be used. Please allow microphone access and try again.';
}

function plainText(markdown: string): string {
  // Render template body as SAFE PLAIN TEXT — no markdown/HTML execution.
  return markdown.replace(/[`*_~#>]/g, '').trim();
}

export function CandidateJoinPage() {
  const [phase, setPhase] = useState<JoinPhase>('loading');
  const [status, setStatus] = useState<'ready' | 'joining' | 'live' | 'ending' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<CandidateConsentTemplate | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [roleTitle, setRoleTitle] = useState('your screening role');
  const [candidateStage, setCandidateStage] = useState<'landing' | 'consent' | 'readiness'>('consent');
  const [inviteHasConsent, setInviteHasConsent] = useState(false);
  const [interviewerLevel, setInterviewerLevel] = useState(0);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [completionKind, setCompletionKind] = useState<'completed' | 'closed'>('completed');
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptSegment[]>([]);
  const navigate = useNavigate();
  const endedRedirectedRef = useRef(false);
  const inviteRef = useRef<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const grantTokenRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const finalizationPromiseRef = useRef<Promise<void> | null>(null);
  const manualCloseRef = useRef(false);
  const capabilityStatus = useCapabilitySupport();

  useEffect(() => {
    if (phase !== 'granted' || status !== 'ended' || endedRedirectedRef.current) return;
    endedRedirectedRef.current = true;
    // Keep the terminal screen on a separate route. No invite, session, or
    // grant data is placed in the URL or navigation state.
    navigate('/candidate/ended', { replace: true });
  }, [navigate, phase, status]);

  useEffect(() => {
    if (status === 'live' && window.scrollY > 0) window.scrollTo(0, 0);
  }, [status]);

  // ── Invite capture: fragment → memory only, fragment removed immediately ─
  useEffect(() => {
    const raw = window.location.hash.slice(1);
    let invite = '';
    try {
      invite = raw ? decodeURIComponent(raw) : '';
    } catch {
      // Malformed percent-encoding is treated exactly like any other invalid
      // invite. The fragment is still removed below and no API call is made.
      invite = '';
    }
    // Fail closed on missing/malformed fragments — never call the API with a
    // value that cannot be a real invite (64-hex).
    inviteRef.current = INVITE_TOKEN_RE.test(invite) ? invite : null;
    // Fragment removed immediately — even when missing/malformed.
    window.history.replaceState(null, '', '/candidate/join');

    return () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      localTrackRef.current?.stop();
      roomRef.current?.disconnect();
    };
  }, []);

  // ── Completion-signal survivability (MITIGATION ONLY) ──────────────────
  // The normal completion signal is an ordinary fetch, and a browser tearing
  // the page down cancels those. Since that call was the only client-side
  // thing that completed the session and finalized the recording, a candidate
  // who closed the tab left the row for the reconciler to expire much later.
  // `pagehide` plus the `keepalive` flag on the request itself closes that.
  //
  // This is a LATENCY mitigation and nothing more: the server-side convergence
  // path (0038 terminal-transition trigger → finalize worker → sweeper) is
  // required to be correct with this call deleted entirely, and the API suite
  // asserts precisely that.
  //
  // DELIBERATELY NOT `visibilitychange → hidden`. That event also fires when a
  // candidate switches tabs or backgrounds a mobile browser MID-INTERVIEW, and
  // this handler ends the session — so wiring it there would trade a bounded
  // convergence delay for terminating live screenings. `pagehide` is the event
  // that actually means "this page is going away". The residual cost is a
  // mobile browser that kills the tab without firing `pagehide`; that case
  // converges server-side like every other, which is the whole point.
  //
  // `pagehide` carries a NARROWER version of the same hazard, which is what
  // `event.persisted` guards. When a page enters the back/forward cache — a
  // mobile Safari app-switch, a back-navigation — `pagehide` fires with
  // `persisted === true` and the page can be RESTORED later via `pageshow`.
  // Ending the candidate's session on that would be the same defect as wiring
  // `visibilitychange`, just rarer. A page holding a live WebRTC peer
  // connection is normally ineligible for bfcache, so the realistic exposure is
  // the window between the grant landing and the room connecting — small, but
  // `unloadSignalSentRef` makes it unrecoverable, so it is guarded rather than
  // reasoned away.
  const unloadSignalSentRef = useRef(false);
  useEffect(() => {
    function sendCompletionSignal(event: PageTransitionEvent): void {
      // A bfcache freeze is not a page going away — it can come back.
      if (event.persisted) return;
      if (unloadSignalSentRef.current) return;
      // If the ordinary finalization already started, it owns the outcome.
      if (finalizationPromiseRef.current) return;
      const sessionId = sessionIdRef.current;
      const grantToken = grantTokenRef.current;
      if (!sessionId || !grantToken) return;
      unloadSignalSentRef.current = true;
      // Errors are irrelevant on this path: nothing here is load-bearing, and
      // there is no UI left to show a failure to.
      void api.completeCandidateScreening(sessionId, grantToken).catch(() => undefined);
    }
    const listener = sendCompletionSignal as EventListener;
    window.addEventListener('pagehide', listener);
    return () => {
      window.removeEventListener('pagehide', listener);
    };
  }, []);

  const allRequiredChecked = useCallback(
    (t: CandidateConsentTemplate | null): boolean => {
      if (!t) return false;
      return t.required_consents.every((r) => checked[r] === true);
    },
    [checked],
  );

  // ── Server-authoritative consent status + template resolution ──────────
  useEffect(() => {
    const invite = inviteRef.current;
    if (!invite) {
      // Missing/malformed fragment → NO consent API call, fail closed.
      setPhase('error');
      setError('This invite is missing, expired, revoked, or already used.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const consent = await api.candidateConsentStatus({ invite_token: invite });
        if (cancelled) return;
        const modernCandidateFlow = MODERN_CANDIDATE_EXPERIENCE && typeof api.candidateLiveKitPreflight === 'function';
        if (modernCandidateFlow && !consent.role_title) {
          setPhase('error');
          setError('screening_context_unavailable');
          return;
        }
        if (consent.role_title) setRoleTitle(consent.role_title);
        setInviteHasConsent(consent.has_consent);
        if (modernCandidateFlow) setCandidateStage('landing');
        if (consent.has_consent) {
          setPhase('granted');
          return;
        }
        const tpl = await api.getCandidateConsentTemplate(LOCALE);
        if (cancelled) return;
        setTemplate(tpl);
        setCandidateStage(modernCandidateFlow ? 'landing' : 'consent');
        setPhase('need-consent');
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setError(
          err instanceof ApiError
            ? err.message
            : 'Unable to check your invitation. Please try again later.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function grantConsent() {
    const invite = inviteRef.current;
    if (!invite || !template) return;
    setError(null);
    try {
      await api.submitCandidateConsent({
        invite_token: invite,
        template_version: template.version,
        locale: template.locale,
        consents: template.required_consents.filter((r) => checked[r] === true),
        status: 'granted',
      });
      if (MODERN_CANDIDATE_EXPERIENCE && typeof api.candidateLiveKitPreflight === 'function') {
        setCandidateStage('readiness');
      }
      setPhase('granted');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record your consent.');
    }
  }

  async function declineConsent() {
    const invite = inviteRef.current;
    if (!invite || !template) return;
    setError(null);
    try {
      await api.submitCandidateConsent({
        invite_token: invite,
        template_version: template.version,
        locale: template.locale,
        consents: [],
        status: 'declined',
      });
      // Decline persists and NEVER exchanges/joins/consumes the token.
      setPhase('declined');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record your consent.');
    }
  }

  function startBrowserRecording(localTrack: LocalAudioTrack) {
    const MediaRecorderCtor = window.MediaRecorder;
    const mediaStreamTrack = localTrack.mediaStreamTrack;
    if (!MediaRecorderCtor || !mediaStreamTrack) return;
    try {
      const stream = new MediaStream([mediaStreamTrack]);
      const options = MediaRecorderCtor.isTypeSupported?.('audio/webm;codecs=opus')
        ? { mimeType: 'audio/webm;codecs=opus' }
        : undefined;
      const recorder = new MediaRecorderCtor(stream, options);
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
    } catch {
      recorderRef.current = null;
      recordingChunksRef.current = [];
    }
  }

  async function stopBrowserRecording(): Promise<Blob | null> {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return null;
    if (recorder.state === 'recording') {
      await new Promise<void>((resolve) => {
        const previous = recorder.onstop;
        recorder.onstop = (event) => {
          previous?.call(recorder, event);
          resolve();
        };
        recorder.stop();
      });
    }
    const chunks = recordingChunksRef.current;
    recordingChunksRef.current = [];
    if (chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    return blob.size > 0 ? blob : null;
  }

  async function uploadBrowserFallback(blob: Blob | null) {
    const sessionId = sessionIdRef.current;
    const grantToken = grantTokenRef.current;
    if (!blob || !sessionId || !grantToken) return;
    for (let attempt = 1; attempt <= CANDIDATE_FINALIZE_ATTEMPTS; attempt += 1) {
      try {
        await api.uploadCandidateRecording(sessionId, grantToken, blob);
        return;
      } catch (err) {
        // HTTP 409 authoritative_recording_pending → egress is authoritative;
        // browser upload is NOT needed. Terminate without consuming retries.
        if (err instanceof ApiError && err.status === 409) return;
        if (attempt < CANDIDATE_FINALIZE_ATTEMPTS) {
          await sleep(CANDIDATE_FINALIZE_RETRY_MS * attempt);
        }
      }
    }
  }

  function finalizeCandidateCall(disconnectRoom: boolean): Promise<void> {
    if (finalizationPromiseRef.current) return finalizationPromiseRef.current;
    const finalization = (async () => {
      const fallbackBlob = await stopBrowserRecording();
      localTrackRef.current?.stop();
      localTrackRef.current = null;
      if (disconnectRoom) roomRef.current?.disconnect();
      roomRef.current = null;

      const sessionId = sessionIdRef.current;
      const grantToken = grantTokenRef.current;
      if (!sessionId || !grantToken) return;

      let fallbackRequired = false;
      for (let attempt = 1; attempt <= CANDIDATE_FINALIZE_ATTEMPTS; attempt += 1) {
        try {
          const result = await api.completeCandidateScreening(sessionId, grantToken);
          const recordingStatus = result.recording_status ?? 'fallback_required';
          if (recordingStatus === 'ready') return;
          if (recordingStatus === 'fallback_required') {
            fallbackRequired = true;
            break;
          }
        } catch {
          // Retain the in-memory blob while the API cold-starts or Egress settles.
        }
        if (attempt < CANDIDATE_FINALIZE_ATTEMPTS) {
          await sleep(CANDIDATE_FINALIZE_RETRY_MS * attempt);
        }
      }

      // I‑2: browser upload is accepted only when the server explicitly
      // declares fallback. pending / ready mean the egress is authoritative
      // (or will be) — NEVER upload the browser-only blob in those cases.
      if (fallbackRequired) {
        await uploadBrowserFallback(fallbackBlob);
      }
    })().finally(() => setStatus('ended'));
    finalizationPromiseRef.current = finalization;
    return finalization;
  }

  async function join(preflightTrack?: LocalAudioTrack) {
    const invite = inviteRef.current;
    if (!invite || phase !== 'granted') {
      setError('This invite is missing, expired, revoked, or already used.');
      return;
    }

    setStatus('joining');
    setError(null);
    let joinStep: 'microphone' | 'exchange' | 'connect' = 'microphone';
    try {
      // Acquire microphone access before consuming the one-time invite. If the
      // browser permission/device step fails, the invite remains reusable.
      const localTrack = preflightTrack ?? await acquireLocalAudioTrack();
      localTrackRef.current = localTrack;
      manualCloseRef.current = false;
      setMicrophoneMuted(false);

      joinStep = 'exchange';
      const access = await api.exchangeCandidateInvite(invite);
      inviteRef.current = null;
      grantTokenRef.current = access.grant_token;
      sessionIdRef.current = access.session_id;

      joinStep = 'connect';
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      setLiveTranscript([]);
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && remoteAudioRef.current) {
          track.attach(remoteAudioRef.current);
        }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (participants) => {
        const interviewer = participants.find((participant) => (
          (AGENT_PARTICIPANT_KIND !== undefined && participant.kind === AGENT_PARTICIPANT_KIND) ||
          (participant.kind as unknown) === 'agent' ||
          participant.attributes?.hello_speaker === 'interviewer'
        ));
        setInterviewerLevel(interviewer ? Math.max(0, Math.min(1, interviewer.audioLevel)) : 0);
      });
      room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        const isInterviewer = participant && (
          (AGENT_PARTICIPANT_KIND !== undefined && participant.kind === AGENT_PARTICIPANT_KIND) ||
          (participant.kind as unknown) === 'agent' ||
          participant.attributes?.hello_speaker === 'interviewer'
        );
        if (!isInterviewer) return;
        setLiveTranscript((previous) => {
          const next = [...previous];
          for (const segment of segments as TranscriptionSegment[]) {
            const text = segment.text.trim();
            if (!text) continue;
            const value: LiveTranscriptSegment = {
              id: segment.id,
              text,
              final: segment.final,
            };
            const existing = next.findIndex((item) => item.id === segment.id);
            if (existing >= 0) next[existing] = value;
            else next.push(value);
          }
          return next.slice(-MAX_LIVE_TRANSCRIPT_SEGMENTS);
        });
      });
      room.on(RoomEvent.Disconnected, () => {
        if (!manualCloseRef.current) setCompletionKind('completed');
        setStatus('ending');
        void finalizeCandidateCall(false);
      });
      await room.connect(access.url, access.livekit_token);
      await room.localParticipant.publishTrack(localTrack);
      startBrowserRecording(localTrack);
      setStatus('live');
    } catch (err) {
      localTrackRef.current?.stop();
      localTrackRef.current = null;
      roomRef.current?.disconnect();
      roomRef.current = null;
      setStatus('ready');
      if (joinStep === 'microphone') {
        setError(microphoneErrorMessage(err));
        return;
      }
      setError(exchangeErrorMessage(err));
    }
  }

  async function toggleMicrophone() {
    const track = localTrackRef.current;
    if (!track) return;
    try {
      if (track.isMuted) await track.unmute();
      else await track.mute();
      setMicrophoneMuted(track.isMuted);
    } catch {
      setError('We could not change your microphone state. Please try again.');
    }
  }

  async function leave() {
    manualCloseRef.current = true;
    setCompletionKind('closed');
    setStatus('ending');
    await finalizeCandidateCall(true);
  }

  const modernFlow = MODERN_CANDIDATE_EXPERIENCE && typeof api.candidateLiveKitPreflight === 'function';
  const presentedItems = template?.consent_items?.filter((item) => template.required_consents.includes(item.type)) ?? [];
  const consentItems = template && presentedItems.length === template.required_consents.length
    ? presentedItems
    : template?.required_consents.map((type) => ({ type, label: `I agree to ${type.replace(/_/g, ' ')}.` })) ?? [];
  const allChecked = template ? allRequiredChecked(template) : false;

  if (phase === 'declined') {
    return <main className="candidate-experience candidate-shell candidate-scope"><div className="candidate-shell__inner"><div className="candidate-brand"><img src="/ik-logo.png" alt="Interview Kickstart" /><div><b>Interview Kickstart</b><span>Candidate interview</span></div></div><div className="candidate-glass-card candidate-landing candidate-status-card"><p className="candidate-eyebrow">Invitation closed</p><h1>Consent declined</h1><p className="candidate-muted">This screening cannot start without the required consent.</p></div></div></main>;
  }

  return (
    <main className="candidate-experience candidate-shell candidate-scope">
      <div className="candidate-shell__inner">
        <header className="candidate-brand" aria-label="Interview Kickstart">
          <img src="/ik-logo.png" alt="Interview Kickstart" />
          <div><b>Interview Kickstart</b><span>Private candidate interview</span></div>
        </header>

        {phase === 'loading' && <p className="candidate-glass-card candidate-status-card" role="status">Checking your invitation…</p>}
        {phase === 'error' && <div className="candidate-glass-card candidate-landing candidate-status-card"><p className="candidate-eyebrow">Unable to continue</p><h1>We couldn’t open this invite</h1><p className="candidate-error" role="alert">{error}</p></div>}

        {phase === 'need-consent' && candidateStage === 'landing' && (
          <section className="candidate-glass-card candidate-landing candidate-status-card" aria-labelledby="invite-title">
            <p className="candidate-eyebrow">Your invitation</p>
            <h1 id="invite-title">Audio screening interview</h1>
            <h2 className="candidate-role">{roleTitle}</h2>
            <p className="candidate-muted">A short, audio-only conversation with our AI interviewer. No camera is needed.</p>
            <div className="candidate-landing__meta"><span className="candidate-pill">Audio only</span><span className="candidate-pill">Approx. 20 minutes</span><span className="candidate-pill">Private and secure</span></div>
            <Button className="candidate-primary-cta" onClick={() => setCandidateStage('consent')}>Review consent</Button>
          </section>
        )}

        {phase === 'granted' && candidateStage === 'landing' && (
          <section className="candidate-glass-card candidate-landing candidate-status-card" aria-labelledby="invite-title">
            <p className="candidate-eyebrow">Your invitation</p><h1 id="invite-title">Audio screening interview</h1><h2 className="candidate-role">{roleTitle}</h2><p className="candidate-muted">Your consent is on file. Let’s check your audio and connection before we begin.</p><Button className="candidate-primary-cta" onClick={() => setCandidateStage('readiness')}>Prepare my audio</Button>
          </section>
        )}

        {phase === 'need-consent' && candidateStage === 'consent' && template && (
          <section className="candidate-glass-card candidate-consent candidate-status-card" aria-labelledby="consent-title">
            <p className="candidate-eyebrow">Step 2 of 4 · Consent</p><h1 id="consent-title">A few things before we begin</h1><h2 className="sr-only">Screening consent</h2>
            <p className="candidate-consent__summary">{template.summary ?? 'Please review and accept each item to continue to your audio screening.'}</p>
            <fieldset><legend className="candidate-field-label">Required consent</legend>
              <label className="candidate-consent__all"><input type="checkbox" checked={allChecked} ref={(input) => { if (input) input.indeterminate = !allChecked && template.required_consents.some((type) => checked[type]); }} onChange={(event) => { const value = event.target.checked; setChecked(Object.fromEntries(template.required_consents.map((type) => [type, value]))); }} /><span>Select all required consents</span></label>
              <div className="candidate-consent__items">{consentItems.map((item) => <label className="candidate-consent__item" key={item.type}><input type="checkbox" aria-label={item.type.replace(/_/g, ' ')} checked={checked[item.type] === true} onChange={(event) => setChecked((prev) => ({ ...prev, [item.type]: event.target.checked }))} /><span>{item.label}</span></label>)}</div>
            </fieldset>
            <details className="candidate-consent__details"><summary>Read full consent details</summary><p>{plainText(template.body_md)}</p></details>
            <div className="candidate-interview__controls"><Button onClick={grantConsent} disabled={!allChecked}>Accept and continue</Button><Button variant="secondary" onClick={declineConsent}>Decline</Button></div>
            <p className="candidate-privacy-note">Questions? <Link to="/privacy-notice">Review the privacy notice</Link>.</p>
          </section>
        )}

        {phase === 'granted' && candidateStage === 'readiness' && modernFlow && status !== 'live' && (
          capabilityStatus === 'unsupported'
            ? <div className="candidate-glass-card candidate-landing candidate-status-card" role="alert"><h1>Browser not supported</h1><p className="candidate-error">Your browser does not support the microphone and WebRTC features this screening requires. Please use a current browser over HTTPS.</p></div>
            : <AudioReadinessStep inviteToken={inviteRef.current ?? ''} roleTitle={roleTitle} onBack={() => setCandidateStage(inviteHasConsent ? 'landing' : 'consent')} onReady={(track) => { localTrackRef.current = track; void join(track); }} />
        )}

        {phase === 'granted' && status === 'live' && (
          <section className="candidate-interview" aria-label="Live audio interview">
            <div className="candidate-glass-card candidate-interview__stage"><div><p className="candidate-eyebrow">Live interview</p><h1 className="candidate-role">{roleTitle}</h1><InterviewerAura level={interviewerLevel} speaking={interviewerLevel > 0.025} /><div className="candidate-interview__controls"><button type="button" aria-pressed={microphoneMuted} onClick={() => void toggleMicrophone()}>{microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}</button><button type="button" onClick={() => void leave()}>Leave screening</button></div></div></div>
            <section role="region" className="candidate-glass-card candidate-interview__captions" aria-label="Live transcript"><h2 id="interviewer-caption-title">Interviewer</h2><div className="candidate-caption-list" aria-live="polite">{liveTranscript.length === 0 ? <p className="candidate-muted">Listening for the interviewer…</p> : liveTranscript.map((segment) => <p className="candidate-caption" key={segment.id}><small>{segment.final ? 'Interviewer' : 'Speaking'}</small>{segment.text}</p>)}</div></section>
          </section>
        )}

        {phase === 'granted' && status === 'ending' && <div className="candidate-glass-card candidate-landing candidate-status-card" role="status"><p className="candidate-eyebrow">Wrapping up</p><h1>Saving your screening…</h1><p className="candidate-muted">Please keep this tab open for a moment while we securely finish.</p></div>}

        {phase === 'granted' && status === 'ended' && <div className="candidate-glass-card candidate-landing candidate-status-card"><p className="candidate-eyebrow">{completionKind === 'completed' ? 'Screening complete' : 'Screening closed'}</p><h1>{completionKind === 'completed' ? 'Your screening is complete.' : 'Your screening has been closed.'}</h1><p className="candidate-muted">{completionKind === 'completed' ? 'Thank you for your time. You can now close this browser tab.' : 'You can now close this browser tab.'}</p></div>}

        {phase === 'granted' && status !== 'live' && status !== 'ending' && status !== 'ended' && !modernFlow && (capabilityStatus === 'unsupported' ? <div role="alert" className="candidate-glass-card candidate-landing candidate-status-card"><h1>Browser not supported</h1><p className="candidate-error">Your browser does not support the microphone and WebRTC features this screening requires.</p></div> : <Button className="candidate-primary-cta candidate-fallback-cta" onClick={() => void join()} loading={status === 'joining'}>Join screening</Button>)}

        {error && phase !== 'error' && <p className="candidate-error" role="alert">{error}</p>}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      </div>
    </main>
  );
}
