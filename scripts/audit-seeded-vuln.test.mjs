#!/usr/bin/env node

/**
 * audit-seeded-vuln.test.mjs
 *
 * Deterministic policy-violation tests feeding synthetic `npm audit --json`
 * fixtures into the policy checker.  No live npm advisory database required.
 *
 * Coverage:
 *  1.  Unaccepted high advisory → fail
 *  2.  Valid non-expired exception covering all → pass
 *  3.  Expired exception with vulns → fail
 *  4.  Malformed/incomplete exception → fail closed
 *  5.  One advisory excepted, second uncovered → fail
 *  6.  Invalid audit JSON shape → fail closed
 *  7.  Invalid GHSA ID format in exception → fail
 *  8.  Moderate severity advisory → not blocking
 *  9.  Empty vulnerabilities with no exceptions → pass
 *  10. Package-mismatch exception → fail
 *  11. High advisory without extractable GHSA → fail closed
 *  12. Inherited string-only via with missing reference → fail
 *  13. Aggregate severity: high+moderate advisories, only high excepted → pass
 *  14. Unused (stale) active exception → fail
 *  15. Duplicate GHSA ID in exceptions → fail
 *  16. Via entry with missing url → fail closed
 *  17. Advisory object missing severity → fail closed
 *  18. Sub-dep advisory matched by advisory package name → pass
 *  19. Inherited string-only via with valid reference and blocking child → pass
 *  20. Wrapper regression: react-router.config.ts invalidates exception
 *  21. Expired exception with EMPTY audit → fail (not just warning)      [A]
 *  22. Exception matching only moderate advisory → unused/stale → fail   [B]
 *  23. High vuln with empty via array → fail closed                      [C1]
 *  24. High parent referencing low-only child → fail                     [C2]
 *  25. Expiry date-only: same-day UTC still valid (boundary test)        [F]
 *  26. Non-date or impossible expiry values → fail validation
 *  27. Invalid project scope metadata → fail validation
 *  28. Mixed via array with no blocking explanation → fail closed
 *  29. Cyclic inherited vulnerability graph → fail closed without recursion
 *  30. Missing exception registry array → fail closed
 *  31. Non-object exception entry → fail closed
 *  32. Invalid vulnerability container/entry → fail closed
 *  33. Unknown vulnerability/advisory severity → fail closed
 */

import { checkAudit } from "./check-audit-exceptions.mjs";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "__fixtures__", "vulnerable-fixture");

