#!/usr/bin/env node

/**
 * check-demo-artifacts.test.mjs
 *
 * ZERO-DEPENDENCY deterministic tests for check-demo-artifacts.mjs.
 * Uses node:assert and node:test. Tests valid artifacts, malformed inputs,
 * security detection, and edge cases.
 */

import { strict as assert } from 'node:assert';
import { test, describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validate, DEMO_BASE, EXPECTED_GROUPS, checkFile, validateContent, diagnostics } from './check-demo-artifacts.mjs';

const VALIDATOR = join(import.meta.dirname, 'check-demo-artifacts.mjs');
const ACTUAL_DEMO = resolve(import.meta.dirname, '..', 'docs', 'demo');

function runCLI(path) {
  const r = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf-8', timeout: 10000 });
  return { code: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

function writeTemp(content, ext = 'json') {
  const d = mkdtempSync(join(tmpdir(), 'demo-t-'));
  const p = join(d, `test.${ext}`);
  writeFileSync(p, content, 'utf-8');
  return p;
}

function writeTempDir() {
  return mkdtempSync(join(tmpdir(), 'demo-t-dir-'));
}

// Minimal valid JSON artifact
function validHelloHTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><title>Test</title></head><body>
<span class="badge">is_synthetic</span>
<p>demo.alpha@example.invalid</p>
</body></html>`;
}

function validHelloMD() {
  return `# Test\n\nis_synthetic\n\ndemo.alpha@example.invalid\n`;
}

function validSyntheticJSON() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: 'demo-html-v1-2025-06-15',
    generated_at: '2025-06-15T10:00:00Z',
    description: 'Synthetic demo'
  });
}

function validManifestJSON() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: 'demo-assets-v1-2025-06-15',
    generated_at: '2025-06-15T10:00:00Z',
    personas: [
      { candidate_id: 'DEMO-001', email: 'demo.alpha@example.invalid', phone: null }
    ]
  });
}

