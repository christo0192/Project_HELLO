/**
 * GET /api/interview-rounds/:id/review: everything the R1 review page reads, in one audited answer.
 *
 * What this pins is what the page must never get wrong: who may read it (the rule of the R1 video,
 * so viewers gain R1 transcripts here and only here), what an appeal withholds, what a withdrawn
 * consent hides, and that a key, a URL or a line of model output never reaches the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import { r1Router } from '../routes/r1.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { POSTGREST_MAX_ROWS } from '../lib/id-batches.js';
import { readR1Review } from '../lib/r1/review.js';

const CANDIDATE = '10000000-0000-4000-8000-000000000001';
const ROUND = '20000000-0000-4000-8000-000000000001';
const SESSION_1 = '30000000-0000-4000-8000-000000000001';
const SESSION_2 = '30000000-0000-4000-8000-000000000002';
const ASSESSMENT = '60000000-0000-4000-8000-000000000001';
const PHONE_SESSION = '30000000-0000-4000-8000-000000000099';
const OWNER = '40000000-0000-4000-8000-000000000001';
const OTHER = '50000000-0000-4000-8000-000000000001';
const ROLE = '70000000-0000-4000-8000-000000000001';
/** Letters in it, so another case is another spelling: ROUND has none. */
const LETTERED_ROUND = 'abcdef00-0000-4000-8000-00000000abcd';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const failing = new Set<string>();
/** One read of a table whose other reads must still answer, as `call_sessions is:interview_round_id`. */
const failingReads = new Set<string>();
/** Each read that ran, with the columns it filtered on. */
let reads: Array<{ table: string; asked: string[] }> = [];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As Postgres compares a uuid column: by value, so any spelling of an id matches. */
const sameValue = (actual: unknown, expected: unknown): boolean =>
  actual === expected
  || (typeof actual === 'string' && typeof expected === 'string' && UUID_SHAPE.test(actual) && actual.toLowerCase() === expected.toLowerCase());

