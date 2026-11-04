/**
 * Static guarantees for migration 0135, which raises the fleet daily cold-dial ceiling
 * (`phone_max_daily_dials()`) from 0132's 250 to 500. The behavioural proof runs on real Postgres
 * in supabase-ci: app/supabase/tests/phone_dial_scope_fleet_cap_assert.sql A1 asserts the shipped
 * value, B1..B4 prove the refusal logic at a lowered boundary, and F1 restores the shipped value
 * and admits through it.
 *
 * The last block is written for whichever cap migration is newest, not for 0135 alone. A1 and the
 * deploy's drift check must name the value the newest cap file ships, so the next raise cannot
 * update the migration and forget the two checks that prove it reached production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../supabase/migrations');
const FILE = '0135_phone_fleet_daily_cap_500.sql';
const CAP_FILE_RE = /^\d{4}_phone_fleet_daily_cap_(\d+)\.sql$/;
/** Normalised to LF so a Windows (CRLF) checkout compares the same as CI. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (name: string): string => lf(readFileSync(path.join(MIGRATIONS, name), 'utf8'));
const readRepo = (rel: string): string => lf(readFileSync(path.resolve(here, rel), 'utf8'));
/** SQL with `--` comments removed (no string literal in these files contains `--`). */
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const flat = (sql: string): string => stripComments(sql).replace(/\s+/g, ' ').trim().toLowerCase();

const allFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

/** Every function a migration declares, by name, in order. */
const declaredFunctions = (sql: string): string[] =>
  [...flat(sql).matchAll(/create (?:or replace )?function screening_v2\.([a-z0-9_]+)\s*\(/g)].map(
    (m) => m[1],
  );

/** The literal a `phone_max_daily_dials()` declaration returns, from a file's code. */
function capIn(sql: string): number | null {
  const m = /create or replace function screening_v2\.phone_max_daily_dials\(\) returns integer language sql immutable set search_path to 'pg_catalog' as \$\$ select (\d+) \$\$;/.exec(
    flat(sql),
  );
  return m ? Number(m[1]) : null;
}

describe('migration 0135: frame', () => {
  it('exists, is the only migration with its number, and carries the fleet-cap infix', () => {
    expect(allFiles().filter((f) => f.startsWith('0135_'))).toEqual([FILE]);
    expect(FILE).toMatch(CAP_FILE_RE);
  });

  it('opens with a LOCAL lock_timeout', () => {
    expect(flat(read(FILE)).startsWith("set local lock_timeout = '10s';")).toBe(true);
  });

  it('declares exactly one function, phone_max_daily_dials(), and nothing else', () => {
    const sql = read(FILE);
    expect(declaredFunctions(sql)).toEqual(['phone_max_daily_dials']);
    expect(flat(sql)).not.toMatch(/\b(alter|drop|truncate|insert|update|delete)\b|create (table|index|trigger|view|policy)|\bdo \$/);
  });
});

describe('migration 0135: the ceiling', () => {
  it('returns 500, and the declaration before it (0132) returned 250', () => {
    expect(capIn(read(FILE))).toBe(500);
    const declaring = allFiles().filter((f) => capIn(read(f)) !== null);
    expect(declaring).toEqual([
      '0094_phone_dial_scope_fleet_cap_suppressions.sql',
      '0132_phone_fleet_daily_cap_250.sql',
      FILE,
    ]);
    expect(capIn(read(declaring[1]))).toBe(250);
  });

  it('keeps the declaration shape: IMMUTABLE, pinned search_path, NOT security definer', () => {
    const code = flat(read(FILE));
    expect(code).toContain(
      "create or replace function screening_v2.phone_max_daily_dials() returns integer language sql immutable set search_path to 'pg_catalog' as $$ select 500 $$;",
    );
    expect(code).not.toContain('security definer');
  });

  it('restates the ACL: revoked from browser roles, executable by service_role only', () => {
    const code = flat(read(FILE));
    expect(code).toContain(
      'revoke all on function screening_v2.phone_max_daily_dials() from public, anon, authenticated;',
    );
    expect(code).toContain('grant execute on function screening_v2.phone_max_daily_dials() to service_role;');
    expect(code).not.toMatch(/grant [^;]*phone_max_daily_dials[^;]* to (public|anon|authenticated)/);
  });

  it('leaves the concurrency cap alone', () => {
    expect(flat(read(FILE))).not.toContain('phone_max_concurrent');
  });
});

describe('the newest fleet-cap migration is what production is checked against', () => {
  const capFiles = allFiles().filter((f) => CAP_FILE_RE.test(f));
  const newest = capFiles[capFiles.length - 1]!;
  const shipped = Number(CAP_FILE_RE.exec(newest)![1]);

  it('the newest cap file declares the value its name carries', () => {
    expect(capIn(read(newest))).toBe(shipped);
  });

  it('no migration after it redeclares the cap', () => {
    const after = allFiles().filter((f) => f > newest);
    for (const f of after) expect(capIn(read(f)), `${f} redeclares the cap`).toBeNull();
  });

  it('the real-Postgres suite asserts exactly that value as shipped (A1)', () => {
    const assert = readRepo('../../../supabase/tests/phone_dial_scope_fleet_cap_assert.sql');
    const a1 = [...assert.matchAll(/if screening_v2\.phone_max_daily_dials\(\) <> (\d+) then/g)].map((m) => Number(m[1]));
    expect(a1).toEqual([shipped]);
  });

  it('the deploy drift check proves production runs exactly that value', () => {
    const drift = readRepo('../../../../scripts/verify-prod-function-drift.sh');
    const tokens = [...drift.matchAll(/"screening_v2\.phone_max_daily_dials\(\)\|select (\d+)"/g)].map((m) => Number(m[1]));
    expect(tokens).toEqual([shipped]);
    // No earlier migration carries the token, so a production database on any
    // earlier cap fails the check instead of passing it by accident.
    for (const f of allFiles().filter((x) => x < newest)) {
      expect(read(f), `${f} must not contain the drift token`).not.toContain(`select ${shipped}`);
    }
  });
});
