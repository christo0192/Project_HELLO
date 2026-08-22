/**
 * Test support: deterministic extraction from `0042_phone_screening.sql`.
 *
 * The drift tests read the MIGRATION TEXT rather than a hand-copied list, so a
 * migration that adds a status, widens a CHECK or renames a parameter turns
 * the TypeScript unions red instead of turning a benign refusal into a thrown
 * error on a billable path. Every extractor here is fail-closed: a missing
 * anchor throws rather than yielding an empty set that would make an
 * assertion pass vacuously.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIGRATION_0042_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0042_phone_screening.sql', import.meta.url),
);

export const MIGRATION_0042 = readFileSync(MIGRATION_0042_PATH, 'utf8');

/** 0013 owns the consent vocabulary the phone lane only MIRRORS. */
export const MIGRATION_0013 = readFileSync(
  fileURLToPath(
    new URL('../../../../supabase/migrations/0013_consent_classification.sql', import.meta.url),
  ),
  'utf8',
);

/** Members of the `screening_v2.consent_type` enum, read from 0013. */
export function consentTypeEnumMembers(): string[] {
  const anchor = 'create type screening_v2.consent_type as enum (';
  const start = MIGRATION_0013.indexOf(anchor);
  if (start === -1) throw new Error('0013 consent_type enum missing');
  const end = MIGRATION_0013.indexOf(');', start);
  if (end === -1) throw new Error('0013 consent_type enum unterminated');
  const members = [...MIGRATION_0013.slice(start + anchor.length, end)
    .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (members.length === 0) throw new Error('0013 consent_type enum empty');
  return members;
}

/** Members of the `consent_records.status` CHECK, read from 0013. */
export function consentStatusMembers(): string[] {
  const anchor = "add column if not exists status text not null default 'granted'";
  const start = MIGRATION_0013.indexOf(anchor);
  if (start === -1) throw new Error('0013 consent status column missing');
  const open = MIGRATION_0013.indexOf('check (status in (', start);
  if (open === -1) throw new Error('0013 consent status CHECK missing');
  const close = MIGRATION_0013.indexOf(')', open + 18);
  const members = [...MIGRATION_0013.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (members.length === 0) throw new Error('0013 consent status CHECK empty');
  return members;
}

/** The ten service-role RPCs, in the order 0042 declares them. */
export const RPC_NAMES = [
  'admit_phone_attempt',
  'heartbeat_phone_attempt',
  'reclaim_phone_attempt_leases',
  'apply_phone_event',
  'schedule_phone_appointment',
  'cancel_phone_appointment',
  'set_phone_halt',
  'clear_phone_halt',
  'expire_phone_appointments',
  'phone_backlog',
] as const;

/**
 * The body of one `create or replace function`, from its header to its own
 * terminator.
 *
 * Two hazards, both of which bit an earlier draft and both of which are why
 * this is not a bare `indexOf`:
 *
 *   * PREFIX COLLISION. `phone_ist_window_open` is a strict prefix of
 *     `phone_ist_window_open_at`, which 0042 declares FIRST, so anchoring on
 *     the name alone locked onto the wrong function and returned a blob
 *     spanning three helpers. The anchor therefore includes the open paren.
 *   * TERMINATOR. The one-line helpers close with an inline `$$;` on the same
 *     line as the body (`as $$ select time '09:00:00' $$;`) and have no
 *     `\n$$;` at all, so a newline-only terminator ran on into the NEXT
 *     function. Both forms are accepted, and the nearer one wins.
 *
 * A self-test in `phone-screening-rpc-contract.test.ts` asserts both hazards
 * stay closed, because an over-broad body makes every `toContain` assertion
 * built on it validate a different object than it names.
 */
export function functionBody(name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = MIGRATION_0042.indexOf(anchor);
  if (start === -1) throw new Error(`0042 function missing: ${name}`);
  const multiLine = MIGRATION_0042.indexOf('\n$$;', start);
  const inline = MIGRATION_0042.indexOf('$$;', start + anchor.length);
  const candidates = [multiLine, inline].filter((i) => i !== -1);
  if (candidates.length === 0) throw new Error(`0042 function unterminated: ${name}`);
  const end = Math.min(...candidates);
  const body = MIGRATION_0042.slice(start, end);
  // Fail closed on any remaining over-capture: a body must contain exactly one
  // function header, its own.
  const headers = [...body.matchAll(/create or replace function screening_v2\.\w+\(/g)];
  if (headers.length !== 1) {
    throw new Error(`0042 function body over-captured: ${name} (${headers.length} headers)`);
  }
  return body;
}

/** Parameter names of an RPC, in declaration order, read from its signature. */
export function functionParameters(name: string): string[] {
  const body = functionBody(name);
  const open = body.indexOf('(');
  const close = body.indexOf(')\nreturns');
  if (open === -1 || close === -1) throw new Error(`0042 signature unreadable: ${name}`);
  const params = body.slice(open + 1, close);
  return [...params.matchAll(/(?:^|,)\s*(p_[a-z_]+)\s/g)].map((m) => m[1]);
}

/**
 * Every `status` literal one RPC can return.
 *
 * Two forms are recognised, and only two, because only two exist: a direct
 * `'status', 'literal'`, and a `case ... then 'a' else 'b' end`. The case form
 * is read from its `then`/`else` results ONLY — its CONDITION also contains
 * quoted literals (`v_eng.state = 'scheduled'`), and counting those would add
 * a status the RPC cannot actually return.
 */
export function functionStatuses(name: string): Set<string> {
  const body = functionBody(name);
  const out = new Set<string>();
  const marker = /'status'\s*,\s*/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(body)) !== null) {
    const p = m.index + m[0].length;
    if (body[p] === "'") {
      const q = body.indexOf("'", p + 1);
      if (q === -1) throw new Error(`0042 unterminated status literal in ${name}`);
      out.add(body.slice(p + 1, q));
    } else if (body.startsWith('case', p)) {
      const e = body.indexOf(' end', p);
      if (e === -1) throw new Error(`0042 unterminated status case in ${name}`);
      for (const lit of body.slice(p, e).matchAll(/(?:then|else)\s*'([a-z_]+)'/g)) out.add(lit[1]);
    } else {
      throw new Error(`0042 unrecognised status form in ${name}`);
    }
  }
  if (out.size === 0) throw new Error(`0042 no statuses extracted for ${name}`);
  return out;
}

/**
 * The members of a closed `check (... in ('a','b',...))` constraint, read by
 * constraint name. Throws when the anchor or the list delimiters are missing.
 */
export function checkMembers(constraintName: string): string[] {
  const anchor = `constraint ${constraintName}`;
  const start = MIGRATION_0042.indexOf(anchor);
  if (start === -1) throw new Error(`0042 constraint missing: ${constraintName}`);
  const open = MIGRATION_0042.indexOf(' in (', start);
  if (open === -1) throw new Error(`0042 constraint has no IN list: ${constraintName}`);
  const close = MIGRATION_0042.indexOf(')', open + 5);
  if (close === -1) throw new Error(`0042 constraint list unterminated: ${constraintName}`);
  const list = MIGRATION_0042.slice(open + 5, close);
  return [...list.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

/**
 * The single literal a one-line SQL helper returns, e.g. `select time
 * '09:00:00'`. The trailing `$$` is now outside the extracted body (it sits on
 * the terminator), so the pattern reads to the end of the value.
 */
export function helperLiteral(name: string): string {
  const body = functionBody(name);
  const m = /as \$\$\s*select\s+(?:time\s+)?'?([^'\s]+)'?\s*(?:\$\$)?\s*$/.exec(body.trim());
  if (!m) throw new Error(`0042 helper literal unreadable: ${name}`);
  return m[1];
}
