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
    readonly reason: 'unusable_output' | 'unspeakable_questions',
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
      /** How many questions the phone gate refused. */
      rejected: number;
    };

export interface RoleDraftDeps {
  /** Seam for tests; defaults to DeepSeek v4-pro. */
  infer?: (prompt: string) => Promise<unknown>;
  /**
   * Called on every phase change. MUST NOT throw — a progress sink that fails
   * must not fail the generation it is only describing.
   */
  onProgress?: (event: RoleDraftPhase) => void;
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
- NOT contain any of these words in any form, even innocently: ${BANNED_WORDS.join(', ')}

That last rule is strict and is checked mechanically. If a natural phrasing
needs a banned word, rephrase around it — for example say "applicant tracking
tools" rather than "applicant tracking system", or "engineers" rather than
"developers".

Return the JSON object and nothing else.`;
}

/** Shape-check the model's output before it is trusted for anything. */
function coerceDraft(raw: unknown): RoleDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const jd = typeof obj.jd === 'string' ? obj.jd.trim() : '';
  if (!jd) return null;

  const skills = Array.isArray(obj.required_skills)
    ? obj.required_skills
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 100)
    : [];
  if (skills.length === 0) return null;

  const rawQuestions = Array.isArray(obj.screening_template) ? obj.screening_template : [];
  const questions: RoleDraftQuestion[] = [];
  rawQuestions.forEach((entry, i) => {
    const q = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const text = typeof q.question === 'string' ? q.question.trim() : '';
    if (!text) return;
    const weight = typeof q.weight === 'number' && Number.isFinite(q.weight) && q.weight >= 0
      ? q.weight
      : 1;
    // Ids are OURS, never the model's: the save path rejects duplicate keys,
    // and a model that repeats "q1" would fail a gate for a reason that has
    // nothing to do with the question.
    questions.push({ id: `q${i + 1}`, question: text, weight });
  });
  if (questions.length === 0) return null;

  return { jd, required_skills: skills, screening_template: questions };
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

  for (let attempt = 1; attempt <= ROLE_DRAFT_MAX_ATTEMPTS; attempt += 1) {
    report({
      phase: failures.length > 0 ? 'repairing' : 'drafting',
      attempt,
      maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS,
      ...(failures.length > 0 ? { rejected: failures.length } : {}),
    } as RoleDraftPhase);

    const raw = await infer(buildPrompt(jobRole, failures));
    report({ phase: 'checking', attempt, maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS });
    const draft = coerceDraft(raw);

    if (!draft) {
      lastShapeFailure = true;
      failures = [
        'The response was not a JSON object carrying a non-empty "jd", a non-empty "required_skills" array, and a non-empty "screening_template" array.',
      ];
      continue;
    }
    lastShapeFailure = false;

    // THE SAME validator the save path runs. Anything else would let a draft
    // pass here and fail on write, or worse, on the call.
    const issues = validatePhoneQuestionTemplate(draft.screening_template);
    if (issues.size === 0) {
      return { draft, attempts: attempt, repaired };
    }

    failures = [...issues.entries()].map(([index, list]) => {
      const text = draft.screening_template[index]?.question ?? '';
      const message = phoneQuestionIssueMessage(index, list);
      repaired.push(`${message}: "${text}"`);
      return `${message} — the offending text was: "${text}"`;
    });
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
