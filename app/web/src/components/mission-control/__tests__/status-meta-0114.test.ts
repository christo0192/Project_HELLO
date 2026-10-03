/**
 * 0114 (C10): Mission Control labels for the phone health reasons (including
 * the new `phone_due_starved`) and the warning-only scanner codes.
 */
import { describe, it, expect } from 'vitest';
import {
  phoneHealthReasonLabel,
  phoneHealthReasonTone,
  scannerWarningLabel,
} from '../statusMeta';
import type { PhoneHealthResponse, ScannerWarningReason } from '../../../types';

/** The API's closed reason vocabulary (openapi.yaml PhoneHealthResponse.reasons). */
const PHONE_REASONS = [
  'phone_screening_disabled',
  'backlog_unavailable',
  'halt_unreadable',
  'admission_halted',
  'attempt_leases_expired',
  'fleet_at_capacity',
  'appointments_overdue',
  'phone_runtime_stopped',
  'phone_loop_stale',
  'phone_loop_erroring',
  'phone_due_halted',
  'phone_sweep_not_ok',
  'phone_runtime_start_failed',
  'phone_due_starved',
] as const;

describe('phoneHealthReasonLabel', () => {
  it('has operator copy for every reason the API can send', () => {
    for (const reason of PHONE_REASONS) {
      const label = phoneHealthReasonLabel(reason);
      expect(label, reason).not.toBe(reason);
      expect(label, reason).not.toMatch(/_/);
      expect(label.length, reason).toBeGreaterThan(10);
    }
  });

  it('phone_due_starved says calls are due but none are being placed', () => {
    expect(phoneHealthReasonLabel('phone_due_starved')).toMatch(/due but none are being placed/);
    expect(phoneHealthReasonTone('phone_due_starved')).toBe('danger');
  });

  it('a pause is informational, not an error', () => {
    expect(phoneHealthReasonTone('admission_halted')).toBe('info');
    expect(phoneHealthReasonTone('phone_due_halted')).toBe('info');
    expect(phoneHealthReasonTone('phone_loop_stale')).toBe('warning');
  });

  it('an unknown code is shown as itself, never guessed at', () => {
    expect(phoneHealthReasonLabel('something_new')).toBe('something_new');
    expect(phoneHealthReasonLabel('__proto__')).toBe('__proto__');
  });
});

describe('scannerWarningLabel', () => {
  it('labels both warning-only scanner codes', () => {
    const codes: ScannerWarningReason[] = ['scanner_updater_failing', 'scanner_signatures_aging'];
    for (const code of codes) {
      expect(scannerWarningLabel(code)).not.toBe(code);
    }
    expect(scannerWarningLabel('scanner_signatures_aging')).toMatch(/24 hours/);
  });

  it('an unknown code is shown as itself', () => {
    expect(scannerWarningLabel('scanner_other')).toBe('scanner_other');
  });
});

describe('PhoneHealthResponse typing (additive)', () => {
  it('accepts a body with and without the runtime starvation block', () => {
    const without: PhoneHealthResponse = {
      ok: true, enabled: true, status: 'ok', reasons: [], admission: null,
    };
    const withBlock: PhoneHealthResponse = {
      ...without,
      status: 'degraded',
      reasons: ['phone_due_starved'],
      runtime: {
        due_starvation: {
          starving: true, since: '2026-10-03T04:00:00.000Z', alarmed: true, codes: ['no_session'],
        },
      },
    };
    expect(without.runtime).toBeUndefined();
    expect(withBlock.runtime?.due_starvation?.alarmed).toBe(true);
  });
});
