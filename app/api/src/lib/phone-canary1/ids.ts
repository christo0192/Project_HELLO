/**
 * lib/phone-canary1/ids.ts — three unrelated identifiers, none derived from
 * the destination and none derived from each other.
 *
 * ── WHY THREE, AND WHY THE THIRD ONE EXISTS AT ALL ────────────────────
 * The design's first revision claimed the canary passes "no attempt id".
 * That is unachievable at the seam: `PhoneOriginateRequest` requires an
 * `attemptId`, and `createLiveSipClient` derives the participant identity
 * `phone-<attemptId>` from it — an identity that lands in LiveKit room state
 * whatever we do. The honest claim is narrower and stronger for being true:
 * no attempt id reaches the WORKER, because the dispatch metadata has no field
 * for one.
 *
 * So a third identifier is minted and named for what it is:
 *
 *   * `sessionId`          — the room name `phone-<sessionId>`. NOT a
 *                            `call_sessions` row; nothing writes one.
 *   * `canaryId`           — eight hex characters, the worker's log handle.
 *   * `originateAttemptId` — the `attemptId` field the originate seam
 *                            requires, and the sole source of the participant
 *                            identity.
 *
 * It is emphatically NOT the session id. `phone.py` carries a docstring
 * recording that this lane has already shipped the session-id-in-the-
 * attempt-id-position bug once, and every event posted under it resolved to no
 * attempt at all. A test asserts the participant identity is derived from
 * `originateAttemptId` and provably from neither of the other two.
 *
 * ── DIGIT-RUN AVOIDANCE IS A CORRECTNESS PROPERTY, NOT A PRIVACY ONE ──
 * The worker refuses a canary metadata blob carrying a 7+ digit run. A uuid
 * segment is eight hex characters and is all-digits with probability
 * (10/16)^8 ≈ 2.3%, so across two uuids and a handle roughly one run in twelve
 * would be refused at random. That is how a real guard acquires a reputation
 * for flakiness and gets deleted.
 *
 * Minting therefore re-draws any identifier whose rendering would trip the far
 * end's rule. The inbound guard stays strict; the outbound side guarantees it
 * is satisfiable. Bounded, because an unbounded loop over a broken RNG is a
 * hang rather than a refusal.
 */

import { randomUUID } from 'node:crypto';
import { containsDigitRun } from './metadata.js';

export interface Canary1Ids {
  /** Names the room. Not a `call_sessions` row. */
  readonly sessionId: string;
  /** Eight hex characters. The worker's log handle, and nothing else. */
  readonly canaryId: string;
  /** The originate seam's required attempt id. Never sent to the worker. */
  readonly originateAttemptId: string;
}

/** How many re-draws before minting gives up. A broken RNG must refuse, not hang. */
export const CANARY1_ID_MINT_ATTEMPTS = 32;

/** Raised when the source of randomness cannot produce a usable identifier. */
export const CANARY1_ID_MINT_FAILED = 'canary_id_mint_failed';

/** Length of the log handle, in hex characters. */
export const CANARY1_HANDLE_LENGTH = 8;

function draw(uuid: () => string, project: (raw: string) => string): string {
  for (let attempt = 0; attempt < CANARY1_ID_MINT_ATTEMPTS; attempt += 1) {
    const candidate = project(uuid());
    if (!containsDigitRun(candidate)) return candidate;
  }
  throw new Error(CANARY1_ID_MINT_FAILED);
}

/**
 * Mint the three. `uuid` is injectable so a test can force a colliding draw
 * and prove the re-mint loop is real rather than decorative — a loop that has
 * never been observed to iterate is a loop nobody has tested.
 */
export function mintCanary1Ids(uuid: () => string = randomUUID): Canary1Ids {
  return {
    sessionId: draw(uuid, (raw) => raw),
    canaryId: draw(uuid, (raw) => raw.replace(/-/g, '').slice(0, CANARY1_HANDLE_LENGTH)),
    originateAttemptId: draw(uuid, (raw) => raw),
  };
}
