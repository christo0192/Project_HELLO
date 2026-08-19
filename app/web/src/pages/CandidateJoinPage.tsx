import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createLocalAudioTrack,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from 'livekit-client';
import { api, ApiError } from '../api';
import type { CandidateConsentTemplate } from '../types';
import { Button, Card } from '../components/ui';
import { useCapabilitySupport } from '../lib/capability-check';

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
  speaker: 'christy' | 'candidate';
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
  const [status, setStatus] = useState<'ready' | 'joining' | 'live' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<CandidateConsentTemplate | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptSegment[]>([]);
  const inviteRef = useRef<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const grantTokenRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const finalizationPromiseRef = useRef<Promise<void> | null>(null);
  const capabilityStatus = useCapabilitySupport();

  // ── Invite capture: fragment → memory only, fragment removed immediately ─
  useEffect(() => {
    const raw = window.location.hash.slice(1);
    const invite = raw ? decodeURIComponent(raw) : '';
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
  const unloadSignalSentRef = useRef(false);
  useEffect(() => {
    function sendCompletionSignal(): void {
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
    window.addEventListener('pagehide', sendCompletionSignal);
    return () => {
      window.removeEventListener('pagehide', sendCompletionSignal);
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
        if (consent.has_consent) {
          setPhase('granted');
          return;
        }
        const tpl = await api.getCandidateConsentTemplate(LOCALE);
        if (cancelled) return;
        setTemplate(tpl);
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

  async function join() {
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
      const localTrack = await acquireLocalAudioTrack();
      localTrackRef.current = localTrack;

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
      room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        const speaker: LiveTranscriptSegment['speaker'] =
          participant?.identity === room.localParticipant.identity ? 'candidate' : 'christy';
        setLiveTranscript((previous) => {
          const next = [...previous];
          for (const segment of segments as TranscriptionSegment[]) {
            const text = segment.text.trim();
            if (!text) continue;
            const value: LiveTranscriptSegment = {
              id: segment.id,
              text,
              speaker,
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
        setStatus('ended');
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

  async function leave() {
    await finalizeCandidateCall(true);
  }

  // ── Decline is terminal: no join button, no exchange, no media access ──
  if (phase === 'declined') {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
        <Card className="w-full p-6">
          <h1 className="text-xl font-semibold text-gray-900">Consent declined</h1>
          <p className="mt-2 text-sm text-gray-600">
            You declined the screening consent. You cannot join this screening
            without providing the required consent.
          </p>
          <p className="mt-3 text-xs text-gray-400">
            Your choice is recorded and this invitation has not been used.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
      <Card className="w-full p-6">
        <h1 className="text-xl font-semibold text-gray-900">Candidate voice screening</h1>
        <p className="mt-2 text-sm text-gray-600">
          Your one-time invite grants access only to this screening room.
        </p>

        {phase === 'loading' && (
          <p className="mt-4 text-sm text-gray-500" role="status">
            Checking your invitation…
          </p>
        )}

        {phase === 'error' && (
          <p className="mt-4 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {phase === 'need-consent' && template && (
          <section aria-label="Screening consent" className="mt-5">
            <h2 className="text-sm font-semibold text-gray-900">{template.title}</h2>
            <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm leading-relaxed text-gray-700">
              {/* Plain text only — the template is never executed as HTML. */}
              <p className="whitespace-pre-wrap">{plainText(template.body_md)}</p>
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-gray-700">
                Required consent (must accept all to continue)
              </legend>
              <div className="mt-2 space-y-3">
                {template.required_consents.map((type) => (
                  <label
                    key={type}
                    className="flex items-start gap-3 text-sm text-gray-700"
                  >
                    <input
                      type="checkbox"
                      checked={checked[type] === true}
                      onChange={(e) =>
                        setChecked((prev) => ({ ...prev, [type]: e.target.checked }))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-accent-600 focus:ring-accent-500"
                    />
                    <span>{type.replace(/_/g, ' ')}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <Button
                onClick={grantConsent}
                disabled={!allRequiredChecked(template)}
                className="flex-1"
              >
                Accept and continue
              </Button>
              <Button variant="secondary" onClick={declineConsent} className="flex-1">
                Decline
              </Button>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              You can review the{' '}
              <Link to="/privacy-notice" className="font-medium text-accent-600 hover:underline">
                privacy notice
              </Link>{' '}
              at any time.
            </p>
          </section>
        )}

        {phase === 'granted' && (
          <>
            {status === 'live' ? (
              <>
                <section
                  aria-label="Live transcript"
                  aria-live="polite"
                  className="mt-5 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-gray-900">Live transcript</h2>
                    <span className="text-xs text-gray-500">Final text is saved after each turn</span>
                  </div>
                  {liveTranscript.length === 0 ? (
                    <p className="text-sm text-gray-500">Waiting for the conversation to start…</p>
                  ) : (
                    <ol className="space-y-3">
                      {liveTranscript.map((segment) => (
                        <li
                          key={segment.id}
                          className={segment.speaker === 'candidate' ? 'text-right' : 'text-left'}
                        >
                          <span className="block text-xs font-medium text-gray-500">
                            {segment.speaker === 'candidate' ? 'You' : 'Christy'}
                          </span>
                          <span
                            className={`mt-1 inline-block max-w-[90%] rounded-xl px-3 py-2 text-sm ${
                              segment.speaker === 'candidate'
                                ? 'bg-accent-600 text-white'
                                : 'bg-white text-gray-800 ring-1 ring-gray-200'
                            } ${segment.final ? '' : 'italic opacity-70'}`}
                          >
                            {segment.text}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                <Button className="mt-5" onClick={leave}>Leave screening</Button>
              </>
            ) : status === 'ended' ? (
              <p className="mt-5 text-sm font-medium text-gray-700">The screening has ended.</p>
            ) : capabilityStatus === 'checking' ? (
              null
            ) : capabilityStatus === 'unsupported' ? (
              <div role="alert" className="mt-5 rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-800">
                  Your browser does not support the microphone and WebRTC features this
                  screening requires. Please use a current version of a supported browser.
                </p>
              </div>
            ) : (
              <Button className="mt-5" onClick={join} loading={status === 'joining'}>
                Join screening
              </Button>
            )}
          </>
        )}

        {error && phase !== 'error' && (
          <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>
        )}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      </Card>
    </main>
  );
}
