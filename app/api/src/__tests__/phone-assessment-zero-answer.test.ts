/**
 * 0115 (M013 S02, T06) — the phone assessment handler and the zero-answer
 * relabel.
 *
 * After the completion post, a session whose latest phone assessment is a
 * MEASURED 0-answer row (`insufficient`, `evidence_answered === 0`) is
 * relabelled failed/screening_abandoned through
 * `relabel_zero_answer_phone_engagement`. A failed relabel throws so the job
 * retries, and the retry takes the early-return path: it calls ONLY the
 * relabel and never scores twice.
 *
 * The RPC itself (the predicate, the candidate move, idempotency) is proven on
 * real Postgres: app/supabase/tests/phone_0115_relabel.sql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPhoneAssessmentHandler } from '../lib/phone-runtime/assessment-handler.js';
import {
  PHONE_RELABEL_RPC_PARAMETERS,
  SCREENING_ABANDONED_REASON,
} from '../lib/phone-screening/rpc-contract.js';
import { PHONE_SYSTEM_ACTOR } from '../lib/phone-screening/stores.js';
import { sanitizeErrorCode } from '../lib/queue/runner.js';

const SESSION = '11111111-1111-4111-a111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-a222-222222222222';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ENGAGEMENT = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee';

type Evidence = { evidence_grade: string | null; evidence_answered: number | null } | null;
type Result = { data: unknown; error: unknown };

interface Model {
  /** Answers to the latest-phone-evidence reads, in order (the last repeats). */
  evidence: Array<Evidence | 'error'>;
  engagement: { state: string; state_reason: string | null; session_id: string | null } | null | 'error';
  apply: Result;
  relabel: Result;
  /** `assessments` existence read on the not-applied path. */
  scoredRow: boolean;
}

function makeClient(over: Partial<Model> = {}) {
  const model: Model = {
    evidence: [null, { evidence_grade: 'insufficient', evidence_answered: 0 }],
    engagement: { state: 'completed', state_reason: null, session_id: SESSION },
    apply: { data: { status: 'applied' }, error: null },
    relabel: { data: { status: 'applied' }, error: null },
    scoredRow: true,
    ...over,
  };
  const log: string[] = [];
  const relabelCalls: Array<Record<string, unknown>> = [];
  const applyCalls: Array<Record<string, unknown>> = [];
  let evidenceReads = 0;

  const client = {
    async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
      log.push(`rpc:${name}`);
      if (name === 'phone_attempt_score_suppression') return { data: null, error: null };
      if (name === 'apply_phone_event') {
        applyCalls.push(args);
        return model.apply;
      }
      if (name === 'relabel_zero_answer_phone_engagement') {
        relabelCalls.push(args);
        return model.relabel;
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from(table: string) {
      log.push(`from:${table}`);
      let ordered = false;
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { ordered = true; return builder; },
        limit() { return builder; },
        async maybeSingle(): Promise<Result> {
          if (table === 'phone_appointments') return { data: null, error: null };
          if (table === 'assessments' && ordered) {
            const i = Math.min(evidenceReads, model.evidence.length - 1);
            evidenceReads += 1;
            const answer = model.evidence[i];
            if (answer === 'error') return { data: null, error: { message: 'boom' } };
            return { data: answer, error: null };
          }
          if (table === 'assessments') {
            return { data: model.scoredRow ? { id: 'a1' } : null, error: null };
          }
          if (table === 'phone_call_attempts') return { data: { engagement_id: ENGAGEMENT }, error: null };
          if (table === 'phone_engagements') {
            if (model.engagement === 'error') return { data: null, error: { message: 'boom' } };
            return { data: model.engagement === null ? null : { id: ENGAGEMENT, ...model.engagement }, error: null };
          }
          return { data: null, error: { message: `unexpected table ${table}` } };
        },
      };
      return builder;
    },
  };
  return { client, log, relabelCalls, applyCalls, model };
}

const PARTIAL = {
  session_id: SESSION,
  attempt_id: ATTEMPT,
  partial: true,
  covered: 0,
  total: 5,
  disconnect_reason: 'unobserved_disconnect',
};
const CLEAN = { session_id: SESSION, attempt_id: ATTEMPT };

function handlerFor(client: unknown, scored: string[]) {
  return createPhoneAssessmentHandler({
    client: client as never,
    score: async (sessionId) => { scored.push(sessionId); },
  });
}

