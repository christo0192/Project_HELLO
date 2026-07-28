#!/usr/bin/env node

/**
 * SEC-07 CSP smoke test.
 *
 * Starts the built Vite preview server with synthetic process env vars,
 * asserts the report-only CSP header is present on HTML documents,
 * asserts no unsafe directives are present, and asserts the header is
 * absent on a static JS asset. Then exits cleanly.
 *
 * No heavy browser dependency — pure Node.js HTTP.
 *
 * Usage: node scripts/smoke-test-csp.mjs
 * Prerequisite: web app must already be built (npm run build in app/web).
 */

import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { resolve } from 'node:path';

// ── Synthetic env for CSP smoke test ──────────────────────────────────

const SYNTHETIC_ENV = {
  ...process.env,
  VITE_API_BASE: 'http://localhost:8787',
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_LIVEKIT_URL: 'wss://meet.example.com',
  VITE_CSP_MODE: 'report-only',
  VITE_CSP_REPORT_ENDPOINT: 'http://localhost:8787/api/csp-report',
};

// ── Helpers ──────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    get(url, { headers: { Accept: 'text/html' } }, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }).on('error', reject);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const previewPort = 15173; // non-standard to avoid conflicts

  console.log('[smoke] Starting vite preview on port', previewPort, '...');

  const proc = spawn(
    process.execPath,
    [
      resolve(process.cwd(), 'app/web/node_modules/.bin/vite'),
      'preview',
      '--port', String(previewPort),
      '--strictPort',
    ],
    {
      cwd: resolve(process.cwd(), 'app/web'),
      env: SYNTHETIC_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Collect stderr for debugging.
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for the preview server to be ready (up to 30 s).
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(`http://localhost:${previewPort}/`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    assert(ready, `Vite preview did not start on port ${previewPort}. stderr:\n${stderr.slice(-500)}`);
    console.log('[smoke] Vite preview is up.');

    // ── Test 1: CSP Report-Only header present, no enforcing header ──

    const htmlRes = await httpGet(`http://localhost:${previewPort}/`);
    assert(htmlRes.status === 200, `HTML page returned ${htmlRes.status}`);

    const reportOnly = htmlRes.headers['content-security-policy-report-only'];
    assert(reportOnly, 'Content-Security-Policy-Report-Only header missing on HTML');
    assert(
      !htmlRes.headers['content-security-policy'],
      'Content-Security-Policy (enforcing) header must be absent in report-only mode',
    );
    console.log('[smoke] ✓ Content-Security-Policy-Report-Only present on HTML, enforcing absent.');

    const cspHeader = reportOnly;

    // ── Test 2: No unsafe directives ────────────────────────────────

    assert(!cspHeader.includes('unsafe-inline'), 'CSP contains unsafe-inline');
    assert(!cspHeader.includes('unsafe-eval'), 'CSP contains unsafe-eval');
    assert(!cspHeader.includes("'unsafe-inline'"), "CSP contains 'unsafe-inline'");
    assert(!cspHeader.includes("'unsafe-eval'"), "CSP contains 'unsafe-eval'");
    assert(!cspHeader.includes('strict-dynamic'), 'CSP contains strict-dynamic');
    console.log('[smoke] ✓ No unsafe directives.');

    // ── Test 3: Required origins and directives present ─────────────

    assert(cspHeader.includes('self'), "CSP missing 'self'");
    assert(cspHeader.includes('project.supabase.co'), 'CSP missing Supabase origin');
    assert(cspHeader.includes('localhost:8787'), 'CSP missing API origin');
    assert(cspHeader.includes('meet.example.com'), 'CSP missing LiveKit origin');
    assert(cspHeader.includes('report-uri'), 'CSP missing report-uri directive');
    assert(cspHeader.includes("object-src 'none'"), "CSP missing object-src 'none'");
    console.log('[smoke] ✓ All required origins and directives present.');

    // ── Test 4: CSP header absent on static JS asset ────────────────

    // First get HTML to find an asset path.
    const assetMatch = htmlRes.body.match(/src="([^"]+\.js)"/);
    if (assetMatch) {
      const assetPath = assetMatch[1];
      const assetUrl = assetPath.startsWith('http')
        ? assetPath
        : `http://localhost:${previewPort}${assetPath}`;
      const assetRes = await httpGet(assetUrl);
      const assetCsp =
        assetRes.headers['content-security-policy-report-only'] ||
        assetRes.headers['content-security-policy'];
      assert(!assetCsp, `CSP header should be absent on assets, got: ${assetCsp}`);
      console.log('[smoke] ✓ CSP header absent on JS asset.');
    } else {
      throw new Error('FAIL: No JS asset found in built HTML. Cannot verify CSP absence on assets.');
    }

    console.log('[smoke] All smoke assertions passed.');
    process.exitCode = 0;
  } finally {
    proc.kill('SIGTERM');
    // Give it a moment to shut down.
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err.message);
  process.exit(1);
});
