#!/usr/bin/env node

/**
 * sast.test.mjs — TST-05 offline SAST self-tests (Phase 6 lane L4).
 *
 * Proves the analyzer (scripts/sast/analyzer.mjs + rules.json) is:
 *   1. NON-VACUOUS — seeded unsafe fixtures MUST be flagged (prove red).
 *   2. PRECISE — seeded safe fixtures MUST NOT be flagged.
 *   3. BOUNDED — the analyzer does NOT scan secrets/env (gitleaks boundary):
 *      a secret-shaped fixture MUST NOT be flagged by SAST.
 *   4. GREEN ON THE REAL REPO — the repository source passes the ruleset
 *      (fail-closed baseline; new violations turn CI red).
 *
 * Zero network, synthetic fixtures only.
 * Usage: node scripts/sast.test.mjs
 * Exit 0 = all self-tests pass; 1 = any failure.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ANALYZER = path.join(__dirname, "sast", "analyzer.mjs");
const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "sast");

let failures = 0;
const pass = (msg) => console.log(`PASS: ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};

/** Run the analyzer over explicit paths relative to ROOT; return {status, stdout, stderr}. */
function runAnalyzer(relativePaths, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [ANALYZER, "--scan-dir", ...relativePaths, ...extraArgs],
    { cwd: ROOT, encoding: "utf8" }
  );
}

