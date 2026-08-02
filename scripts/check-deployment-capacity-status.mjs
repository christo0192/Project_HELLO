#!/usr/bin/env node

/**
 * check-deployment-capacity-status.mjs — PR-B status-field validator (DEP foundations).
 *
 * Product-focused scanner over PR-B Phase-11 artifact paths only:
 *   - infra/capacity/**
 *   - infra/deployment-contracts/**
 *   - config/deployment-capacity*.schema.json
 *   - docs/deployment-capacity/**
 *   - docs/runbooks/deployment-capacity*.md
 *   - docs/runbooks/canary-rollback*.md
 *
 * It rejects positive deployment/capacity/HA claims semantically:
 *   - status/policy/approval values APPROVED, DEPLOYED, ACCEPTED, WINNER, SIGNED
 *     (including underscore/space-joined forms such as APPROVED_PENDING_OWNER,
 *     but permitting truthful negated forms such as NOT_DEPLOYED)
 *   - signed: true, capacityApproved/capacity_approved: true, deployed/provisioned: true
 *   - slsa_level > 0
 *   - prose claims such as "capacity approved", "deployment accepted",
 *     "failover verified", "supports N concurrent sessions"
 *
 * Positive claims are rejected UNCONDITIONALLY (HIGH-review regression):
 * repository-only Phase 11 work carries no authentic external evidence, so no
 * EV-xxxx reference, UUID, or other identifier string near a claim can
 * authorize it.
 *
 * Truthful PENDING/PROPOSED/synthetic_local text is explicitly permitted.
 * The scanner is product-focused only: it does NOT scan for attribution,
 * orchestration, or model-process markers.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const errors = [];
const scannedFiles = [];

// ── Scan surface (PR-B allowlisted data/doc paths) ──────────────────────────

const SCAN_DIRS = ["infra/capacity", "infra/deployment-contracts", "docs/deployment-capacity"];
const SCAN_GLOBS = [
  ["config", /^deployment-capacity.*\.schema\.json$/],
  ["docs/runbooks", /^deployment-capacity.*\.md$/],
  ["docs/runbooks", /^canary-rollback.*\.md$/],
];
const SCAN_EXTENSIONS = new Set([".json", ".md"]);

// ── Forbidden claim tokens (exact status values) ────────────────────────────

const FORBIDDEN_TOKENS = new Set(["APPROVED", "DEPLOYED", "ACCEPTED", "WINNER", "SIGNED"]);
const NEGATION_PREFIXES = new Set(["NOT", "NO", "UN", "NON"]);

// Truthful string values that may sit inside otherwise claim-sensitive keys.
const TRUTHFUL_VALUE = /^(?:pending|proposed|none|null|n\/a|not[_-]?applicable|not[_-]?started|owner[_-]?verify|synthetic|false|unapproved|undeployed|unsigned|unaccepted|not[_-]?(?:approved|deployed|accepted|signed)|no[_-]?(?:approval|deployment|acceptance|signature)|in[_-]?progress|deferred|required|todo|placeholder)$/i;

// Claim-sensitive key names: only their TRUE boolean value or non-truthful
// string value is treated as a claim. Matches snake_case, kebab-case and
// camelCase forms (capacityApproved, approvedBy, failoverVerified, signed...).
const CLAIM_KEY = new RegExp(
  [
    "(?:^|[_-])(?:approved|deployed|provisioned|accepted|winner|signed|live|failover|verified)(?:$|[_-])",
    "(?:approved|deployed|provisioned|accepted|winner|signed|failover|verified)(?=[A-Z]|$)",
    "(?:^|[_-])(?:capacity[_-]?approved|ha[_-]?achieved|failover[_-]?verified)(?:$|[_-])",
    "(?:capacityapproved|haachieved|failoververified)",
  ].join("|"),
  "i"
);

// ── Prose claim patterns (semantic, negation-aware) ─────────────────────────

const CLAIM_PATTERNS = [
  { id: "approved", re: /\bapproved\b/i },
  { id: "deployed", re: /\bdeployed\b/i },
  { id: "provisioned", re: /\bprovisioned\b/i },
  { id: "accepted", re: /\baccepted\b/i },
  { id: "signed", re: /\bsigned\b/i },
  { id: "winner", re: /\bwinner\b/i },
  { id: "slsa-level", re: /slsa[ _-]?level\s*(?:[>=:]|\s)\s*[1-9]\d*/i },
  { id: "capacity-approved", re: /capacity[^\n.]{0,40}\bapproved\b/i },
  { id: "failover-ha-verified", re: /(?:failover|ha)[^\n.]{0,40}\b(?:verified|achieved|tested ok|confirmed)\b/i },
  { id: "concurrent-capacity", re: /(?:supports|handles|serves)\s+\d[\d,]*\s*\+?\s*(?:concurrent|simultaneous)/i },
  { id: "deployment-complete", re: /\bdeployment\b[^\n.]{0,30}\b(?:complete|completed|live|achieved|done)\b/i },
  { id: "approval-granted", re: /\bapproval\b[^\n.]{0,25}\b(?:granted|confirmed|obtained|received|secured)\b/i },
];

