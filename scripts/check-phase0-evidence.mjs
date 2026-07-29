#!/usr/bin/env node

/**
 * check-phase0-evidence.mjs
 *
 * ZERO-DEPENDENCY Phase-0 evidence manifest validator.
 * Loads schema from config/phase0-evidence.schema.json — canonical source.
 * Recursive schema-driven validation for type/required/enum/const/pattern/
 * minItems/maxItems/minLength/maxLength/additionalProperties/if-then-else.
 * Only cross-field business rules (date, coverage, secret scanning) live in code.
 * NEVER scans env files, artifact files, directories.
 * NEVER emits input values in diagnostics.
 * NEVER claims rotation or disposition occurred.
 *
 * Usage: node check-phase0-evidence.mjs <manifest-path>   (REQUIRED)
 *
 * Export: validate(manifestPath, clock?)
 *   - CLI uses new Date() (real clock); tests inject clock
 *
 * Exit: 0 = all verified complete, 2 = valid shape with pending, 1 = invalid/unsafe
 */

import { readFileSync, statSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Load canonical schema ----
const SCHEMA_PATH = resolve(import.meta.dirname, '..', 'config', 'phase0-evidence.schema.json');
let SCHEMA;
try {
  SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
} catch {
  process.stderr.write('DIAG [SCHEMA_LOAD_ERROR]: Failed to load schema\n');
  process.exit(1);
}

// ---- Extract schema-driven values for business rules ----
function schemaProp(schema, ...path) {
  let n = schema;
  for (const p of path) { if (!n || typeof n !== 'object') return undefined; n = n[p]; }
  return n;
}

const SCHEMA_VERSION = SCHEMA.version || '1.0.0';
const VALID_PROVIDERS = schemaProp(SCHEMA, 'properties', 'credentialGroups', 'items', 'properties', 'provider', 'enum') || [];
const VALID_ARTIFACT_IDS = schemaProp(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'groupId', 'enum') || [];
const VALID_OWNER_ROLES = schemaProp(SCHEMA, 'properties', 'owner', 'properties', 'role', 'enum') || [];
const CRED_VERIF_ROLES = schemaProp(SCHEMA, 'properties', 'credentialGroups', 'items', 'properties', 'verification', 'properties', 'ownerRole', 'enum') || VALID_OWNER_ROLES;
const VALID_ROTATION = schemaProp(SCHEMA, 'properties', 'credentialGroups', 'items', 'properties', 'verification', 'properties', 'rotationAction', 'enum') || [];
const VALID_REJECT = schemaProp(SCHEMA, 'properties', 'credentialGroups', 'items', 'properties', 'verification', 'properties', 'oldCredentialRejectionMethod', 'enum') || [];
const VALID_OUTCOMES = schemaProp(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'verification', 'properties', 'manualReviewOutcome', 'enum') || [];
const VALID_DISPOSITIONS = schemaProp(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'verification', 'properties', 'dispositionStatus', 'enum') || [];
const VALID_ARTIFACT_TYPES = schemaProp(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'artifactType', 'enum') || [];
const ART_VERIF_ROLES = schemaProp(SCHEMA, 'properties', 'artifactGroups', 'items', 'properties', 'verification', 'properties', 'ownerRole', 'enum') || VALID_OWNER_ROLES;

// ---- Business: canonical groupId->provider mapping (exact one-to-one) ----
const CRED_GROUP_PROVIDER_MAP = Object.freeze({
  'supabase-rotation': 'supabase',
  'livekit-rotation': 'livekit',
  'anthropic-rotation': 'anthropic',
  'sarvam-rotation': 'sarvam',
  'deepgram-rotation': 'deepgram',
  'retell-rotation': 'retell',
  'elevenlabs-rotation': 'elevenlabs',
  'cartesia-rotation': 'cartesia',
});

// ---- Business: canonical groupId->artifactType mapping ----
const ART_GROUP_TYPE_MAP = Object.freeze({
  'hello-html': 'generated-document',
  'hello-md': 'generated-document',
  'hello-assets': 'resume-copy',
  'generated-pdf': 'scorecard-pdf',
  'voice-recording': 'voice-media',
  'scorecard-export': 'scorecard-pdf',
  'env-example-values': 'generated-document',
});

// ---- Business: allowed (outcome, disposition) pairs for verified FND-03 ----
const ALLOWED_ARTIFACT_COMBOS = new Set([
  'clean:retained-restricted',
  'replaced-synthetic:retained-restricted',
  'replaced-synthetic:deleted-after-replacement',
  'quarantined:retained-restricted',
]);

// ---- Security patterns ----
const JWT_PATTERN = /^eyJ[a-zA-Z0-9_-]+\./;
const PRIVKEY_MARKER = /-----BEGIN/;
const TOKEN_PREFIXES = /(sk-|pk-|rk-|whook_|xox[bprs]-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|hf_|sf_|sgd_|tkn_)/i;
const BASE64_HI_ENTROPY = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const URL_USERINFO = /https?:\/\/[^\/\s@]+:[^\/\s@]+@/i;
const URL_QUERY = /https?:\/\/[^\s]+\?/;
const URL_FRAGMENT = /https?:\/\/[^\s]+#/;
const ABS_PATH = /^\/[^\/]/;
const WIN_PATH = /^[A-Za-z]:\\/;
const UNC_PATH = /^\\\\/;
const DOT_SLASH = /^\.\.?\//;
const PARENT_TRAVERSAL = /\.\.\//;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE1 = /\+\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/;
const PHONE_RE2 = /\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/;

// ---- Strict UTC RFC3339 ----
const STRICT_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isStrictUTC(str) {
  if (typeof str !== 'string') return false;
  if (!STRICT_UTC_RE.test(str)) return false;
  // Reject impossible dates (new Date allows Feb 30 etc via rollover):
  // parse components and verify round-trip
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return false;
  // Validate the parsed components match the input
  const iso = d.toISOString();
  // Compare date+time portions: the epoch ms of our rounded parse vs toISOString
  // Simpler: reconstruct from components
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return false;
  const yr = +m[1], mo = +m[2], dy = +m[3], hr = +m[4], mn = +m[5], sc = +m[6];
  // new Date(Date.UTC(...)) to avoid local TZ issues
  const utc = new Date(Date.UTC(yr, mo - 1, dy, hr, mn, sc));
  if (Number.isNaN(utc.getTime())) return false;
  if (utc.getUTCFullYear() !== yr) return false;
  if (utc.getUTCMonth() + 1 !== mo) return false;
  if (utc.getUTCDate() !== dy) return false;
  if (utc.getUTCHours() !== hr) return false;
  if (utc.getUTCMinutes() !== mn) return false;
  if (utc.getUTCSeconds() !== sc) return false;
  return true;
}

function isFuture(str, clock) {
  const d = new Date(str);
  return d.getTime() > clock.getTime();
}

// ---- Evidence ref tightening ----
// Reject empty segments, . or .., repeated /, trailing /, query, fragment, userinfo
const EVIDENCE_REF_RE = /^restricted:\/\/FND0(2|3)\/[a-z0-9][a-z0-9._/-]{0,255}$/;

function validEvidenceRef(value) {
  if (typeof value !== 'string') return false;
  if (!EVIDENCE_REF_RE.test(value)) return false;
  // Extract the path portion after restricted://FND0X/
  const pathPart = value.replace(/^restricted:\/\/FND0[23]\//, '');
  // Reject double slashes, dot segments, trailing slash, query, fragment, userinfo
  if (/\/\//.test(pathPart)) return false;
  if (/(?:^|\/)\.(?:\.)?(?:\/|$)/.test(pathPart)) return false; // /. or /.. or ./ or ../
  if (/^\//.test(pathPart)) return false;
  if (/\/$/.test(pathPart)) return false;
  if (/[?#@]/.test(pathPart)) return false;
  return true;
}

// ---- Diagnostics: NEVER echo input values ----
const diagnostics = [];
function diag(cat, loc) { diagnostics.push(`DIAG [${cat}]: ${loc}`); }

// ====== RECURSIVE SCHEMA VALIDATOR (canonical) ======

/**
 * Validate value against a JSON Schema subset:
 *   type, required, additionalProperties (boolean only), enum, const, pattern,
 *   minItems, maxItems, minLength, maxLength, properties, items, if/then/else
 * Returns { valid: bool, errors: number }
 */
function validateSchema(value, schema, loc, clock, dlog) {
  const emit = dlog || diag;
  if (!schema || typeof schema !== 'object') return { valid: true, errors: 0 };

  let errors = 0;

  // type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let typeOk = false;
    for (const t of types) {
      if (t === 'string' && typeof value === 'string') typeOk = true;
      if (t === 'number' && typeof value === 'number') typeOk = true;
      if (t === 'integer' && Number.isInteger(value)) typeOk = true;
      if (t === 'boolean' && typeof value === 'boolean') typeOk = true;
      if (t === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) typeOk = true;
      if (t === 'array' && Array.isArray(value)) typeOk = true;
      if (t === 'null' && value === null) typeOk = true;
    }
    if (!typeOk) { emit('SCHEMA_ERROR', loc); errors++; return { valid: false, errors }; }
  }

  // string constraints
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) { emit('SCHEMA_ERROR', loc); errors++; }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) { emit('SCHEMA_ERROR', loc); errors++; }
    if (schema.pattern && typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) { emit('SCHEMA_ERROR', loc); errors++; }
      } catch { /* invalid regex in schema — ignore */ }
    }
    if (schema.enum && !schema.enum.includes(value)) { emit('SCHEMA_ERROR', loc); errors++; }
    if (schema.const !== undefined && value !== schema.const) { emit('SCHEMA_ERROR', loc); errors++; }
    // format: date-time → strict UTC check
    if (schema.format === 'date-time') {
      if (!isStrictUTC(value)) { emit('SCHEMA_ERROR', loc); errors++; }
      if (isFuture(value, clock)) { emit('SCHEMA_ERROR', loc); errors++; }
    }
  }

  // array constraints
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) { emit('SCHEMA_ERROR', loc); errors++; }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) { emit('SCHEMA_ERROR', loc); errors++; }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const r = validateSchema(value[i], schema.items, `${loc}[${i}]`, clock, dlog);
        errors += r.errors;
      }
    }
  }

  // object constraints
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // required
    if (schema.required) {
      for (const r of schema.required) {
        if (!(r in value)) {
          emit('SCHEMA_ERROR', loc);
          errors++;
        }
      }
    }
    // properties + additionalProperties
    if (schema.properties && typeof schema.properties === 'object') {
      const propNames = new Set(Object.keys(schema.properties));
      for (const [k, v] of Object.entries(value)) {
        if (propNames.has(k)) {
          const r = validateSchema(v, schema.properties[k], `${loc}.${k}`, clock, dlog);
          errors += r.errors;
        } else if (schema.additionalProperties === false) {
          emit('SCHEMA_ERROR', loc);
          errors++;
        }
      }
    }

    // if/then/else — use silent log for condition evaluation
    if (schema.if) {
      const silent = () => {};
      const condResult = validateSchema(value, schema.if, loc, clock, silent);
      if (condResult.valid && condResult.errors === 0) {
        if (schema.then) {
          // apply then: properties=false means field must not be present
          if (schema.then.required) {
            for (const r of schema.then.required) {
              if (!(r in value)) { emit('SCHEMA_ERROR', loc); errors++; }
            }
          }
          if (schema.then.properties) {
            for (const [k, v] of Object.entries(schema.then.properties)) {
              if (k in value && value[k] !== undefined && value[k] !== null) {
                if (v === false) {
                  emit('SCHEMA_ERROR', loc);
                  errors++;
                } else if (typeof v === 'object') {
                  const r = validateSchema(value[k], v, `${loc}.${k}`, clock, dlog);
                  errors += r.errors;
                }
              }
            }
          }
        }
      } else {
        if (schema.else) {
          if (schema.else.required) {
            for (const r of schema.else.required) {
              if (!(r in value)) { emit('SCHEMA_ERROR', loc); errors++; }
            }
          }
        }
      }
    }
  }

  return { valid: errors === 0, errors };
}

