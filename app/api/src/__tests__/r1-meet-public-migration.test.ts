/**
 * Static guarantees for migration 0143 (M035 S01: public R1 Meet bookings, one public booking
 * link). The behavioural SQL assertions run in supabase-ci
 * (app/supabase/tests/r1_meet_public_bookings_assert.sql, wired by scripts/test-r1-meet-public.sh),
 * and the two-session races of the create and the move in its own job r1-meet-public-race-test
 * (scripts/test-r1-meet-public-concurrency.sh, fixtures r1_meet_public_concurrency_setup.sql);
 * these text-level checks keep the file additive and dark, keep the one sanctioned DROP NOT NULL
 * exact, and keep the swapped CHECKs in step with 0142 (the reasons and their pairing) and with
 * the shared M035 contracts (the job payloads and dedup keys of section 5).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_MEET_CAP_REASONS,
  R1_MEET_CAP_STATUSES,
  R1_MEET_DISPATCHED_STATUSES,
  R1_MEET_LIVE_STATUSES,
  R1_MEET_TERMINAL_STATUSES,
  R1_MEET_UNDISPATCHED_STATUSES,
} from '../lib/r1/meet/runtime-store.js';
import {
  R1_MEET_JOB_MAX_ATTEMPTS,
  parseBotReleaseJob,
  parseEnsureBotJob,
  r1MeetDedupKeys,
  r1MeetJobs,
} from '../lib/r1/meet/jobs.js';

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
    const markers = [
      '-- §1. ', '-- §2. ', '-- §3. ', '-- §4. ',
      '-- §10. ', '-- §11. ', '-- §12. ', '-- §13. ', '-- §14. ', '-- §15. ', '-- §16. ', '-- §17. ',
      '-- §18. ', '-- §19. ', '-- §20. ', '-- §21. ', '-- §22. ', '-- §23. ', '-- §90. ',
    ];
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

// ── T2: the internal helpers and the read, digest, calendar-state and throttle RPCs ─────────────

/** Whole-line comments removed, whitespace collapsed (the `code` view of any SQL text). */
const norm = (text: string): string => text.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
const migration = (file: string): string => norm(readFileSync(path.join(migrations, file), 'utf8').replace(/\r\n/g, '\n'));
const code0128 = migration('0128_r1_twenty_minute_roleplay.sql');
const code0130 = migration('0130_ashby_phone_parsing_intake.sql');
const code0131 = migration('0131_r1_concurrent_sessions.sql');

/** The executable 0143 text that follows EACH whole-line occurrence of `marker` (later comments skipped). */
function copiesAfter(marker: string): string[] {
  const out: string[] = [];
  for (let at = sql.indexOf(`${marker}\n`); at !== -1; at = sql.indexOf(`${marker}\n`, at + 1)) {
    // A whole-line comment (indentation only before it), never a trailing one.
    expect(sql.slice(sql.lastIndexOf('\n', at) + 1, at).trim(), marker).toBe('');
    out.push(norm(sql.slice(at + marker.length + 1)));
  }
  expect(out.length, marker).toBeGreaterThan(0);
  return out;
}

/** `text` from `start` through the first `end` after it (both included). */
function through(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i, start).toBeGreaterThan(-1);
  const j = text.indexOf(end, i + start.length);
  expect(j, end).toBeGreaterThan(i);
  return text.slice(i, j + end.length);
}

/** Consecutive duplicates collapsed: a code checked twice in a row counts once. */
const runs = (values: string[]): string[] => values.filter((v, i) => i === 0 || values[i - 1] !== v);

/** The migration that last (re)declares a function before 0143. */
function lastDefiner(fn: string): string {
  const files = readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < FILE).sort();
  const definers = files.filter((f) => readFileSync(path.join(migrations, f), 'utf8').toLowerCase()
    .includes(`create or replace function screening_v2.${fn}(`));
  expect(definers.length, fn).toBeGreaterThan(0);
  return definers.at(-1)!;
}

interface T2Function {
  name: string;
  params: string;
  types: string;
  returns: string;
  posture: string;
  helper?: true;
}
const T2_FUNCTIONS: readonly T2Function[] = [
  { name: 'r1_meet_public_slot_count', params: 'p_start_at timestamptz, p_end_at timestamptz, p_exclude_booking_id uuid',
    types: 'timestamptz, timestamptz, uuid', returns: 'integer', posture: 'stable security invoker', helper: true },
  { name: 'r1_meet_public_day_count', params: 'p_ist_date date, p_exclude_booking_id uuid',
    types: 'date, uuid', returns: 'jsonb', posture: 'stable security invoker', helper: true },
  { name: 'r1_meet_public_refusal', params: 'p_candidate_id uuid, p_ashby_application_id text, p_now timestamptz',
    types: 'uuid, text, timestamptz', returns: 'text', posture: 'stable security invoker', helper: true },
  { name: 'r1_meet_public_capacity', params: 'p_from timestamptz, p_to timestamptz, p_now timestamptz default now()',
    types: 'timestamptz, timestamptz, timestamptz', returns: 'jsonb', posture: 'stable security definer' },
  { name: 'r1_meet_public_precheck',
    params: 'p_candidate_id uuid, p_ashby_application_id text, p_now timestamptz default now()',
    types: 'uuid, text, timestamptz', returns: 'jsonb', posture: 'stable security definer' },
  { name: 'r1_meet_public_set_manage_digest', params: 'p_booking_id uuid, p_digest text, p_now timestamptz default now()',
    types: 'uuid, text, timestamptz', returns: 'jsonb', posture: 'security definer' },
  { name: 'r1_meet_public_manage_read',
    params: 'p_digest text, p_cutoff_sec integer, p_max_moves integer, p_now timestamptz default now()',
    types: 'text, integer, integer, timestamptz', returns: 'jsonb', posture: 'stable security definer' },
  { name: 'r1_meet_public_set_calendar_state',
    params: 'p_booking_id uuid, p_from text[], p_to text, p_now timestamptz default now()',
    types: 'uuid, text[], text, timestamptz', returns: 'jsonb', posture: 'security definer' },
  { name: 'r1_meet_public_throttle_hit',
    params: 'p_keys text[], p_limits integer[], p_window_sec integer, p_now timestamptz default now()',
    types: 'text[], integer[], integer, timestamptz', returns: 'jsonb', posture: 'security definer' },
  { name: 'r1_meet_public_throttle_prune',
    params: 'p_older_than_sec integer, p_limit integer, p_now timestamptz default now()',
    types: 'integer, integer, timestamptz', returns: 'jsonb', posture: 'security definer' },
];
const STABLE_T2 = T2_FUNCTIONS.filter((f) => f.posture.startsWith('stable ')).map((f) => f.name);

/** Contracts section 4 "live": every status that holds the slot (the Ashby-only pre-round statuses never do). */
const LIVE = ['pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call'] as const;
const sqlList = (values: readonly string[]): string => `(${values.map((v) => `'${v}'`).join(', ')})`;

describe('migration 0143: T2 signatures, posture and privileges', () => {
  it('declares every T2 function once with its contract signature, return type and posture', () => {
    for (const fn of T2_FUNCTIONS) {
      expect(code, fn.name).toContain(
        `create or replace function screening_v2.${fn.name}( ${fn.params} ) returns ${fn.returns} `
        + `language plpgsql ${fn.posture} set search_path = pg_catalog, screening_v2 as $$`,
      );
      expect(lc.split(`create or replace function screening_v2.${fn.name}(`), fn.name).toHaveLength(2);
    }
    // Exactly the three helpers are invoker and stable; the read RPCs are stable definers.
    expect(T2_FUNCTIONS.filter((f) => f.helper).map((f) => f.name))
      .toEqual(['r1_meet_public_slot_count', 'r1_meet_public_day_count', 'r1_meet_public_refusal']);
    expect(STABLE_T2).toEqual([
      'r1_meet_public_slot_count', 'r1_meet_public_day_count', 'r1_meet_public_refusal',
      'r1_meet_public_capacity', 'r1_meet_public_precheck', 'r1_meet_public_manage_read',
    ]);
  });

  it('grants every RPC to service_role only, with a revoke, a grant and a comment', () => {
    for (const fn of T2_FUNCTIONS.filter((f) => !f.helper)) {
      const sig = `screening_v2.${fn.name}(${fn.types})`;
      expect(code, fn.name).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(code, fn.name).toContain(`grant execute on function ${sig} to service_role;`);
      expect(code, fn.name).toContain(`comment on function ${sig} is`);
      expect(lc.split(`grant execute on function ${sig}`), fn.name).toHaveLength(2);
    }
  });

  it('revokes the helpers from every API role, service_role included, and never grants them', () => {
    for (const fn of T2_FUNCTIONS.filter((f) => f.helper)) {
      const sig = `screening_v2.${fn.name}(${fn.types})`;
      expect(code, fn.name).toContain(`revoke all on function ${sig} from public, anon, authenticated, service_role;`);
      expect(code, fn.name).toContain(`comment on function ${sig} is`);
      expect(lc, fn.name).not.toMatch(new RegExp(`\\bgrant\\b[^;]*\\bon function screening_v2\\.${fn.name}\\(`));
    }
  });

  it('writes nothing and locks nothing in a stable function body', () => {
    for (const name of STABLE_T2) {
      const body = functionBody(name);
      expect(body, name).not.toMatch(/\binsert\s+into\b|\bupdate\s+screening_v2\.|\bdelete\s+from\b|\bfor update\b|\bpg_advisory/);
    }
  });

  it('validates every argument first, in the plan order, before reading anything', () => {
    const FIELDS: Record<string, string[]> = {
      r1_meet_public_capacity: ['window', 'now'],
      r1_meet_public_precheck: ['candidate_id', 'application_id', 'now'],
      r1_meet_public_set_manage_digest: ['booking_id', 'digest', 'now'],
      r1_meet_public_manage_read: ['digest', 'cutoff', 'max_moves', 'now'],
      r1_meet_public_set_calendar_state: ['booking_id', 'to', 'from', 'now'],
      r1_meet_public_throttle_hit: ['keys', 'limits', 'window', 'now'],
      r1_meet_public_throttle_prune: ['older_than', 'limit', 'now'],
    };
    for (const [name, fields] of Object.entries(FIELDS)) {
      const body = functionBody(name);
      const found = [...body.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)];
      expect(runs(found.map((m) => m[1]!)), name).toEqual(fields);
      // Nothing of the schema is touched before the last field check (the DECLARE types aside).
      const statements = body.slice(body.indexOf(' begin ', body.indexOf('as $$')));
      expect(statements.indexOf('screening_v2.'), name).toBeGreaterThan(statements.lastIndexOf("'invalid_request'"));
    }
  });

  it('answers only its closed statuses, in order', () => {
    const STATUSES: Record<string, string[]> = {
      r1_meet_public_capacity: ['invalid_request', 'ok'],
      r1_meet_public_precheck: ['invalid_request', 'eligible', 'refused'],
      r1_meet_public_set_manage_digest: ['invalid_request', 'not_found', 'not_public', 'booking_terminal', 'ok'],
      r1_meet_public_manage_read: ['invalid_request', 'not_found', 'ok'],
      r1_meet_public_set_calendar_state: ['invalid_request', 'not_found', 'not_public', 'state_conflict', 'ok'],
      r1_meet_public_throttle_hit: ['invalid_request', 'ok'],
      r1_meet_public_throttle_prune: ['invalid_request', 'ok'],
    };
    for (const [name, statuses] of Object.entries(STATUSES)) {
      expect(runs([...functionBody(name).matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!)), name).toEqual(statuses);
    }
  });
});

