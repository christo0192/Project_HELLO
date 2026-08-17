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
 */

import type { RuntimeWorkflowStores, OperationClaimRow } from './orchestration.js';
import { materializeInvite, type MaterializationStore, type MaterializationMapping } from './materialize.js';
import type { EmailProviderState } from './invite-delivery.js';

/**
 * The ONLY operation types this runtime executes. Deliberately excludes
 * `scorecard_write` and `stage_move` — see the module header.
 */
export const SUPPORTED_OPERATION_TYPES = ['invite_delivery'] as const;
export type SupportedOperationType = (typeof SUPPORTED_OPERATION_TYPES)[number];

/** Operation types the runtime must never claim while no result sink exists. */
export const REFUSED_OPERATION_TYPES = ['scorecard_write', 'stage_move'] as const;

export interface OperationWorkerDeps {
  stores: RuntimeWorkflowStores;
  materialization: MaterializationStore;
  /** Resolve mapping config for a link's job. Null when no usable mapping. */
  resolveMappingForLink(applicationLinkId: string): Promise<MaterializationMapping | null>;
  /** Build the site-relative recruiter reissue path for an application. */
  reissuePathFor(externalApplicationId: string): string;
  /** Email provider gate. Stays closed until an approved provider + domain. */
  email: EmailProviderState;
  /** Opaque worker identity recorded as the operation lease owner. */
  owner: string;
  leaseSeconds: number;
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
    claim = await deps.stores.claimOperation('invite_delivery', deps.owner, deps.leaseSeconds);
  } catch {
    return { claimed: false };
  }
  if (!claim) return { claimed: false };

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

    const mapping = await deps.resolveMappingForLink(claim.applicationLinkId);
    if (!mapping) {
      const r = await deps.stores.failOperation(claim.id, claim.leaseToken, 'mapping_inactive', true);
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
      // No ingestion row at all means the application carried no resume handle.
      noResume: ingestion === null,
      email: deps.email,
      recruiterReissuePath: deps.reissuePathFor(link.externalApplicationId),
      nowMs: deps.nowMs,
    });

    if (result.delivery === 'not_ready') {
      // Retryable: the ephemeral ingestion has not reached `ready` yet. The
      // operation's own max_attempts bounds this — it cannot spin forever.
      const r = await deps.stores.failOperation(
        claim.id, claim.leaseToken, result.reason ?? 'not_ready', true,
      );
      emit('deferred', result.reason);
      return {
        claimed: true, operationType: claim.operationType, committed: false,
        staleLease: r === 'not_owned', code: result.reason ?? 'not_ready',
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

    const outcome = await deps.stores.completeOperation(claim.id, claim.leaseToken, anchor, claim.marker);
    emit(outcome === 'ok' ? 'completed' : 'stale_lease', result.delivery);
    return {
      claimed: true, operationType: claim.operationType,
      committed: outcome === 'ok', staleLease: outcome !== 'ok',
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