// ====== SECURITY SCANNERS ======

// All known schema field names (used to detect secret-like unknown field names)
const KNOWN_FIELDS = new Set([
  'schemaVersion', 'evidenceDate', 'owner', 'credentialGroups', 'artifactGroups',
  'role', 'groupId', 'provider', 'verification', 'status',
  'ownerRole', 'evidenceRef', 'rotationAction', 'oldCredentialRejectionMethod',
  'artifactType', 'manualReviewOutcome', 'dispositionStatus',
]);

function scanStringValue(value, loc) {
  if (typeof value !== 'string') return false;
  let found = false;
  // JWT
  if (JWT_PATTERN.test(value)) { diag('SECRET_VALUE', loc); found = true; }
  // Private key
  if (PRIVKEY_MARKER.test(value)) { diag('SECRET_VALUE', loc); found = true; }
  // Token prefixes
  if (TOKEN_PREFIXES.test(value)) { diag('SECRET_VALUE', loc); found = true; }
  // High-entropy b64
  if (BASE64_HI_ENTROPY.test(value) && value.length >= 40) { diag('SECRET_VALUE', loc); found = true; }
  // URL userinfo
  if (URL_USERINFO.test(value)) { diag('SECRET_VALUE', loc); found = true; }
  // URL query
  if (URL_QUERY.test(value)) { diag('SECRET_VALUE', loc); found = true; }
  // URL fragment
  if (URL_FRAGMENT.test(value)) { diag('SECRET_VALUE', loc); found = true; }
  // Paths
  if (ABS_PATH.test(value) || WIN_PATH.test(value) || UNC_PATH.test(value) || DOT_SLASH.test(value)) { diag('PATH_LEAK', loc); found = true; }
  if (PARENT_TRAVERSAL.test(value)) { diag('PATH_LEAK', loc); found = true; }
  // Email
  if (EMAIL_RE.test(value)) { diag('PII_VALUE', loc); found = true; }
  // Phone
  if (PHONE_RE1.test(value) || PHONE_RE2.test(value)) { diag('PII_VALUE', loc); found = true; }
  return found;
}