// Truthful/negation markers that permit a nearby claim word (PENDING/PROPOSED/
// synthetic/negated phrasing is permitted; positive claims are not).
const TRUTHFUL_MARKER = /\b(?:not|never|no|nothing|without|unverified|unapproved|unsigned|undeployed|unaccepted|unclaimed|pending|proposed|rejected|placeholder|synthetic|todo|to be|future|required|requires|must|invalid|forbidden|prohibited|disallowed|not permitted|must not|should not|cannot|can't|won't|will not|does not|do not|has not|have not|is not|are not|was not|were not|not been|not yet|not-yet|no longer|no capacity|no real|no claim|not claimed|in progress|deferred|n\/a|none|intentionally|explicitly|unmeasured|hypothetical|proposal|proposed only)\b/i;

// NOTE (HIGH-review regression): there is deliberately NO external-evidence
// bypass. Repository-only Phase 11 work carries no authentic external
// evidence, so a positive deployment/capacity/HA/acceptance/signed/SLSA claim
// is rejected UNCONDITIONALLY — no EV-xxxx reference, UUID, or other
// identifier string near the claim can authorize it.

// ── Filesystem walk ─────────────────────────────────────────────────────────

// JSON-Schema vocabulary subtrees (property-name references, enum/const values,
// type declarations) are metadata, not deployment status fields. Their values
// are skipped by the claim scan; prose in "description" keys is still scanned.
const SCHEMA_SKIP_SUBTREE_KEYS = new Set([
  "required", "enum", "const", "pattern", "type", "format", "items", "properties",
  "$defs", "definitions", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "additionalProperties", "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems", "uniqueItems", "title", "$id", "$schema", "version",
  "default", "examples", "$ref", "contentSchema",
]);

const isJsonSchemaFile = (doc) =>
  doc !== null && typeof doc === "object" && !Array.isArray(doc) &&
  ("$schema" in doc || "type" in doc);


