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
 * caps at 64 CHARACTERS and returns null past it — dropping the field. A quiet
 * tick fits; a tick carrying a real refusal does not. So the diagnostic was
 * present whenever there was nothing to say and absent whenever there was.
 *
 * An earlier repair attributed this to the entropy/token defense and sanitised
 * the sub-codes, which was not the cause and changed nothing. That is why this
 * suite drives the REAL logger through its injected writer rather than
 * asserting a length: a rule about a limit belongs to the thing enforcing it,
 * and re-implementing the check here would let the two drift apart again.
 */

import { describe, it, expect } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { PHONE_DEFERRAL_CODES } from '../lib/phone-screening/admission.js';
import { PHONE_RPC_STATUS_UNION } from '../lib/phone-screening/rpc-contract.js';

/** Emit one line through a real logger and return the parsed envelope. */
function emitted(meta: { error_type: string; error_category: string }): Record<string, unknown> {
  const lines: string[] = [];
  const logger = createLogger('test', { writer: (line) => lines.push(line) });
  logger.info('unknown_event', meta);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** The shape `runtime.ts` composes: counts only, no status. */
const summary = (ex: number, of: number, di: number, gate: boolean): string =>
  `gate.${gate ? 1 : 0}:ex${ex}:of${of}:di${di}`;

describe('the regression this shape exists to prevent', () => {
  it('the OLD composed value was DROPPED exactly when it carried refusals', () => {
    // Reconstructed literally, including the 180-char slice the old code used.
    const old = (
      'gate.0:st.ok:ex1:of0:di0'
      + ':skip.none:ref.dial_not_allowlisted-consent_preflight_refused'
    ).slice(0, 180);
    expect(old.length).toBeGreaterThan(64);
    // A rejected field is OMITTED from the envelope, not emitted as null —
    // so the old diagnostic did not even leave a hole where its answer should
    // have been.
    const envelope = emitted({ error_type: 'phone_due_diag', error_category: old });
    expect(envelope).not.toHaveProperty('error_category');
  });

  it('…while the same old shape with NOTHING to report survived', () => {
    // The asymmetry is the whole defect: silence was reportable, trouble was not.
    const quiet = 'gate.0:st.ok:ex0:of0:di0:skip.none:ref.none';
    expect(quiet.length).toBeLessThanOrEqual(64);
    expect(emitted({ error_type: 'phone_due_diag', error_category: quiet }).error_category)
      .toBe(quiet);
  });
});

describe('the summary line survives at its worst case', () => {
  it('the widest counts still fit, and are not read as an identifier', () => {
    // Six digits is the clamp `runtime.ts` applies. It is not cosmetic: TEN
    // consecutive digits trip DEFENSE_RE's phone/card rule, which fires BEFORE
    // the format check and would drop the line for a reason no length
    // assertion would have found.
    const value = summary(999_999, 999_999, 999_999, true);
    expect(value.length).toBeLessThanOrEqual(64);
    expect(emitted({ error_type: 'phone_due_diag', error_category: value }).error_category)
      .toBe(value);
  });

  it('an UNCLAMPED count would have been dropped — the clamp is load-bearing', () => {
    // Ten digits in a row. Without the clamp a runaway counter would silence
    // the diagnostic in precisely the situation worth diagnosing.
    const unclamped = 'gate.1:ex1234567890:of0:di0';
    expect(emitted({ error_type: 'phone_due_diag', error_category: unclamped }))
      .not.toHaveProperty('error_category');
  });
});

describe('the status is its own value, so no status can outgrow the budget', () => {
  it('every RPC status survives on its own line', () => {
    // Driving the ENTIRE union, rather than a chosen example, is what makes
    // this hold for a status a later migration adds — and it is what caught
    // the first version of this fix, where `candidate_daily_attempt_exists`
    // pushed the composed summary to 67 characters and nulled it.
    expect(PHONE_RPC_STATUS_UNION.length).toBeGreaterThan(100);
    for (const status of PHONE_RPC_STATUS_UNION) {
      expect(
        emitted({ error_type: 'phone_due_status', error_category: status }).error_category,
        `${status} (${status.length} chars) was dropped`,
      ).toBe(status);
    }
  });

  it('the loop-level statuses are covered too', () => {
    for (const status of ['ok', 'halted', 'window_closed', 'degraded', 'unknown_status']) {
      expect(emitted({ error_type: 'phone_due_status', error_category: status }).error_category)
        .toBe(status);
    }
  });
});

describe('each refusal code is emitted on its own line, and survives', () => {
  it('every pre-claim deferral code fits as a value in its own right', () => {
    expect(PHONE_DEFERRAL_CODES.length).toBeGreaterThan(0);
    for (const code of PHONE_DEFERRAL_CODES) {
      expect(
        emitted({ error_type: 'phone_due_refusal', error_category: code }).error_category,
        `${code} was dropped`,
      ).toBe(code);
    }
  });

  it('every RPC refusal status fits as a value in its own right', () => {
    for (const status of PHONE_RPC_STATUS_UNION) {
      expect(
        emitted({ error_type: 'phone_due_refusal', error_category: status }).error_category,
        `${status} was dropped`,
      ).toBe(status);
    }
  });

  it('no code is anywhere near the limits, so the margin is real', () => {
    // Both vocabularies are closed and every member is short, underscored
    // snake_case — which is why emitting each code as a whole value needs no
    // trimming at all. Trimming was considered and REJECTED: a 64-char slice
    // of a long token is still 30+ alphanumerics in a row, so DEFENSE_RE would
    // null it anyway and the "safety" would be imaginary.
    for (const code of [...PHONE_DEFERRAL_CODES, ...PHONE_RPC_STATUS_UNION]) {
      expect(code.length, `${code} is close to the 64-char cap`).toBeLessThanOrEqual(48);
      expect(code, `${code} would trip the entropy defense`).not.toMatch(/[A-Za-z0-9]{30,}/);
    }
  });
});
