/**
 * Static guarantees for migration 0134 (Christy verdict tags, M027). The
 * behavioural cases run against the real migrated schema in
 * app/supabase/tests/policy_tests.sql (section "0134"); no Postgres is available
 * to this suite. These checks keep the text honest:
 *
 *   - enqueue_ashby_operation is 0031 VERBATIM except the one allowlist line;
 *   - claim_ashby_operation is 0059 VERBATIM except the allowlist line and the
 *     created_at key, so neither the 0032 terminal gate nor the 0035 invite gate
 *     can silently go;
 *   - revoke, grant and the schema-cache reload are all there;
 *   - scripts/verify-prod-function-drift.sh checks are well-formed and
 *     DISCRIMINATING (the token is in the 0134 body and in no earlier one);
 *   - the backfill is shipped, never run, and returns no candidate data.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
/** Normalised to LF so a Windows (CRLF) checkout compares the same as CI. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (name: string): string => lf(readFileSync(path.join(migrations, name), 'utf8'));

const M0134 = read('0134_ashby_recommendation_tags.sql');
const M0031 = read('0031_ashby_workflow.sql');
const M0059 = read('0059_ashby_cycle_scorecards.sql');
const DRIFT_SCRIPT = lf(readFileSync(path.resolve(here, '../../../../scripts/verify-prod-function-drift.sh'), 'utf8'));

const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const CODE = stripComments(M0134);

/** One `create or replace function screening_v2.<name>(` up to its own `\n$$;\n`. */
function declaration(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, `${name} must be declared`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;\n', start);
  expect(end, `${name} must close with $$;`).toBeGreaterThan(start);
  return sql.slice(start, end + 5);
}

