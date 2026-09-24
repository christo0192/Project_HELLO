/**
 * The queue seam: is the handler actually REGISTERED, and does it reach the
 * job with the store it was given?
 *
 * `candidate-question-jobs.test.ts` proves the decisions and
 * `candidate-question-store.test.ts` proves the reads and writes. Neither
 * touches `buildAshbyHandlers`, so the queue NAME could drift from the one the
 * enqueue uses, or the handler could be dropped from the map entirely, with
 * both of those suites green and every generated question silently never
 * written. A queue can complete jobs while doing nothing useful — that is the
 * shape of PR #66 and of the signal prefilter, and both were invisible for the
 * same reason.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAshbyHandlers,
} from '../integrations/ashby/runtime-workers.js';
import {
  CANDIDATE_QUESTIONS_QUEUE,
  type CandidateQuestionsContext,
  type CandidateQuestionsStore,
} from '../lib/candidate-question-jobs.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

/** The smallest runtime `buildAshbyHandlers` will accept. */
function runtime() {
  return {
    runtimeConfig: {},
    stores: {},
    materialization: {} as MaterializationStore,
  } as never;
}

function job(payload: unknown) {
  return {
    id: 'job_1',
    name: CANDIDATE_QUESTIONS_QUEUE,
    payload,
    attempts: 1,
    maxAttempts: 2,
    createdAt: new Date().toISOString(),
  } as never;
}

function store(context: CandidateQuestionsContext | null) {
  return {
    loadContext: vi.fn().mockResolvedValue(context),
    currentTemplateFingerprint: vi.fn().mockResolvedValue(null),
    writeReady: vi.fn().mockResolvedValue(undefined),
    writeFailed: vi.fn().mockResolvedValue(undefined),
  } satisfies CandidateQuestionsStore & Record<string, unknown>;
}

describe('the candidate-questions queue seam', () => {
  it('REGISTERS a handler under the name the enqueue uses', () => {
    // One name, two call sites. If they drift, the job is enqueued for ever
    // and claimed by nothing — no error, no event, just no questions.
    const handlers = buildAshbyHandlers(runtime());
    expect(Object.keys(handlers)).toContain(CANDIDATE_QUESTIONS_QUEUE);
    expect(typeof handlers[CANDIDATE_QUESTIONS_QUEUE]).toBe('function');
  });

  it('does not disturb the three queues that were already there', () => {
    const handlers = buildAshbyHandlers(runtime());
    for (const name of ['ashby.signal', 'ashby.import', 'ashby.ingestion']) {
      expect(Object.keys(handlers), name).toContain(name);
    }
  });

  it('REACHES THE JOB with the injected store, and with the payload id', async () => {
    const s = store(null);
    const handlers = buildAshbyHandlers(runtime(), { candidateQuestionStore: s });
    await handlers[CANDIDATE_QUESTIONS_QUEUE](job({ applicationLinkId: 'link-42' }));
    expect(s.loadContext).toHaveBeenCalledWith('link-42');
  });

  it('IGNORES a job with no usable payload rather than throwing', async () => {
    // A malformed payload is a dead-letter, not a retry: nothing about it
    // improves on a second attempt, and throwing would burn the budget and
    // then park the job as failed for a reason nobody can act on.
    const s = store(null);
    const handlers = buildAshbyHandlers(runtime(), { candidateQuestionStore: s });
    for (const payload of [{}, { applicationLinkId: '' }, { applicationLinkId: 42 }, null]) {
      await expect(
        handlers[CANDIDATE_QUESTIONS_QUEUE](job(payload)),
      ).resolves.toBeUndefined();
    }
    expect(s.loadContext).not.toHaveBeenCalled();
  });

  it('RUNS THE REAL GENERATOR AND THE REAL JOB, not a stub of either', async () => {
    // The handler is a thin adapter, and the cheapest way to prove it is wired
    // to the real thing is to hand it a context the real generator has a
    // settled opinion about. A résumé this thin is `no_resume` — decided
    // BEFORE any provider call, so this test reaches no network — and the job
    // RECORDS that rather than throwing, which is the "only a provider fault
    // is retryable" rule arriving through the handler.
    const s = store({
      engagementId: 'eng-1',
      roleId: 'role-1',
      engagementTerminal: false,
      roleTitle: 'Inside Sales Advisor',
      jd: null,
      requiredSkills: [],
      template: [
        { id: 'q1', question: 'Tell me about yourself?', weight: 1, category: 'introduction' },
        { id: 'q2', question: 'What does your day look like?', weight: 1, category: 'profile_relevance' },
      ],
      resume: { name: 'Asha' },
      existing: null,
    });
    const handlers = buildAshbyHandlers(runtime(), { candidateQuestionStore: s });
    await expect(
      handlers[CANDIDATE_QUESTIONS_QUEUE](job({ applicationLinkId: 'link-42' })),
    ).resolves.toBeUndefined();

    expect(s.writeReady).not.toHaveBeenCalled();
    expect(s.writeFailed).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      roleId: 'role-1',
      reason: 'no_resume',
    });
  });

  it('spends NO provider call on a role that predates compartments', async () => {
    // The other settled refusal, and the one that decides whether this feature
    // costs anything at all for the roles that existed before it.
    const s = store({
      engagementId: 'eng-2',
      roleId: 'role-2',
      engagementTerminal: false,
      roleTitle: 'Inside Sales Advisor',
      jd: null,
      requiredSkills: [],
      template: [{ id: 'q1', question: 'Tell me about yourself?', weight: 1 }],
      resume: { name: 'Asha' },
      existing: null,
    });
    const handlers = buildAshbyHandlers(runtime(), { candidateQuestionStore: s });
    await handlers[CANDIDATE_QUESTIONS_QUEUE](job({ applicationLinkId: 'link-43' }));
    expect(s.writeFailed).toHaveBeenCalledWith({
      engagementId: 'eng-2',
      roleId: 'role-2',
      reason: 'no_variable_slots',
    });
  });
});
