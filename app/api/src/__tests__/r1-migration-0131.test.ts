/**
 * Static guarantees for migration 0131 (M019, R1 concurrent sessions). The behavioural SQL
 * assertions run in supabase-ci (app/supabase/tests/r1_foundation_assert.sql, wired by
 * scripts/test-r1-foundation.sh); these checks keep the migration to exactly what it claims:
 *
 *   - one additive column, r1_settings.max_concurrent_sessions (default 1, CHECK 1..15);
 *   - r1_admit_attempt as 0128 VERBATIM except three marked hunks (`-- ▼ 0131 <id>` ...
 *     `-- ▲ 0131 <id>`) and the one 0128 line the gate hunk replaces. Stripping the hunks and
 *     putting that line back must give 0128's body byte for byte (LF-normalised), so a silent
 *     edit anywhere else in the lifted body (a reordered lock, a dropped refusal, a changed
 *     charge) fails here instead of shipping as a "verbatim" copy that is not;
 *   - one new service-role RPC, retire_voice_worker, that deletes only a stopped lease row.
 *
 * WHAT THIS FILE CANNOT DO is prove behaviour: text is not execution. The real-Postgres cases
 * (the default of 1 behaves as before, 3 of 3 admitted, the pool cap, the Cloud target, the CHECK,
 * round_live, retire) are in r1_foundation_assert.sql.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0131_r1_concurrent_sessions.sql';
/** Normalised to LF so a Windows (CRLF) checkout compares the same as CI. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (name: string): string => lf(readFileSync(path.join(migrations, name), 'utf8'));
const readRepo = (rel: string): string => lf(readFileSync(path.resolve(here, rel), 'utf8'));

const M0131 = read(FILE);
const M0128 = read('0128_r1_twenty_minute_roleplay.sql');

/** SQL with `--` comments removed (no string literal in 0131 contains `--`). */
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const flat = (sql: string): string => stripComments(sql).replace(/\s+/g, ' ').trim();
const CODE = stripComments(M0131);

/** One `create or replace function screening_v2.<name>(` from its header to its own `\n$$;\n`. */
function declaration(sql: string, name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = sql.indexOf(anchor);
  if (start === -1) throw new Error(`${name} not declared`);
  if (sql.indexOf(anchor, start + 1) !== -1) throw new Error(`${name} declared twice`);
  const end = sql.indexOf('\n$$;\n', start);
  if (end === -1) throw new Error(`${name} unterminated`);
  return sql.slice(start, end + '\n$$;\n'.length);
}

const HUNK_RE = /^[ \t]*-- ▼ 0131 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0131 ([^\n]+)\n/gm;

/** Remove every marked 0131 hunk; returns the residue and the hunks by tag, in file order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const residue = body.replace(HUNK_RE, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = (hunks[open] ?? '') + inner;
    return '';
  });
  if (/▼ 0131|▲ 0131/.test(residue)) throw new Error('unbalanced 0131 hunk marker');
  return { residue, tags, hunks };
}

/** A hunk's statements: trimmed, comment-only and blank lines dropped. */
const codeLines = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'));

/** The `'status'` literals a body writes (both the compact and the spaced style). */
const statusLiterals = (text: string): Set<string> =>
  new Set([...text.matchAll(/'status',\s*'([a-z_]+)'/g)].map((m) => m[1]));

const ADMIT_0128 = declaration(M0128, 'r1_admit_attempt');
const ADMIT_0131 = declaration(M0131, 'r1_admit_attempt');
const ADMIT = stripHunks(ADMIT_0131);
const RETIRE = declaration(M0131, 'retire_voice_worker');

/** The one 0128 line 0131 replaces: the single-slot rule. */
const REPLACED =
  "  if v_live_r1>=1 then return jsonb_build_object('status','r1_in_flight'); end if;\n";
const LIVE = "('created','waiting','in_progress')";