/** Every declaration of `screening_v2.<name>(` in one migration, header to `$$;`. */
function declarations(sql: string, name: string): string[] {
  const header = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+screening_v2\\.${name}\\s*\\(`, 'g');
  const found: string[] = [];
  for (const m of sql.matchAll(header)) {
    const end = sql.indexOf('\n$$;', m.index);
    if (end === -1) throw new Error(`${name} declaration is unterminated`);
    found.push(sql.slice(m.index, end));
  }
  return found;
}

/** `(uuid,text,...,timestamptz)` from a declaration's argument list. */
function regprocedureArgs(decl: string): string {
  const open = decl.indexOf('(');
  const close = decl.indexOf('\n)\nreturns', open);
  if (open === -1 || close === -1) throw new Error('argument list not found');
  const types = decl
    .slice(open + 1, close)
    .split(',\n')
    .map((arg) => arg.trim().split(/\s+/)[1]);
  return `(${types.join(',')})`;
}

/** The `CHECKS=( ... )` entries: `<regprocedure>|<token>`, one per line. */
function driftChecks(): Array<{ signature: string; token: string }> {
  const block = /CHECKS=\(\n([\s\S]*?)\n\)/.exec(DRIFT_SCRIPT);
  if (!block) throw new Error('CHECKS array not found');
  return block[1]
    .split('\n')
    .map((line) => /^\s*"([^"|]+)\|([^"]+)"\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ signature: m[1], token: m[2] }));
}

const OLD_ALLOWLIST = "not in ('invite_delivery','scorecard_write','stage_move') then";
const NEW_ALLOWLIST = "not in ('invite_delivery','scorecard_write','stage_move','recommendation_tag') then";

describe('0134 — the redeclared functions change only what they must', () => {
  it('enqueue_ashby_operation: undoing the one allowlist change gives back 0031 byte for byte', () => {
    const now = declaration(M0134, 'enqueue_ashby_operation');
    expect(now).toContain(NEW_ALLOWLIST);
    expect(now.replace(NEW_ALLOWLIST, OLD_ALLOWLIST)).toBe(declaration(M0031, 'enqueue_ashby_operation'));
  });

  it('claim_ashby_operation: undoing the two changes gives back 0059 byte for byte', () => {
    const now = declaration(M0134, 'claim_ashby_operation');
    expect(now).toContain(NEW_ALLOWLIST);
    expect(now).toContain("'source_session_id', v_op.source_session_id,\n    'created_at', v_op.created_at\n");
    const restored = now
      .replace(NEW_ALLOWLIST, OLD_ALLOWLIST)
      .replace(
        "'source_session_id', v_op.source_session_id,\n    'created_at', v_op.created_at\n",
        "'source_session_id', v_op.source_session_id\n",
      );
    expect(restored).toBe(declaration(M0059, 'claim_ashby_operation'));
  });

  it('claim keeps the 0032 terminal gate, the dependency gate and the 0035 invite gate', () => {
    const now = stripComments(declaration(M0134, 'claim_ashby_operation'));
    expect(now).toContain('and l.terminal_state is null');
    expect(now).toContain('o.depends_on_operation_id is null');
    expect(now).toContain("o.operation_type <> 'invite_delivery'");
    expect(now).toContain("m.status = 'enabled'");
    expect(now).toContain("i.state = 'ready'");
  });

  it('0059 is still the newest earlier claim body and 0031 the only earlier enqueue body', () => {
    const declaring = (name: string): string[] =>
      readdirSync(migrations)
        .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < '0134_')
        .filter((f) => declarations(read(f), name).length > 0)
        .sort();
    const claim = declaring('claim_ashby_operation');
    expect(claim[claim.length - 1]).toMatch(/^0059_/);
    expect(declaring('enqueue_ashby_operation').every((f) => f.startsWith('0031_'))).toBe(true);
  }, 60_000);
});

describe('0134 — the type CHECK', () => {
  it('follows the 0032 pattern: drop if exists, add not valid, validate', () => {
    expect(CODE).toMatch(/drop constraint if exists chk_ashby_operations_type;/);
    expect(CODE).toMatch(
      /add constraint chk_ashby_operations_type check \(\s+operation_type in \('invite_delivery','scorecard_write','stage_move','recommendation_tag'\)\s+\)\s+not valid;/,
    );
    expect(CODE).toMatch(/validate constraint chk_ashby_operations_type;/);
  });

  it('re-creates no audit constraint: the generic ashby_operation_* actions cover it', () => {
    expect(CODE).not.toContain('chk_audit_action');
  });
});

describe('0134 — enqueue_ashby_recommendation_tag', () => {
  const fn = stripComments(declaration(M0134, 'enqueue_ashby_recommendation_tag'));

  it('answers each documented refusal', () => {
    for (const status of ['invalid_request', 'not_found', 'blocked_terminal', 'mapping_inactive', 'session_mismatch', 'assessment_missing']) {
      expect(fn).toContain(`'status', '${status}'`);
    }
  });

  it('locks the Ashby link before it reads anything else', () => {
    const lock = fn.indexOf("where id = p_application_link_id and provider = 'ashby' for update");
    expect(lock).toBeGreaterThan(0);
    expect(fn.indexOf('v_mapping_status')).toBeGreaterThan(0);
    expect(fn.slice(0, lock)).not.toContain('from screening_v2.ashby_job_mappings');
  });

  it('accepts the session on the link or on a phone engagement of the link, and nothing else', () => {
    expect(fn).toContain('v_link.session_id is distinct from p_session_id');
    expect(fn).toMatch(/e\.application_link_id = p_application_link_id\s+and e\.session_id = p_session_id/);
  });

  it('keys on the newest assessment revision and the link, with a NULL marker and no dependency', () => {
    expect(fn).toMatch(/order by a\.created_at desc, a\.id desc\s+limit 1/);
    expect(fn).toContain("'ashby:recommendation_tag:' || p_application_link_id::text || ':' || v_assessment_id::text");
    expect(fn).toMatch(/\n\s+null, null, p_actor_id\);/);
  });

  it('sets source_session_id only on an insert', () => {
    expect(fn).toMatch(/if v_result->>'status' = 'inserted' then\s+update screening_v2\.ashby_operations\s+set source_session_id = p_session_id/);
  });

  it('never reads the verdict: a newest result with no verdict still has to remove a stale tag', () => {
    expect(fn).not.toContain('recommendation in');
    expect(fn).not.toContain('a.recommendation');
    expect(fn).not.toContain('evidence_grade');
  });
});

describe('0134 — backfill_ashby_recommendation_tags', () => {
  const fn = stripComments(declaration(M0134, 'backfill_ashby_recommendation_tags'));

  it('defaults to a dry run and only enqueues under `not p_dry_run`', () => {
    expect(fn).toContain('p_dry_run boolean     default true');
    const gate = fn.indexOf('if not p_dry_run then');
    expect(gate).toBeGreaterThan(0);
    const firstWrite = fn.indexOf('screening_v2.enqueue_ashby_recommendation_tag(');
    expect(firstWrite).toBeGreaterThan(gate);
    expect(fn.slice(0, gate)).not.toMatch(/\b(insert into|update screening_v2)\b/);
  });

  it('walks links oldest scorecard first and schedules each insert after the last', () => {
    expect(fn).toContain('order by s.created_at asc, s.id asc');
    expect(fn).toContain("set scheduled_at = p_now + (v_inserted * interval '1 millisecond')");
  });

  it('takes the session from the newest SUCCEEDED scorecard', () => {
    expect(fn).toContain("o.operation_type = 'scorecard_write'");
    expect(fn).toContain("o.state = 'succeeded'");
    expect(fn).toContain('order by o.application_link_id, o.created_at desc, o.id desc');
    expect(fn).toContain('coalesce(s.source_session_id, l.session_id)');
  });

  it('reports every documented count', () => {
    for (const key of ['total_eligible', 'verdicts', 'skipped_terminal', 'skipped_mapping_inactive', 'skipped_no_session', 'enqueue']) {
      expect(fn).toContain(`'${key}'`);
    }
    expect(fn).toMatch(/'advance', v_advance, 'hold', v_hold, 'reject', v_reject, 'none', v_none/);
  });

  it('never touches a candidate table or a contact column', () => {
    expect(fn).not.toContain('screening_v2.candidates');
    expect(fn).not.toMatch(/\b(email|phone_e164|phone_raw|external_candidate_id|external_application_id)\b/);
  });

  it('is shipped, never run: the migration does not call it', () => {
    const outside = CODE.replace(declaration(CODE, 'backfill_ashby_recommendation_tags'), '');
    expect(outside).not.toMatch(/(select|perform)\s+screening_v2\.backfill_ashby_recommendation_tags/);
  });
});

describe('0134 — security posture', () => {
  it('every function is SECURITY DEFINER with a fixed search_path', () => {
    for (const name of [
      'enqueue_ashby_operation',
      'claim_ashby_operation',
      'enqueue_ashby_recommendation_tag',
      'backfill_ashby_recommendation_tags',
    ]) {
      const fn = declaration(CODE, name);
      expect(fn).toContain('security definer');
      expect(fn).toContain('set search_path = pg_catalog, screening_v2');
    }
  });

  it('every function is revoked from browser roles and granted only to service_role', () => {
    const sigs = [
      'enqueue_ashby_operation(uuid, text, text, uuid, text, uuid)',
      'claim_ashby_operation(text, text, integer, timestamptz)',
      'enqueue_ashby_recommendation_tag(uuid, uuid, uuid, timestamptz)',
      'backfill_ashby_recommendation_tags(boolean, timestamptz)',
    ];
    for (const sig of sigs) {
      expect(CODE).toContain(`revoke all on function screening_v2.${sig}\n  from public, anon, authenticated;`);
      expect(CODE).toContain(`grant execute on function screening_v2.${sig}\n  to service_role;`);
    }
    expect(CODE).not.toMatch(/grant [^;]* to (anon|authenticated|public)\b/);
  });

  it('ends with the schema-cache reload every RPC-adding migration carries', () => {
    expect(M0134.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe('verify-prod-function-drift.sh covers the functions 0134 declares', () => {
  const CHECKS = [
    {
      name: 'enqueue_ashby_operation',
      signature: 'screening_v2.enqueue_ashby_operation(uuid,text,text,uuid,text,uuid)',
      token: 'recommendation_tag',
      isNew: false,
    },
    {
      name: 'claim_ashby_operation',
      signature: 'screening_v2.claim_ashby_operation(text,text,integer,timestamptz)',
      token: 'recommendation_tag',
      isNew: false,
    },
    {
      name: 'enqueue_ashby_recommendation_tag',
      signature: 'screening_v2.enqueue_ashby_recommendation_tag(uuid,uuid,uuid,timestamptz)',
      token: 'enqueue_ashby_operation',
      isNew: true,
    },
    {
      name: 'backfill_ashby_recommendation_tags',
      signature: 'screening_v2.backfill_ashby_recommendation_tags(boolean,timestamptz)',
      token: 'enqueue_ashby_recommendation_tag',
      isNew: true,
    },
  ];

  it.each(CHECKS)('$name: the check is listed verbatim', ({ signature, token }) => {
    expect(driftChecks()).toContainEqual({ signature, token });
  });

  it.each(CHECKS)('$name: the signature is the one the 0134 header declares', ({ name, signature }) => {
    const [decl, ...rest] = declarations(M0134, name);
    expect(rest).toEqual([]);
    expect(signature).toBe(`screening_v2.${name}${regprocedureArgs(decl)}`);
  });

  it.each(CHECKS)('$name: the token is in the 0134 body, outside comments', ({ name, token }) => {
    const [decl] = declarations(M0134, name);
    expect(stripComments(decl)).toContain(token);
  });

  it.each(CHECKS)(
    '$name: no earlier declaration carries the token, so a prod without 0134 fails',
    { timeout: 60_000 },
    ({ name, token, isNew }) => {
      const earlier: Array<{ file: string; body: string }> = [];
      for (const file of readdirSync(migrations).sort()) {
        const number = /^(\d{4})_.*\.sql$/.exec(file);
        if (!number || Number(number[1]) >= 134) continue;
        for (const body of declarations(read(file), name)) earlier.push({ file, body });
      }
      if (isNew) {
        expect(earlier).toEqual([]);
      } else {
        expect(earlier.length).toBeGreaterThan(0);
      }
      for (const { file, body } of earlier) {
        expect(body, `${file} must not mention ${token}`).not.toContain(token);
      }
    },
  );
});
