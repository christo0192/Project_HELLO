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
    expect(closers).toContain('expected annual ctc');
    expect(closers).toContain('notice period');
  });

  it('carries the TOKENS THE PHONE WORKER KEYS ON, not just the meaning', () => {
    // THE WORDING IS COUPLED TO A PYTHON PREDICATE, and nothing in TypeScript
    // makes that visible. `phone_answer_covers_objective` (phone.py:7793)
    // treats any text containing ctc/salary/compensation/package as a
    // compensation objective, then decides what an answer must contain by
    // reading the OBJECTIVE's own words:
    //
    //     needs_current  = /\bcurrent\b/         needs_expected = /\bexpected|expectation/
    //
    // A compensation question with NEITHER word is "covered" by every answer,
    // including an empty one. The second closer was first written "What annual
    // CTC are you looking for in your next position?", and the contiguous
    // forward-skip at agent.py:5586 therefore marked it answered off the back
    // of the CURRENT-CTC reply and never asked it — on every call, for every
    // role. Verified against the real predicate before and after.
    //
    // This test is the tripwire for that coupling. Rewording a closer is fine;
    // dropping the token its consumer keys on is not.
    const [current, expected, notice] = ROLE_DRAFT_CLOSING_QUESTIONS;
    expect(current).toMatch(/\bcurrent\b/i);
    expect(expected).toMatch(/\bexpected\b|\bexpectation/i);
    // Both are compensation objectives to the worker, so both need their token.
    for (const q of [current, expected]) {
      expect(q).toMatch(/\b(?:ctc|salary|compensation|package)\b/i);
    }
    // The notice closer keys on a different branch entirely.
    expect(notice).toMatch(/\b(?:notice period|available|availability|start)\b/i);
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

    // BOUNDED BY WHAT WAS ASKED FOR. "Write 4" is a prompt rule with nothing
    // behind it, and the model wrote six last week — which would have been a
    // ten-question form and a ten-question call against a ten-minute budget.
    expect(texts).toHaveLength(ROLE_DRAFT_TOTAL_QUESTIONS);
    expect(texts[0]).toBe(ROLE_DRAFT_OPENING_QUESTION);
    expect(texts.slice(-ROLE_DRAFT_CLOSING_QUESTIONS.length)).toEqual([
      ...ROLE_DRAFT_CLOSING_QUESTIONS,
    ]);
  });

  it('DROPS a model question the arc already asks', async () => {
    // The arc is spliced after `validatePhoneQuestionTemplate`, so a model
    // question that normalises to an arc question is invisible to the pre-arc
    // check and fatal on Save — `duplicate_text` is a template-level issue and
    // `createRoleSchema` refuses the whole role. The prompt tells the model not
    // to write an introduction or a salary question; this file's own argument
    // is that prompt rules hold only most of the time.
    const infer = vi.fn().mockResolvedValue({
      ...goodDraft(),
      screening_template: [
        { question: ROLE_DRAFT_OPENING_QUESTION, weight: 1 },
        ...modelQuestions.slice(0, 3).map((question) => ({ question, weight: 1 })),
      ],
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const texts = draft.screening_template.map((q) => q.question);

    expect(texts.filter((t) => t === ROLE_DRAFT_OPENING_QUESTION)).toHaveLength(1);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('MARKS THE ARC MANDATORY, or the worker is free to skip it', async () => {
    // `format_questions` (prompting.py:114) renders `[MUST ASK] ` only for a
    // question carrying this flag, inside a system prompt that says to cover
    // the bank "where relevant", not to ask every question mechanically, and
    // — when the call runs against its ten-minute budget — to "prioritize
    // mandatory items". Without the flag the arc was form-deep: true of the
    // draft, optional on the call. The no-template fallback plan already
    // marks expected CTC and notice period mandatory, so an Ask Hello role
    // was weaker than a role nobody had authored.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const flags = draft.screening_template.map((q) => q.mandatory === true);

    expect(flags[0]).toBe(true);
    expect(flags.slice(-ROLE_DRAFT_CLOSING_QUESTIONS.length)).toEqual(
      ROLE_DRAFT_CLOSING_QUESTIONS.map(() => true),
    );
    // The model's own questions are NOT mandatory — flagging everything would
    // make the priority signal meaningless.
    expect(flags.slice(1, 1 + modelQuestions.length)).toEqual(modelQuestions.map(() => false));
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
    // A LITERAL, not the constant. `toHaveBeenCalledTimes(REPHRASE_MAX_ATTEMPTS)`
    // reads the same symbol the loop does, so raising the ceiling to 25 passed
    // — and this route is SYNCHRONOUS, so the ceiling is the only thing between
    // one press and an Express handler held for N provider calls.
    expect(REPHRASE_MAX_ATTEMPTS).toBe(2);
    expect(infer).toHaveBeenCalledTimes(2);
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

  it('REFUSES A REWRITE THAT DROPS "expected" — the P0 this arc was fixed for', async () => {
    // The sharpest failure this button can have. "Keep the meaning" is a
    // prompt instruction and the post-gate only checks speakability, so a
    // rewrite of the expected-CTC closer could come back as "What annual CTC
    // are you looking for in your next role?" — verbatim the wording that
    // made `phone_answer_covers_objective` return true for ANY answer, so the
    // question is force-skipped on every call and recorded as asked. Perfectly
    // speakable, and silently destroys the thing this commit exists to fix.
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ question: 'What annual CTC are you looking for in your next role?' })
      .mockResolvedValueOnce({ question: 'What is your expected annual CTC going forward?' });
    const out = await rephraseQuestion(ROLE_DRAFT_CLOSING_QUESTIONS[1], { infer });

    expect(out).toBe('What is your expected annual CTC going forward?');
    expect(infer).toHaveBeenCalledTimes(2);
    // And the retry says WHICH word went missing, rather than asking again blind.
    expect(infer.mock.calls[1][0]).toMatch(/dropped "expected"/);
  });

  it('REFUSES a rewrite that drops "current"', async () => {
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ question: 'What annual CTC do you draw today, including variable pay?' })
      .mockResolvedValueOnce({ question: 'What is your current annual CTC including variable pay?' });
    const out = await rephraseQuestion(ROLE_DRAFT_CLOSING_QUESTIONS[0], { infer });
    expect(out).toMatch(/\bcurrent\b/i);
  });

  it('REFUSES a rewrite that drops "notice period"', async () => {
    // A different branch of the same predicate, and the same consequence.
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ question: 'How soon could you start if things move ahead?' })
      .mockResolvedValueOnce({ question: 'What is your notice period, and when could you start?' });
    const out = await rephraseQuestion(ROLE_DRAFT_CLOSING_QUESTIONS[2], { infer });
    expect(out).toMatch(/notice period/i);
  });

  it('LEAVES AN ORDINARY QUESTION FREE to be reworded however', async () => {
    // The constraint applies only where the worker actually reads the
    // question for those words. A role-specific question carrying none of
    // them must not be held to any of it.
    const infer = vi.fn().mockResolvedValue({ question: 'Which tools do you use every day?' });
    const out = await rephraseQuestion('How do you keep the applicant tracking system current?', {
      infer,
    });
    expect(out).toBe('Which tools do you use every day?');
    expect(infer).toHaveBeenCalledTimes(1);
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
