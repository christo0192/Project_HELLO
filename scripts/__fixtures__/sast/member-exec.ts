// Seeded MEMBER-EXEC fixture for TST-05 (scripts/sast.test.mjs).
// Regression test for F1: the S002 rule must also catch destructured AND
// member-call forms — cp.exec, child_process.exec, childProcess.execSync.
// The original pattern only matched bare exec( / execSync( calls and missed
// these dominant dangerous spellings.
const cp = require("node:child_process");

export function runA(userInput: string) {
  // S002: member-call exec — MUST be flagged
  cp.exec(userInput);
}

export function runB(userInput: string) {
  // S002: member-call execSync — MUST be flagged
  cp.execSync(userInput);
}

const child_process = require("node:child_process");

export function runC(userInput: string) {
  // S002: child_process.exec — MUST be flagged
  child_process.exec(userInput);
}

export function runD() {
  // SAFE: spawn with argument array and shell:false — must NOT be flagged
  cp.spawn("echo", ["hello"], { shell: false });
}
