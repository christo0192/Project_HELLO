/**
 * Static guarantees for migration 0143 (M035 S01: public R1 Meet bookings, one public booking
 * link). The behavioural SQL assertions run in supabase-ci
 * (app/supabase/tests/r1_meet_public_bookings_assert.sql, wired by scripts/test-r1-meet-public.sh);
 * these text-level checks keep the file additive and dark, keep the one sanctioned DROP NOT NULL
 * exact, and keep the swapped CHECKs in step with 0142 (the reasons and their pairing) and with
 * the shared M035 contracts (the job payloads and dedup keys of section 5).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const root = path.resolve(here, '../../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const FILE = '0143_r1_meet_public_bookings.sql';
const sql = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
/** Whole-line comments removed, whitespace collapsed: a layout-independent view of the executable SQL. */
const code = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
const lc = code.toLowerCase();
/** The TOP-LEVEL statements only: every dollar-quoted body (functions, DO blocks) replaced by a stub. */
const top = lc.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, () => '$body$');
/** The top level with string literals emptied: comment texts and IN-lists cannot hide or fake DDL. */
const topBare = top.replace(/'(?:[^']|'')*'/g, "''");

const sql0142 = readFileSync(path.join(migrations, '0142_r1_meet_bookings.sql'), 'utf8').replace(/\r\n/g, '\n');
const code0142 = sql0142.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();

/** The executable text of `source` from `startMarker` up to (not including) `endMarker`. */
function blockOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return source.slice(start, end);
}
const block = (startMarker: string, endMarker: string): string => blockOf(code, startMarker, endMarker);

/** The quoted values of a SQL list such as `'a', 'b'`. */
function quoted(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** The body of a named function (from its `create or replace function` to the closing `$$;`). */
function functionBody(name: string): string {
  return block(`create or replace function screening_v2.${name}(`, '$$;');
}

/** Every `(status in (...) and reason in (...))` family of a pairing CHECK text. */
function families(pairing: string): Array<{ statuses: string[]; reasons: string[] }> {
  return [...pairing.matchAll(/\(status in \(([^)]*)\) and reason in \(([^)]*)\)\)/g)].map((m) => ({
    statuses: quoted(m[1]!),
    reasons: quoted(m[2]!),
  }));
}

const BOOKINGS = 'alter table screening_v2.r1_meet_bookings';
const ASHBY_IDS = ['ashby_interview_event_id', 'ashby_schedule_id', 'ashby_scheduled_by_user_id'] as const;
/** The five table CHECKs 0143 adds or swaps, in file order (plan R3). */
const SWAPPED = [
  'chk_r1_meet_bookings_source_ids',
  'chk_r1_meet_bookings_calendar_event_id',
  'chk_r1_meet_bookings_public_columns',
  'chk_r1_meet_bookings_reason',
  'chk_r1_meet_bookings_status_reason',
] as const;
const TRIGGERS = ['enqueue_r1_meet_public_terminal', 'enqueue_r1_meet_calendar_purge'] as const;
const STATUSES = [
  'pending', 'unmatched_application', 'unmapped_scheduler', 'blocked',
  'bot_scheduled', 'bot_joining', 'human_present', 'in_call',
  'completed', 'cancelled', 'failed', 'drained',
] as const;

