/**
 * Static guarantees for migration 0142 (M034 S02: R1 over Google Meet bookings, webhook receipts,
 * the round channel and HR-attested consent). The behavioural SQL assertions run in supabase-ci
 * (app/supabase/tests/r1_meet_bookings_assert.sql, wired by scripts/test-r1-meet.sh); these
 * text-level checks keep the file additive, dark and in step with the S01 TypeScript contracts
 * (objective profiles, consent modes, Dex event decisions, the Ashby schedule dedupe key and the
 * canonical Meet URL).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGoogleMeetUrl } from '../integrations/google-meet/url.js';
import {
  R1_MEET_CONSENT_MODES,
  R1_MEET_DEFAULT_PROFILE_ID,
  R1_MEET_PROFILE_IDS,
} from '../lib/r1/meet/profiles.js';
import {
  R1_MEET_DEX_EVENT_DECISIONS,
  parseR1MeetAshbySchedule,
  r1MeetAshbyScheduleDedupKey,
  type R1MeetAshbySchedule,
} from '../lib/r1/meet/ashby-schedule.js';
import {
  FIXTURE_DEX_USER_ID,
  FIXTURE_MEET_URL,
  FIXTURE_MEETING_LINK,
  makeAshbyInterviewEvent,
  makeAshbyInterviewSchedule,
} from './support/ashby-schedule-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const root = path.resolve(here, '../../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const FILE = '0142_r1_meet_bookings.sql';
const sql = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
/** Whole-line comments removed, whitespace collapsed: a layout-independent view of the executable SQL. */
const code = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
const lc = code.toLowerCase();
/** The TOP-LEVEL statements only: every dollar-quoted body (functions, DO blocks) replaced by a stub. */
const top = lc.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, () => '$body$');
/** The top level with string literals emptied: comment texts and IN-lists cannot hide or fake DDL. */
const topBare = top.replace(/'(?:[^']|'')*'/g, "''");

const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

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

/** The IN-list of the named CHECK constraint (`constraint <name> check (<col> in (...))`). */
function inList(constraint: string, column: string): string[] {
  const m = new RegExp(`constraint ${constraint} check \\( ?${column} in \\(([^)]*)\\) ?\\)`).exec(code);
  expect(m, constraint).not.toBeNull();
  return quoted(m![1]!);
}

/** The body of a named function (from its `create or replace function` to the closing `$$;`). */
function functionBody(name: string): string {
  return block(`create or replace function screening_v2.${name}(`, '$$;');
}

const bookings = block('create table if not exists screening_v2.r1_meet_bookings (', 'create unique index if not exists uq_r1_meet_bookings_live_round');
const receipts = block('create table if not exists screening_v2.r1_meet_receipts (', 'create index if not exists idx_r1_meet_receipts_received');

const STATUSES = [
  'pending', 'unmatched_application', 'unmapped_scheduler', 'blocked',
  'bot_scheduled', 'bot_joining', 'human_present', 'in_call',
  'completed', 'cancelled', 'failed', 'drained',
] as const;
const ACTIVE = ['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call'];
const TERMINAL = ['completed', 'cancelled', 'failed', 'drained'];

/** Every `(status in (...) and reason in (...))` family of the pairing CHECK. */
function pairingFamilies(): Array<{ statuses: string[]; reasons: string[] }> {
  const pairing = block('constraint chk_r1_meet_bookings_status_reason check (', 'constraint chk_r1_meet_bookings_version');
  return [...pairing.matchAll(/\(status in \(([^)]*)\) and reason in \(([^)]*)\)\)/g)].map((m) => ({
    statuses: quoted(m[1]!),
    reasons: quoted(m[2]!),
  }));
}

/** The receipt dedupe CHECK as JavaScript, exactly as written in the migration. */
function receiptKeyAccepts(key: string): boolean {
  const m = /char_length\(dedupe_key\) between 1 and (\d+) and dedupe_key ~ '([^']+)'/.exec(receipts);
  expect(m).not.toBeNull();
  return key.length >= 1 && key.length <= Number(m![1]) && new RegExp(m![2]!).test(key);
}