describe('check-demo-artifacts.mjs', () => {

  // === 1. BASICS ===
  it('1. Returns 0 against actual demo directory', () => {
    const r = runCLI(ACTUAL_DEMO);
    assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`);
  });
  it('2. Returns 0 with no args (default DEMO_BASE)', () => {
    const r = runCLI(ACTUAL_DEMO);
    assert.strictEqual(r.code, 0);
  });
  it('3. Missing directory: exit 1', () => {
    const { code } = runCLI('/nonexistent/demo');
    assert.strictEqual(code, 1);
  });
  it('4. File instead of directory: exit 1', () => {
    const p = writeTemp('{}');
    const { code } = runCLI(p);
    assert.strictEqual(code, 1);
  });

  // === 2. VALIDATION FUNCTIONS ===
  it('5. validateContent: clean HTML passes', () => {
    assert.strictEqual(validateContent(validHelloHTML(), 'test.html'), true);
  });
  it('6. validateContent: clean JSON passes', () => {
    assert.strictEqual(validateContent(validSyntheticJSON(), 'test.json'), true);
  });
  it('7. validateContent: JWT in string fails', () => {
    const content = `{"val": "eyJhbGciOiJIUzI1NiJ9.injected"}`;
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('8. validateContent: private key marker fails', () => {
    const content = `{"val": "-----BEGIN RSA PRIVATE KEY-----"}`;
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('9. validateContent: token prefix sk- fails', () => {
    const content = `{"val": "sk-proj-test-token-value"}`;
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('10. validateContent: external URL fails', () => {
    const content = `See https://external-service.com/api`;
    assert.strictEqual(validateContent(content, 'test.md'), false);
  });
  it('11. validateContent: example.com/org/net allowed', () => {
    const content = `See https://example.com/test`;
    assert.strictEqual(validateContent(content, 'test.md'), true);
  });
  it('12. validateContent: script tag in HTML fails', () => {
    const content = `<html><script>alert(1)</script></html>`;
    assert.strictEqual(validateContent(content, 'test.html'), false);
  });
  it('13. validateContent: on* event handler in HTML fails', () => {
    const content = `<div onclick="alert(1)">click</div>`;
    assert.strictEqual(validateContent(content, 'test.html'), false);
  });
  it('14. validateContent: non-reserved email fails', () => {
    const content = `Contact: user@gmail.com`;
    assert.strictEqual(validateContent(content, 'test.md'), false);
  });
  it('15. validateContent: example.invalid email passes', () => {
    const content = `Contact: demo.alpha@example.invalid`;
    assert.strictEqual(validateContent(content, 'test.md'), true);
  });
  it('16. validateContent: phone number fails', () => {
    const content = `Call +1-212-867-5309`;
    assert.strictEqual(validateContent(content, 'test.md'), false);
  });
  it('17. validateContent: absolute path fails', () => {
    const content = `Path: /etc/passwd`;
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('18. validateContent: parent traversal fails', () => {
    const content = `Path: ../secret`;
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('19. validateContent: UNC path fails', () => {
    const content = `Path: \\\\server\\share`;
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });

  // === 3. JSON VALIDATION ===
  it('20. JSON without is_synthetic fails', () => {
    const content = JSON.stringify({ synthetic_id: 'demo-v1', generated_at: '2025-06-15T10:00:00Z' });
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('21. JSON malformed fails', () => {
    assert.strictEqual(validateContent('{ broken', 'test.json'), false);
  });
  it('22. JSON with non-null phone string fails', () => {
    const content = JSON.stringify({
      is_synthetic: true,
      synthetic_id: 'demo-assets-v1-2025-06-15',
      generated_at: '2025-06-15T10:00:00Z',
      personas: [{ phone: '+1-212-867-5309' }]
    });
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('23. JSON with null phone passes', () => {
    const content = JSON.stringify({
      is_synthetic: true,
      synthetic_id: 'demo-assets-v1-2025-06-15',
      generated_at: '2025-06-15T10:00:00Z',
      personas: [{ phone: null }]
    });
    assert.strictEqual(validateContent(content, 'test.json'), true);
  });

  // === 4. SECURITY/PII IN DIAGNOSTICS ===
  it('24. validateContent rejects JWT in string', () => {
    const content = JSON.stringify({
      is_synthetic: true,
      synthetic_id: 'demo-html-v1-2025-06-15',
      generated_at: '2025-06-15T10:00:00Z',
      val: 'eyJhbGciOiJIUzI1NiJ9.secret-token'
    });
    assert.strictEqual(validateContent(content, 'test.json'), false);
  });
  it('25. validateContent rejects non-reserved email', () => {
    assert.strictEqual(validateContent('user@gmail.com', 'test.md'), false);
  });

  // === 5. FILE BOUNDS ===
  it('26. Oversized file >1MB fails', () => {
    const p = writeTempDir();
    writeFileSync(join(p, 'large.json'), 'x'.repeat(1048577), 'utf-8');
    const { code } = runCLI(p);
    assert.strictEqual(code, 1);
  });

  // === 6. URL ALLOW LIST ===
  it('27. example.org URL passes', () => {
    const content = `See https://example.org/about`;
    assert.strictEqual(validateContent(content, 'test.md'), true);
  });
  it('28. example.net URL passes', () => {
    const content = `See https://example.net/help`;
    assert.strictEqual(validateContent(content, 'test.md'), true);
  });
  it('29. example.edu URL passes', () => {
    const content = `See https://example.edu/research`;
    assert.strictEqual(validateContent(content, 'test.md'), true);
  });
  it('30. localhost URL passes', () => {
    const content = `See http://localhost:3000`;
    assert.strictEqual(validateContent(content, 'test.md'), true);
  });

  // === 7. MISSING GROUP ===
  it('31. Missing expected file fails validation', () => {
    // Create a minimal valid dir that's missing a group
    const p = writeTempDir();
    mkdirSync(join(p, 'hello-assets'));
    writeFileSync(join(p, 'hello.html'), validHelloHTML(), 'utf-8');
    // Missing hello.md, all JSON files, etc.
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('MISSING_GROUP') || stderr.includes('MISSING_FILE'));
  });

  // === 8. SYMLINK ===
  it('32. validateContent rejects malformed JSON', () => {
    const checkCode = validateContent('this is not valid json', 'test.json');
    assert.strictEqual(checkCode, false);
  });
  it('33. validateContent passes valid markdown', () => {
    const checkCode = validateContent('# Hello\n\nis_synthetic\n\ndemo@example.invalid', 'test.md');
    assert.strictEqual(checkCode, true);
  });

  // === 9. FND03-02: required marker enforcement (mustContain) ===
  it('FND03-02a: HTML without is_synthetic marker fails', () => {
    // Mutation: strip is_synthetic from valid HTML
    const mutated = validHelloHTML().replace('is_synthetic', 'was_synthetic');
    const p = writeTempDir();
    writeFileSync(join(p, 'hello.html'), mutated, 'utf-8');
    // Add other required files minimally
    mkdirSync(join(p, 'hello-assets'));
    writeFileSync(join(p, 'hello.md'), validHelloMD(), 'utf-8');
    writeFileSync(join(p, 'hello-assets/manifest.json'), validManifestJSON(), 'utf-8');
    mkdirSync(join(p, 'generated-pdf'));
    writeFileSync(join(p, 'generated-pdf/generated-pdf-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'voice-recording'));
    writeFileSync(join(p, 'voice-recording/voice-tone-info.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'scorecard-export'));
    writeFileSync(join(p, 'scorecard-export/scorecard-export-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'env-example-values'));
    writeFileSync(join(p, 'env-example-values/env-example-synthetic.json'), validSyntheticJSON(), 'utf-8');
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1, `Expected exit 1 when HTML is_synthetic stripped, got ${code}; stderr: ${stderr}`);
    assert.ok(stderr.includes('MISSING_MARKER'), 'stderr must contain MISSING_MARKER');
  });
  it('FND03-02b: Markdown without is_synthetic marker fails', () => {
    // Mutation: strip is_synthetic from valid markdown
    const mutated = validHelloMD().replace('is_synthetic', 'was_synthetic');
    const p = writeTempDir();
    writeFileSync(join(p, 'hello.md'), mutated, 'utf-8');
    writeFileSync(join(p, 'hello.html'), validHelloHTML(), 'utf-8');
    mkdirSync(join(p, 'hello-assets'));
    writeFileSync(join(p, 'hello-assets/manifest.json'), validManifestJSON(), 'utf-8');
    mkdirSync(join(p, 'generated-pdf'));
    writeFileSync(join(p, 'generated-pdf/generated-pdf-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'voice-recording'));
    writeFileSync(join(p, 'voice-recording/voice-tone-info.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'scorecard-export'));
    writeFileSync(join(p, 'scorecard-export/scorecard-export-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'env-example-values'));
    writeFileSync(join(p, 'env-example-values/env-example-synthetic.json'), validSyntheticJSON(), 'utf-8');
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1, `Expected exit 1 when MD is_synthetic stripped, got ${code}; stderr: ${stderr}`);
    assert.ok(stderr.includes('MISSING_MARKER'), 'stderr must contain MISSING_MARKER');
  });
  it('FND03-02c: HTML without example.invalid marker fails', () => {
    // Mutation: strip example.invalid from valid HTML
    const mutated = validHelloHTML().replace('example.invalid', 'example.com');
    const p = writeTempDir();
    writeFileSync(join(p, 'hello.html'), mutated, 'utf-8');
    writeFileSync(join(p, 'hello.md'), validHelloMD(), 'utf-8');
    mkdirSync(join(p, 'hello-assets'));
    writeFileSync(join(p, 'hello-assets/manifest.json'), validManifestJSON(), 'utf-8');
    mkdirSync(join(p, 'generated-pdf'));
    writeFileSync(join(p, 'generated-pdf/generated-pdf-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'voice-recording'));
    writeFileSync(join(p, 'voice-recording/voice-tone-info.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'scorecard-export'));
    writeFileSync(join(p, 'scorecard-export/scorecard-export-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'env-example-values'));
    writeFileSync(join(p, 'env-example-values/env-example-synthetic.json'), validSyntheticJSON(), 'utf-8');
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1, `Expected exit 1 when HTML example.invalid stripped, got ${code}; stderr: ${stderr}`);
    assert.ok(stderr.includes('MISSING_MARKER'), 'stderr must contain MISSING_MARKER');
  });
  it('FND03-02d: JSON without is_synthetic marker fails', () => {
    // Mutation: strip is_synthetic from valid JSON
    const mutated = validManifestJSON().replace('"is_synthetic": true', '"is_synthetic": false');
    const p = writeTempDir();
    mkdirSync(join(p, 'hello-assets'));
    writeFileSync(join(p, 'hello-assets/manifest.json'), mutated, 'utf-8');
    writeFileSync(join(p, 'hello.html'), validHelloHTML(), 'utf-8');
    writeFileSync(join(p, 'hello.md'), validHelloMD(), 'utf-8');
    mkdirSync(join(p, 'generated-pdf'));
    writeFileSync(join(p, 'generated-pdf/generated-pdf-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'voice-recording'));
    writeFileSync(join(p, 'voice-recording/voice-tone-info.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'scorecard-export'));
    writeFileSync(join(p, 'scorecard-export/scorecard-export-synthetic.json'), validSyntheticJSON(), 'utf-8');
    mkdirSync(join(p, 'env-example-values'));
    writeFileSync(join(p, 'env-example-values/env-example-synthetic.json'), validSyntheticJSON(), 'utf-8');
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1, `Expected exit 1 when JSON is_synthetic stripped, got ${code}; stderr: ${stderr}`);
    assert.ok(stderr.includes('MISSING_MARKER'), 'stderr must contain MISSING_MARKER');
  });

  it('FND03-04: custom demo path validates its files rather than canonical files', () => {
    const p = writeTempDir();
    cpSync(ACTUAL_DEMO, p, { recursive: true });
    writeFileSync(join(p, 'hello-assets', 'manifest.json'),
      validManifestJSON().replace('example.invalid', 'not-synthetic.test'), 'utf-8');
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1);
    assert.match(stderr, /PII_EMAIL/);
  });

  it('FND03-05: allowed README files are content-scanned', () => {
    const p = writeTempDir();
    cpSync(ACTUAL_DEMO, p, { recursive: true });
    writeFileSync(join(p, 'voice-recording', 'README.md'),
      'is_synthetic\ncredential-like sk-' + 'A'.repeat(40), 'utf-8');
    const { code, stderr } = runCLI(p);
    assert.strictEqual(code, 1);
    assert.match(stderr, /SECRET_VALUE/);
  });

  it('FND03-06: HTML data URLs are rejected even when small', () => {
    diagnostics.length = 0;
    const content = validHelloHTML().replace('</body>', '<img src="data:image/png;base64,AAAA"></body>');
    assert.strictEqual(validateContent(content, 'test.html'), false);
    assert.ok(diagnostics.some((d) => d.includes('DATA_URL')));
  });

});
