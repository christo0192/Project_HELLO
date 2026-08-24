/**
 * lib/phone-canary1/metadata.ts — the canary's OWN room and dispatch builders.
 *
 * ── WHY NOT REUSE THE PRODUCTION BUILDERS ─────────────────────────────
 * `buildPhoneRoomMetadata` and `buildPhoneDispatchMetadata` are literal
 * closed-key constructors, and a structural test asserts their key sets. That
 * is what makes "a real candidate's room can never be read as a canary"
 * checkable rather than merely intended: production physically cannot emit
 * `canary` or `mode`, so no amount of drift on this side can produce a
 * collision. Adding an optional key to them would spend exactly that property.
 *
 * So the canary gets its own builders, and the two key sets are asserted
 * DISJOINT-BY-CONSTRUCTION in both directions.
 *
 * ── WHAT IS ABSENT FROM THE DISPATCH IS THE STRONGEST CONTROL ─────────
 * The dispatch metadata carries NO `attempt_id` and NO `epoch`. On the shipped
 * worker that dispatch is INERT: `_run_phone_entrypoint` refuses
 * `phone_dispatch_unresolved` and returns BEFORE `ctx.connect()`. Disarmed,
 * mis-deployed or rolled back, this mechanism degrades to "a room nobody
 * speaks in".
 *
 * That control is narrowed, not preserved, by PR105: the canary branch is a
 * new path to connect-and-speak that does not require an attempt id. What
 * keeps it unreachable from a real candidate is the worker's three-condition
 * gate plus the closed production key sets above — and the disarm lifecycle is
 * the residual that follows.
 *
 * ── THE OUTBOUND HALF OF THE DIGIT-RUN AGREEMENT ──────────────────────
 * The worker refuses any canary blob whose serialized form carries a 7+ digit
 * run — the shape of a dialable number. A uuid segment is eight hex characters
 * and MAY legitimately be all digits (`11111111-…`), so that guard would
 * otherwise refuse a few percent of honest runs at random. A guard that fires
 * on correct input is a guard that gets deleted.
 *
 * The fix is on this side: `ids.ts` re-mints any identifier whose rendering
 * would trip the guard, and these builders REFUSE to emit a blob that trips it
 * rather than shipping one the far end will reject. The strict inbound rule
 * therefore stays strict, and both ends agree by construction instead of by
 * coincidence.
 *
 * No I/O, no imports outside this package.
 */

import type { Canary1Ids } from './ids.js';

/** The channel marker. The SAME value production uses — a canary room IS a phone room. */
export const CANARY1_ROOM_CHANNEL = 'phone';

/** Room metadata key set. Closed, ordered, asserted. */
export const CANARY1_ROOM_METADATA_KEYS = [
  'session_id',
  'room_name',
  'channel',
  'canary',
] as const;

/** Dispatch metadata key set. Closed, ordered, asserted. NOTE what is absent. */
export const CANARY1_DISPATCH_METADATA_KEYS = [
  'session_id',
  'channel',
  'mode',
  'canary_id',
] as const;

/**
 * The shape of a dialable number, and the exact rule the worker's inbound
 * guard applies. Mirrored rather than re-invented: 0042's metadata sanitizer
 * and `phone.py`'s `_DIGIT_RUN_RE` both use this run length.
 */
export const CANARY1_DIGIT_RUN_RE = /\d{7,}/;

/** Raised when a builder would emit a blob the far end is required to refuse. */
export const CANARY1_METADATA_DIGIT_RUN = 'canary_metadata_digit_run';

/** True when this text carries a run of seven or more decimal digits. */
export function containsDigitRun(value: string): boolean {
  return CANARY1_DIGIT_RUN_RE.test(value);
}

/** The canary room name. Identical in shape to production's, so both channel signals agree. */
export function canary1RoomName(sessionId: string): string {
  return `phone-${sessionId}`;
}

/**
 * Serialize and refuse in one place, so neither builder can forget the check.
 * Throws a BARE code: an interpolated blob in an error message is a leak, and
 * the containment layer discards error objects anyway.
 */
function serializeOrRefuse(payload: Record<string, unknown>): string {
  const blob = JSON.stringify(payload);
  if (containsDigitRun(blob)) throw new Error(CANARY1_METADATA_DIGIT_RUN);
  return blob;
}

/**
 * Room metadata. Four closed keys, every value opaque or literal, `canary`
 * a literal `true` rather than a parsed flag.
 */
export function buildCanary1RoomMetadata(ids: Canary1Ids): string {
  return serializeOrRefuse({
    session_id: ids.sessionId,
    room_name: canary1RoomName(ids.sessionId),
    channel: CANARY1_ROOM_CHANNEL,
    canary: true,
  });
}

/**
 * Dispatch metadata. Four closed keys — and no attempt id, no epoch, no
 * candidate id, no number, and nothing derived from one.
 *
 * `originateAttemptId` deliberately does NOT appear. It exists, because
 * `PhoneOriginateRequest` requires an attempt id to derive the participant
 * identity from, but it never reaches the worker and the worker has no way to
 * ask for it. The load-bearing claim is "no attempt id IN THE DISPATCH
 * METADATA", which is the true form.
 */
export function buildCanary1DispatchMetadata(ids: Canary1Ids, mode: string): string {
  return serializeOrRefuse({
    session_id: ids.sessionId,
    channel: CANARY1_ROOM_CHANNEL,
    mode,
    canary_id: ids.canaryId,
  });
}
