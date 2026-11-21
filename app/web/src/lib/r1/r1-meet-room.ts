/**
 * The Meet bridge's live room: the meeting's audio in, the interviewer's voice out (M034 S07,
 * decisions D-S07-6, D-S07-8, D-S07-9, D-S07-14 and D-S07-16).
 *
 * The bridge page runs inside the Recall bot's Output Media: a headless Chrome whose microphone
 * is the mixed meeting audio (without the bot's own voice) and whose page is the bot's camera
 * tile. This controller joins that page to the R1 room as the candidate participant. It is a
 * plain controller, not a hook, so the trust and teardown rules can be tested without rendering.
 * The page owns one controller per ticket.
 *
 * Invariants:
 *   - Audio only. The one published track is the meeting audio, as the MICROPHONE source with
 *     DTX off (the token grants the microphone only, and a quiet stretch must still stream
 *     packets). No camera track is created, only the interviewer's AUDIO is ever attached, and
 *     nothing is published on the data channel.
 *   - Only the interviewer agent drives the tile: its audio, and the attributes it publishes
 *     (`phase`, `leadname`, `rpleft`), are read from a participant whose kind is AGENT (see
 *     r1-agent.ts). Anyone else in the room is ignored. The `awaiting` flag is not read: the
 *     tile has no button, so the spoken "ready" is the only path.
 *   - Every attribute is optional. A worker that publishes only some of them (or none) leaves
 *     the others unreported, and the tile shows nothing for them rather than a guess.
 *   - `phase=ended` from the agent makes the bridge leave the room itself, so the worker's
 *     room deletion reads as a clean end instead of a dropped connection.
 *   - Ending is exactly-once. An agent end and an unexpected disconnect race each other;
 *     whichever arrives first reports its reason and every later signal is dropped.
 *   - The reason says what the tile should show. `aborted` is a technical stop on our side (the
 *     last phase the agent announced was `aborted`, whether or not `ended` followed); a room
 *     that was DELETED after the agent had reached `closing` or `finishing` is a finished
 *     interview whose `ended` attribute never arrived; every other loss is `disconnected`.
 *   - Whether the interviewer is in the room is reported separately from the phase, by counting
 *     AGENT-kind identities (a rejoining agent stays one).
 *   - There is NO mute, NO leave, NO data method and NO video here: nobody presses anything on
 *     the tile. The bridge leaves only on the agent's word, a lost room, or the page going away
 *     (`dispose`, which reports nothing). A full disconnect is terminal: there is no client
 *     rejoin (livekit-client's own reconnect handles blips).
 *   - There is NO completion call and no recorder. The R1 worker owns the recording and the
 *     terminal write; the bridge only leaves the room.
 *
 * The ending rules are REPLICATED from r1-room.ts, not shared with it: the live browser
 * controller stays untouched by the Meet work, and r1-meet-room.test.ts runs the same ending
 * scenarios to keep the two in step. Do not edit r1-room.ts for the bridge.
 */

import {
  createLocalAudioTrack,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type Participant,
  type TrackPublishOptions,
} from 'livekit-client';
import {
  isAgentParticipant,
  R1_AGENT_ATTRIBUTES,
  R1_LEAD_NAME_ATTRIBUTE,
  R1_ROLEPLAY_LEFT_ATTRIBUTE,
  trustedSignals,
  type PhaseSource,
} from './r1-agent';
import { R1_ROOM_OPTIONS } from './r1-media';
import { R1_PHASE_ATTRIBUTE, type R1Phase } from './r1-phase';

/**
 * How the meeting audio is captured (D-S07-8). Echo cancellation stays ON as insurance against
 * the interviewer hearing himself (Recall documents that the mix excludes the bot's audio, but
 * R1 lets the candidate barge in from the first word). Noise suppression and gain control are
 * OFF: Meet already processed the mix, and a second pass can clip words before speech-to-text.
 */
export const R1_MEET_AUDIO_CAPTURE_OPTIONS: AudioCaptureOptions = Object.freeze({
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
});

/**
 * How the meeting audio is published (D-S07-9): as the microphone (the only source the token
 * grants), with Opus DTX off so a quiet stretch of the meeting still streams packets.
 */
export const R1_MEET_AUDIO_PUBLISH_OPTIONS: TrackPublishOptions = Object.freeze({
  source: Track.Source.Microphone,
  dtx: false,
});

/** Capture the meeting audio the bot's Chrome exposes as its microphone. */
export function captureMeetAudio(): Promise<LocalAudioTrack> {
  return createLocalAudioTrack(R1_MEET_AUDIO_CAPTURE_OPTIONS);
}

export type R1MeetEndReason = 'agent_ended' | 'aborted' | 'disconnected';

