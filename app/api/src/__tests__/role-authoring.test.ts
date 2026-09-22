/**
 * Ask Hello — the generator that drafts a role from a job title.
 *
 * The load-bearing claim is NOT "it calls a model". It is that nothing this
 * produces can reach a live call unspoken, and that nothing it returns can
 * fail on Save after the operator has waited minutes for it.
 *
 * THIS FILE HAS BEEN REWRITTEN ONCE ALREADY, because the first version was
 * vacuous in ways a review had to find: the "is BOUNDED" test asserted
 * `toHaveBeenCalledTimes(ROLE_DRAFT_MAX_ATTEMPTS)` — comparing against the
 * very constant it was meant to pin, so setting that constant to 1000 passed
 * every test (verified). The bound is now asserted as a LITERAL. Likewise the
 * unusable-output test used one fixture that failed all three shape guards at
 * once, so each guard could be deleted individually and stay green; there is
 * now a fixture per guard.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateRoleDraft,
  RoleDraftError,
  ROLE_DRAFT_MAX_ATTEMPTS,
  ROLE_DRAFT_QUESTION_COUNT,
} from '../lib/role-authoring.js';
import { validatePhoneQuestion } from '../lib/phone-screening/question-validation.js';
import { createRoleSchema } from '../schemas/roles.js';

/** A draft every gate accepts. At least MIN_QUESTIONS (3) entries. */
function goodDraft(overrides: Record<string, unknown> = {}) {
  return {
    jd: 'A job description with enough prose to be usable.',
    required_skills: ['Communication', 'Sales'],
    screening_template: [
      { question: 'What does your current role involve day to day?', weight: 1 },
      { question: 'How do you handle an unhappy customer?', weight: 1 },
      { question: 'What made you look for a new position?', weight: 1 },
    ],
    ...overrides,
  };
}

const q = (question: string, weight: unknown = 1) => ({ question, weight });

