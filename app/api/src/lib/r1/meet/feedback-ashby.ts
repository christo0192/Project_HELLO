/**
 * The Ashby side of Dex's scorecard feedback (M034 S09, dark; D-S09-3, D-S09-10, D-S09-12, D-S09-13).
 *
 * EXPLICIT SETTINGS. The API key, the logger and the test transport are arguments: this module reads
 * no environment, and loading it performs no I/O. The runtime (S09 T4) builds the port lazily, on the
 * first feedback job, from the existing Ashby runtime configuration.
 *
 * THE PORT, two calls through the UNCHANGED Ashby client (`createAshbyClient`):
 *   readForm  `feedbackFormDefinition.info` through the read-only probe: the form's sanitized
 *             STRUCTURE (sections, fields, paths, types, option values), never an answer;
 *   submit    `applicationFeedback.submit`. The answer (`submittedFormInstance`) is discarded and never
 *             logged. The port sends only the five keys of `r1MeetFeedbackRequest` (never `extra`) and
 *             refuses, before the network, a request without `userId` or `interviewEventId`: without
 *             the event id Ashby would create a new submission on every call, so a retry could post a
 *             second card (D-S09-1).
 * The client is built with `maxAttempts: 1` and a 15 s timeout: the `r1-meet` queue does every retry
 * (a deferral, then attempts, then the dead-letter queue), and one job makes at most one form read and
 * one submit, well inside the lane lease.
 *
 * FAILURES, `classifyR1MeetAshbyFailure` (D-S09-10), over the client's closed taxonomy:
 *   rate_limited     a 429 (`rate_limited`, or `retry_exhausted` with 429): defer 60 s;
 *   unavailable      a 5xx, a timeout, a network failure, a malformed or oversized answer, or
 *                    `retry_exhausted` with another status or none: defer 30 s (a retry is safe, the
 *                    submit is an update of Dex's one card);
 *   rejected         a permanent 4xx (`http_client_error`) or `success:false` (`logical_failure`):
 *                    terminal, with an alert;
 *   request_invalid  the client's pre-transport validation (`invalid_request`): terminal, with an alert.
 * A non-Ashby error answers null and the caller rethrows it. `detail` is `<category>[:<code>]`, at most
 * 64 characters: the category, then for `retry_exhausted` the transient class it ended on, otherwise
 * the first endpoint error code that is a short safe identifier (lower-cased), as the operation worker
 * keeps it. Never a message, a body, an id or a path.
 *
 * LOGS. The client's own metadata lines become `r1_meet_ashby_ok` (info) and `r1_meet_ashby_failed`
 * (warn) with error_type `<operation>[:<category>]` and the HTTP status: closed words and a number,
 * never the key, an id, a URL path, a field path or any part of a body.
 */

import { createAshbyClient, type AshbyClientLogger, type AshbyTransport } from '../../../integrations/ashby/client.js';
import { AshbyError, isAshbyError, type AshbyErrorCategory } from '../../../integrations/ashby/errors.js';
import { probeFeedbackFormDefinition, type ProbeFeedbackForm } from '../../../integrations/ashby/probe.js';
import type { FeedbackSubmitRequest } from '../../../integrations/ashby/types.js';
import type { R1MeetLog, R1MeetLogMeta } from './recall-actions.js';

/** The client settings of the port (D-S09-3): no retries inside the client, 15 s per call. */
export const R1_MEET_ASHBY_CLIENT_SETTINGS = Object.freeze({ maxAttempts: 1, timeoutMs: 15_000 });

const SUBMIT_OPERATION = 'applicationFeedback.submit';
const MAX_DETAIL_LEN = 64;
const ENDPOINT_CODE = /^[a-z0-9_.:-]{1,40}$/;

const CATEGORIES: ReadonlySet<string> = new Set<AshbyErrorCategory>([
  'invalid_request',
  'logical_failure',
  'http_client_error',
  'rate_limited',
  'http_server_error',
  'malformed_response',
  'timeout',
  'network',
  'output_limit',
  'retry_exhausted',
]);

// ── The port ────────────────────────────────────────────────────────────────

export interface R1MeetAshbyFeedbackPort {
  /** The form's sanitized structure, or null when Ashby answered no usable definition. */
  readForm(formDefinitionId: string): Promise<ProbeFeedbackForm | null>;
  /** Submit (or update) Dex's feedback for one interview event. Resolves with nothing. */
  submit(request: FeedbackSubmitRequest): Promise<void>;
}

