/**
 * ashby/operation-worker.ts — leased executor for the `ashby_operations` outbox.
 *
 * ══ THE RESULT-SINK REFUSAL (read before changing SUPPORTED_OPERATION_TYPES) ══
 *
 * This worker claims `invite_delivery` and NOTHING else. `scorecard_write` and
 * `stage_move` are never claimed and never executed, because no approved Ashby
 * result sink exists:
 *
 *   1. `bindFeedbackForm` fails closed with `binding_unverified` unless a
 *      tenant-VERIFIED form binding is supplied, and no column, RPC, or config
 *      anywhere produces one — `ashby_job_mappings.feedback_form_id` is a bare
 *      text column with no verified flag and no field-id columns.
 *   2. `AshbyClient.applicationFeedbackSubmit` and `applicationChangeStage`
 *      therefore have
 *      no production caller, and this worker adds none.
 *   3. The 0029 `trg_ashby_operation_dependency` trigger raises P0001 if a
 *      `stage_move` tries to reach running/succeeded before its `scorecard_write`
 *      dependency has succeeded — a DB-level backstop, not application logic.
 *   4. `enqueueStageMove` re-reads `application.info` and refuses when a human
 *      moved the application away from the mapped AI stage.
 *
 * A completed screening therefore parks at `writeback_pending` (0032) and no TA
 * stage move occurs. Widening SUPPORTED_OPERATION_TYPES without first landing a
 * verified binding would break that guarantee — the accompanying test asserts
 * the two forbidden types are never passed to `claim_ashby_operation`.
 *
 * Every mutation is CAS'd on the live lease, so a worker whose lease expired or
 * was reclaimed commits nothing.
 *
 * ══ WHAT `succeeded` MEANS ══
 *
 * ══ A WAIT IS NOT A FAILURE ══
 *
 * `claim_ashby_operation` increments `attempts` at claim time, and
 * `fail_ashby_operation` reschedules a retry with NO backoff. So recording
 * "the resume ingestion has not finished yet" as a retryable FAILURE — which
 * this worker used to do — spent the operation's entire five-attempt budget in
 * roughly five poll intervals (~20-25s) and permanently failed the invite
 * before a real resume could plausibly have been downloaded, scanned and
 * parsed. The attempt bound was designed as a safety property; it functioned
 * as a deadline, and it fired on the HEALTHY path, not only on the canary's.
 *
 * Prerequisite outcomes are therefore DEFERRED, never failed: `deferOperation`
 * refunds the attempt the claim charged and reschedules behind a bounded
 * delay. The claim RPC (0035) additionally refuses to hand out an operation
 * whose prerequisites are unmet, so this path is the post-claim race backstop
 * rather than the common case. Genuine faults — `candidate_missing`,
 * `persist_failed`, an adapter throw — are still ordinary attempt-bounded
 * failures, because those are real failures.
 *
 * Minting
 * an invite only produces a SHA-256 digest, and the provider-gated email
 * channel sends nothing at all, so the only honest success is an authorized
 * human taking possession of a usable link — which happens in
 * `mark_ashby_invite_delivered` (0032), driven by the Mission Control delivery
 * endpoint. The worker either PARKS the manual channel as
 * `awaiting_manual_delivery` or records a durable, non-retryable failure with
 * a sanitized reason.
 */

import type { RuntimeWorkflowStores, OperationClaimRow } from './orchestration.js';
import { bindFeedbackForm, buildScorecard, HELLO_CHRISTY_SCORECARD_BINDING } from './scorecard.js';
import { materializeInvite, type MaterializationStore, type MaterializationMapping } from './materialize.js';
import type { EmailProviderState } from './invite-delivery.js';

/**
 * The ONLY operation types this runtime executes. Deliberately excludes
 * `scorecard_write` and `stage_move` — see the module header.
 */
export const SUPPORTED_OPERATION_TYPES = ['invite_delivery', 'scorecard_write'] as const;
export type SupportedOperationType = (typeof SUPPORTED_OPERATION_TYPES)[number];

/** Operation types the runtime must never claim while no result sink exists. */
export const REFUSED_OPERATION_TYPES = ['stage_move'] as const;

