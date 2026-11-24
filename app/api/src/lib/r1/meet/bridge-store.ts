/**
 * The booking reads and writes of the Meet bridge exchange (M034 S05, dark).
 *
 * Three narrow calls on `screening_v2.r1_meet_bookings` (migration 0142), each answering a closed,
 * parsed result so the route never interprets raw rows or jsonb:
 *
 *  - `peekR1MeetTicket`: a READ-ONLY look-up of the booking that holds a ticket digest, so the
 *    exchange can refuse what it can decide without spending the single-use ticket (unknown,
 *    already claimed, not live, outside the window) before it reads any other configuration
 *    (D-S05-5). It selects only the columns those decisions need: never the digest, the Meet URL,
 *    an Ashby or Recall column, the attester or the slot.
 *  - `claimR1MeetTicket`: `r1_meet_claim_ticket` (0142 §17), the authoritative single-use claim
 *    under the booking row lock. Its answer is the binding the exchange admits with.
 *  - `bindR1MeetSession`: `r1_meet_bind_session` (0142 §15), right after admission.
 *
 * Every function answers `{ kind: 'error' }` for a database error, a rejected call, an unknown
 * status or a malformed row or binding, so a route answers 503 and never mistakes an outage or a
 * drifted answer for "not found". Ids come back lower-cased. Nothing here logs, and no ticket,
 * digest or id is ever put in an error.
 *
 * The client is an argument (type-only import of `lib/supabase`), so loading this module reads no
 * environment and performs no I/O; the route passes the service-role client.
 */

import type { supabase } from '../../supabase.js';
import { parseR1MeetInstant } from './ticket.js';

type Db = typeof supabase;

/** The 0142 RPCs this store calls. */
export const R1_MEET_CLAIM_TICKET_RPC = 'r1_meet_claim_ticket' as const;
export const R1_MEET_BIND_SESSION_RPC = 'r1_meet_bind_session' as const;

/**
 * The booking statuses a ticket may be claimed in (0142 §17 `booking_not_claimable` is every other
 * one; the same set 0142 §16 arms in). Frozen.
 */
export const R1_MEET_CLAIMABLE_STATUSES = Object.freeze([
  'bot_scheduled',
  'bot_joining',
  'human_present',
  'in_call',
] as const);

/** Exactly what the peek selects (pinned by `r1-meet-bridge-store.test.ts`). */
export const R1_MEET_TICKET_PEEK_COLUMNS =
  'id, status, round_id, session_id, objective_profile, ticket_not_before, ticket_expires_at, ticket_claimed_at';

/** The closed refusals of `r1_meet_claim_ticket` (0142 §17), in the order the RPC checks them. Frozen. */
export const R1_MEET_CLAIM_REFUSALS = Object.freeze([
  'invalid_ticket',
  'invalid_request',
  'ticket_unknown',
  'ticket_already_claimed',
  'booking_not_claimable',
  'ticket_not_yet_valid',
  'ticket_expired',
  'round_not_live',
] as const);
export type R1MeetClaimRefusal = (typeof R1_MEET_CLAIM_REFUSALS)[number];

/** The closed refusals of `r1_meet_bind_session` (0142 §15). Frozen. */
export const R1_MEET_BIND_REFUSALS = Object.freeze([
  'not_found',
  'invalid_request',
  'not_in_call',
  'session_mismatch',
] as const);
export type R1MeetBindRefusal = (typeof R1_MEET_BIND_REFUSALS)[number];

/** The booking a ticket digest names, as the peek reads it. Ids lower-cased; times as epoch ms. */
export interface R1MeetTicketBooking {
  readonly id: string;
  readonly status: string;
  readonly roundId: string;
  /** The session bound by an earlier exchange of this booking (a re-arm), or null. */
  readonly sessionId: string | null;
  readonly objectiveProfile: string;
  readonly ticketNotBeforeMs: number;
  readonly ticketExpiresAtMs: number;
  /** When the current ticket was claimed, or null while it is unclaimed. */
  readonly ticketClaimedAtMs: number | null;
}

