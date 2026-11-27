/**
 * The database side of the "Dex R1: Booked" tag lane (M035 S11, dark; D-S11-2, D-S11-3, D-S11-4).
 *
 * WHAT IT READS. Four narrow reads over the service-role client, one query each, and no write:
 *   booking               one booking by id (`r1_meet_bookings`), the columns
 *                         `R1_MEET_BOOKED_TAG_BOOKING_COLUMNS` and nothing else (the `reason` tells a
 *                         failure that could not have been an interview, PR #453 review S11-R1);
 *   applicationLink       the Ashby candidate id of one Ashby application (`ashby_application_links`,
 *                         provider `ashby`, `external_application_id` matched verbatim; unique by
 *                         `uq_ashby_application_links_app`, 0029);
 *   candidateApplications every application linked to one Ashby candidate (`external_candidate_id`
 *                         matched case-insensitively, as 0143's person-wide rules match it with
 *                         `lower(...) = lower(...)`, PR #453 review S11-R4; any lifecycle or terminal
 *                         state), at most
 *                         `R1_MEET_BOOKED_TAG_MAX_APPLICATIONS`: one more row than that answers
 *                         `overflow` and no ids, so the job never decides from a partial list;
 *   newestPublicBooking   the newest public booking (`source = 'public_page'`) of one application,
 *                         by `created_at` and then `id`, both descending.
 * The tag is candidate-wide, so the job asks these four to compute whether ANY application of the
 * person still wants it (the converge rule, D-S11-2); the store itself decides nothing.
 *
 * WHAT IT NEVER READS. Our candidate id, the Meet URL, the ticket digest, or any calendar, manage,
 * request or move column of a booking; of a link only its two Ashby ids. Nothing here can carry a
 * name, an email or a joining link into the job.
 *
 * WHY NOT THE RUNTIME STORE (D-S11-3). `runtime-store.ts` parses a whole Ashby-scheduled booking: it
 * has no `source` and refuses the NULL Ashby schedule ids a public row carries. This store reads
 * `source` only when an `ashby_booked_tag` job exists, and only migration 0143 queues one, so it
 * works in either merge order with the slice that teaches the runtime store about public rows.
 *
 * IDS. A booking id answers lower-cased; Ashby ids (application, candidate) are Ashby's own
 * spelling, kept verbatim, because the links match them exactly (the one exception: the person-wide
 * read above ignores the case of the candidate id, like 0143). Every instant answers as
 * `toISOString()`; a zoneless or unparseable one is drift.
 *
 * FAILURES. A DB error, a rejected call, a builder that throws, or a row the schema does not allow
 * (an unknown source or status, a bad instant, an empty or over-long Ashby id, a selected column
 * absent, a row that does not match what was asked) throws `R1MeetJobError('r1_meet_db_error')`:
 * the code is the whole message, so no driver text, id or value reaches `job_queue` or a log. A
 * missing row is not an error: single reads answer null.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import type { supabase } from '../../supabase.js';
import { R1_MEET_BOOKING_REASONS, R1_MEET_BOOKING_STATUSES, type R1MeetBookingReason, type R1MeetBookingStatus } from './bookings-read.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from './jobs.js';
import { parseR1MeetInstant } from './ticket.js';

type Db = typeof supabase;

/** Exactly what the booking reads select (D-S11-3). */
export const R1_MEET_BOOKED_TAG_BOOKING_COLUMNS =
  'id, source, status, reason, ashby_application_id, start_at, updated_at, created_at';

/** At most this many applications of one Ashby candidate are weighed; one more is an overflow. */
export const R1_MEET_BOOKED_TAG_MAX_APPLICATIONS = 25;

/**
 * The booking sources of 0143's `chk_r1_meet_bookings_source`. Private on purpose: the slice that
 * adds a shared list of them to `bookings-read.ts` may switch this module to it.
 */
