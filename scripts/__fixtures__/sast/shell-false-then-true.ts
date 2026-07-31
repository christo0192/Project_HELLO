// Seeded SHELL-FALSE-THEN-TRUE fixture for TST-05 (scripts/sast.test.mjs).
// Regression test for F2: a SAFE spawn with shell:false on one line followed
// by an UNSAFE spawn with shell:true on another line must ONLY flag the
// unsafe line (correct-line attribution). The original [\s\S]*? gap could
// span both lines and mis-attribute or false-positive.
import { spawn } from "node:child_process";

export function safeThenUnsafe(userInput: string) {
  // Line 8: SAFE — shell:false. Must NOT be flagged.
  const safe = spawn("echo", [userInput], { shell: false });
  // Line 10: UNSAFE — shell:true. MUST be flagged HERE.
  const unsafe = spawn("sh", ["-c", userInput], { shell: true });
  safe.unref();
  unsafe.unref();
}
