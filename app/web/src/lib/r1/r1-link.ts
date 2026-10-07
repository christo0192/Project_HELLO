/**
 * Where the R1 link token and the rejoin nonce live in the browser.
 *
 * Invariants:
 *   - The link token is read from the URL FRAGMENT only, kept in memory by the
 *     caller, and the fragment is removed from the address bar immediately,
 *     even when it is missing or malformed. It is never put in a query string,
 *     a path, web storage or a log line (plan section 4 step 3).
 *   - The per-attempt nonce is the ONLY secret kept in `sessionStorage`
 *     (plan section 4 step 6). It is useless without the link token and is
 *     cleared when the attempt ends. Storage may be absent or throw (private
 *     windows, blocked site data), so every access is wrapped and the page
 *     works without it.
 *   - A nonce belongs to ONE link. It is stored beside a short digest of that
 *     link's token and read back only for the same link, so opening a second
 *     link in the same tab (a staff dry run, a reissued link) never sends the
 *     first link's nonce. Capturing a different link's token discards the
 *     stale entry. Only 64 of the token's 256 digest bits are stored, so the
 *     entry names the link without revealing it.
 */

import { sha256Hex } from './r1-digest';

/** Link tokens are 256-bit values serialised as 64 lowercase hex characters. */
const LINK_TOKEN_RE = /^[a-f0-9]{64}$/;

/** Attempt nonces are opaque to the web; accept a conservative token alphabet. */
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

const DIGEST_RE = /^[a-f0-9]{16}$/;
const DIGEST_LENGTH = 16;

export const R1_PATH = '/candidate/r1';
export const R1_NONCE_STORAGE_KEY = 'r1.attempt.nonce';

export function isLinkToken(value: string): boolean {
  return LINK_TOKEN_RE.test(value);
}

export function isNonce(value: string): boolean {
  return NONCE_RE.test(value);
}

/** The short, one-way name this module files a link's nonce under. */
export function linkDigest(linkToken: string): string {
  return sha256Hex(linkToken).slice(0, DIGEST_LENGTH);
}

/** What `sessionStorage` holds: the owning link's digest and its nonce, nothing else. */
interface StoredNonce {
  l: string;
  n: string;
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return sessionStore()?.getItem(R1_NONCE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function parseEntry(raw: string): StoredNonce | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { l, n } = value as Record<string, unknown>;
    if (typeof l !== 'string' || typeof n !== 'string') return null;
    return DIGEST_RE.test(l) && isNonce(n) ? { l, n } : null;
  } catch {
    return null;
  }
}

export function clearNonce(): void {
  try {
    sessionStore()?.removeItem(R1_NONCE_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * Read and strip the link token. Returns null when the fragment is missing or
 * is not a well-formed token. The fragment is removed in every case. A stored
 * nonce that belongs to a different link (or is unreadable) is discarded the
 * moment a valid token is captured.
 */
export function captureLinkToken(win: Window = window): string | null {
  const raw = win.location.hash.slice(1);
  let value = '';
  try {
    value = raw ? decodeURIComponent(raw) : '';
  } catch {
    value = '';
  }
  win.history.replaceState(null, '', R1_PATH);
  if (!isLinkToken(value)) return null;
  const stored = readRaw();
  if (stored !== null && parseEntry(stored)?.l !== linkDigest(value)) clearNonce();
  return value;
}

/** The rejoin nonce stored for THIS link, or null. */
export function readNonce(linkToken: string): string | null {
  const stored = readRaw();
  const entry = stored === null ? null : parseEntry(stored);
  return entry && entry.l === linkDigest(linkToken) ? entry.n : null;
}

export function saveNonce(linkToken: string, nonce: string): void {
  if (!isLinkToken(linkToken) || !isNonce(nonce)) return;
  const entry: StoredNonce = { l: linkDigest(linkToken), n: nonce };
  try {
    sessionStore()?.setItem(R1_NONCE_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // The rejoin convenience is lost; the interview itself is unaffected.
  }
}
