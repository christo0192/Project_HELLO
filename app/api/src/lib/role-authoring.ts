/**
 * "Ask Hello" — draft a role's job description, required skills and screening
 * questions from nothing but a job title, using DeepSeek v4-pro.
 *
 * THE HARD PART IS NOT THE GENERATION, IT IS THE GATE. Every question this
 * produces has to survive `validatePhoneQuestion`, whose `META_RE` rejects any
 * text containing **system, developer, assistant, model, prompt, instruction,
 * interviewer or recruiter**. That ban exists to stop prompt-injection reaching
 * the phone worker, and it is indifferent to intent: a perfectly ordinary
 * question for a Talent Acquisition role — "how do you keep an applicant
 * tracking system current?" — is rejected for the word *system*, and "how do
 * you source a developer for a niche role?" is rejected for *developer*.
 * Those are exactly the roles someone would most want to auto-author.
 *
 * (The ban is `\b`-anchored and therefore singular-only: *developers* slips
 * through where *developer* does not. Verified by execution rather than
 * assumed — an earlier version of this comment used the plural as its example
 * and was simply wrong. The inconsistency is a property of the validator, not
 * of this module, and widening it is out of scope here: every word added to
 * `META_RE` is a word the generator must then avoid, and a rule the prompt
 * does not state is a rule that burns the whole attempt budget.)
 *
 * So a generator that wrote whatever the model returned would cheerfully
 * author a role whose questions fail at call time. That is not theoretical:
 * an unspeakable question in a role template killed two live calls one second
 * after consent on 2026-09-10. Generation therefore runs the SAME validator
 * the save path runs, feeds the specific failures back to the model, and
 * retries.
 *
 * WHY THE RETRY IS BOUNDED. The owner asked for "retry until they all pass".
 * Taken literally that is an unbounded loop against a model that takes
 * 133–206s per scoring call, so a stubborn title would hang an HTTP request
 * indefinitely. The compromise preserves the property that was actually
 * wanted — nothing invalid is ever written, and nothing is silently dropped —
 * by retrying within a budget and FAILING LOUDLY if it is exhausted. A caller
 * gets a draft where every question passes, or an error naming what could not
 * be phrased. It never gets a half-authored role.
 */
import { env } from './env.js';
import { runClaudeJSONWithProvenance } from './claude.js';
import { BusinessError } from './provider-resilience.js';
import {
  phoneQuestionIssueMessage,
  validatePhoneQuestionTemplate,
  PHONE_META_WORDS,
} from './phone-screening/question-validation.js';

/**
 * Openings the screening worker cannot speak — an instruction TO an
 * interviewer, not a question FOR a candidate.
 */
const DIRECTIVE_OPENING_RE =
  /^\s*(?:ask|probe|explore|cover|check|confirm|discuss|understand|find)\b/i;

/**
 * The generator's own check, STRICTER than `validatePhoneQuestion`.
 *
 * The shared validator's speakability test is an ALTERNATION — `/\?|\btell\b|
 * \bdescribe\b|…/` — so "Describe your approach to handling objections." has
 * no question mark and passes it clean, and "Ask about a deal you closed?"
 * passes despite being an instruction to an interviewer rather than something
 * to say to a candidate. Both were verified against the real regex.
 *
 * The prompt already TELLS the model both rules — the "end with a question
 * mark" and "NOT begin with any of" bullets in the question-rules block
 * below. (Cited by content, not by line: the ":149-150" that stood here had
 * never pointed at them in any commit of this file.) Stating a rule
 * and then not enforcing it is the worst of both: the model is free to ignore
 * it and the draft is returned as verified-clean.
 *
 * Enforced HERE rather than by widening the shared validator on purpose. That
 * validator also runs on every existing role's save path, and tightening it
 * would retroactively make saved roles unsaveable — a much larger blast
 * radius than one generator refusing to emit a shape it was told not to.
 */