function scanObject(value, loc, clock) {
  if (typeof value !== 'object' || value === null) return false;
  let found = false;
  for (const [k, v] of Object.entries(value)) {
    const subLoc = loc ? `${loc}.${k}` : k;
    // Secret-like field name check (only for unknown fields)
    if (!KNOWN_FIELDS.has(k)) {
      if (/secret|private|key\b|token\b|password|passphrase|credential|account|project_id|api_key|jwt|pii|email|phone/i.test(k)) {
        diag('SECRET_VALUE', loc);
        found = true;
      }
    }
    if (typeof v === 'string') {
      if (scanStringValue(v, subLoc)) found = true;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if (scanObject(v, subLoc, clock)) found = true;
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'object' && v[i] !== null) {
          if (scanObject(v[i], `${subLoc}[${i}]`, clock)) found = true;
        } else if (typeof v[i] === 'string') {
          if (scanStringValue(v[i], `${subLoc}[${i}]`)) found = true;
        }
      }
    }
  }
  return found;
}

function scanPlaceholders(value, loc) {
  if (typeof value === 'string') {
    const l = value.toLowerCase();
    if (l.includes('placeholder') || l.includes('todo') || l.includes('replace me') || l.includes('change this')) {
      diag('PLACEHOLDER_CLAIM', loc);
      return true;
    }
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (scanPlaceholders(v, loc ? `${loc}.${k}` : k)) return true;
    }
  }
  return false;
}

