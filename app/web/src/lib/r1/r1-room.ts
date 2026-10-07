/**
 * The live R1 room: connect, publish, follow the interviewer, leave.
 *
 * This is a plain controller, not a hook, so the trust and teardown rules can
 * be tested without rendering. The page owns one controller per attempt.
 *
 * Invariants:
 *   - Only the interviewer agent drives the page: speaker level, captions and
 *     the `phase` attribute are all read from a participant whose kind is
 *     AGENT (see r1-agent.ts). Anyone else in the room is ignored.
 *   - `phase=ended` from the agent makes the page leave the room itself. The
 *     worker sets that attribute immediately before it deletes the room, so
 *     the candidate sees a clean end instead of a dropped connection.
 *   - Ending is exactly-once. A manual leave, an agent end and an unexpected
 *     disconnect race each other; whichever arrives first reports its reason
 *     and every later signal is dropped.
 *   - The reason says what the candidate should be told. `aborted` is a
 *     technical stop on our side (the last phase the agent announced was
 *     `aborted`, whether or not the `ended` attribute followed); a room that
 *     was DELETED after the agent had reached `closing` or `finishing` is a
 *     finished interview whose `ended` attribute simply never arrived; every
 *     other unplanned loss is `disconnected`.
 *   - Whether the interviewer is in the room is reported separately from the
 *     phase, by counting AGENT-kind participants. The phase is a worker
 *     publication and can be missing; presence cannot be spoofed and lets the
 *     page say "interview in progress" instead of "waiting for your interviewer".
 *   - There is NO completion call and no recorder here. The R1 worker owns the
 *     recording and the terminal write; the browser only leaves the room.
 */

import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalVideoTrack,
  type Participant,
  type TranscriptionSegment,
} from 'livekit-client';
import { isAgentParticipant, trustedPhase } from './r1-agent';
import { publishR1Media, R1_ROOM_OPTIONS, stopR1Media, type R1LocalMedia } from './r1-media';
import { R1_PHASE_ATTRIBUTE, type CaptionSegment, type R1Phase } from './r1-phase';

export type R1EndReason = 'agent_ended' | 'aborted' | 'left' | 'disconnected';

export interface R1RoomHandlers {
  onPhase: (phase: R1Phase) => void;
  /** Whether at least one AGENT-kind participant is in the room (reported on change). */
  onAgentPresent: (present: boolean) => void;
  onAgentLevel: (level: number) => void;
  /** Captions from the agent, with the phase that was current when they arrived. */
  onCaptions: (segments: CaptionSegment[], phase: R1Phase | null) => void;
  onCameraOn: (on: boolean) => void;
  onEnded: (reason: R1EndReason) => void;
}

export interface R1RoomController {
  connect: (url: string, token: string, media: R1LocalMedia) => Promise<void>;
  setMicMuted: (muted: boolean) => Promise<boolean>;
  setCameraOn: (on: boolean) => Promise<boolean>;
  leave: () => Promise<void>;
  /** Tear down silently (page unmount); reports nothing. */
  dispose: () => void;
}

