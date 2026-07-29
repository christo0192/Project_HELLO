#!/usr/bin/env node

/**
 * check-phase0-evidence.test.mjs
 *
 * ZERO-DEPENDENCY deterministic tests for check-phase0-evidence.mjs.
 * Uses node:assert and node:test.
 * Imports validate() directly for logic tests; uses spawnSync for CLI tests.
 */

import { strict as assert } from 'node:assert';
import { test, describe, it } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validate } from './check-phase0-evidence.mjs';

const VALIDATOR = join(import.meta.dirname, 'check-phase0-evidence.mjs');
const EXAMPLE = join(import.meta.dirname, '..', 'config', 'phase0-evidence.example.json');
const TEST_CLOCK = new Date('2025-06-01T00:00:00Z');

/**
 * Build a complete valid fixture (all 8 providers verified, all 7 artifact groups verified).
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
        status: 'verified',
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
        status: 'verified',
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
        status: 'verified',
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
        status: 'verified',
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
        status: 'verified',
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
        provider: 'retell',
        status: 'verified',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:55:00Z',
          evidenceRef: 'restricted://FND02/retell/rotation-v1',
          rotationAction: 'revoked',
          oldCredentialRejectionMethod: 'provider-console-timestamp',
        },
      },
      {
        groupId: 'elevenlabs-rotation',
        provider: 'elevenlabs',
        status: 'verified',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T01:00:00Z',
          evidenceRef: 'restricted://FND02/elevenlabs/rotation-v1',
          rotationAction: 'revoked',
          oldCredentialRejectionMethod: 'audit-log-screenshot',
        },
      },
      {
        groupId: 'cartesia-rotation',
        provider: 'cartesia',
        status: 'verified',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T01:05:00Z',
          evidenceRef: 'restricted://FND02/cartesia/rotation-v1',
          rotationAction: 'deleted-resource',
          oldCredentialRejectionMethod: 'provider-console-timestamp',
        },
      },
    ],
    artifactGroups: [
      {
        groupId: 'hello-html',
        artifactType: 'generated-document',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'replaced-synthetic',
          dispositionStatus: 'deleted-after-replacement',
          evidenceRef: 'restricted://FND03/hello-html/synthetic-v1',
        },
      },
      {
        groupId: 'hello-md',
        artifactType: 'generated-document',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'replaced-synthetic',
          dispositionStatus: 'deleted-after-replacement',
          evidenceRef: 'restricted://FND03/hello-md/synthetic-v1',
        },
      },
      {
        groupId: 'hello-assets',
        artifactType: 'resume-copy',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'clean',
          dispositionStatus: 'retained-restricted',
          evidenceRef: 'restricted://FND03/hello-assets/retention-v1',
        },
      },
      {
        groupId: 'generated-pdf',
        artifactType: 'scorecard-pdf',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'clean',
          dispositionStatus: 'retained-restricted',
          evidenceRef: 'restricted://FND03/generated-pdf/retention-v1',
        },
      },
      {
        groupId: 'voice-recording',
        artifactType: 'voice-media',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'replaced-synthetic',
          dispositionStatus: 'deleted-after-replacement',
          evidenceRef: 'restricted://FND03/voice-recording/synthetic-v1',
        },
      },
      {
        groupId: 'scorecard-export',
        artifactType: 'scorecard-pdf',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'clean',
          dispositionStatus: 'retained-restricted',
          evidenceRef: 'restricted://FND03/scorecard-export/retention-v1',
        },
      },
      {
        groupId: 'env-example-values',
        artifactType: 'generated-document',
        status: 'verified',
        verification: {
          manualReviewOutcome: 'replaced-synthetic',
          dispositionStatus: 'deleted-after-replacement',
          evidenceRef: 'restricted://FND03/env-example-values/synthetic-v1',
        },
      },
    ],
  };
}

/**
 * Helper: write fixture to temp file and return path.
 */
function writeTempFixture(data) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-'));
  const manifestPath = join(tmpDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(data), 'utf-8');
  return manifestPath;
}

/**
 * Helper: run validator CLI via spawnSync.
 */