function parsed(raw: Record<string, unknown>): R1MeetAshbySchedule {
  const result = parseR1MeetAshbySchedule(raw, { dexUserId: FIXTURE_DEX_USER_ID });
  if (!result.ok) throw new Error(`fixture did not parse: ${result.reason}`);
  return result.schedule;
}

describe('migration 0142: file and frame', () => {
  it('is the only 0142 migration, carries the _r1_ infix and follows 0141', () => {
    expect(readdirSync(migrations).filter((name) => name.startsWith('0142_'))).toEqual([FILE]);
    expect(FILE).toMatch(/^0142_r1_[a-z0-9_]+\.sql$/);
    // Not "the newest": a later migration (S03+) must not turn this test red.
    const numbered = readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(numbered.indexOf(FILE)).toBeGreaterThan(numbered.indexOf('0141_ashby_progress_nudge.sql'));
  });

  it('sets a local lock_timeout first and reloads PostgREST last', () => {
    expect(code.startsWith("set local lock_timeout = '10s';")).toBe(true);
    expect(code.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(code.split("set local lock_timeout = '10s';")).toHaveLength(2);
  });

  it('documents that it is dark, additive and re-runnable', () => {
    expect(sql).toMatch(/^-- DARK\. Nothing calls any object below/m);
    expect(sql).toMatch(/Additive and re-runnable/);
    expect(sql).toMatch(/no existing function is redeclared/);
  });

  it('keeps its sections in order', () => {
    const markers = ['-- §1. ', '-- §2. ', '-- §3. ', '-- §4. ', '-- §5. ', '-- §90. '];
    let last = -1;
    for (const marker of markers) {
      expect(sql.split(marker).length - 1, marker).toBe(1);
      expect(sql.indexOf(marker), marker).toBeGreaterThan(last);
      last = sql.indexOf(marker);
    }
  });
});

describe('migration 0142: additive', () => {
  it('drops nothing but its own triggers, and deletes, updates or truncates no row', () => {
    expect([...topBare.matchAll(/\bdrop\s+(?!trigger if exists\b)\w+/g)].map((m) => m[0])).toEqual([]);
    expect(topBare).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\balter\s+column\b|\bdrop\s+not\s+null\b|\brename\b/);
    expect(topBare).not.toMatch(/\bupdate\s+(?:only\s+)?[a-z0-9_]+(?:\.[a-z0-9_]+)?\s+set\b/);
    expect(topBare).not.toMatch(/\binsert\s+into\b/);
  });

  it('alters only the two R1 tables it extends and the two it creates', () => {
    const altered = [...lc.matchAll(/\balter table (?:only )?([a-z0-9_.]+)/g)].map((m) => m[1]!);
    expect(new Set(altered)).toEqual(new Set([
      'screening_v2.interview_rounds',
      'screening_v2.interview_round_consents',
      'screening_v2.r1_meet_bookings',
      'screening_v2.r1_meet_receipts',
    ]));
  });

  it('creates exactly the two new tables, every table and index guarded by if not exists', () => {
    expect([...top.matchAll(/create table if not exists screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1]))
      .toEqual(['r1_meet_bookings', 'r1_meet_receipts']);
    expect(topBare.match(/\bcreate table\b/g)).toHaveLength(2);
    const indexes = topBare.match(/\bcreate (?:unique )?index\b[^;]*/g) ?? [];
    expect(indexes.length).toBe(11);
    for (const index of indexes) expect(index, index).toMatch(/^create (?:unique )?index if not exists /);
    expect(topBare).not.toMatch(/\bconcurrently\b|create (type|sequence|policy|view|extension|schema)\b/);
  });

  it('adds every column with if not exists and a constant default or none', () => {
    const adds = [...lc.matchAll(/\badd column ([^;]*?)(?=;| constraint )/g)].map((m) => m[1]!);
    expect(adds.map((a) => a.split(' ').slice(0, 5).join(' '))).toEqual([
      'if not exists channel text',
      'if not exists method text',
      'if not exists attested_by_external_id text',
      'if not exists attested_at timestamptz',
      'if not exists india_location_attested boolean',
    ]);
    expect(lc).toContain("add column if not exists channel text not null default 'browser'");
    expect(lc).toContain("add column if not exists method text not null default 'candidate_web'");
  });

  it('adds the multi-column consent CHECK only behind a pg_constraint guard', () => {
    expect(lc.match(/\badd constraint\b/g)).toHaveLength(1);
    const guard = block('do $$ begin if not exists ( select 1 from pg_constraint', 'end if; end; $$;');
    expect(guard).toContain("where conname = 'chk_interview_round_consents_attestation'");
    expect(guard).toContain("and conrelid = 'screening_v2.interview_round_consents'::regclass");
    expect(guard).toContain('add constraint chk_interview_round_consents_attestation check (');
  });

  it('re-creates each of its two triggers after a guarded drop on the same table', () => {
    const creates = [...lc.matchAll(/create trigger ([a-z0-9_]+) (?:before|after) [a-z ]+? on ([a-z0-9_.]+)/g)]
      .map((m) => `${m[1]} on ${m[2]}`);
    expect(creates).toEqual([
      'trg_interview_rounds_channel_locked on screening_v2.interview_rounds',
      'enqueue_r1_meet_bot_release on screening_v2.r1_meet_bookings',
    ]);
    for (const c of creates) expect(lc).toContain(`drop trigger if exists ${c};`);
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
    // The D5 list by name: the browser consent and admission paths stay byte-for-byte unchanged.
    for (const fn of [
      'r1_send_round', 'r1_admit_attempt', 'r1_transition_round', 'r1_withdraw_consent',
      'r1_settle_attempt', 'r1_reserve_preflight', 'enqueue_r1_recording_finalize',
      'enqueue_r1_recording_erase', 'purge_on_r1_recording_delete', 'reject_interview_round_audience_change',
    ]) {
      expect(lc, fn).not.toMatch(new RegExp(`create (or replace )?function screening_v2\\.${fn}\\(`));
    }
  });

  it('writes no call_sessions row, never reissues through r1_transition_round, and queues only r1-meet', () => {
    expect(lc).not.toMatch(/insert into screening_v2\.call_sessions\b/);
    expect(lc).not.toContain('r1_transition_round(');
    const queueInserts = lc.match(/insert into screening_v2\.job_queue\b/g) ?? [];
    const named = [...lc.matchAll(/insert into screening_v2\.job_queue \(name, [^)]*\) values \('([^']*)'/g)].map((m) => m[1]);
    expect(queueInserts.length).toBeGreaterThan(0);
    expect(named).toHaveLength(queueInserts.length);
    expect(new Set(named)).toEqual(new Set(['r1-meet']));
  });

  it('reads no machine clock inside a function body', () => {
    const bodies = [...lc.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]!);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/\bnow\s*\(|\bcurrent_timestamp\b|\bclock_timestamp\s*\(|\bstatement_timestamp\s*\(/);
      expect(body).not.toMatch(/\bwhen others\b/);
    }
  });
});

