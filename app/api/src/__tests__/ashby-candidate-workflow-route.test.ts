/**
 * Candidate-scoped, read-only Ashby workflow status —
 *   GET /api/candidates/:id/ashby-workflow
 *   GET /api/integrations/ashby/review/:applicationLinkId/workflow
 *
 * These two addresses are ONE surface: one projection, one role rule, one
 * ownership rule. The tests below are the negative controls that keep it that
 * way:
 *   - the global auth contract rejects an unauthenticated caller;
 *   - an interviewer cannot read another owner's candidate, and the denial is
 *     byte-identical to "unknown candidate" so neither the candidate nor the
 *     workflow can be enumerated;
 *   - a malformed id is rejected before any database work;
 *   - a non-Ashby candidate is a truthful 200 `workflow: null`, not an error;
 *   - a database failure is a sanitized 500 — never a false 404 and never a
 *     false "no workflow";
 *   - the response body is key-allowlisted: no external Ashby ids, no internal
 *     row ids, no operation keys/markers/leases/tokens, no provider payloads,
 *     no PII, no free-text error detail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { finalErrorHandler } from '../lib/validation.js';
import {
  createAshbyCandidateWorkflowRouter,
  CANDIDATE_NOT_FOUND,
} from '../routes/ashby-candidate-workflow.js';
import { ashbyReviewRouter, createAshbyScopedWorkflowRoute } from '../routes/ashby-review.js';
import {
  projectCandidateWorkflow,
  createCandidateWorkflowStore,
  type CandidateAshbyWorkflowStore,
  type CandidateAshbyWorkflowView,
} from '../integrations/ashby/candidate-workflow.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT}` };

const RECRUITER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_RECRUITER_ID = '00000000-0000-4000-8000-0000000000ee';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_CANDIDATE_ID = '00000000-0000-4000-8000-000000000009';
const LINK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';

const WORKFLOW: CandidateAshbyWorkflowView = {
  lifecycle: 'writeback_pending',
  terminalState: null,
  ingestionState: 'ready',
  operations: [
    { type: 'invite_delivery', state: 'succeeded', errorCode: null },
    { type: 'scorecard_write', state: 'failed', errorCode: 'provider_5xx' },
  ],
  sessionStatus: 'completed',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

let mockFrom: any;

/** A thenable Supabase query-builder stub whose terminal value is fixed. */
function chainable(value: unknown): any {
  const fn: any = function () {
    return chainable(value);
  };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['eq', 'order', 'limit', 'select', 'is', 'in']) fn[m] = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  return fn;
}

/**
 * Candidates table fake that applies the interviewer `owner_id` filter exactly
 * as PostgREST would, so ownership denial is exercised the production way.
 */
function candidatesTable(ownerId: string, opts: { error?: unknown } = {}) {
  const builder: any = {
    _filtered: false,
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      if (column === 'owner_id' && value !== ownerId) this._filtered = true;
      return this;
    },
    maybeSingle() {
      if (opts.error) return Promise.resolve({ data: null, error: opts.error });
      return Promise.resolve({ data: this._filtered ? null : { id: CANDIDATE_ID }, error: null });
    },
  };
  return builder;
}

function makeUser(appRole: AuthUser['appRole'], id = RECRUITER_ID): AuthUser {
  return { id, email: 'recruiter@example.com', aal: 'aal2', active: true, appRole, orgId: null };
}

/**
 * A store that always answers with `WORKFLOW` unless told otherwise, and
 * records which entry point each surface actually used — the candidate page
 * must read by candidate, the link-scoped page must read by LINK.
 */
interface StubStore extends CandidateAshbyWorkflowStore {
  calls: Array<{ by: 'candidate' | 'link'; id: string }>;
}
function stubStore(
  impl?: (id: string) => Promise<CandidateAshbyWorkflowView | null>,
): StubStore {
  const answer = impl ?? (async () => WORKFLOW);
  const calls: StubStore['calls'] = [];
  return {
    calls,
    getForCandidate: (id) => {
      calls.push({ by: 'candidate', id });
      return answer(id);
    },
    getForApplicationLink: (id) => {
      calls.push({ by: 'link', id });
      return answer(id);
    },
  };
}

