/**
 * The Ashby side of Dex's scorecard feedback (M034 S09, dark; D-S09-3, D-S09-10, D-S09-12, D-S09-13).
 *
 * EXPLICIT SETTINGS. The API key, the logger and the test transport are arguments: this module reads
 * no environment, and loading it performs no I/O. The runtime (S09 T4) builds the port lazily, on the
 * first feedback job, from the existing Ashby runtime configuration.
 *
 * THE PORT, four calls through the UNCHANGED Ashby client (`createAshbyClient`):
 *   readForm        `feedbackFormDefinition.info` through the read-only probe: the form's sanitized
 *                   STRUCTURE (sections, fields, paths, types, option values), never an answer;
 *   submit          `applicationFeedback.submit` for an Ashby-scheduled booking (interview-event mode).
 *                   The answer (`submittedFormInstance`) is discarded and never logged. The port sends
 *                   only the five keys of `r1MeetFeedbackRequest` (never `extra`) and refuses, before
 *                   the network, a request without `userId` or `interviewEventId`: without the event id
 *                   Ashby would create a new submission on every call, so a retry could post a second
 *                   card (D-S09-1);
 *   submitGeneral   `applicationFeedback.submit` for a public-page booking (M035 S02), which has no
 *                   Ashby schedule and so no interview event: GENERAL application feedback. It sends
 *                   exactly applicationId, formDefinitionId, feedbackForm and userId, and refuses
 *                   before the network a request without `userId` or WITH any `interviewEventId` key
 *                   (`unexpected_interview_event_id`): the two modes never mix. Ashby makes a new card
 *                   on every such call, so the handler runs `listDexFeedback` before every one;
 *   listDexFeedback `applicationFeedback.list` for one application (the key needs `candidatesRead`):
 *                   Dex's cards submitted at or after `since`, as two fields each (the form id and the
 *                   submitted time). Pages of 100 from `createdAfter` = `since` minus one hour (clock
 *                   slack; the time filter is ours), at most `R1_MEET_FEEDBACK_LIST_MAX_PAGES`. The
 *                   reader is FIXED-SHAPE: it reads `submittedByUser.id`, `creditedToUser.id`,
 *                   `submittedAt` and `feedbackFormDefinitionId` of each entry and nothing else (never
 *                   `submittedValues`, `formDefinition`, a name or an email, never a key enumeration),
 *                   and nothing of the answer is logged, thrown or returned beyond those two fields. A
 *                   list it cannot read in full (not an array, an entry with no readable user id, a Dex
 *                   entry with a bad time or form id, a repeated or missing cursor, a sixth page) is
 *                   `malformed_response` / `feedback_list_unreadable`: the handler defers, never submits.
 *                   The response fields follow the public Ashby reference and are UNVERIFIED on the
 *                   tenant (a live-spike item).
 * The client is built with `maxAttempts: 1` and a 15 s timeout: the `r1-meet` queue does every retry
 * (a deferral, then attempts, then the dead-letter queue), and one job makes at most one form read,
 * one list of at most five pages and one submit, well inside the lane lease.
 *
 * FAILURES, `classifyR1MeetAshbyFailure` (D-S09-10), over the client's closed taxonomy:
 *   rate_limited     a 429 (`rate_limited`, or `retry_exhausted` with 429): defer 60 s;
 *   unavailable      a 5xx, a timeout, a network failure, a malformed, unreadable or oversized
 *                    answer, or `retry_exhausted` with another status or none: defer 30 s (a retry is
 *                    safe: an interview-event submit is an update of Dex's one card, and a general
 *                    submit is preceded by the list guard on every run);
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
import type { FeedbackSubmitRequest, OpaqueRecord } from '../../../integrations/ashby/types.js';
import type { R1MeetLog, R1MeetLogMeta } from './recall-actions.js';
import { parseR1MeetInstant } from './ticket.js';

/** The client settings of the port (D-S09-3): no retries inside the client, 15 s per call. */
export const R1_MEET_ASHBY_CLIENT_SETTINGS = Object.freeze({ maxAttempts: 1, timeoutMs: 15_000 });

/** At most this many `applicationFeedback.list` pages per run; more is unreadable (M035 S02). */
export const R1_MEET_FEEDBACK_LIST_MAX_PAGES = 5;

const SUBMIT_OPERATION = 'applicationFeedback.submit';
const LIST_OPERATION = 'applicationFeedback.list';
/** Ashby's page size limit for the list. */
const LIST_PAGE_LIMIT = 100;
/** `createdAfter` is this much before `since`: clock slack only, the time filter is the reader's. */
const LIST_CLOCK_SLACK_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** One of Dex's cards on an application, as `listDexFeedback` copies it: two fields, nothing else. */
export interface R1MeetDexFeedbackCard {
  /** The card's form, a lower-cased UUID, or null when the entry carried none. */
  readonly formDefinitionId: string | null;
  /** When it was submitted (`toISOString()`), at or after the query's `since`. */
  readonly submittedAt: string;
}

export interface R1MeetDexFeedbackQuery {
  /** The Dex Ashby user (`R1_MEET_ASHBY_DEX_USER_ID`), a UUID; matched without case. */
  readonly dexUserId: string;
  /** A zoned ISO 8601 instant (the booking's `start_at`): older cards are not returned. */
  readonly since: string;
}

