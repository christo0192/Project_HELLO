/**
 * ashby/index.ts — public surface of the typed Ashby client foundation.
 *
 * This module is intentionally NOT wired to any production route, queue, or
 * worker. It provides an injectable, hardened transport for a later
 * tenant-probe / integration step. No credentials are configured here and no
 * live Ashby connectivity is claimed.
 */

export { AshbyError, isAshbyError, type AshbyErrorCategory } from './errors.js';
export {
  AshbyClient,
  createAshbyClient,
  ASHBY_API_BASE_URL,
  type AshbyClientConfig,
  type AshbyClientLogger,
  type AshbyLogRecord,
  type AshbyTransport,
  type AshbyTransportRequest,
  type AshbyTransportResponse,
  type RequestOptions,
} from './client.js';
export { createMetadataLogger } from './logging.js';
export {
  ASHBY_OPERATIONS,
  type AshbyOperation,
  type AshbyEnvelope,
  type AshbySuccessEnvelope,
  type AshbyErrorEnvelope,
  type AshbyResult,
  type PaginatedList,
  type OpaqueRecord,
  type ApplicationListParams,
  type FeedbackSubmitRequest,
  type FeedbackRequestCreateRequest,
} from './types.js';