function makeApp(
  user: AuthUser | null,
  opts: { store?: StubStore } = {},
): express.Express {
  const store = opts.store ?? stubStore();
  const app = express();
  app.use(express.json());
  if (user) app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT) }));
  app.use('/api/candidates', createAshbyCandidateWorkflowRouter({ store }));
  // The link-scoped twin, injected the same structural way — no module global.
  app.use('/api/integrations/ashby/review', createAshbyScopedWorkflowRoute({ store }));
  app.use('/api/integrations/ashby/review', ashbyReviewRouter);
  app.use(finalErrorHandler);
  return app;
}

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
  mockFrom.mockImplementation((table: string) => {
    if (table === 'candidates') return candidatesTable(RECRUITER_ID);
    if (table === 'ashby_application_links') return chainable({ data: { candidate_id: CANDIDATE_ID }, error: null });
    throw new Error(`unexpected table ${table}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── Access control ─────────────────────────────────────────────────── */

describe('GET /api/candidates/:id/ashby-workflow — access', () => {
  it('serves admin, viewer and the owning interviewer', async () => {
    for (const role of ['admin', 'viewer', 'interviewer'] as const) {
      const store = stubStore();
      const res = await request(makeApp(makeUser(role), { store }))
        .get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`)
        .set(AUTH);
      expect(res.status, role).toBe(200);
      expect(res.body.workflow.lifecycle, role).toBe('writeback_pending');
      // Reads by candidate, with the id from the URL — never by anything else.
      expect(store.calls, role).toEqual([{ by: 'candidate', id: CANDIDATE_ID }]);
    }
  });

  it('401s an unauthenticated caller via the global auth contract', async () => {
    const res = await request(makeApp(makeUser('admin'))).get(
      `/api/candidates/${CANDIDATE_ID}/ashby-workflow`,
    );
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('403s a caller with no resolved role', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/candidates', createAshbyCandidateWorkflowRouter({ store: stubStore() }));
    app.use(finalErrorHandler);
    const res = await request(app).get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`);
    expect(res.status).toBe(403);
  });

  it('denies an interviewer another owner’s candidate, indistinguishably from unknown', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'candidates') return candidatesTable(OTHER_RECRUITER_ID);
      throw new Error(`unexpected table ${table}`);
    });
    const unowned = await request(makeApp(makeUser('interviewer')))
      .get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`)
      .set(AUTH);

    // "Unknown candidate" for an admin: no row matches at all.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'candidates') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    });
    const unknown = await request(makeApp(makeUser('admin')))
      .get(`/api/candidates/${OTHER_CANDIDATE_ID}/ashby-workflow`)
      .set(AUTH);

    for (const res of [unowned, unknown]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(CANDIDATE_NOT_FOUND);
    }
    // The denial leaks neither the candidate id nor whether a workflow exists.
    const body = JSON.stringify(unowned.body);
    expect(body).not.toContain(CANDIDATE_ID);
    expect(body).not.toMatch(/workflow|lifecycle|ashby|email|phone|name/i);
  });

  it('rejects a malformed candidate id before touching the database', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .get('/api/candidates/not-a-uuid/ashby-workflow')
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(CANDIDATE_NOT_FOUND);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('registers GET and nothing else — no write verb is routed at all', () => {
    // Asserted against the router's own stack rather than via HTTP: a 404 from
    // Express's default handler would pass whether or not a write route
    // existed behind a guard, so it would not be load-bearing.
    const router = createAshbyCandidateWorkflowRouter({ store: stubStore() }) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };
    const routes = router.stack.filter((l) => l.route).map((l) => l.route!);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/:id/ashby-workflow');
    expect(Object.keys(routes[0].methods).filter((m) => routes[0].methods[m])).toEqual(['get']);
  });
});

/* ── Truthful outcomes ──────────────────────────────────────────────── */

