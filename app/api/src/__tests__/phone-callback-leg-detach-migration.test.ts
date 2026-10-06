/**
 * 0113 / M009 E4 — the callback-leg detach, asserted against the migration
 * TEXT (B3).
 *
 * WHY THIS EXISTS: 0113 re-declares four large function bodies lifted from
 * older migrations (confirm from 0073, finalize from 0095, the stranded sweep
 * from 0045, and E6's apply_phone_event from 0095). A transcription slip in a lift silently reverts behaviour that
 * no E4 test looks at, so the first block proves each 0113 body is its source
 * body with lines only ADDED, apart from a short, named list of lines the fix
 * had to rewrite. The second block pins the E4 edits themselves, and the
 * third pins that the one-time data repair which policy_tests.sql replays is
 * the migration's own text, not a paraphrase of it.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (0113-E4-*);
 * text is not execution.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  MIGRATION_0045,
  MIGRATION_0072,
  MIGRATION_0073,
  MIGRATION_0095,
  MIGRATION_0113,
  MIGRATION_0114,
  MIGRATION_0115,
  functionBody,
  functionParameters,
} from './support/phone-migration.js';

const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const M0113 = lf(MIGRATION_0113);
const M0114 = lf(MIGRATION_0114);
const M0115 = lf(MIGRATION_0115);
const POLICY_TESTS = lf(
  readFileSync(
    fileURLToPath(new URL('../../../supabase/tests/policy_tests.sql', import.meta.url)),
    'utf8',
  ),
);

/** One function's text in ONE migration: header through its closing `$$;`. */
function bodyIn(sql: string, name: string): string {
  const text = lf(sql);
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = text.indexOf(anchor);
  if (start === -1) throw new Error(`${name} not declared`);
  if (text.indexOf(anchor, start + 1) !== -1) throw new Error(`${name} declared twice`);
  const end = text.indexOf('\n$$;', start);
  if (end === -1) throw new Error(`${name} unterminated`);
  return text.slice(start, end + '\n$$;'.length);
}

/**
 * The source body's lines, minus `rewritten`, must appear in the target body
 * IN ORDER (a subsequence). Returns the first source line that cannot be
 * placed, or null — so a failure names the exact line that was lost.
 */
function firstLostLine(source: string, target: string, rewritten: readonly string[]): string | null {
  const want = source.split('\n').filter((l) => !rewritten.includes(l));
  const have = target.split('\n');
  let j = 0;
  for (const line of want) {
    while (j < have.length && have[j] !== line) j += 1;
    if (j === have.length) return line;
    j += 1;
  }
  return null;
}

/** Lines the target ADDED (present in target, not consumed by the source). */
function addedLines(source: string, target: string): string[] {
  const src = source.split('\n');
  const out: string[] = [];
  let i = 0;
  for (const line of target.split('\n')) {
    if (i < src.length && src[i] === line) i += 1;
    else out.push(line);
  }
  return out;
}

const LIFTS = [
  {
    name: 'confirm_candidate_voice_callback',
    from: MIGRATION_0073,
    // The audit metadata's closing line gains two keys, so its `));` moves.
    rewritten: ["                                    'superseded', v_live.id is not null));"],
  },
  {
    name: 'finalize_phone_partial_sessions',
    from: MIGRATION_0095,
    // The expired arm gains the NOT EXISTS; the session object gains a key.
    rewritten: [
      "         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout')",
      "      'recording_present',  v_recording_present);",
    ],
  },
  {
    name: 'sweep_phone_stranded_sessions',
    from: MIGRATION_0045,
    rewritten: [],
  },
  {
    // E6's ledger edge (B1). ~720 lines lifted verbatim from 0095; the only
    // change is ONE new `when` arm, pinned below. Without this entry a rebase
    // or merge-fix that drops a charge-ladder arm would pass vitest.
    name: 'apply_phone_event',
    from: MIGRATION_0095,
    rewritten: [],
  },
] as const;

