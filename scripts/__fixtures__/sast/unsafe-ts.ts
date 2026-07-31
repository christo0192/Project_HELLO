// Seeded UNSAFE fixture for TST-05 (scripts/sast.test.mjs).
// INTENTIONALLY contains dangerous-code patterns that the offline SAST
// analyzer must flag. This file is excluded from the default repository
// scan and is only scanned explicitly by the SAST self-test to prove the
// analyzer is not vacuous ("prove red").
export function handle(userInput) {
  // S001: dynamic eval
  const result = eval(`(${userInput})`);
  // S002: child_process exec with a command string
  const { exec } = require("node:child_process");
  exec(`git commit -m "${userInput}"`);
  // S003: spawn with shell enabled
  const { spawn } = require("node:child_process");
  spawn("sh", ["-c", userInput], { shell: true });
  return result;
}
