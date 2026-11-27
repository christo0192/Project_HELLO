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
 * test that asserts the literal on `main`, and — since the activation work — by
 * a default-branch CI gate (`scripts/check-main-disarmed.mjs`) that fails
 * `main` if it is ever anything else. Arming lives on `canary1/arm`, a
 * reviewed, CI-green branch that is NEVER merged: there is no revert to
 * remember, because nothing is merged to revert.
 *
 * ── WHAT IT GATES, AND WHY THAT IS WIDER THAN THE DESIGN ASKED ────────
 * The accepted design gates `--execute` on this constant. This module gates
 * EVERY provider seam on it — the dry run's `createRoom` and `createDispatch`
 * included — because a `--dry-run` that can create a real LiveKit room is
 * still a merged PR that reaches a provider. The dry run is conducted from the
 * activation branch `canary1/arm` (operational sequence step 9), so nothing in
 * the intended sequence is lost, and the property PR105 can claim becomes the
 * stronger one: on `main`, this mechanism contacts nothing — permanently, not
 * until a window opens.
 *
 * No I/O, no imports, nothing to configure.
 */

/**
 * **`true` HERE, AND ONLY HERE.** This file is on `canary1/arm`, the reviewed,
 * CI-green **activation artifact that is NEVER MERGED**. It exists so the owner
 * can run the Canary-1 CLI from an isolated worktree of this branch for the
 * length of one supervised window, and for nothing else. Delete the branch when
 * the window closes.
 *
 * On `main` this constant is the literal `false`, always — INCLUDING while a
 * canary window is open — and `scripts/check-main-disarmed.mjs` fails the
 * default branch if it is ever anything else. That gate lives on `main` and
 * this branch never edits it, which is why flipping the in-suite pin (§9 of
 * `phone-canary1-structural.test.ts`) alongside this line makes this branch's
 * own pull request green without buying the branch any route onto `main`. A
 * test the artifact can rewrite is not a gate against the artifact; the gate
 * that is, does not travel here. There is no prepared revert, because nothing
 * is merged to revert.
 *
 * **The pre-merge control is that this branch's pull request is a DRAFT.**
 * GitHub refuses to merge a draft outright, and that is the only pre-merge
 * control this repository actually holds: it has **no branch protection** and
 * `quality` is **not** a required status check (observed), so a red check
 * reports an accidental merge rather than preventing one. Never mark the pull
 * request ready for review — there is nothing to review it into.
 *
 * Typed as `boolean` rather than inferred as the literal `true`, so the arming
 * check downstream stays a real branch the compiler does not fold away — the
 * annotation is load-bearing in both directions, and is what keeps arming and
 * disarming a one-token change to this line.
 */
export const CANARY1_ARMED: boolean = true;

/** The stable refusal code emitted when the constant is `false`. */
export const CANARY1_NOT_ARMED = 'canary1_not_armed';