describe('migration 0142: interview_rounds.channel and the HR-attested consent columns', () => {
  it('adds the channel with the browser default and the two-value CHECK', () => {
    expect(code).toContain(
      "alter table screening_v2.interview_rounds add column if not exists channel text not null default 'browser' "
      + "constraint chk_interview_rounds_channel check (channel in ('browser', 'meet'));",
    );
  });

  it('locks the channel: only browser -> meet, only while invited, unstarted and without consent', () => {
    const fn = functionBody('reject_interview_round_channel_change');
    expect(fn).toContain('returns trigger language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$');
    expect(fn).toContain('if new.channel is distinct from old.channel');
    expect(fn).toContain("old.channel = 'browser' and new.channel = 'meet' and old.status = 'invited' and old.starts_used = 0");
    expect(fn).toContain('select 1 from screening_v2.interview_round_consents c where c.round_id = old.id');
    expect(fn).toContain("using errcode = 'P0001'");
    expect(code).toContain(
      'create trigger trg_interview_rounds_channel_locked before update of channel on screening_v2.interview_rounds '
      + 'for each row execute function screening_v2.reject_interview_round_channel_change();',
    );
  });

  it('accepts exactly candidate_web and the S01 consent modes as the consent method', () => {
    expect(inList('chk_interview_round_consents_method', 'method')).toEqual(['candidate_web', ...R1_MEET_CONSENT_MODES]);
    expect(code).toContain("add column if not exists method text not null default 'candidate_web'");
  });

  it('pairs the method with the attestation columns', () => {
    const pairing = block('add constraint chk_interview_round_consents_attestation check (', 'end if;');
    expect(pairing).toContain(
      "(method = 'candidate_web' and attested_by_external_id is null and attested_at is null and india_location_attested is null)",
    );
    expect(pairing).toContain(
      "(method = 'hr_attested_ashby' and attested_by_external_id is not null and attested_at is not null and india_location_attested is true)",
    );
    expect(code).toContain(`attested_by_external_id ~* '${UUID_RE}'`);
  });
});

