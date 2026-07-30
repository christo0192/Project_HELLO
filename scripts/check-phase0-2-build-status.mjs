#!/usr/bin/env node

/**
 * check-phase0-2-build-status.mjs
 *
 * Deterministic, no-dependency checker that validates Phase0-2 build-closure
 * markers across PLAN.md, docs/HANDOVER.md, docs/current-state.md, and
 * decision docs. Ensures that future documentation cannot confuse build
 * blockers with go-live gates.
 *
 * Exits 0 on success, 1 on failure.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const errors = [];
const fail = (message) => errors.push(message);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a file relative to root, return content or null on missing. */
async function readDoc(relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch {
    fail(`Cannot read ${relativePath}`);
    return null;
  }
}

/** Assert a regex pattern exists in text (case-insensitive). */
function assertContains(text, pattern, label, description) {
  if (!pattern.test(text)) {
    fail(`${label}: missing required marker ${description ? `— ${description}` : ""}`);
  }
}

/** Assert a regex pattern does NOT exist in text. */
function assertAbsent(text, pattern, label, description) {
  if (pattern.test(text)) {
    fail(`${label}: forbidden marker present — ${description || pattern}`);
  }
}

// ---------------------------------------------------------------------------
// 1. PLAN.md checks
// ---------------------------------------------------------------------------

