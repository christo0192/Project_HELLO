/**
 * The `scorecard_feedback` job of the `r1-meet` runtime (M034 S09, dark; D-S09-1, D-S09-4, D-S09-5,
 * D-S09-10, D-S09-11, D-S09-13): post Dex's R1 scorecard of one Meet round to Ashby as the interview's
 * feedback (`applicationFeedback.submit` with the booking's `interviewEventId` and the Dex user), once
 * per booking and assessment.
 *
 * WHO QUEUES IT. The scorecard-ready trigger and the maintenance re-drive (S09 T4) through
 * `r1_meet_record_receipt`: ONE receipt per (booking, assessment), key
 * `ashby-schedule:feedback:<booking>:<assessment>`, and its job (payload ids only, plus the RPC's
 * `receipt_id` and `source`). An operator's manual re-post (runbook) is the same payload without
 * `receipt_id`. The handler always finds the receipt by its KEY, so both kinds of job share it.
 *
 * ONCE (D-S09-1). Ours: a receipt already `processed` makes the job a no-op with ZERO Ashby calls, so a
 * re-delivered or replayed job never posts again. Ashby's: every submit names the interview event and
 * the Dex user, so Ashby UPDATES Dex's one submission for that event; a retry after an answer that was
 * lost can never create a second card.
 *
 * THE STEPS, each stopping at its first refusal (closed codes; a refusal is `ignored(<code>)`, so the
 * dispatcher ends a trigger job's receipt `ignored`):
 *   1  unwired                   `deps.feedback` absent: throw `r1_meet_feedback_unwired` (a build bug).
 *   2  feedback_off              the form setting is blank: nothing is read.
 *      feedback_config_invalid   the form setting is malformed: alert, receipt `failed`.
 *   3  already_submitted         the receipt is `processed`: nothing more, no Ashby call.
 *   4  booking_missing | defer booking_not_settled (a live status, 60 s, bounded, then throw
 *      `r1_meet_feedback_booking_not_settled`) | booking_not_completed (failed, cancelled, drained:
 *      a call that went wrong is never posted) | booking_unbound (no round or session) | stale (more
 *      than 7 days after the slot ended) | profile_unknown (an `objective_profile` this build has no
 *      profile for: the card's header names the profile's bot and interview kind, never a guess).
 *   5  round_not_meet (missing or a browser round) | assessment_superseded (not the round's current).
 *   6  assessment_missing | assessment_not_booking_session (not the booking's attempt).
 *   7  decision_use_blocked (an open appeal) | consent_withdrawn (withdrawn or declined).
 *   8  not_postable                a placeholder, `human_review`, v1 or a value that cannot be mapped.
 *   9  ashby_inactive              Ashby's own switches are off (`ASHBY_INTEGRATION_ENABLED` with a
 *                                 usable webhook secret, and `ASHBY_RUNTIME_ENABLED`: the documented
 *                                 "stop all Ashby writes" rollback stops this write too): one warning,
 *                                 receipt `failed` (re-postable once Ashby is back on), no Ashby call;
 *      ashby_key_missing           no usable Ashby key: alert, receipt `failed`.
 *  10  the form read: a transient failure, no definition or no schema defers `form_unavailable` (60 s,
 *      bounded, then throw `r1_meet_feedback_form_unavailable`); a permanent 4xx alerts
 *      `form_unreadable`, receipt `failed`.
 *  11  the binding (`bindR1MeetFeedbackForm`): a refusal alerts with its reason, receipt `failed`.
 *  12  the submit: success settles the receipt `processed` (a failure of that write only warns; the
 *      dispatcher's own finish tries again) and answers `processed('submitted')`. A 429 defers
 *      `ashby_rate_limited` (60 s) and a 5xx, timeout or network failure defers `ashby_unavailable`
 *      (30 s), both bounded, then throw `r1_meet_feedback_ashby_rate_limited` / `_unavailable`. A
 *      permanent 4xx or `success:false` alerts `r1_meet_feedback_rejected` and is terminal
 *      (`ashby_rejected`, or `ashby_rejected_after_retry` when an earlier run of the job may have
 *      reached this submit or the queue cannot tell, `r1MeetFeedbackSubmitMayHaveRun`: the card may
 *      already be in Ashby and the tenant refused the update); the client's own request validation
 *      is terminal `ashby_request_invalid`. Anything that is not an Ashby error is rethrown (the
 *      dispatcher makes it `r1_meet_unexpected_error`).
 * A terminal fault leaves the receipt `failed`, so the runbook's re-post can send it again after the fix.
 *
 * LOGS (D-S09-13). Closed words, counts and an HTTP status only: never an id, a form, section or field
 * id or path, a URL, a name or any rationale text. Alerts are `error` lines.
 *
 * Loading this module performs no I/O: every port arrives in `R1MeetFlowDeps.feedback`.
 */