export type R1MeetTicketPeek =
  | { readonly kind: 'found'; readonly booking: R1MeetTicketBooking }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'error' };

/** What a successful claim binds the exchange to. Ids lower-cased; the slot as the RPC printed it. */
export interface R1MeetClaimBinding {
  readonly bookingId: string;
  readonly roundId: string;
  readonly candidateId: string;
  readonly objectiveProfile: string;
  /** The session an earlier claim of this booking bound (a re-arm after admission), or null. */
  readonly sessionId: string | null;
  readonly startAt: string;
  readonly endAt: string;
}

export type R1MeetClaimResult =
  | { readonly kind: 'ok'; readonly binding: R1MeetClaimBinding }
  | { readonly kind: 'refused'; readonly reason: R1MeetClaimRefusal }
  | { readonly kind: 'error' };

export type R1MeetBindResult =
  | { readonly kind: 'ok'; readonly previousSessionId: string | null }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'refused'; readonly reason: R1MeetBindRefusal }
  | { readonly kind: 'error' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const CLAIM_REFUSALS: ReadonlySet<string> = new Set(R1_MEET_CLAIM_REFUSALS);
const BIND_REFUSALS: ReadonlySet<string> = new Set(R1_MEET_BIND_REFUSALS);
const ERROR = Object.freeze({ kind: 'error' as const });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A lower-cased UUID, or undefined when `value` is not one. */
function uuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}

/**
 * A lower-cased UUID, null for null, or undefined when malformed. An ABSENT key is malformed: the
 * peek selects the column and the RPCs always build the key, so its absence is drift.
 */
function uuidOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return uuid(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** An ISO instant with a zone, as `now` must be sent to the RPCs. */
function isZonedInstant(value: unknown): value is string {
  return parseR1MeetInstant(value) !== null;
}

function parsePeekRow(row: Record<string, unknown>): R1MeetTicketBooking | null {
  const id = uuid(row.id);
  const roundId = uuid(row.round_id);
  const sessionId = uuidOrNull(row.session_id);
  const status = nonEmptyString(row.status);
  const objectiveProfile = nonEmptyString(row.objective_profile);
  const ticketNotBeforeMs = parseR1MeetInstant(row.ticket_not_before);
  const ticketExpiresAtMs = parseR1MeetInstant(row.ticket_expires_at);
  const ticketClaimedAtMs = row.ticket_claimed_at === null ? null : parseR1MeetInstant(row.ticket_claimed_at);
  if (
    id === undefined
    || roundId === undefined
    || sessionId === undefined
    || status === undefined
    || objectiveProfile === undefined
    || ticketNotBeforeMs === null
    || ticketExpiresAtMs === null
    || (row.ticket_claimed_at !== null && ticketClaimedAtMs === null)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    status,
    roundId,
    sessionId,
    objectiveProfile,
    ticketNotBeforeMs,
    ticketExpiresAtMs,
    ticketClaimedAtMs,
  });
}

/**
 * Read (never lock, never write) the booking holding `digest`. `unknown` when none does, or when
 * `digest` is not a 64-hex digest (no booking can hold one: 0142 CHECK), without a query.
 */
export async function peekR1MeetTicket(db: Db, digest: string): Promise<R1MeetTicketPeek> {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return Object.freeze({ kind: 'unknown' as const });
  try {
    const { data, error } = await db
      .from('r1_meet_bookings')
      .select(R1_MEET_TICKET_PEEK_COLUMNS)
      .eq('ticket_digest', digest)
      .maybeSingle();
    if (error) return ERROR;
    if (data === null || data === undefined) return Object.freeze({ kind: 'unknown' as const });
    if (!isPlainObject(data)) return ERROR;
    const booking = parsePeekRow(data);
    return booking ? Object.freeze({ kind: 'found' as const, booking }) : ERROR;
  } catch {
    return ERROR;
  }
}

