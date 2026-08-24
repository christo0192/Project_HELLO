#!/usr/bin/env node
// Default-branch gate: `main` must never carry an ARMED Canary-1 constant.
//
// ── THE ACCIDENT THIS GUARDS ──────────────────────────────────────────────
// Canary-1 arming does not live on `main`. It lives on `canary1/arm`, a
// reviewed, CI-green activation branch that flips
// `app/api/src/lib/phone-canary1/arming.ts` from
//
//     export const CANARY1_ARMED: boolean = false;
//   to
//     export const CANARY1_ARMED: boolean = true;
//
// and is NEVER merged. The whole safety property of PR105 — "on main, this
// mechanism contacts no provider, permanently" — rests on that branch staying
// unmerged. The accident is therefore exactly one thing: somebody merges the
// activation artifact anyway (a stray "merge the canary branch" during a
// window, an auto-merge, a well-meaning cleanup of an old branch).
//
// ── WHY THE EXISTING PIN CANNOT CATCH IT ──────────────────────────────────
// `app/api/src/__tests__/phone-canary1-structural.test.ts` §9 already pins the
// literal `false`. That pin CANNOT catch this accident, because the pin TRAVELS
// WITH THE BRANCH: the activation artifact flips the constant and flips the pin
// in the same commit, so the artifact is green, and a merge of the artifact
// brings the inverted pin along and is green too. A test that the artifact can
// rewrite is not a gate against the artifact.
//
// This gate does not travel. It lives on `main`, it is never edited by the
// activation branch, and it asks exactly one question about `main`: is the
// constant still `false`? The workflow runs it on the DEFAULT BRANCH ONLY, so
// the artifact's own PR stays green (it must — it is a legitimate, reviewable
// branch) while a MERGE of that artifact turns `main` red immediately.
//
// ── HOW TO RUN IT BY HAND ─────────────────────────────────────────────────
//     node scripts/check-main-disarmed.mjs
//
// `ARMING_PATH` is exported as a REPO-RELATIVE string because that is the
// contract the wiring test asserts about. The direct run, however, resolves it
// against this script's own location rather than the process cwd, so running it
// from any directory behaves identically — an operator reaching for this during
// an incident should not have to be standing in the repo root for it to be
// truthful. (`runbook §4b` is the manual path.)
//
// Dependency-free: node builtins only.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/** Repo-relative, by contract — the wiring test asserts this path exists. */
export const ARMING_PATH = "app/api/src/lib/phone-canary1/arming.ts";

/**
 * The disarmed literal, matched exactly as `arming.ts` declares it. The
 * explicit `: boolean` annotation is part of the pattern on purpose: it is
 * load-bearing in the source (it stops TypeScript folding `if (CANARY1_ARMED)`
 * to `never` and deleting the armed path from the emitted program), so a
 * silent removal of the annotation should be noticed here, not shrugged at.
 */
export const DISARMED_RE = /export const CANARY1_ARMED:\s*boolean\s*=\s*false;/;

/** Pure. Exported so the wiring test can prove it goes red WITHOUT reading the tree. */
export function isCanary1Disarmed(source) {
  return DISARMED_RE.test(source);
}

// ── RUN-AS-MAIN GUARD ─────────────────────────────────────────────────────
// Load-bearing, not hygiene: the wiring test imports this module and runs on
// EVERY PR, including the activation artifact's own PR. If importing it read
// arming.ts, the artifact's PR would go red — and the first fix anyone reaches
// for is deleting the gate.
//
// `process.argv[1]` is UNDEFINED under `node -e` / `node --eval`, and
// pathToFileURL(undefined) throws. Without the first conjunct, any eval-context
// import throws FROM INSIDE THE GATE — and the line the operator then deletes to
// make the error go away is the one keeping the artifact's PR green.
//
// ── AND WHY THE URL COMPARISON IS NOT THE ONLY CONDITION ──────────────────
// A guard that can silently decline to run is a guard that evaluated nothing:
// under a symlinked path or a wrapper invocation the URL comparison can fail to
// match even though this file IS the entry point, and the module would then
// import, assert nothing, print nothing and exit 0 — a GREEN step that ran no
// gate. The second condition catches exactly that case by asking a different
// question of the same fact: is the process's entry point this FILE, by name?
// It cannot be true for the wiring test (whose entry point is
// `check-main-disarmed.test.mjs`) or for any eval context (no `argv[1]`), so
// the artifact's PR stays green.
//
// The workflow step is the other half: it asserts the verdict line below is
// actually printed, so "the gate ran" is evidence rather than an inference from
// an exit code that a no-op also produces.
const entry = process.argv[1];
const isEntryModule = entry !== undefined
  && import.meta.url === pathToFileURL(entry).href;
const isEntryFileByName = entry !== undefined
  && path.basename(entry) === "check-main-disarmed.mjs";
if (isEntryModule || isEntryFileByName) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!isCanary1Disarmed(readFileSync(path.join(repoRoot, ARMING_PATH), "utf8"))) {
    console.error(
      "main carries an ARMED Canary-1 constant. The activation artifact "
      + "(canary1/arm) must never be merged. If it was: revert that commit now, "
      + "delete the branch, and confirm `fly secrets list` shows no "
      + "PHONE_CANARY_ENABLED on project-hello-phone-voice."
    );
    process.exit(1);
  }
  console.log("main disarmed OK");
}