/** A small PostgREST double: filters, order and `.range()` as the read uses them, a 1000-row cap. */
function query(table: string, tables: Tables) {
  const filters: Array<(row: Row) => boolean> = [];
  const asked: string[] = [];
  let window: [number, number] | null = null;
  const orders: Array<[string, boolean]> = [];
  const read = () => {
    reads.push({ table, asked });
    if (failing.has(table) || asked.some((what) => failingReads.has(`${table} ${what}`))) return { data: null, error: { message: 'boom' } };
    let rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    for (const [key, ascending] of [...orders].reverse()) {
      rows = [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (window) rows = rows.slice(window[0], window[1] + 1);
    return { data: rows.slice(0, POSTGREST_MAX_ROWS), error: null };
  };
  const q: any = {
    select: () => q,
    eq: (key: string, expected: unknown) => { asked.push(`eq:${key}`); filters.push((row) => sameValue(row[key], expected)); return q; },
    is: (key: string, expected: unknown) => { asked.push(`is:${key}`); filters.push((row) => row[key] === expected); return q; },
    not: (key: string, _op: string, expected: unknown) => { filters.push((row) => row[key] !== expected); return q; },
    in: (key: string, expected: unknown[]) => { asked.push(`in:${key}`); filters.push((row) => expected.some((value) => sameValue(row[key], value))); return q; },
    order: (key: string, options?: { ascending?: boolean }) => { orders.push([key, options?.ascending !== false]); return q; },
    limit: (n: number) => { window = [0, n - 1]; return q; },
    range: (from: number, to: number) => { window = [from, to]; return q; },
    maybeSingle: async () => { const r = read(); return { data: r.data?.[0] ?? null, error: r.error }; },
    single: async () => { const r = read(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then: (resolve: (x: any) => unknown, reject?: (x: unknown) => unknown) => Promise.resolve(read()).then(resolve, reject),
  };
  return q;
}

function metric(id: string, name: string, score: number | null, refs: string[] = []) {
  return {
    configMetricId: id,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: `${name} rationale.`,
    evidenceRefs: refs,
    evidence: refs.map((ref) => {
      const [, turn, quote] = /^T(\d+): (.*)$/.exec(ref)!;
      return { turn_index: Number(turn), quote };
    }),
    metric: { id, name, weightBps: 2500, rubric: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' }, instruction: 'SECRET-INSTRUCTION' },
  };
}

function tablesFor(overrides: Partial<Tables> = {}): Tables {
  return {
    interview_rounds: [{
      id: ROUND, candidate_id: CANDIDATE, role_id: 'r1-role', status: 'completed', expires_at: '2026-11-06T00:00:00Z',
      attempts_allowed: 2, attempts_counted: 1, recommendation: 'hold', overall: 58, assessment_id: ASSESSMENT,
      status_write: 'pending_reject', pending_reject_until: '2026-11-06T10:00:00Z', consent_locale: 'en-IN',
      created_at: '2026-11-01T00:00:00Z', created_by: OWNER, link_token_digest: 'd'.repeat(64),
    }],
    candidates: [{
      id: CANDIDATE, owner_id: OWNER, status: 'screened', decision_use_blocked_at: null, name: 'Ava Example', role_id: ROLE,
      skills: ['Sales'], experience_years: 4, email: 'ava@example.com', phone_raw: '+15550100',
      parsed: { summary: 'Sold courses.', phone: '+15550100', email: 'ava@example.com', current_role: 'Advisor', education: ['BA'], recent_role: { title: 'Advisor', employer: 'Example Co', period: '2024', highlights: ['Top seller'] } },
    }],
    roles: [{ id: ROLE, title: 'Sales Program Advisor' }],
    interview_round_attempts: [{
      session_id: SESSION_1, round_id: ROUND, attempt_number: 1, persona_id: 'p1_career_switcher', persona_variant: 'default',
      persona_version: 1, content_sha: 'c'.repeat(64), counted: true, outcome: 'complete', nonce_digest: 'n'.repeat(64),
      created_at: '2026-11-02T10:00:00Z',
    }],
    call_sessions: [
      { id: SESSION_1, candidate_id: CANDIDATE, interview_round_id: ROUND, status: 'completed', started_at: '2026-11-02T10:00:00Z', ended_at: '2026-11-02T10:30:00Z', duration_sec: 1800, external_call_id: 'screening-secret-room' },
      { id: PHONE_SESSION, candidate_id: CANDIDATE, interview_round_id: null, status: 'completed', started_at: '2026-10-30T10:00:00Z', ended_at: '2026-10-30T10:10:00Z', duration_sec: 600 },
    ],
    interview_round_recordings: [{
      session_id: SESSION_1, round_id: ROUND, status: 'ready', layout: 'combined', has_video: true, started_at_ms: 1_800_000_000_000,
      duration_ms: 1_500_000, camera_off_ms: 0, degraded_at_ms: null, degraded_reason: null, failure_reason: null,
      delete_after: '2027-02-01T00:00:00Z', delete_requested_at: null, delete_reason: null, deleted_at: null, updated_at: '2026-11-02T10:31:00Z',
      combined_key: 'r1/secret/key.mp4', combined_etag: 'SECRET-ETAG', upload_id: 'SECRET-UPLOAD',
    }],
    transcript_turns: [
      { session_id: SESSION_1, turn_index: 0, speaker: 'bot', text: 'Hello, I am Christy.', turn_started_at_ms: 1_800_000_001_000, turn_ended_at_ms: 1_800_000_003_500, ai_voice: 'interviewer', ai_played_ms: 2400, is_gate: false, phase: 'opening', interrupted: false, source_item_id: 'SECRET-ITEM' },
      { session_id: SESSION_1, turn_index: 1, speaker: 'candidate', text: 'Tell me about your goals.', turn_started_at_ms: 1_800_000_005_000, turn_ended_at_ms: null, ai_voice: null, ai_played_ms: null, is_gate: false, phase: 'roleplay', interrupted: true, source_item_id: 'SECRET-ITEM' },
    ],
    assessments: [
      {
        id: ASSESSMENT, session_id: SESSION_1, candidate_id: CANDIDATE, schema_version: 2, recommendation: 'hold', overall_score: 58,
        weighted_score_5: 2.74, scoring_status: 'complete', score_scale_max: 4, created_at: '2026-11-02T10:40:00Z',
        metric_results: [metric('m1', 'Probing & discovery', 3, ['T1: Tell me about your goals']), metric('m2', 'Objection handling', null)],
        raw: {
          recommendation: 'hold',
          metricResults: [{ rationale: 'SECRET-RAW' }],
          r1: {
            outcome: 'scored', valid: true, scored_recommendation: 'hold',
            gate: { passed: true, failures: [] },
            administration_quality: { status: 'ok', failures: [], counts: { guardHits: 0 } },
            agreement: { runs_agree: false, disagreement: 1.2 },
            runs: [{ prompt: 'SECRET-RUN', output: 'SECRET-RUN' }],
            thresholds: { advance: 65, hold: 45 },
            versions: { model: 'SECRET-MODEL' },
          },
        },
        provenance: { secret: 'SECRET-PROVENANCE' },
      },
      { id: '60000000-0000-4000-8000-000000000002', session_id: PHONE_SESSION, candidate_id: CANDIDATE, schema_version: 2, recommendation: 'advance', overall_score: 71, created_at: '2026-10-30T10:20:00Z' },
    ],
    r1_admin_log: [
      { id: 'l1', session_id: SESSION_1, round_id: ROUND, event_type: 'need_revealed', turn_index: 1, family_id: null, created_at: '2026-11-02T10:29:00Z', payload: { pins: { persona_id: 'p1_career_switcher', persona_variant: 'v2', content_sha256: 'SECRET-SHA' }, need: 'H1', probed_turn: 1, probe_source: 'SECRET-SOURCE' } },
      { id: 'l2', session_id: SESSION_1, round_id: ROUND, event_type: 'family_delivered', turn_index: 1, family_id: 'F1', created_at: '2026-11-02T10:29:01Z', payload: { pins: { persona_variant: 'v2' }, move_id: 'SECRET-MOVE', slip_seconds: 2 } },
    ],
    interview_round_consents: [{ id: 'c1', round_id: ROUND, granted_at: '2026-11-02T09:59:00Z', withdrawn_at: null, proof: { decision: 'granted', ip: 'SECRET-IP' } }],
    ...overrides,
  };
}

function appFor(role: 'admin' | 'interviewer' | 'viewer', id = OWNER, tables = tablesFor(), active = true) {
  mocks.from.mockImplementation((table: string) => query(table, tables));
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).authUser = { id, appRole: role, active };
    next();
  });
  app.use('/api', r1Router);
  return app;
}

const review = (app: express.Express, id = ROUND) => request(app).get(`/api/interview-rounds/${id}/review`);

let audits: AuditEntry[];
const previousSink = getAuditSink();
beforeEach(() => {
  failing.clear();
  failingReads.clear();
  reads = [];
  audits = [];
  setAuditSink(async (entry) => { audits.push(entry); });
});
afterEach(() => setAuditSink(previousSink));

describe('who may read a review', () => {
  it('lets an admin read any candidate', async () => {
    expect((await review(appFor('admin', OTHER))).status).toBe(200);
  });

  it('lets a viewer read any candidate: R1 transcripts follow the rule of the R1 video', async () => {
    const res = await review(appFor('viewer', OTHER));
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].turns).toHaveLength(2);
  });

  it('lets an interviewer read a candidate they own, even a round they did not send', async () => {
    const tables = tablesFor();
    tables.interview_rounds[0].created_by = OTHER;
    expect((await review(appFor('interviewer', OWNER, tables))).status).toBe(200);
  });

  it('refuses an interviewer who does not own the candidate, and audits it, with nothing about the round', async () => {
    const res = await review(appFor('interviewer', OTHER));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'access_denied' });
    expect(audits.map((a) => a.event)).toContain('rbac.access_denied');
    expect(audits.map((a) => a.event)).not.toContain('resource.read');
  });

  it('tells an interviewer nothing about whether a round exists', async () => {
    const res = await review(appFor('interviewer', OTHER), '20000000-0000-4000-8000-00000000dead');
    expect(res.status).toBe(403);
  });

  it('answers 404 for a round that does not exist to those who see every candidate', async () => {
    const res = await review(appFor('admin'), '20000000-0000-4000-8000-00000000dead');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('refuses an inactive user, whatever their role', async () => {
    expect((await review(appFor('admin', OWNER, tablesFor(), false))).status).toBe(403);
  });

  it('refuses a malformed id', async () => {
    const res = await review(appFor('admin'), 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_id' });
  });
});

describe('what the answer carries', () => {
  it('carries the round, with the dry-run flag and the fields a reviewer acts on', async () => {
    const { body } = await review(appFor('admin'));
    expect(body.round).toEqual({
      id: ROUND, candidate_id: CANDIDATE, status: 'completed', expires_at: '2026-11-06T00:00:00Z',
      attempts_allowed: 2, attempts_counted: 1, recommendation: 'hold', overall: 58, status_write: 'pending_reject',
      pending_reject_until: '2026-11-06T10:00:00Z', scores_withheld: false, is_staff_dry_run: false,
      created_at: '2026-11-01T00:00:00Z', created_by: OWNER,
    });
  });

  it('carries the candidate with no contact detail, not even from the parsed resume', async () => {
    const { body } = await review(appFor('viewer', OTHER));
    expect(body.candidate).toEqual({
      id: CANDIDATE, name: 'Ava Example', role_title: 'Sales Program Advisor', skills: ['Sales'], experience_years: 4,
      resume: {
        summary: 'Sold courses.', current_role: 'Advisor', education: ['BA'],
        recent_role: { title: 'Advisor', employer: 'Example Co', period: '2024', highlights: ['Top seller'] },
      },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('+15550100');
    expect(text).not.toContain('ava@example.com');
  });

  it('reads no resume as none, rather than an empty object', async () => {
    const tables = tablesFor();
    tables.candidates[0].parsed = { name: 'Ava Example', phone: '+15550100' };
    expect((await review(appFor('admin', OWNER, tables))).body.candidate.resume).toBeNull();
  });

  it('carries each attempt with its persona, end time, recording summary and turns', async () => {
    const { body } = await review(appFor('admin'));
    expect(body.attempts).toHaveLength(1);
    const [attempt] = body.attempts;
    expect(attempt).toMatchObject({
      session_id: SESSION_1, attempt_number: 1, counted: true, outcome: 'complete', persona_id: 'p1_career_switcher',
      persona_label: 'Career switcher', learner_name: 'Priya Nair', started_at: '2026-11-02T10:00:00Z',
      ended_at: '2026-11-02T10:30:00Z', consent_withdrawn: false, transcript_hidden: false, in_progress: false,
    });
    expect(attempt.recording).toMatchObject({ state: 'ready', mode: 'single', has_video: true, started_at_ms: 1_800_000_000_000, duration_ms: 1_500_000 });
    expect(attempt.turns).toEqual([
      { turn_index: 0, speaker: 'bot', text: 'Hello, I am Christy.', turn_started_at_ms: 1_800_000_001_000, turn_ended_at_ms: 1_800_000_003_500, ai_voice: 'interviewer', ai_played_ms: 2400, is_gate: false, phase: 'opening', interrupted: false },
      { turn_index: 1, speaker: 'candidate', text: 'Tell me about your goals.', turn_started_at_ms: 1_800_000_005_000, turn_ended_at_ms: null, ai_voice: null, ai_played_ms: null, is_gate: false, phase: 'roleplay', interrupted: true },
    ]);
  });

  it('reads an older turn, with none of the 0136 facts, as not known', async () => {
    const tables = tablesFor();
    tables.transcript_turns = [{ session_id: SESSION_1, turn_index: 0, speaker: 'bot', text: 'Hello.', turn_started_at_ms: 1_800_000_001_000, is_gate: false, phase: 'opening', interrupted: false }];
    const [turn] = (await review(appFor('admin', OWNER, tables))).body.attempts[0].turns;
    expect(turn).toMatchObject({ turn_ended_at_ms: null, ai_voice: null, ai_played_ms: null });
  });

  it('passes on no stored value it cannot stand behind', async () => {
    const tables = tablesFor();
    Object.assign(tables.transcript_turns[0], { turn_ended_at_ms: -5, ai_voice: 'somebody_else', ai_played_ms: -1 });
    const [turn] = (await review(appFor('admin', OWNER, tables))).body.attempts[0].turns;
    expect(turn).toMatchObject({ turn_ended_at_ms: null, ai_voice: null, ai_played_ms: null });
  });

  it('names no learner when the log has no pins, so the page falls back to its own label', async () => {
    const { body } = await review(appFor('admin', OWNER, tablesFor({ r1_admin_log: [] })));
    expect(body.attempts[0].learner_name).toBeNull();
    expect(body.attempts[0].persona_label).toBe('Career switcher');
  });

  it('gives each attempt its own learner', async () => {
    const tables = tablesFor();
    tables.interview_round_attempts.push({ ...tables.interview_round_attempts[0], session_id: SESSION_2, attempt_number: 2, persona_id: 'p2_recent_grad', counted: true });
    tables.call_sessions.push({ id: SESSION_2, candidate_id: CANDIDATE, interview_round_id: ROUND, status: 'completed', started_at: '2026-11-03T10:00:00Z', ended_at: '2026-11-03T10:30:00Z' });
    tables.r1_admin_log.push({ id: 'l3', session_id: SESSION_2, round_id: ROUND, event_type: 'need_revealed', turn_index: 4, family_id: null, created_at: '2026-11-03T10:29:00Z', payload: { pins: { persona_variant: 'v1' }, need: 'H2' } });
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.attempts.map((a: Row) => a.learner_name)).toEqual(['Priya Nair', 'Ananya Rao']);
  });

  it('orders a restart after the start it replaced, whatever order the rows come in: they share a number', async () => {
    const tables = tablesFor();
    const [scored] = tables.interview_round_attempts;
    tables.interview_round_attempts = [
      { ...scored, created_at: '2026-11-02T10:05:00Z' },
      { ...scored, session_id: SESSION_2, counted: false, outcome: 'provider_error', created_at: '2026-11-02T10:00:00Z' },
    ];
    tables.call_sessions.push({ id: SESSION_2, candidate_id: CANDIDATE, interview_round_id: ROUND, status: 'failed', started_at: '2026-11-02T10:00:00Z', ended_at: '2026-11-02T10:01:00Z' });
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.attempts.map((a: Row) => [a.session_id, a.attempt_number])).toEqual([[SESSION_2, 1], [SESSION_1, 1]]);
  });

  it('carries the assessment: structured evidence and the gate, administration and agreement facts', async () => {
    const { body } = await review(appFor('viewer', OTHER));
    expect(body.assessment).toEqual({
      id: ASSESSMENT, session_id: SESSION_1, recommendation: 'hold', raw_recommendation: 'hold', overall_score: 58,
      scoring_status: 'complete', score_scale_max: 4, created_at: '2026-11-02T10:40:00Z',
      metric_results: [
        { metric_id: 'm1', name: 'Probing & discovery', weight_bps: 2500, score: 3, evidence_status: 'scored', rationale: 'Probing & discovery rationale.', evidence: [{ turn_index: 1, quote: 'Tell me about your goals' }] },
        { metric_id: 'm2', name: 'Objection handling', weight_bps: 2500, score: null, evidence_status: 'insufficient_evidence', rationale: 'Objection handling rationale.', evidence: [] },
      ],
      r1: {
        outcome: 'scored', valid: true, code: null, gate: { passed: true, failures: [] },
        administration_quality: { status: 'ok', failures: [], counts: { guardHits: 0 } },
        agreement: { runs_agree: false, disagreement: 1.2 }, thresholds: { advance: 65, hold: 45 },
      },
    });
  });

  it('reads structured evidence from the refs of a row written before `evidence` existed', async () => {
    const tables = tablesFor();
    delete tables.assessments[0].metric_results[0].evidence;
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.assessment.metric_results[0].evidence).toEqual([{ turn_index: 1, quote: 'Tell me about your goals' }]);
  });

  describe('a retake that replaced the first result', () => {
    const FIRST = '60000000-0000-4000-8000-000000000011';
    const NEWEST_OF_FIRST = '60000000-0000-4000-8000-000000000012';

    function retaken(): Tables {
      const tables = tablesFor();
      tables.interview_round_attempts.push({ ...tables.interview_round_attempts[0], session_id: SESSION_2, attempt_number: 2, created_at: '2026-11-03T10:00:00Z' });
      tables.call_sessions.push({ ...tables.call_sessions[0], id: SESSION_2 });
      // The round's assessment is now the retake's; the first attempt keeps two revisions of its own.
      tables.assessments[0].session_id = SESSION_2;
      tables.assessments.push(
        { ...tables.assessments[0], id: FIRST, session_id: SESSION_1, revision: 1, overall_score: 40, recommendation: 'reject', created_at: '2026-11-02T10:40:00Z' },
        { ...tables.assessments[0], id: NEWEST_OF_FIRST, session_id: SESSION_1, revision: 2, overall_score: 44, recommendation: 'reject', created_at: '2026-11-02T10:50:00Z' },
      );
      return tables;
    }

    it('still carries the scorecard of the attempt it replaced: its newest, once', async () => {
      const { body } = await review(appFor('viewer', OTHER, retaken()));
      expect(body.assessment.session_id).toBe(SESSION_2);
      expect(body.replaced_assessments.map((item: Row) => [item.id, item.session_id, item.overall_score])).toEqual([[NEWEST_OF_FIRST, SESSION_1, 44]]);
      expect(body.replaced_assessments[0].metric_results[0]).toMatchObject({ rationale: 'Probing & discovery rationale.' });
    });

    it('never repeats the deciding attempt there', async () => {
      const { body } = await review(appFor('admin', OWNER, retaken()));
      expect(body.replaced_assessments.some((item: Row) => item.session_id === SESSION_2)).toBe(false);
    });

    it('has none for a round with one attempt', async () => {
      const { body } = await review(appFor('admin'));
      expect(body.replaced_assessments).toEqual([]);
    });

    it('holds them back with the rest while an appeal blocks decision use', async () => {
      const tables = retaken();
      tables.candidates[0].decision_use_blocked_at = '2026-11-02T00:00:00Z';
      const { body } = await review(appFor('admin', OWNER, tables));
      expect(body.replaced_assessments).toEqual([]);
    });

    it('drops the words of an attempt consent was withdrawn from, as for the deciding one', async () => {
      const tables = retaken();
      tables.interview_round_consents = [{ id: 'c1', round_id: ROUND, withdrawn_at: '2026-11-02T12:00:00Z', proof: { decision: 'withdrawn' } }];
      const { body } = await review(appFor('admin', OWNER, tables));
      expect(body.replaced_assessments[0].metric_results[0]).toMatchObject({ rationale: null, evidence: [] });
    });

    it('answers 503 rather than a page that has lost a scorecard', async () => {
      const app = appFor('admin', OWNER, retaken());
      failingReads.add('assessments in:session_id');
      const res = await request(app).get(`/api/interview-rounds/${ROUND}/review`);
      expect(res.status).toBe(503);
    });
  });

  it('has no assessment before the round holds one', async () => {
    const tables = tablesFor();
    tables.interview_rounds[0].assessment_id = null;
    expect((await review(appFor('admin', OWNER, tables))).body.assessment).toBeNull();
  });

  it('carries the log with each event at its turn, and only the fields a reviewer reads', async () => {
    const { body } = await review(appFor('admin'));
    expect(body.events).toEqual([
      { session_id: SESSION_1, event_type: 'need_revealed', turn_index: 1, family_id: null, need: 'H1', kind: null, created_at: '2026-11-02T10:29:00Z' },
      { session_id: SESSION_1, event_type: 'family_delivered', turn_index: 1, family_id: 'F1', need: null, kind: null, created_at: '2026-11-02T10:29:01Z' },
    ]);
  });

  it('reads the log by session, the index it has, and not by round, which has none', async () => {
    await review(appFor('admin'));
    const logReads = reads.filter((read) => read.table === 'r1_admin_log');
    expect(logReads).toHaveLength(1);
    expect(logReads[0].asked).toEqual(['in:session_id']);
  });

  it('carries only the log of this round', async () => {
    const tables = tablesFor();
    tables.r1_admin_log.push({ id: 'l9', session_id: SESSION_2, round_id: 'another-round', event_type: 'guard_hit', turn_index: 0, family_id: null, created_at: '2026-11-02T10:29:02Z', payload: {} });
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.events.map((event: Row) => event.event_type)).toEqual(['need_revealed', 'family_delivered']);
  });

  it('asks for no log when no attempt has started', async () => {
    const { body, status } = await review(appFor('admin', OWNER, tablesFor({ interview_round_attempts: [] })));
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(reads.filter((read) => read.table === 'r1_admin_log')).toEqual([]);
  });

  it('carries the phone screening beside it, and never takes an R1 assessment for one', async () => {
    const { body } = await review(appFor('admin'));
    expect(body.phone_screening).toEqual({ recommendation: 'advance', overall_score: 71, created_at: '2026-10-30T10:20:00Z', evidence_grade: null, scoring_status: null });
  });

  it('says when the phone score is held or provisional: neither is a firm result', async () => {
    const tables = tablesFor();
    Object.assign(tables.assessments[1], { evidence_grade: 'insufficient', scoring_status: 'incomplete_evidence' });
    expect((await review(appFor('admin', OWNER, tables))).body.phone_screening).toMatchObject({ evidence_grade: 'insufficient', scoring_status: 'incomplete_evidence' });
  });

  it('has no phone line for a candidate with no phone assessment', async () => {
    const tables = tablesFor();
    tables.assessments = tables.assessments.filter((a) => a.session_id !== PHONE_SESSION);
    const { body, status } = await review(appFor('admin', OWNER, tables));
    expect(status).toBe(200);
    expect(body.phone_screening).toBeNull();
  });

  it('carries the rubric, without the scorer instructions', async () => {
    const { body } = await review(appFor('viewer', OTHER));
    expect(body.rubric).toHaveLength(5);
    expect(body.rubric[0]).toMatchObject({ name: 'Probing & discovery', weight_bps: 2500 });
    expect(Object.keys(body.rubric[0].levels)).toEqual(['1', '2', '3', '4']);
    expect(body.rubric[0]).not.toHaveProperty('instruction');
  });

  it('never carries a key, a URL, a digest, a room name, model output or a consent proof', async () => {
    const res = await review(appFor('admin'));
    const text = JSON.stringify(res.body);
    for (const secret of ['SECRET', 'r1/secret', 'screening-secret-room', 'd'.repeat(64), 'n'.repeat(64), 'c'.repeat(64)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/"(url|video_url|audio_url|combined_key|etag)"/);
  });

  it('is never cached: it carries a transcript', async () => {
    expect((await review(appFor('admin'))).headers['cache-control']).toBe('no-store');
  });

  it('reads a transcript past the 1000-row cap, in turn order', async () => {
    const tables = tablesFor();
    tables.transcript_turns = Array.from({ length: 1205 }, (_, i) => ({
      session_id: SESSION_1, turn_index: i, speaker: 'bot', text: `Turn ${i}`, turn_started_at_ms: null, is_gate: false, phase: 'roleplay', interrupted: false,
    }));
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.attempts[0].turns).toHaveLength(1205);
    expect(body.attempts[0].turns[1204].turn_index).toBe(1204);
  });
});

