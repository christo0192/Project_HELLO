#!/usr/bin/env node
// Wiring test for scripts/check-main-disarmed.mjs — runs on EVERY PR.
//
// The gate it guards (`check-main-disarmed.mjs`) runs on the DEFAULT BRANCH
// ONLY: it fails `main` if `app/api/src/lib/phone-canary1/arming.ts` ever
// carries an ARMED Canary-1 constant, which is what a merge of the never-merged
// activation branch `canary1/arm` would do. That asymmetry is deliberate — the
// activation artifact's own PR must stay green, and a MERGE of it must turn
// `main` red — but it has a cost: on a pull request nothing evaluates the gate,
// so nothing would notice if it were unwired, deleted, or quietly made
// conditional.
//
// This file is the other half. It runs unconditionally on pull requests and
// proves the WIRING **without ever evaluating the armed assertion against the
// tree**. It never reads `arming.ts` for a verdict; it imports the gate's pure
// predicate and drives it with FIXTURES.
//
// The second assertion is the point of the whole file: a SEEDED-RED CONTROL on
// a fixture, running on every PR. The gate is proved to bite without anyone
// having to arm a branch to find out — a control that only fires during a real
// incident is not a control, it is a hope.
//
// Assertions 4-8 read `.github/workflows/quality.yml` as text (no YAML
// dependency is available here), locating each step block by its `run:` body
// and inspecting the SIBLING KEYS of that same list item — so a guard added or
// removed on the correct step is seen, and a lookalike string elsewhere in the
// file is not mistaken for one. Each block also carries the NAME OF THE JOB it
// belongs to, because a step moved into a different (or never-triggered) job
// would otherwise satisfy every assertion about the step itself.
//
// Assertion 7 is the one the rest depend on and nothing else in the repository
// makes: the gate's `if:` is only ever TRUE on a push to the default branch, so
// if `quality.yml`'s `on:` block loses that trigger the gate becomes
// permanently vacuous — every PR stays green, this wiring test stays green, and
// `main` is silently unguarded. That is the "a safety assertion that cannot
// fire when the guarded thing changes" class this lane keeps paying for, so the
// trigger is pinned here alongside the guard that reads it.
//
// CHECK_MAIN_DISARMED_WORKFLOW: optional path override for the workflow file,
// used only to drive this file's own red controls against a mutated copy. It
// defaults to the real workflow, so CI — which never sets it — is unaffected.
//
// Dependency-free: node builtins only.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ARMING_PATH, isCanary1Disarmed } from "./check-main-disarmed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wfPath = process.env.CHECK_MAIN_DISARMED_WORKFLOW
  ? path.resolve(process.env.CHECK_MAIN_DISARMED_WORKFLOW)
  : path.join(root, ".github/workflows/quality.yml");

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// ── 1-2. The predicate, on fixtures. Green control, then RED control. ─────
ok(isCanary1Disarmed("export const CANARY1_ARMED: boolean = false;") === true,
  "the disarmed literal must be recognised as disarmed — the gate would fail main forever otherwise");
ok(isCanary1Disarmed("export const CANARY1_ARMED: boolean = true;") === false,
  "SEEDED-RED CONTROL FAILED: the gate accepted an ARMED constant. It cannot catch a merge of "
  + "canary1/arm and must be repaired, not deleted.");

// ── 3. The path the gate reads is the file that actually exists ───────────
ok(existsSync(path.join(root, ARMING_PATH)),
  `ARMING_PATH names a file that does not exist: ${ARMING_PATH}. A gate pointed at a missing `
  + "file is not a gate — it would read as green on a tree with no arming constant at all.");

// ── Step-block parsing: locate a list item by its `run:` line ─────────────
// Anchored to the indentation of the `steps:` key, so a `- ` line inside a
// multi-line `run: |` body (deeper indent) can never be mistaken for a step.
const wf = readFileSync(wfPath, "utf8");
const wfLines = wf.split("\n");

