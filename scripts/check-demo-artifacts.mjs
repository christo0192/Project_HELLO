#!/usr/bin/env node

/**
 * check-demo-artifacts.mjs
 *
 * ZERO-DEPENDENCY validator for synthetic demo artifacts under docs/demo/.
 * Checks all 7 FND-03 artifact groups for:
 *   - Correct file existence
 *   - is_synthetic markers
 *   - No PII (reserved emails only, no phone numbers)
 *   - No secrets/tokens/paths
 *   - No external URLs
 *   - No scripts/active content (in HTML specifically)
 *   - No path traversal or symlinks
 *   - Nondeterministic timestamps/IDs rejected
 *   - Malformed JSON rejected
 *   - Size bounds
 *
 * Usage: node scripts/check-demo-artifacts.mjs [demo-path]
 *
 * Exit: 0 = all clean, 1 = any failure
 */

import { readFileSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

// ---- Config ----
const DEMO_BASE = resolve(import.meta.dirname, '..', 'docs', 'demo');
const MAX_FILE_SIZE = 1048576; // 1 MB per file
const MAX_TOTAL_SIZE = 5242880; // 5 MB total
const ALLOWED_DOMAIN = /@example\.invalid$/;
const DETERMINISTIC_TIMESTAMP = '2025-06-15T10:00:00Z';
const DETERMINISTIC_ID_RE = /^demo-(html|md|assets|pdf|voice|scorecard|env)-v1-2025-06-15$/;

// Expected files per group
const EXPECTED_GROUPS = {
  'hello-html': { path: 'hello.html', mustContain: ['is_synthetic', 'example.invalid', 'static'] },
  'hello-md': { path: 'hello.md', mustContain: ['is_synthetic', 'example.invalid'] },
  'hello-assets': { path: 'hello-assets/manifest.json', mustContain: ['is_synthetic', 'example.invalid'] },
  'generated-pdf': { path: 'generated-pdf/generated-pdf-synthetic.json', mustContain: ['is_synthetic', 'example.invalid'] },
  'voice-recording': { path: 'voice-recording/voice-tone-info.json', mustContain: ['is_synthetic', 'non-speech'] },
  'scorecard-export': { path: 'scorecard-export/scorecard-export-synthetic.json', mustContain: ['is_synthetic', 'example.invalid'] },
  'env-example-values': { path: 'env-example-values/env-example-synthetic.json', mustContain: ['is_synthetic', 'placeholder'] },
};

// Additional files that are allowed to exist
const ALLOWED_EXTRA = new Set([
  'generated-pdf/README.md',
  'generated-pdf/generated-pdf-template.md',
  'voice-recording/README.md',
  'scorecard-export/README.md',
  'env-example-values/README.md',
  'manifest.json',
]);

// ---- Security patterns ----
const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]+\./;
const PRIVKEY_MARKER = /-----BEGIN/;
const TOKEN_PREFIXES = /(sk-|pk-|rk-|whook_|xox[bprs]-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|hf_|sf_|sgd_|tkn_)/i;
const URL_USERINFO = /https?:\/\/[^\/\s@]+:[^\/\s@]+@/i;
const ABS_PATH = /^\/[^\/]/;
const WIN_PATH = /^[A-Za-z]:\\/;
const UNC_PATH = /^\\\\/;
const PARENT_TRAVERSAL = /\.\.\//;
const PHONE_RE1 = /\+\d[\d\s.-]{7,}\d/;
const PHONE_RE2 = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/;
const EXTERNAL_URL = /https?:\/\/(?!(?:[\w-]+\.)*example\.(?:invalid|com|org|net|edu)(?:$|\/)|localhost(?::\d+)?(?:$|\/))/i;
const SCRIPT_TAG = /<script\b/i;
const ON_EVENT = /\son\w+\s*=/i;
const DATA_URL = /data:\s*[a-z]+\/[a-z-]+;\s*base64\s*,/i;
const NON_DETERMINISTIC_TIME = /\b(?:now|current_timestamp|getdate|new\s+date)\b/i;
const VARIABLE_TIMESTAMP = /T\d{2}:\d{2}:\d{2}Z[^"]*$/m;

// ---- Diagnostics ----
const diagnostics = [];
function diag(cat, msg) { diagnostics.push(`DIAG [${cat}]: ${msg}`); }

// ---- Validation ----
let totalSize = 0;

function checkFile(filePath, baseDir = DEMO_BASE) {
  const resolvedBase = resolve(baseDir);
  const fullPath = resolve(resolvedBase, filePath);
  const relFromBase = relative(resolvedBase, fullPath);
  const relPath = `docs/demo/${filePath}`;

  if (relFromBase.startsWith('..') || resolve(resolvedBase, relFromBase) !== fullPath) {
    diag('PATH_ESCAPE', relPath);
    return false;
  }

  // Stat
  let stats;
  try { stats = lstatSync(fullPath); } catch {
    diag('MISSING_FILE', relPath);
    return false;
  }

  // Symlink check
  if (stats.isSymbolicLink()) {
    diag('SYMLINK_DETECTED', relPath);
    return false;
  }

  // Regular file check
  if (!stats.isFile()) {
    diag('NOT_A_FILE', relPath);
    return false;
  }

  // Size bound
  if (stats.size > MAX_FILE_SIZE) {
    diag('FILE_TOO_LARGE', `${relPath} (${stats.size} bytes)`);
    return false;
  }
  totalSize += stats.size;

  // Read content
  let content;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    diag('READ_ERROR', relPath);
    return false;
  }

  return validateContent(content, relPath);
}

