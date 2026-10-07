import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
const { from, rpc } = mocks;
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import { r1InternalRouter, r1Router } from '../routes/r1.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE = '10000000-0000-4000-8000-000000000001';
const ROUND = '20000000-0000-4000-8000-000000000001';
const SESSION = '30000000-0000-4000-8000-000000000001';
const OWNER = '40000000-0000-4000-8000-000000000001';
const OTHER = '50000000-0000-4000-8000-000000000001';
const SECRET = 'r'.repeat(32);
const DB_NOW = '2030-05-06T07:08:09.000Z';
const DB_POOL_PURE = 123.45;

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

/** A deliberately small Supabase query double. It preserves the methods this
 * router uses so the tests exercise its authorization and ordering logic. */
function query(table: string, tables: Tables) {
  let operation = 'select';
  let value: any;
  let filters: Array<(row: Row) => boolean> = [];
  const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const result = () => {
    if (operation === 'select') return { data: rows(), error: null };
    if (operation === 'insert') {
      const inserted = (Array.isArray(value) ? value : [value]).map((item) => ({ ...item, id: item.id ?? `${table}-${tables[table]!.length + 1}` }));
      (tables[table] ??= []).push(...inserted);
      return { data: inserted, error: null };
    }
    // Models the 0119 trigger: only a write that NAMES monthly_cap_minutes stamps allocation_set_at.
    const stamp = table === 'r1_settings' && 'monthly_cap_minutes' in value ? { allocation_set_at: DB_NOW } : {};
    const updated = rows().map((row) => Object.assign(row, value, stamp));
    return { data: updated, error: null };
  };
  const q: any = {
    select: () => q,
    eq: (key: string, expected: unknown) => { filters.push((row) => row[key] === expected); return q; },
    is: (key: string, expected: unknown) => { filters.push((row) => row[key] === expected); return q; },
    in: (key: string, expected: unknown[]) => { filters.push((row) => expected.includes(row[key])); return q; },
    order: () => q,
    update: (next: Row) => { operation = 'update'; value = next; return q; },
    insert: (next: Row | Row[]) => { operation = 'insert'; value = next; return q; },
    maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
    single: async () => ({ data: result().data[0] ?? null, error: null }),
    then: (resolve: (x: any) => unknown, reject?: (x: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return q;
}

function baseTables(): Tables {
  return {
    candidates: [{ id: CANDIDATE, owner_id: OWNER, status: 'new', decision_use_blocked_at: null, name: 'Ava O\'Neil', resume_text: 'must not leave this boundary' }],
    r1_settings: [{ singleton: true, enabled: true, paused: false, monthly_cap_minutes: 4000, pause_line_minutes: 4000, dashboard_minutes: 0, advance_threshold: 65, hold_threshold: 45, livekit_target: 'cloud' }],
    roles: [{ id: 'role-r1', interview_kind: 'sales_r1' }],
    interview_rounds: [], phone_engagements: [], call_sessions: [], job_queue: [],
    r1_budget_month: [{ month_start: new Date().toISOString().slice(0, 7) + '-01', minutes_used: 0, minutes_reserved: 0 }],
    interview_round_attempts: [], r1_usage_ledger: [], r1_admin_log: [], audit_events: [],
  };
}

function appFor(role: 'admin' | 'interviewer' | 'viewer', id = OWNER, tables = baseTables()) {
  from.mockImplementation((table: string) => query(table, tables));
  rpc.mockImplementation(async (fn: string, args: any) => {
    if (fn === 'r1_send_round') {
      const settings = tables.r1_settings[0];
      if (!settings.enabled || settings.paused) return { data: { status: settings.paused ? 'paused' : 'disabled' }, error: null };
      const committed = (tables.r1_budget_month[0]?.minutes_used ?? 0) + (tables.r1_budget_month[0]?.minutes_reserved ?? 0) + 55; if (committed > settings.monthly_cap_minutes || (settings.livekit_target === 'cloud' && committed > settings.pause_line_minutes)) return { data: { status: 'capacity_exhausted' }, error: null };
      if (tables.phone_engagements.some((x) => ['pending_prereqs', 'eligible', 'scheduled', 'dialing', 'in_call', 'reconnecting', 'awaiting_retry'].includes(x.state))) return { data: { status: 'phone_engagement_active' }, error: null };
      if (tables.call_sessions.some((s) => s.mode === 'live') && tables.job_queue.some((j) => j.name === 'phone.assessment')) return { data: { status: 'phone_assessment_pending' }, error: null };
      const row = { id: `round-${tables.interview_rounds.length + 1}`, status: 'invited', candidate_id: args.p_candidate_id, role_id: args.p_role_id, created_by: args.p_created_by, link_token_digest: args.p_link_token_digest, expires_at: args.p_expires_at, held_minutes: 55 };
      tables.interview_rounds.push(row); tables.r1_budget_month[0].minutes_reserved += 55;
      return { data: { status: 'ok', id: row.id, round_status: row.status, expires_at: row.expires_at }, error: null };
    }
    if (fn === 'r1_transition_round') {
      const row = tables.interview_rounds.find((r) => r.id === args.p_round_id);
      if (!row || row.version !== args.p_expected_version) return { data: { status: 'version_conflict' }, error: null };
      if (args.p_action === 'reissue' && row.status !== 'invited') return { data: { status: 'round_terminal' }, error: null };
      if (args.p_action === 'grant-retake' && !(row.status === 'completed' && row.attempts_counted === 1 && row.attempts_allowed > 1)) return { data: { status: 'retake_not_allowed' }, error: null };
      if (args.p_action === 'cancel') row.status = 'cancelled';
      if (args.p_action === 'grant-retake') { row.status = 'invited'; row.expires_at = args.p_expires_at; }
      if (args.p_action === 'reissue') { row.link_token_digest = args.p_link_token_digest; row.expires_at = args.p_expires_at; }
      row.version += 1; return { data: { status: 'ok' }, error: null };
    }
    if (fn === 'r1_record_usage') { const duplicate = tables.r1_usage_ledger.some((r) => r.session_id === args.p_session_id && r.event_key === args.p_event_key); if (!duplicate) tables.r1_usage_ledger.push({ session_id: args.p_session_id, round_id: args.p_round_id, participant_kind: args.p_participant_kind, event: args.p_event, seconds: args.p_seconds, event_key: args.p_event_key }); return { data: { duplicate }, error: null }; }
    if (fn === 'r1_stamp_dashboard_reading') {
      // Models the 0119 RPC: the DATABASE supplies the clock and the pool-estimate baseline.
      if (tables.r1_settings[0].__stampFails) return { data: null, error: { message: 'boom' } };
      const settings = tables.r1_settings[0];
      const changed = settings.dashboard_minutes !== args.p_dashboard_minutes || !settings.dashboard_read_at;
      if (changed) Object.assign(settings, { dashboard_minutes: args.p_dashboard_minutes, dashboard_read_at: DB_NOW, dashboard_estimate_baseline: DB_POOL_PURE, updated_by: args.p_updated_by });
      return { data: { status: 'ok', changed, settings: { ...settings } }, error: null };
    }
    return { data: null, error: null };
  });
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).authUser = { id, appRole: role };
    next();
  });
  app.use('/api', r1Router);
  return { app, tables };
}

