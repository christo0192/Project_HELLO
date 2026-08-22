/**
 * livekit-phone-dial/phone-room.ts — the phone room, which is a SIBLING of the
 * browser room and deliberately not the same thing.
 *
 * ── WHAT IT SHARES, AND WHAT IT MUST NOT ──────────────────────────────
 * It shares `requireLiveKitConfigured` with `room-provisioning.ts` — the
 * configuration check is the same check. It shares NOTHING else, and one
 * omission is the whole point of the file:
 *
 *   **A PHONE ROOM NEVER STARTS AN EGRESS.**
 *
 * `provisionRoomForCreatedSession` starts the authoritative recording BEFORE
 * it publishes the room as joinable, because a browser candidate consented on
 * a web page before the room ever existed. A phone candidate has consented to
 * nothing at the moment the room is created: the line has not rung, nobody has
 * answered, and no disclosure has been delivered. Starting an egress here
 * would record a person who has not yet been told they are being recorded, on
 * a call they have not yet accepted — which is the single failure this entire
 * phase is shaped to make impossible.
 *
 * So recording is bound LATER, by `recording.ts`, and only through
 * `attach_phone_attempt_recording`, which 0043 refuses unless the engagement
 * is already `in_call` — a state reachable through exactly one transition,
 * `disclosure.delivered`. The gate is in the state machine, not in the order
 * of two statements here.
 *
 * ── ONE SESSION, MANY ATTEMPTS ────────────────────────────────────────
 * A reconnect is a NEW attempt, a NEW participant and a NEW epoch, but the
 * SAME session, transcript and question cursor. The room is therefore keyed by
 * SESSION, not by attempt, and provisioning is idempotent: a reconnect finds
 * the room already there and adopts it. Creating a second room per attempt
 * would fork the transcript, which is the one thing a reconnect exists to
 * avoid.
 *
 * ── NO INVITE ─────────────────────────────────────────────────────────
 * There is no token minted and no join link produced. A phone candidate joins
 * by answering a telephone; an invite would be a second, unused way in.
 */

import { requireLiveKitConfigured } from '../../lib/room-provisioning.js';

/** Rooms are keyed by SESSION so reconnect attempts share one transcript. */
export function phoneRoomName(sessionId: string): string {
  return `phone-${sessionId}`;
}

/** The marker the browser worker uses to recognise — and skip — a phone room. */
export const PHONE_ROOM_CHANNEL = 'phone';

/**
 * Room metadata. Three closed keys and a correlation id, exactly as the
 * browser provisioner does it.
 *
 * `channel` is load-bearing rather than decorative: the existing browser
 * worker auto-dispatches into EVERY room in the project, so without a marker
 * it would join phone rooms and start talking to a candidate who has not been
 * classified, let alone disclosed to. The worker keys its skip on this value
 * and on the room-name shape, so neither alone is a single point of failure.
 *
 * NOTHING derived from a phone number appears here. This is not merely
 * observed — the value set is closed and none of its members is sourced from
 * the candidate row.
 */
export function buildPhoneRoomMetadata(
  sessionId: string,
  roomName: string,
  correlationId?: string | null,
): string {
  return JSON.stringify({
    session_id: sessionId,
    room_name: roomName,
    channel: PHONE_ROOM_CHANNEL,
    correlation_id: correlationId ?? undefined,
  });
}

/** The narrow slice of `RoomServiceClient` this file uses. */
export interface PhoneRoomServiceClientLike {
  createRoom(options: {
    name: string;
    emptyTimeout: number;
    maxParticipants: number;
    metadata: string;
  }): Promise<unknown>;
  updateRoomMetadata(room: string, metadata: string): Promise<unknown>;
}

/** The named-agent dispatch seam. Absent when no phone worker is deployed. */
export interface PhoneAgentDispatchClientLike {
  createDispatch(roomName: string, agentName: string, options?: { metadata?: string }): Promise<unknown>;
}

/**
 * A phone room holds the candidate's SIP leg and one agent. `maxParticipants`
 * is 2 rather than the browser room's 4: there is no screen-share, no
 * observer and no second candidate device on a telephone call, and a cap that
 * admits participants the design has no role for is a cap that is not doing
 * anything.
 */
export const PHONE_ROOM_MAX_PARTICIPANTS = 2;

