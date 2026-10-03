/**
 * Error copy. Two rules carry real operational weight:
 *
 *   1. A 429 is a pacing limit on the operator's own account. Reporting it as
 *      degraded service would turn a client-side problem into a false
 *      incident — and the phone routes sit on the default rate-limit bucket
 *      precisely so that polling the calendar cannot fake an outage.
 *   2. The mapped codes are an ALLOWLIST. An unmapped failure gets a generic
 *      sentence and its raw text is never printed, so nothing a future
 *      substrate error happens to carry can reach the DOM by default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from '../../../api';
import {
  isVersionConflict,
  phoneErrorMessage,
  phoneErrorRequiresRefresh,
} from '../phoneErrors';

describe('rate limiting is not a health signal', () => {
  it('says throttled and retry, and never says degraded or unavailable', () => {
    const msg = phoneErrorMessage(new ApiError('rate_limited', 429));
    expect(msg).toMatch(/too many requests/i);
    expect(msg).toMatch(/wait a moment|try again/i);
    expect(msg).toMatch(/not a problem with phone screening/i);
    expect(msg).not.toMatch(/degraded|outage|unavailable|down|incident/i);
  });

  it('prefers the 429 reading over any code the body carried', () => {
    // Status wins: a throttled response must not be re-read as a substrate
    // refusal just because it echoed one.
    expect(phoneErrorMessage(new ApiError('phone_read_error', 429))).toMatch(
      /too many requests/i,
    );
  });
});

describe('version conflict', () => {
  const err = new ApiError('version_conflict', 409);

  it('says the change was REFUSED, and never that nothing changed', () => {
    // On the reschedule path the API can answer version_conflict with
    // `appointment_rolled_back: false`, meaning a stray appointment was
    // inserted and could not be undone. The shared client keeps only the
    // error code, so this copy cannot tell the two cases apart — and must
    // therefore not assert the reassuring one.
    const msg = phoneErrorMessage(err);
    expect(msg).toMatch(/changed since/i);
    expect(msg).toMatch(/was refused/i);
    expect(msg).toMatch(/refreshed/i);
    expect(msg).not.toMatch(/nothing was changed/i);
  });

  it('is recognised, and demands a refresh before the next attempt', () => {
    expect(isVersionConflict(err)).toBe(true);
    expect(phoneErrorRequiresRefresh(err)).toBe(true);
    expect(isVersionConflict(new ApiError('not_live', 409))).toBe(false);
  });
});

describe('substrate refusals', () => {
  it.each([
    ['not_live', /no longer live/i],
    ['not_found', /no longer exists/i],
    ['appointment_exists', /already has a live appointment/i],
    ['slot_in_past', /in the past/i],
    ['window_closed', /outside the approved calling window/i],
    ['slot_straddles_ist_midnight', /cannot cross midnight/i],
    ['engagement_terminal', /final state/i],
    ['attempt_in_flight', /in progress/i],
    ['phone_screening_disabled', /turned off/i],
    ['slot_not_yet_eligible', /next eligible time/i],
    ['daily_attempt_exists', /maximum number of calls on that day/i],
  ])('maps %s to operator English', (code, pattern) => {
    expect(phoneErrorMessage(new ApiError(code, 409))).toMatch(pattern);
  });

  it('does not claim a change was applied when the outcome is unknown', () => {
    const msg = phoneErrorMessage(new ApiError('phone_rpc_unknown_status', 500));
    expect(msg).toMatch(/did not get a clear answer/i);
    expect(msg).toMatch(/refresh/i);
    expect(phoneErrorRequiresRefresh(new ApiError('phone_rpc_unknown_status', 500))).toBe(
      true,
    );
  });

  it('never claims an audit failure undid the mutation', () => {
    // `auditOrFail` compensates only where a callback is supplied, and none
    // of the three appointment routes supplies one. The row was written.
    const msg = phoneErrorMessage(new ApiError('phone_audit_write_failed', 500));
    expect(msg).toMatch(/may have been applied/i);
    expect(msg).not.toMatch(/it was not applied|was not applied/i);
    expect(phoneErrorRequiresRefresh(new ApiError('phone_audit_write_failed', 500))).toBe(
      true,
    );
  });

  it('re-reads after a refusal that proves the loaded state is stale', () => {
    // The UI hides both write controls when it believes an engagement is in
    // flight or terminal, so either refusal means the row on screen is stale.
    for (const code of ['attempt_in_flight', 'engagement_terminal']) {
      expect(phoneErrorRequiresRefresh(new ApiError(code, 409))).toBe(true);
    }
  });

  it('0114 (C5): the two booking refusals say the existing slot is untouched', () => {
    // Both are decided before any supersede, so a refused reschedule leaves
    // the old slot live. The copy must not let an operator think it is gone.
    for (const code of ['slot_not_yet_eligible', 'daily_attempt_exists']) {
      const msg = phoneErrorMessage(new ApiError(code, 409));
      expect(msg).toMatch(/existing appointment is unchanged/i);
      expect(msg).not.toMatch(/refused\. Refresh the calendar/i);
      expect(msg).not.toContain(code);
      expect(phoneErrorRequiresRefresh(new ApiError(code, 409))).toBe(false);
    }
  });

  it('flags only the refusals that actually invalidate the view', () => {
    expect(phoneErrorRequiresRefresh(new ApiError('slot_in_past', 409))).toBe(false);
    expect(phoneErrorRequiresRefresh(new ApiError('window_closed', 409))).toBe(false);
  });
});

/**
 * Owner request 2026-10-03 (S03 P9): candidate-page booking refusals used to
 * fall to the generic "The request was refused. Refresh … try again" line,
 * which sends an operator round a retry loop that can never succeed. Each one
 * now says what happened and what to do.
 */
