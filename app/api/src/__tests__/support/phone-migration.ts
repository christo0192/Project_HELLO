/**
 * Test support: deterministic extraction from the phone migrations.
 *
 * The drift tests read the MIGRATION TEXT rather than a hand-copied list, so a
 * migration that adds a status, widens a CHECK or renames a parameter turns
 * the TypeScript unions red instead of turning a benign refusal into a thrown
 * error on a billable path. Every extractor here is fail-closed: a missing
 * anchor throws rather than yielding an empty set that would make an
 * assertion pass vacuously.
 *
 * ── WHY THIS IS MIGRATION-AWARE RATHER THAN 0042-ONLY ─────────────────
 * 0043 does what a forward-only migration is supposed to do: it RE-DECLARES
 * two CHECKs in full and REPLACES one function body. So for anything it
 * touches, 0042's text is no longer what the database enforces — it is
 * history.
 *
 * An extractor pinned to 0042 would therefore keep reading the OLD
 * declaration and keep passing while the TypeScript union and the live schema
 * diverged. That is strictly worse than no drift test, because it still reads
 * like one. The lesson is the one P3 recorded when its own tripwire had to
 * change: a tripwire that cannot fire once the thing it guards moves is not a
 * weaker control, it is a misleading one.
 *
 * 0044 does it a second time: it REPLACES `apply_phone_event` again, so for
 * that function 0043's text is now history too.
 *
 * So extraction searches migrations NEWEST-FIRST and the newest declaration
 * wins — exactly the resolution order Postgres itself applies. Adding a phone
 * migration means adding one line to `PHONE_MIGRATIONS`, whose contents are
 * asserted non-empty at import so a missing file fails loudly rather than
 * making every extractor return nothing.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIGRATION_0042_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0042_phone_screening.sql', import.meta.url),
);

export const MIGRATION_0042 = readFileSync(MIGRATION_0042_PATH, 'utf8');

export const MIGRATION_0043_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0043_phone_safe_dialer.sql', import.meta.url),
);

export const MIGRATION_0043 = readFileSync(MIGRATION_0043_PATH, 'utf8');

export const MIGRATION_0044_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0044_phone_assessment_resume.sql', import.meta.url),
);

export const MIGRATION_0044 = readFileSync(MIGRATION_0044_PATH, 'utf8');

export const MIGRATION_0045_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0045_phone_runtime_liveness.sql', import.meta.url),
);

export const MIGRATION_0045 = readFileSync(MIGRATION_0045_PATH, 'utf8');

export const MIGRATION_0051_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0051_phone_session_egress_stamp.sql', import.meta.url),
);

export const MIGRATION_0051 = readFileSync(MIGRATION_0051_PATH, 'utf8');

export const MIGRATION_0052_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0052_phone_turn_timing.sql', import.meta.url),
);

export const MIGRATION_0052 = readFileSync(MIGRATION_0052_PATH, 'utf8');

export const MIGRATION_0057_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0057_phone_rescreen_cycles.sql', import.meta.url),
);

export const MIGRATION_0057 = readFileSync(MIGRATION_0057_PATH, 'utf8');

export const MIGRATION_0060_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0060_phone_cagv_contract.sql', import.meta.url),
);

export const MIGRATION_0060 = readFileSync(MIGRATION_0060_PATH, 'utf8');

export const MIGRATION_0061_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0061_phone_consent_start.sql', import.meta.url),
);

export const MIGRATION_0061 = readFileSync(MIGRATION_0061_PATH, 'utf8');

export const MIGRATION_0063_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0063_phone_candidate_test_gate.sql', import.meta.url),
);

export const MIGRATION_0063 = readFileSync(MIGRATION_0063_PATH, 'utf8');

export const MIGRATION_0064_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0064_phone_temporary_247_window.sql', import.meta.url),
);

export const MIGRATION_0064 = readFileSync(MIGRATION_0064_PATH, 'utf8');

export const MIGRATION_0065_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0065_phone_speakable_parity.sql', import.meta.url),
);

export const MIGRATION_0065 = readFileSync(MIGRATION_0065_PATH, 'utf8');

export const MIGRATION_0066_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0066_phone_directive_topics.sql', import.meta.url),
);

export const MIGRATION_0066 = readFileSync(MIGRATION_0066_PATH, 'utf8');

export const MIGRATION_0067_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0067_phone_full_call_capture.sql', import.meta.url),
);

export const MIGRATION_0067 = readFileSync(MIGRATION_0067_PATH, 'utf8');

export const MIGRATION_0068_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0068_phone_voice_callback_confirmation.sql', import.meta.url),
);

export const MIGRATION_0068 = readFileSync(MIGRATION_0068_PATH, 'utf8');

export const MIGRATION_0070_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0070_phone_gate_free_resume_context.sql', import.meta.url),
);

export const MIGRATION_0070 = readFileSync(MIGRATION_0070_PATH, 'utf8');

export const MIGRATION_0071_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0071_phone_persistence_finalization.sql', import.meta.url),
);

export const MIGRATION_0071 = readFileSync(MIGRATION_0071_PATH, 'utf8');

export const MIGRATION_0072_PATH = fileURLToPath(
  new URL('../../../../supabase/migrations/0072_phone_partial_assessment.sql', import.meta.url),
);

export const MIGRATION_0072 = readFileSync(MIGRATION_0072_PATH, 'utf8');

/**
 * Every phone migration, NEWEST FIRST. Extraction walks this in order and the
 * first file that declares a thing wins, which is what "the latest declaration
 * is the effective one" means in a forward-only scheme.
 */
