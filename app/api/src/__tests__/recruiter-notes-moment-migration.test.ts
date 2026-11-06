/**
 * 0137: recruiter notes tied to a moment, read from the migration's text. No Postgres is available
 * here, so this file only reads text and cannot show that a CHECK accepts or refuses a row: that runs
 * on real Postgres in app/supabase/tests/policy_tests.sql (section "0137"), row by row, together with
 * the append-only guard and the deletes a note must not get in the way of. These pin what makes the
 * migration safe to apply while calls are live:
 *
 *   1. it is additive: three nullable columns with no default, on one table, and nothing else;
 *   2. no existing row is written: the notes are append-only and stay exactly as they are;
 *   3. it is the repo's shape: a short lock timeout, NOT VALID then VALIDATE, a schema reload;
 *   4. it declares no foreign key. 0015's guard would turn ON DELETE SET NULL into a refused UPDATE and
 *      ON DELETE CASCADE into a refused DELETE, and a key would take a lock on the live call table;
 *   5. the window on media_ms is the one the API validates.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_MEDIA_MS_MAX } from '../schemas/notes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0137_recruiter_notes_moment.sql';
const SQL = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const CODE = SQL.replace(/^\s*--.*$/gm, '');
const FLAT = CODE.replace(/\s+/g, ' ').trim();
const POLICY = readFileSync(path.resolve(here, '../../../supabase/tests/policy_tests.sql'), 'utf8');

const COLUMNS = [
  ['round_id', 'uuid'],
  ['session_id', 'uuid'],
  ['media_ms', 'integer'],
] as const;
const CONSTRAINTS = ['chk_recruiter_notes_session_needs_round', 'chk_recruiter_notes_media_ms'] as const;

/** Every statement of the migration, one per line, with its keywords in place. */
const STATEMENTS = CODE.split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

describe('0137 shape', () => {
  it('is the only 0137 migration', () => {
    expect(readdirSync(migrations).filter((file) => file.startsWith('0137_'))).toEqual([FILE]);
  });

  it('sets a short lock timeout before any DDL', () => {
    const lock = CODE.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(CODE.search(/\balter table\b/));
  });

  it('touches recruiter_notes and no other table', () => {
    const tables = [...CODE.matchAll(/\b(?:alter table|on column|update|insert into|delete from)\s+(?:only\s+)?([a-z0-9_."]+)/g)]
      .map((match) => match[1].split('.').slice(0, 2).join('.'));
    expect(new Set(tables)).toEqual(new Set(['screening_v2.recruiter_notes']));
  });

  it('adds exactly three nullable columns with no default', () => {
    const added = [...FLAT.matchAll(/add column if not exists (\w+) (\w+)( [^,;]*)?[,;]/g)];
    expect(added.map((match) => [match[1], match[2]])).toEqual(COLUMNS.map(([name, type]) => [name, type]));
    for (const match of added) expect((match[3] ?? '').trim()).toBe('null');
    expect(FLAT).not.toMatch(/\bdefault\b/);
    expect(FLAT).not.toMatch(/\bnot null\b(?! ?\)| and| or)/);
  });

  it('writes no row: no backfill, no rewrite, nothing destroyed', () => {
    expect(FLAT).not.toMatch(/\b(update|delete|insert|truncate|copy|merge)\b/i);
    expect(FLAT).not.toMatch(/\bdrop\b/i);
    expect(FLAT).not.toMatch(/\balter column\b/i);
  });

  it('never opens the append-only guard: the escape hatch is not used and the triggers are not touched', () => {
    expect(FLAT).not.toContain('allow_recruiter_notes_mutation');
    expect(FLAT).not.toMatch(/\btrigger\b/i);
  });

  it('adds each CHECK NOT VALID, then VALIDATEs it, as 0116 does', () => {
    for (const name of CONSTRAINTS) {
      const added = STATEMENTS.findIndex((s) => s.includes(`add constraint ${name}`));
      const validated = STATEMENTS.findIndex((s) => s.includes(`validate constraint ${name}`));
      expect(added, name).toBeGreaterThan(-1);
      expect(STATEMENTS[added].endsWith('not valid'), name).toBe(true);
      expect(validated, name).toBeGreaterThan(added);
    }
  });

  it('declares no foreign key: the guard would refuse the delete of any round or session a note names', () => {
    expect(FLAT).not.toMatch(/\breferences\b/i);
    expect(FLAT).not.toMatch(/\bforeign key\b/i);
  });

  it('declares no function, policy, grant or index', () => {
    expect(FLAT).not.toMatch(/\bcreate\b/i);
    expect(FLAT).not.toMatch(/\bgrant\b|\brevoke\b/i);
  });

  it('documents each column and reloads the API schema last', () => {
    for (const [name] of COLUMNS) {
      expect(FLAT).toContain(`comment on column screening_v2.recruiter_notes.${name} is`);
    }
    expect(STATEMENTS[STATEMENTS.length - 1]).toBe("notify pgrst, 'reload schema'");
  });
});

describe('0137 agrees with the API', () => {
  const check = (name: string) => {
    const statement = STATEMENTS.find((s) => s.includes(`add constraint ${name}`));
    expect(statement, name).toBeDefined();
    return statement as string;
  };

  it('holds a time to the window the schema validates, and only on a note that names its attempt', () => {
    const body = check('chk_recruiter_notes_media_ms');
    expect(body).toContain('media_ms >= 0');
    expect(body).toContain(`media_ms <= ${NOTE_MEDIA_MS_MAX}`);
    expect(body).toContain('session_id is not null');
  });

  it('holds an attempt to a note that names its round', () => {
    expect(check('chk_recruiter_notes_session_needs_round')).toContain('session_id is null or round_id is not null');
  });
});

describe('0137 runs on real Postgres in CI', () => {
  it('has its section in the policy tests', () => {
    for (const label of [
      '0137: the three moment columns are nullable with no default',
      '0137: the moment CHECKs exist and are validated',
      '0137: a note names no round or session by foreign key',
      '0137: an anchored note is still append-only',
      '0137: a session can go while a note names it, and the note stays',
      '0137: a candidate erasure still takes their anchored notes',
    ]) {
      expect(POLICY, label).toContain(label);
    }
  });
});
