/**
 * lib/phone-canary1/preflight.ts — every refusal that must happen BEFORE a
 * seam is touched, and the arithmetic that makes the outermost bounds derived
 * rather than chosen.
 *
 * Each refusal reports `providerContacted: false`, and a test asserts that a
 * refused preflight leaves the injected SIP client, room client and dispatch
 * client with zero calls. "Refused before the seam" is a claim about call
 * counts, not about statement order in a file.
 *
 * ── WHY THE FIVE INEQUALITIES ARE CHECKED AND NOT ASSUMED ─────────────
 * `dial.ts` refuses `timeouts_misordered` rather than trusting two defaults to
 * stay ordered, with the reasoning written next to it: if the originate gives
 * up while the carrier is still ringing, the leg can STILL be answered
 * afterwards, landing a real person in a call whose dial we have written off.
 * The same hazard exists here and the same refusal answers it.
 *
 * The second inequality is the PR#66 class — a wait charged against a budget
 * sized for failure. The worker's participant-wait clock starts at job
 * assignment, before the originate, so dispatch scheduling, a cold worker start
 * and the whole ring window are charged against it. It must therefore exceed
 * the ring by a real margin, not merely be "large".
 *
 * The third inequality is why the CLI's wall clock is DERIVED. The wall clock
 * supervises the two bounds beneath it; choosing it independently is how a
 * healthy call gets cut off mid-sentence and the operator reads a provider
 * fault. `wall >= participant_wait + max_call + margin` makes the outermost
 * bound a consequence of the inner ones.
 *
 * The fourth and fifth are the same discipline applied to the room's own
 * `emptyTimeout` and to the pre-originate wait. Both are stated in full next
 * to the code that checks them, and both refuse rather than clamp: a bound
 * that silently moves is a bound nobody can reason about from a transcript.
 *
 * ── AND WHY THE CREDENTIAL GATE IS SEPARATE FROM THE TRUNK GATE ───────
 * `isLiveDialPermitted` speaks for the phone flags; `isPhoneTransportReady`
 * speaks for the trunk; the credentials are a third, independent question. An
 * operator who arms the dialer without configuring a trunk has made one
 * decision, not two — and each gets its own refusal so the terminal says which.
 *
 * No I/O, no clients, no environment reads.
 */

import {
  CANARY1_BOUNDS,
  CANARY1_ORIGINATE_MARGIN_SEC,
  CANARY1_PARTICIPANT_WAIT_MARGIN_SEC,
  CANARY1_WALL_CLOCK_MARGIN_SEC,
  canary1RoomEmptyTimeoutSeconds,
} from './plan.js';

/** Every stable refusal the preflight may produce, in the order it checks them. */
export const CANARY1_PREFLIGHT_REFUSALS = [
  'trunk_not_configured',
  'livekit_credentials_missing',
  'bounds_out_of_range',
  'timeouts_misordered',
  'waits_misordered',
  'bounds_misordered',
  'room_timeout_misordered',
  'origination_wait_misordered',
  'questions_out_of_range',
] as const;

export type Canary1PreflightRefusal = (typeof CANARY1_PREFLIGHT_REFUSALS)[number];

/** The check name each refusal reports under, so a PASS and a FAIL share a name. */
export const CANARY1_PREFLIGHT_CHECKS: Readonly<Record<Canary1PreflightRefusal, string>> =
  Object.freeze({
    trunk_not_configured: 'preflight_trunk_configured',
    livekit_credentials_missing: 'preflight_livekit_credentials',
    bounds_out_of_range: 'preflight_bounds_in_range',
    timeouts_misordered: 'preflight_timeouts_ordered',
    waits_misordered: 'preflight_waits_ordered',
    bounds_misordered: 'preflight_bounds_ordered',
    room_timeout_misordered: 'preflight_room_timeout_ordered',
    origination_wait_misordered: 'preflight_origination_wait_ordered',
    questions_out_of_range: 'preflight_questions_in_range',
  });