function generatedQuestionIssue(text: string): string | null {
  if (!text.trim().endsWith('?')) {
    return 'must end with a question mark';
  }
  if (DIRECTIVE_OPENING_RE.test(text)) {
    return 'must not begin with ask/probe/explore/cover/check/confirm/discuss/understand/find — it is spoken to the candidate, not to an interviewer';
  }
  return null;
}

/** Attempts INCLUDING the first. 3 = one draft plus two repair rounds. */
/**
 * The smallest per-call budget this generator will accept.
 *
 * 240s, against 133-206s measured for v4-pro on 2026-09-17: above the slowest
 * observed call with room for a slow day, and inside the 300000 ceiling
 * `DEEPSEEK_TIMEOUT_MS` is validated to. It is a FLOOR, never a cap — a
 * deployment that configures more keeps it.
 */
export const ROLE_DRAFT_MIN_TIMEOUT_MS = 240_000;

/**
 * The per-call budget this generator will actually use.
 *
 * A FUNCTION rather than an inline `Math.max`, so it can be tested. As an
 * expression buried in the default `infer` closure it was unreachable from
 * any test — every test injects `deps.infer` — and a review confirmed the
 * floor could be lowered to 1000ms with the whole suite green. The floor is
 * the only thing standing between a machine without the Fly secret and a
 * feature that fails 100% of the time, so it is worth being able to assert.
 */
export function roleDraftTimeoutMs(configuredMs: number): number {
  return Math.max(configuredMs, ROLE_DRAFT_MIN_TIMEOUT_MS);
}

export const ROLE_DRAFT_MAX_ATTEMPTS = 3;

/**
 * THE SCREEN HAS A SHAPE, and it is not left to the model.
 *
 * A screening call that opens cold on a role-specific question is jarring, and
 * one that ends without pay and notice leaves the recruiter to chase the two
 * facts that decide whether the pipeline moves at all. The first live role
 * authored with Ask Hello ("Sales v1 hiring") produced six perfectly speakable
 * questions in no particular order and neither of those things.
 *
 * ASKED FOR AS "has to" AND "should always", SO THEY ARE FIXED TEXT rather
 * than prompt rules. Earlier rounds established that the model complies with
 * stated rules only most of the time — every generated question still goes
 * through `validatePhoneQuestionTemplate`, and a rule that is merely REQUESTED
 * costs a whole retry cycle when it is missed. These sentences are written
 * once, checked by `roleArcQuestions()`'s own test against the real validator,
 * and cannot drift.
 *
 * The operator can still edit or delete any of them in the form before saving;
 * this is the default arc, not a lock.
 */
export const ROLE_DRAFT_OPENING_QUESTION =
  'To start, could you tell me a little about yourself and walk me through your most recent role?';

/**
 * Pay and availability, always last.
 *
 * Last because they are the questions a candidate is most likely to bristle
 * at, and asking them first sours everything after. Three separate questions
 * rather than one compound one: "current CTC, expected CTC and notice period"
 * in a single breath reliably gets one answer out of three back.
 */
export const ROLE_DRAFT_CLOSING_QUESTIONS = [
  'What is your current annual CTC, including any variable pay?',
  'What annual CTC are you looking for in your next position?',
  'What is your notice period, and how soon could you join if things move ahead?',
] as const;

/** How many ROLE-SPECIFIC questions the model is asked to write. */
export const ROLE_DRAFT_QUESTION_COUNT = 4;

/** What the operator actually ends up with: opener + model's four + closers. */
export const ROLE_DRAFT_TOTAL_QUESTIONS =
  1 + ROLE_DRAFT_QUESTION_COUNT + ROLE_DRAFT_CLOSING_QUESTIONS.length;

export interface RoleDraftQuestion {
  id: string;
  question: string;
  weight: number;
}

export interface RoleDraft {
  jd: string;
  required_skills: string[];
  screening_template: RoleDraftQuestion[];
}

export interface RoleDraftResult {
  draft: RoleDraft;
  /** Attempts used, so the route can report a repair happened. */
  attempts: number;
  /** Questions the model had to re-phrase, by the rule they broke. */
  repaired: string[];
}

