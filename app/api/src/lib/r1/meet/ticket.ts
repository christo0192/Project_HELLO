/**
 * The Meet bridge ticket (M034 S05, dark): the single-use secret that lets the bridge page, opened
 * by Dex's Recall bot as its camera, exchange itself for one LiveKit join of the booked R1 session.
 *
 * What a ticket is:
 *  - 32 random bytes as base64url without padding (43 characters), minted FRESH for every arm and
 *    never reused, never stored and never logged. It travels only in the page URL fragment
 *    (`<web origin>/candidate/r1/meet#t=<ticket>`), which browsers never send to a server.
 *  - Single use: the API stores only its digest (`r1_meet_bookings.ticket_digest`, migration 0142
 *    §16) with a claim window, and `r1_meet_claim_ticket` (0142 §17) claims it once under the
 *    booking row lock.
 *  - The digest is a hex HMAC-SHA256 in its own domain `hello:r1:meet-bridge:v1`, so a ticket
 *    digest is never a plain SHA-256 and never collides with any other R1 MAC (the attempt token,
 *    the resume token). It is 64 lowercase hex characters: exactly what the 0142 CHECK accepts.
 *
 * Why the key comes from `WORKER_CONTEXT_SECRET`: the API is the only party that ever digests a
 * ticket (S05 when the page presents it, S06 when it arms one), and that secret is already an
 * API server key (the attempt token derives from it the same way, `../attempt-token.ts`). No new
 * secret is needed. The secret itself is never the key: the key is HMAC(secret, domain). Rotating
 * the secret invalidates every armed ticket (S06 re-arms) and every live resume token.
 *
 * The claim window (`r1MeetTicketWindow`, critic C1): from max(5 minutes, the bot's join lead plus
 * one minute) before the slot starts until 15 minutes after it ends, so `not_before` always lies
 * at or before the bot's `join_at` (a 425 is terminal on the bridge page) and inside the 0142 §16
 * bounds (start - 15 minutes .. end + 30 minutes). A lead that cannot fit those bounds arms nothing.
 *
 * How S06 uses this module: `mintR1MeetTicket(...)` -> `r1_meet_arm_ticket(booking, digest,
 * not_before, expires_at, now)` -> on `ok`, post `r1MeetBridgePageUrl(config.bridgePageUrl,
 * ticket)` to Recall as the bot's output media. A `digest_in_use` or `duplicate` answer means
 * "mint again". This module itself never calls Recall or the database, reads no Meet variable, and
 * performs no I/O at import.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { R1_MEET_BRIDGE_PAGE_PATH } from './config.js';

/** The HMAC domain of the ticket digest. */
export const R1_MEET_TICKET_DOMAIN = 'hello:r1:meet-bridge:v1';
/** Random bytes per ticket: 256 bits. */
export const R1_MEET_TICKET_BYTES = 32;
/** What the bridge page (S07) and the exchange accept as a ticket. A minted one is 43 characters. */
export const R1_MEET_TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
/** The window opens at least this long before the slot starts. */
export const R1_MEET_TICKET_LEAD_SEC = 300;
/** The window closes this long after the slot ends. */
export const R1_MEET_TICKET_TAIL_SEC = 900;
/** 0142 §16: `not_before >= start_at - 15 minutes`. A longer lead arms nothing. */
export const R1_MEET_TICKET_MAX_LEAD_SEC = 900;
/** 0142 §16: `expires_at <= end_at + 30 minutes`. */
export const R1_MEET_TICKET_MAX_TAIL_SEC = 1800;

/** The opening always precedes the bot's join time by at least this much. */
const JOIN_MARGIN_SEC = 60;
/** The shared worker secret is a key source only at this length or more (as the attempt token). */
const MIN_SECRET_LENGTH = 32;
/** Only the Meet bridge domains may be derived here, never another R1 key (attempt token...). */
const MEET_KEY_DOMAIN = /^hello:r1:meet-[a-z]+(?:-[a-z]+)*:v[0-9]+$/;
/** An instant with an explicit zone; Date.parse alone would read a zoneless string as local time. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * The HMAC key of a Meet bridge domain, or null when the shared worker secret is absent or shorter
 * than 32 characters (the routes then answer 503 before any database read). Read lazily, so a
 * malformed value never stops the API from booting. Same derivation as `../attempt-token.ts`:
 * HMAC-SHA256(secret, domain). Refuses (null) any domain outside `hello:r1:meet-*:v<n>`.
 */
export function r1MeetDerivedKey(domain: string, source: NodeJS.ProcessEnv = process.env): Buffer | null {
  if (typeof domain !== 'string' || !MEET_KEY_DOMAIN.test(domain)) return null;
  const secret = source.WORKER_CONTEXT_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return null;
  return createHmac('sha256', secret).update(domain).digest();
}

/** True when tickets can be digested in this process (the bridge key exists). */
export function r1MeetBridgeKeysConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
  return r1MeetDerivedKey(R1_MEET_TICKET_DOMAIN, source) !== null;
}

/**
 * The stored form of a ticket: hex HMAC-SHA256 under the bridge key (64 lowercase hex characters).
 * Null when no key exists or the ticket is not ticket-shaped (never digest arbitrary input).
 */