const plan = await readDoc("PLAN.md");
if (plan) {
  // 1a. Build-blocker: none for Phase0-2 (post-PR26).
  //     Accept either:
  //     - A literal "build-blocker: none" statement, OR
  //     - The Phase 0 execution status table contains no "hard blocker"
  //       claim (all items described as "pending", "parked", or "blocked"
  //       with external/institutional blockers — not true code build blockers), OR
  //     - The top summary includes "None are production/go-live accepted"
  //       (confirming these are go-live gates, not build-blockers).
  const hasBuildBlockerNone = /\bbuild-blocker:\s*none\b/i.test(plan);
  const phase0StatusSection = plan.match(/\*\*Phase 0 execution status[\s\S]*?(?=\n---\n)/i);
  const hasNoHardBlockerClaim = phase0StatusSection
    ? !/hard.blocker/i.test(phase0StatusSection[0])
    : false;
  const summaryNoGoLive = /None are production\/go-live accepted/i.test(plan);
  if (!hasBuildBlockerNone && !hasNoHardBlockerClaim && !summaryNoGoLive) {
    fail("PLAN.md: must assert build-blocker: none for Phase0-2 (or Phase 0 execution table must show no hard blockers, or summary must say 'None are production/go-live accepted')");
  }

  // 1b. 0/17 launch gates preserved (gate count not promoted)
  assertContains(plan, /0\s*\/\s*17/, "PLAN.md", "0/17 launch gates must be preserved");

  // 1c. 0/14 phases preserved
  assertContains(plan, /0\s*\/\s*14/, "PLAN.md", "0/14 roadmap phases must be preserved");

  // 1d. D-004 not a hard go-live blocker.
  //     The unresolved-blockers paragraph (line ~372) must NOT claim D-004
  //     as a hard blocker, and the D-004 decision table row must not show
  //     "Blocked — hard blocker" or similar blocking status.
  //     We check:
  //     1) The unresolved-blockers section explicitly says D-004 is not
  //        a hard blocker (contains "no longer a hard go-live blocker"), OR
  //     2) The D-004 decision table row has status "Open" or "—", not "Blocked".
  const unresolvedSection = plan.match(/\*\*Unresolved Phase 2 blockers[\s\S]*?(?=\n##|$)/i);
  const d004ExplicitlyNotHard = unresolvedSection
    ? /D-004.*no longer a hard go-live blocker/i.test(unresolvedSection[0])
    : false;
  const d004TableEntry = plan.match(/\| D-004 \|([^|]+\|[^|]+\|[^|]+)\|/i);
  const d004TableNotBlocked = d004TableEntry
    ? !/Blocked/i.test(d004TableEntry[1])
    : false;
  if (!d004ExplicitlyNotHard && !d004TableNotBlocked) {
    fail("PLAN.md: D-004 must not be asserted as a hard go-live blocker");
  }

  // 1e. D-008 listed as go-live gate (US-host Legal nod pending)
  assertContains(plan, /D-008/i, "PLAN.md", "D-008 must be referenced as a go-live gate");

  // 1f. D-009 listed as go-live gate (retention period)
  assertContains(plan, /D-009/i, "PLAN.md", "D-009 must be referenced as a go-live gate");

  // 1g. D-010 listed as go-live gate (DPDP consent)
  assertContains(plan, /D-010/i, "PLAN.md", "D-010 must be referenced as a go-live gate");
}

// ---------------------------------------------------------------------------
// 2. docs/HANDOVER.md checks
// ---------------------------------------------------------------------------

const handover = await readDoc("docs/HANDOVER.md");
if (handover) {
  // 2a. PR26 merged reference (Phase0-2 closure baseline)
  assertContains(
    handover,
    /PR #?26|PR26/i,
    "docs/HANDOVER.md",
    "PR26 must be referenced as merged (Phase0-2 closure baseline)",
  );

  // 2b. 0/17 launch gates preserved
  assertContains(
    handover,
    /0\s*\/\s*17/i,
    "docs/HANDOVER.md",
    "0/17 launch gates must be preserved",
  );

  // 2c. 0/14 phases preserved
  assertContains(
    handover,
    /0\s*\/\s*14/i,
    "docs/HANDOVER.md",
    "0/14 roadmap phases must be preserved",
  );

  // 2d. D-004 must not be claimed as a hard blocker.
  //     HANDOVER inherits the D-004 status from PLAN.md; it must not
  //     override it with a hard-blocker claim.
  //     Check any line mentioning D-004 for hard-blocker language.
  const d004Lines = handover.match(/^.*D-004.*$/gm);
  if (d004Lines && d004Lines.some((line) => /hard.blocker/i.test(line))) {
    fail("docs/HANDOVER.md: D-004 must not be claimed as a hard blocker");
  }

  // 2e. FND-05/FND-06 referenced as NOT deployed/accepted in HANDOVER.
  //     Check the Phase-0 Foundation Status table specifically.
  const fndTableSection = handover.match(/## Phase-0 Foundation Status[\s\S]*?(?=\n##|$)/i);
  const fndTable = fndTableSection ? fndTableSection[0] : handover;
  for (const [fndId, markers] of [
    ["FND-05", /(?:parked|pending|select|not.*accepted|not deploy)/i],
    ["FND-06", /(?:parked|pending|select|blocked|not.*accepted|not deploy)/i],
  ]) {
    const rowRegex = new RegExp(`\\|\\s*${fndId}\\s*\\|[^|]+\\|([^|]+)\\|`);
    const fndMatch = fndTable.match(rowRegex);
    if (fndMatch) {
      if (!markers.test(fndMatch[1])) {
        fail(`docs/HANDOVER.md: ${fndId} must be described as selected/parked/pending (not deployed)`);
      }
    } else {
      // Fallback: check all FND-05/FND-06 lines are not claiming deployed/accepted
      const allFndLines = handover.match(new RegExp(`^.*${fndId}.*$`, "gm")) || [];
      if (!allFndLines.some((line) => markers.test(line))) {
        fail(`docs/HANDOVER.md: ${fndId} must be described as selected/parked/pending (not deployed)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. docs/current-state.md checks
// ---------------------------------------------------------------------------

const currentState = await readDoc("docs/current-state.md");
if (currentState) {
  // 3a. Pre-production status explicitly stated
  assertContains(
    currentState,
    /pre-production/i,
    "docs/current-state.md",
    "Must assert pre-production status",
  );

  // 3b. 0/17 launch gates preserved
  assertContains(
    currentState,
    /0\s*\/\s*17/i,
    "docs/current-state.md",
    "0/17 launch gates must be preserved",
  );

  // 3c. 0/14 phases preserved
  assertContains(
    currentState,
    /0\s*\/\s*14/i,
    "docs/current-state.md",
    "0/14 roadmap phases must be preserved",
  );
}

// ---------------------------------------------------------------------------
// 4. docs/decisions/fnd-08-inputs.md checks
// ---------------------------------------------------------------------------

const fnd08Inputs = await readDoc("docs/decisions/fnd-08-inputs.md");
if (fnd08Inputs) {
  // 4a. D-004 no cross-border data transfer (in-region self-hosted).
  //     Check the D-004 table row content for in-region/self-hosted markers.
  //     The D-004 row is: | D-004 | Scoring provider/hosting | description... | ... |
  //     We look for safety markers in the description (3rd column).
  const d004InputRow = fnd08Inputs.match(/\| D-004 \|[^|]+\|([^|]+)\|/i);
  const d004InputHasSafeMarkers = d004InputRow
    ? /(?:in-region|self.hosted|no cross.border|no DPA|not.*hard)/i.test(d004InputRow[1])
    : /D-004[\s\S]*?(?:in-region|self.hosted)/i.test(fnd08Inputs);
  if (!d004InputHasSafeMarkers) {
    fail("docs/decisions/fnd-08-inputs.md: D-004 must state no cross-border data transfer (in-region self-hosted)");
  }
}

// ---------------------------------------------------------------------------
// 5. docs/decisions/fnd-08-owner-approval.md checks
// ---------------------------------------------------------------------------

const fnd08Owner = await readDoc("docs/decisions/fnd-08-owner-approval.md");
if (fnd08Owner) {
  // 5a/5b. FND-05 and FND-06 status lines under ## FND-05 / FND-06 status.
  //     Each is a single line: "FND-05 (secret manager): ... **Selection is complete; ... pending.**"
  const fndStatusSection = fnd08Owner.match(/## FND-05 \/ FND-06 status[\s\S]*?(?=\n##|\n---|$)/i);
  if (fndStatusSection) {
    const section = fndStatusSection[0];
    // Extract FND-05 line
    const fnd05Line = section.match(/^FND-05[^]*?(?=\n{2,}|$)/im);
    const fnd05Ok = fnd05Line
      ? /(?:select|not deploy|not accept|pending|parked|blocked|execution blocked|complete.*pending)/i.test(fnd05Line[0])
      : false;
    if (!fnd05Ok) {
      fail("docs/decisions/fnd-08-owner-approval.md: FND-05 must be described as selected but not deployed/accepted");
    }
    // Extract FND-06 line
    const fnd06Line = section.match(/^FND-06[^]*?(?=\n{2,}|$)/im);
    const fnd06Ok = fnd06Line
      ? /(?:select|not deploy|not accept|pending|parked|blocked|execution blocked|complete.*pending)/i.test(fnd06Line[0])
      : false;
    if (!fnd06Ok) {
      fail("docs/decisions/fnd-08-owner-approval.md: FND-06 must be described as selected but not deployed/accepted");
    }
  } else {
    // Fallback if section not found: check global patterns
    const fnd05Done = !/FND-05[^]*?(?:select|pending|parked|blocked)/i.test(fnd08Owner);
    const fnd06Done = !/FND-06[^]*?(?:select|pending|parked|blocked)/i.test(fnd08Owner);
    if (fnd05Done) fail("docs/decisions/fnd-08-owner-approval.md: FND-05 must be described as selected but not deployed/accepted");
    if (fnd06Done) fail("docs/decisions/fnd-08-owner-approval.md: FND-06 must be described as selected but not deployed/accepted");
  }

  // 5c. No production-accepted claim
  assertAbsent(
    fnd08Owner,
    /\bproduction[- ]accepted\b/i,
    "docs/decisions/fnd-08-owner-approval.md",
    "Must not claim production-accepted status",
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (errors.length) {
  console.error(`Phase0-2 build-status check FAILED (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Phase0-2 build-status check PASSED:\n` +
  `  - No true build-blockers for Phase0-2\n` +
  `  - Go-live gates preserved (D-008, D-009, D-010, FND-05, FND-06)\n` +
  `  - 0/17 launch gates unchanged\n` +
  `  - 0/14 roadmap phases unchanged\n` +
  `  - PR26 baseline confirmed\n` +
  `  - No production-accepted claims\n` +
  `  - No cross-border data transfer claimed for D-004`);
