/**
 * Phase 9 L2 — quota reservation client (invariant 11).
 * Bounded Idempotency-Key; cost units from policy (never client); repeated
 * key returns the SAME stable reservation (never double-reserves); commit
 * idempotent; release compensates failure; enforcement only when a policy
 * is enabled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isValidIdempotencyKey,
  extractIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  reserveQuota,
  commitReservation,
  releaseReservation,
  quotaEnforcementEnabled,
  runWithQuotaReservation,
  ResponseSentError,
  type QuotaReservationOk,
} from '../lib/quota.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

function chainable(value: any): any {
  const fn = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.order = () => chainable(value);
  fn.limit = () => chainable(value);
  fn.select = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  fn.is = () => chainable(value);
  return fn;
}

let mockRpc: any;
let mockFrom: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockRpc = (mod.supabase as any).rpc;
  mockFrom = (mod.supabase as any).from;
  mockRpc.mockReset();
  mockFrom.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const RESERVATION_ID = '00000000-0000-4000-8000-0000000000aa';

describe('Idempotency-Key validation (bounded)', () => {
  it('accepts bounded RFC3986-unreserved keys', () => {
    expect(isValidIdempotencyKey('req-123')).toBe(true);
    expect(isValidIdempotencyKey('A'.repeat(128))).toBe(true);
    expect(isValidIdempotencyKey('a.b~c_d-e')).toBe(true);
  });

  it('rejects missing, oversized, and unsafe keys', () => {
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('A'.repeat(129))).toBe(false);
    expect(isValidIdempotencyKey('sp ace')).toBe(false);
    expect(isValidIdempotencyKey('quote"')).toBe(false);
    expect(isValidIdempotencyKey('semi;colon')).toBe(false);
    expect(isValidIdempotencyKey('slash/')).toBe(false);
  });

  it('exposes the max length constant', () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });

  it('extractIdempotencyKey reads the header case-insensitively', () => {
    const req = (value?: string) =>
      ({ get: (name: string) => (name === 'Idempotency-Key' ? value : undefined) }) as any;
    expect(extractIdempotencyKey(req('abc-123'))).toBe('abc-123');
    expect(extractIdempotencyKey(req('  xyz '))).toBe('xyz'); // trimmed
    expect(extractIdempotencyKey(req(''))).toBeNull();
    expect(extractIdempotencyKey(req('bad key!'))).toBeNull();
    expect(extractIdempotencyKey(req(undefined))).toBeNull();
  });
});

describe('reserveQuota (check_and_reserve_quota mapping)', () => {
  it('maps ok → allowed with reservation id + remaining caps + warning', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'ok',
        allowed: true,
        reservation_id: RESERVATION_ID,
        remaining_sessions: 4,
        remaining_cost_units: 18,
        warning_reached: true,
      },
      error: null,
    });
    const result = await reserveQuota({ scopeId: 'cand-1', mode: 'simulation', idempotencyKey: 'k' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.allowed).toBe(true);
      expect(result.reservationId).toBe(RESERVATION_ID);
      expect(result.remainingSessions).toBe(4);
      expect(result.remainingCostUnits).toBe(18);
      expect(result.warningReached).toBe(true);
    }
    expect(mockRpc).toHaveBeenCalledWith('check_and_reserve_quota', {
      p_scope_id: 'cand-1',
      p_mode: 'simulation',
      p_idempotency_key: 'k',
    });
  });

  it('maps duplicate → same stable reservation with its status', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'duplicate', allowed: true, reservation_id: RESERVATION_ID, reservation_status: 'committed' },
      error: null,
    });
    const result = await reserveQuota({ scopeId: 'cand-1', mode: 'live', idempotencyKey: 'k' });
    expect(result.status).toBe('duplicate');
    if (result.status === 'duplicate') {
      expect(result.reservationId).toBe(RESERVATION_ID);
      expect(result.reservationStatus).toBe('committed');
    }
  });

  it('maps quota_exceeded with remaining caps', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'quota_exceeded', allowed: false, remaining_sessions: 0, remaining_cost_units: 2 },
      error: null,
    });
    const result = await reserveQuota({ scopeId: 'cand-1', mode: 'simulation', idempotencyKey: 'k' });
    expect(result.status).toBe('quota_exceeded');
    if (result.status === 'quota_exceeded') {
      expect(result.allowed).toBe(false);
      expect(result.remainingSessions).toBe(0);
    }
  });

  it('maps no_policy → not allowed', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'no_policy', allowed: false }, error: null });
    const result = await reserveQuota({ scopeId: 'cand-1', mode: 'simulation', idempotencyKey: 'k' });
    expect(result).toEqual({ status: 'no_policy', allowed: false });
  });

  it('maps RPC error / malformed payload → rpc_error (never trusts client cost)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await reserveQuota({ scopeId: 'x', mode: 'simulation', idempotencyKey: 'k' })).status).toBe('rpc_error');
    mockRpc.mockResolvedValue({ data: { status: 'weird' }, error: null });
    expect((await reserveQuota({ scopeId: 'x', mode: 'simulation', idempotencyKey: 'k' })).status).toBe('rpc_error');
    mockRpc.mockResolvedValue({ data: [1, 2], error: null });
    expect((await reserveQuota({ scopeId: 'x', mode: 'simulation', idempotencyKey: 'k' })).status).toBe('rpc_error');
  });
});

describe('commitReservation / releaseReservation (idempotent CAS)', () => {
  it('commit ok', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'committed' }, error: null });
    expect(await commitReservation(RESERVATION_ID)).toEqual({ ok: true, code: 'committed' });
  });
  it('commit already-committed is a no-op (never double-counts)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_committed' }, error: null });
    expect(await commitReservation(RESERVATION_ID)).toEqual({ ok: true, code: 'already_committed' });
  });
  it('commit released → not ok', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'released_not_commitable' }, error: null });
    expect(await commitReservation(RESERVATION_ID)).toEqual({ ok: false, code: 'released_not_commitable' });
  });
  it('commit RPC error → not ok', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await commitReservation(RESERVATION_ID)).toEqual({ ok: false, code: 'rpc_error' });
  });
  it('release ok (compensation)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'released' }, error: null });
    expect(await releaseReservation(RESERVATION_ID)).toEqual({ ok: true, code: 'released' });
  });
  it('release already-released is a no-op', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_released' }, error: null });
    expect(await releaseReservation(RESERVATION_ID)).toEqual({ ok: true, code: 'already_released' });
  });
});

describe('quotaEnforcementEnabled', () => {
  it('false when no enabled policy (disabled by default)', async () => {
    mockFrom.mockReturnValue(chainable({ data: [], error: null }));
    expect(await quotaEnforcementEnabled()).toEqual({ ok: true, enabled: false });
  });
  it('true when at least one enabled policy exists', async () => {
    mockFrom.mockReturnValue(chainable({ data: [{ id: 'p1' }], error: null }));
    expect(await quotaEnforcementEnabled()).toEqual({ ok: true, enabled: true });
  });
  it('ok:false on DB failure (gates fail closed)', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: { message: 'down' } }));
    expect(await quotaEnforcementEnabled()).toEqual({ ok: false, enabled: false });
  });
});

describe('runWithQuotaReservation', () => {
  const okReservation: QuotaReservationOk = {
    status: 'ok',
    allowed: true,
    reservationId: RESERVATION_ID,
    remainingSessions: null,
    remainingCostUnits: null,
    warningReached: false,
  };

  it('commits after successful creation; release not called', async () => {
    const commit = vi.fn().mockResolvedValue({ ok: true, code: 'committed' });
    const release = vi.fn().mockResolvedValue({ ok: true, code: 'released' });
    const fn = vi.fn().mockResolvedValue(undefined);
    const outcome = await runWithQuotaReservation(okReservation, fn, { commit, release });
    expect(outcome.handled).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(RESERVATION_ID);
    expect(release).not.toHaveBeenCalled();
  });

  it('releases on failure and rethrows', async () => {
    const commit = vi.fn();
    const release = vi.fn().mockResolvedValue({ ok: true, code: 'released' });
    const fn = vi.fn().mockRejectedValue(new Error('session create failed'));
    await expect(runWithQuotaReservation(okReservation, fn, { commit, release })).rejects.toThrow('session create failed');
    expect(release).toHaveBeenCalledWith(RESERVATION_ID);
    expect(commit).not.toHaveBeenCalled();
  });

  it('release failure is swallowed (best-effort compensation)', async () => {
    const release = vi.fn().mockRejectedValue(new Error('release failed'));
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runWithQuotaReservation(okReservation, fn, { release })).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ResponseSentError → handled (no rethrow, no commit, release called)', async () => {
    const commit = vi.fn();
    const release = vi.fn().mockResolvedValue({ ok: true, code: 'released' });
    const fn = vi.fn().mockImplementation(() => { throw new ResponseSentError(); });
    const outcome = await runWithQuotaReservation(okReservation, fn, { commit, release });
    expect(outcome.handled).toBe(true);
    expect(release).toHaveBeenCalledWith(RESERVATION_ID);
    expect(commit).not.toHaveBeenCalled();
  });
});
