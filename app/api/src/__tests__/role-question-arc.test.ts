/**
 * The screening call has a SHAPE, and Rephrase is the way out of the gate.
 *
 * The first role authored with Ask Hello in production ("Sales v1 hiring")
 * produced six speakable, role-relevant questions in no particular order — no
 * introduction, and nothing about pay or notice. Those are the two facts that
 * decide whether a pipeline moves, so the recruiter had to chase them by hand
 * on every call the bot made.
 *
 * The arc is therefore FIXED TEXT rather than a prompt rule. Earlier rounds
 * established that the model follows stated rules only most of the time, and a
 * missed rule costs a whole 133-206s retry. These tests exist to prove the
 * fixed sentences survive the same phone gate everything else does — a
 * hard-coded question that the screener refuses to read aloud would break
 * EVERY role, not one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateRoleDraft,
  rephraseQuestion,
  RoleDraftError,
  ROLE_DRAFT_OPENING_QUESTION,
  ROLE_DRAFT_CLOSING_QUESTIONS,
  ROLE_DRAFT_QUESTION_COUNT,
  ROLE_DRAFT_TOTAL_QUESTIONS,
  REPHRASE_MAX_ATTEMPTS,
} from '../lib/role-authoring.js';
import { validatePhoneQuestion } from '../lib/phone-screening/question-validation.js';

/** Four role-specific questions, all of which pass the gate. */
const modelQuestions = [
  'What does your current role involve day to day?',
  'How do you handle an unhappy customer?',
  'What made you look for a new position?',
  'Which part of that work did you enjoy most?',
];

function goodDraft() {
  return {
    jd: 'A job description with enough prose to be usable.',
    required_skills: ['Communication', 'Sales'],
    screening_template: modelQuestions.map((question) => ({ question, weight: 1 })),
  };
}

describe('the fixed arc survives the real phone gate', () => {
  // THE WHOLE POINT. These four sentences ship in every role this feature
  // authors, so if `META_RE` ever grows a word one of them contains, every
  // future draft breaks at once — and it would break in the phone worker, on a
  // live call, not here. This is the test that makes that a red CI run.
  it('the opening question is speakable', () => {
    expect(validatePhoneQuestion(ROLE_DRAFT_OPENING_QUESTION)).toEqual([]);
  });

  it('every closing question is speakable', () => {
    for (const question of ROLE_DRAFT_CLOSING_QUESTIONS) {
      expect(validatePhoneQuestion(question), question).toEqual([]);
    }
  });

  it('the arc asks what it was asked to ask', () => {
    // Asserted on MEANING, not on an exact string, so rewording the sentences
    // stays free while dropping the subject does not.
    expect(ROLE_DRAFT_OPENING_QUESTION.toLowerCase()).toContain('yourself');
    expect(ROLE_DRAFT_OPENING_QUESTION.toLowerCase()).toContain('recent role');
    const closers = ROLE_DRAFT_CLOSING_QUESTIONS.join(' ').toLowerCase();
    expect(closers).toContain('current annual ctc');
    expect(closers).toContain('looking for');
    expect(closers).toContain('notice period');
  });
});

