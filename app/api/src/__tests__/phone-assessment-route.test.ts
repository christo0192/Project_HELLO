/**
 * P4b — the three internal assessment endpoints, and the ordering they exist
 * to enforce.
 *
 * ── THE ORDERING ──────────────────────────────────────────────────────
 *   every plan key durable -> session completion CAS -> AWAIT scoring
 *   -> VERIFY the assessment row -> only then may anything be claimed.
 *
 * The browser route fires scoring on a detached eight-second timer and
 * swallows the error. That is right for a path whose completed session is
 * durable on its own and where a reconciler can retry; it is wrong here,
 * because nothing may claim a phone completion until the score exists. Several
 * tests below assert the ORDER of the injected seams directly, because "we
 * await it" is exactly the kind of claim a refactor breaks silently.
 *
 * ── THE OTHER PROPERTY ────────────────────────────────────────────────
 * The response is a PROJECTION, not a pass-through. `sanitizeAssessmentState`
 * builds the body key by key, and the structural test at the bottom asserts it
 * is a strict SUBSET of the worker context the browser path has always
 * resolved — because whatever reaches this body reaches a voice worker and,
 * through it, a language model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createPhoneWorkerRouter,
  sanitizeAssessmentState,
} from '../routes/phone-worker.js';
import { transitionSession } from '../lib/session-lifecycle.js';
import { runAssessment } from '../services/assessment.js';
import type {
  CommitPhoneQuestionBoundaryResult,
  PhoneAssessmentState,
  PhoneStores,
} from '../lib/phone-screening/index.js';

// M-4: the two production DI defaults are the ONLY thing standing between
// this router and a feature that ships green and inert. They are mocked at the
// module boundary so a router built with an EMPTY deps object can be driven and
// observed — without that test, replacing either default with a no-op leaves
// the whole suite green, which is exactly the failure the code's own comment
// invokes.
vi.mock('../lib/session-lifecycle.js', () => ({
  transitionSession: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/assessment.js', () => ({
  runAssessment: vi.fn(async () => ({ id: 'assessment-1' })),
}));

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = '99999999-8888-4777-8666-555555555555';
const SECRET = 'phone-worker-secret-0123456789abcdefghij';
const ENABLED = { PHONE_SCREENING_ENABLED: 'true' } as NodeJS.ProcessEnv;
const DISABLED = {} as NodeJS.ProcessEnv;
const NOW = new Date('2026-09-01T06:00:00.000Z');

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.WORKER_CONTEXT_SECRET;
  process.env.WORKER_CONTEXT_SECRET = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = savedSecret;
});

function state(over: Partial<PhoneAssessmentState> = {}): PhoneAssessmentState {
  return {
    status: 'ok',
    sessionId: SESSION,
    sessionStatus: 'in_progress',
    terminalReason: null,
    candidateName: 'Asha',
    planSource: 'role_template',
    questionCount: 2,
    questions: [
      { key: 'k1', text: 'Years of experience?', mandatory: true, hint: null },
      { key: 'k2', text: 'Why are you moving?', mandatory: false, hint: 'specifics' },
    ],
    cursor: 0,
    nextKey: 'k1',
    completedKeys: [],
    turns: [],
    assessmentExists: false,
    planComplete: false,
    ...over,
  };
}

interface Harness {
  app: express.Express;
  startAssessment: ReturnType<typeof vi.fn>;
  assessmentState: ReturnType<typeof vi.fn>;
  commitQuestionBoundary: ReturnType<typeof vi.fn>;
  completeSession: ReturnType<typeof vi.fn>;
  scoreSession: ReturnType<typeof vi.fn>;
  /** Every seam call, in the order it happened. THE ordering assertion. */
  order: string[];
}

