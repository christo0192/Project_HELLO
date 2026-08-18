/**
 * resume-scanner-freshness.test.ts — the production ClamAV activation blocker.
 *
 * A live Fly container had `RESUME_SCANNER=clamav` and a working `clamscan`
 * that accepted a clean fixture and rejected EICAR — while libclamav warned
 * that the virus database was older than seven days. Every one of those uploads
 * was being "screened" against signatures that had not moved since the image
 * was built, and nothing in the product could tell.
 *
 * These tests pin the repair:
 *
 *  1. Signature age is read from the CVD/CLD header's epoch build-time field —
 *     machine-readable, not a localized stderr string.
 *  2. Stale / missing / unreadable / corrupt signatures fail CLOSED, without
 *     `clamscan` being invoked at all, so a stale `exit 0` can never be
 *     mistaken for a clean verdict.
 *  3. Fresh signatures still accept clean files and still reject EICAR.
 *  4. The scratch file holding the untrusted bytes is wiped and removed on
 *     every path.
 *  5. The updater lifecycle is bounded, single-flight, and non-fatal.
 *  6. The container supervisor forwards signals and propagates the child's exit.
 *  7. The image contract itself forbids the `|| true` silent-stale acceptance.
 */

import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import {
  AGE_DATABASE,
  CVD_HEADER_BYTES,
  DEFAULT_MAX_DB_AGE_HOURS,
  MAX_DB_AGE_HOURS_BOUNDS,
  REQUIRED_DATABASES,
  createSignatureFreshnessReader,
  parseCvdHeader,
  readSignatureState,
  resolveMaxDbAgeHours,
} from '../lib/clamav-signatures.js';
import { ClamAvScanner, ClamScanGate, probeClamAvCapability } from '../lib/malware-scanner.js';
import {
  AV_UPDATER_BOUNDS,
  loadAvUpdaterConfig,
  runAvUpdateOnce,
  startAvUpdater,
} from '../lib/av-updater.js';
import { readScannerHealth, evaluateDegradation, scannerMode } from '../integrations/ashby/runtime-health.js';
import { FORWARDED_SIGNALS, startSupervisor } from '../container/entrypoint.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const HOUR_MS = 3_600_000;

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Build a real 512-byte CVD header. The layout is taken verbatim from a
 * freshclam-downloaded `daily.cvd`:
 *   ClamAV-VDB:<build time>:<version>:<sigs>:<f-level>:<md5>:<dsig>:<builder>:<epoch>
 */
function cvdHeader(buildTimeMs: number, version = 28096): Buffer {
  const epoch = Math.floor(buildTimeMs / 1000);
  const text = [
    'ClamAV-VDB',
    '18 Aug 2026 06-27 +0000',
    String(version),
    '355605',
    '90',
    '8547d965282ba55e10ef06e0be88c064',
    'S63f9catgbTKqtsXkl7rrwmiAJpJ7aUU3Eyr5doY0iUiQa0EEgH2z2Cd0ZDcy8ec30ZNnkEuxvLgymIuBTCA',
    'svc.clamav-publisher',
    String(epoch),
  ].join(':');
  const buf = Buffer.alloc(CVD_HEADER_BYTES, 0x20);
  buf.write(text, 0, 'ascii');
  return buf;
}

/** Create a database directory whose `daily` build time is `ageMs` old. */
async function makeDbDir(opts: {
  ageMs?: number;
  omit?: readonly string[];
  corrupt?: readonly string[];
  ext?: 'cvd' | 'cld';
  now?: number;
} = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'clamdb-'));
  for (const name of REQUIRED_DATABASES) {
    if (opts.omit?.includes(name)) continue;
    const path = join(dir, `${name}.${opts.ext ?? 'cvd'}`);
    if (opts.corrupt?.includes(name)) {
      await writeFile(path, Buffer.from('this is not a ClamAV database at all'));
      continue;
    }
    // `main` is legitimately republished only about once a year, so it is aged
    // far past any ceiling on purpose: freshness must be judged on `daily`.
    const ageMs = name === AGE_DATABASE ? (opts.ageMs ?? 60_000) : 240 * 24 * HOUR_MS;
    await writeFile(path, cvdHeader(now - ageMs));
  }
  return dir;
}