describe('truthful absence vs failure', () => {
  it('a non-Ashby candidate is 200 with workflow:null, not an error', async () => {
    const res = await request(makeApp(makeUser('admin'), { store: stubStore(async () => null) }))
      .get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, workflow: null });
  });

  it('a candidate-lookup failure is a sanitized 500, never a false 404', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'candidates') return candidatesTable(RECRUITER_ID, { error: { message: 'boom', code: '08006' } });
      throw new Error(`unexpected table ${table}`);
    });
    const res = await request(makeApp(makeUser('admin')))
      .get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`)
      .set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body).not.toEqual(CANDIDATE_NOT_FOUND);
    expect(JSON.stringify(res.body)).not.toMatch(/boom|08006|owner_id|supabase/i);
  });

  it('a workflow-read failure is a sanitized 500, never a false workflow:null', async () => {
    const store = stubStore(async () => {
      throw new Error('ashby_candidate_workflow_error');
    });
    const res = await request(makeApp(makeUser('admin'), { store }))
      .get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`)
      .set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body.workflow).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/ashby_candidate_workflow_error|stack|select/i);
  });
});

/* ── Response allowlist ─────────────────────────────────────────────── */

/** Every key that may appear anywhere in the response body. */
const ALLOWED_KEYS = new Set([
  'ok',
  'workflow',
  'lifecycle',
  'terminalState',
  'ingestionState',
  'operations',
  'sessionStatus',
  'updatedAt',
  'type',
  'state',
  'errorCode',
]);

function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('response key allowlist', () => {
  it('emits only allowlisted keys for a fully-populated workflow', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .get(`/api/candidates/${CANDIDATE_ID}/ashby-workflow`)
      .set(AUTH);
    expect(res.status).toBe(200);
    for (const key of collectKeys(res.body)) expect(ALLOWED_KEYS.has(key), key).toBe(true);
  });

  it('the projection drops every forbidden column even when the row carries them', () => {
    const view = projectCandidateWorkflow(
      {
        lifecycle: 'processing',
        terminal_state: null,
        session_id: SESSION_ID,
        updated_at: '2026-08-20T00:00:00.000Z',
        // Deliberately over-supplied: none of this may survive the projection.
        ...({
          id: LINK_ID,
          external_application_id: 'app_EXTERNAL',
          external_candidate_id: 'cand_EXTERNAL',
          external_job_id: 'job_EXTERNAL',
          external_stage_id: 'stage_EXTERNAL',
          external_resume_file_handle: 'handle_EXTERNAL',
          candidate_id: CANDIDATE_ID,
          terminal_reason: 'a free-text reason',
        } as Record<string, unknown>),
        ashby_resume_ingestions: [
          { state: 'scanning', ...({ id: 'ing-1', failed_reason: 'free text', provenance: { url: 'https://x' } } as Record<string, unknown>) },
        ],
        ashby_operations: [
          {
            operation_type: 'invite_delivery',
            state: 'failed',
            error_code: 'invite_deferred',
            updated_at: '2026-08-20T00:00:00.000Z',
            ...({
              id: 'op-1',
              operation_key: 'ashby:invite:app_EXTERNAL',
              error_detail: 'provider said no',
              lease_token: 'tok_SECRET',
              attempts: 3,
            } as Record<string, unknown>),
          },
        ],
      },
      'completed',
    );

    const serialized = JSON.stringify(view);
    for (const forbidden of [
      LINK_ID,
      SESSION_ID,
      CANDIDATE_ID,
      'EXTERNAL',
      'op-1',
      'ing-1',
      'operation_key',
      'lease_token',
      'tok_SECRET',
      'provider said no',
      'free text',
      'a free-text reason',
      'provenance',
      'attempts',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    for (const key of collectKeys(view)) expect(ALLOWED_KEYS.has(key), key).toBe(true);
  });
});

/* ── Projection semantics ───────────────────────────────────────────── */

describe('projectCandidateWorkflow', () => {
  it('never reports stage_move, and keeps a stable declaration order', () => {
    const view = projectCandidateWorkflow(
      {
        lifecycle: 'ready',
        updated_at: '2026-08-20T00:00:00.000Z',
        ashby_operations: [
          { operation_type: 'stage_move', state: 'pending', error_code: null, updated_at: '2026-08-20T00:00:00.000Z' },
          { operation_type: 'scorecard_write', state: 'pending', error_code: null, updated_at: '2026-08-20T00:00:00.000Z' },
          { operation_type: 'invite_delivery', state: 'succeeded', error_code: null, updated_at: '2026-08-20T00:00:00.000Z' },
        ],
      },
      null,
    );
    expect(view.operations.map((o) => o.type)).toEqual(['invite_delivery', 'scorecard_write']);
  });

  it('reports only the most recently updated row per operation type', () => {
    const view = projectCandidateWorkflow(
      {
        lifecycle: 'processing',
        updated_at: '2026-08-20T00:00:00.000Z',
        ashby_operations: [
          { operation_type: 'invite_delivery', state: 'failed', error_code: 'stale', updated_at: '2026-08-19T00:00:00.000Z' },
          { operation_type: 'invite_delivery', state: 'succeeded', error_code: null, updated_at: '2026-08-20T00:00:00.000Z' },
        ],
      },
      null,
    );
    expect(view.operations).toEqual([{ type: 'invite_delivery', state: 'succeeded', errorCode: null }]);
  });

  it('degrades unusable rows without inventing state', () => {
    const view = projectCandidateWorkflow(
      {
        // No lifecycle at all → the documented default, never `undefined`.
        ashby_resume_ingestions: null,
        ashby_operations: [
          { operation_type: 'invite_delivery', state: 42, error_code: null, updated_at: 'x' },
        ],
      },
      null,
    );
    expect(view.lifecycle).toBe('imported');
    expect(view.ingestionState).toBeNull();
    expect(view.terminalState).toBeNull();
    expect(view.operations).toEqual([]);
  });
});

/* ── Store: DB failures surface as failures ─────────────────────────── */

/**
 * A Supabase fake that RECORDS the filters applied and honours them against a
 * tiny in-memory table. The identity-stub `chainable()` above deliberately
 * ignores filters, which is fine for route-level tests but would let the only
 * tenancy scoping on a service-role read be deleted without a single failure.
 */
function filteringClient(rows: Array<Record<string, unknown>>) {
  const applied: Array<[string, unknown]> = [];
  const embedIn: Array<[string, unknown]> = [];
  const client: any = {
    applied,
    embedIn,
    from(table: string) {
      if (table === 'call_sessions') return chainable({ data: { status: 'completed' }, error: null });
      let working = rows;
      const builder: any = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        in(column: string, values: unknown) {
          embedIn.push([column, values]);
          return builder;
        },
        eq(column: string, value: unknown) {
          applied.push([column, value]);
          working = working.filter((r) => r[column] === value);
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: working, error: null }).then(resolve),
      };
      return builder;
    },
  };
  return client;
}

