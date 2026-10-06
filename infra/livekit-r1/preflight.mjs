#!/usr/bin/env node
/**
 * Validate captured `fly machines list --json` output for the disposable SFU.
 * This deliberately does not invoke Fly, so an operator can pipe output or
 * validate a saved response before a manual deploy.
 */
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`livekit-r1 preflight FAILED: ${message}`);
  process.exitCode = 1;
}

let input;
try {
  input = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
} catch (error) {
  fail(`cannot read machine JSON: ${error.message}`);
}

if (process.exitCode) process.exit();

let machines;
try {
  machines = JSON.parse(input);
} catch (error) {
  fail(`machine JSON is invalid: ${error.message}`);
}

if (!Array.isArray(machines)) {
  fail("machine JSON must be an array");
} else if (machines.length !== 1) {
  fail(`expected exactly one Machine, found ${machines.length}`);
} else if (machines[0]?.region !== "sin") {
  fail(`the sole Machine must be in sin, found ${JSON.stringify(machines[0]?.region)}`);
} else {
  console.log(`livekit-r1 preflight OK: one Machine in sin (${machines[0].id ?? "unknown-id"})`);
}
