/**
 * 0118 (R1 PR-LK-liveness) — production drift coverage for the two PHONE-SHARED
 * RPCs it re-declares, asserted against the migration TEXT and the drift script.
 *
 * Supabase never re-runs an applied migration, so a prod database that missed or
 * kept an older body of `claim_voice_worker` / `reset_voice_worker` would look
 * correct in every local and CI database. `scripts/verify-prod-function-drift.sh`
 * proves the LIVE body contains a token; for these two functions the token is
 * `livekit_host`, which only 0118 introduces. This file proves the check is
 * well-formed and DISCRIMINATING:
 *
 *   - each CHECKS signature is exactly the signature 0118 declares (a wrong
 *     regprocedure makes the live query fail, which the script counts as drift);
 *   - the token is present in the 0118 body (so a correct prod passes);
 *   - the token is absent from every earlier declaration of the function (so a
 *     prod still on the 0112 body fails with position 0).
 *
 * Execution is not proven here: no Postgres is available to this suite. The
 * behavioural assertions live in app/supabase/tests/r1_foundation_assert.sql.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_DIR = `${ROOT}app/supabase/migrations/`;
const DRIFT_SCRIPT = lf(readFileSync(`${ROOT}scripts/verify-prod-function-drift.sh`, 'utf8'));
const MIGRATION_0118_FILE = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0118_'));

const TOKEN = 'livekit_host';
const FUNCTIONS = ['claim_voice_worker', 'reset_voice_worker'] as const;

interface Check {
  signature: string;
  token: string;
}

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

/** Every declaration of `screening_v2.<name>(` in one migration, header to `$$;`. */
function declarations(sql: string, name: string): string[] {
  const anchor = `create or replace function screening_v2.${name}(`;
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = sql.indexOf(anchor, from);
    if (start === -1) return found;
    const end = sql.indexOf('\n$$;', start);
    if (end === -1) throw new Error(`${name} declaration is unterminated`);
    found.push(sql.slice(start, end));
    from = end;
  }
}

/** `(text,text,uuid,bigint,timestamptz)` from a declaration's argument list. */
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

const M0118 = lf(readFileSync(`${MIGRATIONS_DIR}${MIGRATION_0118_FILE}`, 'utf8'));

/** Earlier migrations (number < 0118), in order, that declare `name`. */
function earlierDeclarations(name: string): Array<{ file: string; body: string }> {
  const found: Array<{ file: string; body: string }> = [];
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    const number = /^(\d{4})_/.exec(file);
    if (!number || Number(number[1]) >= 118) continue;
    for (const body of declarations(lf(readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8')), name)) {
      found.push({ file, body });
    }
  }
  return found;
}

describe('verify-prod-function-drift.sh covers the functions 0118 re-declares', () => {
  it('keeps the original request_phone_rescreen check', () => {
    expect(driftChecks()).toContainEqual({
      signature: 'screening_v2.request_phone_rescreen(uuid,text,text,text,uuid,timestamptz)',
      token: 'ensure_ashby_phone_engagement',
    });
  });

  it.each(FUNCTIONS)('checks %s for the livekit_host token', (name) => {
    const matches = driftChecks().filter((c) => c.signature.startsWith(`screening_v2.${name}(`));
    expect(matches).toHaveLength(1);
    expect(matches[0].token).toBe(TOKEN);
  });

  it.each(FUNCTIONS)('%s: the checked signature is exactly the one 0118 declares', (name) => {
    const [declaration, ...rest] = declarations(M0118, name);
    expect(rest).toEqual([]);
    const check = driftChecks().find((c) => c.signature.startsWith(`screening_v2.${name}(`));
    expect(check?.signature).toBe(`screening_v2.${name}${regprocedureArgs(declaration)}`);
  });

  it.each(FUNCTIONS)('%s: the token is in the 0118 body, so a correct prod passes', (name) => {
    const [declaration] = declarations(M0118, name);
    expect(declaration).toContain(TOKEN);
  });

  it.each(FUNCTIONS)(
    '%s: no earlier declaration carries the token, so a prod on the old body fails (position 0)',
    (name) => {
      const earlier = earlierDeclarations(name);
      // The latest pre-0118 definition (0112) exists, so the comparison is real.
      expect(earlier.length).toBeGreaterThan(0);
      expect(earlier.map((e) => e.file)).toContain(
        readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0112_')),
      );
      for (const { file, body } of earlier) {
        expect(body, `${file} must not mention ${TOKEN}`).not.toContain(TOKEN);
      }
    },
  );

  it('keeps the script read-only and fail-closed', () => {
    expect(DRIFT_SCRIPT).toContain('set -euo pipefail');
    expect(DRIFT_SCRIPT).toMatch(
      /elif \[ "\$pos" -eq 0 \]; then[\s\S]*failures=\$\(\(failures \+ 1\)\)/,
    );
    expect(DRIFT_SCRIPT).not.toMatch(
      /\b(insert into|update screening_v2|delete from|create or replace|alter table|drop )\b/i,
    );
  });
});