describe('0115 — after the completion post, a measured 0-answer session is relabelled', () => {
  it.each([
    ['partial (stranded post)', PARTIAL],
    ['clean (attempt post)', CLEAN],
  ])('%s: score once, post once, then the relabel as the system actor', async (_label, payload) => {
    const scored: string[] = [];
    const { client, relabelCalls, applyCalls, log } = makeClient();
    await expect(handlerFor(client, scored)({ payload } as never)).resolves.toBeUndefined();
    expect(scored).toEqual([SESSION]);
    expect(applyCalls).toHaveLength(1);
    expect(relabelCalls).toHaveLength(1);
    expect(Object.keys(relabelCalls[0])).toEqual([
      ...PHONE_RELABEL_RPC_PARAMETERS.relabel_zero_answer_phone_engagement,
    ]);
    expect(relabelCalls[0].p_engagement_id).toBe(ENGAGEMENT);
    expect(relabelCalls[0].p_actor_id).toBe(PHONE_SYSTEM_ACTOR);
    expect(Number.isNaN(Date.parse(String(relabelCalls[0].p_now)))).toBe(false);
    // The completion post comes first (0044 interlock, MP3 finalize, backstop).
    expect(log.indexOf('rpc:apply_phone_event')).toBeLessThan(
      log.indexOf('rpc:relabel_zero_answer_phone_engagement'),
    );
  });

  it.each([
    ['one answered question', { evidence_grade: 'insufficient', evidence_answered: 1 }],
    ['an UNMEASURED count (NULL)', { evidence_grade: 'insufficient', evidence_answered: null }],
    ['a decision grade', { evidence_grade: 'decision', evidence_answered: 0 }],
    ['an ungraded row', { evidence_grade: null, evidence_answered: null }],
  ])('%s: no relabel call', async (_label, evidence) => {
    const scored: string[] = [];
    const { client, relabelCalls, applyCalls } = makeClient({ evidence: [null, evidence] });
    await handlerFor(client, scored)({ payload: PARTIAL } as never);
    expect(scored).toEqual([SESSION]);
    expect(applyCalls).toHaveLength(1);
    expect(relabelCalls).toHaveLength(0);
  });

  it('an engagement bound to ANOTHER session is not relabelled from this job', async () => {
    const { client, relabelCalls } = makeClient({
      engagement: { state: 'completed', state_reason: null, session_id: OTHER_SESSION },
    });
    await handlerFor(client, [])({ payload: PARTIAL } as never);
    expect(relabelCalls).toHaveLength(0);
  });

  it.each(['applied', 'already', 'not_eligible', 'some_future_status'])(
    'an RPC answer of %s is a success',
    async (status) => {
      const { client } = makeClient({ relabel: { data: { status }, error: null } });
      await expect(handlerFor(client, [])({ payload: PARTIAL } as never)).resolves.toBeUndefined();
    },
  );

  it('a not-applied completion with the scorecard landed still tries the relabel (self-guarding)', async () => {
    const { client, relabelCalls } = makeClient({
      apply: { data: { status: 'unexpected_event' }, error: null },
      relabel: { data: { status: 'not_eligible', reason: 'not_completed' }, error: null },
    });
    await expect(handlerFor(client, [])({ payload: PARTIAL } as never)).resolves.toBeUndefined();
    expect(relabelCalls).toHaveLength(1);
  });
});

