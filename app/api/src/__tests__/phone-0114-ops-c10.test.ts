/**
 * 0114 (PR-C, P8) — C10 operational blindness, API side.
 *
 *   C10a  audit target_type from the FULL path / metadata.resource.
 *   C10b  `clear_phone_halt`'s `actor_required` in the contract and mapped
 *         defensively to a 500 by /halt/clear; the writer-recognition
 *         structural check for set/clear/admit_phone_test_attempt.
 *   C10c  freshclam exit codes, the supervisor's status file, the
 *         rate-limited `av_updater_failing` warn, and the scanner's
 *         warning-only health reasons.
 *   C10d  the exhaustive due-code classifier, the starvation episode tracker
 *         (fake clock), its runtime wiring (one audit row per episode) and the
 *         `phone_due_starved` health reason.
 *
 * SQL behaviour of §8 is proven in policy_tests.sql (0114-§8); this file is
 * the TypeScript half.
 */
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditTarget,
  auditTargetType,
  createDbAuditSink,
  getAuditSink,
  recordAudit,
  setAuditSink,
  type AuditEntry,
} from '../lib/audit.js';
import { createPhoneApiRouter } from '../routes/phone.js';
import {
  CLEAR_PHONE_HALT_STATUSES,
  PHONE_RPC_STATUS_COUNT,
  PHONE_RPC_STATUS_UNION,
} from '../lib/phone-screening/rpc-contract.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import type { PhoneStores } from '../lib/phone-screening/ports.js';
import {
  AV_UPDATER_HEALTH,
  AV_UPDATER_STATUS_FILE_DEFAULT,
  FRESHCLAM_EXIT_UP_TO_DATE,
  avUpdaterFailing,
  parseAvUpdaterStatus,
  readAvUpdaterStatusFile,
  resolveAvUpdaterStatusFile,
  runAvUpdateAttempt,
  runAvUpdateOnce,
  startAvUpdater,
  writeAvUpdaterStatusFile,
  type AvStatusFs,
  type AvUpdaterStatus,
} from '../lib/av-updater.js';
import { supervisorUpdaterOptions } from '../container/entrypoint.js';
import {
  SCANNER_WARNING_REASONS,
  evaluateDegradation,
  readScannerHealth,
  withScannerUpdaterHealth,
  type ScannerHealthView,
} from '../integrations/ashby/runtime-health.js';
import {
  PHONE_ADMISSION_DEFERRAL,
  PHONE_ADMISSION_DEFERRAL_DETAILS,
  PHONE_ADMISSION_REFUSAL,
  PHONE_ADMISSION_REFUSAL_DETAILS,
  PHONE_DUE_CODE_CLASS,
  PHONE_DUE_SKIPS,
  PHONE_DUE_STARVATION_WARN_INTERVAL_SEC,
  PHONE_UNKNOWN_ADMISSION_DETAIL,
  createPhoneDueStarvationTracker,
  phoneDueCodeClass,
  phoneDueStarvingCodes,
  phoneRefusalCountKey,
  type PhoneDueResult,
} from '../lib/phone-runtime/due-loop.js';
import { PHONE_DIAL_REFUSALS } from '../integrations/livekit-phone-dial/dial.js';
import {
  PHONE_DUE_STARVATION_ALERT_BOUNDS,
  loadPhoneDueStarvationAlertSec,
  type PhoneRuntimeConfig,
} from '../lib/phone-runtime/config.js';
import {
  clearPhoneRuntimeRegistration,
  clearPhoneRuntimeStartFailure,
  phoneRuntimeDegradeReasons,
  phoneRuntimeView,
  registerPhoneRuntime,
} from '../lib/phone-runtime/health.js';
import { createPhoneRuntime, type PhoneRuntimeHandle } from '../lib/phone-runtime/runtime.js';
import { loadPhoneScreeningConfig, type PhoneScreeningConfig } from '../lib/phone-screening/index.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import type { Queue } from '../lib/queue/index.js';
import { MIGRATION_0114 } from './support/phone-migration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const M0114 = lf(MIGRATION_0114);
const ADMIN_ID = '66666666-6666-4666-8666-666666666666';
const UUID_X = '0b3f1c2e-7d4a-4e5b-9c6d-1a2b3c4d5e6f';

// ═════════════════════════════════════════════════════════════════════════
//  C10a — audit target
// ═════════════════════════════════════════════════════════════════════════

function entry(path_: string, metadata: Record<string, unknown> = {}): AuditEntry {
  return {
    event: 'resource.update',
    correlationId: null,
    userId: null,
    userRole: null,
    method: 'POST',
    path: path_,
    metadata,
    timestamp: '2026-10-03T00:00:00.000Z',
  };
}

describe('C10a auditTargetType — the table', () => {
  it.each([
    // metadata.resource wins whatever the path says
    ['/api/phone/halt', 'phone_control', 'phone_control'],
    ['/api/phone/halt/clear', 'phone_control', 'phone_control'],
    ['/halt', 'phone_control', 'phone_control'],
    ['/api/candidates/x', 'PHONE_RESCREEN', 'phone_rescreen'],
    // first segment after `api`
    ['/api/phone/halt', undefined, 'phone'],
    ['/api/recordings/' + UUID_X + '/download', undefined, 'recordings'],
    ['/api/candidates/' + UUID_X + '/phone', undefined, 'candidates'],
    // lane prefixes skipped
    ['/api/internal/phone/events', undefined, 'phone'],
    ['/api/integrations/ashby/mission-control/health', undefined, 'ashby'],
    ['/api/internal/integrations/x', undefined, 'x'],
    // ids rejected in the resource position
    ['/api/' + UUID_X + '/download', undefined, 'api'],
    ['/api/12345/x', undefined, 'api'],
    ['/api/deadbeefdeadbeefdeadbeef', undefined, 'api'],
    // nothing usable
    ['/api', undefined, 'api'],
    ['/halt', undefined, 'api'],
    ['/halt/clear', undefined, 'api'],
    ['', undefined, 'api'],
    ['/api/phone?x=1', undefined, 'phone'],
    // an unusable resource falls through to the path
    ['/api/phone/halt', '[REDACTED]', 'phone'],
    ['/api/phone/halt', 'has space', 'phone'],
    ['/api/phone/halt', 42, 'phone'],
    ['/api/phone/halt', 'x'.repeat(65), 'phone'],
    // an id is never a type, even when offered as the resource
    ['/api/phone/halt', 'deadbeefdeadbeefdeadbeef', 'phone'],
  ] as const)('%s with resource %s → %s', (p, resource, expected) => {
    expect(auditTargetType(p, resource)).toBe(expected);
  });

  it('auditTarget keeps the id rule: first *_id metadata value, else the path', () => {
    expect(auditTarget(entry('/api/phone/halt', { resource: 'phone_control' })))
      .toEqual({ type: 'phone_control', id: '/api/phone/halt' });
    expect(auditTarget(entry('/api/candidates/c', { engagement_id: UUID_X })))
      .toEqual({ type: 'candidates', id: UUID_X });
  });
});

