#!/usr/bin/env node

/**
 * SEC-07 CSP smoke test.
 *
 * Starts the built Vite preview server with synthetic process env vars,
 * asserts the report-only CSP header is present on HTML documents,
 * asserts no unsafe directives are present, and asserts the header is
 * absent on a static JS asset. Then exits cleanly.
 *
 * R1-REC: runs the same preview three times for the OPTIONAL
 * VITE_R1_RECORDINGS_ORIGIN (the R1 recordings store, media-src only):
 *   1. without it    -> the policy has no recordings origin at all;
 *   2. with it       -> it is in media-src, in no other directive, and nothing
 *                       else about the header changed;
 *   3. with a bad one -> the preview server refuses to start (fail closed)
 *                       instead of quietly widening or dropping the policy.
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

const BASE_ENV = {
  ...process.env,
  VITE_API_BASE: 'http://localhost:8787',
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_LIVEKIT_URL: 'wss://meet.example.com',
  VITE_CSP_MODE: 'report-only',
  VITE_CSP_REPORT_ENDPOINT: 'http://localhost:8787/api/csp-report',
};
// A variable left in the caller's shell must not decide the "without" pass.
delete BASE_ENV.VITE_R1_RECORDINGS_ORIGIN;

const R2_ORIGIN = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const PREVIEW_PORT = 15173; // non-standard to avoid conflicts

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

function startPreview(extraEnv) {
  const proc = spawn(
    process.execPath,
    [
      // The package's own entry, not `.bin/vite`: that is a symlink on Linux but a shell shim on
      // Windows, which `node` cannot run.
      resolve(process.cwd(), 'app/web/node_modules/vite/bin/vite.js'),
      'preview',
      '--port', String(PREVIEW_PORT),
      '--strictPort',
    ],
    {
      cwd: resolve(process.cwd(), 'app/web'),
      env: { ...BASE_ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const state = { proc, stderr: '', exited: null };
  proc.stderr.on('data', (d) => { state.stderr += d.toString(); });
  proc.stdout.on('data', (d) => { state.stderr += d.toString(); });
  proc.on('exit', (code) => { state.exited = code ?? 1; });
  return state;
}

async function stopPreview(state) {
  if (state.exited === null) state.proc.kill('SIGTERM');
  // Give it a moment to shut down (and free the port for the next pass).
  const until = Date.now() + 5_000;
  while (state.exited === null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
}

/** Wait for the preview server to be ready (up to 30 s); false if it exited first. */
async function waitReady(state) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && state.exited === null) {
    try {
      const res = await httpGet(`http://localhost:${PREVIEW_PORT}/`);
      if (res.status === 200) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const directive = (header, name) =>
  header.split(';').map((s) => s.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

// ── Pass 1: the full SEC-07 smoke, without the recordings origin ─────

async function passWithout() {
  console.log('[smoke] Starting vite preview on port', PREVIEW_PORT, '...');
  const state = startPreview({});
  try {
    assert(
      await waitReady(state),
      `Vite preview did not start on port ${PREVIEW_PORT}. stderr:\n${state.stderr.slice(-500)}`,
    );
    console.log('[smoke] Vite preview is up.');

    // ── Test 1: CSP Report-Only header present, no enforcing header ──

    const htmlRes = await httpGet(`http://localhost:${PREVIEW_PORT}/`);
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
        : `http://localhost:${PREVIEW_PORT}${assetPath}`;
      const assetRes = await httpGet(assetUrl);
      const assetCsp =
        assetRes.headers['content-security-policy-report-only'] ||
        assetRes.headers['content-security-policy'];
      assert(!assetCsp, `CSP header should be absent on assets, got: ${assetCsp}`);
      console.log('[smoke] ✓ CSP header absent on JS asset.');
    } else {
      throw new Error('FAIL: No JS asset found in built HTML. Cannot verify CSP absence on assets.');
    }

    // ── Test 5 (R1-REC): no recordings origin without the variable ──

    assert(!cspHeader.includes('r2.cloudflarestorage.com'), 'CSP has a recordings origin without VITE_R1_RECORDINGS_ORIGIN');
    assert(
      directive(cspHeader, 'media-src') === "media-src 'self' blob: https://project.supabase.co",
      `media-src changed without VITE_R1_RECORDINGS_ORIGIN: ${directive(cspHeader, 'media-src')}`,
    );
    console.log('[smoke] ✓ Without VITE_R1_RECORDINGS_ORIGIN the policy has no recordings origin.');

    return cspHeader;
  } finally {
    await stopPreview(state);
  }
}

// ── Pass 2: with the recordings origin ───────────────────────────────

async function passWith(baseline) {
  const state = startPreview({ VITE_R1_RECORDINGS_ORIGIN: R2_ORIGIN });
  try {
    assert(
      await waitReady(state),
      `Vite preview (with VITE_R1_RECORDINGS_ORIGIN) did not start. stderr:\n${state.stderr.slice(-500)}`,
    );
    const res = await httpGet(`http://localhost:${PREVIEW_PORT}/`);
    const header = res.headers['content-security-policy-report-only'];
    assert(header, 'Content-Security-Policy-Report-Only header missing with VITE_R1_RECORDINGS_ORIGIN');

    assert(
      directive(header, 'media-src') === `media-src 'self' blob: https://project.supabase.co ${R2_ORIGIN}`,
      `media-src should carry the recordings origin, got: ${directive(header, 'media-src')}`,
    );
    for (const d of header.split(';').map((s) => s.trim())) {
      if (d.startsWith('media-src ')) continue;
      assert(!d.includes('r2.cloudflarestorage.com'), `the recordings origin leaked into: ${d}`);
    }
    const without = (h) => h.split('; ').filter((d) => !d.startsWith('media-src ')).join('; ');
    assert(without(header) === without(baseline), 'the rest of the policy changed when the recordings origin was set');
    assert(!header.includes('unsafe-inline') && !header.includes('unsafe-eval'), 'CSP gained an unsafe directive');
    console.log('[smoke] ✓ With VITE_R1_RECORDINGS_ORIGIN it is in media-src and nowhere else.');
  } finally {
    await stopPreview(state);
  }
}

// ── Pass 3: a bad recordings origin stops the server ─────────────────

async function passBad() {
  for (const bad of ['http://account.r2.cloudflarestorage.com', 'https://*.r2.cloudflarestorage.com']) {
    const state = startPreview({ VITE_R1_RECORDINGS_ORIGIN: bad });
    try {
      const deadline = Date.now() + 30_000;
      while (state.exited === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert(state.exited !== null, `preview should refuse to start with VITE_R1_RECORDINGS_ORIGIN=${bad}`);
      assert(state.exited !== 0, `preview exited 0 with VITE_R1_RECORDINGS_ORIGIN=${bad}`);
      assert(
        state.stderr.includes('VITE_R1_RECORDINGS_ORIGIN'),
        `the failure should name VITE_R1_RECORDINGS_ORIGIN, stderr:\n${state.stderr.slice(-500)}`,
      );
    } finally {
      await stopPreview(state);
    }
  }
  console.log('[smoke] ✓ A bad VITE_R1_RECORDINGS_ORIGIN stops the preview server (fail closed).');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const baseline = await passWithout();
  await passWith(baseline);
  await passBad();
  console.log('[smoke] All smoke assertions passed.');
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err.message);
  process.exit(1);
});
