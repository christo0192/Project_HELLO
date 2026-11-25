/**
 * The database port of Dex's scorecard feedback (M034 S09, dark; D-S09-2, D-S09-4, D-S09-5, D-S09-9).
 *
 * WHAT IT READS AND WRITES. Narrow methods over the service-role client, one query each:
 *   receipt                the feedback receipt by its key (`r1_meet_receipts`, source `ashby`);
 *   settleReceipt          a compare-and-set of that receipt: `processed` from recorded, enqueued or
 *                          failed (a manual re-post after a fix ends a failed one), `failed` from
 *                          recorded or enqueued only (a posted card is never marked failed);
 *   round                  the round's candidate, channel and CURRENT assessment (`interview_rounds`);
 *   assessment             the persisted scorecard columns the card is built from (`assessments`), and
 *                          never `raw`, `evidence_*` or any transcript column;
 *   decisionUseBlocked     the candidate's open appeal (`candidates.decision_use_blocked_at`), the
 *                          same rule as the staff reads; a candidate that cannot be found counts as
 *                          blocked (fail closed: no card for a row this port cannot see);
 *   consentWithdrawn       a withdrawal or decline of the round's consent: a row with `withdrawn_at`
 *                          set AND `proof->>decision` withdrawn or declined. Only that one string of
 *                          `proof` is read. A consent SUPERSEDED by a newer one also has `withdrawn_at`
 *                          but is not a withdrawal (the rule of `lib/r1/recording/erase.ts`, written
 *                          again here so the Meet runtime does not load the recording module);
 *   recordFeedback         ONE `r1_meet_record_receipt` call (0142 §18): the receipt and its
 *                          `r1-meet` job in one transaction, payload EXACTLY
 *                          `{ kind: 'scorecard_feedback', booking_id, assessment_id }` (the RPC adds
 *                          `receipt_id` and `source`);
 *   the re-drive reads     recent completed bookings, their rounds' assessment ids, and the feedback
 *                          receipts that already exist (S09 T4, `maintenance`).
 *
 * THE KEY (D-S09-2): `ashby-schedule:feedback:<booking uuid>:<assessment uuid>`, lower-cased, 97
 * characters. Source `ashby` because Ashby is the counterparty of the write, and the 0142 CHECK ties
 * that source to the `ashby-schedule:` prefix. The second segment is the literal `feedback`, never a
 * UUID, so the key can never collide with an S03 schedule key (`ashby-schedule:<schedule uuid>:...`)
 * nor match S06's newer-delivery read (`like 'ashby-schedule:<uuid>:%'`).
 *
 * FAILURES. Every database failure, rejected call or row that is not what the schema allows throws
 * `R1MeetJobError('r1_meet_db_error')`: the code is the whole message, so no driver text, id or value
 * ever reaches `job_queue` or a log. A missing row is not an error: single reads answer null.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import { ID_BATCH_SIZE, chunkIds } from '../../id-batches.js';
import type { supabase } from '../../supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from './jobs.js';
import {
  R1_MEET_RECEIPT_OUTCOMES,
  createR1MeetReceiptStore,
  type R1MeetReceiptAnswer,
  type R1MeetReceiptOutcome,
} from './receipts.js';

type Db = typeof supabase;

/** The receipt's `event_type` and the job's `kind`. */
export const R1_MEET_FEEDBACK_EVENT_TYPE = 'scorecard_feedback' as const;

/** The literal head of every feedback receipt key. */
export const R1_MEET_FEEDBACK_KEY_PREFIX = 'ashby-schedule:feedback:' as const;

/** At most this many receipt keys in one `in (...)` read (each key is 97 characters, not 36). */
export const R1_MEET_FEEDBACK_KEY_BATCH = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUND_CHANNELS = Object.freeze(['browser', 'meet'] as const);
const WITHDRAWAL_DECISIONS: ReadonlySet<string> = new Set(['withdrawn', 'declined']);