describe('C10a auditTargetType — properties', () => {
  const TYPE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('always a short lower-case word, never an id, never a lane prefix', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom('api', 'internal', 'integrations', 'phone', 'halt', 'clear', UUID_X, '123'),
            fc.string({ maxLength: 20 }),
          ),
          { maxLength: 6 },
        ),
        fc.oneof(fc.constant(undefined), fc.string({ maxLength: 80 }), fc.integer()),
        (segments, resource) => {
          const t = auditTargetType(`/${segments.join('/')}`, resource);
          expect(t).toMatch(TYPE_RE);
          expect(t).not.toMatch(UUID_RE);
          expect(['internal', 'integrations']).not.toContain(t);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a valid resource always wins, lower-cased', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_]{0,30}$/),
        fc.string({ maxLength: 40 }),
        (resource, p) => {
          fc.pre(!/^[0-9a-f]{16,}$/.test(resource) && !/^\d+$/.test(resource));
          expect(auditTargetType(p, resource)).toBe(resource);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('C10a recordAudit through a MOUNTED router', () => {
  let original: ReturnType<typeof getAuditSink>;
  let entries: AuditEntry[];

  beforeEach(() => {
    original = getAuditSink();
    entries = [];
    setAuditSink((e) => { entries.push(e); });
  });
  afterEach(() => { setAuditSink(original); });

  function mounted(base: string, metadata: Record<string, unknown>) {
    const app = express();
    const router = Router();
    router.post('/:id/download', async (req: Request, res: Response) => {
      await recordAudit(req, 'resource.read', 200, { metadata });
      res.json({ ok: true });
    });
    router.post('/halt/clear', async (req: Request, res: Response) => {
      await recordAudit(req, 'resource.read', 200, { metadata });
      res.json({ ok: true });
    });
    app.use(base, router);
    return app;
  }

  it('records the FULL path, mount prefix included', async () => {
    await request(mounted('/api/phone', {})).post('/api/phone/halt/clear').send({});
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('/api/phone/halt/clear');
    // pre-0114 this read `clear`
    expect(auditTarget(entries[0]).type).toBe('phone');
  });

  it('an id segment under the mount never becomes the type', async () => {
    await request(mounted('/api/recordings', {})).post(`/api/recordings/${UUID_X}/download`).send({});
    expect(entries[0].path).toBe(`/api/recordings/${UUID_X}/download`);
    expect(auditTarget(entries[0]).type).toBe('recordings');
  });

  it('the DB sink writes target_type phone_control for the real /api/phone/halt route', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const fakeDb = {
      from: (table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          expect(table).toBe('audit_events');
          inserts.push(row);
          return { error: null };
        },
      }),
    };
    setAuditSink(createDbAuditSink(fakeDb as never));
    setRateLimitStore(new MemoryRateLimitStore());
    const stores = {
      setHalt: async () => ({ status: 'ok', alreadyHalted: false, haltReason: 'operator_pause' }),
    } as unknown as PhoneStores;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { authUser: unknown }).authUser = { id: ADMIN_ID, appRole: 'admin' };
      next();
    });
    app.use('/api/phone', createPhoneApiRouter({
      configSource: { PHONE_SCREENING_ENABLED: 'true' },
      stores,
      now: () => new Date('2026-10-03T00:00:00Z'),
    }));
    const res = await request(app).post('/api/phone/halt').send({ reason: 'operator_pause' });
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].target_type).toBe('phone_control');
    expect((inserts[0].metadata as Record<string, unknown>).path).toBe('/api/phone/halt');
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  C10b — actor_required, and the writer recognition
// ═════════════════════════════════════════════════════════════════════════

describe('C10b clear_phone_halt actor_required', () => {
  it('is in the contract, and the distinct-status count does not move', () => {
    expect(CLEAR_PHONE_HALT_STATUSES).toContain('actor_required');
    expect(PHONE_RPC_STATUS_UNION).toContain('actor_required');
    expect(PHONE_RPC_STATUS_COUNT).toBe(124);
  });

  it('/halt/clear maps it to a 500 phone_halt_actor_required, audits nothing, compensates nothing', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const original = getAuditSink();
    const audited: AuditEntry[] = [];
    setAuditSink((e) => { audited.push(e); });
    const calls: string[] = [];
    const stores = {
      backlog: async () => {
        calls.push('backlog');
        return {
          status: 'ok',
          admission: { controlPresent: true, halted: true, haltReason: 'operator_pause' },
        };
      },
      clearHalt: async () => { calls.push('clearHalt'); return { status: 'actor_required' }; },
      setHalt: async () => { calls.push('setHalt'); return { status: 'ok' }; },
    } as unknown as PhoneStores;
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { authUser: unknown }).authUser = { id: ADMIN_ID, appRole: 'admin' };
        next();
      });
      app.use('/api/phone', createPhoneApiRouter({
        configSource: { PHONE_SCREENING_ENABLED: 'true' },
        stores,
        now: () => new Date('2026-10-03T00:00:00Z'),
      }));
      const res = await request(app).post('/api/phone/halt/clear').send({ reason: 'operator_pause' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'phone_halt_actor_required' });
      expect(calls).toEqual(['backlog', 'clearHalt']);
      expect(audited).toHaveLength(0);
    } finally {
      setAuditSink(original);
    }
  });

  it('the route passes the authenticated id as the actor (so the refusal is unreachable)', () => {
    const route = readFileSync(path.join(API_ROOT, 'src/routes/phone.ts'), 'utf8');
    const clearAt = route.indexOf("'/halt/clear'");
    expect(clearAt).toBeGreaterThan(0);
    const block = route.slice(clearAt, route.indexOf('SUPPRESSIONS', clearAt));
    expect(block).toContain('const actorId = req.authUser?.id ?? null;');
    expect(block).toContain('writeStore().clearHalt({ actorId, now: now() })');
  });
});