async function collectFiles() {
  const files = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dirs are permitted (e.g. before lane B2 lands)
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`Refusing to scan symlink ${relative}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, relative);
      } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(relative);
      }
    }
  }
  for (const dir of SCAN_DIRS) await walk(path.join(root, dir), dir);
  for (const [dir, pattern] of SCAN_GLOBS) {
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && pattern.test(entry.name)) files.push(path.join(dir, entry.name));
    }
  }
  return [...new Set(files)].sort();
}

// ── Claim detection ─────────────────────────────────────────────────────────

/** True when the window contains a truthful/negation marker. */
function isTruthfulWindow(window) {
  return TRUTHFUL_MARKER.test(window);
}

/**
 * Segment-aware status-token check for JSON values.
 * "NOT_DEPLOYED" and "UNAPPROVED" are permitted; "APPROVED" and
 * "APPROVED_PENDING_OWNER" are not. Returns the offending token or null.
 */
function forbiddenTokenSegments(value) {
  const segments = String(value).split(/[_-\s]+/);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i].toUpperCase();
    if (!FORBIDDEN_TOKENS.has(segment)) continue;
    const previous = i > 0 ? segments[i - 1].toUpperCase() : "";
    if (NEGATION_PREFIXES.has(previous)) continue;
    return segment;
  }
  return null;
}

/** Short status-like values (enum tokens) vs long prose. */
function isStatusLikeString(value) {
  return value.length <= 60 && !/[.,;!?]/.test(value);
}

/** Prose claim scan over a text window. Returns first violating pattern id or null. */
function proseClaim(text) {
  for (const pattern of CLAIM_PATTERNS) {
    const re = new RegExp(pattern.re.source, `${pattern.re.flags.includes("g") ? "" : "g"}i`);
    let match;
    while ((match = re.exec(text)) !== null) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(text.length, re.lastIndex + 80);
      const window = text.slice(start, end);
      // No external-evidence bypass: a claim is rejected unless a truthful/
      // negation marker is present in the window. EV-xxxx/UUID refs do not
      // authorize positive deployment/capacity/HA claims.
      if (!isTruthfulWindow(window)) return pattern.id;
    }
  }
  return null;
}

function scanJsonValue(value, keyPath, keyHint) {
  if (typeof value === "boolean") {
    if (value === true && CLAIM_KEY.test(keyHint)) {
      errors.push(`${keyPath}: boolean true on claim-sensitive field "${keyHint}" is a positive deployment/capacity/HA claim`);
    }
    return;
  }
  if (typeof value === "number") {
    if (/slsa[ _-]?level/i.test(keyHint) && value > 0) {
      errors.push(`${keyPath}: slsa_level > 0 is a signed/SLSA maturity claim without authentic evidence`);
    }
    return;
  }
  if (typeof value !== "string") return;

  if (isStatusLikeString(value)) {
    const token = forbiddenTokenSegments(value);
    if (token) {
      errors.push(`${keyPath}: forbidden status token ${token} — positive deployment/capacity claims are not permitted`);
      return;
    }
  } else {
    const prose = proseClaim(value);
    if (prose) {
      errors.push(`${keyPath}: prose claim detected (${prose}) — positive deployment/capacity/HA claims are not permitted`);
    }
  }

  // Claim-sensitive key carrying a non-truthful string value (e.g. approvedBy: <name>).
  if (CLAIM_KEY.test(keyHint) && value.trim() !== "" && !TRUTHFUL_VALUE.test(value.trim())) {
    errors.push(`${keyPath}: field "${keyHint}" asserts a positive claim (value is not a truthful PENDING/PROPOSED status)`);
  }
}

function scanJsonObject(obj, keyPath, schemaMode) {
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const childPath = `${keyPath}[${index}]`;
      if (item !== null && typeof item === "object") scanJsonObject(item, childPath, schemaMode);
      else scanJsonValue(item, childPath, "");
    });
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    const childPath = keyPath === "" ? key : `${keyPath}.${key}`;
    if (schemaMode && SCHEMA_SKIP_SUBTREE_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object") scanJsonObject(value, childPath, schemaMode);
    else scanJsonValue(value, childPath, key);
  }
}

function scanMarkdown(content, filePath) {
  // Whole-content scan with a bounded cross-line window so truthful qualifiers
  // ("rejected by the status validator: APPROVED...", "...is rejected.") are
  // recognised even when they sit on an adjacent line.
  for (const pattern of CLAIM_PATTERNS) {
    const re = new RegExp(pattern.re.source, "gi");
    let match;
    while ((match = re.exec(content)) !== null) {
      const lineNo = content.slice(0, match.index).split("\n").length;
      const start = Math.max(0, match.index - 120);
      const end = Math.min(content.length, re.lastIndex + 100);
      const window = content.slice(start, end);
      // No external-evidence bypass: EV-xxxx/UUID refs near the claim do not
      // authorize it. Only truthful/negation markers permit the word.
      if (!isTruthfulWindow(window)) {
        errors.push(`${filePath}:${lineNo}: prose claim detected (${pattern.id}) — positive deployment/capacity/HA claims are not permitted`);
      }
    }
  }
}

async function scanFile(relativePath) {
  const full = path.join(root, relativePath);
  let content;
  try {
    content = await readFile(full, "utf8");
  } catch {
    errors.push(`Cannot read ${relativePath}`);
    return;
  }
  scannedFiles.push(relativePath);
  if (relativePath.endsWith(".json")) {
    let doc;
    try {
      doc = JSON.parse(content);
    } catch {
      errors.push(`${relativePath}: not valid JSON`);
      return;
    }
    if (doc !== null && typeof doc === "object") scanJsonObject(doc, relativePath, isJsonSchemaFile(doc));
  } else {
    scanMarkdown(content, relativePath);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const files = await collectFiles();
for (const file of files) await scanFile(file);

if (errors.length) {
  console.error(`deployment-capacity status validation FAILED (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`deployment-capacity status validation passed across ${scannedFiles.length} artifact(s):`);
for (const file of scannedFiles) console.log(`  - ${file}`);
console.log("  No APPROVED/DEPLOYED/ACCEPTED/WINNER/SIGNED, signed:true, slsa_level>0, or positive capacity/HA claims found.");
console.log("  Truthful PENDING/PROPOSED/synthetic_local states are intact.");