describe('a read that fails', () => {
  for (const table of ['interview_rounds', 'candidates', 'interview_round_attempts', 'interview_round_recordings', 'call_sessions', 'transcript_turns', 'r1_admin_log', 'interview_round_consents']) {
    it(`answers 503 rather than a partial page when ${table} cannot be read`, async () => {
      failing.add(table);
      const res = await review(appFor('admin'));
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'service_unavailable' });
    });
  }

  it('answers 503 rather than "not scored" when the assessment cannot be read', async () => {
    failing.add('assessments');
    expect((await review(appFor('admin'))).status).toBe(503);
  });

  it.each([
    ['the phone sessions', 'call_sessions is:interview_round_id'],
    ['the phone assessment', 'assessments in:session_id'],
  ])('still answers when %s cannot be read: it is one line of context', async (_what, read) => {
    failingReads.add(read);
    const { body, status } = await review(appFor('admin'));
    expect(status).toBe(200);
    expect(body.phone_screening).toBeNull();
    // The review itself is whole: this is the one line going, and not the page.
    expect(body.attempts[0].turns).toHaveLength(2);
    expect(body.assessment.id).toBe(ASSESSMENT);
  });

  it('still answers when the role title cannot be read', async () => {
    failing.add('roles');
    const { body, status } = await review(appFor('admin'));
    expect(status).toBe(200);
    expect(body.candidate.role_title).toBeNull();
    expect(body.candidate.name).toBe('Ava Example');
  });
});

