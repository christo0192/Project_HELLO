/**
 * Running `candidate-questions.ts` as durable, unattended work.
 *
 * WHY A QUEUE AND NOT A BACKGROUND PROMISE. Generation takes one provider call
 * of up to two minutes, and the moment it is useful — when a candidate is
 * admitted to phone screening — is inside an ingestion worker that already has
 * a starvation history. Doing the work inline there would hold a lease for two
 * minutes per candidate on a drain that is tick-rate bound. Detaching a
 * promise instead would lose every in-flight generation on a redeploy, which
 * on Fly is routine.
 *
 * So it is a job on the existing durable queue, which already owns leasing,
 * retry, backoff and crash recovery. This module adds none of that; adding it
 * would give two places to disagree about whether work is in flight.
 *
 * WHEN IT RUNS. Enqueued right after `ensure_ashby_phone_engagement` reports
 * an engagement exists — the first moment we know this candidate will actually
 * be called, and comfortably before the due loop dials. Not at import: an
 * imported candidate is not necessarily a screened one, and paying a provider
 * call for every résumé that lands would be the expensive way to find that out.
 *
 * WHAT A FAILURE COSTS. Nothing. `0103`'s plan builder prefers a `ready` row
 * and falls back to the role's own template for every other state — absent,
 * pending, failed or malformed. Every path through this module ends with the
 * candidate getting either a sharper screen or exactly the screen they would
 * have had before it existed.
 */
import { createLogger } from './logger.js';
import {
  CandidateQuestionsError,
  generateCandidateQuestions,
  templateFingerprint,
  type CandidateQuestionsDeps,
  type CandidateTemplateQuestion,
} from './candidate-questions.js';

const logger = createLogger('candidate-questions');

/** The queue this work lands on. One name, referenced by enqueue and handler. */
export const CANDIDATE_QUESTIONS_QUEUE = 'candidate.questions';

/**
 * Two, and no more.
 *
 * The retry is for a transient provider fault. A run that failed because the
 * model cannot write a speakable question about this résumé will fail the same
 * way every time, and the fallback is already correct — so burning a third
 * paid call to re-confirm it is pure cost. The handler distinguishes the two:
 * only `provider_error` is re-thrown for the queue to retry.
 */
export const CANDIDATE_QUESTIONS_MAX_JOB_ATTEMPTS = 2;

export interface CandidateQuestionsJobPayload {
  /** The application link whose engagement to write questions for. */
  applicationLinkId: string;
}

/** Everything generation needs, read in one hop by the store. */
export interface CandidateQuestionsContext {
  engagementId: string;
  roleId: string | null;
  /** A terminal engagement is never called again; generating for it is waste. */
  engagementTerminal: boolean;
  roleTitle: string;
  jd: string | null;
  requiredSkills: string[];
  template: CandidateTemplateQuestion[];
  resume: unknown;
  /** The stored row, if this engagement already has one. */
  existing: { status: string; templateHash: string | null } | null;
}

export interface CandidateQuestionsStore {
  loadContext(applicationLinkId: string): Promise<CandidateQuestionsContext | null>;
  /**
   * The role's template fingerprint RIGHT NOW, re-read just before the write.
   * Generation takes minutes; this is how a recruiter's edit during that
   * window is noticed instead of being overwritten.
   */
  currentTemplateFingerprint(roleId: string): Promise<string | null>;
  writeReady(input: {
    engagementId: string;
    roleId: string | null;
    questions: CandidateTemplateQuestion[];
    templateHash: string;
    model: string;
  }): Promise<void>;
  writeFailed(input: {
    engagementId: string;
    roleId: string | null;
    reason: string;
  }): Promise<void>;
}

export interface CandidateQuestionsHandlerDeps {
  store: CandidateQuestionsStore;
  /** Model name recorded on the row. Provenance only; nothing reads it. */
  model: string;
  generate?: typeof generateCandidateQuestions;
  generateDeps?: CandidateQuestionsDeps;
}

/**
 * What the handler decided, for the caller's log and for tests.
 *
 * Every value here is a SUCCESSFUL outcome of the job. The only way this
 * handler throws is a provider fault, because that is the only failure the
 * queue's retry can do anything about.
 */