export function r1MeetTicketDigest(ticket: string, source: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof ticket !== 'string' || !R1_MEET_TICKET_PATTERN.test(ticket)) return null;
  const key = r1MeetDerivedKey(R1_MEET_TICKET_DOMAIN, source);
  if (!key) return null;
  return createHmac('sha256', key).update(ticket, 'utf8').digest('hex');
}

/**
 * Epoch ms of an ISO 8601 instant that carries its zone (`Z` or `+hh:mm`, as PostgREST and the
 * 0142 RPC answers print a timestamptz), or null. A zoneless string is refused: `Date.parse` would
 * read it as local time. Shared with the booking store.
 */
export function parseR1MeetInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !ZONED_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export interface R1MeetTicketWindowInput {
  /** The booked slot start (zoned ISO 8601, as the booking row or the claim binding carries it). */
  readonly startAt: string;
  /** The booked slot end. */
  readonly endAt: string;
  /** The objective profile's `botJoinLeadSec`: the bot's `join_at` is this long before the start. */
  readonly botJoinLeadSec: number;
  /** The caller's clock, epoch ms. */
  readonly nowMs: number;
}

export interface R1MeetTicketWindow {
  readonly not_before: string;
  readonly expires_at: string;
}

/**
 * The claim window of a ticket for one slot (D-S05-19): `not_before = start - max(300 s,
 * botJoinLeadSec + 60 s)`, `expires_at = end + 900 s`, as ISO strings. Null (do not arm) when the
 * lead would exceed the 0142 bound (start - 15 minutes), when the window has already closed
 * (`expires_at <= now`), when the slot is unparseable or `end <= start`, or for a negative or
 * non-integer lead.
 */
export function r1MeetTicketWindow(input: R1MeetTicketWindowInput): R1MeetTicketWindow | null {
  const startMs = parseR1MeetInstant(input.startAt);
  const endMs = parseR1MeetInstant(input.endAt);
  const { botJoinLeadSec, nowMs } = input;
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  if (!Number.isSafeInteger(botJoinLeadSec) || botJoinLeadSec < 0) return null;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  const leadSec = Math.max(R1_MEET_TICKET_LEAD_SEC, botJoinLeadSec + JOIN_MARGIN_SEC);
  if (leadSec > R1_MEET_TICKET_MAX_LEAD_SEC) return null;
  const notBeforeMs = startMs - leadSec * 1000;
  const expiresMs = endMs + R1_MEET_TICKET_TAIL_SEC * 1000;
  if (expiresMs <= nowMs) return null;
  return Object.freeze({
    not_before: new Date(notBeforeMs).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
  });
}

export interface MintedR1MeetTicket {
  /** The plaintext: post it inside the page URL only; never store or log it. */
  readonly ticket: string;
  /** What `r1_meet_arm_ticket` stores. */
  readonly digest: string;
  readonly not_before: string;
  readonly expires_at: string;
}

export interface MintR1MeetTicketDeps {
  /** Test seam; production uses `crypto.randomBytes`. Must return exactly the bytes asked for. */
  readonly random?: (bytes: number) => Buffer;
  /** Test seam for the worker secret. */
  readonly source?: NodeJS.ProcessEnv;
}

/**
 * Mint a fresh ticket for one arm (D-S05-20): 32 random bytes as base64url without padding, its
 * digest and its window. Null when no bridge key exists, when the slot has no window (see
 * `r1MeetTicketWindow`), or when the random source returns anything but 32 bytes. Call it again
 * for every arm: a ticket is never reused.
 */
export function mintR1MeetTicket(
  input: R1MeetTicketWindowInput,
  deps: MintR1MeetTicketDeps = {},
): MintedR1MeetTicket | null {
  const source = deps.source ?? process.env;
  if (!r1MeetBridgeKeysConfigured(source)) return null;
  const window = r1MeetTicketWindow(input);
  if (!window) return null;
  const bytes = (deps.random ?? randomBytes)(R1_MEET_TICKET_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== R1_MEET_TICKET_BYTES) return null;
  const ticket = bytes.toString('base64url');
  const digest = r1MeetTicketDigest(ticket, source);
  if (digest === null) return null;
  return Object.freeze({ ticket, digest, not_before: window.not_before, expires_at: window.expires_at });
}

/**
 * The URL the bot shows as its camera: `${bridgePageUrl}#t=${ticket}`. `bridgePageUrl` is the Meet
 * configuration's `bridgePageUrl` (the first WEB_ORIGIN entry plus `R1_MEET_BRIDGE_PAGE_PATH`),
 * passed in by the caller; this helper reads no environment. Null unless it is exactly an https
 * origin followed by that path (no userinfo, port spelling, query or fragment) and the ticket is
 * ticket-shaped.
 */
export function r1MeetBridgePageUrl(bridgePageUrl: string, ticket: string): string | null {
  if (typeof bridgePageUrl !== 'string' || typeof ticket !== 'string') return null;
  if (!R1_MEET_TICKET_PATTERN.test(ticket)) return null;
  let url: URL;
  try {
    url = new URL(bridgePageUrl);
  } catch {
    return null;
  }
  const canonical =
    url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && url.pathname === R1_MEET_BRIDGE_PAGE_PATH
    // Exactly origin + path: refuses a bare '?' or '#', ':443' and other spellings the parser repairs.
    && bridgePageUrl === `${url.origin}${R1_MEET_BRIDGE_PAGE_PATH}`;
  return canonical ? `${bridgePageUrl}#t=${ticket}` : null;
}