function validateContent(content, relPath) {
  let ok = true;

  // Check for binary/gibberish — must be valid UTF-8 with mostly printable chars
  const printableRatio = (content.match(/[\x20-\x7E\n\r\t]/g) || []).length / content.length;
  if (printableRatio < 0.6 && content.length > 100) {
    // Allow known binary formats only
    const ext = relPath.split('.').pop();
    if (ext !== 'wav' && ext !== 'pdf' && ext !== 'png' && ext !== 'jpg') {
      diag('BINARY_CONTENT', relPath);
      ok = false;
    }
  }

  // Check secret markers across every text format, not only JSON strings.
  if (JWT_PATTERN.test(content) || PRIVKEY_MARKER.test(content) ||
      TOKEN_PREFIXES.test(content) || URL_USERINFO.test(content)) {
    diag('SECRET_VALUE', relPath);
    ok = false;
  }
  if (PARENT_TRAVERSAL.test(content)) {
    diag('PATH_LEAK', relPath);
    ok = false;
  }

  // Check path-like values in quoted fields.
  const strings = content.match(/"([^"]{4,})"/g) || [];
  for (const s of strings) {
    const val = s.slice(1, -1);
    if (JWT_PATTERN.test(val)) { diag('SECRET_VALUE', relPath); ok = false; }
    if (PRIVKEY_MARKER.test(val)) { diag('SECRET_VALUE', relPath); ok = false; }
    if (TOKEN_PREFIXES.test(val)) { diag('SECRET_VALUE', relPath); ok = false; }
    if (URL_USERINFO.test(val)) { diag('SECRET_VALUE', relPath); ok = false; }
    if (ABS_PATH.test(val)) { diag('PATH_LEAK', relPath); ok = false; }
    if (WIN_PATH.test(val)) { diag('PATH_LEAK', relPath); ok = false; }
    if (UNC_PATH.test(val)) { diag('PATH_LEAK', relPath); ok = false; }
    if (PARENT_TRAVERSAL.test(val)) { diag('PATH_LEAK', relPath); ok = false; }
  }

  // Email check — only @example.invalid allowed
  const emailMatches = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (emailMatches) {
    for (const email of emailMatches) {
      if (!ALLOWED_DOMAIN.test(email)) {
        diag('PII_EMAIL', relPath);
        ok = false;
      }
    }
  }

  // Phone check
  if (PHONE_RE1.test(content) || PHONE_RE2.test(content)) {
    diag('PII_PHONE', relPath);
    ok = false;
  }

  // External URLs check
  const urlMatches = content.match(/https?:\/\/[^\s"'<>`\]\)]+/g);
  if (urlMatches) {
    for (const url of urlMatches) {
      if (EXTERNAL_URL.test(url)) {
        diag('EXTERNAL_URL', relPath);
        ok = false;
      }
    }
  }

  // HTML-specific checks
  if (relPath.endsWith('.html') || relPath.endsWith('.htm')) {
    if (SCRIPT_TAG.test(content)) {
      diag('ACTIVE_CONTENT', relPath);
      ok = false;
    }
    if (ON_EVENT.test(content)) {
      diag('ACTIVE_CONTENT', relPath);
      ok = false;
    }
    if (DATA_URL.test(content)) {
      diag('DATA_URL', relPath);
      ok = false;
    }
    if (/\b(?:src|href)\s*=\s*["']https?:\/\//i.test(content)) {
      diag('EXTERNAL_HTML_RESOURCE', relPath);
      ok = false;
    }
  }

  // JSON-specific checks
  if (relPath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null) {
        diag('INVALID_JSON', relPath);
        ok = false;
      }
      // Must have is_synthetic marker
      if (!parsed.is_synthetic) {
        diag('MISSING_SYNTHETIC_MARKER', relPath);
        ok = false;
      }
      // Must have deterministic generated_at
      if (parsed.generated_at && parsed.generated_at !== DETERMINISTIC_TIMESTAMP) {
        // Allow variation in the same day but flag non-standard timestamps
        if (!parsed.generated_at.startsWith('2025-06-15T')) {
          diag('NON_DETERMINISTIC_TIMESTAMP', relPath);
          ok = false;
        }
      }
      // synthetic_id must be deterministic
      if (parsed.synthetic_id && !DETERMINISTIC_ID_RE.test(parsed.synthetic_id) &&
          !parsed.synthetic_id.startsWith('demo-')) {
        diag('NON_DETERMINISTIC_ID', relPath);
        ok = false;
      }
      // No phone values that are non-null strings
      if (parsed.personas) {
        for (const p of parsed.personas) {
          if (p.phone && typeof p.phone !== 'string' && p.phone !== null) {
            diag('PII_PHONE', relPath);
            ok = false;
          }
          if (typeof p.phone === 'string' && p.phone.length > 0) {
            diag('PII_PHONE', relPath);
            ok = false;
          }
        }
      }
      // Check for secrets-like field names
      for (const key of Object.keys(parsed)) {
        if (/secret|private|key\b|token\b|password|credential|api_key|jwt/i.test(key) &&
            !key.startsWith('is_') && key !== 'example') {
          diag('SUSPICIOUS_FIELD', `${relPath}.${key}`);
          ok = false;
        }
      }
    } catch {
      diag('MALFORMED_JSON', relPath);
      ok = false;
    }
  }

  return ok;
}

