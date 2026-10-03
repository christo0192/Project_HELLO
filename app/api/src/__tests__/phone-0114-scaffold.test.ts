/**
 * 0114 (PR-C) scaffold, §1 constraints and suite wiring — C0 of M009/S03.
 *
 * 0114 is ONE migration in numbered sections, each filled by exactly one task
 * between its own BEGIN/END markers. These tests pin the frame every other
 * task builds on:
 *
 *   - the migration is registered NEWEST-FIRST in PHONE_MIGRATIONS, so every
 *     extractor reads 0114's bodies and CHECK lists, not 0113's;
 *   - the §1..§8 markers exist once each, in order, and nothing lives
 *     outside them except the header, the lock timeout and the final notify;
 *   - §1's two CHECKs are LIFTED (byte-identical to the newest prior list)
 *     plus only the stated members, NOT VALID then VALIDATE — a retyped list
 *     that silently dropped a member is the failure this pattern invites;
 *   - the policy suite has one block per section, before the verdict, with
 *     the unhalted phone-control assertion after the last block.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIGRATION_0114,
  MIGRATION_0114_PATH,
  PHONE_MIGRATIONS,
  checkMembers,
} from './support/phone-migration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../../supabase/migrations');
const POLICY_TESTS = path.resolve(HERE, '../../../supabase/tests/policy_tests.sql');

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const SQL = lf(MIGRATION_0114);
const stripComments = (s: string) => s.replace(/--[^\n]*/g, '');
const literals = (s: string) => [...stripComments(s).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);

const NEW_AUDIT_ACTIONS = [
  'phone_engagement_late_completed',
  'phone_scheduled_engagement_released',
  'phone_identity_hold_release',
  'phone_due_starved',
];

const AUDIT_RE =
  /add constraint chk_audit_action check \(\n {2}action = any \(array\[\n([\s\S]*?)\n {2}\]\)\n\) not valid;/;
const OUTCOME_RE =
  /add constraint chk_phone_call_attempts_outcome check \(\n([\s\S]*?)\)\)\n {2}not valid;/;

/** Every migration (sorted) that re-creates `re`, with its captured list text. */
function recreations(re: RegExp): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const m = lf(readFileSync(path.join(MIGRATIONS, file), 'utf8')).match(re);
    if (m) out.push({ file, body: m[1] });
  }
  return out;
}

function section(n: number): string {
  const begin = `-- ==== 0114 §${n} BEGIN ====`;
  const end = `-- ==== 0114 §${n} END ====`;
  const b = SQL.indexOf(begin);
  const e = SQL.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`0114 §${n} markers missing or inverted`);
  return SQL.slice(b + begin.length, e);
}

describe('0114 registration', () => {
  it('is the FIRST (newest) entry of PHONE_MIGRATIONS, ahead of 0113 and 0112', () => {
    const names = PHONE_MIGRATIONS.map((m) => m.name);
    expect(names[0]).toBe('0114');
    expect(names.indexOf('0114')).toBeLessThan(names.indexOf('0113'));
    expect(names.indexOf('0113')).toBeLessThan(names.indexOf('0112'));
    expect(names.filter((n) => n === '0114')).toHaveLength(1);
  });

  it('points at 0114_phone_outcome_integrity.sql and is the newest migration file', () => {
    expect(path.basename(MIGRATION_0114_PATH)).toBe('0114_phone_outcome_integrity.sql');
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(files.filter((f) => f.startsWith('0114_'))).toEqual(['0114_phone_outcome_integrity.sql']);
    expect(files[files.length - 1]).toBe('0114_phone_outcome_integrity.sql');
  });
});

describe('0114 frame', () => {
  it('has each §1..§8 BEGIN/END marker exactly once, in order', () => {
    let last = -1;
    for (let n = 1; n <= 8; n += 1) {
      for (const kind of ['BEGIN', 'END']) {
        const marker = `-- ==== 0114 §${n} ${kind} ====`;
        expect(SQL.split(marker).length - 1, marker).toBe(1);
        const at = SQL.indexOf(marker);
        expect(at, marker).toBeGreaterThan(last);
        last = at;
      }
    }
  });

  it('sets a LOCAL lock_timeout before §1 and ends with the PostgREST reload', () => {
    const lock = SQL.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(SQL.indexOf('-- ==== 0114 §1 BEGIN ===='));
    expect(SQL.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(SQL.split("notify pgrst, 'reload schema';").length - 1).toBe(1);
  });

  it('carries no executable SQL outside the section markers except lock_timeout and notify', () => {
    let outside = SQL;
    for (let n = 1; n <= 8; n += 1) outside = outside.replace(section(n), '');
    const statements = stripComments(outside)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('-- ===='));
    expect(statements).toEqual([
      "set local lock_timeout = '10s';",
      "notify pgrst, 'reload schema';",
    ]);
  });

  it('§1 reads no machine clock (and §1 declares no function)', () => {
    const s1 = stripComments(section(1)).toLowerCase();
    expect(s1).not.toMatch(/\bnow\s*\(|clock_timestamp|current_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/);
    expect(s1).not.toMatch(/create\s+or\s+replace\s+function/);
  });
});

describe('0114 §1a — chk_phone_call_attempts_outcome', () => {
  const all = recreations(OUTCOME_RE);

  it('0114 is the last re-creation, and its predecessor is 0095', () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[all.length - 1].file).toBe('0114_phone_outcome_integrity.sql');
    expect(all[all.length - 2].file).toBe('0095_phone_call_outcome_hygiene.sql');
  });

  it('is the 0095 list LIFTED byte-for-byte plus only callback_deferred', () => {
    const prev = all[all.length - 2].body;
    const mine = all[all.length - 1].body;
    expect(mine.startsWith(prev.trimEnd())).toBe(true);
    const added = literals(mine.slice(prev.trimEnd().length));
    expect(added).toEqual(['callback_deferred']);
    expect(new Set(literals(mine))).toEqual(new Set([...literals(prev), 'callback_deferred']));
  });

  it('is what the newest-first extractor now reads (14 members, a superset of 0095)', () => {
    const members = checkMembers('chk_phone_call_attempts_outcome');
    expect(members).toContain('callback_deferred');
    expect(members).toContain('consent_failed');
    expect(members).toContain('abandoned_pre_disclosure');
    expect(members).toContain('declined');
    expect(members).toHaveLength(14);
  });

  it('is added NOT VALID, then VALIDATED, with its comment re-set', () => {
    const s1 = section(1);
    const add = s1.indexOf('add constraint chk_phone_call_attempts_outcome');
    const validate = s1.indexOf('validate constraint chk_phone_call_attempts_outcome');
    expect(add).toBeGreaterThan(s1.indexOf('drop constraint if exists chk_phone_call_attempts_outcome'));
    expect(validate).toBeGreaterThan(add);
    expect(s1.indexOf('comment on constraint chk_phone_call_attempts_outcome')).toBeGreaterThan(validate);
  });
});

