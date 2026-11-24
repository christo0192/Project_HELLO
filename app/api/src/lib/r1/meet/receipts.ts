/**
 * lib/r1/meet/receipts.ts — the r1-meet receipt port (M034 S03, dark).
 *
 * Every accepted Meet webhook delivery (a Recall Svix delivery, or one Ashby interview-schedule job)
 * becomes ONE call of the service-role RPC `screening_v2.r1_meet_record_receipt` (migration 0142
 * §18). In one transaction the RPC inserts the de-duplicated receipt row and, because the port
 * always sends `p_enqueue: true`, the matching `r1-meet` job (the 0030 transactional outbox; a
 * duplicate delivery re-drives a missing job and never doubles a live one). So a receipt never
 * exists without its work, and the receivers make exactly one DB round trip per job (critic C8).
 *
 * What is sent (and nothing else): `p_source`, `p_dedupe_key`, `p_event_type`, `p_booking_id`,
 * `p_enqueue: true`, `p_payload`, `p_now` (the ISO instant of the receiver's clock, the same instant
 * as an Ashby payload's `received_at`). `p_scheduled_at` is NEVER sent: receivers enqueue for now;
 * only the worker (S06) delays its own re-runs.
 *
 * Payload rules (contract §2, data-classification "Job payloads"): a `kind` plus ids, kinds and
 * times only (an `ashby_schedule` job may also carry the canonical Meet URL). Never a body, a name,
 * an email or a display name. The RPC refuses a payload without a valid `kind` or over 4096 bytes;
 * the builders (`recall-event.ts`, `ashby-schedule-jobs.ts`) stay far below that.
 *
 * Answers: `inserted` / `duplicate` with the receipt id, its outcome and the outbox flags; one of
 * the seven closed refusals (`R1_MEET_RECEIPT_REFUSALS`) as `{ status: 'refused', reason }`; an RPC
 * error, a rejected call or any other answer THROWS a fixed message (the route answers a retryable
 * 500). No input, key, payload or driver error text is ever echoed in a thrown message.
 *
 * Why the client is an argument: this module does NOT import `lib/supabase` (which reads the
 * environment at load). The routes pass the service-role client lazily, like
 * `routes/ashby-webhook.ts`, so loading every Meet module (the r1-meet-dark pin) stays free of
 * environment and network, and tests pass an in-memory port instead.
 */

/** The 0142 service-role RPC the port calls. */
export const R1_MEET_RECORD_RECEIPT_RPC = 'r1_meet_record_receipt' as const;

/**
 * The closed refusals of `r1_meet_record_receipt` (0142 §18), in the order the RPC checks them. The
 * port never sends `p_scheduled_at`, so `invalid_scheduled_at` cannot happen; it is listed because a
 * drift pin compares this list with the migration. Frozen.
 */
export const R1_MEET_RECEIPT_REFUSALS = Object.freeze([
  'invalid_source',
  'invalid_dedupe_key',
  'invalid_event_type',
  'invalid_request',
  'invalid_payload',
  'payload_too_large',
  'invalid_scheduled_at',
] as const);

export type R1MeetReceiptRefusal = (typeof R1_MEET_RECEIPT_REFUSALS)[number];

/** The receipt sources the 0142 `chk_r1_meet_receipts_source` CHECK accepts. Frozen. */
export const R1_MEET_RECEIPT_SOURCES = Object.freeze(['recall', 'ashby'] as const);

export type R1MeetReceiptSource = (typeof R1_MEET_RECEIPT_SOURCES)[number];

/** The receipt outcomes the 0142 `chk_r1_meet_receipts_outcome` CHECK accepts. Frozen. */
export const R1_MEET_RECEIPT_OUTCOMES = Object.freeze([
  'recorded',
  'enqueued',
  'processed',
  'ignored',
  'failed',
] as const);

export type R1MeetReceiptOutcome = (typeof R1_MEET_RECEIPT_OUTCOMES)[number];

/** One receipt (and its `r1-meet` job) to record. */
export interface R1MeetReceiptRequest {
  readonly source: R1MeetReceiptSource;
  /** The Svix `webhook-id` (Recall) or the S03 Ashby schedule key (`ashby-schedule:...`). */
  readonly dedupeKey: string;
  /** The Recall event name or the Ashby action. */
  readonly eventType: string;
  /** Our booking row id (a UUID), or null. An unknown id is stored as null by the RPC. */
  readonly bookingId: string | null;
  /** The job payload: `kind` plus ids and times only. */
  readonly payload: { readonly kind: string } & Readonly<Record<string, unknown>>;
  /** The receiver's clock, epoch ms. */
  readonly nowMs: number;
}

