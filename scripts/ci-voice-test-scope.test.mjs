#!/usr/bin/env node

/**
 * ci-voice-test-scope.test.mjs: self-test for the voice test skip, plus pins that
 * quality.yml guards exactly the voice steps and that no voice test reads a file the
 * skip would let through.
 *
 * Run: node scripts/ci-voice-test-scope.test.mjs
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideVoiceTests,
  firstVoiceRelevantPath,
  WEB_FILES_VOICE_TESTS_READ,
} from './ci-voice-test-scope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
};

const onPr = (paths) => decideVoiceTests({ event: 'pull_request', baseRef: 'main', paths });

check('a pull request that changes only the web app skips the voice tests', () => {
  assert.equal(onPr(['app/web/src/pages/DashboardPage.tsx', 'app/web/e2e/review.e2e.ts']).voiceTests, 'skip');
  assert.equal(onPr(['app/web/package.json', 'app/web/package-lock.json']).voiceTests, 'skip');
});

check('design docs and the design gate count as web only', () => {
  const colourPr = [
    'app/web/src/index.css',
    'docs/design/hello-glass-design-system.md',
    'docs/design/logsheet-colour-decision-2026-11-06.md',
    'scripts/validate-hr-design-system.mjs',
    'scripts/validate-hr-design-system.test.mjs',
  ];
  assert.equal(onPr(colourPr).voiceTests, 'skip');
});

check('one path off the list runs them, and the reason names it', () => {
  for (const relevant of [
    'app/api/src/routes/r1.ts',
    'app/voice-livekit/phone.py',
    'app/supabase/migrations/0138_x.sql',
    '.github/workflows/quality.yml',
    'scripts/ci-voice-test-scope.mjs',
    'scripts/docker_import_closure.py',
    'config/environment.schema.json',
    'package.json',
    'docs/runbooks/phone-safe-dialer.md',
    'docs/design/r1/R1-PLAN-final.md',
  ]) {
    const verdict = onPr(['app/web/src/App.tsx', relevant]);
    assert.equal(verdict.voiceTests, 'run', relevant);
    assert.match(verdict.reason, new RegExp(relevant.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  }
});

check('a web file a voice test reads runs them', () => {
  for (const file of WEB_FILES_VOICE_TESTS_READ) assert.equal(onPr([file]).voiceTests, 'run', file);
});

check('anything but a pull request runs them, whatever the paths', () => {
  for (const event of ['push', 'workflow_dispatch', 'merge_group', '', undefined]) {
    const verdict = decideVoiceTests({ event, baseRef: 'main', paths: ['app/web/src/App.tsx'] });
    assert.equal(verdict.voiceTests, 'run', String(event));
  }
});

check('a pull request into anything but main runs them, because a retarget starts no new run', () => {
  for (const baseRef of ['feat/voice-change', '', undefined]) {
    const verdict = decideVoiceTests({ event: 'pull_request', baseRef, paths: ['app/web/src/App.tsx'] });
    assert.equal(verdict.voiceTests, 'run', String(baseRef));
  }
});

check('a diff that cannot be read, or an empty one, runs them', () => {
  assert.equal(onPr(null).voiceTests, 'run');
  assert.equal(onPr(undefined).voiceTests, 'run');
  assert.equal(onPr([]).voiceTests, 'run');
});

check('a path git had to quote is not read as web only', () => {
  assert.equal(firstVoiceRelevantPath(['"app/web/src/caf\\303\\251.tsx"']), '"app/web/src/caf\\303\\251.tsx"');
});

// ── The list must stay true: a voice test that reads a new file has to be seen ───────────────

/** Python without its comments and docstrings, so a mention is not read as a read. */
const codeOnly = (text) =>
  text
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

const ABOVE_THE_WORKER = String.raw`(?:\b_?(?:REPO|ROOT|APP)\b|\.parents\[|\.parent\.parent|HERE\.parent)`;