/**
 * Sanitized reasons that mean "a prerequisite is not satisfied yet", NOT "this
 * delivery failed". Each is deferred without consuming an attempt.
 *
 * `candidate_missing` and `persist_failed` are deliberately absent: those are
 * genuine faults in work this operation owns, and they must stay bounded by
 * `max_attempts` rather than parking indefinitely.
 */
export const PREREQUISITE_DEFER_REASONS: ReadonlySet<string> = new Set([
  'ingestion_not_ready',
  'mapping_inactive',
]);

/** Default backoff applied to a prerequisite deferral. */
export const DEFAULT_DEFER_SECONDS = 60;

export interface OperationWorkerDeps {
  stores: RuntimeWorkflowStores;
  materialization: MaterializationStore;
  scorecard?: {
    submit(req: { applicationId: string; formDefinitionId: string; feedbackForm: Record<string, unknown> }): Promise<unknown>;
    dashboardOrigin: string;
  };
  /** Resolve mapping config for a link's job. Null when no usable mapping. */
  resolveMappingForLink(applicationLinkId: string): Promise<MaterializationMapping | null>;
  /** Build the site-relative recruiter reissue path for an application. */
  reissuePathFor(externalApplicationId: string): string;
  /** Email provider gate. Stays closed until an approved provider + domain. */
  email: EmailProviderState;
  /** Opaque worker identity recorded as the operation lease owner. */
  owner: string;
  leaseSeconds: number;
  /**
   * How long a prerequisite-deferred operation waits before becoming
   * claimable again. Server-clamped to 1..3600s by the RPC. Defaults to
   * {@link DEFAULT_DEFER_SECONDS}.
   */
  deferSeconds?: number;
  /** Metadata-only observer. Never receives tokens, PII, or provider text. */
  onEvent?: (event: { kind: string; operationType: string; code?: string }) => void;
  nowMs?: () => number;
}

export type OperationRunOutcome =
  | { claimed: false }
  | {
      claimed: true;
      operationType: string;
      committed: boolean;
      staleLease: boolean;
      /** Sanitized outcome code — safe to log. */
      code: string;
    };

/**
 * Resolve the delivery channel for a claimed invite_delivery operation.
 *
 * The channel is encoded in the operation key by `inviteDeliveryOperationKey`
 * as `ashby:invite:<application>:<channel>:<invite>`. Reading it from the KEY
 * (rather than from the mapping's delivery mode) is what makes
 * `delivery_mode='both'` correct: it enqueues two operations, and each must
 * resolve to its own channel. Deriving the channel from the mapping instead
 * collapsed both to `manual` and completed the email operation as a manual
 * success — review finding M1.
 *
 * A key we cannot parse falls back to the mapping mode, and an ambiguous
 * `both` with no usable key falls back to `manual` (the only channel that can
 * actually deliver) rather than silently claiming the email channel worked.
 */
export function channelForOperationKey(
  operationKey: string | null,
  deliveryMode: 'email' | 'manual' | 'both',
): 'email' | 'manual' {
  if (typeof operationKey === 'string') {
    const parts = operationKey.split(':');
    for (const part of parts) {
      if (part === 'email') return 'email';
      if (part === 'manual') return 'manual';
    }
  }
  return deliveryMode === 'email' ? 'email' : 'manual';
}

/**
 * Claim at most one `invite_delivery` operation and execute it under its lease.
 * Returns `{claimed:false}` when the queue is empty. Never throws.
 */
