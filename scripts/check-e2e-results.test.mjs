#!/usr/bin/env node

/**
 * check-e2e-results.test.mjs: self-test for the zero-tolerance e2e gate, plus a
 * pin that the web-e2e workflow actually runs it and tolerates nothing.
 *
 * Run: node scripts/check-e2e-results.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countTestsBySpec,
  evaluateE2eReport,
  REQUIRED_E2E_COVERAGE,
} from './check-e2e-results.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stats = (overrides = {}) => ({ stats: { expected: 12, unexpected: 0, flaky: 0, skipped: 0, ...overrides } });

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
};

check('a clean run passes', () => {
  assert.equal(evaluateE2eReport(stats()).ok, true);
});

check('skipped tests are allowed and reported', () => {
  const verdict = evaluateE2eReport(stats({ skipped: 3 }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.summary.skipped, 3);
});

check('one failed test fails the gate', () => {
  const verdict = evaluateE2eReport(stats({ unexpected: 1 }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(), /1 test\(s\) failed/);
});

check('a flaky test fails the gate even though it eventually passed', () => {
  const verdict = evaluateE2eReport(stats({ flaky: 1 }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(), /flaky/);
});

check('a run that executed nothing is not a pass', () => {
  assert.equal(evaluateE2eReport(stats({ expected: 0 })).ok, false);
  assert.equal(evaluateE2eReport(stats({ expected: 5 }), { minTests: 6 }).ok, false);
  assert.equal(evaluateE2eReport(stats({ expected: 6 }), { minTests: 6 }).ok, true);
});

check('runner-level errors fail the gate', () => {
  const report = { ...stats(), errors: [{ message: 'globalSetup failed' }] };
  assert.equal(evaluateE2eReport(report).ok, false);
});

check('a malformed report fails closed', () => {
  for (const report of [null, undefined, 'ok', {}, { stats: null }, stats({ expected: '12' }), stats({ unexpected: -1 }), stats({ flaky: 1.5 })]) {
    assert.equal(evaluateE2eReport(report).ok, false, JSON.stringify(report));
  }
});

// ── Coverage: the gate must notice a spec that silently left the run ─────────────────────────

const APP = 'app.e2e.ts';
const R1 = 'candidate-r1.e2e.ts';

/** A Playwright JSON report spec: one test on one project. */
const test = (file, projectName, status = 'expected') => ({ file, tests: [{ projectName, status }] });
const tests = (file, projectName, count, status) =>
  Array.from({ length: count }, () => test(file, projectName, status));
/** A file's suite with its tests inside a nested `describe`, as Playwright reports them. */
const suite = (file, specs) => ({ title: file, file, specs: [], suites: [{ title: 'group', file, specs }] });

const both = (file, count, status) => [
  ...tests(file, 'desktop', count, status),
  ...tests(file, 'mobile', count, status),
];
const report = (suites, overrides) => ({ ...stats(overrides), suites });
const FULL = () => [suite(APP, both(APP, 49)), suite(R1, both(R1, 25))];
const withCoverage = (given) => evaluateE2eReport(given, { requiredCoverage: REQUIRED_E2E_COVERAGE });

check('coverage counts passed tests per spec and project, through nested suites', () => {
  const counts = countTestsBySpec(report(FULL()));
  assert.deepEqual(counts.get(`${R1} [desktop]`), { passed: 25, total: 25 });
  assert.deepEqual(counts.get(`${R1} [mobile]`), { passed: 25, total: 25 });
  assert.deepEqual(counts.get(`${APP} [mobile]`), { passed: 49, total: 49 });
  const mixed = countTestsBySpec(
    report([suite(R1, [test(R1, 'desktop'), test(R1, 'desktop', 'skipped'), test(R1, 'desktop', 'unexpected')])]),
  );
  assert.deepEqual(mixed.get(`${R1} [desktop]`), { passed: 1, total: 3 });
  assert.equal(countTestsBySpec(null).size, 0);
});