const GENERIC_RE = /^The request was refused\. Refresh the calendar and try again/;

describe('candidate-page booking refusals (P9)', () => {
  it.each([
    ['rescreen_required', /call cycle has ended.*Use Rescreen first, then book a slot/i, 409, true],
    ['application_not_live', /application is no longer active/i, 409, true],
    ['application_not_found', /no active application/i, 409, true],
    ['candidate_not_found', /could not be found/i, 404, true],
    ['prerequisites_unavailable', /could not be set up/i, 409, false],
    ['invalid_request', /could not be attributed to your account/i, 409, false],
    ['duplicate_application', /another candidate record.*Release the duplicate-application hold/i, 409, true],
    ['phone_schedule_unavailable', /could not be reached, so nothing was booked/i, 503, false],
    ['appointment_not_found', /no longer exists for this candidate/i, 404, true],
    ['slot_not_yet_eligible', /next eligible time/i, 409, false],
    ['daily_attempt_exists', /maximum number of calls on that day/i, 409, false],
  ] as const)('maps %s to specific operator copy', (code, pattern, status, refresh) => {
    const err = new ApiError(code, status);
    const msg = phoneErrorMessage(err);
    expect(msg).toMatch(pattern);
    expect(msg).not.toMatch(GENERIC_RE);
    // The copy is English, never the raw code.
    expect(msg).not.toContain(code);
    expect(phoneErrorRequiresRefresh(err)).toBe(refresh);
  });

  it('uses the exact owner-approved rescreen sentence', () => {
    expect(phoneErrorMessage(new ApiError('rescreen_required', 409))).toBe(
      "This candidate's call cycle has ended. Use Rescreen first, then book a slot.",
    );
  });

  it('never names the other candidate record on a duplicate hold', () => {
    const msg = phoneErrorMessage(new ApiError('duplicate_application', 409));
    expect(msg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(msg).not.toMatch(/@|\+\d/);
  });

  it('keeps 403, 429 and transport handling ahead of any booking code', () => {
    for (const code of ['rescreen_required', 'duplicate_application', 'slot_not_yet_eligible']) {
      expect(phoneErrorMessage(new ApiError(code, 403))).toMatch(/role does not allow/i);
      expect(phoneErrorMessage(new ApiError(code, 429))).toMatch(/too many requests/i);
      expect(phoneErrorMessage(new ApiError(code, 0))).toMatch(/could not be reached/i);
    }
  });
});

/**
 * Cross-package guard: every refusal `schedule_phone_appointment` and
 * `schedule_candidate_phone_appointment` can return (the API's closed status
 * vocabularies in rpc-contract.ts) must have specific copy. The loop is
 * driven by the API source, never by the web map, so a new SQL status that
 * the web side has never heard of turns this red instead of reaching an
 * operator as the generic sentence.
 */
describe('every booking RPC status has specific copy', () => {
  const RPC_CONTRACT_PATH = resolve(
    __dirname,
    '../../../../../api/src/lib/phone-screening/rpc-contract.ts',
  );
  const SUCCESS = new Set(['ok', 'ok_prereqs_pending']);

  function extractArray(src: string, name: string): string[] {
    const match = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
    if (!match) throw new Error(`${name} not found in rpc-contract.ts`);
    const constants = new Map<string, string>();
    for (const m of src.matchAll(/export const (\w+) = '([a-z_]+)' as const;/g)) {
      constants.set(m[1], m[2]);
    }
    return match[1]
      .split(',')
      .map((raw) => raw.replace(/\/\/.*$/gm, '').trim())
      .filter(Boolean)
      .map((token) => {
        const literal = /^'([a-z_]+)'$/.exec(token);
        if (literal) return literal[1];
        const resolved = constants.get(token);
        if (!resolved) throw new Error(`unresolved status token ${token} in ${name}`);
        return resolved;
      });
  }

  const src = readFileSync(RPC_CONTRACT_PATH, 'utf8');
  const hrStatuses = extractArray(src, 'SCHEDULE_PHONE_APPOINTMENT_STATUSES');
  const candidateOwn = extractArray(src, 'SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_OWN_STATUSES');
  const refusals = [...new Set([...hrStatuses, ...candidateOwn])].filter((s) => !SUCCESS.has(s));

  it('extracts the real vocabularies (non-vacuous)', () => {
    expect(hrStatuses).toContain('ok');
    expect(hrStatuses).toContain('slot_not_yet_eligible');
    expect(hrStatuses).toContain('daily_attempt_exists');
    expect(candidateOwn).toContain('rescreen_required');
    expect(candidateOwn).toContain('duplicate_application');
    expect(refusals.length).toBeGreaterThanOrEqual(20);
  });

  it.each(refusals.map((s) => [s]))('%s renders specific copy', (code) => {
    const msg = phoneErrorMessage(new ApiError(code, 409));
    expect(msg).not.toMatch(GENERIC_RE);
    expect(msg).not.toContain(code);
  });

  it('the generic fallback still applies to an unmapped code', () => {
    expect(phoneErrorMessage(new ApiError('not_a_real_status', 409))).toMatch(GENERIC_RE);
  });
});

describe('the mapped set is an allowlist', () => {
  it('never echoes an unmapped code into the copy', () => {
    const leaky = new ApiError('sip_call_id=abc-123 room=phone-room-9', 500);
    const msg = phoneErrorMessage(leaky);
    expect(msg).not.toContain('sip_call_id');
    expect(msg).not.toContain('abc-123');
    expect(msg).not.toContain('phone-room-9');
    expect(msg).toMatch(/refused/i);
  });

  it('does not resolve an inherited Object property as a message', () => {
    // A bare index into an object literal returns `Object.prototype.toString`
    // for a server code of `toString` — a Function typed as a string, which
    // React then refuses to render, blanking the page.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const msg = phoneErrorMessage(new ApiError(key, 500));
      expect(typeof msg).toBe('string');
      expect(msg).toMatch(/refused/i);
    }
  });

  it('handles a non-ApiError without throwing', () => {
    expect(phoneErrorMessage(new Error('boom'))).toMatch(/refused/i);
    expect(phoneErrorMessage(null)).toMatch(/refused/i);
    expect(phoneErrorMessage(undefined)).toMatch(/refused/i);
    expect(phoneErrorRequiresRefresh(new Error('boom'))).toBe(false);
  });
});

describe('permission and transport', () => {
  it('states a 403 as a role fact rather than a fault', () => {
    const msg = phoneErrorMessage(new ApiError('forbidden', 403));
    expect(msg).toMatch(/role does not allow/i);
    expect(msg).toMatch(/reads stay available/i);
  });

  it('describes a transport failure as unreachable, not as a refusal', () => {
    expect(phoneErrorMessage(new ApiError('Could not reach the server', 0))).toMatch(
      /could not be reached/i,
    );
  });
});
