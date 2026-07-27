import { useEffect, useRef, useState } from "react";
import {
  createLocalAudioTrack,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { api, ApiError } from "../api";
import { Button, Card } from "./ui";

export function LiveKitCallCard({
  candidateId,
  candidateName,
}: {
  candidateId: string;
  candidateName?: string | null;
}) {
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "ending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localAudioRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mixerRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const mixerSourcesRef = useRef<MediaStreamAudioSourceNode[]>([]);
  const mixedTrackIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      void disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setError(null);
    setStatus("connecting");
    try {
      const live = await api.startLiveKitScreening(candidateId);
      setSessionId(live.session_id);
      setRoomName(live.room_name);

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      const mixer = await createRecordingMixer();

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio || !remoteAudioRef.current) return;
        track.attach(remoteAudioRef.current);
        connectTrackToMixer(track.mediaStreamTrack);
      });
      room.on(RoomEvent.Disconnected, () => {
        void finishRecording();
        setStatus("idle");
      });

      await room.connect(live.url, live.token);
      const localTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      localAudioRef.current = localTrack;
      connectTrackToMixer(localTrack.mediaStreamTrack);
      await room.localParticipant.publishTrack(localTrack);
      startRecording(mixer.stream, live.session_id);
      setStatus("live");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start LiveKit call.");
      setStatus("idle");
      await disconnect();
    }
  }

  async function disconnect() {
    setStatus((current) => (current === "live" ? "ending" : current));
    localAudioRef.current?.stop();
    localAudioRef.current = null;
    roomRef.current?.disconnect();
    roomRef.current = null;
    await finishRecording();
    setStatus("idle");
  }

  async function createRecordingMixer() {
    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("This browser does not support call recording.");
    }
    const audioContext = new AudioContextClass();
    await audioContext.resume();
    const mixer = audioContext.createMediaStreamDestination();
    audioContextRef.current = audioContext;
    mixerRef.current = mixer;
    mixerSourcesRef.current = [];
    mixedTrackIdsRef.current = new Set();
    return mixer;
  }

  function connectTrackToMixer(track?: MediaStreamTrack | null) {
    const audioContext = audioContextRef.current;
    const mixer = mixerRef.current;
    if (!track || !audioContext || !mixer || mixedTrackIdsRef.current.has(track.id)) {
      return;
    }
    const stream = new MediaStream([track]);
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(mixer);
    mixerSourcesRef.current.push(source);
    mixedTrackIdsRef.current.add(track.id);
  }

  function startRecording(stream: MediaStream, activeSessionId: string) {
    if (typeof MediaRecorder === "undefined" || stream.getAudioTracks().length === 0) return;
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const chunks = chunksRef.current;
      chunksRef.current = [];
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      void api.uploadLiveKitRecording(activeSessionId, blob).catch(() => {
        // Recording upload is helpful for demo playback, but transcript/scoring remain primary.
      });
    };
    recorder.start(1000);
    recorderRef.current = recorder;
  }

  async function finishRecording() {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    mixerSourcesRef.current.forEach((source) => source.disconnect());
    mixerSourcesRef.current = [];
    mixedTrackIdsRef.current.clear();
    mixerRef.current?.stream.getTracks().forEach((track) => track.stop());
    mixerRef.current = null;
    await audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  const isBusy = status === "connecting" || status === "ending";
  const isLive = status === "live";

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">LiveKit voice screening</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Starts a LiveKit room for {candidateName || "this candidate"} and joins from this browser.
          </p>
          {roomName && (
            <p className="mt-1 text-[11px] text-gray-400">
              {roomName}
              {sessionId ? ` · ${sessionId.slice(0, 8)}` : ""}
            </p>
          )}
        </div>
        {isLive ? (
          <Button onClick={disconnect} className="shrink-0">
            End Call
          </Button>
        ) : (
          <Button onClick={start} loading={isBusy} className="shrink-0">
            Start Screening
          </Button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {isLive && (
        <p className="mt-3 text-xs font-medium text-red-700">
          Live. Keep this tab open until the call ends.
        </p>
      )}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
    </Card>
  );
}