/** What the RPC answered, parsed. */
export type R1MeetReceiptAnswer =
  | {
      readonly status: 'inserted' | 'duplicate';
      /** The receipt row id. */
      readonly id: string;
      /** The receipt's outcome after this call; null if the RPC ever answers an unknown value. */
      readonly outcome: R1MeetReceiptOutcome | null;
      /** This call inserted the `r1-meet` job. */
      readonly enqueued: boolean;
      /** Durable work exists for the receipt (a live job, or a terminal outcome). */
      readonly workPending: boolean;
      /** The receipt row is linked to an existing booking. */
      readonly bookingLinked: boolean;
    }
  | { readonly status: 'refused'; readonly reason: R1MeetReceiptRefusal };

/** The port the receivers depend on. */
export interface R1MeetReceiptPort {
  record(request: R1MeetReceiptRequest): Promise<R1MeetReceiptAnswer>;
}

/** The slice of the Supabase client the store needs (the service-role client in production). */
export interface R1MeetRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

const RPC_ERROR = 'r1_meet_receipt_rpc_error';
const UNEXPECTED_ANSWER = 'r1_meet_receipt_unexpected_answer';
const INVALID_NOW = 'r1_meet_receipt_invalid_now';

/** Largest epoch ms a `Date` can hold. */
const MAX_EPOCH_MS = 8.64e15;

const REFUSALS: ReadonlySet<string> = new Set(R1_MEET_RECEIPT_REFUSALS);
const OUTCOMES: ReadonlySet<string> = new Set(R1_MEET_RECEIPT_OUTCOMES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Parse the jsonb answer of `r1_meet_record_receipt`. Throws `Error('r1_meet_receipt_unexpected_answer')`
 * for anything that is not an `inserted` / `duplicate` answer with a non-empty string `id` or one of
 * the seven refusals. The result is frozen.
 */
export function parseR1MeetReceiptAnswer(data: unknown): R1MeetReceiptAnswer {
  let answer: R1MeetReceiptAnswer | null = null;
  try {
    if (isPlainObject(data)) {
      const status = data.status;
      const id = data.id;
      if ((status === 'inserted' || status === 'duplicate') && typeof id === 'string' && id.length > 0) {
        const outcome = data.outcome;
        answer = {
          status,
          id,
          outcome: typeof outcome === 'string' && OUTCOMES.has(outcome) ? (outcome as R1MeetReceiptOutcome) : null,
          enqueued: data.enqueued === true,
          workPending: data.work_pending === true,
          bookingLinked: data.booking_linked === true,
        };
      } else if (typeof status === 'string' && REFUSALS.has(status)) {
        answer = { status: 'refused', reason: status as R1MeetReceiptRefusal };
      }
    }
  } catch {
    answer = null;
  }
  if (answer === null) throw new Error(UNEXPECTED_ANSWER);
  return Object.freeze(answer);
}

/**
 * The production receipt store: one `r1_meet_record_receipt` call per request. A `nowMs` that is not
 * a finite epoch ms a `Date` can hold rejects with `TypeError('r1_meet_receipt_invalid_now')` before
 * any call.
 */
export function createR1MeetReceiptStore(client: R1MeetRpcClient): R1MeetReceiptPort {
  return {
    async record(request: R1MeetReceiptRequest): Promise<R1MeetReceiptAnswer> {
      const nowMs = request.nowMs;
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_EPOCH_MS) {
        throw new TypeError(INVALID_NOW);
      }
      const args: Record<string, unknown> = {
        p_source: request.source,
        p_dedupe_key: request.dedupeKey,
        p_event_type: request.eventType,
        p_booking_id: request.bookingId ?? null,
        p_enqueue: true,
        p_payload: request.payload,
        p_now: new Date(nowMs).toISOString(),
      };
      let result: { data: unknown; error: unknown };
      try {
        result = await client.rpc(R1_MEET_RECORD_RECEIPT_RPC, args);
      } catch {
        throw new Error(RPC_ERROR);
      }
      if (typeof result !== 'object' || result === null) throw new Error(UNEXPECTED_ANSWER);
      if (result.error !== null && result.error !== undefined && result.error !== false) throw new Error(RPC_ERROR);
      return parseR1MeetReceiptAnswer(result.data);
    },
  };
}
