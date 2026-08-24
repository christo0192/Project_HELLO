/**
 * PR105 — teardown, which is this mechanism's kill switch.
 *
 * ── WHY THIS IS NOT COVERED BY THE DATABASE HALT ──────────────────────
 * `POST /api/phone/halt` stops ADMISSION and the due pass. Canary-1 never
 * admits — there is no engagement, no attempt and no row for the halt to see —
 * and the halt does not end calls that are already live in any case. So the
 * abort for this mechanism is Ctrl-C, and Ctrl-C must run the SAME teardown
 * the happy path runs. That is a real reduction in emergency-stop coverage,
 * and it is why the runbook requires a second person present.
 *
 * ── AND WHY DELETE IS NOT THE ASSERTION ───────────────────────────────
 * A delete that returns without throwing is a claim by the provider. The
 * assertion is ABSENCE: the room is listed by name and the answer must be
 * empty. Two facts, two verdict lines, and only the second one ends a call.
 */

import { describe, it, expect } from 'vitest';

import {
  CANARY1_MANUAL_REMEDY_CODES,
  CANARY1_TEARDOWN_BACKOFF_MS,
  tearDownCanary1Room,
  type Canary1RoomTeardownClientLike,
  type Canary1RoomView,
} from '../lib/phone-canary1/index.js';

const ROOM = 'phone-9c4a1e75-2b83-41d7-8f60-1ea55d3c9b02';

function client(script: {
  deleteThrows?: boolean;
  listThrows?: boolean;
  presentFor?: number;
}): { rooms: Canary1RoomTeardownClientLike; deletes: number; lists: number } {
  let deletes = 0;
  let lists = 0;
  const state = {
    get deletes() { return deletes; },
    get lists() { return lists; },
    rooms: {
      async deleteRoom(): Promise<unknown> {
        deletes += 1;
        if (script.deleteThrows === true) throw new Error('provider refused');
        return null;
      },
      async listRooms(): Promise<readonly Canary1RoomView[]> {
        lists += 1;
        if (script.listThrows === true) throw new Error('provider refused');
        return lists <= (script.presentFor ?? 0) ? [{ numParticipants: 1 }] : [];
      },
    },
  };
  return state;
}

const NO_SLEEP = async (): Promise<void> => {};

describe('1. delete, then VERIFY absence', () => {
  it('reports deleted only when the room is observed gone', async () => {
    const c = client({});
    const result = await tearDownCanary1Room(ROOM, { rooms: c.rooms, sleep: NO_SLEEP });
    expect(result).toEqual({
      status: 'deleted', deleteCalled: true, verifiedAbsent: true, attempts: 1,
    });
  });

  it('retries three times with the documented backoff, then fails closed', async () => {
    const slept: number[] = [];
    const c = client({ presentFor: 99 });
    const result = await tearDownCanary1Room(ROOM, {
      rooms: c.rooms,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(result.status).toBe('cleanup_failed');
    expect(result.verifiedAbsent).toBe(false);
    expect(result.attempts).toBe(CANARY1_TEARDOWN_BACKOFF_MS.length + 1);
    expect(slept).toEqual([...CANARY1_TEARDOWN_BACKOFF_MS]);
  });

  it('a room already gone when delete FAILS is still a success', async () => {
    // A provider error on an already-deleted room would otherwise burn all
    // three retries and report a cleanup failure for a room that does not
    // exist — which sends an operator to the LiveKit console for nothing, and
    // trains them to ignore the line that matters.
    const c = client({ deleteThrows: true });
    const result = await tearDownCanary1Room(ROOM, { rooms: c.rooms, sleep: NO_SLEEP });
    expect(result.status).toBe('deleted');
    expect(result.deleteCalled).toBe(false);
    expect(result.verifiedAbsent).toBe(true);
  });

  it('succeeds on a later attempt when the provider is slow to converge', async () => {
    const c = client({ presentFor: 2 });
    const result = await tearDownCanary1Room(ROOM, { rooms: c.rooms, sleep: NO_SLEEP });
    expect(result.status).toBe('deleted');
    expect(result.attempts).toBe(3);
  });

  it('a listing that THROWS is not read as absence', async () => {
    // Fail-closed: "we could not check" and "the room is gone" must not look
    // the same. This is the same rule Canary-0 applies to a missing Docker.
    const c = client({ listThrows: true });
    const result = await tearDownCanary1Room(ROOM, { rooms: c.rooms, sleep: NO_SLEEP });
    expect(result.status).toBe('cleanup_failed');
    expect(c.lists).toBe(CANARY1_TEARDOWN_BACKOFF_MS.length + 1);
  });

  it('a THROWING delete never escapes the containment', async () => {
    const c = client({ deleteThrows: true, presentFor: 99 });
    await expect(
      tearDownCanary1Room(ROOM, { rooms: c.rooms, sleep: NO_SLEEP }),
    ).resolves.toMatchObject({ status: 'cleanup_failed' });
  });

  it('a THROWING sleep never escapes either', async () => {
    const c = client({ presentFor: 99 });
    await expect(tearDownCanary1Room(ROOM, {
      rooms: c.rooms,
      sleep: async () => { throw new Error('timer gone'); },
    })).resolves.toMatchObject({ status: 'cleanup_failed' });
  });

  it('POSITIVE CONTROL — a permanently failing delete DOES go red', async () => {
    // The success cases above are only meaningful if the failure case is
    // reachable. It is, and it reports the code the runbook's remedy card is
    // keyed on.
    const c = client({ deleteThrows: true, presentFor: 99 });
    const result = await tearDownCanary1Room(ROOM, { rooms: c.rooms, sleep: NO_SLEEP });
    expect(result.status).toBe('cleanup_failed');
    expect(CANARY1_MANUAL_REMEDY_CODES).toEqual([
      'hang_up_the_handset',
      'delete_the_room_in_the_livekit_console',
      'scale_the_phone_worker_to_zero',
    ]);
  });
});

describe('2. the backoff is bounded and ordered', () => {
  it('is exactly three retries at 1s, 2s, 4s', () => {
    expect([...CANARY1_TEARDOWN_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000]);
    // Ordered ascending, and bounded: the whole retry budget is under eight
    // seconds, so teardown cannot itself become the thing holding a live leg.
    const total = CANARY1_TEARDOWN_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(10_000);
  });
});
