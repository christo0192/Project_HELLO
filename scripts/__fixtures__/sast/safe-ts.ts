// Seeded SAFE fixture for TST-05 (scripts/sast.test.mjs).
// Contains benign patterns that must NOT be flagged (precision check):
//  - regex .exec() is a String method, NOT the child-process exec builtin
//  - spawn with an argument array and shell:false is the sanctioned pattern
//  - a local helper is not a dangerous API
// Deliberate near-miss tokens below are dot-prefixed (regex .exec) or
// paren-free (the word "eval") so the anchored rules cannot match them.
export function safe(userInput: string) {
  const re = /Bearer\s+([A-Za-z0-9._~+/-]+=*)/;
  const match = re.exec(userInput); // dot-prefixed: lookbehind excludes it
  const { spawn } = require("node:child_process");
  const child = spawn("claude", ["-p", userInput], { shell: false });
  child.on("error", () => {});
  // "eval" as a bare word (no call) cannot match the eval-call rule.
  const note = "eval is not called here";
  return match ? match[1] : note;
}

export function runLocal() {
  return 42;
}
