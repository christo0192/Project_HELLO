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
 * tracking system current?" — is rejected for the word *system*, and a sales
 * question about *sourcing developers* is rejected for *developers*. Those are
 * exactly the roles someone would most want to auto-author.
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
import {
  phoneQuestionIssueMessage,
  validatePhoneQuestionTemplate,
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
 * The prompt already TELLS the model both rules (":149-150"). Stating a rule
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
export const ROLE_DRAFT_MAX_ATTEMPTS = 3;
/** How many questions a draft aims for. */
export const ROLE_DRAFT_QUESTION_COUNT = 6;

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
 * The banned words, spelled out FOR the model.
 *
 * Kept as a literal list rather than derived from `META_RE`, because a regex
 * source is not something a model reliably reads — and the list is checked
 * against the real validator by a test, so the two cannot drift silently.
 */
const BANNED_WORDS = [
  'system',
  'developer',
  'assistant',
  'model',
  'prompt',
  'instruction',
  'interviewer',
  'recruiter',
];

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

Write ${ROLE_DRAFT_QUESTION_COUNT} screening questions. They are READ ALOUD to a
candidate by an automated caller, so each one must:
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
      const { data } = await runClaudeJSONWithProvenance<unknown>(prompt, {
        model: env.deepseekScoringModel,
        // The SHARED DeepSeek budget, not a scoring-specific one: the
        // dedicated `DEEPSEEK_SCORING_TIMEOUT_MS` knob lives in PR #300, which
        // is deliberately unmerged. In production this is the 270s the owner
        // set as a Fly secret, which is above every v4-pro duration measured
        // on 2026-09-17 (133-206s).
        timeoutMs: env.deepseekTimeoutMs,
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
      throw new RoleDraftError('Hello was cancelled.', 'cancelled');
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
      providerError = err;
      rejectedCount = 0;
      failures = [
        'The previous response could not be read at all. Return ONLY the raw JSON object, with no code fence, no preamble and no trailing prose.',
      ];
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
    lastShapeFailure = false;
    providerError = null;

    // THE SAME validator the save path runs, PLUS the two rules the prompt
    // states that it does not cover (see `generatedQuestionIssue`).
    const issues = validatePhoneQuestionTemplate(draft.screening_template);
    const shapeIssues = new Map<number, string>();
    draft.screening_template.forEach((q, index) => {
      const issue = generatedQuestionIssue(q.question);
      if (issue) shapeIssues.set(index, issue);
    });

    if (issues.size === 0 && shapeIssues.size === 0) {
      return { draft, attempts: attempt, repaired: [...new Set(repaired)] };
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
    );
  }
  if (lastShapeFailure) {
    throw new RoleDraftError(
      'Hello could not draft this role — the response was not usable.',
      'unusable_output',
    );
  }
  throw new RoleDraftError(
    'Hello drafted questions that the phone screener will not read aloud, and could not rephrase them.',
    'unspeakable_questions',
    failures,
  );
}