export class RoleDraftError extends Error {
  constructor(
    message: string,
    readonly reason: 'unusable_output' | 'unspeakable_questions' | 'cancelled',
    readonly detail?: readonly string[],
    /**
     * Attempts actually spent. Carried so the job row can record it: without
     * it every failed job read `attempts: 0`, which made "burned the whole
     * budget on a provider outage" indistinguishable from "stopped before the
     * first call" — and those want opposite responses.
     */
    readonly attempts?: number,
  ) {
    super(message);
    this.name = 'RoleDraftError';
  }
}

/**
 * What the caller is told WHILE this runs.
 *
 * v4-pro takes 133-206s per call and this retries up to three times, so a
 * silent spinner can sit there for ten minutes looking hung. Every phase
 * change is pushed out as it happens — real server state, not a timer
 * pretending to be one.
 */
export type RoleDraftPhase =
  | { phase: 'drafting'; attempt: number; maxAttempts: number }
  | { phase: 'checking'; attempt: number; maxAttempts: number }
  | {
      phase: 'repairing';
      attempt: number;
      maxAttempts: number;
      /** How many questions the phone gate refused. Always >= 1 here. */
      rejected: number;
    }
  /**
   * The model's output was not usable AT ALL — unparseable, or missing a
   * required key. A distinct phase because reporting it as `repairing` made
   * the UI say "Rephrasing 1 question the screener won't read aloud" when no
   * question had been examined and the model had returned prose.
   */
  | { phase: 'rereading'; attempt: number; maxAttempts: number };

export interface RoleDraftDeps {
  /** Seam for tests; defaults to DeepSeek v4-pro. */
  infer?: (prompt: string) => Promise<unknown>;
  /**
   * Seam for the PROVIDER CALL ITSELF, one level below `infer`.
   *
   * `infer` replaces the whole default closure, so a test that injects it
   * never reaches the options that closure builds — and the timeout floor
   * lives in exactly those options. A review disconnected the floor from the
   * call site and every test stayed green. This is the seam that makes the
   * wiring assertable without also faking the model.
   */
  runJson?: typeof runClaudeJSONWithProvenance;
  /**
   * Called on every phase change. MUST NOT throw — a progress sink that fails
   * must not fail the generation it is only describing.
   */
  onProgress?: (event: RoleDraftPhase) => void;
  /**
   * Checked BETWEEN attempts. Returning true stops the loop.
   *
   * This is what makes Cancel mean something: without it, cancelling only hid
   * the UI while up to three v4-pro calls carried on billing. Checked between
   * attempts rather than mid-call because the provider call is not
   * interruptible — the most that can be saved is the attempts not yet begun,
   * which is most of the cost.
   */
  shouldCancel?: () => Promise<boolean>;
}

/**
 * The banned words, spelled out FOR the model — READ FROM THE GATE ITSELF.
 *
 * This was a second hand-written copy, justified by "the list is checked
 * against the real validator by a test, so the two cannot drift silently".
 * That test only ran one way: it asserted each word here is refused by the
 * validator, never that the validator refuses nothing else. Adding a word to
 * `META_RE` kept 172 tests across five suites green, and the prompt would
 * then never state the new rule — so v4-pro keeps emitting it, the template
 * gate keeps refusing, and all three attempts (six v4-pro calls, ten minutes)
 * burn before the operator is told Hello could not phrase the questions.
 *
 * A regex source is still not something a model reads reliably, which is why
 * the words are spelled out in the prompt. They are now spelled out FROM the
 * gate's own array rather than beside it.
 */
const BANNED_WORDS = [...PHONE_META_WORDS];