/** Same meaning and call order as the browser room's handlers, minus what the tile never shows. */
export interface R1MeetRoomHandlers {
  onPhase: (phase: R1Phase) => void;
  /** The learner's display name, or null when the interviewer has none (yet, or any more). */
  onLeadName: (name: string | null) => void;
  /**
   * Seconds of role-play budget left, as of this call, or null once the interviewer stops
   * publishing it. Called AFTER `onPhase` when both arrive together, so the page can freeze
   * its local count for the old phase before it takes the new number.
   */
  onRoleplayLeft: (seconds: number | null) => void;
  /** Whether at least one AGENT-kind participant is in the room (reported on change). */
  onAgentPresent: (present: boolean) => void;
  onEnded: (reason: R1MeetEndReason) => void;
}

export interface R1MeetRoomController {
  /** Join the room, publish the meeting audio and start following the interviewer. */
  connect: (url: string, token: string, audio: LocalAudioTrack) => Promise<void>;
  /** Tear down silently (page unmount); reports nothing. */
  dispose: () => void;
}

/** The participant fields presence tracking reads; `identity` keeps a rejoining agent single. */
interface PresenceSource {
  kind: unknown;
  identity?: string;
}

export function createR1MeetRoom(
  handlers: R1MeetRoomHandlers,
  getAudioElement: () => HTMLAudioElement | null,
): R1MeetRoomController {
  let room: Room | null = null;
  let audio: LocalAudioTrack | null = null;
  let finished = false;
  let currentPhase: R1Phase | null = null;
  const agents = new Set<unknown>();

  /** Claim the single ending. Everything that ends the interview goes through this first. */
  function claimEnd(): boolean {
    if (finished) return false;
    finished = true;
    return true;
  }

  function finish(reason: R1MeetEndReason): void {
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
    audio?.stop();
    // The worker speaks its apology and then sets `ended` after `aborted`: that is a
    // stop on our side, not a finished interview.
    handlers.onEnded(previous === 'aborted' ? 'aborted' : 'agent_ended');
  }

  /**
   * Report what an agent participant publishes. `changed` names the attributes that moved (an
   * attributes event); without it every attribute is reported (the agent just appeared, or the
   * bridge just connected), absent ones as null. Reporting only what moved matters for the clock:
   * re-reporting an unchanged `rpleft` later would restart the local count from a stale number.
   */
  function applySignals(
    participant: PhaseSource | null | undefined,
    changed?: Readonly<Record<string, string>>,
  ): void {
    const signals = trustedSignals(participant);
    if (!signals || finished) return;
    const moved = (key: string): boolean => changed === undefined || key in changed;
    if (moved(R1_PHASE_ATTRIBUTE)) applyPhase(signals.phase);
    // `phase=ended` leaves the room: nothing after it is news.
    if (finished) return;
    if (moved(R1_LEAD_NAME_ATTRIBUTE)) handlers.onLeadName(signals.leadName);
    if (moved(R1_ROLEPLAY_LEFT_ATTRIBUTE)) handlers.onRoleplayLeft(signals.rpleft);
  }

  function syncAgents(target: Room): void {
    for (const participant of target.remoteParticipants.values()) {
      trackAgent(participant, true);
      applySignals(participant);
    }
  }

  /** Why the room went away with no `ended` attribute. */
  function reasonForDisconnect(cause: DisconnectReason | undefined): R1MeetEndReason {
    if (currentPhase === 'aborted') return 'aborted';
    const wrappingUp = currentPhase === 'closing' || currentPhase === 'finishing';
    return wrappingUp && cause === DisconnectReason.ROOM_DELETED ? 'agent_ended' : 'disconnected';
  }

  /** Ask the browser to play remote audio. Best effort: Recall's Chrome needs no gesture. */
  function startPlayback(target: Room): void {
    if (typeof target.startAudio !== 'function') return;
    try {
      void Promise.resolve(target.startAudio()).catch(() => undefined);
    } catch {
      // A synchronous failure is as harmless as a rejected one: the attached element plays.
    }
  }

  function wire(target: Room): void {
    target.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      const element = getAudioElement();
      if (track.kind === Track.Kind.Audio && isAgentParticipant(participant) && element) {
        track.attach(element);
      }
    });
    target.on(RoomEvent.ParticipantConnected, (participant) => {
      trackAgent(participant, true);
      applySignals(participant);
    });
    target.on(RoomEvent.ParticipantDisconnected, (participant) => {
      trackAgent(participant, false);
    });
    target.on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, participant: Participant) => {
        if (!R1_AGENT_ATTRIBUTES.some((key) => key in changed)) return;
        applySignals(participant, changed);
      },
    );
    target.on(RoomEvent.Disconnected, (cause?: DisconnectReason) => {
      finish(reasonForDisconnect(cause));
    });
  }

  return {
    async connect(url, token, meetingAudio) {
      audio = meetingAudio;
      const next = new Room(R1_ROOM_OPTIONS);
      room = next;
      wire(next);
      await next.connect(url, token);
      // Ended or disposed while connecting: publish nothing into a room that is going away.
      if (finished) return;
      await next.localParticipant.publishTrack(meetingAudio, R1_MEET_AUDIO_PUBLISH_OPTIONS);
      if (finished) return;
      startPlayback(next);
      syncAgents(next);
    },

    dispose() {
      finished = true;
      room?.removeAllListeners();
      void room?.disconnect();
      audio?.stop();
      room = null;
    },
  };
}
