/**
 * DELETE /api/roles/:id — three outcomes, and why it is not one.
 *
 * `screening_v2.roles` is referenced six ways and the foreign keys disagree:
 * `candidates.role_id` and `sessions.role_id` are ON DELETE SET NULL,
 * `role_scorecards` is CASCADE, and `ashby_job_mappings.role_id` is NOT NULL
 * ON DELETE RESTRICT. So a plain delete would detach every candidate who ever
 * applied for a job from the job they applied for — the record survives and
 * stops saying what it was for — and would cascade away the scorecard the
 * historical assessments were scored against.
 *
 * These tests exist because that damage is INVISIBLE from the operator's side:
 * the card disappears either way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/audit.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

const { rolesRouter } = await import('../routes/roles.js');
const { supabase } = await import('../lib/supabase.js');
const { recordAudit } = await import('../lib/audit.js');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT}` };
const OWNER = '00000000-0000-4000-8000-0000000000ff';
const ROLE = '11111111-1111-4111-8111-111111111111';

/** Per-table behaviour for one test. */
interface Scenario {
  /** The ownership read. `null` = not found / not owned. */
  role: { id: string } | null;
  mappings: number;
  candidates: number;
  sessions: number;
  /** Rows the update/delete write reports back. */
  written?: { id: string } | null;
}
let scenario: Scenario;
/** Every table a request touched, with the operation. */
let touched: Array<{ table: string; op: string; filters: Array<[string, unknown]> }>;

function chain(table: string): any {
  const call = { table, op: 'select', filters: [] as Array<[string, unknown]> };
  touched.push(call);
  const counts: Record<string, number> = {
    ashby_job_mappings: scenario.mappings,
    candidates: scenario.candidates,
    sessions: scenario.sessions,
  };
  const self: any = {
    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      // A HEAD+count read is the reference check; anything else is a row read.
      if (opts?.count) self.__count = counts[table] ?? 0;
      return self;
    },
    eq(col: string, val: unknown) {
      call.filters.push([col, val]);
      return self;
    },
    update(payload: Record<string, unknown>) {
      call.op = 'update';
      self.__payload = payload;
      return self;
    },
    delete() {
      call.op = 'delete';
      return self;
    },
    maybeSingle: () =>
      Promise.resolve({
        data:
          call.op === 'select'
            ? scenario.role
            : scenario.written === undefined
              ? { id: ROLE }
              : scenario.written,
        error: null,
      }),
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ count: self.__count ?? 0, data: [], error: null }).then(res),
  };
  return self;
}

function app(appRole: AuthUser['appRole'] = 'interviewer') {
  const user: AuthUser = {
    id: OWNER,
    email: 'r@example.com',
    aal: 'aal2',
    active: true,
    appRole,
    orgId: null,
  };
  const a = express();
  a.use(express.json());
  a.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT) }));
  a.use('/api/roles', rolesRouter);
  a.use(finalErrorHandler);
  return a;
}

const del = (role = 'interviewer' as AuthUser['appRole']) =>
  request(app(role)).delete(`/api/roles/${ROLE}`).set(AUTH);

beforeEach(() => {
  touched = [];
  scenario = { role: { id: ROLE }, mappings: 0, candidates: 0, sessions: 0 };
  vi.mocked(supabase.from).mockImplementation((t: string) => chain(t) as never);
  vi.mocked(recordAudit).mockResolvedValue(undefined as never);
});
afterEach(() => vi.clearAllMocks());

describe('DELETE /api/roles/:id', () => {
  it('DELETES a role nothing references', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'deleted' });
    expect(touched.some((t) => t.table === 'roles' && t.op === 'delete')).toBe(true);
  });

  it('ARCHIVES rather than deletes when candidates reference it', async () => {
    // THE WHOLE POINT. `candidates.role_id` is ON DELETE SET NULL, so a hard
    // delete would leave every screened candidate pointing at nothing — the
    // row survives and silently stops saying which job it was for.
    scenario.candidates = 12;
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('archived');
    expect(res.body.candidates).toBe(12);
    const write = touched.find((t) => t.table === 'roles' && t.op === 'update');
    expect(write, 'it must UPDATE, never delete').toBeTruthy();
    expect(touched.some((t) => t.table === 'roles' && t.op === 'delete')).toBe(false);
  });

  it('ARCHIVES when only sessions reference it', async () => {
    // Sessions outlive candidates in some flows, and a call record that no
    // longer names its role is just as lossy.
    scenario.sessions = 3;
    const res = await del();
    expect(res.body.outcome).toBe('archived');
    expect(res.body.sessions).toBe(3);
  });

  it('REFUSES when an Ashby job is mapped to it, and changes nothing', async () => {
    // That key is ON DELETE RESTRICT, so the database would refuse anyway —
    // answering with the reason beats surfacing a constraint error, and the
    // message names the screen where the mapping can be removed.
    scenario.mappings = 1;
    const res = await del();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Ashby Mission Control/);
    expect(touched.some((t) => t.table === 'roles' && t.op !== 'select')).toBe(false);
  });

  it('SCOPES THE OWNERSHIP READ to the caller for an interviewer', async () => {
    await del('interviewer');
    const read = touched.find((t) => t.table === 'roles');
    expect(read?.filters).toContainEqual(['owner_id', OWNER]);
  });

  it('does NOT scope an admin to their own roles', async () => {
    await del('admin');
    const read = touched.find((t) => t.table === 'roles');
    expect(read?.filters.some(([col]) => col === 'owner_id')).toBe(false);
  });

  it('404s a role the caller does not own, without touching anything', async () => {
    scenario.role = null;
    const res = await del();
    expect(res.status).toBe(404);
    expect(touched.some((t) => t.op !== 'select')).toBe(false);
  });

  it('refuses a viewer', async () => {
    const res = await del('viewer');
    expect(res.status).toBe(403);
  });

  it('FAILS CLOSED when the audit sink dies', async () => {
    // A delete whose record was lost is the one an operator will most want to
    // look up. Every other mutation on this router is fail-closed; this one
    // must not be the exception.
    vi.mocked(recordAudit).mockRejectedValue(new Error('sink down') as never);
    const res = await del();
    expect(res.status).toBe(500);
  });
});