/** Exactly what the assessment read selects: the card's inputs, never `raw`. */
export const R1_MEET_FEEDBACK_ASSESSMENT_COLUMNS =
  'id,session_id,schema_version,recommendation,overall_score,weighted_score_5,score_scale_max,metric_results';

/**
 * The feedback receipt key of one booking and assessment (see the header). Throws
 * `TypeError('r1_meet_feedback_invalid_key')` (a fixed message) when either id is not a UUID.
 */
export function r1MeetFeedbackReceiptKey(bookingId: string, assessmentId: string): string {
  if (typeof bookingId !== 'string' || !UUID.test(bookingId) || typeof assessmentId !== 'string' || !UUID.test(assessmentId)) {
    throw new TypeError('r1_meet_feedback_invalid_key');
  }
  return `${R1_MEET_FEEDBACK_KEY_PREFIX}${bookingId.toLowerCase()}:${assessmentId.toLowerCase()}`;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface R1MeetFeedbackReceipt {
  /** Lower-cased. */
  readonly id: string;
  readonly outcome: R1MeetReceiptOutcome;
}

export type R1MeetFeedbackSettle = 'processed' | 'failed';

export interface R1MeetFeedbackRound {
  readonly id: string;
  readonly candidateId: string;
  readonly channel: (typeof ROUND_CHANNELS)[number];
  /** The round's CURRENT assessment (`r1_attach_assessment`), or null. Lower-cased. */
  readonly assessmentId: string | null;
}

/** The assessment columns the card is built from, as selected (jsonb and numerics untyped). */
export interface R1MeetFeedbackAssessmentRow {
  readonly schema_version: unknown;
  readonly recommendation: unknown;
  readonly overall_score: unknown;
  readonly weighted_score_5: unknown;
  readonly score_scale_max: unknown;
  readonly metric_results: unknown;
}

export interface R1MeetFeedbackAssessment {
  readonly id: string;
  /** Lower-cased, or null. */
  readonly sessionId: string | null;
  readonly row: R1MeetFeedbackAssessmentRow;
}

/** One completed booking the re-drive looks at. */
export interface R1MeetFeedbackBookingRef {
  readonly id: string;
  readonly roundId: string | null;
  readonly sessionId: string | null;
}

export interface R1MeetFeedbackStore {
  /** The feedback receipt with this key, or null. */
  receipt(dedupeKey: string): Promise<R1MeetFeedbackReceipt | null>;
  /** False when the receipt was not in a state this outcome may follow, or is gone. */
  settleReceipt(id: string, outcome: R1MeetFeedbackSettle, nowIso: string): Promise<boolean>;
  round(roundId: string): Promise<R1MeetFeedbackRound | null>;
  assessment(assessmentId: string): Promise<R1MeetFeedbackAssessment | null>;
  decisionUseBlocked(candidateId: string): Promise<boolean>;
  consentWithdrawn(roundId: string): Promise<boolean>;
  /** Record the receipt and queue its job (one RPC); the RPC's answer, refusals included. */
  recordFeedback(bookingId: string, assessmentId: string, nowMs: number): Promise<R1MeetReceiptAnswer>;
  /** Completed bookings whose slot started in `[startAfter, startBefore)`, newest first. */
  listRecentCompleted(query: {
    readonly startAfter: string;
    readonly startBefore: string;
    readonly limit: number;
  }): Promise<readonly R1MeetFeedbackBookingRef[]>;
  /** Round id to its current assessment id, for the rounds that have one. */
  roundAssessmentIds(roundIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The subset of `keys` that already exist as feedback receipts. */
  existingFeedbackKeys(keys: readonly string[]): Promise<ReadonlySet<string>>;
}

// ── Reading rows ────────────────────────────────────────────────────────────

function dbError(): R1MeetJobError {
  return new R1MeetJobError(R1_MEET_DB_ERROR);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Reads one row field by field; anything unexpected throws `r1_meet_db_error`. */
class FieldReader {
  private readonly data: Record<string, unknown>;

  constructor(data: unknown) {
    if (!isPlainObject(data)) throw dbError();
    this.data = data;
  }

  fail(): never {
    throw dbError();
  }

  /** Only null is null: an absent key is drift (the column was selected). */
  orNull<T>(key: string, read: (key: string) => T): T | null {
    return this.data[key] === null ? null : read(key);
  }

  /** A selected column of any value (jsonb or numeric, judged later); absent is drift. */
  present(key: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : this.fail();
  }

  readonly uuid = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : this.fail();
  };

  readonly text = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && value.length > 0 ? value : this.fail();
  };

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    return allowed.find((candidate) => candidate === this.data[key]) ?? this.fail();
  }
}

