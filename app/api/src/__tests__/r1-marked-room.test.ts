/**
 * M034 S04: the R1 attempt's marked-room provisioning, extracted from the R1 candidate
 * router into lib/r1/marked-room.ts.
 *
 * The wrapper must call provisioning exactly as the router did (same arguments, same key
 * order, the room-client factory only when injected), pass success through, fold every
 * failure code into `provider_failed` or `not_joinable`, and let throws propagate.
 */

import { describe, expect, it, vi } from 'vitest';
import { cloudLiveKitEndpoint, type LiveKitEndpoint } from '../lib/livekit-endpoints.js';
import type { ProvisionRoomResult, RoomServiceClientLike } from '../lib/room-provisioning.js';
import { provisionMarkedRoom, type ProvisionMarkedRoomDeps } from '../lib/r1/marked-room.js';

const SESSION_ID = '30000000-0000-4000-8000-0000000000e1';
const ROUND_ID = '20000000-0000-4000-8000-0000000000c1';
const SESSION = { id: SESSION_ID, interview_round_id: ROUND_ID };
const ROOM = `screening-${SESSION_ID}`;

/** A synthetic R1 SFU endpoint. Low-entropy fixture so the history secret scanner never flags it. */
const R1_ENDPOINT: LiveKitEndpoint = {
  url: 'wss://r1.example.invalid',
  apiKey: 'r1-test-key',
  apiSecret: 'r1-test-secret-' + 's'.repeat(24),
  target: 'r1',
};

function provisionReturning(result: ProvisionRoomResult) {
  return vi.fn<ProvisionMarkedRoomDeps['provisionRoom']>(async () => result);
}

function roomClient(): RoomServiceClientLike {
  return {
    createRoom: vi.fn(async () => ({})),
    updateRoomMetadata: vi.fn(async () => ({})),
    deleteRoom: vi.fn(async () => ({})),
  };
}

describe('provisionMarkedRoom', () => {
  it('calls provisioning once with exactly the router arguments, and no rooms key when no factory is injected', async () => {
    for (const endpoint of [cloudLiveKitEndpoint(), R1_ENDPOINT]) {
      const provisionRoom = provisionReturning({ ok: true, roomName: ROOM, adopted: false });
      await provisionMarkedRoom(SESSION, endpoint, { provisionRoom });
      expect(provisionRoom).toHaveBeenCalledTimes(1);
      expect(provisionRoom).toHaveBeenCalledWith(SESSION_ID, 'existing_session', {
        endpoint,
        lane: 'r1',
        interviewRoundId: ROUND_ID,
      });
      const args = provisionRoom.mock.calls[0]!;
      expect(args[2]!.endpoint).toBe(endpoint);
      expect(Object.keys(args[2]!)).toEqual(['endpoint', 'lane', 'interviewRoundId']);
    }
  });

  it('calls the injected room-client factory once with the endpoint and passes its client as rooms', async () => {
    const client = roomClient();
    const rooms = vi.fn((_endpoint: LiveKitEndpoint) => client);
    const provisionRoom = provisionReturning({ ok: true, roomName: ROOM, adopted: false });
    await provisionMarkedRoom(SESSION, R1_ENDPOINT, { provisionRoom, rooms });
    expect(rooms).toHaveBeenCalledTimes(1);
    expect(rooms).toHaveBeenCalledWith(R1_ENDPOINT);
    expect(rooms.mock.calls[0]![0]).toBe(R1_ENDPOINT);
    expect(provisionRoom).toHaveBeenCalledTimes(1);
    const args = provisionRoom.mock.calls[0]!;
    expect(Object.keys(args[2]!)).toEqual(['endpoint', 'lane', 'interviewRoundId', 'rooms']);
    expect(args[2]!.rooms).toBe(client);
    // The factory runs before provisioning, while the argument object is built.
    expect(rooms.mock.invocationCallOrder[0]!).toBeLessThan(provisionRoom.mock.invocationCallOrder[0]!);
  });

  it('passes success through, adopted or not', async () => {
    for (const adopted of [true, false]) {
      const provisionRoom = provisionReturning({ ok: true, roomName: ROOM, adopted });
      await expect(provisionMarkedRoom(SESSION, R1_ENDPOINT, { provisionRoom })).resolves.toEqual({
        ok: true,
        roomName: ROOM,
        adopted,
      });
    }
  });

  it('maps provider_failed to provider_failed and every other failure code to not_joinable', async () => {
    const providerFailed = provisionReturning({
      ok: false,
      code: 'provider_failed',
      roomName: ROOM,
      error: new Error('livekit down'),
      terminated: false,
      terminateFailed: false,
    });
    await expect(provisionMarkedRoom(SESSION, R1_ENDPOINT, { provisionRoom: providerFailed })).resolves.toEqual({
      ok: false,
      reason: 'provider_failed',
    });

    const others: ProvisionRoomResult[] = [
      { ok: false, code: 'not_joinable', roomName: ROOM },
      { ok: false, code: 'transition_conflict', roomName: ROOM, cleanupFailed: false },
      { ok: false, code: 'transition_failed', roomName: ROOM, cleanupFailed: true },
    ];
    for (const result of others) {
      const provisionRoom = provisionReturning(result);
      await expect(provisionMarkedRoom(SESSION, R1_ENDPOINT, { provisionRoom }), result.ok ? 'ok' : result.code)
        .resolves.toEqual({ ok: false, reason: 'not_joinable' });
    }
  });

  it('propagates a provisioning rejection with the same error object', async () => {
    const failure = new Error('livekit endpoint not configured');
    const provisionRoom = vi.fn<ProvisionMarkedRoomDeps['provisionRoom']>(async () => {
      throw failure;
    });
    await expect(provisionMarkedRoom(SESSION, R1_ENDPOINT, { provisionRoom })).rejects.toBe(failure);
    expect(provisionRoom).toHaveBeenCalledTimes(1);
  });

  it('passes a null round id through unchanged (provisioning, not this wrapper, fails it closed)', async () => {
    // What provisioning answers for an R1 lane without a round: its lane-mismatch guard throws inside its own try.
    const provisionRoom = provisionReturning({
      ok: false,
      code: 'provider_failed',
      roomName: ROOM,
      error: new Error('r1_lane_mismatch'),
      terminated: false,
      terminateFailed: false,
    });
    await expect(
      provisionMarkedRoom({ id: SESSION_ID, interview_round_id: null }, R1_ENDPOINT, { provisionRoom }),
    ).resolves.toEqual({ ok: false, reason: 'provider_failed' });
    expect(provisionRoom).toHaveBeenCalledWith(SESSION_ID, 'existing_session', {
      endpoint: R1_ENDPOINT,
      lane: 'r1',
      interviewRoundId: null,
    });
    expect(provisionRoom.mock.calls[0]![2]!.interviewRoundId).toBeNull();
  });
});