function build(options: {
  start?: PhoneAssessmentState;
  states?: PhoneAssessmentState[];
  commit?: CommitPhoneQuestionBoundaryResult;
  completeOk?: boolean;
  completeConflict?: boolean;
  scoreThrows?: boolean;
  configSource?: NodeJS.ProcessEnv;
  storeThrows?: boolean;
} = {}): Harness {
  const order: string[] = [];
  const startAssessment = vi.fn(async () => {
    order.push('start');
    if (options.storeThrows === true) throw new Error('phone_start_assessment_error');
    return options.start ?? state();
  });
  // A QUEUE, not a constant: `/assessment/complete` reads the state BEFORE
  // completing and again AFTER scoring, and the two answers are what prove the
  // verification is a real read rather than an echo of the first one.
  const queued = [...(options.states ?? [])];
  const assessmentState = vi.fn(async () => {
    order.push('state');
    return queued.length > 0 ? queued.shift()! : state({ planComplete: true, cursor: 2 });
  });
  const commitQuestionBoundary = vi.fn(async () => {
    order.push('commit');
    return (
      options.commit ?? {
        status: 'applied' as const,
        applied: true,
        duplicate: false,
        cursor: 1,
        questionCount: 2,
        planComplete: false,
      }
    );
  });
  const completeSession = vi.fn(async () => {
    order.push('complete');
    return { ok: options.completeOk !== false, conflict: options.completeConflict === true };
  });
  const scoreSession = vi.fn(async () => {
    order.push('score');
    if (options.scoreThrows === true) throw new Error('provider exploded: session 42');
  });

  const stores = {
    startAssessment,
    assessmentState,
    commitQuestionBoundary,
  } as unknown as PhoneStores;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/phone',
    createPhoneWorkerRouter({
      stores,
      completeSession: completeSession as never,
      scoreSession: scoreSession as never,
      configSource: options.configSource ?? ENABLED,
      now: () => NOW,
    }),
  );

  return {
    app, startAssessment, assessmentState, commitQuestionBoundary,
    completeSession, scoreSession, order,
  };
}

function post(h: Harness, path: string, body: Record<string, unknown>) {
  return request(h.app)
    .post(`/api/internal/phone${path}`)
    .set('Authorization', `Bearer ${SECRET}`)
    .send(body);
}

const START_BODY = { attempt_id: ATTEMPT, session_id: SESSION };
const TURN_BODY = {
  session_id: SESSION,
  question_key: 'k1',
  expected_index: 0,
  source_event_id: 'q:k1',
  turns: [
    { speaker: 'bot', text: 'How many years?' },
    { speaker: 'candidate', text: 'About four.' },
  ],
};

const PATHS = ['/assessment/start', '/assessment/turn', '/assessment/complete'] as const;