function stepBlocks(lines) {
  const blocks = [];
  let itemIndent = null;
  let cur = null;
  let inJobs = false;
  let job = null;
  const indentOf = (l) => l.match(/^(\s*)/)[1].length;
  for (const line of lines) {
    // Job tracking: a job key is a two-space-indented mapping key under the
    // top-level `jobs:`. Recorded so a step can be attributed to the job that
    // actually runs it.
    if (/^jobs:\s*$/.test(line)) { inJobs = true; job = null; continue; }
    if (inJobs && /^\S/.test(line)) { inJobs = false; job = null; }
    if (inJobs) {
      const jobKey = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      if (jobKey) {
        if (cur) { blocks.push(cur); cur = null; }
        itemIndent = null;
        job = jobKey[1];
      }
    }
    const stepsKey = line.match(/^(\s*)steps:\s*$/);
    if (stepsKey) {
      if (cur) { blocks.push(cur); cur = null; }
      itemIndent = stepsKey[1].length + 2;
      continue;
    }
    if (itemIndent === null) continue;
    if (line.trim() === "") { if (cur) cur.lines.push(line); continue; }
    const ind = indentOf(line);
    if (ind === itemIndent && /^\s*- \S/.test(line)) {
      if (cur) blocks.push(cur);
      // Normalise the "- " marker into a plain key line so sibling-key
      // matching below treats the first key like any other.
      cur = { job, lines: [" ".repeat(itemIndent + 2) + line.slice(itemIndent + 2)] };
      continue;
    }
    if (ind > itemIndent) { if (cur) cur.lines.push(line); continue; }
    if (cur) { blocks.push(cur); cur = null; }
    if (ind < itemIndent) itemIndent = null;
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ job: b.job, text: b.lines.join("\n") }));
}