describe('0115 — retry safety: a failed relabel never costs a second score', () => {
  it('an RPC error throws phone_assessment_relabel_failed; the retry relabels WITHOUT scoring or posting', async () => {
    const scored: string[] = [];
    const first = makeClient({ relabel: { data: null, error: { message: 'boom', code: 'PGRST000' } } });
    await expect(handlerFor(first.client, scored)({ payload: PARTIAL } as never))
      .rejects.toThrow('phone_assessment_relabel_failed');
    expect(scored).toEqual([SESSION]);
    expect(first.applyCalls).toHaveLength(1);

    // The retry: the 0-answer row now exists, the engagement is completed.
    const retry = makeClient({ evidence: [{ evidence_grade: 'insufficient', evidence_answered: 0 }] });
    await expect(handlerFor(retry.client, scored)({ payload: PARTIAL } as never)).resolves.toBeUndefined();
    expect(scored).toEqual([SESSION]); // still ONE score across both runs
    expect(retry.applyCalls).toHaveLength(0);
    expect(retry.relabelCalls).toHaveLength(1);
    expect(retry.relabelCalls[0].p_engagement_id).toBe(ENGAGEMENT);
    expect(retry.log.indexOf('rpc:relabel_zero_answer_phone_engagement')).toBeGreaterThan(
      retry.log.indexOf('rpc:phone_attempt_score_suppression'),
    );
  });

  it('a replay after the relabel (engagement already failed/screening_abandoned): relabel only, answers already', async () => {
    const scored: string[] = [];
    const { client, applyCalls, relabelCalls } = makeClient({
      evidence: [{ evidence_grade: 'insufficient', evidence_answered: 0 }],
      engagement: { state: 'failed', state_reason: SCREENING_ABANDONED_REASON, session_id: SESSION },
      relabel: { data: { status: 'already' }, error: null },
    });
    await expect(handlerFor(client, scored)({ payload: PARTIAL } as never)).resolves.toBeUndefined();
    expect(scored).toHaveLength(0);
    expect(applyCalls).toHaveLength(0);
    expect(relabelCalls).toHaveLength(1);
  });

  it('an existing 0-answer row with the engagement NOT yet completed takes the ordinary path', async () => {
    // e.g. an earlier completion post that did not apply: score() adopts the
    // existing row (runAssessment's 0044 reuse) and the post is retried.
    const scored: string[] = [];
    const { client, applyCalls } = makeClient({
      evidence: [{ evidence_grade: 'insufficient', evidence_answered: 0 }],
      engagement: { state: 'reconnecting', state_reason: null, session_id: SESSION },
    });
    await handlerFor(client, scored)({ payload: PARTIAL } as never);
    expect(scored).toEqual([SESSION]);
    expect(applyCalls).toHaveLength(1);
  });

  it('a failed engagement with any OTHER reason is not short-circuited', async () => {
    const scored: string[] = [];
    const { client, applyCalls } = makeClient({
      evidence: [{ evidence_grade: 'insufficient', evidence_answered: 0 }],
      engagement: { state: 'failed', state_reason: 'assessment_aborted', session_id: SESSION },
    });
    await handlerFor(client, scored)({ payload: PARTIAL } as never);
    expect(scored).toEqual([SESSION]);
    expect(applyCalls).toHaveLength(1);
  });

  it('an evidence read error throws BEFORE score()', async () => {
    const scored: string[] = [];
    const { client, applyCalls } = makeClient({ evidence: ['error'] });
    await expect(handlerFor(client, scored)({ payload: PARTIAL } as never))
      .rejects.toThrow('phone_assessment_evidence_read_failed');
    expect(scored).toHaveLength(0);
    expect(applyCalls).toHaveLength(0);
  });

  it('an engagement read error after the post throws (the retry takes the early path)', async () => {
    const { client } = makeClient({ engagement: 'error' });
    await expect(handlerFor(client, [])({ payload: PARTIAL } as never))
      .rejects.toThrow('phone_assessment_engagement_read_failed');
  });
});

describe('0115 — handler source', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../lib/phone-runtime/assessment-handler.ts', import.meta.url)),
    'utf8',
  );

  it('names the relabel RPC once, and the early path sits between the guards and score()', () => {
    expect(src.match(/'relabel_zero_answer_phone_engagement'/g)).toHaveLength(1);
    const suppression = src.indexOf("throw new Error('phone_assessment_suppression_check_failed')");
    const early = src.indexOf('const prior = await latestPhoneEvidence(');
    const score = src.indexOf('await score(sessionId');
    expect(suppression).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(suppression);
    expect(score).toBeGreaterThan(early);
  });

  it('every new error code survives the queue sanitizer verbatim', () => {
    for (const code of [
      'phone_assessment_relabel_failed',
      'phone_assessment_evidence_read_failed',
      'phone_assessment_engagement_read_failed',
    ]) {
      expect(src).toContain(`'${code}'`);
      expect(sanitizeErrorCode(new Error(code))).toBe(code);
    }
  });

  it('never requeues: the handler writes no candidate status and enqueues nothing', () => {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\.from\('candidates'\)/);
    expect(code).not.toMatch(/\bqueued\b/);
    expect(code).not.toMatch(/\.enqueue\(/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});