function clampLevel(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function cameraIsLive(video: LocalVideoTrack): boolean {
  return !video.isMuted && video.mediaStreamTrack?.readyState !== 'ended';
}

/** The participant fields presence tracking reads; `identity` keeps a rejoining agent single. */
interface PresenceSource {
  kind: unknown;
  identity?: string;
}

export function createR1Room(
  handlers: R1RoomHandlers,
  getAudioElement: () => HTMLAudioElement | null,
): R1RoomController {
  let room: Room | null = null;
  let media: R1LocalMedia | null = null;
  let finished = false;
  let currentPhase: R1Phase | null = null;
  const agents = new Set<unknown>();

  /** Claim the single ending. Everything that ends the interview goes through this first. */
  function claimEnd(): boolean {
    if (finished) return false;
    finished = true;
    return true;
  }

  function finish(reason: R1EndReason): void {
    if (claimEnd()) handlers.onEnded(reason);
  }

  /** Count a participant in or out; only AGENT-kind participants are ever counted. */
  function trackAgent(participant: PresenceSource, present: boolean): void {
    if (!isAgentParticipant(participant)) return;
    const before = agents.size > 0;
    const key = participant.identity ?? participant;
    if (present) agents.add(key);
    else agents.delete(key);
    const after = agents.size > 0;
    if (before !== after && !finished) handlers.onAgentPresent(after);
  }

  function applyPhase(phase: R1Phase | null): void {
    if (phase === null || finished) return;
    const previous = currentPhase;
    currentPhase = phase;
    handlers.onPhase(phase);
    if (phase !== 'ended') return;
    // Claim the ending BEFORE leaving: a room reports its own Disconnected event,
    // and it can do so synchronously inside disconnect(). If that event got in
    // first it would be read as a dropped connection instead of a clean end.
    if (!claimEnd()) return;
    void room?.disconnect();
    stopR1Media(media);
    // The worker speaks its apology and then sets `ended` after `aborted`: that is a
    // stop on our side, not a finished interview.
    handlers.onEnded(previous === 'aborted' ? 'aborted' : 'agent_ended');
  }

  function syncAgentPhase(target: Room): void {
    for (const participant of target.remoteParticipants.values()) {
      trackAgent(participant, true);
      applyPhase(trustedPhase(participant));
    }
  }

  /** Why the room went away with no `ended` attribute and no click of Leave. */
  function reasonForDisconnect(cause: DisconnectReason | undefined): R1EndReason {
    if (currentPhase === 'aborted') return 'aborted';
    const wrappingUp = currentPhase === 'closing' || currentPhase === 'finishing';
    return wrappingUp && cause === DisconnectReason.ROOM_DELETED ? 'agent_ended' : 'disconnected';
  }

  function wire(target: Room): void {
    target.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      const element = getAudioElement();
      if (track.kind === Track.Kind.Audio && isAgentParticipant(participant) && element) {
        track.attach(element);
      }
    });
    target.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const agent = speakers.find((speaker) => isAgentParticipant(speaker));
      handlers.onAgentLevel(agent ? clampLevel(agent.audioLevel) : 0);
    });
    target.on(
      RoomEvent.TranscriptionReceived,
      (segments: TranscriptionSegment[], participant?: Participant) => {
        if (!isAgentParticipant(participant)) return;
        const lines = segments.map(({ id, text, final }) => ({ id, text, final }));
        handlers.onCaptions(lines, currentPhase);
      },
    );
    target.on(RoomEvent.ParticipantConnected, (participant) => {
      trackAgent(participant, true);
      applyPhase(trustedPhase(participant));
    });
    target.on(RoomEvent.ParticipantDisconnected, (participant) => {
      trackAgent(participant, false);
    });
    target.on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, participant: Participant) => {
        if (!(R1_PHASE_ATTRIBUTE in changed)) return;
        applyPhase(trustedPhase(participant));
      },
    );
    target.on(RoomEvent.Disconnected, (cause?: DisconnectReason) => {
      finish(reasonForDisconnect(cause));
    });
  }

  return {
    async connect(url, token, localMedia) {
      media = localMedia;
      const next = new Room(R1_ROOM_OPTIONS);
      room = next;
      wire(next);
      const video = localMedia.video;
      const reportCamera = (): void => handlers.onCameraOn(cameraIsLive(video));
      video.on(TrackEvent.Muted, reportCamera);
      video.on(TrackEvent.Unmuted, reportCamera);
      video.on(TrackEvent.Ended, reportCamera);
      await next.connect(url, token);
      await publishR1Media(next, localMedia);
      syncAgentPhase(next);
      reportCamera();
    },

    async setMicMuted(muted) {
      const audio = media?.audio;
      if (!audio) return muted;
      if (muted) await audio.mute();
      else await audio.unmute();
      return audio.isMuted;
    },

    async setCameraOn(on) {
      const video = media?.video;
      if (!video) return on;
      if (on) await video.unmute();
      else await video.mute();
      return cameraIsLive(video);
    },

    async leave() {
      const active = room;
      if (!claimEnd()) return;
      await active?.disconnect();
      stopR1Media(media);
      handlers.onEnded('left');
    },

    dispose() {
      finished = true;
      room?.removeAllListeners();
      void room?.disconnect();
      stopR1Media(media);
      room = null;
    },
  };
}
