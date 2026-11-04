/**
 * scanner-upstream-late.test.ts — a late ClamAV release must not stop resume
 * ingestion, and a stuck updater still must.
 *
 * The incident, 2026-11-04: ClamAV publishes `daily` about once a day. Release
 * 28173 was built 2026-11-03 06:27Z and the next one was hours late. The machine
 * held 28173, the newest database in existence, yet at 06:27Z on 11-04 it crossed
 * the 24 h ceiling and every resume ingestion was refused with
 * `signatures_stale`. A hundred-odd resumes queued until an operator raised the
 * ceiling by hand. Refusing protected nothing: there was nothing newer to scan
 * with.
 *
 * The obvious repair is unsafe. "The updater succeeded recently" proves nothing,
 * because freshclam exits 0 while on a CDN cool-down (libfreshclam.c,
 * `fc_update_database`: "You are still on cool-down", `status = FC_SUCCESS`), so
 * a rate-limited machine reports success for as long as it is falling behind.
 * The only proof is the comparison itself: the local `daily` version against the
 * version the publisher advertises in DNS.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CVD_HEADER_BYTES,
  REQUIRED_DATABASES,
  UPSTREAM_CONFIRMED_MAX_DB_AGE_HOURS,
  UPSTREAM_EVIDENCE_MAX_AGE_SEC,
  UPSTREAM_RECORD_MAX_AGE_SEC,
  readSignatureState,
} from '../lib/clamav-signatures.js';
import {
  CLAMAV_UPDATE_INFO_HOST,
  lookupUpstreamRecord,
  parseAvUpdaterStatus,
  parseUpstreamUpdateInfo,
  readAvUpstreamEvidence,
  startAvUpdater,
  writeAvUpdaterStatusFile,
  type AvUpdaterStatus,
  type AvUpstreamEvidence,
} from '../lib/av-updater.js';
import { ClamAvScanner } from '../lib/malware-scanner.js';
import { supervisorUpdaterOptions } from '../container/entrypoint.js';
import { checkScannerReadiness } from '../integrations/ashby/scanner-readiness.js';
import {
  SCANNER_WARNING_REASONS,
  readScannerHealth,
  withScannerUpdaterHealth,
  type ScannerHealthView,
} from '../integrations/ashby/runtime-health.js';

const HOUR_MS = 3_600_000;

/** The incident, as it was. */
const BUILT_AT = Date.parse('2026-11-03T06:27:00Z');
const NOW = Date.parse('2026-11-04T10:20:00Z');
const LOCAL_DAILY = 28173;

/** The TXT record `current.cvd.clamav.net` returned during the incident. */
const REAL_TXT = '1.4.6:63:28173:1793782800:1:90:49192:339';

const CONFIRMING: AvUpstreamEvidence = {
  daily_version: LOCAL_DAILY,
  record_at: '2026-11-04T09:00:00.000Z',
  checked_at: '2026-11-04T09:33:55.144Z',
};