describe('migration 0143: file and frame', () => {
  it('is the only 0143 migration, carries the _r1_ infix and follows 0142', () => {
    expect(readdirSync(migrations).filter((name) => name.startsWith('0143_'))).toEqual([FILE]);
    expect(FILE).toMatch(/^0143_r1_[a-z0-9_]+\.sql$/);
    // Not "the newest": a later migration (S12's 0144) must not turn this test red.
    const numbered = readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(numbered.indexOf(FILE)).toBeGreaterThan(numbered.indexOf('0142_r1_meet_bookings.sql'));
    expect(numbered.indexOf('0142_r1_meet_bookings.sql')).toBeGreaterThan(-1);
  });

  it('sets a local lock_timeout first and reloads PostgREST last', () => {
    expect(code.startsWith("set local lock_timeout = '10s';")).toBe(true);
    expect(code.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(code.split("set local lock_timeout = '10s';")).toHaveLength(2);
    expect(code.split("notify pgrst, 'reload schema';")).toHaveLength(2);
  });

  it('documents that it is dark, additive and re-runnable', () => {
    expect(sql).toMatch(/^-- DARK\. Nothing calls any object below/m);
    expect(sql).toMatch(/R1_MEET_PUBLIC_BOOKING_ENABLED \(default OFF\)/);
    expect(sql).toMatch(/Additive and re-runnable/);
    expect(sql).toMatch(/no existing function is redeclared/);
  });

  it('keeps its sections in order, each exactly once', () => {
    const markers = ['-- §1. ', '-- §2. ', '-- §3. ', '-- §4. ', '-- §90. '];
    let last = -1;
    for (const marker of markers) {
      expect(sql.split(marker).length - 1, marker).toBe(1);
      expect(sql.indexOf(marker), marker).toBeGreaterThan(last);
      last = sql.indexOf(marker);
    }
    // Every section marker in the file is one of the listed ones (a later task adds its own).
    const all = [...sql.matchAll(/^-- §(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(all).toEqual([...all].sort((a, b) => a - b));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('migration 0143: additive', () => {
  it('drops only its own two triggers, the five CHECKs it swaps and the three sanctioned NOT NULLs', () => {
    expect([...topBare.matchAll(/\bdrop trigger if exists ([a-z0-9_]+) on screening_v2\.r1_meet_bookings;/g)].map((m) => m[1]))
      .toEqual([...TRIGGERS]);
    expect([...topBare.matchAll(/\bdrop constraint if exists ([a-z0-9_]+);/g)].map((m) => m[1])).toEqual([...SWAPPED]);
    expect([...topBare.matchAll(/\balter column ([a-z0-9_]+) ([a-z ]+?);/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(ASHBY_IDS.map((col) => `${col} drop not null`));
    // Nothing else is dropped: 2 triggers + 5 constraints + 3 NOT NULLs.
    expect(topBare.match(/\bdrop\b/g)).toHaveLength(TRIGGERS.length + SWAPPED.length + ASHBY_IDS.length);
    expect(topBare.match(/\balter column\b/g)).toHaveLength(ASHBY_IDS.length);
  });

  it('deletes, updates, inserts, truncates and renames nothing at the top level', () => {
    expect(topBare).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\brename\b/);
    expect(topBare).not.toMatch(/\bupdate\s+(?:only\s+)?[a-z0-9_]+(?:\.[a-z0-9_]+)?\s+set\b/);
    expect(topBare).not.toMatch(/\binsert\s+into\b/);
    expect(topBare).not.toMatch(/\bconcurrently\b|create (type|sequence|policy|view|extension|schema)\b/);
    expect(topBare).not.toMatch(/\bdo \$body\$/);
  });

  it('alters only the bookings table it extends and the throttle table it creates', () => {
    const altered = [...lc.matchAll(/\balter table (?:only )?([a-z0-9_.]+)/g)].map((m) => m[1]!);
    expect(new Set(altered)).toEqual(new Set(['screening_v2.r1_meet_bookings', 'screening_v2.r1_meet_public_throttle']));
  });

  it('creates exactly the throttle table, every table and index guarded by if not exists', () => {
    expect([...top.matchAll(/create table if not exists screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1]))
      .toEqual(['r1_meet_public_throttle']);
    expect(topBare.match(/\bcreate table\b/g)).toHaveLength(1);
    const indexes = topBare.match(/\bcreate (?:unique )?index\b[^;]*/g) ?? [];
    expect(indexes.length).toBe(3);
    for (const index of indexes) expect(index, index).toMatch(/^create (?:unique )?index if not exists /);
  });

  it('adds the seven columns in order, each with if not exists and a constant default or none', () => {
    const adds = [...lc.matchAll(/\badd column ([^;]*?)(?=;| constraint )/g)].map((m) => m[1]!);
    expect(adds.map((a) => a.split(' ').slice(0, 5).join(' '))).toEqual([
      'if not exists source text',
      'if not exists google_calendar_event_id text',
      'if not exists calendar_state text',
      'if not exists invite_sent_at timestamptz',
      'if not exists public_request_id uuid',
      'if not exists manage_token_digest text',
      'if not exists move_count smallint',
    ]);
    expect(adds.filter((a) => /\bdefault\b|\bnot null\b/.test(a))).toEqual([
      "if not exists source text not null default 'ashby'",
      'if not exists move_count smallint not null default 0',
    ]);
  });

  it('swaps every multi-column CHECK as drop if exists, add not valid, then validate', () => {
    for (const name of SWAPPED) {
      const drop = code.indexOf(`${BOOKINGS} drop constraint if exists ${name};`);
      const add = code.indexOf(`${BOOKINGS} add constraint ${name} check (`);
      const validate = code.indexOf(`${BOOKINGS} validate constraint ${name};`);
      expect(drop, name).toBeGreaterThan(-1);
      expect(add, name).toBe(drop + `${BOOKINGS} drop constraint if exists ${name}; `.length);
      expect(validate, name).toBeGreaterThan(add);
      expect(code.slice(add, validate).trimEnd().endsWith(') not valid;'), name).toBe(true);
      expect(code.split(`add constraint ${name} `), name).toHaveLength(2);
    }
    // No other ADD CONSTRAINT: the single-column CHECKs ride on their ADD COLUMN.
    expect(lc.match(/\badd constraint\b/g)).toHaveLength(SWAPPED.length);
  });
});

describe('migration 0143: the sanctioned DROP NOT NULL (TST-15)', () => {
  it('carries the marker once, in a comment right above the first drop', () => {
    expect(sql.split('R1-MEET-PUBLIC-IDS SANCTION').length - 1).toBe(1);
    const marker = sql.indexOf('-- R1-MEET-PUBLIC-IDS SANCTION:');
    const firstDrop = sql.indexOf('drop not null');
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(firstDrop);
    // Only comment lines sit between the marker and the first drop statement.
    const between = sql.slice(marker, sql.lastIndexOf('\n', firstDrop)).split('\n');
    const statementStart = between.findIndex((line) => !line.startsWith('--'));
    expect(between.slice(0, statementStart).every((line) => line.startsWith('--'))).toBe(true);
    expect(between.slice(statementStart)).toEqual([`${BOOKINGS}`]);
  });

  it('adds and validates the source/id CHECK before the first drop', () => {
    const firstDrop = code.indexOf('drop not null');
    expect(code.indexOf(`${BOOKINGS} add constraint chk_r1_meet_bookings_source_ids check (`)).toBeLessThan(firstDrop);
    expect(code.indexOf(`${BOOKINGS} validate constraint chk_r1_meet_bookings_source_ids;`)).toBeLessThan(firstDrop);
    expect(code.indexOf(`${BOOKINGS} add column if not exists source text`)).toBeLessThan(firstDrop);
  });

  it('keeps ashby_application_id NOT NULL', () => {
    expect(lc).not.toMatch(/alter column ashby_application_id\b/);
    expect(lc).not.toMatch(/\bdrop not null\b[^;]*ashby_application_id/);
  });

  it('is sanctioned by an exact, migration-local branch of the TST-15 verifier', () => {
    const verifier = read('scripts/migrate-rollback.test.mjs');
    expect(verifier).toContain('R1-MEET-PUBLIC-IDS SANCTION');
    expect(verifier).toContain("migration.startsWith('0143_r1_meet_public_bookings')");
    expect(verifier).toContain('SANCTIONED_DROP_NOT_NULL');
    // The positive fixture and every mutant of the self-tests.
    for (const label of ['P9 ', 'N10a ', 'N10b ', 'N10c ', 'N10d ', 'N10e ', 'N10f ', 'N10g ', 'N10h ']) {
      expect(verifier, label).toContain(`"${label}`);
    }
  });
});

describe('migration 0143: r1_meet_bookings schema', () => {
  it('adds the source with the ashby default and the two-value CHECK', () => {
    expect(code).toContain(
      `${BOOKINGS} add column if not exists source text not null default 'ashby' `
      + "constraint chk_r1_meet_bookings_source check (source in ('ashby', 'public_page'));",
    );
  });

  it('ties the three Ashby ids to the source, both ways', () => {
    expect(code).toContain(
      `${BOOKINGS} add constraint chk_r1_meet_bookings_source_ids check ( `
      + "(source = 'ashby' and ashby_interview_event_id is not null and ashby_schedule_id is not null "
      + 'and ashby_scheduled_by_user_id is not null) '
      + "or (source = 'public_page' and ashby_interview_event_id is null and ashby_schedule_id is null "
      + 'and ashby_scheduled_by_user_id is null) ) not valid;',
    );
  });

  it('pins the calendar event id to the booking id without dashes', () => {
    expect(code).toContain(
      `${BOOKINGS} add constraint chk_r1_meet_bookings_calendar_event_id check ( `
      + "google_calendar_event_id is null or google_calendar_event_id = replace(id::text, '-', '') ) not valid;",
    );
  });

  it('closes the calendar states, the manage digest and move_count on their columns', () => {
    expect(code).toContain(
      `${BOOKINGS} add column if not exists calendar_state text constraint chk_r1_meet_bookings_calendar_state `
      + "check (calendar_state is null or calendar_state in ('created', 'invited', 'cancelled', 'purged'));",
    );
    expect(code).toContain(
      `${BOOKINGS} add column if not exists manage_token_digest text constraint chk_r1_meet_bookings_manage_digest `
      + "check (manage_token_digest is null or manage_token_digest ~ '^[a-f0-9]{64}$');",
    );
    expect(code).toContain(
      `${BOOKINGS} add column if not exists move_count smallint not null default 0 `
      + 'constraint chk_r1_meet_bookings_move_count check (move_count between 0 and 10);',
    );
    expect(code).toContain(`${BOOKINGS} add column if not exists google_calendar_event_id text;`);
    expect(code).toContain(`${BOOKINGS} add column if not exists invite_sent_at timestamptz;`);
    expect(code).toContain(`${BOOKINGS} add column if not exists public_request_id uuid;`);
  });

  it('ties the public columns to the source', () => {
    expect(code).toContain(
      `${BOOKINGS} add constraint chk_r1_meet_bookings_public_columns check ( `
      + "(source = 'ashby' and google_calendar_event_id is null and calendar_state is null "
      + 'and invite_sent_at is null and public_request_id is null and manage_token_digest is null '
      + 'and move_count = 0) '
      + "or (source = 'public_page' and google_calendar_event_id is not null and calendar_state is not null "
      + "and public_request_id is not null and (invite_sent_at is null or calendar_state in ('invited', 'cancelled', 'purged'))) "
      + ') not valid;',
    );
  });

  it('adds the two partial unique indexes', () => {
    expect(code).toContain(
      'create unique index if not exists uq_r1_meet_bookings_public_request on screening_v2.r1_meet_bookings '
      + '(public_request_id) where public_request_id is not null;',
    );
    expect(code).toContain(
      'create unique index if not exists uq_r1_meet_bookings_manage_digest on screening_v2.r1_meet_bookings '
      + '(manage_token_digest) where manage_token_digest is not null;',
    );
  });

  it('keeps the 32 reasons of 0142 in 0142 order, then candidate_cancelled and invite_undeliverable', () => {
    const m0142 = /constraint chk_r1_meet_bookings_reason check \(reason in \(([^)]*)\)\)/.exec(code0142);
    const m0143 = /add constraint chk_r1_meet_bookings_reason check \(reason in \(([^)]*)\)\) not valid;/.exec(code);
    expect(m0142).not.toBeNull();
    expect(m0143).not.toBeNull();
    const before = quoted(m0142![1]!);
    const after = quoted(m0143![1]!);
    expect(before).toHaveLength(32);
    expect(after).toHaveLength(34);
    expect(new Set(after).size).toBe(34);
    expect(after.slice(0, 32)).toEqual(before);
    expect(after.slice(32)).toEqual(['candidate_cancelled', 'invite_undeliverable']);
  });

  it('keeps every 0142 pairing family, adding only cancelled/candidate_cancelled and failed/invite_undeliverable', () => {
    const before = families(blockOf(code0142, 'constraint chk_r1_meet_bookings_status_reason check (', 'constraint chk_r1_meet_bookings_version'));
    const after = families(block(
      'add constraint chk_r1_meet_bookings_status_reason check (',
      'validate constraint chk_r1_meet_bookings_status_reason;',
    ));
    expect(before).toHaveLength(8);
    const expected = before.map((f) => ({
      statuses: f.statuses,
      reasons: f.statuses.includes('cancelled') ? [...f.reasons, 'candidate_cancelled']
        : f.statuses.includes('failed') ? [...f.reasons, 'invite_undeliverable']
          : f.reasons,
    }));
    expect(after).toEqual(expected);
    // Every status in exactly one family; every reason of the closed list in exactly one family.
    for (const status of STATUSES) {
      expect(after.filter((f) => f.statuses.includes(status)), status).toHaveLength(1);
    }
    const reasons = quoted(/add constraint chk_r1_meet_bookings_reason check \(reason in \(([^)]*)\)\)/.exec(code)![1]!);
    const paired = after.flatMap((f) => f.reasons);
    expect([...paired].sort()).toEqual([...reasons].sort());
  });

  it('comments every new column and every added CHECK, and marks the manage digest Secret', () => {
    for (const col of ['source', 'google_calendar_event_id', 'calendar_state', 'invite_sent_at', 'public_request_id', 'manage_token_digest', 'move_count']) {
      expect(lc, col).toContain(`comment on column screening_v2.r1_meet_bookings.${col} is`);
    }
    for (const name of SWAPPED) {
      expect(lc, name).toContain(`comment on constraint ${name} on screening_v2.r1_meet_bookings is`);
    }
    expect(block('comment on column screening_v2.r1_meet_bookings.manage_token_digest is', ';')).toMatch(/Secret\.'$/);
  });
});

describe('migration 0143: r1_meet_public_throttle', () => {
  it('stores keyed digests per bucket with closed CHECKs and a bucket index', () => {
    expect(code).toContain(
      'create table if not exists screening_v2.r1_meet_public_throttle ( key_digest text not null, '
      + 'bucket_start timestamptz not null, hits integer not null default 0, '
      + 'constraint pk_r1_meet_public_throttle primary key (key_digest, bucket_start), '
      + "constraint chk_r1_meet_public_throttle_key check (key_digest ~ '^[a-f0-9]{64}$'), "
      + 'constraint chk_r1_meet_public_throttle_hits check (hits >= 0) );',
    );
    expect(code).toContain(
      'create index if not exists idx_r1_meet_public_throttle_bucket on screening_v2.r1_meet_public_throttle (bucket_start);',
    );
    expect(lc).toContain('comment on table screening_v2.r1_meet_public_throttle is');
    for (const col of ['key_digest', 'bucket_start', 'hits']) {
      expect(lc, col).toContain(`comment on column screening_v2.r1_meet_public_throttle.${col} is`);
    }
  });

  it('is RLS on, closed to the browser roles, and service_role gets select/insert/update/delete only', () => {
    expect(code).toContain('alter table screening_v2.r1_meet_public_throttle enable row level security;');
    expect(code).toContain('revoke all on screening_v2.r1_meet_public_throttle from public, anon, authenticated;');
    expect(code).toContain('revoke all on screening_v2.r1_meet_public_throttle from service_role;');
    expect(code).toContain('grant select, insert, update, delete on screening_v2.r1_meet_public_throttle to service_role;');
    expect(lc.match(/\bgrant\b[^;]*\bon screening_v2\.r1_meet_public_throttle\b/g)).toHaveLength(1);
    expect(lc).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/);
    expect(lc).not.toMatch(/\bcreate policy\b/);
  });
});

describe('migration 0143: the terminal and purge triggers', () => {
  it('fires the terminal trigger only for a public booking that first becomes cancelled, failed or drained', () => {
    expect(code).toContain(
      'drop trigger if exists enqueue_r1_meet_public_terminal on screening_v2.r1_meet_bookings; '
      + 'create trigger enqueue_r1_meet_public_terminal after update of status on screening_v2.r1_meet_bookings '
      + "for each row when (new.source = 'public_page' and new.status in ('cancelled', 'failed', 'drained') "
      + "and old.status not in ('completed', 'cancelled', 'failed', 'drained')) "
      + 'execute function screening_v2.enqueue_r1_meet_public_terminal();',
    );
  });

  it('fires the purge trigger only for a deleted public booking whose event exists', () => {
    expect(code).toContain(
      'drop trigger if exists enqueue_r1_meet_calendar_purge on screening_v2.r1_meet_bookings; '
      + 'create trigger enqueue_r1_meet_calendar_purge after delete on screening_v2.r1_meet_bookings '
      + "for each row when (old.source = 'public_page' and old.calendar_state in ('created', 'invited')) "
      + 'execute function screening_v2.enqueue_r1_meet_calendar_purge();',
    );
    expect(lc.match(/\bcreate trigger\b/g)).toHaveLength(TRIGGERS.length);
  });

  it('runs both functions as security invoker with search_path pg_catalog, revoked from the API roles', () => {
    for (const fn of TRIGGERS) {
      expect(functionBody(fn), fn).toContain(
        'returns trigger language plpgsql security invoker set search_path = pg_catalog as $$',
      );
      expect(code, fn).toContain(`revoke all on function screening_v2.${fn}() from public, anon, authenticated;`);
      expect(lc, fn).toContain(`comment on function screening_v2.${fn}() is`);
      expect(lc, fn).not.toMatch(new RegExp(`grant [^;]* on function screening_v2\\.${fn}\\(`));
    }
  });

  it('queues the calendar cancel while the event exists, the tag removal always, ids only', () => {
    const body = functionBody('enqueue_r1_meet_public_terminal');
    const calendar = block("if new.calendar_state in ('created', 'invited') then", 'end if;');
    expect(calendar).toContain(
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
      + "jsonb_build_object('kind', 'calendar_sync', 'op', 'cancel', 'booking_id', new.id), "
      + "'r1-meet:calendar:' || new.id::text || ':cancel', 10) on conflict do nothing;",
    );
    const tail = body.slice(body.indexOf('end if;'));
    expect(tail).toContain(
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
      + "jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'remove', 'booking_id', new.id), "
      + "'r1-meet:ashby-tag:' || new.id::text || ':remove', 10) on conflict do nothing; return null;",
    );
    expect(body.match(/insert into screening_v2\.job_queue\b/g)).toHaveLength(2);
    expect(body.match(/on conflict do nothing;/g)).toHaveLength(2);
  });

  it('queues one calendar purge, ids only', () => {
    const body = functionBody('enqueue_r1_meet_calendar_purge');
    expect(body).toContain(
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
      + "jsonb_build_object('kind', 'calendar_sync', 'op', 'purge', 'booking_id', old.id), "
      + "'r1-meet:calendar:' || old.id::text || ':purge', 10) on conflict do nothing; return old;",
    );
    expect(body.match(/insert into screening_v2\.job_queue\b/g)).toHaveLength(1);
  });

  it('writes only the contract payloads (kind, op, booking_id) with the closed ops and keys of section 5', () => {
    const payloads = [...lc.matchAll(/jsonb_build_object\('kind', '(calendar_sync|ashby_booked_tag)', ([^)]*)\)/g)];
    expect(payloads.length).toBeGreaterThan(0);
    const OPS: Record<string, string[]> = {
      calendar_sync: ['invite', 'move', 'cancel', 'purge'],
      ashby_booked_tag: ['add', 'remove'],
    };
    for (const m of payloads) {
      const rest = /^'op', '([a-z]+)', 'booking_id', [a-z_.]+$/.exec(m[2]!);
      expect(rest, m[0]).not.toBeNull();
      expect(OPS[m[1]!], m[0]).toContain(rest![1]);
    }
    for (const m of lc.matchAll(/'r1-meet:(calendar|ashby-tag):' \|\| [a-z_.]+::text \|\| ':([a-z]+)/g)) {
      expect(OPS[m[1] === 'calendar' ? 'calendar_sync' : 'ashby_booked_tag'], m[0]).toContain(m[2]);
    }
  });

  it('queues only r1-meet jobs with max_attempts 10, every insert on conflict do nothing', () => {
    const queueInserts = lc.match(/insert into screening_v2\.job_queue\b/g) ?? [];
    const named = [...lc.matchAll(/insert into screening_v2\.job_queue \(name, [^)]*\) (?:values \(|select )'([^']*)'/g)].map((m) => m[1]);
    expect(queueInserts.length).toBeGreaterThan(0);
    expect(named).toHaveLength(queueInserts.length);
    expect(new Set(named)).toEqual(new Set(['r1-meet']));
    expect(lc.match(/insert into screening_v2\.job_queue \(name, payload, dedup_key, max_attempts\) values \('r1-meet', /g))
      .toHaveLength(queueInserts.length);
    expect(lc.match(/, 10\) on conflict do nothing;/g)).toHaveLength(queueInserts.length);
  });
});

describe('migration 0143: clock, handlers and redeclarations', () => {
  it('reads no machine clock inside a function body and swallows no error', () => {
    const bodies = [...lc.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]!);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/\bnow\s*\(|\bcurrent_timestamp\b|\bclock_timestamp\s*\(|\bstatement_timestamp\s*\(/);
    }
    expect(lc).not.toMatch(/\bwhen others\b/);
    expect(lc).not.toMatch(/insert into screening_v2\.call_sessions\b/);
  });

  it('redeclares no existing function', () => {
    const created = [...lc.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\(/g)].map((m) => m[1]!);
    expect(created.length).toBeGreaterThan(0);
    const earlier = new Set<string>();
    for (const file of readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < FILE)) {
      const text = readFileSync(path.join(migrations, file), 'utf8').toLowerCase();
      for (const m of text.matchAll(/create (?:or replace )?function\s+(?:screening_v2\.)?([a-z0-9_]+)\s*\(/g)) earlier.add(m[1]!);
    }
    for (const fn of created) expect(earlier.has(fn), fn).toBe(false);
    // The D5 list by name, plus every 0142 RPC: the browser and Ashby paths stay byte-for-byte unchanged.
    for (const fn of [
      'r1_send_round', 'r1_admit_attempt', 'r1_transition_round', 'r1_withdraw_consent',
      'r1_settle_attempt', 'r1_reserve_preflight', 'enqueue_r1_recording_finalize',
      'enqueue_r1_recording_erase', 'purge_on_r1_recording_delete', 'reject_interview_round_audience_change',
      'r1_meet_create_round_from_ashby', 'r1_meet_reschedule_booking', 'r1_meet_cancel_booking',
      'r1_meet_set_bot', 'r1_meet_transition_booking', 'enqueue_r1_meet_bot_release',
      'enqueue_r1_meet_round_cancelled',
    ]) {
      expect(lc, fn).not.toMatch(new RegExp(`create (or replace )?function screening_v2\\.${fn}\\(`));
    }
  });
});

describe('migration 0143: wiring and the SQL suite', () => {
  const suite = read('app/supabase/tests/r1_meet_public_bookings_assert.sql');

  it('runs the suite with ON_ERROR_STOP from its own helper', () => {
    const script = read('scripts/test-r1-meet-public.sh');
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain("log() { printf '[r1-meet-public] %s %s\\n'");
    expect(script).toContain('psql -U postgres -d postgres -q -v ON_ERROR_STOP=1');
    expect(script).toContain('< "$TESTS/r1_meet_public_bookings_assert.sql"');
  });

  it('is called by supabase-test.sh right after the 0142 suite, before the TST-15 rehearsal', () => {
    const runner = read('scripts/supabase-test.sh');
    const meet = runner.indexOf('bash scripts/test-r1-meet.sh');
    const pub = runner.indexOf('bash scripts/test-r1-meet-public.sh');
    const tst15 = runner.indexOf('TST-15 rollback rehearsal');
    expect(meet).toBeGreaterThan(-1);
    expect(pub).toBeGreaterThan(meet);
    expect(tst15).toBeGreaterThan(pub);
    expect(runner.split('bash scripts/test-r1-meet-public.sh')).toHaveLength(2);
    expect(runner.slice(pub, tst15)).toContain('if [ "${PIPESTATUS[0]}" -ne 0 ]; then');
  });

  it('is named in both path filters of supabase-ci.yml, right after the 0142 helper', () => {
    const ci = read('.github/workflows/supabase-ci.yml');
    expect(ci.match(/^ {6}- 'scripts\/test-r1-meet-public\.sh'$/gm)).toHaveLength(2);
    expect(ci.match(/^ {6}- 'scripts\/test-r1-meet\.sh'\n {6}- 'scripts\/test-r1-meet-public\.sh'$/gm)).toHaveLength(2);
  });

  it('runs in one rolled-back transaction with fixture ids in the 7f000000 namespace', () => {
    const statements = suite.replace(/^\s*--.*$/gm, '').trim();
    expect(statements.startsWith('begin;')).toBe(true);
    expect(statements.endsWith('rollback;')).toBe(true);
    expect(suite.trimEnd().split('\n').at(-1)).toBe('rollback;');
    expect(statements).not.toMatch(/\bcommit;/);
    // Digests are computed at run time, never written as literals.
    expect(suite).toContain('encode(sha256(convert_to(');
    expect(suite).not.toMatch(/[a-f0-9]{40,}/i);
    const ids = [...suite.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/gi)].map((m) => m[0]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('7f000000-'), id).toBe(true);
    expect(suite).not.toMatch(/whsec_/i);
  });

  it('covers the T1 sections in order', () => {
    let last = -1;
    for (const section of ['-- T1-A. ', '-- T1-B. ', '-- T1-C. ', '-- T1-D. ', '-- T1-E. ', '-- T1-F. ', '-- T1-G. ', '-- T1-H. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
      expect(suite.indexOf(section), section).toBeGreaterThan(last);
      last = suite.indexOf(section);
    }
    for (const label of [
      'T1-A ashby_application_id stays NOT NULL',
      'T1-B an Ashby booking without source reads ashby and passes',
      'T1-C ',
      'T1-D the dashed booking id as the event id',
      'T1-E a second booking with the same public request id',
      'T1-F all 38 (status, reason) pairs are accepted',
      'T1-G ... and queues the bot release and the calendar purge, exactly',
      'T1-G a repeated purge of the same booking while its job is live adds no job',
      'T1-H a duplicate (key, bucket)',
    ]) {
      expect(suite, label).toContain(label);
    }
  });

  it('keeps the 0142 suite inserting valid Ashby rows (its full-row insert names the 0143 NOT NULL columns)', () => {
    const suite0142 = read('app/supabase/tests/r1_meet_bookings_assert.sql');
    const row = blockOf(suite0142, 'create function _r1_meet_tests.booking_row(', '$$;');
    expect(row).toContain("'source', 'ashby',");
    expect(row).toContain("'move_count', 0,");
  });
});
