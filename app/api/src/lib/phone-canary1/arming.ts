/**
 * lib/phone-canary1/arming.ts — the constant that decides whether this
 * mechanism may touch a provider at all.
 *
 * ── WHY A SOURCE CONSTANT AND NOT AN ENVIRONMENT VARIABLE ─────────────
 * Every other switch in this lane is an environment variable, deliberately:
 * an operator can flip one without a deploy, and `phone-screening/config.ts`
 * exists to read them safely. This one is the opposite on purpose.
 *
 * PR105 ships the whole Canary-1 mechanism — the hidden-entry CLI, the
 * originate seam, the room and dispatch builders, the teardown — and ships it
 * MERGEABLE. A reviewer must be able to answer "can this branch place a call?"
 * by reading one line of source, not by reasoning about which environment a
 * future deploy might carry. An environment variable would make the answer
 * "not today", which is not the same claim.
 *
 * So the predicate is a compile-time constant, shipped `false`, pinned by a
 * test that asserts the literal on `main`. Arming it is PR106: a diff, a
 * review, and a revert commit prepared before the run.
 *
 * ── WHAT IT GATES, AND WHY THAT IS WIDER THAN THE DESIGN ASKED ────────
 * The accepted design gates `--execute` on this constant. This module gates
 * EVERY provider seam on it — the dry run's `createRoom` and `createDispatch`
 * included — because a `--dry-run` that can create a real LiveKit room is
 * still a merged PR that reaches a provider. The dry run happens after PR106
 * arms the constant (operational sequence step 6), so nothing in the intended
 * sequence is lost, and the property PR105 can claim becomes the stronger one:
 * on `main`, this mechanism contacts nothing.
 *
 * No I/O, no imports, nothing to configure.
 */

/**
 * `false` on `main`, always. PR106 flips it and flips the pin test with it;
 * merging PR106's prepared revert flips both back.
 *
 * Typed as `boolean` rather than inferred as the literal `false`, so the
 * arming check downstream is a real branch the compiler does not fold away —
 * an `if (false)` narrowed to `never` would delete the armed path from the
 * emitted program and make every test of it unreachable.
 */
export const CANARY1_ARMED: boolean = false;

/** The stable refusal code emitted when the constant is `false`. */
export const CANARY1_NOT_ARMED = 'canary1_not_armed';