import type { ProbeFeedbackForm } from '../../../integrations/ashby/probe.js';
import type { R1MeetFeedbackConfig } from './config.js';
import { classifyR1MeetAshbyFailure, type R1MeetAshbyFeedbackPort } from './feedback-ashby.js';
import {
  R1_MEET_FEEDBACK_LIMITS,
  bindR1MeetFeedbackForm,
  isR1MeetFeedbackRefused,
  r1MeetFeedbackReportUrl,
  r1MeetFeedbackRequest,
  r1MeetFeedbackSource,
  r1MeetFeedbackSummary,
} from './feedback-form.js';
import {
  r1MeetFeedbackReceiptKey,
  type R1MeetFeedbackReceipt,
  type R1MeetFeedbackStore,
} from './feedback-store.js';
import {
  R1MeetJobError,
  R1_MEET_DB_ERROR,
  R1_MEET_MALFORMED_PAYLOAD,
  R1_MEET_UNKNOWN_KIND,
  canDeferR1MeetJob,
  parseScorecardFeedbackJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetProcessed,
  type R1MeetJobMeta,
  type R1MeetJobResult,
  type R1MeetScorecardFeedbackJob,
} from './jobs.js';
import type { R1MeetFlowDeps, R1MeetJobDefinition, R1MeetLog } from './recall-actions.js';
import { getR1MeetProfile } from './profiles.js';
import { R1_MEET_LIVE_STATUSES } from './runtime-store.js';

/** The alerts of this job (error lines). Not part of `R1_MEET_ALERTS`, which S06 owns. Frozen. */
export const R1_MEET_FEEDBACK_ALERTS = Object.freeze({
  configInvalid: 'r1_meet_feedback_config_invalid',
  formInvalid: 'r1_meet_feedback_form_invalid',
  rejected: 'r1_meet_feedback_rejected',
} as const);

/** The warning of a card held back because Ashby's own switches are off (a rollback, not a fault). */
export const R1_MEET_FEEDBACK_ASHBY_INACTIVE_LOG = 'r1_meet_feedback_ashby_inactive';

/** The deferrals of this job, in seconds. Frozen. */
export const R1_MEET_FEEDBACK_DEFER = Object.freeze({
  notSettled: 60,
  form: 60,
  rateLimited: 60,
  unavailable: 30,
} as const);