export interface Canary1TimeBounds {
  readonly ringSeconds: number;
  readonly originateTimeoutSeconds: number;
  readonly participantWaitSeconds: number;
  readonly joinWaitSeconds: number;
  /**
   * The room's `emptyTimeout`, in seconds. DERIVED by the caller from
   * `participantWaitSeconds` and passed in — see the fourth inequality below
   * for why it is an input rather than a recomputation.
   */
  readonly roomEmptyTimeoutSeconds: number;
  readonly maxCallSeconds: number;
  readonly wallClockSeconds: number;
  readonly questions: number;
}

export interface Canary1PreflightInput {
  readonly bounds: Canary1TimeBounds;
  readonly trunkId: string;
  readonly credentials: { readonly url: string; readonly apiKey: string; readonly apiSecret: string };
  readonly questionsAvailable: number;
}

export type Canary1PreflightResult =
  | { readonly ok: true; readonly providerContacted: false }
  | {
      readonly ok: false;
      readonly refusal: Canary1PreflightRefusal;
      readonly providerContacted: false;
    };

function refuse(refusal: Canary1PreflightRefusal): Canary1PreflightResult {
  return { ok: false, refusal, providerContacted: false };
}

/**
 * Run every pre-seam gate, in a fixed order, and stop at the first refusal.
 *
 * Fixed order matters for the operator: the terminal shows the checks that
 * passed and then the one that did not, so the first FAIL is always the thing
 * to fix. A "collect all failures" report would be friendlier and would also
 * make the transcript's meaning depend on how many things were wrong at once.
 */
