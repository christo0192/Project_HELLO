/**
 * Static guarantees for migration 0144 (M035 S12: the public R1 booking page's on-the-spot Ashby
 * import, and the fences that keep such an import away from resume ingestion, the Ashby profile
 * step and the phone lane). The behavioural SQL assertions run in supabase-ci
 * (app/supabase/tests/r1_meet_public_import_assert.sql); these text-level checks keep the file
 * dark, additive, independent of 0143, keep the lifted claim_ashby_profile_due and
 * v_ashby_application_impact equal to their 0130 and 0140 declarations plus exactly one marked
 * hunk each, keep the local lookup RPC in step with the S04 store that reads it, and keep the
 * import RPC's order, writes and answers to the contract (link first, then the shell; never an
 * ingestion, an engagement or any other row).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONE_MIGRATIONS } from './support/phone-migration.js';
import { STRICT_IN_MOBILE_E164 } from '../lib/candidate-phone.js';
import {
  R1_PUBLIC_DSAR_HOLD_STATUSES,
  R1_PUBLIC_DSAR_HOLD_TYPES,
  R1_PUBLIC_LOCAL_ROWS_RPC,
  R1_PUBLIC_LOCAL_ROW_COLUMNS,
} from '../lib/r1/meet/public/match-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const FILE = '0144_r1_meet_public_import.sql';
const sql = lf(readFileSync(path.join(migrations, FILE), 'utf8'));
const M0130 = lf(readFileSync(path.join(migrations, '0130_ashby_phone_parsing_intake.sql'), 'utf8'));
const M0140 = lf(readFileSync(path.join(migrations, '0140_ashby_business_impact.sql'), 'utf8'));
const RUNTIME = lf(readFileSync(path.resolve(here, '../integrations/ashby/runtime.ts'), 'utf8'));
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

/** Executable text only: comments and a signature's `default now()` removed, whitespace collapsed. */
const flat = (text: string): string => withoutComments(text).replace(/\s+/g, ' ').trim();

/** §5: the view as 0140 and 0144 declare it (from its header through `from facts f;`). */
const VIEW_START = 'create or replace view screening_v2.v_ashby_application_impact';
const VIEW_END = '\nfrom facts f;\n';
const VIEW_0140 = slice(M0140, VIEW_START, VIEW_END);
const VIEW_0144 = slice(sql, VIEW_START, VIEW_END);
const VIEW = stripHunks(VIEW_0144);

/** §6 and §7: the two RPCs, as written and as executable text. */
const LOCAL_ROWS_RAW = bodyIn(sql, R1_PUBLIC_LOCAL_ROWS_RPC);
const LOCAL_ROWS = flat(LOCAL_ROWS_RAW);
const IMPORT_RPC = 'r1_meet_public_import_application';
const IMPORT_RAW = bodyIn(sql, IMPORT_RPC);
const IMPORT = flat(IMPORT_RAW);

/** The import RPC's parameters, its invalid_request fields and its refusal codes (contracts §4.2, §9). */
const IMPORT_PARAMETERS = [
  'p_ashby_application_id text',
  'p_ashby_candidate_id text',
  'p_ashby_job_id text',
  'p_ashby_stage_id text',
  'p_name text',
  'p_email text',
  'p_phone_e164 text',
  'p_now timestamptz default now()',
];
const IMPORT_SIGNATURE = 'text, text, text, text, text, text, text, timestamptz';
const IMPORT_FIELDS = ['application_id', 'ashby_candidate_id', 'job_id', 'stage_id', 'name', 'email', 'phone', 'now'];
const IMPORT_CODES = ['dsar_hold', 'candidate_ineligible', 'application_terminal', 'link_unbound', 'mapping_unavailable'];

/** The shell's columns: the Ashby import's insertCandidateShell columns, then the 0130 marker and the two times. */
const SHELL_COLUMNS = [
  'role_id', 'owner_id', 'resume_id', 'name', 'email', 'phone_raw', 'phone_e164', 'phone_valid', 'skills',
  'experience_years', 'parsed', 'status', 'ats_source', 'ashby_phone_applied_at', 'created_at', 'updated_at',
];

/** The tables an import must never write (contracts §4.2: no ingestion, engagement, operation or invite rows). */
const NEVER_WRITTEN = [
  'ashby_resume_ingestions',
  'phone_engagements',
  'ashby_operations',
  'job_queue',
  'call_sessions',
  'candidate_invites',
  'consent_records',
  'interview_round_consents',
];

/** The distinct values, in order of first appearance. */
const firstSeen = (values: readonly string[]): string[] => [...new Set(values)];

