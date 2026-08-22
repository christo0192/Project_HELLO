/**
 * livekit-phone-dial/dialable-number.ts — the ONE place a raw phone number is
 * allowed to exist in this process, and the wrapper that stops it leaking.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────
 * Every other module in the phone lane maintains the property that no raw
 * number exists outside the `candidates` row: 0042 reads `phone_e164` INSIDE
 * SQL and turns it straight into a digest, the ingress allowlist admits one
 * attribute and it is not a number, and the operator API projects a sanitized
 * view. The dialer is the single unavoidable exception — a SIP originate takes
 * the number, so the number must reach the SDK call.
 *
 * The response is not "be careful". It is to make the value STRUCTURALLY
 * UNLOGGABLE. `DialableNumber` hides the digits behind a private symbol and
 * overrides every path by which a value normally reaches a log line:
 *
 *   * `toString()`  — template literals, string concatenation, `String(x)`
 *   * `toJSON()`    — `JSON.stringify`, every structured logger in this repo
 *   * `util.inspect.custom` — `console.log(obj)`, Node's error formatting
 *
 * All three yield `[redacted]`. Reading the digits requires calling
 * `unwrapDialableNumber` by name, which greps as an audit point and appears at
 * exactly one call site: the SDK originate.
 *
 * A comment saying "do not log this" is not a control; a type whose default
 * rendering is `[redacted]` is. This lane has already paid for the difference
 * — P3's independent review found a trust-boundary sentence that described a
 * stronger property than the code implemented, and the repair was to move the
 * code to match the sentence rather than soften the sentence.
 *
 * No I/O, no client, no configuration.
 */

import { createHash } from 'node:crypto';

/** Private brand. Not exported, so no other module can forge or read one. */
const DIGITS = Symbol('phone.e164');

/** The redaction every accidental render produces. */
export const REDACTED = '[redacted]';

/**
 * The strict Indian-mobile form 0042's `admit_phone_attempt` enforces
 * (`'^\+91[6-9][0-9]{9}$'`), MIRRORED here rather than re-invented. A value
 * the substrate would refuse must not reach a carrier, and the check is
 * applied at the wrapper rather than at the call site because a structural
 * interface guarantees nothing on its own.
 */
const STRICT_IN_MOBILE_E164 = /^\+91[6-9][0-9]{9}$/;

export interface DialableNumber {
  readonly [DIGITS]: string;
  /** SHA-256 hex digest — the form the allowlist and suppressions speak. */
  readonly digest: string;
  toString(): string;
  toJSON(): string;
}

/**
 * Wrap a raw E.164 value. Refuses anything the substrate itself would refuse,
 * so an unwrappable number can never be produced from a malformed row.
 *
 * Throws a BARE code with no interpolation — including the offending value in
 * the message would defeat the entire point of the wrapper, and this lane has
 * the house rule that a thrown phone error carries a code and nothing else.
 */
export function wrapDialableNumber(raw: string): DialableNumber {
  if (typeof raw !== 'string' || !STRICT_IN_MOBILE_E164.test(raw)) {
    throw new Error('phone_number_not_dialable');
  }
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
  const wrapped = {
    [DIGITS]: raw,
    digest,
    toString: (): string => REDACTED,
    toJSON: (): string => REDACTED,
  };
  // `console.log(obj)` and Node's own error formatting go through
  // `util.inspect`, which ignores `toString`/`toJSON` entirely. Without this
  // the wrapper would redact the two paths a developer thinks about and leak
  // on the one they do not.
  Object.defineProperty(wrapped, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => REDACTED,
    enumerable: false,
  });
  return Object.freeze(wrapped) as DialableNumber;
}

/**
 * Read the digits. THE ONLY legitimate caller is the SIP originate; every
 * other use is a leak. Named verbosely on purpose so it is greppable and so
 * nobody reaches for it absent-mindedly.
 */
export function unwrapDialableNumber(number: DialableNumber): string {
  return number[DIGITS];
}