describe('migration 0143: T2 copied predicates equal their sources', () => {
  it('copies from the latest definitions (0128 r1_send_round, 0131 r1_admit_attempt, 0142 create)', () => {
    expect(lastDefiner('r1_send_round')).toBe('0128_r1_twenty_minute_roleplay.sql');
    expect(lastDefiner('r1_admit_attempt')).toBe('0131_r1_concurrent_sessions.sql');
    expect(lastDefiner('r1_capacity_snapshot')).toBe('0128_r1_twenty_minute_roleplay.sql');
    expect(lastDefiner('r1_meet_create_round_from_ashby')).toBe('0142_r1_meet_bookings.sql');
  });

  it('copies the 0131 concurrent-limit block verbatim (same variable names)', () => {
    const source = through(code0131, "if v_settings.livekit_target='r1' then", 'end if;');
    expect(source).toContain('v_limit:=least(coalesce(v_settings.max_concurrent_sessions,1),greatest(v_pool,1));');
    for (const copy of copiesAfter('-- copied from r1_admit_attempt (0131 concurrent-limit)')) {
      expect(copy.startsWith(source), copy.slice(0, 200)).toBe(true);
    }
  });

  it('copies the two 0128 phone predicates verbatim', () => {
    const send = blockOf(code0128, 'create or replace function screening_v2.r1_send_round(', '$$;');
    const engagement = through(send, 'if exists (select 1 from screening_v2.phone_engagements e', ') then');
    const assessment = through(send, 'if exists (select 1 from screening_v2.call_sessions s join screening_v2.job_queue j', ') then');
    expect(engagement).toContain('e.candidate_id=p_candidate_id');
    expect(assessment).toContain("j.name='phone.assessment'");
    for (const copy of copiesAfter('-- copied from r1_send_round (0128)')) {
      expect(copy.startsWith(engagement), copy.slice(0, 200)).toBe(true);
      const next = copy.indexOf('if exists (', engagement.length);
      expect(copy.slice(next).startsWith(assessment), copy.slice(next, next + 200)).toBe(true);
    }
  });

  it('decides admits with the r1_send_round capacity expression', () => {
    const CAPACITY = "coalesce((screening_v2.r1_capacity_snapshot(p_now, 65)->>'admits')::boolean, false)";
    const send = blockOf(code0128, 'create or replace function screening_v2.r1_send_round(', '$$;');
    expect(send).toContain(`if ${CAPACITY} is not true then return jsonb_build_object('status','capacity_exhausted');`);
    const copies = copiesAfter('-- copied from r1_send_round (0128) capacity');
    expect(copies[0]!.startsWith(`if ${CAPACITY} is not true then return 'capacity_exhausted';`)).toBe(true);
    for (const copy of copies) {
      expect(copy.startsWith(`if ${CAPACITY} is not true then`) || copy.startsWith(`v_admits := ${CAPACITY};`), copy.slice(0, 200))
        .toBe(true);
    }
    expect(functionBody('r1_meet_public_capacity')).toContain(`v_admits := ${CAPACITY};`);
  });

  it('copies the 0130 DSAR hold predicate, on the candidate parameter', () => {
    const hold = code0130.indexOf("v_outcome := 'subject_request_hold';");
    expect(hold).toBeGreaterThan(-1);
    const source = code0130.slice(code0130.lastIndexOf('if exists (', hold), hold).trim();
    expect(source).toContain('d.candidate_id = v_link.candidate_id');
    const expected = source.replace('d.candidate_id = v_link.candidate_id', 'd.candidate_id = p_candidate_id');
    for (const copy of copiesAfter('-- copied from 0130 subject_request_hold')) {
      expect(copy.startsWith(expected), copy.slice(0, 300)).toBe(true);
    }
  });

  it('copies the 0142 step 8a predicate without its event conjunct (the helper has no booking yet)', () => {
    const source = through(code0142, 'select r.id, r.version into v_lapsed_id, v_lapsed_version', ' limit 1;');
    const conjunct = ' and o.ashby_interview_event_id <> p_ashby_interview_event_id';
    expect(source.split(conjunct)).toHaveLength(2);
    const expected = source.replace(conjunct, '');
    const copies = copiesAfter('-- copied from r1_meet_create_round_from_ashby (0142) step 8a, without the event conjunct');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startsWith(expected), copies[0]!.slice(0, 600)).toBe(true);
    expect(functionBody('r1_meet_public_refusal')).toContain(expected);
  });

  it('copies the 0142 step 10 reuse condition verbatim', () => {
    const source = through(code0142, "if v_round.id is null or v_round.channel <> 'meet'", ' then exit decide;')
      .slice(0, -' exit decide;'.length);
    expect(source).toContain("b.status not in ('completed', 'cancelled', 'failed', 'drained'))");
    for (const copy of copiesAfter('-- copied from r1_meet_create_round_from_ashby (0142) step 10 reuse')) {
      expect(copy.startsWith(source), copy.slice(0, 600)).toBe(true);
    }
    expect(functionBody('r1_meet_public_refusal')).toContain(`${source} v_reusable := false; end if;`);
  });

  it('reads the newest active notice with the 0142 step 7 predicate', () => {
    const source = through(code0142, 'select t.* into v_template', "and t.locale = 'en-IN';");
    const prefix = source.slice(0, -"'en-IN';".length);
    for (const copy of copiesAfter('-- newest active notice (0142 step 7)')) {
      expect(copy.startsWith(prefix), copy.slice(0, 300)).toBe(true);
      expect(["'en-IN';", 'v_round.consent_locale;', 'v_locale;'].some((tail) => copy.startsWith(`${prefix}${tail}`)),
        copy.slice(0, 300)).toBe(true);
    }
    expect(functionBody('r1_meet_public_refusal')).toContain(`${prefix}v_locale;`);
  });

  it('reads consent_current with the admission consent gate, on the booking round', () => {
    const gate = through(code0131, 'exists(select 1 from screening_v2.interview_round_consents c', 't.required_consents <@ c.consents)');
    expect(code0128).toContain(gate);
    expect(gate.split('c.round_id=v_round.id')).toHaveLength(2);
    const expected = `v_consent := ${gate.replace('c.round_id=v_round.id', 'c.round_id=v_booking.round_id')};`;
    for (const copy of copiesAfter('-- copied from r1_admit_attempt (0128) consent gate')) {
      expect(copy.startsWith(expected), copy.slice(0, 300)).toBe(true);
    }
  });
});

describe('migration 0143: T2 helpers and RPC bodies', () => {
  it('names the live, cap, dispatched and terminal lists exactly as runtime-store.ts does', () => {
    expect([...LIVE]).toEqual(R1_MEET_LIVE_STATUSES.filter((s) => s !== 'unmatched_application' && s !== 'unmapped_scheduler'));
    const day = functionBody('r1_meet_public_day_count');
    const m = /and \(b\.status in \(([^)]*)\) or \(b\.status in \(([^)]*)\) and b\.reason in \(([^)]*)\)\)\);/.exec(day);
    expect(m, day).not.toBeNull();
    expect(quoted(m![1]!)).toEqual([...LIVE]);
    expect(quoted(m![2]!)).toEqual([...R1_MEET_CAP_STATUSES]);
    expect(quoted(m![3]!)).toEqual([...R1_MEET_CAP_REASONS]);
    expect(functionBody('r1_meet_public_slot_count')).toContain(`where b.status in ${sqlList(LIVE)}`);
    expect(functionBody('r1_meet_public_capacity')).toContain(`where b.status in ${sqlList(LIVE)}`);
    expect(functionBody('r1_meet_public_refusal')).toContain(`and b.status in ${sqlList(LIVE)}`);
    expect(functionBody('r1_meet_public_manage_read')).toContain(`v_booking.status not in ${sqlList(LIVE)}`);
    expect(functionBody('r1_meet_public_set_manage_digest'))
      .toContain(`if v_booking.status in ${sqlList(R1_MEET_TERMINAL_STATUSES)} then`);
    const read = functionBody('r1_meet_public_manage_read');
    const undispatched = R1_MEET_UNDISPATCHED_STATUSES.filter((s) => s !== 'unmatched_application' && s !== 'unmapped_scheduler');
    expect(read).toContain(
      `'can_move', v_booking.status in ${sqlList(undispatched)} and v_before_cutoff and v_booking.move_count < p_max_moves,`,
    );
    expect(read).toContain(`'can_cancel', v_booking.status not in ${sqlList(R1_MEET_DISPATCHED_STATUSES)} and v_before_cutoff,`);
  });

  it('counts a slot by overlap and a day by its IST window', () => {
    expect(functionBody('r1_meet_public_slot_count')).toContain(
      'and b.start_at < p_end_at and b.end_at > p_start_at and b.id is distinct from p_exclude_booking_id);',
    );
    const day = functionBody('r1_meet_public_day_count');
    expect(day).toContain("v_from timestamptz := p_ist_date::timestamp at time zone 'Asia/Kolkata';");
    expect(day).toContain("v_to timestamptz := (p_ist_date + 1)::timestamp at time zone 'Asia/Kolkata';");
    expect(day).toContain('where b.start_at >= v_from and b.start_at < v_to and b.id is distinct from p_exclude_booking_id');
    expect(day).toContain("count(*)::integer, (count(*) filter (where b.source = 'public_page'))::integer");
    expect(day).toContain("return jsonb_build_object('total', v_total, 'public', v_public);");
  });

  it('returns the refusal codes in exactly the contract order, then NULL', () => {
    const body = functionBody('r1_meet_public_refusal');
    expect(runs([...body.matchAll(/return '([a-z0-9_]+)';/g)].map((m) => m[1]!))).toEqual([
      'application_unknown', 'application_terminal', 'mapping_unavailable', 'dsar_hold', 'candidate_ineligible',
      'already_booked', 'r1_completed', 'phone_engagement_active', 'phone_assessment_pending',
      'role_not_configured', 'consent_template_unavailable', 'disabled', 'paused', 'capacity_exhausted',
    ]);
    expect(body.trimEnd().endsWith('return null; end;')).toBe(true);
    // The link is matched verbatim and must be bound to THIS candidate; a lapsed-only round is not "live".
    expect(body).toContain("where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;");
    expect(body).toContain('if not v_link_found or v_link_candidate is distinct from p_candidate_id then');
    expect(body).toContain('if v_round.id is not null and not v_reusable and v_lapsed_id is null then return \'already_booked\';');
    expect(body).toContain("if not v_reusable and exists (select 1 from screening_v2.interview_rounds r where r.candidate_id = p_candidate_id and r.kind = 'sales_r1' and r.status = 'completed') then return 'r1_completed';");
    expect(body).toContain("if not v_reusable then if coalesce(");
    expect(body).toContain("if v_reusable then v_locale := v_round.consent_locale; end if;");
  });

  it('precheck is the helper behind its field checks', () => {
    const body = functionBody('r1_meet_public_precheck');
    expect(body).toContain('v_code := screening_v2.r1_meet_public_refusal(p_candidate_id, p_ashby_application_id, p_now);');
    expect(body).toContain("if v_code is null then return jsonb_build_object('status', 'eligible'); end if; "
      + "return jsonb_build_object('status', 'refused', 'code', v_code);");
    expect(body).toContain("if p_ashby_application_id is null or p_ashby_application_id !~* c_uuid then");
  });

  it('capacity: the 15-day window, ordered id-free intervals, every IST date, closed defaults without settings', () => {
    const body = functionBody('r1_meet_public_capacity');
    expect(body).toContain("if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '15 days' then");
    expect(body).toContain(
      "select coalesce(jsonb_agg(jsonb_build_object('start_at', b.start_at, 'end_at', b.end_at) "
      + "order by b.start_at, b.end_at), '[]'::jsonb) into v_intervals",
    );
    expect(body).toContain("v_first := (p_from at time zone 'Asia/Kolkata')::date;");
    expect(body).toContain("v_last := ((p_to - interval '1 microsecond') at time zone 'Asia/Kolkata')::date;");
    expect(body).toContain('|| screening_v2.r1_meet_public_day_count(g.d, null) order by g.d) into v_days');
    expect(body).toContain('from (select v_first + i as d from generate_series(0, v_last - v_first) i) g;');
    expect(body).toContain(
      "if not found then return jsonb_build_object('status', 'ok', 'enabled', false, 'paused', false, 'admits', false, "
      + "'effective_concurrency', 1, 'intervals', v_intervals, 'day_counts', v_days); end if;",
    );
    // r1_capacity_snapshot raises on a missing settings row: it is only reached after the row was found.
    expect(body.indexOf('if not found then return')).toBeLessThan(body.indexOf('r1_capacity_snapshot('));
  });

  it('set_manage_digest and set_calendar_state never touch updated_at (R19) and write one column set', () => {
    const digest = functionBody('r1_meet_public_set_manage_digest');
    const calendar = functionBody('r1_meet_public_set_calendar_state');
    for (const body of [digest, calendar]) expect(body).not.toContain('updated_at');
    expect(digest.match(/\bupdate screening_v2\./g)).toHaveLength(1);
    expect(digest).toContain('update screening_v2.r1_meet_bookings set manage_token_digest = p_digest where id = v_booking.id;');
    expect(digest).toContain("if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then");
    expect(calendar.match(/\bupdate screening_v2\./g)).toHaveLength(1);
    expect(calendar).toContain(
      "update screening_v2.r1_meet_bookings set calendar_state = p_to, invite_sent_at = case when p_to = 'invited' "
      + 'then coalesce(invite_sent_at, p_now) else invite_sent_at end where id = v_booking.id;',
    );
    expect(calendar).toContain("if p_to is null or p_to not in ('invited', 'cancelled', 'purged') then");
    expect(calendar).toContain(
      "v_allowed := case p_to when 'purged' then array['created', 'invited', 'cancelled'] else array['created', 'invited'] end;",
    );
    expect(calendar).toContain('if p_from is null or array_ndims(p_from) is distinct from 1 then');
    expect(calendar).toContain('if cardinality(p_from) not between 1 and 3 or cardinality(array_remove(p_from, null)) <> cardinality(p_from) or not (p_from <@ v_allowed) then');
    expect(calendar).toContain("if v_booking.calendar_state <> all(p_from) then return jsonb_build_object('status', 'state_conflict', 'current', v_booking.calendar_state);");
  });

  it('manage_read answers only for a live public booking before its slot ends', () => {
    const body = functionBody('r1_meet_public_manage_read');
    expect(body).toContain("where b.manage_token_digest = p_digest and b.source = 'public_page';");
    expect(body).toContain('or p_now >= v_booking.end_at then return jsonb_build_object(\'status\', \'not_found\');');
    expect(body).toContain('if p_cutoff_sec is null or p_cutoff_sec not between 900 and 43200 then');
    expect(body).toContain('if p_max_moves is null or p_max_moves not between 0 and 10 then');
    expect(body).toContain('v_before_cutoff := p_now < v_booking.start_at - make_interval(secs => p_cutoff_sec);');
    expect(body).toContain("'moves_left', greatest(p_max_moves - v_booking.move_count, 0),");
    // The whole ok answer: the contract keys in order, no digest, no Meet URL, no candidate data.
    const undispatched = R1_MEET_UNDISPATCHED_STATUSES.filter((s) => s !== 'unmatched_application' && s !== 'unmapped_scheduler');
    expect(body).toContain(
      "return jsonb_build_object( 'status', 'ok', 'booking_id', v_booking.id, 'booking_status', v_booking.status, "
      + "'version', v_booking.version, 'has_bot', v_booking.recall_bot_id is not null, "
      + "'start_at', v_booking.start_at, 'end_at', v_booking.end_at, "
      + `'can_move', v_booking.status in ${sqlList(undispatched)} and v_before_cutoff and v_booking.move_count < p_max_moves, `
      + `'can_cancel', v_booking.status not in ${sqlList(R1_MEET_DISPATCHED_STATUSES)} and v_before_cutoff, `
      + "'moves_left', greatest(p_max_moves - v_booking.move_count, 0), 'consent_current', v_consent);",
    );
    expect(body).not.toMatch(/manage_token_digest', |meet_url|ashby_application_id|public_request_id/);
  });

  it('throttle_hit: closed inputs, one upsert in key order, capped hits, epoch-floored bucket', () => {
    const body = functionBody('r1_meet_public_throttle_hit');
    expect(body).toContain('if p_keys is null or array_ndims(p_keys) is distinct from 1 then');
    expect(body).toContain('if cardinality(p_keys) not between 1 and 8');
    expect(body).toContain("where k.key_digest is null or k.key_digest !~ '^[a-f0-9]{64}$')");
    expect(body).toContain('or (select count(distinct k.key_digest) from unnest(p_keys) k(key_digest)) <> cardinality(p_keys) then');
    expect(body).toContain('or cardinality(p_limits) <> cardinality(p_keys)');
    expect(body).toContain('where l.hit_limit is null or l.hit_limit not between 1 and 100000) then');
    expect(body).toContain('if p_window_sec is null or p_window_sec not between 60 and 86400 then');
    expect(body).toContain(
      'v_bucket := to_timestamp((floor(extract(epoch from p_now) / p_window_sec) * p_window_sec)::double precision);',
    );
    expect(body).toContain(
      'insert into screening_v2.r1_meet_public_throttle as t (key_digest, bucket_start, hits) '
      + 'select k.key_digest, v_bucket, 1 from unnest(p_keys) k(key_digest) order by k.key_digest '
      + 'on conflict (key_digest, bucket_start) do update set hits = least(t.hits + 1, 1000000000) '
      + 'returning t.key_digest, t.hits',
    );
    expect(body.match(/\binsert into\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/\bupdate screening_v2\.|\bdelete from\b/);
    expect(body).toContain('where h.hits > k.hit_limit;');
    expect(body).toContain("return jsonb_build_object('status', 'ok', 'over', to_jsonb(v_over));");
  });

  it('throttle_prune deletes the oldest buckets first, bounded, skipping held rows', () => {
    const body = functionBody('r1_meet_public_throttle_prune');
    expect(body).toContain('if p_older_than_sec is null or p_older_than_sec not between 3600 and 31536000 then');
    expect(body).toContain('if p_limit is null or p_limit not between 1 and 5000 then');
    expect(body).toContain(
      'delete from screening_v2.r1_meet_public_throttle where (key_digest, bucket_start) in ( '
      + 'select t.key_digest, t.bucket_start from screening_v2.r1_meet_public_throttle t '
      + 'where t.bucket_start < p_now - make_interval(secs => p_older_than_sec) '
      + 'order by t.bucket_start, t.key_digest limit p_limit for update skip locked);',
    );
    expect(body).toContain("return jsonb_build_object('status', 'ok', 'deleted', v_deleted);");
  });
});