check('a run with both specs on both projects passes the coverage gate', () => {
  assert.equal(withCoverage(report(FULL())).ok, true);
});

check('dropping candidate-r1.e2e.ts is caught even though every remaining test passes', () => {
  const verdict = withCoverage(report([suite(APP, both(APP, 49))]));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /candidate-r1\.e2e\.ts \[desktop\]: 0 test\(s\) passed/);
  assert.match(verdict.errors.join('\n'), /candidate-r1\.e2e\.ts \[mobile\]: 0 test\(s\) passed/);
  assert.match(verdict.errors.join('\n'), /dropped from the run/);
});

check('dropping app.e2e.ts is caught too', () => {
  const verdict = withCoverage(report([suite(R1, both(R1, 25))]));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /app\.e2e\.ts \[desktop\]/);
});

check('losing one project of a spec is caught', () => {
  const noMobile = [suite(APP, both(APP, 49)), suite(R1, tests(R1, 'desktop', 25))];
  const verdict = withCoverage(report(noMobile));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /candidate-r1\.e2e\.ts \[mobile\]/);
  assert.doesNotMatch(verdict.errors.join('\n'), /candidate-r1\.e2e\.ts \[desktop\]/);
});

check('a spec whose tests all skipped or failed has no coverage', () => {
  for (const status of ['skipped', 'unexpected', 'flaky']) {
    const verdict = withCoverage(report([suite(APP, both(APP, 49)), suite(R1, both(R1, 25, status))]));
    assert.equal(verdict.ok, false, status);
    assert.match(verdict.errors.join('\n'), /candidate-r1\.e2e\.ts/);
  }
});

check('the R1 spec has a floor, so a dropped describe block is caught', () => {
  const floor = REQUIRED_E2E_COVERAGE.find((entry) => entry.file === R1).minPassed;
  assert.ok(floor >= 20 && floor <= 25, `the floor ${floor} must be realistic for 25 tests`);
  const atFloor = [suite(APP, both(APP, 49)), suite(R1, both(R1, floor))];
  assert.equal(withCoverage(report(atFloor)).ok, true);
  const belowFloor = [suite(APP, both(APP, 49)), suite(R1, both(R1, floor - 1))];
  const verdict = withCoverage(report(belowFloor));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), new RegExp(`at least ${floor} must run and pass`));
});

check('a report with no suites at all has no coverage', () => {
  assert.equal(withCoverage(stats()).ok, false);
  assert.equal(withCoverage({ ...stats(), suites: [] }).ok, false);
});

check('coverage is reported alongside the totals, and is off unless asked for', () => {
  assert.equal(evaluateE2eReport(stats()).ok, true);
  assert.equal(evaluateE2eReport(report([suite(APP, both(APP, 49))])).ok, true);
  const verdict = withCoverage(report([suite(APP, both(APP, 49))], { unexpected: 1 }));
  assert.ok(verdict.errors.length >= 2);
});

check('file names are matched by base name, so a path prefix or backslashes do not hide a spec', () => {
  const prefixed = (file) => `e2e\\sub/${file}`;
  const suites = [suite(prefixed(APP), both(prefixed(APP), 49)), suite(prefixed(R1), both(prefixed(R1), 25))];
  assert.equal(withCoverage(report(suites)).ok, true);
});

check('the required coverage names both specs on both projects', () => {
  assert.deepEqual(
    REQUIRED_E2E_COVERAGE.map((entry) => [entry.file, [...entry.projects]]),
    [
      [APP, ['desktop', 'mobile']],
      [R1, ['desktop', 'mobile']],
    ],
  );
});

