/**
 * 0130 (M017, ADR-0018) — production drift coverage for the six functions it
 * declares, asserted against the migration TEXT and the drift script.
 *
 * Supabase never re-runs an applied migration, so a prod database that missed
 * 0130 would keep the 0114 bodies of `admit_phone_attempt` and
 * `ensure_ashby_phone_engagement` and lack the three new RPCs, while every
 * local and CI database looked correct. `scripts/verify-prod-function-drift.sh`
 * proves the LIVE body contains a token. This file proves its six 0130 checks
 * are well-formed and DISCRIMINATING:
 *
 *   - each CHECKS signature is exactly the argument list the 0130 CREATE header
 *     declares (a wrong regprocedure makes the live query fail, which the
 *     script counts as drift);
 *   - each token is in the 0130 body (so a correct prod passes);
 *   - no earlier declaration of the function carries the token (so a prod still
 *     on the 0114 admit or ensure body, or the 0099 verify body, fails with
 *     position 0). The three new
 *     RPCs have no earlier declaration at all, so a prod without 0130 fails the
 *     regprocedure cast, which the script also counts as a failure.
 *
 * Execution is not proven here: no Postgres is available to this suite. The
 * behavioural assertions live in app/supabase/tests/policy_tests.sql.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_DIR = `${ROOT}app/supabase/migrations/`;
const DRIFT_SCRIPT = lf(readFileSync(`${ROOT}scripts/verify-prod-function-drift.sh`, 'utf8'));
const MIGRATION_0130_FILE = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0130_'));
const M0130 = lf(readFileSync(`${MIGRATIONS_DIR}${MIGRATION_0130_FILE}`, 'utf8'));

interface Check {
  signature: string;
  token: string;
}

/** The six lines 0130 adds to CHECKS, and the newest earlier file declaring each function. */
const CHECKS_0130: ReadonlyArray<Check & { name: string; lastEarlier: string | null }> = [
  {
    name: 'admit_phone_attempt',
    signature: 'screening_v2.admit_phone_attempt(uuid,text,text,integer,timestamptz)',
    token: 'phone_parsing',
    lastEarlier: '0114_phone_outcome_integrity.sql',
  },
  {
    name: 'ensure_ashby_phone_engagement',
    signature: 'screening_v2.ensure_ashby_phone_engagement(uuid,timestamptz)',
    token: 'phone_parsing',
    lastEarlier: '0114_phone_outcome_integrity.sql',
  },
  {
    name: 'apply_ashby_candidate_profile',
    signature:
      'screening_v2.apply_ashby_candidate_profile(uuid,text,text,text,text,text,text,timestamptz)',
    token: 'ensure_ashby_phone_engagement',
    lastEarlier: null,
  },
  {
    name: 'claim_ashby_profile_due',
    signature: 'screening_v2.claim_ashby_profile_due(integer,integer,integer,integer,timestamptz)',
    token: 'profile_attempts',
    lastEarlier: null,
  },
  {
    name: 'release_ashby_number_after_identity_mismatch',
    signature: 'screening_v2.release_ashby_number_after_identity_mismatch(uuid,timestamptz)',
    token: 'identity_unconfirmed',
    lastEarlier: null,
  },
  {
    // §8 re-declares it (0099 + the M017-d engagements-first lock); the token
    // is that hunk's locking clause, which no earlier body carries.
    name: 'verify_candidate_phone',
    signature: 'screening_v2.verify_candidate_phone(uuid,text,uuid,timestamptz)',
    token: 'for update of e',
    lastEarlier: '0099_verify_phone_clears_stale_reason.sql',
  },
];
const NAMES = CHECKS_0130.map((c) => c.name);
const byName = (name: string) => CHECKS_0130.find((c) => c.name === name)!;

/** The `CHECKS=( ... )` entries: `<regprocedure>|<token>`, one per line. */
function driftChecks(): Check[] {
  const block = /CHECKS=\(\n([\s\S]*?)\n\)/.exec(DRIFT_SCRIPT);
  if (!block) throw new Error('CHECKS array not found');
  return block[1]
    .split('\n')
    .map((line) => /^\s*"([^"|]+)\|([^"]+)"\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ signature: m[1], token: m[2] }));
}

/**
 * Every declaration of `screening_v2.<name>(` in one migration, header to `$$;`.
 * `create function` is matched as well as `create or replace function`, so a
 * declaration written either way counts as an earlier body.
 */
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
function regprocedureArgs(declaration: string): string {
  const open = declaration.indexOf('(');
  const close = declaration.indexOf('\n)\nreturns', open);
  if (open === -1 || close === -1) throw new Error('argument list not found');
  const types = declaration
    .slice(open + 1, close)
    .split(',\n')
    .map((arg) => arg.trim().split(/\s+/)[1]);
  return `(${types.join(',')})`;
}

/** Code with `--` comments removed, so a token only a comment carries does not count. */
const code = (text: string) => text.replace(/--[^\n]*/g, '');

/** Earlier migrations (number < 0130), in order, with each declaration of `name`. */
function earlierDeclarations(name: string): Array<{ file: string; body: string }> {
  const found: Array<{ file: string; body: string }> = [];
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    const number = /^(\d{4})_.*\.sql$/.exec(file);
    if (!number || Number(number[1]) >= 130) continue;
    for (const body of declarations(lf(readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8')), name)) {
      found.push({ file, body });
    }
  }
  return found;
}

describe('verify-prod-function-drift.sh covers the functions 0130 declares', () => {
  it('lists the six 0130 checks verbatim', () => {
    for (const { signature, token } of CHECKS_0130) {
      expect(driftChecks()).toContainEqual({ signature, token });
    }
  });

  it.each(NAMES)('%s: exactly one check names it', (name) => {
    const matches = driftChecks().filter((c) => c.signature.startsWith(`screening_v2.${name}(`));
    expect(matches).toHaveLength(1);
    expect(matches[0].token).toBe(byName(name).token);
  });

  it.each(NAMES)('%s: the checked signature is exactly the one the 0130 CREATE header declares', (name) => {
    const [declaration, ...rest] = declarations(M0130, name);
    expect(declaration).toBeDefined();
    expect(rest).toEqual([]);
    expect(byName(name).signature).toBe(`screening_v2.${name}${regprocedureArgs(declaration)}`);
  });

  it.each(NAMES)('%s: the token is in the 0130 body, outside comments, so a correct prod passes', (name) => {
    const [declaration] = declarations(M0130, name);
    expect(code(declaration)).toContain(byName(name).token);
  });

  it.each(NAMES)(
    '%s: no earlier declaration carries the token, so a prod without 0130 fails',
    { timeout: 60_000 },
    (name) => {
      const { token, lastEarlier } = byName(name);
      const earlier = earlierDeclarations(name);
      if (lastEarlier === null) {
        // New in 0130: an old prod has no such function, so the regprocedure
        // cast fails and the script counts the unreadable answer as a failure.
        expect(earlier).toEqual([]);
      } else {
        // The latest pre-0130 definition exists, so the comparison is real.
        expect(earlier.length).toBeGreaterThan(0);
        expect(earlier[earlier.length - 1].file).toBe(lastEarlier);
      }
      for (const { file, body } of earlier) {
        expect(body, `${file} must not mention ${token}`).not.toContain(token);
      }
    },
  );

  it('fails closed on a function the database does not have', () => {
    expect(DRIFT_SCRIPT).toMatch(
      /if ! out=\$\([\s\S]*?\); then\n\s+echo "::error::drift check could not query[^\n]*\n\s+failures=\$\(\(failures \+ 1\)\)/,
    );
  });
});