/** Every `'<key>', '<value>'` literal pair's value for one key, in order. */
function literalsOf(body: string, key: string): string[] {
  return [...body.matchAll(new RegExp(`'${key}', '([a-z_]+)'`, 'g'))].map((m) => m[1]!);
}

/** Every `return jsonb_build_object(...)` of a body: its keys and values, in order. */
function answers(body: string): Array<{ keys: string[]; values: string[] }> {
  return [...body.matchAll(/return jsonb_build_object\(([^()]*)\);/g)].map((m) => {
    const parts = m[1]!.split(',').map((part) => part.trim());
    return {
      keys: parts.filter((_, i) => i % 2 === 0).map((key) => key.replace(/^'|'$/g, '')),
      values: parts.filter((_, i) => i % 2 === 1),
    };
  });
}

/** The column and value lists of the one `insert into screening_v2.<table> (...) values (...)` of a body. */
function insertInto(body: string, table: string): { columns: string[]; values: string[] } {
  const all = [...body.matchAll(new RegExp(`insert into screening_v2\\.${table} \\(([^)]*)\\) values \\(([^)]*)\\)`, 'g'))];
  expect(all, table).toHaveLength(1);
  const list = (text: string): string[] => text.split(',').map((part) => part.trim());
  return { columns: list(all[0]![1]!), values: list(all[0]![2]!) };
}

/** The keys insertCandidateShell (integrations/ashby/runtime.ts) writes, in order. */
function shellInsertKeys(): string[] {
  const at = RUNTIME.indexOf('async insertCandidateShell(input)');
  expect(at).toBeGreaterThan(-1);
  const start = RUNTIME.indexOf('.insert({', at);
  const end = RUNTIME.indexOf('})', start);
  expect(start).toBeGreaterThan(at);
  return [...RUNTIME.slice(start, end).matchAll(/^\s+([a-z0-9_]+):/gm)].map((m) => m[1]!);
}

/**
 * The statements of a migration that write r1_public_booking into a link's intake_type: an insert
 * into the links that names intake_type and the value, or an update whose SET names both.
 */
function intakeWrites(text: string): string[] {
  const all = flat(lf(text)).toLowerCase();
  const out: string[] = [];
  for (const m of all.matchAll(/\binsert into (?:screening_v2\.)?ashby_application_links\b[^;]*;/g)) {
    if (/\bintake_type\b/.test(m[0]) && m[0].includes("'r1_public_booking'")) out.push(m[0]);
  }
  for (const m of all.matchAll(
    /\bupdate (?:only )?(?:screening_v2\.)?ashby_application_links\b(?: (?:as )?[a-z_]+)? set ([^;]*?)(?: from | where | returning |;)/g,
  )) {
    if (/\bintake_type\b/.test(m[1]!) && m[1]!.includes("'r1_public_booking'")) out.push(m[0]);
  }
  return out;
}

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
    // The file holds exactly two hunks: this one (§4) and the impact view's (§5).
    expect(stripHunks(sql).tags).toEqual(['M035-S12-a', 'M035-S12-b']);
    expect(sql.split('▼ 0144')).toHaveLength(3);
    expect(sql.split('▲ 0144')).toHaveLength(3);
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

