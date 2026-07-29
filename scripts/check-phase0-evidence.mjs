#!/usr/bin/env node

/**
 * check-phase0-evidence.mjs
 *
 * ZERO-DEPENDENCY Phase-0 evidence manifest validator.
 * Loads schema from config/phase0-evidence.schema.json — no embedded duplicate.
 * Validates shape, coverage, safety (secret/PII/path/URL scanning).
 * NEVER scans env files, artifact files, directories, or any other files.
 * NEVER emits input values in diagnostics.
 * NEVER claims rotation or disposition occurred — only validates evidence shape.
 *
 * Usage: node check-phase0-evidence.mjs <manifest-path>
 *   manifest-path is REQUIRED; exit 1 if missing.
 *
 * Export (for tests): validate(manifestPath, clock?)
 *   - Tests pass clock = new Date('2025-06-01T00:00:00Z')
 *   - CLI always uses new Date() (real clock)
 *
 * Exit codes:
 *   0 = complete + valid (all 8 providers verified, all 7 artifact groups verified, no pending)
 *   2 = valid shape but at least one entry status="pending"
 *   1 = invalid / unsafe / tool error
 */

import { readFileSync, statSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Load schema from canonical file ----
const SCHEMA_PATH = resolve(import.meta.dirname, '..', 'config', 'phase0-evidence.schema.json');
let SCHEMA;
try {
  SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
} catch {
  process.stderr.write('DIAG [SCHEMA_LOAD_ERROR]: Failed to load schema from config/phase0-evidence.schema.json\n');
  process.exit(1);
}

const SCHEMA_VERSION = SCHEMA.version || '1.0.0';

// ---- Extract enums from schema dynamically ----
function extractEnum(schema, ...pathSegments) {
  let node = schema;
  for (const seg of pathSegments) {
    if (!node || typeof node !== 'object') return [];
    node = node[seg];
  }
  return Array.isArray(node) ? node : [];
}

// 8 providers
const VALID_PROVIDERS = extractEnum(SCHEMA, 'properties', 'credentialGroups', 'items', 'properties', 'provider', 'enum');
// 7 artifact group IDs
const VALID_ARTIFACT_GROUP_IDS = extractEnum(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'groupId', 'enum');
// Approved owner roles
const VALID_OWNER_ROLES = extractEnum(SCHEMA, 'properties', 'owner', 'properties', 'role', 'enum');

// ---- Patterns (runtime-constructed to avoid scanner triggers) ----
const JWT_PATTERN = /^eyJ[a-zA-Z0-9_-]+\./;
const PRIVKEY_MARKER = /-----BEGIN/;
const TOKEN_PREFIXES = /(sk-|pk-|rk-|whook_|xox[bprs]-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|hf_|sf_|sgd_|tkn_)/i;
const BASE64_HIGH_ENTROPY = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const URL_WITH_CREDS = /https?:\/\/[^\/\s@]+:[^\/\s@]+@/i;
const URL_WITH_QUERY = /https?:\/\/[^\s]+\?/;
const URL_WITH_FRAGMENT = /https?:\/\/[^\s]+#/;
const ABSOLUTE_UNIX_PATH = /^\/[^\/]/;
const ABSOLUTE_WIN_PATH = /^[A-Za-z]:\\/;
const PARENT_TRAVERSAL = /\.\.\//;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_PATTERN1 = /\+\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/;
const PHONE_PATTERN2 = /\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/;

// ---- Diagnostics (redacted — NEVER echo input values) ----
const diagnostics = [];

function diag(category, detail) {
  diagnostics.push(`DIAG [${category}]: ${detail}`);
}

// ---- Date helpers ----
function isISO8601Date(str, clock) {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return false;
  // Must have UTC offset (Z or +00:00 or -00:00) or be UTC
  if (!/[+-]\d{2}:\d{2}$/.test(str) && !str.endsWith('Z')) return false;
  // Must not be after clock
  if (d.getTime() > clock.getTime()) return false;
  return true;
}

function isDateTimeValue(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
}

// ---- Known schema field names (structural only, not input-derived) ----
const SCHEMA_FIELD_NAMES = new Set([
  'schemaVersion', 'evidenceDate', 'owner', 'credentialGroups', 'artifactGroups',
  'role', 'groupId', 'provider', 'verification', 'status',
  'ownerRole', 'evidenceRef', 'rotationAction', 'oldCredentialRejectionMethod',
  'artifactType', 'manualReviewOutcome', 'dispositionStatus',
]);

// ---- Validate role against schema enum ----
function isValidRole(role) {
  return VALID_OWNER_ROLES.includes(role);
}

// ---- Secret/PII/path/value scanners ----
function scanValue(value, path, clock) {
  if (typeof value !== 'string') return false;
  let found = false;

  // JWT
  if (JWT_PATTERN.test(value)) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // Private key markers
  if (PRIVKEY_MARKER.test(value)) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // Common token prefixes
  if (TOKEN_PREFIXES.test(value)) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // High-entropy base64 (≥ 40 chars)
  if (BASE64_HIGH_ENTROPY.test(value) && value.length >= 40) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // URL with userinfo
  if (URL_WITH_CREDS.test(value)) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // URL with query
  if (URL_WITH_QUERY.test(value)) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // URL with fragment
  if (URL_WITH_FRAGMENT.test(value)) {
    diag('SECRET_VALUE', `at ${path}`);
    found = true;
  }
  // Absolute paths (Unix or Windows)
  if (ABSOLUTE_UNIX_PATH.test(value) || ABSOLUTE_WIN_PATH.test(value)) {
    diag('PATH_LEAK', `at ${path}`);
    found = true;
  }
  // Parent traversal
  if (PARENT_TRAVERSAL.test(value)) {
    diag('PATH_LEAK', `at ${path}`);
    found = true;
  }
  // Emails
  if (EMAIL_PATTERN.test(value)) {
    diag('PII_VALUE', `at ${path}`);
    found = true;
  }
  // Phone-like patterns
  if (PHONE_PATTERN1.test(value) || PHONE_PATTERN2.test(value)) {
    diag('PII_VALUE', `at ${path}`);
    found = true;
  }
  // Future dates (only for date-time fields, not arbitrary strings — checked in schema validation)
  // Evidence ref restricted to //FND02 or //FND03
  if (path.endsWith('evidenceRef')) {
    if (!/^restricted:\/\/FND0(2|3)\/[a-z0-9][a-z0-9._/-]{0,255}$/.test(value)) {
      diag('INVALID_EVIDENCE_REF', `at ${path}`);
      found = true;
    }
  }

  return found;
}

function scanObject(obj, path, clock) {
  let found = false;
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;

    // Check for secret-like field names (not in schema)
    if (!SCHEMA_FIELD_NAMES.has(key)) {
      if (/secret|private|key\b|token\b|password|passphrase|credential|account|project_id|api_key|jwt|pii|email|phone/i.test(key)) {
        diag('SECRET_VALUE', `at ${currentPath}`);
        found = true;
      }
    }

    if (typeof value === 'string') {
      if (scanValue(value, currentPath, clock)) found = true;
    } else if (typeof value === 'object' && value !== null) {
      if (scanObject(value, currentPath, clock)) found = true;
    }
  }
  return found;
}

