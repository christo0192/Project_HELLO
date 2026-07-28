#!/usr/bin/env node

/**
 * check-audit-exceptions.mjs
 *
 * Cross-references `npm audit --json` output against a documented exceptions
 * file.  Every exception is matched by BOTH GHSA advisory ID AND package name;
 * unmatched high/crit advisories fail closed.
 *
 * DESIGN CHOICES
 * ──────────────
 * • Advisory-level severity, not package-aggregate severity. A high package
 *   whose only advisory is moderate does not require an exception.
 * • Expired exceptions always fail the build (not a soft warning) even when
 *   the audit contains zero vulnerabilities.
 * • An exception that only matches below-threshold (moderate/low) advisories
 *   is treated as unused/stale – it blocks the build.
 * • A high/crit vulnerability with an empty via array, or whose via chain
 *   contains zero blocking advisories and no valid inherited-path to a
 *   blocking advisory, fails closed.
 * • Expiry: ISO 8601 date only (e.g. "2026-10-01"). The exception is valid
 *   through 23:59:59 UTC on that date. After that it is expired.
 * • Always invoked, even when npm audit exits 0.
 *
 * Usage (CLI):
 *   npm audit --json | node scripts/check-audit-exceptions.mjs \
 *     --exceptions .github/audit-exceptions.json \
 *     --project-dir app/web
 *
 * Usage (API):
 *   import { checkAudit } from './check-audit-exceptions.mjs';
 *   const result = checkAudit(auditJson, exceptions, { projectDir: 'app/web' });
 *   if (!result.pass) { console.error(result.report); process.exit(1); }
 */

import { readFileSync } from "node:fs";
import { accessSync, constants } from "node:fs";
import { resolve, join } from "node:path";

// ── Types (JSDoc only — no TypeScript dependency) ──────────────────

/**
 * @typedef {Object} AdvisoryObject
 * @property {string} url
 * @property {string} title
 * @property {string} severity   - "high" | "critical" | "moderate" | "low"
 * @property {string} name       - package name the advisory is filed against
 * @property {string} range
 */

/**
 * @typedef {Object} NpmVulnerability
 * @property {string} name
 * @property {string} severity
 * @property {boolean} isDirect
 * @property {(string|AdvisoryObject)[]} via
 * @property {string} range
 * @property {string[]} nodes
 * @property {boolean} fixAvailable
 */

/**
 * @typedef {Object} NpmAuditReport
 * @property {number} auditReportVersion
 * @property {Object<string,NpmVulnerability>} vulnerabilities
 */

/**
 * @typedef {Object} Exception
 * @property {string} id                  - GHSA advisory ID
 * @property {string} package             - npm package name
 * @property {string} owner
 * @property {string} rationale
 * @property {string} compensating_control
 * @property {string} expiry              - ISO 8601 date. Valid through 23:59:59 UTC on this date.
 * @property {string} review_trigger
 * @property {string[]} [projects]
 */

/**
 * @typedef {Object} CheckOptions
 * @property {string} [projectDir]
 * @property {string} [projectName]
 */

/**
 * @typedef {Object} CheckResult
 * @property {boolean} pass
 * @property {string} report
 * @property {Object[]} failures
 */

/**
 * @typedef {Object} ParsedVuln
 * @property {boolean} valid
 * @property {AdvisoryObject[]} advisories
 * @property {string[]} refs
 * @property {boolean} hasAnyBlockingAdvisory
 * @property {boolean} hasAnyAdvisory
 * @property {string[]} errors
 */

// ── Constants ──────────────────────────────────────────────────────

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const VALID_SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);

const REQUIRED_EXCEPTION_KEYS = [
  "id", "package", "owner", "rationale",
  "compensating_control", "expiry", "review_trigger",
];

const GHSA_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const GHSA_URL_RE = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Expiry ────────────────────────────────────────────────────────
// Exceptions are valid THROUGH end-of-day UTC on the expiry date.
// e.g. expiry "2026-10-01" means valid until 2026-10-02T00:00:00Z exclusive.
// We parse `Date.parse("2026-10-01")` which yields midnight UTC on that date,
// then compare: now < expiryDate + 1 day.