describe('generateRoleDraft wraps the model in that arc', () => {
  it('opens with the introduction and ends with pay and notice', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const texts = draft.screening_template.map((q) => q.question);

    expect(texts).toHaveLength(ROLE_DRAFT_TOTAL_QUESTIONS);
    expect(texts[0]).toBe(ROLE_DRAFT_OPENING_QUESTION);
    expect(texts.slice(-ROLE_DRAFT_CLOSING_QUESTIONS.length)).toEqual([
      ...ROLE_DRAFT_CLOSING_QUESTIONS,
    ]);
    // The model's own questions are the MIDDLE, in the order it wrote them.
    expect(texts.slice(1, 1 + modelQuestions.length)).toEqual(modelQuestions);
  });

  it('re-issues ids across the whole list, or the save path rejects it', async () => {
    // `validatePhoneQuestion` refuses duplicate keys, and the model's four
    // arrive as q1-q4. Splicing without re-numbering would produce two q1s and
    // fail a gate for a reason that has nothing to do with the questions.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const ids = draft.screening_template.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('q1');
    expect(ids.at(-1)).toBe(`q${ROLE_DRAFT_TOTAL_QUESTIONS}`);
  });

  it('the WHOLE delivered list passes the gate, arc included', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    for (const q of draft.screening_template) {
      expect(validatePhoneQuestion(q.question), q.question).toEqual([]);
    }
  });

  it('asks the model for the MIDDLE only, and says so', async () => {
    // A model that also writes an introduction and a salary question leaves
    // the operator deleting duplicates out of an eight-question form. The
    // prompt has to state the arc it is being slotted into.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    await generateRoleDraft('Sales Advisor', { infer });
    const prompt = infer.mock.calls[0][0] as string;
    expect(prompt).toContain(`Write ${ROLE_DRAFT_QUESTION_COUNT} screening questions`);
    expect(prompt).toMatch(/do NOT write an introduction question/i);
    expect(prompt).toMatch(/do NOT ask about salary, CTC/i);
  });

  it('KEEPS THE ARC when the model floods the list, and drops its surplus', async () => {
    // The arc costs four slots out of a ceiling `coerceDraft` has already
    // clamped to. Splicing without re-clamping produced MAX_QUESTIONS + 4 and
    // the draft then failed `createRoleSchema` on Save — minutes after the
    // operator waited for it. The opener and closers were asked for as "has
    // to" and "always", so the model's surplus is what gives way.
    const infer = vi.fn().mockResolvedValue({
      jd: 'A job description with enough prose to be usable.',
      required_skills: ['Communication'],
      screening_template: Array.from({ length: 5_000 }, (_, i) => ({
        question: `What did you do in situation number ${i}?`,
        weight: 1,
      })),
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const texts = draft.screening_template.map((q) => q.question);

    expect(texts.length).toBeLessThanOrEqual(100);
    expect(texts[0]).toBe(ROLE_DRAFT_OPENING_QUESTION);
    expect(texts.slice(-ROLE_DRAFT_CLOSING_QUESTIONS.length)).toEqual([
      ...ROLE_DRAFT_CLOSING_QUESTIONS,
    ]);
  });

  it('does NOT spend the repair budget on sentences the model never wrote', async () => {
    // The arc is applied AFTER validation. If it were applied before, a
    // rejected attempt would quote the three CTC questions back to the model
    // as things to fix — burning a 133-206s retry explaining sentences that
    // are already correct.
    const infer = vi
      .fn()
      .mockResolvedValueOnce({
        ...goodDraft(),
        screening_template: [
          { question: 'What is your system administration experience?', weight: 1 },
          ...modelQuestions.slice(1).map((question) => ({ question, weight: 1 })),
        ],
      })
      .mockResolvedValueOnce(goodDraft());
    const { draft, repaired } = await generateRoleDraft('Sales Advisor', { infer });

    expect(infer).toHaveBeenCalledTimes(2);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toContain('system administration');
    // And the second prompt does not mention the closers as failures.
    const secondPrompt = infer.mock.calls[1][0] as string;
    expect(secondPrompt).not.toContain('notice period, and how soon');
    expect(draft.screening_template).toHaveLength(ROLE_DRAFT_TOTAL_QUESTIONS);
  });
});

describe('rephraseQuestion — the way out of an unforgiving gate', () => {
  it('returns the rewrite when it passes', async () => {
    const infer = vi.fn().mockResolvedValue({
      question: 'How do you keep your applicant tracking tools up to date?',
    });
    const out = await rephraseQuestion(
      'How do you keep the applicant tracking system current?',
      { infer },
    );
    expect(out).toBe('How do you keep your applicant tracking tools up to date?');
    expect(validatePhoneQuestion(out)).toEqual([]);
    // One call when the first suggestion is good: a button beside a text field
    // must not cost two generations by default.
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it('NEVER hands back a suggestion that still fails the gate', async () => {
    // The failure this button exists to prevent. Returning the model's word
    // for it would be worse than the error message it replaced: the operator
    // would save a question the screener silently refuses to read.
    const infer = vi.fn().mockResolvedValue({
      question: 'What is your system administration experience?',
    });
    await expect(rephraseQuestion('anything', { infer })).rejects.toBeInstanceOf(RoleDraftError);
    expect(infer).toHaveBeenCalledTimes(REPHRASE_MAX_ATTEMPTS);
  });

  it('QUOTES THE FAILURE BACK on the retry, rather than asking again blind', async () => {
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ question: 'What is your system experience?' })
      .mockResolvedValueOnce({ question: 'What tools do you use every day?' });
    const out = await rephraseQuestion('What is your system experience?', { infer });
    expect(out).toBe('What tools do you use every day?');
    const retryPrompt = infer.mock.calls[1][0] as string;
    expect(retryPrompt).toContain('YOUR PREVIOUS SUGGESTION WAS REJECTED');
  });

  it('rejects a response that is not a question object at all', async () => {
    const infer = vi.fn().mockResolvedValue({ text: 'wrong key' });
    await expect(rephraseQuestion('anything', { infer })).rejects.toThrow(
      /could not rephrase/i,
    );
  });

  it('enforces the DIRECTIVE-OPENING rule the shared validator does not', async () => {
    // `validatePhoneQuestion` passes "Ask about a deal you closed?" — it has a
    // question mark. It is still an instruction to an interviewer rather than
    // something to say to a candidate, and the generator's stricter check is
    // what catches it. Rephrase has to apply BOTH gates or it becomes a way to
    // put exactly that sentence into a role.
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ question: 'Ask about a deal you closed recently?' })
      .mockResolvedValueOnce({ question: 'Which deal that you closed are you proudest of?' });
    const out = await rephraseQuestion('deals', { infer });
    expect(out).toBe('Which deal that you closed are you proudest of?');
  });
});
