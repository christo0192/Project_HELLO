/**
 * The manage-link token of a public R1 booking (M035 S05, dark): the secret in the link Lexy's
 * calendar invite carries, with which the candidate moves, cancels or withdraws the booking.
 *
 * What a manage token is:
 *  - 32 random bytes as base64url without padding (43 characters), minted FRESH by the
 *    `calendar_sync` job for every invite or move it sends, so each send rotates it and the earlier
 *    link stops working. It is never logged, never queued and never put in an error.
 *  - The database stores only its digest (`r1_meet_bookings.manage_token_digest`, migration 0143,
 *    written by `r1_meet_public_set_manage_digest`), and the digest is stored BEFORE the invite that
 *    carries the token is sent. The raw token lives in memory, in the Google event description and
 *    in the candidate's mailbox only.
 *  - The digest is a hex HMAC-SHA256 in its own domain `hello:r1:meet-manage:v1`, under the key
 *    `r1MeetDerivedKey` derives from the worker secret (`../ticket.ts`), so it is never a plain
 *    SHA-256 and never equals a bridge-ticket digest of the same text. It is 64 lowercase hex
 *    characters: exactly what the 0143 CHECK accepts.
 *  - The link is `<web origin>/book/manage#m=<token>`: the token travels in the URL fragment,
 *    which browsers never send to a server. The manage page (S06/S08) posts it to the API, which
 *    digests it with `r1MeetManageTokenDigest` and compares. S06 never mints.
 *
 * Read no environment here: the worker secret is reached only through `r1MeetDerivedKey`'s
 * `source` parameter. This module never calls the database or Google and performs no I/O at
 * import.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { R1_MEET_BRIDGE_PAGE_PATH, R1_MEET_PUBLIC_MANAGE_PAGE_PATH } from '../config.js';
import { r1MeetDerivedKey } from '../ticket.js';

/** The HMAC domain of the manage-token digest. */
export const R1_MEET_MANAGE_DOMAIN = 'hello:r1:meet-manage:v1';
/** Random bytes per manage token: 256 bits. */
export const R1_MEET_MANAGE_TOKEN_BYTES = 32;
/** Exactly a minted token: 32 bytes as base64url without padding. Nothing else is ever digested. */
export const R1_MEET_MANAGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface MintedR1MeetManageToken {
  /** The plaintext: put it in the invite's manage link only; never store, queue or log it. */
  readonly token: string;
  /** What `r1_meet_public_set_manage_digest` stores. */
  readonly digest: string;
}

export interface MintR1MeetManageTokenDeps {
  /** Test seam; production uses `crypto.randomBytes`. Must return exactly the bytes asked for. */
  readonly random?: (bytes: number) => Buffer;
  /** Test seam for the worker secret (the flows pass `R1MeetFlowDeps.ticketSource`). */
  readonly source?: NodeJS.ProcessEnv;
}

/**
 * The stored form of a manage token: hex HMAC-SHA256 under the manage key (64 lowercase hex
 * characters). Null when no key exists (the worker secret is absent or shorter than 32 characters)
 * or the value is not token-shaped (never digest arbitrary input).
 */
export function r1MeetManageTokenDigest(token: string, source?: NodeJS.ProcessEnv): string | null {
  if (typeof token !== 'string' || !R1_MEET_MANAGE_TOKEN_PATTERN.test(token)) return null;
  const key = r1MeetDerivedKey(R1_MEET_MANAGE_DOMAIN, source);
  if (!key) return null;
  return createHmac('sha256', key).update(token, 'utf8').digest('hex');
}

/**
 * Mint a fresh manage token for one invite or move send: 32 random bytes as base64url without
 * padding, and its digest. Null when no manage key exists (no randomness is spent then), or when
 * the random source throws or returns anything but 32 bytes. Call it again for every send: a token
 * is never reused.
 */
export function mintR1MeetManageToken(deps: MintR1MeetManageTokenDeps = {}): MintedR1MeetManageToken | null {
  if (r1MeetDerivedKey(R1_MEET_MANAGE_DOMAIN, deps.source) === null) return null;
  let bytes: unknown;
  try {
    bytes = (deps.random ?? randomBytes)(R1_MEET_MANAGE_TOKEN_BYTES);
  } catch {
    return null;
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== R1_MEET_MANAGE_TOKEN_BYTES) return null;
  const token = bytes.toString('base64url');
  const digest = r1MeetManageTokenDigest(token, deps.source);
  if (digest === null) return null;
  return Object.freeze({ token, digest });
}

/**
 * The candidate's manage link: `${origin}/book/manage#m=${token}`, where `origin` is the origin of
 * the Meet configuration's `bridgePageUrl` (the first WEB_ORIGIN entry plus
 * `R1_MEET_BRIDGE_PAGE_PATH`), passed in by the caller. The bridge page URL is checked exactly as
 * `r1MeetBridgePageUrl` (`../ticket.ts`) checks it: an https origin followed by that path, with no
 * userinfo, port spelling, query or fragment. Null unless it passes and the token is token-shaped.
 */
export function r1MeetPublicManageLink(bridgePageUrl: string, token: string): string | null {
  if (typeof bridgePageUrl !== 'string' || typeof token !== 'string') return null;
  if (!R1_MEET_MANAGE_TOKEN_PATTERN.test(token)) return null;
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
  return canonical ? `${url.origin}${R1_MEET_PUBLIC_MANAGE_PAGE_PATH}#m=${token}` : null;
}