function internalApp(tables = baseTables()) {
  from.mockImplementation((table: string) => query(table, tables));
  rpc.mockImplementation(async (fn: string, args: any) => { if (fn === 'r1_record_usage') { const duplicate = tables.r1_usage_ledger.some((row) => row.session_id === args.p_session_id && row.event_key === args.p_event_key); if (!duplicate) tables.r1_usage_ledger.push({ session_id: args.p_session_id, event_key: args.p_event_key }); return { data: { duplicate }, error: null }; } return { data: null, error: null }; });
  const app = express();
  app.use(express.json());
  app.use('/api/internal/r1', r1InternalRouter);
  return { app, tables };
}

describe('R1 recruiter routes', () => {
  let originalSink: ReturnType<typeof getAuditSink>;
  let audits: AuditEntry[];

  beforeEach(() => {
    process.env.R1_ENABLED = 'true';
    process.env.WORKER_CONTEXT_SECRET = SECRET;
    from.mockReset();
    rpc.mockReset();
    audits = [];
    originalSink = getAuditSink();
    setAuditSink((entry) => { audits.push(entry); });
  });

  it('sends a token-free audited one-time link with no-store', async () => {
    const { app, tables } = appFor('interviewer');
    const response = await request(app).post(`/api/candidates/${CANDIDATE}/interview-rounds`)
      .send({ india_location_attested: true });
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toContain('no-store');
    const token = response.body.join_url.split('#')[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(tables.interview_rounds[0].link_token_digest).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(tables.candidates[0].status).toBe('new');
  });

  it.each([
    ['paused', (t: Tables) => { t.r1_settings[0].paused = true; }, 'r1_paused'],
    ['cap exhausted', (t: Tables) => { t.r1_budget_month[0].minutes_used = 3946; }, 'r1_capacity_exhausted'],
    ['active phone engagement', (t: Tables) => { t.phone_engagements.push({ candidate_id: CANDIDATE, state: 'in_call' }); }, 'phone_engagement_active'],
    ['pending phone assessment', (t: Tables) => { t.call_sessions.push({ id: 'phone-session', candidate_id: CANDIDATE, mode: 'live' }); t.job_queue.push({ name: 'phone.assessment', status: 'pending', payload: { session_id: 'phone-session' } }); }, 'phone_assessment_pending'],
    ['decision-use block', (t: Tables) => { t.candidates[0].decision_use_blocked_at = '2026-01-01T00:00:00Z'; }, 'decision_use_blocked'],
  ])('refuses Send R1 when %s', async (_name, arrange, code) => {
    const tables = baseTables(); arrange(tables);
    const { app } = appFor('admin', OWNER, tables);
    const response = await request(app).post(`/api/candidates/${CANDIDATE}/interview-rounds`).send({ india_location_attested: true });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(code);
  });

  it('requires India attestation and a seeded R1 role', async () => {
    const { app } = appFor('admin');
    expect((await request(app).post(`/api/candidates/${CANDIDATE}/interview-rounds`).send({})).body.error)
      .toBe('india_location_attestation_required');
    const tables = baseTables(); tables.roles = [];
    const missing = await request(appFor('admin', OWNER, tables).app)
      .post(`/api/candidates/${CANDIDATE}/interview-rounds`).send({ india_location_attested: true });
    expect(missing.status).toBe(409);
    expect(missing.body.error).toBe('r1_role_not_configured');
  });

  it('enforces owner/admin/viewer IDOR boundaries', async () => {
    const tables = baseTables();
    tables.interview_rounds.push({ id: ROUND, candidate_id: CANDIDATE, created_by: OWNER, status: 'invited', attempts_allowed: 2, attempts_counted: 0, version: 1 });
    expect((await request(appFor('admin', OTHER, tables).app).post(`/api/interview-rounds/${ROUND}/cancel`)).status).toBe(200);
    tables.interview_rounds[0].status = 'invited';
    expect((await request(appFor('interviewer', OWNER, tables).app).post(`/api/interview-rounds/${ROUND}/cancel`)).status).toBe(200);
    tables.interview_rounds[0].status = 'invited';
    expect((await request(appFor('interviewer', OTHER, tables).app).post(`/api/interview-rounds/${ROUND}/cancel`)).status).toBe(403);
    expect((await request(appFor('viewer', OTHER, tables).app).get(`/api/candidates/${CANDIDATE}/interview-rounds`)).status).toBe(200);
    expect((await request(appFor('viewer', OTHER, tables).app).post(`/api/interview-rounds/${ROUND}/cancel`)).status).toBe(403);
  });

  it('reissues a different digest and grants only an unspent counted retake', async () => {
    const tables = baseTables();
    tables.interview_rounds.push({ id: ROUND, candidate_id: CANDIDATE, created_by: OWNER, status: 'completed', attempts_allowed: 2, attempts_counted: 1, version: 4, link_token_digest: 'a'.repeat(64) });
    const { app } = appFor('admin', OWNER, tables);
    const reissue = await request(app).post(`/api/interview-rounds/${ROUND}/reissue`);
    expect(reissue.status).toBe(409);
    // A live invite can reissue; its previous digest is replaced and never returned.
    tables.interview_rounds[0].status = 'invited';
    const live = await request(app).post(`/api/interview-rounds/${ROUND}/reissue`);
    expect(live.status).toBe(200);
    expect(tables.interview_rounds[0].link_token_digest).not.toBe('a'.repeat(64));
    expect(live.headers['cache-control']).toContain('no-store');
    tables.interview_rounds[0].status = 'completed';
    const retake = await request(app).post(`/api/interview-rounds/${ROUND}/grant-retake`);
    expect(retake.status).toBe(200);
    tables.interview_rounds[0].attempts_counted = 2;
    expect((await request(app).post(`/api/interview-rounds/${ROUND}/grant-retake`)).body.error).toBe('retake_not_allowed');
  });

  it('keeps settings admin-only and audits an update', async () => {
    const tables = baseTables();
    expect((await request(appFor('interviewer', OWNER, tables).app).get('/api/admin/r1/settings')).status).toBe(403);
    const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ paused: true, livekit_target: 'r1' });
    expect(response.status).toBe(200);
    expect(tables.r1_settings[0]).toMatchObject({ paused: true, livekit_target: 'r1', updated_by: OWNER });
    expect(audits.some((entry) => entry.event === 'resource.update' && entry.metadata?.resource === 'r1_settings')).toBe(true);
  });

  it('stamps a dashboard reading through the database RPC, never in the route', async () => {
    const { app, tables } = appFor('admin');
    const response = await request(app).put('/api/admin/r1/settings').send({ dashboard_minutes: 2500 });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    // Exactly the reading and the actor: no clock, no baseline, no pool estimate leave this process.
    expect(rpc).toHaveBeenCalledWith('r1_stamp_dashboard_reading', { p_dashboard_minutes: 2500, p_updated_by: OWNER });
    expect(response.body).toMatchObject({ dashboard_minutes: 2500, dashboard_read_at: DB_NOW, dashboard_estimate_baseline: DB_POOL_PURE, updated_by: OWNER });
    expect(tables.r1_settings[0]).toMatchObject({ dashboard_minutes: 2500, dashboard_read_at: DB_NOW, dashboard_estimate_baseline: DB_POOL_PURE });
    expect(audits.filter((entry) => entry.event === 'resource.update' && entry.metadata?.resource === 'r1_settings')).toHaveLength(1);
  });

  it('keeps other settings on the table update and sends only the reading to the stamp RPC', async () => {
    const tables = baseTables();
    const { app } = appFor('admin', OWNER, tables);
    const response = await request(app).put('/api/admin/r1/settings').send({ paused: true, monthly_cap_minutes: 1100, dashboard_minutes: '2600.5' });
    expect(response.status).toBe(200);
    expect(tables.r1_settings[0]).toMatchObject({ paused: true, monthly_cap_minutes: 1100, updated_by: OWNER, dashboard_minutes: 2600.5 });
    expect(rpc).toHaveBeenCalledWith('r1_stamp_dashboard_reading', { p_dashboard_minutes: 2600.5, p_updated_by: OWNER });
    expect(response.body.paused).toBe(true);
    expect(audits.filter((entry) => entry.metadata?.resource === 'r1_settings')).toHaveLength(1);
  });

  it('does not stamp when no dashboard reading is submitted', async () => {
    const tables = baseTables();
    const { app } = appFor('admin', OWNER, tables);
    expect((await request(app).put('/api/admin/r1/settings').send({ pause_line_minutes: 4000 })).status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect(tables.r1_settings[0].dashboard_read_at).toBeUndefined();
  });

  it.each([
    ['dashboard_read_at', '2030-01-01T00:00:00Z'],
    ['dashboard_read_at', null],
    ['dashboard_estimate_baseline', 0],
  ])('rejects a client-supplied %s and writes nothing', async (field, value) => {
    const tables = baseTables();
    const { app } = appFor('admin', OWNER, tables);
    const response = await request(app).put('/api/admin/r1/settings').send({ dashboard_minutes: 2500, paused: true, [field]: value });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_r1_settings' });
    expect(rpc).not.toHaveBeenCalled();
    expect(tables.r1_settings[0].paused).toBe(false);
    expect(tables.r1_settings[0].dashboard_read_at).toBeUndefined();
    expect(audits.filter((entry) => entry.metadata?.resource === 'r1_settings')).toHaveLength(0);
  });

  it.each([null, '', '  ', true, 'abc', -1, 100000000, Number.NaN])('rejects an unusable dashboard reading %p before any write', async (value) => {
    const tables = baseTables();
    const { app } = appFor('admin', OWNER, tables);
    const response = await request(app).put('/api/admin/r1/settings').send({ dashboard_minutes: value, paused: true });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_r1_settings' });
    expect(rpc).not.toHaveBeenCalled();
    expect(tables.r1_settings[0].paused).toBe(false);
  });

  it('fails closed with a 503 when the stamp RPC fails, still auditing a partially applied update', async () => {
    const tables = baseTables(); tables.r1_settings[0].__stampFails = true;
    const { app } = appFor('admin', OWNER, tables);
    const response = await request(app).put('/api/admin/r1/settings').send({ paused: true, dashboard_minutes: 2500 });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'service_unavailable' });
    expect(tables.r1_settings[0].paused).toBe(true);
    expect(tables.r1_settings[0].dashboard_read_at).toBeUndefined();
    expect(audits.filter((entry) => entry.metadata?.resource === 'r1_settings')).toHaveLength(1);
  });

  it('refuses Send R1 at the R1 allocation in either target, and at the pause line only for Cloud', async () => {
    const outcome = async (arrange: (t: Tables) => void) => {
      const tables = baseTables(); arrange(tables);
      return (await request(appFor('admin', OWNER, tables).app).post(`/api/candidates/${CANDIDATE}/interview-rounds`).send({ india_location_attested: true })).status;
    };
    // Allocation 54 < 55: refused even though the pause line is huge and the target is self-hosted.
    expect(await outcome((t) => { Object.assign(t.r1_settings[0], { livekit_target: 'r1', monthly_cap_minutes: 54, pause_line_minutes: 100000 }); })).toBe(409);
    // A tiny pause line never gates a self-hosted R1 ...
    expect(await outcome((t) => { Object.assign(t.r1_settings[0], { livekit_target: 'r1', monthly_cap_minutes: 1100, pause_line_minutes: 1 }); })).toBe(201);
    // ... but does gate the Cloud fallback.
    expect(await outcome((t) => { Object.assign(t.r1_settings[0], { livekit_target: 'cloud', monthly_cap_minutes: 1100, pause_line_minutes: 1 }); })).toBe(409);
  });

  describe('enabling R1 with the untouched default allocation (0119 repurposed monthly_cap_minutes)', () => {
    // 0115 created monthly_cap_minutes = 4000 as a total-pool placeholder; it is now the R1 allocation (sessions x 55).
    const untouched = () => { const tables = baseTables(); Object.assign(tables.r1_settings[0], { enabled: false }); return tables; };

    it('refuses enabled=true while the allocation is still the default 4000 and has never been saved', async () => {
      const tables = untouched();
      expect(tables.r1_settings[0]).toMatchObject({ monthly_cap_minutes: 4000, enabled: false });
      expect(tables.r1_settings[0].updated_by).toBeUndefined();
      const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ enabled: true });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'r1_allocation_not_set' });
      expect(tables.r1_settings[0].enabled).toBe(false);
      expect(tables.r1_settings[0].updated_by).toBeUndefined();
      expect(audits.filter((entry) => entry.metadata?.resource === 'r1_settings')).toHaveLength(0);
    });

    it('refuses it even when other fields ride along, and writes none of them', async () => {
      const tables = untouched();
      const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ enabled: true, paused: true, pause_line_minutes: 4000 });
      expect(response.status).toBe(409);
      expect(tables.r1_settings[0]).toMatchObject({ enabled: false, paused: false });
    });

    it.each([
      ['the request sets the allocation', (t: Tables) => { void t; }, { enabled: true, monthly_cap_minutes: 1100 }],
      ['the request deliberately sets 4000', (t: Tables) => { void t; }, { enabled: true, monthly_cap_minutes: 4000 }],
      ['the allocation was saved before', (t: Tables) => { t.r1_settings[0].allocation_set_at = DB_NOW; }, { enabled: true }],
      ['the stored allocation is not the default', (t: Tables) => { t.r1_settings[0].monthly_cap_minutes = 1100; }, { enabled: true }],
    ])('allows enabled=true when %s', async (_label, arrange, body) => {
      const tables = untouched(); arrange(tables);
      const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send(body);
      expect(response.status).toBe(200);
      expect(tables.r1_settings[0].enabled).toBe(true);
    });

    // Gate review: the guard was keyed on updated_by, which ANY settings write records (the dashboard stamp RPC sets it,
    // and so does an empty save). Only a save of the allocation itself may lift it.
    it.each([
      ['a dashboard reading was saved', { dashboard_minutes: 1200 }],
      ['an empty save was made', {}],
      ['a pause was saved', { paused: true }],
      ['a pause line was saved', { pause_line_minutes: 4000 }],
      ['thresholds were saved', { advance_threshold: 70, hold_threshold: 40 }],
    ])('keeps refusing enabled=true after %s (updated_by is set, the allocation is not)', async (_label, earlier) => {
      const tables = untouched();
      const { app } = appFor('admin', OWNER, tables);
      expect((await request(app).put('/api/admin/r1/settings').send(earlier)).status).toBe(200);
      expect(tables.r1_settings[0].updated_by).toBe(OWNER);
      expect(tables.r1_settings[0].allocation_set_at).toBeUndefined();
      const response = await request(app).put('/api/admin/r1/settings').send({ enabled: true });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'r1_allocation_not_set' });
      expect(tables.r1_settings[0].enabled).toBe(false);
      expect(tables.r1_settings[0].monthly_cap_minutes).toBe(4000);
    });

    it('lets enabled=true through once the allocation itself was saved, even a deliberate unchanged 4000', async () => {
      const tables = untouched();
      const { app } = appFor('admin', OWNER, tables);
      expect((await request(app).put('/api/admin/r1/settings').send({ dashboard_minutes: 1200 })).status).toBe(200);
      expect((await request(app).put('/api/admin/r1/settings').send({ enabled: true })).status).toBe(409);
      expect((await request(app).put('/api/admin/r1/settings').send({ monthly_cap_minutes: 4000 })).status).toBe(200);
      expect(tables.r1_settings[0].allocation_set_at).toBe(DB_NOW);
      expect((await request(app).put('/api/admin/r1/settings').send({ enabled: true })).status).toBe(200);
      expect(tables.r1_settings[0]).toMatchObject({ enabled: true, monthly_cap_minutes: 4000 });
    });

    it('rejects a client-supplied allocation_set_at and writes nothing', async () => {
      const tables = untouched();
      const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ enabled: true, allocation_set_at: DB_NOW });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_r1_settings' });
      expect(tables.r1_settings[0].enabled).toBe(false);
      expect(tables.r1_settings[0].allocation_set_at).toBeUndefined();
      expect(audits.filter((entry) => entry.metadata?.resource === 'r1_settings')).toHaveLength(0);
    });

    it('never blocks disabling or an update that does not enable', async () => {
      const tables = untouched();
      expect((await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ enabled: false })).status).toBe(200);
      expect((await request(appFor('admin', OWNER, untouched()).app).put('/api/admin/r1/settings').send({ pause_line_minutes: 4000 })).status).toBe(200);
    });

    it('rejects a non-boolean enabled so the guard cannot be sidestepped with a string', async () => {
      const tables = untouched();
      const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ enabled: 'true' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_r1_settings' });
      expect(tables.r1_settings[0].enabled).toBe(false);
    });

    it('fails closed when the stored settings cannot be read', async () => {
      const tables = untouched(); tables.r1_settings = [];
      const response = await request(appFor('admin', OWNER, tables).app).put('/api/admin/r1/settings').send({ enabled: true });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'service_unavailable' });
    });
  });

  it('reports a reissue refused for capacity as r1_capacity_exhausted, not a generic transition conflict', async () => {
    const tables = baseTables();
    tables.interview_rounds.push({ id: ROUND, candidate_id: CANDIDATE, created_by: OWNER, status: 'invited', attempts_allowed: 2, attempts_counted: 0, version: 1, expires_at: new Date(Date.now() - 1000).toISOString(), held_minutes: 55 });
    const { app } = appFor('admin', OWNER, tables);
    // A lapsed link's hold stopped counting before any sweep; the database re-checks capacity when it is revived.
    rpc.mockImplementation(async (fn: string) => (fn === 'r1_transition_round' ? { data: { status: 'capacity_exhausted' }, error: null } : { data: null, error: null }));
    const response = await request(app).post(`/api/interview-rounds/${ROUND}/reissue`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'r1_capacity_exhausted' });
    expect(audits.filter((entry) => entry.metadata?.resource === 'interview_round_reissue')).toHaveLength(0);
  });

  it.each([{ monthly_cap_minutes: 0 }, { pause_line_minutes: 1.5 }, { advance_threshold: 101 }, { hold_threshold: -1 }, { dashboard_minutes: -1 }, { livekit_target: 'elsewhere' }])('rejects invalid settings %#', async (body) => {
    const response = await request(appFor('admin').app).put('/api/admin/r1/settings').send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_r1_settings' });
  });
});

