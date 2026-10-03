/**
 * 0114 §8 (PR-C, S8) — halt provenance and the phone_control direct-write
 * audit (C10b), asserted against the migration TEXT.
 *
 * set_phone_halt is LIFTED from 0110 and clear_phone_halt from 0042 (their
 * newest declarations). The core assertion is a structural diff: remove every
 * marked 0114 hunk (`-- ▼ 0114 <id>` … `-- ▲ 0114 <id>`), undo the few exact
 * 0110/0042 lines the hunks REPLACE, and what is left must be BYTE-IDENTICAL.
 * A retyped body that silently reverted 0110's precedence fails here.
 *
 * admit_phone_test_attempt is not touched: the trigger recognises it (and
 * set/clear) from the PL/pgSQL call stack, because a function-level SET of a
 * custom parameter needs superuser, which Supabase migrations do not have.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (block 0114-§8)
 * and phone_halt_precedence.sql; text is not execution.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  MIGRATION_0042,
  MIGRATION_0110,
  MIGRATION_0114,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const M0042 = lf(MIGRATION_0042);
const M0110 = lf(MIGRATION_0110);
const M0114 = lf(MIGRATION_0114);

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

const BEGIN = '-- ==== 0114 §8 BEGIN ====';
const END = '-- ==== 0114 §8 END ====';
const SECTION = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END) + END.length);

/** One function declaration (header through the closing `$$;`) from a file. */
function bodyIn(sql: string, name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = sql.indexOf(anchor);
  if (start === -1) throw new Error(`${name} not declared`);
  if (sql.indexOf(anchor, start + 1) !== -1) throw new Error(`${name} declared twice`);
  const end = sql.indexOf('\n$$;\n', start);
  if (end === -1) throw new Error(`${name} unterminated`);
  return sql.slice(start, end + '\n$$;\n'.length);
}