export interface R1MeetAshbyFeedbackPort {
  /** The form's sanitized structure, or null when Ashby answered no usable definition. */
  readForm(formDefinitionId: string): Promise<ProbeFeedbackForm | null>;
  /** Submit (or update) Dex's feedback for one interview event. Resolves with nothing. */
  submit(request: FeedbackSubmitRequest): Promise<void>;
  /** Submit Dex's feedback as general application feedback (no interview event). Resolves with nothing. */
  submitGeneral(request: FeedbackSubmitRequest): Promise<void>;
  /** Dex's cards on the application submitted at or after `since` (frozen), or the unreadable error. */
  listDexFeedback(applicationId: string, query: R1MeetDexFeedbackQuery): Promise<readonly R1MeetDexFeedbackCard[]>;
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
    async submitGeneral(request: FeedbackSubmitRequest): Promise<void> {
      if (typeof request.userId !== 'string' || request.userId.length === 0) {
        throw new AshbyError('invalid_request', { code: 'missing_user_id', operation: SUBMIT_OPERATION });
      }
      // General mode only: a request that names an interview event belongs to `submit`, never here.
      if ('interviewEventId' in request) {
        throw new AshbyError('invalid_request', { code: 'unexpected_interview_event_id', operation: SUBMIT_OPERATION });
      }
      // The four keys only: an `extra` on the request is dropped, never forwarded.
      await client.applicationFeedbackSubmit({
        applicationId: request.applicationId,
        formDefinitionId: request.formDefinitionId,
        feedbackForm: request.feedbackForm,
        userId: request.userId,
      });
    },
    async listDexFeedback(applicationId: string, query: R1MeetDexFeedbackQuery): Promise<readonly R1MeetDexFeedbackCard[]> {
      const checked = checkDexFeedbackQuery(query);
      const createdAfter = checked.sinceMs - LIST_CLOCK_SLACK_MS;
      const cards: R1MeetDexFeedbackCard[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 1; ; page += 1) {
        if (page > R1_MEET_FEEDBACK_LIST_MAX_PAGES) throw feedbackListUnreadable();
        const extra: OpaqueRecord = cursor === undefined
          ? { limit: LIST_PAGE_LIMIT, createdAfter }
          : { limit: LIST_PAGE_LIMIT, createdAfter, cursor };
        const answer = await client.applicationFeedbackList<unknown>(applicationId, extra);
        cards.push(...readDexFeedbackCards(answer.results, checked.dexUserId, checked.sinceMs));
        if (!answer.moreDataAvailable) break;
        const next = answer.nextCursor;
        if (typeof next !== 'string' || next.length === 0 || cursors.has(next)) throw feedbackListUnreadable();
        cursors.add(next);
        cursor = next;
      }
      return Object.freeze(cards);
    },
  });
}

// ── The list reader (M035 S02) ──────────────────────────────────────────────

/**
 * Read ONE `applicationFeedback.list` page (`results`) into Dex's cards at or after `query.since`
 * (see the header): pure, fixed-shape, frozen. Throws `invalid_request` for a query that is not a
 * UUID and a zoned instant, and `malformed_response` / `feedback_list_unreadable` for a page it
 * cannot read in full. Exported for direct tests; the port uses the same reader.
 */
export function r1MeetDexFeedbackCards(results: unknown, query: R1MeetDexFeedbackQuery): readonly R1MeetDexFeedbackCard[] {
  const checked = checkDexFeedbackQuery(query);
  return Object.freeze(readDexFeedbackCards(results, checked.dexUserId, checked.sinceMs));
}

function checkDexFeedbackQuery(query: R1MeetDexFeedbackQuery): { readonly dexUserId: string; readonly sinceMs: number } {
  const dexUserId: unknown = isPlainObject(query) ? query.dexUserId : undefined;
  if (typeof dexUserId !== 'string' || !UUID.test(dexUserId)) {
    throw new AshbyError('invalid_request', { code: 'invalid_dex_user_id', operation: LIST_OPERATION });
  }
  const sinceMs = parseR1MeetInstant(isPlainObject(query) ? query.since : undefined);
  if (sinceMs === null) throw new AshbyError('invalid_request', { code: 'invalid_since', operation: LIST_OPERATION });
  return { dexUserId: dexUserId.toLowerCase(), sinceMs };
}

function readDexFeedbackCards(results: unknown, dexUserId: string, sinceMs: number): R1MeetDexFeedbackCard[] {
  if (!Array.isArray(results)) throw feedbackListUnreadable();
  const cards: R1MeetDexFeedbackCard[] = [];
  for (const entry of results as readonly unknown[]) {
    if (!isPlainObject(entry)) throw feedbackListUnreadable();
    const submittedBy = userIdOf(own(entry, 'submittedByUser'));
    const creditedTo = userIdOf(own(entry, 'creditedToUser'));
    if (submittedBy === null && creditedTo === null) throw feedbackListUnreadable();
    // Another interviewer's card: skipped, nothing else of it is read.
    if (submittedBy !== dexUserId && creditedTo !== dexUserId) continue;
    const submittedMs = parseR1MeetInstant(own(entry, 'submittedAt'));
    if (submittedMs === null) throw feedbackListUnreadable();
    const form = own(entry, 'feedbackFormDefinitionId');
    let formDefinitionId: string | null;
    if (form === undefined || form === null) formDefinitionId = null;
    else if (typeof form === 'string' && UUID.test(form)) formDefinitionId = form.toLowerCase();
    else throw feedbackListUnreadable();
    if (submittedMs < sinceMs) continue;
    cards.push(Object.freeze({ formDefinitionId, submittedAt: new Date(submittedMs).toISOString() }));
  }
  return cards;
}

/** A user reference's id, lower-cased, when it is a plain object whose own `id` is a UUID; else null. */
function userIdOf(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const id = own(value, 'id');
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
}

function feedbackListUnreadable(): AshbyError {
  return new AshbyError('malformed_response', { code: 'feedback_list_unreadable', operation: LIST_OPERATION });
}

/** One named own property (never a key enumeration, never the prototype chain). */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
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
