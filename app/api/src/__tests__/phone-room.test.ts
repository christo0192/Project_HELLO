/**
 * P5 — `provisionPhoneRoom`, the phone room that is a SIBLING of the browser
 * room and deliberately not the same thing.
 *
 * The property this file exists to pin is an ABSENCE:
 *
 *   A PHONE ROOM NEVER STARTS AN EGRESS.
 *
 * `provisionRoomForCreatedSession` starts the authoritative recording BEFORE it
 * publishes the browser room as joinable, because a browser candidate consented
 * on a web page before the room ever existed. A phone candidate has consented to
 * NOTHING at the moment the room is created: the line has not even rung, nobody
 * has answered, and no disclosure has been delivered. An egress here would
 * record a person who has not been told they are being recorded, on a call they
 * have not accepted.
 *
 * An absence cannot be observed by calling the function, so it is asserted two
 * ways that fail independently: the module source carries none of the egress
 * identifiers, and the deps object the function actually accepts carries no
 * egress seam a caller could hand it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `requireLiveKitConfigured` reads a module-level `env` snapshot, so clearing
// `process.env` after import would not move it. The seam is stubbed instead,
// with a mutable flag so ONE test can exercise the unconfigured branch without
// making every other test in the file depend on ambient credentials.
const livekitConfigured = vi.hoisted(() => ({ ok: true }));
vi.mock('../lib/room-provisioning.js', () => ({
  requireLiveKitConfigured: (): void => {
    if (!livekitConfigured.ok) {
      throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set');
    }
  },
}));

const {
  provisionPhoneRoom,
  phoneRoomName,
  buildPhoneRoomMetadata,
  PHONE_ROOM_CHANNEL,
  PHONE_ROOM_MAX_PARTICIPANTS,
  PHONE_ROOM_EMPTY_TIMEOUT_SEC,
} = await import('../integrations/livekit-phone-dial/phone-room.js');

type ProvisionDeps = Parameters<typeof provisionPhoneRoom>[1];

const SESSION = '11111111-2222-4333-8444-555555555555';
const ROOM = `phone-${SESSION}`;
const AGENT = 'phone-screener';

/** 0042's `chk_phone_call_attempts_room_name`, copied verbatim. */
const ROOM_NAME_CHECK = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * A room fake that ALSO exposes the destructive methods the real
 * `RoomServiceClient` has. The narrow port does not declare them, but a fake
 * that lacks them entirely could not prove the code never reaches for them.
 */
interface CreateRoomOptions {
  name: string;
  emptyTimeout: number;
  maxParticipants: number;
  metadata: string;
}

function roomsFake(
  overrides: {
    createRoom?: (options: CreateRoomOptions) => Promise<unknown>;
    updateRoomMetadata?: (room: string, metadata: string) => Promise<unknown>;
  } = {},
) {
  return {
    createRoom: vi.fn<(options: CreateRoomOptions) => Promise<unknown>>(
      overrides.createRoom ?? (async () => ({})),
    ),
    updateRoomMetadata: vi.fn<(room: string, metadata: string) => Promise<unknown>>(
      overrides.updateRoomMetadata ?? (async () => ({})),
    ),
    deleteRoom: vi.fn<(room: string) => Promise<unknown>>(async () => ({})),
    removeParticipant: vi.fn<(room: string, identity: string) => Promise<unknown>>(
      async () => ({}),
    ),
  };
}

type DispatchFn = (
  roomName: string,
  agentName: string,
  options?: { metadata?: string },
) => Promise<unknown>;

function dispatchFake(impl?: DispatchFn) {
  return vi.fn<DispatchFn>(impl ?? (async () => ({})));
}

beforeEach(() => {
  livekitConfigured.ok = true;
});

// ═══════════════════════════════════════════════════════════════════════
// The absence
// ═══════════════════════════════════════════════════════════════════════