function readJson(name) {
  return JSON.parse(readFileSync(resolve(FIXTURE, name), "utf-8"));
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\nSEC-10 Dependency Policy Tests\n");

// ── 1 ──
test("Unaccepted high advisory blocks", () => {
  const audit = readJson("audit-unaccepted-high.json");
  const result = checkAudit(audit, []);
  assert(result.pass === false, "Expected pass=false");
  const lodash = result.failures.find(f => f.type === "uncovered_advisory" && f.package === "lodash");
  assert(lodash, "Expected uncovered_advisory for lodash");
  assert(lodash.ghsa === "GHSA-35jh-r3h4-6jhm" || lodash.ghsa === "GHSA-p6mc-m468-83gw");
  const minimist = result.failures.find(f => f.type === "uncovered_advisory" && f.package === "minimist");
  assert(minimist, "Expected uncovered_advisory for minimist (critical)");
  assert(minimist.severity === "critical");
});

// ── 2 ──
test("Valid non-expired exception covering all advisories passes", () => {
  const audit = readJson("audit-lodash-two-high.json");
  const exceptions = readJson("valid-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === true, `Expected pass=true, got: ${result.report}`);
  assert(result.failures.length === 0, "Expected zero failures");
});

// ── 3. Expired exception WITH vulns → fail ──
test("Expired exception with vulnerabilities fails", () => {
  const audit = readJson("audit-lodash-two-high.json");
  const exceptions = readJson("expired-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false, "Expected fail for expired exceptions");
  // Should have both expired_exception failures AND uncovered_advisory failures
  assert(result.failures.some(f => f.type === "expired_exception"), "Expected expired_exception failures");
  assert(result.failures.some(f => f.type === "uncovered_advisory"), "Expected uncovered_advisory after expiry pruning");
});

// ── 4 ──
test("Malformed exception file fails closed", () => {
  const audit = readJson("audit-lodash-two-high.json");
  const exceptions = readJson("malformed-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
  assert(result.report.includes("required non-empty"));
});

// ── 5 ──
test("One advisory excepted, second uncovered for same package fails", () => {
  const audit = readJson("audit-lodash-two-high.json");
  const exceptions = readJson("partial-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false);
  const lodash = result.failures.find(f => f.type === "uncovered_advisory" && f.package === "lodash");
  assert(lodash, "Expected uncovered_advisory for lodash");
  assert(lodash.ghsa === "GHSA-p6mc-m468-83gw", "GHSA-p6mc should be the uncovered one");
  assert(result.report.includes("PASS:"), "First advisory should show PASS");
  assert(result.report.includes("FAIL:"), "Second advisory should show FAIL");
});

// ── 6 ──
test("Invalid audit JSON shape fails closed", () => {
  const cases = [
    { vulnerabilities: {} },
    { auditReportVersion: 2 },
    null,
    "not json",
  ];
  for (const c of cases) {
    const r = checkAudit(c, []);
    assert(r.pass === false, `Expected fail for ${JSON.stringify(c)}`);
    assert(r.failures.some(f => f.type === "invalid_audit_shape"));
  }
});

// ── 7 ──
test("Invalid GHSA ID format in exception fails validation", () => {
  const bad = [{ id: "CVE-2023-1234", package: "test", owner: "t", rationale: "t", compensating_control: "t", expiry: "2099-01-01", review_trigger: "t" }];
  const result = checkAudit(readJson("audit-lodash-two-high.json"), bad);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
  assert(result.report.includes("GHSA"));
});

// ── 8 ──
test("Moderate severity advisory is not blocking", () => {
  const audit = readJson("audit-aggregate-severity.json");
  const exceptions = readJson("aggregate-severity-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === true, `Expected pass — moderate advisory should not block. Got: ${result.report}`);
  assert(result.report.includes("below threshold"), "Moderate advisory should show below-threshold INFO");
  assert(result.report.includes("PASS:"), "High advisory should show PASS with exception");
});

// ── 9 ──
test("Empty vulnerabilities with no exceptions passes", () => {
  const audit = readJson("audit-empty.json");
  const result = checkAudit(audit, []);
  assert(result.pass === true, "Expected pass for empty vulns");
  assert(result.report.includes("PASS"));
});

// ── 10 ──
test("Exception for wrong package does not match", () => {
  const audit = readJson("audit-lodash-one-high.json");
  const exceptions = readJson("package-mismatch-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false, "Expected fail — GHSA excepted for react-router but advisory is on lodash");
  const uncovered = result.failures.find(f => f.type === "uncovered_advisory");
  assert(uncovered, "Expected uncovered_advisory");
  assert(uncovered.wrong_package_exception === true, "Should flag wrong_package_exception");
  assert(result.report.includes("Package mismatch"), "Report should mention package mismatch");
});

// ── 11 ──
test("High advisory without GHSA URL fails closed", () => {
  const audit = readJson("audit-no-ghsa-url.json");
  const result = checkAudit(audit, []);
  assert(result.pass === false, "Expected fail for advisory without GHSA");
  assert(result.failures.some(f => f.type === "advisory_without_ghsa"));
  assert(result.report.includes("no extractable GHSA"), "Report should mention no GHSA");
});

// ── 12 ──
test("Inherited string-only via with missing referenced package fails", () => {
  const audit = readJson("audit-missing-reference.json");
  const result = checkAudit(audit, []);
  assert(result.pass === false, "Expected fail for missing reference");
  const failure = result.failures.find(f => f.type === "missing_dependency_reference");
  assert(failure, "Expected missing_dependency_reference failure");
  assert(failure.referenced_package === "nonexistent-pkg");
});

// ── 13 ──
test("Aggregate severity does not require exception for moderate advisory", () => {
  const audit = readJson("audit-aggregate-severity.json");
  const exceptions = readJson("aggregate-severity-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === true, `Expected pass. Got: ${result.report}`);
  assert(!result.failures.some(f => f.type === "uncovered_advisory"),
    "Moderate advisory should not produce uncovered_advisory");
});

// ── 14 ──
test("Unused active exception fails", () => {
  const audit = readJson("audit-empty.json");
  const exceptions = readJson("stale-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false, "Expected fail for stale exception");
  const failure = result.failures.find(f => f.type === "unused_exception");
  assert(failure, "Expected unused_exception failure");
  assert(failure.id === "GHSA-cccc-cccc-cccc");
  assert(result.report.includes("Stale exceptions"));
});

// ── 15 ──
test("Duplicate GHSA ID in exceptions fails validation", () => {
  const dupes = [
    { id: "GHSA-aaaa-aaaa-aaaa", package: "pkg1", owner: "t", rationale: "t", compensating_control: "t", expiry: "2099-01-01", review_trigger: "t" },
    { id: "GHSA-aaaa-aaaa-aaaa", package: "pkg2", owner: "t", rationale: "t", compensating_control: "t", expiry: "2099-01-01", review_trigger: "t" },
  ];
  const result = checkAudit(readJson("audit-empty.json"), dupes);
  assert(result.pass === false, "Expected fail for duplicate IDs");
  assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
});

// ── 16 ──
test("Via advisory object missing url fails shape validation", () => {
  const badAudit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "bad-pkg": {
        name: "bad-pkg", severity: "high", isDirect: true,
        via: [{ source: 1, name: "bad-pkg", dependency: "bad-pkg", title: "Bad", severity: "high", cwe: [], cvss: { score: 8 }, range: "*" }],
        effects: [], range: "*", nodes: ["node_modules/bad-pkg"], fixAvailable: true,
      },
    },
  };
  const result = checkAudit(badAudit, []);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_vulnerability_shape"));
});

// ── 17 ──
test("Via advisory object missing severity fails shape validation", () => {
  const badAudit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "bad-pkg": {
        name: "bad-pkg", severity: "high", isDirect: true,
        via: [{ source: 1, name: "bad-pkg", dependency: "bad-pkg", title: "Bad", url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx", cwe: [], cvss: { score: 8 }, range: "*" }],
        effects: [], range: "*", nodes: ["node_modules/bad-pkg"], fixAvailable: true,
      },
    },
  };
  const result = checkAudit(badAudit, []);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_vulnerability_shape"));
});

// ── 18 ──
test("Advisory on sub-dep matched by advisory package name (moderate advisory exception unused)", () => {
  // Exception for GHSA-bbbb on "sub-dep" is for a MODERATE advisory — it should be flagged as stale.
  // Only the high advisory (GHSA-aaaa) needs an exception.
  const audit = readJson("audit-aggregate-severity.json");
  const exceptions = [
    { id: "GHSA-aaaa-aaaa-aaaa", package: "mixed-pkg", owner: "t", rationale: "t", compensating_control: "t", expiry: "2099-01-01", review_trigger: "t" },
  ];
  const result = checkAudit(audit, exceptions);
  assert(result.pass === true, `Expected pass — only the high advisory needs an exception. Got: ${result.report}`);
});

// ── 19. Inherited string-only via with BLOCKING child → pass ──
test("Inherited string-only via with valid blocking child passes", () => {
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "parent-pkg": {
        name: "parent-pkg", severity: "high", isDirect: true,
        via: ["child-pkg"],
        effects: [], range: "<=1.0.0", nodes: [], fixAvailable: true,
      },
      "child-pkg": {
        name: "child-pkg", severity: "high", isDirect: false,
        via: [{
          source: 1, name: "child-pkg", dependency: "child-pkg",
          title: "High vuln in child",
          url: "https://github.com/advisories/GHSA-dddd-dddd-dddd",
          severity: "high", cwe: [], cvss: { score: 8 }, range: "<=1.0.0",
        }],
        effects: [], range: "<=1.0.0", nodes: [], fixAvailable: true,
      },
    },
  };
  const exceptions = [
    { id: "GHSA-dddd-dddd-dddd", package: "child-pkg", owner: "t", rationale: "t", compensating_control: "t", expiry: "2099-01-01", review_trigger: "t" },
  ];
  const result = checkAudit(audit, exceptions);
  assert(result.pass === true, `Expected pass — child excepted, parent inherits. Got: ${result.report}`);
  assert(result.report.includes("evaluated as blocking"), "Inherited entry should mention evaluated as blocking");
});

// ── 20. Wrapper regression: invariant ──
test("Wrapper regression: react-router.config.ts invalidates exception", () => {
  const tmpDir = join(tmpdir(), `sec10-invariant-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "react-router.config.ts"), "// RSC mode enabled\n");

  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "react-router": {
        name: "react-router", severity: "high", isDirect: false,
        via: [{
          source: 1, name: "react-router", dependency: "react-router",
          title: "RSC CSRF Bypass",
          url: "https://github.com/advisories/GHSA-qwww-vcr4-c8h2",
          severity: "high", cwe: [], cvss: { score: 7 }, range: ">=7.12.0 <8.3.0",
        }],
        effects: [], range: ">=7.12.0 <8.3.0", nodes: [], fixAvailable: false,
      },
    },
  };
  const exceptions = [
    { id: "GHSA-qwww-vcr4-c8h2", package: "react-router", owner: "t", rationale: "t", compensating_control: "t", expiry: "2099-01-01", review_trigger: "t" },
  ];
  const result = checkAudit(audit, exceptions, { projectDir: tmpDir });
  assert(result.pass === false, "Expected FAIL when react-router.config.ts exists");
  assert(result.failures.some(f => f.type === "invariant_violated"));
  assert(result.report.includes("Architecture invariant violated"));

  unlinkSync(join(tmpDir, "react-router.config.ts"));
  rmdirSync(tmpDir);
});

// ═══════════════════════════════════════════════════════════════════
// NEW TESTS: second quality pass
// ═══════════════════════════════════════════════════════════════════

// ── 21 [A]. Expired exception with EMPTY audit → FAIL ──
test("Expired exception fails even with zero vulnerabilities", () => {
  const audit = readJson("audit-empty.json");
  const exceptions = readJson("expired-empty-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false, "Expired exception must fail even with empty audit");
  assert(result.failures.some(f => f.type === "expired_exception"), "Expected expired_exception failure");
  assert(result.report.includes("Expired exceptions"), "Report should mention expired exceptions");
});

// ── 22 [B]. Exception matching only moderate advisory → stale/unused → FAIL ──
test("Exception matching only moderate advisory is treated as stale", () => {
  const audit = readJson("audit-moderate-only.json");
  const exceptions = readJson("moderate-match-exceptions.json").exceptions;
  const result = checkAudit(audit, exceptions);
  assert(result.pass === false,
    "Expected fail — exception matches only a moderate (below-threshold) advisory and should be stale");
  assert(result.failures.some(f => f.type === "unused_exception"),
    "Expected unused_exception for exception that only matches moderate");
  assert(result.report.includes("does not match any BLOCKING advisory"),
    "Report should clarify it doesn't match any BLOCKING advisory");
  assert(result.report.includes("below threshold"),
    "Moderate advisory should still show below-threshold INFO");
});

// ── 23 [C1]. High vuln with empty via array → fail closed ──
test("High severity vuln with empty via array fails closed", () => {
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "mystery-pkg": {
        name: "mystery-pkg",
        severity: "high",
        isDirect: true,
        via: [],
        effects: [],
        range: "*",
        nodes: ["node_modules/mystery-pkg"],
        fixAvailable: false,
      },
    },
  };
  const result = checkAudit(audit, []);
  assert(result.pass === false, "Expected fail for high vuln with empty via");
  const failure = result.failures.find(f => f.type === "empty_via_blocking");
  assert(failure, "Expected empty_via_blocking failure");
  assert(failure.package === "mystery-pkg");
  assert(result.report.includes("empty via array"), "Report should mention empty via array");
});

// ── 24 [C2]. High parent referencing low-only child → fail ──
test("High parent with via to low-only child fails", () => {
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "parent-high": {
        name: "parent-high",
        severity: "high",
        isDirect: true,
        via: ["child-low"],
        effects: [],
        range: "<=1.0.0",
        nodes: [],
        fixAvailable: true,
      },
      "child-low": {
        name: "child-low",
        severity: "low",
        isDirect: false,
        via: [{
          source: 444, name: "child-low", dependency: "child-low",
          title: "Low severity vuln — should not explain high parent",
          url: "https://github.com/advisories/GHSA-gggg-gggg-gggg",
          severity: "low", cwe: [], cvss: { score: 2 }, range: "<=1.0.0",
        }],
        effects: [],
        range: "<=1.0.0",
        nodes: [],
        fixAvailable: true,
      },
    },
  };
  const result = checkAudit(audit, []);
  assert(result.pass === false,
    "Expected fail — high parent with low-only child has no valid blocking chain");
  const failure = result.failures.find(f => f.type === "nonblocking_inherited_chain");
  assert(failure, "Expected nonblocking_inherited_chain failure");
  assert(failure.package === "parent-high");
  assert(failure.refs.includes("child-low"));
  assert(result.report.includes("no direct or inherited blocking advisory"),
    "Report should explain the inherited chain issue");
});

// ── 25 [F]. Expiry date-only: same-day UTC still valid ──
test("Expiry date boundary: exception valid through end of expiry day", () => {
  // Today's date in ISO, plus 1 day as expiry — still valid today
  const tomorrow = new Date(Date.now() + 86_400_000);
  const expiryDate = tomorrow.toISOString().slice(0, 10);

  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "test-pkg": {
        name: "test-pkg", severity: "high", isDirect: true,
        via: [{
          source: 1, name: "test-pkg", dependency: "test-pkg",
          title: "Test high vuln",
          url: "https://github.com/advisories/GHSA-hhhh-hhhh-hhhh",
          severity: "high", cwe: [], cvss: { score: 8 }, range: "*",
        }],
        effects: [], range: "*", nodes: [], fixAvailable: true,
      },
    },
  };
  const exceptions = [
    { id: "GHSA-hhhh-hhhh-hhhh", package: "test-pkg", owner: "t", rationale: "t", compensating_control: "t", expiry: expiryDate, review_trigger: "t" },
  ];
  const result = checkAudit(audit, exceptions);
  assert(result.pass === true,
    `Expected pass — expiry ${expiryDate} should be valid through end of today. Got: ${result.report}`);
  assert(!result.failures.some(f => f.type === "expired_exception"), "Should not have expired_exception");
});

// ── 26. Expiry must be a real date-only value ──
test("Expiry requires a real YYYY-MM-DD date", () => {
  const audit = readJson("audit-empty.json");
  const base = {
    id: "GHSA-iiii-iiii-iiii", package: "test-pkg", owner: "t",
    rationale: "t", compensating_control: "t", review_trigger: "t",
  };

  for (const expiry of ["2099-01-01T12:00:00Z", "2099-02-30", "01/01/2099"]) {
    const result = checkAudit(audit, [{ ...base, expiry }]);
    assert(result.pass === false, `Expected invalid expiry ${expiry} to fail`);
    assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
  }
});

// ── 27. Project scoping metadata must not silently broaden ──
test("Invalid exception project scope fails validation", () => {
  const result = checkAudit(readJson("audit-empty.json"), [{
    id: "GHSA-jjjj-jjjj-jjjj", package: "test-pkg", owner: "t",
    rationale: "t", compensating_control: "t", expiry: "2099-01-01",
    review_trigger: "t", projects: "app/web",
  }]);
  assert(result.pass === false, "String project scope must not be treated as global");
  assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
});

// ── 28. Mixed direct/inherited metadata must explain high severity ──
test("Mixed via array without blocking advisory fails closed", () => {
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "mixed-high": {
        name: "mixed-high", severity: "high", isDirect: true,
        via: [{
          source: 1, name: "mixed-high", dependency: "mixed-high",
          title: "Moderate only", url: "https://github.com/advisories/GHSA-kkkk-kkkk-kkkk",
          severity: "moderate", range: "*",
        }, "child-low"],
        effects: [], range: "*", nodes: [], fixAvailable: false,
      },
      "child-low": {
        name: "child-low", severity: "low", isDirect: false,
        via: [{
          source: 2, name: "child-low", dependency: "child-low",
          title: "Low only", url: "https://github.com/advisories/GHSA-llll-llll-llll",
          severity: "low", range: "*",
        }],
        effects: [], range: "*", nodes: [], fixAvailable: false,
      },
    },
  };
  const result = checkAudit(audit, []);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "nonblocking_inherited_chain"));
});

// ── 29. Cyclic inherited references cannot overflow or pass ──
test("Cyclic inherited graph fails closed without recursion overflow", () => {
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "cycle-a": {
        name: "cycle-a", severity: "high", isDirect: true, via: ["cycle-b"],
        effects: [], range: "*", nodes: [], fixAvailable: false,
      },
      "cycle-b": {
        name: "cycle-b", severity: "high", isDirect: false, via: ["cycle-a"],
        effects: [], range: "*", nodes: [], fixAvailable: false,
      },
    },
  };
  const result = checkAudit(audit, []);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "nonblocking_inherited_chain"));
});

// ── 30. Missing registry array cannot silently become empty ──
test("Missing exception registry array fails closed", () => {
  const result = checkAudit(readJson("audit-empty.json"), undefined);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
});

// ── 31. Invalid exception entries produce a controlled failure ──
test("Non-object exception entry fails closed", () => {
  const result = checkAudit(readJson("audit-empty.json"), [null]);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_exceptions_file"));
});

// ── 32. Invalid vulnerability containers and entries fail closed ──
test("Invalid vulnerability container and entry fail closed", () => {
  const cases = [
    { auditReportVersion: 2, vulnerabilities: [] },
    { auditReportVersion: 2, vulnerabilities: { "bad-pkg": null } },
  ];
  for (const audit of cases) {
    const result = checkAudit(audit, []);
    assert(result.pass === false, `Expected failure for ${JSON.stringify(audit)}`);
  }
});

// ── 33. Unknown severity values cannot bypass policy ──
test("Unknown severity fails closed", () => {
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      "bad-pkg": {
        name: "bad-pkg", severity: "severe", isDirect: true,
        via: [{
          source: 1, name: "bad-pkg", dependency: "bad-pkg",
          title: "Unknown severity", url: "https://github.com/advisories/GHSA-mmmm-mmmm-mmmm",
          severity: "severe", range: "*",
        }],
        effects: [], range: "*", nodes: [], fixAvailable: false,
      },
    },
  };
  const result = checkAudit(audit, []);
  assert(result.pass === false);
  assert(result.failures.some(f => f.type === "invalid_vulnerability_shape"));
});

// ═══════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) process.exit(1);