describe('generateRoleDraft — nothing unspeakable escapes', () => {
  it('returns the draft when every question passes the gate', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft, attempts, repaired } = await generateRoleDraft('Sales Advisor', { infer });

    expect(attempts).toBe(1);
    expect(repaired).toEqual([]);
    expect(draft.jd).toBe('A job description with enough prose to be usable.');
    expect(draft.required_skills).toEqual(['Communication', 'Sales']);
    expect(draft.screening_template).toHaveLength(3);
    expect(draft.screening_template[0].weight).toBe(1);
    for (const entry of draft.screening_template) {
      expect(validatePhoneQuestion(entry.question)).toEqual([]);
    }
  });

  it('RETURNS SOMETHING THE SAVE PATH WILL ACCEPT', async () => {
    // The highest-value assertion in the file. A draft that passes the
    // generator and then fails zod on Save is the half-authored role this
    // module promises never to produce — discovered by the operator minutes
    // after the wait. Weights, counts and string lengths are all clamped to
    // the save schema's bounds, and this proves it against the real schema.
    const infer = vi.fn().mockResolvedValue(
      goodDraft({
        // Every value here is out of the schema's range.
        required_skills: ['Sales', 'x'.repeat(500)],
        screening_template: [
          q('What does your current role involve?', 9999),
          q('How do you handle an unhappy customer?', -3),
          q('What made you look for a new position?', 'high'),
        ],
      }),
    );
    const { draft } = await generateRoleDraft('Sales Advisor', { infer });

    expect(() =>
      createRoleSchema.parse({ title: 'Sales Advisor', ...draft }),
    ).not.toThrow();
    // Clamped, not rejected — an out-of-range weight is a cosmetic fault and
    // failing the whole draft over one would waste the entire wait.
    // 9999 clamps DOWN to the schema's ceiling; a negative and a non-number
    // both fall back to the neutral 1 rather than to 0, because 0 means "this
    // metric does not count" and inventing that is a different claim.
    expect(draft.screening_template.map((e) => e.weight)).toEqual([100, 1, 1]);
    expect(draft.required_skills[1].length).toBe(200);
  });

  it('REFUSES a question with no question mark', async () => {
    // `validatePhoneQuestion`'s speakability test is an ALTERNATION —
    // "Describe your approach to handling objections." matches on `describe`
    // and passes it clean with no `?` at all (verified against the real
    // regex). The prompt tells the model to end with one; stating a rule and
    // not enforcing it is the worst of both.
    const imperative = goodDraft({
      screening_template: [
        q('Describe your approach to handling objections.'),
        q('Walk me through your last deal.'),
        q('Tell me about your pipeline.'),
      ],
    });
    const infer = vi.fn().mockResolvedValueOnce(imperative).mockResolvedValueOnce(goodDraft());

    const { draft, attempts } = await generateRoleDraft('Sales', { infer });
    expect(attempts).toBe(2);
    for (const entry of draft.screening_template) {
      expect(entry.question.trim().endsWith('?')).toBe(true);
    }
    expect(infer.mock.calls[1][0]).toContain('question mark');
  });

  it('REFUSES a question addressed to an interviewer, not the candidate', async () => {
    // "Ask about a deal you closed last quarter?" passes the save gate (it has
    // a `?` and matches no banned word) but is an instruction to a human
    // interviewer, not something to say to a candidate.
    const directive = goodDraft({
      screening_template: [
        q('Ask about a deal you closed last quarter?'),
        q('Probe their objection handling?'),
        q('What made you look for a new position?'),
      ],
    });
    const infer = vi.fn().mockResolvedValueOnce(directive).mockResolvedValueOnce(goodDraft());

    const { draft } = await generateRoleDraft('Sales', { infer });
    for (const entry of draft.screening_template) {
      expect(/^\s*(?:ask|probe|explore|cover|check|confirm|discuss|understand|find)\b/i.test(entry.question)).toBe(false);
    }
  });

  it('RETRIES a question the phone gate refuses, and feeds back WHY', async () => {
    // "system" is banned outright by META_RE — and this is the natural
    // phrasing for a Talent Acquisition role, which is why the retry exists.
    const bad = goodDraft({
      screening_template: [
        q('How do you keep an applicant tracking system up to date?'),
        q('How do you handle an unhappy customer?'),
        q('What made you look for a new position?'),
      ],
    });
    const infer = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(goodDraft());

    const { draft, attempts, repaired } = await generateRoleDraft('TA Specialist', { infer });

    expect(attempts).toBe(2);
    // CONTENT, not just length — asserting `toHaveLength(1)` let
    // `repaired.push('x')` survive.
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toContain('applicant tracking system');
    const secondPrompt = infer.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('applicant tracking system');
    expect(secondPrompt).toContain('REJECTED');
    for (const entry of draft.screening_template) {
      expect(validatePhoneQuestion(entry.question)).toEqual([]);
    }
  });

  it('does NOT double-count a question rejected on more than one attempt', async () => {
    // `repaired` used to accumulate every rejection from every pass, so 2
    // rejected then 1 rejected reported "rephrased 3 questions" beside a
    // three-question draft.
    const badTwice = goodDraft({
      screening_template: [
        q('Which system do you prefer?'),
        q('How do you brief a recruiter?'),
        q('What made you look for a new position?'),
      ],
    });
    const badOnce = goodDraft({
      screening_template: [
        q('Which system do you prefer?'),
        q('How do you handle an unhappy customer?'),
        q('What made you look for a new position?'),
      ],
    });
    const infer = vi
      .fn()
      .mockResolvedValueOnce(badTwice)
      .mockResolvedValueOnce(badOnce)
      .mockResolvedValueOnce(goodDraft());

    const { attempts, repaired } = await generateRoleDraft('TA', { infer });
    expect(attempts).toBe(3);
    // The LAST failing pass rejected one, not three.
    expect(repaired).toHaveLength(1);
  });

  it('THROWS rather than returning a draft it could not make speakable', async () => {
    const stubborn = goodDraft({
      screening_template: [
        q('Describe your ideal recruiter?'),
        q('How do you handle an unhappy customer?'),
        q('What made you look for a new position?'),
      ],
    });
    const infer = vi.fn().mockResolvedValue(stubborn);

    await expect(generateRoleDraft('Sourcer', { infer })).rejects.toMatchObject({
      reason: 'unspeakable_questions',
      // Streamed to the client, so the operator learns WHICH question failed.
      detail: [expect.stringContaining('ideal recruiter')],
    });
  });

  it('is BOUNDED AT THREE ATTEMPTS — asserted as a literal, not as the constant', async () => {
    // The previous version compared against ROLE_DRAFT_MAX_ATTEMPTS itself, so
    // setting that constant to 1000 passed every test — reinstating exactly
    // the unbounded loop against a 270s model that the bound exists to
    // prevent. Verified: `= 1000` was green.
    expect(ROLE_DRAFT_MAX_ATTEMPTS).toBe(3);
    const infer = vi.fn().mockResolvedValue(
      goodDraft({
        screening_template: [
          q('Tell me about your model?'),
          q('How do you handle an unhappy customer?'),
          q('What made you look for a new position?'),
        ],
      }),
    );
    await expect(generateRoleDraft('Data', { infer })).rejects.toThrow(RoleDraftError);
    expect(infer).toHaveBeenCalledTimes(3);
  });

  it('asks for a stated number of questions', async () => {
    // Unasserted anywhere before, so `= 1` or deleting the sentence was green
    // and a one-question screening template shipped as a success.
    expect(ROLE_DRAFT_QUESTION_COUNT).toBeGreaterThanOrEqual(4);
    const infer = vi.fn().mockResolvedValue(goodDraft());
    await generateRoleDraft('Any', { infer });
    expect(infer.mock.calls[0][0]).toContain(`Write ${ROLE_DRAFT_QUESTION_COUNT} screening questions`);
  });

  it('assigns its OWN question ids, never the model’s', async () => {
    const infer = vi.fn().mockResolvedValue(
      goodDraft({
        screening_template: [
          { id: 'dup', ...q('What did you do last year?') },
          { id: 'dup', ...q('How do you plan a week?') },
          { id: 'dup', ...q('What made you look for a new position?') },
        ],
      }),
    );
    const { draft } = await generateRoleDraft('Any', { infer });
    expect(draft.screening_template.map((e) => e.id)).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('generateRoleDraft — unusable output, one fixture per guard', () => {
  // One fixture that failed all three guards at once let each be deleted
  // individually and stay green.
  it('rejects a draft with no job description', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft({ jd: '   ' }));
    await expect(generateRoleDraft('Any', { infer })).rejects.toMatchObject({
      reason: 'unusable_output',
    });
  });

  it('rejects a draft with no skills', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft({ required_skills: [] }));
    await expect(generateRoleDraft('Any', { infer })).rejects.toMatchObject({
      reason: 'unusable_output',
    });
  });

  it('rejects a draft with TOO FEW questions, not merely zero', async () => {
    // A model returning six entries of which five use the key "text" instead
    // of "question" yielded a ONE-question draft that passed every gate and
    // was offered as a complete screening script.
    const infer = vi.fn().mockResolvedValue(
      goodDraft({
        screening_template: [
          q('What does your current role involve?'),
          { text: 'How do you handle an unhappy customer?' },
          { text: 'What made you look for a new position?' },
        ],
      }),
    );
    await expect(generateRoleDraft('Any', { infer })).rejects.toMatchObject({
      reason: 'unusable_output',
    });
  });

  it('rejects output that is not an object at all', async () => {
    const infer = vi.fn().mockResolvedValue('sorry, I cannot do that');
    await expect(generateRoleDraft('Any', { infer })).rejects.toMatchObject({
      reason: 'unusable_output',
    });
  });
});