// ═══════════════════════════════════════════════════════════════════════
describe('the assessment endpoints sit behind the SAME worker boundary', () => {
  for (const path of PATHS) {
    it(`${path} refuses every unauthenticated shape without touching the database`, async () => {
      const h = build();
      delete process.env.WORKER_CONTEXT_SECRET;
      expect((await request(h.app).post(`/api/internal/phone${path}`).send({})).status).toBe(503);

      process.env.WORKER_CONTEXT_SECRET = 'too-short';
      expect((await request(h.app).post(`/api/internal/phone${path}`).send({})).status).toBe(503);

      process.env.WORKER_CONTEXT_SECRET = SECRET;
      const noBearer = await request(h.app).post(`/api/internal/phone${path}`).send({});
      expect(noBearer.status).toBe(401);
      expect(noBearer.body).toEqual({ ok: false, error: 'authentication_required' });

      const basic = await request(h.app)
        .post(`/api/internal/phone${path}`)
        .set('Authorization', `Basic ${SECRET}`)
        .send({});
      expect(basic.status).toBe(401);

      const wrong = await request(h.app)
        .post(`/api/internal/phone${path}`)
        .set('Authorization', `Bearer ${'x'.repeat(SECRET.length)}`)
        .send({});
      expect(wrong.status).toBe(403);

      expect(h.startAssessment).not.toHaveBeenCalled();
      expect(h.assessmentState).not.toHaveBeenCalled();
      expect(h.commitQuestionBoundary).not.toHaveBeenCalled();
      expect(h.completeSession).not.toHaveBeenCalled();
      expect(h.scoreSession).not.toHaveBeenCalled();
    });

    it(`${path} is 503 and inert while phone screening is disabled`, async () => {
      const h = build({ configSource: DISABLED });
      const res = await post(h, path, START_BODY);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'phone_screening_disabled' });
      expect(h.order).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /assessment/start', () => {
  it('returns the plan, the cursor, the completed keys and the turns', async () => {
    const h = build({
      start: state({
        cursor: 1,
        nextKey: 'k2',
        completedKeys: ['k1'],
        turns: [
          { turnIndex: 0, speaker: 'bot', text: 'Years?' },
          { turnIndex: 1, speaker: 'candidate', text: 'Four.' },
        ],
      }),
    });
    const res = await post(h, '/assessment/start', START_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.plan.questions.map((q: { key: string }) => q.key)).toEqual(['k1', 'k2']);
    expect(res.body.progress).toEqual({
      cursor: 1,
      next_key: 'k2',
      completed_keys: ['k1'],
      plan_complete: false,
    });
    expect(res.body.turns).toHaveLength(2);
    expect(h.startAssessment).toHaveBeenCalledWith({
      attemptId: ATTEMPT, sessionId: SESSION, now: NOW,
    });
  });

  it('forwards every refusal with its own stable code, and never as a success', async () => {
    const refusals = [
      'disclosure_not_delivered',
      'engagement_terminal',
      'invalid_role_template',
      'session_binding_mismatch',
      'session_candidate_mismatch',
      'session_already_bound',
      'session_not_active',
      'unknown_attempt',
      'unknown_session',
      'plan_missing',
      'unknown_status',
    ] as const;
    for (const status of refusals) {
      const h = build({ start: { status } as PhoneAssessmentState });
      const res = await post(h, '/assessment/start', START_BODY);
      expect(res.status, status).toBe(200);
      expect(res.body, status).toEqual({ ok: false, status });
      // A refusal carries NO plan. A worker that read one would screen
      // somebody on a call the state machine has refused.
      expect(res.body.plan, status).toBeUndefined();
    }
  });

  it('refuses a malformed body before the database is touched', async () => {
    const bad = [
      {},
      { attempt_id: ATTEMPT },
      { session_id: SESSION },
      { attempt_id: 'not-a-uuid', session_id: SESSION },
      { attempt_id: ATTEMPT, session_id: SESSION, extra: 1 },
    ];
    for (const body of bad) {
      const h = build();
      const res = await post(h, '/assessment/start', body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
      expect(h.order).toEqual([]);
    }
  });

  it('a store failure becomes a sanitized code, never a driver message', async () => {
    const h = build({ storeThrows: true });
    const res = await post(h, '/assessment/start', START_BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, status: 'phone_assessment_error' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /assessment/turn', () => {
  it('forwards the boundary verbatim and reports the SERVER cursor', async () => {
    const h = build();
    const res = await post(h, '/assessment/turn', TURN_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 'applied',
      duplicate: false,
      cursor: 1,
      question_count: 2,
      plan_complete: false,
      expected_key: null,
    });
    expect(h.commitQuestionBoundary).toHaveBeenCalledWith({
      sessionId: SESSION,
      questionKey: 'k1',
      expectedIndex: 0,
      sourceEventId: 'q:k1',
      turns: TURN_BODY.turns,
      now: NOW,
    });
  });

  it('`ok` comes from the RPC\'s own applied flag, never from the status string', async () => {
    // The shape a careless projection reports as success: a status that reads
    // like one, with the durability flag absent.
    const h = build({
      commit: { status: 'applied', applied: false, duplicate: false } as CommitPhoneQuestionBoundaryResult,
    });
    const res = await post(h, '/assessment/turn', TURN_BODY);
    expect(res.body.ok).toBe(false);
  });

  it('a refusal names the key the cursor actually owes', async () => {
    const h = build({
      commit: {
        status: 'key_not_current', applied: false, duplicate: false,
        cursor: 0, expectedKey: 'k1',
      } as CommitPhoneQuestionBoundaryResult,
    });
    const res = await post(h, '/assessment/turn', TURN_BODY);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('key_not_current');
    expect(res.body.expected_key).toBe('k1');
  });

  it('a duplicate is reported as a durable success, and says so', async () => {
    const h = build({
      commit: {
        status: 'applied', applied: true, duplicate: true, cursor: 1, planComplete: false,
      } as CommitPhoneQuestionBoundaryResult,
    });
    const res = await post(h, '/assessment/turn', TURN_BODY);
    expect(res.body.ok).toBe(true);
    expect(res.body.duplicate).toBe(true);
  });

  it('refuses every malformed exchange before the database is touched', async () => {
    const bad: Record<string, unknown>[] = [
      { ...TURN_BODY, turns: [TURN_BODY.turns[0]] },
      { ...TURN_BODY, turns: [] },
      { ...TURN_BODY, turns: Array.from({ length: 13 }, () => TURN_BODY.turns[0]) },
      { ...TURN_BODY, turns: [{ speaker: 'system', text: 'x' }, TURN_BODY.turns[1]] },
      { ...TURN_BODY, turns: [{ speaker: 'bot', text: '   ' }, TURN_BODY.turns[1]] },
      { ...TURN_BODY, expected_index: -1 },
      { ...TURN_BODY, question_key: 'has space' },
      { ...TURN_BODY, source_event_id: '' },
      { ...TURN_BODY, session_id: 'nope' },
      { ...TURN_BODY, extra: true },
    ];
    for (const body of bad) {
      const h = build();
      const res = await post(h, '/assessment/turn', body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(h.order).toEqual([]);
    }
  });

  it('an OMITTED expected index is refused — an absent CAS is not a weaker one', async () => {
    const { expected_index: _drop, ...withoutCas } = TURN_BODY;
    const h = build();
    const res = await post(h, '/assessment/turn', withoutCas);
    expect(res.status).toBe(400);
    expect(h.order).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('POST /assessment/complete — the ordering this phase exists for', () => {
  it('completes, AWAITS scoring, then verifies the row — in that order', async () => {
    const h = build({
      states: [
        state({ planComplete: true, cursor: 2, completedKeys: ['k1', 'k2'] }),
        state({ planComplete: true, cursor: 2, assessmentExists: true }),
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'scored' });
    // THE assertion. `state` twice, with `complete` and `score` between them,
    // and `score` strictly before the verifying read.
    expect(h.order).toEqual(['state', 'complete', 'score', 'state']);
  });

  it('refuses while ANY plan key is still outstanding, and scores nothing', async () => {
    const h = build({
      states: [state({ planComplete: false, cursor: 1, questionCount: 2 })],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({
      ok: false, status: 'plan_incomplete', cursor: 1, question_count: 2,
    });
    expect(h.order).toEqual(['state']);
    expect(h.completeSession).not.toHaveBeenCalled();
    expect(h.scoreSession).not.toHaveBeenCalled();
  });

  it('a completion CAS CONFLICT still scores and still verifies', async () => {
    // Two legs racing to complete is exactly what a reconnect produces. The
    // loser must not conclude "somebody else did it" and claim a completion it
    // has not verified — nor must it give up on one that is legitimately owed.
    const h = build({
      completeOk: false,
      completeConflict: true,
      states: [
        state({ planComplete: true, cursor: 2 }),
        state({ planComplete: true, cursor: 2, assessmentExists: true }),
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: true, status: 'scored' });
    expect(h.order).toEqual(['state', 'complete', 'score', 'state']);
  });

  it('a NON-conflict completion failure stops before scoring', async () => {
    const h = build({
      completeOk: false,
      completeConflict: false,
      states: [state({ planComplete: true, cursor: 2 })],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: false, status: 'completion_failed' });
    expect(h.scoreSession).not.toHaveBeenCalled();
  });

  it('a scoring failure with NO row yields no completion, and quotes nothing', async () => {
    const h = build({
      scoreThrows: true,
      states: [
        state({ planComplete: true, cursor: 2 }),
        state({ planComplete: true, cursor: 2, assessmentExists: false }),
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: false, status: 'scoring_failed' });
    // The thrown error carried a session number and a provider phrase. Neither
    // may reach the worker, which logs what it is told.
    expect(JSON.stringify(res.body)).not.toContain('provider exploded');
    expect(JSON.stringify(res.body)).not.toContain('42');
  });

  it('A SCORING THROW WITH A ROW IS STILL SCORED — the exception is not the evidence', async () => {
    // The ordinary reconnect case, and the inversion it used to produce. The
    // WINNING leg inserts the assessment; the LOSING leg's insert hits 23505
    // and any failure to read the winner's row back re-throws. The session IS
    // scored. A leg that returned `scoring_failed` here would report otherwise,
    // the worker would post `assessment.aborted`, and the engagement would go
    // terminal `failed` over a screening that exists.
    const h = build({
      scoreThrows: true,
      states: [
        state({ planComplete: true, cursor: 2 }),
        state({ planComplete: true, cursor: 2, assessmentExists: true }),
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: true, status: 'scored' });
    // …and the verification really did run after the throw.
    expect(h.order).toEqual(['state', 'complete', 'score', 'state']);
  });

  it('the two refusals stay DISTINCT — the worker treats them differently', async () => {
    // `scoring_failed` is a provider fault the worker may retry;
    // `assessment_missing` is a state it must not.
    const thrown = build({
      scoreThrows: true,
      states: [state({ planComplete: true, cursor: 2 }), state({ planComplete: true, cursor: 2 })],
    });
    expect((await post(thrown, '/assessment/complete', START_BODY)).body.status)
      .toBe('scoring_failed');

    const quiet = build({
      states: [state({ planComplete: true, cursor: 2 }), state({ planComplete: true, cursor: 2 })],
    });
    expect((await post(quiet, '/assessment/complete', START_BODY)).body.status)
      .toBe('assessment_missing');
  });

  it('the completion reports NO duration at all, which is the truthful answer', async () => {
    // A phone session spans every reconnect, and 0042 defers a window-closed
    // one to the NEXT IST DAY, so no single elapsed number is true of the
    // conversation. `started_at` is stamped when the session ROW is created —
    // NOT NULL, defaulted, never updated — so measuring from it would report
    // time-since-provisioning and clamp at 86,400 on a next-day reconnect: a
    // plausible-looking measurement of something nobody asked about. A
    // hardcoded 0 was worse still. NULL says "not measured", and that is true.
    const h = build({
      states: [
        state({ planComplete: true, cursor: 2 }),
        state({ planComplete: true, cursor: 2, assessmentExists: true }),
      ],
    });
    await post(h, '/assessment/complete', START_BODY);
    expect(h.completeSession).toHaveBeenCalledWith({ sessionId: SESSION });
    const call = h.completeSession.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(call)).toEqual(['sessionId']);
  });

  it('SCORING RESOLVING IS NOT AN ASSESSMENT EXISTING', async () => {
    // The distinction the whole endpoint turns on. `scoreSession` resolved, and
    // the verifying read still says there is no row — so nothing may be claimed.
    const h = build({
      states: [
        state({ planComplete: true, cursor: 2 }),
        state({ planComplete: true, cursor: 2, assessmentExists: false }),
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(h.scoreSession).toHaveBeenCalledOnce();
    expect(res.body).toEqual({ ok: false, status: 'assessment_missing' });
  });

  it('a verifying read that itself fails is not a success either', async () => {
    const h = build({
      states: [
        state({ planComplete: true, cursor: 2 }),
        { status: 'unknown_session' } as PhoneAssessmentState,
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: false, status: 'assessment_missing' });
  });

  it('an ALREADY-completed session is scored and verified without re-completing', async () => {
    const h = build({
      states: [
        state({ planComplete: true, cursor: 2, sessionStatus: 'completed' }),
        state({ planComplete: true, cursor: 2, assessmentExists: true }),
      ],
    });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: true, status: 'scored' });
    expect(h.completeSession).not.toHaveBeenCalled();
    expect(h.scoreSession).toHaveBeenCalledOnce();
  });

  it('a session that went terminal some OTHER way is refused, not scored', async () => {
    for (const sessionStatus of ['failed', 'cancelled', 'expired', 'waiting']) {
      const h = build({
        states: [state({ planComplete: true, cursor: 2, sessionStatus })],
      });
      const res = await post(h, '/assessment/complete', START_BODY);
      expect(res.body, sessionStatus).toEqual({ ok: false, status: 'session_not_active' });
      expect(h.scoreSession, sessionStatus).not.toHaveBeenCalled();
    }
  });

  it('a state read that refuses stops before anything is completed', async () => {
    const h = build({ states: [{ status: 'plan_missing' } as PhoneAssessmentState] });
    const res = await post(h, '/assessment/complete', START_BODY);
    expect(res.body).toEqual({ ok: false, status: 'plan_missing' });
    expect(h.order).toEqual(['state']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the response body is a SUBSET, asserted structurally', () => {
  // The keys `resolveWorkerContext` has always returned on the browser path.
  // Copied here as a literal on purpose: importing it would make the assertion
  // track whatever that function grows into, which is the opposite of a
  // subset check.
  const WORKER_CONTEXT_KEYS = [
    'session_id', 'candidate_id', 'role_id', 'candidate_name', 'room_name', 'status',
  ];

  it('`context` carries only keys the browser worker context already had', () => {
    const body = sanitizeAssessmentState(state());
    const context = body.context as Record<string, unknown>;
    for (const key of Object.keys(context)) {
      expect(WORKER_CONTEXT_KEYS, `context.${key} is not a worker-context key`).toContain(key);
    }
    // …and is a STRICT subset: the identifiers a voice worker has no use for
    // are absent rather than merely unused.
    expect(context).not.toHaveProperty('candidate_id');
    expect(context).not.toHaveProperty('role_id');
    expect(context).not.toHaveProperty('room_name');
  });

  it('nothing anywhere in the body is a phone, SIP, provider or attempt identifier', () => {
    const body = sanitizeAssessmentState(
      state({
        turns: [
          { turnIndex: 0, speaker: 'bot', text: 'Years?' },
          { turnIndex: 1, speaker: 'candidate', text: 'Four.' },
        ],
      }),
    );
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'phone', 'e164', 'sip', 'egress', 'attempt', 'room_name',
      'lease', 'provider', 'resume', 'engagement',
    ]) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // UUIDs are stripped first: they are full of digit runs and are not
    // numbers anybody can dial. What is left must have none.
    const withoutUuids = serialized.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '',
    );
    expect(withoutUuids).not.toMatch(/\d{7,}/);
  });

  it('an unknown key on the RPC answer does NOT reach the body', () => {
    // The projection is the control. A pass-through would forward whatever a
    // future migration adds — to a voice worker, and through it to a model.
    const contaminated = {
      ...state(),
      phoneE164: '+919812345670',
      leaseToken: 'secret-token',
      egressId: 'EG_abcdefgh',
    } as unknown as PhoneAssessmentState;
    const serialized = JSON.stringify(sanitizeAssessmentState(contaminated));
    expect(serialized).not.toContain('919812345670');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('EG_abcdefgh');
  });

  it('CONTROL — the projection is not simply empty', () => {
    // Without this the assertions above would pass on `{}`.
    const body = sanitizeAssessmentState(
      state({ turns: [{ turnIndex: 0, speaker: 'bot', text: 'Years?' }] }),
    );
    expect((body.plan as { questions: unknown[] }).questions).toHaveLength(2);
    expect(body.turns).toHaveLength(1);
    expect((body.context as { candidate_name: string }).candidate_name).toBe('Asha');
    expect(body.progress).toBeDefined();
  });
});


// ═══════════════════════════════════════════════════════════════════════
describe('the PRODUCTION defaults, driven with an empty deps object', () => {
  // Every other test in this file injects `completeSession` and `scoreSession`.
  // That is right for asserting ordering, and it means none of them touches
  // the defaults — so this is the one place the wiring is real.
  function defaultsHarness(states: PhoneAssessmentState[]) {
    const queued = [...states];
    const assessmentState = vi.fn(async () =>
      queued.length > 0 ? queued.shift()! : state({ planComplete: true, cursor: 2 }));
    const app = express();
    app.use(express.json());
    app.use(
      '/api/internal/phone',
      createPhoneWorkerRouter({
        // No completeSession, no scoreSession: the defaults must reach through.
        stores: { assessmentState } as unknown as PhoneStores,
        configSource: ENABLED,
        now: () => NOW,
      }),
    );
    return app;
  }

  beforeEach(() => {
    vi.mocked(transitionSession).mockClear();
    vi.mocked(runAssessment).mockClear();
    vi.mocked(transitionSession).mockResolvedValue({ ok: true } as never);
    vi.mocked(runAssessment).mockResolvedValue({ id: 'assessment-1' } as never);
  });

  it('completeSession defaults to the SHARED lifecycle CAS the browser uses', async () => {
    const app = defaultsHarness([
      state({ planComplete: true, cursor: 2 }),
      state({ planComplete: true, cursor: 2, assessmentExists: true }),
    ]);
    const res = await request(app)
      .post('/api/internal/phone/assessment/complete')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(START_BODY);
    expect(res.body).toEqual({ ok: true, status: 'scored' });
    expect(transitionSession).toHaveBeenCalledWith(
      SESSION, 'in_progress', 'completed', 'conversation_complete',
    );
  });

  it('scoreSession defaults to the SHARED runner, with the PHONE source', async () => {
    const app = defaultsHarness([
      state({ planComplete: true, cursor: 2 }),
      state({ planComplete: true, cursor: 2, assessmentExists: true }),
    ]);
    await request(app)
      .post('/api/internal/phone/assessment/complete')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(START_BODY);
    // The source is what puts the row in the partition the unique index and
    // the SQL interlock both key on. A default that dropped it would score the
    // session as `browser` and the completion would then be refused.
    expect(runAssessment).toHaveBeenCalledWith(SESSION, { source: 'phone' });
  });

  it('a lifecycle CONFLICT still reaches the scorer through the default', async () => {
    vi.mocked(transitionSession).mockResolvedValue({ ok: false, conflict: true } as never);
    const app = defaultsHarness([
      state({ planComplete: true, cursor: 2 }),
      state({ planComplete: true, cursor: 2, assessmentExists: true }),
    ]);
    const res = await request(app)
      .post('/api/internal/phone/assessment/complete')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(START_BODY);
    expect(res.body).toEqual({ ok: true, status: 'scored' });
    expect(runAssessment).toHaveBeenCalledOnce();
  });

  it('a lifecycle ERROR does NOT reach the scorer', async () => {
    vi.mocked(transitionSession).mockResolvedValue(
      { ok: false, conflict: false, code: 'ERR_INVALID_TRANSITION' } as never,
    );
    const app = defaultsHarness([state({ planComplete: true, cursor: 2 })]);
    const res = await request(app)
      .post('/api/internal/phone/assessment/complete')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(START_BODY);
    expect(res.body).toEqual({ ok: false, status: 'completion_failed' });
    expect(runAssessment).not.toHaveBeenCalled();
  });
});
