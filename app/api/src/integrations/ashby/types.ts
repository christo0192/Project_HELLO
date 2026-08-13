/**
 * Ashby client — typed request/response primitives.
 *
 * SCOPE (invariant 7): this file locks ONLY the officially verified generic
 * envelope and pagination primitives, plus the small set of endpoints needed
 * for tenant probing. Tenant-uncertain payload details (feedback form field
 * paths, score scales, exact per-endpoint request field names, file.info URL
 * host/TTL) are intentionally left as opaque/narrow extension points via
 * `OpaqueRecord` and optional `extra` fields — they are NOT speculatively
 * locked here. Actual shapes must be pinned from a tenant probe before any
 * saga is coded around them.
 */

/** An opaque object whose exact shape is tenant-verifiable, not yet locked. */
export type OpaqueRecord = Record<string, unknown>;

// ── Response envelope (verified: Ashby may return 200 + success:false) ──────

export interface AshbySuccessEnvelope<T> {
  success: true;
  results: T;
  /** Cursor-pagination flag (list endpoints). */
  moreDataAvailable?: boolean;
  /** Opaque next-page cursor (list endpoints). Never logged. */
  nextCursor?: string;
  /** Opaque incremental sync token (list endpoints). Never logged. */
  syncToken?: string;
  [k: string]: unknown;
}

export interface AshbyErrorEnvelope {
  success: false;
  /** Endpoint-specific errors array (shape varies; treated opaquely). */
  errors?: unknown;
  /** Alternate error info object some endpoints return. */
  errorInfo?: unknown;
  [k: string]: unknown;
}

export type AshbyEnvelope<T> = AshbySuccessEnvelope<T> | AshbyErrorEnvelope;

/** Successful result surfaced to callers, plus verified pagination primitives. */
export interface AshbyResult<T> {
  results: T;
  moreDataAvailable: boolean;
  /** Opaque cursor; treat as a black box, never log. */
  nextCursor?: string;
  /** Opaque incremental sync token; treat as a black box, never log. */
  syncToken?: string;
}

// ── Pagination helper output ────────────────────────────────────────────────

export interface PaginatedList<T> {
  items: T[];
  /** Pages actually fetched (bounded by maxPages). */
  pagesFetched: number;
  /** Last opaque sync token observed, if any. Never log. */
  syncToken?: string;
}

// ── Operation registry (fixed endpoint paths; never caller-controlled) ──────

/** Ashby operations this foundation supports for tenant probing. */
export type AshbyOperation =
  | 'application.info'
  | 'application.list'
  | 'candidate.info'
  | 'file.info'
  | 'jobInterviewPlan.info'
  | 'applicationFeedback.list'
  | 'applicationFeedbackRequest.create'
  | 'applicationFeedback.submit'
  | 'application.changeStage';

export interface AshbyOperationSpec {
  /** Fixed request path appended to the allowlisted base origin. */
  path: string;
  /**
   * Whether the operation mutates tenant state. Mutations are NOT retried on
   * ambiguous failures (timeout/network after send) unless the caller supplies
   * an explicit idempotency strategy.
   */
  mutation: boolean;
}

/** Fixed operation → path/mutation map. Paths are never caller-controlled. */
export const ASHBY_OPERATIONS: Readonly<Record<AshbyOperation, AshbyOperationSpec>> = {
  'application.info':                  { path: '/application.info',                  mutation: false },
  'application.list':                  { path: '/application.list',                  mutation: false },
  'candidate.info':                    { path: '/candidate.info',                    mutation: false },
  'file.info':                         { path: '/file.info',                         mutation: false },
  'jobInterviewPlan.info':             { path: '/jobInterviewPlan.info',             mutation: false },
  'applicationFeedback.list':          { path: '/applicationFeedback.list',          mutation: false },
  'applicationFeedbackRequest.create': { path: '/applicationFeedbackRequest.create', mutation: true },
  'applicationFeedback.submit':        { path: '/applicationFeedback.submit',        mutation: true },
  'application.changeStage':           { path: '/application.changeStage',           mutation: true },
} as const;

// ── Narrow, extension-friendly request shapes ───────────────────────────────
// Only fields we are confident about are named; everything else rides in
// `extra` so a tenant probe can complete the shape without a code rewrite.

export interface ApplicationListParams {
  /** Opaque cursor from a prior page. */
  cursor?: string;
  /** Opaque incremental sync token. */
  syncToken?: string;
  /** Optional bounded page size hint (tenant-verifiable). */
  limit?: number;
  /** Tenant-verifiable additional request fields. */
  extra?: OpaqueRecord;
}

export interface FeedbackSubmitRequest {
  applicationId: string;
  /** Feedback form definition id (per-job, tenant-verifiable). */
  formDefinitionId: string;
  /** Typed form field submissions; exact field paths are tenant-verifiable. */
  feedbackForm: OpaqueRecord;
  /** Attribution user (verified optional). */
  userId?: string;
  /** Interview event anchor (verified optional). */
  interviewEventId?: string;
  /** Tenant-verifiable additional request fields. */
  extra?: OpaqueRecord;
}

export interface FeedbackRequestCreateRequest {
  applicationId: string;
  /** Interviewer user id (verified optional depending on tenant). */
  userId?: string;
  /** Interview id (tenant-verifiable). */
  interviewId?: string;
  /** Tenant-verifiable additional request fields. */
  extra?: OpaqueRecord;
}
