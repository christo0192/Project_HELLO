/**
 * GET /api/roles — the `has_ashby_mapping` flag (M008).
 *
 * The Dashboard and Candidates role filters list only roles that have an
 * Ashby job mapping. They used to work that out from the Mission Control
 * mappings list, which a viewer cannot read (403 → every role listed), which
 * is capped at the 200 newest rows (older mapped roles vanished), and which
 * writes an audit row per read. The flag moved onto the roles list, so these
 * tests pin what it means:
 *
 *  - true iff a NON-ARCHIVED mapping names the role, whatever its status;
 *  - an archived-only role is false (a deleted mapping is not a mapped job);
 *  - the interviewer owner filter still applies;
 *  - ONE mapping read for the page (not one per role), and no audit write.
 *
 * The mock applies the filters the route puts on the query to an in-memory
 * table, so a route that forgot `.is('archived_at', null)` sees the archived
 * row and the archived-only test fails.
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
const ME = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

const R_LIVE = '11111111-1111-4111-8111-000000000001';
const R_PAUSED = '11111111-1111-4111-8111-000000000002';
const R_DRIFT = '11111111-1111-4111-8111-000000000003';
const R_ARCHIVED_ONLY = '11111111-1111-4111-8111-000000000004';
const R_NONE = '11111111-1111-4111-8111-000000000005';
const R_OTHERS = '11111111-1111-4111-8111-000000000006';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
/** Every query the route ran: table + filters, in order. */
let queries: Array<{ table: string; filters: Array<[string, string, unknown]> }>;
/** When set, the named table answers with this error. */
let failTable: string | null;

function chain(table: string): any {
  if (!(table in tables)) throw new Error(`unexpected table ${table}`);
  const q = { table, filters: [] as Array<[string, string, unknown]> };
  queries.push(q);
  const self: any = {
    select: () => self,
    order: () => self,
    eq(col: string, val: unknown) {
      q.filters.push(['eq', col, val]);
      return self;
    },
    is(col: string, val: unknown) {
      q.filters.push(['is', col, val]);
      return self;
    },
    in(col: string, vals: unknown[]) {
      q.filters.push(['in', col, vals]);
      return self;
    },
    then(resolve: (v: unknown) => unknown) {
      if (failTable === table) {
        return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }).then(resolve);
      }
      const rows = tables[table].filter((row) =>
        q.filters.every(([op, col, val]) =>
          op === 'eq'
            ? row[col] === val
            : op === 'is'
              ? row[col] === val
              : (val as unknown[]).includes(row[col]),
        ),
      );
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return self;
}

function app(appRole: AuthUser['appRole']) {
  const user: AuthUser = { id: ME, email: 'me@example.com', aal: 'aal2', active: true, appRole, orgId: null };
  const a = express();
  a.use(express.json());
  a.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT) }));
  a.use('/api/roles', rolesRouter);
  a.use(finalErrorHandler);
  return a;
}

const list = (appRole: AuthUser['appRole'] = 'admin') => request(app(appRole)).get('/api/roles').set(AUTH);

const role = (id: string, owner = ME): Row => ({
  id,
  title: `Role ${id.slice(-1)}`,
  owner_id: owner,
  is_active: true,
  created_at: '2026-09-01T00:00:00Z',
});
const mapping = (roleId: string, status: string, archived = false): Row => ({
  role_id: roleId,
  status,
  archived_at: archived ? '2026-09-10T00:00:00Z' : null,
});

beforeEach(() => {
  failTable = null;
  queries = [];
  tables = {
    roles: [
      role(R_LIVE),
      role(R_PAUSED),
      role(R_DRIFT),
      role(R_ARCHIVED_ONLY),
      role(R_NONE),
      role(R_OTHERS, OTHER),
    ],
    ashby_job_mappings: [
      mapping(R_LIVE, 'enabled'),
      mapping(R_LIVE, 'paused'),
      mapping(R_PAUSED, 'paused'),
      mapping(R_DRIFT, 'drift'),
      mapping(R_ARCHIVED_ONLY, 'enabled', true),
      mapping(R_OTHERS, 'enabled'),
    ],
  };
  vi.mocked(supabase.from).mockImplementation((t: string) => chain(t) as never);
});
afterEach(() => vi.clearAllMocks());

const flags = (body: Array<{ id: string; has_ashby_mapping: unknown }>) =>
  Object.fromEntries(body.map((r) => [r.id, r.has_ashby_mapping]));

describe('GET /api/roles — has_ashby_mapping', () => {
  it('is true for a role with a live, paused or drift mapping and false with none', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(flags(res.body)).toEqual({
      [R_LIVE]: true,
      [R_PAUSED]: true,
      [R_DRIFT]: true,
      [R_ARCHIVED_ONLY]: false,
      [R_NONE]: false,
      [R_OTHERS]: true,
    });
  });

  it('is false for a role whose only mapping is archived', async () => {
    const res = await list();
    const archivedOnly = res.body.find((r: { id: string }) => r.id === R_ARCHIVED_ONLY);
    expect(archivedOnly.has_ashby_mapping).toBe(false);
  });

  it('is a boolean on EVERY row and leaves the rest of the row untouched', async () => {
    const res = await list();
    expect(res.body).toHaveLength(6);
    for (const row of res.body) expect(typeof row.has_ashby_mapping).toBe('boolean');
    const live = res.body.find((r: { id: string }) => r.id === R_LIVE);
    expect(live).toEqual({ ...role(R_LIVE), has_ashby_mapping: true });
  });

  it('keeps the interviewer owner filter, and flags only the rows they see', async () => {
    const res = await list('interviewer');
    expect(res.status).toBe(200);
    const roleQuery = queries.find((q) => q.table === 'roles');
    expect(roleQuery?.filters).toContainEqual(['eq', 'owner_id', ME]);
    expect(res.body.map((r: { id: string }) => r.id)).not.toContain(R_OTHERS);
    expect(flags(res.body)[R_LIVE]).toBe(true);
    const mappingQuery = queries.find((q) => q.table === 'ashby_job_mappings');
    const inFilter = mappingQuery?.filters.find(([op]) => op === 'in');
    expect(inFilter?.[2]).not.toContain(R_OTHERS);
  });

  it('reads mappings ONCE for the page, scoped to the listed roles and to non-archived rows', async () => {
    await list();
    const mappingQueries = queries.filter((q) => q.table === 'ashby_job_mappings');
    expect(mappingQueries).toHaveLength(1);
    expect(mappingQueries[0].filters).toContainEqual(['is', 'archived_at', null]);
    const inFilter = mappingQueries[0].filters.find(([op]) => op === 'in');
    expect([...(inFilter?.[2] as string[])].sort()).toEqual(
      [R_LIVE, R_PAUSED, R_DRIFT, R_ARCHIVED_ONLY, R_NONE, R_OTHERS].sort(),
    );
  });

  it('writes no audit row (it is the same unaudited viewer read it always was)', async () => {
    const res = await list('viewer');
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('skips the mapping read and answers [] when there are no roles', async () => {
    tables.roles = [];
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(queries.some((q) => q.table === 'ashby_job_mappings')).toBe(false);
  });

  it('propagates a mapping read error like a roles read error (500, no partial list)', async () => {
    failTable = 'ashby_job_mappings';
    const res = await list();
    expect(res.status).toBe(500);
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('still propagates a roles read error', async () => {
    failTable = 'roles';
    const res = await list();
    expect(res.status).toBe(500);
    expect(queries.some((q) => q.table === 'ashby_job_mappings')).toBe(false);
  });
});
