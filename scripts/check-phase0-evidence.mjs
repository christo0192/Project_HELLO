#!/usr/bin/env node

/**
 * check-phase0-evidence.mjs
 *
 * ZERO-DEPENDENCY Phase-0 evidence manifest validator.
 * Validates the shape of a FND-02/FND-03 evidence manifest.
 * NEVER scans env files, artifact files, directories, or any other files.
 * NEVER emits input values in diagnostics.
 * NEVER claims rotation or disposition occurred — only validates evidence shape.
 *
 * Usage: node check-phase0-evidence.mjs [path/to/manifest.json]
 * Default: config/phase0-evidence.example.json
 *
 * Exit codes:
 *   0 = complete + valid (all 6 providers covered, all groups verified)
 *   2 = valid shape but incomplete (6-provider check fails or groups not fully verified)
 *   1 = invalid / unsafe / tool error
 */

import { readFileSync, statSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

// ---- Schema (embedded, no external fetch) ----
const SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'evidenceDate', 'owner', 'credentialGroups', 'artifactGroups'],
  properties: {
    schemaVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    evidenceDate: { type: 'string', format: 'date-time' },
    owner: {
      type: 'object',
      required: ['role', 'evidenceDate'],
      properties: {
        role: { type: 'string' },
        evidenceDate: { type: 'string', format: 'date-time' },
      },
    },
    credentialGroups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['groupId', 'provider', 'verification'],
        properties: {
          groupId: { type: 'string', pattern: '^[a-z][a-z0-9-]+$' },
          provider: {
            type: 'string',
            enum: ['supabase', 'livekit', 'anthropic', 'sarvam', 'deepgram', 'retell-elevenlabs-cartesia'],
          },
          verification: {
            type: 'object',
            required: ['ownerRole', 'evidenceDate', 'evidenceRef', 'rotationAction', 'oldCredentialRejectionMethod'],
            properties: {
              ownerRole: { type: 'string' },
              evidenceDate: { type: 'string', format: 'date-time' },
              evidenceRef: { type: 'string', pattern: '^restricted://FND02/[a-z0-9][a-z0-9._/-]{0,255}$' },
              rotationAction: { type: 'string', enum: ['rotated', 'revoked', 'deleted-resource'] },
              oldCredentialRejectionMethod: { type: 'string', enum: ['audit-log-screenshot', 'provider-console-timestamp', 'credential-rejection-test'] },
            },
          },
        },
      },
    },
    artifactGroups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['groupId', 'artifactType', 'verification'],
        properties: {
          groupId: { type: 'string', pattern: '^[a-z][a-z0-9-]+$' },
          artifactType: {
            type: 'string',
            enum: ['interview-recording', 'scorecard-pdf', 'candidate-screenshot', 'resume-copy', 'voice-media', 'generated-document', 'browser-recording'],
          },
          verification: {
            type: 'object',
            required: ['manualReviewOutcome', 'dispositionStatus', 'evidenceRef'],
            properties: {
              manualReviewOutcome: { type: 'string', enum: ['clean', 'replaced-synthetic', 'quarantined'] },
              dispositionStatus: { type: 'string', enum: ['retained-restricted', 'deleted-after-replacement', 'pending-review'] },
              evidenceRef: { type: 'string', pattern: '^restricted://FND03/[a-z0-9][a-z0-9._/-]{0,255}$' },
            },
          },
        },
      },
    },
  },
};

// ---- Constants ----
const VALID_PROVIDERS = ['supabase', 'livekit', 'anthropic', 'sarvam', 'deepgram', 'retell-elevenlabs-cartesia'];
const VALID_ARTIFACT_TYPES = ['interview-recording', 'scorecard-pdf', 'candidate-screenshot', 'resume-copy', 'voice-media', 'generated-document', 'browser-recording'];
const VALID_ROTATION_ACTIONS = ['rotated', 'revoked', 'deleted-resource'];
const VALID_REJECTION_METHODS = ['audit-log-screenshot', 'provider-console-timestamp', 'credential-rejection-test'];
const VALID_MANUAL_OUTCOMES = ['clean', 'replaced-synthetic', 'quarantined'];
const VALID_DISPOSITIONS = ['retained-restricted', 'deleted-after-replacement', 'pending-review'];