describe('generateRoleDraft — provider failures', () => {
  it('A PROVIDER ERROR COSTS ONE ATTEMPT, NOT THE WHOLE BUDGET', async () => {
    // `runClaudeJSONWithProvenance` throws on a timeout, a non-2xx, and on
    // unparseable JSON — the most common model failure of all. Unguarded, the
    // first transient 502 escaped the loop entirely and surfaced as "could not
    // be reached" with two attempts unused while advertising three.
    const infer = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce(goodDraft());

    const { draft, attempts } = await generateRoleDraft('Any', { infer });
    expect(attempts).toBe(2);
    expect(draft.screening_template).toHaveLength(3);
  });

  it('names the provider failure when it burns every attempt', async () => {
    const infer = vi.fn().mockRejectedValue(new Error('504 upstream timeout'));
    await expect(generateRoleDraft('Any', { infer })).rejects.toMatchObject({
      reason: 'unusable_output',
      detail: [expect.stringContaining('504')],
    });
    expect(infer).toHaveBeenCalledTimes(3);
  });
});

describe('generateRoleDraft — the prompt states every rule the gate enforces', () => {
  it('warns about every banned WORD, and does so as a prohibition', async () => {
    // Asserting `prompt.toContain(word)` alone let the sentence be inverted to
    // "These words are perfectly fine to use: …" — the model would then be
    // told the opposite of the rule and every draft would burn all three
    // v4-pro attempts.
    const infer = vi.fn().mockResolvedValue(goodDraft());
    await generateRoleDraft('Any', { infer });
    const prompt = infer.mock.calls[0][0] as string;

    const banned = ['system', 'developer', 'assistant', 'model', 'prompt', 'instruction', 'interviewer', 'recruiter'];
    for (const word of banned) {
      // Banned by the REAL validator...
      expect(validatePhoneQuestion(`What is your ${word} experience?`)).toContain('directive');
    }
    // ...and the prompt forbids them, in one prohibition line.
    const line = prompt.split('\n').find((l) => l.includes('NOT contain any of these words'));
    expect(line).toBeDefined();
    for (const word of banned) expect(line).toContain(word);
  });

  it('warns about the MARKUP and CLAUSE rules too, not just the words', async () => {
    // These reject ordinary questions for Backend/Data/DevOps and CS roles,
    // and the prompt used to be silent on all of them — so those drafts burned
    // all three attempts deterministically.
    expect(validatePhoneQuestion('How comfortable are you writing JSON and YAML config?')).toContain('directive');
    expect(validatePhoneQuestion('How do you read the requirements before a build?')).toContain('directive');

    const infer = vi.fn().mockResolvedValue(goodDraft());
    await generateRoleDraft('Any', { infer });
    const prompt = infer.mock.calls[0][0] as string;
    expect(prompt).toContain('json');
    expect(prompt).toContain('read/repeat/output/respond');
    expect(prompt).toContain('question mark');
  });
});

