/**
 * ashby/logging.ts — metadata-only logger adapter.
 *
 * Bridges the Ashby client's structured {@link AshbyLogRecord} onto the
 * repository's strict allowlist logger. Only scalar metadata that the existing
 * logger already permits is forwarded: the operation name (as `schema`, a safe
 * identifier), the error category (as `error_category`), the HTTP status (as
 * `http_status`), and a coarse duration in whole seconds (`duration_sec`).
 * Request/response bodies, ids, sync tokens, file URLs, feedback content, and
 * the API key are never passed through — the log record type cannot carry them.
 */

import { createLogger } from '../../lib/logger.js';
import type { AshbyClientLogger, AshbyLogRecord } from './client.js';

/**
 * A metadata-only logger backed by the repo's allowlist logger. Non-allowlisted
 * fields are dropped by the underlying logger; nothing sensitive can reach it
 * because {@link AshbyLogRecord} only exposes primitives.
 */
export function createMetadataLogger(component = 'ashby-client'): AshbyClientLogger {
  const logger = createLogger(component);
  return {
    event(record: AshbyLogRecord): void {
      const level = record.outcome === 'failure' ? 'warn' : 'debug';
      logger[level]('unknown_event', {
        schema: record.operation,
        error_category: record.category,
        http_status: record.httpStatus,
        duration_sec: Math.round(record.durationMs / 1000),
      });
    },
  };
}
