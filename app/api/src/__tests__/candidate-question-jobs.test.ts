/**
 * The job's decisions: regenerate or not, retry or record.
 *
 * All of it against a fake store, because none of these decisions need a
 * database to be wrong — and a mocked query builder would let a test assert a
 * payload nothing reads.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CANDIDATE_QUESTIONS_MAX_JOB_ATTEMPTS,
  CANDIDATE_QUESTIONS_QUEUE,
  runCandidateQuestionsJob,
  type CandidateQuestionsContext,
  type CandidateQuestionsStore,
} from '../lib/candidate-question-jobs.js';
import {
  CandidateQuestionsError,
  templateFingerprint,
  type CandidateTemplateQuestion,
} from '../lib/candidate-questions.js';

function template(): CandidateTemplateQuestion[] {
  return [
    { id: 'q1', question: 'To start, could you tell me about yourself?', weight: 1, mandatory: true, category: 'introduction' },
    { id: 'q2', question: 'What does your current role involve day to day?', weight: 1, category: 'profile_relevance' },
    { id: 'q3', question: 'How long have you stayed in your recent positions?', weight: 1, category: 'stability' },
    { id: 'q4', question: 'What is your current annual CTC?', weight: 1, mandatory: true, category: 'compensation' },
  ];
}

function context(over: Partial<CandidateQuestionsContext> = {}): CandidateQuestionsContext {
  return {
    engagementId: 'eng-1',
    roleId: 'role-1',
    engagementTerminal: false,
    roleTitle: 'Inside Sales Advisor',
    jd: 'Sell to enterprise buyers.',
    requiredSkills: ['Outbound calling'],
    template: template(),
    resume: { name: 'Asha' },
    existing: null,
    ...over,
  };
}

function fakeStore(ctx: CandidateQuestionsContext | null) {
  return {
    loadContext: vi.fn().mockResolvedValue(ctx),
    writeReady: vi.fn().mockResolvedValue(undefined),
    writeFailed: vi.fn().mockResolvedValue(undefined),
  } satisfies CandidateQuestionsStore & Record<string, unknown>;
}

/** A generator stub that returns a usable result without a provider. */
function generated(questions = template()) {
  return vi.fn().mockResolvedValue({
    questions,
    fingerprint: templateFingerprint(template()),
    rewritten: { profile_relevance: 1, stability: 1 },
  });
}

