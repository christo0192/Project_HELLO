/**
 * Phase 9 L2 — maintenance guard (invariant 10).
 * Fail-closed for NEW-work gates: blocks on enabled maintenance OR DB-read
 * failure; authenticated admins pass through with allowAdmin; never blocks
 * active-call continuation (the guard is only mounted on START paths).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  MAINTENANCE_CONFIG_KEY,
  readMaintenanceState,
  createMaintenanceMiddleware,
  maintenanceBlockedBody,
} from '../lib/maintenance.js';

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

let mockFrom: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readMaintenanceState', () => {
  it('reads system_config key=maintenance', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: null }));
    const state = await readMaintenanceState();
    expect(state).toEqual({ ok: true, enabled: false, reason: null, updatedAt: null });
    expect(mockFrom).toHaveBeenCalledWith('system_config');
  });

  it('enabled when value.enabled === true, with bounded reason', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: {
          value: { enabled: true, reason: 'x'.repeat(300) },
          updated_at: '2026-08-02T00:00:00.000Z',
        },
        error: null,
      }),
    );
    const state = await readMaintenanceState();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.enabled).toBe(true);
      expect(state.reason).toHaveLength(200); // bounded
      expect(state.updatedAt).toBe('2026-08-02T00:00:00.000Z');
    }
  });

  it('disabled when value missing or enabled !== true', async () => {
    mockFrom.mockReturnValue(
      chainable({ data: { value: { enabled: 'yes' }, updated_at: null }, error: null }),
    );
    const state = await readMaintenanceState();
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.enabled).toBe(false);
  });

  it('fails closed ({ok:false}) on DB read error', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: { message: 'db down' } }));
    const state = await readMaintenanceState();
    expect(state).toEqual({ ok: false });
  });

  it('MAINTENANCE_CONFIG_KEY is the bounded config key', () => {
    expect(MAINTENANCE_CONFIG_KEY).toBe('maintenance');
    expect(MAINTENANCE_CONFIG_KEY.length).toBeLessThanOrEqual(128);
  });
});

describe('createMaintenanceMiddleware', () => {
  function makeApp(opts?: { allowAdmin?: boolean; reader?: () => Promise<any> }) {
    const app = express();
    // Simulated authenticated-user injection (mirrors requireAuth).
    app.use((req: any, _res: any, next: any) => {
      req.authUser = { id: 'user-1', appRole: 'admin', active: true };
      next();
    });
    app.use(
      '/new-work',
      createMaintenanceMiddleware({
        allowAdmin: opts?.allowAdmin,
        readState: opts?.reader as any,
      }),
      (_req, res) => res.json({ ok: true }),
    );
    return app;
  }

  it('passes through when maintenance is off', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: null }));
    const res = await request(makeApp()).get('/new-work');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('blocks (503) when maintenance is on for a non-bypass gate', async () => {
    const reader = async () => ({ ok: true as const, enabled: true, reason: 'upgrade', updatedAt: null });
    const res = await request(makeApp({ reader })).get('/new-work');
    expect(res.status).toBe(503);
    expect(res.body).toEqual(maintenanceBlockedBody());
  });

  it('blocks (503) on DB-read failure — fail closed', async () => {
    const reader = async () => ({ ok: false } as const);
    const res = await request(makeApp({ reader })).get('/new-work');
    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('maintenance_mode');
  });

  it('allows authenticated admins through when maintenance is on (allowAdmin)', async () => {
    const reader = async () => ({ ok: true as const, enabled: true, reason: 'upgrade', updatedAt: null });
    const res = await request(makeApp({ allowAdmin: true, reader })).get('/new-work');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('blocks admins too when allowAdmin is not set', async () => {
    const reader = async () => ({ ok: true as const, enabled: true, reason: 'upgrade', updatedAt: null });
    const res = await request(makeApp({ reader })).get('/new-work');
    expect(res.status).toBe(503);
  });

  it('uses the live DB reader by default (maintenance on via system_config)', async () => {
    mockFrom.mockReturnValue(
      chainable({ data: { value: { enabled: true, reason: 'x' }, updated_at: null }, error: null }),
    );
    const res = await request(makeApp({ allowAdmin: false })).get('/new-work');
    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('maintenance_mode');
  });
});