describe('createCandidateWorkflowStore — scoping is load-bearing', () => {
  const MINE = {
    id: LINK_ID,
    candidate_id: CANDIDATE_ID,
    provider: 'ashby',
    lifecycle: 'ready',
    terminal_state: null,
    session_id: null,
    updated_at: '2026-08-20T00:00:00.000Z',
    ashby_resume_ingestions: [{ state: 'ready' }],
    ashby_operations: [],
  };
  const SOMEONE_ELSES = {
    ...MINE,
    id: '33333333-3333-4333-8333-333333333333',
    candidate_id: OTHER_CANDIDATE_ID,
    lifecycle: 'completed',
  };

  it('scopes the candidate read to that candidate and to provider ashby', async () => {
    const client = filteringClient([SOMEONE_ELSES, MINE]);
    const view = await createCandidateWorkflowStore(client).getForCandidate(CANDIDATE_ID);
    expect(client.applied).toContainEqual(['candidate_id', CANDIDATE_ID]);
    expect(client.applied).toContainEqual(['provider', 'ashby']);
    // The other candidate's row is filtered out, not merely out-ranked.
    expect(view?.lifecycle).toBe('ready');
  });

  it('returns nothing when only another candidate’s link exists', async () => {
    const client = filteringClient([SOMEONE_ELSES]);
    await expect(
      createCandidateWorkflowStore(client).getForCandidate(CANDIDATE_ID),
    ).resolves.toBeNull();
  });

  it('scopes the link read to that link id, not to the candidate', async () => {
    const client = filteringClient([SOMEONE_ELSES, MINE]);
    const view = await createCandidateWorkflowStore(client).getForApplicationLink(LINK_ID);
    expect(client.applied).toContainEqual(['id', LINK_ID]);
    expect(client.applied.some(([c]: [string, unknown]) => c === 'candidate_id')).toBe(false);
    expect(view?.lifecycle).toBe('ready');
  });

  it('filters stage_move out at the database, not only in the projection', async () => {
    const client = filteringClient([MINE]);
    await createCandidateWorkflowStore(client).getForCandidate(CANDIDATE_ID);
    const embed = client.embedIn.find(([c]: [string, unknown]) => c === 'ashby_operations.operation_type');
    expect(embed).toBeDefined();
    expect([...(embed![1] as string[])]).toEqual(['invite_delivery', 'scorecard_write']);
  });
});