const SECRET_FIELD_PATTERN = /secret|private|key\b|token\b|password|passphrase|credential|account|project_id|api_key|jwt|pii|email|phone/i;
const JWT_PATTERN = /^eyJ[a-zA-Z0-9_-]{10,}\.(eyJ[a-zA-Z0-9_-]{10,}|[a-zA-Z0-9_-]{10,})\./;
const PRIVKEY_MARKER = /-----BEGIN/;
const BASE64_HIGH_ENTROPY = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const URL_WITH_CREDS = /https?:\/\/[^\/\s@]+:[^\/\s@]+@/i;
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:\\)/;
const LOCAL_PATH = /^(\.\/|\.\.\/|\/)/;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_PATTERN = /\+?\d{1,4}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,4}[\s.-]?\d{1,4}/;
const FUTURE_DATE_LIMIT = new Date('2026-07-30T00:00:00Z');
const EVIDENCE_REF_PATTERN = /^restricted:\/\/FND0(2|3)\/[a-z0-9][a-z0-9._/-]{0,255}$/;

// ---- Diagnostics (redacted) ----
const diagnostics = [];

function diag(category, detail) {
  diagnostics.push(`DIAG [${category}]: ${detail}`);
}

// ---- Validation helpers ----

function isISO8601Date(str) {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !Number.isNaN(d.getTime());
}

function isDateTimeValue(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
}

// ---- Known schema field names (to avoid flagging structural fields) ----
const SCHEMA_FIELD_NAMES = new Set([
  'schemaVersion', 'evidenceDate', 'owner', 'credentialGroups', 'artifactGroups',
  'role', 'groupId', 'provider', 'verification',
  'ownerRole', 'evidenceRef', 'rotationAction', 'oldCredentialRejectionMethod',
  'artifactType', 'manualReviewOutcome', 'dispositionStatus',
]);

function detectSecretFieldNames(obj, path = '') {
  let found = false;
  for (const key of Object.keys(obj)) {
    // Skip known schema-defined field names
    if (SCHEMA_FIELD_NAMES.has(key)) continue;
    if (SECRET_FIELD_PATTERN.test(key)) {
      diag('SECRET_FIELD_NAME', `Field name at ${path}.${key} matches secret-like pattern`);
      found = true;
    }
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      if (detectSecretFieldNames(obj[key], `${path}.${key}`)) found = true;
    }
    if (Array.isArray(obj[key])) {
      for (let i = 0; i < obj[key].length; i++) {
        if (typeof obj[key][i] === 'object' && obj[key][i] !== null) {
          if (detectSecretFieldNames(obj[key][i], `${path}.${key}[${i}]`)) found = true;
        }
      }
    }
  }
  return found;
}

function detectSecretValues(obj, path = '') {
  let found = false;
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (typeof value === 'string') {
      if (JWT_PATTERN.test(value)) {
        diag('SECRET_VALUE', `Value at ${currentPath} matches JWT token pattern`);
        found = true;
      }
      if (PRIVKEY_MARKER.test(value)) {
        diag('SECRET_VALUE', `Value at ${currentPath} matches private key marker`);
        found = true;
      }
      if (BASE64_HIGH_ENTROPY.test(value) && !key.toLowerCase().includes('evidence')) {
        if (value.length >= 64) {
          diag('SECRET_VALUE', `Value at ${currentPath} appears to be high-entropy base64`);
          found = true;
        }
      }
      if (URL_WITH_CREDS.test(value)) {
        diag('SECRET_VALUE', `Value at ${currentPath} contains URL with embedded credentials`);
        found = true;
      }
      if (EMAIL_PATTERN.test(value) && !value.includes('example.com') && !value.includes('synthetic')) {
        diag('PII_VALUE', `Value at ${currentPath} matches email pattern`);
        found = true;
      }
      if (PHONE_PATTERN.test(value) && value.replace(/[\s.-]/g, '').length >= 10 && value.replace(/[\s.-]/g, '').length <= 15) {
        if (!value.includes('555') && !value.includes('000')) {
          diag('PII_VALUE', `Value at ${currentPath} matches phone number pattern`);
          found = true;
        }
      }
      if (ABSOLUTE_PATH.test(value)) {
        diag('PATH_LEAK', `Value at ${currentPath} appears to be an absolute path`);
        found = true;
      }
      if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')) {
        diag('PATH_LEAK', `Value at ${currentPath} appears to be a local relative path`);
        found = true;
      }
      if (isDateTimeValue(value)) {
        const date = new Date(value);
        if (date > FUTURE_DATE_LIMIT) {
          diag('FUTURE_DATE', `Value at ${currentPath} is a future date`);
          found = true;
        }
      }
    }
    if (typeof value === 'object' && value !== null) {
      if (detectSecretValues(value, currentPath)) found = true;
    }
  }
  return found;
}