export function runCanary1Preflight(input: Canary1PreflightInput): Canary1PreflightResult {
  const b = input.bounds;

  if (input.trunkId.trim() === '') return refuse('trunk_not_configured');

  if (
    input.credentials.url.trim() === ''
    || input.credentials.apiKey.trim() === ''
    || input.credentials.apiSecret.trim() === ''
  ) {
    return refuse('livekit_credentials_missing');
  }

  // ── RANGE BEFORE ORDER ──────────────────────────────────────────────
  // `CANARY1_BOUNDS` declares a `{def, min, max}` for every knob, and an
  // earlier revision read only `def` — so the ranges were decorative and an
  // operator flag was unbounded. `--max-call-seconds 3600` would have set a
  // one-hour ceiling on a live PSTN leg past a declared maximum of 300, and
  // `--participant-wait-seconds 500` would have been checked against a value
  // the worker never uses, because `phone.py` clamps that knob to [1, 180].
  // A declared range that nothing enforces is exactly the decorative control
  // this lane keeps deleting.
  //
  // Checked BEFORE the three inequalities so a nonsense value is reported as
  // out of range rather than as misordered — the refusal has to name the thing
  // the operator actually typed.
  for (const [name, value] of [
    ['ringSeconds', b.ringSeconds],
    ['originateTimeoutSeconds', b.originateTimeoutSeconds],
    ['participantWaitSeconds', b.participantWaitSeconds],
    ['joinWaitSeconds', b.joinWaitSeconds],
    ['maxCallSeconds', b.maxCallSeconds],
    ['wallClockSeconds', b.wallClockSeconds],
    // `roomEmptyTimeoutSeconds` is deliberately ABSENT from this loop: it is
    // not an operator knob and has no `{def,min,max}` to check against. Its
    // range IS the fourth inequality below, which is stronger than a static
    // window because it moves with the wait it must outlive.
    //
    // `questions` is deliberately ABSENT from this loop. Its real range is
    // 1..(the number of question texts that exist), which is checked below
    // against `questionsAvailable`. Checking it here too would make that
    // second guard unreachable while the copy holds three questions — a guard
    // that cannot fire reads as a safety net and is not one.
  ] as const) {
    const bound = CANARY1_BOUNDS[name];
    if (!Number.isSafeInteger(value) || value < bound.min || value > bound.max) {
      return refuse('bounds_out_of_range');
    }
  }

  // Mirrors `dial.ts` gate 1a. STRICTLY greater, not "greater or equal": an
  // originate that expires on the same tick the ring does is the same race.
  if (b.ringSeconds >= b.originateTimeoutSeconds) return refuse('timeouts_misordered');

  if (b.participantWaitSeconds < b.ringSeconds + CANARY1_PARTICIPANT_WAIT_MARGIN_SEC) {
    return refuse('waits_misordered');
  }

  if (
    b.wallClockSeconds
    < b.participantWaitSeconds + b.maxCallSeconds + CANARY1_WALL_CLOCK_MARGIN_SEC
  ) {
    return refuse('bounds_misordered');
  }

  // ── THE FOURTH AND FIFTH INEQUALITIES ───────────────────────────────
  // Their POSITION here must match their position in
  // `CANARY1_PREFLIGHT_REFUSALS` / `CANARY1_PREFLIGHT_CHECKS`, because the
  // passing lines are emitted in the record's INSERTION order while the
  // refusal order comes from the statement order in this function. The two
  // orders are the same transcript to an operator, so they are edited
  // together or the runbook's expected sequence stops being true.
  //
  // Fourth: the room must outlive the window in which we are still waiting for
  // the worker. `emptyTimeout` runs from room CREATION and the canary room is
  // created EMPTY, so a chosen value shorter than the join window means the
  // provider reaps the room while the CLI is still watching it — and the
  // observer then reports the same code an unarmed or scaled-to-zero worker
  // produces. Derived, so a raised `--participant-wait-seconds` cannot
  // silently re-open the gap.
  //
  // The value CHECKED is the one that will be passed to `createRoom`, not one
  // recomputed here. That is what makes this a real gate rather than a
  // tautology: comparing a derivation against itself can never fail, so the
  // caller supplies the number it is actually going to use and this compares
  // it against the minimum the join window demands. A future edit that
  // hardcodes the old flat 120 back into the room builder refuses HERE, before
  // a room exists — which is precisely the mutation that produced the defect.
  if (b.roomEmptyTimeoutSeconds < canary1RoomEmptyTimeoutSeconds(b.participantWaitSeconds)) {
    return refuse('room_timeout_misordered');
  }

  // Fifth: the pre-originate wait is CHARGED against the worker's own
  // participant wait, which starts at job assignment. If the CLI may spend
  // `joinWait` watching for the worker and then `ring` seconds ringing, the
  // worker must still be waiting when the leg is answered — otherwise it gives
  // up mid-ring, closes the room, and an answered handset hears nothing. That
  // is the exact failure the pre-originate wait exists to prevent, arriving
  // from the other side.
  //
  // The older `participantWait >= ring + PARTICIPANT_WAIT_MARGIN` above is
  // KEPT. It is the PR#66 repair, it still governs the dry run, and where
  // `joinWait + ORIGINATE_MARGIN >= PARTICIPANT_WAIT_MARGIN` this one
  // dominates anyway. Two inequalities that agree cost nothing; deleting the
  // older one "to avoid redundancy" would delete the reason it exists.
  if (
    b.participantWaitSeconds
    < b.joinWaitSeconds + b.ringSeconds + CANARY1_ORIGINATE_MARGIN_SEC
  ) {
    return refuse('origination_wait_misordered');
  }

  // Derived from the copy that exists, so it stays reachable from both ends:
  // 0 and 4 both fire today, and it starts refusing 3 the moment a question is
  // deleted from `CANARY1_QUESTIONS`.
  if (
    !Number.isSafeInteger(b.questions)
    || b.questions < 1
    || b.questions > input.questionsAvailable
  ) {
    return refuse('questions_out_of_range');
  }

  return { ok: true, providerContacted: false };
}

/**
 * The smallest wall clock that satisfies the third inequality for these inner
 * bounds. The runbook prints this next to `--ring-seconds` so an operator who
 * raises a bound is told what the outer one becomes, rather than discovering
 * it as a refusal.
 */
export function canary1MinimumWallClockSeconds(
  participantWaitSeconds: number,
  maxCallSeconds: number,
): number {
  return participantWaitSeconds + maxCallSeconds + CANARY1_WALL_CLOCK_MARGIN_SEC;
}
