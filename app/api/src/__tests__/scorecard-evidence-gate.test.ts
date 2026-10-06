/**
 * C3 (migration 0114 §4) — the interview-coverage evidence grade and the
 * Ashby gate built on it.
 *
 *   1. evidence.ts: the grading table, canAutoReject, and the prod shapes the
 *      design was calibrated on (a744741c, 01c5a5dc, e3a187ed, 7f6bb294,
 *      494a13d5, 5cf5809c, ae3d53e1) — 2026-10-03 read-only dry-run;
 *   2. the completion observer HOLDS an insufficient row
 *      (`held_insufficient_evidence`, 0 enqueues);
 *   3. `enqueueScorecardWrite` refuses before the RPC; a missing column is
 *      decision; any other read error fails closed;
 *   4. `readScorecardSource` carries the grade; the marker and the form are
 *      unchanged by it;
 *   5. the saga refuses with no store call; the worker fails non-retryably;
 *   6. Mission Control derives "held for evidence" by a JOIN.
 *
 * Zero network: every client is an in-memory double.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTO_REJECT_MIN,
  EVIDENCE_REASONS,
  INFRA_DISCONNECT_REASON,
  PARTIAL_DECISION,
  PHONE_DISCONNECT_REASONS,
  UNOBSERVED_DISCONNECT_REASON,
  canAutoReject,
  gradeEvidence,
  readAssessmentEvidenceGrade,
  type EvidenceMeasurement,
  type GradeEvidenceInput,
} from '../lib/scorecards/evidence.js';
import {
  observeAshbyCompletion,
  EVIDENCE_INSUFFICIENT_REVIEW_REASON,
} from '../integrations/ashby/completion-observer.js';
import { createMissionControlStore, createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import { ashbyReviewPath, buildScorecard, type ScorecardSource } from '../integrations/ashby/scorecard.js';
import {
  enqueueScorecard,
  type OperationClaimRow,
  type RuntimeWorkflowStores,
  type SagaDeps,
} from '../integrations/ashby/orchestration.js';
import { runClaimedAshbyOperation } from '../integrations/ashby/operation-worker.js';

const LINK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const FORM_ID = '1c9a92c0-c18f-4bf1-898f-c29e71d7d303';

function measured(planned: number | null, answered: number, rows = answered, nulls = 0): EvidenceMeasurement {
  return { planned, progressRows: rows, answeredRows: answered, nullDispositionRows: nulls };
}

function phone(over: Partial<GradeEvidenceInput> = {}): GradeEvidenceInput {
  return {
    source: 'phone',
    partial: true,
    candidateTurns: 6,
    disconnectReason: 'candidate_hangup',
    measurement: measured(4, 3),
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════
describe('gradeEvidence — the rule table', () => {
  it('browser is always decision/complete_call and reads nothing', () => {
    expect(gradeEvidence({
      source: 'browser', partial: false, candidateTurns: 0, disconnectReason: null, measurement: null,
    })).toEqual({ grade: 'decision', reason: 'complete_call', answered: null, planned: null });
  });

  it('0 candidate non-gate turns: insufficient — infra_interrupted on worker_crash, else no_candidate_speech', () => {
    expect(gradeEvidence(phone({ candidateTurns: 0, disconnectReason: 'worker_crash' })).reason).toBe('infra_interrupted');
    expect(gradeEvidence(phone({ candidateTurns: 0 })).reason).toBe('no_candidate_speech');
    // Applies to a non-partial phone row too: a "complete" call with no speech
    // is not evidence.
    const silent = gradeEvidence(phone({ partial: false, candidateTurns: 0, disconnectReason: null }));
    expect(silent).toMatchObject({ grade: 'insufficient', reason: 'no_candidate_speech' });
  });

  it('phone, not partial: decision/complete_call regardless of the read', () => {
    expect(gradeEvidence(phone({ partial: false, measurement: 'read_failed' })))
      .toEqual({ grade: 'decision', reason: 'complete_call', answered: null, planned: null });
    // The counts ride along when measured (they drive the reject rule).
    expect(gradeEvidence(phone({ partial: false, measurement: measured(4, 1, 4) })))
      .toEqual({ grade: 'decision', reason: 'complete_call', answered: 1, planned: 4 });
  });

  it('partial: read failure -> evidence_read_failed; no plan -> no_plan (both insufficient)', () => {
    expect(gradeEvidence(phone({ measurement: 'read_failed' })))
      .toEqual({ grade: 'insufficient', reason: 'evidence_read_failed', answered: null, planned: null });
    expect(gradeEvidence(phone({ measurement: measured(null, 2) })))
      .toEqual({ grade: 'insufficient', reason: 'no_plan', answered: null, planned: null });
  });

  it('partial: answered*4 >= planned*3 is the decision boundary (PARTIAL_DECISION 3/4)', () => {
    expect(PARTIAL_DECISION).toEqual({ num: 3, den: 4 });
    expect(gradeEvidence(phone({ measurement: measured(4, 3, 4) })))
      .toEqual({ grade: 'decision', reason: 'partial_sufficient', answered: 3, planned: 4 });
    expect(gradeEvidence(phone({ measurement: measured(5, 3, 4) })))
      .toEqual({ grade: 'insufficient', reason: 'partial_thin', answered: 3, planned: 5 });
    expect(gradeEvidence(phone({ disconnectReason: 'worker_crash', measurement: measured(5, 3, 4) })).reason)
      .toBe('infra_interrupted');
  });

  it('0115 unobserved_disconnect is NOT an infrastructure fault (only worker_crash is)', () => {
    // A reclaimed leg with teardown evidence: the line dropped unobserved, our
    // side was alive. 0 answers grades no_candidate_speech, never
    // infra_interrupted; a thin partial grades partial_thin.
    expect(UNOBSERVED_DISCONNECT_REASON).toBe('unobserved_disconnect');
    expect(gradeEvidence(phone({ candidateTurns: 0, disconnectReason: UNOBSERVED_DISCONNECT_REASON })))
      .toMatchObject({ grade: 'insufficient', reason: 'no_candidate_speech' });
    expect(gradeEvidence(phone({ disconnectReason: UNOBSERVED_DISCONNECT_REASON, measurement: measured(5, 3, 4) })))
      .toEqual({ grade: 'insufficient', reason: 'partial_thin', answered: 3, planned: 5 });
    // The 9f60523d shape: 0 of 5 answered, measured — insufficient, answered 0.
    expect(gradeEvidence(phone({
      candidateTurns: 0, disconnectReason: UNOBSERVED_DISCONNECT_REASON, measurement: measured(5, 0, 0),
    }))).toEqual({ grade: 'insufficient', reason: 'no_candidate_speech', answered: 0, planned: 5 });
    // Every token but worker_crash grades the same way.
    for (const reason of PHONE_DISCONNECT_REASONS) {
      const r = gradeEvidence(phone({ candidateTurns: 0, disconnectReason: reason })).reason;
      expect(r, reason).toBe(reason === INFRA_DISCONNECT_REASON ? 'infra_interrupted' : 'no_candidate_speech');
    }
    expect(PHONE_DISCONNECT_REASONS).toEqual([
      'candidate_hangup', 'worker_crash', 'unobserved_disconnect', 'disconnected',
    ]);
  });

  it('NULL dispositions grade on the ROW count but leave answered unmeasured', () => {
    const legacy = gradeEvidence(phone({ measurement: measured(4, 0, 3, 3) }));
    expect(legacy).toEqual({ grade: 'decision', reason: 'partial_sufficient', answered: null, planned: 4 });
    // Unmeasured can never auto-reject.
    expect(canAutoReject({ source: 'phone', recommendation: 'reject', scoringStatus: 'complete', evidence: legacy }))
      .toBe(false);
  });

  it('every produced reason is in the closed vocabulary', () => {
    const inputs: GradeEvidenceInput[] = [
      { source: 'browser', partial: false, candidateTurns: 1, disconnectReason: null, measurement: null },
      phone({ candidateTurns: 0 }), phone({ candidateTurns: 0, disconnectReason: 'worker_crash' }),
      phone({ partial: false }), phone({ measurement: 'read_failed' }), phone({ measurement: measured(null, 0) }),
      phone({ measurement: measured(4, 3) }), phone({ measurement: measured(4, 1) }),
    ];
    for (const input of inputs) {
      expect(EVIDENCE_REASONS).toContain(gradeEvidence(input).reason);
    }
  });
});

describe('canAutoReject', () => {
  const decision = { grade: 'decision' as const, answered: 2, planned: 4 };
  it('requires reject + complete (or v1) + decision; browser needs nothing more', () => {
    expect(canAutoReject({ source: 'browser', recommendation: 'reject', scoringStatus: null, evidence: { grade: 'decision', answered: null, planned: null } })).toBe(true);
    expect(canAutoReject({ source: 'browser', recommendation: 'hold', scoringStatus: null, evidence: decision })).toBe(false);
    expect(canAutoReject({ source: 'browser', recommendation: 'reject', scoringStatus: 'incomplete_evidence', evidence: decision })).toBe(false);
    expect(canAutoReject({ source: 'phone', recommendation: 'reject', scoringStatus: 'complete', evidence: { ...decision, grade: 'insufficient' } })).toBe(false);
  });

  it('phone needs a MEASURED answered*2 >= planned (AUTO_REJECT_MIN 1/2)', () => {
    expect(AUTO_REJECT_MIN).toEqual({ num: 1, den: 2 });
    const at = (answered: number | null, planned: number | null) => canAutoReject({
      source: 'phone', recommendation: 'reject', scoringStatus: 'complete', evidence: { grade: 'decision', answered, planned },
    });
    expect(at(2, 4)).toBe(true);
    expect(at(1, 4)).toBe(false);
    expect(at(null, 4)).toBe(false);
    expect(at(2, null)).toBe(false);
  });
});

describe('the 2026-10-03 prod shapes (read-only dry-run, ids are row prefixes)', () => {
  // [assessment, partial, disconnect, planned, answered, candidateTurns, scoring_status, rec]
  const shapes = {
    a744741c: { partial: true, dr: 'candidate_hangup', m: measured(4, 0, 2), turns: 8, status: 'complete', rec: 'reject' },
    '01c5a5dc': { partial: false, dr: null, m: measured(5, 2, 5), turns: 7, status: 'incomplete_evidence', rec: 'reject' },
    e3a187ed: { partial: false, dr: null, m: measured(4, 2, 4), turns: 11, status: 'complete', rec: 'reject' },
    '7f6bb294': { partial: false, dr: null, m: measured(4, 1, 4), turns: 10, status: 'complete', rec: 'reject' },
    '494a13d5': { partial: true, dr: 'worker_crash', m: measured(5, 0, 0), turns: 0, status: 'incomplete_evidence', rec: null },
    '5cf5809c': { partial: true, dr: 'candidate_hangup', m: measured(5, 0, 0), turns: 2, status: 'incomplete_evidence', rec: 'reject' },
  } as const;
  const grade = (k: keyof typeof shapes) => gradeEvidence({
    source: 'phone', partial: shapes[k].partial, candidateTurns: shapes[k].turns,
    disconnectReason: shapes[k].dr, measurement: shapes[k].m,
  });
  const reject = (k: keyof typeof shapes) => canAutoReject({
    source: 'phone', recommendation: shapes[k].rec, scoringStatus: shapes[k].status, evidence: grade(k),
  });

  it('a744741c (0/4 answered, partial) is insufficient and must not reject', () => {
    expect(grade('a744741c')).toMatchObject({ grade: 'insufficient', reason: 'partial_thin' });
    expect(reject('a744741c')).toBe(false);
  });
  it('01c5a5dc (full call) is a decision and publishes; provisional reject lands screened', () => {
    expect(grade('01c5a5dc')).toMatchObject({ grade: 'decision', reason: 'complete_call' });
    expect(reject('01c5a5dc')).toBe(false);
  });
  it('e3a187ed (complete, 2/4) stays rejected', () => {
    expect(reject('e3a187ed')).toBe(true);
  });
  it('7f6bb294 (complete, 1/4) reverts to screened', () => {
    expect(grade('7f6bb294')).toMatchObject({ grade: 'decision', answered: 1, planned: 4 });
    expect(reject('7f6bb294')).toBe(false);
  });
  it('494a13d5 (worker crash, no speech) is infra_interrupted; 5cf5809c is insufficient', () => {
    expect(grade('494a13d5')).toMatchObject({ grade: 'insufficient', reason: 'infra_interrupted' });
    expect(grade('5cf5809c')).toMatchObject({ grade: 'insufficient', reason: 'partial_thin' });
  });
});

describe('thresholds are mirrored BY NAME in migration 0114 §4', () => {
  it('names PARTIAL_DECISION and AUTO_REJECT_MIN once §4 is filled', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../../supabase/migrations/0114_phone_outcome_integrity.sql'),
      'utf8',
    );
    const section = sql.split('-- ==== 0114 §4 BEGIN ====')[1]?.split('-- ==== 0114 §4 END ====')[0] ?? '';
    // §4 is owned by S4; until it lands this assertion is vacuous by design
    // (it only checks a filled section).
    if (!/evidence_grade/.test(section)) return;
    expect(section).toMatch(/PARTIAL_DECISION/);
    expect(section).toMatch(/AUTO_REJECT_MIN/);
    expect(section).toMatch(/evidence\.ts/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('readAssessmentEvidenceGrade — tolerant separate read', () => {
  function client(result: { data: unknown; error: unknown }) {
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) builder[m] = () => builder;
    builder.maybeSingle = async () => result;
    return { from: vi.fn(() => builder) };
  }
  it('reads the grade', async () => {
    expect(await readAssessmentEvidenceGrade(client({ data: { evidence_grade: 'insufficient' }, error: null }), 'a')).toBe('insufficient');
    expect(await readAssessmentEvidenceGrade(client({ data: { evidence_grade: null }, error: null }), 'a')).toBeNull();
  });
  it('a missing column (42703) or schema-cache miss (PGRST204) is null', async () => {
    expect(await readAssessmentEvidenceGrade(client({ data: null, error: { code: '42703', message: 'column assessments.evidence_grade does not exist' } }), 'a')).toBeNull();
    expect(await readAssessmentEvidenceGrade(client({ data: null, error: { code: 'PGRST204', message: 'x' } }), 'a')).toBeNull();
  });
  it('any other error propagates', async () => {
    await expect(readAssessmentEvidenceGrade(client({ data: null, error: { code: '57014', message: 'timeout' } }), 'a'))
      .rejects.toThrow('assessment_evidence_read_error');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('completion observer — insufficient evidence is HELD', () => {
  function deps() {
    const markWritebackPending = vi.fn(async () => ({ status: 'ok' }));
    const enqueueScorecardWrite = vi.fn(async () => ({ status: 'inserted' }));
    return {
      markWritebackPending,
      enqueueScorecardWrite,
      deps: {
        lookup: { findLinkBySessionId: async () => ({ id: LINK_ID, terminalState: null }) },
        stores: { markWritebackPending, enqueueScorecardWrite },
      },
    };
  }

  it('parks with evidence_insufficient_review and enqueues nothing', async () => {
    const d = deps();
    const out = await observeAshbyCompletion(SESSION_ID, d.deps, { evidenceGrade: 'insufficient' });
    expect(out).toEqual({ status: 'held_insufficient_evidence', applicationLinkId: LINK_ID });
    expect(d.markWritebackPending).toHaveBeenCalledWith(LINK_ID, EVIDENCE_INSUFFICIENT_REVIEW_REASON);
    expect(EVIDENCE_INSUFFICIENT_REVIEW_REASON).toBe('evidence_insufficient_review');
    expect(d.enqueueScorecardWrite).not.toHaveBeenCalled();
  });

  it('already_pending is still held; a terminal link stays blocked', async () => {
    const d = deps();
    d.markWritebackPending.mockResolvedValueOnce({ status: 'already_pending' });
    expect(await observeAshbyCompletion(SESSION_ID, d.deps, { evidenceGrade: 'insufficient' }))
      .toEqual({ status: 'held_insufficient_evidence', applicationLinkId: LINK_ID });
    d.markWritebackPending.mockResolvedValueOnce({ status: 'blocked_terminal' });
    expect(await observeAshbyCompletion(SESSION_ID, d.deps, { evidenceGrade: 'insufficient' }))
      .toEqual({ status: 'blocked_terminal' });
    expect(d.enqueueScorecardWrite).not.toHaveBeenCalled();
  });

  it('decision (or no grade) keeps the pre-0114 path: park + one enqueue', async () => {
    for (const options of [{ evidenceGrade: 'decision' as const }, {}, undefined]) {
      const d = deps();
      const out = await observeAshbyCompletion(SESSION_ID, d.deps, options);
      expect(out).toEqual({ status: 'parked', applicationLinkId: LINK_ID });
      expect(d.markWritebackPending).toHaveBeenCalledWith(LINK_ID, 'scorecard_write_pending');
      expect(d.enqueueScorecardWrite).toHaveBeenCalledTimes(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
const V1_ASSESSMENT = {
  id: 'assess_1',
  english: { grammar: 8, vocabulary: 8, fluency: 8, coherence: 8 },
  tone: { clarity: 7, confidence: 7, professionalism: 7 },
  communication: { score: 8 },
  motivation: { score: 7 },
  role_fit: { score: 9 },
  overall_score: 80,
  recommendation: 'advance',
  summary: 'Strong communicator with relevant experience.',
  provenance: { requestedModel: 'm', prompt_template_version: 'v1' },
  created_at: '2026-08-20T00:00:00Z',
};

/**
 * A Supabase double whose `assessments` result depends on the COLUMNS asked
 * for: the scorecard read (SCORECARD_ASSESSMENT_COLUMNS) vs the tolerant
 * `evidence_grade` read.
 */
