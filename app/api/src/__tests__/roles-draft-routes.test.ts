/**
 * The three Ask Hello endpoints, and the `agent_name` round-trip.
 *
 * These routes are short on purpose — the work lives in `role-draft-jobs.ts`.
 * What is worth testing here is everything a short route can still get wrong:
 * who may call it, whether a dead audit sink can lose a draft, whether the
 * caller's own id is what scopes the read (rather than anything they sent),
 * and whether a field the form writes actually survives to the database.
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

/** Payloads handed to `.insert()`, so a route test can assert what it SENDS. */
let inserted: Array<Record<string, unknown>> = [];
/**
 * Payloads handed to `.update()`.
 *
 * The recorder had no `update` method, so no route-level PATCH test existed
 * and the PUT-side `agent_name` guard — the exact twin of the POST-side one
 * three tests up — could be made unconditional with the whole suite green.
 */
let patched: Array<Record<string, unknown>> = [];
function insertRecorder(): any {
  const self: any = {
    insert(payload: Record<string, unknown>) {
      inserted.push(payload);
      return self;
    },
    update(payload: Record<string, unknown>) {
      patched.push(payload);
      return self;
    },
    select: () => self,
    eq: () => self,
    single: () =>
      Promise.resolve({ data: { id: 'role-1', ...(inserted.at(-1) ?? {}) }, error: null }),
    maybeSingle: () =>
      Promise.resolve({ data: { id: 'role-1', ...(inserted.at(-1) ?? {}) }, error: null }),
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: 'role-1' }], error: null }).then(res),
  };
  return self;
}
vi.mock('../lib/role-draft-jobs.js', async () => ({
  // The real class — but NOT, as an earlier comment here claimed, because a
  // stub would let the 409 test pass while production 500s. It would not:
  // the route imports `RoleDraftBusyError` from this same mocked module and
  // the test throws `new jobs.RoleDraftBusyError(...)` from the same binding,
  // so `instanceof` holds against whatever class the mock supplies. A review
  // proved it by substituting a local class; 27/27 stayed green.
  //
  // It is kept because using the real class costs nothing and keeps the
  // constructor signature honest, and the false sentence is replaced because
  // a comment asserting a protection that does not exist is worse than no
  // comment — the next reviewer trusts it instead of re-checking.
  RoleDraftBusyError: (await vi.importActual<typeof import('../lib/role-draft-jobs.js')>(
    '../lib/role-draft-jobs.js',
  )).RoleDraftBusyError,
  startRoleDraft: vi.fn(),
  readRoleDraft: vi.fn(),
  readActiveRoleDraft: vi.fn(),
  cancelRoleDraft: vi.fn(),
  ROLE_DRAFT_STALE_MS: 720_000,
}));
vi.mock('../lib/audit.js', () => ({ recordAudit: vi.fn() }));

const { rolesRouter } = await import('../routes/roles.js');
const jobs = await import('../lib/role-draft-jobs.js');
const { recordAudit } = await import('../lib/audit.js');
const { supabase } = await import('../lib/supabase.js');
const { createRoleSchema, updateRoleSchema } = await import('../schemas/roles.js');

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };
const OWNER = '00000000-0000-4000-8000-0000000000ff';
const DRAFT_ID = '00000000-0000-4000-8000-000000000011';

const JOB = {
  id: DRAFT_ID,
  job_role: 'Sales Advisor',
  status: 'running' as const,
  phase: null,
  draft: null,
  attempts: 0,
  repaired: [],
  error_reason: null,
  error_message: null,
  max_attempts: 3,
  created_at: '2026-09-22T10:00:00.000Z',
};

function makeUser(role: AuthUser['appRole']): AuthUser {
  return {
    id: OWNER,
    email: 'recruiter@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
  };
}

function app(role: AuthUser['appRole'] = 'interviewer') {
  const a = express();
  a.use(express.json());
  a.use(createRequireAuth({ getUser: mockAuthGetUser(makeUser(role), JWT_AAL2) }));
  a.use('/api/roles', rolesRouter);
  a.use(finalErrorHandler);
  return a;
}

beforeEach(() => {
  vi.mocked(jobs.startRoleDraft).mockReset().mockResolvedValue(JOB);
  vi.mocked(jobs.readRoleDraft).mockReset().mockResolvedValue(JOB);
  vi.mocked(jobs.readActiveRoleDraft).mockReset().mockResolvedValue(null);
  vi.mocked(jobs.cancelRoleDraft).mockReset().mockResolvedValue(true);
  vi.mocked(recordAudit).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(supabase.from).mockReset();
  inserted = [];
  patched = [];
});
afterEach(() => vi.restoreAllMocks());