function buildPrompt(jobRole: string, priorFailures: readonly string[]): string {
  const repair =
    priorFailures.length > 0
      ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Fix exactly these problems and keep everything else:\n${priorFailures
          .map((f) => `- ${f}`)
          .join('\n')}\n`
      : '';

  return `You are drafting a phone screening setup for the job role below.

JOB ROLE: ${jobRole}
${repair}
Return ONLY a JSON object with exactly these keys:
{
  "jd": "a job description of 120-250 words, plain prose, no markdown, no bullet characters",
  "required_skills": ["6 to 10 short skill names, each 1-4 words"],
  "screening_template": [
    { "question": "...", "weight": 1 }
  ]
}

Write ${ROLE_DRAFT_QUESTION_COUNT} screening questions about THE WORK ITSELF.

The call already opens by asking the candidate to introduce themselves and
describe their most recent role, and it already ends by asking their current
CTC, their expected CTC, and their notice period. Those four are added for
you — do NOT write an introduction question, and do NOT ask about salary, CTC,
compensation, notice period or availability. Write the middle of the
conversation: what this person has actually done, and how they did it.

They are READ ALOUD to a candidate by an automated caller, so each one must:
- end with a question mark
- be one sentence a person can say naturally in under 12 seconds
- ask the candidate about THEIR experience, not about the hiring process
- NOT begin with any of: ask, probe, explore, cover, check, confirm, discuss, understand, find
- NOT contain any of these words: ${BANNED_WORDS.join(', ')}
- NOT contain the words json, xml or yaml, any of [ ] { } < >, or backticks
- NOT contain "must/should/do not" followed by "ask/say/tell/mention/reveal/ignore"
- NOT contain "read/repeat/output/respond" followed by "the" or "this"

Those rules are checked mechanically and are unforgiving. They reject ordinary
phrasings, so work around them: say "applicant tracking tools" rather than
"applicant tracking system", "engineers" rather than "developers", "config
files" rather than "JSON or YAML", and "how do you go over the requirements"
rather than "how do you read the requirements".

Return the JSON object and nothing else.`;
}

/**
 * The fixed opener and closers, wrapped around what the model wrote.
 *
 * APPLIED AFTER VALIDATION, not before. The model's questions are checked on
 * their own, so a rejected attempt names only the sentence the model is
 * actually being asked to fix — feeding it back the three CTC questions it
 * never wrote would waste the repair budget explaining sentences that are
 * already correct.
 *
 * Ids are re-issued across the whole list, because `validatePhoneQuestion`
 * rejects duplicate keys and the model's four arrive as q1-q4.
 */
function withArc(draft: RoleDraft): RoleDraft {
  // THE ARC COSTS FOUR SLOTS, and `coerceDraft` has already clamped to
  // `MAX_QUESTIONS`. Splicing without re-clamping pushed a model that returned
  // the ceiling to MAX_QUESTIONS + 4, which `createRoleSchema` then refuses —
  // the "passes here, fails on Save after the operator waited minutes" failure
  // this module exists to prevent. Caught by the existing clamp test.
  //
  // THE MIDDLE IS WHAT GIVES WAY. The opener and the three closers were asked
  // for as "has to" and "always", so they are kept and the model's surplus
  // questions are dropped from the end.
  const room = MAX_QUESTIONS - 1 - ROLE_DRAFT_CLOSING_QUESTIONS.length;
  const model = draft.screening_template.slice(0, Math.max(0, room));
  const texts = [
    ROLE_DRAFT_OPENING_QUESTION,
    ...model.map((q) => q.question),
    ...ROLE_DRAFT_CLOSING_QUESTIONS,
  ];
  // The opener and closers carry weight 1: they are asked of every candidate
  // for every role, so nothing about them discriminates between two people.
  // The model's own weights survive for the role-specific middle.
  const weights = [1, ...model.map((q) => q.weight), ...ROLE_DRAFT_CLOSING_QUESTIONS.map(() => 1)];
  return {
    ...draft,
    screening_template: texts.map((question, i) => ({
      id: `q${i + 1}`,
      question,
      weight: weights[i] ?? 1,
    })),
  };
}

/**
 * Bounds copied from `createRoleSchema`, because a draft that passes here and
 * then fails zod on Save is the half-authored role this module promises never
 * to produce — discovered by the operator minutes after the wait.
 */
const MAX_JD_CHARS = 100_000;
const MAX_SKILLS = 100;
const MAX_SKILL_CHARS = 200;
const MAX_QUESTIONS = 100;
const MAX_QUESTION_CHARS = 2_000;
const MAX_WEIGHT = 100;
/** Below this, a "successful" draft is not a screening script. */
const MIN_QUESTIONS = 3;

/** Shape-check AND clamp the model's output before it is trusted for anything. */
function coerceDraft(raw: unknown): RoleDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const jd = typeof obj.jd === 'string' ? obj.jd.trim().slice(0, MAX_JD_CHARS) : '';
  if (!jd) return null;
  // THE JD IS NOT PATTERN-CHECKED, and that is a decision, not an oversight.
  //
  // A lexical gate was written here and then removed, because it was measured
  // and it was worse than nothing: on ten realistic one-sentence JD bodies it
  // rejected SIX — backend ("returns JSON payloads"), data ("CSV, XML and
  // JSON feeds"), devops ("YAML pipeline definitions"), support ("read the
  // ticket history"), sales ("never mention pricing before qualifying") and
  // teaching ("read the curriculum") — and on eight plainly hostile strings
  // it caught ZERO. It would have made drafting the engineering roles this
  // feature is most wanted for impossible, while advertising a protection it
  // did not provide.
  //
  // The decisive argument is not the hit rate, though. `createRoleSchema.jd`
  // is `z.string().max(100_000)` with no content check at all, so the same
  // interviewer can type any of those eight strings into the field by hand
  // and press Save. A gate on the GENERATOR that the HUMAN path does not have
  // protects nothing — it only moves where the text is typed.
  //
  // `roles.jd` reaching the phone worker's system prompt (`prompting.py:275`)
  // is real and is tracked as its own work. It is a structural problem — the
  // prompt concatenates where it should delimit — and no regex over free
  // prose is the fix for it.

  const skills = Array.isArray(obj.required_skills)
    ? obj.required_skills
        .filter((s): s is string => typeof s === 'string')
        // Truncated, not rejected: an over-long "skill" is a cosmetic fault,
        // and failing the whole draft over one verbose string would waste the
        // entire wait.
        .map((s) => s.trim().slice(0, MAX_SKILL_CHARS))
        .filter(Boolean)
        .slice(0, MAX_SKILLS)
    : [];
  if (skills.length === 0) return null;

  const rawQuestions = Array.isArray(obj.screening_template) ? obj.screening_template : [];
  const questions: RoleDraftQuestion[] = [];
  rawQuestions.forEach((entry, i) => {
    const q = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const text = typeof q.question === 'string' ? q.question.trim() : '';
    if (!text || text.length > MAX_QUESTION_CHARS) return;
    // Clamped to the schema's range. A model that weights in basis points or
    // on a 0-1000 priority scale produced a draft that displayed fine and then
    // 400'd on Save.
    const rawWeight = Number(q.weight);
    const weight =
      Number.isFinite(rawWeight) && rawWeight >= 0 ? Math.min(rawWeight, MAX_WEIGHT) : 1;
    // Ids are OURS, never the model's: the save path rejects duplicate keys,
    // and a model that repeats "q1" would fail a gate for a reason that has
    // nothing to do with the question.
    questions.push({ id: `q${i + 1}`, question: text, weight });
  });

  // A FLOOR, not just a non-empty check. A model that returns six entries of
  // which five use the key "text" instead of "question" yielded a
  // ONE-question draft that passed every gate and was offered as complete.
  if (questions.length < MIN_QUESTIONS) return null;

  return {
    jd,
    required_skills: skills,
    screening_template: questions.slice(0, MAX_QUESTIONS),
  };
}

/**
 * Draft a role. Resolves only when EVERY question passes the phone gate.
 *
 * @throws RoleDraftError when the model cannot produce usable JSON, or cannot
 *         phrase every question within the attempt budget.
 */
export async function generateRoleDraft(
  jobRole: string,
  deps: RoleDraftDeps = {},
): Promise<RoleDraftResult> {
  const infer =
    deps.infer ??
    (async (prompt: string) => {
      const run = deps.runJson ?? runClaudeJSONWithProvenance;
      const { data } = await run<unknown>(prompt, {
        model: env.deepseekScoringModel,
        // FLOORED, because the budget this reads is shared and its declared
        // value is too small for this call.
        //
        // `DEEPSEEK_TIMEOUT_MS` defaults to 120000 (env.ts) and fly.toml
        // checks in 120000 — both below every v4-pro duration measured on
        // 2026-09-17 (133-206s). Production carries a larger value as a Fly
        // secret, but a secret is not a guarantee: a new machine, a staging
        // app, a local run, or one `fly secrets unset` puts 120s back, and
        // then EVERY attempt times out. The operator would watch the phase
        // label count "1 of 3 -> 2 of 3 -> 3 of 3" over six minutes, be told
        // "Hello could not be reached", and the labels would be describing
        // retries of a call that never had time to finish.
        //
        // The knob is also shared with the resume parser, so tuning it DOWN
        // for parsing would silently kill role drafting. The dedicated
        // `DEEPSEEK_SCORING_TIMEOUT_MS` lives in PR #300, deliberately
        // unmerged; until it lands, this call states its own minimum.
        timeoutMs: roleDraftTimeoutMs(env.deepseekTimeoutMs),
      });
      return data;
    });

  // Isolated: an observer must never break the thing it observes.
  const report = (event: RoleDraftPhase) => {
    try {
      deps.onProgress?.(event);
    } catch {
      /* a progress sink is not allowed to fail the draft */
    }
  };

  const repaired: string[] = [];
  let failures: string[] = [];
  let lastShapeFailure = false;
  /** The last provider throw, so an exhausted budget can say what went wrong. */
  let providerError: unknown = null;
  /** Questions the LAST attempt rejected. 0 when the failure was not a question. */
  let rejectedCount = 0;

  for (let attempt = 1; attempt <= ROLE_DRAFT_MAX_ATTEMPTS; attempt += 1) {
    if (deps.shouldCancel && (await deps.shouldCancel())) {
      throw new RoleDraftError('Hello was cancelled.', 'cancelled', undefined, attempt - 1);
    }
    report(
      rejectedCount > 0
        ? {
            phase: 'repairing',
            attempt,
            maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS,
            rejected: rejectedCount,
          }
        : failures.length > 0
          ? { phase: 'rereading', attempt, maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS }
          : { phase: 'drafting', attempt, maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS },
    );

    // BOTH CAUSES ARE CLEARED PER ATTEMPT, and that is the fix for a wrong
    // message rather than tidiness. `providerError` used to be cleared only
    // after a SUCCESSFUL parse, so one transient 502 on attempt 1 followed by
    // two unreadable responses still reported "Hello could not be reached" —
    // sending the operator to retry a provider that was fine, when the real
    // answer was that the model would not return usable JSON. Whatever is set
    // when the loop exits now describes the attempt that actually ended it.
    providerError = null;
    lastShapeFailure = false;

    // A PROVIDER FAILURE COSTS ONE ATTEMPT, NOT THE WHOLE BUDGET.
    // `runClaudeJSONWithProvenance` throws on a timeout, a non-2xx, and on
    // unparseable JSON — the most common model failure of all, since a fenced
    // ```json block or a sentence of preamble is enough. Unguarded, the first
    // transient 502 escaped the loop entirely and surfaced as "Hello could not
    // be reached" with two attempts unused, while advertising three.
    let raw: unknown;
    try {
      raw = await infer(buildPrompt(jobRole, failures));
    } catch (err) {
      // UNPARSEABLE OUTPUT IS NOT AN OUTAGE, and the two arrive through the
      // same throw. `runDeepseekJSON` retries once itself and then raises
      // `BusinessError` when the reply still will not parse — a reachable,
      // healthy provider that returned prose. Counting that as a provider
      // failure told the operator "Hello could not be reached", sending them
      // to retry something that was never down, and it is the COMMONEST
      // failure of the two: a fenced ```json block or a sentence of preamble
      // is enough to cause it.
      if (err instanceof BusinessError) {
        lastShapeFailure = true;
        rejectedCount = 0;
        failures = [
          'The previous response could not be read as JSON. Return ONLY the raw JSON object, with no code fence, no preamble and no trailing prose.',
        ];
        continue;
      }
      providerError = err;
      rejectedCount = 0;
      // Says what actually happened. The old line claimed the response "could
      // not be read at all", which on a timeout or a 502 is a description of
      // an answer that never arrived — and it was fed into the next prompt,
      // so the model was asked to fix output it had not produced.
      failures = [];
      continue;
    }
    report({ phase: 'checking', attempt, maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS });
    const draft = coerceDraft(raw);

    if (!draft) {
      lastShapeFailure = true;
      rejectedCount = 0;
      failures = [
        'The response was not a JSON object carrying a non-empty "jd", a non-empty "required_skills" array, and a non-empty "screening_template" array.',
      ];
      continue;
    }
    // THE SAME validator the save path runs, PLUS the two rules the prompt
    // states that it does not cover (see `generatedQuestionIssue`).
    const issues = validatePhoneQuestionTemplate(draft.screening_template);
    const shapeIssues = new Map<number, string>();
    draft.screening_template.forEach((q, index) => {
      const issue = generatedQuestionIssue(q.question);
      if (issue) shapeIssues.set(index, issue);
    });

    if (issues.size === 0 && shapeIssues.size === 0) {
      return { draft: withArc(draft), attempts: attempt, repaired: [...new Set(repaired)] };
    }

    // Rebuilt per attempt, not appended: `repaired` used to accumulate every
    // rejection from every pass, so 4 rejected then 3 rejected reported
    // "rephrased 7 questions" beside a six-question draft.
    const thisPass: string[] = [];
    const indexes = new Set([...issues.keys(), ...shapeIssues.keys()]);
    failures = [...indexes].sort((a, b) => a - b).map((index) => {
      const text = draft.screening_template[index]?.question ?? '';
      const list = issues.get(index);
      const message = list
        ? phoneQuestionIssueMessage(index, list)
        : `Question ${index + 1} ${shapeIssues.get(index)}`;
      thisPass.push(`${message}: "${text}"`);
      return `${message} — the offending text was: "${text}"`;
    });
    repaired.length = 0;
    repaired.push(...thisPass);
    rejectedCount = thisPass.length;
  }

  if (providerError) {
    // Named, not swallowed into a generic message: a provider outage that
    // burned all three attempts is a different problem from a model that
    // would not phrase a question, and the operator can act on the difference.
    throw new RoleDraftError(
      'Hello could not be reached after several tries. Try again in a moment.',
      'unusable_output',
      [providerError instanceof Error ? providerError.message : String(providerError)],
      ROLE_DRAFT_MAX_ATTEMPTS,
    );
  }
  if (lastShapeFailure) {
    throw new RoleDraftError(
      'Hello could not draft this role — the response was not usable.',
      'unusable_output',
      undefined,
      ROLE_DRAFT_MAX_ATTEMPTS,
    );
  }
  throw new RoleDraftError(
    'Hello drafted questions that the phone screener will not read aloud, and could not rephrase them.',
    'unspeakable_questions',
    failures,
    ROLE_DRAFT_MAX_ATTEMPTS,
  );
}


