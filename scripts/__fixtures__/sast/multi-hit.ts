// Seeded MULTI-HIT fixture for TST-05 (scripts/sast.test.mjs).
// Contains MULTIPLE occurrences of the same dangerous patterns in one file.
// Regression test for global-regex scanning: the analyzer must report EVERY
// occurrence (proving RegExp#exec advances lastIndex with the g flag) and
// must terminate (proving no infinite loop from a non-global exec).
export function first(input: string) {
  return eval(`(${input})`);
}
export function second(input: string) {
  return eval(`(${input})`);
}
export function third(input: string) {
  return eval(`(${input})`);
}
export function runA(cmd: string) {
  const { execSync } = require("node:child_process");
  execSync(cmd);
}
export function runB(cmd: string) {
  const { execSync } = require("node:child_process");
  execSync(cmd);
}