/**
 * @param {string} expiryIso - ISO 8601 date (e.g. "2026-10-01")
 * @returns {{ valid: boolean, parsed: number }} parsed is Date.parse value
 */
function parseExpiry(expiryIso) {
  if (!DATE_ONLY_RE.test(expiryIso)) {
    return { valid: false, parsed: NaN };
  }

  const parsed = Date.parse(`${expiryIso}T00:00:00Z`);
  if (isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== expiryIso) {
    return { valid: false, parsed: NaN };
  }

  // Add 1 day so the date is treated as "through end of this UTC day".
  return { valid: true, parsed: parsed + 86_400_000 };
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateExceptionsFile(obj) {
  const errors = [];
  if (obj === null || typeof obj !== "object") {
    return { valid: false, errors: ["Exceptions file must be a JSON object"] };
  }
  if (!Array.isArray(obj.exceptions)) {
    return { valid: false, errors: ["Missing or invalid 'exceptions' array"] };
  }
  const seenIds = new Set();
  for (let i = 0; i < obj.exceptions.length; i++) {
    const e = obj.exceptions[i];
    const prefix = `exceptions[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      errors.push(`${prefix}: must be a JSON object`);
      continue;
    }
    for (const key of REQUIRED_EXCEPTION_KEYS) {
      if (typeof e[key] !== "string" || e[key].trim() === "") {
        errors.push(`${prefix}.${key}: required non-empty string`);
      }
    }
    if (typeof e.id === "string" && !GHSA_RE.test(e.id)) {
      errors.push(`${prefix}.id: "${e.id}" is not a valid GHSA ID (expected GHSA-xxxx-xxxx-xxxx)`);
    }
    if (typeof e.expiry === "string") {
      const { valid } = parseExpiry(e.expiry);
      if (!valid) {
        errors.push(`${prefix}.expiry: "${e.expiry}" must be a real YYYY-MM-DD UTC date`);
      }
    }
    if (e.projects !== undefined) {
      if (!Array.isArray(e.projects) || e.projects.length === 0 ||
          e.projects.some(project => typeof project !== "string" || project.trim() === "")) {
        errors.push(`${prefix}.projects: when present, must be a non-empty array of non-empty strings`);
      }
    }
    if (typeof e.id === "string") {
      if (seenIds.has(e.id)) {
        errors.push(`${prefix}.id: duplicate GHSA ID "${e.id}"`);
      }
      seenIds.add(e.id);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ── Invariant checks ───────────────────────────────────────────────

/**
 * @param {Exception} exception
 * @param {string} [projectDir]
 * @returns {{ valid: boolean, reason?: string }}
 */
function checkInvariant(exception, projectDir) {
  if (exception.id === "GHSA-qwww-vcr4-c8h2" && projectDir) {
    const candidates = [
      join(projectDir, "react-router.config.ts"),
      join(projectDir, "react-router.config.js"),
      join(projectDir, "react-router.config.mjs"),
    ];
    for (const p of candidates) {
      try {
        accessSync(p, constants.R_OK);
        return {
          valid: false,
          reason: `Architecture invariant violated: ${p} exists. This enables React Router framework/RSC mode, making GHSA-qwww-vcr4-c8h2 exploitable. Remove the file or update the exception.`,
        };
      } catch { /* file absent — invariant holds */ }
    }
  }
  return { valid: true };
}

// ── Audit shape validation ─────────────────────────────────────────

/**
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAuditShape(obj) {
  const errors = [];
  if (obj === null || typeof obj !== "object") {
    return { valid: false, errors: ["Audit input is not a JSON object"] };
  }
  if (typeof obj.auditReportVersion !== "number") {
    errors.push("Missing or invalid 'auditReportVersion' — expected npm audit --json output");
  }
  if (obj.vulnerabilities === undefined || obj.vulnerabilities === null) {
    errors.push("Missing 'vulnerabilities' — expected npm audit --json output");
  } else if (typeof obj.vulnerabilities !== "object" || Array.isArray(obj.vulnerabilities)) {
    errors.push("'vulnerabilities' is not an object — expected npm audit --json output");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Parse vulnerability via entries. Returns parsed structure including
 * whether the vuln has any blocking advisory in its own via list.
 *
 * @param {NpmVulnerability} vuln
 * @param {string} vulnKey
 * @returns {ParsedVuln}
 */
function parseVulnerabilityVia(vuln, vulnKey) {
  const advisories = [];
  const refs = [];
  const errors = [];
  let hasAnyBlockingAdvisory = false;
  let hasAnyAdvisory = false;

  if (vuln === null || typeof vuln !== "object" || Array.isArray(vuln)) {
    return {
      valid: false,
      advisories,
      refs,
      hasAnyBlockingAdvisory,
      hasAnyAdvisory,
      errors: [`${vulnKey}: vulnerability entry must be an object`],
    };
  }

  if (typeof vuln.name !== "string" || !vuln.name) {
    errors.push(`${vulnKey}: missing or invalid 'name'`);
  }
  if (typeof vuln.severity !== "string" || !VALID_SEVERITIES.has(vuln.severity.toLowerCase())) {
    errors.push(`${vulnKey}: missing or invalid 'severity'`);
  }
  if (!Array.isArray(vuln.via)) {
    errors.push(`${vulnKey}: missing or non-array 'via'`);
    return { valid: false, advisories, refs, hasAnyBlockingAdvisory, hasAnyAdvisory, errors };
  }

  for (let i = 0; i < vuln.via.length; i++) {
    const via = vuln.via[i];
    if (typeof via === "string") {
      refs.push(via);
    } else if (typeof via === "object" && via !== null) {
      hasAnyAdvisory = true;
      const prefix = `${vulnKey}.via[${i}]`;
      if (typeof via.url !== "string" || !via.url) {
        errors.push(`${prefix}: missing or invalid 'url'`);
      }
      if (typeof via.severity !== "string" || !VALID_SEVERITIES.has(via.severity.toLowerCase())) {
        errors.push(`${prefix}: missing or invalid 'severity'`);
      }
      if (typeof via.name !== "string" || !via.name) {
        errors.push(`${prefix}: missing or invalid 'name'`);
      }
      if (BLOCKING_SEVERITIES.has((via.severity || "").toLowerCase())) {
        hasAnyBlockingAdvisory = true;
      }
      advisories.push(/** @type {AdvisoryObject} */ (via));
    } else {
      errors.push(`${vulnKey}.via[${i}]: unexpected type ${typeof via}`);
    }
  }

  return {
    valid: errors.length === 0,
    advisories,
    refs,
    hasAnyBlockingAdvisory,
    hasAnyAdvisory,
    errors,
  };
}

// ── Core logic ─────────────────────────────────────────────────────

/**
 * @param {NpmAuditReport} auditJson
 * @param {Exception[]} exceptions
 * @param {CheckOptions} options
 * @returns {CheckResult}
 */
export function checkAudit(auditJson, exceptions, options = {}) {
  const failures = [];
  const lines = [];

  // ── 1. Validate audit shape ──
  const shapeCheck = validateAuditShape(auditJson);
  if (!shapeCheck.valid) {
    failures.push({ type: "invalid_audit_shape", errors: shapeCheck.errors });
    return {
      pass: false,
      report: `FAIL: npm audit output is malformed.\n${shapeCheck.errors.map(e => `  - ${e}`).join("\n")}`,
      failures,
    };
  }

  // ── 2. Validate exceptions file ──
  const excCheck = validateExceptionsFile({ exceptions });
  if (!excCheck.valid) {
    failures.push({ type: "invalid_exceptions_file", errors: excCheck.errors });
    return {
      pass: false,
      report: `FAIL: Exceptions file is invalid.\n${excCheck.errors.map(e => `  - ${e}`).join("\n")}`,
      failures,
    };
  }

  // ── 3. Build active exception index. Expired exceptions are FAILURES. ──
  const now = Date.now();
  /** @type {Map<string, Exception>} */
  const activeExceptions = new Map();
  /** @type {Set<string>} */
  const usedExceptionKeys = new Set();

  for (const e of exceptions) {
    // Project scoping
    if (e.projects && Array.isArray(e.projects) && e.projects.length > 0) {
      const projectName = options.projectName || "";
      if (!e.projects.includes(projectName)) {
        continue; // Not applicable to this project
      }
    }

    const expiryResult = parseExpiry(e.expiry);
    if (!expiryResult.valid || expiryResult.parsed < now) {
      // EXPIRED — always a failure even with zero vulnerabilities
      failures.push({
        type: "expired_exception",
        id: e.id,
        package: e.package,
        owner: e.owner,
        expiry: e.expiry,
      });
      lines.push(`FAIL: Exception ${e.id} (${e.package}) expired ${e.expiry}. Expired exceptions must be removed or renewed.`);
      continue;
    }

    const inv = checkInvariant(e, options.projectDir);
    if (!inv.valid) {
      failures.push({ type: "invariant_violated", id: e.id, package: e.package, reason: inv.reason });
      lines.push(`FAIL: Exception ${e.id} (${e.package}) — ${inv.reason}`);
      continue;
    }

    const key = `${e.id}::${e.package}`;
    activeExceptions.set(key, e);
  }

  // ── 4. First pass: parse all vulns to build a blocking-via-ref map ──
  const vulns = auditJson.vulnerabilities || {};

  /** @type {Map<string, ParsedVuln>} */
  const parsedVulns = new Map();
  const knownPackages = new Set();

  let shapeErrorsFound = false;
  for (const [key, vuln] of Object.entries(vulns)) {
    const parsed = parseVulnerabilityVia(vuln, key);
    parsedVulns.set(key, parsed);
    if (vuln && typeof vuln === "object" && !Array.isArray(vuln) && typeof vuln.name === "string") {
      knownPackages.add(vuln.name);
    }
    if (!parsed.valid) {
      shapeErrorsFound = true;
      failures.push({ type: "invalid_vulnerability_shape", packageKey: key, errors: parsed.errors });
      for (const err of parsed.errors) {
        lines.push(`FAIL: ${err}`);
      }
    }
  }
  if (shapeErrorsFound) {
    return {
      pass: false,
      report: `FAIL: npm audit contains unparseable vulnerability entries.\n${lines.join("\n")}`,
      failures,
    };
  }

  // ── 5. Determine which packages have a valid blocking chain ──
  // A package is "blocking" if:
  //   a) It has at least one blocking advisory directly in its via array, OR
  //   b) It inherits from a string ref that is itself blocking.
  // We compute this iteratively to handle chains of any depth.

  /** @type {Map<string, boolean>} */
  const isBlocking = new Map(
    [...parsedVulns].map(([key, parsed]) => [key, parsed.hasAnyBlockingAdvisory]),
  );

  // Propagate blocking status through inherited references to a fixed point.
  // This handles cycles without recursion and still resolves a cycle that has
  // a path to a real blocking advisory.
  let blockingStatusChanged = true;
  while (blockingStatusChanged) {
    blockingStatusChanged = false;
    for (const [key, parsed] of parsedVulns) {
      if (!isBlocking.get(key) && parsed.refs.some(ref => isBlocking.get(ref) === true)) {
        isBlocking.set(key, true);
        blockingStatusChanged = true;
      }
    }
  }

  // ── 6. Process each vulnerability ──
  for (const [vulnKey, vuln] of Object.entries(vulns)) {
    const parsed = parsedVulns.get(vulnKey);
    if (!parsed) continue;

    const { advisories, refs } = parsed;
    const vulnSeverity = (vuln.severity || "").toLowerCase();
    const vulnIsBlockingSeverity = BLOCKING_SEVERITIES.has(vulnSeverity);

    // ── 6a. Empty via on a blocking-severity vuln → fail closed ──
    if (vulnIsBlockingSeverity && advisories.length === 0 && refs.length === 0) {
      failures.push({
        type: "empty_via_blocking",
        package: vuln.name,
        severity: vulnSeverity,
        packageKey: vulnKey,
      });
      lines.push(
        `FAIL: ${vuln.name} (${vulnSeverity}) has an empty via array. Cannot determine blocking rationale — fail closed.`,
      );
      continue;
    }

    // Every blocking aggregate severity must be explained by a direct blocking
    // advisory or an inherited chain that reaches one. This also covers mixed
    // via arrays containing both advisory objects and package references.
    const missingRefs = refs.filter(r => !knownPackages.has(r));
    if (missingRefs.length > 0) {
      for (const ref of missingRefs) {
        failures.push({
          type: "missing_dependency_reference",
          package: vuln.name,
          referenced_package: ref,
        });
        lines.push(
          `FAIL: ${vuln.name} references "${ref}" which is not present in the audit vulnerabilities. Cannot evaluate inherited severity.`,
        );
      }
      continue;
    }

    if (vulnIsBlockingSeverity && !isBlocking.get(vulnKey)) {
      failures.push({
        type: "nonblocking_inherited_chain",
        package: vuln.name,
        severity: vulnSeverity,
        refs,
        packageKey: vulnKey,
      });
      lines.push(
        `FAIL: ${vuln.name} (${vulnSeverity}) has no direct or inherited blocking advisory explaining its aggregate severity — fail closed.`,
      );
      continue;
    }

    // ── 6b. Inherited-only entries have already been validated as blocking. ──
    if (vulnIsBlockingSeverity && advisories.length === 0 && refs.length > 0) {
      for (const ref of refs) {
        lines.push(
          `PASS: ${vuln.name} — severity inherited from "${ref}" (evaluated as blocking).`,
        );
      }
      continue;
    }

    // ── 6c. Evaluate advisory objects by their OWN severity ──
    for (const adv of advisories) {
      const advSeverity = (adv.severity || "").toLowerCase();

      if (!BLOCKING_SEVERITIES.has(advSeverity)) {
        // DO NOT mark exceptions as used for below-threshold advisories.
        // If an exception only matches moderate/low advisories, it becomes
        // a stale/unused exception and blocks the build.
        lines.push(`INFO: ${vuln.name} advisory ${adv.title || "?"} (${advSeverity}) — below threshold.`);
        continue;
      }

      // Extract GHSA ID from URL
      const ghsaMatch = adv.url.match(GHSA_URL_RE);
      if (!ghsaMatch) {
        failures.push({
          type: "advisory_without_ghsa",
          package: vuln.name,
          advisory_package: adv.name,
          severity: advSeverity,
          title: adv.title,
          url: adv.url,
        });
        lines.push(
          `FAIL: ${vuln.name} (${advSeverity}) — advisory "${adv.title}" has no extractable GHSA ID from URL "${adv.url}". Must fail closed.`,
        );
        continue;
      }

      const ghsaId = ghsaMatch[0];
      const exceptionKey = `${ghsaId}::${adv.name}`;
      const exception = activeExceptions.get(exceptionKey);

      if (exception) {
        usedExceptionKeys.add(exceptionKey);
        lines.push(
          `PASS: ${vuln.name} advisory ${ghsaId} on ${adv.name} (${advSeverity}) — covered by exception from ${exception.owner}, expires ${exception.expiry}.`,
        );
      } else {
        // Check for package-mismatch exception
        let wrongPackage = false;
        for (const [ek, ev] of activeExceptions) {
          if (ek.startsWith(`${ghsaId}::`) && ek !== exceptionKey) {
            wrongPackage = true;
            lines.push(
              `NOTE: Exception ${ghsaId} exists for package "${ev.package}" but advisory targets "${adv.name}". Package mismatch — not matched.`,
            );
            break;
          }
        }
        failures.push({
          type: "uncovered_advisory",
          package: vuln.name,
          advisory_package: adv.name,
          ghsa: ghsaId,
          severity: advSeverity,
          title: adv.title,
          wrong_package_exception: wrongPackage,
        });
        lines.push(
          `FAIL: ${vuln.name} advisory ${ghsaId} on ${adv.name} (${advSeverity}) — no matching exception.`,
        );
      }
    }

    // ── 6d. Handle string-only (inherited) via entries ──
    for (const ref of refs) {
      if (!knownPackages.has(ref)) {
        failures.push({
          type: "missing_dependency_reference",
          package: vuln.name,
          referenced_package: ref,
        });
        lines.push(
          `FAIL: ${vuln.name} references "${ref}" which is not present in the audit vulnerabilities. Cannot evaluate inherited severity.`,
        );
      } else {
        lines.push(
          `PASS: ${vuln.name} — severity inherited from "${ref}" (evaluated independently).`,
        );
      }
    }
  }

  // ── 7. Detect unused active exceptions ──
  for (const [key, exception] of activeExceptions) {
    if (!usedExceptionKeys.has(key)) {
      failures.push({
        type: "unused_exception",
        id: exception.id,
        package: exception.package,
        owner: exception.owner,
        expiry: exception.expiry,
      });
      lines.push(
        `FAIL: Exception ${exception.id} (${exception.package}) is active but does not match any BLOCKING advisory. Stale exceptions must be removed.`,
      );
    }
  }

  // ── 8. Final result ──
  const pass = failures.length === 0;
  let summary;
  if (failures.some(f => f.type === "expired_exception")) {
    summary = "Expired exceptions must be removed or renewed.";
  } else if (failures.some(f => f.type === "uncovered_advisory" || f.type === "advisory_without_ghsa" || f.type === "empty_via_blocking" || f.type === "nonblocking_inherited_chain")) {
    summary = "Blocking vulnerabilities found with no valid exception.";
  } else if (failures.some(f => f.type === "unused_exception")) {
    summary = "Stale exceptions detected. Remove or update them.";
  } else if (failures.some(f => f.type === "invariant_violated")) {
    summary = "Architecture invariant violated for an active exception.";
  } else if (failures.some(f => f.type === "missing_dependency_reference")) {
    summary = "Referenced dependencies are missing from the audit.";
  } else {
    summary = "All high/critical advisories are covered by valid exceptions.";
  }

  return {
    pass,
    report: `${pass ? "PASS" : "FAIL"}: ${summary}\n${lines.join("\n")}`,
    failures,
  };
}

// ── CLI entry point ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let exceptionsPath = "";
  let projectDir = "";
  let projectName = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exceptions" && i + 1 < args.length) {
      exceptionsPath = args[++i];
    } else if (args[i] === "--project-dir" && i + 1 < args.length) {
      projectDir = args[++i];
    } else if (args[i] === "--project-name" && i + 1 < args.length) {
      projectName = args[++i];
    } else {
      console.error(`Unknown or incomplete argument: ${args[i]}`);
      process.exit(2);
    }
  }

  if (!exceptionsPath) {
    console.error("Usage: npm audit --json | node check-audit-exceptions.mjs --exceptions <path> [--project-dir <path>]");
    process.exit(2);
  }

  const resolvedExceptionsPath = resolve(process.cwd(), exceptionsPath);
  const resolvedProjectDir = projectDir ? resolve(process.cwd(), projectDir) : "";

  let exceptionsData;
  try {
    exceptionsData = JSON.parse(readFileSync(resolvedExceptionsPath, "utf-8"));
  } catch (err) {
    console.error(`FAIL: Cannot read exceptions file: ${err.message}`);
    process.exit(1);
  }

  const chunks = [];
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  let auditJson;
  try {
    auditJson = JSON.parse(chunks.join(""));
  } catch (err) {
    console.error(`FAIL: Cannot parse audit JSON from stdin: ${err.message}`);
    process.exit(1);
  }

  const result = checkAudit(auditJson, exceptionsData.exceptions, {
    projectDir: resolvedProjectDir,
    projectName: projectName,
  });

  console.log(result.report);
  process.exit(result.pass ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""));
if (isMain) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