describe('0113 E4 — every lifted body is its source plus additions only', () => {
  for (const lift of LIFTS) {
    it(`${lift.name}: no source line is lost or altered beyond the named rewrites`, () => {
      const source = bodyIn(lift.from, lift.name);
      const target = bodyIn(M0113, lift.name);
      expect(firstLostLine(source, target, lift.rewritten)).toBeNull();
      // Every named rewrite really is gone (else the allowance is stale).
      for (const line of lift.rewritten) expect(target.split('\n')).not.toContain(line);
    });

    it(`${lift.name}: is the body the drift extractors resolve (0113, or the newest re-lift)`, () => {
      // 0114 (M009 PR-C) re-lifts apply_phone_event, finalize and sweep from
      // 0113, and 0115 (M013 S02 §4) re-lifts finalize from 0114 (their own
      // structural tests pin those diffs); everything else 0113 owns must
      // still resolve to 0113.
      const declares = (sql: string) =>
        sql.includes(`create or replace function screening_v2.${lift.name}(`);
      const newest = declares(M0115) ? M0115 : declares(M0114) ? M0114 : M0113;
      expect(lf(functionBody(lift.name))).toBe(bodyIn(newest, lift.name).slice(0, -'\n$$;'.length));
    });
  }

  it('adds no machine-clock read to any lifted body', () => {
    for (const lift of LIFTS) {
      const added = addedLines(bodyIn(lift.from, lift.name), bodyIn(M0113, lift.name)).join('\n');
      expect(added, lift.name).not.toMatch(/\b(now|clock_timestamp|statement_timestamp)\s*\(|current_(timestamp|date)\b/i);
    }
  });

  it('restates each ACL exactly as the source did (service_role only)', () => {
    const acl = (name: string, args: string) => [
      `revoke all on function screening_v2.${name}(${args})`,
      `grant execute on function screening_v2.${name}(${args})`,
    ];
    for (const line of acl('confirm_candidate_voice_callback', 'uuid, timestamptz, timestamptz')) {
      expect(M0113).toContain(line);
    }
    for (const line of acl('finalize_phone_partial_sessions', 'integer, integer, timestamptz')) {
      expect(lf(MIGRATION_0072)).toContain(line);
      expect(M0113).toContain(line);
    }
    expect(M0113).toContain(
      'revoke all on function screening_v2.sweep_phone_stranded_sessions(integer, timestamptz, integer) from public, anon, authenticated;',
    );
    expect(M0113).toContain(
      'grant execute on function screening_v2.sweep_phone_stranded_sessions(integer, timestamptz, integer) to service_role;',
    );
    expect(M0113).not.toMatch(/grant\s+execute[^;]*\bto\s+(anon|authenticated|public)\b/i);
  });
});

describe('0113 E6 — apply_phone_event gains only the pre-answer branch', () => {
  const added = addedLines(
    bodyIn(MIGRATION_0095, 'apply_phone_event'),
    bodyIn(M0113, 'apply_phone_event'),
  );
  const code = added.filter((line) => line.trim() !== '' && !line.trim().startsWith('--'));

  it('adds exactly one new arm, fenced to a pre-answer attempt', () => {
    // Top-level CASE arms sit at 6 spaces; the inner outcome/charge CASEs nest deeper.
    expect(code.filter((line) => /^ {6}when\s/.test(line))).toEqual([
      "      when v_eng.state = 'dialing'",
    ]);
    expect(code).toContain("           and p_event_type in ('call.no_answer','call.busy','call.failed')");
    expect(code).toContain("           and v_att.state in ('admitted','ringing')");
    expect(code).toContain('           and v_att.answered_at is null then');
  });

  it('touches no existing arm: no added line re-states a provider edge or the stranded logic', () => {
    for (const line of code) {
      expect(line).not.toMatch(/sip\.originate_|sip\.participant_|v_stranded|assessment\.(completed|aborted)/);
    }
    // Only the three state/outcome/charge assignments, plus their CASE arms.
    expect(code.filter((line) => line.includes(':='))).toEqual([
      "        v_att_state := 'ended';",
      '        v_outcome   := case p_event_type',
      '        v_charge    := case p_event_type',
    ]);
  });
});

describe('0113 E4 — the edits themselves', () => {
  const confirm = bodyIn(M0113, 'confirm_candidate_voice_callback');
  const finalize = bodyIn(M0113, 'finalize_phone_partial_sessions');
  const sweep = bodyIn(M0113, 'sweep_phone_stranded_sessions');

  it('confirm captures the bound session BEFORE the engagement UPDATE nulls it', () => {
    const capture = confirm.indexOf('v_bound_session_id := v_eng.session_id;');
    const update = confirm.indexOf('         session_id = null,');
    expect(capture).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(capture);
  });

  it("confirm releases only THIS engagement's claim, on the bound and attempt sessions, last in lock order", () => {
    const release = confirm.indexOf('update screening_v2.call_sessions\n     set phone_engagement_id = null');
    expect(release).toBeGreaterThan(confirm.indexOf('update screening_v2.phone_engagements'));
    expect(release).toBeGreaterThan(confirm.indexOf('insert into screening_v2.phone_appointments'));
    expect(confirm).toContain(
      '   where phone_engagement_id = v_eng.id\n     and id in (v_bound_session_id, v_attempt.session_id);',
    );
  });

  it('confirm records the detach on the EXISTING audit row (no new action)', () => {
    expect(confirm).toContain("'session_detached', v_bound_session_id is not null,");
    expect(confirm).toContain("'claim_released', v_claim_released));");
    expect([...confirm.matchAll(/insert into screening_v2\.audit_events/g)]).toHaveLength(1);
    // Advisory lock, replay and the unique_violation fence are kept.
    expect(confirm).toContain("perform pg_advisory_xact_lock(hashtext('phone_callback_booking'));");
    expect(confirm).toContain('exception when unique_violation then');
  });

  it('finalize skips callback legs on the expired arm only, and reports callback_booked by exact attempt match', () => {
    expect(finalize).toContain("         s.status = 'in_progress'\n");
    expect(finalize).toContain(
      "         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout'\n" +
        '             and not exists (\n' +
        '               select 1 from screening_v2.phone_appointments ap\n' +
        '                where ap.confirmed_from_attempt_id = a.id\n',
    );
    expect(finalize).toContain('       where ap.confirmed_from_attempt_id = v_row.attempt_id\n    ) into v_callback_booked;');
    expect(finalize).toContain("'callback_booked',    v_callback_booked);");
    // No status filter and no engagement-level fallback on the flag.
    const flagEnd = finalize.indexOf('into v_callback_booked');
    const flag = finalize.slice(finalize.lastIndexOf('select exists (', flagEnd), flagEnd);
    expect(flag).toContain('confirmed_from_attempt_id');
    expect(flag).not.toMatch(/engagement_id|status/);
  });

  it('the sweep skips a live candidate_voice appointment and keeps its contract parameters', () => {
    expect(sweep).toContain(
      '       and not exists (\n' +
        '         select 1 from screening_v2.phone_appointments ap\n' +
        '          where ap.engagement_id = e.id\n' +
        "            and ap.source = 'candidate_voice'\n" +
        "            and ap.status in ('scheduled','confirmed')\n",
    );
    // The 0045 comment block between p_now and p_grace_seconds is kept, so the
    // extractor still yields exactly what rpc-contract.ts pins.
    expect(functionParameters('sweep_phone_stranded_sessions')).toEqual(['p_limit', 'p_now']);
  });

  it('0113 does not redeclare expire_phone_appointments', () => {
    expect(M0113).not.toContain('function screening_v2.expire_phone_appointments(');
  });
});

describe('0113 E4 — the one-time data repair', () => {
  const start = M0113.indexOf('-- >>> 0113-E4-REPAIR\n');
  const end = M0113.indexOf('-- <<< 0113-E4-REPAIR');
  const block = M0113.slice(start + '-- >>> 0113-E4-REPAIR\n'.length, end);
  const statements = block
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

  it('is delimited, and is exactly two UPDATEs: release the claims, then detach', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^update screening_v2\.call_sessions s\s+set phone_engagement_id = null/);
    expect(statements[1]).toMatch(/^update screening_v2\.phone_engagements e\s+set session_id = null, version = e\.version \+ 1/);
    // It runs after the function section, before the schema reload.
    expect(start).toBeGreaterThan(M0113.lastIndexOf('$$;'));
    expect(M0113.indexOf("notify pgrst, 'reload schema';")).toBeGreaterThan(end);
  });

  it('never touches a terminal engagement and needs a LIVE candidate_voice appointment', () => {
    for (const s of statements) {
      expect(s).toContain('e.terminal_at is null');
      expect(s).toContain("e.state = 'scheduled'");
      expect(s).toContain("ap.source = 'candidate_voice'");
      expect(s).toContain("ap.status in ('scheduled','confirmed')");
    }
    // The claim release is keyed on the binding, guarded on the claim.
    expect(statements[0]).toContain('s.phone_engagement_id = e.id');
    expect(statements[0]).toContain('s.id = e.session_id');
    expect(statements[1]).toContain('e.session_id is not null');
  });

  it('is replayed VERBATIM by policy_tests.sql (twice: apply, then idempotent re-run)', () => {
    const policy = norm(POLICY_TESTS);
    for (const s of statements) {
      const needle = norm(s);
      const first = policy.indexOf(needle);
      expect(first, s.slice(0, 60)).toBeGreaterThan(-1);
      expect(policy.indexOf(needle, first + 1), `${s.slice(0, 60)} (second run)`).toBeGreaterThan(-1);
    }
  });
});