describe('while an appeal blocks decision use', () => {
  const blocked = () => {
    const tables = tablesFor();
    tables.candidates[0].decision_use_blocked_at = '2026-11-04T00:00:00Z';
    return tables;
  };

  it('withholds every field that gives the result away, and says so', async () => {
    const { body } = await review(appFor('admin', OWNER, blocked()));
    expect(body.round).toMatchObject({ recommendation: null, overall: null, status_write: null, pending_reject_until: null, scores_withheld: true });
    expect(body.assessment).toBeNull();
    expect(body.phone_screening).toBeNull();
  });

  it('does not read the assessment at all', async () => {
    failing.add('assessments');
    expect((await review(appFor('admin', OWNER, blocked()))).status).toBe(200);
  });

  it('keeps the interview itself: the transcript and the recording are not scores', async () => {
    const { body } = await review(appFor('viewer', OTHER, blocked()));
    expect(body.attempts[0].turns).toHaveLength(2);
    expect(body.attempts[0].recording.state).toBe('ready');
  });

  it('leaks no score anywhere in the answer', async () => {
    const text = JSON.stringify((await review(appFor('admin', OWNER, blocked()))).body);
    for (const leak of ['rationale', 'metric_results', '"hold"', '"pending_reject"', '"2026-11-06T10:00:00Z"']) expect(text).not.toContain(leak);
  });
});

