#!/usr/bin/env node

/**
 * generate-demo-artifacts.mjs
 *
 * Deterministic generator for synthetic demo artifacts under docs/demo/.
 * Each run produces byte-for-byte identical output.
 *
 * Usage:
 *   node scripts/generate-demo-artifacts.mjs                    # Generate all groups
 *   node scripts/generate-demo-artifacts.mjs --group hello-html # Single group
 *   node scripts/generate-demo-artifacts.mjs --verify           # Verify checksums
 *
 * Groups: hello-html, hello-md, hello-assets, generated-pdf,
 *         voice-recording, scorecard-export, env-example-values
 *
 * ZERO DEPENDENCIES — only uses Node.js built-in modules.
 * NO external network calls, NO credential access, NO PII.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const DEMO_DIR = resolve(import.meta.dirname, '..', 'docs', 'demo');
const TIMESTAMP = '2025-06-15T10:00:00Z';

// Manifest path for --verify
const MANIFEST_PATH = join(DEMO_DIR, 'manifest.json');

function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function generateHelloHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Synthetic Demo — HELLO Screening Bot</title>
</head>
<body>
<h1>Synthetic Demo — HELLO Screening Bot</h1>
<p class="badge">is_synthetic</p>
<p class="meta">ID: demo-html-v1-${TIMESTAMP.slice(0, 10)}</p>
<p>Safe synthetic replacement. No real candidate data.</p>
<p class="demo">Contact: demo.alpha@example.invalid</p>
<p class="type">static</p>
</body>
</html>`;
}

function generateHelloMD() {
  return `# Synthetic Demo — HELLO Screening Bot

> **is_synthetic** — ID: demo-md-v1-${TIMESTAMP.slice(0, 10)}
> Generated: ${TIMESTAMP}

Safe synthetic replacement. No real candidate data.

Contact: demo.alpha@example.invalid
`;
}

function generateHelloAssets() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: `demo-assets-v1-${TIMESTAMP.slice(0, 10)}`,
    generated_at: TIMESTAMP,
    description: 'Synthetic resume copy replacement',
    personas: [
      { candidate_id: 'DEMO-001', email: 'demo.alpha@example.invalid', phone: null },
      { candidate_id: 'DEMO-002', email: 'demo.beta@example.invalid', phone: null },
      { candidate_id: 'DEMO-003', email: 'demo.gamma@example.invalid', phone: null },
    ],
  }, null, 2) + '\n';
}

function generateScorecardJSON() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: `demo-scorecard-v1-${TIMESTAMP.slice(0, 10)}`,
    generated_at: TIMESTAMP,
    group: 'scorecard-export',
    description: 'Synthetic scorecard export for demo. Contact: demo.alpha@example.invalid',
    scorecards: [
      {
        candidate_id: 'DEMO-001',
        overall_score: 82,
        evaluated_at: '2026-01-15T14:30:00Z',
      },
      {
        candidate_id: 'DEMO-002',
        overall_score: 88,
        evaluated_at: '2026-01-15T15:00:00Z',
      },
    ],
  }, null, 2) + '\n';
}

function generateGeneratedPDFJSON() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: `demo-pdf-v1-${TIMESTAMP.slice(0, 10)}`,
    generated_at: TIMESTAMP,
    group: 'generated-pdf',
    scorecards: [
      {
        candidate_id: 'DEMO-001',
        candidate_email: 'demo.alpha@example.invalid',
        overall_score: 82,
      },
      {
        candidate_id: 'DEMO-002',
        candidate_email: 'demo.beta@example.invalid',
        overall_score: 88,
      },
    ],
  }, null, 2) + '\n';
}

function generateVoiceToneInfo() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: `demo-voice-v1-${TIMESTAMP.slice(0, 10)}`,
    generated_at: TIMESTAMP,
    group: 'voice-recording',
    replacement_type: 'generated-non-speech-tone',
    specification: {
      frequency_hz: 440,
      duration_seconds: 3.0,
      sample_rate_hz: 22050,
      channels: 1,
      encoding: 'PCM 16-bit signed LE',
      notes: 'Non-speech synthetic tone. No human voice or biometric data.',
    },
  }, null, 2) + '\n';
}

function generateEnvExampleJSON() {
  return JSON.stringify({
    is_synthetic: true,
    synthetic_id: `demo-env-v1-${TIMESTAMP.slice(0, 10)}`,
    generated_at: TIMESTAMP,
    group: 'env-example-values',
    variables: [
      { name: 'SUPABASE_URL', example: 'https://placeholder-project-id.example.com' },
      { name: 'SUPABASE_SERVICE_KEY', example: 'placeholder-service-role-key' },
      { name: 'ANTHROPIC_API_KEY', example: 'placeholder-anthropic-key' },
      { name: 'NODE_ENV', example: 'development' },
    ],
  }, null, 2) + '\n';
}

const GENERATORS = {
  'hello-html': { path: 'hello.html', generate: generateHelloHTML },
  'hello-md': { path: 'hello.md', generate: generateHelloMD },
  'hello-assets': { path: 'hello-assets/manifest.json', generate: generateHelloAssets },
  'generated-pdf': { path: 'generated-pdf/generated-pdf-synthetic.json', generate: generateGeneratedPDFJSON },
  'voice-recording': { path: 'voice-recording/voice-tone-info.json', generate: generateVoiceToneInfo },
  'scorecard-export': { path: 'scorecard-export/scorecard-export-synthetic.json', generate: generateScorecardJSON },
  'env-example-values': { path: 'env-example-values/env-example-synthetic.json', generate: generateEnvExampleJSON },
};

function generate(groupId) {
  const config = GENERATORS[groupId];
  if (!config) {
    process.stderr.write(`DIAG [UNKNOWN_GROUP]: Unknown group '${groupId}'. Valid: ${Object.keys(GENERATORS).join(', ')}\n`);
    return false;
  }

  const fullPath = join(DEMO_DIR, config.path);
  const dir = resolve(fullPath, '..');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = config.generate();
  writeFileSync(fullPath, content, 'utf-8');

  const hash = sha256(content);
  process.stdout.write(`GENERATED ${config.path}  (sha256: ${hash})\n`);
  return true;
}

function verify() {
  let allOk = true;

  // Load manifest
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    process.stderr.write('ERROR: Could not load manifest at ' + MANIFEST_PATH + '\n');
    return false;
  }

  if (!manifest.checksums || typeof manifest.checksums !== 'object') {
    process.stderr.write('ERROR: Manifest has no checksums object\n');
    return false;
  }

  for (const [groupId, config] of Object.entries(GENERATORS)) {
    const relPath = config.path;
    const fullPath = join(DEMO_DIR, relPath);
    let content;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      process.stderr.write(`  ${relPath}: MISSING\n`);
      allOk = false;
      continue;
    }

    const actual = sha256(content);
    const expected = manifest.checksums[relPath];

    if (!expected) {
      process.stderr.write(`  ${relPath}: ${actual} (NOT IN MANIFEST)\n`);
      allOk = false;
    } else if (actual !== expected) {
      process.stderr.write(`  ${relPath}: CHECKSUM MISMATCH (expected ${expected}, got ${actual})\n`);
      allOk = false;
    } else {
      process.stdout.write(`  ${relPath}: ${actual} OK\n`);
    }
  }

  return allOk;
}

// ---- CLI ----
const args = process.argv.slice(2);

if (args.includes('--verify')) {
  process.exit(verify() ? 0 : 1);
}

const groupArg = args.find(a => a.startsWith('--group='));
const group = groupArg ? groupArg.split('=')[1] : null;

if (group) {
  process.exit(generate(group) ? 0 : 1);
}

// Generate all
let allOk = true;
for (const gid of Object.keys(GENERATORS)) {
  if (!generate(gid)) { allOk = false; }
}
process.exit(allOk ? 0 : 1);
