/**
 * Static guarantees for migration 0132, which raises the fleet daily cold-dial ceiling
 * (`phone_max_daily_dials()`) from 0094's 50 to 250. The behavioural proof runs on real Postgres
 * in supabase-ci: app/supabase/tests/phone_dial_scope_fleet_cap_assert.sql A1 asserts the shipped
 * value, B1..B4 prove the refusal logic at a lowered boundary, and F1 restores the shipped value
 * and admits through it. This file keeps the migration to exactly what it claims.
 *
 * It also makes a structural relaxation sound. The 0114, 0125 and 0130 scaffold tests set aside
 * every `_phone_fleet_daily_cap_<n>.sql` file, as they set aside R1 files, when they check that
 * their migration is the newest non-R1 one. That is safe only while such a file redeclares nothing
 * but this constant, which no newest-first extractor reads. The last block pins that for every
 * file with the infix, so a future cap migration that slips in anything else turns this red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../supabase/migrations');
const FILE = '0132_phone_fleet_daily_cap_250.sql';
const CAP_FILE_RE = /^\d{4}_phone_fleet_daily_cap_\d+\.sql$/;
/** Normalised to LF so a Windows (CRLF) checkout compares the same as CI. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (name: string): string => lf(readFileSync(path.join(MIGRATIONS, name), 'utf8'));
const readRepo = (rel: string): string => lf(readFileSync(path.resolve(here, rel), 'utf8'));
/** SQL with `--` comments removed (no string literal in these files contains `--`). */
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const flat = (sql: string): string => stripComments(sql).replace(/\s+/g, ' ').trim().toLowerCase();

const M0132 = read(FILE);
const CODE = flat(M0132);

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

const allFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

describe('migration 0132: frame', () => {
  it('is the only migration with its number and carries the fleet-cap infix', () => {
    expect(allFiles().filter((f) => f.startsWith('0132_'))).toEqual([FILE]);
    expect(FILE).toMatch(CAP_FILE_RE);
  });

  it('opens with a LOCAL lock_timeout', () => {
    expect(CODE.startsWith("set local lock_timeout = '10s';")).toBe(true);
  });

  it('declares exactly one function, phone_max_daily_dials(), and nothing else', () => {
    expect(declaredFunctions(M0132)).toEqual(['phone_max_daily_dials']);
    expect(CODE).not.toMatch(/\b(alter|drop|truncate|insert|update|delete)\b|create (table|index|trigger|view|policy)|\bdo \$/);
  });
});

describe('migration 0132: the ceiling', () => {
  it('returns 250, and the previous declaration (0094) returned 50', () => {
    expect(capIn(M0132)).toBe(250);
    const declaring = allFiles().filter((f) => capIn(read(f)) !== null);
    expect(declaring).toEqual(['0094_phone_dial_scope_fleet_cap_suppressions.sql', FILE]);
    expect(capIn(read(declaring[0]))).toBe(50);
  });

  it('keeps 0094\'s declaration shape: IMMUTABLE, pinned search_path, NOT security definer', () => {
    expect(CODE).toContain(
      "create or replace function screening_v2.phone_max_daily_dials() returns integer language sql immutable set search_path to 'pg_catalog' as $$ select 250 $$;",
    );
    expect(CODE).not.toContain('security definer');
  });

  it('restates the ACL: revoked from browser roles, executable by service_role only', () => {
    expect(CODE).toContain(
      'revoke all on function screening_v2.phone_max_daily_dials() from public, anon, authenticated;',
    );
    expect(CODE).toContain('grant execute on function screening_v2.phone_max_daily_dials() to service_role;');
    expect(CODE).not.toMatch(/grant [^;]*phone_max_daily_dials[^;]* to (public|anon|authenticated)/);
  });

  it('is the value the real-Postgres suite asserts as shipped (A1)', () => {
    const assert = readRepo('../../../supabase/tests/phone_dial_scope_fleet_cap_assert.sql');
    expect(assert).toContain('if screening_v2.phone_max_daily_dials() <> 250 then');
    expect(assert).not.toContain('if screening_v2.phone_max_daily_dials() <> 50 then');
  });

  it('is checked against the LIVE body after every production migration', () => {
    const drift = readRepo('../../../../scripts/verify-prod-function-drift.sh');
    expect(drift).toContain('  "screening_v2.phone_max_daily_dials()|select 250"\n');
    // No earlier declaration carries the token, so a prod still on 0094 fails the check.
    for (const f of allFiles().filter((x) => x < FILE)) {
      expect(read(f), `${f} must not contain the drift token`).not.toContain('select 250');
    }
  });
});

describe('fleet-cap migrations are safe to set aside in the 0114/0125/0130 newest-file pins', () => {
  const capFiles = allFiles().filter((f) => CAP_FILE_RE.test(f));

  it('includes 0132', () => {
    expect(capFiles).toContain(FILE);
  });

  it.each(capFiles)('%s redeclares only phone_max_daily_dials() and touches no table, trigger or audit list', (f) => {
    const sql = read(f);
    expect(declaredFunctions(sql)).toEqual(['phone_max_daily_dials']);
    expect(flat(sql)).not.toMatch(/\b(alter|drop|truncate|insert|update|delete)\b|create (table|index|trigger|view|policy)|chk_audit_action/);
    // The file name carries the value it ships, so a reader of the migration list sees the cap.
    expect(capIn(sql)).toBe(Number(/_(\d+)\.sql$/.exec(f)![1]));
  });
});