export const PHONE_MIGRATIONS: readonly { readonly name: string; readonly sql: string }[] =
  Object.freeze([
    // 0072 adds finalize_phone_partial_sessions (server-side partial-finalize)
    // and the assessments.partial column. Newest-first so its declaration wins.
    { name: '0072', sql: MIGRATION_0072 },
    // 0071 re-declares commit_phone_question_boundary (authorship-guarded turn
    // insert) and reclaim_phone_attempt_leases (crashed-session terminalize) in
    // full, and adds commit_phone_item_turn + sweep_phone_stranded_recordings,
    // so it must be NEWEST-FIRST for the extractor to read the effective bodies.
    { name: '0071', sql: MIGRATION_0071 },
    // 0070 re-declares get_phone_assessment_state in full (is_gate-filtered
    // resume turns + the gate_recorded signal), so it must be NEWEST-FIRST for
    // the extractor to read the effective body rather than 0049's.
    { name: '0070', sql: MIGRATION_0070 },
    { name: '0068', sql: MIGRATION_0068 },
    { name: '0067', sql: MIGRATION_0067 },
    { name: '0066', sql: MIGRATION_0066 },
    { name: '0065', sql: MIGRATION_0065 },
    { name: '0064', sql: MIGRATION_0064 },
    { name: '0063', sql: MIGRATION_0063 },
    { name: '0061', sql: MIGRATION_0061 },
    { name: '0060', sql: MIGRATION_0060 },
    { name: '0057', sql: MIGRATION_0057 },
    // NOTE (residual, pre-existing): 0046–0050 are not registered here, so
    // declarations they carry (e.g. 0050's re-definition of
    // attach_phone_attempt_recording) are invisible to the extractor and the
    // 0043 originals win. 0051 is registered because its RPC exists NOWHERE
    // earlier — without this line the contract test could not see it at all.
    { name: '0052', sql: MIGRATION_0052 },
    { name: '0051', sql: MIGRATION_0051 },
    { name: '0045', sql: MIGRATION_0045 },
    { name: '0044', sql: MIGRATION_0044 },
    { name: '0043', sql: MIGRATION_0043 },
    { name: '0042', sql: MIGRATION_0042 },
  ]);