/**
 * How long an EMPTY phone room survives. Shorter than the browser room's ten
 * minutes because a phone room that is empty has either not been answered yet
 * or has ended, and both are bounded by the ring timeout and the call ceiling
 * rather than by a human deciding to click a link.
 */
export const PHONE_ROOM_EMPTY_TIMEOUT_SEC = 120;

export type PhoneRoomStatus =
  | 'created'
  | 'adopted'
  | 'not_configured'
  | 'provider_failed'
  | 'dispatch_failed';

export interface PhoneRoomResult {
  readonly status: PhoneRoomStatus;
  readonly roomName: string;
  /** Whether a named agent was actually dispatched into the room. */
  readonly dispatched: boolean;
  /** Stable code only — never a provider message. */
  readonly reason?: string;
}

export interface ProvisionPhoneRoomDeps {
  readonly rooms: PhoneRoomServiceClientLike;
  /** Absent when no named phone worker is configured. */
  readonly dispatch?: PhoneAgentDispatchClientLike;
  readonly correlationId?: string | null;
}

export interface ProvisionPhoneRoomInput {
  readonly sessionId: string;
  /**
   * The named phone agent to dispatch, or `''` for none.
   *
   * EMPTY IS A LEGITIMATE, DELIBERATE STATE, not an error. The existing
   * browser worker is unnamed and auto-dispatches into every room, so it would
   * otherwise pick this room up; the room-name and metadata markers make it
   * skip instead. Until a named phone worker is deployed, a phone room is
   * therefore created and simply has no agent — which is correct, because the
   * alternative is the browser agent talking to an unclassified caller.
   */
  readonly agentName: string;
}

/**
 * Create (or adopt) the phone room and, when a named worker is configured,
 * dispatch it explicitly.
 *
 * Explicit dispatch is required because the phone worker is NAMED, and a named
 * LiveKit worker does not auto-dispatch. That asymmetry is the design: the
 * browser worker stays unnamed and untouched — so browser screening needs no
 * Python change and no coordinated deploy — while the phone worker is opt-in
 * and its rollback is simply not deploying it.
 */
export async function provisionPhoneRoom(
  input: ProvisionPhoneRoomInput,
  deps: ProvisionPhoneRoomDeps,
): Promise<PhoneRoomResult> {
  const roomName = phoneRoomName(input.sessionId);
  try {
    requireLiveKitConfigured();
  } catch {
    // A bare code. `requireLiveKitConfigured` throws a message naming the env
    // file, which is fine for a browser route's 500 but is not something this
    // path forwards.
    return { status: 'not_configured', roomName, dispatched: false, reason: 'livekit_not_configured' };
  }

  const metadata = buildPhoneRoomMetadata(input.sessionId, roomName, deps.correlationId);
  let status: PhoneRoomStatus = 'created';
  try {
    await deps.rooms.createRoom({
      name: roomName,
      emptyTimeout: PHONE_ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: PHONE_ROOM_MAX_PARTICIPANTS,
      metadata,
    });
  } catch {
    // A reconnect finds the room already present. Converge on the metadata
    // rather than failing, exactly as the browser provisioner does — and
    // report `adopted` so a caller can tell a fresh dial from a reconnect
    // without inferring it from the absence of an error.
    try {
      await deps.rooms.updateRoomMetadata(roomName, metadata);
      status = 'adopted';
    } catch {
      return { status: 'provider_failed', roomName, dispatched: false, reason: 'room_create_error' };
    }
  }

  if (input.agentName === '' || deps.dispatch === undefined) {
    return { status, roomName, dispatched: false, reason: 'no_named_agent' };
  }

  try {
    // Dispatch metadata is deliberately the SAME closed object as the room
    // metadata. A second, richer payload here would be a second place a phone
    // value could be introduced, and the worker already resolves everything it
    // needs server-side from the session id.
    await deps.dispatch.createDispatch(roomName, input.agentName, { metadata });
  } catch {
    // The room exists and is correct; only the agent is missing. This is
    // reported rather than swallowed, because a room with no agent will sit
    // silent while a real person says "hello" into it — and it is NOT
    // converted into a room teardown, because a reconnect may already have a
    // live participant in there.
    return { status: 'dispatch_failed', roomName, dispatched: false, reason: 'agent_dispatch_error' };
  }

  return { status, roomName, dispatched: true };
}
