#!/usr/bin/env node

/**
 * check-e2e-results.mjs: the zero-tolerance gate over Playwright's JSON report.
 *
 * Playwright already exits non-zero when a test fails. This gate exists for the
 * cases that exit code can hide, and so that the web-e2e job states its policy
 * in code rather than in a flag:
 *
 *   - ANY failed test fails the job (`unexpected > 0`).
 *   - ANY flaky test fails the job (`flaky > 0`: it passed only on a retry).
 *     The config sets retries to 0, so this only fires if someone adds retries;
 *     the gate then refuses to let a retry turn a red test green.
 *   - A run that executed nothing fails (`expected < minTests`). A broken glob,
 *     a renamed project or a crashed global setup would otherwise read as a
 *     clean, empty pass.
 *   - A run that silently DROPPED a spec fails. The totals above cannot see it:
 *     if candidate-r1.e2e.ts left the collection (a renamed project, a changed
 *     `testMatch`, a `--grep`), the recruiter tests would still pass and the gate
 *     would read green with no R1 coverage at all. So the CLI also requires every
 *     spec in REQUIRED_E2E_COVERAGE to have passed tests on every project it
 *     names, at or above that spec's floor. Skipped tests do not count as passed.
 *   - Runner-level errors in the report fail the job.
 *
 * Skipped tests are allowed and reported: mobile-only states legitimately skip
 * on the desktop project.
 *
 * Usage: node scripts/check-e2e-results.mjs <path to results.json> [minTests]
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * The specs the web-e2e job must actually run, and where. `minPassed` is a
 * per-project floor: the R1 spec has 25 tests per project today, and 20 leaves
 * room to retire a few without letting a dropped `describe` block go unseen.
 * `app.e2e.ts` is the recruiter suite owned by other work, so it only has to be
 * present and passing.
 */
export const REQUIRED_E2E_COVERAGE = Object.freeze([
  Object.freeze({ file: 'app.e2e.ts', projects: ['desktop', 'mobile'], minPassed: 1 }),
  Object.freeze({ file: 'candidate-r1.e2e.ts', projects: ['desktop', 'mobile'], minPassed: 20 }),
]);

const baseName = (file) => String(file ?? '').split(/[\\/]/).pop();

/** Count passed and total tests per `<file> [<project>]` by walking the report's suites. */
export function countTestsBySpec(report) {
  const counts = new Map();
  const visit = (suites) => {
    for (const suite of Array.isArray(suites) ? suites : []) {
      for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
        const file = baseName(spec.file ?? suite.file);
        for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
          const key = `${file} [${test.projectName}]`;
          const entry = counts.get(key) ?? { passed: 0, total: 0 };
          entry.total += 1;
          // `expected` is Playwright's word for "ran and matched its expected outcome".
          if (test.status === 'expected') entry.passed += 1;
          counts.set(key, entry);
        }
      }
      visit(suite.suites);
    }
  };
  visit(report?.suites);
  return counts;
}

export function evaluateE2eReport(report, { minTests = 1, requiredCoverage = [] } = {}) {
  const stats = report && typeof report === 'object' ? report.stats : undefined;
  if (!stats || typeof stats !== 'object') {
    return { ok: false, errors: ['the report has no stats block'], summary: null };
  }
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const expected = count(stats.expected);
  const unexpected = count(stats.unexpected);
  const flaky = count(stats.flaky);
  const skipped = count(stats.skipped);
  if ([expected, unexpected, flaky, skipped].includes(null)) {
    return { ok: false, errors: ['the report stats are not whole numbers'], summary: null };
  }

  const errors = [];
  if (unexpected > 0) errors.push(`${unexpected} test(s) failed`);
  if (flaky > 0) errors.push(`${flaky} test(s) were flaky (passed only on a retry)`);
  if (expected < minTests) {
    errors.push(`only ${expected} test(s) passed; at least ${minTests} must run and pass`);
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    errors.push(`${report.errors.length} runner error(s) in the report`);
  }
  if (requiredCoverage.length > 0) {
    const bySpec = countTestsBySpec(report);
    for (const { file, projects, minPassed = 1 } of requiredCoverage) {
      for (const project of projects) {
        const passed = bySpec.get(`${file} [${project}]`)?.passed ?? 0;
        if (passed < minPassed) {
          errors.push(
            `${file} [${project}]: ${passed} test(s) passed; at least ${minPassed} must run ` +
              'and pass (was the spec dropped from the run?)',
          );
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, summary: { expected, unexpected, flaky, skipped } };
}

async function main() {
  const [file, min] = process.argv.slice(2);
  if (!file) {
    console.error('usage: check-e2e-results.mjs <results.json> [minTests]');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.error(`cannot read the Playwright report ${file}: ${error.message}`);
    process.exit(1);
  }
  const verdict = evaluateE2eReport(report, {
    minTests: min ? Number(min) : 1,
    requiredCoverage: REQUIRED_E2E_COVERAGE,
  });
  if (verdict.summary) {
    const { expected, unexpected, flaky, skipped } = verdict.summary;
    console.log(`e2e: ${expected} passed, ${unexpected} failed, ${flaky} flaky, ${skipped} skipped`);
  }
  if (!verdict.ok) {
    for (const error of verdict.errors) console.error(`e2e gate: ${error}`);
    process.exit(1);
  }
  console.log('e2e gate: zero failures');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
