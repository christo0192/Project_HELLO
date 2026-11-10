/**
 * No regular expression in a migration (or a SQL test) may carry a repetition
 * bound above 255.
 *
 * WHY THIS TEST EXISTS. Postgres refuses a `{m,n}` bound above 255 (its
 * RE_DUP_MAX), but only when the expression is compiled, which for a CHECK is
 * the first row it checks, not the migration that declares it. M031's first
 * 0138 wrote nine identifier CHECKs as `'^[A-Za-z0-9_.:-]{1,256}$'` (to match
 * the API's 256-character id rule). The migration applied cleanly; every insert
 * into those tables then raised SQLSTATE 2201B "invalid repetition count(s)",
 * so the catalogue refresh could never write a row and the policy suite
 * aborted. The text-only migration tests could not see it.
 *
 * So every SQL string literal is read, a repetition bound inside one is found,
 * and any number above 255 fails here, at the desk. A longer limit is written
 * as `x ~ '^[...]+$' and length(x) <= n` instead.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE = path.resolve(HERE, '../../../supabase');
const DIRS = ['migrations', 'tests'] as const;

/** Postgres's RE_DUP_MAX: the largest m or n a `{m,n}` bound may name. */
const RE_DUP_MAX = 255;

/**
 * Every single-quoted literal in a SQL text, comments skipped. Dollar-quoted
 * bodies are read as code, so the literals inside a function are found too.
 * `''` is a quote inside a literal; in an E'' literal a backslash escapes the
 * next character.
 */
function sqlLiterals(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (sql[i] !== "'") { i += 1; continue; }
    const escaped = /[Ee]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
    let j = i + 1;
    let text = '';
    while (j < sql.length) {
      const ch = sql[j];
      if (escaped && ch === '\\') { text += sql.slice(j, j + 2); j += 2; continue; }
      if (ch === "'") {
        if (sql[j + 1] === "'") { text += "'"; j += 2; continue; }
        break;
      }
      text += ch;
      j += 1;
    }
    out.push(text);
    i = j + 1;
  }
  return out;
}

/**
 * The repetition bounds in one literal: a `{m}`, `{m,}` or `{m,n}` that follows
 * something a regex can repeat (a class, a group, a dot, a character or an
 * escape). A brace that opens the literal (an array or a JSON path) is not one.
 */
function repetitionBounds(literal: string): Array<{ text: string; numbers: number[] }> {
  return [...literal.matchAll(/(?<=[\])\w.\\])\{(\d+)(?:,(\d*))?\}/g)].map((m) => ({
    text: m[0],
    numbers: [m[1], m[2]].filter((n): n is string => typeof n === 'string' && n !== '').map(Number),
  }));
}

function sqlFiles(): Array<{ name: string; sql: string }> {
  return DIRS.flatMap((dir) =>
    readdirSync(path.join(SUPABASE, dir))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: `${dir}/${f}`, sql: readFileSync(path.join(SUPABASE, dir, f), 'utf8').replace(/\r\n/g, '\n') })),
  );
}

describe('the literal and bound readers', () => {
  it('reads literals, skips comments, and handles doubled quotes and E-strings', () => {
    const sql = [
      "select 'a', 'it''s' -- 'not this'",
      "/* nor 'this' */ where x ~ E'[^\\\\x20]' and y = 'z';",
      'create function f() returns int language plpgsql as $$ begin perform 1 where v ~ \'^[a-z]{1,64}$\'; end $$;',
    ].join('\n');
    expect(sqlLiterals(sql)).toEqual(['a', "it's", '[^\\\\x20]', 'z', '^[a-z]{1,64}$']);
  });

  it('finds a bound after a class, a group, a dot, a character or an escape, and not an array literal', () => {
    expect(repetitionBounds('^[A-Za-z0-9_.:-]{1,256}$').map((b) => b.numbers)).toEqual([[1, 256]]);
    expect(repetitionBounds('^(ab){3}x{2,}\\d{4}.{0,9}$').map((b) => b.text)).toEqual(['{3}', '{2,}', '{4}', '{0,9}']);
    expect(repetitionBounds('{1,256}')).toEqual([]);
    expect(repetitionBounds('{items,300}')).toEqual([]);
  });

  it('would have caught the first 0138: a {1,256} bound is above the limit', () => {
    const bad = "constraint c check (stage_id ~ '^[A-Za-z0-9_.:-]{1,256}$')";
    const over = sqlLiterals(bad).flatMap(repetitionBounds).filter((b) => b.numbers.some((n) => n > RE_DUP_MAX));
    expect(over.map((b) => b.text)).toEqual(['{1,256}']);
  });
});

describe('every SQL file', () => {
  const files = sqlFiles();

  it('reads the migrations and the SQL tests, and finds the regexes in them', () => {
    expect(files.filter((f) => f.name.startsWith('migrations/')).length).toBeGreaterThan(100);
    expect(files.some((f) => f.name === 'tests/policy_tests.sql')).toBe(true);
    // A reader that found nothing would pass everything below.
    const bounds = files.flatMap((f) => sqlLiterals(f.sql).flatMap(repetitionBounds));
    expect(bounds.length).toBeGreaterThan(100);
  });

  it.each(files.map((f) => [f.name, f.sql] as const))(`%s names no repetition bound above ${RE_DUP_MAX}`, (_name, sql) => {
    const over = sqlLiterals(sql)
      .flatMap(repetitionBounds)
      .filter((b) => b.numbers.some((n) => n > RE_DUP_MAX))
      .map((b) => b.text);
    expect(over, 'Postgres refuses a regex bound above 255 when the CHECK first runs; write "~ \'^[...]+$\' and length(x) <= n"').toEqual([]);
  });
});