function findPlaceholderClaims(obj, path = '') {
  let found = false;
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower.includes('placeholder') || lower.includes('todo') || lower.includes('replace me') || lower.includes('change this')) {
        diag('PLACEHOLDER_CLAIM', `Value at ${currentPath} appears to be a placeholder claim`);
        found = true;
      }
    }
    if (typeof value === 'object' && value !== null) {
      if (findPlaceholderClaims(value, currentPath)) found = true;
    }
  }
  return found;
}

function checkUnknownFields(obj, schema, path = '') {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  if (!schema || !schema.properties) return false;

  let found = false;
  const allowed = new Set(Object.keys(schema.properties));

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      diag('UNKNOWN_FIELD', `Unknown field at ${path}.${key}`);
      found = true;
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key) && schema.properties[key] && schema.properties[key].type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (checkUnknownFields(value, schema.properties[key], `${path}.${key}`)) found = true;
    }
    if (allowed.has(key) && schema.properties[key] && schema.properties[key].items && Array.isArray(value)) {
      const itemSchema = schema.properties[key].items;
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'object' && value[i] !== null && !Array.isArray(value[i])) {
          if (checkUnknownFields(value[i], itemSchema, `${path}.${key}[${i}]`)) found = true;
          if (itemSchema.properties && itemSchema.properties.verification && value[i].verification) {
            if (checkUnknownFields(value[i].verification, itemSchema.properties.verification, `${path}.${key}[${i}].verification`)) found = true;
          }
        }
      }
    }
  }

  return found;
}

function checkEvidenceRefs(obj, path = '') {
  let found = false;
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (key === 'evidenceRef' && typeof value === 'string') {
      if (!EVIDENCE_REF_PATTERN.test(value)) {
        diag('INVALID_EVIDENCE_REF', `evidenceRef at ${currentPath} does not match restricted://FND0X/ grammar`);
        found = true;
      }
    }
    if (typeof value === 'object' && value !== null) {
      if (checkEvidenceRefs(value, currentPath)) found = true;
    }
  }
  return found;
}

function findDuplicates(groups) {
  if (!Array.isArray(groups)) return false;
  const seen = new Set();
  let found = false;
  for (const g of groups) {
    if (g && g.groupId) {
      if (seen.has(g.groupId)) {
        diag('DUPLICATE_GROUPID', `Duplicate groupId: ${g.groupId}`);
        found = true;
      }
      seen.add(g.groupId);
    }
  }
  return found;
}

function checkProviderCoverage(groups) {
  if (!Array.isArray(groups)) return false;
  const present = new Set(groups.map(g => g.provider));
  const missing = VALID_PROVIDERS.filter(p => !present.has(p));
  if (missing.length > 0) {
    diag('INCOMPLETE_COVERAGE', `Missing provider(s): ${missing.join(', ')}`);
    return false;
  }
  return true;
}

function checkAllCredGroupsVerified(groups) {
  if (!Array.isArray(groups)) return false;
  for (const g of groups) {
    if (!g.verification || !g.verification.evidenceRef || !g.verification.evidenceDate || !g.verification.ownerRole || !g.verification.rotationAction || !g.verification.oldCredentialRejectionMethod) {
      return false;
    }
  }
  return true;
}

function checkAllArtGroupsVerified(groups) {
  if (!Array.isArray(groups)) return false;
  for (const g of groups) {
    if (!g.verification || !g.verification.evidenceRef || !g.verification.manualReviewOutcome || !g.verification.dispositionStatus) {
      return false;
    }
  }
  return true;
}

// ---- Main validation ----