describe('migration 0144 §5: v_ashby_application_impact is the 0140 view plus one marked hunk', () => {
  it('is byte-identical to the 0140 view once the hunk is removed', () => {
    expect(VIEW.residue).toBe(VIEW_0140);
  });

  it('has exactly one hunk, M035-S12-b, whose code is the intake filter', () => {
    expect(VIEW.tags).toEqual(['M035-S12-b']);
    expect(withoutComments(VIEW.hunks['M035-S12-b']!).trim()).toBe("and l.intake_type <> 'r1_public_booking'");
  });

  it('places the hunk inside the lk CTE, right after the erasure filter', () => {
    const lines = VIEW_0144.split('\n');
    const open = lines.findIndex((line) => line.includes('-- ▼ 0144 M035-S12-b'));
    expect(lines[open - 1]).toBe("     and l.terminal_reason is distinct from 'subject_erasure'");
    const lk = VIEW_0144.indexOf('\nlk as (\n');
    const hunk = VIEW_0144.indexOf('▼ 0144');
    expect(lk).toBeGreaterThan(-1);
    expect(lk).toBeLessThan(hunk);
    expect(hunk).toBeLessThan(VIEW_0144.indexOf('\n),\n', lk));
  });

  it('still runs as its caller', () => {
    expect(VIEW_0144.startsWith(`${VIEW_START}\n  with (security_invoker = true) as\n`)).toBe(true);
  });

  it('keeps the 0140 revoke and grant lines verbatim, once, after the view and its comment', () => {
    const grants = slice(M0140, 'revoke all on screening_v2.v_ashby_application_impact from', 'to service_role;\n');
    expect(grants.split('\n')).toHaveLength(3);
    expect(sql.split(grants)).toHaveLength(2);
    expect(sql.indexOf(grants)).toBeGreaterThan(sql.indexOf('comment on view screening_v2.v_ashby_application_impact is'));
    expect(sql.indexOf('comment on view screening_v2.v_ashby_application_impact is')).toBeGreaterThan(sql.indexOf(VIEW_0144));
  });

  it('keeps the 0140 comment and appends the 0144 sentence', () => {
    const anchor = 'comment on view screening_v2.v_ashby_application_impact is\n';
    expect(commentText(sql, anchor)).toBe(
      `${commentText(M0140, anchor)} 0144 (M035 S12): r1_public_booking links (on-the-spot imports by the ` +
        'public R1 booking page) are left out.',
    );
  });

  it('up to 0144 only 0140 and 0144 declare the view, so 0144 is the declaration a later change lifts from', () => {
    const declaring = readdirSync(migrations)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name <= FILE)
      .sort()
      .filter((name) => lf(readFileSync(path.join(migrations, name), 'utf8')).includes(VIEW_START));
    expect(declaring).toEqual(['0140_ashby_business_impact.sql', FILE]);
  });
});