/**
 * Rephrase ONE question until the phone gate will read it aloud.
 *
 * WHY THIS EXISTS. `validatePhoneQuestion` is unforgiving and indifferent to
 * intent: it bans the words *system*, *developer*, *assistant*, *model*,
 * *prompt*, *instruction*, *interviewer* and *recruiter* anywhere in a
 * question, so "how do you keep an applicant tracking system current?" is
 * refused for the word *system*. An operator typing their own question hits
 * that wall with no way over it — the form says the sentence is unusable and
 * leaves them to guess which word offended. This turns that dead end into a
 * button.
 *
 * NOT A JOB, unlike drafting. This returns one sentence of about fifteen
 * words, so it answers inside a normal request rather than needing a row, a
 * poll and a cancel. The point is that it feels instant beside the field it
 * fixes.
 *
 * THE MODEL IS NEVER TRUSTED, only used. Its suggestion goes through the same
 * `validatePhoneQuestion` and `generatedQuestionIssue` that the save path and
 * the generator use; a suggestion that still fails is retried once with the
 * specific failure quoted back, and a second failure is reported rather than
 * returned. A "rephrase" that hands back another unusable sentence would be
 * worse than the error message it replaced.
 */
export interface RephraseDeps {
  /** Seam for tests; defaults to the real provider call. */
  infer?: (prompt: string) => Promise<unknown>;
  runJson?: typeof runClaudeJSONWithProvenance;
}