export interface R1MeetAshbyFeedbackPortOptions {
  /** `ASHBY_API_KEY`, passed in by the runtime. Never logged. */
  readonly apiKey: string;
  readonly log: R1MeetLog;
  /** Test seam: replaces the network (the Ashby fake). Production passes nothing. */
  readonly transport?: AshbyTransport;
  /** Test seam for the client's backoff sleep (unused with one attempt). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the port. Throws the client's `invalid_request` (`missing_api_key`) for an empty key, so the
 * caller builds it only when a key is configured.
 */
export function createR1MeetAshbyFeedbackPort(options: R1MeetAshbyFeedbackPortOptions): R1MeetAshbyFeedbackPort {
  const client = createAshbyClient({
    apiKey: options.apiKey,
    maxAttempts: R1_MEET_ASHBY_CLIENT_SETTINGS.maxAttempts,
    timeoutMs: R1_MEET_ASHBY_CLIENT_SETTINGS.timeoutMs,
    logger: r1MeetAshbyClientLogger(options.log),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return Object.freeze({
    readForm(formDefinitionId: string): Promise<ProbeFeedbackForm | null> {
      return probeFeedbackFormDefinition(formDefinitionId, client);
    },
    async submit(request: FeedbackSubmitRequest): Promise<void> {
      if (typeof request.userId !== 'string' || request.userId.length === 0) {
        throw new AshbyError('invalid_request', { code: 'missing_user_id', operation: SUBMIT_OPERATION });
      }
      if (typeof request.interviewEventId !== 'string' || request.interviewEventId.length === 0) {
        throw new AshbyError('invalid_request', { code: 'missing_interview_event_id', operation: SUBMIT_OPERATION });
      }
      // The five keys only: an `extra` on the request is dropped, never forwarded.
      await client.applicationFeedbackSubmit({
        applicationId: request.applicationId,
        formDefinitionId: request.formDefinitionId,
        feedbackForm: request.feedbackForm,
        userId: request.userId,
        interviewEventId: request.interviewEventId,
      });
    },
  });
}

/** The Ashby client's metadata logger as `r1_meet_ashby_ok` / `r1_meet_ashby_failed` lines. */
export function r1MeetAshbyClientLogger(log: R1MeetLog): AshbyClientLogger {
  return {
    event(record) {
      const meta: R1MeetLogMeta = {
        error_category: record.outcome === 'success' ? 'r1_meet_ashby_ok' : 'r1_meet_ashby_failed',
        error_type: record.category === undefined ? record.operation : `${record.operation}:${record.category}`,
        ...(typeof record.httpStatus === 'number' ? { http_status: record.httpStatus } : {}),
      };
      if (record.outcome === 'success') log.info(meta);
      else log.warn(meta);
    },
  };
}

// ── Failure classes (D-S09-10) ──────────────────────────────────────────────

export type R1MeetAshbyFailureKind = 'rate_limited' | 'unavailable' | 'rejected' | 'request_invalid';

export interface R1MeetAshbyFailure {
  readonly kind: R1MeetAshbyFailureKind;
  /** `<category>[:<code>]`, closed words, at most 64 characters. */
  readonly detail: string;
  readonly httpStatus: number | null;
}

/** Classify an Ashby client failure (see the header); null for anything that is not an AshbyError. */
export function classifyR1MeetAshbyFailure(error: unknown): R1MeetAshbyFailure | null {
  if (!isAshbyError(error)) return null;
  const httpStatus = typeof error.httpStatus === 'number' ? error.httpStatus : null;
  return Object.freeze({
    kind: failureKind(error.category, httpStatus, error.code),
    detail: failureDetail(error),
    httpStatus,
  });
}

function failureKind(category: AshbyErrorCategory, httpStatus: number | null, code: string): R1MeetAshbyFailureKind {
  switch (category) {
    case 'rate_limited':
      return 'rate_limited';
    case 'retry_exhausted':
      return httpStatus === 429 || code === 'rate_limited' ? 'rate_limited' : 'unavailable';
    case 'http_client_error':
    case 'logical_failure':
      return 'rejected';
    case 'invalid_request':
      return 'request_invalid';
    case 'http_server_error':
    case 'timeout':
    case 'network':
    case 'malformed_response':
    case 'output_limit':
      return 'unavailable';
    default:
      // Not reachable through the typed constructor; a transient class retries within its bound.
      return 'unavailable';
  }
}

function failureDetail(error: AshbyError): string {
  const category = CATEGORIES.has(error.category) ? error.category : 'unknown';
  let suffix: string | undefined;
  if (category === 'retry_exhausted') {
    // The client records the transient class it ended on as the code.
    suffix = CATEGORIES.has(error.code) && error.code !== 'retry_exhausted' ? error.code : undefined;
  } else {
    suffix = error.endpointCodes
      .map((code) => code.toLowerCase())
      .find((code) => ENDPOINT_CODE.test(code));
  }
  return (suffix ? `${category}:${suffix}` : category).slice(0, MAX_DETAIL_LEN);
}