const SOURCES = Object.freeze(['ashby', 'public_page'] as const);
const PUBLIC_SOURCE = 'public_page';

/** The two reasons 0143 appends to 0142's 32 in `chk_r1_meet_bookings_reason`. */
const PUBLIC_REASONS = Object.freeze(['candidate_cancelled', 'invite_undeliverable'] as const);

/**
 * The booking reasons of 0143's `chk_r1_meet_bookings_reason`: 0142's 32 (`R1_MEET_BOOKING_REASONS`),
 * then the two 0143 appends, each once. A set union on purpose, so it stays the same 34 when S02
 * appends the two to `R1_MEET_BOOKING_REASONS` (either merge order). Frozen.
 */
export const R1_MEET_BOOKED_TAG_REASONS: readonly R1MeetBookedTagReason[] = Object.freeze([
  ...new Set<R1MeetBookedTagReason>([...R1_MEET_BOOKING_REASONS, ...PUBLIC_REASONS]),
]);

/** The two columns of a link the lane reads. */
const LINK_COLUMNS = 'external_application_id, external_candidate_id';
const LINK_PROVIDER = 'ashby';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The length bound of every Ashby id column (0029's link CHECKs). */
const ASHBY_ID_MAX_LENGTH = 256;
/**
 * An Ashby id with no LIKE wildcard or escape character in it (Ashby ids are UUIDs), so `ilike` on it
 * is exactly `lower(column) = lower(id)`. Any other id is matched verbatim.
 */
const CASELESS_SAFE_ID = /^[0-9A-Za-z-]{1,256}$/;

// ── Shapes ──────────────────────────────────────────────────────────────────

export type R1MeetBookedTagSource = (typeof SOURCES)[number];
export type R1MeetBookedTagReason = R1MeetBookingReason | (typeof PUBLIC_REASONS)[number];

export interface R1MeetBookedTagBooking {
  /** Lower-cased. */
  readonly id: string;
  readonly source: R1MeetBookedTagSource;
  readonly status: R1MeetBookingStatus;
  /** One of `R1_MEET_BOOKED_TAG_REASONS` (0143's reason CHECK). */
  readonly reason: R1MeetBookedTagReason;
  /** Verbatim (1..256 characters). */
  readonly applicationId: string;
  /** `toISOString()`. */
  readonly startAt: string;
  /** `toISOString()`. */
  readonly updatedAt: string;
  /** `toISOString()`. */
  readonly createdAt: string;
}

export interface R1MeetBookedTagLink {
  /** Verbatim, or null when the link was never bound to an Ashby candidate. */
  readonly externalCandidateId: string | null;
}

export interface R1MeetBookedTagApplications {
  /** Verbatim, unique, in the read's order (ascending). Empty on an overflow. */
  readonly applicationIds: readonly string[];
  /** True when the candidate has more than `R1_MEET_BOOKED_TAG_MAX_APPLICATIONS` links. */
  readonly overflow: boolean;
}

export interface R1MeetBookedTagStore {
  /** One booking by id, or null. */
  booking(id: string): Promise<R1MeetBookedTagBooking | null>;
  /** The link of one Ashby application, or null when there is none. */
  applicationLink(applicationId: string): Promise<R1MeetBookedTagLink | null>;
  /** Every application linked to one Ashby candidate, its id in any case (bounded; see the header). */
  candidateApplications(externalCandidateId: string): Promise<R1MeetBookedTagApplications>;
  /** The newest public booking of one Ashby application, or null. */
  newestPublicBooking(applicationId: string): Promise<R1MeetBookedTagBooking | null>;
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

  readonly uuid = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : this.fail();
  };

  /** An Ashby id, verbatim: a string of 1..256 characters. */
  readonly ashbyId = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && value.length > 0 && value.length <= ASHBY_ID_MAX_LENGTH ? value : this.fail();
  };

  readonly instant = (key: string): string => {
    const ms = parseR1MeetInstant(this.data[key]);
    return ms === null ? this.fail() : new Date(ms).toISOString();
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

function parseBooking(row: unknown): R1MeetBookedTagBooking {
  const read = new FieldReader(row);
  return Object.freeze({
    id: read.uuid('id'),
    source: read.oneOf('source', SOURCES),
    status: read.oneOf('status', R1_MEET_BOOKING_STATUSES),
    reason: read.oneOf('reason', R1_MEET_BOOKED_TAG_REASONS),
    applicationId: read.ashbyId('ashby_application_id'),
    startAt: read.instant('start_at'),
    updatedAt: read.instant('updated_at'),
    createdAt: read.instant('created_at'),
  });
}

// ── The store ───────────────────────────────────────────────────────────────

/** The booked-tag store over the service-role client (production) or a test double. */
export function createR1MeetBookedTagStore(client: Db): R1MeetBookedTagStore {
  return Object.freeze({
    async booking(id: string) {
      const row = rowOf(
        await run(() => client.from('r1_meet_bookings').select(R1_MEET_BOOKED_TAG_BOOKING_COLUMNS).eq('id', id).maybeSingle()),
      );
      if (row === null) return null;
      const booking = parseBooking(row);
      // The row answers the id that was asked for, or it is not this booking.
      if (booking.id !== id.toLowerCase()) throw dbError();
      return booking;
    },

    async applicationLink(applicationId: string) {
      const row = rowOf(
        await run(() =>
          client
            .from('ashby_application_links')
            .select(LINK_COLUMNS)
            .eq('provider', LINK_PROVIDER)
            .eq('external_application_id', applicationId)
            .maybeSingle(),
        ),
      );
      if (row === null) return null;
      const read = new FieldReader(row);
      if (read.ashbyId('external_application_id') !== applicationId) read.fail();
      return Object.freeze({ externalCandidateId: read.orNull('external_candidate_id', read.ashbyId) });
    },

    async candidateApplications(externalCandidateId: string) {
      // 0143 matches the person with lower() on both sides; `ilike` on an id with no wildcard is that.
      const caseless = CASELESS_SAFE_ID.test(externalCandidateId);
      const rows = rowsOf(
        await run(() => {
          const query = client.from('ashby_application_links').select(LINK_COLUMNS).eq('provider', LINK_PROVIDER);
          return (caseless
            ? query.ilike('external_candidate_id', externalCandidateId)
            : query.eq('external_candidate_id', externalCandidateId))
            .order('external_application_id', { ascending: true })
            .limit(R1_MEET_BOOKED_TAG_MAX_APPLICATIONS + 1);
        }),
      );
      const asked = externalCandidateId.toLowerCase();
      const ids = rows.map((row) => {
        const read = new FieldReader(row);
        // Every row answers the candidate that was asked for (in any case), or it is drift.
        if (read.ashbyId('external_candidate_id').toLowerCase() !== asked) read.fail();
        return read.ashbyId('external_application_id');
      });
      if (ids.length > R1_MEET_BOOKED_TAG_MAX_APPLICATIONS) {
        return Object.freeze({ applicationIds: Object.freeze([] as string[]), overflow: true });
      }
      return Object.freeze({ applicationIds: Object.freeze([...new Set(ids)]), overflow: false });
    },

    async newestPublicBooking(applicationId: string) {
      const rows = rowsOf(
        await run(() =>
          client
            .from('r1_meet_bookings')
            .select(R1_MEET_BOOKED_TAG_BOOKING_COLUMNS)
            .eq('source', PUBLIC_SOURCE)
            .eq('ashby_application_id', applicationId)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(1),
        ),
      );
      if (rows.length === 0) return null;
      if (rows.length > 1) throw dbError();
      const booking = parseBooking(rows[0]);
      // The filters were source and application: a row of another source or application is drift.
      if (booking.source !== PUBLIC_SOURCE || booking.applicationId !== applicationId) throw dbError();
      return booking;
    },
  });
}