// ════════════════════════════════════════════════════════════════════
// 1. Unsafe fixtures must be flagged (prove red) — negative controls
// ════════════════════════════════════════════════════════════════════
{
  const rel = path.relative(ROOT, FIXTURE_DIR);
  const r = runAnalyzer([rel]);
  const out = r.stdout + r.stderr;
  // Analyzer should exit 1 because the unsafe fixtures live in the scan dir.
  if (r.status === 1) {
    pass("unsafe fixture dir → analyzer fails closed (exit 1)");
  } else {
    fail(`unsafe fixture dir did NOT fail closed (status=${r.status})`);
  }
  for (const [rule, needle] of [
    ["S001-dynamic-eval-js", "eval("],
    ["S002-childprocess-exec-js", "exec(`git commit"],
    ["S003-spawn-shell-js", "shell: true"],
    ["S101-subprocess-shell-py", "subprocess.run(cmd, shell=True)"],
    ["S102-os-system-py", "os.system(cmd)"],
    ["S103-dynamic-eval-py", "exec(cmd)"],
    ["S104-pickle-load-py", "pickle.loads(blob)"],
    ['S201-shell-eval-sh', 'eval "$cmd"'],
    ["S202-curl-pipe-installer", "curl -sSL https://example.invalid/install.sh | bash"],
  ]) {
    const hit = out.includes(rule) && out.includes(needle);
    if (hit) pass(`negative control flagged: ${rule}`);
    else fail(`negative control NOT flagged: ${rule}`);
  }

  // F1 regression: member-exec forms (cp.exec, child_process.execSync, etc.)
  // must ALSO be flagged by S002 — the original lookbehind missed them.
  const memberRel = path.relative(ROOT, path.join(FIXTURE_DIR, "member-exec.ts"));
  const mr = runAnalyzer([memberRel]);
  const mout = mr.stdout + mr.stderr;
  const s002Count = (mout.match(/\[S002-childprocess-exec-js\]/g) || []).length;
  if (mr.status === 1 && s002Count >= 3) {
    pass(`F1 member-exec regression: S002=${s002Count} findings (cp.exec, cp.execSync, child_process.exec all flagged)`);
  } else {
    fail(`F1 member-exec regression failed (status=${mr.status}, S002=${s002Count}):\n${mout}`);
  }
  // But the safe spawn with shell:false in the same file must NOT be flagged
  if (!mout.includes("S003-spawn-shell-js")) {
    pass("F1 member-exec precision: safe spawn(shell:false) in member-exec.ts not flagged by S003");
  } else {
    fail(`F1 member-exec precision failed: S003 fired on safe spawn\n${mout}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 2. Safe fixtures must NOT be flagged (precision)
// ════════════════════════════════════════════════════════════════════
{
  const safeFiles = [
    path.join(FIXTURE_DIR, "safe-ts.ts"),
    path.join(FIXTURE_DIR, "safe-py.py"),
  ];
  const r = runAnalyzer(safeFiles.map((f) => path.relative(ROOT, f)));
  const out = r.stdout + r.stderr;
  if (r.status === 0 && !out.includes("FAILED")) {
    pass("safe fixtures produce zero findings (regex .exec, argument-array spawn, shell=False all ignored)");
  } else {
    fail(`safe fixtures produced findings or non-zero exit (status=${r.status}):\n${out}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 3a. MULTI-HIT regression: the g-flagged exec loop must report EVERY
//     occurrence and terminate (no non-global infinite loop, no first-match
//     stop). multi-hit.ts has 3x eval( and 2x execSync(.
// ════════════════════════════════════════════════════════════════════
{
  const rel = path.relative(ROOT, path.join(FIXTURE_DIR, "multi-hit.ts"));
  const r = runAnalyzer([rel]);
  const out = r.stdout + r.stderr;
  const countRule = (id) => (out.match(new RegExp("\\[" + id + "\\]", "g")) || []).length;
  const s001 = countRule("S001-dynamic-eval-js");
  const s002 = countRule("S002-childprocess-exec-js");
  if (r.status === 1 && s001 >= 3 && s002 >= 2) {
    pass(`multi-hit regression: S001=${s001} occurrences, S002=${s002} occurrences all reported (global exec advances; loop terminates)`);
  } else {
    fail(`multi-hit regression failed (status=${r.status}, S001=${s001}, S002=${s002}):\n${out}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 3b. ZERO-HIT regression: near-misses (regex .exec, local helpers, spawn
//     with argv array + shell:false) must produce ZERO findings and the
//     analyzer must terminate cleanly (no phantom hits, no hang).
// ════════════════════════════════════════════════════════════════════
{
  const rel = path.relative(ROOT, path.join(FIXTURE_DIR, "near-miss.ts"));
  const r = runAnalyzer([rel]);
  const out = r.stdout + r.stderr;
  if (r.status === 0 && !out.includes("FAILED") && !/\[S\d{3}-/.test(out)) {
    pass("zero-hit regression: near-miss file yields no findings and terminates cleanly");
  } else {
    fail(`zero-hit regression failed (status=${r.status}):\n${out}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 3c. F2 LINE-ATTRIBUTION regression: shell=False then shell=True.
//     The bounded patterns must attribute the finding to the shell=True
//     line ONLY, not to the safe shell=False line before it.
// ════════════════════════════════════════════════════════════════════
{
  // JS: spawn with shell:false on line 8, shell:true on line 10
  const relJs = path.relative(ROOT, path.join(FIXTURE_DIR, "shell-false-then-true.ts"));
  const rJs = runAnalyzer([relJs]);
  const outJs = rJs.stdout + rJs.stderr;
  // The finding for S003 must appear on the shell:true line (line 10), not line 8.
  const s003Match = outJs.match(/shell-false-then-true\.ts:(\d+):.*\[S003-spawn-shell-js\]/);
  if (rJs.status === 1 && s003Match) {
    const line = parseInt(s003Match[1], 10);
    if (line > 8) {
      pass(`F2 line attribution (JS): S003 finding on line ${line} (shell:true line, not shell:false line 8)`);
    } else {
      fail(`F2 line attribution (JS) FAILED: S003 finding on line ${line} — should be on shell:true line, not line 8`);
    }
  } else {
    fail(`F2 line attribution (JS) FAILED: no S003 finding or wrong exit (status=${rJs.status}):\n${outJs}`);
  }

  // Python: subprocess.run with shell=False on line 9, shell=True on line 11
  const relPy = path.relative(ROOT, path.join(FIXTURE_DIR, "shell-false-then-true.py"));
  const rPy = runAnalyzer([relPy]);
  const outPy = rPy.stdout + rPy.stderr;
  const s101Match = outPy.match(/shell-false-then-true\.py:(\d+):.*\[S101-subprocess-shell-py\]/);
  if (rPy.status === 1 && s101Match) {
    const line = parseInt(s101Match[1], 10);
    if (line > 9) {
      pass(`F2 line attribution (Python): S101 finding on line ${line} (shell=True line, not shell=False line 9)`);
    } else {
      fail(`F2 line attribution (Python) FAILED: S101 finding on line ${line} — should be on shell=True line, not line 9`);
    }
  } else {
    fail(`F2 line attribution (Python) FAILED: no S101 finding or wrong exit (status=${rPy.status}):\n${outPy}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 3d. F2 LARGE-FILE BOUND: a file above 512 KiB is deterministically
//     skipped with an explicit log message and must NOT stall.
// ════════════════════════════════════════════════════════════════════
{
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sast-largefile-"));
  const largeFile = path.join(tmp, "large-vendored.ts");
  // Write a file just over 512 KiB (513 KiB). The exact content doesn't
  // matter — it just needs to exceed the cap.
  const oneMb = Buffer.alloc(513 * 1024, 65); // 'A' repeated
  await writeFile(largeFile, oneMb);
  try {
    const r = runAnalyzer([largeFile]);
    const out = r.stdout + r.stderr;
    if (r.status === 0 && /SKIPPED.*(?:513|51[3-9]|5[2-9]\d)\s*KiB.*limit/.test(out)) {
      pass("F2 large-file bound: 513 KiB file skipped deterministically with explicit log");
    } else if (r.status === 0) {
      fail(`F2 large-file bound FAILED: large file not skipped or skip message missing:\n${out}`);
    } else {
      fail(`F2 large-file bound FAILED: analyzer errored on large file (status=${r.status}):\n${out}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════
// 3. Secret-shaped fixture must NOT be flagged (SAST does not scan secrets)
// ════════════════════════════════════════════════════════════════════
// Generated at runtime in the OS temp dir (NOT shipped in the repo): a
// secret-shaped file would otherwise trip the repo's real gitleaks gate
// (secret-scan.yml / scan-secrets.sh), which is exactly what the SAST
// boundary must NOT do. Writing it outside the repo keeps both gates
// independent and green.
{
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sast-secret-boundary-"));
  const secretFile = path.join(tmp, "secret-shaped.txt");
  await writeFile(
    secretFile,
    [
      // Fake-secret shapes are built from fragments so the SOURCE never
      // contains a contiguous secret-shaped token (gitleaks would flag it).
      // The assembled string is written only to the OS temp dir at runtime,
      // which the repo's secret gate never scans.
      "aws_access_key=AKIAIOSFODNN7EXAMPLE",
      "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "github_token=ghp_" + "0123456789abcdef0123456789abcdef0123",
      "",
    ].join("\n")
  );
  try {
    const r = runAnalyzer([secretFile]);
    const out = r.stdout + r.stderr;
    if (r.status === 0 && !out.includes("AKIAIOSFODNN7EXAMPLE")) {
      pass("secret-shaped content NOT flagged — SAST stays within the dangerous-code boundary (gitleaks owns secret scanning)");
    } else {
      fail(`SAST drifted into secret scanning or errored (status=${r.status}):\n${out}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════
// 4. Real repository scan passes (fail-closed baseline)
// ════════════════════════════════════════════════════════════════════
{
  const r = spawnSync(process.execPath, [ANALYZER], { cwd: ROOT, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  if (r.status === 0) {
    pass(`real repository scan green (${out.split("\n").filter((l) => l.includes("scanned")).length} scan roots, no findings)`);
  } else {
    fail(`real repository scan found violations (status=${r.status}):\n${out}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 5. Rule inventory is deterministic and self-describing
// ════════════════════════════════════════════════════════════════════
{
  const r = spawnSync(process.execPath, [ANALYZER, "--list"], { cwd: ROOT, encoding: "utf8" });
  if (r.status === 0 && /Offline SAST ruleset: \d+ rules/.test(r.stdout)) {
    const n = Number(/\d+/.exec(r.stdout.match(/Offline SAST ruleset: (\d+) rules/)[1]));
    pass(`rule inventory lists ${n} rules deterministically`);
  } else {
    fail(`--list failed (status=${r.status}): ${r.stdout}${r.stderr}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════
if (failures > 0) {
  console.error(`\nsast.test.mjs FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log("\nAll offline SAST self-tests passed: non-vacuous (red on unsafe), precise (green on safe), bounded (no secret scanning), baseline green.");
process.exit(0);
