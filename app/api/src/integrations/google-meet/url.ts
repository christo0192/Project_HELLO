/**
 * google-meet/url.ts — the one place a Google Meet link is accepted.
 *
 * Vendor-neutral on purpose: the Ashby interview-schedule parser (`lib/r1/meet/ashby-schedule.ts`,
 * the link Ashby put on the interview event) and the Recall bot builder (the link the bot is sent
 * to) both call it, so a link that one side accepts the other side accepts too.
 *
 * Accepted: `https://meet.google.com/<abc-defg-hij>` with an optional single trailing `/`, an
 * optional query and an optional fragment. Scheme and host compare case-insensitively (RFC 3986)
 * and the code is case-folded. The output is ALWAYS the canonical `https://meet.google.com/<code>`:
 * the query (e.g. `?authuser=0`) and fragment are dropped.
 *
 * Rejected (returns null, never throws): http, any other host (including look-alikes such as
 * `meet.google.com.evil.test` and the `g.co/meet` short links), userinfo, any explicit port (even
 * `:443`), `/lookup/...`, `/new`, extra path segments, percent-encoded or otherwise odd paths,
 * whitespace or control characters anywhere, inputs over 2048 characters and non-strings.
 *
 * Reads no environment and performs no I/O.
 */

export const GOOGLE_MEET_ORIGIN = 'https://meet.google.com';

/** A Meet meeting code: three, four and three lowercase letters. */
export const GOOGLE_MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

const MAX_URL_LENGTH = 2048;

// Printable ASCII only. `new URL` silently strips tabs and newlines from inside a URL, so this
// check runs first: a link carrying them is malformed, not "close enough".
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// The literal authority. Comparing the raw prefix (not only the parsed hostname) is what rejects
// userinfo, any explicit port (the parser drops a default `:443`), a trailing-dot host and
// backslash spellings, which the WHATWG parser would otherwise normalise into an accepted URL.
const REQUIRED_PREFIX = `${GOOGLE_MEET_ORIGIN}/`;

const MEET_PATH = /^\/([A-Za-z]{3}-[A-Za-z]{4}-[A-Za-z]{3})\/?$/;

/** Canonical `https://meet.google.com/<code>`, or null when `raw` is not a Google Meet link. */
export function normalizeGoogleMeetUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  if (!PRINTABLE_ASCII.test(raw)) return null;
  if (raw.slice(0, REQUIRED_PREFIX.length).toLowerCase() !== REQUIRED_PREFIX) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'meet.google.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    return null;
  }

  // The path is checked as WRITTEN as well as parsed: the parser resolves `/x/../abc-defg-hij` to an
  // accepted path, and a link spelled like that is not a link Google or Ashby produced.
  const afterOrigin = raw.slice(GOOGLE_MEET_ORIGIN.length);
  const rawPath = afterOrigin.split(/[?#]/, 1)[0];
  const match = MEET_PATH.exec(url.pathname);
  if (!match || rawPath !== url.pathname) return null;
  const code = match[1].toLowerCase();
  return GOOGLE_MEET_CODE_RE.test(code) ? `${GOOGLE_MEET_ORIGIN}/${code}` : null;
}

/**
 * The meeting code of an ALREADY-normalised URL (the exact output of `normalizeGoogleMeetUrl`), for
 * comparing two links without logging either. Anything else, including a link that would
 * normalise but is not yet canonical, returns null.
 */
export function googleMeetCode(normalizedUrl: string): string | null {
  if (typeof normalizedUrl !== 'string' || !normalizedUrl.startsWith(REQUIRED_PREFIX)) return null;
  const code = normalizedUrl.slice(REQUIRED_PREFIX.length);
  return GOOGLE_MEET_CODE_RE.test(code) ? code : null;
}