function storeClient(evidence: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (_name: string, _args?: unknown) => ({ data: { status: 'inserted' }, error: null }));
  const results: Record<string, { data: unknown; error: unknown }> = {
    ashby_operations: { data: null, error: null },
    ashby_application_links: {
      data: {
        external_application_id: 'app_1', external_job_id: 'job_1', job_mapping_id: 'map_1', session_id: SESSION_ID,
        ashby_job_mappings: { status: 'enabled', feedback_form_id: FORM_ID },
      },
      error: null,
    },
  };
  const client = {
    from(table: string) {
      let columns = '';
      const builder: Record<string, unknown> = {};
      builder.select = (c: string) => { columns = c; return builder; };
      for (const m of ['eq', 'order', 'limit', 'in', 'is']) builder[m] = () => builder;
      const settle = () => Promise.resolve(
        table === 'assessments'
          ? (columns === 'evidence_grade' ? evidence : { data: V1_ASSESSMENT, error: null })
          : (results[table] ?? { data: null, error: null }),
      );
      builder.maybeSingle = settle;
      builder.single = settle;
      builder.then = (onOk: (v: unknown) => unknown) => settle().then(onOk);
      return builder;
    },
    rpc,
  };
  return { client, rpc };
}

describe('enqueueScorecardWrite — refuses insufficient evidence before the RPC', () => {
  it('insufficient -> evidence_insufficient, zero RPCs', async () => {
    const { client, rpc } = storeClient({ data: { evidence_grade: 'insufficient' }, error: null });
    const out = await createWorkflowStores(client as never).enqueueScorecardWrite!(LINK_ID, SESSION_ID);
    expect(out).toEqual({ status: 'evidence_insufficient' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('decision, NULL, or a missing column (stale schema) all enqueue as before', async () => {
    for (const evidence of [
      { data: { evidence_grade: 'decision' }, error: null },
      { data: { evidence_grade: null }, error: null },
      { data: null, error: { code: '42703', message: 'column assessments.evidence_grade does not exist' } },
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'evidence_grade' column" } },
    ]) {
      const { client, rpc } = storeClient(evidence);
      const out = await createWorkflowStores(client as never).enqueueScorecardWrite!(LINK_ID, SESSION_ID);
      expect(out).toEqual({ status: 'inserted' });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][0]).toBe('enqueue_ashby_cycle_scorecard');
    }
  });

  it('any other evidence read error fails closed (throws), zero RPCs', async () => {
    const { client, rpc } = storeClient({ data: null, error: { code: '57014', message: 'statement timeout' } });
    await expect(createWorkflowStores(client as never).enqueueScorecardWrite!(LINK_ID, SESSION_ID))
      .rejects.toThrow('ashby_scorecard_enqueue_error');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('readScorecardSource — carries the grade; marker and form unchanged', () => {
  it('sets evidenceGrade from the tolerant read', async () => {
    const insufficient = storeClient({ data: { evidence_grade: 'insufficient' }, error: null });
    const src = await createWorkflowStores(insufficient.client as never).readScorecardSource!(LINK_ID, SESSION_ID);
    expect(src?.evidenceGrade).toBe('insufficient');

    const stale = storeClient({ data: null, error: { code: '42703', message: 'no column' } });
    const legacy = await createWorkflowStores(stale.client as never).readScorecardSource!(LINK_ID, SESSION_ID);
    expect(legacy).not.toBeNull();
    expect(legacy?.evidenceGrade).toBeNull();
  });

  it('a real evidence read error returns null (the worker retries assessment_missing)', async () => {
    const broken = storeClient({ data: null, error: { code: '57014', message: 'timeout' } });
    expect(await createWorkflowStores(broken.client as never).readScorecardSource!(LINK_ID, SESSION_ID)).toBeNull();
  });

  it('the marker snapshot and the normalized scorecard ignore evidenceGrade', async () => {
    const decision = storeClient({ data: { evidence_grade: 'decision' }, error: null });
    const src = await createWorkflowStores(decision.client as never).readScorecardSource!(LINK_ID, SESSION_ID);
    const { evidenceGrade: _ignored, ...withoutGrade } = src!;
    const a = buildScorecard(src!, { min: 1, max: 4 });
    const b = buildScorecard(withoutGrade as ScorecardSource, { min: 1, max: 4 });
    const c = buildScorecard({ ...withoutGrade, evidenceGrade: 'insufficient' } as ScorecardSource, { min: 1, max: 4 });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.marker).toBe(b.marker);
      expect(c.marker).toBe(b.marker);
      expect(a.scorecard).toEqual(b.scorecard);
      expect(JSON.stringify(a.scorecard)).not.toMatch(/evidence/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
function sagaSource(over: Partial<ScorecardSource> = {}): ScorecardSource {
  return {
    externalApplicationId: 'app_ext_1',
    overallScore: 72,
    recommendation: 'reject',
    dimensions: [{ key: 'communication', score: 8 }],
    summary: 'Synthetic summary.',
    provenance: { model: 'synthetic-model', scoredAt: '2026-08-21T00:00:00.000Z', version: '1' },
    reviewPath: ashbyReviewPath(LINK_ID),
    ...over,
  };
}

describe('saga enqueueScorecard — refusal with no store call', () => {
  it('blocks evidence_insufficient before any admission read or enqueue', async () => {
    const findScorecardWriteOperation = vi.fn(async () => null);
    const enqueueOperation = vi.fn(async () => ({ status: 'inserted' }));
    const deps = {
      gates: { enabled: true },
      stores: { findScorecardWriteOperation, enqueueOperation },
      client: {} as never,
      scale: { min: 1, max: 4 },
      applicationLinkId: LINK_ID,
      externalApplicationId: 'app_ext_1',
      aiScreeningStageId: 'stage_ai',
    } as unknown as SagaDeps;
    const out = await enqueueScorecard(sagaSource({ evidenceGrade: 'insufficient' }), deps);
    expect(out).toEqual({ status: 'blocked_scorecard', reason: 'evidence_insufficient' });
    expect(findScorecardWriteOperation).not.toHaveBeenCalled();
    expect(enqueueOperation).not.toHaveBeenCalled();

    // A decision source is unaffected.
    const ok = await enqueueScorecard(sagaSource({ evidenceGrade: 'decision' }), deps);
    expect(ok.status).toBe('scorecard_enqueued');
    expect(enqueueOperation).toHaveBeenCalledTimes(1);
  });
});

describe('operation worker — insufficient sources fail NON-retryably', () => {
  it('fails evidence_insufficient (retryable=false) and never submits', async () => {
    const failures: Array<[string, boolean]> = [];
    const claim: OperationClaimRow = {
      id: 'op_1', operationType: 'scorecard_write', operationKey: `ashby:scorecard:link:${LINK_ID}`,
      applicationLinkId: LINK_ID, leaseToken: 'lease_1', attempts: 1, maxAttempts: 5, marker: 'm',
      sourceSessionId: SESSION_ID,
    };
    const stores = {
      claimOperation: async () => claim,
      readLink: async () => ({
        id: LINK_ID, externalApplicationId: 'app_ext_1', externalJobId: null, externalResumeFileHandle: null,
        jobMappingId: null, candidateId: null, sessionId: SESSION_ID, inviteId: null, lifecycle: 'writeback_pending', terminalState: null,
      }),
      readScorecardSource: async () => sagaSource({ evidenceGrade: 'insufficient' }),
      failOperation: async (_id: string, _t: string, reason: string, retryable: boolean) => {
        failures.push([reason, retryable]);
        return { outcome: 'failed' as const };
      },
      completeOperation: async () => 'ok' as const,
    } as unknown as RuntimeWorkflowStores;
    const submit = vi.fn(async () => ({}));
    const out = await runClaimedAshbyOperation({
      stores,
      materialization: {} as never,
      scorecard: { submit, dashboardOrigin: 'https://hello.example.com' },
      resolveMappingForLink: async () => null,
      reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false },
      owner: 'w1',
      leaseSeconds: 30,
    });
    expect(failures).toEqual([['evidence_insufficient', false]]);
    expect(submit).not.toHaveBeenCalled();
    expect(out).toMatchObject({ claimed: true, committed: false, code: 'evidence_insufficient' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('Mission Control — "held for evidence" is a JOIN on the grade', () => {
  const PHONE_SESSION = '33333333-3333-4333-8333-333333333333';

  function mcClient(tables: Record<string, { data: unknown; error: unknown }>) {
    const asked: string[] = [];
    const client = {
      from(table: string) {
        asked.push(table);
        const builder: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is']) builder[m] = () => builder;
        const settle = () => Promise.resolve(tables[table] ?? { data: null, error: null });
        builder.maybeSingle = settle;
        builder.then = (onOk: (v: unknown) => unknown) => settle().then(onOk);
        return builder;
      },
    };
    return { client, asked };
  }

  function link(over: Record<string, unknown> = {}) {
    return {
      id: LINK_ID, external_application_id: 'app_1', external_job_id: 'job_1',
      lifecycle: 'writeback_pending', terminal_state: null, session_id: null,
      updated_at: '2026-10-03T00:00:00Z', ashby_resume_ingestions: { state: 'ready' }, ashby_operations: [],
      ...over,
    };
  }

  it('a parked link whose newest phone-cycle assessment is insufficient is held', async () => {
    const { client } = mcClient({
      ashby_application_links: { data: [link()], error: null },
      phone_engagements: { data: [{ application_link_id: LINK_ID, session_id: PHONE_SESSION }], error: null },
      assessments: {
        data: [
          { session_id: PHONE_SESSION, evidence_grade: 'insufficient', created_at: '2026-10-03T00:00:00Z' },
          { session_id: PHONE_SESSION, evidence_grade: 'decision', created_at: '2026-10-01T00:00:00Z' },
        ],
        error: null,
      },
    });
    const [row] = await createMissionControlStore(client as never).listWorkflows(50);
    expect(row.heldForEvidence).toBe(true);
  });

  it('a decision grade, a scorecard op, or a non-parked link is not held (and is not queried)', async () => {
    const decision = mcClient({
      ashby_application_links: { data: [link()], error: null },
      phone_engagements: { data: [{ application_link_id: LINK_ID, session_id: PHONE_SESSION }], error: null },
      assessments: { data: [{ session_id: PHONE_SESSION, evidence_grade: 'decision', created_at: 'x' }], error: null },
    });
    expect((await createMissionControlStore(decision.client as never).listWorkflows(50))[0].heldForEvidence).toBe(false);

    const withOp = mcClient({
      ashby_application_links: {
        data: [link({ ashby_operations: [{ id: 'o', operation_type: 'scorecard_write', state: 'failed', error_code: null }] })],
        error: null,
      },
    });
    expect((await createMissionControlStore(withOp.client as never).listWorkflows(50))[0].heldForEvidence).toBe(false);
    expect(withOp.asked).not.toContain('assessments');

    const ready = mcClient({ ashby_application_links: { data: [link({ lifecycle: 'ready' })], error: null } });
    expect((await createMissionControlStore(ready.client as never).listWorkflows(50))[0].heldForEvidence).toBe(false);
    expect(ready.asked).not.toContain('phone_engagements');
  });

  it('an unreadable grade (stale schema) degrades to null and never breaks the list', async () => {
    const { client } = mcClient({
      ashby_application_links: { data: [link({ session_id: SESSION_ID })], error: null },
      call_sessions: { data: [{ id: SESSION_ID, status: 'completed' }], error: null },
      phone_engagements: { data: [], error: null },
      assessments: { data: null, error: { code: '42703', message: 'column assessments.evidence_grade does not exist' } },
    });
    const rows = await createMissionControlStore(client as never).listWorkflows(50);
    expect(rows).toHaveLength(1);
    expect(rows[0].heldForEvidence).toBeNull();
    expect(rows[0].sessionStatus).toBe('completed');
  });
});