if (PHONE_MIGRATIONS.length === 0 || PHONE_MIGRATIONS.some((m) => m.sql.length === 0)) {
  // Fail at import rather than letting every extractor return nothing and
  // every assertion pass against an empty set.
  throw new Error('phone migration sources missing or empty');
}

/**
 * All phone migration text concatenated, for `toContain`-style checks where
 * "is this declared ANYWHERE in the phone schema" is the real question — a
 * grant, a reason literal — as opposed to "which declaration is effective",
 * which is what the newest-first extractors answer.
 */
export const PHONE_MIGRATIONS_TEXT: string = PHONE_MIGRATIONS.map((m) => m.sql).join('\n');

/**
 * RPCs that take no injected clock because they read and decide nothing that
 * depends on time. Enumerated rather than inferred, so adding a
 * time-dependent RPC without `p_now` fails instead of being quietly excused.
 */
export const CLOCK_FREE_RPCS: readonly string[] = Object.freeze([
  'list_phone_engagement_recordings',
  // 0044: a pure read. Nothing it decides depends on time.
  'get_phone_assessment_state',
  // 0045: a constant. It answers how long a phone `waiting` session may
  // legitimately live, which is a property of the ladder, not of the clock.
  'phone_stale_session_seconds',
]);

/**
 * The newest migration text that contains `anchor`, with the migration name so
 * a failure says WHICH file the value came from.
 */
function newestContaining(anchor: string, what: string): { name: string; sql: string } {
  for (const migration of PHONE_MIGRATIONS) {
    if (migration.sql.includes(anchor)) return migration;
  }
  throw new Error(`no phone migration declares ${what}`);
}

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

/** The service-role RPCs, in the order the migrations declare them. */
export const RPC_NAMES = [
  'admit_phone_attempt',
  'heartbeat_phone_attempt',
  'reclaim_phone_attempt_leases',
  'apply_phone_event',
  'schedule_phone_appointment',
  'confirm_candidate_voice_callback',
  'cancel_phone_appointment',
  'set_phone_halt',
  'clear_phone_halt',
  'expire_phone_appointments',
  'phone_backlog',
  // 0043.
  'attach_phone_attempt_recording',
  'finalize_phone_attempt_recording',
  'list_phone_engagement_recordings',
  'clear_phone_attempt_recordings',
  // 0051 — the session-level egress stamp.
  'stamp_phone_session_egress',
  // 0044.
  'start_phone_assessment',
  'get_phone_assessment_state',
  'commit_phone_question_boundary',
  // 0045 — the two obligations 0042 assigned to P5, plus the sweep claim.
  'heartbeat_phone_attempt_by_epoch',
  'sweep_phone_day_rolled',
  'sweep_phone_stranded_sessions',
  'claim_phone_sweep',
  // 0057 — explicit cycle door. PII-bearing number verification is
  // intentionally outside the phone-domain RPC contract.
  'request_phone_rescreen',
  'arm_phone_test_gate',
  'admit_phone_test_attempt',
  'record_phone_probe',
  'consent_and_start_phone_assessment',
  // 0071 — per-item transcript persistence (X4) and the crashed-session
  // recording-finalization backstop sweep (X5).
  'commit_phone_item_turn',
  'sweep_phone_stranded_recordings',
  // 0072 — server-side partial-finalize on a non-terminal-ending call.
  'finalize_phone_partial_sessions',
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
  const { name: from, sql } = newestContaining(anchor, `function ${name}`);
  const start = sql.indexOf(anchor);
  const multiLine = sql.indexOf('\n$$;', start);
  const inline = sql.indexOf('$$;', start + anchor.length);
  const candidates = [multiLine, inline].filter((i) => i !== -1);
  if (candidates.length === 0) throw new Error(`${from} function unterminated: ${name}`);
  const end = Math.min(...candidates);
  const body = sql.slice(start, end);
  // Fail closed on any remaining over-capture: a body must contain exactly one
  // function header, its own.
  const headers = [...body.matchAll(/create or replace function screening_v2\.\w+\(/g)];
  if (headers.length !== 1) {
    throw new Error(`${from} function body over-captured: ${name} (${headers.length} headers)`);
  }
  return body;
}

/** Parameter names of an RPC, in declaration order, read from its signature. */
export function functionParameters(name: string): string[] {
  const body = functionBody(name);
  const open = body.indexOf('(');
  const close = body.indexOf(')\nreturns');
  if (open === -1 || close === -1) throw new Error(`phone signature unreadable: ${name}`);
  const params = body.slice(open + 1, close);
  return [...params.matchAll(/(?:^|,)\s*(p_[a-z0-9_]+)\s/g)].map((m) => m[1]);
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
      if (q === -1) throw new Error(`phone unterminated status literal in ${name}`);
      out.add(body.slice(p + 1, q));
    } else if (body.startsWith('case', p)) {
      const e = body.indexOf(' end', p);
      if (e === -1) throw new Error(`phone unterminated status case in ${name}`);
      for (const lit of body.slice(p, e).matchAll(/(?:then|else)\s*'([a-z_]+)'/g)) out.add(lit[1]);
    } else {
      throw new Error(`phone unrecognised status form in ${name}`);
    }
  }
  if (out.size === 0) throw new Error(`phone no statuses extracted for ${name}`);
  return out;
}

