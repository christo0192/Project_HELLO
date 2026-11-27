/**
 * M035 S12 fix round (F4): HR's phone actions on a candidate the public R1 booking page imported.
 *
 * Such a candidate's only Ashby link has intake `r1_public_booking`, so `ensure_ashby_phone_engagement`
 * (reached through `request_candidate_phone_call` and `schedule_candidate_phone_appointment`) hits
 * the 0144 §3 engagement guard, which raises P0001 with one closed message and rolls everything
 * back. The routes answer that as a plain, permanent `409 not_phone_screened`, never the 503 "phone
 * request unavailable" an outage gets, and never with a warning that reads like one. Any other
 * database error still answers 503.
 *
 * HTTP tests run against the real candidatesRouter with a mocked supabase module (no network, no
 * database).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidatesRouter, NOT_PHONE_SCREENED } from '../routes/candidates.js';
import { finalErrorHandler } from '../lib/validation.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import {
  R1_PUBLIC_BOOKING_ENGAGEMENT_REFUSAL,
  isR1PublicBookingEngagementRefusal,
} from '../integrations/ashby/orchestration.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0144 = readFileSync(path.resolve(here, '../../../supabase/migrations/0144_r1_meet_public_import.sql'), 'utf8');

const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const CANDIDATE_ID = '7f144000-0000-4000-8000-001000000401';

/** The error PostgREST relays for the 0144 §3 guard. */
const GUARD_ERROR = { code: 'P0001', message: R1_PUBLIC_BOOKING_ENGAGEMENT_REFUSAL, details: null, hint: null };

/** Per-table chainable answer. */
function tableChain(value: unknown): any {
  const fn: any = function () { return tableChain(value); };
  fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'single', 'gt', 'gte', 'lt', 'lte', 'neq']) {
    fn[m] = () => tableChain(value);
  }
  return fn;
}

let mockFrom: any;
let mockRpc: any;
let originalSink: ReturnType<typeof getAuditSink>;
let audited: AuditEntry[];

function tables() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'candidates') return tableChain({ data: { id: CANDIDATE_ID, owner_id: ACTOR_ID }, error: null });
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(async () => {
  process.env.PHONE_SCREENING_ENABLED = 'true';
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockRpc = (mod.supabase as any).rpc;
  mockFrom.mockReset();
  mockRpc.mockReset();
  originalSink = getAuditSink();
  audited = [];
  setAuditSink((entry) => { audited.push(entry); });
});

afterEach(() => {
  setAuditSink(originalSink);
  delete process.env.PHONE_SCREENING_ENABLED;
  vi.restoreAllMocks();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: ACTOR_ID, appRole: 'admin' };
    next();
  });
  app.use('/api/candidates', candidatesRouter);
  app.use(finalErrorHandler);
  return app;
}

/** Every line console.warn / console.error got while `fn` ran. */
async function loud(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  await fn();
  return lines;
}

describe('the guard refusal is recognised exactly', () => {
  it('the constant is the closed message 0144 §3 raises', () => {
    const raised = [...MIGRATION_0144.matchAll(/raise exception '([^']*)'\s+using errcode = 'P0001';/g)].map((m) => m[1]);
    expect(raised).toContain(R1_PUBLIC_BOOKING_ENGAGEMENT_REFUSAL);
    expect(raised.filter((m) => m === R1_PUBLIC_BOOKING_ENGAGEMENT_REFUSAL)).toHaveLength(1);
    expect(NOT_PHONE_SCREENED).toBe('not_phone_screened');
  });

  it('only that code and that message', () => {
    expect(isR1PublicBookingEngagementRefusal(GUARD_ERROR)).toBe(true);
    expect(isR1PublicBookingEngagementRefusal({ ...GUARD_ERROR, code: 'XX000' })).toBe(false);
    expect(isR1PublicBookingEngagementRefusal({ ...GUARD_ERROR, message: 'r1_public_booking: a public booking import never gets a resume ingestion' })).toBe(false);
    expect(isR1PublicBookingEngagementRefusal({ code: 'P0001', message: 'something else' })).toBe(false);
    for (const value of [null, undefined, 'P0001', 1, [], {}]) expect(isR1PublicBookingEngagementRefusal(value)).toBe(false);
  });
});

describe('POST /api/candidates/:id/phone-call on a public booking import', () => {
  it('answers 409 not_phone_screened, audits the refusal, and writes no warning', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: null, error: GUARD_ERROR });
    let res: request.Response | undefined;
    const lines = await loud(async () => {
      res = await request(makeApp()).post(`/api/candidates/${CANDIDATE_ID}/phone-call`).send({ confirm: true });
    });
    expect(res!.status).toBe(409);
    expect(res!.body).toEqual({ ok: false, error: 'not_phone_screened' });
    expect(mockRpc.mock.calls.map((c: unknown[]) => c[0])).toEqual(['request_candidate_phone_call']);
    expect(lines.filter((l) => l.includes('rpc_failed'))).toEqual([]);
    const audit = audited.filter((e) => (e.metadata as { resource?: unknown } | undefined)?.resource === 'phone_call_request');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.statusCode).toBe(409);
    expect(audit[0]!.metadata).toMatchObject({ resource: 'phone_call_request', status: 'not_phone_screened' });
    // The body carries no message text, id or value.
    expect(JSON.stringify(res!.body)).not.toContain(CANDIDATE_ID);
    expect(JSON.stringify(res!.body)).not.toContain('r1_public_booking:');
  });

  it('control: any other database error is still 503 phone_request_unavailable', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' } });
    const res = await request(makeApp()).post(`/api/candidates/${CANDIDATE_ID}/phone-call`).send({ confirm: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'phone_request_unavailable' });
  });
});

describe('POST /api/candidates/:id/phone-appointments on a public booking import', () => {
  const BODY = { starts_at: '2026-12-04T05:30:00.000Z', ends_at: '2026-12-04T06:00:00.000Z' };

  it('answers 409 not_phone_screened and books nothing', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: null, error: GUARD_ERROR });
    const res = await request(makeApp()).post(`/api/candidates/${CANDIDATE_ID}/phone-appointments`).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'not_phone_screened' });
    expect(mockRpc.mock.calls.map((c: unknown[]) => c[0])).toEqual(['schedule_candidate_phone_appointment']);
  });

  it('control: any other database error is still 503 phone_schedule_unavailable', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'another raise' } });
    const res = await request(makeApp()).post(`/api/candidates/${CANDIDATE_ID}/phone-appointments`).send(BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'phone_schedule_unavailable' });
  });
});
