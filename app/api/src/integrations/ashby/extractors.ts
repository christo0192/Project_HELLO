/**
 * ashby/extractors.ts — defensive, bounded extraction of the fields the
 * webhook + worker need from a tenant-uncertain Ashby payload.
 *
 * The exact Ashby webhook body shape is tenant-verifiable (see types.ts): only
 * the small set of fields below are read, each via a prioritized list of
 * candidate paths, and every value is validated as a bounded safe id string.
 * Nothing here trusts the payload as truth — the worker re-reads
 * `application.info` as the source of truth (invariant 6). These extractors
 * exist only to (a) form a stable dedup identity and (b) carry an opaque
 * application id on the signal. No contact/resume/token data is ever read.
 */

/** Max accepted id length (parity with the DB id-column bounds). */
const MAX_ID_LEN = 256;

/** A safe external id: printable, no control chars, within bounds. */
function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length < 1 || value.length > MAX_ID_LEN) return undefined;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return undefined;
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read the first present safe-id at any of the given dotted paths. */
function firstSafeId(root: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    let cur: unknown = root;
    for (const seg of path) {
      const obj = asObject(cur);
      if (!obj) { cur = undefined; break; }
      cur = obj[seg];
    }
    const id = safeId(cur);
    if (id) return id;
  }
  return undefined;
}

/** The subset of the webhook the ingress + worker act on. */
export interface WebhookSignal {
  /** Stable per-delivery/action id used as the receipt dedup key. */
  webhookActionId: string;
  /** Event action name (e.g. 'candidateStageChange'). */
  action: string;
  /** Opaque external application id, if present. */
  externalApplicationId?: string;
  /** Opaque external job id, if present (worker re-validates against mapping). */
  externalJobId?: string;
  /** Opaque current stage id as claimed by the payload (advisory only). */
  externalStageId?: string;
}

export type ExtractResult =
  | { ok: true; signal: WebhookSignal }
  | { ok: false; reason: 'not_object' | 'missing_action' | 'unresolvable_id' };

/** Safe action-name pattern (bounded identifier; no PII/control chars). */
const ACTION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The single stage-change action that is the initial processing trigger. */
export const CANDIDATE_STAGE_CHANGE_ACTION = 'candidateStageChange';

/**
 * Stage-centric dedup identity for a candidate-stage-change. Using
 * (applicationId, stageId) — NOT a per-delivery provider id — means webhook
 * retries AND reconciliation-recovered signals for the SAME application-at-stage
 * all converge to exactly one receipt. Bounded to the id length.
 */
export function stageDedupId(applicationId: string, stageId: string | undefined): string {
  const id = `stage:${applicationId}:${stageId ?? 'nostage'}`;
  return id.length <= MAX_ID_LEN ? id : id.slice(0, MAX_ID_LEN);
}

/**
 * Extract the webhook signal from an already-parsed body. Fails closed:
 *  - non-object body               → not_object
 *  - no recognizable action name   → missing_action
 *  - no explicit id AND no id we can deterministically derive → unresolvable_id
 *
 * The dedup id prefers an explicit provider id; when absent it falls back to a
 * deterministic composite of (action + applicationId + stageId) so repeated
 * deliveries of the SAME state still converge to one receipt.
 */
export function extractWebhookSignal(parsed: unknown): ExtractResult {
  const root = asObject(parsed);
  if (!root) return { ok: false, reason: 'not_object' };

  const actionRaw =
    firstSafeId(root, [['action'], ['type'], ['event'], ['data', 'action', 'type']]);
  if (!actionRaw || !ACTION_RE.test(actionRaw)) return { ok: false, reason: 'missing_action' };
  const action = actionRaw;

  const externalApplicationId = firstSafeId(root, [
    ['data', 'application', 'id'],
    ['data', 'applicationId'],
    ['application', 'id'],
    ['applicationId'],
  ]);
  const externalJobId = firstSafeId(root, [
    ['data', 'application', 'job', 'id'],
    ['data', 'application', 'jobId'],
    ['data', 'job', 'id'],
    ['jobId'],
  ]);
  const externalStageId = firstSafeId(root, [
    ['data', 'application', 'currentInterviewStage', 'id'],
    ['data', 'application', 'currentStageId'],
    ['data', 'stageId'],
    ['stageId'],
  ]);

  // Prefer an explicit provider delivery/action id (used for non-stage events).
  const explicitId = firstSafeId(root, [
    ['id'],
    ['webhookId'],
    ['actionId'],
    ['data', 'action', 'id'],
    ['data', 'id'],
  ]);

  let webhookActionId: string | undefined;
  if (action === CANDIDATE_STAGE_CHANGE_ACTION && externalApplicationId) {
    // Stage-centric dedup: retries + reconciliation converge to one receipt.
    webhookActionId = stageDedupId(externalApplicationId, externalStageId);
  } else if (explicitId) {
    webhookActionId = explicitId;
  } else if (externalApplicationId) {
    // Deterministic composite fallback for non-stage events without an id.
    const composite = `derived:${action}:${externalApplicationId}`;
    webhookActionId = composite.length <= MAX_ID_LEN ? composite : composite.slice(0, MAX_ID_LEN);
  }
  if (!webhookActionId) return { ok: false, reason: 'unresolvable_id' };

  return {
    ok: true,
    signal: { webhookActionId, action, externalApplicationId, externalJobId, externalStageId },
  };
}

// ── Worker-side extraction from the authoritative application.info result ────

/** Fields the worker reads from the authoritative application.info payload. */
export interface ApplicationInfoView {
  applicationId?: string;
  jobId?: string;
  currentStageId?: string;
  /** Opaque candidate id for an authoritative candidate.info resume fallback. */
  candidateId?: string;
}

/** Defensively read the authoritative application.info result. */
export function extractApplicationInfo(results: unknown): ApplicationInfoView {
  const root = asObject(results);
  if (!root) return {};
  // application.info may nest under `application` or return the app directly.
  const app = asObject(root.application) ?? root;
  const candidateId = firstSafeId(app, [['candidate', 'id'], ['candidateId']]);
  return {
    applicationId: firstSafeId(app, [['id']]) ?? firstSafeId(root, [['applicationId']]),
    jobId: firstSafeId(app, [['job', 'id'], ['jobId']]),
    currentStageId:
      firstSafeId(app, [['currentInterviewStage', 'id'], ['currentStageId'], ['stageId']]),
    ...(candidateId ? { candidateId } : {}),
  };
}
