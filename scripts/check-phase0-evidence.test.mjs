#!/usr/bin/env node

/**
 * check-phase0-evidence.test.mjs
 *
 * ZERO-DEPENDENCY deterministic tests for check-phase0-evidence.mjs.
 * Uses node:assert (node test runner if available, otherwise inline).
 */

import { strict as assert } from 'node:assert';
import { test, describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const VALIDATOR = join(import.meta.dirname, 'check-phase0-evidence.mjs');
const EXAMPLE = join(import.meta.dirname, '..', 'config', 'phase0-evidence.example.json');

/**
 * Helper: write a temp JSON file and run validator against it.
 * Returns { code, stderr }
 */
function runValidator(jsonContent) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-'));
  const manifestPath = join(tmpDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(jsonContent), 'utf-8');
  try {
    const stdout = execSync(`node "${VALIDATOR}" "${manifestPath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { code: 0, stderr: '', stdout };
  } catch (err) {
    return {
      code: err.status,
      stderr: err.stderr || '',
      stdout: err.stdout || '',
    };
  }
}

/**
 * Build a complete valid fixture (all 6 providers, all verified).
 */
function buildCompleteFixture() {
  return {
    schemaVersion: '1.0.0',
    evidenceDate: '2025-06-01T00:00:00Z',
    owner: {
      role: 'Security Lead',
      evidenceDate: '2025-06-01T01:00:00Z',
    },
    credentialGroups: [
      {
        groupId: 'supabase-rotation',
        provider: 'supabase',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:30:00Z',
          evidenceRef: 'restricted://FND02/supabase/rotation-v1',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'audit-log-screenshot',
        },
      },
      {
        groupId: 'livekit-rotation',
        provider: 'livekit',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:35:00Z',
          evidenceRef: 'restricted://FND02/livekit/rotation-v1',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'credential-rejection-test',
        },
      },
      {
        groupId: 'anthropic-rotation',
        provider: 'anthropic',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:40:00Z',
          evidenceRef: 'restricted://FND02/anthropic/rotation-v1',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'provider-console-timestamp',
        },
      },
      {
        groupId: 'sarvam-rotation',
        provider: 'sarvam',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:45:00Z',
          evidenceRef: 'restricted://FND02/sarvam/rotation-v1',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'audit-log-screenshot',
        },
      },
      {
        groupId: 'deepgram-rotation',
        provider: 'deepgram',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:50:00Z',
          evidenceRef: 'restricted://FND02/deepgram/rotation-v1',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'credential-rejection-test',
        },
      },
      {
        groupId: 'retell-rotation',
        provider: 'retell-elevenlabs-cartesia',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:55:00Z',
          evidenceRef: 'restricted://FND02/retell/rotation-v1',
          rotationAction: 'revoked',
          oldCredentialRejectionMethod: 'provider-console-timestamp',
        },
      },
    ],
    artifactGroups: [
      {
        groupId: 'recording-sanitization',
        artifactType: 'interview-recording',
        verification: {
          manualReviewOutcome: 'replaced-synthetic',
          dispositionStatus: 'deleted-after-replacement',
          evidenceRef: 'restricted://FND03/recording/sanitization-v1',
        },
      },
      {
        groupId: 'scorecard-sanitization',
        artifactType: 'scorecard-pdf',
        verification: {
          manualReviewOutcome: 'clean',
          dispositionStatus: 'retained-restricted',
          evidenceRef: 'restricted://FND03/scorecard/retention-v1',
        },
      },
    ],
  };
}

// ======== TESTS ========

describe('check-phase0-evidence.mjs', () => {

  it('1. Valid complete synthetic fixture: exit 0', () => {
    const { code } = runValidator(buildCompleteFixture());
    assert.strictEqual(code, 0, `Expected exit 0, got ${code}`);
  });

  it('2. Committed example: exit 2 (valid but incomplete)', () => {
    try {
      const stdout = execSync(`node "${VALIDATOR}" "${EXAMPLE}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      assert.fail('Expected non-zero exit');
    } catch (err) {
      assert.strictEqual(err.status, 2, `Expected exit 2 from example, got ${err.status}`);
    }
  });

  it('3. Unknown top-level field: exit 1', () => {
    const data = buildCompleteFixture();
    data.unknownField = 'should fail';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('4. Unknown field in credentialGroup: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].extraField = 'should fail';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('5. Missing required field (no evidenceRef): exit 1', () => {
    const data = buildCompleteFixture();
    delete data.credentialGroups[0].verification.evidenceRef;
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('6. Secret-like field name ("apiKey"): exit 1', () => {
    const data = buildCompleteFixture();
    data.apiKey = 'should-fail';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('7. JWT token pattern in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = 'restricted://FND02/test/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0'; // gitleaks:allow
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('8. Private key marker (-----BEGIN RSA PRIVATE KEY-----): exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = '-----BEGIN RSA PRIVATE KEY-----'; // gitleaks:allow
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('9. URL with credentials (https://user:pass@host): exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = 'https://user:pass@example.com/evidence'; // gitleaks:allow
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('10. Email address in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = 'owner@company.com';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('11. Phone number in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = '+1-212-867-5309';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('12. Future date: exit 1', () => {
    const data = buildCompleteFixture();
    data.evidenceDate = '2099-12-31T23:59:59Z';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('13. Duplicate groupId: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[1].groupId = 'supabase-rotation';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('14. Placeholder claim marked as verified: exit 1', () => {
    const data = buildCompleteFixture();
    // Use a valid schema field with a placeholder value
    data.credentialGroups[0].verification.ownerRole = 'TODO: replace me with actual role';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('15. Unknown provider: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].provider = 'unknown-provider';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('16. Symlink input: exit 1', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-sym-'));
    const realPath = join(tmpDir, 'real.json');
    const linkPath = join(tmpDir, 'link.json');
    writeFileSync(realPath, JSON.stringify(buildCompleteFixture()), 'utf-8');
    try {
      symlinkSync(realPath, linkPath);
    } catch {
      // Symlink may fail on some systems, skip
      return;
    }
    try {
      execSync(`node "${VALIDATOR}" "${linkPath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      assert.fail('Expected non-zero exit for symlink');
    } catch (err) {
      assert.strictEqual(err.status, 1, `Expected exit 1 for symlink, got ${err.status}`);
    }
  });

  it('17. Oversized input (>64KB): exit 1', () => {
    const data = buildCompleteFixture();
    // Pad credentialGroups to exceed 64KB
    for (let i = 0; i < 100; i++) {
      data.credentialGroups.push({
        groupId: `padding-group-${i}`,
        provider: 'supabase',
        verification: {
          ownerRole: 'A'.repeat(500),
          evidenceDate: '2025-06-01T00:00:00Z',
          evidenceRef: 'restricted://FND02/supabase/padding',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'audit-log-screenshot',
        },
      });
      if (Buffer.byteLength(JSON.stringify(data)) > 66000) break;
    }
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('18. Missing provider coverage (only 5 of 6): exit 2', () => {
    const data = buildCompleteFixture();
    data.credentialGroups = data.credentialGroups.slice(0, 5);
    const { code } = runValidator(data);
    assert.strictEqual(code, 2, `Expected exit 2 (incomplete), got ${code}`);
  });

  it('19. Diagnostics do not echo a seeded secret', () => {
    const data = buildCompleteFixture();
    data.evidenceDate = '2099-12-31T23:59:59Z';
    const { code, stderr } = runValidator(data);
    assert.strictEqual(code, 1);
    // Ensure the seeded "future date" value is NOT in stderr
    assert.ok(!stderr.includes('2099-12-31T23:59:59Z'), 'stderr must not contain seeded secret value');
    assert.ok(!stderr.includes('2099'), 'stderr must not contain the future year');
    // But it should contain the diagnostic category
    assert.ok(stderr.includes('FUTURE_DATE'), 'stderr should contain FUTURE_DATE category');
  });

  it('20. Malformed JSON: exit 1', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-mal-'));
    const manifestPath = join(tmpDir, 'malformed.json');
    writeFileSync(manifestPath, '{ invalid json }', 'utf-8');
    try {
      execSync(`node "${VALIDATOR}" "${manifestPath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      assert.fail('Expected non-zero exit');
    } catch (err) {
      assert.strictEqual(err.status, 1, `Expected exit 1, got ${err.status}`);
    }
  });

  it('21. Non-regular file (directory): exit 1', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-dir-'));
    // Pass directory as argument
    try {
      execSync(`node "${VALIDATOR}" "${tmpDir}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      assert.fail('Expected non-zero exit');
    } catch (err) {
      assert.strictEqual(err.status, 1, `Expected exit 1 for directory, got ${err.status}`);
    }
  });

  it('22. Evidence reference outside restricted:// grammar: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = 'https://example.com/evidence';
    const { code } = runValidator(data);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

});