// ── T3: r1_meet_create_round_from_public ────────────────────────────────────────────────────────

const CREATE = 'r1_meet_create_round_from_public';
const CREATE_PARAMS = 'p_booking_id uuid, p_public_request_id uuid, p_candidate_id uuid, p_ashby_application_id text, '
  + 'p_meet_url text, p_start_at timestamptz, p_end_at timestamptz, p_created_by uuid, p_consent jsonb, '
  + 'p_slot_seats integer, p_public_day_limit integer, p_bot_day_limit integer, '
  + "p_objective_profile text default 'r1_dex_sales', p_expiry_grace_sec integer default 7200, "
  + 'p_now timestamptz default now()';
const CREATE_TYPES = 'uuid, uuid, uuid, text, text, timestamptz, timestamptz, uuid, jsonb, integer, integer, integer, '
  + 'text, integer, timestamptz';
const REFUSED = (code: string): string => `return jsonb_build_object('status', 'refused', 'code', '${code}');`;
/** The form's consent checked against the notice in v_template (step 8 for en-IN, again on a re-link). */
const CONSENT_CHECK = "if p_consent ->> 'template_version' <> v_template.version then "
  + `${REFUSED('consent_stale')} end if; `
  + "if not (v_template.required_consents <@ (p_consent -> 'consents')) "
  + "or p_consent -> 'in_india' is distinct from 'true'::jsonb then "
  + `${REFUSED('consent_incomplete')} end if;`;

