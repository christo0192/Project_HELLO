/**
 * 0136: R1 turn timing columns, read from the migration's text. No Postgres is available here, so
 * this file only reads text and cannot show that a CHECK accepts or refuses a row: that runs on real
 * Postgres in app/supabase/tests/policy_tests.sql (section "0136"), row by row, for each of the three
 * CHECKs and for the cascade. These pin what makes the migration safe to apply while phone calls are
 * live:
 *
 *   1. it is additive: three nullable columns with no default, on one table, and nothing else;
 *   2. no existing row is written, so no backfill and no rewrite of candidate data;
 *   3. it is the repo's shape: a short lock timeout, NOT VALID then VALIDATE, a schema reload;
 *   4. no function is redeclared, so the phone turn RPCs cannot change with it;
 *   5. the CHECK windows agree with what the R1 worker writes (r1_persistence.py).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0136_r1_turn_timing.sql';
const SQL = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const CODE = SQL.replace(/^\s*--.*$/gm, '');
const FLAT = CODE.replace(/\s+/g, ' ').trim();
const WORKER = readFileSync(
  path.resolve(here, '../../../voice-livekit/r1_persistence.py'),
  'utf8',
).replace(/\r\n/g, '\n');

const COLUMNS = [
  ['turn_ended_at_ms', 'bigint'],
  ['ai_voice', 'text'],
  ['ai_played_ms', 'integer'],
] as const;
const CONSTRAINTS = [
  'chk_transcript_turns_turn_ended_at_ms',
  'chk_transcript_turns_ai_voice',
  'chk_transcript_turns_ai_played_ms',
] as const;

/** Every statement of the migration, one per line, with its keywords in place. */
const STATEMENTS = CODE.split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

describe('0136 shape', () => {
  it('is the only 0136 migration', () => {
    expect(readdirSync(migrations).filter((file) => file.startsWith('0136_'))).toEqual([FILE]);
  });

  it('sets a short lock timeout before any DDL', () => {
    const lock = CODE.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(CODE.search(/\balter table\b/));
  });

  it('touches transcript_turns and no other table', () => {
    const tables = [...CODE.matchAll(/\b(?:alter table|on column|update|insert into|delete from)\s+(?:only\s+)?([a-z0-9_."]+)/g)]
      .map((match) => match[1].split('.').slice(0, 2).join('.'));
    expect(new Set(tables)).toEqual(new Set(['screening_v2.transcript_turns']));
  });

  it('adds exactly three nullable columns with no default', () => {
    const added = [...FLAT.matchAll(/add column if not exists (\w+) (\w+)( [^,;]*)?[,;]/g)];
    expect(added.map((match) => [match[1], match[2]])).toEqual(COLUMNS.map(([name, type]) => [name, type]));
    for (const match of added) expect((match[3] ?? '').trim()).toBe('null');
    expect(FLAT).not.toMatch(/\bdefault\b/);
    expect(FLAT).not.toMatch(/\bnot null\b/);
  });

  it('writes no row: no backfill, no rewrite, nothing destroyed', () => {
    expect(FLAT).not.toMatch(/\b(update|delete|insert|truncate|copy|merge)\b/i);
    expect(FLAT).not.toMatch(/\bdrop\b/i);
    expect(FLAT).not.toMatch(/\balter column\b/i);
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

  it('declares no function, trigger, policy, grant or index: the phone RPCs cannot change with it', () => {
    expect(FLAT).not.toMatch(/\bcreate\b/i);
    expect(FLAT).not.toMatch(/\bgrant\b|\brevoke\b/i);
  });

  it('documents each column and reloads the API schema last', () => {
    for (const [name] of COLUMNS) {
      expect(FLAT).toContain(`comment on column screening_v2.transcript_turns.${name} is`);
    }
    expect(STATEMENTS[STATEMENTS.length - 1]).toBe("notify pgrst, 'reload schema'");
  });
});

describe('0136 agrees with the R1 worker', () => {
  const check = (name: string) => {
    const statement = STATEMENTS.find((s) => s.includes(`add constraint ${name}`));
    expect(statement, name).toBeDefined();
    return statement as string;
  };

  it('holds an end to the turn_started_at_ms window, and never before its own start', () => {
    const body = check('chk_transcript_turns_turn_ended_at_ms');
    expect(body).toContain('turn_ended_at_ms > 0');
    expect(body).toContain('turn_ended_at_ms < 4102444800000');
    expect(body).toContain('turn_started_at_ms is null or turn_ended_at_ms >= turn_started_at_ms');
    expect(WORKER).toContain('TURN_ANCHOR_LIMIT_MS = 4_102_444_800_000');
  });

  it('allows the worker\'s two voices, on bot rows only', () => {
    const body = check('chk_transcript_turns_ai_voice');
    expect(body).toContain("speaker = 'bot'");
    expect(body).toContain("ai_voice in ('interviewer', 'learner')");
    expect(WORKER).toContain('AI_VOICES = frozenset({"interviewer", "learner"})');
  });

  it('bounds played time as the worker does, on bot rows only', () => {
    const body = check('chk_transcript_turns_ai_played_ms');
    expect(body).toContain("speaker = 'bot'");
    expect(body).toContain('ai_played_ms >= 0');
    expect(body).toContain('ai_played_ms <= 86400000');
    expect(WORKER).toContain('AI_PLAYED_LIMIT_MS = 86_400_000');
  });
});