/** How many provider calls one press of Rephrase may cost. */
export const REPHRASE_MAX_ATTEMPTS = 2;

function buildRephrasePrompt(question: string, priorFailure: string | null): string {
  const repair = priorFailure
    ? `\nYOUR PREVIOUS SUGGESTION WAS REJECTED: ${priorFailure}\nFix exactly that and keep the meaning.\n`
    : '';
  return `Rewrite the screening question below so an automated caller can read it
aloud to a job candidate. Keep what it is asking about; change only the wording.

QUESTION: ${question}
${repair}
The rewritten question must:
- end with a question mark
- be one sentence a person can say naturally in under 12 seconds
- ask the candidate about THEIR experience, not about the hiring process
- NOT begin with any of: ask, probe, explore, cover, check, confirm, discuss, understand, find
- NOT contain any of these words: ${BANNED_WORDS.join(', ')}
- NOT contain the words json, xml or yaml, any of [ ] { } < >, or backticks
- NOT contain "must/should/do not" followed by "ask/say/tell/mention/reveal/ignore"
- NOT contain "read/repeat/output/respond" followed by "the" or "this"

Those rules are checked mechanically. Work around them rather than arguing with
them: say "applicant tracking tools" rather than "applicant tracking system",
"engineers" rather than "developers", "config files" rather than "JSON or YAML".

Return ONLY a JSON object: {"question": "..."}`;
}