/** The ports of the feedback job. Production builds them in `runtime.ts` (S09 T4). */
export interface R1MeetFeedbackDeps {
  /** `getR1MeetFeedbackConfig()`, asked once per job. */
  config(): R1MeetFeedbackConfig;
  readonly store: R1MeetFeedbackStore;
  /**
   * Ashby's own switches, asked per job: the integration master switch with a usable webhook secret
   * (`isAshbyWebhookActive`) AND `ASHBY_RUNTIME_ENABLED` (ashby-runtime-activation.md §6). The key is
   * the next question (`ashby`).
   */
  ashbyActive(): boolean;
  /** The Ashby port, or null when no usable Ashby key is configured. */
  ashby(): R1MeetAshbyFeedbackPort | null;
  /** The Dex Ashby user (`R1_MEET_ASHBY_DEX_USER_ID`): the interviewer the card is submitted for. */
  readonly dexUserId: string;
  /** The Meet bridge page URL: its https origin hosts the round's review page. */
  readonly bridgePageUrl: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: ReadonlySet<string> = new Set(R1_MEET_LIVE_STATUSES);
const UNWIRED = 'r1_meet_feedback_unwired';

/**
 * The outcomes a run can only reach BEFORE any submit, as the queue keeps them: the job's own waits
 * (steps 4 and 10) and the codes thrown when those waits pass the bound; the dispatcher's
 * `r1_meet_inactive` deferral (no handler ran; a literal here, because `dispatcher.ts` imports this
 * module); and the throws that cannot follow a submit that may have landed: `r1_meet_db_error` (the
 * settle after a success only warns, and the terminal settle follows a refusal, which posts nothing),
 * `r1_meet_feedback_unwired`, `r1_meet_unknown_kind`, `r1_meet_malformed_payload`. NOT here, because
 * they may follow a submit that landed: the submit's own waits and throws (`ashby_rate_limited`,
 * `ashby_unavailable`, `r1_meet_feedback_ashby_*`) and `r1_meet_unexpected_error`.
 */
const PRE_SUBMIT_OUTCOMES: ReadonlySet<string> = new Set([
  'booking_not_settled',
  'form_unavailable',
  'r1_meet_inactive',
  'r1_meet_feedback_booking_not_settled',
  'r1_meet_feedback_form_unavailable',
  R1_MEET_DB_ERROR,
  UNWIRED,
  R1_MEET_UNKNOWN_KIND,
  R1_MEET_MALFORMED_PAYLOAD,
]);

/**
 * May an earlier run of this job have reached Ashby's submit, so the card may already be there? Pure;
 * it only picks the label of a terminal refusal (`ashby_rejected_after_retry` or `ashby_rejected`),
 * and the receipt ends `failed` either way.
 *
 * The queue keeps only the PREVIOUS run's outcome (`defer_job` and `fail_job` overwrite each other's
 * fields; a lost lease leaves both as they were), but it counts every earlier run exactly: a deferral
 * refunds its attempt and adds to `defer_count`, a throw or a lost lease keeps its attempt, so the
 * job's earlier runs are `(attempts - 1) + deferCount`. Hence:
 *  1. no earlier run: no;
 *  2. every earlier run was a deferral (`attempts === 1`, so nothing threw and no lease was lost) and
 *     the last one found the booking still live (`booking_not_settled`): no. A completed booking is
 *     never revived (0142 §3, §10, §14), so every earlier run also found it not completed, and the
 *     submit needs a completed booking;
 *  3. more than one earlier run otherwise: yes, because what came before the previous run is
 *     unknown (a submit that Ashby could not answer, then a form read that failed, keeps only the
 *     form's code);
 *  4. exactly one earlier run: its outcome is the one the queue kept. Yes, unless it is one of
 *     `PRE_SUBMIT_OUTCOMES`; a run that left no outcome (a lost lease) is yes.
 * A re-post (a new job) or a replayed dead letter (a new row) starts a new history and reads as a first
 * run: the runbook tells the operator to look for the card first after one of those.
 */
export function r1MeetFeedbackSubmitMayHaveRun(
  meta: Pick<R1MeetJobMeta, 'attempts' | 'deferCount' | 'lastDeferReason' | 'lastError'>,
): boolean {
  const kept = Math.max(0, meta.attempts - 1);
  const earlierRuns = kept + Math.max(0, meta.deferCount);
  if (earlierRuns === 0) return false;
  if (kept === 0 && meta.lastDeferReason === 'booking_not_settled') return false;
  if (earlierRuns > 1) return true;
  const previous = meta.lastDeferReason ?? meta.lastError;
  return previous === null || !PRE_SUBMIT_OUTCOMES.has(previous);
}

const SUBMITTED_LOG = 'r1_meet_feedback_submitted';
const SETTLE_FAILED_LOG = 'r1_meet_feedback_receipt_settle_failed';

/** A transient wait within the job's deferral bound; past it, the closed code is thrown (retries, DLQ). */
function deferOrThrow(meta: R1MeetJobMeta, nowMs: number, code: string, seconds: number, thrown: string): R1MeetJobResult {
  if (!canDeferR1MeetJob(meta, nowMs)) throw new R1MeetJobError(thrown);
  return r1MeetDefer(code, seconds);
}

function alert(log: R1MeetLog, category: string, errorType: string, httpStatus: number | null = null): void {
  log.error({
    error_category: category,
    error_type: errorType,
    ...(typeof httpStatus === 'number' ? { http_status: httpStatus } : {}),
  });
}

/** Run the job (see the header). Exported for tests; the dispatcher reaches it through the definition. */
export async function runR1MeetScorecardFeedback(
  deps: R1MeetFlowDeps,
  job: R1MeetScorecardFeedbackJob,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  // 1. Wiring.
  const feedback = deps.feedback;
  if (feedback === undefined || feedback === null) throw new R1MeetJobError(UNWIRED);
  const store = feedback.store;
  const key = r1MeetFeedbackReceiptKey(job.bookingId, job.assessmentId);
  const nowIso = (): string => new Date(deps.now()).toISOString();

  /** A permanent fault: alert, end the receipt `failed` (re-postable after the fix), refuse. */
  const terminal = async (
    receipt: R1MeetFeedbackReceipt | null,
    category: string,
    errorType: string,
    code: string,
    httpStatus: number | null = null,
  ): Promise<R1MeetJobResult> => {
    alert(deps.log, category, errorType, httpStatus);
    if (receipt !== null) await store.settleReceipt(receipt.id, 'failed', nowIso());
    return r1MeetIgnored(code);
  };

  // 2. The form setting.
  const config = feedback.config();
  if (config.status === 'off') return r1MeetIgnored('feedback_off');
  if (config.status !== 'on') {
    return terminal(await store.receipt(key), R1_MEET_FEEDBACK_ALERTS.configInvalid, 'feedback_config_invalid', 'feedback_config_invalid');
  }

  // 3. Once: a posted card is never posted again.
  const receipt = await store.receipt(key);
  if (receipt?.outcome === 'processed') return r1MeetIgnored('already_submitted');

  // 4. The booking: completed by its attempt, bound, and recent.
  const booking = await deps.store.getBooking(job.bookingId);
  if (booking === null) return r1MeetIgnored('booking_missing');
  if (LIVE.has(booking.status)) {
    return deferOrThrow(meta, deps.now(), 'booking_not_settled', R1_MEET_FEEDBACK_DEFER.notSettled, 'r1_meet_feedback_booking_not_settled');
  }
  if (booking.status !== 'completed') return r1MeetIgnored('booking_not_completed');
  // A public-page booking (M035) has no interview event: not posted yet (M035 S02 T3 posts it).
  if (
    booking.roundId === null
    || booking.sessionId === null
    || booking.source !== 'ashby'
    || !UUID.test(booking.eventId)
  ) {
    return r1MeetIgnored('booking_unbound');
  }
  const endMs = Date.parse(booking.endAt);
  if (!Number.isFinite(endMs) || deps.now() > endMs + R1_MEET_FEEDBACK_LIMITS.staleMs) return r1MeetIgnored('stale');
  // The card says which interview this was: the booking's profile, never a default.
  const profile = getR1MeetProfile(booking.objectiveProfile);
  if (profile === null) return r1MeetIgnored('profile_unknown');

  // 5. The round: a Meet round whose CURRENT assessment is this one.
  const round = await store.round(booking.roundId);
  if (round === null || round.channel !== 'meet') return r1MeetIgnored('round_not_meet');
  if (round.assessmentId !== job.assessmentId) return r1MeetIgnored('assessment_superseded');

  // 6. The assessment: of this booking's attempt.
  const assessment = await store.assessment(job.assessmentId);
  if (assessment === null) return r1MeetIgnored('assessment_missing');
  if (assessment.sessionId !== booking.sessionId) return r1MeetIgnored('assessment_not_booking_session');

  // 7. Governance: an open appeal, a withdrawn or declined consent.
  if (await store.decisionUseBlocked(round.candidateId)) return r1MeetIgnored('decision_use_blocked');
  if (await store.consentWithdrawn(round.id)) return r1MeetIgnored('consent_withdrawn');

  // 8. A scorecard the card can state without making anything up.
  const source = r1MeetFeedbackSource(assessment.row);
  if (isR1MeetFeedbackRefused(source)) return r1MeetIgnored('not_postable');

  // 9. Ashby's own switches (a rollback that stops every Ashby write stops this one), then the key.
  if (!feedback.ashbyActive()) {
    deps.log.warn({ error_category: R1_MEET_FEEDBACK_ASHBY_INACTIVE_LOG });
    if (receipt !== null) await store.settleReceipt(receipt.id, 'failed', nowIso());
    return r1MeetIgnored('ashby_inactive');
  }
  const ashby = feedback.ashby();
  if (ashby === null) {
    return terminal(receipt, R1_MEET_FEEDBACK_ALERTS.configInvalid, 'ashby_key_missing', 'ashby_key_missing');
  }

  // 10. The live form definition (structure only).
  let form: ProbeFeedbackForm | null;
  try {
    form = await ashby.readForm(config.formDefinitionId);
  } catch (error) {
    const failure = classifyR1MeetAshbyFailure(error);
    if (failure === null) throw error;
    if (failure.kind === 'rate_limited' || failure.kind === 'unavailable') {
      return deferOrThrow(meta, deps.now(), 'form_unavailable', R1_MEET_FEEDBACK_DEFER.form, 'r1_meet_feedback_form_unavailable');
    }
    return terminal(receipt, R1_MEET_FEEDBACK_ALERTS.formInvalid, 'form_unreadable', 'form_unreadable', failure.httpStatus);
  }
  if (form === null || form.schemaAvailable !== true) {
    return deferOrThrow(meta, deps.now(), 'form_unavailable', R1_MEET_FEEDBACK_DEFER.form, 'r1_meet_feedback_form_unavailable');
  }

  // 11. Bind the card onto the live form; never invent a field.
  const binding = bindR1MeetFeedbackForm(source, form, {
    formDefinitionId: config.formDefinitionId,
    reportUrl: r1MeetFeedbackReportUrl(feedback.bridgePageUrl, booking.roundId),
    summary: r1MeetFeedbackSummary(source, profile),
  });
  if (!binding.ok) return terminal(receipt, R1_MEET_FEEDBACK_ALERTS.formInvalid, binding.reason, binding.reason);

  // 12. Submit (or update) Dex's one card for this interview event.
  const request = r1MeetFeedbackRequest({
    applicationId: booking.applicationId,
    formDefinitionId: config.formDefinitionId,
    interviewEventId: booking.eventId,
    dexUserId: feedback.dexUserId,
    fieldSubmissions: binding.fieldSubmissions,
  });
  try {
    await ashby.submit(request);
  } catch (error) {
    const failure = classifyR1MeetAshbyFailure(error);
    if (failure === null) throw error;
    switch (failure.kind) {
      case 'rate_limited':
        return deferOrThrow(meta, deps.now(), 'ashby_rate_limited', R1_MEET_FEEDBACK_DEFER.rateLimited, 'r1_meet_feedback_ashby_rate_limited');
      case 'unavailable':
        return deferOrThrow(meta, deps.now(), 'ashby_unavailable', R1_MEET_FEEDBACK_DEFER.unavailable, 'r1_meet_feedback_ashby_unavailable');
      case 'rejected':
        return terminal(
          receipt,
          R1_MEET_FEEDBACK_ALERTS.rejected,
          failure.detail,
          r1MeetFeedbackSubmitMayHaveRun(meta) ? 'ashby_rejected_after_retry' : 'ashby_rejected',
          failure.httpStatus,
        );
      case 'request_invalid':
        return terminal(receipt, R1_MEET_FEEDBACK_ALERTS.rejected, failure.detail, 'ashby_request_invalid', failure.httpStatus);
      default:
        throw error;
    }
  }

  if (receipt !== null) {
    try {
      await store.settleReceipt(receipt.id, 'processed', nowIso());
    } catch {
      // The card is in Ashby: never fail (and re-post) for this write. The dispatcher's finish of a
      // trigger job tries the same compare-and-set again.
      deps.log.warn({ error_category: SETTLE_FAILED_LOG });
    }
  }
  deps.log.info({
    error_category: SUBMITTED_LOG,
    error_type: `metrics_${binding.metricsBound}_unbound_${binding.metricsUnbound}`,
  });
  return r1MeetProcessed('submitted');
}

/** `scorecard_feedback` (S09): Dex's scorecard to Ashby, once per booking and assessment. */
export const r1MeetScorecardFeedbackDefinition: R1MeetJobDefinition<R1MeetScorecardFeedbackJob> = Object.freeze({
  kind: 'scorecard_feedback',
  parse: parseScorecardFeedbackJob,
  run(deps: R1MeetFlowDeps, job: R1MeetScorecardFeedbackJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    return runR1MeetScorecardFeedback(deps, job, meta);
  },
});