describe('R1 internal worker routes', () => {
  beforeEach(() => {
    process.env.WORKER_CONTEXT_SECRET = SECRET;
    from.mockReset();
  });

  function readyTables() {
    const tables = baseTables();
    tables.call_sessions.push({ id: SESSION, candidate_id: CANDIDATE, interview_round_id: ROUND, status: 'waiting', mode: 'browser', external_call_id: `screening-${SESSION}` });
    tables.interview_round_attempts.push({ session_id: SESSION, round_id: ROUND, attempt_number: 1, persona_id: 'p1', persona_version: 1, persona_variant: 'a', content_sha: 'b'.repeat(64) });
    return tables;
  }

  it('requires the worker bearer and a current R1 browser session', async () => {
    const { app, tables } = internalApp(readyTables());
    const body = { room: `screening-${SESSION}` };
    expect((await request(app).post('/api/internal/r1/context').send(body)).status).toBe(401);
    expect((await request(app).post('/api/internal/r1/context').set('authorization', 'Bearer wrong').send(body)).status).toBe(403);
    tables.call_sessions[0].status = 'completed';
    const denied = await request(app).post('/api/internal/r1/context').set('authorization', `Bearer ${SECRET}`).send(body);
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe('r1_session');
  });

  it('returns only a sanitized first name and writes only validated usage', async () => {
    const tables = readyTables(); tables.candidates[0].name = 'Ava O\'Neil';
    const { app } = internalApp(tables);
    const room = `screening-${SESSION}`;
    const context = await request(app).post('/api/internal/r1/context').set('authorization', `Bearer ${SECRET}`).send({ room });
    expect(context.status).toBe(200);
    expect(context.body.first_name).toBe('Ava');
    expect(JSON.stringify(context.body)).not.toMatch(/resume|o'neil/i);
    expect((await request(app).post('/api/internal/r1/usage').set('authorization', `Bearer ${SECRET}`).send({ room, participant_kind: 'candidate', seconds: -1 })).status).toBe(400);
    expect((await request(app).post('/api/internal/r1/usage').set('authorization', `Bearer ${SECRET}`).send({ room, participant_kind: 'candidate', seconds: 12, event: 'disconnect', event_key: 'first' })).status).toBe(201);
    expect((await request(app).post('/api/internal/r1/usage').set('authorization', `Bearer ${SECRET}`).send({ room, participant_kind: 'candidate', seconds: 12, event: 'disconnect', event_key: 'first' })).status).toBe(200);
    expect(tables.r1_usage_ledger).toHaveLength(1);
    expect((await request(app).post('/api/internal/r1/usage').set('authorization', `Bearer ${SECRET}`).send({ room, participant_kind: 'preflight', seconds: 16, event_key: 'bad' })).status).toBe(400);
  });

  describe('admin-log ordering contract (PR-4b must post BEFORE the terminal transition)', () => {
    const post = (app: express.Express, body: Record<string, unknown>) =>
      request(app).post('/api/internal/r1/admin-log').set('authorization', `Bearer ${SECRET}`)
        .send({ room: `screening-${SESSION}`, ...body });
    const facts = {
      event_type: 'session_facts',
      payload: {
        roleplay_seconds: 700, talk_share_pct: 50, longest_monologue_seconds: 40, barge_in_count: 0,
        question_count: 8, interruption_count: 0, first_audio_p95_ms: 2000,
      },
    };

    it('accepts session_facts while the session is waiting or in progress', async () => {
      const tables = readyTables();
      const { app } = internalApp(tables);
      expect((await post(app, facts)).status).toBe(201);
      tables.call_sessions[0].status = 'in_progress';
      expect((await post(app, facts)).status).toBe(201);
      expect(tables.r1_admin_log).toHaveLength(2);
      expect(tables.r1_admin_log[0]).toMatchObject({ session_id: SESSION, round_id: ROUND, event_type: 'session_facts' });
    });

    it.each(['completed', 'failed', 'cancelled', 'expired'])(
      'refuses session_facts with 409 r1_session once the session is %s: the row would arrive too late to be scored',
      async (status) => {
        const tables = readyTables();
        tables.call_sessions[0].status = status;
        const { app } = internalApp(tables);
        const response = await post(app, facts);
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('r1_session');
        expect(tables.r1_admin_log).toHaveLength(0);
      },
    );

    it('applies the same ordering to every admin-log event type, not only session_facts', async () => {
      const tables = readyTables();
      tables.call_sessions[0].status = 'completed';
      const { app } = internalApp(tables);
      for (const event_type of ['need_revealed', 'family_delivered', 'push_delivered', 'counter_delivered', 'discount_detected', 'guard_hit', 'time_cue']) {
        expect((await post(app, { event_type })).status, event_type).toBe(409);
      }
      expect(tables.r1_admin_log).toHaveLength(0);
    });

    it('documents the contract where the worker author will read it', () => {
      const parser = readFileSync(path.resolve(here, '../lib/r1/admin-log.ts'), 'utf8');
      expect(parser).toContain('ORDERING CONTRACT');
      expect(parser).toContain('BEFORE the session\'s terminal transition');
      const runbook = readFileSync(path.resolve(here, '../../../../docs/runbooks/r1-operations.md'), 'utf8');
      expect(runbook).toContain('Ordering: post everything BEFORE the terminal transition');
    });
  });

  it.each(['\u{1f600}', 'Robert; DROP TABLE candidates;--', 'a'.repeat(100), 'नमस्ते'])('falls back safely for unsafe worker names: %s', async (name) => {
    const tables = readyTables(); tables.candidates[0].name = name;
    const response = await request(internalApp(tables).app).post('/api/internal/r1/context').set('authorization', `Bearer ${SECRET}`).send({ room: `screening-${SESSION}` });
    expect(response.status).toBe(200);
    expect(response.body.first_name).toBe('there');
  });
});
