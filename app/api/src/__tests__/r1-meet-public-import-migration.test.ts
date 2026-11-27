/**
 * Static guarantees for migration 0144 (M035 S12: the public R1 booking page's on-the-spot Ashby
 * import, and the fences that keep such an import away from resume ingestion, the Ashby profile
 * step and the phone lane). The behavioural SQL assertions run in supabase-ci
 * (app/supabase/tests/r1_meet_public_import_assert.sql); these text-level checks keep the file
 * dark, additive, independent of 0143, and keep the lifted claim_ashby_profile_due equal to its
 * 0130 declaration plus exactly one marked hunk.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONE_MIGRATIONS } from './support/phone-migration.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const FILE = '0144_r1_meet_public_import.sql';
const sql = lf(readFileSync(path.join(migrations, FILE), 'utf8'));
const M0130 = lf(readFileSync(path.join(migrations, '0130_ashby_phone_parsing_intake.sql'), 'utf8'));
/** Whole-line comments removed, whitespace collapsed: a layout-independent view of the executable SQL. */
const code = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
const lc = code.toLowerCase();
/** The TOP-LEVEL statements only: every dollar-quoted body (functions, DO blocks) replaced by a stub. */
const top = lc.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, () => '$body$');
/** The top level with string literals emptied: comment texts and IN-lists cannot hide or fake DDL. */
const topBare = top.replace(/'(?:[^']|'')*'/g, "''");