/**
 * The members of a closed `check (... in ('a','b',...))` constraint, read by
 * constraint name. Throws when the anchor or the list delimiters are missing.
 */
export function checkMembers(constraintName: string): string[] {
  // `add constraint <name>` is how a RE-DECLARATION reads; `constraint <name>`
  // is how an inline table-definition one does. The re-declaration form is
  // tried first within each migration, so 0043's widened list wins over the
  // inline 0042 one even though both live in files this walks.
  const addAnchor = `add constraint ${constraintName}`;
  const inlineAnchor = `constraint ${constraintName}`;
  let from = '';
  let sql = '';
  let start = -1;
  for (const migration of PHONE_MIGRATIONS) {
    const added = migration.sql.indexOf(addAnchor);
    const inline = migration.sql.indexOf(inlineAnchor);
    const hit = added !== -1 ? added : inline;
    if (hit !== -1) {
      from = migration.name;
      sql = migration.sql;
      start = hit;
      break;
    }
  }
  if (start === -1) throw new Error(`no phone migration declares constraint: ${constraintName}`);
  const open = sql.indexOf(' in (', start);
  if (open === -1) throw new Error(`${from} constraint has no IN list: ${constraintName}`);
  // The list may span lines and carry `--` comments between members (0043
  // does), so scan to the MATCHING close paren rather than the first one, and
  // strip comments before reading literals — a comment mentioning a value in
  // quotes would otherwise be read as a member.
  let depth = 1;
  let i = open + 5;
  for (; i < sql.length && depth > 0; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') depth -= 1;
  }
  if (depth !== 0) throw new Error(`${from} constraint list unterminated: ${constraintName}`);
  const list = sql.slice(open + 5, i - 1).replace(/--[^\n]*/g, '');
  const members = [...list.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
  if (members.length === 0) throw new Error(`${from} constraint list empty: ${constraintName}`);
  return members;
}

/**
 * The single literal a one-line SQL helper returns, e.g. `select time
 * '09:00:00'`. The trailing `$$` is now outside the extracted body (it sits on
 * the terminator), so the pattern reads to the end of the value.
 */
export function helperLiteral(name: string): string {
  const body = functionBody(name);
  const m = /as \$\$\s*select\s+(?:time\s+)?'?([^'\s]+)'?\s*(?:\$\$)?\s*$/.exec(body.trim());
  if (!m) throw new Error(`phone helper literal unreadable: ${name}`);
  return m[1];
}
