/**
 * An in-memory `R1MeetReceiptPort` for tests (M034 S03 plan T1), reused by S06.
 *
 * It behaves like `createR1MeetReceiptStore` over the 0142 §18 RPC `r1_meet_record_receipt` with
 * `p_enqueue = true` (the only form the port sends):
 * - A `nowMs` that is not a finite epoch ms rejects with `TypeError('r1_meet_receipt_invalid_now')`
 *   (the store's own guard, before any RPC).
 * - The closed refusals, first one wins, with no state change: `invalid_source` (not `recall` /
 *   `ashby`); `invalid_dedupe_key` (not 1..256 characters of `[A-Za-z0-9_.:-]`, or the
 *   `ashby-schedule:` prefix without source `ashby`, or source `ashby` without it);
 *   `invalid_event_type` (not `^[A-Za-z0-9_.:-]{1,128}$`); `invalid_payload` (not an object whose
 *   `kind` matches `^[a-z][a-z0-9_]{0,39}$`); `payload_too_large` (the jsonb text of the payload
 *   over 4096 bytes: see `jsonbTextByteLength`).
 * - A booking id that is not a UUID makes the RPC fail before any refusal (Postgres cannot cast it
 *   to `uuid`), so the port rejects with `Error('r1_meet_receipt_rpc_error')`. An unknown UUID is stored as null
 *   (`bookingLinked: false`); pass `knownBookingIds` to link.
 * - Insert-or-duplicate on the dedupe key. The first delivery's source, event type and booking link
 *   stay. The receipt is `enqueued` and ONE live job is inserted with payload
 *   `{ ...payload, receipt_id, source }` (the RPC's `p_payload || jsonb_build_object(...)`).
 * - Re-drive: a duplicate inserts a missing job (after `dropJob`) with THIS delivery's payload, while
 *   the receipt is still `enqueued`; with a live job it answers `enqueued: false, workPending: true`;
 *   after `settle` (a terminal outcome) it answers `workPending: true` and inserts nothing.
 *
 * Knobs (served in the order they were queued, one per `record` call):
 * - `throwNext(n)`: the next n calls reject with `Error('r1_meet_receipt_rpc_error')` and change
 *   nothing (the RPC failed before committing);
 * - `loseAnswerNext(n)`: the next n calls commit normally and THEN reject the same way (the answer
 *   was lost after the commit; a redelivery is a duplicate);
 * - `answerNext(answer)`: the next call answers `answer` verbatim and changes nothing.
 * - `settle(receiptId, outcome)`: the worker reached a terminal outcome; the live job is gone.
 * - `dropJob(receiptId)`: the live job vanished (pruned or lost) while the receipt stays `enqueued`.
 *
 * `calls` records EVERY `record` request, in order, including refused and thrown ones. `jobs()`
 * lists the live jobs as `{ dedupeKey, payload }` (the receipt's dedupe key, not the job's), in the
 * order they were inserted. `receipts()` lists the receipt rows.
 *
 * Never shipped: `tsconfig.build.json` excludes `src/__tests__`.
 */
import type {
  R1MeetReceiptAnswer,
  R1MeetReceiptOutcome,
  R1MeetReceiptPort,
  R1MeetReceiptRequest,
  R1MeetReceiptSource,
} from '../../lib/r1/meet/receipts.js';

/** The RPC's payload cap, in bytes of the jsonb text. */
export const R1_MEET_FAKE_PAYLOAD_MAX_BYTES = 4096;

export interface R1MeetFakeReceipt {
  readonly id: string;
  readonly source: R1MeetReceiptSource;
  readonly dedupeKey: string;
  readonly eventType: string;
  readonly bookingId: string | null;
  readonly outcome: R1MeetReceiptOutcome;
}

export interface R1MeetFakeJob {
  /** The receipt's dedupe key. */
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown> & { readonly receipt_id: string; readonly source: R1MeetReceiptSource };
}

