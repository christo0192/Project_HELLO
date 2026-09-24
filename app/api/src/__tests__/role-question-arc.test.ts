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
  REPHRASE_TIMEOUT_MS,
} from '../lib/role-authoring.js';
import {
  ROLE_DRAFT_SHIFT_QUESTION,
  ROLE_DRAFT_RELEVANCE_COUNT,
  ROLE_DRAFT_STABILITY_COUNT,
} from '../lib/role-authoring.js';
import { validatePhoneQuestion } from '../lib/phone-screening/question-validation.js';
import { createRoleSchema } from '../schemas/roles.js';

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
    profile_relevance: modelQuestions.slice(0, 2).map((question) => ({ question, weight: 1 })),
    stability: [{ question: modelQuestions[2], weight: 1 }],
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
    // A RULE OVER THE ARRAY, not three positional assertions. Destructuring
    // `[current, expected, notice]` left anything at index >= 3 unchecked, so
    // appending a fourth closer worded "What annual CTC are you looking for in
    // your next position?" — the exact sentence this arc exists to remove —
    // passed. Every count assertion moves with the array length, so nothing
    // else objected either.
    const compensation = /\b(?:ctc|salary|compensation|package)\b/i;
    const current = /\bcurrent\b/i;
    const expected = /\bexpected\b|\bexpectation/i;

    let sawCurrent = false;
    let sawExpected = false;
    for (const q of ROLE_DRAFT_CLOSING_QUESTIONS) {
      if (!compensation.test(q)) continue;
      // EVERY compensation closer must say which side it asks about, or the
      // worker treats it as answered by anything at all.
      const hasCurrent = current.test(q);
      const hasExpected = expected.test(q);
      expect(
        hasCurrent || hasExpected,
        `"${q}" is a compensation objective carrying neither "current" nor "expected", so phone_answer_covers_objective returns true for ANY answer and it is never asked`,
      ).toBe(true);
      sawCurrent ||= hasCurrent;
      sawExpected ||= hasExpected;
    }
    expect(sawCurrent, 'a closer must ask for CURRENT CTC').toBe(true);
    expect(sawExpected, 'a closer must ask for EXPECTED CTC').toBe(true);

    // And one closer keys on the availability branch instead.
    expect(
      ROLE_DRAFT_CLOSING_QUESTIONS.some((q) =>
        /\b(?:notice period|available|availability|start)\b/i.test(q),
      ),
    ).toBe(true);
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
    // The model's questions are the two middle compartments, in the order it
    // wrote them, with the fixed shift question sitting between them.
    expect(texts.slice(1, 1 + ROLE_DRAFT_RELEVANCE_COUNT)).toEqual(
      modelQuestions.slice(0, ROLE_DRAFT_RELEVANCE_COUNT),
    );
    expect(texts[1 + ROLE_DRAFT_RELEVANCE_COUNT]).toBe(ROLE_DRAFT_SHIFT_QUESTION);
    expect(texts[2 + ROLE_DRAFT_RELEVANCE_COUNT]).toBe(modelQuestions[2]);
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
    // NAMED COMPARTMENTS, and the counts it is held to.
    expect(prompt).toContain(`"profile_relevance": ${ROLE_DRAFT_RELEVANCE_COUNT} questions`);
    expect(prompt).toContain(`"stability": ${ROLE_DRAFT_STABILITY_COUNT} question`);
    expect(prompt).toMatch(/do NOT write an introduction question/i);
    expect(prompt).toMatch(/do NOT ask about shifts\s+or working hours/i);
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

    // BOUNDED PER COMPARTMENT. A count in the prompt is a rule with nothing
    // behind it; the model wrote six last week. Flooding `profile_relevance`
    // fills only that compartment — the stability slot stays EMPTY rather than
    // being padded with relevance questions, so the total is one short of the
    // full arc and every fixed question is still present and in order.
    expect(texts.length).toBeLessThan(ROLE_DRAFT_TOTAL_QUESTIONS);
    expect(texts[0]).toBe(ROLE_DRAFT_OPENING_QUESTION);
    expect(texts).toContain(ROLE_DRAFT_SHIFT_QUESTION);
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

  it('DROPS a model question the arc already asks — including the SHIFT one', async () => {
    // This PR added `ROLE_DRAFT_SHIFT_QUESTION` to `arcKeys`, and removing it
    // again left all 6095 API tests green: the test above feeds back only the
    // OPENER. The prompt's "do NOT ask about shifts or working hours" is a
    // prompt rule, and this file's standing argument is that those hold only
    // most of the time — when one is missed the duplicate is a template-level
    // `duplicate_text` and `createRoleSchema` refuses the WHOLE role on Save.
    const infer = vi.fn().mockResolvedValue({
      jd: 'A job description with enough prose to be usable.',
      required_skills: ['Sales'],
      profile_relevance: [
        { question: ROLE_DRAFT_SHIFT_QUESTION, weight: 1 },
        ...modelQuestions.slice(0, 2).map((question) => ({ question, weight: 1 })),
      ],
      stability: [{ question: 'How long did you stay in your last two jobs?', weight: 1 }],
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const texts = draft.screening_template.map((q) => q.question);

    expect(texts.filter((t) => t === ROLE_DRAFT_SHIFT_QUESTION)).toHaveLength(1);
    expect(new Set(texts).size).toBe(texts.length);
    // And it is still the arc's own copy, in the arc's own slot — dropping the
    // model's duplicate must not cost the compartment its question.
    expect(draft.screening_template.find((q) => q.category === 'shift_fit')?.question).toBe(
      ROLE_DRAFT_SHIFT_QUESTION,
    );
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
    // The shift question is a hard qualifier, so it is mandatory too.
    const shiftIndex = draft.screening_template.findIndex((q) => q.category === 'shift_fit');
    expect(flags[shiftIndex]).toBe(true);
    // The model's own compartments are NOT mandatory — flagging everything
    // would make the priority signal meaningless.
    for (const q of draft.screening_template) {
      if (q.category === 'profile_relevance' || q.category === 'stability') {
        expect(q.mandatory === true, q.question).toBe(false);
      }
    }
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
        profile_relevance: [
          { question: 'What is your system administration experience?', weight: 1 },
          { question: modelQuestions[1], weight: 1 },
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

  it('CAPS THE PROVIDER BUDGET, because this route is synchronous', async () => {
    // The cap lived only inside the default `infer` closure, and every other
    // test injects `deps.infer` — so it was unreachable and deleting it left
    // the suite green. Production reads the RAISED Fly secret (up to 300s),
    // and two gate attempts x the runner's own retry against that is ~20
    // minutes on an Express handler with no client abort. `runJson` is the
    // seam that reaches it, the same shape `roleDraftTimeoutMs` uses.
    const runJson = vi.fn().mockResolvedValue({
      data: { question: 'Which tools do you use every day?' },
    });
    await rephraseQuestion('What is your system experience?', { runJson: runJson as never });
    const opts = runJson.mock.calls[0][1] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeLessThanOrEqual(REPHRASE_TIMEOUT_MS);
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

describe('the call runs in compartments', () => {
  // ORDER IS THE STRUCTURE. `0044`'s plan builder copies `screening_template`
  // verbatim, in order, so the sequence below IS how the conversation runs —
  // no migration, and nothing new for the worker to understand.
  it('assembles intro -> relevance -> shift -> stability -> pay', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const categories = draft.screening_template.map((q) => q.category);

    expect(categories).toEqual([
      'introduction',
      ...Array(ROLE_DRAFT_RELEVANCE_COUNT).fill('profile_relevance'),
      'shift_fit',
      ...Array(ROLE_DRAFT_STABILITY_COUNT).fill('stability'),
      'compensation',
      'compensation',
      'compensation',
    ]);
  });

  it('LABELS BY WHICH ARRAY IT CAME BACK IN, not by asking the model', async () => {
    // A self-reported `category` field would be wrong in exactly the way that
    // is invisible: a correct-looking draft with a pay question sitting in the
    // middle of the screen. The compartment is decided by which request the
    // answer arrived in, so the model cannot mislabel it.
    const infer = vi.fn().mockResolvedValue({
      ...goodDraft(),
      // THE PLANTED VALUE MUST BE `stability`, and an earlier version of this
      // test planted 'compensation' instead — which is INERT. `withArc` buckets
      // on exactly one comparison, `q.category === 'stability'`, and overwrites
      // the label from the bucket afterwards, so a planted 'compensation'
      // changes nothing and the test passed even when the model's self-report
      // was allowed to win. Proven by mutation: spreading the model object over
      // the structural label kept all 30 tests green.
      profile_relevance: [
        { question: 'What does your current role involve day to day?', weight: 1, category: 'stability' },
        { question: 'How do you handle an unhappy customer?', weight: 1 },
      ],
      stability: [{ question: 'How long did you stay in your last two jobs?', weight: 1 }],
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    const relevance = draft.screening_template.filter((q) => q.category === 'profile_relevance');
    expect(relevance).toHaveLength(ROLE_DRAFT_RELEVANCE_COUNT);
    expect(relevance[0].question).toBe('What does your current role involve day to day?');
    // And the compartment the model tried to claim still holds the question
    // that actually came back in the `stability` array — if the self-report
    // won, this is the relevance question instead, and the genuine stability
    // question is dropped entirely.
    const stability = draft.screening_template.filter((q) => q.category === 'stability');
    expect(stability).toHaveLength(ROLE_DRAFT_STABILITY_COUNT);
    expect(stability[0].question).toBe('How long did you stay in your last two jobs?');
  });

  it('BOUNDS THE STABILITY COMPARTMENT TOO, not only relevance', async () => {
    // The mirror of the flood test above, and it was missing: every flood
    // fixture in this file filled `profile_relevance`, so nothing ever put
    // more than one entry in `stability` and the `.slice()` bounding it could
    // be DELETED with all 6095 API tests green. A model answering with forty
    // stability questions then produced a 47-question call.
    const infer = vi.fn().mockResolvedValue({
      jd: 'A job description with enough prose to be usable.',
      required_skills: ['Sales'],
      profile_relevance: modelQuestions.slice(0, 2).map((question) => ({ question, weight: 1 })),
      stability: Array.from({ length: 40 }, (_, i) => ({
        question: `How long did you stay in the role before number ${i}?`,
        weight: 1,
      })),
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });

    expect(draft.screening_template).toHaveLength(ROLE_DRAFT_TOTAL_QUESTIONS);
    expect(
      draft.screening_template.filter((q) => q.category === 'stability'),
    ).toHaveLength(ROLE_DRAFT_STABILITY_COUNT);
    // The surplus must come off the MIDDLE, never off the pay questions.
    expect(
      draft.screening_template.slice(-ROLE_DRAFT_CLOSING_QUESTIONS.length).map((q) => q.question),
    ).toEqual([...ROLE_DRAFT_CLOSING_QUESTIONS]);
  });

  it('NEVER FILLS THE STABILITY SLOT with a relevance question', async () => {
    // A model that writes five relevance questions and no stability one must
    // leave the compartment empty rather than have it quietly mean something
    // else — the whole value of naming them is that a recruiter can trust what
    // each one contains.
    const infer = vi.fn().mockResolvedValue({
      jd: 'A job description with enough prose to be usable.',
      required_skills: ['Sales'],
      profile_relevance: modelQuestions.map((question) => ({ question, weight: 1 })),
      stability: [],
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    expect(draft.screening_template.filter((q) => q.category === 'stability')).toHaveLength(0);
    expect(
      draft.screening_template.filter((q) => q.category === 'profile_relevance'),
    ).toHaveLength(ROLE_DRAFT_RELEVANCE_COUNT);
  });

  it('ACCEPTS THE OLD FLAT SHAPE rather than wasting the whole wait', async () => {
    // The response shape is the model's to get wrong. A run that answers with
    // the old `screening_template` still produces a usable draft; those
    // questions are profile relevance, which is what a flat list of role
    // questions has always been.
    const infer = vi.fn().mockResolvedValue({
      jd: 'A job description with enough prose to be usable.',
      required_skills: ['Sales'],
      screening_template: modelQuestions.map((question) => ({ question, weight: 1 })),
    });
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    expect(draft.screening_template.some((q) => q.category === 'profile_relevance')).toBe(true);
    expect(draft.screening_template[0].category).toBe('introduction');
  });

  it('the SHIFT question is speakable and is asked of everyone', () => {
    // Fixed, and mandatory: a candidate who cannot work US hours is a no
    // regardless of how strong the rest of the call was, and it is the
    // question a recruiter most often leaves until after they already like
    // someone.
    expect(validatePhoneQuestion(ROLE_DRAFT_SHIFT_QUESTION)).toEqual([]);

    // AND IT ASKS WHAT IT IS NAMED FOR. Speakability was the only assertion on
    // the one question this work adds, so it could be replaced with "What is
    // your current annual CTC in your present job?" — a pay question sitting in
    // the shift compartment, asking CTC twice and never asking about nights —
    // with every test in the repository still green. Every other fixed question
    // here carries a meaning-level assertion; this restores the parity.
    expect(ROLE_DRAFT_SHIFT_QUESTION.toLowerCase()).toMatch(/night|overnight|shift/);
    // It must NOT read as a compensation objective: `phone_answer_covers_
    // objective` keys on ctc/salary/compensation/package, and a shift question
    // carrying one of those words with no `current`/`expected` slot would be
    // treated as answered by anything at all and never asked.
    expect(ROLE_DRAFT_SHIFT_QUESTION.toLowerCase()).not.toMatch(
      /\b(?:ctc|salary|compensation|package)\b/,
    );
  });

  it('the EXPECTED-CTC question asks for negotiating room and keeps its token', async () => {
    // The owner asked for room to negotiate. The clause must not cost the
    // `expected` token — without it `phone_answer_covers_objective` treats the
    // question as answered by anything at all and it is never asked.
    const expected = ROLE_DRAFT_CLOSING_QUESTIONS[1];
    expect(expected).toMatch(/\bexpected\b/i);
    expect(expected.toLowerCase()).toContain('negotiate');
    expect(validatePhoneQuestion(expected)).toEqual([]);
  });

  it('the whole compartmented draft still passes the SAVE schema', async () => {
    // `screeningQuestionSchema` is `.strict()`, so an unknown `category` would
    // not be ignored — it would fail Save minutes after the operator waited.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    expect(() => createRoleSchema.parse({ title: 'Sales Advisor', ...draft })).not.toThrow();
  });

  it('every fixed compartment question is MANDATORY, and the model\'s are not', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });
    for (const q of draft.screening_template) {
      const fixed = q.category === 'introduction' || q.category === 'shift_fit' || q.category === 'compensation';
      expect(q.mandatory === true, `${q.category}: ${q.question}`).toBe(fixed);
    }
  });
});
