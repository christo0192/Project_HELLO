/**
 * Ask Hello — the generator that drafts a role from a job title.
 *
 * The load-bearing claim is NOT "it calls a model". It is that nothing this
 * produces can reach a live call unspoken: every question is run through the
 * SAME `validatePhoneQuestion` the save path runs, and a draft is returned
 * only when all of them pass. An unspeakable question in a role template
 * killed two live calls one second after consent on 2026-09-10, so a
 * generator that trusted the model would be that incident with a button.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateRoleDraft,
  RoleDraftError,
  ROLE_DRAFT_MAX_ATTEMPTS,
} from '../lib/role-authoring.js';
import { validatePhoneQuestion } from '../lib/phone-screening/question-validation.js';

/** A draft the phone gate accepts. */
function goodDraft(overrides: Record<string, unknown> = {}) {
  return {
    jd: 'A job description with enough prose to be usable.',
    required_skills: ['Communication', 'Sales'],
    screening_template: [
      { question: 'What does your current role involve day to day?', weight: 1 },
      { question: 'How do you handle an unhappy customer?', weight: 1 },
    ],
    ...overrides,
  };
}

describe('generateRoleDraft — nothing unspeakable escapes', () => {
  it('returns the draft when every question passes the gate', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft, attempts, repaired } = await generateRoleDraft('Sales Advisor', { infer });

    expect(attempts).toBe(1);
    expect(repaired).toEqual([]);
    expect(draft.screening_template).toHaveLength(2);
    // Proven against the REAL validator, not a copy of its rules.
    for (const q of draft.screening_template) {
      expect(validatePhoneQuestion(q.question)).toEqual([]);
    }
  });

  it('RETRIES a question the phone gate refuses, and feeds back WHY', async () => {
    // "system" is banned outright by META_RE — and this is the natural
    // phrasing for a Talent Acquisition role, which is why the retry exists.
    const bad = goodDraft({
      screening_template: [
        { question: 'How do you keep an applicant tracking system up to date?', weight: 1 },
      ],
    });
    const infer = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(goodDraft());

    const { draft, attempts, repaired } = await generateRoleDraft('TA Specialist', { infer });

    expect(attempts).toBe(2);
    expect(repaired).toHaveLength(1);
    // The SECOND prompt has to name the offending text, or the model is being
    // asked to fix something it cannot see.
    const secondPrompt = infer.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('applicant tracking system');
    expect(secondPrompt).toContain('REJECTED');
    for (const q of draft.screening_template) {
      expect(validatePhoneQuestion(q.question)).toEqual([]);
    }
  });

  it('THROWS rather than returning a draft it could not make speakable', async () => {
    // The whole point. Returning the last attempt, or dropping the bad
    // questions silently, would put an unspeakable question one Save away
    // from a live call.
    const stubborn = goodDraft({
      screening_template: [{ question: 'Describe your ideal recruiter?', weight: 1 }],
    });
    const infer = vi.fn().mockResolvedValue(stubborn);

    await expect(generateRoleDraft('Sourcer', { infer })).rejects.toThrow(RoleDraftError);
    expect(infer).toHaveBeenCalledTimes(ROLE_DRAFT_MAX_ATTEMPTS);
    await expect(generateRoleDraft('Sourcer', { infer })).rejects.toMatchObject({
      reason: 'unspeakable_questions',
    });
  });

  it('is BOUNDED — it cannot loop forever on a model that never complies', async () => {
    // "Retry until they all pass" taken literally is an unbounded loop against
    // a model measured at 133-206s per call.
    const infer = vi.fn().mockResolvedValue(
      goodDraft({ screening_template: [{ question: 'Tell me about your model?', weight: 1 }] }),
    );
    await expect(generateRoleDraft('Data', { infer })).rejects.toThrow(RoleDraftError);
    expect(infer).toHaveBeenCalledTimes(ROLE_DRAFT_MAX_ATTEMPTS);
  });

  it('rejects unusable output instead of half-building a role', async () => {
    const infer = vi.fn().mockResolvedValue({ nonsense: true });
    await expect(generateRoleDraft('Anything', { infer })).rejects.toMatchObject({
      reason: 'unusable_output',
    });
  });

  it('assigns its OWN question ids, never the model’s', async () => {
    // The save path rejects duplicate keys; a model repeating "q1" would fail
    // a gate for a reason that has nothing to do with the question.
    const infer = vi.fn().mockResolvedValue(
      goodDraft({
        screening_template: [
          { id: 'dup', question: 'What did you do last year?', weight: 1 },
          { id: 'dup', question: 'How do you plan a week?', weight: 1 },
        ],
      }),
    );
    const { draft } = await generateRoleDraft('Any', { infer });
    expect(draft.screening_template.map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('names every banned word IN THE PROMPT, checked against the real validator', async () => {
    // The prompt lists the banned words for the model. If that list drifts
    // from META_RE, the model is being told the wrong rules and every draft
    // pays for it in retries.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    await generateRoleDraft('Any', { infer });
    const prompt = infer.mock.calls[0][0] as string;

    for (const word of [
      'system',
      'developer',
      'assistant',
      'model',
      'prompt',
      'instruction',
      'interviewer',
      'recruiter',
    ]) {
      // Banned by the validator...
      expect(validatePhoneQuestion(`What is your ${word} experience?`)).toContain('directive');
      // ...and therefore named in the prompt.
      expect(prompt).toContain(word);
    }
  });
});

describe('generateRoleDraft — progress reporting', () => {
  it('reports every phase, so a ten-minute draft is never silent', async () => {
    const bad = goodDraft({
      screening_template: [{ question: 'What system do you use?', weight: 1 }],
    });
    const infer = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(goodDraft());
    const seen: string[] = [];

    await generateRoleDraft('Any', {
      infer,
      onProgress: (e) => seen.push(e.phase),
    });

    // First pass drafts and checks; the second is a REPAIR, and says so —
    // "drafting" twice would hide that anything went wrong.
    expect(seen).toEqual(['drafting', 'checking', 'repairing', 'checking']);
  });

  it('carries the rejected COUNT on a repair, so the UI can name it', async () => {
    const bad = goodDraft({
      screening_template: [
        { question: 'Which system do you prefer?', weight: 1 },
        { question: 'How do you brief a recruiter?', weight: 1 },
      ],
    });
    const infer = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(goodDraft());
    const repairs: unknown[] = [];

    await generateRoleDraft('Any', {
      infer,
      onProgress: (e) => {
        if (e.phase === 'repairing') repairs.push(e);
      },
    });

    expect(repairs).toEqual([
      { phase: 'repairing', attempt: 2, maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS, rejected: 2 },
    ]);
  });

  it('A THROWING PROGRESS SINK CANNOT FAIL THE DRAFT', async () => {
    // An observer must never break the thing it observes. Without the guard, a
    // client that disconnects mid-stream takes the generation down with it.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Any', {
      infer,
      onProgress: () => {
        throw new Error('client went away');
      },
    });
    expect(draft.screening_template).toHaveLength(2);
  });
});