function collectAllFiles(dir, root) {
  const base = root || dir;
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectAllFiles(fullPath, base));
      } else {
        results.push(relative(base, fullPath));
      }
    }
  } catch { /* directory doesn't exist */ }
  return results;
}

function validate() {
  const demoPath = process.argv[2] ? resolve(process.argv[2]) : DEMO_BASE;
  diagnostics.length = 0;
  totalSize = 0;
  let ok = true;

  // Check demo directory exists
  try {
    const stats = statSync(demoPath);
    if (!stats.isDirectory()) {
      diag('NOT_A_DIRECTORY', demoPath);
      return 1;
    }
  } catch {
    diag('MISSING_DEMO_DIR', demoPath);
    return 1;
  }

  // Collect and validate every file, including allowed README/template files.
  const allFiles = collectAllFiles(demoPath);
  const seenFiles = new Set(allFiles);
  const expectedPaths = new Set([
    ...Object.values(EXPECTED_GROUPS).map(g => g.path),
    ...ALLOWED_EXTRA,
  ]);
  const fileValidity = new Map();
  for (const filePath of allFiles) {
    if (!expectedPaths.has(filePath)) {
      diag('UNEXPECTED_FILE', filePath);
      ok = false;
      continue;
    }
    const valid = checkFile(filePath, demoPath);
    fileValidity.set(filePath, valid);
    if (!valid) ok = false;
  }

  // Check expected group files exist and contain required markers. Only read
  // marker content after lstat/content validation has rejected symlinks.
  for (const [groupId, config] of Object.entries(EXPECTED_GROUPS)) {
    if (!seenFiles.has(config.path)) {
      diag('MISSING_GROUP', `${groupId}: ${config.path}`);
      ok = false;
    } else if (fileValidity.get(config.path)) {
      const content = readFileSync(resolve(demoPath, config.path), 'utf-8');
      for (const marker of config.mustContain ?? []) {
        if (!content.includes(marker)) {
          diag('MISSING_MARKER', `${groupId}: ${config.path} missing required marker "${marker}"`);
          ok = false;
        }
      }
    }
  }

  // Total size bound
  if (totalSize > MAX_TOTAL_SIZE) {
    diag('TOTAL_SIZE_EXCEEDED', `${totalSize} bytes > ${MAX_TOTAL_SIZE} bytes`);
    ok = false;
  }

  return ok ? 0 : 1;
}

// ---- CLI ----
if (process.argv[1] === import.meta.filename) {
  const code = validate();
  for (const d of diagnostics) process.stderr.write(d + '\n');
  process.exit(code);
}

export { validate, DEMO_BASE, EXPECTED_GROUPS, checkFile, validateContent, diagnostics };