describe('migration 0144 §6: r1_meet_public_local_rows, the read-only lookup the S04 store calls', () => {
  it('has the exact header S04 pins: single-spaced parameters, stable, security definer, pinned search_path', () => {
    expect(LOCAL_ROWS_RAW.startsWith(
      `create or replace function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(\n` +
        '  p_email text,\n' +
        '  p_phone text,\n' +
        '  p_limit integer default 21\n' +
        ')\n' +
        'returns jsonb\n' +
        'language plpgsql\n' +
        'stable\n' +
        'security definer\n' +
        'set search_path = pg_catalog, screening_v2\n' +
        'as $$\n',
    )).toBe(true);
    // S04's regex (r1-meet-public-match-store.test.ts), word for word.
    expect(sql).toMatch(
      new RegExp(`create or replace function screening_v2\\.${R1_PUBLIC_LOCAL_ROWS_RPC}\\(\\s*p_email text,\\s*p_phone text,\\s*p_limit integer default 21\\s*\\)\\s*returns jsonb`),
    );
    expect(R1_PUBLIC_LOCAL_ROWS_RPC).toBe('r1_meet_public_local_rows');
  });

  it('is service-role only, in two one-line statements, with a 0144 comment', () => {
    expect(sql).toContain(
      `\nrevoke all on function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(text, text, integer) from public, anon, authenticated;\n`,
    );
    expect(sql).toContain(`\ngrant execute on function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(text, text, integer) to service_role;\n`);
    expect(code).not.toMatch(/grant [a-z ,]+ on function screening_v2\.r1_meet_public_local_rows\([^)]*\) to [a-z_, ]*\b(anon|authenticated|public)\b/);
    const comment = commentText(sql, `comment on function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(text, text, integer) is\n`);
    expect(comment).toMatch(/^0144 \(M035 S04 fix round, S12\): /);
    expect(comment).toContain('Service-role only.');
  });

  it('answers each row with exactly the eight keys the store reads, in its order, from the picked rows only', () => {
    const builder = /jsonb_agg\(jsonb_build_object\(([^)]*)\)/.exec(LOCAL_ROWS);
    expect(builder).not.toBeNull();
    const parts = builder![1]!.split(',').map((part) => part.trim());
    expect(parts.filter((_, i) => i % 2 === 0)).toEqual(R1_PUBLIC_LOCAL_ROW_COLUMNS.map((key) => `'${key}'`));
    expect(parts.filter((_, i) => i % 2 === 1)).toEqual(
      R1_PUBLIC_LOCAL_ROW_COLUMNS.map((key) => (key === 'candidate_id' ? 'r.candidate_id::text' : `r.${key}`)),
    );
    expect(LOCAL_ROWS.split('jsonb_build_object(')).toHaveLength(4);
    for (const column of R1_PUBLIC_LOCAL_ROW_COLUMNS) expect(LOCAL_ROWS, column).toContain(`'${column}'`);
  });

  it('answers only invalid_request (no field, no value) or ok with the rows', () => {
    expect(answers(LOCAL_ROWS)).toEqual([
      { keys: ['status'], values: ["'invalid_request'"] },
      { keys: ['status', 'rows'], values: ["'ok'", 'v_rows'] },
    ]);
    expect(LOCAL_ROWS.split('return ')).toHaveLength(3);
    expect(LOCAL_ROWS).not.toContain("'field'");
  });

  it('validates exactly the contract inputs', () => {
    expect(LOCAL_ROWS).toContain(
      'if (p_email is null and p_phone is null) or p_limit is null or p_limit not between 1 and 21 ' +
        'or (p_email is not null and (p_email <> lower(btrim(p_email)) or char_length(p_email) not between 3 and 254 ' +
        "or p_email !~ '^[^@]+@[^@]+$')) or (p_phone is not null and p_phone !~ '^\\+91[6-9][0-9]{9}$') then " +
        "return jsonb_build_object('status', 'invalid_request'); end if;",
    );
  });

  it('matches each side by its index, at most p_limit by id, and joins them in full', () => {
    expect(LOCAL_ROWS).toContain(
      'select c.id from screening_v2.candidates c where c.email is not null and lower(btrim(c.email)) = p_email ' +
        'order by c.id limit p_limit',
    );
    expect(LOCAL_ROWS).toContain(
      'select c.id from screening_v2.candidates c where c.phone_e164 = p_phone order by c.id limit p_limit',
    );
    expect(LOCAL_ROWS).toContain('from by_email e full join by_phone ph on ph.id = e.id');
    expect(LOCAL_ROWS).toContain(
      "case when e.id is not null and ph.id is not null then 'both' when e.id is not null then 'email' else 'phone' end as matched_by",
    );
  });

  it('holds and blocks per candidate with the 0130 DSAR predicate the store names', () => {
    const predicates = [...LOCAL_ROWS.matchAll(/d\.request_type in \(([^)]*)\) and d\.request_status in \(([^)]*)\)/g)];
    expect(predicates).toHaveLength(1);
    expect(quoted(predicates[0]![1]!)).toEqual([...R1_PUBLIC_DSAR_HOLD_TYPES]);
    expect(quoted(predicates[0]![2]!)).toEqual([...R1_PUBLIC_DSAR_HOLD_STATUSES]);
    expect(LOCAL_ROWS).toContain('where d.candidate_id = x.candidate_id');
    expect(LOCAL_ROWS).toContain('c.decision_use_blocked_at is not null as decision_blocked');
  });

  it('gives one row per Ashby link, a fail-closed row for no link, and orders and cuts in the "C" collation', () => {
    expect(LOCAL_ROWS).toContain(
      'left join screening_v2.ashby_application_links l on l.candidate_id = p.candidate_id and l.provider = \'ashby\' ' +
        'left join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id',
    );
    expect(LOCAL_ROWS).toContain('(l.id is null or l.terminal_state is not null) as link_terminal');
    expect(LOCAL_ROWS).toContain("coalesce(m.status = 'enabled' and m.archived_at is null, false) as mapping_enabled");
    expect(LOCAL_ROWS).toContain('order by p.candidate_id, l.external_application_id collate "C" nulls last limit p_limit');
    expect(LOCAL_ROWS).toContain('order by r.candidate_id, r.application_id collate "C" nulls last), \'[]\'::jsonb)');
  });

  it('writes, raises, locks and performs nothing', () => {
    // String literals emptied: the DSAR list's 'delete' is a value, not a statement.
    const body = LOCAL_ROWS.toLowerCase().replace(/'(?:[^']|'')*'/g, "''");
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|merge|raise|perform|execute)\b/);
    expect(body).not.toMatch(/\bfor (share|update|no key update|key share)\b/);
  });
});

