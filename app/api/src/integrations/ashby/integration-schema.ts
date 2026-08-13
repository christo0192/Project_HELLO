/**
 * integration-schema.ts — deterministic domain model for the Ashby integration
 * schema (migration 0029). Pure, DB-free logic that MIRRORS the SQL guarantees
 * (state machines, dependency ordering, completeness/drift gates, delivery
 * modes, fixed 24h TTL) so callers and unit tests can validate the same
 * invariants the database enforces at the trigger/constraint boundary.
 *
 * This module is schema/config foundation only — it is NOT wired to any route,
 * worker, webhook, or live Ashby call, and it configures no credentials.
 *
 * PRIVACY: operational/event/outbox contracts carry opaque IDs and sanitized
 * codes only. Contact fields (email/phone), resume text/bytes/URLs, invite
 * tokens, and raw webhook bodies live exclusively in the existing sensitive
 * candidate/invite model and MUST NOT appear here — see forbiddenOperationalKeys.
 */

export const ASHBY_PROVIDER = 'ashby' as const;

/** Fixed Phase-1 invite TTL. Any other value is rejected. */
export const ASHBY_INVITE_TTL_HOURS = 24 as const;

// ── Enumerations (mirror the CHECK constraints in 0029) ─────────────────────

export const DELIVERY_MODES = ['email', 'manual', 'both'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const MAPPING_STATUSES = ['paused', 'enabled', 'drift'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export const APPLICATION_LIFECYCLES = ['imported', 'processing', 'ready', 'completed', 'cancelled'] as const;
export type ApplicationLifecycle = (typeof APPLICATION_LIFECYCLES)[number];

export const APPLICATION_TERMINAL_STATES = ['withdrawn', 'deleted', 'manual_stage_cancel'] as const;
export type ApplicationTerminalState = (typeof APPLICATION_TERMINAL_STATES)[number];

export const EVENT_RECEIPT_STATUSES = ['received', 'processing', 'processed', 'failed', 'ignored'] as const;
export type EventReceiptStatus = (typeof EVENT_RECEIPT_STATUSES)[number];

export const INGESTION_STATES = [
  'queued', 'fetching', 'scanning', 'extracting', 'structuring', 'ready', 'failed_review', 'cancelled',
] as const;
export type IngestionState = (typeof INGESTION_STATES)[number];

export const OPERATION_TYPES = ['invite_delivery', 'scorecard_write', 'stage_move'] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_STATES = ['pending', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

// ── Resume ingestion state machine (parity with the DB trigger) ─────────────

/** Legal next-states for each ingestion state; terminal states have none. */
export const INGESTION_TRANSITIONS: Readonly<Record<IngestionState, readonly IngestionState[]>> = {
  queued: ['fetching', 'cancelled'],
  fetching: ['scanning', 'failed_review', 'cancelled'],
  scanning: ['extracting', 'failed_review', 'cancelled'],
  extracting: ['structuring', 'failed_review', 'cancelled'],
  structuring: ['ready', 'failed_review', 'cancelled'],
  failed_review: ['queued', 'cancelled'], // retriable
  ready: [], // terminal
  cancelled: [], // terminal
} as const;

/** True iff `from -> to` is legal (same-state is an idempotent no-op). */
export function isValidIngestionTransition(from: IngestionState, to: IngestionState): boolean {
  if (from === to) return true;
  const allowed = INGESTION_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

// ── Operation dependency ordering (scorecard-before-stage) ──────────────────

/**
 * Whether an operation may transition to `nextState` given its dependency's
 * current state. Becoming `running` or `succeeded` requires any dependency to
 * have already `succeeded` (a stage_move cannot run before its scorecard_write
 * prerequisite succeeds). Non-runnable transitions are unrestricted here.
 */
export function canOperationEnterState(
  nextState: OperationState,
  dependencyState: OperationState | null | undefined,
): boolean {
  if (nextState !== 'running' && nextState !== 'succeeded') return true;
  if (dependencyState === null || dependencyState === undefined) return true; // no dependency
  return dependencyState === 'succeeded';
}

// ── Mapping completeness / drift / enable gate ──────────────────────────────

export interface MappingEnableInput {
  status: MappingStatus;
  aiScreeningStageId: string | null | undefined;
  taScreeningStageId: string | null | undefined;
  deliveryMode: string;
  inviteTtlHours: number;
}

/** A mapping is complete for enable iff both screening stage IDs are present. */
export function isMappingComplete(m: Pick<MappingEnableInput, 'aiScreeningStageId' | 'taScreeningStageId'>): boolean {
  return Boolean(m.aiScreeningStageId) && Boolean(m.taScreeningStageId);
}

export function isValidDeliveryMode(mode: string): mode is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(mode);
}

export function isValidInviteTtlHours(hours: number): boolean {
  return hours === ASHBY_INVITE_TTL_HOURS;
}

export type MappingEnableResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_delivery_mode' | 'invalid_invite_ttl' | 'incomplete_cannot_enable' | 'drifted_cannot_enable' };

/**
 * Validate a request to ENABLE a mapping (or keep it paused). Mirrors
 * upsert_ashby_job_mapping: enabling requires a valid delivery mode, the fixed
 * 24h TTL, both stage IDs, and a non-drifted current status.
 */
export function evaluateMappingEnable(
  next: MappingEnableInput,
  currentStatus?: MappingStatus,
): MappingEnableResult {
  if (!isValidDeliveryMode(next.deliveryMode)) return { ok: false, reason: 'invalid_delivery_mode' };
  if (!isValidInviteTtlHours(next.inviteTtlHours)) return { ok: false, reason: 'invalid_invite_ttl' };
  if (next.status !== 'enabled') return { ok: true };
  if (!isMappingComplete(next)) return { ok: false, reason: 'incomplete_cannot_enable' };
  if (currentStatus === 'drift') return { ok: false, reason: 'drifted_cannot_enable' };
  return { ok: true };
}

// ── Terminal-state gate for new operations ──────────────────────────────────

/** A terminal application link accepts no new delivery/write-back operations. */
export function canCreateOperation(linkTerminalState: ApplicationTerminalState | null | undefined): boolean {
  return linkTerminalState === null || linkTerminalState === undefined;
}

// ── Forbidden operational payload keys (no PII/tokens/bodies) ────────────────

/**
 * Key fragments that must NEVER appear in operational/event/outbox metadata.
 * Contact/resume/token/raw-body data belongs only to the sensitive candidate
 * model. Matching is case-insensitive substring on each key.
 */
export const FORBIDDEN_OPERATIONAL_KEY_FRAGMENTS: readonly string[] = [
  'email', 'phone', 'contact',
  'resume_text', 'resumetext', 'resume_bytes', 'resume_url', 'resumeurl',
  'signed_url', 'signedurl', 'presigned',
  'token', 'secret', 'password', 'apikey', 'api_key',
  'webhook_body', 'webhookbody', 'raw_body', 'rawbody', 'body',
] as const;

/**
 * Recursively collect any object keys that match a forbidden fragment. An empty
 * array means the payload is contract-safe for an operational/event/outbox row.
 */
export function findForbiddenOperationalKeys(value: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (value === null || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenOperationalKeys(v, `${path}[${i}]`)));
    return hits;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_OPERATIONAL_KEY_FRAGMENTS.some((f) => lower.includes(f))) {
      hits.push(`${path}.${key}`);
    }
    hits.push(...findForbiddenOperationalKeys(v, `${path}.${key}`));
  }
  return hits;
}

/** True iff `payload` carries no forbidden PII/token/body-shaped keys. */
export function isOperationalPayloadSafe(payload: unknown): boolean {
  return findForbiddenOperationalKeys(payload).length === 0;
}