describe('when there is nothing to do', () => {
  it('stops when the link resolves to nothing', async () => {
    const store = fakeStore(null);
    const generate = generated();
    const outcome = await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek', generate },
    );
    expect(outcome).toBe('context_missing');
    expect(generate).not.toHaveBeenCalled();
    expect(store.writeReady).not.toHaveBeenCalled();
    expect(store.writeFailed).not.toHaveBeenCalled();
  });

  it('STOPS ON A TERMINAL ENGAGEMENT — that candidate will not be called again', async () => {
    const store = fakeStore(context({ engagementTerminal: true }));
    const generate = generated();
    const outcome = await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek', generate },
    );
    expect(outcome).toBe('engagement_terminal');
    expect(generate).not.toHaveBeenCalled();
  });

  it('STOPS when a ready set already covers the CURRENT template', async () => {
    // Idempotence across a redelivery. The queue dedups, but a dedup key only
    // covers jobs that are still in flight.
    const store = fakeStore(
      context({ existing: { status: 'ready', templateHash: templateFingerprint(template()) } }),
    );
    const generate = generated();
    const outcome = await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek', generate },
    );
    expect(outcome).toBe('already_current');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('when there is work to do', () => {
  it('REGENERATES when the recruiter has edited the template since', async () => {
    // The stored set embeds the fixed questions as they stood when it was
    // built, so a set whose fingerprint no longer matches is about a call that
    // is no longer the one being made.
    const store = fakeStore(
      context({ existing: { status: 'ready', templateHash: 'fnv1a32:deadbeef:4' } }),
    );
    const generate = generated();
    const outcome = await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek', generate },
    );
    expect(outcome).toBe('generated');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('regenerates over a FAILED row, in case the model does better this time', async () => {
    const store = fakeStore(
      context({ existing: { status: 'failed', templateHash: null } }),
    );
    const outcome = await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek', generate: generated() },
    );
    expect(outcome).toBe('generated');
  });

  it('WRITES WHAT THE GENERATOR RETURNED, not what it was given', async () => {
    const rewritten = template();
    rewritten[1] = { ...rewritten[1], question: 'At Lumen Retail, what did you change to grow pipeline?' };
    const store = fakeStore(context());
    const generate = vi.fn().mockResolvedValue({
      questions: rewritten,
      fingerprint: 'fnv1a32:abcd1234:4',
      rewritten: { profile_relevance: 1, stability: 1 },
    });

    await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek-v4-pro', generate },
    );

    expect(store.writeReady).toHaveBeenCalledTimes(1);
    const written = store.writeReady.mock.calls[0][0] as {
      engagementId: string; roleId: string | null; model: string; templateHash: string;
      questions: CandidateTemplateQuestion[];
    };
    expect(written.engagementId).toBe('eng-1');
    expect(written.roleId).toBe('role-1');
    expect(written.model).toBe('deepseek-v4-pro');
    // The FINGERPRINT THE GENERATOR COMPUTED, not one recomputed here: they
    // are the same value today, and storing a locally recomputed one would
    // silently start lying the day the generator's input differs.
    expect(written.templateHash).toBe('fnv1a32:abcd1234:4');
    // The full ordered template, with the rewritten question in place.
    expect(written.questions.map((q) => q.question)).toEqual(rewritten.map((q) => q.question));
    expect(written.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('hands the generator the ROLE context it was given', async () => {
    const store = fakeStore(context());
    const generate = generated();
    await runCandidateQuestionsJob(
      { applicationLinkId: 'link-1' },
      { store, model: 'deepseek', generate },
    );
    const input = generate.mock.calls[0][0] as {
      roleTitle: string; jd: string | null; requiredSkills: string[];
      template: CandidateTemplateQuestion[]; resume: unknown;
    };
    expect(input.roleTitle).toBe('Inside Sales Advisor');
    expect(input.jd).toBe('Sell to enterprise buyers.');
    expect(input.requiredSkills).toEqual(['Outbound calling']);
    expect(input.template.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(input.resume).toEqual({ name: 'Asha' });
  });
});

describe('when generation does not work', () => {
  for (const reason of ['no_variable_slots', 'no_resume', 'unspeakable_questions'] as const) {
    it(`RECORDS \`${reason}\` and completes — the call runs the role template`, async () => {
      // A settled answer. This résumé, this template and this model do not
      // produce a usable question, and re-running would pay for the same
      // answer again while a job churns attempts over a call that is already
      // correct.
      const store = fakeStore(context());
      const generate = vi.fn().mockRejectedValue(
        new CandidateQuestionsError('nope', reason, 'detail'),
      );
      const outcome = await runCandidateQuestionsJob(
        { applicationLinkId: 'link-1' },
        { store, model: 'deepseek', generate },
      );
      expect(outcome).toBe('not_generated');
      expect(store.writeFailed).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        roleId: 'role-1',
        reason,
      });
      expect(store.writeReady).not.toHaveBeenCalled();
    });
  }

  it('RE-THROWS A PROVIDER FAULT so the queue retries it, and records nothing', async () => {
    // The one failure a retry can do anything about. Recording it as failed
    // would turn a thirty-second outage into a permanently un-personalised
    // candidate.
    const store = fakeStore(context());
    const generate = vi.fn().mockRejectedValue(
      new CandidateQuestionsError('provider down', 'provider_error', 'timeout'),
    );
    await expect(
      runCandidateQuestionsJob({ applicationLinkId: 'link-1' }, { store, model: 'deepseek', generate }),
    ).rejects.toMatchObject({ reason: 'provider_error' });
    expect(store.writeFailed).not.toHaveBeenCalled();
    expect(store.writeReady).not.toHaveBeenCalled();
  });

  it('re-throws anything that is not one of ours, unrecorded', async () => {
    const store = fakeStore(context());
    const generate = vi.fn().mockRejectedValue(new TypeError('bug'));
    await expect(
      runCandidateQuestionsJob({ applicationLinkId: 'link-1' }, { store, model: 'deepseek', generate }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(store.writeFailed).not.toHaveBeenCalled();
  });
});

describe('the queue contract', () => {
  it('names one queue, and bounds the retry at two', () => {
    // Two: the retry is for a transient provider fault. Everything else is
    // already recorded as settled, so a third attempt buys nothing.
    expect(CANDIDATE_QUESTIONS_QUEUE).toBe('candidate.questions');
    expect(CANDIDATE_QUESTIONS_MAX_JOB_ATTEMPTS).toBe(2);
  });
});