/** The value of a top-level sibling key of one step, or null when absent. */
function stepKey(block, key) {
  const m = block.text.match(new RegExp(`^\\s*${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

// Matched anywhere in the step's body rather than only on a single-line `run:`,
// because the gate step's `run:` is a multi-line block that asserts the gate's
// verdict LINE (see assertion 8). The negative lookahead is what keeps
// `check-main-disarmed.mjs` from also matching `check-main-disarmed.test.mjs`.
const blocks = stepBlocks(wfLines);
const gateBlocks = blocks.filter((b) => /node scripts\/check-main-disarmed\.mjs(?![\w.])/.test(b.text));
const wiringBlocks = blocks.filter((b) => /node scripts\/check-main-disarmed\.test\.mjs(?![\w.])/.test(b.text));

// ── 4. The gate is invoked at all ─────────────────────────────────────────
ok(gateBlocks.length === 1,
  `expected exactly one quality.yml step running \`node scripts/check-main-disarmed.mjs\` `
  + `(found ${gateBlocks.length}). Without it the default branch is unguarded.`);

// ── 5. Its `if:` is EXACTLY the push-to-main guard ────────────────────────
// Asserted as text, and asserted NOT to be any of the ways this guard rots:
// widened to always(), stubbed to true, or deleted so the gate runs on the
// activation artifact's own PR (which would make the artifact's PR red and the
// gate the obvious thing to delete).
const PUSH_TO_MAIN = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
if (gateBlocks.length === 1) {
  const guard = stepKey(gateBlocks[0], "if");
  ok(guard !== null,
    "the disarm gate step has NO `if:` guard — it would then run on every pull request, including "
    + "canary1/arm's own PR, turning a legitimate review branch red.");
  ok(guard === PUSH_TO_MAIN,
    `the disarm gate's guard must be exactly \`${PUSH_TO_MAIN}\`; found \`${guard}\`.`);
  ok(guard !== "always()" && !/\balways\(\)/.test(guard || ""),
    "the disarm gate's guard must not be always() — that runs it on pull requests too.");
  ok(guard !== "true" && guard !== "${{ true }}",
    "the disarm gate's guard must not be a stubbed-true condition.");
}

// ── 6. The wiring check itself is unconditional ───────────────────────────
// If THIS step could be made conditional, everything above could be switched
// off in one line without any check going red.
ok(wiringBlocks.length === 1,
  `expected exactly one quality.yml step running \`node scripts/check-main-disarmed.test.mjs\` `
  + `(found ${wiringBlocks.length}). Without it nothing on a pull request proves the gate is wired.`);
if (wiringBlocks.length === 1) {
  ok(stepKey(wiringBlocks[0], "if") === null,
    "the disarm-gate WIRING step must carry no `if:` guard — a conditional wiring check can be "
    + "switched off in one line, and then nothing on a PR proves the gate still exists.");
}

// ── 7. The TRIGGER that makes the gate's guard reachable at all ──────────
// The guard asserted in 5 is only ever true for `on: push: branches: [main]`.
// Delete or narrow that trigger and the gate never runs again: it is skipped on
// every pull request by design, so nothing goes red, this file stays green, and
// the default branch is unguarded. Nothing else in the repository reads
// `quality.yml`, so if it is not pinned here it is not pinned.
const onBlock = (() => {
  const start = wfLines.findIndex((l) => /^on:\s*$/.test(l));
  if (start === -1) return null;
  const rest = wfLines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
})();
ok(onBlock !== null,
  "quality.yml has no top-level `on:` block — the workflow's triggers cannot be verified, and the "
  + "disarm gate's push-to-main guard may never be reachable.");
if (onBlock !== null) {
  ok(/^\s*push:\s*$/m.test(onBlock),
    "quality.yml's `on:` block has no `push:` trigger. The disarm gate's `if:` tests "
    + "`github.event_name == 'push'`, so without it the gate is permanently skipped — green "
    + "everywhere, guarding nothing.");
  ok(/^\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\]\s*$/m.test(onBlock)
    || /^\s*-\s*main\s*$/m.test(onBlock),
    "quality.yml's push trigger does not include `main`. The disarm gate's `if:` tests "
    + "`github.ref == 'refs/heads/main'`, so the gate would never run on the branch it exists to "
    + "guard.");
}

// ── 8. The gate lives in the `quality` job, and its run asserts the VERDICT ─
// A step moved into a different job — or into one that never runs for this
// event — satisfies every assertion about the step itself while evaluating
// nothing. And a gate module that declines to run its assertion exits 0 too, so
// the exit code alone cannot distinguish a pass from a no-op: the step must
// require the verdict line.
const GATE_JOB = "quality";
const GATE_VERDICT = "main disarmed OK";
if (gateBlocks.length === 1) {
  ok(gateBlocks[0].job === GATE_JOB,
    `the disarm gate step must live in the \`${GATE_JOB}\` job; found `
    + `\`${gateBlocks[0].job}\`. A step in another job can be skipped, gated or never triggered `
    + "while every assertion about the step itself still passes.");
  ok(gateBlocks[0].text.includes(GATE_VERDICT),
    `the disarm gate step must assert the gate's verdict line (\`${GATE_VERDICT}\`). Exit code 0 `
    + "is also what a module that evaluated NOTHING returns, so the exit code alone is not "
    + "evidence that the gate ran.");
}
if (wiringBlocks.length === 1) {
  ok(wiringBlocks[0].job === GATE_JOB,
    `the disarm-gate WIRING step must live in the \`${GATE_JOB}\` job; found `
    + `\`${wiringBlocks[0].job}\`.`);
}

if (failures.length) {
  console.error(`main-disarmed gate wiring FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(
  "main-disarmed gate wiring OK (predicate green + seeded-red on fixtures; "
  + `${ARMING_PATH} present; quality.yml triggers on push to main, runs the gate in the `
  + `\`${GATE_JOB}\` job under \`${PUSH_TO_MAIN}\` asserting \`${GATE_VERDICT}\`, `
  + "and runs the wiring check unconditionally).",
);
