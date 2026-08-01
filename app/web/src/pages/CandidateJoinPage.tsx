import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { createLocalAudioTrack, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import { api, ApiError } from '../api';
import { Button, Card } from '../components/ui';
import { useCapabilitySupport } from '../lib/capability-check';

/** Public candidate flow. The invite fragment is consumed once and removed immediately. */
export function CandidateJoinPage() {
  const [status, setStatus] = useState<'ready' | 'joining' | 'live' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const inviteRef = useRef<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [searchParams] = useSearchParams();
  const capabilityStatus = useCapabilitySupport();
  // GOV-03/GOV-09: Consent status derived from URL query param
  const consentParam = searchParams.get('consent');
  const consentStatus: 'unknown' | 'granted' | 'declined' =
    consentParam === 'true' ? 'granted' : consentParam === 'declined' ? 'declined' : 'unknown';

  useEffect(() => {
    const raw = window.location.hash.slice(1);
    inviteRef.current = raw ? decodeURIComponent(raw) : null;
    if (raw) window.history.replaceState(null, '', '/candidate/join');

    return () => {
      localTrackRef.current?.stop();
      roomRef.current?.disconnect();
    };
  }, []);

  async function join() {
    const invite = inviteRef.current;
    inviteRef.current = null;
    if (!invite) {
      setError('This invite is missing, expired, revoked, or already used.');
      return;
    }

    // GOV-09: Join fails without consent evidence
    if (consentStatus !== 'granted') {
      setError('You must accept the privacy notice before joining the screening.');
      return;
    }

    setStatus('joining');
    setError(null);
    try {
      const access = await api.exchangeCandidateInvite(invite);
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && remoteAudioRef.current) {
          track.attach(remoteAudioRef.current);
        }
      });
      room.on(RoomEvent.Disconnected, () => setStatus('ended'));
      await room.connect(access.url, access.livekit_token);
      const localTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      localTrackRef.current = localTrack;
      await room.localParticipant.publishTrack(localTrack);
      setStatus('live');
    } catch (err) {
      setStatus('ready');
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

  // GOV-09: Show declined message
  if (consentStatus === 'declined') {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
        <Card className="w-full p-6">
          <h1 className="text-xl font-semibold text-gray-900">Consent declined</h1>
          <p className="mt-2 text-sm text-gray-600">
            You declined the privacy notice. You cannot join this screening without
            providing consent for the AI interview and recording.
          </p>
          <Link
            to="/privacy-notice"
            className="mt-5 inline-block text-sm font-medium text-blue-600 hover:underline"
          >
            Review privacy notice again
          </Link>
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

        {/* GOV-03/GOV-09: Consent banner */}
        {consentStatus === 'unknown' && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-800">
              You must review and accept the{' '}
              <Link to="/privacy-notice" className="font-medium underline">
                privacy notice
              </Link>{' '}
              before joining the screening.
            </p>
          </div>
        )}

        {/* GOV-09: Join only when consent is granted */}
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
        ) : consentStatus === 'granted' ? (
          <Button className="mt-5" onClick={join} loading={status === 'joining'}>
            Join screening
          </Button>
        ) : (
          <Link
            to="/privacy-notice"
            className="mt-5 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Review privacy notice
          </Link>
        )}

        {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      </Card>
    </main>
  );
}
