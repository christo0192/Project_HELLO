/**
 * HR cancels the 24 h pending reject (plan 6.5) and the worker's session_facts intake.
 * The RPC's own semantics (not_pending, the override monitor) are proven on Postgres by
 * app/supabase/tests/r1_scorer_assert.sql; these cover the route contract: who may call it,
 * the audited response, and the status mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
const { from, rpc } = mocks;
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import { r1InternalRouter, r1Router } from '../routes/r1.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';

const ROUND = '20000000-0000-4000-8000-000000000001';
const SESSION = '30000000-0000-4000-8000-000000000001';
const OWNER = '40000000-0000-4000-8000-000000000001';
const OTHER = '50000000-0000-4000-8000-000000000001';
const SECRET = 'r'.repeat(32);

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

function query(table: string, tables: Tables, selects: string[] = []) {
  let operation = 'select';
  let value: any;
  const filters: Array<(row: Row) => boolean> = [];
  const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const result = () => {
    if (operation === 'insert') {
      const inserted = (Array.isArray(value) ? value : [value]).map((item) => ({ ...item }));
      (tables[table] ??= []).push(...inserted);
      return { data: inserted, error: null };
    }
    return { data: rows(), error: null };
  };
  const q: any = {
    select: (columns?: string) => { if (columns) selects.push(`${table}:${columns}`); return q; },
    eq: (key: string, expected: unknown) => { filters.push((row) => row[key] === expected); return q; },
    in: (key: string, expected: unknown[]) => { filters.push((row) => expected.includes(row[key])); return q; },
    order: () => q,
    insert: (next: Row | Row[]) => { operation = 'insert'; value = next; return q; },
    maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
    single: async () => ({ data: result().data[0] ?? null, error: null }),
    then: (resolve: (x: any) => unknown, reject?: (x: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return q;
}

function tablesFor(): Tables {
  return {
    candidates: [{ id: 'cand-1', owner_id: OWNER, status: 'screened', decision_use_blocked_at: null }],
    interview_rounds: [{
      id: ROUND, candidate_id: 'cand-1', created_by: OWNER, status: 'completed', attempts_allowed: 2,
      attempts_counted: 1, expires_at: '2026-10-09T00:00:00Z', version: 4,
      recommendation: 'reject', overall: 31, status_write: 'pending_reject', pending_reject_until: '2026-10-07T10:00:00Z',
    }],
    call_sessions: [{ id: SESSION, candidate_id: 'cand-1', interview_round_id: ROUND, status: 'in_progress', external_call_id: `screening-${SESSION}`, mode: 'browser' }],
    r1_admin_log: [],
  };
}

let selects: string[];

function appFor(role: 'admin' | 'interviewer' | 'viewer', id = OWNER, tables = tablesFor()) {
  from.mockImplementation((table: string) => query(table, tables, selects));
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).authUser = { id, appRole: role };
    next();
  });
  app.use('/api', r1Router);
  return { app, tables };
}

function internalApp(tables = tablesFor()) {
  from.mockImplementation((table: string) => query(table, tables, selects));
  const app = express();
  app.use(express.json());
  app.use('/api/internal/r1', r1InternalRouter);
  return { app, tables };
}

describe('POST /api/interview-rounds/:id/cancel-pending-reject', () => {
  let originalSink: ReturnType<typeof getAuditSink>;
  let audits: AuditEntry[];

  beforeEach(() => {
    delete process.env.R1_ENABLED; // cancelling must work even with R1 switched off
    process.env.WORKER_CONTEXT_SECRET = SECRET;
    from.mockReset();
    rpc.mockReset();
    selects = [];
    audits = [];
    originalSink = getAuditSink();
    setAuditSink((entry) => { audits.push(entry); });
    return () => setAuditSink(originalSink);
  });

  it('lets the owning interviewer cancel, audits it and reports the monitor result', async () => {
    rpc.mockResolvedValue({ data: { status: 'ok', override: { disabled: false, window: 1, overrides: 1 } }, error: null });
    const { app } = appFor('interviewer');
    const response = await request(app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, auto_status_disabled: false });
    expect(rpc).toHaveBeenCalledWith('r1_cancel_pending_reject', { p_round_id: ROUND, p_actor: OWNER });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ event: 'resource.update' });
    expect(JSON.stringify(audits)).toContain('interview_round_cancel_pending_reject');
    expect(JSON.stringify(audits)).toContain(ROUND);
  });

  it('tells HR when the cancellation tripped the override monitor and switched auto-status off', async () => {
    rpc.mockResolvedValue({ data: { status: 'ok', override: { disabled: true } }, error: null });
    const { app } = appFor('admin', OTHER);
    const response = await request(app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, auto_status_disabled: true });
    expect(rpc).toHaveBeenCalledWith('r1_cancel_pending_reject', { p_round_id: ROUND, p_actor: OTHER });
  });

  it('refuses a non-owning interviewer and a viewer, without calling the RPC', async () => {
    const other = appFor('interviewer', OTHER);
    expect((await request(other.app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`)).status).toBe(403);
    const viewer = appFor('viewer', OWNER);
    expect((await request(viewer.app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`)).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('answers 400 for a bad id and 404 for an unknown round', async () => {
    const { app } = appFor('admin');
    expect((await request(app).post('/api/interview-rounds/not-a-uuid/cancel-pending-reject')).status).toBe(400);
    const unknown = '99999999-9999-4999-8999-999999999999';
    expect((await request(app).post(`/api/interview-rounds/${unknown}/cancel-pending-reject`)).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps RPC outcomes: not_pending and conflicts are 409, an RPC error is 503, nothing is audited', async () => {
    const { app } = appFor('admin');
    rpc.mockResolvedValueOnce({ data: { status: 'not_pending' }, error: null });
    let response = await request(app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'not_pending' });

    rpc.mockResolvedValueOnce({ data: { status: 'round_not_found' }, error: null });
    response = await request(app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'round_transition_conflict' });

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'db down with a secret' } });
    response = await request(app).post(`/api/interview-rounds/${ROUND}/cancel-pending-reject`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(audits).toHaveLength(0);
  });

  it('exposes the pending-reject state on the round list (visible on the card)', async () => {
    const { app } = appFor('viewer');
    const response = await request(app).get('/api/candidates/cand-1/interview-rounds');
    // The candidate id is not a UUID here, so the route rejects it; use a real one.
    expect(response.status).toBe(400);
    const tables = tablesFor();
    tables.candidates![0]!.id = '10000000-0000-4000-8000-000000000001';
    tables.interview_rounds![0]!.candidate_id = '10000000-0000-4000-8000-000000000001';
    const listed = appFor('viewer', OWNER, tables);
    const ok = await request(listed.app).get('/api/candidates/10000000-0000-4000-8000-000000000001/interview-rounds');
    expect(ok.status).toBe(200);
    expect(ok.body.rounds[0]).toMatchObject({ status_write: 'pending_reject', pending_reject_until: '2026-10-07T10:00:00Z' });
    const select = selects.find((s) => s.startsWith('interview_rounds:'))!;
    expect(select).toContain('status_write');
    expect(select).toContain('pending_reject_until');
    // The secret digest is still never selected.
    expect(select).not.toContain('link_token_digest');
  });
});

describe('POST /api/internal/r1/admin-log: session_facts', () => {
  beforeEach(() => {
    process.env.WORKER_CONTEXT_SECRET = SECRET;
    from.mockReset();
    selects = [];
  });
  const room = `screening-${SESSION}`;
  const auth = { authorization: `Bearer ${SECRET}` };

  it('accepts the worker\'s session_facts event and stores it against the R1 session', async () => {
    const { app, tables } = internalApp();
    const response = await request(app).post('/api/internal/r1/admin-log').set(auth).send({
      room,
      event_type: 'session_facts',
      payload: { roleplay_seconds: 740, first_audio_p95_ms: 2100 },
    });
    expect(response.status).toBe(201);
    expect(tables.r1_admin_log).toHaveLength(1);
    expect(tables.r1_admin_log![0]).toMatchObject({
      session_id: SESSION, round_id: ROUND, event_type: 'session_facts',
      payload: { roleplay_seconds: 740, first_audio_p95_ms: 2100 },
    });
  });

  it('still refuses an unknown event type and a missing bearer', async () => {
    const { app, tables } = internalApp();
    const bad = await request(app).post('/api/internal/r1/admin-log').set(auth).send({ room, event_type: 'made_up' });
    expect(bad.status).toBe(400);
    const anonymous = await request(app).post('/api/internal/r1/admin-log').send({ room, event_type: 'session_facts' });
    expect(anonymous.status).toBe(401);
    expect(tables.r1_admin_log).toHaveLength(0);
  });
});