/** The executable text from `startMarker` up to (not including) `endMarker`. */
function block(startMarker: string, endMarker: string): string {
  const start = code.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  const end = code.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** The quoted values of a SQL list such as `'a', 'b'`. */
function quoted(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** The body of a named function in the collapsed code (from its header to the closing `$$;`). */
function functionBody(name: string): string {
  return block(`create or replace function screening_v2.${name}(`, '$$;');
}

/** One function declaration (header through the closing `$$;`) from a file, exactly as written. */
function bodyIn(text: string, name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = text.indexOf(anchor);
  if (start === -1) throw new Error(`${name} not declared`);
  if (text.indexOf(anchor, start + 1) !== -1) throw new Error(`${name} declared twice`);
  const end = text.indexOf('\n$$;\n', start);
  if (end === -1) throw new Error(`${name} unterminated`);
  return text.slice(start, end + '\n$$;\n'.length);
}

/** Remove every marked 0144 hunk; returns the residue and the hunks by tag id, in order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = /^[ \t]*-- ▼ 0144 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0144 ([^\n]+)\n/gm;
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    const id = open.split(' ')[0]!;
    tags.push(id);
    hunks[id] = (hunks[id] ?? '') + inner;
    return '';
  });
  if (/▼ 0144|▲ 0144/.test(residue)) throw new Error('unbalanced 0144 hunk marker');
  return { residue, tags, hunks };
}

/** The verbatim text from `start` through `end` (inclusive) in a file, found exactly once. */
function slice(text: string, start: string, end: string): string {
  const at = text.indexOf(start);
  if (at === -1) throw new Error(`${start} not found`);
  if (text.indexOf(start, at + 1) !== -1) throw new Error(`${start} found twice`);
  return text.slice(at, text.indexOf(end, at) + end.length);
}

/** The joined string literals of `comment on <kind> <name> is ...;` in a file. */
function commentText(text: string, anchor: string): string {
  const start = text.indexOf(anchor);
  if (start === -1) throw new Error(`${anchor} not found`);
  if (text.indexOf(anchor, start + 1) !== -1) throw new Error(`${anchor} found twice`);
  const end = text.indexOf("';\n", start);
  return [...text.slice(start + anchor.length, end + 2).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).join('');
}

/** The IN-list of one inline 0130 CHECK (the regex of contract-openapi.test.ts). */
function check0130(constraint: string, column: string): string[] {
  const m = new RegExp(`${constraint} check \\((?:${column} is null or )?${column} in \\(([^)]*)\\)\\)`).exec(M0130);
  expect(m, constraint).not.toBeNull();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** Code with comments and a signature's `default now()` removed (phone-0130-intake.test.ts). */
const withoutComments = (body: string): string =>
  body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

const LINKS = 'screening_v2.ashby_application_links';
const INTAKE_CHECK = 'chk_ashby_application_links_intake_type';
const INTAKE_VALUES = ['resume_parsing', 'phone_parsing', 'r1_public_booking'];

/** The three trigger functions of §2-§3, their closed messages, and their triggers. */
const GUARDS = [
  {
    fn: 'reject_r1_public_booking_intake_change',
    message: 'r1_public_booking: the intake type of a public booking import never changes',
    trigger: 'trg_ashby_application_links_intake_locked',
    table: LINKS,
    create:
      'create trigger trg_ashby_application_links_intake_locked before update of intake_type on ' +
      `${LINKS} for each row when (old.intake_type is distinct from new.intake_type and ` +
      "(old.intake_type = 'r1_public_booking' or new.intake_type = 'r1_public_booking')) " +
      'execute function screening_v2.reject_r1_public_booking_intake_change();',
  },
  {
    fn: 'reject_r1_public_booking_engagement',
    message: 'r1_public_booking: a public booking import never gets a phone engagement',
    trigger: 'trg_phone_engagements_r1_public_booking',
    table: 'screening_v2.phone_engagements',
    create:
      'create trigger trg_phone_engagements_r1_public_booking before insert on ' +
      'screening_v2.phone_engagements for each row execute function ' +
      'screening_v2.reject_r1_public_booking_engagement();',
  },
  {
    fn: 'reject_r1_public_booking_ingestion',
    message: 'r1_public_booking: a public booking import never gets a resume ingestion',
    trigger: 'trg_ashby_resume_ingestions_r1_public_booking',
    table: 'screening_v2.ashby_resume_ingestions',
    create:
      'create trigger trg_ashby_resume_ingestions_r1_public_booking before insert on ' +
      'screening_v2.ashby_resume_ingestions for each row execute function ' +
      'screening_v2.reject_r1_public_booking_ingestion();',
  },
] as const;

const CLAIM_0130 = bodyIn(M0130, 'claim_ashby_profile_due');
const CLAIM_0144 = bodyIn(sql, 'claim_ashby_profile_due');
const CLAIM = stripHunks(CLAIM_0144);

describe('migration 0144: file and frame', () => {
  it('is the only 0144 migration, carries the _r1_ infix and follows 0142 (and 0143 when present)', () => {
    const numbered = readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(numbered.filter((name) => name.startsWith('0144_'))).toEqual([FILE]);
    // The _r1_ infix is what exempts it from the phone lane's "newest non-R1 migration" pins.
    expect(FILE).toMatch(/^0144_r1_[a-z0-9_]+\.sql$/);
    // Not "the newest": a later migration must not turn this test red.
    expect(numbered.indexOf(FILE)).toBeGreaterThan(numbered.indexOf('0142_r1_meet_bookings.sql'));
    for (const f143 of numbered.filter((name) => name.startsWith('0143_'))) {
      expect(numbered.indexOf(FILE), f143).toBeGreaterThan(numbered.indexOf(f143));
    }
  });

  it('sets a local lock_timeout first and reloads PostgREST last', () => {
    expect(code.startsWith("set local lock_timeout = '10s';")).toBe(true);
    expect(code.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(code.split("set local lock_timeout = '10s';")).toHaveLength(2);
    expect(code.split("notify pgrst, 'reload schema';")).toHaveLength(2);
  });

  it('documents that it is dark, additive and re-runnable, what it redeclares, and that 0143 is not needed', () => {
    expect(sql.startsWith('-- DARK. ')).toBe(true);
    const header = sql
      .slice(0, sql.indexOf("set local lock_timeout = '10s';"))
      .replace(/^--[ \t]?/gm, '')
      .replace(/\s+/g, ' ');
    expect(header).toContain('Additive and re-runnable');
    expect(header).toContain('R1_MEET_PUBLIC_BOOKING_ENABLED (default OFF');
    expect(header).toContain(
      'Redeclares (lifted in full, ONE marked hunk each): claim_ashby_profile_due (0130 §6), ' +
        'v_ashby_application_impact (0140 §2). References no 0143 object.',
    );
  });

  it('keeps its sections in order, each between two dash rules', () => {
    const markers = ['-- §1. ', '-- §2. ', '-- §3. ', '-- §4. ', '-- §5. ', '-- §6. ', '-- §7. ', '-- §90. '];
    const lines = sql.split('\n');
    let last = -1;
    for (const marker of markers) {
      expect(sql.split(marker).length - 1, marker).toBe(1);
      expect(sql.indexOf(marker), marker).toBeGreaterThan(last);
      last = sql.indexOf(marker);
      const at = lines.findIndex((line) => line.startsWith(marker));
      expect(lines[at - 1], marker).toMatch(/^-- -{80,}$/);
      expect(lines[at + 1], marker).toMatch(/^-- -{80,}$/);
    }
  });

  it('is not a phone-lane migration: the extractors keep reading the 0130 claim body', () => {
    expect(PHONE_MIGRATIONS.map((m) => m.name)).not.toContain('0144');
  });
});

describe('migration 0144 §1: the intake CHECK learns r1_public_booking', () => {
  /** §1 in the collapsed code: from the first statement to the column comment that closes it. */
  const section1 = block(`alter table ${LINKS} drop constraint`, `comment on column ${LINKS}.intake_type is`);

  it('is exactly the guarded drop, the NOT VALID add and the validation, in that order', () => {
    expect(section1.trim()).toBe(
      `alter table ${LINKS} drop constraint if exists ${INTAKE_CHECK}; ` +
        `alter table ${LINKS} add constraint ${INTAKE_CHECK} check (intake_type in ` +
        "('resume_parsing', 'phone_parsing', 'r1_public_booking')) not valid; " +
        `alter table ${LINKS} validate constraint ${INTAKE_CHECK};`,
    );
    // Nowhere else in the file is the constraint dropped, added or validated.
    expect(code.split(INTAKE_CHECK)).toHaveLength(4);
  });

  it('adds exactly the new value after the two 0130 values', () => {
    const m = /add constraint chk_ashby_application_links_intake_type check \(intake_type in \(([^)]*)\)\) not valid;/.exec(code);
    expect(m).not.toBeNull();
    const values = quoted(m![1]!);
    expect(values).toEqual(INTAKE_VALUES);
    expect(values.slice(0, 2)).toEqual(check0130(INTAKE_CHECK, 'intake_type'));
  });

  it('keeps the 0130 column comment and appends the 0144 sentence', () => {
    const anchor = `comment on column ${LINKS}.intake_type is\n`;
    const text = commentText(sql, anchor);
    const original = commentText(M0130, anchor);
    expect(text.startsWith(original)).toBe(true);
    expect(text.slice(original.length)).toBe(
      ' 0144 (M035 S12): r1_public_booking means the public R1 booking page imported this application ' +
        'on the spot (r1_meet_public_import_application, the only writer); it never gets a resume ' +
        'ingestion, a phone engagement or the Ashby profile step, and the value never changes.',
    );
  });
});

describe('migration 0144 §2-§3: the intake lock and the two insert guards', () => {
  for (const guard of GUARDS) {
    it(`${guard.fn}: a security-definer trigger function that raises one closed message`, () => {
      const body = functionBody(guard.fn);
      expect(body).toContain(
        `create or replace function screening_v2.${guard.fn}() returns trigger language plpgsql ` +
          'security definer set search_path = pg_catalog, screening_v2 as $$',
      );
      const raises = [...body.matchAll(/raise exception '((?:[^']|'')*)' using errcode = 'P0001';/g)].map((m) => m[1]);
      expect(raises).toEqual([guard.message]);
      expect(body.split('raise ')).toHaveLength(2);
      // Closed: no placeholder, so no id or value can reach the message.
      expect(guard.message).not.toContain('%');
      expect(body).not.toMatch(/\b(insert into|update|delete from)\b/);
      expect(body).toContain('return new;');
    });

    it(`${guard.trigger}: exact timing, table and condition, after a guarded drop`, () => {
      const drop = `drop trigger if exists ${guard.trigger} on ${guard.table};`;
      expect(code).toContain(`${drop} ${guard.create}`);
      expect(code.split(`create trigger ${guard.trigger} `)).toHaveLength(2);
    });
  }

  it('the two insert guards look the link up by the row\'s link id and the new value only', () => {
    for (const guard of GUARDS.slice(1)) {
      expect(functionBody(guard.fn)).toContain(
        `if exists (select 1 from ${LINKS} l where l.id = new.application_link_id and ` +
          "l.intake_type = 'r1_public_booking') then raise exception",
      );
    }
  });

  it('creates exactly these three triggers', () => {
    expect([...lc.matchAll(/create trigger ([a-z0-9_]+) /g)].map((m) => m[1])).toEqual(GUARDS.map((g) => g.trigger));
  });

  it('no client role may execute a trigger function, and each has a 0144 comment', () => {
    for (const guard of GUARDS) {
      expect(code).toContain(`revoke all on function screening_v2.${guard.fn}() from public, anon, authenticated;`);
      expect(code).not.toMatch(new RegExp(`grant [a-z ,]+ on function screening_v2\\.${guard.fn}\\(`));
      expect(commentText(sql, `comment on function screening_v2.${guard.fn}() is\n`)).toMatch(/^0144 \(M035 S12\): /);
    }
  });
});

describe('migration 0144 §4: claim_ashby_profile_due is the 0130 claim plus one marked hunk', () => {
  it('is byte-identical to the 0130 declaration once the hunk is removed', () => {
    expect(CLAIM.residue).toBe(CLAIM_0130);
  });

  it('has exactly one hunk, M035-S12-a, whose code is the intake filter', () => {
    expect(CLAIM.tags).toEqual(['M035-S12-a']);
    expect(withoutComments(CLAIM.hunks['M035-S12-a']!).trim()).toBe("and l.intake_type <> 'r1_public_booking'");
    expect(sql.split('▼ 0144')).toHaveLength(2);
    expect(sql.split('▲ 0144')).toHaveLength(2);
  });

  it('places the hunk right after the lifecycle filter, inside the due CTE', () => {
    const lines = CLAIM_0144.split('\n');
    const open = lines.findIndex((line) => line.includes('-- ▼ 0144 M035-S12-a'));
    expect(lines[open - 1]).toBe("       and l.lifecycle not in ('completed', 'cancelled')");
    expect(CLAIM_0144.indexOf('with due as (')).toBeLessThan(CLAIM_0144.indexOf('▼ 0144'));
    expect(CLAIM_0144.indexOf('▼ 0144')).toBeLessThan(CLAIM_0144.indexOf('     order by l.profile_checked_at'));
  });

  it('keeps the 0130 revoke and grant lines verbatim and right after the function', () => {
    const grants = slice(
      M0130,
      'revoke all on function screening_v2.claim_ashby_profile_due(',
      '  to service_role;\n',
    );
    expect(grants.split('\n')).toHaveLength(5);
    expect(sql).toContain(`${CLAIM_0144}\n${grants}`);
  });

  it('keeps the 0130 comment and appends the 0144 sentence', () => {
    const anchor = 'comment on function screening_v2.claim_ashby_profile_due is\n';
    expect(commentText(sql, anchor)).toBe(
      `${commentText(M0130, anchor)} 0144 (M035 S12): never claims an r1_public_booking link.`,
    );
  });
});

describe('migration 0144: additive and dark', () => {
  const ALLOWED_DROPS = [
    `alter table ${LINKS} drop constraint if exists ${INTAKE_CHECK}`,
    ...GUARDS.map((g) => `drop trigger if exists ${g.trigger} on ${g.table}`),
  ];

  it('drops only its CHECK (to re-add it) and its own triggers', () => {
    const statements = topBare.split(';').map((s) => s.trim());
    expect(statements.filter((s) => /\bdrop\b/.test(s))).toEqual(ALLOWED_DROPS);
  });

  it('deletes, updates, inserts or truncates no row, and alters no column', () => {
    expect(topBare).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\balter\s+column\b|\bdrop\s+not\s+null\b|\brename\b/);
    expect(topBare).not.toMatch(/\bupdate\s+(?:only\s+)?[a-z0-9_]+(?:\.[a-z0-9_]+)?\s+set\b/);
    expect(topBare).not.toMatch(/\binsert\s+into\b/);
    expect(topBare).not.toMatch(/\bset\s+default\b|\bdrop\s+default\b/);
  });

  it('alters only the links table and creates no table, index, type, sequence or policy', () => {
    const altered = [...lc.matchAll(/\balter table (?:only )?([a-z0-9_.]+)/g)].map((m) => m[1]!);
    expect(new Set(altered)).toEqual(new Set([LINKS]));
    expect(topBare).not.toMatch(/\bcreate (?:unique )?index\b|\bcreate table\b|\bcreate type\b|\bcreate sequence\b|\bcreate policy\b/);
  });

  it('reads no machine clock in any function body', () => {
    const bodies = [...sql.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\([\s\S]*?\n\$\$;\n/g)];
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const m of bodies) {
      expect(withoutComments(m[0]), m[1]).not.toMatch(MACHINE_CLOCK);
    }
  });

  it('names no 0143 object (S01 builds it in parallel; 0144 must apply without it)', () => {
    for (const name of [
      'r1_meet_bookings',
      'r1_meet_public_capacity',
      'r1_meet_public_precheck',
      'r1_meet_create_round_from_public',
    ]) {
      expect(sql, name).not.toContain(name);
    }
  });
});