describe('migration 0142: r1_meet_bookings', () => {
  it('has exactly the planned columns, in order, with their types', () => {
    const columns = [...bookings.matchAll(/(?:\( |, )([a-z][a-z0-9_]*) (uuid|text|integer|timestamptz)(?=[ ,])/g)]
      .map((m) => `${m[1]} ${m[2]}`);
    expect(columns).toEqual([
      'id uuid', 'ashby_interview_event_id uuid', 'ashby_schedule_id text', 'ashby_application_id text',
      'ashby_interview_stage_id text', 'ashby_interview_id text', 'ashby_scheduled_by_user_id text',
      'ashby_updated_at timestamptz', 'candidate_id uuid', 'round_id uuid', 'objective_profile text',
      'status text', 'reason text', 'version integer', 'key_attempt integer', 'meet_url text',
      'start_at timestamptz', 'end_at timestamptz', 'recall_bot_id uuid', 'ticket_digest text',
      'ticket_not_before timestamptz', 'ticket_expires_at timestamptz', 'ticket_claimed_at timestamptz',
      'ticket_arms integer', 'session_id uuid', 'created_at timestamptz', 'updated_at timestamptz',
    ]);
    // PII-minimal: no name, email, phone or body column.
    expect(bookings).not.toMatch(/\b(name|email|phone|body|payload|raw|scheduled_by_email)\b [a-z]/);
  });

  it('keys the booking by the Ashby event id (uuid) and follows the DSAR cascade convention', () => {
    expect(bookings).toContain('ashby_interview_event_id uuid not null,');
    expect(bookings).toContain('constraint uq_r1_meet_bookings_event unique (ashby_interview_event_id)');
    expect(bookings).toContain('candidate_id uuid references screening_v2.candidates(id) on delete cascade,');
    expect(bookings).toContain('round_id uuid references screening_v2.interview_rounds(id) on delete cascade,');
    expect(bookings).toContain('session_id uuid references screening_v2.call_sessions(id) on delete set null,');
  });

  it('checks every Ashby id is UUID-shaped, case-insensitively', () => {
    expect(bookings).toContain(`constraint chk_r1_meet_bookings_schedule_id check ( ashby_schedule_id ~* '${UUID_RE}' )`);
    expect(bookings).toContain(`constraint chk_r1_meet_bookings_application_id check ( ashby_application_id ~* '${UUID_RE}' )`);
    expect(bookings).toContain(`ashby_interview_stage_id is null or ashby_interview_stage_id ~* '${UUID_RE}'`);
    expect(bookings).toContain(`ashby_interview_id is null or ashby_interview_id ~* '${UUID_RE}'`);
    expect(bookings).toContain(`constraint chk_r1_meet_bookings_scheduled_by check ( ashby_scheduled_by_user_id ~* '${UUID_RE}' )`);
  });

  it('accepts exactly the S01 objective profiles, defaulting to r1_dex_sales', () => {
    expect(inList('chk_r1_meet_bookings_objective_profile', 'objective_profile')).toEqual([...R1_MEET_PROFILE_IDS]);
    expect(bookings).toContain(`objective_profile text not null default '${R1_MEET_DEFAULT_PROFILE_ID}',`);
  });

  it('has the closed 12-state status list', () => {
    expect(inList('chk_r1_meet_bookings_status', 'status')).toEqual([...STATUSES]);
  });

  it('has 32 distinct reasons that include every S01 Dex event decision', () => {
    const reasons = inList('chk_r1_meet_bookings_reason', 'reason');
    expect(reasons).toHaveLength(32);
    expect(new Set(reasons).size).toBe(32);
    for (const decision of R1_MEET_DEX_EVENT_DECISIONS) expect(reasons, decision).toContain(decision);
  });

  it('ties each reason to exactly one status family, and covers every status once', () => {
    const families = pairingFamilies();
    expect(families).toHaveLength(8);
    const statuses = families.flatMap((f) => f.statuses);
    expect([...statuses].sort()).toEqual([...STATUSES].sort());
    expect(families[0]).toEqual({ statuses: ACTIVE, reasons: ['eligible'] });
    const reasons = families.flatMap((f) => f.reasons);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect([...reasons].sort()).toEqual([...inList('chk_r1_meet_bookings_reason', 'reason')].sort());
    const familyOf = (status: string) => families.find((f) => f.statuses.includes(status))!.reasons;
    expect(familyOf('unmatched_application')).toEqual(['application_unknown', 'application_terminal']);
    expect(familyOf('unmapped_scheduler')).toEqual(['scheduler_unmapped', 'created_by_unknown']);
    expect(familyOf('completed')).toEqual(['attempt_settled']);
    expect(familyOf('drained')).toEqual(['flag_off']);
    // The S01 hand-off: these three may be acted on before the call (unschedule but keep the booking).
    for (const r of ['not_scheduled', 'no_attester', 'no_meet_link']) expect(familyOf('blocked'), r).toContain(r);
    expect(familyOf('cancelled')).toEqual(expect.arrayContaining(['cancelled', 'dex_absent']));
    expect(familyOf('failed')).toContain('in_past');
  });

  it('bounds the bot generation, the key rotation and the ticket arms', () => {
    expect(bookings).toContain('version integer not null default 0,');
    expect(bookings).toContain('key_attempt integer not null default 0,');
    expect(bookings).toContain('ticket_arms integer not null default 0,');
    expect(bookings).toContain('constraint chk_r1_meet_bookings_version check (version between 0 and 50)');
    expect(bookings).toContain('constraint chk_r1_meet_bookings_key_attempt check (key_attempt between 0 and 20)');
    expect(bookings).toContain('constraint chk_r1_meet_bookings_ticket_arms check (ticket_arms between 0 and 5)');
  });

  it('accepts exactly the canonical Meet URL that S01 normalizeGoogleMeetUrl produces', () => {
    const m = /constraint chk_r1_meet_bookings_meet_url check \( meet_url ~ '([^']+)' \)/.exec(bookings);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]!);
    expect(normalizeGoogleMeetUrl(FIXTURE_MEETING_LINK)).toBe(FIXTURE_MEET_URL);
    for (const raw of [FIXTURE_MEETING_LINK, 'https://meet.google.com/ABC-DEFG-HIJ', 'https://meet.google.com/xyz-abcd-efg/']) {
      expect(re.test(normalizeGoogleMeetUrl(raw)!), raw).toBe(true);
    }
    for (const bad of [
      'https://meet.google.com/ABC-DEFG-HIJ', `${FIXTURE_MEET_URL}?authuser=0`, 'http://meet.google.com/abc-defg-hij',
      `${FIXTURE_MEET_URL}/`, 'https://meet.google.com/abcd-efg-hij', 'https://meet.google.comx/abc-defg-hij',
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it('bounds the slot to at most 24 hours and stores the ticket as a hex64 digest only', () => {
    expect(bookings).toContain("constraint chk_r1_meet_bookings_slot check ( end_at > start_at and end_at <= start_at + interval '24 hours' )");
    expect(bookings).toContain("ticket_digest is null or ticket_digest ~ '^[a-f0-9]{64}$'");
    expect(bookings).not.toMatch(/\bticket (text|uuid)\b|\bticket_plain|\braw_ticket/);
  });

  it('binds the round, the bot and the ticket to the status', () => {
    const binding = block('constraint chk_r1_meet_bookings_round_binding check (', 'constraint chk_r1_meet_bookings_bot_binding');
    expect(binding).toContain(`(status not in (${[...ACTIVE, 'completed'].map((s) => `'${s}'`).join(', ')}) or (round_id is not null and candidate_id is not null))`);
    expect(binding).toContain("(status <> 'unmatched_application' or (candidate_id is null and round_id is null))");
    expect(binding).toContain("(status <> 'unmapped_scheduler' or round_id is null)");
    expect(binding).toContain('(round_id is null or candidate_id is not null)');
    const bot = block('constraint chk_r1_meet_bookings_bot_binding check (', 'constraint chk_r1_meet_bookings_ticket check (');
    expect(bot).toContain("(status not in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call') or recall_bot_id is not null)");
    expect(bot).toContain("(status not in ('pending', 'blocked', 'unmatched_application', 'unmapped_scheduler') or recall_bot_id is null)");
    const ticket = block('constraint chk_r1_meet_bookings_ticket check (', 'create unique index');
    expect(ticket).toContain('((ticket_digest is null) = (ticket_not_before is null))');
    expect(ticket).toContain('((ticket_digest is null) = (ticket_expires_at is null))');
    expect(ticket).toContain('(ticket_expires_at is null or ticket_expires_at > ticket_not_before)');
    expect(ticket).toContain('(ticket_claimed_at is null or ticket_digest is not null)');
    expect(ticket).toContain(`status in (${['bot_scheduled', 'bot_joining', 'human_present', 'in_call', ...TERMINAL].map((s) => `'${s}'`).join(', ')})`);
  });

  it('indexes the runtime lookups', () => {
    const terminal = TERMINAL.map((s) => `'${s}'`).join(', ');
    for (const index of [
      `create unique index if not exists uq_r1_meet_bookings_live_round on screening_v2.r1_meet_bookings (round_id) where round_id is not null and status not in (${terminal});`,
      'create index if not exists idx_r1_meet_bookings_status_start on screening_v2.r1_meet_bookings (status, start_at);',
      'create unique index if not exists uq_r1_meet_bookings_recall_bot on screening_v2.r1_meet_bookings (recall_bot_id) where recall_bot_id is not null;',
      'create unique index if not exists uq_r1_meet_bookings_ticket_digest on screening_v2.r1_meet_bookings (ticket_digest) where ticket_digest is not null;',
      'create index if not exists idx_r1_meet_bookings_round on screening_v2.r1_meet_bookings (round_id) where round_id is not null;',
      'create index if not exists idx_r1_meet_bookings_candidate on screening_v2.r1_meet_bookings (candidate_id) where candidate_id is not null;',
      'create index if not exists idx_r1_meet_bookings_schedule on screening_v2.r1_meet_bookings (ashby_schedule_id);',
      'create index if not exists idx_r1_meet_bookings_session on screening_v2.r1_meet_bookings (session_id) where session_id is not null;',
      `create index if not exists idx_r1_meet_bookings_owed_release on screening_v2.r1_meet_bookings (updated_at) where recall_bot_id is not null and status in (${terminal});`,
    ]) {
      expect(code, index).toContain(index);
    }
  });
});

describe('migration 0142: r1_meet_receipts', () => {
  it('has exactly the planned columns and no body or metadata column', () => {
    const columns = [...receipts.matchAll(/(?:\( |, )([a-z][a-z0-9_]*) (uuid|text|timestamptz|jsonb)(?=[ ,])/g)]
      .map((m) => `${m[1]} ${m[2]}`);
    expect(columns).toEqual([
      'id uuid', 'source text', 'dedupe_key text', 'event_type text', 'booking_id uuid',
      'outcome text', 'received_at timestamptz', 'processed_at timestamptz',
    ]);
    expect(receipts).not.toMatch(/\bjsonb\b|\bbody\b|\bmetadata\b|\bpayload\b/);
    expect(receipts).toContain('booking_id uuid references screening_v2.r1_meet_bookings(id) on delete set null,');
  });

  it('de-duplicates on the key and keeps the Svix and Ashby key spaces disjoint', () => {
    expect(receipts).toContain('constraint uq_r1_meet_receipts_dedupe_key unique (dedupe_key)');
    expect(inList('chk_r1_meet_receipts_source', 'source')).toEqual(['recall', 'ashby']);
    expect(receipts).toContain("constraint chk_r1_meet_receipts_dedupe_space check ( (source = 'ashby') = (dedupe_key like 'ashby-schedule:%') )");
    expect(receipts).toContain("char_length(dedupe_key) between 1 and 256 and dedupe_key ~ '^[A-Za-z0-9_.:-]+$'");
    expect(inList('chk_r1_meet_receipts_outcome', 'outcome')).toEqual(['recorded', 'enqueued', 'processed', 'ignored', 'failed']);
    expect(receipts).toContain("constraint chk_r1_meet_receipts_processed check ( (processed_at is null) = (outcome in ('recorded', 'enqueued')) )");
  });

  it('accepts every dedupe key the S01 Ashby helper can build, and a Svix id outside that space', () => {
    const base = parsed(makeAshbyInterviewSchedule());
    const noUpdatedAt = parsed(makeAshbyInterviewSchedule({
      updatedAt: null,
      interviewEvents: [makeAshbyInterviewEvent({ updatedAt: null })],
    }));
    const yearZero = parsed(makeAshbyInterviewSchedule({
      updatedAt: '0000-01-01T00:00:00.000Z',
      interviewEvents: [makeAshbyInterviewEvent({ updatedAt: '0000-01-01T00:00:00.000Z' })],
    }));
    const keys = [
      r1MeetAshbyScheduleDedupKey(base, Date.parse('2026-11-20T09:00:06.000Z')),
      r1MeetAshbyScheduleDedupKey(noUpdatedAt, 8.64e15),
      r1MeetAshbyScheduleDedupKey(noUpdatedAt, Number.NaN),
      r1MeetAshbyScheduleDedupKey(yearZero, 0),
    ];
    expect(keys[1]).toMatch(/:r8640000000000000:/);
    expect(keys[1]).toHaveLength(86);
    expect(keys[3]).toMatch(/:-\d+:/);
    for (const k of keys) {
      expect(k.startsWith('ashby-schedule:'), k).toBe(true);
      expect(k.length, k).toBeLessThanOrEqual(256);
      expect(receiptKeyAccepts(k), k).toBe(true);
    }
    const svix = ['msg', '2FakeSvixMessageIdForTests0'].join('_');
    expect(receiptKeyAccepts(svix)).toBe(true);
    expect(svix.startsWith('ashby-schedule:')).toBe(false);
    expect(receiptKeyAccepts(`msg_${'a'.repeat(253)}`)).toBe(false);
    expect(receiptKeyAccepts('msg_with space')).toBe(false);
    expect(receiptKeyAccepts('')).toBe(false);
  });

  it('bounds the event type and indexes the prune and booking lookups', () => {
    expect(receipts).toContain("constraint chk_r1_meet_receipts_event_type check (event_type ~ '^[A-Za-z0-9_.:-]{1,128}$')");
    expect(code).toContain('create index if not exists idx_r1_meet_receipts_received on screening_v2.r1_meet_receipts (received_at);');
    expect(code).toContain('create index if not exists idx_r1_meet_receipts_booking on screening_v2.r1_meet_receipts (booking_id) where booking_id is not null;');
  });
});

describe('migration 0142: the bot release trigger and privileges', () => {
  it('queues one r1-meet bot_release job per deleted booking that still holds a bot', () => {
    const fn = functionBody('enqueue_r1_meet_bot_release');
    expect(fn).toContain('returns trigger language plpgsql security invoker set search_path = pg_catalog as $$');
    expect(fn).toContain(
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) values ('r1-meet', "
      + "jsonb_build_object('kind', 'bot_release', 'recall_bot_id', old.recall_bot_id, 'booking_id', old.id), "
      + "'r1-meet:bot-release:' || old.recall_bot_id::text, 10) on conflict do nothing; return old;",
    );
    expect(code).toContain(
      'create trigger enqueue_r1_meet_bot_release after delete on screening_v2.r1_meet_bookings for each row '
      + 'when (old.recall_bot_id is not null) execute function screening_v2.enqueue_r1_meet_bot_release();',
    );
  });

  it('enables RLS with no policy and grants the tables to service_role only', () => {
    for (const table of ['r1_meet_bookings', 'r1_meet_receipts']) {
      expect(code).toContain(`alter table screening_v2.${table} enable row level security;`);
    }
    expect(lc).not.toMatch(/create policy|grant [a-z, ]+ to (anon|authenticated|public)\b/);
    expect(code).toContain('revoke all on screening_v2.r1_meet_bookings, screening_v2.r1_meet_receipts from public, anon, authenticated;');
    expect(code).toContain('revoke all on screening_v2.r1_meet_bookings, screening_v2.r1_meet_receipts from service_role;');
    expect(code).toContain('grant select, insert, update, delete on screening_v2.r1_meet_bookings, screening_v2.r1_meet_receipts to service_role;');
    for (const fn of ['reject_interview_round_channel_change', 'enqueue_r1_meet_bot_release']) {
      expect(code).toContain(`revoke all on function screening_v2.${fn}() from public, anon, authenticated;`);
    }
  });
});

describe('migration 0142: SQL test wiring', () => {
  it('runs the assertions from supabase-test.sh and triggers supabase-ci on the helper', () => {
    const script = read('scripts/test-r1-meet.sh');
    expect(script).toContain('psql -U postgres -d postgres -q -v ON_ERROR_STOP=1');
    expect(script).toContain('< "$TESTS/r1_meet_bookings_assert.sql"');
    expect(script).toContain("log() { printf '[r1-meet] %s %s\\n'");
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    const suite = read('scripts/supabase-test.sh');
    expect(suite).toContain('bash scripts/test-r1-meet.sh');
    expect(suite.indexOf('bash scripts/test-r1-meet.sh')).toBeGreaterThan(suite.indexOf('bash scripts/test-ashby-impact.sh'));
    expect(suite.indexOf('bash scripts/test-r1-meet.sh')).toBeLessThan(suite.indexOf('TST-15 rollback rehearsal'));
    // Both the `push` and the `pull_request` path filters name the helper.
    expect(read('.github/workflows/supabase-ci.yml').match(/- 'scripts\/test-r1-meet\.sh'/g)).toHaveLength(2);
  });

  it('runs in one rolled-back transaction with fixture ids in the 7f000000 namespace', () => {
    const assertions = read('app/supabase/tests/r1_meet_bookings_assert.sql');
    const statements = assertions.replace(/^\s*--.*$/gm, '').trim();
    expect(statements.startsWith('begin;')).toBe(true);
    expect(statements.endsWith('rollback;')).toBe(true);
    expect(assertions.trimEnd().split('\n').at(-1)).toBe('rollback;');
    expect(statements).not.toMatch(/\bcommit;/);
    // Digests are computed at run time, never written as literals.
    expect(assertions).toContain("encode(sha256(convert_to(");
    expect(assertions).not.toMatch(/'[a-f0-9]{40,}'/);
    // Every UUID (or UUID prefix) written in the file lives in the dedicated namespace.
    const ids = [...assertions.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/gi)].map((m) => m[0]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('7f000000-'), id).toBe(true);
    expect(assertions).not.toMatch(/whsec_/i);
  });
});