/** Parse the jsonb answer of `r1_meet_claim_ticket`. */
export function parseR1MeetClaimAnswer(data: unknown): R1MeetClaimResult {
  if (!isPlainObject(data)) return ERROR;
  const status = data.status;
  if (typeof status !== 'string') return ERROR;
  if (CLAIM_REFUSALS.has(status)) {
    return Object.freeze({ kind: 'refused' as const, reason: status as R1MeetClaimRefusal });
  }
  if (status !== 'ok') return ERROR;
  const bookingId = uuid(data.booking_id);
  const roundId = uuid(data.round_id);
  const candidateId = uuid(data.candidate_id);
  const objectiveProfile = nonEmptyString(data.objective_profile);
  const sessionId = uuidOrNull(data.session_id);
  const startAt = data.start_at;
  const endAt = data.end_at;
  if (
    bookingId === undefined
    || roundId === undefined
    || candidateId === undefined
    || objectiveProfile === undefined
    || sessionId === undefined
    || !isZonedInstant(startAt)
    || !isZonedInstant(endAt)
  ) {
    return ERROR;
  }
  return Object.freeze({
    kind: 'ok' as const,
    binding: Object.freeze({ bookingId, roundId, candidateId, objectiveProfile, sessionId, startAt, endAt }),
  });
}

/**
 * Claim the ticket whose digest is `digest`, at `nowIso`. A malformed digest is refused as
 * `invalid_ticket` and a malformed `nowIso` as `invalid_request` (the RPC's own first two refusals)
 * without a round trip. Sends exactly `{ p_ticket_digest, p_now }`.
 */
export async function claimR1MeetTicket(db: Db, digest: string, nowIso: string): Promise<R1MeetClaimResult> {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    return Object.freeze({ kind: 'refused' as const, reason: 'invalid_ticket' as const });
  }
  if (!isZonedInstant(nowIso)) return Object.freeze({ kind: 'refused' as const, reason: 'invalid_request' as const });
  try {
    const { data, error } = await db.rpc(R1_MEET_CLAIM_TICKET_RPC, { p_ticket_digest: digest, p_now: nowIso });
    if (error) return ERROR;
    return parseR1MeetClaimAnswer(data);
  } catch {
    return ERROR;
  }
}

/** Parse the jsonb answer of `r1_meet_bind_session`. */
export function parseR1MeetBindAnswer(data: unknown): R1MeetBindResult {
  if (!isPlainObject(data)) return ERROR;
  const status = data.status;
  if (typeof status !== 'string') return ERROR;
  if (BIND_REFUSALS.has(status)) {
    return Object.freeze({ kind: 'refused' as const, reason: status as R1MeetBindRefusal });
  }
  if (status === 'duplicate') return Object.freeze({ kind: 'duplicate' as const });
  if (status !== 'ok') return ERROR;
  const previousSessionId = uuidOrNull(data.previous_session_id);
  if (previousSessionId === undefined) return ERROR;
  return Object.freeze({ kind: 'ok' as const, previousSessionId });
}

/**
 * Bind the admitted session to the in-call booking, at `nowIso`. Ids that are not UUIDs or a
 * malformed `nowIso` are refused as `invalid_request` without a round trip. Sends exactly
 * `{ p_booking_id, p_session_id, p_now }`.
 */
export async function bindR1MeetSession(
  db: Db,
  bookingId: string,
  sessionId: string,
  nowIso: string,
): Promise<R1MeetBindResult> {
  const booking = uuid(bookingId);
  const session = uuid(sessionId);
  if (booking === undefined || session === undefined || !isZonedInstant(nowIso)) {
    return Object.freeze({ kind: 'refused' as const, reason: 'invalid_request' as const });
  }
  try {
    const { data, error } = await db.rpc(R1_MEET_BIND_SESSION_RPC, {
      p_booking_id: booking,
      p_session_id: session,
      p_now: nowIso,
    });
    if (error) return ERROR;
    return parseR1MeetBindAnswer(data);
  } catch {
    return ERROR;
  }
}