describe('after consent is withdrawn', () => {
  const withdrawn = (decision = 'withdrawn') => {
    const tables = tablesFor();
    tables.interview_round_consents = [{ id: 'c1', round_id: ROUND, granted_at: '2026-11-02T09:59:00Z', withdrawn_at: '2026-11-03T00:00:00Z', proof: { decision } }];
    return tables;
  };

  it('hides the transcript and disables the recording, with the reason', async () => {
    const { body } = await review(appFor('admin', OWNER, withdrawn()));
    const [attempt] = body.attempts;
    expect(attempt.consent_withdrawn).toBe(true);
    expect(attempt.transcript_hidden).toBe(true);
    expect(attempt.turns).toEqual([]);
    expect(attempt.recording).toMatchObject({ state: 'deleted', reason: 'consent_withdrawn', started_at_ms: null, duration_ms: null, mode: null });
  });

  it('does not read the transcript at all', async () => {
    failing.add('transcript_turns');
    expect((await review(appFor('admin', OWNER, withdrawn()))).status).toBe(200);
  });

  it('hides quotes too: they are the transcript by another route', async () => {
    const { body } = await review(appFor('admin', OWNER, withdrawn()));
    expect(body.assessment.metric_results[0].evidence).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Tell me about your goals');
  });

  it('hides the rationales too: each one cites what the candidate said', async () => {
    const tables = withdrawn();
    tables.assessments[0].metric_results[0].rationale = 'Asked "Tell me about your goals" and followed up well.';
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.assessment.metric_results.map((m: Row) => m.rationale)).toEqual([null, null]);
    expect(JSON.stringify(body)).not.toContain('followed up well');
  });

  it('keeps each score, and the rationales of an attempt made after the withdrawal', async () => {
    const tables = withdrawn();
    expect((await review(appFor('admin', OWNER, tables))).body.assessment.metric_results[0].score).toBe(3);
    tables.interview_round_attempts[0].created_at = '2026-11-04T00:00:00Z';
    expect((await review(appFor('admin', OWNER, tables))).body.assessment.metric_results[0].rationale).toBe('Probing & discovery rationale.');
  });

  it('treats a decline the same way', async () => {
    const { body } = await review(appFor('admin', OWNER, withdrawn('declined')));
    expect(body.attempts[0].transcript_hidden).toBe(true);
  });

  it('does not take a consent superseded by a newer notice for a withdrawal', async () => {
    const { body } = await review(appFor('admin', OWNER, withdrawn('superseded')));
    expect(body.attempts[0].transcript_hidden).toBe(false);
    expect(body.attempts[0].turns).toHaveLength(2);
    expect(body.attempts[0].recording.state).toBe('ready');
  });

  it('keeps an attempt made after the withdrawal, as the erase rule does', async () => {
    const tables = withdrawn();
    tables.interview_round_attempts.push({ ...tables.interview_round_attempts[0], session_id: SESSION_2, attempt_number: 2, created_at: '2026-11-04T00:00:00Z' });
    tables.call_sessions.push({ id: SESSION_2, candidate_id: CANDIDATE, interview_round_id: ROUND, status: 'completed', started_at: '2026-11-04T00:00:00Z', ended_at: '2026-11-04T00:30:00Z' });
    tables.transcript_turns.push({ session_id: SESSION_2, turn_index: 0, speaker: 'bot', text: 'Second try.', turn_started_at_ms: null, is_gate: false, phase: 'opening', interrupted: false });
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.attempts.map((a: Row) => a.transcript_hidden)).toEqual([true, false]);
    expect(body.attempts[1].turns).toHaveLength(1);
  });

  it('leaves "no recording was made" as it is: nothing was deleted', async () => {
    const tables = withdrawn();
    tables.interview_round_recordings = [];
    expect((await review(appFor('admin', OWNER, tables))).body.attempts[0].recording.state).toBe('none');
  });

  describe('whatever case the id is typed in', () => {
    const lettered = () => {
      const tables = withdrawn();
      tables.interview_rounds[0].id = LETTERED_ROUND;
      for (const table of ['interview_round_attempts', 'interview_round_recordings', 'r1_admin_log', 'interview_round_consents']) {
        for (const row of tables[table]) row.round_id = LETTERED_ROUND;
      }
      tables.call_sessions[0].interview_round_id = LETTERED_ROUND;
      return tables;
    };

    it.each([
      ['lower', LETTERED_ROUND],
      ['upper', LETTERED_ROUND.toUpperCase()],
    ])('hides the same things for an id in %s case', async (_case, id) => {
      const res = await review(appFor('viewer', OTHER, lettered()), id);
      expect(res.status).toBe(200);
      const [attempt] = res.body.attempts;
      expect(attempt).toMatchObject({ consent_withdrawn: true, transcript_hidden: true, turns: [] });
      expect(attempt.recording).toMatchObject({ state: 'deleted', reason: 'consent_withdrawn' });
      expect(res.body.assessment.metric_results.map((m: Row) => m.rationale)).toEqual([null, null]);
      expect(JSON.stringify(res.body)).not.toContain('Tell me about your goals');
    });

    it('audits the read under the id as it is stored', async () => {
      await review(appFor('viewer', OTHER, lettered()), LETTERED_ROUND.toUpperCase());
      expect(audits.find((a) => a.event === 'resource.read')?.metadata).toMatchObject({ round_id: expect.stringMatching(/^abcdef00-/), consent_withdrawn: true });
    });

    it('does not lean on the route: the read itself goes by the stored id', async () => {
      appFor('viewer', OTHER, lettered());
      const result = await readR1Review({ from: mocks.from } as never, { id: OTHER, appRole: 'viewer', active: true }, LETTERED_ROUND.toUpperCase());
      expect(result).toMatchObject({ kind: 'ok', consentWithdrawn: true });
    });
  });
});