export async function rephraseQuestion(
  question: string,
  deps: RephraseDeps = {},
): Promise<string> {
  const infer =
    deps.infer ??
    (async (prompt: string) => {
      const run = deps.runJson ?? runClaudeJSONWithProvenance;
      const { data } = await run<unknown>(prompt, {
        model: env.deepseekScoringModel,
        // NOT the draft's 240s floor. That floor exists because a full draft
        // is three JD-sized generations; this is one short sentence, and a
        // four-minute spinner on a button beside a text field would read as
        // broken. The configured budget is enough and is not raised.
        timeoutMs: env.deepseekTimeoutMs,
      });
      return data;
    });

  let priorFailure: string | null = null;
  let lastIssue = 'the rewritten question still could not be read aloud';

  for (let attempt = 1; attempt <= REPHRASE_MAX_ATTEMPTS; attempt += 1) {
    const raw = await infer(buildRephrasePrompt(question, priorFailure));
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const text = typeof obj.question === 'string' ? obj.question.trim() : '';
    if (!text || text.length > MAX_QUESTION_CHARS) {
      priorFailure = 'the response was not a JSON object carrying a non-empty "question" string';
      lastIssue = priorFailure;
      continue;
    }

    // THE SAME TWO GATES the generator applies, in the same order.
    const issues = validatePhoneQuestionTemplate([{ id: 'q1', question: text }]);
    const list = issues.get(0);
    if (list) {
      priorFailure = phoneQuestionIssueMessage(0, list).replace(/^Question 1 /, 'it ');
      lastIssue = priorFailure;
      continue;
    }
    const shapeIssue = generatedQuestionIssue(text);
    if (shapeIssue) {
      priorFailure = `it ${shapeIssue}`;
      lastIssue = priorFailure;
      continue;
    }
    return text;
  }

  throw new RoleDraftError(
    'Hello could not rephrase that question into something the screener will read aloud.',
    'unspeakable_questions',
    [lastIssue],
    REPHRASE_MAX_ATTEMPTS,
  );
}