describe('createCandidateWorkflowStore', () => {
  it('throws a sanitized error on a link-read failure rather than reporting absence', async () => {
    const client: any = {
      from: () => chainable({ data: null, error: { message: 'connection reset', code: '08006' } }),
    };
    const store = createCandidateWorkflowStore(client);
    await expect(store.getForCandidate(CANDIDATE_ID)).rejects.toThrow('ashby_candidate_workflow_error');
    await expect(store.getForCandidate(CANDIDATE_ID)).rejects.not.toThrow(/connection reset|08006/);
  });

  it('returns null — not an error — when the candidate has no Ashby link', async () => {
    const client: any = { from: () => chainable({ data: [], error: null }) };
    await expect(createCandidateWorkflowStore(client).getForCandidate(CANDIDATE_ID)).resolves.toBeNull();
  });

  it('degrades a failed session read to sessionStatus:null instead of failing the card', async () => {
    const client: any = {
      from: (table: string) =>
        table === 'call_sessions'
          ? chainable({ data: null, error: { message: 'nope' } })
          : chainable({
              data: [
                {
                  lifecycle: 'ready',
                  terminal_state: null,
                  session_id: SESSION_ID,
                  updated_at: '2026-08-20T00:00:00.000Z',
                  ashby_resume_ingestions: [{ state: 'ready' }],
                  ashby_operations: [],
                },
              ],
              error: null,
            }),
    };
    const view = await createCandidateWorkflowStore(client).getForCandidate(CANDIDATE_ID);
    expect(view?.sessionStatus).toBeNull();
    expect(view?.lifecycle).toBe('ready');
  });
});

/* ── The link-scoped twin ───────────────────────────────────────────── */

describe('GET /api/integrations/ashby/review/:applicationLinkId/workflow', () => {
  it('returns the identical projection through the link scope', async () => {
    const store = stubStore();
    const res = await request(makeApp(makeUser('interviewer'), { store }))
      .get(`/api/integrations/ashby/review/${LINK_ID}/workflow`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, workflow: WORKFLOW });
  });

  it('reports the link it was ADDRESSED with, not the candidate’s newest one', async () => {
    // A candidate may hold several Ashby applications. Reading by candidate
    // here would describe a different application than the surrounding page,
    // and the card shows no job id, so the mismatch would be invisible.
    const store = stubStore();
    await request(makeApp(makeUser('interviewer'), { store }))
      .get(`/api/integrations/ashby/review/${LINK_ID}/workflow`)
      .set(AUTH);
    expect(store.calls).toEqual([{ by: 'link', id: LINK_ID }]);
    expect(store.calls.some((c) => c.by === 'candidate')).toBe(false);
  });

  it('applies the same ownership denial and the same link 404 body', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'candidates') return candidatesTable(OTHER_RECRUITER_ID);
      if (table === 'ashby_application_links') return chainable({ data: { candidate_id: CANDIDATE_ID }, error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/integrations/ashby/review/${LINK_ID}/workflow`)
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'application_link_not_found' });
    expect(JSON.stringify(res.body)).not.toContain(CANDIDATE_ID);
  });

  it('rejects a malformed link id before touching the database', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .get('/api/integrations/ashby/review/not-a-uuid/workflow')
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('turns a link-resolution failure into a sanitized 500, not a 404', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ashby_application_links') return chainable({ data: null, error: { message: 'boom' } });
      throw new Error(`unexpected table ${table}`);
    });
    const res = await request(makeApp(makeUser('admin')))
      .get(`/api/integrations/ashby/review/${LINK_ID}/workflow`)
      .set(AUTH);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/boom/i);
  });

  it('401s an unauthenticated caller', async () => {
    const res = await request(makeApp(makeUser('admin'))).get(
      `/api/integrations/ashby/review/${LINK_ID}/workflow`,
    );
    expect(res.status).toBe(401);
  });
});