export type CandidateQuestionsOutcome =
  /** The link, engagement or role no longer resolves. */
  | 'context_missing'
  /** The engagement is terminal — this candidate will not be called again. */
  | 'engagement_terminal'
  /** A ready row already covers the current template. */
  | 'already_current'
  /** Written. The next call for this engagement runs the candidate's screen. */
  | 'generated'
  /** Recorded as failed. The next call runs the role template, as before. */
  | 'not_generated'
  /** The recruiter edited the template while this job ran; nothing written. */
  | 'template_moved';

/**
 * Generate this engagement's questions, once.
 *
 * IDEMPOTENT ON THE TEMPLATE, not on the row. A second delivery of the same
 * job finds a `ready` row whose fingerprint matches the role's current
 * template and stops. A recruiter who has edited the role since produces a
 * fingerprint that no longer matches, and the questions are rewritten around
 * the questions they now actually chose — which is also how an edit
 * invalidates a stale set without anything having to watch for edits.
 */
export async function runCandidateQuestionsJob(
  payload: CandidateQuestionsJobPayload,
  deps: CandidateQuestionsHandlerDeps,
): Promise<CandidateQuestionsOutcome> {
  const context = await deps.store.loadContext(payload.applicationLinkId);
  if (!context) return 'context_missing';
  if (context.engagementTerminal) return 'engagement_terminal';

  const fingerprint = templateFingerprint(context.template);
  if (context.existing?.status === 'ready' && context.existing.templateHash === fingerprint) {
    return 'already_current';
  }

  const generate = deps.generate ?? generateCandidateQuestions;
  try {
    const result = await generate(
      {
        roleTitle: context.roleTitle,
        jd: context.jd,
        requiredSkills: context.requiredSkills,
        template: context.template,
        resume: context.resume as never,
      },
      deps.generateDeps ?? {},
    );
    // ── THE TEMPLATE IS RE-READ BEFORE THE WRITE ────────────────────────
    // Generation takes up to two minutes and the job waits in a queue before
    // that, so a recruiter can save a new template inside the window. The PUT
    // route deletes candidate sets that no longer match — but an IN-FLIGHT job
    // has no row yet, so that delete is a no-op for it, and the write that
    // lands afterwards stores questions built around the OLD template while
    // claiming its fingerprint. `0103`'s plan builder prefers a `ready` row
    // without comparing it to anything, so the call would run the wording the
    // recruiter just changed — invisibly, and until some later edit happened
    // to clear it.
    //
    // Checked rather than locked: the cost of losing this race is one wasted
    // generation, and the next enqueue regenerates against the new template.
    if (context.roleId) {
      const now = await deps.store.currentTemplateFingerprint(context.roleId);
      if (now !== null && now !== result.fingerprint) {
        logger.info('unknown_event', {
          error_category: 'candidate_questions_template_moved',
          error_type: 'discarded',
        });
        return 'template_moved';
      }
    }

    await deps.store.writeReady({
      engagementId: context.engagementId,
      roleId: context.roleId,
      questions: result.questions,
      templateHash: result.fingerprint,
      model: deps.model,
    });
    // METADATA ONLY — a sanitized outcome code, never an identifier. The
    // logger's `AllowedMeta` deliberately has no field for an engagement or a
    // candidate, and a per-candidate generator is exactly the place someone
    // would reach for one.
    logger.info('unknown_event', {
      error_category: 'candidate_questions_written',
      error_type: `relevance_${result.rewritten.profile_relevance}_stability_${result.rewritten.stability}`,
    });
    return 'generated';
  } catch (error) {
    if (error instanceof CandidateQuestionsError) {
      // RE-THROWN ONLY FOR A PROVIDER FAULT. Everything else is a settled
      // answer — this résumé, this template and this model do not produce a
      // usable question — and re-running it would pay for the same answer
      // again. Recording it lets an operator see how often that happens
      // without the row implying anything is still coming.
      if (error.reason === 'provider_error') throw error;
      await deps.store.writeFailed({
        engagementId: context.engagementId,
        roleId: context.roleId,
        reason: error.reason,
      });
      logger.warn('unknown_event', {
        error_category: 'candidate_questions_not_generated',
        error_type: error.reason,
      });
      return 'not_generated';
    }
    throw error;
  }
}