/** Remove every marked hunk; returns the residue and the hunk tags, in order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = /^[ \t]*-- ▼ 0114 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0114 ([^\n]+)\n/gm;
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = (hunks[open] ?? '') + inner;
    return '';
  });
  if (/▼ 0114|▲ 0114/.test(residue)) throw new Error('unbalanced 0114 hunk marker');
  return { residue, tags, hunks };
}

function replaceOnce(text: string, from: string, to: string): string {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`expected exactly one ${JSON.stringify(from)}, found ${n}`);
  return text.replace(from, to);
}

/** Code with comments and the signature's `default now()` removed. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
}
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

const SET_0110 = bodyIn(M0110, 'set_phone_halt');
const SET_0114 = bodyIn(M0114, 'set_phone_halt');
const CLEAR_0042 = bodyIn(M0042, 'clear_phone_halt');
const CLEAR_0114 = bodyIn(M0114, 'clear_phone_halt');
const TRIGGER_FN = bodyIn(M0114, 'audit_phone_control_direct_write');

const HEADER =
  'returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$\n';

describe('0114 §8 ownership', () => {
  it('redeclares set_phone_halt, clear_phone_halt and the trigger function exactly once, inside §8', () => {
    for (const name of ['set_phone_halt', 'clear_phone_halt', 'audit_phone_control_direct_write']) {
      const anchor = `create or replace function screening_v2.${name}(`;
      expect(M0114.split(anchor).length - 1, name).toBe(1);
      expect(SECTION.includes(anchor), name).toBe(true);
    }
  });

  it('lifts from the newest prior declarations: set from 0110, clear from 0042; the test gate untouched', { timeout: 60_000 }, () => {
    // Read every migration ONCE (the suite runs on slow bind mounts in CI/docker).
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
      .map((f) => ({ f, sql: readFileSync(MIGRATIONS_DIR + f, 'utf8') }));
    const declaring = (name: string) =>
      files
        .filter(({ sql }) => sql.includes(`create or replace function screening_v2.${name}(`))
        .map(({ f }) => f);
    expect(declaring('set_phone_halt').slice(-2)).toEqual([
      '0110_phone_halt_reason_precedence.sql',
      '0114_phone_outcome_integrity.sql',
    ]);
    expect(declaring('clear_phone_halt').slice(-2)).toEqual([
      '0042_phone_screening.sql',
      '0114_phone_outcome_integrity.sql',
    ]);
    expect(declaring('admit_phone_test_attempt')).toEqual(['0063_phone_candidate_test_gate.sql']);
    expect(M0114).not.toMatch(/alter function screening_v2\.admit_phone_test_attempt/);
  });

  it('the shared extractors now read 0114 for set/clear', () => {
    expect(functionBody('clear_phone_halt')).toContain("'actor_required'");
    expect(functionBody('set_phone_halt')).toContain('C10b-actor-type');
    expect(functionStatuses('clear_phone_halt')).toEqual(
      new Set(['actor_required', 'halt_unreadable', 'ok']),
    );
    expect(functionStatuses('set_phone_halt')).toEqual(new Set(['invalid_reason', 'ok']));
  });

  it('sets no custom parameter anywhere (function-level SET of one needs superuser)', () => {
    expect(code(SECTION)).not.toMatch(/phone_control_writer|set_config\s*\(/);
    expect(code(SECTION).match(/^set search_path = pg_catalog, screening_v2$/gm)).toHaveLength(3);
  });
});

describe('0114 §8 set_phone_halt — 0110 lifted, only the C10b hunks', () => {
  const { residue, tags, hunks } = stripHunks(SET_0114);

  it('carries exactly the actor-type and provenance hunks, in order', () => {
    expect(tags).toEqual(['C10b-actor-type', 'C10b-provenance']);
  });

  it('is byte-identical to 0110 outside the hunks', () => {
    let base = SET_0110;
    base = replaceOnce(
      base,
      "     'recruiter', 'admin_session_override', 'phone_control', 'default', 'success',\n",
      '',
    );
    base = replaceOnce(
      base,
      "                        'reason_escalated', v_escalated));\n",
      "                        'reason_escalated', v_escalated)\n    );\n",
    );
    expect(residue).toBe(base);
  });

  it('keeps SECURITY DEFINER and the pinned search_path', () => {
    expect(SET_0114).toContain(HEADER);
  });

  it('audits a NULL actor as system, never as a recruiter, and still halts (no refusal)', () => {
    expect(hunks['C10b-actor-type']).toContain(
      "case when p_actor_id is null then 'system' else 'recruiter' end,",
    );
    expect(functionStatuses('set_phone_halt')).not.toContain('actor_required');
  });

  it('adds attributed / db_session_user / sanitised application_name and nothing identifying', () => {
    const prov = hunks['C10b-provenance'];
    expect(prov).toContain("'attributed', p_actor_id is not null");
    expect(prov).toContain("'db_session_user'");
    expect(prov).toContain("current_setting('application_name', true)");
    expect(prov.match(/\{0,64\}/g)).toHaveLength(2);
    expect(prov).not.toMatch(/phone_e164|email|room/i);
  });
});

describe('0114 §8 clear_phone_halt — 0042 lifted, only the C10b hunks', () => {
  const { residue, tags, hunks } = stripHunks(CLEAR_0114);

  it('carries exactly the actor-required and provenance hunks, in order', () => {
    expect(tags).toEqual(['C10b-actor-required', 'C10b-provenance']);
  });

  it('is byte-identical to 0042 outside the hunks', () => {
    const base = replaceOnce(
      CLEAR_0042,
      "                        'was_halted', v_prev_at is not null));\n",
      "                        'was_halted', v_prev_at is not null)\n    );\n",
    );
    expect(residue).toBe(base);
  });

  it('keeps SECURITY DEFINER and the pinned search_path', () => {
    expect(CLEAR_0114).toContain(HEADER);
  });

  it('refuses a NULL actor as the FIRST statement, before any read or write', () => {
    const body = code(CLEAR_0114.slice(CLEAR_0114.indexOf('\nbegin\n') + '\nbegin\n'.length));
    const first = body.trim().split(';')[0].replace(/\s+/g, ' ');
    expect(first).toBe("if p_actor_id is null then return jsonb_build_object('status', 'actor_required')");
    expect(hunks['C10b-actor-required']).toContain("'actor_required'");
  });
});

describe('0114 §8 grants and the direct-write trigger', () => {
  it('re-issues service_role-only grants for set and clear, and grants the trigger function nothing', () => {
    for (const sig of ['set_phone_halt(text, uuid, timestamptz)', 'clear_phone_halt(uuid, timestamptz)']) {
      expect(SECTION).toContain(
        `revoke all on function screening_v2.${sig}\n  from public, anon, authenticated;`,
      );
      expect(SECTION).toContain(`grant execute on function screening_v2.${sig} to service_role;`);
    }
    expect(SECTION.match(/grant execute/g)).toHaveLength(2);
    expect(SECTION).toContain(
      'revoke all on function screening_v2.audit_phone_control_direct_write()\n  from public, anon, authenticated;',
    );
  });

  it('is definer and pinned, and exempts exactly the three writers named from the call stack', () => {
    expect(TRIGGER_FN).toContain(
      'returns trigger\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$',
    );
    expect(TRIGGER_FN).toContain('get diagnostics v_ctx = pg_context;');
    // The first PL/pgSQL frame AFTER a newline (line 1 is the trigger itself),
    // taken verbatim so another schema's same-named function is not exempt.
    expect(TRIGGER_FN).toContain(
      "v_caller := regexp_replace(substring(v_ctx from '\\nPL/pgSQL function ([^ (\\n]{1,200})'),\n" +
        "                             '^screening_v2\\.', '');",
    );
    expect(TRIGGER_FN).toContain(
      "if v_caller in ('set_phone_halt', 'clear_phone_halt', 'admit_phone_test_attempt') then\n    return null;",
    );
  });

  it('swallows an audit failure with a WARNING carrying only the SQLSTATE, and returns null', () => {
    expect(TRIGGER_FN).toMatch(
      /exception when others then[\s\S]*raise warning '[^']*\(sqlstate %\)', sqlstate;\s+end;\s+return null;\s+end;/,
    );
    expect(TRIGGER_FN).toContain("'override', 'phone_control_direct_write'");
    expect(TRIGGER_FN).toContain("'00000000-0000-4000-8000-000000000001'::uuid, 'system'");
  });

  it('fires AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW', () => {
    expect(SECTION).toContain(
      'create trigger trg_phone_control_direct_write_audit\n' +
        '  after insert or update or delete on screening_v2.phone_control\n' +
        '  for each row execute function screening_v2.audit_phone_control_direct_write();',
    );
  });

  it('reads no machine clock anywhere in §8 code', () => {
    expect(code(SECTION)).not.toMatch(MACHINE_CLOCK);
  });

  it('writes no contact datum into any audit metadata', () => {
    expect(code(SECTION)).not.toMatch(/phone_e164|\bemail\b|room_name|candidate_id/i);
  });
});
