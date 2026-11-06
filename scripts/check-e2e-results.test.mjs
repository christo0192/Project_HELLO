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
  mergeE2eReports,
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

// ── The projects run as parallel jobs, so the gate reads one report per project ─────────────

const onProject = (project) => [suite(APP, tests(APP, project, 49)), suite(R1, tests(R1, project, 25))];
const desktopReport = (overrides) => report(onProject('desktop'), overrides);
const mobileReport = (overrides) => report(onProject('mobile'), overrides);

check('two project reports merge into one run that passes the coverage gate', () => {
  const merged = mergeE2eReports([desktopReport(), mobileReport()]);
  assert.equal(withCoverage(merged).ok, true);
  assert.equal(merged.stats.expected, 24);
  assert.deepEqual(countTestsBySpec(merged).get(`${R1} [mobile]`), { passed: 25, total: 25 });
});

check('one project alone does not pass, so a project that never reported is caught', () => {
  const verdict = withCoverage(mergeE2eReports([desktopReport()]));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /candidate-r1\.e2e\.ts \[mobile\]/);
});

check('a failure, a flaky test or a runner error in either report fails the merged run', () => {
  assert.equal(withCoverage(mergeE2eReports([desktopReport(), mobileReport({ unexpected: 1 })])).ok, false);
  assert.equal(withCoverage(mergeE2eReports([desktopReport({ flaky: 1 }), mobileReport()])).ok, false);
  const crashed = { ...mobileReport(), errors: [{ message: 'worker crashed' }] };
  assert.equal(withCoverage(mergeE2eReports([desktopReport(), crashed])).ok, false);
});

check('a malformed report fails the merged run closed', () => {
  for (const bad of [null, undefined, 'ok', {}, { stats: null }, stats({ expected: '12' }), stats({ unexpected: -1 })]) {
    assert.equal(withCoverage(mergeE2eReports([desktopReport(), bad])).ok, false, JSON.stringify(bad));
  }
});

check('the CLI reads several reports, and a missing one is red', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-gate-'));
  const first = path.join(dir, 'desktop.json');
  const second = path.join(dir, 'mobile.json');
  try {
    const gate = path.join(HERE, 'check-e2e-results.mjs');
    const run = (...args) => spawnSync(process.execPath, [gate, ...args], { encoding: 'utf8' });
    writeFileSync(first, JSON.stringify(desktopReport()));
    writeFileSync(second, JSON.stringify(mobileReport()));
    assert.equal(run(first, second).status, 0);
    assert.equal(run(first, second, '24').status, 0);
    assert.equal(run(first, second, '25').status, 1);
    assert.equal(run(first).status, 1, 'one project alone must not pass');
    assert.equal(run(first, path.join(dir, 'absent.json')).status, 1);
    writeFileSync(second, JSON.stringify(mobileReport({ unexpected: 1 })));
    assert.equal(run(first, second).status, 1);
  } finally {
    // Remove exactly what this check created: two files, then the empty directory.
    unlinkSync(first);
    unlinkSync(second);
    rmdirSync(dir);
  }
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
  assert.equal(workflow.match(/timeout-minutes: \d+/g).length, 2, 'both jobs must be bounded');
});

check('both projects run, each one finishes, and each one reports', () => {
  assert.match(workflow, /project: \[desktop, mobile\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /npm run e2e -- --project=\$\{\{ matrix\.project \}\}/);
  assert.match(workflow, /name: web-e2e-artifacts-\$\{\{ matrix\.project \}\}/);
  // `.artifacts` is hidden: without this the upload finds nothing and only warns.
  assert.match(workflow, /path: app\/web\/e2e\/\.artifacts\n\s+include-hidden-files: true/);
});

check('the web-e2e job is the verdict, reads both reports and runs even after a failure', () => {
  const verdictJob = workflow.slice(workflow.indexOf('\n  web-e2e:'));
  assert.ok(verdictJob.length > 1, 'no web-e2e job');
  assert.match(verdictJob, /name: web-e2e\n/);
  assert.match(verdictJob, /needs: e2e-project/);
  assert.match(verdictJob, /^ {4}if: always\(\)/m);
  assert.match(verdictJob, /node scripts\/check-e2e-results\.test\.mjs/);
  assert.match(verdictJob, /test "\$PROJECTS_RESULT" = success/);
  assert.match(verdictJob, /PROJECTS_RESULT: \$\{\{ needs\.e2e-project\.result \}\}/);
});

const playwrightConfig = await readFile(path.join(HERE, '..', 'app', 'web', 'e2e', 'playwright.config.ts'), 'utf8');

check('the browser gets a fake camera and microphone, with permissions, from the config', () => {
  assert.match(playwrightConfig, /'--use-fake-device-for-media-stream'/);
  assert.match(playwrightConfig, /'--use-fake-ui-for-media-stream'/);
  assert.match(playwrightConfig, /permissions: \['camera', 'microphone'\]/);
  assert.match(playwrightConfig, /retries: 0/);
  assert.match(playwrightConfig, /forbidOnly: Boolean\(process\.env\.CI\)/);
});

check('the gate reads the report the config writes, from both projects', () => {
  assert.match(playwrightConfig, /outputFile: path\.join\(ARTIFACTS, 'results\.json'\)/);
  assert.match(workflow, /path: e2e-reports\n/);
  for (const project of ['desktop', 'mobile']) {
    assert.match(workflow, new RegExp(`e2e-reports/web-e2e-artifacts-${project}/results\\.json`));
  }
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