describe('migration 0144 §7: r1_meet_public_import_application, the on-the-spot import', () => {
  it('takes the contract parameters in order, p_now last with default now(), and is volatile security definer', () => {
    const header = IMPORT_RAW.slice(0, IMPORT_RAW.indexOf('\nas $$\n') + '\nas $$\n'.length);
    const open = `create or replace function screening_v2.${IMPORT_RPC}(\n`;
    expect(header.startsWith(open)).toBe(true);
    const params = header.slice(open.length, header.indexOf('\n)\n')).split('\n').map((line) => line.trim().replace(/,$/, ''));
    expect(params).toEqual(IMPORT_PARAMETERS);
    expect(header.slice(header.indexOf('\n)\n'))).toBe(
      '\n)\nreturns jsonb\nlanguage plpgsql\nvolatile\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$\n',
    );
    expect(IMPORT_PARAMETERS.map((p) => p.split(' ')[1]).join(', ')).toBe(IMPORT_SIGNATURE);
  });

  it('is service-role only, in two one-line statements, with a 0144 comment', () => {
    expect(sql).toContain(
      `\nrevoke all on function screening_v2.${IMPORT_RPC}(${IMPORT_SIGNATURE}) from public, anon, authenticated;\n`,
    );
    expect(sql).toContain(`\ngrant execute on function screening_v2.${IMPORT_RPC}(${IMPORT_SIGNATURE}) to service_role;\n`);
    expect(code).not.toMatch(
      /grant [a-z ,]+ on function screening_v2\.r1_meet_public_import_application\([^)]*\) to [a-z_, ]*\b(anon|authenticated|public)\b/,
    );
    const comment = commentText(sql, `comment on function screening_v2.${IMPORT_RPC}(${IMPORT_SIGNATURE}) is\n`);
    expect(comment).toMatch(/^0144 \(M035 S12\): /);
    expect(comment).toContain('Service-role only.');
  });

  it('answers exactly four statuses, the eight fields and the five codes, each with exactly its keys', () => {
    expect(firstSeen(literalsOf(IMPORT, 'status')).sort()).toEqual(['exists', 'imported', 'invalid_request', 'refused']);
    expect(firstSeen(literalsOf(IMPORT, 'field'))).toEqual(IMPORT_FIELDS);
    expect(literalsOf(IMPORT, 'field')).toEqual(IMPORT_FIELDS);
    expect(firstSeen(literalsOf(IMPORT, 'code'))).toEqual(IMPORT_CODES);
    const all = answers(IMPORT);
    // Every return of the body is one of these answers.
    expect(IMPORT.split('return ').length - 1).toBe(all.length);
    for (const answer of all) {
      const status = answer.values[0];
      if (status === "'imported'" || status === "'exists'") {
        expect(answer.keys).toEqual(['status', 'candidate_id', 'application_link_id']);
        expect(answer.values.slice(1)).toEqual(
          status === "'imported'" ? ['v_candidate_id::text', 'v_link_id::text'] : ['v_link_candidate::text', 'v_link_id::text'],
        );
      } else if (status === "'refused'") {
        expect(answer.keys).toEqual(['status', 'code']);
      } else {
        expect(status).toBe("'invalid_request'");
        expect(answer.keys).toEqual(['status', 'field']);
      }
    }
    expect(all.filter((a) => a.values[0] === "'imported'")).toHaveLength(1);
  });

  it('validates the eight fields in order, the first failing wins, and reads nothing before', () => {
    const uuid = "c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';";
    expect(IMPORT).toContain(uuid);
    const checks = [
      ['p_ashby_application_id is null or p_ashby_application_id !~* c_uuid', 'application_id'],
      ['p_ashby_candidate_id is null or p_ashby_candidate_id !~* c_uuid', 'ashby_candidate_id'],
      ['p_ashby_job_id is null or char_length(p_ashby_job_id) not between 1 and 256', 'job_id'],
      ['p_ashby_stage_id is not null and char_length(p_ashby_stage_id) not between 1 and 256', 'stage_id'],
      ["p_name is not null and (char_length(p_name) not between 1 and 200 or btrim(p_name) = '' or p_name ~ '[[:cntrl:]]')", 'name'],
      [
        "p_email is not null and (char_length(p_email) > 254 or p_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$')",
        'email',
      ],
      ["p_phone_e164 is not null and p_phone_e164 !~ '^\\+91[6-9][0-9]{9}$'", 'phone'],
      ['p_now is null or not isfinite(p_now)', 'now'],
    ] as const;
    let last = -1;
    for (const [condition, field] of checks) {
      const statement = `if ${condition} then return jsonb_build_object('status', 'invalid_request', 'field', '${field}'); end if;`;
      expect(IMPORT, field).toContain(statement);
      expect(IMPORT.indexOf(statement), field).toBeGreaterThan(last);
      last = IMPORT.indexOf(statement);
    }
    expect(last).toBeLessThan(IMPORT.indexOf('pg_advisory_xact_lock('));
  });

  it('accepts exactly the number shape the API dials (STRICT_IN_MOBILE_E164)', () => {
    const literal = /p_phone_e164 !~ '([^']*)'/.exec(IMPORT)![1]!;
    expect(literal).toBe(STRICT_IN_MOBILE_E164.source);
  });

  it('locks, reads the holds, the link and the mapping, then writes the link, the shell and the binding, in that order', () => {
    const steps = [
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_public:import:' || lower(p_ashby_application_id), 0));",
      'from screening_v2.',
      'ashby_erased_application_links',
      'decision_use_blocked_at',
      "where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;",
      'from screening_v2.ashby_job_mappings',
      'insert into screening_v2.ashby_application_links',
      'insert into screening_v2.candidates',
      'set candidate_id',
    ];
    let last = -1;
    for (const step of steps) {
      const at = IMPORT.indexOf(step);
      expect(at, step).toBeGreaterThan(last);
      last = at;
    }
    expect(IMPORT.split('pg_advisory_xact_lock(')).toHaveLength(2);
    expect(IMPORT.split('from screening_v2.ashby_job_mappings')).toHaveLength(2);
  });

  it('holds the whole Ashby person: erasure or DSAR first (dsar_hold), then the decision block (candidate_ineligible)', () => {
    const person =
      "where l.provider = 'ashby' and (lower(l.external_candidate_id) = lower(p_ashby_candidate_id) " +
      'or l.external_application_id = p_ashby_application_id)';
    expect(IMPORT.split(person)).toHaveLength(3);
    expect(IMPORT).toContain(
      `${person} and (l.terminal_reason = 'subject_erasure' or exists (select 1 from ` +
        'screening_v2.ashby_erased_application_links e where e.application_link_id = l.id) or exists (select 1 from ' +
        'screening_v2.data_subject_requests d where d.candidate_id = l.candidate_id and d.request_type in ',
    );
    const predicates = [...IMPORT.matchAll(/d\.request_type in \(([^)]*)\) and d\.request_status in \(([^)]*)\)/g)];
    expect(predicates).toHaveLength(1);
    expect(quoted(predicates[0]![1]!)).toEqual([...R1_PUBLIC_DSAR_HOLD_TYPES]);
    expect(quoted(predicates[0]![2]!)).toEqual([...R1_PUBLIC_DSAR_HOLD_STATUSES]);
    expect(IMPORT).toContain(
      'from screening_v2.ashby_application_links l join screening_v2.candidates c on c.id = l.candidate_id ' +
        `${person} and c.decision_use_blocked_at is not null ) then return jsonb_build_object('status', 'refused', 'code', 'candidate_ineligible');`,
    );
    expect(IMPORT.indexOf("'code', 'dsar_hold'")).toBeLessThan(IMPORT.indexOf("'code', 'candidate_ineligible'"));
  });

  it('adopts an existing link unchanged: terminal_state only makes it terminal, no candidate makes it unbound', () => {
    const adopt =
      "if v_link_terminal is not null then return jsonb_build_object('status', 'refused', 'code', 'application_terminal'); end if; " +
      "if v_link_candidate is null then return jsonb_build_object('status', 'refused', 'code', 'link_unbound'); end if; " +
      "return jsonb_build_object('status', 'exists', 'candidate_id', v_link_candidate::text, 'application_link_id', v_link_id::text);";
    const read =
      'select l.id, l.candidate_id, l.terminal_state into v_link_id, v_link_candidate, v_link_terminal ' +
      "from screening_v2.ashby_application_links l where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;";
    // Step 4, and the re-read after a lost race: the same read, the same answers, nothing written.
    expect(IMPORT).toContain(`${read} if found then ${adopt} end if;`);
    expect(IMPORT).toContain(`if v_link_id is null then ${read} ${adopt} end if;`);
    expect(IMPORT.split(read)).toHaveLength(3);
  });

  it('resolves the enabled, live mapping of the job itself, read for share', () => {
    expect(IMPORT).toContain(
      'select m.id, m.role_id, m.owner_id into v_mapping_id, v_role_id, v_owner_id from screening_v2.ashby_job_mappings m ' +
        "where m.provider = 'ashby' and m.external_job_id = p_ashby_job_id and m.status = 'enabled' and m.archived_at is null " +
        "for share; if not found then return jsonb_build_object('status', 'refused', 'code', 'mapping_unavailable'); end if;",
    );
  });

  it('inserts the link first, intake r1_public_booking and no candidate, on conflict do nothing', () => {
    const link = insertInto(IMPORT, 'ashby_application_links');
    expect(link.columns).toEqual([
      'provider', 'external_application_id', 'external_candidate_id', 'external_job_id', 'external_stage_id',
      'job_mapping_id', 'candidate_id', 'lifecycle', 'intake_type', 'created_at', 'updated_at',
    ]);
    expect(link.values).toEqual([
      "'ashby'", 'p_ashby_application_id', 'p_ashby_candidate_id', 'p_ashby_job_id', 'p_ashby_stage_id',
      'v_mapping_id', 'null', "'imported'", "'r1_public_booking'", 'p_now', 'p_now',
    ]);
    expect(IMPORT).toContain('p_now, p_now) on conflict (provider, external_application_id) do nothing returning id into v_link_id;');
  });

  it('then inserts the shell with the Ashby import shell columns, the Ashby values and phone_valid false', () => {
    const shell = insertInto(IMPORT, 'candidates');
    expect(shell.columns).toEqual(SHELL_COLUMNS);
    expect([...shellInsertKeys(), 'ashby_phone_applied_at', 'created_at', 'updated_at']).toEqual(SHELL_COLUMNS);
    expect(shell.values).toEqual([
      'v_role_id', 'v_owner_id', 'null', 'p_name', 'p_email', 'null', 'p_phone_e164', 'false', "'[]'::jsonb",
      'null', 'null', "'queued'", "'ashby'", 'case when p_phone_e164 is not null then p_now end', 'p_now', 'p_now',
    ]);
    expect(IMPORT).toContain(
      'returning id into v_candidate_id; update screening_v2.ashby_application_links set candidate_id = v_candidate_id, ' +
        'updated_at = p_now where id = v_link_id;',
    );
  });
});