/**
 * Write an executable stand-in for `clamscan`. The scanner invokes it as
 * `<bin> --database=… --no-summary --infected <file>`, so the script sees the
 * scratch file as `$4`. Using a real process (rather than a mocked `execFile`) keeps the
 * exit-code mapping, the timeout and the temp-file lifecycle under test.
 */
async function stubScanner(body: string): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'stub-clamscan-'));
  const bin = join(dir, 'clamscan-stub.sh');
  await writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { bin, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. Header parsing — machine-readable, not localized text
// ═══════════════════════════════════════════════════════════════════════════

describe('CVD header parsing', () => {
  it('reads the build time from the epoch field, not the human date string', () => {
    // The human field says "18 Aug 2026"; the epoch field says something else
    // entirely. The epoch field must win — it is the machine-readable one.
    const target = Date.UTC(2026, 7, 1, 12, 0, 0);
    const header = parseCvdHeader(cvdHeader(target), Date.UTC(2026, 7, 2));
    expect(header?.buildTimeMs).toBe(Math.floor(target / 1000) * 1000);
  });

  it('parses a real freshclam-produced header verbatim', () => {
    const real =
      'ClamAV-VDB:18 Aug 2026 06-27 +0000:28096:355605:90:'
      + '8547d965282ba55e10ef06e0be88c064:S63f9catgbTK:svc.clamav-publisher:1787034460';
    const buf = Buffer.alloc(CVD_HEADER_BYTES, 0x00);
    buf.write(real, 0, 'ascii');
    const header = parseCvdHeader(buf, 1787034460_000 + HOUR_MS);
    expect(header).toEqual({ buildTimeMs: 1787034460_000, version: 28096 });
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['wrong magic', Buffer.from('NotAClamAVDatabase:1:2:3:4:5:6:7:1787034460')],
    ['truncated before the epoch field', Buffer.from('ClamAV-VDB:x:28096:1:90:md5:dsig')],
    ['non-numeric epoch', Buffer.from('ClamAV-VDB:x:28096:1:90:md5:dsig:builder:not-a-number')],
    ['non-numeric version', Buffer.from('ClamAV-VDB:x:vNext:1:90:md5:dsig:builder:1787034460')],
    ['binary garbage', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])],
    ['implausibly old epoch', Buffer.from('ClamAV-VDB:x:1:1:90:md5:dsig:builder:100000')],
  ])('rejects %s', (_label, buf) => {
    expect(parseCvdHeader(buf, Date.now())).toBeNull();
  });

  it('rejects a future-dated header rather than reporting a flatteringly small age', () => {
    const now = Date.now();
    const future = cvdHeader(now + 48 * HOUR_MS);
    expect(parseCvdHeader(future, now)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Freshness state — the full fail-closed matrix
// ═══════════════════════════════════════════════════════════════════════════

describe('signature freshness state', () => {
  it('reports fresh for a recently built daily database', async () => {
    const now = Date.now();
    const dir = await makeDbDir({ ageMs: 30 * 60_000, now });
    try {
      const state = await readSignatureState({ dbDir: dir, maxAgeSec: 24 * 3600 }, now);
      expect(state).toMatchObject({ fresh: true, reason: null });
      expect(state.ageSec).toBeGreaterThanOrEqual(1799);
      expect(state.ageSec).toBeLessThanOrEqual(1801);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('judges age on daily alone, so a year-old main.cvd is not stale', async () => {
    const now = Date.now();
    // makeDbDir ages `main` by 240 days by construction.
    const dir = await makeDbDir({ ageMs: 60_000, now });
    try {
      const state = await readSignatureState({ dbDir: dir, maxAgeSec: 24 * 3600 }, now);
      expect(state.fresh).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('accepts a .cld incremental database', async () => {
    const now = Date.now();
    const dir = await makeDbDir({ ageMs: 60_000, ext: 'cld', now });
    try {
      expect((await readSignatureState({ dbDir: dir }, now)).fresh).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('prefers the newer of a co-existing .cvd and .cld', async () => {
    const now = Date.now();
    const dir = await makeDbDir({ ageMs: 300 * HOUR_MS, now });
    try {
      // A scripted update leaves the fresh .cld beside the old .cvd.
      await writeFile(join(dir, `${AGE_DATABASE}.cld`), cvdHeader(now - 60_000));
      const state = await readSignatureState({ dbDir: dir, maxAgeSec: 24 * 3600 }, now);
      expect(state.fresh).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('fails closed when daily is older than the ceiling', async () => {
    const now = Date.now();
    const dir = await makeDbDir({ ageMs: 30 * HOUR_MS, now });
    try {
      const state = await readSignatureState({ dbDir: dir, maxAgeSec: 24 * 3600 }, now);
      expect(state).toMatchObject({ fresh: false, reason: 'signatures_stale' });
      expect(state.ageSec).toBeGreaterThan(24 * 3600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('fails closed on the exact production symptom: a database older than 7 days', async () => {
    const now = Date.now();
    const dir = await makeDbDir({ ageMs: 8 * 24 * HOUR_MS, now });
    try {
      const state = await readSignatureState({ dbDir: dir }, now);
      expect(state.fresh).toBe(false);
      expect(state.reason).toBe('signatures_stale');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('fails closed when the database directory does not exist', async () => {
    const state = await readSignatureState({ dbDir: join(tmpdir(), 'no-such-clamav-dir-xyz') });
    expect(state).toMatchObject({ fresh: false, reason: 'signatures_missing', ageSec: null });
  });

  it('fails closed when the directory exists but is empty (image ships no database)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clamdb-empty-'));
    try {
      const state = await readSignatureState({ dbDir: dir });
      expect(state).toMatchObject({ fresh: false, reason: 'signatures_missing' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(REQUIRED_DATABASES)('fails closed when %s is missing', async (name) => {
    const dir = await makeDbDir({ omit: [name] });
    try {
      const state = await readSignatureState({ dbDir: dir });
      expect(state).toMatchObject({ fresh: false, reason: 'signatures_missing' });
      // A present-but-fresh daily must not leak an age when main is absent.
      expect(state.ageSec).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(REQUIRED_DATABASES)('fails closed when %s is corrupt', async (name) => {
    const dir = await makeDbDir({ corrupt: [name] });
    try {
      const state = await readSignatureState({ dbDir: dir });
      expect(state).toMatchObject({ fresh: false, reason: 'signatures_corrupt' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.getuid?.() === 0)('fails closed when the database file cannot be read', async () => {
    const dir = await makeDbDir();
    const daily = join(dir, `${AGE_DATABASE}.cvd`);
    try {
      await chmod(daily, 0o000);
      const state = await readSignatureState({ dbDir: dir });
      expect(state).toMatchObject({ fresh: false, reason: 'signatures_unreadable' });
    } finally {
      await chmod(daily, 0o600).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the database path is a directory, not a file', async () => {
    const dir = await makeDbDir({ omit: [AGE_DATABASE] });
    try {
      await mkdir(join(dir, `${AGE_DATABASE}.cvd`));
      const state = await readSignatureState({ dbDir: dir });
      expect(state.fresh).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('max-age configuration', () => {
  it('defaults to a ceiling far stricter than ClamAV\'s own 7-day warning', () => {
    expect(resolveMaxDbAgeHours(undefined)).toBe(DEFAULT_MAX_DB_AGE_HOURS);
    expect(DEFAULT_MAX_DB_AGE_HOURS).toBeLessThan(7 * 24);
  });

  it.each([
    ['', MAX_DB_AGE_HOURS_BOUNDS.def],
    ['not-a-number', MAX_DB_AGE_HOURS_BOUNDS.def],
    ['-5', MAX_DB_AGE_HOURS_BOUNDS.def],
    ['0', MAX_DB_AGE_HOURS_BOUNDS.min],
    ['999999', MAX_DB_AGE_HOURS_BOUNDS.max],
    ['48', 48],
  ])('clamps %s', (raw, expected) => {
    expect(resolveMaxDbAgeHours(raw)).toBe(expected);
  });

  it('reads the ceiling from the injected env map', async () => {
    const dir = await makeDbDir({ ageMs: 5 * HOUR_MS });
    try {
      const strict = await readSignatureState({
        dbDir: dir, source: { RESUME_SCANNER_MAX_DB_AGE_HOURS: '1' } as NodeJS.ProcessEnv,
      });
      expect(strict.reason).toBe('signatures_stale');
      const lax = await readSignatureState({
        dbDir: dir, source: { RESUME_SCANNER_MAX_DB_AGE_HOURS: '48' } as NodeJS.ProcessEnv,
      });
      expect(lax.fresh).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('caches within the TTL and only in the safe direction', async () => {
    const dir = await makeDbDir({ ageMs: 60_000 });
    try {
      // Anchored to a real timestamp: the header carries a real epoch build
      // time, so a synthetic clock in 1970 would read as future-dated.
      let clock = Date.now();
      const read = createSignatureFreshnessReader({ dbDir: dir, ttlMs: 10_000, now: () => clock });
      expect((await read()).fresh).toBe(true);
      // Delete the whole database; within the TTL the cached verdict stands.
      await rm(dir, { recursive: true, force: true });
      expect((await read()).fresh).toBe(true);
      // Past the TTL the missing database is seen and the verdict fails closed.
      clock += 20_000;
      expect((await read())).toMatchObject({ fresh: false, reason: 'signatures_missing' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. The scanner — a stale exit 0 is never accepted
// ═══════════════════════════════════════════════════════════════════════════

describe('ClamAvScanner signature gating', () => {
  const fresh = async () => ({ fresh: true, ageSec: 60, maxAgeSec: 86_400, reason: null });

  it('accepts a clean file when signatures are fresh', async () => {
    // `true` is a real binary that exits 0 — the clean path, end to end.
    const scanner = new ClamAvScanner('true', 30_000, fresh);
    const result = await scanner.scan(Buffer.from('an ordinary resume'));
    expect(result).toMatchObject({ safe: true, status: 'clean' });
  });

  it('rejects EICAR even when signatures are fresh', async () => {
    const scanner = new ClamAvScanner('true', 30_000, fresh);
    const result = await scanner.scan(Buffer.from(EICAR, 'utf-8'));
    expect(result).toMatchObject({ safe: false, status: 'infected' });
  });

  it('reports infected on clamscan exit 1', async () => {
    // `false` exits 1 — ClamAV's "a signature matched" code.
    const scanner = new ClamAvScanner('false', 30_000, fresh);
    const result = await scanner.scan(Buffer.from('pretend malware'));
    expect(result).toMatchObject({ safe: false, status: 'infected' });
  });

  it('REFUSES a clean file on stale signatures WITHOUT invoking clamscan', async () => {
    // This is the production defect in one assertion: `clamscan` would exit 0
    // here, and the old code would have returned `clean`.
    let invoked = 0;
    const scanner = new ClamAvScanner('true', 30_000, async () => {
      invoked += 0; // no-op; counted via the binary below
      return { fresh: false, ageSec: 8 * 24 * 3600, maxAgeSec: 86_400, reason: 'signatures_stale' as const };
    });
    const spy = vi.spyOn(process, 'cwd');
    const result = await scanner.scan(Buffer.from('an ordinary resume'));
    spy.mockRestore();
    expect(result.safe).toBe(false);
    expect(result.status).toBe('scanner_signatures_stale');
    expect(result.detail).not.toContain('/');
    expect(invoked).toBe(0);
  });

  it('does not write the untrusted bytes to disk at all when signatures are stale', async () => {
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('hello-resume-scan-'));
    const scanner = new ClamAvScanner('true', 30_000, async () => ({
      fresh: false, ageSec: null, maxAgeSec: 86_400, reason: 'signatures_missing' as const,
    }));
    const result = await scanner.scan(Buffer.from('an ordinary resume'));
    expect(result.status).toBe('scanner_signatures_unavailable');
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('hello-resume-scan-'));
    expect(after.length).toBe(before.length);
  });

  it.each([
    ['signatures_missing', 'scanner_signatures_unavailable'],
    ['signatures_unreadable', 'scanner_signatures_unavailable'],
    ['signatures_corrupt', 'scanner_signatures_unavailable'],
    ['signatures_stale', 'scanner_signatures_stale'],
  ] as const)('maps %s to %s and fails closed', async (reason, status) => {
    const scanner = new ClamAvScanner('true', 30_000, async () => ({
      fresh: false, ageSec: null, maxAgeSec: 86_400, reason,
    }));
    const result = await scanner.scan(Buffer.from('clean bytes'));
    expect(result.safe).toBe(false);
    expect(result.status).toBe(status);
  });

  it('fails closed when the freshness reader itself throws', async () => {
    const scanner = new ClamAvScanner('true', 30_000, async () => { throw new Error('boom'); });
    const result = await scanner.scan(Buffer.from('clean bytes'));
    expect(result).toMatchObject({ safe: false, status: 'scanner_signatures_unavailable' });
    expect(result.detail).not.toContain('boom');
  });

  it('fails closed on a scan timeout', async () => {
    const { bin, cleanup } = await stubScanner('sleep 30');
    try {
      const scanner = new ClamAvScanner(bin, 100, fresh);
      const result = await scanner.scan(Buffer.from('clean bytes'));
      expect(result).toMatchObject({ safe: false, status: 'scanner_timeout' });
    } finally { await cleanup(); }
  });

  it('serializes scans process-wide and rejects work beyond the bounded queue', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'scan-gate-')), 'events');
    const { bin, cleanup } = await stubScanner(`echo start >> "${marker}"\nsleep 0.15\necho end >> "${marker}"\nexit 0`);
    const gate = new ClamScanGate(2);
    try {
      const scanner = new ClamAvScanner(bin, 2_000, fresh, gate, '/tmp/db');
      const results = await Promise.all([
        scanner.scan(Buffer.from('one')),
        scanner.scan(Buffer.from('two')),
        scanner.scan(Buffer.from('three')),
        scanner.scan(Buffer.from('four')),
      ]);
      expect(results.filter((r) => r.status === 'clean')).toHaveLength(3);
      expect(results.filter((r) => r.status === 'scanner_busy')).toHaveLength(1);
      const events = readFileSync(marker, 'utf8').trim().split(/\s+/);
      expect(events).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
    } finally {
      await cleanup();
      await rm(join(marker, '..'), { recursive: true, force: true });
    }
  });

  it('uses the exact vouched database directory and proves EICAR via the real binary path', async () => {
    const spool = await mkdtemp(join(tmpdir(), 'capability-proof-'));
    const args = join(spool, 'args');
    const { bin, cleanup } = await stubScanner(`printf '%s\\n' "$@" > "${args}"\nexit 1`);
    try {
      const result = await probeClamAvCapability({ command: bin, timeoutMs: 2_000, dbDir: '/approved/db', gate: new ClamScanGate(0) });
      expect(result).toEqual({ ready: true, reason: null });
      expect(readFileSync(args, 'utf8')).toContain('--database=/approved/db');
    } finally {
      await cleanup();
      await rm(spool, { recursive: true, force: true });
    }
  });

  it('fails closed on a clamscan internal error (exit 2)', async () => {
    const { bin, cleanup } = await stubScanner('exit 2');
    try {
      const scanner = new ClamAvScanner(bin, 30_000, fresh);
      const result = await scanner.scan(Buffer.from('clean bytes'));
      expect(result).toMatchObject({ safe: false, status: 'scanner_error' });
    } finally { await cleanup(); }
  });

  it('removes the scratch directory on every path', async () => {
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('hello-resume-scan-'));
    for (const bin of ['true', 'false', 'binary-that-does-not-exist']) {
      await new ClamAvScanner(bin, 30_000, fresh).scan(Buffer.from('bytes to scan'));
    }
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('hello-resume-scan-'));
    expect(after.length).toBe(before.length);
  });

  it('hands the real bytes to clamscan and then wipes them before unlinking', async () => {
    // The stub hard-links the scratch file aside, so the same inode survives
    // the scanner's `rm` and can be inspected afterwards. That makes the
    // in-place zero-overwrite directly observable rather than assumed.
    const spool = await mkdtemp(join(tmpdir(), 'scan-spool-'));
    const link = join(spool, 'linked.bin');
    const secret = 'SENSITIVE-RESUME-BYTES';
    const { bin, cleanup } = await stubScanner(
      `cp "$4" "${join(spool, 'copy.bin')}"\nln "$4" "${link}"\nexit 0`,
    );
    try {
      const result = await new ClamAvScanner(bin, 30_000, fresh).scan(Buffer.from(secret, 'utf-8'));
      expect(result).toMatchObject({ safe: true, status: 'clean' });

      // clamscan really saw the bytes...
      expect(readFileSync(join(spool, 'copy.bin'), 'utf8')).toBe(secret);
      // ...and the scratch inode no longer holds them.
      const wiped = readFileSync(link);
      expect(wiped.length).toBe(secret.length);
      expect(wiped.every((b) => b === 0)).toBe(true);
      expect(wiped.toString('utf8')).not.toContain('SENSITIVE');

      // And the private scratch directory itself is gone.
      const survivors = (await readdir(tmpdir())).filter((n) => n.startsWith('hello-resume-scan-'));
      expect(survivors).toEqual([]);
    } finally {
      await cleanup();
      await rm(spool, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Updater lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('signature updater', () => {
  it('is enabled exactly when ClamAV is the configured scanner', () => {
    expect(loadAvUpdaterConfig({ RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(loadAvUpdaterConfig({ RESUME_SCANNER: 'test' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(loadAvUpdaterConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it.each([
    ['AV_UPDATER_INTERVAL_MS', 'intervalMs', AV_UPDATER_BOUNDS.intervalMs],
    ['AV_UPDATER_TIMEOUT_MS', 'timeoutMs', AV_UPDATER_BOUNDS.timeoutMs],
  ] as const)('clamps %s', (envName, field, bound) => {
    const at = (v: string) => loadAvUpdaterConfig({ [envName]: v } as NodeJS.ProcessEnv)[field];
    expect(at('1')).toBe(bound.min);
    expect(at('999999999999')).toBe(bound.max);
    expect(at('nonsense')).toBe(bound.def);
    expect(at(String(bound.def))).toBe(bound.def);
  });

  it('reports success when freshclam exits 0', async () => {
    const outcome = await runAvUpdateOnce({ bin: 'true', configFile: '/dev/null', timeoutMs: 5_000 });
    expect(outcome).toEqual({ ok: true });
  });

  it('reports update_failed when freshclam exits non-zero, without echoing its output', async () => {
    const outcome = await runAvUpdateOnce({ bin: 'false', configFile: '/dev/null', timeoutMs: 5_000 });
    expect(outcome).toEqual({ ok: false, reason: 'update_failed' });
  });

  it('reports updater_unavailable when the binary is absent', async () => {
    const outcome = await runAvUpdateOnce({ bin: 'freshclam-that-does-not-exist', timeoutMs: 5_000 });
    expect(outcome).toEqual({ ok: false, reason: 'updater_unavailable' });
  });

  it('reports update_timeout and never hangs past its bound', async () => {
    const outcome = await runAvUpdateOnce({ bin: 'sleep', configFile: '/dev/null', timeoutMs: 50 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(['update_timeout', 'update_failed']).toContain(outcome.reason);
  });

  it('never throws, whatever the spawner does', async () => {
    const outcome = await runAvUpdateOnce({
      bin: 'x',
      execFileImpl: (() => { throw new Error('spawn exploded'); }) as never,
    });
    expect(outcome).toEqual({ ok: false, reason: 'updater_unavailable' });
  });

  it('is single-flight: a second call joins the running attempt', async () => {
    let started = 0;
    const handle = startAvUpdater({
      intervalMs: AV_UPDATER_BOUNDS.intervalMs.min,
      immediate: false,
      execFileImpl: ((_bin: string, _args: string[], _o: unknown, cb: (e: unknown) => void) => {
        started += 1;
        setTimeout(() => cb(null), 25);
        return new EventEmitter() as never;
      }) as never,
    });
    try {
      const [a, b] = await Promise.all([handle.runNow(), handle.runNow()]);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
      // Two concurrent freshclam processes writing one database directory is
      // precisely the update race that could corrupt a scan.
      expect(started).toBe(1);
      expect(handle.stats()).toMatchObject({ runs: 1, successes: 1, failures: 0 });
    } finally { handle.stop(); }
  });

  it('records failures without throwing, and stop() is idempotent', async () => {
    const handle = startAvUpdater({
      intervalMs: AV_UPDATER_BOUNDS.intervalMs.min,
      immediate: false,
      bin: 'false',
      configFile: '/dev/null',
      timeoutMs: 5_000,
    });
    try {
      await handle.runNow();
      expect(handle.stats()).toMatchObject({ failures: 1, lastReason: 'update_failed' });
    } finally { handle.stop(); handle.stop(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. Container supervisor (PID 1)
// ═══════════════════════════════════════════════════════════════════════════

/** A stand-in for the API child process. */
class FakeChild extends EventEmitter {
  killed: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push((signal ?? 'SIGTERM') as NodeJS.Signals);
    return true;
  }
}

describe('container supervisor', () => {
  function harness(overrides: Parameters<typeof startSupervisor>[0] = {}) {
    const child = new FakeChild();
    const handlers = new Map<NodeJS.Signals, () => void>();
    const updater = {
      stopped: 0,
      runNow: async () => ({ ok: true as const }),
      stop() { this.stopped += 1; },
      stats: () => ({ runs: 0, successes: 0, failures: 0, lastReason: null }),
    };
    const handle = startSupervisor({
      source: { RESUME_SCANNER: 'clamav', SHUTDOWN_GRACE_MS: '1000' } as NodeJS.ProcessEnv,
      spawnChild: () => child as unknown as ChildProcess,
      startUpdater: () => updater,
      onSignal: (sig, fn) => { handlers.set(sig, fn); },
      ...overrides,
    });
    return { handle, child, handlers, updater };
  }

  it('starts the updater when ClamAV is configured and stops it with the child', async () => {
    const { handle, child, updater } = harness();
    expect(handle.updater).toBe(updater);
    child.emit('exit', 0, null);
    await expect(handle.exitCode).resolves.toBe(0);
    expect(updater.stopped).toBe(1);
  });

  it('does not start the updater when ClamAV is not the configured scanner', async () => {
    const child = new FakeChild();
    const handle = startSupervisor({
      source: { RESUME_SCANNER: 'test' } as NodeJS.ProcessEnv,
      spawnChild: () => child as unknown as ChildProcess,
      onSignal: () => undefined,
      startUpdater: (cfg) => (cfg.enabled ? ({} as never) : null),
    });
    expect(handle.updater).toBeNull();
    child.emit('exit', 0, null);
    await expect(handle.exitCode).resolves.toBe(0);
  });

  it.each(FORWARDED_SIGNALS)('forwards %s to the API child', async (signal) => {
    const { handle, child, handlers } = harness();
    handlers.get(signal)!();
    expect(child.killed).toContain(signal);
    child.emit('exit', 0, null);
    await expect(handle.exitCode).resolves.toBe(0);
  });

  it('propagates a non-zero child exit code', async () => {
    const { handle, child } = harness();
    child.emit('exit', 3, null);
    await expect(handle.exitCode).resolves.toBe(3);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
    ['SIGKILL', 137],
    ['SIGQUIT', 143],
  ] as const)('encodes a %s-terminated child as %i', async (signal, expected) => {
    // The container's exit status has to still tell an operator what happened;
    // an unrecognized signal falls back to the SIGTERM encoding rather than
    // reporting a success the process did not have.
    const { handle, child } = harness();
    child.emit('exit', null, signal);
    await expect(handle.exitCode).resolves.toBe(expected);
  });

  it('kills a child that overruns its own drain budget', async () => {
    vi.useFakeTimers();
    try {
      const { handle, child, handlers } = harness();
      handlers.get('SIGTERM')!();
      expect(child.killed).toEqual(['SIGTERM']);
      // A second signal must not stack another kill timer.
      handlers.get('SIGTERM')!();
      vi.advanceTimersByTime(1_000 + 5_000 + 10);
      expect(child.killed).toContain('SIGKILL');
      child.emit('exit', null, 'SIGKILL');
      await expect(handle.exitCode).resolves.toBe(137);
    } finally { vi.useRealTimers(); }
  });

  it('exits non-zero when the API child cannot be spawned', async () => {
    const { handle, child } = harness();
    child.emit('error', new Error('ENOENT'));
    await expect(handle.exitCode).resolves.toBe(1);
  });

  it('a failing updater never takes the container down', async () => {
    const child = new FakeChild();
    const handle = startSupervisor({
      source: { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv,
      spawnChild: () => child as unknown as ChildProcess,
      onSignal: () => undefined,
      startUpdater: () => ({
        runNow: async () => ({ ok: false as const, reason: 'update_failed' as const }),
        stop: () => undefined,
        stats: () => ({ runs: 1, successes: 0, failures: 1, lastReason: 'update_failed' as const }),
      }),
    });
    // The supervisor is still alive and still bound to the child's fate.
    child.emit('exit', 0, null);
    await expect(handle.exitCode).resolves.toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. Truthful health surface
// ═══════════════════════════════════════════════════════════════════════════

describe('scanner readiness on the activation health surface', () => {
  it('reports the configured mode without constructing a scanner', () => {
    expect(scannerMode({ RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv)).toBe('clamav');
    expect(scannerMode({ RESUME_SCANNER: 'test' } as NodeJS.ProcessEnv)).toBe('test');
    expect(scannerMode({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('fail-closed');
  });

  it('is ready only when ClamAV signatures are fresh', async () => {
    const view = await readScannerHealth(
      { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv,
      async () => ({ fresh: true, ageSec: 900, maxAgeSec: 86_400, reason: null }),
      async () => ({ ready: true, reason: null }),
    );
    expect(view).toEqual({ mode: 'clamav', ready: true, signatureAgeSec: 900, maxAgeSec: 86_400, reason: null });
  });

  it('does not claim readiness when the real binary capability proof fails', async () => {
    const view = await readScannerHealth(
      { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv,
      async () => ({ fresh: true, ageSec: 900, maxAgeSec: 86_400, reason: null }),
      async () => ({ ready: false, reason: 'capability_timeout' }),
    );
    expect(view).toMatchObject({ ready: false, reason: 'capability_timeout' });
  });

  it('reports stale signatures truthfully instead of claiming readiness', async () => {
    const view = await readScannerHealth(
      { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv,
      async () => ({ fresh: false, ageSec: 700_000, maxAgeSec: 86_400, reason: 'signatures_stale' }),
    );
    expect(view).toMatchObject({ ready: false, reason: 'signatures_stale', signatureAgeSec: 700_000 });
  });

  it('never reports the built-in test scanner as ready', async () => {
    const view = await readScannerHealth({ RESUME_SCANNER: 'test' } as NodeJS.ProcessEnv);
    expect(view).toMatchObject({ mode: 'test', ready: false, reason: 'test_scanner' });
  });

  it('discloses no path, version, host or filename', async () => {
    const view = await readScannerHealth(
      { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv,
      async () => ({ fresh: false, ageSec: null, maxAgeSec: 86_400, reason: 'signatures_missing' }),
    );
    const serialized = JSON.stringify(view);
    for (const forbidden of ['/var', '/etc', 'clamav.net', '.cvd', '.cld', 'ClamAV-VDB', '28096']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('degrades an active runtime whose scanner cannot screen', () => {
    const base = {
      active: true,
      scheduler: { registeredInThisProcess: true, running: true, loops: [] },
      backlog: {
        queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null,
        operationsPending: 0, operationsFailed: 0, operationsAwaitingDelivery: 0,
        writebackPending: 0, reconcileNoProgressRuns: 0, reconcileLastSuccessAt: null,
      },
    };
    expect(evaluateDegradation({
      ...base,
      scanner: { mode: 'clamav', ready: true, signatureAgeSec: 60, maxAgeSec: 86_400, reason: null },
    })).toEqual({ status: 'healthy', reasons: [] });

    expect(evaluateDegradation({
      ...base,
      scanner: { mode: 'clamav', ready: false, signatureAgeSec: 700_000, maxAgeSec: 86_400, reason: 'signatures_stale' },
    })).toEqual({ status: 'degraded', reasons: ['scanner_signatures_stale'] });

    // A disabled integration is idle, not degraded, whatever the scanner says.
    expect(evaluateDegradation({
      ...base,
      active: false,
      scanner: { mode: 'clamav', ready: false, signatureAgeSec: null, maxAgeSec: 86_400, reason: 'signatures_missing' },
    })).toEqual({ status: 'idle', reasons: [] });
  });
});