/** The plain ways of reaching a path the skip lets through. A static scan, not a proof. */
const READS = Object.freeze([
  ['web', /\/\s*f?["']web(?:\/[^"'\n]*)?["']/],
  ['web', /["'][^"'\n]*\bweb\/[^"'\n]*["']/],
  ['web', /["'][^"'\n]*\/web["']/],
  ['web', /\(\s*f?["']web["']/],
  ['web', /,\s*f?["']web["']\s*[,)]/],
  ['design doc', /["'][^"'\n]*docs\/design(?!\/r1\/)[^"'\n]*["']/],
  ['design doc', /["']docs["']\s*[/,]\s*["']design["'](?!\s*[/,]\s*["']r1["'])/],
  ['design gate', /validate-hr-design-system/],
  ['walk above the worker', new RegExp(`${ABOVE_THE_WORKER}[^\\n]*\\.(?:rglob|glob)\\(`)],
  ['walk above the worker', new RegExp(`os\\.walk\\([^\\n]*${ABOVE_THE_WORKER}`)],
  ['walk above the worker', /\.(?:rglob|glob)\(\s*f?["'][^"'\n]*\//],
]);

const readsIn = (text) =>
  codeOnly(text)
    .split('\n')
    .flatMap((line) => READS.filter(([, pattern]) => pattern.test(line)).map(([kind]) => ({ kind, line: line.trim() })));

check('the scan catches the plain ways of reading a path the skip lets through', () => {
  for (const code of [
    'x = HERE.parent / "web" / "src" / "App.tsx"',
    'x = HERE.parent / "web/src/App.tsx"',
    'x = f"{APP}/web/src/App.tsx"',
    'x = APP.joinpath("web/package.json")',
    'x = APP.joinpath("web", "package.json")',
    'x = os.path.join(REPO, "app", "web", "package.json")',
    'x = os.path.join(_REPO, "../web/src/App.tsx")',
    'files = HERE.parent.rglob("*.ts")',
    'files = BASE.glob("w*/src/lib/r1/*.ts")',
    'files = (ROOT / "docs").rglob("*.md")',
    'for _, _, names in os.walk(_REPO): pass',
    'x = ROOT / "docs/design/palette.md"',
    'x = ROOT / "docs/design" / "palette.md"',
    'DESIGN = ROOT / "docs" / "design"',
    'x = ROOT / "scripts" / "validate-hr-design-system.mjs"',
  ]) {
    assert.ok(readsIn(code).length > 0, `not caught: ${code}`);
  }
});

check('the scan leaves mentions, plain values and reads inside the worker alone', () => {
  for (const code of [
    '# see app/web/src/lib/r1/r1-phase.ts',
    'x = 1  # mirrors app/web/src/lib/r1/r1-phase.ts',
    '"""Mirrors app/web/src/lib/r1/r1-phase.ts and docs/design/x.md."""',
    'payload = {"channel": "web"}',
    'PLAN_DOC = HERE.parents[1] / "docs" / "design" / "r1" / "R1-PLAN-final.md"',
    'x = "docs/design/r1/R1-PLAN-final.md"',
    'R1_MODULES = sorted(HERE.glob("r1_*.py"))',
    'existing = path.parent.glob("*.wav")',
  ]) {
    assert.deepEqual(readsIn(code), [], code);
  }
});

const workerDir = path.join(ROOT, 'app', 'voice-livekit');
const pythonUnder = (dir, prefix = '') =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') return [];
    if (entry.isDirectory()) return pythonUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!entry.isFile() || !entry.name.endsWith('.py')) return [];
    return [{ name: `${prefix}${entry.name}`, text: readFileSync(path.join(dir, entry.name), 'utf8') }];
  });
const workerPython = pythonUnder(workerDir);

check('the scan sees the whole worker, not only the top of its tests folder', () => {
  assert.ok(workerPython.length > 100, `only ${workerPython.length} Python files found`);
  assert.ok(workerPython.some(({ name }) => name === 'phone.py'));
  assert.ok(workerPython.some(({ name }) => name === 'tests/test_r1_core.py'));
});

check('the one read the skip must know about is on the exception list, and there are no others', () => {
  const found = workerPython.flatMap(({ name, text }) => readsIn(text).map((hit) => ({ name, ...hit })));
  assert.deepEqual(
    found.map(({ name, kind }) => `${name}: ${kind}`),
    ['tests/test_r1_core.py: web'],
    'the worker now reads a path the skip lets through: add it to WEB_FILES_VOICE_TESTS_READ or the skip list, then update this pin',
  );
  for (const file of WEB_FILES_VOICE_TESTS_READ) {
    for (const segment of file.split('/').slice(1)) assert.ok(found[0].line.includes(segment), segment);
  }
});

// ── quality.yml must guard the voice steps, and only those ───────────────────────────────────

const GUARD = "if: steps.scope.outputs.voice_tests != 'skip'";
const VOICE_STEPS = [
  'Test LiveKit worker',
  'Test phone noise suppression (real DSP)',
  'Test recording tail flush (real SDK)',
  'Gate real-SDK contract (livekit-agents 1.6.4)',
  'Endpointing real-SDK contract (livekit-agents 1.6.4)',
  'STT shadow real-SDK contract (livekit-agents 1.6.4)',
  'Test R1 SDK contract (livekit-agents 1.6.4)',
  'Test R1 routing (bare python, no skips)',
  'Test R1 content (bare python, no skips)',
];

const quality = readFileSync(path.join(ROOT, '.github', 'workflows', 'quality.yml'), 'utf8');
const steps = quality
  .split(/^ {6}- name: /m)
  .slice(1)
  .map((part) => {
    // A comment above the next step lands at the tail of this one: only code counts.
    const code = part.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    return { name: code[0].trim(), code: code.join('\n') };
  });

check('exactly the voice steps carry the guard', () => {
  assert.deepEqual(steps.filter(({ code }) => code.includes(GUARD)).map(({ name }) => name), VOICE_STEPS);
});

check('every step that runs the worker test suites is guarded, so none is left running alone', () => {
  const runsVoiceTests = steps.filter(({ code }) => /python3? -m unittest|bin\/python -m unittest/.test(code));
  assert.ok(runsVoiceTests.length >= VOICE_STEPS.length);
  for (const { name, code } of runsVoiceTests) assert.ok(code.includes(GUARD), name);
});

check('the decision is made before the first guarded step, from a checkout that has the base', () => {
  const names = steps.map(({ name }) => name);
  const decide = steps.findIndex(({ code }) => code.includes('id: scope'));
  assert.ok(decide >= 0, 'no step has id: scope');
  assert.match(steps[decide].code, /node scripts\/ci-voice-test-scope\.mjs/);
  assert.ok(decide < names.indexOf(VOICE_STEPS[0]));
  assert.match(steps[0].code, /fetch-depth: 2/);
});

check('the decision cannot be softened into a pass', () => {
  assert.doesNotMatch(quality, /continue-on-error/);
  assert.match(quality, /node scripts\/ci-voice-test-scope\.test\.mjs/);
});

console.log(`${checks} checks passed`);