describe('migration 0144: what it writes', () => {
  const ALL = flat(sql).toLowerCase();

  it('inserts only links and candidates, updates only links, and deletes nothing', () => {
    const written = (verb: string): string[] =>
      [...ALL.matchAll(new RegExp(`\\b${verb} screening_v2\\.([a-z0-9_]+)`, 'g'))].map((m) => m[1]!);
    expect(firstSeen(written('insert into'))).toEqual(['ashby_application_links', 'candidates']);
    expect(firstSeen(written('update'))).toEqual(['ashby_application_links']);
    expect(written('delete from')).toEqual([]);
    expect(ALL).not.toMatch(/\bmerge into\b|\btruncate\b/);
  });

  it('never writes an ingestion, engagement, operation, queue, session, invite or consent row', () => {
    expect(ALL).not.toMatch(new RegExp(`\\b(insert into|update|delete from) screening_v2\\.(${NEVER_WRITTEN.join('|')})\\b`));
  });

  it('across every migration, only 0144 §7 writes r1_public_booking into intake_type, once', () => {
    const writers = readdirSync(migrations)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort()
      .flatMap((name) => intakeWrites(readFileSync(path.join(migrations, name), 'utf8')).map((statement) => ({ name, statement })));
    expect(writers.map((w) => w.name)).toEqual([FILE]);
    expect(IMPORT.toLowerCase()).toContain(writers[0]!.statement.slice(0, -1));
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
    expect(bodies.map((m) => m[1])).toEqual([
      ...GUARDS.map((g) => g.fn),
      'claim_ashby_profile_due',
      'r1_meet_public_local_rows',
      'r1_meet_public_import_application',
    ]);
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

describe('migration 0144: SQL test wiring (T3)', () => {
  const repo = path.resolve(here, '../../../..');
  const read = (rel: string): string => lf(readFileSync(path.join(repo, rel), 'utf8'));
  const SCRIPT = 'scripts/test-r1-meet-public-import.sh';
  const ASSERT_FILE = 'app/supabase/tests/r1_meet_public_import_assert.sql';
  const assertions = read(ASSERT_FILE);
  /** The assert file with whole-line comments removed. */
  const statements = assertions.replace(/^\s*--.*$/gm, '').trim();

  it('the helper runs the assert file with ON_ERROR_STOP=1 under its own log prefix', () => {
    const script = read(SCRIPT);
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('migration 0144, M035 S12');
    expect(script).toContain('psql -U postgres -d postgres -q -v ON_ERROR_STOP=1');
    expect(script).toContain('< "$TESTS/r1_meet_public_import_assert.sql"');
    expect(script).toContain("log() { printf '[r1-meet-public-import] %s %s\\n'");
  });

  it('supabase-test.sh runs it once, after the 0142 suite and before the TST-15 rehearsal, and fails the run on failure', () => {
    const suite = read('scripts/supabase-test.sh');
    const call =
      'env SUPABASE_DB_CONTAINER="$SUPABASE_DB_CONTAINER" bash scripts/test-r1-meet-public-import.sh 2>&1 | tee -a "$RESULTS_FILE"';
    expect(suite.split('bash scripts/test-r1-meet-public-import.sh')).toHaveLength(2);
    expect(suite).toContain(`${call}\nif [ "\${PIPESTATUS[0]}" -ne 0 ]; then\n  log 'ERROR: 0144 R1 Meet public import assertions FAILED.'\n  exit 1\nfi\n`);
    expect(suite.indexOf(call)).toBeGreaterThan(suite.indexOf('bash scripts/test-r1-meet.sh'));
    expect(suite.indexOf(call)).toBeLessThan(suite.indexOf('TST-15 rollback rehearsal'));
  });

  it('supabase-ci.yml names the helper in both path filters, each after the 0142 helper', () => {
    const ci = read('.github/workflows/supabase-ci.yml');
    const ours = [...ci.matchAll(/^ +- 'scripts\/test-r1-meet-public-import\.sh'$/gm)].map((m) => m.index!);
    const meet = [...ci.matchAll(/^ +- 'scripts\/test-r1-meet\.sh'$/gm)].map((m) => m.index!);
    expect(ours).toHaveLength(2);
    expect(meet).toHaveLength(2);
    expect(meet[0]!).toBeLessThan(ours[0]!);
    expect(ours[0]!).toBeLessThan(meet[1]!);
    expect(meet[1]!).toBeLessThan(ours[1]!);
  });

  it('runs in one rolled-back transaction, deletes nothing, and keeps fixtures in the 7f144000 namespace', () => {
    expect(statements.startsWith('begin;')).toBe(true);
    expect(statements.endsWith('rollback;')).toBe(true);
    expect(assertions.trimEnd().split('\n').at(-1)).toBe('rollback;');
    expect(statements).not.toMatch(/\bcommit;/i);
    expect(statements).not.toMatch(/\bdelete from\b|\btruncate\b/i);
    expect(assertions).toContain("'7f144000-0000-4000-8000-' || lpad(p_kind::text, 4, '0') || lpad(p_n::text, 8, '0')");
    const ids = [...assertions.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/gi)].map((m) => m[0]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('7f144000-'), id).toBe(true);
  });

  it('holds no secret-shaped or contact-shaped literal (gitleaks rules; numbers are built at run time)', () => {
    expect(assertions).not.toMatch(/[0-9a-f]{40,}/i);
    expect(assertions).not.toMatch(/whsec_/i);
    expect(assertions).not.toMatch(/\bkey\s*=\s*'/i);
    expect(assertions).not.toMatch(/'\+91[0-9]{10}'/);
    for (const m of assertions.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+/gi)) {
      expect(m[0].toLowerCase().endsWith('@example.test'), m[0]).toBe(true);
    }
  });

  it('switches a guard off only for its own fixture rows, and back on', () => {
    for (const guard of GUARDS.slice(1)) {
      const table = guard.table;
      const off = statements.split(`alter table ${table} disable trigger ${guard.trigger};`);
      const on = statements.split(`alter table ${table} enable trigger ${guard.trigger};`);
      expect(off, guard.trigger).toHaveLength(2);
      expect(on, guard.trigger).toHaveLength(2);
      expect(statements.indexOf(`disable trigger ${guard.trigger};`)).toBeLessThan(
        statements.indexOf(`enable trigger ${guard.trigger};`),
      );
    }
    expect(statements).not.toMatch(/disable trigger (?!trg_ashby_resume_ingestions_r1_public_booking;|trg_phone_engagements_r1_public_booking;)/);
    expect(statements).not.toMatch(/session_replication_role/);
  });

  it('exercises every 0144 object, the three writers it fences, every closed message, field, code and row key', () => {
    for (const name of [
      'claim_ashby_profile_due',
      'v_ashby_application_impact',
      'impact_application_rows',
      R1_PUBLIC_LOCAL_ROWS_RPC,
      IMPORT_RPC,
      'advance_ashby_ingestion',
      'apply_ashby_candidate_profile',
      'ensure_ashby_phone_engagement',
      ...GUARDS.map((g) => g.fn),
      ...GUARDS.map((g) => g.trigger),
    ]) {
      expect(statements, name).toContain(name);
    }
    for (const guard of GUARDS) expect(assertions, guard.fn).toContain(`'${guard.message}'`);
    for (const field of IMPORT_FIELDS) expect(statements, field).toContain(`('${field}', '`);
    for (const code of IMPORT_CODES) expect(statements, code).toContain(`"code":"${code}"`);
    for (const key of R1_PUBLIC_LOCAL_ROW_COLUMNS) expect(statements, key).toContain(`'${key}'`);
    for (const value of INTAKE_VALUES) expect(statements, value).toContain(`'${value}'`);
  });

  it('keeps sections A to G in order', () => {
    let at = -1;
    for (const label of ['A. Catalog posture.', 'B. The intake lock', 'C. The two insert guards', 'D. claim_ashby_profile_due',
      'E. The business-impact read model', 'F. r1_meet_public_local_rows', 'G. r1_meet_public_import_application']) {
      const next = assertions.indexOf(`\n-- ${label}`);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
  });
});