check('the CLI exits non-zero for a failing report and zero for a clean one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-gate-'));
  try {
    const gate = path.join(HERE, 'check-e2e-results.mjs');
    const run = (given) => {
      const file = path.join(dir, 'results.json');
      writeFileSync(file, JSON.stringify(given));
      return spawnSync(process.execPath, [gate, file], { encoding: 'utf8' });
    };
    assert.equal(run(report(FULL())).status, 0);
    assert.equal(run(report(FULL(), { unexpected: 2 })).status, 1);
    const missing = spawnSync(process.execPath, [gate, path.join(dir, 'absent.json')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);

    // The CLI enforces the coverage by default: totals alone, or a dropped R1 spec, are red.
    assert.equal(run(stats()).status, 1);
    const dropped = run(report([suite(APP, both(APP, 49))]));
    assert.equal(dropped.status, 1);
    assert.match(dropped.stderr, /candidate-r1\.e2e\.ts \[desktop\]/);
  } finally {
    // Remove exactly what this check created: one file, then the empty directory.
    unlinkSync(path.join(dir, 'results.json'));
    rmdirSync(dir);
  }
});

const workflowText = await readFile(path.join(HERE, '..', '.github', 'workflows', 'web-e2e.yml'), 'utf8');
// Comments may NAME a forbidden construct (the header explains the policy); only code counts.
const workflow = workflowText.replace(/^\s*#.*$/gm, '');

check('the web-e2e workflow runs on Linux with the zero-tolerance gate and no escape hatches', () => {
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /npm run e2e(\s|$)/);
  assert.match(workflow, /node scripts\/check-e2e-results\.mjs/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /--retries/);
  assert.doesNotMatch(workflow, /\|\|\s*true/);
  assert.doesNotMatch(workflow, /@shots/);
});

check('the web-e2e workflow pins every action by commit SHA', () => {
  const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 3, 'expected checkout, setup-node and upload-artifact');
  for (const reference of uses) assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be pinned to a full SHA`);
});

check('the web-e2e workflow is least-privilege and bounded', () => {
  assert.match(workflow, /^permissions:\s*\n\s+contents: read/m);
  assert.match(workflow, /timeout-minutes: \d+/);
});

const playwrightConfig = await readFile(path.join(HERE, '..', 'app', 'web', 'e2e', 'playwright.config.ts'), 'utf8');

check('the browser gets a fake camera and microphone, with permissions, from the config', () => {
  assert.match(playwrightConfig, /'--use-fake-device-for-media-stream'/);
  assert.match(playwrightConfig, /'--use-fake-ui-for-media-stream'/);
  assert.match(playwrightConfig, /permissions: \['camera', 'microphone'\]/);
  assert.match(playwrightConfig, /retries: 0/);
  assert.match(playwrightConfig, /forbidOnly: Boolean\(process\.env\.CI\)/);
});

check('the gate reads the report the config writes', () => {
  assert.match(playwrightConfig, /outputFile: path\.join\(ARTIFACTS, 'results\.json'\)/);
  assert.match(workflow, /check-e2e-results\.mjs app\/web\/e2e\/\.artifacts\/results\.json/);
});

check('every spec and project the gate requires exists in the config, and `npm run e2e` collects it', () => {
  for (const { file, projects } of REQUIRED_E2E_COVERAGE) {
    const specPath = path.join(HERE, '..', 'app', 'web', 'e2e', file);
    assert.ok(existsSync(specPath), `${file} must exist`);
    assert.doesNotMatch(readFileSync(specPath, 'utf8'), /@shots/, `${file} must not be tagged @shots`);
    for (const project of projects) {
      assert.match(playwrightConfig, new RegExp(`name: '${project}'`), `project ${project} must exist`);
    }
  }
  // The collection pattern must still match the required specs, and `npm run e2e` may exclude
  // only the screenshot specs by tag, so a required spec cannot fall out through a grep.
  assert.match(playwrightConfig, /testMatch: \/\.\*\\\.e2e\\\.ts\$\//);
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'app', 'web', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.e2e, /--grep-invert @shots$/);
});

console.log(`${checks} checks passed`);
