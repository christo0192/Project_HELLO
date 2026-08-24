/**
 * lib/phone-canary1/teardown.ts — delete the room, VERIFY it is gone, and fail
 * closed when it is not.
 *
 * ── WHY A `finally`, WHEN THE HALT DRILL FORBIDS ONE ──────────────────
 * `halt-drill.mjs` rule 2 forbids a `finally` block, and a structural test
 * enforces it: there, a `finally` would LIFT A KILL SWITCH as cleanup, which
 * fails OPEN. Here the same construct DELETES A ROOM AND DROPS A LIVE LEG,
 * which fails CLOSED. Direction is what matters, and it is written down
 * because a future reader who knows the drill's rule and not its reason will
 * otherwise "fix" this.
 *
 * ── DELETE IS NOT THE ASSERTION; ABSENCE IS ───────────────────────────
 * A delete that returns without throwing is a claim by the provider. The
 * verification step asks the provider to list the room by name and requires
 * the answer to be empty. Two separate checks with two separate verdict lines,
 * because "we called delete" and "the room is gone" are different facts and
 * only the second one ends a call.
 *
 * ── AND THE WHOLE THING IS INSIDE THE CONTAINMENT ─────────────────────
 * Every provider call here goes through `discardingErrors`. A failing delete
 * during teardown must not become a stack trace quoting a provider payload —
 * teardown runs on the error path, which is exactly when an uncontained throw
 * is most likely and least expected.
 *
 * Partial failure is ALWAYS a non-zero exit. There is no "mostly torn down".
 */

import { discardingErrors } from './containment.js';

/** Backoff between delete attempts, in milliseconds. Three retries, then stop. */
export const CANARY1_TEARDOWN_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

export type Canary1TeardownStatus = 'deleted' | 'cleanup_failed';

/**
 * The only room fields this mechanism reads. A COUNT and a NAME — never the
 * participant list, never a participant's attributes, and never the room
 * metadata coming back out. `sip.phoneNumber` is auto-populated by LiveKit on
 * a SIP participant, so enumerating a participant map is precisely how a phone
 * number escapes into a terminal.
 */
export interface Canary1RoomView {
  readonly numParticipants?: number;
}

export interface Canary1RoomTeardownClientLike {
  deleteRoom(name: string): Promise<unknown>;
  /** Must return the rooms matching the requested names — empty when gone. */
  listRooms(names: readonly string[]): Promise<readonly Canary1RoomView[]>;
}

export interface Canary1TeardownDeps {
  readonly rooms: Canary1RoomTeardownClientLike;
  /** Injected so a test does not spend seven seconds proving a backoff. */
  readonly sleep: (ms: number) => Promise<void>;
}

export interface Canary1TeardownResult {
  readonly status: Canary1TeardownStatus;
  /** Whether the delete call itself ever returned without throwing. */
  readonly deleteCalled: boolean;
  /** Whether the room was OBSERVED absent. The only fact that ends a call. */
  readonly verifiedAbsent: boolean;
  /** How many delete attempts were made. A bounded count, safe to print. */
  readonly attempts: number;
}

/**
 * Delete and verify, with a bounded retry.
 *
 * The loop verifies after EVERY attempt, including the first, because a delete
 * can fail while the room is already gone — a provider error on a
 * already-deleted room would otherwise burn all three retries and report a
 * cleanup failure for a room that does not exist.
 */
export async function tearDownCanary1Room(
  roomName: string,
  deps: Canary1TeardownDeps,
): Promise<Canary1TeardownResult> {
  let deleteCalled = false;
  let attempts = 0;

  for (let i = 0; i <= CANARY1_TEARDOWN_BACKOFF_MS.length; i += 1) {
    attempts += 1;
    const deleted = await discardingErrors(async () => {
      await deps.rooms.deleteRoom(roomName);
      return true;
    });
    if (deleted === true) deleteCalled = true;

    const listed = await discardingErrors(async () => deps.rooms.listRooms([roomName]));
    if (listed !== undefined && listed.length === 0) {
      return { status: 'deleted', deleteCalled, verifiedAbsent: true, attempts };
    }

    const backoff = CANARY1_TEARDOWN_BACKOFF_MS[i];
    if (backoff === undefined) break;
    await discardingErrors(async () => {
      await deps.sleep(backoff);
    });
  }

  // Never "mostly succeeded". The caller emits `cleanup_failed`, prints the
  // manual remedy, and exits non-zero.
  return { status: 'cleanup_failed', deleteCalled, verifiedAbsent: false, attempts };
}

/**
 * The manual remedy, printed when teardown fails. Stable codes only, so it
 * stays inside the grammar the transcript is safe under.
 *
 * It is a list of CODES rather than prose because the verdict grammar has no
 * free-text field; the runbook holds the sentences these codes point at.
 */
export const CANARY1_MANUAL_REMEDY_CODES = [
  'hang_up_the_handset',
  'delete_the_room_in_the_livekit_console',
  'scale_the_phone_worker_to_zero',
] as const;
