#!/usr/bin/env node

/**
 * sast/analyzer.mjs — TST-05 offline deterministic SAST analyzer (Phase 6 lane L4).
 *
 * Repository-owned, deterministic, zero external service, zero network, no
 * unpinned curl installer. Runs a rule set from ./rules.json over configured
 * source roots and fails closed (exit 1) on any finding.
 *
 * BOUNDARY: this analyzer detects DANGEROUS-CODE antipatterns only. It does
 * NOT scan for secrets or environment values — that is the gitleaks boundary
 * (scripts/scan-secrets.sh + .gitleaks.toml + .github/workflows/secret-scan.yml).
 * scripts/__fixtures__/sast/secret-shaped fixture proves this distinction.
 *
 * Usage:
 *   node scripts/sast/analyzer.mjs              # scan the repository
 *   node scripts/sast/analyzer.mjs --list       # print rule inventory
 *   node scripts/sast/analyzer.mjs --scan-dir <dir> <dir2>...   # scan specific dirs (used by self-tests)
 *   node scripts/sast/analyzer.mjs --version
 *
 * Exit codes: 0 = no findings (or --list); 1 = findings; 2 = usage/scan error.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// ── Default scan roots (repository-owned source) ──────────────────────────
const DEFAULT_SCAN_ROOTS = [
  path.join(ROOT, "app", "api", "src"),
  path.join(ROOT, "app", "web", "src"),
  path.join(ROOT, "app", "voice-livekit"),
  path.join(ROOT, "scripts"),
  path.join(ROOT, ".github", "workflows"),
];

// ── Skip rules (never scanned) ────────────────────────────────────────────
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "hello-assets",
]);
// Fixture directories are scanned EXPLICITLY by scripts/sast.test.mjs only.
const SKIP_PATH_FRAGMENTS = [
  path.join("scripts", "__fixtures__"),
  path.join("app", "api", "src", "__tests__"),
  path.join("app", "web", "src", "__tests__"),
  path.join("app", "web", "src", "test"),
  path.join("app", "voice-livekit", "tests"),
];
const SKIP_FILENAMES = new Set([
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".gitleaks.toml",
  "rules.json",
]);

const args = process.argv.slice(2);

// ── Rule loading ──────────────────────────────────────────────────────────
async function loadRules() {
  const raw = await readFile(path.join(__dirname, "rules.json"), "utf8");
  const parsed = JSON.parse(raw);
  return parsed.rules.map((r) => ({
    ...r,
    // "g" is REQUIRED: without it RegExp#exec never advances lastIndex and
    // the scan loop spins forever on the first match; "s" makes . match \n;
    // "m" lets ^/$ match per line (S201 shell-eval uses ^).
    compiled: r.patterns.map((p) => new RegExp(p, "gsm")),
  }));
}

// ── File walking ──────────────────────────────────────────────────────────
async function walk(rootDir, skipDirs, onFile) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return; // missing dir is fine (e.g., no web/src in some checkouts)
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (SKIP_PATH_FRAGMENTS.some((f) => full.replaceAll("\\", "/").endsWith(f))) continue;
      await walk(full, skipDirs, onFile);
    } else if (entry.isFile()) {
      if (SKIP_FILENAMES.has(entry.name)) continue;
      if (entry.name.endsWith(".map")) continue;
      // Test files are intentionally excluded from the DEFAULT scan: they
      // legitimately exercise dangerous APIs as negative controls (e.g.
      // scripts/*.test.mjs needles, fixtures). The analyzer targets shipped
      // product source; test fixtures are scanned EXPLICITLY by
      // scripts/sast.test.mjs.
      if (/(?:\.test\.|\.spec\.)(?:ts|tsx|js|jsx|mjs|cjs|py)$/.test(entry.name)) continue;
      await onFile(full);
    }
  }
}

// ── Per-file scan ─────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 512 * 1024; // 512 KiB — skip larger files to bound scan time
async function scanFile(filePath, rules) {
  const ext = path.extname(filePath).toLowerCase();
  const findings = [];
  let content;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      console.error(`[sast] SKIPPED ${path.relative(ROOT, filePath)} (${(fileStat.size / 1024).toFixed(0)} KiB > ${MAX_FILE_BYTES / 1024} KiB limit)`);
      return findings;
    }
    content = await readFile(filePath, "utf8");
  } catch {
    return findings;
  }
  for (const rule of rules) {
    if (!rule.extensions.includes(ext)) continue;
    for (const re of rule.compiled) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        if (m.index === re.lastIndex) re.lastIndex += 1;
        // Line + column from the match index
        let line = 1;
        let col = 1;
        for (let i = 0; i < m.index && i < content.length; i += 1) {
          if (content[i] === "\n") {
            line += 1;
            col = 1;
          } else {
            col += 1;
          }
        }
        findings.push({
          file: filePath,
          line,
          col,
          rule: rule.id,
          severity: rule.severity,
          message: rule.message,
          match: content.slice(Math.max(0, m.index), Math.min(content.length, m.index + 80)).replace(/\n/g, "\\n"),
        });
      }
    }
  }
  return findings;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const rules = await loadRules();

  if (args.includes("--list")) {
    console.log(`Offline SAST ruleset: ${rules.length} rules`);
    for (const r of rules) {
      console.log(`  ${r.id.padEnd(30)} ${r.severity.padEnd(6)} ${r.name} [${r.extensions.join(",")}]`);
    }
    process.exit(0);
  }
  if (args.includes("--version")) {
    console.log("offline-sast-analyzer v1.0.0");
    process.exit(0);
  }

  // --scan-dir <dir>... → explicit roots (self-tests use this)
  const scanRoots =
    args[0] === "--scan-dir" && args.length > 1 ? args.slice(1).map((a) => path.resolve(ROOT, a)) : DEFAULT_SCAN_ROOTS;

  const allFindings = [];
  for (const rootDir of scanRoots) {
    const rel = path.relative(ROOT, rootDir) || rootDir;
    const st = await stat(rootDir).catch(() => null);
    if (!st) {
      console.error(`[sast] SKIPPED ${rel} (not found)`);
      continue;
    }
    if (st.isFile()) {
      // --scan-dir can target a single file (self-tests scan fixtures).
      if (SKIP_FILENAMES.has(path.basename(rootDir))) continue;
      if (/(?:\.test\.|\.spec\.)(?:ts|tsx|js|jsx|mjs|cjs|py)$/.test(path.basename(rootDir))) continue;
      const findings = await scanFile(rootDir, rules);
      allFindings.push(...findings.map((f) => ({ ...f, file: path.relative(ROOT, f.file) })));
      console.error(`[sast] scanned ${rel}`);
      continue;
    }
    await walk(rootDir, new Set(), async (filePath) => {
      const findings = await scanFile(filePath, rules);
      allFindings.push(...findings.map((f) => ({ ...f, file: path.relative(ROOT, f.file) })));
    });
    console.error(`[sast] scanned ${rel}`);
  }

  if (allFindings.length > 0) {
    console.error(`[sast] FAILED — ${allFindings.length} finding(s) (fail-closed):`);
    for (const f of allFindings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  ${f.file}:${f.line}:${f.col} [${f.rule}] (${f.severity}) ${f.message} — match: ${f.match}`);
    }
    process.exit(1);
  }
  console.error(`[sast] PASS — no dangerous-code findings in ${scanRoots.length} scan root(s); ${rules.length} rules applied.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[sast] analyzer crashed:", err);
  process.exit(2);
});
