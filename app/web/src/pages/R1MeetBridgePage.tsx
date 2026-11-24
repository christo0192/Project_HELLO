import { useEffect, useRef, useState } from 'react';
import type { LocalAudioTrack } from 'livekit-client';
import { R1MeetTile, type MeetStage } from '../components/candidate-r1/R1MeetTile';
import { R1Shell } from '../components/candidate-r1/R1Screens';
import { checkCapabilitySupport } from '../lib/capability-check';
import { r1Api } from '../lib/r1/r1-api';
import { anchorClock, retimeClock, type R1Clock } from '../lib/r1/r1-clock';
import { captureMeetTicket } from '../lib/r1/r1-link';
import { runMeetExchange } from '../lib/r1/r1-meet';
import {
  captureMeetAudio,
  createR1MeetRoom,
  type R1MeetEndReason,
  type R1MeetRoomController,
  type R1MeetRoomHandlers,
} from '../lib/r1/r1-meet-room';
import { isLeadCardVisible, type R1Phase } from '../lib/r1/r1-phase';

/**
 * The Meet bridge page, `/candidate/r1/meet#t=<ticket>` (M034 S07; contract sections 4 and 9,
 * decisions D-S07-7 and D-S07-10 to D-S07-16).
 *
 * The Recall bot's Output Media loads this page in a headless Chrome: its microphone is the
 * mixed meeting audio (without the bot's own voice) and the page is the bot's camera tile. The
 * page joins the R1 room as the candidate participant, so the interviewer hears the meeting and
 * the meeting hears the interviewer.
 *
 * Invariants:
 *   - The ticket is read from the URL fragment and the fragment is stripped at once, before the
 *     ticket is even validated. It lives in a ref only: never state, storage, a URL or a log.
 *   - No ticket (or a malformed one) means no API call and no media request at all: the tile
 *     idles.
 *   - Capture before exchange (D-S07-7): the browser check and the meeting-audio capture come
 *     first, so a browser or audio failure spends no ticket and boots no worker.
 *   - The only API call is `r1Api.meetExchange`, sent through the bounded runner of r1-meet.ts
 *     (at most ten calls, never less than 3 s apart; a short-lived refusal answered before the
 *     ticket is claimed is asked again inside that bound, every other one is terminal and quiet). Under
 *     StrictMode's double effect it still starts exactly once: a second exchange would be
 *     refused as already claimed.
 *   - The server's Meet switch off (503 `meet_disabled`) idles the tile; every other failure
 *     shows the one "cannot join" tile. Each stops the meeting audio.
 *   - Audio only: the one published track is the meeting audio (r1-meet-room.ts); nothing is
 *     published on the data channel and no camera is ever asked for.
 *   - After a room token the ticket is never presented again: a lost room is a terminal tile
 *     (livekit-client's own reconnect handles blips; recovery is a new ticket from the server).
 *   - The tile never shows the candidate's name (there is no source for it) and the page loads
 *     no third-party script, font, image or stylesheet. Every request already carries no
 *     referrer; the page also declares a no-referrer policy while it is mounted.
 */