describe('while the interview runs', () => {
  const live = (status: string) => {
    const tables = tablesFor();
    tables.call_sessions[0].status = status;
    tables.call_sessions[0].ended_at = null;
    return tables;
  };

  for (const status of ['created', 'waiting', 'in_progress']) {
    it(`sends no transcript for a session that is ${status}, and says why`, async () => {
      const [attempt] = (await review(appFor('admin', OWNER, live(status)))).body.attempts;
      expect(attempt.in_progress).toBe(true);
      expect(attempt.turns).toEqual([]);
      expect(attempt.transcript_hidden).toBe(false);
    });
  }

  it('does not read the transcript at all', async () => {
    failing.add('transcript_turns');
    expect((await review(appFor('admin', OWNER, live('in_progress')))).status).toBe(200);
  });

  it('still reads an attempt that has ended beside a live retake', async () => {
    const tables = tablesFor();
    tables.interview_round_attempts.push({ ...tables.interview_round_attempts[0], session_id: SESSION_2, attempt_number: 2, created_at: '2026-11-03T00:00:00Z' });
    tables.call_sessions.push({ id: SESSION_2, candidate_id: CANDIDATE, interview_round_id: ROUND, status: 'in_progress', started_at: '2026-11-03T00:00:00Z', ended_at: null });
    tables.transcript_turns.push({ session_id: SESSION_2, turn_index: 0, speaker: 'bot', text: 'Second try.', turn_started_at_ms: null, is_gate: false, phase: 'opening', interrupted: false });
    const { body } = await review(appFor('viewer', OTHER, tables));
    expect(body.attempts.map((a: Row) => a.in_progress)).toEqual([false, true]);
    expect(body.attempts.map((a: Row) => a.turns.length)).toEqual([2, 0]);
  });

  it('reads the transcript of an attempt that ended, however it ended', async () => {
    for (const status of ['failed', 'cancelled', 'expired']) {
      expect((await review(appFor('admin', OWNER, live(status)))).body.attempts[0].turns).toHaveLength(2);
    }
  });
});

