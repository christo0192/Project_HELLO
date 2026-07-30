import { useEffect, useRef, useState } from 'react';
import { createLocalAudioTrack, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import { api, ApiError } from '../api';
import { Button, Card } from '../components/ui';

/** Public candidate flow. The invite fragment is consumed once and removed immediately. */
export function CandidateJoinPage() {
  const [status, setStatus] = useState<'ready' | 'joining' | 'live' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const inviteRef = useRef<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

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

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
      <Card className="w-full p-6">
        <h1 className="text-xl font-semibold text-gray-900">Candidate voice screening</h1>
        <p className="mt-2 text-sm text-gray-600">
          Your one-time invite grants access only to this screening room.
        </p>
        {status === 'live' ? (
          <Button className="mt-5" onClick={leave}>Leave screening</Button>
        ) : status === 'ended' ? (
          <p className="mt-5 text-sm font-medium text-gray-700">The screening has ended.</p>
        ) : (
          <Button className="mt-5" onClick={join} loading={status === 'joining'}>
            Join screening
          </Button>
        )}
        {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      </Card>
    </main>
  );
}
