/**
 * POST /api/scorecards/metrics/draft — Ask Hello on the Scorebar's
 * Add-a-metric form.
 *
 * The route is short on purpose; the work lives in
 * `lib/scorecards/metric-draft.ts` (tested in scorecard-metric-draft.test.ts).
 * What a short route can still get wrong, and what this pins:
 *   - WHO may call it (admin only — the metric library is admin-only);
 *   - that validation runs BEFORE a generation is spent;
 *   - that it WRITES NOTHING (no library insert, no update, no RPC);
 *   - the 422 shape for "Hello could not", with the stable reason, and that a
 *     real fault is NOT relabelled as one;
 *   - that a dead audit sink cannot lose a draft.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { viewerReadOnly } from '../lib/rbac.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/scorecards/metric-draft.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/scorecards/metric-draft.js')>(
    '../lib/scorecards/metric-draft.js',
  );
  // Only the provider-calling function is replaced.
  return { ...actual, draftMetricRubric: vi.fn() };
});
vi.mock('../lib/audit.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/audit.js')>('../lib/audit.js');
  return { ...actual, recordAudit: vi.fn() };
});

const { scorecardsRouter } = await import('../routes/scorecards.js');
const drafting = await import('../lib/scorecards/metric-draft.js');
// The REAL error class: the route branches on `instanceof` for 422-vs-500.
const { RoleDraftError } = await import('../lib/role-authoring.js');
const { recordAudit } = await import('../lib/audit.js');
const { supabase } = await import('../lib/supabase.js');

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };
const PATH = '/api/scorecards/metrics/draft';

const DRAFT = {
  default_instruction: 'Look for concrete examples. Use only what the candidate said.',
  rubric: {
    '1': 'No example.',
    '2': 'A vague example.',
    '3': 'A specific example with an outcome.',
    '4': 'Several specific examples with outcomes and lessons.',
  },
};

function makeUser(role: AuthUser['appRole']): AuthUser {
  return {
    id: '00000000-0000-4000-8000-0000000000ff',
    email: 'admin@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
  };
}

function app(role: AuthUser['appRole'] = 'admin') {
  const a = express();
  a.use(express.json());
  a.use(createRequireAuth({ getUser: mockAuthGetUser(makeUser(role), JWT_AAL2) }));
  a.use(viewerReadOnly);
  a.use('/api/scorecards', scorecardsRouter);
  a.use(finalErrorHandler);
  return a;
}

/** Nothing reached the database: no table, no RPC. */
function expectNothingWritten() {
  expect(supabase.from).not.toHaveBeenCalled();
  expect(supabase.rpc).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(drafting.draftMetricRubric).mockReset().mockResolvedValue(DRAFT);
  vi.mocked(recordAudit).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(supabase.from).mockReset();
  vi.mocked(supabase.rpc).mockReset();
});

describe('POST /api/scorecards/metrics/draft — who may call it', () => {
  it('401 without a token, and no generation is spent', async () => {
    const res = await request(app()).post(PATH).send({ name: 'Ownership' });
    expect(res.status).toBe(401);
    expect(drafting.draftMetricRubric).not.toHaveBeenCalled();
  });

  it('403 for an interviewer — the metric library is admin-only', async () => {
    const res = await request(app('interviewer')).post(PATH).set(AUTH).send({ name: 'Ownership' });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
    expect(drafting.draftMetricRubric).not.toHaveBeenCalled();
  });

  it('403 for a viewer', async () => {
    const res = await request(app('viewer')).post(PATH).set(AUTH).send({ name: 'Ownership' });
    expect(res.status).toBe(403);
    expect(drafting.draftMetricRubric).not.toHaveBeenCalled();
  });
});

describe('POST /api/scorecards/metrics/draft — validation before any generation', () => {
  const BAD: Array<[string, unknown]> = [
    ['a missing name', { description: 'x' }],
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a 101-character name', { name: 'n'.repeat(101) }],
    ['a 501-character description', { name: 'Ownership', description: 'd'.repeat(501) }],
    ['a non-string name', { name: 42 }],
    ['an unknown field (strict body)', { name: 'Ownership', rubric: { '1': 'x' } }],
  ];
  for (const [label, body] of BAD) {
    it(`400 on ${label}`, async () => {
      const res = await request(app()).post(PATH).set(AUTH).send(body as object);
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('validation_error');
      expect(drafting.draftMetricRubric).not.toHaveBeenCalled();
      expectNothingWritten();
    });
  }

  it('accepts the limits exactly (100-char name, 500-char description)', async () => {
    const res = await request(app())
      .post(PATH)
      .set(AUTH)
      .send({ name: 'n'.repeat(100), description: 'd'.repeat(500) });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/scorecards/metrics/draft — success', () => {
  it('200 with exactly { default_instruction, rubric } and writes NOTHING', async () => {
    const res = await request(app())
      .post(PATH)
      .set(AUTH)
      .send({ name: '  Ownership  ', description: '  Takes responsibility.  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DRAFT);
    // Trimmed by the schema before it reaches the generator.
    expect(drafting.draftMetricRubric).toHaveBeenCalledWith({
      name: 'Ownership',
      description: 'Takes responsibility.',
    });
    expectNothingWritten();
  });

  it('sends description null when it is omitted or null', async () => {
    await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership' });
    await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership', description: null });
    expect(vi.mocked(drafting.draftMetricRubric).mock.calls.map((c) => c[0])).toEqual([
      { name: 'Ownership', description: null },
      { name: 'Ownership', description: null },
    ]);
  });

  it('AUDITS the generation as resource.generate', async () => {
    await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      'resource.generate',
      200,
      expect.objectContaining({
        metadata: { action: 'scorecard_metric_draft', metric_name: 'Ownership' },
      }),
    );
  });

  it('does NOT fail closed on a dead audit sink — it writes nothing to protect', async () => {
    vi.mocked(recordAudit).mockRejectedValue(new Error('audit sink down'));
    const res = await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DRAFT);
  });

  it('is not swallowed by a /metrics/:id route (declared before them)', async () => {
    // PATCH /metrics/:id would 400 "draft" as a non-uuid if it were reachable.
    const res = await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership' });
    expect(res.status).toBe(200);
    expect(drafting.draftMetricRubric).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/scorecards/metrics/draft — "Hello could not"', () => {
  for (const reason of ['invalid_output', 'output_too_long', 'timeout', 'provider_error'] as const) {
    it(`422 in the rephrase error shape for reason ${reason}, and writes nothing`, async () => {
      vi.mocked(drafting.draftMetricRubric).mockRejectedValue(
        new RoleDraftError(drafting.METRIC_DRAFT_MESSAGES[reason], reason, ['internal detail']),
      );
      const res = await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership' });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        error: {
          type: 'unprocessable_entity',
          message: drafting.METRIC_DRAFT_MESSAGES[reason],
          details: { reason },
        },
      });
      // The internal detail (a provider message, the model's failure) stays server-side.
      expect(JSON.stringify(res.body)).not.toContain('internal detail');
      expectNothingWritten();
    });
  }

  it('lets a REAL fault through as a 500 rather than mislabelling it', async () => {
    vi.mocked(drafting.draftMetricRubric).mockRejectedValue(new Error('pooler reset'));
    const res = await request(app()).post(PATH).set(AUTH).send({ name: 'Ownership' });
    expect(res.status).toBe(500);
    expectNothingWritten();
  });
});