describe('POST /api/roles/draft', () => {
  it('answers 202 with the job, not a finished draft', async () => {
    // 202, not 200: the work has been accepted, and it has certainly not
    // happened yet — three v4-pro calls at 133-206s each are still to come.
    const res = await request(app()).post('/api/roles/draft').set(AUTH).send({
      job_role: 'Sales Advisor',
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: DRAFT_ID, status: 'running' });
    expect(jobs.startRoleDraft).toHaveBeenCalledWith(OWNER, 'Sales Advisor');
  });

  it('REFUSES A BODY-SUPPLIED OWNER outright', async () => {
    // The owner id is the only thing separating one recruiter's drafts from
    // another's. The route reads it from the session (asserted above), and the
    // schema is strict so a caller cannot even offer an alternative — a
    // stripped extra key would be a quieter version of the same mistake.
    const res = await request(app())
      .post('/api/roles/draft')
      .set(AUTH)
      .send({ job_role: 'Sales Advisor', owner_id: 'someone-else' });
    expect(res.status).toBe(400);
    expect(jobs.startRoleDraft).not.toHaveBeenCalled();
  });

  it('answers 409, not 500, when a DIFFERENT role is already drafting', async () => {
    // One live draft per owner is a real constraint — each start detaches up
    // to six v4-pro calls. The honest answer names the role holding it; the
    // alternative that shipped briefly was handing back the other role's job,
    // which put a Sales Advisor script into a form headed "Data Engineer".
    vi.mocked(jobs.startRoleDraft).mockRejectedValue(new jobs.RoleDraftBusyError('Sales Advisor'));
    const res = await request(app()).post('/api/roles/draft').set(AUTH).send({
      job_role: 'Data Engineer',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('conflict');
    expect(res.body.error.message).toContain('Sales Advisor');
    expect(res.body.error.details.job_role).toBe('Sales Advisor');
  });

  it('still 500s on an ordinary failure — the 409 is not a catch-all', async () => {
    vi.mocked(jobs.startRoleDraft).mockRejectedValue(new Error('connection failure'));
    const res = await request(app()).post('/api/roles/draft').set(AUTH).send({
      job_role: 'Data Engineer',
    });
    expect(res.status).toBe(500);
  });

  it('refuses a viewer', async () => {
    // Drafting spends money on a model and produces text one Save away from
    // being read to a candidate. Read-only is read-only.
    const res = await request(app('viewer')).post('/api/roles/draft').set(AUTH).send({
      job_role: 'Sales Advisor',
    });
    expect(res.status).toBe(403);
    expect(jobs.startRoleDraft).not.toHaveBeenCalled();
  });

  it('rejects an empty job role', async () => {
    const res = await request(app()).post('/api/roles/draft').set(AUTH).send({ job_role: '   ' });
    expect(res.status).toBe(400);
    expect(jobs.startRoleDraft).not.toHaveBeenCalled();
  });

  it('AUDITS the draft', async () => {
    // It writes no role, but it is a privileged, model-invoking action whose
    // output is one Save away from being spoken to a candidate. Who asked for
    // what belongs in the record.
    await request(app()).post('/api/roles/draft').set(AUTH).send({ job_role: 'Sales Advisor' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      'resource.generate',
      202,
      expect.objectContaining({
        metadata: expect.objectContaining({ draft_id: DRAFT_ID, job_role: 'Sales Advisor' }),
      }),
    );
  });

  it('does NOT fail closed on a dead audit sink', async () => {
    // Deliberately unlike a mutation. This route writes nothing, so a broken
    // audit sink must not cost the operator a ten-minute draft — the rule that
    // protects data has no data to protect here.
    vi.mocked(recordAudit).mockRejectedValue(new Error('audit sink down'));
    const res = await request(app()).post('/api/roles/draft').set(AUTH).send({
      job_role: 'Sales Advisor',
    });
    expect(res.status).toBe(202);
    expect(jobs.startRoleDraft).toHaveBeenCalled();
  });
});

describe('GET /api/roles/draft', () => {
  // THE ROUTE THAT WAS DEAD ON ARRIVAL.
  //
  // `GET '/:id'` was registered first, and `:id` matches ANY single segment —
  // including the literal `draft`. So every call landed in the id route,
  // `roleIdParamSchema` rejected "draft" as a non-uuid, and the caller got a
  // 400. The client swallows a failed resume (it is a convenience, not a
  // precondition), so the only symptom was a refresh that silently did not
  // resume while the job kept billing.
  //
  // These tests go through the WHOLE router rather than the handler, because
  // the handler was never the thing that was broken.

  it('returns the live job', async () => {
    vi.mocked(jobs.readActiveRoleDraft).mockResolvedValue(JOB);
    const res = await request(app()).get('/api/roles/draft').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.active?.id).toBe(DRAFT_ID);
    expect(jobs.readActiveRoleDraft).toHaveBeenCalledWith(OWNER);
  });

  it('IS NOT SHADOWED by GET /api/roles/:id', async () => {
    // The regression itself, named. A 400 here means the id route ate it.
    vi.mocked(jobs.readActiveRoleDraft).mockResolvedValue(null);
    const res = await request(app()).get('/api/roles/draft').set(AUTH);
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
    expect(jobs.readActiveRoleDraft).toHaveBeenCalled();
  });

  it('answers 200 with an explicit null when nothing is running', async () => {
    // Not 404. "You have no draft running" is a normal answer to this
    // question, not a missing resource.
    vi.mocked(jobs.readActiveRoleDraft).mockResolvedValue(null);
    const res = await request(app()).get('/api/roles/draft').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: null });
  });

  it('scopes the read to the authenticated user', async () => {
    await request(app()).get('/api/roles/draft').set(AUTH);
    expect(jobs.readActiveRoleDraft).toHaveBeenCalledWith(OWNER);
  });

  it('refuses a viewer', async () => {
    const res = await request(app('viewer')).get('/api/roles/draft').set(AUTH);
    expect(res.status).toBe(403);
    expect(jobs.readActiveRoleDraft).not.toHaveBeenCalled();
  });
});