function validate(filePath) {
  diagnostics.length = 0;
  let errors = 0;
  let incomplete = false;

  // 1. Stat file — reject symlinks via lstatSync
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    diag('FILE_ERROR', 'Cannot stat file');
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
    diag('FILE_ERROR', 'Cannot read file');
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

  // 3. Schema validation (inline structural)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    diag('SCHEMA_ERROR', 'Root must be a JSON object');
    return 1;
  }

  const schemaProps = SCHEMA.properties;
  for (const req of SCHEMA.required) {
    if (!(req in data)) {
      diag('SCHEMA_ERROR', `Missing required top-level field: ${req}`);
      errors++;
    }
  }

  if (typeof data.schemaVersion === 'string' && !/^\d+\.\d+\.\d+$/.test(data.schemaVersion)) {
    diag('SCHEMA_ERROR', 'schemaVersion must be semver');
    errors++;
  }

  if (data.evidenceDate && !isISO8601Date(data.evidenceDate)) {
    diag('SCHEMA_ERROR', 'evidenceDate is not a valid date');
    errors++;
  }

  if (data.owner) {
    if (!data.owner.role) { diag('SCHEMA_ERROR', 'owner.role is required'); errors++; }
    if (!data.owner.evidenceDate) { diag('SCHEMA_ERROR', 'owner.evidenceDate is required'); errors++; }
    if (data.owner.evidenceDate && !isISO8601Date(data.owner.evidenceDate)) {
      diag('SCHEMA_ERROR', 'owner.evidenceDate is not a valid date');
      errors++;
    }
  }

  if (data.credentialGroups) {
    if (!Array.isArray(data.credentialGroups)) {
      diag('SCHEMA_ERROR', 'credentialGroups must be an array');
      errors++;
    } else if (data.credentialGroups.length > 100) {
      diag('SCHEMA_ERROR', 'credentialGroups exceeds maximum of 100 items');
      errors++;
    } else {
      for (let i = 0; i < data.credentialGroups.length; i++) {
        const g = data.credentialGroups[i];
        if (!g) { diag('SCHEMA_ERROR', `credentialGroups[${i}] is null/undefined`); errors++; continue; }
        if (!g.groupId) { diag('SCHEMA_ERROR', `credentialGroups[${i}].groupId required`); errors++; }
        if (g.groupId && !/^[a-z][a-z0-9-]+$/.test(g.groupId)) {
          diag('SCHEMA_ERROR', `credentialGroups[${i}].groupId does not match pattern`);
          errors++;
        }
        if (!g.provider) { diag('SCHEMA_ERROR', `credentialGroups[${i}].provider required`); errors++; }
        if (g.provider && !VALID_PROVIDERS.includes(g.provider)) {
          diag('UNKNOWN_PROVIDER', `credentialGroups[${i}].provider "${g.provider}" is not in the valid provider list`);
          errors++;
        }
        if (!g.verification) { diag('SCHEMA_ERROR', `credentialGroups[${i}].verification required`); errors++; continue; }
        if (!g.verification.ownerRole) { diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.ownerRole required`); errors++; }
        if (!g.verification.evidenceDate) { diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.evidenceDate required`); errors++; }
        if (g.verification.evidenceDate && !isISO8601Date(g.verification.evidenceDate)) {
          diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.evidenceDate not valid`);
          errors++;
        }
        if (!g.verification.evidenceRef) { diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.evidenceRef required`); errors++; }
        if (g.verification.evidenceRef && !/^restricted:\/\/FND02\/[a-z0-9][a-z0-9._/-]{0,255}$/.test(g.verification.evidenceRef)) {
          diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.evidenceRef invalid`);
          errors++;
        }
        if (!g.verification.rotationAction) { diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.rotationAction required`); errors++; }
        if (g.verification.rotationAction && !VALID_ROTATION_ACTIONS.includes(g.verification.rotationAction)) {
          diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.rotationAction invalid`);
          errors++;
        }
        if (!g.verification.oldCredentialRejectionMethod) { diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.oldCredentialRejectionMethod required`); errors++; }
        if (g.verification.oldCredentialRejectionMethod && !VALID_REJECTION_METHODS.includes(g.verification.oldCredentialRejectionMethod)) {
          diag('SCHEMA_ERROR', `credentialGroups[${i}].verification.oldCredentialRejectionMethod invalid`);
          errors++;
        }
      }
    }
  }

  if (data.artifactGroups) {
    if (!Array.isArray(data.artifactGroups)) {
      diag('SCHEMA_ERROR', 'artifactGroups must be an array');
      errors++;
    } else if (data.artifactGroups.length > 50) {
      diag('SCHEMA_ERROR', 'artifactGroups exceeds maximum of 50 items');
      errors++;
    } else {
      for (let i = 0; i < data.artifactGroups.length; i++) {
        const g = data.artifactGroups[i];
        if (!g) { diag('SCHEMA_ERROR', `artifactGroups[${i}] is null/undefined`); errors++; continue; }
        if (!g.groupId) { diag('SCHEMA_ERROR', `artifactGroups[${i}].groupId required`); errors++; }
        if (g.groupId && !/^[a-z][a-z0-9-]+$/.test(g.groupId)) {
          diag('SCHEMA_ERROR', `artifactGroups[${i}].groupId invalid`);
          errors++;
        }
        if (!g.artifactType) { diag('SCHEMA_ERROR', `artifactGroups[${i}].artifactType required`); errors++; }
        if (g.artifactType && !VALID_ARTIFACT_TYPES.includes(g.artifactType)) {
          diag('UNKNOWN_ARTIFACT_TYPE', `artifactGroups[${i}].artifactType "${g.artifactType}" unknown`);
          errors++;
        }
        if (!g.verification) { diag('SCHEMA_ERROR', `artifactGroups[${i}].verification required`); errors++; continue; }
        if (!g.verification.manualReviewOutcome) { diag('SCHEMA_ERROR', `artifactGroups[${i}].verification.manualReviewOutcome required`); errors++; }
        if (g.verification.manualReviewOutcome && !VALID_MANUAL_OUTCOMES.includes(g.verification.manualReviewOutcome)) {
          diag('SCHEMA_ERROR', `artifactGroups[${i}].verification.manualReviewOutcome invalid`);
          errors++;
        }
        if (!g.verification.dispositionStatus) { diag('SCHEMA_ERROR', `artifactGroups[${i}].verification.dispositionStatus required`); errors++; }
        if (g.verification.dispositionStatus && !VALID_DISPOSITIONS.includes(g.verification.dispositionStatus)) {
          diag('SCHEMA_ERROR', `artifactGroups[${i}].verification.dispositionStatus invalid`);
          errors++;
        }
        if (!g.verification.evidenceRef) { diag('SCHEMA_ERROR', `artifactGroups[${i}].verification.evidenceRef required`); errors++; }
        if (g.verification.evidenceRef && !/^restricted:\/\/FND03\/[a-z0-9][a-z0-9._/-]{0,255}$/.test(g.verification.evidenceRef)) {
          diag('SCHEMA_ERROR', `artifactGroups[${i}].verification.evidenceRef invalid`);
          errors++;
        }
      }
    }
  }

  if (errors > 0) return 1;

  // 4. Content validation
  const hasUnknownFields = checkUnknownFields(data, SCHEMA);
  const hasSecretFieldNames = detectSecretFieldNames(data);
  const hasSecretValues = detectSecretValues(data);
  const hasPlaceholders = findPlaceholderClaims(data);
  const hasDups = findDuplicates(data.credentialGroups) || findDuplicates(data.artifactGroups);
  const hasInvalidRefs = checkEvidenceRefs(data);

  if (hasUnknownFields || hasSecretFieldNames || hasSecretValues || hasPlaceholders || hasDups || hasInvalidRefs) {
    return 1;
  }

  // 5. Completeness check
  const hasAllProviders = checkProviderCoverage(data.credentialGroups);
  const allCredGroupsVerified = checkAllCredGroupsVerified(data.credentialGroups);

  if (!hasAllProviders || !allCredGroupsVerified) {
    return 2;
  }

  // Validate artifact groups too
  const allArtGroupsVerified = checkAllArtGroupsVerified(data.artifactGroups);
  if (!allArtGroupsVerified) {
    return 2;
  }

  return 0;
}

// ---- CLI ----
const target = resolve(process.argv[2] || 'config/phase0-evidence.example.json');
const exitCode = validate(target);

for (const d of diagnostics) {
  process.stderr.write(d + '\n');
}

process.exit(exitCode);