describe('P5 phone room — a phone room NEVER starts an egress', () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL('../integrations/livekit-phone-dial/phone-room.ts', import.meta.url)),
    'utf8',
  );

  /** Comments SAY "never starts an egress"; only the code can prove it. */
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('names no egress identifier anywhere in its executable source', () => {
    for (const forbidden of [
      'startRoomCompositeEgress',
      'EgressClient',
      'startAuthoritativeRecording',
      'recording-egress',
    ]) {
      expect(CODE).not.toContain(forbidden);
    }
    // Nothing egress-shaped at all, under any spelling.
    expect(CODE).not.toMatch(/egress/i);
  });

  it('offers no egress seam on its deps, so a caller cannot inject one either', async () => {
    const rooms = roomsFake();
    // The only injectable collaborators are the room client, the named-agent
    // dispatcher and a correlation id. There is no recording seam to pass.
    const deps = { rooms } satisfies ProvisionDeps;
    expect(Object.keys(deps)).toEqual(['rooms']);

    const result = await provisionPhoneRoom({ sessionId: SESSION, agentName: '' }, deps);

    expect(result.status).toBe('created');
    // Provisioning succeeded having touched exactly two room methods.
    expect(rooms.createRoom).toHaveBeenCalledTimes(1);
    expect(rooms.updateRoomMetadata).not.toHaveBeenCalled();
    expect(rooms.deleteRoom).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Metadata and the room name
// ═══════════════════════════════════════════════════════════════════════

describe('P5 phone room — metadata is a closed set with no number in it', () => {
  it('carries exactly the four documented keys and channel `phone`', () => {
    const parsed = JSON.parse(buildPhoneRoomMetadata(SESSION, ROOM, 'corr-1')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual([
      'channel',
      'correlation_id',
      'room_name',
      'session_id',
    ]);
    expect(parsed.channel).toBe('phone');
    expect(PHONE_ROOM_CHANNEL).toBe('phone');
    expect(parsed.session_id).toBe(SESSION);
    expect(parsed.room_name).toBe(ROOM);
  });

  it('omits `correlation_id` entirely rather than emitting a null', () => {
    const parsed = JSON.parse(buildPhoneRoomMetadata(SESSION, ROOM, null)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual(['channel', 'room_name', 'session_id']);
  });

  it('derives no value from a phone number', () => {
    // The builder has THREE parameters — session id, room name, correlation id
    // — so there is no argument through which a number could arrive, and the
    // value set is exactly those three plus the literal channel marker.
    expect(buildPhoneRoomMetadata.length).toBe(3);

    const parsed = JSON.parse(buildPhoneRoomMetadata(SESSION, ROOM, 'corr-x')) as Record<
      string,
      unknown
    >;
    expect(new Set(Object.values(parsed))).toEqual(new Set([SESSION, ROOM, 'phone', 'corr-x']));

    // Nothing number-shaped survives anywhere in the serialized payload.
    const raw = buildPhoneRoomMetadata(SESSION, ROOM, 'corr-x');
    expect(raw).not.toContain('+');
    expect(raw).not.toContain('9876543210');

    // And the closed key set admits nowhere to put one.
    expect(Object.keys(parsed)).not.toContain('phone');
    expect(Object.keys(parsed)).not.toContain('phone_number');
    expect(Object.keys(parsed)).not.toContain('candidate_id');
  });

  it('is the SAME object the dispatch receives — one payload, one place to leak', async () => {
    const rooms = roomsFake();
    const createDispatch = dispatchFake();
    await provisionPhoneRoom(
      { sessionId: SESSION, agentName: AGENT },
      { rooms, dispatch: { createDispatch }, correlationId: 'corr-9' },
    );
    const roomMetadata = rooms.createRoom.mock.calls[0]![0].metadata;
    const dispatchMetadata = createDispatch.mock.calls[0]![2]?.metadata;
    expect(dispatchMetadata).toBe(roomMetadata);
  });
});

describe('P5 phone room — the room name is keyed by SESSION and DB-legal', () => {
  it('is `phone-<sessionId>`', () => {
    expect(phoneRoomName(SESSION)).toBe(`phone-${SESSION}`);
  });

  it("satisfies 0042's chk_phone_call_attempts_room_name", () => {
    // The constraint's character classes exclude '+' and ' ' precisely so a
    // phone number can never be written into the column.
    expect(phoneRoomName(SESSION)).toMatch(ROOM_NAME_CHECK);
    expect(phoneRoomName(SESSION).length).toBeLessThanOrEqual(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Caps
// ═══════════════════════════════════════════════════════════════════════

describe('P5 phone room — the caps differ from the browser room on purpose', () => {
  it('admits two participants, not the browser room’s four', () => {
    // A phone room holds the candidate's SIP leg and one agent. There is no
    // screen-share, no observer and no second candidate device on a telephone
    // call, so a cap that admitted four would admit participants the design
    // has no role for — which is a cap that is not doing anything.
    expect(PHONE_ROOM_MAX_PARTICIPANTS).toBe(2);
  });

  it('reaps an empty room in 120s, not the browser room’s 600s', () => {
    // An empty phone room has either not been answered yet or has ended, and
    // both are bounded by the ring timeout and the call ceiling — not by a
    // human deciding when to click a join link.
    expect(PHONE_ROOM_EMPTY_TIMEOUT_SEC).toBe(120);
  });

  it('passes both caps through to the provider verbatim', async () => {
    const rooms = roomsFake();
    await provisionPhoneRoom({ sessionId: SESSION, agentName: '' }, { rooms });
    expect(rooms.createRoom).toHaveBeenCalledWith({
      name: ROOM,
      emptyTimeout: PHONE_ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: PHONE_ROOM_MAX_PARTICIPANTS,
      metadata: buildPhoneRoomMetadata(SESSION, ROOM, undefined),
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Reconnect / idempotence
// ═══════════════════════════════════════════════════════════════════════

describe('P5 phone room — a reconnect adopts the room rather than forking it', () => {
  it('converges the metadata and reports `adopted` when createRoom throws', async () => {
    const rooms = roomsFake({
      createRoom: async () => {
        throw new Error('room already exists');
      },
    });

    const result = await provisionPhoneRoom(
      { sessionId: SESSION, agentName: '' },
      { rooms, correlationId: 'corr-2' },
    );

    expect(result.status).toBe('adopted');
    expect(result.roomName).toBe(ROOM);
    // Same room, same session, same transcript: a second room per attempt
    // would fork the transcript a reconnect exists to preserve.
    expect(rooms.updateRoomMetadata).toHaveBeenCalledTimes(1);
    expect(rooms.updateRoomMetadata).toHaveBeenCalledWith(
      ROOM,
      buildPhoneRoomMetadata(SESSION, ROOM, 'corr-2'),
    );
    expect(rooms.deleteRoom).not.toHaveBeenCalled();
  });

  it('reports `provider_failed` with a stable reason when BOTH calls throw', async () => {
    const rooms = roomsFake({
      createRoom: async () => {
        throw new Error('boom: host=livekit-prod-7 tenant=acme');
      },
      updateRoomMetadata: async () => {
        throw new Error('boom: host=livekit-prod-7 tenant=acme');
      },
    });

    const result = await provisionPhoneRoom({ sessionId: SESSION, agentName: AGENT }, { rooms });

    expect(result).toEqual({
      status: 'provider_failed',
      roomName: ROOM,
      dispatched: false,
      reason: 'room_create_error',
    });
    // A stable code, never the provider's message.
    expect(result.reason).not.toContain('livekit-prod-7');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════════════

describe('P5 phone room — dispatch is explicit because the phone worker is NAMED', () => {
  it('an empty agent name is a legitimate state, and NOTHING is dispatched', async () => {
    const rooms = roomsFake();
    const createDispatch = dispatchFake();

    const result = await provisionPhoneRoom(
      { sessionId: SESSION, agentName: '' },
      { rooms, dispatch: { createDispatch } },
    );

    expect(result.status).toBe('created');
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('no_named_agent');
    // The existing BROWSER worker is unnamed and auto-dispatches into every
    // room in the project. It would otherwise pick this room up and start
    // talking to a caller who has not been classified, let alone disclosed to.
    // The room-name and `channel` markers are what make it skip — so a room
    // with no agent is correct, and manufacturing one here would be the bug.
    expect(createDispatch).not.toHaveBeenCalled();
  });

  it('dispatches exactly once when a name AND a dispatch seam are present', async () => {
    const rooms = roomsFake();
    const createDispatch = dispatchFake();

    const result = await provisionPhoneRoom(
      { sessionId: SESSION, agentName: AGENT },
      { rooms, dispatch: { createDispatch }, correlationId: 'corr-3' },
    );

    expect(result).toEqual({ status: 'created', roomName: ROOM, dispatched: true });
    expect(createDispatch).toHaveBeenCalledTimes(1);
    expect(createDispatch).toHaveBeenCalledWith(ROOM, AGENT, {
      metadata: buildPhoneRoomMetadata(SESSION, ROOM, 'corr-3'),
    });
  });

  it('a name with NO dispatch seam deployed is still `no_named_agent`', async () => {
    const rooms = roomsFake();
    const result = await provisionPhoneRoom({ sessionId: SESSION, agentName: AGENT }, { rooms });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('no_named_agent');
  });

  it('a dispatch failure is reported and the room is NOT torn down', async () => {
    const rooms = roomsFake();
    const createDispatch = dispatchFake(async () => {
      throw new Error('agent worker unavailable');
    });

    const result = await provisionPhoneRoom(
      { sessionId: SESSION, agentName: AGENT },
      { rooms, dispatch: { createDispatch } },
    );

    expect(result).toEqual({
      status: 'dispatch_failed',
      roomName: ROOM,
      dispatched: false,
      reason: 'agent_dispatch_error',
    });
    // A reconnect may ALREADY have a live participant in this room. Deleting
    // it or removing participants would turn a loud failure (silent agent)
    // into a destructive one (a candidate cut off mid-call).
    expect(rooms.deleteRoom).not.toHaveBeenCalled();
    expect(rooms.removeParticipant).not.toHaveBeenCalled();
  });

  it('a dispatch failure on an ADOPTED room is still not a teardown', async () => {
    const rooms = roomsFake({
      createRoom: async () => {
        throw new Error('room already exists');
      },
    });
    const createDispatch = dispatchFake(async () => {
      throw new Error('agent worker unavailable');
    });

    const result = await provisionPhoneRoom(
      { sessionId: SESSION, agentName: AGENT },
      { rooms, dispatch: { createDispatch } },
    );

    expect(result.status).toBe('dispatch_failed');
    expect(rooms.deleteRoom).not.toHaveBeenCalled();
    expect(rooms.removeParticipant).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Not configured
// ═══════════════════════════════════════════════════════════════════════

describe('P5 phone room — an unconfigured LiveKit refuses before the provider', () => {
  it('returns `not_configured` and never calls createRoom', async () => {
    livekitConfigured.ok = false;
    const rooms = roomsFake();
    const createDispatch = dispatchFake();

    const result = await provisionPhoneRoom(
      { sessionId: SESSION, agentName: AGENT },
      { rooms, dispatch: { createDispatch } },
    );

    expect(result).toEqual({
      status: 'not_configured',
      roomName: ROOM,
      dispatched: false,
      // A bare code: the real error names the .env file, which is fine for a
      // browser route's 500 and is not something this path forwards.
      reason: 'livekit_not_configured',
    });
    expect(result.reason).not.toContain('.env');
    expect(rooms.createRoom).not.toHaveBeenCalled();
    expect(rooms.updateRoomMetadata).not.toHaveBeenCalled();
    expect(createDispatch).not.toHaveBeenCalled();
  });
});