// ====== MAIN VALIDATE ======

function validate(filePath, clock) {
  diagnostics.length = 0;
  const runtimeClock = clock || new Date();

  // 1. File stat
  let stats;
  try { stats = lstatSync(filePath); } catch {
    diag('FILE_ERROR', 'Cannot stat manifest'); return 1;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    diag('FILE_ERROR', 'Path is not a regular file'); return 1;
  }
  let realStats;
  try { realStats = statSync(filePath); } catch {
    diag('FILE_ERROR', 'Cannot read manifest'); return 1;
  }
  if (realStats.size > 65536) {
    diag('FILE_ERROR', 'Exceeds 65536 bytes'); return 1;
  }

  // 2. Parse JSON
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    diag('PARSE_ERROR', 'Malformed JSON'); return 1;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    diag('SCHEMA_ERROR', 'Root'); return 1;
  }

  // 3. Recursive schema validation (canonical)
  const schemaResult = validateSchema(data, SCHEMA, '', runtimeClock);
  if (!schemaResult.valid) return 1;

  // 4. schemaVersion must match canonical version
  if (data.schemaVersion !== SCHEMA_VERSION) {
    diag('SCHEMA_ERROR', 'schemaVersion'); return 1;
  }

  // 5. Security scan
  if (scanObject(data, '', runtimeClock)) return 1;
  if (scanPlaceholders(data, '')) return 1;

  // 6. Evidence ref validation for all evidenceRef fields
  if (!validateAllEvidenceRefs(data)) return 1;

  // 7. Duplicate detection
  if (findDupes(data.credentialGroups, 'credentialGroups')) return 1;
  if (findDupes(data.artifactGroups, 'artifactGroups')) return 1;

  // 8. Provider cardinality: exactly one per provider, correct mapping
  const credMap = new Map();
  for (let i = 0; i < data.credentialGroups.length; i++) {
    const g = data.credentialGroups[i];
    if (credMap.has(g.provider)) {
      diag('DUPLICATE_PROVIDER', `credentialGroups[${i}]`);
      return 1;
    }
    credMap.set(g.provider, g.groupId);
    // Validate canonical groupId→provider mapping
    const expectedProvider = CRED_GROUP_PROVIDER_MAP[g.groupId];
    if (expectedProvider !== undefined && expectedProvider !== g.provider) {
      diag('SCHEMA_ERROR', `credentialGroups[${i}]`);
      return 1;
    }
  }

  // 9. Artifact cardinality: all 7 required groups, each exactly once
  const artSet = new Set();
  for (let i = 0; i < data.artifactGroups.length; i++) {
    const g = data.artifactGroups[i];
    if (artSet.has(g.groupId)) {
      diag('DUPLICATE_ARTIFACT', `artifactGroups[${i}]`);
      return 1;
    }
    artSet.add(g.groupId);
    // Validate canonical groupId→artifactType mapping
    const expectedType = ART_GROUP_TYPE_MAP[g.groupId];
    if (expectedType !== undefined && expectedType !== g.artifactType) {
      diag('SCHEMA_ERROR', `artifactGroups[${i}]`);
      return 1;
    }
  }

  // Coverage
  const missingProviders = VALID_PROVIDERS.filter(p => !credMap.has(p));
  const missingArtifacts = VALID_ARTIFACT_IDS.filter(id => !artSet.has(id));
  if (missingProviders.length > 0) {
    diag('MISSING_PROVIDER', missingProviders.join(', '));
    return 2;
  }
  if (missingArtifacts.length > 0) {
    diag('MISSING_ARTIFACT_GROUP', missingArtifacts.join(', '));
    return 2;
  }

  // 10. Business: verified artifact combos
  for (let i = 0; i < data.artifactGroups.length; i++) {
    const g = data.artifactGroups[i];
    if (g.status === 'verified' && g.verification) {
      const v = g.verification;
      // Reject pending-review for verified
      if (v.dispositionStatus === 'pending-review') {
        diag('INVALID_OUTCOME', `artifactGroups[${i}]`);
        return 1;
      }
      // Allowed outcome+disposition pairs
      const combo = `${v.manualReviewOutcome}:${v.dispositionStatus}`;
      if (!ALLOWED_ARTIFACT_COMBOS.has(combo)) {
        diag('INVALID_OUTCOME', `artifactGroups[${i}]`);
        return 1;
      }
    }
  }

  // 11. Determine completeness
  let hasPending = false;
  for (const g of data.credentialGroups) {
    if (g.status === 'pending') { hasPending = true; break; }
  }
  if (!hasPending) {
    for (const g of data.artifactGroups) {
      if (g.status === 'pending') { hasPending = true; break; }
    }
  }

  if (hasPending) return 2;
  return 0;
}

