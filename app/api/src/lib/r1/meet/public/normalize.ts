/**
 * The normalisers of the public booking form (M035 S04, dark; D-S04-5, D-S04-6).
 *
 * WHAT IT DECIDES. The one canonical form of what a candidate typed into the public R1 booking page,
 * so the local match, the Ashby search filter and the on-file email check all compare the same text:
 *   normalizePublicEmail   NFC, then the Ashby contact rules (`sanitizeEmail` of
 *                          `integrations/ashby/candidate-profile.ts`: trimmed, at most 254 characters,
 *                          exactly one `@` with text either side, no whitespace, control or format
 *                          character), then lower-case and NFC again, and the result must still pass
 *                          those rules. Anything else is null.
 *   normalizePublicPhone   `normalizePhone` (`lib/phone.ts`, India as the default region), kept only
 *                          when it is a strict Indian mobile (`STRICT_IN_MOBILE_E164`,
 *                          `lib/candidate-phone.ts`), the only form `candidates.phone_e164` ever
 *                          holds. A landline, a foreign number or anything unparseable is null: it
 *                          could never match a stored number, so it is not a phone for matching.
 *
 * WHAT IT NEVER DOES. No Gmail dot or plus folding and no IDN conversion: `a.b+c@gmail.com` stays
 * itself, because folding would make two different Ashby addresses one identity (a guess). No
 * logging, no I/O, no clock, no configuration read; a value is never put into an error (nothing
 * here throws). Inputs that are not strings, or are absurdly long (over 1024 characters for an email,
 * 64 for a phone), are null before any parsing runs.
 *
 * Both functions are idempotent: normalising an output again returns it unchanged (property tests).
 */

import { sanitizeEmail } from '../../../../integrations/ashby/candidate-profile.js';
import { STRICT_IN_MOBILE_E164 } from '../../../candidate-phone.js';
import { normalizePhone } from '../../../phone.js';

/** A typed email longer than this is refused before any Unicode work. */
const MAX_RAW_EMAIL_LEN = 1024;
/** The RFC 5321 path limit, the same bound `sanitizeEmail` applies. */
const MAX_EMAIL_LEN = 254;
/** A typed phone longer than this is refused before libphonenumber sees it. */
const MAX_RAW_PHONE_LEN = 64;

/** The canonical form of a typed email, or null when it is not a usable address. */
export function normalizePublicEmail(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_EMAIL_LEN) return null;
  const sanitized = sanitizeEmail(raw.normalize('NFC'));
  if (sanitized === null) return null;
  const folded = sanitized.toLowerCase().normalize('NFC');
  const checked = sanitizeEmail(folded);
  if (checked === null || checked.length > MAX_EMAIL_LEN) return null;
  return checked;
}

/** The strict `+91` mobile form of a typed phone, or null. */
export function normalizePublicPhone(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_PHONE_LEN) return null;
  const e164 = normalizePhone(raw).e164;
  return e164 !== null && STRICT_IN_MOBILE_E164.test(e164) ? e164 : null;
}
