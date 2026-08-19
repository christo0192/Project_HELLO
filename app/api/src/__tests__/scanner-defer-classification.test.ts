/**
 * Scan-outcome classification, the deferring ingestion exit, and the cheap
 * machine-local readiness gate.
 *
 * The incident these cover: `ClamAvScanner` refused correctly on a cold boot —
 * it had no signature database — and the pipeline wrote that refusal down as a
 * permanent `failed_review` on a candidate's resume. `!scan.safe` was the only
 * distinction drawn, so "I screened it and it is malware" and "I could not
 * screen it" produced the same durable verdict.
 *
 * The fail-closed posture is NOT softened anywhere here, and the tests assert
 * that: `infected` stays terminal on every path.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyScanStatus,
  isScanVerdict,
  ClamScanGate,
  probeClamAvCapability,
  TestScanner,
  type ScanResult,
} from '../lib/malware-scanner.js';
import { runResumeIngestion, type IngestionPorts } from '../integrations/ashby/resume-ingestion.js';
import {
  checkScannerReadiness,
  scannerDeferReason,
  READINESS_TIMEOUT_REASON,
  READINESS_UNKNOWN_REASON,
  READINESS_NOT_READY_REASON,
} from '../integrations/ashby/scanner-readiness.js';
import { deferSecondsFor, DEFER_SECONDS_BY_CLASS } from '../integrations/ashby/runtime-workers.js';
import type { SignatureState } from '../lib/clamav-signatures.js';

// ═══════════════════════════════════════════════════════════════════════
// 1. Classification — exhaustive over the status union
// ═══════════════════════════════════════════════════════════════════════

describe('classifyScanStatus', () => {
  /**
   * EVERY member of the union, listed literally. The type annotation is the
   * point: adding a status to `ScanResult['status']` without adding it here
   * fails the BUILD, so the table cannot silently fall out of date — and a
   * status that nobody classified is exactly how an "I could not look" answer
   * ends up treated as "I looked and it is bad".
   */
  const ALL: ReadonlyArray<ScanResult['status']> = [
    'clean', 'infected',
    'scanner_unavailable', 'scanner_timeout', 'scanner_error', 'scanner_busy',
    'scanner_signatures_stale', 'scanner_signatures_unavailable',
  ];

  it('classifies every status exactly once, with no gaps', () => {
    for (const status of ALL) {
      const klass = classifyScanStatus(status);
      expect(['verdict', 'availability', 'transient']).toContain(klass);
    }
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it('treats only clean and infected as verdicts about the FILE', () => {
    expect(classifyScanStatus('clean')).toBe('verdict');
    expect(classifyScanStatus('infected')).toBe('verdict');
    expect(isScanVerdict('infected')).toBe(true);
    for (const status of ALL.filter((s) => s !== 'clean' && s !== 'infected')) {
      expect(isScanVerdict(status)).toBe(false);
    }
  });

  it('separates "nothing to screen with" from "could not run right now"', () => {
    expect(classifyScanStatus('scanner_signatures_unavailable')).toBe('availability');
    expect(classifyScanStatus('scanner_signatures_stale')).toBe('availability');
    expect(classifyScanStatus('scanner_unavailable')).toBe('availability');
    expect(classifyScanStatus('scanner_busy')).toBe('transient');
    expect(classifyScanStatus('scanner_timeout')).toBe('transient');
    expect(classifyScanStatus('scanner_error')).toBe('transient');
  });

  it('picks a longer wait for availability than for a transient condition', () => {
    expect(deferSecondsFor('scanner_busy')).toBe(DEFER_SECONDS_BY_CLASS.transient);
    expect(deferSecondsFor('scanner_signatures_unavailable')).toBe(DEFER_SECONDS_BY_CLASS.availability);
    // An unrecognised status takes the CONSERVATIVE (longer) wait.
    expect(deferSecondsFor('something_new')).toBe(DEFER_SECONDS_BY_CLASS.availability);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Ingestion — availability defers, infected stays terminal
// ═══════════════════════════════════════════════════════════════════════

function ingestionPorts(over: Partial<IngestionPorts> = {}): {
  ports: IngestionPorts; states: string[]; reasons: (string | undefined)[]; bytes: Buffer;
} {
  const states: string[] = [];
  const reasons: (string | undefined)[] = [];
  const bytes = Buffer.from('RESUME BYTES — must never survive an exit');
  const ports: IngestionPorts = {
    presignedUrl: 'https://host.example/resume.pdf',
    policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
    fetch: async () => ({
      ok: true, bytes, sha256: 'a'.repeat(64), contentType: 'application/pdf',
      finalHost: 'host.example', hops: 0,
    }),
    scan: async () => ({ safe: true, status: 'clean' }),
    guard: () => ({ ok: true, mime: 'application/pdf' }),
    parse: async () => ({
      text: 'Ada Lovelace ada@example.com',
      structured: { name: 'Ada', email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null },
      structurerVersion: 'v1',
    }),
    fallbackFromText: () => ({ name: null, email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null }),
    onState: (state, prov) => { states.push(state); reasons.push(prov?.failedReason); },
    extractorVersion: 'x1',
    classifyScan: (status) => classifyScanStatus(status as ScanResult['status']),
    ...over,
  };
  return { ports, states, reasons, bytes };
}

describe('runResumeIngestion — availability and transient scans DEFER', () => {
  it('returns deferred and writes NO durable state for missing signatures', async () => {
    const { ports, states } = ingestionPorts({
      scan: async () => ({ safe: false, status: 'scanner_signatures_unavailable' }),
    });
    const outcome = await runResumeIngestion(ports);

    expect(outcome.state).toBe('deferred');
    expect(outcome).toMatchObject({ reason: 'scan_scanner_signatures_unavailable' });
    // The row must not gain a failure reason: a wait that health reads as
    // human-needed work is the silent-failure trade this repair exists to avoid.
    expect(states).not.toContain('failed_review');
    expect(states).toEqual(['fetching', 'scanning']);
  });

  it.each([
    'scanner_signatures_stale',
    'scanner_unavailable',
    'scanner_busy',
    'scanner_timeout',
    'scanner_error',
  ])('defers on %s without a failed_review transition', async (status) => {
    const { ports, states } = ingestionPorts({ scan: async () => ({ safe: false, status }) });
    const outcome = await runResumeIngestion(ports);
    expect(outcome.state).toBe('deferred');
    expect(states).not.toContain('failed_review');
  });

  it('WIPES the resume bytes on the deferral path', async () => {
    const { ports, bytes } = ingestionPorts({
      scan: async () => ({ safe: false, status: 'scanner_busy' }),
    });
    const outcome = await runResumeIngestion(ports);
    expect(outcome.state).toBe('deferred');
    // The deferral is a NEW exit from the pipeline; the wipe-on-every-exit
    // guarantee has to reach it or the ephemeral design leaks.
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('keeps INFECTED terminal — the fail-closed verdict is not softened', async () => {
    const { ports, states, reasons, bytes } = ingestionPorts({
      scan: async () => ({ safe: false, status: 'infected' }),
    });
    const outcome = await runResumeIngestion(ports);
    expect(outcome).toEqual({ state: 'failed_review', reason: 'scan_infected' });
    expect(states).toContain('failed_review');
    expect(reasons).toContain('scan_infected');
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('keeps content-derived faults terminal (guard, parse, no fields)', async () => {
    const guard = await runResumeIngestion(ingestionPorts({
      guard: () => ({ ok: false, reason: 'unsupported_type' }),
    }).ports);
    expect(guard).toEqual({ state: 'failed_review', reason: 'guard_unsupported_type' });

    const parse = await runResumeIngestion(ingestionPorts({
      parse: async () => { throw new Error('boom'); },
    }).ports);
    expect(parse).toEqual({ state: 'failed_review', reason: 'parse_error' });
  });

  it('without a classifier, every not-safe status stays terminal (fail-safe default)', async () => {
    const { ports } = ingestionPorts({
      scan: async () => ({ safe: false, status: 'scanner_busy' }),
      classifyScan: undefined,
    });
    const outcome = await runResumeIngestion(ports);
    // Forgetting to wire the classifier must not create a silent unbounded
    // wait; it degrades to the loud pre-repair behaviour instead.
    expect(outcome.state).toBe('failed_review');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The readiness gate — cheap, machine-local, fail-closed
// ═══════════════════════════════════════════════════════════════════════

const FRESH: SignatureState = { fresh: true, ageSec: 120, maxAgeSec: 86_400, reason: null };
const COLD: SignatureState = { fresh: false, ageSec: null, maxAgeSec: 86_400, reason: 'signatures_missing' };

describe('checkScannerReadiness', () => {
  const clamav = { RESUME_SCANNER: 'clamav', NODE_ENV: 'production' } as NodeJS.ProcessEnv;

  it('admits when the signature database is fresh', async () => {
    const v = await checkScannerReadiness({ source: clamav, freshness: async () => FRESH });
    expect(v).toEqual({ action: 'proceed', mode: 'clamav' });
  });

  it('holds on missing/stale/corrupt signatures with a namespaced reason', async () => {
    for (const reason of ['signatures_missing', 'signatures_stale', 'signatures_corrupt', 'signatures_unreadable'] as const) {
      const v = await checkScannerReadiness({
        source: clamav,
        freshness: async () => ({ ...COLD, reason }),
      });
      expect(v).toEqual({ action: 'defer', mode: 'clamav', reasonCode: `scanner_${reason}` });
    }
  });

  it('NEVER runs the capability probe — the gate is a header read only', async () => {
    // The probe executes the real binary behind the gate production scans take.
    // If this gate ever reached for it, a poll loop would compete with scans.
    const freshness = vi.fn(async () => FRESH);
    await checkScannerReadiness({ source: clamav, freshness });
    expect(freshness).toHaveBeenCalledTimes(1);
  });

  it('holds, rather than admits, when the read does not answer in time', async () => {
    const v = await checkScannerReadiness({
      source: clamav,
      freshness: () => new Promise<SignatureState>(() => { /* never settles */ }),
      timeoutMs: 5,
      setTimer: (fn) => { fn(); return 1; },
      clearTimer: () => undefined,
    });
    expect(v).toEqual({ action: 'defer', mode: 'clamav', reasonCode: READINESS_TIMEOUT_REASON });
  });

  it('holds when the reader throws — an absence of proof is not permission', async () => {
    const v = await checkScannerReadiness({
      source: clamav,
      freshness: async () => { throw new Error('fs_exploded'); },
    });
    expect(v).toEqual({ action: 'defer', mode: 'clamav', reasonCode: READINESS_UNKNOWN_REASON });
  });

  it('admits in test mode and in fail-closed mode without reading anything', async () => {
    const freshness = vi.fn(async () => COLD);
    const dev = await checkScannerReadiness({
      source: { RESUME_SCANNER: 'test', NODE_ENV: 'development' } as NodeJS.ProcessEnv, freshness,
    });
    expect(dev.action).toBe('proceed');

    // fail-closed is a CONFIGURATION fault, not a cold start: no amount of
    // waiting produces a scanner, so the scan must fail closed and be seen.
    const misconfigured = await checkScannerReadiness({
      source: { RESUME_SCANNER: '', NODE_ENV: 'production' } as NodeJS.ProcessEnv, freshness,
    });
    expect(misconfigured).toEqual({ action: 'proceed', mode: 'fail-closed' });
    expect(freshness).not.toHaveBeenCalled();
  });

  it('sanitizes an unusable reason rather than persisting it', () => {
    expect(scannerDeferReason('signatures_missing')).toBe('scanner_signatures_missing');
    expect(scannerDeferReason('scanner_busy')).toBe('scanner_busy');
    expect(scannerDeferReason(null)).toBe(READINESS_NOT_READY_REASON);
    expect(scannerDeferReason('Provider said: /var/lib/clamav missing')).toBe(READINESS_NOT_READY_REASON);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Probe/scan gate contention
// ═══════════════════════════════════════════════════════════════════════

describe('capability probe gate contention', () => {
  it('never queues behind a running scan — it reports an absence of proof', async () => {
    const gate = new ClamScanGate(2);
    const held = await gate.acquire(1_000);
    expect(held).not.toBeNull();

    // Previously this waited up to the SCAN timeout (120s by default) and
    // occupied a waiter slot, so a dashboard refresh could push a real resume
    // scan to `scanner_busy` — which used to be a permanent ingestion failure.
    const state = await probeClamAvCapability({ gate, command: 'definitely-not-a-real-binary' });
    expect(state).toEqual({ ready: false, reason: 'capability_unverified' });
    held!();
  });

  it('takes the slot when it is free', () => {
    const gate = new ClamScanGate(2);
    const first = gate.tryAcquire();
    expect(first).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    first!();
    expect(gate.tryAcquire()).not.toBeNull();
  });
});

describe('TestScanner', () => {
  it('warns once per process, not on every scan', async () => {
    const scanner = new TestScanner();
    await scanner.scan(Buffer.from('a'));
    await scanner.scan(Buffer.from('b'));
    // The flag was `readonly false` and never assigned; nothing functional
    // depended on it, but every scan emitted the notice.
    expect((scanner as unknown as { warned: boolean }).warned).toBe(true);
  });

  it('still detects EICAR', async () => {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const r = await new TestScanner().scan(Buffer.from(eicar));
    expect(r).toMatchObject({ safe: false, status: 'infected' });
  });
});
