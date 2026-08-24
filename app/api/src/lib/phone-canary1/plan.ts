/**
 * lib/phone-canary1/plan.ts — the fixed copy and the six nested bounds, and
 * the TypeScript half of the two-sided cross-language pin.
 *
 * ── WHY THE COPY IS HERE AND NOT ON THE WIRE ──────────────────────────
 * The canary's spoken lines are constants in `app/voice-livekit/phone_canary.py`
 * and constants here, compared byte-for-byte by
 * `phone-canary1-cross-language.test.ts`. They are deliberately NOT sent over
 * the dispatch metadata: metadata is a channel other readers can see, it is
 * length-bounded, and it is parsed by a guard that refuses digit runs. Fixed
 * copy belongs in source, where a reviewer reads it and a diff shows a change.
 *
 * ── WHY THE COPY DOES NOT NAME A NUMBER OF QUESTIONS ──────────────────
 * It used to say "two short questions". `PHONE_CANARY_QUESTIONS` admits 1..3
 * and `--questions` accepts the same range, so the line was false whenever the
 * operator asked for anything but two — and this is the one place a
 * configuration mismatch becomes a SPOKEN FALSEHOOD to a person on a telephone.
 * The copy is now true for every admissible count. It is also what goes to
 * TEL-04 as written, which is the other reason it must not depend on a knob.
 *
 * The pin is BUILT here rather than inherited. The design's first revision
 * cited `HEARTBEAT_PATH` as an existing two-sided pin; it is not one — the
 * Python side is asserted only by a prefix check and the TypeScript side
 * hardcodes the literal separately, so the two can drift without anything
 * going red. This file's constants are compared against the Python source
 * text itself.
 *
 * ── WHY THE DISCLOSURE IS NOT `PHONE_DISCLOSURE_TEXT` ─────────────────
 * The production disclosure says the call IS recorded, because a production
 * screening is. This call is not, so reusing that copy would make the system
 * say something false. That is also why the canary copy needs its own TEL-04
 * approval and why the approval is ordered AFTER the `record=` control is in
 * place: approving copy the system does not honour is worse than approving
 * none.
 *
 * No I/O, no imports.
 */

/** The `scenario` field every emitted verdict line carries. */
export const CANARY1_SCENARIO = 'canary1';

/** The dispatch metadata `mode` value that selects the worker's canary branch. */
export const CANARY1_DISPATCH_MODE = 'canary';

/**
 * The named worker the canary dispatches into. The SAME worker production
 * would dispatch, on purpose: a canary that ran against a second worker would
 * prove nothing about the one that will take the real call.
 */
export const CANARY1_DEFAULT_AGENT_NAME = 'phone-screener';

/**
 * SEVEN NESTED BOUNDS, none inherited from a provider default.
 *
 *   ring          <  originate                       (mirrors `dial.ts` gate 1a)
 *   participant wait >= ring + PARTICIPANT_WAIT_MARGIN
 *   wall clock    >= participant wait + max call + WALL_CLOCK_MARGIN
 *   room empty timeout == participant wait + PARTICIPANT_WAIT_MARGIN + ROOM_EMPTY_MARGIN
 *   participant wait >= join wait + ring + ORIGINATE_MARGIN
 *
 * The second relation exists because the worker's participant-wait clock
 * starts at JOB ASSIGNMENT — before the originate — so dispatch scheduling, a
 * cold worker start and the whole ring window are all charged against it. At
 * the production default of 45 s that wait can expire on the HEALTHY path, and
 * the failure reads to an operator as a provider fault. That is a wait charged
 * against a budget sized for failure, which this lane has already shipped once
 * and repaired once.
 *
 * The third relation is why the outermost bound is DERIVED rather than chosen.
 * With a 120 s wait and a 180 s call ceiling, a participant answering late in
 * the wait window is still talking at t=300; a 240 s wall clock would tear the
 * room down mid-sentence and produce exactly the failure signature the second
 * relation exists to eliminate.
 *
 * The FOURTH relation applies the same discipline to the room's own
 * `emptyTimeout`, which used to be a chosen 120 while the join window is
 * `participantWait + 60` = 180. LiveKit's `empty_timeout` runs from room
 * CREATION, and the canary room is created empty and stays empty until the
 * agent joins — unlike a production room, which is dialled within seconds. So
 * between t=120 and t=180 the provider could reap the room while the CLI was
 * still waiting for it, and the observer reported the same code it reports for
 * an unarmed or scaled-to-zero worker. The timeout is now DERIVED from the
 * wait it must outlive (`canary1RoomEmptyTimeoutSeconds`) and the preflight
 * refuses `room_timeout_misordered` if a raised wait ever re-opens the gap.
 *
 * The FIFTH relation exists because the `--execute` path now waits for the
 * worker BEFORE it originates, and that wait is not free: the worker's
 * participant-wait clock starts at JOB ASSIGNMENT, before the originate, so
 * every second spent watching for the worker is a second subtracted from the
 * window in which it will still be waiting when the leg is answered. A naive
 * "just wait for the worker first" consumes the resource it is protecting, and
 * the failure is the SAME silent answered call it was meant to prevent,
 * arriving from the other side. Hence
 * `participantWait >= joinWait + ring + ORIGINATE_MARGIN`, refused as
 * `origination_wait_misordered`.
 */
