/**
 * The due-loop diagnostic must survive the logger it is written for.
 *
 * `phone_due_diag` existed to explain WHY a due engagement was not dialled,
 * and for its whole life it reported nothing in exactly that case. The value
 * was composed as
 *
 *   gate.N:st.X:exN:ofN:diN:skip.CODES:ref.CODES        (truncated to 180)
 *
 * while `logger.ts` validates `error_category` against SAFE_IDENT_RE, which
 * caps at 64 CHARACTERS and rejects past it — dropping the field. A quiet tick
 * fits; a tick carrying a real refusal does not. So the diagnostic was present
 * whenever there was nothing to say and absent whenever there was.
 *
 * An earlier repair attributed this to the entropy/token defense and sanitised
 * the sub-codes, which was not the cause and changed nothing. So this suite
 * drives the REAL logger through its injected writer rather than asserting a
 * length: a rule about a limit belongs to the thing enforcing it, and
 * re-implementing the check here would let the two drift apart again.
 *
 * It also drives the keys PRODUCTION emits, not the bare vocabularies they are
 * built from. `runtime.ts` logs `Object.keys(result.skipped)` and
 * `Object.keys(result.refusals)`, and `due-loop.ts` composes those keys as
 * `<refusal>:<detail>` — so a suite that fed bare codes would be measuring a
 * string 18 characters shorter than the one that reaches the logger, and its
 * margin would be a fiction.
 */

import { describe, it, expect } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { PHONE_DEFERRAL_CODES } from '../lib/phone-screening/admission.js';
import { PHONE_RPC_STATUS_UNION } from '../lib/phone-screening/rpc-contract.js';
import {
  PHONE_ADMISSION_DEFERRAL,
  PHONE_ADMISSION_REFUSAL,
  PHONE_DUE_SKIPS,
  PHONE_UNKNOWN_ADMISSION_DETAIL,
  phoneDueDiagSummary,
  phoneRefusalCountKey,
} from '../lib/phone-runtime/due-loop.js';

/** The logger's own cap, asserted here so a change to it fails loudly. */
const SAFE_IDENT_MAX = 64;