interface DbAnswer {
  readonly data: unknown;
  readonly error: unknown;
}

/** Run one query; a DB error, a rejected call or a builder that throws is the same one code. */
async function run(query: () => PromiseLike<DbAnswer>): Promise<DbAnswer> {
  let answer: DbAnswer;
  try {
    answer = await query();
  } catch {
    throw dbError();
  }
  if (answer === null || typeof answer !== 'object' || answer.error) throw dbError();
  return answer;
}

function rowsOf(answer: DbAnswer): readonly unknown[] {
  if (!Array.isArray(answer.data)) throw dbError();
  return answer.data as unknown[];
}

function rowOf(answer: DbAnswer): unknown {
  return answer.data === null || answer.data === undefined ? null : answer.data;
}

/** A bounded positive limit; anything else is a caller bug (a fixed message, before any query). */
function limitOf(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ID_BATCH_SIZE) throw new RangeError('r1_meet_feedback_invalid_limit');
  return limit;
}

// ── The store ───────────────────────────────────────────────────────────────

/** The feedback store over the service-role client (production) or a test double. */
export function createR1MeetFeedbackStore(client: Db): R1MeetFeedbackStore {
  const receipts = createR1MeetReceiptStore(client as never);

  return Object.freeze({
    async receipt(dedupeKey: string) {
      const row = rowOf(
        await run(() =>
          client
            .from('r1_meet_receipts')
            .select('id,outcome')
            .eq('source', 'ashby')
            .eq('dedupe_key', dedupeKey)
            .maybeSingle(),
        ),
      );
      if (row === null) return null;
      const read = new FieldReader(row);
      return Object.freeze({ id: read.uuid('id'), outcome: read.oneOf('outcome', R1_MEET_RECEIPT_OUTCOMES) });
    },

    async settleReceipt(id: string, outcome: R1MeetFeedbackSettle, nowIso: string) {
      if (outcome !== 'processed' && outcome !== 'failed') throw new RangeError('r1_meet_feedback_invalid_outcome');
      // A posted card is never marked failed; a failed one is re-postable (D-S09-11).
      // Each branch filters on its own fixed list (scale-guard: no `.in` over a variable).
      const updated = rowsOf(
        await run(() => {
          const update = client
            .from('r1_meet_receipts')
            .update({ outcome, processed_at: nowIso })
            .eq('id', id)
            .eq('source', 'ashby');
          const guarded =
            outcome === 'processed'
              ? update.in('outcome', ['recorded', 'enqueued', 'failed'])
              : update.in('outcome', ['recorded', 'enqueued']);
          return guarded.select('id');
        }),
      );
      return updated.length > 0;
    },

    async round(roundId: string) {
      const row = rowOf(
        await run(() =>
          client.from('interview_rounds').select('id,candidate_id,channel,assessment_id').eq('id', roundId).maybeSingle(),
        ),
      );
      if (row === null) return null;
      const read = new FieldReader(row);
      return Object.freeze({
        id: read.uuid('id'),
        candidateId: read.uuid('candidate_id'),
        channel: read.oneOf('channel', ROUND_CHANNELS),
        assessmentId: read.orNull('assessment_id', read.uuid),
      });
    },

    async assessment(assessmentId: string) {
      const row = rowOf(
        await run(() =>
          client.from('assessments').select(R1_MEET_FEEDBACK_ASSESSMENT_COLUMNS).eq('id', assessmentId).maybeSingle(),
        ),
      );
      if (row === null) return null;
      const read = new FieldReader(row);
      return Object.freeze({
        id: read.uuid('id'),
        sessionId: read.orNull('session_id', read.uuid),
        // Exactly the selected card inputs: nothing else of the row is carried on.
        row: Object.freeze({
          schema_version: read.present('schema_version'),
          recommendation: read.present('recommendation'),
          overall_score: read.present('overall_score'),
          weighted_score_5: read.present('weighted_score_5'),
          score_scale_max: read.present('score_scale_max'),
          metric_results: read.present('metric_results'),
        }),
      });
    },

    async decisionUseBlocked(candidateId: string) {
      const row = rowOf(
        await run(() =>
          client.from('candidates').select('id,decision_use_blocked_at').eq('id', candidateId).maybeSingle(),
        ),
      );
      if (row === null) return true;
      const read = new FieldReader(row);
      return read.present('decision_use_blocked_at') !== null;
    },

    async consentWithdrawn(roundId: string) {
      const rows = rowsOf(
        await run(() =>
          client
            .from('interview_round_consents')
            .select('withdrawn_at,decision:proof->>decision')
            .eq('round_id', roundId)
            .not('withdrawn_at', 'is', null),
        ),
      );
      return rows.some((row) => {
        const read = new FieldReader(row);
        const decision = read.present('decision');
        return typeof decision === 'string' && WITHDRAWAL_DECISIONS.has(decision);
      });
    },

    async recordFeedback(bookingId: string, assessmentId: string, nowMs: number) {
      const dedupeKey = r1MeetFeedbackReceiptKey(bookingId, assessmentId);
      const booking = bookingId.toLowerCase();
      const assessment = assessmentId.toLowerCase();
      try {
        return await receipts.record({
          source: 'ashby',
          dedupeKey,
          eventType: R1_MEET_FEEDBACK_EVENT_TYPE,
          bookingId: booking,
          payload: { kind: R1_MEET_FEEDBACK_EVENT_TYPE, booking_id: booking, assessment_id: assessment },
          nowMs,
        });
      } catch {
        throw dbError();
      }
    },

    async listRecentCompleted(query: { readonly startAfter: string; readonly startBefore: string; readonly limit: number }) {
      const limit = limitOf(query.limit);
      return Object.freeze(
        rowsOf(
          await run(() =>
            client
              .from('r1_meet_bookings')
              .select('id,round_id,session_id')
              .eq('status', 'completed')
              .gte('start_at', query.startAfter)
              .lt('start_at', query.startBefore)
              .order('start_at', { ascending: false })
              .limit(limit),
          ),
        ).map((row) => {
          const read = new FieldReader(row);
          return Object.freeze({
            id: read.uuid('id'),
            roundId: read.orNull('round_id', read.uuid),
            sessionId: read.orNull('session_id', read.uuid),
          });
        }),
      );
    },

    async roundAssessmentIds(roundIds: readonly string[]) {
      const out = new Map<string, string>();
      for (const chunk of chunkIds([...new Set(roundIds)], ID_BATCH_SIZE)) {
        const rows = rowsOf(
          await run(() => client.from('interview_rounds').select('id,assessment_id').in('id', chunk)),
        );
        for (const row of rows) {
          const read = new FieldReader(row);
          const assessmentId = read.orNull('assessment_id', read.uuid);
          if (assessmentId !== null) out.set(read.uuid('id'), assessmentId);
        }
      }
      return out;
    },

    async existingFeedbackKeys(keys: readonly string[]) {
      const out = new Set<string>();
      for (const chunk of chunkIds([...new Set(keys)], R1_MEET_FEEDBACK_KEY_BATCH)) {
        const rows = rowsOf(
          await run(() =>
            client.from('r1_meet_receipts').select('dedupe_key').eq('source', 'ashby').in('dedupe_key', chunk),
          ),
        );
        for (const row of rows) out.add(new FieldReader(row).text('dedupe_key'));
      }
      return out;
    },
  });
}