export const CANARY1_BOUNDS = {
  /** How long the line may ring before it is a no-answer. */
  ringSeconds: { def: 30, min: 5, max: 60 },
  /** How long the originate CALL may block. Must strictly exceed the ring. */
  originateTimeoutSeconds: { def: 60, min: 10, max: 90 },
  /** The worker's own wait for "something answered". Its own knob, not the production 45 s. */
  participantWaitSeconds: { def: 120, min: 90, max: 180 },
  /**
   * How long the CLI waits for the named worker to appear in the room BEFORE
   * it originates. Its own knob because it is charged against the worker's
   * participant wait — see the fifth relation above.
   *
   * The floor is 30 because a cold job process is bounded by
   * `initialize_process_timeout: 60.0` with `num_idle_processes: 0`, so
   * anything tighter would be dishonest. The ceiling is 150 because at
   * `participantWaitSeconds`'s maximum of 180 the fifth relation affords
   * `180 - 15 - ring`, i.e. 160 at the minimum ring of 5 — so 150 sits just
   * inside the feasible region. It is deliberately NOT satisfiable at the
   * default ring of 30 (`150 + 30 + 15 = 195 > 180`), and the preflight
   * refuses that combination rather than quietly accepting it: a knob whose
   * maximum is reachable only for some settings of another knob is exactly
   * why the relation is checked instead of assumed.
   */
  joinWaitSeconds: { def: 60, min: 30, max: 150 },
  /** Hard ceiling on a CONNECTED call. An unset billable ceiling is an omission. */
  maxCallSeconds: { def: 180, min: 30, max: 300 },
  /** The outermost CLI clock, after which teardown runs regardless. DERIVED — see above. */
  wallClockSeconds: { def: 330, min: 120, max: 900 },
  /**
   * How many of the fixed questions the worker is expected to ask. The range
   * matches `phone.py`'s clamp on `PHONE_CANARY_QUESTIONS`, and the CLI's real
   * upper bound is the number of question texts that exist — see
   * `questions_out_of_range`.
   */
  questions: { def: 2, min: 1, max: 3 },
} as const;

/** `participant wait >= ring + this`. Covers dispatch scheduling and a cold worker start. */
export const CANARY1_PARTICIPANT_WAIT_MARGIN_SEC = 60;

/** `wall clock >= participant wait + max call + this`. Covers teardown itself. */
export const CANARY1_WALL_CLOCK_MARGIN_SEC = 30;

/**
 * `participant wait >= join wait + ring + this`. Covers the gap between job
 * assignment and the join we can OBSERVE, plus the originate call itself.
 */
export const CANARY1_ORIGINATE_MARGIN_SEC = 15;

/**
 * Added on top of the join window when deriving the room's `emptyTimeout`.
 * Covers the observer's poll interval and the teardown itself.
 */
export const CANARY1_ROOM_EMPTY_MARGIN_SEC = 30;

/**
 * How long an EMPTY canary room survives, so a room outlives every process we
 * control — DERIVED from the join window rather than chosen.
 *
 * The cost is stated rather than buried: an empty canary room now survives
 * 120 + 60 + 30 = 210 s at the defaults, and 180 + 60 + 30 = 270 s at
 * `participantWaitSeconds`'s ceiling, rather than a flat 120, after every
 * process we control has exited. An empty room holds no leg and costs nothing;
 * a room reaped mid-wait destroys the evidence the whole window exists to
 * produce. It is a trade, and it is the right way round.
 */
export function canary1RoomEmptyTimeoutSeconds(participantWaitSeconds: number): number {
  return participantWaitSeconds
    + CANARY1_PARTICIPANT_WAIT_MARGIN_SEC
    + CANARY1_ROOM_EMPTY_MARGIN_SEC;
}

/** One SIP leg and one agent. Nothing else has a role on this call. */
export const CANARY1_ROOM_MAX_PARTICIPANTS = 2;

/**
 * THE CANARY DISCLOSURE. Distinct copy, pending TEL-04 approval in its own
 * right, and true only while the canary session starts with recording off and
 * no attempt row exists for it. Both are asserted; see `phone_canary.py`.
 */
export const CANARY1_DISCLOSURE_TEXT =
  "This is an automated test call from Interview Kickstart's screening system, "
  + 'placed by the system owner to their own number. No candidate is involved, '
  + 'this call is not being recorded, and nothing you say is stored. '
  + "I'll ask a few short questions to check the audio and then hang up.";

/**
 * The fixed questions. Three are defined; the worker asks the first
 * `PHONE_CANARY_QUESTIONS` of them.
 *
 * They are open enough to produce a real answer — the point is to exercise
 * turn-taking, barge-in, latency and the model responding to something it did
 * not script — and closed enough to be safe to speak to a handset.
 */
export const CANARY1_QUESTIONS = [
  'First, can you hear me clearly, and is there any echo or delay on the line?',
  'Second, please say todays day of the week and describe the weather where you are.',
  'Third, please count slowly from one to five so I can check the audio end to end.',
] as const;

/** The closing line. Claims nothing about a recording, because there is none. */
export const CANARY1_CLOSING_TEXT =
  'That is everything I needed. Thanks for taking the test call. Goodbye.';

/** Every fixed line the canary may speak, in the order it may speak them. */
export const CANARY1_SPOKEN_COPY: readonly string[] = [
  CANARY1_DISCLOSURE_TEXT,
  ...CANARY1_QUESTIONS,
  CANARY1_CLOSING_TEXT,
];

/**
 * The four environment variables PR105 introduces, all on the `voice-livekit`
 * component and none on the API. Declared here so the cross-language pin and
 * the environment contract speak about one list.
 */
export const CANARY1_WORKER_ENV_VARS = [
  'PHONE_CANARY_ENABLED',
  'PHONE_CANARY_MAX_CALL_SEC',
  'PHONE_CANARY_PARTICIPANT_WAIT_SEC',
  'PHONE_CANARY_QUESTIONS',
] as const;
