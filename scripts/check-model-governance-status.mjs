#!/usr/bin/env node

/**
 * check-model-governance-status.mjs — PR-A Phase 10 model-governance
 * status-field validator (LLM-01 lane A1).
 *
 * PRODUCT-FOCUSED: parses/inspects the Phase 10 model-governance artifact
 * statuses and rejects positive approval/winner/signed/SLSA claims in
 * status-like fields while permitting truthful repository-only prose
 * (PROPOSED, PENDING, NOT_EVALUATED, OWNER_VERIFY).
 *
 * Scope (PR-A allowlist only — zero overlap with PR-B):
 *   app/api/src/model-governance/**
 *   app/voice-livekit/model_governance/**
 *   config/model-governance*.schema.json
 *   docs/model-governance/**
 *   docs/runbooks/model-governance*.md
 *
 * Rejected claim patterns (field-scoped — prose is NOT scanned):
 *   - any status/policy/approval/decision field whose value is
 *     APPROVED / DEPLOYED / ACCEPTED (case-insensitive)
 *   - any `winner` claim (winner: true, or a status field valued "winner")
 *   - any `slsa_level` greater than zero
 *   - any `signed` flag set to true
 *
 * Repository-only Phase 10 work carries NO authentic external evidence, so
 * positive approval/winner/signed/SLSA claims are rejected UNCONDITIONALLY:
 * no EV-xxxx reference, UUID, or other identifier string can authorize them.
 * Truthful repository-only states are PENDING, PROPOSED, NOT_EVALUATED,
 * OWNER_VERIFY (and negated forms).
 *
 * This validator does NOT scan for AI/model attribution or orchestration-
 * process scaffolding; those are closure-inspection items, not product
 * validators.
 *
 * Usage: node scripts/check-model-governance-status.mjs [root]
 *   root defaults to process.cwd().
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? process.cwd());

// ── Scan roots (PR-A allowlist) ─────────────────────────────────────────
const scanRoots = [
  { dir: "app/api/src/model-governance", match: null },
  { dir: "app/voice-livekit/model_governance", match: null },
  { dir: "config", match: /^model-governance.*\.schema\.json$/ },
  { dir: "docs/model-governance", match: null },
  { dir: "docs/runbooks", match: /^model-governance.*\.md$/ },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".git",
  "dist",
]);

// ── Field-scoped claim patterns ─────────────────────────────────────────
//
// Keys are status/approval/policy/decision/phase/acceptance/state/result/
// outcome (plus common snake/camel variants). Values are the positive claim
// tokens. Only a key:value (or key=value) pair is a claim — free prose is
// never scanned.

// snake/camel/spaced variants: approval_status, approvalStatus, policy_state, policyState, ...
const STATUS_BASES = ["approval", "policy", "decision", "phase", "acceptance"];
const STATUS_KEYS = ["status", "verdict", "state", "result", "outcome"];
for (const base of STATUS_BASES) {
  STATUS_KEYS.push(base);
  for (const tail of ["status", "Status", "state", "State"]) {
    STATUS_KEYS.push(`${base}_${tail}`, `${base}${tail}`, `${base}-${tail}`);
  }
}
const STATUS_KEY = `(?:${STATUS_KEYS.join("|")})`;

const CLAIMS = [
  {
    name: "status approval claim",
    re: new RegExp(`\\b${STATUS_KEY}["'\`*_]*\\s*[=:]\\s*["'\`*_]*\\s*(?:approved|deployed|accepted)\\b`, "i"),
  },
  {
    name: "winner claim (winner: true / winner: 1)",
    re: /\bwinner["'`*_]*\s*[=:]\s*["'`*_]*\s*(?:true|1|approved|deployed|accepted)\b/i,
  },
  {
    name: "winner status value",
    re: new RegExp(`\\b(?:status|result|outcome|verdict|decision)["'\`*_]*\\s*[=:]\\s*["'\`*_]*\\s*winner\\b`, "i"),
  },
  {
    name: "slsa_level greater than zero",
    re: /\bslsa[_-]?level["'`*_]*\s*[=:]\s*["'`*_]*\s*([1-9][0-9]*)\b/i,
  },
  {
    name: "signed flag set to true",
    re: /\bsigned["'`*_]*\s*[=:]\s*["'`*_]*\s*(?:true|1)\b/i,
  },
];

// ── Claim scan (unconditional — no external-evidence bypass) ────────────
//
// A positive approval/winner/signed/SLSA claim is rejected REGARDLESS of any
// same-line EV-xxxx/UUID/identifier reference. Repository-only Phase 10 work
// can never authorize a positive claim.

const errors = [];
const scanned = [];

async function listFiles(dir, match) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing root — nothing to scan
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full, match));
    } else if (entry.isFile() && (match === null || match.test(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

async function scanFile(file) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    errors.push(`${path.relative(root, file)}: cannot read file`);
    return;
  }
  const rel = path.relative(root, file);
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const claim of CLAIMS) {
      if (claim.re.test(line)) {
        errors.push(`${rel}:${i + 1}: ${claim.name}`);
      }
    }
  }
  scanned.push(rel);
}

for (const { dir, match } of scanRoots) {
  const absolute = path.join(root, dir);
  let isDirectory = false;
  try {
    isDirectory = (await stat(absolute)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) continue;
  for (const file of await listFiles(absolute, match)) {
    await scanFile(file);
  }
}

if (errors.length > 0) {
  console.error(`Model-governance status check FAILED (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Model-governance status check passed (${scanned.length} artifact file(s) scanned; ` +
  `no approval/winner/signed/SLSA claims found — positive claims are rejected unconditionally).`,
);