describe('C10b writer recognition — the structural check for set/clear/admit_phone_test_attempt', () => {
  const BEGIN = '-- ==== 0114 §8 BEGIN ====';
  const END = '-- ==== 0114 §8 END ====';
  const S8 = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END));

  function header(name: string): string {
    const at = S8.indexOf(`create or replace function screening_v2.${name}(`);
    expect(at, `${name} not redeclared in §8`).toBeGreaterThan(-1);
    return S8.slice(at, S8.indexOf('as $$', at));
  }

  it('set and clear keep SECURITY DEFINER and the pinned search_path', () => {
    for (const name of ['set_phone_halt', 'clear_phone_halt']) {
      const h = header(name);
      expect(h, name).toContain('security definer');
      expect(h, name).toContain('set search_path = pg_catalog, screening_v2');
    }
  });

  it('the direct-write trigger exempts EXACTLY the three writers (S8 deviation: call stack, not a GUC)', () => {
    const m = /if v_caller in \(([^)]*)\) then\s*\n\s*return null;/.exec(S8);
    expect(m).not.toBeNull();
    const exempt = m![1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
    expect(exempt).toEqual(['admit_phone_test_attempt', 'clear_phone_halt', 'set_phone_halt']);
    // no custom parameter is SET anywhere (a function-level SET of one needs
    // superuser); the comment that explains the deviation may still name it
    expect(S8).not.toMatch(/^\s*set\s+screening_v2\.phone_control_writer/im);
    expect(S8).not.toMatch(/alter\s+function[^;]*phone_control_writer/i);
  });

  it('admit_phone_test_attempt is not redeclared in 0114 (byte-identical test gate)', () => {
    expect(M0114).not.toContain('create or replace function screening_v2.admit_phone_test_attempt(');
  });

  it('phone_due_starved is in the LAST chk_audit_action re-creation, and the runtime writes exactly that action', () => {
    const files = readdirSync(path.join(REPO_ROOT, 'app/supabase/migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
    const recreating = files.filter((f) =>
      /add constraint chk_audit_action/i.test(
        readFileSync(path.join(REPO_ROOT, 'app/supabase/migrations', f), 'utf8')));
    expect(recreating.at(-1)).toBe('0114_phone_outcome_integrity.sql');
    expect(M0114).toContain("'phone_due_starved'");
    const runtime = readFileSync(path.join(API_ROOT, 'src/lib/phone-runtime/runtime.ts'), 'utf8');
    expect(runtime).toContain("action: 'phone_due_starved'");
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  C10c — the signature updater
// ═════════════════════════════════════════════════════════════════════════

/** An execFile double that calls back with the given error. */
function spawner(error: unknown, onCall?: () => void) {
  return ((_bin: string, _args: string[], _o: unknown, cb: (e: unknown) => void) => {
    onCall?.();
    setTimeout(() => cb(error), 0);
    return new EventEmitter() as never;
  }) as never;
}

function exitError(code: number) {
  return Object.assign(new Error('exit'), { code });
}

describe('C10c freshclam exit codes', () => {
  it('exit 0 is a success with exit code 0', async () => {
    expect(await runAvUpdateAttempt({ execFileImpl: spawner(null) }))
      .toEqual({ outcome: { ok: true }, exitCode: 0 });
  });

  it('exit 1 ("up to date") is resolved by re-reading freshness: fresh → success', async () => {
    const isFresh = vi.fn(async () => true);
    expect(await runAvUpdateAttempt({ execFileImpl: spawner(exitError(1)), isFresh }))
      .toEqual({ outcome: { ok: true }, exitCode: FRESHCLAM_EXIT_UP_TO_DATE });
    expect(isFresh).toHaveBeenCalledTimes(1);
  });

  it('exit 1 with a stale (or unreadable) database is a failure', async () => {
    expect(await runAvUpdateAttempt({ execFileImpl: spawner(exitError(1)), isFresh: () => false }))
      .toEqual({ outcome: { ok: false, reason: 'update_failed' }, exitCode: 1 });
    expect(await runAvUpdateAttempt({
      execFileImpl: spawner(exitError(1)),
      isFresh: () => { throw new Error('unreadable'); },
    })).toEqual({ outcome: { ok: false, reason: 'update_failed' }, exitCode: 1 });
  });

  it('exit 1 WITHOUT a freshness reader stays a failure (pre-0114 behaviour)', async () => {
    expect(await runAvUpdateOnce({ execFileImpl: spawner(exitError(1)) }))
      .toEqual({ ok: false, reason: 'update_failed' });
  });

  it('any other non-zero exit is update_failed carrying its code; the freshness reader is not consulted', async () => {
    const isFresh = vi.fn(async () => true);
    for (const code of [52, 54, 57, 62]) {
      expect(await runAvUpdateAttempt({ execFileImpl: spawner(exitError(code)), isFresh }))
        .toEqual({ outcome: { ok: false, reason: 'update_failed' }, exitCode: code });
    }
    expect(isFresh).not.toHaveBeenCalled();
  });

  it('timeout and missing binary carry no exit code', async () => {
    expect(await runAvUpdateAttempt({ execFileImpl: spawner(Object.assign(new Error('t'), { killed: true })) }))
      .toEqual({ outcome: { ok: false, reason: 'update_timeout' }, exitCode: null });
    expect(await runAvUpdateAttempt({ execFileImpl: spawner(Object.assign(new Error('n'), { code: 'ENOENT' })) }))
      .toEqual({ outcome: { ok: false, reason: 'updater_unavailable' }, exitCode: null });
  });
});

describe('C10c the supervisor status', () => {
  function clock(startIso: string) {
    let ms = Date.parse(startIso);
    return { now: () => new Date(ms), advance: (d: number) => { ms += d; } };
  }

  it('tracks consecutive failures, last success, last exit code; a success resets the streak', async () => {
    const c = clock('2026-10-03T00:00:00.000Z');
    const results = [exitError(52), exitError(1), null, exitError(57)];
    let i = 0;
    const statuses: AvUpdaterStatus[] = [];
    const handle = startAvUpdater({
      intervalMs: 3_600_000,
      immediate: false,
      setTimer: () => 0,
      clearTimer: () => undefined,
      now: c.now,
      isFresh: () => false,
      execFileImpl: ((_b: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => {
        const r = results[i++];
        setTimeout(() => cb(r), 0);
        return new EventEmitter() as never;
      }) as never,
      onStatus: (s) => { statuses.push(s); },
    });
    try {
      await handle.runNow(); c.advance(1000);
      await handle.runNow(); c.advance(1000);
      expect(handle.stats()).toMatchObject({ consecutiveFailures: 2, lastExitCode: 1, lastSuccessAt: null });
      await handle.runNow(); c.advance(1000);
      expect(handle.stats()).toMatchObject({
        consecutiveFailures: 0, lastExitCode: 0, lastSuccessAt: '2026-10-03T00:00:02.000Z',
      });
      await handle.runNow();
      expect(statuses).toHaveLength(4);
      expect(statuses[3]).toEqual({
        version: 1,
        started_at: '2026-10-03T00:00:00.000Z',
        runs: 4,
        successes: 1,
        failures: 3,
        consecutive_failures: 1,
        last_attempt_at: '2026-10-03T00:00:03.000Z',
        last_success_at: '2026-10-03T00:00:02.000Z',
        last_exit_code: 57,
        last_reason: 'update_failed',
      });
      expect(handle.status!()).toEqual(statuses[3]);
    } finally { handle.stop(); }
  });

  it('an onStatus that throws never reaches the updater', async () => {
    const handle = startAvUpdater({
      intervalMs: 3_600_000, immediate: false, setTimer: () => 0, clearTimer: () => undefined,
      runOnce: async () => ({ ok: true }),
      onStatus: () => { throw new Error('disk full'); },
    });
    try {
      expect(await handle.runNow()).toEqual({ ok: true });
      expect(handle.stats().successes).toBe(1);
    } finally { handle.stop(); }
  });

  it('the av_updater_failing warn is RATE-LIMITED to one line per hour', async () => {
    const c = clock('2026-10-03T00:00:00.000Z');
    const lines: string[] = [];
    // `warn` lines go to console.warn (lib/logger.ts defaultWrite)
    const spy = vi.spyOn(console, 'warn').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
    }) as never);
    const handle = startAvUpdater({
      intervalMs: 3_600_000, immediate: false, setTimer: () => 0, clearTimer: () => undefined,
      now: c.now,
      runOnce: async () => ({ ok: false, reason: 'update_timeout' }),
    });
    const failing = () => lines.filter((l) => l.includes('"error_category":"av_updater_failing"')).length;
    try {
      for (let n = 0; n < AV_UPDATER_HEALTH.failingConsecutive - 1; n++) {
        await handle.runNow(); c.advance(60_000);
      }
      expect(failing()).toBe(0); // 5 failures in 5 minutes is not yet a trend
      await handle.runNow(); c.advance(60_000); // 6th
      expect(failing()).toBe(1);
      for (let n = 0; n < 10; n++) { await handle.runNow(); c.advance(60_000); }
      expect(failing()).toBe(1); // still inside the hour
      c.advance(AV_UPDATER_HEALTH.warnIntervalMs);
      await handle.runNow();
      expect(failing()).toBe(2);
      // the line carries the closed reason code and a count only
      const line = lines.find((l) => l.includes('av_updater_failing'))!;
      expect(line).toContain('"error_type":"update_timeout"');
    } finally {
      handle.stop();
      spy.mockRestore();
    }
  });

  it('supervisorUpdaterOptions publishes each settled attempt to AV_UPDATER_STATUS_FILE', async () => {
    const writes: Array<{ path: string; status: AvUpdaterStatus }> = [];
    const opts = supervisorUpdaterOptions(
      { enabled: true, intervalMs: 3_600_000, timeoutMs: 600_000 },
      { RESUME_SCANNER: 'clamav', AV_UPDATER_STATUS_FILE: '/run/av/status.json' },
      async (p, status) => { writes.push({ path: p, status }); return true; },
    );
    expect(opts.isFresh).toBeTypeOf('function');
    expect(opts.isCold).toBeTypeOf('function');
    const handle = startAvUpdater({
      ...opts,
      immediate: false,
      setTimer: () => 0,
      clearTimer: () => undefined,
      runOnce: async () => ({ ok: true }),
    });
    try {
      await handle.runNow();
      expect(writes).toHaveLength(1);
      expect(writes[0].path).toBe('/run/av/status.json');
      expect(writes[0].status.successes).toBe(1);
    } finally { handle.stop(); }
  });
});

describe('C10c the status file', () => {
  const STATUS: AvUpdaterStatus = {
    version: 1,
    started_at: '2026-10-03T00:00:00.000Z',
    runs: 3,
    successes: 1,
    failures: 2,
    consecutive_failures: 2,
    last_attempt_at: '2026-10-03T01:00:00.000Z',
    last_success_at: '2026-10-03T00:00:00.000Z',
    last_exit_code: 52,
    last_reason: 'update_failed',
  };

  function memFs(opts: { failRename?: boolean } = {}) {
    const files = new Map<string, string>();
    const ops: string[] = [];
    const fs: AvStatusFs = {
      writeFile: async (p, d) => { ops.push(`write ${p}`); files.set(p, d); },
      rename: async (a, b) => {
        ops.push(`rename ${a} -> ${b}`);
        if (opts.failRename) throw new Error('EXDEV');
        files.set(b, files.get(a)!); files.delete(a);
      },
      unlink: async (p) => { ops.push(`unlink ${p}`); files.delete(p); },
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return v;
      },
    };
    return { fs, files, ops };
  }

  it('is written ATOMICALLY (temp sibling, then rename) and reads back identically', async () => {
    const m = memFs();
    expect(await writeAvUpdaterStatusFile('/tmp/s.json', STATUS, m.fs)).toBe(true);
    expect(m.ops).toEqual([`write /tmp/s.json.${process.pid}.tmp`, `rename /tmp/s.json.${process.pid}.tmp -> /tmp/s.json`]);
    expect([...m.files.keys()]).toEqual(['/tmp/s.json']);
    expect(await readAvUpdaterStatusFile('/tmp/s.json', m.fs)).toEqual(STATUS);
  });

  it('a failed rename cleans up the temp file and never throws', async () => {
    const m = memFs({ failRename: true });
    expect(await writeAvUpdaterStatusFile('/tmp/s.json', STATUS, m.fs)).toBe(false);
    expect(m.files.size).toBe(0);
  });

  it('an absent file, junk, a wrong version or a bad field reads as null', async () => {
    const m = memFs();
    expect(await readAvUpdaterStatusFile('/nope', m.fs)).toBeNull();
    expect(parseAvUpdaterStatus('not json')).toBeNull();
    expect(parseAvUpdaterStatus('[]')).toBeNull();
    expect(parseAvUpdaterStatus(JSON.stringify({ ...STATUS, version: 2 }))).toBeNull();
    expect(parseAvUpdaterStatus(JSON.stringify({ ...STATUS, runs: -1 }))).toBeNull();
    expect(parseAvUpdaterStatus(JSON.stringify({ ...STATUS, started_at: 'yesterday' }))).toBeNull();
  });

  it('untrusted optional fields are narrowed, never passed through', () => {
    const parsed = parseAvUpdaterStatus(JSON.stringify({
      ...STATUS, last_exit_code: 9999, last_reason: 'mirror said: https://x', last_success_at: 'soon',
    }));
    expect(parsed).toMatchObject({ last_exit_code: null, last_reason: null, last_success_at: null });
  });

  it('the path is honoured only when absolute and free of ..', () => {
    expect(resolveAvUpdaterStatusFile({})).toBe(AV_UPDATER_STATUS_FILE_DEFAULT);
    expect(resolveAvUpdaterStatusFile({ AV_UPDATER_STATUS_FILE: '/var/run/av.json' })).toBe('/var/run/av.json');
    expect(resolveAvUpdaterStatusFile({ AV_UPDATER_STATUS_FILE: 'relative.json' })).toBe(AV_UPDATER_STATUS_FILE_DEFAULT);
    expect(resolveAvUpdaterStatusFile({ AV_UPDATER_STATUS_FILE: '/tmp/../etc/x' })).toBe(AV_UPDATER_STATUS_FILE_DEFAULT);
    expect(resolveAvUpdaterStatusFile({ AV_UPDATER_STATUS_FILE: `/${'a'.repeat(300)}` })).toBe(AV_UPDATER_STATUS_FILE_DEFAULT);
  });
});

describe('C10c scanner health: failing / aging / stale (warning-only)', () => {
  const NOW = Date.parse('2026-10-03T12:00:00.000Z');
  const READY: ScannerHealthView = {
    mode: 'clamav', ready: true, signatureAgeSec: 3600, maxAgeSec: 86_400, reason: null,
  };
  const status = (over: Partial<AvUpdaterStatus> = {}): AvUpdaterStatus => ({
    version: 1,
    started_at: '2026-10-03T00:00:00.000Z',
    runs: 10,
    successes: 9,
    failures: 1,
    consecutive_failures: 0,
    last_attempt_at: '2026-10-03T11:00:00.000Z',
    last_success_at: '2026-10-03T11:00:00.000Z',
    last_exit_code: 0,
    last_reason: null,
    ...over,
  });

  it('a healthy updater adds the updater block and no warnings', () => {
    const v = withScannerUpdaterHealth(READY, status(), NOW);
    expect(v.updater).toEqual({
      consecutiveFailures: 0,
      lastSuccessAt: '2026-10-03T11:00:00.000Z',
      lastAttemptAt: '2026-10-03T11:00:00.000Z',
      lastExitCode: 0,
      lastReason: null,
    });
    expect(v.warnings).toBeUndefined();
    expect(v.ready).toBe(true);
  });

  it('failing: 6 consecutive failures', () => {
    expect(withScannerUpdaterHealth(READY, status({ consecutive_failures: 6 }), NOW).warnings)
      .toEqual(['scanner_updater_failing']);
    expect(withScannerUpdaterHealth(READY, status({ consecutive_failures: 5 }), NOW).warnings)
      .toBeUndefined();
  });

  it('failing: no success for 6 h — from the last success, or from start when never', () => {
    expect(withScannerUpdaterHealth(READY, status({ last_success_at: '2026-10-03T06:00:00.000Z' }), NOW).warnings)
      .toEqual(['scanner_updater_failing']);
    expect(withScannerUpdaterHealth(READY, status({ last_success_at: '2026-10-03T06:00:01.000Z' }), NOW).warnings)
      .toBeUndefined();
    expect(avUpdaterFailing(status({ last_success_at: null, started_at: '2026-10-03T05:00:00.000Z' }), NOW)).toBe(true);
    expect(avUpdaterFailing(status({ last_success_at: null, started_at: '2026-10-03T07:00:00.000Z' }), NOW)).toBe(false);
  });

  it('aging: the daily database is 18 h old or more', () => {
    expect(withScannerUpdaterHealth({ ...READY, signatureAgeSec: 18 * 3600 }, null, NOW).warnings)
      .toEqual(['scanner_signatures_aging']);
    expect(withScannerUpdaterHealth({ ...READY, signatureAgeSec: 18 * 3600 - 1 }, null, NOW).warnings)
      .toBeUndefined();
  });

  it('stale: the existing not-ready verdict is untouched; warnings ride alongside', () => {
    const stale: ScannerHealthView = {
      mode: 'clamav', ready: false, signatureAgeSec: 90_000, maxAgeSec: 86_400, reason: 'signatures_stale',
    };
    const v = withScannerUpdaterHealth(stale, status({ consecutive_failures: 9 }), NOW);
    expect(v).toMatchObject({ ready: false, reason: 'signatures_stale' });
    expect(v.warnings).toEqual(['scanner_updater_failing', 'scanner_signatures_aging']);
  });

  it('warnings never degrade: the verdict is decided exactly as before', () => {
    const backlog = {
      queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null, reconcileNoProgressRuns: 0,
      ingestionStuckQueued: 0, ingestionStuckFetching: 0, ingestionStuckScanning: 0,
      ingestionStuckExtracting: 0, ingestionStuckStructuring: 0,
      operationsFailedPrerequisite: 0, operationsBlockedFailedIngestion: 0,
      scannerDeferredJobs: 0, scannerDeferredOldestAgeSec: null,
    };
    const scheduler = { registeredInThisProcess: false, running: false, loops: [] };
    const warned = withScannerUpdaterHealth(
      { ...READY, signatureAgeSec: 20 * 3600 }, status({ consecutive_failures: 7 }), NOW,
    );
    expect(warned.warnings).toHaveLength(2);
    expect(evaluateDegradation({
      active: true, scheduler: scheduler as never, backlog: backlog as never, scanner: warned,
    })).toEqual({ status: 'healthy', reasons: [] });
  });

  it('readScannerHealth wires the reader; only for ClamAV; a throwing reader is "no block"', async () => {
    const fresh = async () => ({ fresh: true, ageSec: 3600, maxAgeSec: 86_400, reason: null });
    const capable = async () => ({ ready: true, reason: null });
    const v = await readScannerHealth(
      { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv, fresh as never, capable as never,
      async () => status({ consecutive_failures: 6 }), () => NOW,
    );
    expect(v.warnings).toEqual(['scanner_updater_failing']);
    expect(v.updater?.consecutiveFailures).toBe(6);

    const quiet = await readScannerHealth(
      { RESUME_SCANNER: 'clamav' } as NodeJS.ProcessEnv, fresh as never, capable as never,
      async () => { throw new Error('EACCES'); }, () => NOW,
    );
    expect(quiet).toEqual({ mode: 'clamav', ready: true, signatureAgeSec: 3600, maxAgeSec: 86_400, reason: null });

    const reader = vi.fn(async () => status());
    const test = await readScannerHealth(
      { RESUME_SCANNER: 'test' } as NodeJS.ProcessEnv, fresh as never, capable as never, reader, () => NOW,
    );
    expect(test.updater).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
    expect([...SCANNER_WARNING_REASONS]).toEqual(['scanner_updater_failing', 'scanner_signatures_aging']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  C10d — the classifier and the starvation alarm
// ═════════════════════════════════════════════════════════════════════════

/** Every key `runPhoneDuePass` can emit, rebuilt from the RUNTIME vocabularies. */
function everyEmittableKey(): string[] {
  const keys = new Set<string>(PHONE_DUE_SKIPS);
  for (const refusal of [...PHONE_DIAL_REFUSALS, 'unknown']) {
    if (refusal === PHONE_ADMISSION_REFUSAL) {
      for (const d of [...PHONE_ADMISSION_REFUSAL_DETAILS, 'not-a-detail', undefined]) {
        keys.add(phoneRefusalCountKey(refusal, d));
      }
    } else if (refusal === PHONE_ADMISSION_DEFERRAL) {
      for (const d of [...PHONE_ADMISSION_DEFERRAL_DETAILS, 'not-a-detail', undefined]) {
        keys.add(phoneRefusalCountKey(refusal, d));
      }
    } else {
      keys.add(phoneRefusalCountKey(refusal, undefined));
    }
  }
  return [...keys].sort();
}

describe('C10d PHONE_DUE_CODE_CLASS — closure', () => {
  it('classifies every key a pass can emit, and nothing else (a bijection)', () => {
    expect(Object.keys(PHONE_DUE_CODE_CLASS).sort()).toEqual(everyEmittableKey());
  });

  it('every class is benign or starving', () => {
    for (const [k, v] of Object.entries(PHONE_DUE_CODE_CLASS)) {
      expect(['benign', 'starving'], k).toContain(v);
    }
  });

  it('pins the load-bearing members', () => {
    expect(phoneDueCodeClass('no_session')).toBe('starving');
    expect(phoneDueCodeClass('line_already_offered')).toBe('benign'); // R10
    expect(phoneDueCodeClass('outside_ist_window')).toBe('benign');
    expect(phoneDueCodeClass('admission_refused:window_closed')).toBe('benign');
    expect(phoneDueCodeClass('admission_refused:halt_unreadable')).toBe('starving');
    expect(phoneDueCodeClass(`admission_refused:${PHONE_UNKNOWN_ADMISSION_DETAIL}`)).toBe('starving');
    expect(phoneDueCodeClass('originate_failed')).toBe('starving');
  });

  it('a key outside the closed map reads as starving (fail loud)', () => {
    expect(phoneDueCodeClass('something_new')).toBe('starving');
    expect(phoneDueCodeClass('__proto__')).toBe('starving');
  });
});

function pass(over: Partial<PhoneDueResult> = {}): PhoneDueResult {
  return { status: 'ok', examined: 2, offered: 0, dialing: 0, skipped: {}, refusals: {}, ...over };
}
const STARVING = pass({ skipped: { no_session: 2 } });

describe('C10d phoneDueStarvingCodes', () => {
  it('an ok pass that examined rows, dialled none and saw a starving code', () => {
    expect(phoneDueStarvingCodes(pass({
      skipped: { no_session: 1, not_yet_due: 3 },
      refusals: { 'admission_refused:halt_unreadable': 1, 'admission_refused:at_capacity': 2 },
    }))).toEqual(['admission_refused:halt_unreadable', 'no_session']);
  });

  it('is empty when anything dialled, nothing was examined, the pass halted, or only benign codes', () => {
    expect(phoneDueStarvingCodes(pass({ skipped: { no_session: 1 }, dialing: 1, offered: 2 }))).toEqual([]);
    expect(phoneDueStarvingCodes(pass({ examined: 0, skipped: { no_session: 1 } }))).toEqual([]);
    expect(phoneDueStarvingCodes({ ...STARVING, status: 'halted' })).toEqual([]);
    expect(phoneDueStarvingCodes({ ...STARVING, status: 'disabled' })).toEqual([]);
    expect(phoneDueStarvingCodes(pass({ skipped: { outside_ist_window: 5 } }))).toEqual([]);
  });
});

describe('C10d the starvation tracker — fake clock', () => {
  const T0 = Date.parse('2026-10-03T04:00:00.000Z');
  const MIN = 60_000;

  it('raises once at the threshold, warns hourly, clears on a healthy pass', () => {
    const t = createPhoneDueStarvationTracker(1800);
    expect(t.observe(STARVING, T0)).toEqual({ alarmRaised: false, warn: false, cleared: false, episodeSec: 0 });
    expect(t.state()).toMatchObject({ starving: true, alarmed: false, since: '2026-10-03T04:00:00.000Z', codes: ['no_session'] });
    expect(t.observe(STARVING, T0 + 29 * MIN).alarmRaised).toBe(false);
    const at = t.observe(STARVING, T0 + 30 * MIN);
    expect(at).toEqual({ alarmRaised: true, warn: true, cleared: false, episodeSec: 1800 });
    expect(t.state().alarmed).toBe(true);
    // no second alarm (one audit per episode); no warn inside the hour
    expect(t.observe(STARVING, T0 + 31 * MIN)).toMatchObject({ alarmRaised: false, warn: false });
    expect(t.observe(STARVING, T0 + 89 * MIN)).toMatchObject({ alarmRaised: false, warn: false });
    expect(t.observe(STARVING, T0 + 90 * MIN)).toMatchObject({ alarmRaised: false, warn: true });
    expect(PHONE_DUE_STARVATION_WARN_INTERVAL_SEC).toBe(3600);
    // a dialling pass ends it, with one `cleared`
    expect(t.observe(pass({ dialing: 1, offered: 1 }), T0 + 91 * MIN))
      .toEqual({ alarmRaised: false, warn: false, cleared: true, episodeSec: 0 });
    expect(t.state()).toEqual({ starving: false, since: null, alarmed: false, codes: [] });
    expect(t.observe(pass({ dialing: 1, offered: 1 }), T0 + 92 * MIN).cleared).toBe(false);
  });

  it('a new episode after a clear starts its own clock and raises its own alarm', () => {
    const t = createPhoneDueStarvationTracker(300);
    t.observe(STARVING, T0);
    expect(t.observe(STARVING, T0 + 5 * MIN).alarmRaised).toBe(true);
    t.observe(pass({ skipped: { outside_ist_window: 2 } }), T0 + 6 * MIN);
    expect(t.observe(STARVING, T0 + 7 * MIN).alarmRaised).toBe(false);
    expect(t.observe(STARVING, T0 + 12 * MIN).alarmRaised).toBe(true);
  });

  it('a halted pass ends the episode — no phone_due_starved while halted', () => {
    const t = createPhoneDueStarvationTracker(300);
    t.observe(STARVING, T0);
    t.observe(STARVING, T0 + 10 * MIN);
    expect(t.state().alarmed).toBe(true);
    expect(t.observe({ ...STARVING, status: 'halted', examined: 0, skipped: {} }, T0 + 11 * MIN).cleared).toBe(true);
    expect(t.state().alarmed).toBe(false);
  });

  it('only-benign quiet passes never start an episode', () => {
    const t = createPhoneDueStarvationTracker(300);
    for (let m = 0; m < 600; m += 1) {
      expect(t.observe(pass({ skipped: { not_yet_due: 4, candidate_already_offered: 1 } }), T0 + m * MIN).alarmRaised)
        .toBe(false);
    }
    expect(t.state().starving).toBe(false);
  });
});

describe('C10d PHONE_DUE_STARVATION_ALERT_SEC', () => {
  it('defaults to 1800 and clamps to 300..21600; malformed reads as the default', () => {
    expect(loadPhoneDueStarvationAlertSec({})).toBe(1800);
    expect(loadPhoneDueStarvationAlertSec({ PHONE_DUE_STARVATION_ALERT_SEC: '60' })).toBe(300);
    expect(loadPhoneDueStarvationAlertSec({ PHONE_DUE_STARVATION_ALERT_SEC: '999999' })).toBe(21_600);
    expect(loadPhoneDueStarvationAlertSec({ PHONE_DUE_STARVATION_ALERT_SEC: 'soon' })).toBe(1800);
    expect(loadPhoneDueStarvationAlertSec({ PHONE_DUE_STARVATION_ALERT_SEC: '900' })).toBe(900);
    expect(PHONE_DUE_STARVATION_ALERT_BOUNDS).toEqual({ def: 1800, min: 300, max: 21_600 });
  });

  it('is declared in the env contract and the api example', () => {
    const schema = readFileSync(path.join(REPO_ROOT, 'config/environment.schema.json'), 'utf8');
    const example = readFileSync(path.join(API_ROOT, '.env.example'), 'utf8');
    for (const name of ['PHONE_DUE_STARVATION_ALERT_SEC', 'AV_UPDATER_STATUS_FILE']) {
      expect(schema, name).toContain(`"${name}"`);
      expect(example, name).toMatch(new RegExp(`^${name}=`, 'm'));
    }
  });
});

describe('C10d health view + degrade reason', () => {
  afterEach(() => {
    clearPhoneRuntimeRegistration();
    clearPhoneRuntimeStartFailure();
  });

  function fakeRuntime(dueStarvation?: { starving: boolean; since: string | null; alarmed: boolean; codes: string[] }) {
    return {
      config: {},
      scheduler: { health: () => ({ running: true, loops: [] }) },
      loopIntervalsMs: {},
      snapshot: () => ({
        lastDue: null, dialJobOutcomes: {}, lastReclaimed: null, lastExpired: null,
        lastReconciled: null, lastRolled: null, lastSameDayReleased: null, lastOrphanExpired: null,
        lastStranded: null, lastRecStranded: null, lastPartialFinalized: null, sweepNotOk: {},
        ...(dueStarvation ? { dueStarvation } : {}),
      }),
    } as unknown as PhoneRuntimeHandle;
  }

  it('an alarmed episode adds phone_due_starved and is published', () => {
    registerPhoneRuntime(fakeRuntime({
      starving: true, since: '2026-10-03T04:00:00.000Z', alarmed: true, codes: ['no_session'],
    }));
    const v = phoneRuntimeView(new Date('2026-10-03T05:00:00Z'));
    expect(v.due_starvation).toEqual({
      starving: true, since: '2026-10-03T04:00:00.000Z', alarmed: true, codes: ['no_session'],
    });
    expect(phoneRuntimeDegradeReasons(v)).toContain('phone_due_starved');
  });

  it('a starving but not-yet-alarmed episode is visible and NOT a degradation', () => {
    registerPhoneRuntime(fakeRuntime({
      starving: true, since: '2026-10-03T04:00:00.000Z', alarmed: false, codes: ['no_session'],
    }));
    expect(phoneRuntimeDegradeReasons(phoneRuntimeView())).not.toContain('phone_due_starved');
  });

  it('additive: a snapshot without the field publishes no due_starvation key', () => {
    registerPhoneRuntime(fakeRuntime());
    expect('due_starvation' in phoneRuntimeView()).toBe(false);
  });
});

describe('C10d the runtime wiring — fake clock, one audit row per episode', () => {
  const ENGAGEMENT = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
  const CANDIDATE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  const SESSION = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
  const live: PhoneRuntimeHandle[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    // 11:30 IST — inside the calling window.
    vi.setSystemTime(new Date('2026-10-05T06:00:00.000Z'));
  });
  afterEach(async () => {
    clearPhoneRuntimeRegistration();
    clearPhoneRuntimeStartFailure();
    while (live.length > 0) await live.pop()!.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function build(opts: { clock: () => number; inserts: Array<Record<string, unknown>>; insertFails?: boolean }) {
    const config: PhoneScreeningConfig = {
      ...loadPhoneScreeningConfig({} as NodeJS.ProcessEnv),
      screeningEnabled: true,
      runtimeEnabled: true,
      dialMode: 'synthetic',
    };
    const runtimeConfig: PhoneRuntimeConfig = {
      dueMs: 1_000,
      reclaimMs: 600_000,
      reconcileMs: 900_000,
      expireMs: 900_000,
      dueLimit: 3,
      reclaimLimit: 25,
      jobLeaseSeconds: 60,
      partialFinalizeGraceSec: 180,
    };
    const stores = {
      async backlog() {
        return { status: 'ok', admission: { controlPresent: true, halted: false, haltReason: null } };
      },
      async claimSweep() { return { status: 'held_by_other' as const }; },
      async reclaimAttemptLeases() { return { status: 'ok', reclaimed: 0 }; },
      async expireAppointments() { return { status: 'ok', expired: 0 }; },
    } as unknown as PhoneStores;
    const reader = {
      // An eligible row whose BOUND session is gone: ensureSession refuses
      // (`existing_terminal`) and the pass skips it `no_session` — the 10-02
      // shape — with no write anywhere.
      async listDueEngagements() {
        return [{
          engagementId: ENGAGEMENT, state: 'eligible', candidateId: CANDIDATE, roleId: null,
          sessionId: SESSION, nextEligibleAt: null, noAnswerAttempts: 0, updatedAt: null,
        }];
      },
      async listDialableNumbers() {
        return new Map([[CANDIDATE, wrapDialableNumber('+919812345678')]]);
      },
      async readSessionForReuse() { return null; },
      async findReusableSession() { return null; },
      async engagementOwningSession() { return null; },
      consent: { async latestConsentRecord() { return null; }, async activeConsentTemplate() { return null; } },
    } as never;
    const queue = {
      async enqueue() { return { id: 'j' } as never; },
      async claim() { return null; },
    } as unknown as Queue;
    const client = {
      from(table: string) {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (table === 'audit_events') opts.inserts.push(row);
            return { error: opts.insertFails ? { message: 'boom' } : null };
          },
        };
      },
    };
    const handle = createPhoneRuntime({
      config, runtimeConfig, client: client as never, queue, stores, reader,
      owner: 'phone-c10d-test', scheduler: { random: () => 0.5 },
      starvationAlertSec: 300, starvationClock: opts.clock,
    });
    expect(handle).not.toBeNull();
    live.push(handle!);
    return handle!;
  }

  it('no_session for 5 minutes → phone_due_starved, ONE audit row with codes only; logs carry no id', async () => {
    let ms = Date.parse('2026-10-05T06:00:00.000Z');
    const inserts: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    vi.spyOn(console, 'warn').mockImplementation(((c: unknown) => { lines.push(String(c)); }) as never);
    const runtime = build({ clock: () => ms, inserts });
    runtime.scheduler.start();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ms += 60_000;
    }
    const snap = runtime.snapshot();
    expect(snap.lastDue?.skipped).toEqual({ no_session: 1 });
    expect(snap.dueStarvation).toMatchObject({ starving: true, alarmed: true, codes: ['no_session'] });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      actor_type: 'system',
      action: 'phone_due_starved',
      target_type: 'phone_runtime',
      target_id: 'phone-due',
      result: 'failure',
    });
    expect((inserts[0].metadata as Record<string, unknown>).codes).toEqual(['no_session']);
    const metadata = JSON.stringify(inserts[0].metadata);
    for (const id of [ENGAGEMENT, CANDIDATE, SESSION, '9812345678']) expect(metadata).not.toContain(id);
    const starvedLines = lines.filter((l) => l.includes('phone_due_starved'));
    expect(starvedLines.length).toBeGreaterThanOrEqual(1);
    for (const l of starvedLines) {
      for (const id of [ENGAGEMENT, CANDIDATE, SESSION, '9812345678']) expect(l).not.toContain(id);
    }
  });

  it('a failing audit insert is swallowed: the alarm still stands and the loop keeps ticking', async () => {
    let ms = Date.parse('2026-10-05T06:00:00.000Z');
    const inserts: Array<Record<string, unknown>> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(console, 'warn').mockImplementation((() => undefined) as never);
    const runtime = build({ clock: () => ms, inserts, insertFails: true });
    runtime.scheduler.start();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ms += 60_000;
    }
    expect(inserts).toHaveLength(1);
    expect(runtime.snapshot().dueStarvation?.alarmed).toBe(true);
    const due = runtime.scheduler.health().loops.find((l) => l.name === 'phone-due');
    expect(due?.consecutiveErrors).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  OpenAPI
// ═════════════════════════════════════════════════════════════════════════

describe('OpenAPI documents the C10 additions', () => {
  const spec = lf(readFileSync(path.join(API_ROOT, 'openapi/openapi.yaml'), 'utf8'));

  it('phone health: phone_due_starved reason and the due_starvation block', () => {
    expect(spec).toMatch(/phone_runtime_start_failed, phone_due_starved/);
    const at = spec.indexOf('    PhoneRuntimeState:');
    const block = spec.slice(at, spec.indexOf('    PhoneRuntimeLoopState:', at));
    expect(block).toContain('        due_starvation:');
    expect(block).toContain('required: [starving, since, alarmed, codes]');
  });

  it('/halt/clear documents phone_halt_actor_required as a 500', () => {
    expect(spec).toContain('Also phone_halt_actor_required (0114)');
  });

  it('the scanner documents the updater block and the warning-only codes', () => {
    const at = spec.indexOf('    AshbyScannerState:');
    const block = spec.slice(at, spec.indexOf('    AshbyRuntimeHealthResponse:', at));
    expect(block).toContain('        updater:');
    expect(block).toContain('        warnings:');
    expect(block).toContain('enum: [scanner_updater_failing, scanner_signatures_aging]');
  });
});