function findPlaceholderClaims(obj, path) {
  let found = false;
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower.includes('placeholder') || lower.includes('todo') || lower.includes('replace me') || lower.includes('change this')) {
        diag('PLACEHOLDER_CLAIM', `at ${currentPath}`);
        found = true;
      }
    } else if (typeof value === 'object' && value !== null) {
      if (findPlaceholderClaims(value, currentPath)) found = true;
    }
  }
  return found;
}

function checkUnknownFields(obj, allowed, locationPath) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  let found = false;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      diag('UNKNOWN_FIELD', locationPath);
      found = true;
    }
  }
  return found;
}

function findDuplicates(groups, path) {
  if (!Array.isArray(groups)) return false;
  const seen = new Set();
  let found = false;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g && g.groupId) {
      if (seen.has(g.groupId)) {
        diag('DUPLICATE_ID', `at ${path}[${i}].groupId`);
        found = true;
      }
      seen.add(g.groupId);
    }
  }
  return found;
}

// ---- FND-03 outcome validation ----
function validateArtifactOutcome(verification, path) {
  if (!verification) return false;
  const outcome = verification.manualReviewOutcome;
  const disposition = verification.dispositionStatus;

  // clean + pending-review = INVALID
  if (outcome === 'clean' && disposition === 'pending-review') {
    diag('INVALID_OUTCOME', `at ${path}: clean outcome contradicts pending-review disposition`);
    return false;
  }
  // quarantined + deleted-after-replacement = INVALID
  if (outcome === 'quarantined' && disposition === 'deleted-after-replacement') {
    diag('INVALID_OUTCOME', `at ${path}: quarantined outcome contradicts deleted-after-replacement disposition`);
    return false;
  }
  return true;
}

// ---- Main validation ----