describe('generateRoleDraft — progress reporting', () => {
  it('reports every phase, so a ten-minute draft is never silent', async () => {
    const bad = goodDraft({
      screening_template: [
        q('What system do you use?'),
        q('How do you handle an unhappy customer?'),
        q('What made you look for a new position?'),
      ],
    });
    const infer = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(goodDraft());
    const seen: string[] = [];

    await generateRoleDraft('Any', { infer, onProgress: (e) => seen.push(e.phase) });
    expect(seen).toEqual(['drafting', 'checking', 'repairing', 'checking']);
  });

  it('carries the rejected COUNT on a repair, so the UI can name it', async () => {
    const bad = goodDraft({
      screening_template: [
        q('Which system do you prefer?'),
        q('How do you brief a recruiter?'),
        q('What made you look for a new position?'),
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
    expect(repairs).toEqual([{ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 2 }]);
  });

  it('calls an unusable response REREADING, never "rephrasing a question"', async () => {
    // Reporting a shape failure as `repairing` made the UI say "Rephrasing 1
    // question the screener won't read aloud" when no question had been
    // examined and the model had returned prose.
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ nope: true })
      .mockResolvedValueOnce(goodDraft());
    const seen: string[] = [];

    await generateRoleDraft('Any', { infer, onProgress: (e) => seen.push(e.phase) });
    expect(seen).toContain('rereading');
    expect(seen).not.toContain('repairing');
  });

  it('A THROWING PROGRESS SINK CANNOT FAIL THE DRAFT', async () => {
    const infer = vi.fn().mockResolvedValue(goodDraft());
    const { draft } = await generateRoleDraft('Any', {
      infer,
      onProgress: () => {
        throw new Error('client went away');
      },
    });
    expect(draft.screening_template).toHaveLength(3);
  });
});