// ---- Helpers ----

function validateAllEvidenceRefs(data) {
  let ok = true;
  for (let i = 0; i < data.credentialGroups.length; i++) {
    const g = data.credentialGroups[i];
    if (g.verification && g.verification.evidenceRef) {
      if (!validEvidenceRef(g.verification.evidenceRef)) {
        diag('INVALID_EVIDENCE_REF', `credentialGroups[${i}]`);
        ok = false;
      }
    }
  }
  for (let i = 0; i < data.artifactGroups.length; i++) {
    const g = data.artifactGroups[i];
    if (g.verification && g.verification.evidenceRef) {
      if (!validEvidenceRef(g.verification.evidenceRef)) {
        diag('INVALID_EVIDENCE_REF', `artifactGroups[${i}]`);
        ok = false;
      }
    }
  }
  return ok;
}

function findDupes(arr, loc) {
  if (!Array.isArray(arr)) return false;
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const g = arr[i];
    if (g && g.groupId) {
      if (seen.has(g.groupId)) { diag('DUPLICATE_ID', `${loc}[${i}]`); return true; }
      seen.add(g.groupId);
    }
  }
  return false;
}

// ---- Exports ----
export { validate };

// ---- CLI ----
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const pathArg = process.argv[2];
  if (!pathArg) {
    process.stderr.write('DIAG [CLI_ERROR]: Usage: node check-phase0-evidence.mjs <manifest-path>\n');
    process.exit(1);
  }
  const code = validate(resolve(pathArg));
  for (const d of diagnostics) process.stderr.write(d + '\n');
  process.exit(code);
}
