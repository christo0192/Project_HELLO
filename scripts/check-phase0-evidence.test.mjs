#!/usr/bin/env node

/**
 * check-phase0-evidence.test.mjs
 *
 * ZERO-DEPENDENCY deterministic tests for check-phase0-evidence.mjs.
 * Uses node:assert and node:test. Imports validate() for logic; spawnSync for CLI.
 * Seeded secret patterns: Buffer.from(..., 'base64').toString('utf-8') at runtime.
 */

import { strict as assert } from 'node:assert';
import { test, describe, it } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validate } from './check-phase0-evidence.mjs';

const VALIDATOR = join(import.meta.dirname, 'check-phase0-evidence.mjs');
const EXAMPLE = join(import.meta.dirname, '..', 'config', 'phase0-evidence.example.json');
const SCHEMA_PATH = join(import.meta.dirname, '..', 'config', 'phase0-evidence.schema.json');
const TEST_CLOCK = new Date('2025-06-01T00:00:00Z');

function writeTemp(data) {
  const d = mkdtempSync(join(tmpdir(), 'ev-t-'));
  const p = join(d, 'm.json');
  writeFileSync(p, JSON.stringify(data), 'utf-8');
  return p;
}

function runCLI(path) {
  const r = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf-8', timeout: 10000 });
  return { code: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

// Canonical complete fixture: 8 providers + 7 artifacts, all verified, allowed combos
function complete() {
  return {
    schemaVersion: '1.0.0',
    evidenceDate: '2025-06-01T00:00:00Z',
    owner: { role: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z' },
    credentialGroups: [
      { groupId: 'supabase-rotation', provider: 'supabase', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/supabase/v1', rotationAction: 'rotated', oldCredentialRejectionMethod: 'audit-log-screenshot' } },
      { groupId: 'livekit-rotation', provider: 'livekit', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/livekit/v1', rotationAction: 'rotated', oldCredentialRejectionMethod: 'credential-rejection-test' } },
      { groupId: 'anthropic-rotation', provider: 'anthropic', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/anthropic/v1', rotationAction: 'rotated', oldCredentialRejectionMethod: 'provider-console-timestamp' } },
      { groupId: 'sarvam-rotation', provider: 'sarvam', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/sarvam/v1', rotationAction: 'rotated', oldCredentialRejectionMethod: 'audit-log-screenshot' } },
      { groupId: 'deepgram-rotation', provider: 'deepgram', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/deepgram/v1', rotationAction: 'rotated', oldCredentialRejectionMethod: 'credential-rejection-test' } },
      { groupId: 'retell-rotation', provider: 'retell', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/retell/v1', rotationAction: 'revoked', oldCredentialRejectionMethod: 'provider-console-timestamp' } },
      { groupId: 'elevenlabs-rotation', provider: 'elevenlabs', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/elevenlabs/v1', rotationAction: 'revoked', oldCredentialRejectionMethod: 'audit-log-screenshot' } },
      { groupId: 'cartesia-rotation', provider: 'cartesia', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', evidenceRef: 'restricted://FND02/cartesia/v1', rotationAction: 'deleted-resource', oldCredentialRejectionMethod: 'provider-console-timestamp' } },
    ],
    artifactGroups: [
      { groupId: 'hello-html', artifactType: 'generated-document', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'replaced-synthetic', dispositionStatus: 'deleted-after-replacement', evidenceRef: 'restricted://FND03/hello-html/v1' } },
      { groupId: 'hello-md', artifactType: 'generated-document', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'replaced-synthetic', dispositionStatus: 'deleted-after-replacement', evidenceRef: 'restricted://FND03/hello-md/v1' } },
      { groupId: 'hello-assets', artifactType: 'resume-copy', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'clean', dispositionStatus: 'retained-restricted', evidenceRef: 'restricted://FND03/hello-assets/v1' } },
      { groupId: 'generated-pdf', artifactType: 'scorecard-pdf', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'clean', dispositionStatus: 'retained-restricted', evidenceRef: 'restricted://FND03/generated-pdf/v1' } },
      { groupId: 'voice-recording', artifactType: 'voice-media', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'replaced-synthetic', dispositionStatus: 'retained-restricted', evidenceRef: 'restricted://FND03/voice-recording/v1' } },
      { groupId: 'scorecard-export', artifactType: 'scorecard-pdf', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'clean', dispositionStatus: 'retained-restricted', evidenceRef: 'restricted://FND03/scorecard-export/v1' } },
      { groupId: 'env-example-values', artifactType: 'generated-document', status: 'verified',
        verification: { ownerRole: 'Security Lead', evidenceDate: '2025-06-01T00:00:00Z', manualReviewOutcome: 'replaced-synthetic', dispositionStatus: 'deleted-after-replacement', evidenceRef: 'restricted://FND03/env-example-values/v1' } },
    ],
  };
}

// Seeded secret patterns (base64-decoded at runtime)
const JWT_SEED = Buffer.from('ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5', 'base64').toString('utf-8');
const PRIVKEY_SEED = Buffer.from('LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVkt', 'base64').toString('utf-8');
const TOK_PREFIX = Buffer.from('c2stcHJvai10ZXN0LXRva2VuLXZhbHVl', 'base64').toString('utf-8');
const URL_CREDS = Buffer.from('aHR0cHM6Ly91c2VyOnBhc3NAZXhhbXBsZS5jb20vZXZpZGVuY2U=', 'base64').toString('utf-8');

describe('check-phase0-evidence.mjs', () => {

  // === 1. BASIC VALIDITY ===
  it('1. Complete fixture (8 providers + 7 artifacts, all verified): exit 0', () => {
    const { code } = runCLI(writeTemp(complete()));
    assert.strictEqual(code, 0);
  });
  it('2. Committed example (all pending): exit 2', () => {
    const { code } = runCLI(EXAMPLE);
    assert.strictEqual(code, 2);
  });
  it('3. No-arg CLI: exit 1', () => {
    const r = spawnSync(process.execPath, [VALIDATOR], { encoding: 'utf-8', timeout: 10000 });
    assert.strictEqual(r.status, 1);
  });

  // === 2. SCHEMA VIOLATIONS ===
  it('4. Unknown top-level field: exit 1', () => {
    const d = complete(); d.extra = 'x';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('5. Wrong schemaVersion: exit 1', () => {
    const d = complete(); d.schemaVersion = '2.0.0';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('6. Missing credentialGroups: exit 1', () => {
    const d = complete(); delete d.credentialGroups;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('7. Empty artifactGroups (minItems 7): exit 1', () => {
    const d = complete(); d.artifactGroups = [];
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 3. STATUS IF/THEN/ELSE ===
  it('8. status=pending with verification present: exit 1', () => {
    const d = complete(); d.credentialGroups[0].status = 'pending';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('9. status=verified without verification: exit 1', () => {
    const d = complete(); d.credentialGroups[0].status = 'verified';
    delete d.credentialGroups[0].verification;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('10. Artifact pending with verification: exit 1', () => {
    const d = complete(); d.artifactGroups[0].status = 'pending';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('11. Artifact verified without verification: exit 1', () => {
    const d = complete(); d.artifactGroups[0].status = 'verified';
    delete d.artifactGroups[0].verification;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 4. PROVIDER CARDINALITY ===
  it('12. Duplicate provider (two supabase entries): exit 1', () => {
    const d = complete();
    d.credentialGroups[1] = { groupId: 'livekit-rotation', provider: 'supabase', status: 'pending' };
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('13. Nine credential rows with all 8 plus extra: exit 1 (schema maxItems 8)', () => {
    const d = complete();
    d.credentialGroups.push({ groupId: 'extra', provider: 'supabase', status: 'pending' });
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('14. One provider pending (7 verified + 1 pending): exit 2', () => {
    const d = complete();
    d.credentialGroups[7].status = 'pending';
    delete d.credentialGroups[7].verification;
    const { code } = runCLI(writeTemp(d));
    assert.strictEqual(code, 2);
  });

  // === 5. ARTIFACT CARDINALITY ===
  it('15. Duplicate artifact groupId: exit 1', () => {
    const d = complete();
    d.artifactGroups[1] = { groupId: 'hello-html', artifactType: 'generated-document', status: 'pending' };
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('16. One artifact pending (6 verified + 1 pending): exit 2', () => {
    const d = complete();
    d.artifactGroups[6].status = 'pending';
    delete d.artifactGroups[6].verification;
    const { code } = runCLI(writeTemp(d));
    assert.strictEqual(code, 2);
  });

  // === 6. GROUPID→PROVIDER/TYPE MAPPING ===
  it('17. Wrong groupId→provider mapping: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].groupId = 'supabase-rotation';
    d.credentialGroups[0].provider = 'livekit';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('18. Wrong groupId→artifactType mapping: exit 1', () => {
    const d = complete();
    d.artifactGroups[0].groupId = 'hello-html';
    d.artifactGroups[0].artifactType = 'voice-media';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 7. STRICT UTC ===
  it('19. Future date relative to clock: exit 1', () => {
    const d = complete(); d.evidenceDate = '2025-07-01T00:00:00Z';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('20. Non-UTC offset +05:30: exit 1', () => {
    const d = complete(); d.evidenceDate = '2025-06-01T00:00:00+05:30';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('21. Non-UTC offset +00:00 (must be Z): exit 1', () => {
    const d = complete(); d.evidenceDate = '2025-06-01T00:00:00+00:00';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('22. Omitted seconds: exit 1', () => {
    const d = complete(); d.evidenceDate = '2025-06-01T00:00Z';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('23. Impossible date (Feb 30): exit 1', () => {
    const d = complete(); d.evidenceDate = '2025-02-30T00:00:00Z';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('24. Trailing junk after Z: exit 1', () => {
    const d = complete(); d.evidenceDate = '2025-06-01T00:00:00Z extra';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('25. Invalid date string: exit 1', () => {
    const d = complete(); d.evidenceDate = 'not-a-date';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 8. FND-03 VERIFIED COMBO VALIDATION ===
  it('26. clean + pending-review: rejected', () => {
    const d = complete();
    d.artifactGroups[0].verification.dispositionStatus = 'pending-review';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('27. quarantined + deleted-after-replacement: rejected', () => {
    const d = complete();
    d.artifactGroups[0].verification.manualReviewOutcome = 'quarantined';
    d.artifactGroups[0].verification.dispositionStatus = 'deleted-after-replacement';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('28. replaced-synthetic + pending-review: rejected', () => {
    const d = complete();
    d.artifactGroups[0].verification.dispositionStatus = 'pending-review';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('29. quarantined + pending-review: rejected', () => {
    const d = complete();
    d.artifactGroups[0].verification.manualReviewOutcome = 'quarantined';
    d.artifactGroups[0].verification.dispositionStatus = 'pending-review';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('30. clean + deleted-after-replacement: rejected', () => {
    const d = complete();
    d.artifactGroups[0].verification.manualReviewOutcome = 'clean';
    d.artifactGroups[0].verification.dispositionStatus = 'deleted-after-replacement';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('31. All allowed combos (excluding quarantined) pass', () => {
    const allowed = [
      ['clean', 'retained-restricted'],
      ['replaced-synthetic', 'retained-restricted'],
      ['replaced-synthetic', 'deleted-after-replacement'],
    ];
    for (const [outcome, disposition] of allowed) {
      const d = complete();
      d.artifactGroups[0].verification.manualReviewOutcome = outcome;
      d.artifactGroups[0].verification.dispositionStatus = disposition;
      assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 0, `combo ${outcome}:${disposition} should pass`);
    }
  });

  // === 9. OWNER ROLE VALIDATION ===
  it('32. Invalid owner.role (free text): exit 1', () => {
    const d = complete(); d.owner.role = 'Some Person';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('33. Invalid verification.ownerRole: exit 1', () => {
    const d = complete(); d.credentialGroups[0].verification.ownerRole = 'John Doe';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('34. Artifact verification missing ownerRole: exit 1', () => {
    const d = complete(); delete d.artifactGroups[0].verification.ownerRole;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('35. Artifact verification missing evidenceDate: exit 1', () => {
    const d = complete(); delete d.artifactGroups[0].verification.evidenceDate;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 10. SECRET/PII DETECTION ===
  it('36. JWT pattern: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = JWT_SEED + '.injected';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('37. Private key marker: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = PRIVKEY_SEED;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('38. Token prefix: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = TOK_PREFIX;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('39. URL with credentials: exit 1', () => {
    const d = complete();
    d.artifactGroups[0].verification.evidenceRef = URL_CREDS;
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('40. Email in value: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = 'test@example.org-x';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('41. Phone number: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = '+1-212-867-5309';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('42. Absolute Unix path: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = '/etc/passwd';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('43. Parent traversal: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = '../secret';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('44. Dot-slash path: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = './local';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('45. UNC path: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = '\\\\server\\share';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('46. URL with query: exit 1', () => {
    const d = complete();
    d.artifactGroups[0].verification.evidenceRef = 'https://example.com/ev?t=abc';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('47. URL with fragment: exit 1', () => {
    const d = complete();
    d.artifactGroups[0].verification.evidenceRef = 'https://example.com/ev#s';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('48. High-entropy base64 (>=40 chars): exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 11. EVIDENCE REF TIGHTENING ===
  it('49. Double slash in evidenceRef: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.evidenceRef = 'restricted://FND02//supabase/v1';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('50. Dot segment in evidenceRef: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.evidenceRef = 'restricted://FND02/supabase/./v1';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('51. Trailing slash in evidenceRef: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.evidenceRef = 'restricted://FND02/supabase/v1/';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });
  it('52. EvidenceRef outside restricted grammar: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.evidenceRef = 'https://example.com/ev';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 12. FILE-LEVEL ERRORS ===
  it('53. Symlink: exit 1', () => {
    const td = mkdtempSync(join(tmpdir(), 'ev-t-sym-'));
    const rp = join(td, 'r.json'); writeFileSync(rp, JSON.stringify(complete()), 'utf-8');
    const lp = join(td, 'l.json');
    try { symlinkSync(rp, lp); } catch { return; }
    assert.strictEqual(runCLI(lp).code, 1);
  });
  it('54. Directory: exit 1', () => {
    assert.strictEqual(runCLI(mkdtempSync(join(tmpdir(), 'ev-t-dir-'))).code, 1);
  });
  it('55. Oversized: exit 1', () => {
    const d = complete();
    for (let i = 0; i < 300; i++) {
      d.credentialGroups.push({ groupId: `pad-${i}`, provider: 'supabase', status: 'pending' });
    }
    assert.strictEqual(runCLI(writeTemp(d)).code, 1);
  });
  it('56. Malformed JSON: exit 1', () => {
    const td = mkdtempSync(join(tmpdir(), 'ev-t-mal-'));
    writeFileSync(join(td, 'm.json'), '{ broken', 'utf-8');
    assert.strictEqual(runCLI(join(td, 'm.json')).code, 1);
  });

  // === 13. NON-DISCLOSURE ===
  it('57. Future date value not echoed in diagnostics', () => {
    const d = complete(); d.evidenceDate = '2099-12-31T23:59:59Z';
    const { code, stderr } = runCLI(writeTemp(d));
    assert.strictEqual(code, 1);
    assert.ok(!stderr.includes('2099'), 'stderr must not contain seeded year');
  });
  it('58. JWT seed not echoed', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = JWT_SEED + '.x';
    const { code, stderr } = runCLI(writeTemp(d));
    assert.strictEqual(code, 1);
    assert.ok(!stderr.includes(JWT_SEED), 'stderr must not contain JWT seed');
  });
  it('59. Email not echoed', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = 'user@example.org-x';
    const { code, stderr } = runCLI(writeTemp(d));
    assert.strictEqual(code, 1);
    assert.ok(!stderr.includes('user@example.org'), 'stderr must not contain email');
  });

  // Through-path for safety scanner: token prefix inside valid evidenceRef shape
  it('59a. Token prefix in evidenceRef path: exit 1, SECRET_VALUE category, no value leak', () => {
    const TOKEN_REF = `restricted://FND02/${TOK_PREFIX}/v1`;
    const d = complete();
    d.credentialGroups[0].verification.evidenceRef = TOKEN_REF;
    const { code, stderr } = runCLI(writeTemp(d));
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('SECRET_VALUE'), 'stderr must contain SECRET_VALUE category');
    assert.ok(!stderr.includes(TOK_PREFIX), 'stderr must not contain token value');
  });

  // === 14. PENDING STATE ===
  it('60. One pending, rest verified: exit 2', () => {
    const d = complete(); d.credentialGroups[0].status = 'pending'; delete d.credentialGroups[0].verification;
    assert.strictEqual(runCLI(writeTemp(d)).code, 2);
  });
  it('61. All pending: exit 2', () => {
    const d = complete();
    for (const g of d.credentialGroups) { g.status = 'pending'; delete g.verification; }
    for (const g of d.artifactGroups) { g.status = 'pending'; delete g.verification; }
    assert.strictEqual(runCLI(writeTemp(d)).code, 2);
  });

  // === 15. SCHEMA PARITY ===
  it('62. Schema providers enum has exactly 8 entries', () => {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const p = s.properties.credentialGroups.items.properties.provider.enum;
    assert.strictEqual(p.length, 8);
    assert.deepStrictEqual(p, ['supabase', 'livekit', 'anthropic', 'sarvam', 'deepgram', 'retell', 'elevenlabs', 'cartesia']);
  });
  it('63. Schema artifact groupId enum has exactly 7 entries', () => {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const ids = s.properties.artifactGroups.items.properties.groupId.enum;
    assert.strictEqual(ids.length, 7);
    assert.deepStrictEqual(ids, ['hello-html', 'hello-md', 'hello-assets', 'generated-pdf', 'voice-recording', 'scorecard-export', 'env-example-values']);
  });
  it('64. Schema credentialGroups minItems=maxItems=8', () => {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    assert.strictEqual(s.properties.credentialGroups.minItems, 8);
    assert.strictEqual(s.properties.credentialGroups.maxItems, 8);
  });
  it('65. Schema artifactGroups minItems=maxItems=7', () => {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    assert.strictEqual(s.properties.artifactGroups.minItems, 7);
    assert.strictEqual(s.properties.artifactGroups.maxItems, 7);
  });
  it('66. Schema status fields have type: string', () => {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    assert.strictEqual(s.properties.credentialGroups.items.properties.status.type, 'string');
    assert.strictEqual(s.properties.artifactGroups.items.properties.status.type, 'string');
  });
  it('67. Artifact verification has ownerRole and evidenceDate in required', () => {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const v = s.properties.artifactGroups.items.properties.verification;
    assert.ok(v.required.includes('ownerRole'));
    assert.ok(v.required.includes('evidenceDate'));
  });

  // === 16. PLACEHOLDER DETECTION ===
  it('68. Placeholder value rejected: exit 1', () => {
    const d = complete();
    d.credentialGroups[0].verification.oldCredentialRejectionMethod = 'TODO: replace me';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 17. DUPLICATE IDs ===
  it('69. Duplicate groupId across credentialGroups: exit 1', () => {
    const d = complete(); d.credentialGroups[1].groupId = 'supabase-rotation';
    assert.strictEqual(validate(writeTemp(d), TEST_CLOCK), 1);
  });

  // === 18. FND03-01: All example artifacts pending, no deleted-after-replacement claim ===
  it('FND03-01a: Committed example has all 7 artifact groups in pending status', () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf-8'));
    assert.strictEqual(example.artifactGroups.length, 7);
    for (let i = 0; i < example.artifactGroups.length; i++) {
      const g = example.artifactGroups[i];
      assert.strictEqual(g.status, 'pending', `artifactGroups[${i}].groupId=${g.groupId} must be pending`);
    }
  });
  it('FND03-01b: Committed example has no artifact verification objects (no disposition claims)', () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf-8'));
    for (let i = 0; i < example.artifactGroups.length; i++) {
      const g = example.artifactGroups[i];
      assert.strictEqual(g.verification, undefined, `artifactGroups[${i}].groupId=${g.groupId} must not have verification`);
    }
  });
  it('FND03-01c: Committed example has no deleted-after-replacement claim anywhere', () => {
    const raw = readFileSync(EXAMPLE, 'utf-8');
    assert.ok(!raw.includes('deleted-after-replacement'), 'Example must not contain deleted-after-replacement claim');
  });
  it('FND03-01d: Committed example exits 2 (valid shape, all pending — owner review pending)', () => {
    const { code, stderr } = runCLI(EXAMPLE);
    assert.strictEqual(code, 2, `Expected exit 2, got ${code}; stderr: ${stderr}`);
  });
  it('FND03-01e: All 7 artifact groupIds present and pending in committed example', () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf-8'));
    const expectedIds = ['hello-html', 'hello-md', 'hello-assets', 'generated-pdf', 'voice-recording', 'scorecard-export', 'env-example-values'];
    const actualIds = example.artifactGroups.map(g => g.groupId);
    assert.deepStrictEqual(actualIds, expectedIds);
  });

});