/** Emit one line through a real logger and return the parsed envelope. */
function emitted(meta: { error_type: string; error_category: string }): Record<string, unknown> {
  const lines: string[] = [];
  const logger = createLogger('test', { writer: (line) => lines.push(line) });
  logger.info('unknown_event', meta);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** Every key the loop can put in `refusals`, composed exactly as it composes them. */
function everyRefusalKey(): string[] {
  const out = new Set<string>();
  for (const refusal of [PHONE_ADMISSION_REFUSAL, PHONE_ADMISSION_DEFERRAL]) {
    // The unknown-detail fallback is a real emitted key, not a placeholder.
    out.add(phoneRefusalCountKey(refusal, PHONE_UNKNOWN_ADMISSION_DETAIL));
    out.add(phoneRefusalCountKey(refusal, undefined));
    for (const detail of [...PHONE_RPC_STATUS_UNION, ...PHONE_DEFERRAL_CODES]) {
      out.add(phoneRefusalCountKey(refusal, detail));
    }
  }
  // The un-expanded refusals pass through as the bare code.
  for (const bare of [
    'transport_not_configured', 'timeouts_misordered', 'lease_too_short',
    'originate_failed', 'room_unavailable', 'unknown',
  ]) {
    out.add(phoneRefusalCountKey(bare, undefined));
  }
  return [...out];
}

describe('the regression this shape exists to prevent', () => {
  it('the OLD composed value was DROPPED exactly when it carried refusals', () => {
    // Reconstructed literally, including the 180-char slice the old code used.
    const old = (
      'gate.0:st.ok:ex1:of0:di0'
      + ':skip.none:ref.admission_deferred_dial_not_allowlisted'
    ).slice(0, 180);
    expect(old.length).toBeGreaterThan(SAFE_IDENT_MAX);
    // A rejected field is OMITTED from the envelope, not emitted as null — so
    // the old diagnostic did not even leave a hole where its answer should
    // have been.
    expect(emitted({ error_type: 'phone_due_diag', error_category: old }))
      .not.toHaveProperty('error_category');
  });

  it('…while the same old shape with NOTHING to report survived', () => {
    // The asymmetry is the whole defect: silence was reportable, trouble was not.
    const quiet = 'gate.0:st.ok:ex0:of0:di0:skip.none:ref.none';
    expect(quiet.length).toBeLessThanOrEqual(SAFE_IDENT_MAX);
    expect(emitted({ error_type: 'phone_due_diag', error_category: quiet }).error_category)
      .toBe(quiet);
  });
});

describe('the summary line survives at its worst case', () => {
  it('the widest counts still fit, and are not read as an identifier', () => {
    // Composed by the SAME helper `runtime.ts` uses — not a copy of its shape,
    // which is how the previous version of this file measured one string and
    // shipped another.
    const value = phoneDueDiagSummary(true, 999_999, 999_999, 999_999);
    expect(value.length).toBeLessThanOrEqual(SAFE_IDENT_MAX);
    expect(emitted({ error_type: 'phone_due_diag', error_category: value }).error_category)
      .toBe(value);
  });

  it('the clamp is load-bearing — an unclamped count is silently dropped', () => {
    // Six digits is the clamp. It is not cosmetic: TEN consecutive digits trip
    // DEFENSE_RE's phone/card rule, which fires BEFORE the format check and
    // would drop the line for a reason no length assertion would have found.
    expect(phoneDueDiagSummary(true, 1_234_567_890, 0, 0)).toBe('gate.1:ex999999:of0:di0');
    expect(emitted({ error_type: 'phone_due_diag', error_category: 'gate.1:ex1234567890:of0:di0' }))
      .not.toHaveProperty('error_category');
  });

  it('negative and fractional counts cannot escape the clamp either', () => {
    expect(phoneDueDiagSummary(false, -5, 1.9, Number.NaN)).toBe('gate.0:ex0:of1:di0');
  });
});

describe('the status is its own value, so no status can outgrow the budget', () => {
  it('every status the loop can report survives', () => {
    // `PhoneDueResult['status']` is exactly these three. Hand-listing others
    // (the previous version drove `window_closed` and `degraded`) tests
    // strings the type cannot hold while missing `disabled`, which it can.
    for (const status of ['disabled', 'halted', 'ok'] as const) {
      expect(emitted({ error_type: 'phone_due_status', error_category: status }).error_category)
        .toBe(status);
    }
  });

  it('every RPC status survives on its own line', () => {
    // Driving the ENTIRE union is what makes this hold for a status a later
    // migration adds — and it is what caught the first version of this fix,
    // where `candidate_daily_attempt_exists` pushed a composed summary to 67
    // characters and nulled it.
    expect(PHONE_RPC_STATUS_UNION.length).toBeGreaterThan(100);
    for (const status of PHONE_RPC_STATUS_UNION) {
      expect(
        emitted({ error_type: 'phone_due_status', error_category: status }).error_category,
        `${status} (${status.length} chars) was dropped`,
      ).toBe(status);
    }
  });
});

describe('each skip and refusal key is emitted whole, and survives', () => {
  it('every SKIP code survives', () => {
    expect(PHONE_DUE_SKIPS.length).toBeGreaterThan(0);
    for (const code of PHONE_DUE_SKIPS) {
      expect(
        emitted({ error_type: 'phone_due_skip', error_category: code }).error_category,
        `${code} was dropped`,
      ).toBe(code);
    }
  });

  it('every COMPOSED refusal key survives — prefix included', () => {
    // This is the assertion the previous version could not make. Production
    // emits `admission_refused:<detail>`, an 18-character prefix on top of the
    // detail; measuring the bare detail understated every key by that much.
    const keys = everyRefusalKey();
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.some((k) => k.startsWith(`${PHONE_ADMISSION_REFUSAL}:`))).toBe(true);
    expect(keys.some((k) => k.startsWith(`${PHONE_ADMISSION_DEFERRAL}:`))).toBe(true);
    for (const key of keys) {
      expect(
        emitted({ error_type: 'phone_due_refusal', error_category: key }).error_category,
        `${key} (${key.length} chars) was dropped`,
      ).toBe(key);
    }
  });

  it('the remaining margin is stated against the COMPOSED key, not the bare code', () => {
    // The number that matters is how much room the longest real key leaves
    // under the logger's cap. Asserting it here means a future migration that
    // names a long refusal fails THIS test rather than silently blanking the
    // diagnostic in production — which is the exact defect this file exists
    // for, and which the previous 48-char bare-code assertion could not catch
    // (48 + an 18-char prefix is 66, already over).
    const longest = everyRefusalKey().reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length).toBeLessThanOrEqual(SAFE_IDENT_MAX);
    // Keep real headroom, so the guard trips before production does.
    expect(longest.length).toBeLessThanOrEqual(SAFE_IDENT_MAX - 8);
    // And no key may form the 30+ alphanumeric run DEFENSE_RE reads as a token.
    for (const key of everyRefusalKey()) {
      expect(key, `${key} would trip the entropy defense`).not.toMatch(/[A-Za-z0-9]{30,}/);
    }
  });
});