function validate(filePath, clock) {
  diagnostics.length = 0;
  let errors = 0;
  let hasPending = false;

  // Use provided clock or real time
  const runtimeClock = clock || new Date();

  // 1. Stat file — reject symlinks via lstatSync
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    diag('FILE_ERROR', 'Cannot stat manifest');
    return 1;
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    diag('FILE_ERROR', 'Path is not a regular file');
    return 1;
  }

  // Also stat (follow) to check size
  let realStats;
  try {
    realStats = statSync(filePath);
  } catch {
    diag('FILE_ERROR', 'Cannot read manifest');
    return 1;
  }

  if (realStats.size > 65536) {
    diag('FILE_ERROR', 'File exceeds maximum size of 65536 bytes');
    return 1;
  }

  // 2. Parse JSON
  let data;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch {
    diag('PARSE_ERROR', 'Malformed JSON');
    return 1;
  }

  // 3. Type check root
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    diag('SCHEMA_ERROR', 'Root must be a JSON object');
    return 1;
  }

  // 4. Required top-level fields
  const topRequired = ['schemaVersion', 'evidenceDate', 'owner', 'credentialGroups', 'artifactGroups'];
  for (const req of topRequired) {
    if (!(req in data)) {
      diag('SCHEMA_ERROR', `Missing required top-level field: ${req}`);
      errors++;
    }
  }
  if (errors > 0) return 1;

  // 5. schemaVersion must equal schema's own version
  if (data.schemaVersion !== SCHEMA_VERSION) {
    diag('SCHEMA_ERROR', `schemaVersion must be "${SCHEMA_VERSION}"`);
    return 1;
  }

  // 6. Validate evidenceDate against clock
  if (!isISO8601Date(data.evidenceDate, runtimeClock)) {
    diag('SCHEMA_ERROR', 'evidenceDate is invalid, not UTC, or in the future');
    return 1;
  }

  // 7. Validate owner
  if (typeof data.owner !== 'object' || data.owner === null || Array.isArray(data.owner)) {
    diag('SCHEMA_ERROR', 'owner must be an object');
    return 1;
  }
  if (!data.owner.role) {
    diag('SCHEMA_ERROR', 'owner.role is required');
    return 1;
  }
  if (!isValidRole(data.owner.role)) {
    diag('SCHEMA_ERROR', 'owner.role is not an approved role');
    return 1;
  }
  if (!data.owner.evidenceDate) {
    diag('SCHEMA_ERROR', 'owner.evidenceDate is required');
    return 1;
  }
  if (!isISO8601Date(data.owner.evidenceDate, runtimeClock)) {
    diag('SCHEMA_ERROR', 'owner.evidenceDate is invalid, not UTC, or in the future');
    return 1;
  }

  // 8. Validate credentialGroups
  if (!Array.isArray(data.credentialGroups)) {
    diag('SCHEMA_ERROR', 'credentialGroups must be an array');
    return 1;
  }
  if (data.credentialGroups.length > 100) {
    diag('SCHEMA_ERROR', 'credentialGroups exceeds maximum of 100 items');
    return 1;
  }

  const credProviderSet = new Set();
  let allCredVerified = true;

  for (let i = 0; i < data.credentialGroups.length; i++) {
    const g = data.credentialGroups[i];
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      diag('SCHEMA_ERROR', `credentialGroups[${i}] is invalid`);
      return 1;
    }

    // groupId required
    if (!g.groupId || typeof g.groupId !== 'string') {
      diag('SCHEMA_ERROR', `credentialGroups[${i}].groupId required`);
      return 1;
    }
    if (!/^[a-z][a-z0-9-]+$/.test(g.groupId)) {
      diag('SCHEMA_ERROR', `credentialGroups[${i}].groupId does not match pattern`);
      return 1;
    }

    // provider required
    if (!g.provider || typeof g.provider !== 'string') {
      diag('SCHEMA_ERROR', `credentialGroups[${i}].provider required`);
      return 1;
    }
    if (!VALID_PROVIDERS.includes(g.provider)) {
      diag('UNKNOWN_PROVIDER', `credentialGroups[${i}].provider`);
      return 1;
    }
    credProviderSet.add(g.provider);

    // status required
    if (!g.status || !['pending', 'verified'].includes(g.status)) {
      diag('SCHEMA_ERROR', `credentialGroups[${i}].status must be "pending" or "verified"`);
      return 1;
    }

    // if/then/else: status=pending => no verification; status=verified => verification required
    if (g.status === 'pending') {
      hasPending = true;
      if (g.verification !== undefined && g.verification !== null) {
        diag('SCHEMA_ERROR', `credentialGroups[${i}]: status=pending but verification present`);
        return 1;
      }
    } else {
      // verified
      if (!g.verification || typeof g.verification !== 'object' || Array.isArray(g.verification)) {
        diag('SCHEMA_ERROR', `credentialGroups[${i}]: status=verified requires verification object`);
        return 1;
      }

      const v = g.verification;
      const vPath = `credentialGroups[${i}].verification`;

      if (!v.ownerRole) { diag('SCHEMA_ERROR', `${vPath}.ownerRole required`); return 1; }
      if (!isValidRole(v.ownerRole)) { diag('SCHEMA_ERROR', `${vPath}.ownerRole is not an approved role`); return 1; }

      if (!v.evidenceDate) { diag('SCHEMA_ERROR', `${vPath}.evidenceDate required`); return 1; }
      if (!isISO8601Date(v.evidenceDate, runtimeClock)) { diag('SCHEMA_ERROR', `${vPath}.evidenceDate invalid, not UTC, or in the future`); return 1; }

      if (!v.evidenceRef || typeof v.evidenceRef !== 'string') { diag('SCHEMA_ERROR', `${vPath}.evidenceRef required`); return 1; }
      if (!/^restricted:\/\/FND02\/[a-z0-9][a-z0-9._/-]{0,255}$/.test(v.evidenceRef)) {
        diag('SCHEMA_ERROR', `${vPath}.evidenceRef pattern mismatch`);
        return 1;
      }

      if (!v.rotationAction || !['rotated', 'revoked', 'deleted-resource'].includes(v.rotationAction)) {
        diag('SCHEMA_ERROR', `${vPath}.rotationAction invalid`);
        return 1;
      }
      if (!v.oldCredentialRejectionMethod || !['audit-log-screenshot', 'provider-console-timestamp', 'credential-rejection-test'].includes(v.oldCredentialRejectionMethod)) {
        diag('SCHEMA_ERROR', `${vPath}.oldCredentialRejectionMethod invalid`);
        return 1;
      }
    }
  }

  // 9. Validate artifactGroups
  if (!Array.isArray(data.artifactGroups)) {
    diag('SCHEMA_ERROR', 'artifactGroups must be an array');
    return 1;
  }
  if (data.artifactGroups.length === 0) {
    diag('SCHEMA_ERROR', 'artifactGroups must not be empty');
    return 1;
  }
  if (data.artifactGroups.length > 50) {
    diag('SCHEMA_ERROR', 'artifactGroups exceeds maximum of 50 items');
    return 1;
  }

  const artGroupIdSet = new Set();
  let allArtVerified = true;

  for (let i = 0; i < data.artifactGroups.length; i++) {
    const g = data.artifactGroups[i];
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      diag('SCHEMA_ERROR', `artifactGroups[${i}] is invalid`);
      return 1;
    }

    // groupId required
    if (!g.groupId || typeof g.groupId !== 'string') {
      diag('SCHEMA_ERROR', `artifactGroups[${i}].groupId required`);
      return 1;
    }
    if (!VALID_ARTIFACT_GROUP_IDS.includes(g.groupId)) {
      diag('UNKNOWN_ARTIFACT_GROUP', `artifactGroups[${i}].groupId`);
      return 1;
    }
    artGroupIdSet.add(g.groupId);

    // artifactType required
    const validArtifactTypes = extractEnum(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'artifactType', 'enum');
    if (!g.artifactType || !validArtifactTypes.includes(g.artifactType)) {
      diag('SCHEMA_ERROR', `artifactGroups[${i}].artifactType invalid`);
      return 1;
    }

    // status required
    if (!g.status || !['pending', 'verified'].includes(g.status)) {
      diag('SCHEMA_ERROR', `artifactGroups[${i}].status must be "pending" or "verified"`);
      return 1;
    }

    // if/then/else
    if (g.status === 'pending') {
      hasPending = true;
      if (g.verification !== undefined && g.verification !== null) {
        diag('SCHEMA_ERROR', `artifactGroups[${i}]: status=pending but verification present`);
        return 1;
      }
    } else {
      if (!g.verification || typeof g.verification !== 'object' || Array.isArray(g.verification)) {
        diag('SCHEMA_ERROR', `artifactGroups[${i}]: status=verified requires verification object`);
        return 1;
      }

      const v = g.verification;
      const vPath = `artifactGroups[${i}].verification`;

      if (!v.manualReviewOutcome || !['clean', 'replaced-synthetic', 'quarantined'].includes(v.manualReviewOutcome)) {
        diag('SCHEMA_ERROR', `${vPath}.manualReviewOutcome invalid`);
        return 1;
      }
      if (!v.dispositionStatus || !['retained-restricted', 'deleted-after-replacement', 'pending-review'].includes(v.dispositionStatus)) {
        diag('SCHEMA_ERROR', `${vPath}.dispositionStatus invalid`);
        return 1;
      }
      if (!v.evidenceRef || typeof v.evidenceRef !== 'string') { diag('SCHEMA_ERROR', `${vPath}.evidenceRef required`); return 1; }
      if (!/^restricted:\/\/FND03\/[a-z0-9][a-z0-9._/-]{0,255}$/.test(v.evidenceRef)) {
        diag('SCHEMA_ERROR', `${vPath}.evidenceRef pattern mismatch`);
        return 1;
      }

      // FND-03 outcome validation
      if (!validateArtifactOutcome(v, vPath)) {
        return 1;
      }
    }
  }

  // 10. Content safety scan
  const hasSecrets = scanObject(data, '', runtimeClock);
  const hasPlaceholders = findPlaceholderClaims(data, '');
  const hasUnknownFields = checkUnknownFields(data, new Set(topRequired), '');
  const hasDups = findDuplicates(data.credentialGroups, 'credentialGroups') ||
                  findDuplicates(data.artifactGroups, 'artifactGroups');

  if (hasSecrets || hasPlaceholders || hasUnknownFields || hasDups) {
    return 1;
  }

  // 11. Unknown fields check on nested objects (using schema knowledge)
  // Check owner
  if (data.owner) {
    const ownerAllowed = new Set(['role', 'evidenceDate']);
    for (const key of Object.keys(data.owner)) {
      if (!ownerAllowed.has(key)) {
        diag('UNKNOWN_FIELD', 'owner');
        return 1;
      }
    }
  }

  // Check credential group items for unknown fields
  const credItemAllowed = new Set(['groupId', 'provider', 'status', 'verification']);
  const credVerificationAllowed = new Set(['ownerRole', 'evidenceDate', 'evidenceRef', 'rotationAction', 'oldCredentialRejectionMethod']);
  for (let i = 0; i < data.credentialGroups.length; i++) {
    const g = data.credentialGroups[i];
    for (const key of Object.keys(g)) {
      if (!credItemAllowed.has(key)) {
        diag('UNKNOWN_FIELD', `credentialGroups[${i}]`);
        return 1;
      }
    }
    if (g.verification && typeof g.verification === 'object') {
      for (const key of Object.keys(g.verification)) {
        if (!credVerificationAllowed.has(key)) {
          diag('UNKNOWN_FIELD', `credentialGroups[${i}].verification`);
          return 1;
        }
      }
    }
  }

  // Check artifact group items for unknown fields
  const artItemAllowed = new Set(['groupId', 'artifactType', 'status', 'verification']);
  const artVerificationAllowed = new Set(['manualReviewOutcome', 'dispositionStatus', 'evidenceRef']);
  for (let i = 0; i < data.artifactGroups.length; i++) {
    const g = data.artifactGroups[i];
    for (const key of Object.keys(g)) {
      if (!artItemAllowed.has(key)) {
        diag('UNKNOWN_FIELD', `artifactGroups[${i}]`);
        return 1;
      }
    }
    if (g.verification && typeof g.verification === 'object') {
      for (const key of Object.keys(g.verification)) {
        if (!artVerificationAllowed.has(key)) {
          diag('UNKNOWN_FIELD', `artifactGroups[${i}].verification`);
          return 1;
        }
      }
    }
  }

  // 12. Coverage checks
  // Require ALL 8 providers
  if (credProviderSet.size < VALID_PROVIDERS.length) {
    const missing = VALID_PROVIDERS.filter(p => !credProviderSet.has(p));
    diag('MISSING_PROVIDER', `Missing providers: ${missing.join(', ')}`);
    return 2;
  }

  // Require ALL 7 artifact group IDs
  if (artGroupIdSet.size < VALID_ARTIFACT_GROUP_IDS.length) {
    const missing = VALID_ARTIFACT_GROUP_IDS.filter(id => !artGroupIdSet.has(id));
    diag('MISSING_ARTIFACT_GROUP', `Missing artifact group IDs: ${missing.join(', ')}`);
    return 2;
  }

  // 13. Determine exit code
  if (hasPending) {
    return 2;
  }

  // All providers present, all verified, all artifact groups present, all verified
  return 0;
}

// ---- Export for tests ----
export { validate };

// ---- CLI (only runs when this file is the entry point) ----
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    process.stderr.write('DIAG [CLI_ERROR]: Manifest path is required. Usage: node check-phase0-evidence.mjs <manifest-path>\n');
    process.exit(1);
  }

  const absPath = resolve(manifestPath);
  const exitCode = validate(absPath);

  for (const d of diagnostics) {
    process.stderr.write(d + '\n');
  }

  process.exit(exitCode);
}