describe('GET /api/roles/draft/:id', () => {
  it('returns the job', async () => {
    const res = await request(app()).get(`/api/roles/draft/${DRAFT_ID}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DRAFT_ID);
    expect(jobs.readRoleDraft).toHaveBeenCalledWith(OWNER, DRAFT_ID);
  });

  it('404s rather than inventing a running job', async () => {
    // A poll that answered "still running" for a draft that does not exist
    // would spin forever, which is the failure this whole surface exists to
    // stop.
    vi.mocked(jobs.readRoleDraft).mockResolvedValue(null);
    const res = await request(app()).get(`/api/roles/draft/${DRAFT_ID}`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it('refuses a non-uuid id at the door', async () => {
    const res = await request(app()).get('/api/roles/draft/not-a-uuid').set(AUTH);
    expect(res.status).toBe(400);
    expect(jobs.readRoleDraft).not.toHaveBeenCalled();
  });

  it('refuses a viewer', async () => {
    const res = await request(app('viewer')).get(`/api/roles/draft/${DRAFT_ID}`).set(AUTH);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/roles/draft/:id/cancel', () => {
  it('reports whether this call is what stopped it', async () => {
    const res = await request(app()).post(`/api/roles/draft/${DRAFT_ID}/cancel`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    expect(jobs.cancelRoleDraft).toHaveBeenCalledWith(OWNER, DRAFT_ID);
  });

  it('is IDEMPOTENT — a losing race is 200 false, not an error', async () => {
    // The operator presses Cancel as the draft lands. That is a race they
    // cannot be blamed for, and an error would be the wrong answer to it.
    vi.mocked(jobs.cancelRoleDraft).mockResolvedValue(false);
    const res = await request(app()).post(`/api/roles/draft/${DRAFT_ID}/cancel`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: false });
  });

  it('refuses a viewer', async () => {
    const res = await request(app('viewer')).post(`/api/roles/draft/${DRAFT_ID}/cancel`).set(AUTH);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/roles — what the insert actually carries', () => {
  // A REVIEW MUTATION SURVIVED HERE. The web form goes to some trouble to omit
  // `agent_name` when it was never touched — because `roles.agent_name` only
  // exists after `supabase db push` of 0100, and PostgREST rejects an unknown
  // column with PGRST204, which 500s EVERY role create until the migration
  // lands. Making the route send it unconditionally kept the whole suite
  // green, so the guard existed on one side only and nothing said so.
  //
  // These assert the PAYLOAD, not the response, because the payload is the
  // thing the database sees.

  beforeEach(() => {
    vi.mocked(supabase.from).mockImplementation(() => insertRecorder() as never);
  });

  it('OMITS agent_name when the caller did not send it', async () => {
    const res = await request(app()).post('/api/roles').set(AUTH).send({
      title: 'Sales Advisor',
      jd: 'Sell things.',
      required_skills: ['Sales'],
      screening_template: [{ id: 'q1', question: 'What do you sell?', weight: 1 }],
    });
    expect(res.status).toBeLessThan(400);
    expect(inserted).toHaveLength(1);
    expect('agent_name' in inserted[0]).toBe(false);
  });

  it('SENDS it when the caller did', async () => {
    await request(app()).post('/api/roles').set(AUTH).send({
      title: 'Sales Advisor',
      agent_name: 'Gopu',
      jd: 'Sell things.',
      required_skills: ['Sales'],
      screening_template: [{ id: 'q1', question: 'What do you sell?', weight: 1 }],
    });
    expect(inserted[0]?.agent_name).toBe('Gopu');
  });

  it('sends NULL for a blank one — "unset" has a single representation', async () => {
    await request(app()).post('/api/roles').set(AUTH).send({
      title: 'Sales Advisor',
      agent_name: '   ',
      jd: 'Sell things.',
      required_skills: ['Sales'],
      screening_template: [{ id: 'q1', question: 'What do you sell?', weight: 1 }],
    });
    expect('agent_name' in inserted[0]).toBe(true);
    expect(inserted[0]?.agent_name).toBeNull();
  });
});

describe('PUT /api/roles/:id — the untested twin of the insert guard', () => {
  // The POST block above exists because a review mutation survived there.
  // This one exists because the NEXT review found the identical conditional
  // one screen further down, on PUT, with zero payload coverage — the
  // recorder had no `update` method, so no test could reach it.
  //
  // Two production effects if it regresses: before `supabase db push` of
  // 0100, every role EDIT 500s on PGRST204; after it, omitting the key
  // silently nulls a role's agent name, contradicting the OpenAPI text this
  // PR added ("Omit the key entirely to leave it untouched").

  beforeEach(() => {
    vi.mocked(supabase.from).mockImplementation(() => insertRecorder() as never);
  });

  it('OMITS agent_name when the caller did not send it', async () => {
    const res = await request(app())
      .put(`/api/roles/${DRAFT_ID}`)
      .set(AUTH)
      .send({ title: 'Sales Advisor' });
    expect(res.status).toBeLessThan(400);
    expect(patched).toHaveLength(1);
    expect('agent_name' in patched[0]).toBe(false);
  });

  it('SENDS it when the caller did', async () => {
    await request(app())
      .put(`/api/roles/${DRAFT_ID}`)
      .set(AUTH)
      .send({ agent_name: 'Gopu' });
    expect(patched[0]?.agent_name).toBe('Gopu');
  });

  it('sends NULL to clear it — an explicit blank is a real edit', async () => {
    await request(app())
      .put(`/api/roles/${DRAFT_ID}`)
      .set(AUTH)
      .send({ agent_name: '   ' });
    expect('agent_name' in patched[0]).toBe(true);
    expect(patched[0]?.agent_name).toBeNull();
  });
});

describe('agent_name', () => {
  // The operator-facing label for a role's screening agent. Never spoken to a
  // candidate — it exists so two roles that look alike in a list can be told
  // apart. The column carries `check (length(agent_name) between 1 and 80)`,
  // which is what the cases below are really defending.

  it('survives a create unchanged', async () => {
    const parsed = createRoleSchema.parse({
      title: 'Sales Advisor',
      agent_name: 'Gopu',
      jd: 'Sell things.',
      required_skills: ['Sales'],
      screening_template: [{ id: 'q1', question: 'What do you sell?', weight: 1 }],
    });
    expect(parsed.agent_name).toBe('Gopu');
  });

  it('TURNS AN EMPTY BOX INTO NULL, not into a constraint violation', async () => {
    // The whole reason this is a transform rather than a `.min(1)`. A blank
    // field means "no agent name", and the form already sends null for it —
    // but a direct caller sending "" deserves the same answer, not a 500 from
    // a database check constraint.
    const parsed = createRoleSchema.parse({
      title: 'Sales Advisor',
      agent_name: '   ',
      jd: 'Sell things.',
      required_skills: ['Sales'],
      screening_template: [{ id: 'q1', question: 'What do you sell?', weight: 1 }],
    });
    expect(parsed.agent_name).toBeNull();
  });

  it('refuses a name longer than the column allows', async () => {
    // 400 here, not a database error two layers down.
    expect(() =>
      createRoleSchema.parse({
        title: 'Sales Advisor',
        agent_name: 'x'.repeat(81),
        jd: 'Sell things.',
        required_skills: ['Sales'],
        screening_template: [{ id: 'q1', question: 'What do you sell?', weight: 1 }],
      }),
    ).toThrow();
  });

  it('can be CLEARED through an update', async () => {
    // Explicit null is a real edit — "this role no longer has its own agent
    // name" — and must be distinguishable from not mentioning the field.
    expect(updateRoleSchema.parse({ agent_name: null }).agent_name).toBeNull();
    expect(updateRoleSchema.parse({ agent_name: '  Hello  ' }).agent_name).toBe('Hello');
    expect('agent_name' in updateRoleSchema.parse({ title: 'x' })).toBe(false);
  });
});