export interface R1MeetReceiptsFake extends R1MeetReceiptPort {
  readonly calls: readonly R1MeetReceiptRequest[];
  jobs(): R1MeetFakeJob[];
  receipts(): R1MeetFakeReceipt[];
  throwNext(count?: number): void;
  loseAnswerNext(count?: number): void;
  answerNext(answer: R1MeetReceiptAnswer): void;
  settle(receiptId: string, outcome: 'processed' | 'ignored' | 'failed'): void;
  dropJob(receiptId: string): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEDUPE_KEY_RE = /^[A-Za-z0-9_.:-]+$/;
const EVENT_TYPE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ASHBY_PREFIX = 'ashby-schedule:';
const MAX_EPOCH_MS = 8.64e15;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Postgres jsonb text form of a parsed JSON value: `{"a": 1, "b": [1, 2]}` (spaces after `:` and `,`). */
function jsonbText(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}: ${jsonbText(child)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The byte length of `octet_length(p_payload::text)` as the RPC measures it: the payload goes over
 * the wire as JSON and Postgres prints jsonb with a space after every `:` and `,`. Exact for the
 * strings, booleans, nulls and small integers the job builders produce.
 */
export function jsonbTextByteLength(payload: unknown): number {
  const parsed = JSON.parse(JSON.stringify(payload) ?? 'null') as unknown;
  return Buffer.byteLength(jsonbText(parsed), 'utf8');
}

type Scripted = { kind: 'throw' } | { kind: 'lose' } | { kind: 'answer'; answer: R1MeetReceiptAnswer };

interface ReceiptRow {
  id: string;
  source: R1MeetReceiptSource;
  dedupeKey: string;
  eventType: string;
  bookingId: string | null;
  outcome: R1MeetReceiptOutcome;
}

export function createR1MeetReceiptsFake(options: { knownBookingIds?: readonly string[] } = {}): R1MeetReceiptsFake {
  const knownBookings = new Set((options.knownBookingIds ?? []).map((id) => id.toLowerCase()));
  const calls: R1MeetReceiptRequest[] = [];
  const receiptsByKey = new Map<string, ReceiptRow>();
  const liveJobs = new Map<string, R1MeetFakeJob>();
  const script: Scripted[] = [];
  let sequence = 0;

  const refused = (reason: Extract<R1MeetReceiptAnswer, { status: 'refused' }>['reason']): R1MeetReceiptAnswer =>
    Object.freeze({ status: 'refused' as const, reason });

  function refusalFor(request: R1MeetReceiptRequest): R1MeetReceiptAnswer | null {
    const { source, dedupeKey, eventType, payload } = request as {
      source: unknown;
      dedupeKey: unknown;
      eventType: unknown;
      payload: unknown;
    };
    if (source !== 'recall' && source !== 'ashby') return refused('invalid_source');
    if (
      typeof dedupeKey !== 'string'
      || dedupeKey.length < 1
      || dedupeKey.length > 256
      || !DEDUPE_KEY_RE.test(dedupeKey)
      || (source === 'ashby') !== dedupeKey.startsWith(ASHBY_PREFIX)
    ) {
      return refused('invalid_dedupe_key');
    }
    if (typeof eventType !== 'string' || !EVENT_TYPE_RE.test(eventType)) return refused('invalid_event_type');
    const wire = JSON.parse(JSON.stringify(payload) ?? 'null') as unknown;
    if (!isPlainObject(wire) || typeof wire.kind !== 'string' || !KIND_RE.test(wire.kind)) {
      return refused('invalid_payload');
    }
    if (jsonbTextByteLength(wire) > R1_MEET_FAKE_PAYLOAD_MAX_BYTES) return refused('payload_too_large');
    return null;
  }

  function commit(request: R1MeetReceiptRequest): R1MeetReceiptAnswer {
    // PostgREST casts the arguments before the function body runs, so a non-UUID booking id fails
    // the call ahead of every refusal.
    const bookingId = request.bookingId ?? null;
    if (bookingId !== null && (typeof bookingId !== 'string' || !UUID_RE.test(bookingId))) {
      throw new Error('r1_meet_receipt_rpc_error');
    }
    const refusal = refusalFor(request);
    if (refusal !== null) return refusal;
    const linkedBooking = bookingId !== null && knownBookings.has(bookingId.toLowerCase()) ? bookingId.toLowerCase() : null;

    let row = receiptsByKey.get(request.dedupeKey);
    const created = row === undefined;
    if (row === undefined) {
      sequence += 1;
      row = {
        id: `5e000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        source: request.source,
        dedupeKey: request.dedupeKey,
        eventType: request.eventType,
        bookingId: linkedBooking,
        outcome: 'enqueued',
      };
      receiptsByKey.set(request.dedupeKey, row);
    } else if (row.outcome === 'recorded') {
      row.outcome = 'enqueued';
    }

    let enqueued = false;
    if (row.outcome === 'enqueued' && !liveJobs.has(row.id)) {
      const wire = JSON.parse(JSON.stringify(request.payload)) as Record<string, unknown>;
      liveJobs.set(row.id, {
        dedupeKey: row.dedupeKey,
        payload: { ...wire, receipt_id: row.id, source: request.source },
      });
      enqueued = true;
    }
    return Object.freeze({
      status: created ? ('inserted' as const) : ('duplicate' as const),
      id: row.id,
      outcome: row.outcome,
      enqueued,
      workPending: true,
      bookingLinked: row.bookingId !== null,
    });
  }

  function rowById(receiptId: string): ReceiptRow {
    for (const row of receiptsByKey.values()) if (row.id === receiptId) return row;
    throw new Error(`r1-meet-receipts-fake: unknown receipt ${receiptId}`);
  }

  return {
    calls,
    async record(request: R1MeetReceiptRequest): Promise<R1MeetReceiptAnswer> {
      calls.push(request);
      const nowMs = request.nowMs;
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_EPOCH_MS) {
        throw new TypeError('r1_meet_receipt_invalid_now');
      }
      const next = script.shift();
      if (next?.kind === 'throw') throw new Error('r1_meet_receipt_rpc_error');
      if (next?.kind === 'answer') return next.answer;
      const answer = commit(request);
      if (next?.kind === 'lose') throw new Error('r1_meet_receipt_rpc_error');
      return answer;
    },
    jobs: () => [...liveJobs.values()].map((job) => ({ dedupeKey: job.dedupeKey, payload: { ...job.payload } })),
    receipts: () => [...receiptsByKey.values()].map((row) => ({ ...row })),
    throwNext(count = 1) {
      for (let i = 0; i < count; i += 1) script.push({ kind: 'throw' });
    },
    loseAnswerNext(count = 1) {
      for (let i = 0; i < count; i += 1) script.push({ kind: 'lose' });
    },
    answerNext(answer) {
      script.push({ kind: 'answer', answer });
    },
    settle(receiptId, outcome) {
      rowById(receiptId).outcome = outcome;
      liveJobs.delete(receiptId);
    },
    dropJob(receiptId) {
      rowById(receiptId);
      liveJobs.delete(receiptId);
    },
  };
}