function runValidatorCLI(manifestPath) {
  const result = spawnSync(process.execPath, [VALIDATOR, manifestPath], {
    encoding: 'utf-8',
    timeout: 10000,
  });
  return {
    code: result.status,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

// ======== TESTS ========

describe('check-phase0-evidence.mjs', () => {

  // === SECTION 1: Basic validity ===

  it('1. Valid complete synthetic fixture (8 providers, 7 artifact groups, all verified): exit 0', () => {
    const fixture = buildCompleteFixture();
    const path = writeTempFixture(fixture);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 0, `Expected exit 0, got ${code}`);
  });

  it('2. Committed example (all pending): exit 2', () => {
    const { code } = runValidatorCLI(EXAMPLE);
    assert.strictEqual(code, 2, `Expected exit 2 from example, got ${code}`);
  });

  it('3. No-arg CLI: exit 1', () => {
    const result = spawnSync(process.execPath, [VALIDATOR], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 1, `Expected exit 1 for no args, got ${result.status}`);
  });

  // === SECTION 2: Schema violations ===

  it('4. Unknown top-level field: exit 1', () => {
    const data = buildCompleteFixture();
    data.extraField = 'should fail';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('5. Wrong schemaVersion: exit 1', () => {
    const data = buildCompleteFixture();
    data.schemaVersion = '2.0.0';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('6. Missing required top-level field (no owner): exit 1', () => {
    const data = buildCompleteFixture();
    delete data.owner;
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('7. Missing credentialGroups: exit 1', () => {
    const data = buildCompleteFixture();
    delete data.credentialGroups;
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('8. Empty artifactGroups array: exit 1', () => {
    const data = buildCompleteFixture();
    data.artifactGroups = [];
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('9. Unknown field in credentialGroup: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].extraField = 'should fail';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 3: Status / if/then/else ===

  it('10. status=pending with verification present: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].status = 'pending';
    data.credentialGroups[0].verification = {
      ownerRole: 'Security Lead',
      evidenceDate: '2025-06-01T00:30:00Z',
      evidenceRef: 'restricted://FND02/supabase/rotation-v1',
      rotationAction: 'rotated',
      oldCredentialRejectionMethod: 'audit-log-screenshot',
    };
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('11. status=verified without verification: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].status = 'verified';
    delete data.credentialGroups[0].verification;
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('12. Artifact status=pending with verification: exit 1', () => {
    const data = buildCompleteFixture();
    data.artifactGroups[0].status = 'pending';
    data.artifactGroups[0].verification = {
      manualReviewOutcome: 'clean',
      dispositionStatus: 'retained-restricted',
      evidenceRef: 'restricted://FND03/test/evidence',
    };
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('13. Artifact status=verified without verification: exit 1', () => {
    const data = buildCompleteFixture();
    data.artifactGroups[0].status = 'verified';
    delete data.artifactGroups[0].verification;
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 4: Provider / artifact group coverage ===

  it('14. Missing one provider (only 7 of 8): exit 2', () => {
    const data = buildCompleteFixture();
    data.credentialGroups = data.credentialGroups.filter(g => g.provider !== 'cartesia');
    const path = writeTempFixture(data);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 2, `Expected exit 2 (incomplete), got ${code}`);
  });

  it('15. Missing one artifact group ID (only 6 of 7): exit 2', () => {
    const data = buildCompleteFixture();
    data.artifactGroups = data.artifactGroups.filter(g => g.groupId !== 'hello-html');
    const path = writeTempFixture(data);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 2, `Expected exit 2 (incomplete), got ${code}`);
  });

  // === SECTION 5: FND-03 outcome validation ===

  it('16. clean + pending-review: exit 1 (contradiction)', () => {
    const data = buildCompleteFixture();
    data.artifactGroups[0].verification.manualReviewOutcome = 'clean';
    data.artifactGroups[0].verification.dispositionStatus = 'pending-review';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('17. quarantined + deleted-after-replacement: exit 1 (contradiction)', () => {
    const data = buildCompleteFixture();
    data.artifactGroups[0].verification.manualReviewOutcome = 'quarantined';
    data.artifactGroups[0].verification.dispositionStatus = 'deleted-after-replacement';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('18. Empty artifactGroups (missing required groups): exit 1', () => {
    const data = buildCompleteFixture();
    data.artifactGroups = [];
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 6: Owner role validation ===

  it('19. Invalid owner.role (free text): exit 1', () => {
    const data = buildCompleteFixture();
    data.owner.role = 'Some Random Person';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('20. Invalid verification.ownerRole (free text): exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = 'John Doe';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('21. Valid roles accepted: exit 0', () => {
    const fixture = buildCompleteFixture();
    // All valid roles
    const roles = ['Engineering Lead', 'Security Lead', 'Product Manager', 'Legal Counsel'];
    fixture.owner.role = roles[0];
    fixture.credentialGroups[0].verification.ownerRole = roles[1];
    const path = writeTempFixture(fixture);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 0, `Expected exit 0, got ${code}`);
  });

  // === SECTION 7: Date validation ===

  it('22. Future evidenceDate relative to clock: exit 1', () => {
    const data = buildCompleteFixture();
    data.evidenceDate = '2025-07-01T00:00:00Z'; // After test clock (2025-06-01)
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('23. Non-UTC date (no Z or offset): exit 1', () => {
    const data = buildCompleteFixture();
    data.evidenceDate = '2025-06-01T00:00:00';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('24. Invalid date string: exit 1', () => {
    const data = buildCompleteFixture();
    data.evidenceDate = 'not-a-date';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 8: File-level errors ===

  it('25. Symlink input: exit 1', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-sym-'));
    const realPath = join(tmpDir, 'real.json');
    const linkPath = join(tmpDir, 'link.json');
    const fixture = buildCompleteFixture();
    writeFileSync(realPath, JSON.stringify(fixture), 'utf-8');
    try {
      symlinkSync(realPath, linkPath);
    } catch {
      return; // Symlink may fail on some systems, skip
    }
    const { code } = runValidatorCLI(linkPath);
    assert.strictEqual(code, 1, `Expected exit 1 for symlink, got ${code}`);
  });

  it('26. Non-regular file (directory): exit 1', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-dir-'));
    const { code } = runValidatorCLI(tmpDir);
    assert.strictEqual(code, 1, `Expected exit 1 for directory, got ${code}`);
  });

  it('27. Oversized input (>64KB): exit 1', () => {
    const data = buildCompleteFixture();
    // Add enough padding to exceed 64KB
    for (let i = 0; i < 200; i++) {
      data.credentialGroups.push({
        groupId: `padding-group-${i}`,
        provider: 'supabase',
        status: 'verified',
        verification: {
          ownerRole: 'Security Lead',
          evidenceDate: '2025-06-01T00:00:00Z',
          evidenceRef: 'restricted://FND02/supabase/padding',
          rotationAction: 'rotated',
          oldCredentialRejectionMethod: 'audit-log-screenshot',
        },
      });
    }
    const path = writeTempFixture(data);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 1, `Expected exit 1 for oversized, got ${code}`);
  });

  it('28. Malformed JSON: exit 1', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-mal-'));
    const manifestPath = join(tmpDir, 'malformed.json');
    writeFileSync(manifestPath, '{ invalid json }', 'utf-8');
    const { code } = runValidatorCLI(manifestPath);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 9: Secret/PII/path detection ===

  // Use runtime-constructed seeded values to avoid scanner-triggering literal strings
  const JWT_SEED = Buffer.from('ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5', 'base64').toString('utf-8');

  it('29. JWT token pattern in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = JWT_SEED + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.test';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  const PRIVKEY_SEED = Buffer.from('LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVkt', 'base64').toString('utf-8');

  it('30. Private key marker: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = PRIVKEY_SEED;
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('31. URL with credentials: exit 1', () => {
    const data = buildCompleteFixture();
    const urlWithCreds = Buffer.from('aHR0cHM6Ly91c2VyOnBhc3NAZXhhbXBsZS5jb20vZXZpZGVuY2U=', 'base64').toString('utf-8');
    data.credentialGroups[0].verification.evidenceRef = urlWithCreds;
    const { code } = runValidatorCLI(writeTempFixture(data));
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('32. Email address in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = 'owner@company.com';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('33. Phone number in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = '+1-212-867-5309';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('34. Token prefix in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = Buffer.from('c2stcHJvai10ZXN0LXRva2VuLXZhbHVl', 'base64').toString('utf-8');
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('35. Absolute Unix path in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = '/etc/passwd';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('36. Parent traversal in value: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = '../secret-file';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('37. URL with query string: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = 'https://example.com/evidence?token=abc123';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 10: Evidence ref validation ===

  it('38. EvidenceRef outside restricted://FND02/FND03 grammar: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = 'https://example.com/evidence';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  it('39. FND03 evidenceRef in credential group: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.evidenceRef = 'restricted://FND03/test/evidence';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 11: Placeholder detection ===

  it('40. Placeholder claim: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].verification.ownerRole = 'TODO: replace me with actual role';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 12: Duplicate IDs ===

  it('41. Duplicate groupId in credentialGroups: exit 1', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[1].groupId = 'supabase-rotation';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

  // === SECTION 13: Non-disclosure diagnostics ===

  it('42. Diagnostics never echo input value (future date)', () => {
    const data = buildCompleteFixture();
    const futureDate = '2099-12-31T23:59:59Z';
    data.evidenceDate = futureDate;
    const path = writeTempFixture(data);
    const { code, stderr } = runValidatorCLI(path);
    assert.strictEqual(code, 1);
    assert.ok(!stderr.includes('2099'), 'stderr must not contain the seeded future year');
    assert.ok(stderr.includes('DIAG ['), 'stderr should contain DIAG markers');
  });

  it('43. Diagnostics never echo input value (seeded JWT)', () => {
    const data = buildCompleteFixture();
    // Put JWT in a non-pattern-checked field so it reaches the security scanner
    data.credentialGroups[0].verification.ownerRole = 'Security Lead';
    data.credentialGroups[0].verification.oldCredentialRejectionMethod = JWT_SEED + '.injected';
    const path = writeTempFixture(data);
    const { code, stderr } = runValidatorCLI(path);
    assert.strictEqual(code, 1);
    assert.ok(!stderr.includes(JWT_SEED), 'stderr must not contain seeded JWT prefix');
    assert.ok(stderr.includes('DIAG ['), 'stderr should contain a DIAG category');
  });

  it('44. Diagnostics never echo input value (seeded email)', () => {
    const data = buildCompleteFixture();
    // Put email in a field that does NOT have an enum check so the PII scanner catches it
    data.credentialGroups[0].verification.oldCredentialRejectionMethod = 'test@example.org-audit';
    const path = writeTempFixture(data);
    const { code, stderr } = runValidatorCLI(path);
    assert.strictEqual(code, 1);
    assert.ok(!stderr.includes('test@example.org'), 'stderr must not contain email address');
    assert.ok(stderr.includes('DIAG ['), 'stderr should contain a DIAG category');
  });

  // === SECTION 14: Pending state ===

  it('45. One entry pending, rest verified: exit 2', () => {
    const data = buildCompleteFixture();
    data.credentialGroups[0].status = 'pending';
    delete data.credentialGroups[0].verification;
    const path = writeTempFixture(data);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 2, `Expected exit 2 (pending present), got ${code}`);
  });

  it('46. All entries pending (example): exit 2', () => {
    const data = buildCompleteFixture();
    for (const g of data.credentialGroups) {
      g.status = 'pending';
      delete g.verification;
    }
    for (const g of data.artifactGroups) {
      g.status = 'pending';
      delete g.verification;
    }
    const path = writeTempFixture(data);
    const { code } = runValidatorCLI(path);
    assert.strictEqual(code, 2, `Expected exit 2 (all pending), got ${code}`);
  });

  // === SECTION 15: Schema parity ===

  it('47. Provider enum parity: schema has exactly 8 providers', () => {
    const schema = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', 'config', 'phase0-evidence.schema.json'), 'utf-8'
    ));
    const providers = schema.properties.credentialGroups.items.properties.provider.enum;
    assert.strictEqual(providers.length, 8, 'Schema must have exactly 8 providers');
    const expected = ['supabase', 'livekit', 'anthropic', 'sarvam', 'deepgram', 'retell', 'elevenlabs', 'cartesia'];
    assert.deepStrictEqual(providers, expected);
  });

  it('48. Artifact group ID enum parity: schema has exactly 7 group IDs', () => {
    const schema = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', 'config', 'phase0-evidence.schema.json'), 'utf-8'
    ));
    const groupIds = schema.properties.artifactGroups.items.properties.groupId.enum;
    assert.strictEqual(groupIds.length, 7, 'Schema must have exactly 7 artifact group IDs');
    const expected = ['hello-html', 'hello-md', 'hello-assets', 'generated-pdf', 'voice-recording', 'scorecard-export', 'env-example-values'];
    assert.deepStrictEqual(groupIds, expected);
  });

  // === SECTION 16: High-entropy base64 ===

  it('49. High-entropy base64 value (>= 40 chars): exit 1', () => {
    const data = buildCompleteFixture();
    // Use a runtime-constructed base64-like string
    data.credentialGroups[0].verification.ownerRole = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const code = validate(writeTempFixture(data), TEST_CLOCK);
    assert.strictEqual(code, 1, `Expected exit 1, got ${code}`);
  });

});
