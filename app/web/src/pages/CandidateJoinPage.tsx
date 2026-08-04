import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { createLocalAudioTrack, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
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
  const inviteRef = useRef<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
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
      localTrackRef.current?.stop();
      roomRef.current?.disconnect();
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

      joinStep = 'connect';
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && remoteAudioRef.current) {
          track.attach(remoteAudioRef.current);
        }
      });
      room.on(RoomEvent.Disconnected, () => setStatus('ended'));
      await room.connect(access.url, access.livekit_token);
      await room.localParticipant.publishTrack(localTrack);
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
      setError(err instanceof ApiError ? err.message : 'Unable to join this screening.');
    }
  }

  function leave() {
    localTrackRef.current?.stop();
    localTrackRef.current = null;
    roomRef.current?.disconnect();
    roomRef.current = null;
    setStatus('ended');
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
              <Button className="mt-5" onClick={leave}>Leave screening</Button>
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