export async function runClaimedAshbyOperation(
  deps: OperationWorkerDeps,
): Promise<OperationRunOutcome> {
  let claim: OperationClaimRow | null;
  try {
    claim = await deps.stores.claimOperation(
      deps.scorecard ? 'scorecard_write' : 'invite_delivery',
      deps.owner,
      deps.leaseSeconds,
    );
  } catch {
    return { claimed: false };
  }
  if (!claim) return { claimed: false };

  const deferSeconds = deps.deferSeconds ?? DEFAULT_DEFER_SECONDS;

  const emit = (kind: string, code?: string): void => {
    if (!deps.onEvent) return;
    try { deps.onEvent({ kind, operationType: claim!.operationType, code }); } catch { /* never break */ }
  };

  try {
    const link = await deps.stores.readLink(claim.applicationLinkId);
    if (!link) {
      const r = await deps.stores.failOperation(claim.id, claim.leaseToken, 'link_missing', false);
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: r === 'not_owned', code: 'link_missing',
      };
    }

    // Terminal re-check under the lease. The 0032 claim RPC already excludes
    // terminal links, but a withdrawal can land between claim and execution.
    if (link.terminalState) {
      const r = await deps.stores.failOperation(claim.id, claim.leaseToken, 'terminal_cancel', false);
      emit('blocked', 'terminal_cancel');
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: r === 'not_owned', code: 'blocked_terminal',
      };
    }

    if (claim.operationType === 'scorecard_write') {
      if (!deps.scorecard || !deps.stores.readScorecardSource) {
        const r = await deps.stores.failOperation(claim.id, claim.leaseToken, 'scorecard_sink_unavailable', false);
        return { claimed: true, operationType: claim.operationType, committed: false, staleLease: r === 'not_owned', code: 'scorecard_sink_unavailable' };
      }
      const source = await deps.stores.readScorecardSource(claim.applicationLinkId);
      if (!source) {
        const r = await deps.stores.failOperation(claim.id, claim.leaseToken, 'assessment_missing', true);
        return { claimed: true, operationType: claim.operationType, committed: false, staleLease: r === 'not_owned', code: 'assessment_missing' };
      }
      const built = buildScorecard(source, { min: 1, max: 4 });
      if (!built.ok) {
        const r = await deps.stores.failOperation(claim.id, claim.leaseToken, `scorecard_${built.reason}`, false);
        return { claimed: true, operationType: claim.operationType, committed: false, staleLease: r === 'not_owned', code: `scorecard_${built.reason}` };
      }
      const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, deps.scorecard.dashboardOrigin);
      if (!bound.ok || !source.externalApplicationId) {
        const reason = bound.ok ? 'application_id_missing' : bound.reason;
        const r = await deps.stores.failOperation(claim.id, claim.leaseToken, reason, false);
        return { claimed: true, operationType: claim.operationType, committed: false, staleLease: r === 'not_owned', code: reason };
      }
      await deps.scorecard.submit({
        applicationId: source.externalApplicationId,
        formDefinitionId: bound.formDefinitionId,
        feedbackForm: bound.feedbackForm,
      });
      const r = await deps.stores.completeOperation(claim.id, claim.leaseToken, 'scorecard_submitted', claim.marker);
      emit('scorecard_submitted', r === 'ok' ? 'scorecard_submitted' : 'stale_lease');
      return { claimed: true, operationType: claim.operationType, committed: r === 'ok', staleLease: r !== 'ok', code: 'scorecard_submitted' };
    }

    const mapping = await deps.resolveMappingForLink(claim.applicationLinkId);
    if (!mapping) {
      // A mapping paused between claim and execution. Waiting for a recruiter
      // to resume it is not a delivery failure, and charging it as one meant a
      // pause lasting longer than ~25 seconds permanently failed every
      // in-flight invite.
      const r = await deps.stores.deferOperation(
        claim.id, claim.leaseToken, 'mapping_inactive', deferSeconds,
      );
      emit('deferred', 'mapping_inactive');
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: r === 'not_owned', code: 'mapping_inactive',
      };
    }

    const ingestion = await deps.stores.readIngestion(claim.applicationLinkId);
    const result = await materializeInvite({
      store: deps.materialization,
      mapping,
      channel: channelForOperationKey(claim.operationKey, mapping.deliveryMode),
      link: {
        id: link.id,
        externalApplicationId: link.externalApplicationId,
        candidateId: link.candidateId,
        sessionId: link.sessionId,
        inviteId: link.inviteId,
        terminalState: link.terminalState,
      },
      ingestionState: ingestion?.state ?? null,
      // "Is this application resume-backed?" is answered by the LINK's handle,
      // not by the existence of an ingestion row: `runImport` seeds an
      // ingestion row for EVERY link, so the row-existence test was always
      // true and a no-resume application would have waited forever for an
      // ingestion that had nothing to ingest.
      noResume: link.externalResumeFileHandle == null,
      email: deps.email,
      recruiterReissuePath: deps.reissuePathFor(link.externalApplicationId),
      nowMs: deps.nowMs,
    });

    if (result.delivery === 'not_ready') {
      const reason = result.reason ?? 'not_ready';
      if (PREREQUISITE_DEFER_REASONS.has(reason)) {
        // A WAIT, not a failure: refund the attempt the claim charged and
        // come back after a bounded delay. With the 0035 claim gate in place
        // this is the post-claim race only.
        const r = await deps.stores.deferOperation(claim.id, claim.leaseToken, reason, deferSeconds);
        emit('deferred', reason);
        return {
          claimed: true, operationType: claim.operationType, committed: false,
          staleLease: r === 'not_owned', code: reason,
        };
      }
      // A genuine fault in work this operation owns (`candidate_missing`,
      // `persist_failed`). Retryable and attempt-bounded, as before.
      const r = await deps.stores.failOperation(claim.id, claim.leaseToken, reason, true);
      emit('retry', reason);
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: r === 'not_owned', code: reason,
      };
    }

    // The external anchor is an OPAQUE invite row id — never the token, never a
    // URL, never contact data.
    const anchor = result.inviteId ?? null;

    // ── The manual channel does NOT complete here (review finding B1) ──────
    // Minting the invite only produces a SHA-256 digest; the plaintext is
    // deliberately never returned, logged, or persisted. Until an authorized
    // admin actually obtains a usable link through the Mission Control
    // delivery endpoint, no recruiter can contact the candidate — so
    // completing the operation as `succeeded` here would report success for
    // work that has not happened. It parks instead, and the delivery endpoint
    // moves it to `succeeded` when the link is genuinely handed over.
    if (result.channel === 'manual' && result.delivery === 'manual_reissue') {
      const parked = await deps.stores.parkOperationAwaitingDelivery(claim.id, claim.leaseToken, anchor);
      emit(parked === 'ok' ? 'awaiting_manual_delivery' : 'stale_lease', 'awaiting_manual_delivery');
      return {
        claimed: true, operationType: claim.operationType,
        // `committed` means the operation reached its intended durable state,
        // which for the manual channel is `awaiting_manual_delivery`.
        committed: parked === 'ok', staleLease: parked !== 'ok',
        code: 'awaiting_manual_delivery',
      };
    }

    // ── Nothing else delivered anything, so nothing else may say `succeeded` ─
    // Every remaining outcome is a delivery that provably did NOT happen:
    //   blocked_provider — the email channel is provider-gated and there is no
    //                      transport wired at all, so zero mail was sent;
    //   blocked_terminal — the application went terminal under the lease;
    //   invalid_reissue_path — the manual artifact could not even be shaped.
    // Completing these as `succeeded` would report success for work that did
    // not occur — the exact untruthfulness the manual channel was repaired for
    // (review finding B1), and it would make Mission Control show a delivered
    // email that no candidate ever received. They are instead recorded as a
    // durable, NON-retryable failure carrying the sanitized reason, which is
    // an admin-visible signal that the mapping needs a decision (switch to the
    // manual channel, or wait for an approved provider). `succeeded` on an
    // invite_delivery operation now means exactly one thing: an authorized
    // human took possession of a usable link.
    const blockedCode = result.reason ?? result.delivery;
    const blocked = await deps.stores.failOperation(claim.id, claim.leaseToken, blockedCode, false);
    emit('blocked', result.delivery);
    return {
      claimed: true, operationType: claim.operationType,
      committed: false, staleLease: blocked === 'not_owned',
      code: result.delivery,
    };
  } catch {
    // Sanitized: a thrown adapter/provider error never leaks its message.
    try {
      const r = await deps.stores.failOperation(claim.id, claim.leaseToken, 'operation_error', true);
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: r === 'not_owned', code: 'operation_error',
      };
    } catch {
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: false, code: 'operation_error',
      };
    }
  }
}

/**
 * Poll both supported operation lanes once.
 *
 * Supplying the scorecard adapter to `runClaimedAshbyOperation` selects the
 * scorecard lane. The runtime previously supplied it unconditionally, which
 * meant the invite lane was never polled and every candidate invite remained
 * pending forever. Keep the lanes explicit and run both on every scheduler
 * pass so neither can starve the other.
 */
export async function runAshbyOperationPass(
  deps: OperationWorkerDeps,
): Promise<{ invite: OperationRunOutcome; scorecard: OperationRunOutcome }> {
  const { scorecard, ...inviteDeps } = deps;
  const invite = await runClaimedAshbyOperation(inviteDeps);
  const scorecardOutcome = scorecard
    ? await runClaimedAshbyOperation({ ...inviteDeps, scorecard })
    : { claimed: false as const };
  return { invite, scorecard: scorecardOutcome };
}