export function R1MeetBridgePage() {
  const [stage, setStage] = useState<MeetStage>({ name: 'connecting', preparing: false });
  // What the interviewer publishes beside the phase (all optional; see r1-agent.ts).
  const [phase, setPhase] = useState<R1Phase | null>(null);
  const [agentPresent, setAgentPresent] = useState(false);
  const [leadName, setLeadName] = useState<string | null>(null);
  const [roleplayClock, setRoleplayClock] = useState<R1Clock | null>(null);
  const [lastActive, setLastActive] = useState<R1Phase | null>(null);

  const ticketRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  /** The exchange has been started for this page: StrictMode's second effect run must not repeat it. */
  const startedRef = useRef(false);
  const endedRef = useRef(false);
  const controllerRef = useRef<R1MeetRoomController | null>(null);
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  /** The phase last reported, so the role-play clock can tell when the role-play starts or stops. */
  const phaseRef = useRef<R1Phase | null>(null);

  // Ticket capture. The fragment is stripped at once, whatever it held. Safe under StrictMode's
  // double effect: the second capture finds the fragment already stripped and must not
  // overwrite the ticket the first one kept.
  useEffect(() => {
    const captured = captureMeetTicket();
    if (captured) ticketRef.current = captured;
    if (!ticketRef.current) setStage({ name: 'idle', reason: 'no_ticket' });
  }, []);

  // The bridge is a chain of awaits. Once the page is gone nothing further may connect a room
  // or publish a track, so every step checks `mountedRef` before it acts.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      audioTrackRef.current?.stop();
      audioTrackRef.current = null;
    };
  }, []);

  // One start per page. StrictMode runs this effect twice on the same refs, and the chain the
  // first run starts outlives the cleanup between the two (it re-checks `mountedRef` after every
  // await), so the second run only has to do nothing. Everything the chain needs is a ref or a
  // state setter, so it lives inside the effect and the effect has no dependencies.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const ticket = ticketRef.current;
    if (!ticket) return;

    const stopAudio = (): void => {
      audioTrackRef.current?.stop();
      audioTrackRef.current = null;
    };

    const endInterview = (reason: R1MeetEndReason): void => {
      endedRef.current = true;
      stopAudio();
      controllerRef.current = null;
      setStage({ name: 'ended', reason });
    };

    const handlers: R1MeetRoomHandlers = {
      onPhase: (next) => {
        // The role-play clock freezes when the role-play stops and restarts when it starts.
        const previous = phaseRef.current;
        phaseRef.current = next;
        const now = performance.now();
        setRoleplayClock((clock) => retimeClock(clock, previous, next, now));
        setPhase(next);
        if (next !== 'paused_disconnected' && next !== 'ended') setLastActive(next);
      },
      onLeadName: setLeadName,
      onRoleplayLeft: (seconds) => {
        const now = performance.now();
        setRoleplayClock(seconds === null ? null : anchorClock(seconds, now));
      },
      onAgentPresent: setAgentPresent,
      onEnded: endInterview,
    };

    const start = async (): Promise<void> => {
      // An unsupported browser sends the ticket nowhere and asks for no audio.
      if (!checkCapabilitySupport().supported) {
        setStage({ name: 'unavailable', reason: 'unsupported' });
        return;
      }
      let audio: LocalAudioTrack;
      try {
        audio = await captureMeetAudio();
      } catch {
        if (mountedRef.current) setStage({ name: 'unavailable', reason: 'no_audio' });
        return;
      }
      if (!mountedRef.current) {
        audio.stop();
        return;
      }
      audioTrackRef.current = audio;
      const outcome = await runMeetExchange({
        ticket,
        exchange: (value, resumeToken) => r1Api.meetExchange(value, resumeToken),
        sleep: (ms) => new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms);
        }),
        now: () => performance.now(),
        isCancelled: () => !mountedRef.current,
        onPreparing: () => {
          if (mountedRef.current) setStage({ name: 'connecting', preparing: true });
        },
      });
      if (!mountedRef.current || outcome.kind === 'cancelled') {
        stopAudio();
        return;
      }
      if (outcome.kind === 'disabled') {
        stopAudio();
        setStage({ name: 'idle', reason: 'disabled' });
        return;
      }
      if (outcome.kind === 'failed') {
        stopAudio();
        setStage({ name: 'unavailable', reason: outcome.reason });
        return;
      }
      const controller = createR1MeetRoom(handlers, () => audioElementRef.current);
      controllerRef.current = controller;
      try {
        await controller.connect(outcome.grant.url, outcome.grant.livekit_token, audio);
      } catch {
        // Gone, or the room already ended while connecting: that tile (or none) stands.
        if (!mountedRef.current || endedRef.current) return;
        controller.dispose();
        controllerRef.current = null;
        stopAudio();
        setStage({ name: 'unavailable', reason: 'connect_failed' });
        return;
      }
      // The room may have ended while connecting: never replace an ending with the live tile.
      if (!mountedRef.current || endedRef.current) return;
      setStage({ name: 'live' });
    };

    void start();
  }, []);

  return (
    <R1Shell>
      <meta name="referrer" content="no-referrer" />
      <R1MeetTile
        stage={stage}
        phase={phase}
        agentPresent={agentPresent}
        leadName={leadName}
        leadVisible={isLeadCardVisible(phase, lastActive)}
        roleplayClock={roleplayClock}
      />
      <audio ref={audioElementRef} autoPlay playsInline className="hidden" />
    </R1Shell>
  );
}
