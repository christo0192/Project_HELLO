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
vi.mock('../lib/role-draft-jobs.js', () => ({
  startRoleDraft: vi.fn(),
  readRoleDraft: vi.fn(),
  cancelRoleDraft: vi.fn(),
  ROLE_DRAFT_STALE_MS: 600_000,
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
  vi.mocked(jobs.cancelRoleDraft).mockReset().mockResolvedValue(true);
  vi.mocked(recordAudit).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(supabase.from).mockReset();
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