describe('migration 0143: T3 r1_meet_create_round_from_public', () => {
  // The body (from its `create or replace function` to the closing `$$;`), read without `expect`
  // at collection time; the first test proves the declaration exists.
  const createStart = code.indexOf(`create or replace function screening_v2.${CREATE}(`);
  const body = createStart === -1 ? '' : code.slice(createStart, code.indexOf('$$;', createStart));

  it('declares the create once with its contract signature, as a volatile security definer', () => {
    expect(code).toContain(
      `create or replace function screening_v2.${CREATE}( ${CREATE_PARAMS} ) returns jsonb `
      + 'language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$',
    );
    expect(lc.split(`create or replace function screening_v2.${CREATE}(`)).toHaveLength(2);
    const sig = `screening_v2.${CREATE}(${CREATE_TYPES})`;
    expect(code).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    expect(code).toContain(`grant execute on function ${sig} to service_role;`);
    expect(code).toContain(`comment on function ${sig} is`);
    expect(lc.split(`grant execute on function ${sig}`)).toHaveLength(2);
    expect(lc).not.toMatch(new RegExp(`\\bgrant\\b[^;]*\\bon function screening_v2\\.${CREATE}\\([^;]*\\bto\\b[^;]*\\b(anon|authenticated|public)\\b`));
  });

  it('validates every field in the contract order, reading nothing, before the first lock', () => {
    const lock = body.indexOf('pg_advisory_xact_lock(');
    expect(lock).toBeGreaterThan(-1);
    const fields = (text: string): string[] =>
      [...text.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(fields(body.slice(0, lock))).toEqual([
      'booking_id', 'request_id', 'candidate_id', 'application_id', 'meet_url', 'slot', 'created_by', 'consent',
      'seats', 'day_limit', 'profile', 'grace', 'now',
      // The replay (another candidate or application) and the taken booking id.
      'request_id', 'booking_id',
    ]);
    // After the candidate lock: only the replay re-check.
    expect(fields(body.slice(lock))).toEqual(['request_id']);
    // Nothing of the schema is read before the last field check.
    const statements = body.slice(body.indexOf(' begin ', body.indexOf('as $$')));
    expect(statements.indexOf('screening_v2.')).toBeGreaterThan(statements.indexOf("'field', 'now'"));
    expect(body).toContain("if p_meet_url is null or p_meet_url !~ '^https://meet\\.google\\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$' then");
    expect(code0142).toContain("if p_meet_url is null or p_meet_url !~ '^https://meet\\.google\\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$' then");
    expect(body).toContain(
      "or p_end_at - p_start_at not between interval '30 minutes' and interval '60 minutes' then",
    );
    expect(body).toContain('if p_slot_seats is null or p_slot_seats not between 1 and 15 then');
    expect(body).toContain('if p_public_day_limit is null or p_public_day_limit not between 1 and 200 '
      + 'or p_bot_day_limit is null or p_bot_day_limit not between 1 and 200 then');
    expect(body).toContain("if p_objective_profile is null or p_objective_profile not in ('r1_dex_sales') then");
    expect(body).toContain('if p_expiry_grace_sec is null or p_expiry_grace_sec not between 900 and 86400 then');
  });

  it('closes the consent shape (plan R23), checked in steps', () => {
    expect(body).toContain("v_consent_ok := p_consent is not null and jsonb_typeof(p_consent) = 'object';");
    expect(body).toContain(
      "where k.key not in ('template_version', 'consents', 'in_india', 'ip_prefix', 'user_agent'))",
    );
    for (const text of [
      "coalesce(jsonb_typeof(p_consent -> 'template_version') = 'string', false)",
      "coalesce(jsonb_typeof(p_consent -> 'consents') = 'array', false)",
      "coalesce(jsonb_typeof(p_consent -> 'in_india') = 'boolean', false)",
      "coalesce(jsonb_typeof(p_consent -> 'ip_prefix'), 'null') in ('null', 'string')",
      "coalesce(jsonb_typeof(p_consent -> 'user_agent'), 'null') in ('null', 'string')",
      "char_length(p_consent ->> 'template_version') between 1 and 64",
      "jsonb_array_length(p_consent -> 'consents') between 1 and 8",
      "coalesce(char_length(p_consent ->> 'ip_prefix') between 1 and 64, true)",
      "coalesce(char_length(p_consent ->> 'user_agent') between 1 and 256, true)",
      "where e.item !~ '^[a-z][a-z0-9_]{0,63}$')",
      "(select count(distinct e.item) from jsonb_array_elements_text(p_consent -> 'consents') e(item)) = jsonb_array_length(p_consent -> 'consents')",
    ]) {
      expect(body, text).toContain(text);
    }
    // The type checks run before any function that needs the type (three separate steps).
    expect(body.split('if v_consent_ok then')).toHaveLength(4);
  });

  it('runs its steps in the contract order (replay, locks, capacity, refusals, 0142 steps 8a, 9, 10, inserts)', () => {
    const steps = [
      'select * into v_replay from screening_v2.r1_meet_bookings b where b.public_request_id = p_public_request_id;',
      'if exists (select 1 from screening_v2.r1_meet_bookings b where b.id = p_booking_id) then',
      `if p_start_at <= p_now then ${REFUSED('in_past')}`,
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_public:candidate:' || p_candidate_id::text, 0));",
      'select * into v_replay from screening_v2.r1_meet_bookings b where b.public_request_id = p_public_request_id;',
      "v_day := (p_start_at at time zone 'Asia/Kolkata')::date;",
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_public:day:' || to_char(v_day, 'YYYY-MM-DD'), 0));",
      `if screening_v2.r1_meet_public_slot_count(p_start_at, p_end_at, null) >= p_slot_seats then ${REFUSED('slot_full')}`,
      'v_counts := screening_v2.r1_meet_public_day_count(v_day, null);',
      "if (v_counts ->> 'public')::integer >= p_public_day_limit or (v_counts ->> 'total')::integer >= p_bot_day_limit "
        + `then ${REFUSED('day_full')}`,
      'v_refusal := screening_v2.r1_meet_public_refusal(p_candidate_id, p_ashby_application_id, p_now);',
      "if v_refusal is not null then return jsonb_build_object('status', 'refused', 'code', v_refusal); end if;",
      `if not exists (select 1 from auth.users u where u.id = p_created_by) then ${REFUSED('created_by_unknown')}`,
      'v_expires := p_end_at + make_interval(secs => p_expiry_grace_sec);',
      `if v_expires > p_now + interval '14 days' then ${REFUSED('slot_too_far')}`,
      "and t.locale = 'en-IN';",
      `if not found or jsonb_array_length(v_template.required_consents) = 0 then ${REFUSED('consent_template_unavailable')}`,
      CONSENT_CHECK,
      `if v_role_count <> 1 then ${REFUSED('role_not_configured')}`,
      'and o.id is distinct from p_booking_id',
      'v_send := screening_v2.r1_send_round(',
      "update screening_v2.interview_rounds set channel = 'meet' where id = v_round_id; v_result := 'created';",
      'select * into v_round from screening_v2.interview_rounds where id = v_live_id for update;',
      'and t.locale = v_round.consent_locale;',
      CONSENT_CHECK,
      "v_round_id := v_round.id; v_result := 'relinked';",
      'insert into screening_v2.interview_round_consents',
      'insert into screening_v2.r1_meet_bookings',
      "jsonb_build_object('kind', 'ensure_bot'",
      "jsonb_build_object('kind', 'calendar_sync', 'op', 'invite'",
      "jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'add'",
      "'status', 'booked'",
    ];
    let at = -1;
    for (const step of steps) {
      const i = body.indexOf(step, at + 1);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    expect(body.match(/pg_advisory_xact_lock\(/g)).toHaveLength(2);
    expect(body.split('where b.public_request_id = p_public_request_id;')).toHaveLength(3);
    // No booking row is locked: the day lock serialises the creates of a day.
    expect(body).not.toMatch(/from screening_v2\.r1_meet_bookings[^;]*for update/);
  });

  it('answers replayed, refused, invalid_request or booked, with the refusal codes in order', () => {
    expect(runs([...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!))).toEqual([
      'invalid_request', 'replayed', 'invalid_request', 'refused', 'replayed', 'invalid_request', 'refused', 'booked',
    ]);
    const codes = [...body.matchAll(/'status', 'refused', 'code', (?:'([a-z_]+)'|(v_[a-z_]+))\)/g)].map((m) => m[1] ?? m[2]!);
    expect(runs(codes)).toEqual([
      'in_past', 'slot_full', 'day_full', 'v_refusal', 'created_by_unknown', 'slot_too_far',
      'consent_template_unavailable', 'consent_stale', 'consent_incomplete', 'role_not_configured',
      // r1_send_round's own refusals (a race backstop behind §12), then the re-link's.
      'v_code', 'already_booked', 'phone_engagement_active', 'phone_assessment_pending',
      'consent_template_unavailable', 'consent_stale', 'consent_incomplete',
    ]);
    // Every refusal code is a closed contract word.
    const contract = new Set([
      'application_unknown', 'application_terminal', 'mapping_unavailable', 'dsar_hold', 'candidate_ineligible',
      'already_booked', 'r1_completed', 'phone_engagement_active', 'phone_assessment_pending', 'role_not_configured',
      'consent_template_unavailable', 'disabled', 'paused', 'capacity_exhausted', 'slot_full', 'day_full',
      'consent_stale', 'consent_incomplete', 'in_past', 'slot_too_far', 'created_by_unknown',
    ]);
    for (const c of codes.filter((c) => !c.startsWith('v_'))) expect(contract.has(c), c).toBe(true);
    expect(body).toContain(
      "return jsonb_build_object('status', 'replayed', 'booking_id', v_replay.id, "
      + "'start_at', v_replay.start_at, 'end_at', v_replay.end_at);",
    );
    expect(body).toContain(
      'if v_replay.candidate_id = p_candidate_id and v_replay.ashby_application_id = p_ashby_application_id then',
    );
    expect(body).toContain(
      "return jsonb_build_object( 'status', 'booked', 'result', v_result, 'booking_id', v_booking.id, "
      + "'round_id', v_booking.round_id, 'candidate_id', v_booking.candidate_id, "
      + "'start_at', v_booking.start_at, 'end_at', v_booking.end_at, "
      + "'version', v_booking.version, 'key_attempt', v_booking.key_attempt, "
      + "'round_expires_at', v_expires);",
    );
    // No answer (a field name of invalid_request aside) carries the Meet URL, a digest, the request
    // id, the calendar event id or anything of the form's consent.
    const answers = [...body.matchAll(/return jsonb_build_object\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(answers.length).toBeGreaterThan(20);
    for (const answer of answers.filter((a) => !a.includes("'invalid_request'"))) {
      expect(answer).not.toMatch(/meet_url|digest|request_id|calendar|ip_prefix|user_agent|p_consent/);
    }
  });

  it('maps r1_send_round exactly as 0142 does, and raises on anything unexpected', () => {
    const list0142 = /if v_code in \(([^)]*)\) then v_status := 'blocked'; v_reason := v_code;/.exec(code0142);
    expect(list0142).not.toBeNull();
    expect(body).toContain(`if v_code in (${list0142![1]}) then return jsonb_build_object('status', 'refused', 'code', v_code); end if;`);
    expect(body).toContain(
      "if v_code is distinct from 'ok' and v_code is distinct from 'round_active' then "
      + "raise exception 'r1_meet_create_round_from_public: unexpected answer from r1_send_round' using errcode = 'P0001'; end if;",
    );
  });

  it('copies 0142 step 8a with `o.id is distinct from p_booking_id` for the event conjunct (R01 1.3)', () => {
    const source = through(code0142, 'select r.id, r.version into v_lapsed_id, v_lapsed_version', ' limit 1;');
    const conjunct = ' and o.ashby_interview_event_id <> p_ashby_interview_event_id';
    expect(source.split(conjunct)).toHaveLength(2);
    const expire = "if v_lapsed_id is not null then perform screening_v2.r1_transition_round(v_lapsed_id, 'expire', "
      + 'v_lapsed_version, null, null, p_now); end if;';
    expect(code0142).toContain(`${source} ${expire}`);
    const expected = `${source.replace(conjunct, ' and o.id is distinct from p_booking_id')} ${expire}`;
    const copies = copiesAfter('-- copied from r1_meet_create_round_from_ashby (0142) step 8a, is distinct from');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startsWith(expected), copies[0]!.slice(0, 700)).toBe(true);
    expect(body).toContain(expected);
    // The alias keeps the copied text verbatim: the candidate is the parameter.
    expect(body).toContain('v_candidate_id constant uuid := p_candidate_id;');
  });

  it('copies 0142 step 9: the round through r1_send_round with the unusable link digest, then channel meet', () => {
    const DIGEST = "encode(sha256(convert_to('r1-meet-unusable:' || gen_random_uuid()::text || ':' "
      + "|| gen_random_uuid()::text, 'UTF8')), 'hex')";
    expect(code0142).toContain(DIGEST);
    expect(body).toContain(DIGEST);
    const source = through(code0142, 'select c.status into v_candidate_status', "v_code := v_send ->> 'status';");
    expect(source).toContain(DIGEST);
    const copies = copiesAfter('-- copied from r1_meet_create_round_from_ashby (0142) step 9');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startsWith(source), copies[0]!.slice(0, 600)).toBe(true);
    expect(lc.match(/\br1_send_round\(/g)).toHaveLength(1);
  });

  it('copies 0142 step 10 (the hold month, the round lock, the reuse, the expiry and the supersede)', () => {
    const source = through(code0142, 'select r.id, r.held_minutes, r.hold_month, r.charged_attempt_number > r.attempts_counted',
      'select * into v_round from screening_v2.interview_rounds where id = v_live_id for update;');
    expect(source.split('exit decide;')).toHaveLength(3);
    const expected = source.replaceAll('exit decide;', REFUSED('already_booked'));
    const copies = copiesAfter('-- copied from r1_meet_create_round_from_ashby (0142) step 10');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startsWith(expected), copies[0]!.slice(0, 900)).toBe(true);
    // The reuse condition (pinned verbatim by the T2 test) refuses as already_booked.
    const reuse = through(code0142, "if v_round.id is null or v_round.channel <> 'meet'", ' then exit decide;')
      .slice(0, -' exit decide;'.length);
    expect(body).toContain(`${reuse} ${REFUSED('already_booked')} end if;`);
    // The re-link: the round's audience, the form re-checked, the expiry moved, the consent superseded.
    const expiry = 'update screening_v2.interview_rounds set expires_at = v_expires, version = version + 1, '
      + 'updated_at = p_now where id = v_round.id;';
    const supersede = through(code0142, 'update screening_v2.interview_round_consents set withdrawn_at = p_now,',
      'where round_id = v_round.id and withdrawn_at is null;');
    for (const text of [expiry, supersede]) {
      expect(code0142).toContain(text);
      expect(body).toContain(text);
    }
    expect(body.split(CONSENT_CHECK)).toHaveLength(3);
    expect(body.indexOf(CONSENT_CHECK, body.indexOf('and t.locale = v_round.consent_locale;'))).toBeLessThan(body.indexOf(expiry));
    expect(body.indexOf(expiry)).toBeLessThan(body.indexOf(supersede));
    expect(body.indexOf(supersede)).toBeLessThan(body.indexOf('insert into screening_v2.interview_round_consents'));
  });

  it('inserts the candidate_web consent: no attestation column, the required set, exactly the nine proof fields', () => {
    const insert = through(body, 'insert into screening_v2.interview_round_consents', 'p_now);');
    expect(insert.startsWith(
      'insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof, granted_at) '
      + 'values (v_round_id, v_template.id, v_template.required_consents, jsonb_build_object(',
    )).toBe(true);
    expect(insert).not.toMatch(/\bmethod\b|attested|hr_attested/);
    const proof = through(insert, 'jsonb_build_object(', 'true)');
    const args = proof.slice('jsonb_build_object('.length, -1).trim().split(', ');
    expect(args).toHaveLength(18);
    expect(args.filter((_, i) => i % 2 === 0)).toEqual([
      "'decision'", "'captured_at'", "'template_version'", "'locale'", "'ip_prefix'", "'user_agent'",
      "'source'", "'channel'", "'india_location_confirmed'",
    ]);
    expect(proof).toBe(
      "jsonb_build_object( 'decision', 'granted', 'captured_at', p_now, 'template_version', v_template.version, "
      + "'locale', v_template.locale, 'ip_prefix', p_consent ->> 'ip_prefix', 'user_agent', p_consent ->> 'user_agent', "
      + "'source', 'r1_public_booking', 'channel', 'meet', 'india_location_confirmed', true)",
    );
    expect(body.match(/insert into screening_v2\.interview_round_consents\b/g)).toHaveLength(1);
  });

  it('inserts the public booking: no Ashby event, schedule or scheduler, the event id pin, calendar created', () => {
    expect(body).toContain(
      'insert into screening_v2.r1_meet_bookings (id, source, ashby_interview_event_id, ashby_schedule_id, '
      + 'ashby_application_id, ashby_interview_stage_id, ashby_interview_id, ashby_scheduled_by_user_id, ashby_updated_at, '
      + 'candidate_id, round_id, objective_profile, status, reason, meet_url, start_at, end_at, '
      + 'google_calendar_event_id, calendar_state, public_request_id, created_at, updated_at) '
      + "values (p_booking_id, 'public_page', null, null, p_ashby_application_id, null, null, null, null, "
      + "p_candidate_id, v_round_id, p_objective_profile, 'pending', 'eligible', p_meet_url, p_start_at, p_end_at, "
      + "replace(p_booking_id::text, '-', ''), 'created', p_public_request_id, p_now, p_now) returning * into v_booking;",
    );
    expect(body.match(/insert into screening_v2\.r1_meet_bookings\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/\bupdate screening_v2\.r1_meet_bookings\b/);
  });

  it('queues exactly the ensure_bot, calendar invite and Ashby tag add jobs of contracts section 5', () => {
    const inserts = [...body.matchAll(/insert into screening_v2\.job_queue [^;]*;/g)].map((m) => m[0]);
    expect(inserts).toEqual([
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
        + "jsonb_build_object('kind', 'ensure_bot', 'booking_id', v_booking.id), "
        + "'r1-meet:ensure-bot:' || v_booking.id::text, 10) on conflict do nothing;",
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
        + "jsonb_build_object('kind', 'calendar_sync', 'op', 'invite', 'booking_id', v_booking.id), "
        + "'r1-meet:calendar:' || v_booking.id::text || ':invite', 10) on conflict do nothing;",
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
        + "jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'add', 'booking_id', v_booking.id), "
        + "'r1-meet:ashby-tag:' || v_booking.id::text || ':add', 10) on conflict do nothing;",
    ]);
    // The ensure_bot row is exactly what jobs.ts writes and parses (S06's maintenance re-drives it).
    const id = '7f000000-0000-4000-8000-004000000500';
    const spec = r1MeetJobs.ensureBot(id);
    expect(spec.payload).toEqual({ kind: 'ensure_bot', booking_id: id });
    expect(spec.dedupKey).toBe(`r1-meet:ensure-bot:${id}`);
    expect(r1MeetDedupKeys.ensureBot(id.toUpperCase())).toBe(`r1-meet:ensure-bot:${id}`);
    expect(spec.maxAttempts).toBe(10);
    expect(R1_MEET_JOB_MAX_ATTEMPTS.ensure_bot).toBe(10);
    expect(parseEnsureBotJob({ kind: 'ensure_bot', booking_id: id })).toEqual({ kind: 'ensure_bot', bookingId: id });
  });

  it('calls r1_transition_round only for the 8a expiry and the T4 cancel (with its one retry), never reissuing a link', () => {
    expect([...lc.matchAll(/\br1_transition_round\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
      "v_lapsed_id, 'expire', v_lapsed_version, null, null, p_now",
      "v_booking.round_id, 'cancel', v_round_version, null, null, p_now",
      "v_booking.round_id, 'cancel', v_round_version, null, null, p_now",
    ]);
    expect(functionBody('r1_meet_public_cancel_booking').match(/\br1_transition_round\(/g)).toHaveLength(2);
    expect(lc).not.toContain("'reissue'");
    expect(body).not.toMatch(/\br1_withdraw_consent\(|\bcall_sessions\b[^;]*\binsert\b|insert into screening_v2\.call_sessions/);
  });
});

// ── T4: move, cancel and re-consent through the manage digest ──────────────────────────────────

const MOVE = 'r1_meet_public_move_booking';
const CANCEL = 'r1_meet_public_cancel_booking';
const RECONSENT = 'r1_meet_public_reconsent';
const T4_FUNCTIONS: readonly T2Function[] = [
  { name: MOVE,
    params: 'p_booking_id uuid, p_digest text, p_expected_version integer, p_start_at timestamptz, p_end_at timestamptz, '
      + 'p_slot_seats integer, p_public_day_limit integer, p_bot_day_limit integer, p_max_moves integer, '
      + 'p_cutoff_sec integer, p_expiry_grace_sec integer default 7200, p_now timestamptz default now()',
    types: 'uuid, text, integer, timestamptz, timestamptz, integer, integer, integer, integer, integer, integer, timestamptz',
    returns: 'jsonb', posture: 'security definer' },
  { name: CANCEL,
    params: 'p_digest text, p_withdraw_consent boolean, p_cutoff_sec integer, p_now timestamptz default now()',
    types: 'text, boolean, integer, timestamptz', returns: 'jsonb', posture: 'security definer' },
  { name: RECONSENT,
    params: 'p_digest text, p_consent jsonb, p_now timestamptz default now()',
    types: 'text, jsonb, timestamptz', returns: 'jsonb', posture: 'security definer' },
];
/** The body of a 0142 function, as executable text. */
const body0142 = (name: string): string => blockOf(code0142, `create or replace function screening_v2.${name}(`, '$$;');
/** Every refusal code of a body, in text order (`v_*` for a passed-through variable). */
const refusalCodes = (text: string): string[] =>
  [...text.matchAll(/'status', 'refused', 'code', (?:'([a-z_]+)'|(v_[a-z_]+))\)/g)].map((m) => m[1] ?? m[2]!);
/** `steps` must appear in `text` in this order. */
function inOrder(text: string, steps: readonly string[]): void {
  let at = -1;
  for (const step of steps) {
    const i = text.indexOf(step, at + 1);
    expect(i, step).toBeGreaterThan(at);
    at = i;
  }
}

describe('migration 0143: T4 move, cancel and re-consent', () => {
  const move = (): string => functionBody(MOVE);
  const cancel = (): string => functionBody(CANCEL);
  const reconsent = (): string => functionBody(RECONSENT);
  const create = (): string => functionBody(CREATE);

  it('declares the three once with their contract signatures, as volatile security definers, service_role only', () => {
    for (const fn of T4_FUNCTIONS) {
      expect(code, fn.name).toContain(
        `create or replace function screening_v2.${fn.name}( ${fn.params} ) returns ${fn.returns} `
        + `language plpgsql ${fn.posture} set search_path = pg_catalog, screening_v2 as $$`,
      );
      expect(lc.split(`create or replace function screening_v2.${fn.name}(`), fn.name).toHaveLength(2);
      const sig = `screening_v2.${fn.name}(${fn.types})`;
      expect(code, fn.name).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(code, fn.name).toContain(`grant execute on function ${sig} to service_role;`);
      expect(code, fn.name).toContain(`comment on function ${sig} is`);
      expect(lc.split(`grant execute on function ${sig}`), fn.name).toHaveLength(2);
      expect(lc, fn.name).not.toMatch(
        new RegExp(`\\bgrant\\b[^;]*\\bon function screening_v2\\.${fn.name}\\([^;]*\\bto\\b[^;]*\\b(anon|authenticated|public)\\b`),
      );
    }
  });

  it('validates every argument first, in the plan order, before reading anything', () => {
    const FIELDS: Record<string, string[]> = {
      [MOVE]: ['booking_id', 'digest', 'version', 'slot', 'seats', 'day_limit', 'max_moves', 'cutoff', 'grace', 'now'],
      [CANCEL]: ['digest', 'withdraw_consent', 'cutoff', 'now'],
      [RECONSENT]: ['digest', 'consent', 'now'],
    };
    for (const [name, fields] of Object.entries(FIELDS)) {
      const body = functionBody(name);
      const found = [...body.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)].map((m) => m[1]!);
      expect(runs(found), name).toEqual(fields);
      const statements = body.slice(body.indexOf(' begin ', body.indexOf('as $$')));
      expect(statements.indexOf('screening_v2.'), name).toBeGreaterThan(statements.lastIndexOf("'invalid_request'"));
      expect(body, name).toContain("if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then");
      expect(body, name).toContain('if p_now is null then');
    }
    // The bounds are the create's and manage_read's, word for word.
    for (const text of [
      'if p_expected_version is null or p_expected_version not between 0 and 50 then',
      "or p_end_at - p_start_at not between interval '30 minutes' and interval '60 minutes' then",
      'if p_slot_seats is null or p_slot_seats not between 1 and 15 then',
      'if p_public_day_limit is null or p_public_day_limit not between 1 and 200 '
        + 'or p_bot_day_limit is null or p_bot_day_limit not between 1 and 200 then',
      'if p_max_moves is null or p_max_moves not between 0 and 10 then',
      'if p_cutoff_sec is null or p_cutoff_sec not between 900 and 43200 then',
      'if p_expiry_grace_sec is null or p_expiry_grace_sec not between 900 and 86400 then',
    ]) {
      expect(move(), text).toContain(text);
    }
    expect(create()).toContain("or p_end_at - p_start_at not between interval '30 minutes' and interval '60 minutes' then");
    expect(functionBody('r1_meet_public_manage_read')).toContain('if p_max_moves is null or p_max_moves not between 0 and 10 then');
    expect(cancel()).toContain('if p_withdraw_consent is null then');
    expect(cancel()).toContain('if p_cutoff_sec is null or p_cutoff_sec not between 900 and 43200 then');
  });

  it('answers only its closed statuses and refusal codes, in order', () => {
    const statuses = (text: string): string[] => runs([...text.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!));
    expect(statuses(move())).toEqual(['invalid_request', 'refused', 'moved']);
    expect(statuses(cancel())).toEqual(['invalid_request', 'refused', 'already_cancelled', 'refused', 'cancelled']);
    expect(statuses(reconsent())).toEqual(['invalid_request', 'refused', 'ok']);
    expect(runs(refusalCodes(cancel()))).toEqual(['not_found', 'cutoff_passed', 'booking_dispatched']);
    expect(runs(refusalCodes(reconsent()))).toEqual([
      'not_found', 'booking_dispatched', 'not_found', 'consent_stale', 'consent_incomplete',
    ]);
    // Every code is a closed contract word of its RPC (contracts section 4.1 items 6-8).
    const CONTRACT: Record<string, string[]> = {
      [MOVE]: ['not_found', 'cutoff_passed', 'moves_exhausted', 'same_slot', 'slot_full', 'day_full', 'bot_attached',
        'booking_dispatched', 'in_past', 'slot_too_far', 'version_conflict', 'round_not_live'],
      [CANCEL]: ['not_found', 'cutoff_passed', 'booking_dispatched'],
      [RECONSENT]: ['not_found', 'booking_dispatched', 'consent_stale', 'consent_incomplete'],
    };
    for (const [name, words] of Object.entries(CONTRACT)) {
      for (const c of refusalCodes(functionBody(name)).filter((c) => !c.startsWith('v_'))) {
        expect(words, `${name} ${c}`).toContain(c);
      }
    }
    // No answer (a field name of invalid_request aside) carries a digest, the Meet URL or the consent.
    for (const name of [MOVE, CANCEL, RECONSENT]) {
      const answers = [...functionBody(name).matchAll(/return jsonb_build_object\(([^;]*)\);/g)].map((m) => m[1]!);
      expect(answers.length, name).toBeGreaterThan(3);
      for (const answer of answers.filter((a) => !a.includes("'invalid_request'"))) {
        expect(answer, name).not.toMatch(/meet_url|digest|request_id|calendar|ip_prefix|user_agent|p_consent|ticket/);
      }
    }
  });

  it('move: the day locks (least, then greatest), then the booking, then the refusals in the plan order (R16)', () => {
    const body = move();
    inOrder(body, [
      "select b.start_at into v_current_start from screening_v2.r1_meet_bookings b "
        + "where b.id = p_booking_id and b.source = 'public_page' and b.manage_token_digest = p_digest;",
      `if not found then ${REFUSED('not_found')} end if;`,
      "v_old_day := (v_current_start at time zone 'Asia/Kolkata')::date;",
      "v_new_day := (p_start_at at time zone 'Asia/Kolkata')::date;",
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_public:day:' || to_char(least(v_old_day, v_new_day), 'YYYY-MM-DD'), 0));",
      'if v_new_day <> v_old_day then',
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_public:day:' || to_char(greatest(v_old_day, v_new_day), 'YYYY-MM-DD'), 0));",
      "select * into v_booking from screening_v2.r1_meet_bookings b "
        + "where b.id = p_booking_id and b.source = 'public_page' and b.manage_token_digest = p_digest for update;",
      `or v_booking.status not in ${sqlList(LIVE)} or p_now >= v_booking.end_at then ${REFUSED('not_found')}`,
      `if p_now >= v_booking.start_at - make_interval(secs => p_cutoff_sec) then ${REFUSED('cutoff_passed')}`,
      `if v_booking.move_count >= p_max_moves then ${REFUSED('moves_exhausted')}`,
      `if p_start_at = v_booking.start_at and p_end_at = v_booking.end_at then ${REFUSED('same_slot')}`,
      `if v_booking.status in ${sqlList(R1_MEET_DISPATCHED_STATUSES)} then ${REFUSED('booking_dispatched')}`,
      `if p_start_at <= p_now then ${REFUSED('in_past')}`,
      `if p_end_at + make_interval(secs => p_expiry_grace_sec) > p_now + interval '14 days' then ${REFUSED('slot_too_far')}`,
      `if screening_v2.r1_meet_public_slot_count(p_start_at, p_end_at, v_booking.id) >= p_slot_seats then ${REFUSED('slot_full')}`,
      'v_counts := screening_v2.r1_meet_public_day_count(v_new_day, v_booking.id);',
      "if (v_counts ->> 'public')::integer >= p_public_day_limit or (v_counts ->> 'total')::integer >= p_bot_day_limit "
        + `then ${REFUSED('day_full')}`,
      `if v_booking.version is distinct from p_expected_version then ${REFUSED('version_conflict')}`,
      `if v_booking.recall_bot_id is not null then ${REFUSED('bot_attached')}`,
      'v_res := screening_v2.r1_meet_reschedule_booking( v_booking.id, p_expected_version, p_start_at, p_end_at, '
        + 'v_booking.meet_url, null, p_expiry_grace_sec, p_now);',
    ]);
    // The plan's refusal order (R16) up to the reschedule, then its mapping.
    const before = body.slice(0, body.indexOf('screening_v2.r1_meet_reschedule_booking('));
    expect(runs(refusalCodes(before))).toEqual([
      'not_found', 'cutoff_passed', 'moves_exhausted', 'same_slot', 'booking_dispatched', 'in_past', 'slot_too_far',
      'slot_full', 'day_full', 'version_conflict', 'bot_attached',
    ]);
    expect(runs(refusalCodes(body.slice(before.length)))).toEqual(['v_code', 'moves_exhausted', 'round_not_live', 'not_found']);
    // Two advisory locks, both before the one row lock; the locks are on days only (no candidate lock).
    expect(body.match(/pg_advisory_xact_lock\(/g)).toHaveLength(2);
    expect(body.match(/\bfor update\b/g)).toHaveLength(1);
    expect(body.lastIndexOf('pg_advisory_xact_lock(')).toBeLessThan(body.indexOf(' for update;'));
    expect(body).not.toContain('r1_meet_public:candidate:');
    // The day-lock key is the create's.
    expect(create()).toContain("hashtextextended('r1_meet_public:day:' || to_char(v_day, 'YYYY-MM-DD'), 0)");
  });

  it('move: maps every answer of the unchanged 0142 reschedule, raising on the rest', () => {
    expect(lastDefiner('r1_meet_reschedule_booking')).toBe('0142_r1_meet_bookings.sql');
    expect(code0142).toContain(
      'create or replace function screening_v2.r1_meet_reschedule_booking( p_booking_id uuid, p_expected_version integer, '
      + 'p_start_at timestamptz, p_end_at timestamptz, p_meet_url text, p_ashby_updated_at timestamptz, '
      + 'p_expiry_grace_sec integer default 7200, p_now timestamptz default now() )',
    );
    const body = move();
    expect(body).toContain(
      "if v_code in ('version_conflict', 'booking_dispatched', 'bot_attached', 'in_past', 'slot_too_far') then "
      + "return jsonb_build_object('status', 'refused', 'code', v_code); end if;",
    );
    expect(body).toContain(`if v_code = 'version_exhausted' then ${REFUSED('moves_exhausted')} end if;`);
    expect(body).toContain(`if v_code in ('round_not_live', 'no_round') then ${REFUSED('round_not_live')} end if;`);
    expect(body).toContain(`if v_code in ('not_found', 'booking_terminal') then ${REFUSED('not_found')} end if;`);
    expect(body).toContain(
      "if v_code is distinct from 'ok' then raise exception "
      + "'r1_meet_public_move_booking: unexpected answer from r1_meet_reschedule_booking' using errcode = 'P0001'; end if;",
    );
    // Mapped + raised = every answer the reschedule can give.
    const answers = new Set([...body0142('r1_meet_reschedule_booking').matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!));
    const mapped = new Set(['ok', 'version_conflict', 'booking_dispatched', 'bot_attached', 'in_past', 'slot_too_far',
      'version_exhausted', 'round_not_live', 'no_round', 'not_found', 'booking_terminal']);
    for (const a of mapped) expect(answers, a).toContain(a);
    expect([...answers].filter((a) => !mapped.has(a)).sort()).toEqual(['invalid_request', 'not_allowed', 'stale_update']);
  });

  it('move: move_count + 1, then ensure_bot and calendar move keyed by the new count, then the contract answer', () => {
    const body = move();
    const update = 'update screening_v2.r1_meet_bookings set move_count = move_count + 1 where id = v_booking.id '
      + 'returning * into v_booking;';
    const inserts = [
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
        + "jsonb_build_object('kind', 'ensure_bot', 'booking_id', v_booking.id), "
        + "'r1-meet:ensure-bot:' || v_booking.id::text, 10) on conflict do nothing;",
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
        + "jsonb_build_object('kind', 'calendar_sync', 'op', 'move', 'booking_id', v_booking.id), "
        + "'r1-meet:calendar:' || v_booking.id::text || ':move:' || v_booking.move_count::text, 10) on conflict do nothing;",
    ];
    expect([...body.matchAll(/insert into screening_v2\.job_queue [^;]*;/g)].map((m) => m[0])).toEqual(inserts);
    inOrder(body, ["if v_code is distinct from 'ok' then", update, ...inserts,
      "return jsonb_build_object( 'status', 'moved', 'booking_id', v_booking.id, "
        + "'start_at', v_booking.start_at, 'end_at', v_booking.end_at, "
        + "'version', v_booking.version, 'key_attempt', v_booking.key_attempt, 'move_count', v_booking.move_count);"]);
    expect(body.match(/\bupdate screening_v2\./g)).toHaveLength(1);
    expect(body).not.toContain('updated_at');
    // ensure_bot is the create's job (one live job per booking: a pending one absorbs the move's).
    expect(create()).toContain(inserts[0]);
  });

  it('cancel: the booking first, then the round (one retry), then the consent, then the bot release; no round_cancelled job', () => {
    const body = cancel();
    const ticket = through(body0142('r1_meet_cancel_booking'), 'ticket_digest = case when ticket_claimed_at is null',
      'updated_at = p_now');
    const transition = "v_res := screening_v2.r1_transition_round(v_booking.round_id, 'cancel', v_round_version, null, null, p_now);";
    inOrder(body, [
      "select * into v_booking from screening_v2.r1_meet_bookings b "
        + "where b.manage_token_digest = p_digest and b.source = 'public_page' for update;",
      `if not found or p_now >= v_booking.end_at then ${REFUSED('not_found')} end if;`,
      "if v_booking.status = 'cancelled' and v_booking.reason = 'candidate_cancelled' then "
        + "return jsonb_build_object('status', 'already_cancelled'); end if;",
      `if v_booking.status in ${sqlList(R1_MEET_TERMINAL_STATUSES)} then ${REFUSED('not_found')} end if;`,
      `if p_now >= v_booking.start_at - make_interval(secs => p_cutoff_sec) then ${REFUSED('cutoff_passed')} end if;`,
      `if v_booking.status in ${sqlList(R1_MEET_DISPATCHED_STATUSES)} then ${REFUSED('booking_dispatched')} end if;`,
      'select r.status, r.version into v_round_status, v_round_version from screening_v2.interview_rounds r '
        + 'where r.id = v_booking.round_id;',
      `update screening_v2.r1_meet_bookings set status = 'cancelled', reason = 'candidate_cancelled', ${ticket} `
        + 'where id = v_booking.id;',
      "if v_round_status in ('invited', 'in_progress') then",
      transition,
      "if v_res ->> 'status' = 'version_conflict' then select r.version into v_round_version "
        + 'from screening_v2.interview_rounds r where r.id = v_booking.round_id;',
      transition,
      "if v_res ->> 'status' is distinct from 'ok' and v_res ->> 'status' is distinct from 'round_terminal' then "
        + "raise exception 'r1_meet_public_cancel_booking: the round could not be cancelled' using errcode = 'P0001';",
      'if p_withdraw_consent and v_booking.round_id is not null then',
      "v_res := screening_v2.r1_withdraw_consent(v_booking.round_id, jsonb_build_object('source', 'r1_public_booking'), "
        + "p_now, 'withdrawn');",
      "if v_res ->> 'status' is distinct from 'ok' then raise exception",
      "if v_booking.recall_bot_id is not null then insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) "
        + "values ('r1-meet', jsonb_build_object('kind', 'bot_release', 'recall_bot_id', v_booking.recall_bot_id, "
        + "'booking_id', v_booking.id), 'r1-meet:bot-release:' || v_booking.recall_bot_id::text, 10) on conflict do nothing; "
        + 'end if;',
      "return jsonb_build_object('status', 'cancelled', 'booking_id', v_booking.id);",
    ]);
    expect(ticket).toContain('ticket_expires_at = case when ticket_claimed_at is null then null else ticket_expires_at end,');
    expect(body.match(/\bupdate screening_v2\./g)).toHaveLength(1);
    expect(body.match(/insert into screening_v2\.job_queue\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/round_cancelled|round-cancelled|pg_advisory|\binterview_round_consents\b/);
    // The calls are to the unchanged browser primitives, with their argument order.
    expect(lastDefiner('r1_transition_round')).toBe('0128_r1_twenty_minute_roleplay.sql');
    expect(code0128).toContain(
      'create or replace function screening_v2.r1_transition_round(p_round_id uuid,p_action text,p_expected_version integer,'
      + 'p_link_token_digest text default null,p_expires_at timestamptz default null,p_now timestamptz default now())',
    );
    expect(lastDefiner('r1_withdraw_consent')).toBe('0120_r1_candidate_route_primitives.sql');
    expect(migration('0120_r1_candidate_route_primitives.sql')).toContain(
      "create or replace function screening_v2.r1_withdraw_consent( p_round_id uuid, p_proof jsonb default '{}'::jsonb, "
      + "p_now timestamptz default now(), p_decision text default 'withdrawn' )",
    );
    expect(lc.match(/\br1_withdraw_consent\(/g)).toHaveLength(1);
    // 0142's round_cancelled trigger only queues for a LIVE booking: the booking cancelled first adds nothing.
    expect(body0142('enqueue_r1_meet_round_cancelled')).toContain(
      "where b.round_id = new.id and b.status not in ('completed', 'cancelled', 'failed', 'drained') on conflict do nothing;",
    );
  });

  it('cancel: the bot_release row is 0142\'s delete-trigger job and what jobs.ts writes and parses', () => {
    expect(body0142('enqueue_r1_meet_bot_release')).toContain(
      "values ('r1-meet', jsonb_build_object('kind', 'bot_release', 'recall_bot_id', old.recall_bot_id, 'booking_id', old.id), "
      + "'r1-meet:bot-release:' || old.recall_bot_id::text, 10) on conflict do nothing;",
    );
    const bot = '7f000000-0000-4000-8000-003000000621';
    const id = '7f000000-0000-4000-8000-004000000621';
    const spec = r1MeetJobs.botRelease(bot, id);
    expect(spec.payload).toEqual({ kind: 'bot_release', recall_bot_id: bot, booking_id: id });
    expect(spec.dedupKey).toBe(`r1-meet:bot-release:${bot}`);
    expect(spec.maxAttempts).toBe(10);
    expect(R1_MEET_JOB_MAX_ATTEMPTS.bot_release).toBe(10);
    expect(parseBotReleaseJob({ kind: 'bot_release', recall_bot_id: bot, booking_id: id }))
      .toEqual({ kind: 'bot_release', recallBotId: bot, bookingId: id });
  });

  it('reconsent: the create\'s consent shape and checks on the round\'s live notice, supersede before the insert', () => {
    const body = reconsent();
    const shape = through(create(), "v_consent_ok := p_consent is not null and jsonb_typeof(p_consent) = 'object';",
      "return jsonb_build_object('status', 'invalid_request', 'field', 'consent'); end if;");
    expect(body).toContain(shape);
    const insert = through(create(), 'insert into screening_v2.interview_round_consents', 'p_now);');
    const supersede = through(code0142, 'update screening_v2.interview_round_consents set withdrawn_at = p_now,',
      'where round_id = v_round.id and withdrawn_at is null;');
    const live = "if not found or v_round.channel <> 'meet' or v_round.status not in ('invited', 'in_progress') "
      + 'or v_round.expires_at <= p_now then';
    expect(body0142('r1_meet_reschedule_booking')).toContain(`${live} return jsonb_build_object('status', 'round_not_live'`);
    inOrder(body, [
      shape,
      "select * into v_booking from screening_v2.r1_meet_bookings b "
        + "where b.manage_token_digest = p_digest and b.source = 'public_page' for update;",
      `or v_booking.status not in ${sqlList(LIVE)} or p_now >= v_booking.end_at then ${REFUSED('not_found')}`,
      `if v_booking.status in ${sqlList(R1_MEET_DISPATCHED_STATUSES)} then ${REFUSED('booking_dispatched')}`,
      'select * into v_round from screening_v2.interview_rounds r where r.id = v_booking.round_id for update;',
      `${live} ${REFUSED('not_found')}`,
      'and t.locale = v_round.consent_locale;',
      `if not found or jsonb_array_length(v_template.required_consents) = 0 then ${REFUSED('consent_stale')}`,
      CONSENT_CHECK,
      supersede,
      'v_round_id := v_round.id;',
      insert,
      "return jsonb_build_object('status', 'ok');",
    ]);
    expect(body.split(CONSENT_CHECK)).toHaveLength(2);
    expect(body.match(/insert into screening_v2\.interview_round_consents\b/g)).toHaveLength(1);
    expect(body.match(/\bupdate screening_v2\./g)).toHaveLength(1);
    expect(body.match(/\bfor update\b/g)).toHaveLength(2);
    expect(body).not.toMatch(/job_queue|pg_advisory|update screening_v2\.(r1_meet_bookings|interview_rounds)\b/);
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

  it('covers the T2 sections in order, after T1', () => {
    let last = suite.indexOf('-- T1-H. ');
    for (const section of ['-- T2-A. ', '-- T2-B. ', '-- T2-C. ', '-- T2-D. ', '-- T2-E. ', '-- T2-F. ', '-- T2-G. ', '-- T2-H. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
      expect(suite.indexOf(section), section).toBeGreaterThan(last);
      last = suite.indexOf(section);
    }
    for (const label of [
      'T2-A slot count 05:00-05:45: one public and one Ashby live booking; the touching ones are out',
      'T2-A day count IST 2026-12-09: total 7 (5 live + attempt_settled + no_show), public 5',
      'T2-A capacity day_counts: one entry per IST date, ascending',
      'T2-A a 15-day window answers 16 ascending IST dates',
      'T2-A target r1, max 3: least(3, greatest(browser pool, 1)), 1 with no pool',
      'T2-A a 65-minute cap with a hold outstanding: admits false',
      'T2-A no settings row: enabled false, paused false, admits false, effective concurrency 1',
      'T2-B a link bound to another candidate: application_unknown',
      'T2-B a terminal link and a DSAR hold: application_terminal first',
      'T2-B a live browser round: already_booked',
      'T2-B an in-progress lapsed Meet round: already_booked',
      'T2-B ... HR cancels that booking (round, consent untouched), and the candidate is eligible',
      'T2-B an expirable lapsed Meet round (unstarted, unused): eligible',
      'T2-B the round HR grant-retake leaves (invited, 1 of 2 attempts, 1 start): eligible',
      'T2-B a completed R1 and an expirable lapsed round: r1_completed',
      'T2-B a completed R1 while paused: r1_completed first',
      'T2-B a pending phone assessment: phone_assessment_pending',
      'T2-B the newest release has no en-IN notice: consent_template_unavailable',
      'T2-B the same cap with a reusable Meet round: eligible',
      'T2-B the precheck writes nothing',
      'T2-C setting the digest leaves updated_at and the status alone',
      'T2-C a digest another booking holds',
      'T2-D at start - cutoff: neither can_move nor can_cancel',
      'T2-D a newer active release: consent_current false',
      'T2-D a live Ashby booking holding the digest (CHECK lifted, rolled back): not_found',
      'T2-E invited -> invited (a re-send) keeps the first invite time',
      'T2-E the calendar moves left updated_at, the status and the jobs alone',
      'T2-F exact over indexes, ascending: [0, 2]',
      'T2-F duplicate keys: refused (field keys)',
      'T2-G a limit of 2 deletes the two oldest buckets only',
      'T2-H execute r1_meet_public_refusal',
    ]) {
      expect(suite, label).toContain(label);
    }
  });

  it('covers the T3 sections in order, after T2, through the create helper', () => {
    let last = suite.indexOf('-- T2-H. ');
    for (const section of ['-- T3-A. ', '-- T3-B. ', '-- T3-C. ', '-- T3-D. ', '-- T3-E. ', '-- T3-F. ', '-- T3-G. ', '-- T3-H. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
      expect(suite.indexOf(section), section).toBeGreaterThan(last);
      last = suite.indexOf(section);
    }
    // The helper calls the RPC with every one of its 15 arguments.
    const helper = blockOf(suite, 'create function _r1_meet_public_tests.create(', '$$;');
    expect(helper).toContain('return screening_v2.r1_meet_create_round_from_public(');
    expect(helper).toContain("nullif(a -> 'consent', 'null'::jsonb)");
    expect(helper).toContain("(a ->> 'now')::timestamptz);");
    for (const label of [
      'T3-A a first eligible submit answers booked/created with exactly the contract fields',
      "T3-A the consent is the candidate''s own: candidate_web, no attestation, our notice and its required set, the nine proof fields exactly",
      'T3-A the booking queues exactly the ensure_bot, calendar invite and Ashby tag add jobs',
      'T3-A admission passes the consent gate of a public Meet round',
      'T3-A admission refuses the round once its consent is withdrawn: consent_missing',
      'T3-B the same submit again answers replayed with the booking and its slot, exactly',
      'T3-B the same request id for another candidate: invalid_request request_id',
      'T3-B a booking id already taken, with a new request id: invalid_request booking_id',
      'T3-C two seats and two live bookings in the slot',
      'T3-C one seat and a slot that starts when the Ashby one ends',
      'T3-C the total (with the completed Ashby booking) at the bot day limit',
      'T3-C a slot at 00:00 IST on 2026-12-12 (18:30 UTC on 2026-12-11) is counted on IST 2026-12-12',
      'T3-D a second submit of a booked candidate (new booking and request ids)',
      'T3-D the newest release has no en-IN notice: consent_template_unavailable',
      'T3-D precheck and create agree for candidate ',
      'T3-E a consent with a field the shape does not name',
      'T3-E a 257-character user_agent',
      'T3-E an expiry one second past now + 14 days',
      'T3-E no India tick',
      'T3-E extra granted consents',
      'T3-F after an Ashby cancel the public submit re-links the same round',
      'T3-F ... the HR-attested consent is superseded, never erased',
      'T3-F after a failed public booking a new submit re-links the same round',
      "T3-F after HR''s grant-retake the public submit re-links the round",
      'T3-F a re-link under a newer release the form did not show: consent_stale',
      'T3-F a staff round whose staff notice requires more than the form granted: consent_incomplete',
      'T3-F a reusable staff round with no staff notice',
      'T3-G a lapsed, unused Meet round is expired and a new round created',
      'T3-G a lapsed Meet round that still has a live booking',
      'T3-H a 65-minute cap with a hold outstanding',
      'T3-H the same cap with a reusable Meet round (a re-link takes no new hold)',
      'T3-H the create is executable by service_role only',
      'T3-H execute r1_meet_create_round_from_public',
    ]) {
      expect(suite, label).toContain(label);
    }
    // Every refusal of the expect() helper is checked to write nothing.
    const expectHelper = blockOf(suite, 'create function _r1_meet_public_tests.expect(', '$$;');
    expect(expectHelper).toContain("if p_outcome not like 'booked:%' then");
    expect(expectHelper).toContain('_r1_meet_public_tests.counts() = v_before');
    // The create is pinned as one overload by the catalog check.
    expect(suite).toContain("x.proname = 'r1_meet_create_round_from_public'");
  });

  it('keeps the 0142 suite inserting valid Ashby rows (its full-row insert names the 0143 NOT NULL columns)', () => {
    const suite0142 = read('app/supabase/tests/r1_meet_bookings_assert.sql');
    const row = blockOf(suite0142, 'create function _r1_meet_tests.booking_row(', '$$;');
    expect(row).toContain("'source', 'ashby',");
    expect(row).toContain("'move_count', 0,");
  });

  it('leaves exactly the 0143 public function names out of the 0142 suite name guard, and pins them itself', () => {
    const suite0142 = read('app/supabase/tests/r1_meet_bookings_assert.sql');
    const guard = through(suite0142, "x.proname like 'r1\\_meet\\_%'", ' = (select array_agg(');
    expect(guard).toContain(
      "x.proname like 'r1\\_meet\\_%'\n        and x.proname not like 'r1\\_meet\\_public\\_%' "
      + "and x.proname <> 'r1_meet_create_round_from_public')",
    );
    expect(suite0142.split("x.proname not like 'r1\\_meet\\_public\\_%'")).toHaveLength(2);
    // The mirror guard here lists every r1_meet_public_* function of the file so far.
    const mirror = through(suite, "x.proname like 'r1\\_meet\\_public\\_%')", ']) f));');
    const listed = [...mirror.matchAll(/'screening_v2\.(r1_meet_public_[a-z_]+)\(([^)]*)\)'/g)].map((m) => `${m[1]}(${m[2]})`);
    const declared = [...lc.matchAll(/create or replace function screening_v2\.(r1_meet_public_[a-z_]+)\(/g)].map((m) => m[1]!);
    expect(listed.map((s) => s.split('(')[0])).toEqual(declared);
    for (const fn of [...T2_FUNCTIONS, ...T4_FUNCTIONS]) expect(listed, fn.name).toContain(`${fn.name}(${fn.types})`);
    expect(listed).toHaveLength(13);
  });

  it('covers the T4 sections in order, after T3, through the move, cancel and re-consent helpers', () => {
    let last = suite.indexOf('-- T3-H. ');
    for (const section of ['-- T4-A. ', '-- T4-B. ', '-- T4-C. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
      expect(suite.indexOf(section), section).toBeGreaterThan(last);
      last = suite.indexOf(section);
    }
    expect(suite.indexOf('-- T4-C. ')).toBeLessThan(suite.lastIndexOf('rollback;'));
    // The helpers call each RPC with every argument, and every refusal is checked to write nothing.
    expect(blockOf(suite, 'create function _r1_meet_public_tests.move(', '$$;'))
      .toContain('return screening_v2.r1_meet_public_move_booking(');
    expect(blockOf(suite, 'create function _r1_meet_public_tests.cancel(', '$$;'))
      .toContain('return screening_v2.r1_meet_public_cancel_booking(');
    expect(blockOf(suite, 'create function _r1_meet_public_tests.reconsent(', '$$;'))
      .toContain("nullif(a -> 'consent', 'null'::jsonb)");
    const expectRpc = blockOf(suite, 'create function _r1_meet_public_tests.expect_rpc(', '$$;');
    expect(expectRpc).toContain("if p_outcome not in ('moved:', 'cancelled:', 'ok:') then");
    expect(expectRpc).toContain('_r1_meet_public_tests.counts() = v_before');
    for (const label of [
      'T4-A a move to another IST day',
      'T4-A ... the jobs: the create\'\'s three and calendar move:1 (the pending ensure_bot absorbed the move\'\'s)',
      'T4-A ... queues calendar move:2 and, the first ensure_bot done, one new live ensure_bot',
      'T4-A one seat and a slot overlapping only the booking\'\'s own',
      'T4-A the day\'\'s own counts (the booking included) as the limits, one seat',
      'T4-A every field wrong from ',
      'T4-A at the slot end (the cutoff has passed too)',
      'T4-A one second before start - cutoff with no moves left',
      'T4-A no moves left and the same slot',
      'T4-A a dispatched booking and the same slot',
      'T4-A a dispatched booking and a slot in the past',
      'T4-A one seat in a past slot a live booking holds',
      'T4-A an expiry one second past now + 14 days, one seat, a live booking there',
      'T4-A an expiry exactly at now + 14 days, one seat, the day\'\'s public limit 1',
      'T4-A the bot limit 1 on a day with one live Ashby booking, a stale version too',
      'T4-A a stale version and a bot attached',
      'T4-A one seat in a slot a live booking holds, a bot attached',
      'T4-A after set_bot replace, the new version: the S06 bot path moves',
      'T4-A at bot generation 50 (the reschedule\'\'s version_exhausted)',
      'T4-A the round cancelled by HR',
      'T4-A execute r1_meet_public_move_booking',
      'T4-B a pending booking, the consent kept',
      'T4-B ... the round is cancelled through r1_transition_round and its 65-minute hold refunded',
      'T4-B ... and no round_cancelled job (0142\'\'s trigger found no live booking on the round)',
      'T4-B the same cancel again',
      'T4-B after the cancel the candidate books the freed slot again: a new round',
      'T4-B ... the unclaimed ticket is cleared; the bot id stays until its release is confirmed',
      'T4-B ... which queues exactly the existing 0127 recording erase job',
      'T4-B ... the jobs: the create\'\'s three, the calendar cancel, the tag removal and the bot release (0142 key)',
      'T4-B ... the claimed ticket stays as evidence',
      'T4-B a live Ashby booking holding the digest (CHECK lifted, rolled back): not_found, untouched',
      'T4-B a dispatched booking at start - cutoff',
      'T4-B a booking whose round already expired, withdrawing the consent',
      'T4-B the round version moves during the cancel: one retry cancels it',
      'T4-B a round whose hold month row is missing: the cancel raises',
      'T4-B a live public booking with no round, withdrawing the consent',
      'T4-B execute r1_meet_public_cancel_booking',
      'T4-C a re-consent on the current notice',
      'T4-C ... and inserts the candidate_web consent of the form, the nine proof fields exactly',
      'T4-C under a newer release, the older notice',
      'T4-C ... supersedes the old consent (no recording erase) and stores the newer notice\'\'s candidate_web consent',
      'T4-C after the candidate withdrew',
      'T4-C the newest release has no notice for the round\'\'s audience',
      'T4-C a staff round whose staff notice requires more than the form granted: consent_incomplete',
      'T4-C ... and stores the staff notice\'\'s required set and locale',
      'T4-C a stale notice and no India tick: consent_stale first',
      'T4-C a dispatched booking and a stale notice',
      'T4-C a booking whose round HR cancelled',
      'T4-C a consent of the wrong shape (',
      'T4-C execute r1_meet_public_reconsent',
    ]) {
      expect(suite, label).toContain(label);
    }
    // The retry is proved with a test-only trigger that is dropped again.
    expect(suite).toContain('create trigger t4_bump_round before update of status on screening_v2.r1_meet_bookings');
    expect(suite).toContain('drop trigger t4_bump_round on screening_v2.r1_meet_bookings;');
  });
});

/** The arguments of the first `<callee>(...)` call in `text`, split on top-level commas only. */
function callArgs(text: string, callee: string): string[] {
  const start = text.indexOf(`${callee}(`);
  expect(start, callee).toBeGreaterThan(-1);
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = start + callee.length + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') {
      if (depth === 0) {
        out.push(current.trim());
        return out;
      }
      depth -= 1;
    }
    if (!quoted && depth === 0 && ch === ',') {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  throw new Error(`unterminated call ${callee}`);
}

describe('migration 0143: T5 two-session race harness (CI)', () => {
  const script = read('scripts/test-r1-meet-public-concurrency.sh');
  const base = read('scripts/test-r1-concurrency.sh');
  const setup = read('app/supabase/tests/r1_meet_public_concurrency_setup.sql');
  const ci = read('.github/workflows/supabase-ci.yml');

  /** The `race <tag> <key> <winner> <expected>` head of each race call, in script order. */
  const races = [...script.matchAll(/^race (c[1-5]-[a-z-]+) ("[^"\n]+"|'[^'\n]+') '([^'\n]+)' \\\n {2}'([^'\n]+)' \\$/gm)]
    .map((m) => ({ tag: m[1]!, key: m[2]!.slice(1, -1), win: m[3]!, expected: m[4]! }));

  it('is its own throwaway Postgres: own container and log prefix, strict bash, the 0131 harness parts copied', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).toContain('readonly CTR="r1-meet-public-race-pg-$$"');
    expect(script).toContain("log() { printf '[r1-meet-public-race] %s %s\\n'");
    expect(script).not.toContain('r1-concurrency-test-pg-');
    expect(script).not.toContain('[r1-concurrency]');
    // Readiness (3 consecutive TCP select 1), the Supabase role stubs and the apply-every-migration
    // loop are the 0131 harness's, byte for byte.
    for (const [start, end] of [
      ['ready=0\nfor _ in $(seq 1 90); do', "log 'postgres is ready (3 consecutive TCP select 1)'"],
      ["psql_q <<'SQL' >/dev/null\n", '\nSQL\n'],
      ["log 'applying every migration in order...'", '\ndone\n'],
      ['BLOCKER_PID=\'\'\nblocker_open() {', '\n}\nblocker_commit() {'],
      ['blocker_commit() {', '\n}\n'],
    ] as const) {
      expect(through(script, start, end), start).toBe(through(base, start, end));
    }
    expect(script).not.toMatch(/docker exec [^\n]*pg_isready/);
  });

  it('applies every migration, then 0143 a second time (idempotency), then seeds its own fixtures', () => {
    const every = script.indexOf('for f in "$MIG"/*.sql; do');
    const again = script.indexOf("log 'applying 0143 a second time (idempotency)...'");
    const seed = script.indexOf('psql_q < "$TESTS/r1_meet_public_concurrency_setup.sql"');
    expect(every).toBeGreaterThan(-1);
    expect(again).toBeGreaterThan(every);
    expect(seed).toBeGreaterThan(again);
    expect(script).toContain('target=("$MIG"/0143_*.sql)');
    expect(script).toContain('[ "${#target[@]}" -eq 1 ] || fail "expected exactly one 0143_*.sql');
    expect(script.slice(again, seed)).toContain('-f "/tmp/$(basename "${target[0]}")"');
    expect(script.slice(again, seed)).toContain("fail '0143 is not idempotent'");
    expect(script.split('ON_ERROR_STOP=1').length - 1).toBeGreaterThanOrEqual(6);
  });

  it('holds the RPC\'s own advisory key in a blocker and waits until every racer waits on it (pg_locks, at most 30 s)', () => {
    expect(script).toContain("readonly RACER_OPTS='-c statement_timeout=60000'");
    expect(script).toContain('-e "PGOPTIONS=$RACER_OPTS"');
    expect(script).toContain(`"select pg_advisory_xact_lock(hashtextextended('$key', 0));"`);
    const wait = through(script, 'await_advisory_waiters() {', '\n}\n');
    expect(wait).toContain('for _ in $(seq 1 300); do');
    expect(wait).toContain('sleep .1');
    expect(wait).toContain("from pg_locks w join pg_stat_activity a on a.pid = w.pid");
    expect(wait).toContain("where w.locktype = 'advisory' and not w.granted");
    expect(wait).toContain('and h.objid = w.objid and h.objsubid = w.objsubid');
    expect(wait).toContain('[ "$got" = "${want}:${want}" ] && return 0');
    const race = through(script, 'race() {', '\n}\n');
    expect(race.indexOf('await_advisory_waiters "r1mp-race-$tag-" "$n" "r1mp-block-$tag"'))
      .toBeLessThan(race.indexOf('blocker_commit'));
    expect(race).toContain('psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c "select \'racer:\' || ${exprs[$i]};"');
    // The answers must be exactly the expected ones; any error, deadlock or unique violation fails.
    expect(race).toContain('[ "$got" != "$expect" ]');
    expect(race).toContain("deadlock detected|duplicate key value|violates|error");
    expect(race).toContain('LC_ALL=C sort');
    // The key each scenario holds is one the RPCs take (0143 create and move).
    const prefixes = [...lc.matchAll(/pg_advisory_xact_lock\(hashtextextended\('([a-z0-9_]+:[a-z]+:)' \|\|/g)].map((m) => m[1]!);
    expect([...new Set(prefixes)].sort()).toEqual(['r1_meet_public:candidate:', 'r1_meet_public:day:']);
    expect(races.map((r) => r.tag)).toEqual(['c1-two-tabs', 'c2-same-request', 'c3-one-seat', 'c4-public-day-limit', 'c5-move-one-seat']);
    for (const r of races) expect(prefixes.some((p) => r.key.startsWith(p)), r.tag).toBe(true);
    expect(script).toContain('cand() { psql_v "select _r1mp.id(10, $1)"; }');
  });

  it('names C1-C5 with their exact answers and verifies each from the database', () => {
    expect(races).toEqual([
      { tag: 'c1-two-tabs', key: 'r1_meet_public:candidate:$(cand 1)', win: 'booked:created',
        expected: 'racer:booked:created racer:refused:already_booked' },
      { tag: 'c2-same-request', key: 'r1_meet_public:candidate:$(cand 2)', win: 'booked:created',
        expected: 'racer:booked:created racer:replayed:' },
      { tag: 'c3-one-seat', key: 'r1_meet_public:day:2026-12-04', win: 'booked:created',
        expected: 'racer:booked:created racer:refused:slot_full' },
      { tag: 'c4-public-day-limit', key: 'r1_meet_public:day:2026-12-05', win: 'booked:created',
        expected: 'racer:booked:created racer:refused:day_full' },
      { tag: 'c5-move-one-seat', key: 'r1_meet_public:day:2026-12-08', win: 'moved:',
        expected: 'racer:moved: racer:refused:slot_full' },
    ]);
    // Each scenario is explained where it runs; each race has exactly two racers, each its own session.
    for (const tag of ['C1', 'C2', 'C3', 'C4', 'C5']) {
      expect(script.split(`\n# ${tag} — `).length - 1, tag).toBe(1);
    }
    expect(script.match(/^ {2}"_r1mp\.(create|move)\(/gm)).toHaveLength(10);
    for (const call of [
      "_r1mp.create(1, 11, 11, '2026-12-02 05:00:00+00', '2026-12-02 05:45:00+00', 2, 20)",
      "_r1mp.create(1, 12, 12, '2026-12-02 05:00:00+00', '2026-12-02 05:45:00+00', 2, 20)",
      "_r1mp.create(2, 21, 20, '2026-12-03 05:00:00+00', '2026-12-03 05:45:00+00', 2, 20)",
      "_r1mp.create(2, 22, 20, '2026-12-03 05:00:00+00', '2026-12-03 05:45:00+00', 2, 20)",
      "_r1mp.create(3, 31, 31, '2026-12-04 05:00:00+00', '2026-12-04 05:45:00+00', 1, 20)",
      "_r1mp.create(4, 32, 32, '2026-12-04 05:00:00+00', '2026-12-04 05:45:00+00', 1, 20)",
      "_r1mp.create(5, 41, 41, '2026-12-05 05:00:00+00', '2026-12-05 05:45:00+00', 2, 1)",
      "_r1mp.create(6, 42, 42, '2026-12-05 07:00:00+00', '2026-12-05 07:45:00+00', 2, 1)",
      "_r1mp.move(51, '2026-12-08 05:00:00+00', '2026-12-08 05:45:00+00', 1)",
      "_r1mp.move(52, '2026-12-08 05:00:00+00', '2026-12-08 05:45:00+00', 1)",
    ]) {
      expect(script.split(`"${call}"`).length - 1, call).toBe(1);
    }
    for (const verify of [
      "_r1mp.verify_create('c1-two-tabs', array[1], array[11, 12], array[11, 12], ${c1[$WINNER]})",
      "_r1mp.verify_create('c2-same-request', array[2], array[21, 22], array[20, 20], ${c2[$WINNER]})",
      "_r1mp.verify_create('c3-one-seat', array[3, 4], array[31, 32], array[31, 32], ${c3[$WINNER]})",
      "_r1mp.verify_create('c4-public-day-limit', array[5, 6], array[41, 42], array[41, 42], ${c4[$WINNER]})",
      "_r1mp.verify_move('c5-move-one-seat', ${c5[$WINNER]}, ${c5[$((1 - WINNER))]}, '2026-12-08 05:00:00+00', '2026-12-08 05:45:00+00')",
    ]) {
      expect(script, verify).toContain(`psql_q -c "select ${verify};" >/dev/null`);
    }
    // Each verify follows its own race.
    for (const r of races) {
      expect(script.indexOf(`'${r.tag}'`), r.tag).toBeGreaterThan(script.indexOf(`race ${r.tag} `));
    }
    // C5's two bookings sit on a LATER IST day than the target, so both moves wait on the target's lock.
    expect(setup).toContain("(51, 7, '2026-12-09 05:00:00+00', '2026-12-09 05:45:00+00')");
    expect(setup).toContain("(52, 8, '2026-12-09 07:00:00+00', '2026-12-09 07:45:00+00')");
  });

  it('calls the two RPCs with every argument at a pinned clock, and checks the contract jobs exactly', () => {
    const create = blockOf(setup, 'create or replace function _r1mp.create(', '$$;');
    expect(callArgs(create, 'screening_v2.r1_meet_create_round_from_public')).toHaveLength(15);
    const move = blockOf(setup, 'create or replace function _r1mp.move(', '$$;');
    expect(callArgs(move, 'screening_v2.r1_meet_public_move_booking')).toHaveLength(12);
    expect(setup).toContain("select '2026-12-01 04:00:00+00'::timestamptz");
    expect(norm(setup)).not.toMatch(/\bnow\s*\(|\bcurrent_timestamp\b|\bclock_timestamp\s*\(|\bstatement_timestamp\s*\(/i);
    // The job keys are the migration's (contracts section 5).
    for (const key of ["'r1-meet:ensure-bot:' ||", "':invite'", "':add'", "'r1-meet:calendar:' ||", "'r1-meet:ashby-tag:' ||"]) {
      expect(sql, key).toContain(key);
      expect(setup, key).toContain(key);
    }
    expect(sql).toContain("|| ':move:' || v_booking.move_count::text");
    expect(setup).toContain("'r1-meet:calendar:' || w.id::text || ':move:1'");
    // Winner: one booking, round and live consent; loser: nothing; the month: 65 per round, once.
    expect(setup).toContain("format('candidate %s: bookings=1 rounds=1 consents=1 live_consents=1', v_n)");
    expect(setup).toContain("format('candidate %s: bookings=0 rounds=0 consents=0 live_consents=0', v_n)");
    expect(setup).toContain('or v_held <> 65 * v_rounds or v_reserved is distinct from v_held then');
    expect(setup).toContain('if _r1mp.jobs_of(b.id) is distinct from _r1mp.create_jobs(b.id) then');
    // verify_create proves itself not vacuous before any race.
    expect(setup).toContain("perform _r1mp.verify_create('self-test', array[7, 8], array[51, 52], array[51, 52], 51);");
    expect(setup).toContain("perform _r1mp.verify_create('self-test', array[7], array[51, 59], array[51, 59], 59);");
  });

  it('keeps the fixtures synthetic: 7f000000 ids, runtime digests, example.test, no key-shaped literal', () => {
    const ids = [...setup.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/gi)].map((m) => m[0]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('7f000000-'), id).toBe(true);
    expect(setup).toContain('encode(sha256(convert_to(');
    expect(setup).not.toMatch(/[a-f0-9]{40,}/i);
    expect(setup).not.toMatch(/whsec_/i);
    for (const m of setup.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(m[0]).toMatch(/@example\.test$/);
    expect(script).not.toMatch(/[a-f0-9]{40,}/i);
  });

  it('is its own supabase-ci job right after r1-concurrency-test, triggered on its script', () => {
    const jobs = [...ci.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]!);
    expect(jobs[jobs.indexOf('r1-concurrency-test') + 1]).toBe('r1-meet-public-race-test');
    const body = through(ci, '  r1-meet-public-race-test:\n', '\n\n');
    expect(body).toContain('    runs-on: ubuntu-latest\n');
    expect(body).toContain('    timeout-minutes: 15\n');
    expect(body).toContain('      - uses: actions/checkout@v4\n');
    expect(body).toContain('        run: bash scripts/test-r1-meet-public-concurrency.sh');
    expect(body).toMatch(/ {6}# 0143 \(M035 S01\)/);
    expect(ci.match(/^ {6}- 'scripts\/test-r1-meet-public\.sh'\n {6}- 'scripts\/test-r1-meet-public-concurrency\.sh'$/gm))
      .toHaveLength(2);
    expect(ci.split('scripts/test-r1-meet-public-concurrency.sh').length - 1).toBe(3);
  });
});
