#!/usr/bin/env node
// ADR-0013 evidence-count agreement (PR104, audit finding L-1).
//
// ADR-0013's "Evidence" section states two DIFFERENT counts that are easy to
// confuse and were in fact confused: the full canary run makes 133 checks
// against a live Postgres, while the offline gate makes its own, larger set of
// assertions that need no database. The ADR claimed "133 offline assertions"
// long after the offline gate had grown to 139 — a number that reads as audited
// evidence while being wrong, which is the "stale tripwire" class this lane
// keeps rediscovering: a claim that cannot be true any more is worse than none.
//
// What this checker enforces, and what it deliberately does not:
//
//   * TWO-SIDED on the offline count. It RUNS `scripts/phone-canary/canary0.test.mjs`
//     and compares the ADR's stated figure with the total the gate itself
//     reports. It therefore fails if the ADR drifts from the gate AND if the
//     gate's total changes without the ADR being updated. Adding an offline
//     assertion is meant to cost one ADR line; that is the point.
//   * STRUCTURAL on the SQL-check count. The 133 figure comes from a run
//     against a real database, which this gate has no Docker and no network to
//     reproduce, so it is NOT verified here — claiming otherwise would be the
//     same kind of decorative evidence. What is enforced is that the two counts
//     stay distinct and separately labelled, so a future editor cannot collapse
//     them back into the single ambiguous number that produced L-1.
//
// Dependency-free; runs the offline gate in a subprocess (no DB, no network).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adrPath = path.join(root, "docs/adr/0013-phone-screening-runtime.md");
const gatePath = path.join(root, "scripts/phone-canary/canary0.test.mjs");
const adr = readFileSync(adrPath, "utf8");

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// ── 1. What the offline gate actually reports ────────────────────────────
const run = spawnSync(process.execPath, [gatePath], { encoding: "utf8", cwd: root });
const gateOut = (run.stdout || "") + (run.stderr || "");
ok(run.status === 0, `the offline canary gate must pass before its count can be cited as evidence (exit ${run.status})`);
const gateMatch = gateOut.match(/phone-canary offline gate: (\d+) passed, (\d+) failed/);
ok(gateMatch !== null, "could not read the offline gate's summary line — the evidence count has no source");
const actualOffline = gateMatch ? Number(gateMatch[1]) : null;
ok(actualOffline !== null && actualOffline > 0, "the offline gate reported a non-positive assertion total");

// ── 2. What ADR-0013 claims ──────────────────────────────────────────────
const offlineClaim = adr.match(/canary0\.test\.mjs`\s*—\s*\*\*(\d+) offline assertions\*\*/);
ok(offlineClaim !== null,
  "ADR-0013 must state the offline assertion count as `canary0.test.mjs` — **N offline assertions**");
const sqlClaim = adr.match(/canary0\.mjs`\s*—\s*10 scenarios, \*\*(\d+) checks\*\*/);
ok(sqlClaim !== null,
  "ADR-0013 must state the live-database check count as `canary0.mjs` — 10 scenarios, **N checks**");

// The ADR also quotes the gate's summary line verbatim so a reader can compare
// it against a terminal without knowing this checker exists.
const quoted = adr.match(/phone-canary offline gate: (\d+) passed, 0 failed/);
ok(quoted !== null, "ADR-0013 must quote the gate's own summary line as the reproduction of its offline count");

// ── 3. Agreement, in BOTH directions ─────────────────────────────────────
if (offlineClaim && actualOffline !== null) {
  ok(Number(offlineClaim[1]) === actualOffline,
    `ADR-0013 claims ${offlineClaim[1]} offline assertions; the gate reports ${actualOffline}. `
    + "Update the ADR (or the gate), not this check — the evidence numbers are the auditable claim.");
}
if (quoted && actualOffline !== null) {
  ok(Number(quoted[1]) === actualOffline,
    `ADR-0013 quotes "offline gate: ${quoted[1]} passed"; the gate reports ${actualOffline}`);
}

// ── 4. The two counts must stay distinct and separately labelled ─────────
if (offlineClaim && sqlClaim) {
  ok(Number(sqlClaim[1]) !== Number(offlineClaim[1]),
    `ADR-0013 states the same number (${sqlClaim[1]}) for the live-database checks and the offline assertions. `
    + "They measure different things and collapsing them is exactly how the stale count survived review.");
  ok(/DIFFERENT number/.test(adr),
    "ADR-0013 must say in words that the two counts are different measurements, not a typo to be reconciled");
}

if (failures.length) {
  console.error(`phone canary evidence-count agreement FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(
  `phone canary evidence agreement OK (ADR-0013 offline=${actualOffline} matches the gate; `
  + `live-database checks=${sqlClaim ? sqlClaim[1] : "?"} kept distinct).`,
);