describe('0114 §1b — chk_audit_action', () => {
  const all = recreations(AUDIT_RE);

  it('0114 is the LAST re-creation (what audit-vocabulary.test.ts reads), after 0102', () => {
    expect(all[all.length - 1].file).toBe('0114_phone_outcome_integrity.sql');
    expect(all[all.length - 2].file).toBe('0102_audit_resource_generate.sql');
  });

  it('is the 0102 list LIFTED byte-for-byte plus only the four 0114 actions', () => {
    const prev = all[all.length - 2].body;
    const mine = all[all.length - 1].body;
    expect(mine.startsWith(prev.trimEnd())).toBe(true);
    expect(literals(mine.slice(prev.trimEnd().length))).toEqual(NEW_AUDIT_ACTIONS);
  });

  it('is a strict SUPERSET of the previous list — no member dropped', () => {
    const prev = new Set(literals(all[all.length - 2].body));
    const mine = new Set(literals(all[all.length - 1].body));
    expect([...prev].filter((a) => !mine.has(a))).toEqual([]);
    expect([...mine].filter((a) => !prev.has(a)).sort()).toEqual([...NEW_AUDIT_ACTIONS].sort());
    expect(mine.size).toBe(prev.size + NEW_AUDIT_ACTIONS.length);
  });

  it('the audit-vocabulary parser reads the same set from 0114', () => {
    // The exact regex audit-vocabulary.test.ts uses, so 0114 cannot be
    // shaped in a way that test silently skips.
    const m = SQL.match(
      /add constraint chk_audit_action check \(\s*action = any \(array\[([\s\S]*?)\]\s*\)/,
    );
    expect(m).not.toBeNull();
    const parsed = new Set(
      [...m![1].replace(/--[^\n]*/g, '').matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]),
    );
    expect(parsed).toEqual(new Set(literals(all[all.length - 1].body)));
  });

  it('is added NOT VALID, then VALIDATED, with its generation comment re-set to 0114', () => {
    const s1 = section(1);
    const add = s1.indexOf('add constraint chk_audit_action');
    const validate = s1.indexOf('validate constraint chk_audit_action');
    expect(add).toBeGreaterThan(s1.indexOf('drop constraint if exists chk_audit_action'));
    expect(validate).toBeGreaterThan(add);
    expect(s1).toContain("'Closed audit vocabulary through 0114.");
  });
});

describe('policy_tests.sql 0114 blocks', () => {
  const POL = lf(readFileSync(POLICY_TESTS, 'utf8'));
  const verdict = POL.indexOf('-- Verdict (includes all Phase 1 and Phase 2 WS-A tests above)');

  it('has each 0114-§1..§8 BEGIN/END marker exactly once, in order, before the verdict', () => {
    expect(verdict).toBeGreaterThan(-1);
    let last = POL.lastIndexOf("'0113-E4-repair");
    expect(last).toBeGreaterThan(-1);
    for (let n = 1; n <= 8; n += 1) {
      for (const kind of ['BEGIN', 'END']) {
        const marker = `-- ==== 0114-§${n} ${kind} ====`;
        expect(POL.split(marker).length - 1, marker).toBe(1);
        const at = POL.indexOf(marker);
        expect(at, marker).toBeGreaterThan(last);
        last = at;
      }
    }
    expect(verdict).toBeGreaterThan(last);
  });

  it('re-asserts the unhalted phone control AFTER the last 0114 block, as the last phone assertion', () => {
    const end8 = POL.indexOf('-- ==== 0114-§8 END ====');
    const unhalted = POL.indexOf(
      "'0114: the phone control singleton is present and NOT halted after every 0114 block'",
    );
    expect(unhalted).toBeGreaterThan(end8);
    expect(unhalted).toBeLessThan(verdict);
    expect(POL.slice(unhalted, verdict)).not.toMatch(/0114-§|perform screening_v2\.|select screening_v2\./);
  });
});