function cvdHeader(buildTimeMs: number, version: number): Buffer {
  const text = [
    'ClamAV-VDB', '03 Nov 2026 06-27 +0000', String(version), '355841', '90',
    'b7c96f586f5f4ada86d0155c27e64f00', 'VnDLCYyJicFx2C1tb8', 'svc.clamav-publisher',
    String(Math.floor(buildTimeMs / 1000)),
  ].join(':');
  const buf = Buffer.alloc(CVD_HEADER_BYTES, 0x20);
  buf.write(text, 0, 'ascii');
  return buf;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dbDir(opts: {
  builtAt?: number;
  version?: number;
  omit?: readonly string[];
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clamdb-upstream-'));
  dirs.push(dir);
  for (const name of REQUIRED_DATABASES) {
    if (opts.omit?.includes(name)) continue;
    const header = name === 'daily'
      ? cvdHeader(opts.builtAt ?? BUILT_AT, opts.version ?? LOCAL_DAILY)
      : cvdHeader(NOW - 240 * 24 * HOUR_MS, 63);
    await writeFile(join(dir, `${name}.cvd`), header);
  }
  return dir;
}

const SOFT_SEC = 24 * 3600;
const HARD_SEC = UPSTREAM_CONFIRMED_MAX_DB_AGE_HOURS * 3600;

async function stateWith(
  evidence: AvUpstreamEvidence | null,
  opts: { builtAt?: number; version?: number; now?: number } = {},
) {
  const dir = await dbDir(opts);
  return readSignatureState(
    { dbDir: dir, maxAgeSec: SOFT_SEC, upstream: async () => evidence },
    opts.now ?? NOW,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. The incident: the publisher is late and we hold what it last published
// ═══════════════════════════════════════════════════════════════════════════

describe('a late upstream release, proven', () => {
  it('stays fresh when the machine holds the version the publisher still advertises', async () => {
    const state = await stateWith(CONFIRMING);
    expect(state).toMatchObject({
      fresh: true,
      reason: null,
      upstreamConfirmed: true,
      maxAgeSec: HARD_SEC,
    });
    expect(state.ageSec).toBeGreaterThan(SOFT_SEC);
  });

  it('stays fresh when local is ahead of a lagging DNS record', async () => {
    const state = await stateWith(CONFIRMING, { version: LOCAL_DAILY + 1 });
    expect(state).toMatchObject({ fresh: true, upstreamConfirmed: true });
  });

  it('accepts exactly at the hard ceiling', async () => {
    const state = await stateWith(CONFIRMING, { builtAt: NOW - HARD_SEC * 1000 });
    expect(state).toMatchObject({ fresh: true, upstreamConfirmed: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Everything else stays fail-closed
// ═══════════════════════════════════════════════════════════════════════════

describe('without proof the 24 h ceiling still holds', () => {
  const stale = { fresh: false, reason: 'signatures_stale', maxAgeSec: SOFT_SEC };

  it('refuses when the publisher has moved on: the updater is not keeping up', async () => {
    const state = await stateWith({ ...CONFIRMING, daily_version: LOCAL_DAILY + 1 });
    expect(state).toMatchObject(stale);
    expect(state.upstreamConfirmed).toBeUndefined();
  });

  it('refuses when there is no evidence at all', async () => {
    expect(await stateWith(null)).toMatchObject(stale);
  });

  it('treats a throwing evidence reader as an absence of proof, not a read failure', async () => {
    const dir = await dbDir();
    const state = await readSignatureState({
      dbDir: dir,
      maxAgeSec: SOFT_SEC,
      upstream: async () => { throw new Error('EACCES'); },
    }, NOW);
    expect(state).toMatchObject(stale);
  });

  it('refuses evidence older than the evidence window, and accepts it exactly at the edge', async () => {
    const at = (ageSec: number): AvUpstreamEvidence => ({
      ...CONFIRMING,
      checked_at: new Date(NOW - ageSec * 1000).toISOString(),
      record_at: new Date(NOW - ageSec * 1000).toISOString(),
    });
    expect((await stateWith(at(UPSTREAM_EVIDENCE_MAX_AGE_SEC))).fresh).toBe(true);
    expect(await stateWith(at(UPSTREAM_EVIDENCE_MAX_AGE_SEC + 1))).toMatchObject(stale);
  });

  it('refuses a DNS record that was already old when it was read', async () => {
    const recordAged = (ageSec: number): AvUpstreamEvidence => ({
      ...CONFIRMING,
      record_at: new Date(Date.parse(CONFIRMING.checked_at) - ageSec * 1000).toISOString(),
    });
    expect((await stateWith(recordAged(UPSTREAM_RECORD_MAX_AGE_SEC))).fresh).toBe(true);
    expect(await stateWith(recordAged(UPSTREAM_RECORD_MAX_AGE_SEC + 1))).toMatchObject(stale);
  });

  it('refuses a DNS record dated well after it was read', async () => {
    const future = new Date(Date.parse(CONFIRMING.checked_at) + 2 * HOUR_MS).toISOString();
    expect(await stateWith({ ...CONFIRMING, record_at: future })).toMatchObject(stale);
  });

  it('refuses evidence stamped in the future', async () => {
    const future = new Date(NOW + 2 * HOUR_MS).toISOString();
    expect(await stateWith({ ...CONFIRMING, checked_at: future, record_at: future }))
      .toMatchObject(stale);
  });

  it('refuses past the hard ceiling however good the evidence, without reading it', async () => {
    const dir = await dbDir({ builtAt: NOW - (HARD_SEC + 1) * 1000 });
    const upstream = vi.fn(async () => CONFIRMING);
    const state = await readSignatureState({ dbDir: dir, maxAgeSec: SOFT_SEC, upstream }, NOW);
    expect(state).toMatchObject(stale);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('cannot rescue a database that is missing', async () => {
    const dir = await dbDir({ omit: ['main'] });
    const state = await readSignatureState(
      { dbDir: dir, maxAgeSec: SOFT_SEC, upstream: async () => CONFIRMING }, NOW,
    );
    expect(state).toMatchObject({ fresh: false, reason: 'signatures_missing' });
  });

  it('a successful freshclam exit is not proof: a cool-down status document still refuses', async () => {
    // freshclam exits 0 on a CDN cool-down, so this document is exactly what a
    // rate-limited machine publishes. It carries no comparison, so no pass.
    const coolDown = JSON.stringify({
      version: 1,
      started_at: '2026-11-03T11:33:23.393Z',
      runs: 23,
      successes: 23,
      failures: 0,
      consecutive_failures: 0,
      last_attempt_at: '2026-11-04T09:33:55.144Z',
      last_success_at: '2026-11-04T09:33:55.144Z',
      last_exit_code: 0,
      last_reason: null,
    });
    const fs = ownFile(coolDown);
    const dir = await dbDir();
    const state = await readSignatureState({
      dbDir: dir,
      maxAgeSec: SOFT_SEC,
      upstream: () => readAvUpstreamEvidence('/tmp/status.json', fs, 1000),
    }, NOW);
    expect(state).toMatchObject(stale);
  });
});

describe('the normal path is unchanged', () => {
  it('within the ceiling it reads no evidence and reports the plain state', async () => {
    const dir = await dbDir({ builtAt: NOW - HOUR_MS });
    const upstream = vi.fn(async () => CONFIRMING);
    const state = await readSignatureState({ dbDir: dir, maxAgeSec: SOFT_SEC, upstream }, NOW);
    expect(state).toEqual({ fresh: true, ageSec: 3600, maxAgeSec: SOFT_SEC, reason: null });
    expect(upstream).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. The DNS update-info record
// ═══════════════════════════════════════════════════════════════════════════

describe('parseUpstreamUpdateInfo', () => {
  it('reads the daily version and record time from the real record', () => {
    expect(parseUpstreamUpdateInfo(REAL_TXT)).toEqual({
      daily_version: 28173,
      record_at: '2026-11-04T09:00:00.000Z',
    });
  });

  it.each([
    ['empty', ''],
    ['no fields', 'garbage'],
    ['too few fields', '1.4.6:63:28173'],
    ['non-numeric version', '1.4.6:63:abc:1793782800:1:90:49192:339'],
    ['zero version', '1.4.6:63:0:1793782800:1:90:49192:339'],
    ['non-numeric record time', '1.4.6:63:28173:soon:1:90:49192:339'],
    ['negative version', '1.4.6:63:-1:1793782800:1:90:49192:339'],
  ])('rejects %s', (_label, text) => {
    expect(parseUpstreamUpdateInfo(text)).toBeNull();
  });
});

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('lookupUpstreamRecord', () => {
  it('asks the update-info host and joins split TXT chunks', async () => {
    const resolveTxt = vi.fn(async () => [['1.4.6:63:28173:', '1793782800:1:90:49192:339']]);
    await expect(lookupUpstreamRecord({ resolveTxt })).resolves.toEqual({
      daily_version: 28173,
      record_at: '2026-11-04T09:00:00.000Z',
    });
    expect(resolveTxt).toHaveBeenCalledWith(CLAMAV_UPDATE_INFO_HOST);
    expect(CLAMAV_UPDATE_INFO_HOST).toBe('current.cvd.clamav.net');
  });

  it('takes the HIGHEST version when several records answer, the stricter reading', async () => {
    const resolveTxt = async () => [
      ['1.4.6:63:28170:1793782800:1:90:49192:339'],
      ['not a record'],
      ['1.4.6:63:28174:1793782800:1:90:49192:339'],
    ];
    const record = await lookupUpstreamRecord({ resolveTxt });
    expect(record?.daily_version).toBe(28174);
  });

  it.each([
    ['a DNS failure', async () => { throw new Error('ESERVFAIL'); }, 'upstream_lookup_failed'],
    ['a junk answer', async () => [['nonsense']], 'upstream_record_invalid'],
    ['no answer', async () => [], 'upstream_record_invalid'],
  ])('returns null and logs a closed code on %s', async (_label, resolveTxt, code) => {
    const logs = captureLogs();
    try {
      await expect(lookupUpstreamRecord({ resolveTxt: resolveTxt as never })).resolves.toBeNull();
      expect(logs.lines.join('\n')).toContain(`"error_type":"${code}"`);
    } finally { logs.restore(); }
  });

  it('is bounded: a resolver that never answers times out', async () => {
    const logs = captureLogs();
    try {
      await expect(lookupUpstreamRecord({
        resolveTxt: () => new Promise(() => undefined),
        timeoutMs: 5,
      })).resolves.toBeNull();
      expect(logs.lines.join('\n')).toContain('"error_type":"upstream_lookup_timeout"');
    } finally { logs.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. The status document that carries the evidence across processes
// ═══════════════════════════════════════════════════════════════════════════

const BASE_STATUS: AvUpdaterStatus = {
  version: 1,
  started_at: '2026-11-03T11:33:23.393Z',
  runs: 1,
  successes: 1,
  failures: 0,
  consecutive_failures: 0,
  last_attempt_at: '2026-11-04T09:33:55.144Z',
  last_success_at: '2026-11-04T09:33:55.144Z',
  last_exit_code: 0,
  last_reason: null,
};

describe('status document', () => {
  it('round-trips the evidence', () => {
    const parsed = parseAvUpdaterStatus(JSON.stringify({ ...BASE_STATUS, upstream: CONFIRMING }));
    expect(parsed?.upstream).toEqual(CONFIRMING);
  });

  it('a document written before this change has no evidence and no key', () => {
    const parsed = parseAvUpdaterStatus(JSON.stringify(BASE_STATUS));
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('upstream');
  });

  it.each([
    ['not an object', 'yes'],
    ['an array', [CONFIRMING]],
    ['a string version', { ...CONFIRMING, daily_version: '28173' }],
    ['a zero version', { ...CONFIRMING, daily_version: 0 }],
    ['a fractional version', { ...CONFIRMING, daily_version: 28173.5 }],
    ['a bad record time', { ...CONFIRMING, record_at: 'yesterday' }],
    ['a bad check time', { ...CONFIRMING, checked_at: 12345 }],
    ['a missing field', { daily_version: 28173, record_at: CONFIRMING.record_at }],
  ])('drops the whole evidence block for %s, keeping the rest of the document', (_label, upstream) => {
    const parsed = parseAvUpdaterStatus(JSON.stringify({ ...BASE_STATUS, upstream }));
    expect(parsed).not.toBeNull();
    expect(parsed?.runs).toBe(1);
    expect(parsed).not.toHaveProperty('upstream');
  });
});

function ownFile(text: string, over: { isFile?: boolean; mode?: number; uid?: number } = {}) {
  return {
    lstat: async () => ({
      isFile: () => over.isFile ?? true,
      mode: over.mode ?? 0o100644,
      uid: over.uid ?? 1000,
    }),
    readFile: async () => text,
  };
}

describe('readAvUpstreamEvidence', () => {
  const doc = JSON.stringify({ ...BASE_STATUS, upstream: CONFIRMING });

  it('returns the evidence from a regular file this user owns', async () => {
    await expect(readAvUpstreamEvidence('/tmp/s.json', ownFile(doc), 1000)).resolves.toEqual(CONFIRMING);
  });

  it.each([
    ['something that is not a regular file', { isFile: false }],
    ['a group-writable file', { mode: 0o100664 }],
    ['a world-writable file', { mode: 0o100646 }],
    ['a file owned by someone else', { uid: 1001 }],
  ])('refuses %s: this file now backs a security decision', async (_label, over) => {
    await expect(readAvUpstreamEvidence('/tmp/s.json', ownFile(doc, over), 1000)).resolves.toBeNull();
  });

  it('is null, not an error, and says nothing when the file is simply absent', async () => {
    const fs = {
      lstat: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
      readFile: async () => doc,
    };
    const logs = captureLogs();
    try {
      await expect(readAvUpstreamEvidence('/tmp/s.json', fs, 1000)).resolves.toBeNull();
      expect(logs.lines.join('\n')).not.toContain('upstream_evidence_refused');
    } finally { logs.restore(); }
  });

  it('says so when it refuses a file, or the refusal would look like a lookup problem', async () => {
    const logs = captureLogs();
    try {
      await readAvUpstreamEvidence('/tmp/s.json', ownFile(doc, { uid: 1001 }), 1000);
      expect(logs.lines.join('\n')).toContain('"error_type":"upstream_evidence_refused"');
    } finally { logs.restore(); }
  });

  // POSIX ownership and mode bits: these need the real filesystem, so Linux CI.
  describe.skipIf(process.platform === 'win32')('on the real filesystem', () => {
    async function statusDir(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'av-evidence-'));
      dirs.push(dir);
      return dir;
    }
    const withEvidence: AvUpdaterStatus = { ...BASE_STATUS, upstream: CONFIRMING };

    it('reads back exactly what the supervisor writer produces', async () => {
      const path = join(await statusDir(), 'status.json');
      await expect(writeAvUpdaterStatusFile(path, withEvidence)).resolves.toBe(true);
      await expect(readAvUpstreamEvidence(path)).resolves.toEqual(CONFIRMING);
    });

    it('refuses a real symlink, even to a file it would otherwise trust', async () => {
      const dir = await statusDir();
      const target = join(dir, 'real.json');
      await writeAvUpdaterStatusFile(target, withEvidence);
      const link = join(dir, 'link.json');
      await symlink(target, link);
      await expect(readAvUpstreamEvidence(link)).resolves.toBeNull();
    });

    it('refuses a real group-writable file', async () => {
      const path = join(await statusDir(), 'status.json');
      await writeAvUpdaterStatusFile(path, withEvidence);
      await chmod(path, 0o664);
      await expect(readAvUpstreamEvidence(path)).resolves.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. The updater gathers evidence after every attempt
// ═══════════════════════════════════════════════════════════════════════════

describe('startAvUpdater upstream evidence', () => {
  const RECORD = { daily_version: 28173, record_at: '2026-11-04T09:00:00.000Z' };
  const clock = (iso: string) => () => new Date(iso);

  function updater(over: Partial<Parameters<typeof startAvUpdater>[0]>) {
    return startAvUpdater({
      intervalMs: 3_600_000,
      immediate: false,
      setTimer: () => 0,
      clearTimer: () => undefined,
      runOnce: async () => ({ ok: true }),
      now: clock('2026-11-04T09:33:55.144Z'),
      ...over,
    });
  }

  it('publishes the record stamped with when it was read', async () => {
    const writes: AvUpdaterStatus[] = [];
    const handle = updater({
      upstreamLookup: async () => RECORD,
      onStatus: (s) => { writes.push(s); },
    });
    try {
      await handle.runNow();
      expect(writes[0]!.upstream).toEqual({ ...RECORD, checked_at: '2026-11-04T09:33:55.144Z' });
    } finally { handle.stop(); }
  });

  it('still looks when freshclam failed: being current does not depend on the download', async () => {
    const handle = updater({
      runOnce: async () => ({ ok: false, reason: 'update_failed' }),
      upstreamLookup: async () => RECORD,
    });
    try {
      await handle.runNow();
      expect(handle.status?.().upstream?.daily_version).toBe(28173);
    } finally { handle.stop(); }
  });

  it.each([
    ['returns null', async () => null],
    ['throws', async () => { throw new Error('boom'); }],
  ])('keeps the last good evidence when the lookup %s, so it ages out on its own', async (_label, next) => {
    let call = 0;
    const handle = updater({
      upstreamLookup: async () => {
        call += 1;
        if (call === 1) return RECORD;
        return next();
      },
    });
    try {
      await handle.runNow();
      const first = handle.status?.().upstream;
      const outcome = await handle.runNow();
      expect(outcome).toEqual({ ok: true });
      expect(handle.status?.().upstream).toEqual(first);
    } finally { handle.stop(); }
  });

  it('never moves backwards: a stale resolver cannot reopen a gate a newer version closed', async () => {
    // A machine on 28173 saw 28174 and was refused. A serve-stale resolver then
    // answers 28173 again, which would read as "current" if it replaced what we saw.
    const answers = [
      { ...RECORD, daily_version: 28174 },
      { ...RECORD, daily_version: 28173 },
    ];
    const handle = updater({ upstreamLookup: async () => answers.shift() ?? null });
    try {
      await handle.runNow();
      await handle.runNow();
      expect(handle.status?.().upstream?.daily_version).toBe(28174);
    } finally { handle.stop(); }
  });

  it('a newer version replaces what it saw', async () => {
    const answers = [RECORD, { ...RECORD, daily_version: 28174 }];
    const handle = updater({ upstreamLookup: async () => answers.shift() ?? null });
    try {
      await handle.runNow();
      await handle.runNow();
      expect(handle.status?.().upstream?.daily_version).toBe(28174);
    } finally { handle.stop(); }
  });

  it('a lookup failure never changes the attempt counters', async () => {
    const handle = updater({ upstreamLookup: async () => { throw new Error('boom'); } });
    try {
      await handle.runNow();
      expect(handle.status?.()).toMatchObject({ successes: 1, failures: 0, consecutive_failures: 0 });
      expect(handle.status?.()).not.toHaveProperty('upstream');
    } finally { handle.stop(); }
  });

  it('the supervisor wires the lookup into what it publishes', async () => {
    const writes: AvUpdaterStatus[] = [];
    const opts = supervisorUpdaterOptions(
      { enabled: true, intervalMs: 3_600_000, timeoutMs: 600_000 },
      { RESUME_SCANNER: 'clamav' },
      async (_p, status) => { writes.push(status); return true; },
      async () => RECORD,
    );
    const handle = startAvUpdater({
      ...opts,
      immediate: false,
      setTimer: () => 0,
      clearTimer: () => undefined,
      runOnce: async () => ({ ok: true }),
    });
    try {
      await handle.runNow();
      expect(writes[0]!.upstream?.daily_version).toBe(28173);
    } finally { handle.stop(); }
  });

  it('the supervisor says so when the status file cannot be written', async () => {
    // The evidence crosses processes through this file, so a failed write leaves
    // the API with no proof, and nothing else would report it.
    const logs = captureLogs();
    const opts = supervisorUpdaterOptions(
      { enabled: true, intervalMs: 3_600_000, timeoutMs: 600_000 },
      { RESUME_SCANNER: 'clamav' },
      async () => false,
      async () => RECORD,
    );
    const handle = startAvUpdater({
      ...opts,
      immediate: false,
      setTimer: () => 0,
      clearTimer: () => undefined,
      runOnce: async () => ({ ok: true }),
    });
    try {
      await handle.runNow();
      expect(logs.lines.join('\n')).toContain('"error_type":"status_write_failed"');
    } finally {
      handle.stop();
      logs.restore();
    }
  });

  it('the supervisor defaults to the real lookup', () => {
    const opts = supervisorUpdaterOptions(
      { enabled: true, intervalMs: 3_600_000, timeoutMs: 600_000 },
      { RESUME_SCANNER: 'clamav' },
    );
    expect(opts.upstreamLookup).toBe(lookupUpstreamRecord);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. End to end across the seam, and the surfaces downstream of the verdict
// ═══════════════════════════════════════════════════════════════════════════

describe('the default evidence reader', () => {
  // POSIX ownership and mode bits: Windows reports 0666 for every file.
  it.skipIf(process.platform === 'win32')('reads the status file the supervisor writes', async () => {
    const db = await dbDir();
    const statusDir = await mkdtemp(join(tmpdir(), 'av-status-'));
    dirs.push(statusDir);
    const path = join(statusDir, 'status.json');
    await writeFile(path, JSON.stringify({ ...BASE_STATUS, upstream: CONFIRMING }), { mode: 0o644 });
    const state = await readSignatureState({
      dbDir: db,
      source: { AV_UPDATER_STATUS_FILE: path } as NodeJS.ProcessEnv,
    }, NOW);
    expect(state).toMatchObject({ fresh: true, upstreamConfirmed: true });
  });

  it('with no status file a stale database stays stale', async () => {
    const db = await dbDir();
    const state = await readSignatureState({
      dbDir: db,
      source: { AV_UPDATER_STATUS_FILE: join(db, 'no-such-status.json') } as NodeJS.ProcessEnv,
    }, NOW);
    expect(state).toMatchObject({ fresh: false, reason: 'signatures_stale' });
  });
});

describe('downstream of an upstream-confirmed verdict', () => {
  const CONFIRMED = {
    fresh: true,
    ageSec: 100_380,
    maxAgeSec: HARD_SEC,
    reason: null,
    upstreamConfirmed: true as const,
  };
  const CLAMAV = { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv;

  it('the ingestion gate proceeds', async () => {
    await expect(checkScannerReadiness({ source: CLAMAV, freshness: async () => CONFIRMED }))
      .resolves.toMatchObject({ action: 'proceed' });
  });

  it.skipIf(process.platform === 'win32')('the scanner runs the real scan and says what it relied on', async () => {
    const lines: string[] = [];
    // `info` lines go straight to stdout (lib/logger.ts defaultWrite).
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    try {
      const scanner = new ClamAvScanner('true', 30_000, async () => CONFIRMED);
      await expect(scanner.scan(Buffer.from('an ordinary resume')))
        .resolves.toMatchObject({ safe: true, status: 'clean' });
      expect(lines.join('\n')).toContain('"error_type":"signatures_upstream_confirmed"');
    } finally { spy.mockRestore(); }
  });

  it('a plain fresh scan logs no such line', async () => {
    const lines: string[] = [];
    // `info` lines go straight to stdout (lib/logger.ts defaultWrite).
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    try {
      const scanner = new ClamAvScanner(
        'true', 30_000,
        async () => ({ fresh: true, ageSec: 60, maxAgeSec: 86_400, reason: null }),
      );
      await scanner.scan(Buffer.from('an ordinary resume'));
      expect(lines.join('\n')).not.toContain('signatures_upstream_confirmed');
    } finally { spy.mockRestore(); }
  });

  const capable = async () => ({ ready: true, reason: null });

  it('health stays ready and carries a warning-only code', async () => {
    const view = await readScannerHealth(
      CLAMAV, async () => CONFIRMED, capable as never, async () => null, () => NOW,
    );
    expect(view).toMatchObject({ ready: true, reason: null, upstreamConfirmed: true });
    expect(view.warnings).toContain('scanner_upstream_late');
    expect(SCANNER_WARNING_REASONS).toContain('scanner_upstream_late');
  });

  it('health never exposes a signature version', async () => {
    const view = await readScannerHealth(
      CLAMAV, async () => CONFIRMED, capable as never,
      async () => ({ ...BASE_STATUS, upstream: CONFIRMING }), () => NOW,
    );
    expect(JSON.stringify(view)).not.toContain(String(LOCAL_DAILY));
  });

  describe('scanner_upstream_unverified: the safety net is not in place', () => {
    const READY: ScannerHealthView = {
      mode: 'clamav', ready: true, signatureAgeSec: 3600, maxAgeSec: SOFT_SEC, reason: null,
    };
    const unverified = (status: AvUpdaterStatus | null) =>
      withScannerUpdaterHealth(READY, status, NOW).warnings ?? [];
    const checked = (ageSec: number): AvUpdaterStatus => ({
      ...BASE_STATUS,
      upstream: { ...CONFIRMING, checked_at: new Date(NOW - ageSec * 1000).toISOString() },
    });

    it('warns when no lookup has ever succeeded, while the scanner is still healthy', () => {
      expect(unverified(BASE_STATUS)).toContain('scanner_upstream_unverified');
      expect(withScannerUpdaterHealth(READY, BASE_STATUS, NOW).ready).toBe(true);
    });

    it('warns once the last lookup is too old to count, and not before', () => {
      expect(unverified(checked(UPSTREAM_EVIDENCE_MAX_AGE_SEC))).not.toContain('scanner_upstream_unverified');
      expect(unverified(checked(UPSTREAM_EVIDENCE_MAX_AGE_SEC + 1))).toContain('scanner_upstream_unverified');
    });

    it('has nothing to say on a machine with no supervisor', () => {
      expect(unverified(null)).not.toContain('scanner_upstream_unverified');
    });

    it('is a published warning code', () => {
      expect(SCANNER_WARNING_REASONS).toContain('scanner_upstream_unverified');
    });
  });

  it('a stale verdict on the same machine raises no late-upstream warning', () => {
    const stale: ScannerHealthView = {
      mode: 'clamav', ready: false, signatureAgeSec: 100_380, maxAgeSec: SOFT_SEC, reason: 'signatures_stale',
    };
    expect(withScannerUpdaterHealth(stale, null, NOW).warnings ?? []).not.toContain('scanner_upstream_late');
  });
});
