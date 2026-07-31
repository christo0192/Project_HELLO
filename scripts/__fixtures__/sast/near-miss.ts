// Seeded NEAR-MISS fixture for TST-05 (scripts/sast.test.mjs).
// Zero-hit regression: every line is a deliberate near-miss of the ruleset.
// The analyzer must report ZERO findings here and must terminate quickly
// (proving the g-flagged exec loop advances lastIndex and exits cleanly
// when no match exists — no phantom hits, no infinite loop).
// Near-miss tokens below are dot-prefixed (regex .exec) or paren-free
// ("eval" / "exec" as bare words) so the anchored rules cannot match them.
export function safe(input: string): string {
  // Near-miss S001: a local function named eval_ is not the eval builtin.
  function eval_parse(s: string) {
    return JSON.parse(s);
  }
  // Near-miss S002: regex .exec is a String method, not child_process.exec.
  const re = /Bearer\s+(\S+)/;
  const m = re.exec(input); // dot-prefixed: lookbehind excludes it
  // Near-miss S002: a locally defined helper is not child_process.execSync.
  function runCommand(s: string) {
    return s.length;
  }
  // Near-miss S003: spawn with an argument array, no shell:true.
  const { spawn } = require("node:child_process");
  const child = spawn("node", ["-e", input], { shell: false });
  child.unref();
  return m ? m[1] : eval_parse("{}") + String(runCommand(input));
}