describe('a staff dry run', () => {
  it('is marked from the round, and the locale itself stays out of the answer', async () => {
    const tables = tablesFor();
    tables.interview_rounds[0].consent_locale = 'en-IN-x-staff';
    const { body } = await review(appFor('admin', OWNER, tables));
    expect(body.round.is_staff_dry_run).toBe(true);
    expect(JSON.stringify(body)).not.toContain('en-IN');
  });
});

describe('the audit of a read', () => {
  it('records who read what, as a read, with no transcript in it', async () => {
    await review(appFor('viewer', OTHER));
    const entry = audits.find((a) => a.event === 'resource.read');
    // The redactor reads these fixture ids' all-digit tails as phone numbers, so only their heads are compared.
    expect(entry?.metadata).toEqual({
      resource: 'r1_review', round_id: expect.stringMatching(/^20000000-/), requested_by: expect.stringMatching(/^50000000-/),
      role: 'viewer', scores_withheld: false, consent_withdrawn: false,
    });
    expect(JSON.stringify(audits)).not.toContain('Tell me about your goals');
  });

  it('records that consent was withdrawn on a read of such a round', async () => {
    const tables = tablesFor();
    tables.interview_round_consents = [{ id: 'c1', round_id: ROUND, granted_at: '2026-11-02T09:59:00Z', withdrawn_at: '2026-11-03T00:00:00Z', proof: { decision: 'withdrawn' } }];
    await review(appFor('viewer', OTHER, tables));
    expect(audits.find((a) => a.event === 'resource.read')?.metadata).toMatchObject({ consent_withdrawn: true });
  });

  it('still answers when the audit cannot be written: a read fails open', async () => {
    setAuditSink(async () => { throw new Error('sink down'); });
    expect((await review(appFor('admin'))).status).toBe(200);
  });
});