describe('migration 0131: frame', () => {
  it('is the only migration with its number and carries the _r1_ infix', () => {
    expect(readdirSync(migrations).filter((name) => name.startsWith('0131_'))).toEqual([FILE]);
    expect(FILE).toMatch(/^\d{4}_r1_/);
  });

  it('opens with a LOCAL lock_timeout and ends by reloading the PostgREST schema', () => {
    const statements = CODE.trim();
    expect(statements.startsWith("set local lock_timeout = '10s';")).toBe(true);
    expect(statements.endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it('is additive: one ALTER (the new column), no DML, no drop, no DO block, no index/table/view/trigger', () => {
    // Remove every $$ ... $$ body, then look at what runs at top level.
    const topLevel = CODE.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
    expect(topLevel).not.toMatch(/^\s*(insert|update|delete|truncate)\b/im);
    expect(CODE).not.toMatch(/\bdrop\b|\btruncate\b/i);
    expect(CODE).not.toMatch(/^\s*do\s+\$\$/im);
    expect(CODE.match(/\balter\s+table\b/gi)).toHaveLength(1);
    expect(CODE).not.toMatch(/\bcreate\s+(unique\s+)?index\b|\bcreate\s+table\b|\bcreate\s+(or\s+replace\s+)?view\b/i);
    expect(CODE).not.toMatch(/\bcreate\s+(or\s+replace\s+)?trigger\b/i);
  });

  it('declares exactly r1_admit_attempt and retire_voice_worker, and re-declares nothing else', () => {
    const declared = [...CODE.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
    expect(declared).toEqual(['r1_admit_attempt', 'retire_voice_worker']);
    // Left exactly as their latest definitions: the capacity maths already sums per-session floors
    // (0128), the phone-shared lease RPCs keep 0118, and the 0115 settings audit trigger is not
    // extended (the settings route audits new columns, the recording_mode precedent).
    for (const untouched of [
      'r1_capacity_snapshot', 'r1_send_round', 'r1_transition_round', 'claim_voice_worker',
      'reset_voice_worker', 'release_voice_worker', 'register_voice_worker', 'audit_r1_settings_change',
    ]) expect(CODE, untouched).not.toMatch(new RegExp(`function\\s+screening_v2\\.${untouched}\\b`));
  });
});

describe('migration 0131: the setting', () => {
  it('adds max_concurrent_sessions as integer NOT NULL default 1 with a named CHECK of 1..15', () => {
    expect(flat(M0131)).toContain(
      'alter table screening_v2.r1_settings add column if not exists max_concurrent_sessions integer not null default 1 '
        + 'constraint chk_r1_settings_max_concurrent_sessions check (max_concurrent_sessions between 1 and 15);',
    );
    expect(M0131).toContain('comment on column screening_v2.r1_settings.max_concurrent_sessions is');
  });
});

describe('migration 0131: r1_admit_attempt', () => {
  it('is 0128 byte for byte once the 0131 hunks are stripped, less exactly the replaced single-slot line', () => {
    expect(ADMIT_0128.split(REPLACED)).toHaveLength(2);
    expect(ADMIT.tags).toEqual(['concurrent-declare', 'concurrent-limit', 'concurrent-gate']);
    expect(ADMIT.residue).toBe(ADMIT_0128.replace(REPLACED, ''));
    expect(ADMIT_0131).not.toContain(REPLACED);
  });

  it('the gate hunk sits exactly where the replaced line was', () => {
    // Swap the gate hunk (markers included) back for the 0128 line, strip the rest: 0128 exactly.
    const gate = /^[ \t]*-- ▼ 0131 concurrent-gate\n[\s\S]*?^[ \t]*-- ▲ 0131 concurrent-gate\n/m;
    expect(ADMIT_0131).toMatch(gate);
    expect(stripHunks(ADMIT_0131.replace(gate, REPLACED)).residue).toBe(ADMIT_0128);
  });

  it('adds only the two locals, the limit with its same-round check, and the gate against the limit', () => {
    expect(codeLines(ADMIT.hunks['concurrent-declare'])).toEqual(['v_pool integer; v_limit integer;']);
    expect(codeLines(ADMIT.hunks['concurrent-limit'])).toEqual([
      "if v_settings.livekit_target='r1' then",
      "select count(*) into v_pool from screening_v2.voice_worker_leases l where l.app='project-hello-voice' and l.pipeline='browser';",
      'v_limit:=least(coalesce(v_settings.max_concurrent_sessions,1),greatest(v_pool,1));',
      'else',
      'v_limit:=1;',
      'end if;',
      `if v_limit>1 and exists(select 1 from screening_v2.call_sessions s where s.interview_round_id=v_round.id and s.status in ${LIVE}) then return jsonb_build_object('status','round_live'); end if;`,
    ]);
    expect(codeLines(ADMIT.hunks['concurrent-gate'])).toEqual([
      "if v_live_r1>=v_limit then return jsonb_build_object('status','r1_in_flight'); end if;",
    ]);
  });

  it('keeps the refusal order: round gates, then the limit and round_live, the live count, the Cloud check, capacity', () => {
    const at = (needle: string): number => {
      const i = ADMIT_0131.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      "select * into v_settings from screening_v2.r1_settings where singleton for update;",
      "return jsonb_build_object('status','consent_missing')",
      '-- ▼ 0131 concurrent-limit',
      "return jsonb_build_object('status','round_live')",
      'select count(*) into v_live_r1 from screening_v2.call_sessions',
      "if v_live_r1>=v_limit then return jsonb_build_object('status','r1_in_flight')",
      "if v_settings.livekit_target='cloud' then",
      "return jsonb_build_object('status','cloud_capacity_exhausted')",
      'screening_v2.r1_capacity_snapshot(p_now,',
      'insert into screening_v2.call_sessions(',
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('only the self-hosted target reads the setting; Cloud stays at one slot and keeps its phone check', () => {
    const limit = ADMIT.hunks['concurrent-limit'];
    const selfHosted = limit.slice(limit.indexOf("if v_settings.livekit_target='r1' then"), limit.indexOf('  else\n'));
    expect(selfHosted).toContain('max_concurrent_sessions');
    expect(stripComments(limit).split('max_concurrent_sessions')).toHaveLength(2);
    expect(limit).toContain('  else\n    v_limit:=1;\n  end if;\n');
    // The 0128 Cloud block survives unchanged (also implied by the byte-for-byte residue).
    expect(ADMIT_0131).toContain(
      "  if v_settings.livekit_target='cloud' then\n"
        + "    select count(*) into v_live_phone from screening_v2.phone_call_attempts p where p.state in ('admitted','ringing','answered_unclassified','human','machine') and p.lease_expires_at>p_now;\n"
        + "    if v_live_phone>=4 then return jsonb_build_object('status','cloud_capacity_exhausted'); end if;\n"
        + '  end if;\n',
    );
  });

  it('round_live is asked only above a limit of 1, with the live predicate of the per-round unique index', () => {
    // At a limit of 1 the live count refuses a same-round admission first as r1_in_flight, exactly
    // as 0128 did: the default ships the old answer.
    const limit = codeLines(ADMIT.hunks['concurrent-limit']).join('\n');
    expect(limit).toContain('if v_limit>1 and exists(');
    // uq_call_sessions_interview_round_live (0116) covers the same three live statuses.
    const index = flat(read('0116_r1_shared_session_fields.sql'));
    expect(index).toContain(
      "create unique index if not exists uq_call_sessions_interview_round_live on screening_v2.call_sessions(interview_round_id) where interview_round_id is not null and status in ('created', 'waiting', 'in_progress');",
    );
    // ...and the live count the gate compares with is 0128's, unchanged.
    expect(ADMIT_0131).toContain(
      `  select count(*) into v_live_r1 from screening_v2.call_sessions s where s.interview_round_id is not null and s.status in ${LIVE};\n`,
    );
  });

  it("counts the pool the API orchestrates: the browser app's lease rows of pipeline browser, in every state", () => {
    const runtime = readRepo('../lib/worker-orchestration-runtime.ts');
    expect(runtime).toMatch(/export const BROWSER_FLY_APP = 'project-hello-voice';/);
    expect(readRepo('../routes/voice-worker.ts')).toMatch(/const BROWSER_APP = 'project-hello-voice';/);
    expect(readRepo('../lib/browser-orchestration.ts')).toContain("pipeline: 'browser',");
    const pool = codeLines(ADMIT.hunks['concurrent-limit'])[1];
    expect(pool).not.toMatch(/\bstate\b/);
  });

  it("answers 0128's statuses plus round_live, and nothing else", () => {
    const expected = new Set([...statusLiterals(ADMIT_0128), 'round_live']);
    expect(statusLiterals(ADMIT_0131)).toEqual(expected);
    expect(statusLiterals(ADMIT_0128).has('round_live')).toBe(false);
  });

  it("keeps security definer, the pinned search_path and 0128's exact service_role-only grant", () => {
    expect(ADMIT_0131).toContain(
      'returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$',
    );
    const grant = 'revoke all on function screening_v2.r1_admit_attempt(uuid,text,timestamptz) from public, anon, authenticated;\n'
      + 'grant execute on function screening_v2.r1_admit_attempt(uuid,text,timestamptz) to service_role;\n';
    expect(M0128).toContain(grant);
    expect(M0131).toContain(grant);
  });
});

describe('migration 0131: retire_voice_worker', () => {
  it('takes (app, machine_id), is security definer with a pinned search_path, and reads no clock', () => {
    expect(RETIRE).toMatch(
      /^create or replace function screening_v2\.retire_voice_worker\(\n  p_app        text,\n  p_machine_id text\n\)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas \$\$\n/,
    );
    expect(RETIRE).not.toMatch(/\b(now|clock_timestamp|statement_timestamp)\s*\(|\bcurrent_timestamp\b/);
  });

  it('deletes only a stopped row of that machine, writes nothing else, and answers a fixed vocabulary', () => {
    const body = stripComments(RETIRE);
    expect(body.match(/\bdelete\s+from\b/gi)).toHaveLength(1);
    expect(body).toContain(
      "  delete from screening_v2.voice_worker_leases\n   where app = p_app\n     and machine_id = p_machine_id\n     and state = 'stopped';\n",
    );
    expect(body).not.toMatch(/\b(insert|update)\b/i);
    expect(statusLiterals(RETIRE)).toEqual(new Set(['invalid_request', 'retired', 'unknown_machine', 'not_stopped']));
  });

  it('is service_role-only', () => {
    const sig = 'screening_v2.retire_voice_worker(text, text)';
    expect(M0131).toContain(`revoke all on function ${sig}\n  from public, anon, authenticated;`);
    expect(M0131).toContain(`grant execute on function ${sig}\n  to service_role;`);
    expect(M0131).not.toMatch(/grant execute on function screening_v2\.retire_voice_worker[^;]*to (?:anon|authenticated|public)/);
  });
});

describe('migration 0131: behavioural assertions', () => {
  it('exist in the R1 foundation suite, which the R1 SQL runner executes', () => {
    const runner = readRepo('../../../../scripts/test-r1-foundation.sh');
    expect(runner).toContain('< "$TESTS/r1_foundation_assert.sql"');
    const assertions = readRepo('../../../supabase/tests/r1_foundation_assert.sql');
    // The two CHECK refusals share one labelled loop over 0 and 16.
    expect(assertions).toContain("foreach k in array array[0, 16] loop");
    expect(assertions).toContain("perform _r1_tests.assert('0131: the CHECK refuses ' || k,");
    for (const label of [
      '0131: max_concurrent_sessions defaults to 1 and the shipped row reads 1',
      '0131: the CHECK accepts its upper bound 15',
      '0131: at the default of 1 a pool of 3 still admits one live R1 session',
      '0131: at the default of 1 a second admission of a live round is still r1_in_flight',
      '0131: max 3 with no registered pool keeps one slot',
      '0131: max 3 with 3 browser machines admits 3 and refuses the 4th as r1_in_flight',
      '0131: a second admission of a live round is round_live with free slots, and starts nothing',
      '0131: lowering the limit below the live count refuses new admissions and leaves the live sessions alone',
      '0131: max 3 with 2 browser machines refuses the 3rd',
      '0131: the Cloud target stays at one slot with max 3 and 3 machines',
      '0131: retire refuses a claimed row and keeps it',
      '0131: retire deletes a stopped row',
    ]) expect(assertions, label).toContain(label);
  });
});
