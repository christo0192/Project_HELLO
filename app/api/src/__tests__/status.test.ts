/**
 * Phase 9 L2 — GET /api/status (public, invariant 9).
 * Returns ONLY bounded operational/maintenance/degraded state + updated_at.
 * Excludes model/provider/internal dependencies and PII. Public — the
 * router itself requires no auth (L4 adds it to PUBLIC_ROUTES).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { statusRouter } from '../routes/status.js';

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

function makeApp() {
  const app = express();
  app.use('/api/status', statusRouter);
  return app;
}

describe('GET /api/status (public, bounded)', () => {
  it('no auth required — status is public', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: null }));
    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns ok when maintenance is not configured', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: null }));
    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      maintenance: null,
      updated_at: expect.any(String),
    });
  });

  it('returns maintenance state when maintenance is enabled', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: {
          value: { enabled: true, reason: 'scheduled maintenance' },
          updated_at: '2026-08-02T00:00:00.000Z',
        },
        error: null,
      }),
    );
    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('maintenance');
    expect(res.body.maintenance).toEqual({
      enabled: true,
      reason: 'scheduled maintenance',
      updated_at: '2026-08-02T00:00:00.000Z',
    });
  });

  it('returns degraded (bounded) when the DB read fails — no internals leaked', async () => {
    mockFrom.mockReturnValue(chainable({ data: null, error: { message: 'db down' } }));
    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.maintenance).toBeNull();
    // Negative control: response excludes model/provider/internal deps.
    expect(res.body.model).toBeUndefined();
    expect(res.body.provider).toBeUndefined();
    expect(res.body.database).toBeUndefined();
    expect(res.body.error).toBeUndefined();
  });

  it('negative control: status response never includes model/provider', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: { value: { enabled: false }, updated_at: '2026-08-02T00:00:00.000Z' },
        error: null,
      }),
    );
    const res = await request(makeApp()).get('/api/status');
    expect(JSON.stringify(res.body)).not.toContain('model');
    expect(JSON.stringify(res.body)).not.toContain('provider');
    expect(JSON.stringify(res.body)).not.toContain('api_key');
  });
});
