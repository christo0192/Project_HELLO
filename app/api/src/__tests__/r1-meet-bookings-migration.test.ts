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

describe('migration 0142: r1_meet_create_round_from_ashby (T2)', () => {
  const NAME = 'r1_meet_create_round_from_ashby';
  const SIG = 'uuid, text, text, text, text, text, timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz';
  const fn = functionBody(NAME);
  /** The plpgsql body only (after `as $$`), comments stripped, whitespace collapsed. */
  const body = fn.slice(fn.indexOf(' as $$') + ' as $$'.length);
  const bodyLc = body.toLowerCase();
  /** The raw function text with its comments, for the copied-predicate marker. */
  const rawStart = sql.indexOf(`create or replace function screening_v2.${NAME}(`);
  const raw = sql.slice(rawStart, sql.indexOf('$$;', rawStart));

  it('sits in its own §10 section between §5 and §90', () => {
    expect(sql.split('-- §10. ').length - 1).toBe(1);
    expect(sql.indexOf('-- §10. ')).toBeGreaterThan(sql.indexOf('-- §5. '));
    expect(sql.indexOf('-- §10. ')).toBeLessThan(sql.indexOf('-- §90. '));
    expect(rawStart).toBeGreaterThan(sql.indexOf('-- §10. '));
    expect(rawStart).toBeLessThan(sql.indexOf('-- §90. '));
  });

  it('has the planned argument list, returns jsonb, and is security definer with a pinned search_path', () => {
    expect(code).toContain(
      `create or replace function screening_v2.${NAME}( `
      + 'p_ashby_interview_event_id uuid, p_ashby_schedule_id text, p_ashby_application_id text, '
      + 'p_ashby_interview_stage_id text, p_ashby_interview_id text, p_ashby_scheduled_by_user_id text, '
      + 'p_attested_at timestamptz, p_ashby_updated_at timestamptz, p_meet_url text, p_start_at timestamptz, '
      + "p_end_at timestamptz, p_created_by uuid, p_objective_profile text default 'r1_dex_sales', "
      + 'p_expiry_grace_sec integer default 7200, p_now timestamptz default now() ) '
      + 'returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$',
    );
    // The grant signature lists the same types in the same order.
    const params = /\( (p_[\s\S]*?) \) returns jsonb/.exec(fn)![1]!
      .split(', ').map((p) => p.split(' ')[1]);
    expect(params.join(', ')).toBe(SIG);
  });

  it('is service-role only and documented', () => {
    expect(code).toContain(`revoke all on function screening_v2.${NAME}(${SIG}) from public, anon, authenticated;`);
    expect(code).toContain(`grant execute on function screening_v2.${NAME}(${SIG}) to service_role;`);
    expect(code).toContain(`comment on function screening_v2.${NAME}(${SIG}) is`);
    expect(lc).not.toMatch(new RegExp(`grant [a-z ,]+ on function screening_v2\\.${NAME}\\([^)]*\\) to (?!service_role;)`));
  });

  it('validates every input with a closed field code, in order, before any lock or write', () => {
    const fields = [...body.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(fields).toEqual([
      'event_id', 'schedule_id', 'application_id', 'stage_id', 'interview_id', 'attester',
      'meet_url', 'slot', 'attested_at', 'profile', 'grace', 'now',
    ]);
    const lastInvalid = body.lastIndexOf("'invalid_request'");
    expect(lastInvalid).toBeLessThan(body.indexOf("'in_past'"));
    expect(body.indexOf("'in_past'")).toBeLessThan(body.indexOf('pg_advisory_xact_lock('));
    // The same shapes as the table CHECKs and the S01 contracts.
    expect(body).toContain(`c_uuid constant text := '${UUID_RE}';`);
    const tableUrl = /constraint chk_r1_meet_bookings_meet_url check \( meet_url ~ '([^']+)' \)/.exec(bookings)![1]!;
    expect(body).toContain(`p_meet_url !~ '${tableUrl}'`);
    expect(quoted(/p_objective_profile not in \(([^)]*)\)/.exec(body)![1]!)).toEqual([...R1_MEET_PROFILE_IDS]);
    expect(body).toContain("p_end_at <= p_start_at or p_end_at > p_start_at + interval '24 hours'");
    expect(body).toContain("p_attested_at is null or p_attested_at > p_now + interval '5 minutes'");
    expect(body).toContain('p_expiry_grace_sec not between 900 and 86400');
    expect(body).toContain('if p_start_at <= p_now then return jsonb_build_object(\'status\', \'in_past\'); end if;');
  });

  it('locks the event first, then (through r1_send_round) settings and month, then the hold month and the round', () => {
    const order = [
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_booking:' || p_ashby_interview_event_id::text, 0));",
      'from screening_v2.r1_meet_bookings b where b.ashby_interview_event_id = p_ashby_interview_event_id for update;',
      'v_send := screening_v2.r1_send_round(',
      'perform 1 from screening_v2.r1_budget_month where month_start = v_hold_month for update;',
      'select * into v_round from screening_v2.interview_rounds where id = v_live_id for update;',
    ];
    let last = -1;
    for (const step of order) {
      expect(body.split(step).length - 1, step).toBeGreaterThanOrEqual(1);
      expect(body.indexOf(step), step).toBeGreaterThan(last);
      last = body.indexOf(step);
    }
    // Exactly one booking row lock (the event's own), two hold-month locks (held, uncounted), one round lock.
    expect(bodyLc.match(/\bfor update\b/g)).toHaveLength(4);
    expect(bodyLc.match(/r1_meet_bookings b where b\.ashby_interview_event_id = p_ashby_interview_event_id for update/g)).toHaveLength(1);
  });

  it('answers the replay rules of an existing booking before matching anything', () => {
    const terminal = body.indexOf("v_booking.status in ('completed', 'cancelled', 'failed', 'drained')");
    const exists = body.indexOf("'status', 'exists'");
    const stale = body.indexOf('if p_ashby_updated_at < v_booking.ashby_updated_at then');
    const match = body.indexOf('from screening_v2.ashby_application_links l');
    expect(terminal).toBeGreaterThan(-1);
    expect(exists).toBeGreaterThan(terminal);
    expect(stale).toBeGreaterThan(exists);
    expect(match).toBeGreaterThan(stale);
  });

  it('matches the candidate by the Ashby application link only, and requires created_by in auth.users', () => {
    expect(body).toContain("where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;");
    expect(bodyLc).not.toMatch(/\bemail\b/);
    expect(body).toContain('if not exists (select 1 from auth.users u where u.id = p_created_by) then');
    // p_created_by is only null-checked, looked up in auth.users and handed to r1_send_round.
    expect(body.match(/p_created_by/g)).toHaveLength(3);
    expect(body).toContain('if p_created_by is null then');
    expect(body).toContain('v_send := screening_v2.r1_send_round( v_candidate_id, v_role_id, p_created_by,');
  });

  it('bounds the expiry at 14 days and never reissues the round link', () => {
    expect(body).toContain('v_expires := p_end_at + make_interval(secs => p_expiry_grace_sec);');
    expect(body).toContain("if v_expires > p_now + interval '14 days' then v_retry_after := v_expires - interval '14 days';");
    expect(bodyLc).not.toContain('r1_transition_round');
    expect(bodyLc).not.toContain('link_token_digest');
  });

  it('creates the round through r1_send_round with a digest whose preimage is never kept, then sets channel meet', () => {
    expect(body).toContain(
      "encode(sha256(convert_to('r1-meet-unusable:' || gen_random_uuid()::text || ':' || gen_random_uuid()::text, 'UTF8')), 'hex'), "
      + 'v_candidate_status, v_expires, p_now);',
    );
    expect(body).toContain("update screening_v2.interview_rounds set channel = 'meet' where id = v_round_id;");
    // The channel flips before the consent row exists (the channel lock allows it only then).
    expect(body.indexOf("set channel = 'meet'")).toBeLessThan(body.indexOf('insert into screening_v2.interview_round_consents'));
    expect(body).toContain(
      "raise exception 'r1_meet_create_round_from_ashby: unexpected answer from r1_send_round' using errcode = 'P0001';",
    );
  });

  it('reads the newest active notice with admission\'s exact predicate, for en-IN and for a re-linked round\'s audience', () => {
    const admission = readFileSync(path.join(migrations, '0131_r1_concurrent_sessions.sql'), 'utf8');
    const newest = '(select max(x.version) from screening_v2.interview_round_consent_templates x where x.is_active)';
    expect(admission).toContain(`t.is_active and t.version=${newest}`);
    expect(body).toContain(`where t.is_active and t.version = ${newest} and t.locale = 'en-IN';`);
    expect(body).toContain(`where t.is_active and t.version = ${newest} and t.locale = v_round.consent_locale;`);
    expect(body.match(/jsonb_array_length\(v_template\.required_consents\) = 0/g)).toHaveLength(2);
  });

  it('copies the two phone checks of r1_send_round (0128) character for character into the re-link', () => {
    const src = readFileSync(path.join(migrations, '0128_r1_twenty_minute_roleplay.sql'), 'utf8').replace(/\r\n/g, '\n');
    const sendStart = src.indexOf('create or replace function screening_v2.r1_send_round(');
    const send = src.slice(sendStart, src.indexOf('$$;', sendStart));
    const checks = [...send.matchAll(/^\s*if (exists \(.*\)) then return jsonb_build_object\('status','(phone_engagement_active|phone_assessment_pending)'\); end if;$/gm)]
      .map((m) => ({ predicate: m[1]!, code: m[2]! }));
    expect(checks.map((c) => c.code)).toEqual(['phone_engagement_active', 'phone_assessment_pending']);
    const marker = '-- copied from r1_send_round (0128)\n';
    expect(raw.split(marker)).toHaveLength(2);
    let rest = raw.slice(raw.indexOf(marker) + marker.length);
    for (const check of checks) {
      const stmt = `if ${check.predicate} then`;
      rest = rest.trimStart();
      expect(rest.startsWith(stmt), check.code).toBe(true);
      rest = rest.slice(stmt.length).trimStart();
      expect(rest.startsWith(`v_reason := '${check.code}';`), check.code).toBe(true);
      rest = rest.slice(rest.indexOf('end if;') + 'end if;'.length);
    }
    // The copied text reads r1_send_round's parameter name; the block binds it to the matched candidate.
    expect(body).toContain('declare p_candidate_id constant uuid := v_candidate_id; begin');
  });

  it('re-links only a reusable live Meet round and supersedes its live consent like the browser flow', () => {
    for (const condition of [
      'v_round.id is null',
      "v_round.channel <> 'meet'",
      "v_round.status not in ('invited', 'in_progress')",
      'v_round.expires_at <= p_now',
      'v_round.starts_used >= 3',
      'v_round.attempts_counted >= v_round.attempts_allowed',
      "s.interview_round_id = v_round.id and s.status in ('created', 'waiting', 'in_progress')",
      "b.round_id = v_round.id and b.status not in ('completed', 'cancelled', 'failed', 'drained')",
    ]) {
      expect(body, condition).toContain(condition);
    }
    expect(body).toContain('update screening_v2.interview_rounds set expires_at = v_expires, version = version + 1, updated_at = p_now where id = v_round.id;');
    expect(body).toContain(
      "update screening_v2.interview_round_consents set withdrawn_at = p_now, proof = coalesce(proof, '{}'::jsonb) "
      + "|| jsonb_build_object('decision', 'superseded', 'superseded_at', p_now) where round_id = v_round.id and withdrawn_at is null;",
    );
    // The hold is never moved: no budget-month write in the re-link.
    expect(bodyLc).not.toMatch(/update screening_v2\.r1_budget_month/);
  });

  it('writes the HR-attested consent with the Ashby scheduler as the attester, never created_by', () => {
    const start = body.indexOf('insert into screening_v2.interview_round_consents');
    const insert = body.slice(start, body.indexOf(';', start));
    expect(insert).toContain(
      '(round_id, template_id, consents, proof, granted_at, method, attested_by_external_id, attested_at, india_location_attested)',
    );
    expect(insert).toContain('values (v_round_id, v_template.id, v_template.required_consents,');
    expect(insert).toContain("'decision', 'granted', 'method', 'hr_attested_ashby', 'captured_at', p_now,");
    expect(insert).toContain("'attested_by_external_id', p_ashby_scheduled_by_user_id,");
    expect(insert).toContain("'india_location_attested', true, 'source', 'ashby_interview_schedule',");
    expect(insert).toContain("p_now, 'hr_attested_ashby', p_ashby_scheduled_by_user_id, p_attested_at, true)");
    expect(insert).not.toContain('p_created_by');
    expect(insert).not.toMatch(/ip_prefix|user_agent|email|name'/);
    expect(R1_MEET_CONSENT_MODES).toContain('hr_attested_ashby');
  });

  it('pairs every status and reason it writes with the booking CHECKs', () => {
    const families = pairingFamilies();
    const familyOf = (status: string) => families.find((f) => f.statuses.includes(status))!.reasons;
    const pairs = [...body.matchAll(/v_status := '([a-z_]+)'; v_reason := '([a-z_]+)';/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(pairs.length).toBeGreaterThanOrEqual(9);
    for (const [status, reason] of pairs) expect(familyOf(status), `${status}/${reason}`).toContain(reason);
    // r1_send_round refusals map 1:1 onto blocked reasons.
    const refusals = quoted(/if v_code in \(([^)]*)\) then v_status := 'blocked'; v_reason := v_code;/.exec(body)![1]!);
    expect(refusals).toEqual([
      'disabled', 'paused', 'candidate_ineligible', 'role_not_configured',
      'phone_engagement_active', 'phone_assessment_pending', 'capacity_exhausted',
    ]);
    for (const reason of refusals) expect(familyOf('blocked'), reason).toContain(reason);
    // The re-link's own refusals keep status blocked.
    const relinkStart = body.indexOf("v_status := 'blocked'; v_reason := 'round_active';");
    const relink = body.slice(relinkStart, body.indexOf('update screening_v2.interview_rounds set expires_at = v_expires', relinkStart));
    const relinkReasons = [...relink.matchAll(/v_reason := '([a-z_]+)';/g)].map((m) => m[1]!);
    expect(relinkReasons).toEqual(['round_active', 'phone_engagement_active', 'phone_assessment_pending', 'consent_template_unavailable']);
    for (const reason of relinkReasons) expect(familyOf('blocked'), reason).toContain(reason);
  });

  it('never writes a call session, an audit row or a job, never reads the clock, and never returns a digest', () => {
    expect(bodyLc).not.toMatch(/insert into screening_v2\.(call_sessions|audit_events|job_queue)\b/);
    expect(bodyLc).not.toMatch(/\bnow\s*\(|\bcurrent_timestamp\b|\bclock_timestamp\s*\(|\bstatement_timestamp\s*\(/);
    expect(bodyLc).not.toMatch(/\bwhen others\b|\bexception\s+when\b/);
    const builds = [...bodyLc.matchAll(/jsonb_build_object\(/g)].map((m) => bodyLc.slice(m.index!, bodyLc.indexOf(';', m.index!)));
    expect(builds.length).toBeGreaterThan(10);
    for (const b of builds) expect(b).not.toMatch(/digest|token|unusable/);
  });
});

describe('migration 0142: the booking lifecycle RPCs (T3)', () => {
  const RPCS = [
    {
      name: 'r1_meet_reschedule_booking',
      section: '-- §11. ',
      args: 'p_booking_id uuid, p_expected_version integer, p_start_at timestamptz, p_end_at timestamptz, '
        + 'p_meet_url text, p_ashby_updated_at timestamptz, p_expiry_grace_sec integer default 7200, '
        + 'p_now timestamptz default now()',
      sig: 'uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz',
      statuses: [
        'ok', 'invalid_request', 'not_found', 'booking_terminal', 'version_conflict', 'stale_update',
        'booking_dispatched', 'bot_attached', 'no_round', 'not_allowed', 'in_past', 'slot_too_far',
        'round_not_live',
      ],
    },
    {
      name: 'r1_meet_cancel_booking',
      section: '-- §12. ',
      args: 'p_booking_id uuid, p_reason text, p_now timestamptz default now()',
      sig: 'uuid, text, timestamptz',
      statuses: ['ok', 'invalid_reason', 'invalid_request', 'not_found', 'already_cancelled', 'booking_terminal'],
    },
    {
      name: 'r1_meet_set_bot',
      section: '-- §13. ',
      args: 'p_booking_id uuid, p_action text, p_expected_version integer, p_expected_key_attempt integer, '
        + 'p_recall_bot_id uuid default null, p_now timestamptz default now()',
      sig: 'uuid, text, integer, integer, uuid, timestamptz',
      statuses: [
        'ok', 'invalid_action', 'invalid_request', 'not_found', 'version_conflict', 'duplicate',
        'bot_conflict', 'not_allowed', 'in_past', 'round_not_live', 'bot_in_use',
        'key_attempts_exhausted', 'version_exhausted',
      ],
    },
    {
      name: 'r1_meet_transition_booking',
      section: '-- §14. ',
      args: 'p_booking_id uuid, p_from_status text, p_to_status text, p_reason text, p_now timestamptz default now()',
      sig: 'uuid, text, text, text, timestamptz',
      statuses: ['ok', 'invalid_request', 'not_found', 'status_conflict', 'invalid_transition'],
    },
    {
      name: 'r1_meet_bind_session',
      section: '-- §15. ',
      args: 'p_booking_id uuid, p_session_id uuid, p_now timestamptz default now()',
      sig: 'uuid, uuid, timestamptz',
      statuses: ['ok', 'invalid_request', 'not_found', 'not_in_call', 'session_mismatch', 'duplicate'],
    },
  ] as const;

  /** The plpgsql body of an RPC (after `as $$`), comments stripped, whitespace collapsed. */
  const bodyOf = (name: string): string => {
    const fn = functionBody(name);
    return fn.slice(fn.indexOf(' as $$') + ' as $$'.length);
  };
  const BOOKING_LOCK = 'from screening_v2.r1_meet_bookings b where b.id = p_booking_id for update;';
  const families = pairingFamilies();
  const familyOf = (status: string) => families.find((f) => f.statuses.includes(status))!.reasons;

  it('sits in sections §11 to §15, in order, between §10 and §90', () => {
    let last = sql.indexOf('-- §10. ');
    expect(last).toBeGreaterThan(-1);
    for (const rpc of RPCS) {
      expect(sql.split(rpc.section).length - 1, rpc.section).toBe(1);
      const at = sql.indexOf(rpc.section);
      expect(at, rpc.section).toBeGreaterThan(last);
      const fnAt = sql.indexOf(`create or replace function screening_v2.${rpc.name}(`);
      expect(fnAt, rpc.name).toBeGreaterThan(at);
      last = fnAt;
    }
    expect(sql.indexOf('-- §90. ')).toBeGreaterThan(last);
  });

  it('has the planned argument lists, returns jsonb, and is security definer with a pinned search_path', () => {
    for (const rpc of RPCS) {
      expect(code, rpc.name).toContain(
        `create or replace function screening_v2.${rpc.name}( ${rpc.args} ) `
        + 'returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$',
      );
      const params = /\( (p_[\s\S]*?) \) returns jsonb/.exec(functionBody(rpc.name))![1]!
        .split(', ').map((p) => p.split(' ')[1]);
      expect(params.join(', '), rpc.name).toBe(rpc.sig);
      expect(sql.split(`create or replace function screening_v2.${rpc.name}(`), rpc.name).toHaveLength(2);
    }
  });

  it('is service-role only and documented', () => {
    for (const rpc of RPCS) {
      expect(code, rpc.name).toContain(`revoke all on function screening_v2.${rpc.name}(${rpc.sig}) from public, anon, authenticated;`);
      expect(code, rpc.name).toContain(`grant execute on function screening_v2.${rpc.name}(${rpc.sig}) to service_role;`);
      expect(code, rpc.name).toContain(`comment on function screening_v2.${rpc.name}(${rpc.sig}) is`);
      expect(lc, rpc.name).not.toMatch(new RegExp(`grant [a-z ,]+ on function screening_v2\\.${rpc.name}\\([^)]*\\) to (?!service_role;)`));
    }
  });

  it('answers a closed set of statuses each', () => {
    for (const rpc of RPCS) {
      const body = bodyOf(rpc.name);
      const answered = new Set([
        ...[...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!),
        ...[...body.matchAll(/v_answer := '([a-z_]+)';/g)].map((m) => m[1]!),
      ]);
      expect([...answered].sort(), rpc.name).toEqual([...rpc.statuses].sort());
      // The only computed status is set_bot's v_answer, assigned from the literals above.
      const computed = [...body.matchAll(/'status', (?!')([a-z_]+)/g)].map((m) => m[1]);
      expect(computed, rpc.name).toEqual(rpc.name === 'r1_meet_set_bot' ? ['v_answer'] : []);
    }
  });

  it('reads no clock, has no exception handler, writes no session, audit row or job, and returns no digest', () => {
    for (const rpc of RPCS) {
      const bodyLc = bodyOf(rpc.name).toLowerCase();
      expect(bodyLc, rpc.name).not.toMatch(/\bnow\s*\(|\bcurrent_timestamp\b|\bclock_timestamp\s*\(|\bstatement_timestamp\s*\(/);
      expect(bodyLc, rpc.name).not.toMatch(/\bwhen others\b|\bexception\s+when\b/);
      expect(bodyLc, rpc.name).not.toMatch(/\b(insert into|delete from)\b/);
      expect(bodyLc, rpc.name).not.toMatch(/update screening_v2\.(call_sessions|audit_events|job_queue|interview_round_consents|candidates|r1_budget_month)\b/);
      expect(bodyLc, rpc.name).not.toMatch(/r1_transition_round|link_token_digest|r1_send_round|r1_admit_attempt/);
      const builds = [...bodyLc.matchAll(/jsonb_build_object\(/g)].map((m) => bodyLc.slice(m.index!, bodyLc.indexOf(';', m.index!)));
      expect(builds.length, rpc.name).toBeGreaterThan(2);
      // Values only (string literals blanked): a field code such as 'meet_url' names, never carries.
      for (const b of builds) expect(b.replace(/'[^']*'/g, "''"), rpc.name).not.toMatch(/digest|token|meet_url|scheduled_by/);
    }
  });

  it('locks its one booking row first; only the reschedule goes on to settings, the hold month and the round', () => {
    for (const rpc of RPCS) {
      const body = bodyOf(rpc.name);
      expect(body.split(BOOKING_LOCK), rpc.name).toHaveLength(2);
      const firstLock = body.indexOf(' for update');
      expect(firstLock, rpc.name).toBe(body.indexOf(BOOKING_LOCK) + BOOKING_LOCK.length - ' for update;'.length);
      if (rpc.name === 'r1_meet_reschedule_booking') continue;
      expect(body.toLowerCase().match(/\bfor update\b/g), rpc.name).toHaveLength(1);
      expect(body, rpc.name).not.toMatch(/r1_settings|r1_budget_month/);
    }
    const body = bodyOf('r1_meet_reschedule_booking');
    const order = [
      BOOKING_LOCK,
      'perform 1 from screening_v2.r1_settings where singleton for update;',
      'perform 1 from screening_v2.r1_budget_month where month_start = v_hold_month for update;',
      'from screening_v2.interview_rounds r where r.id = v_booking.round_id for update;',
      'update screening_v2.interview_rounds set',
      'update screening_v2.r1_meet_bookings set',
    ];
    let last = -1;
    for (const step of order) {
      expect(body.split(step).length - 1, step).toBe(1);
      expect(body.indexOf(step), step).toBeGreaterThan(last);
      last = body.indexOf(step);
    }
    expect(body.toLowerCase().match(/\bfor update\b/g)).toHaveLength(4);
    // The hold month is taken exactly when the round transitions would take it.
    expect(body).toContain('if v_hold_month is not null and (v_hold_minutes > 0 or v_uncounted) then');
    expect(body).toContain('select r.held_minutes, r.hold_month, r.charged_attempt_number > r.attempts_counted into v_hold_minutes, v_hold_month, v_uncounted');
  });

  it('cancel writes the booking row and nothing else', () => {
    const body = bodyOf('r1_meet_cancel_booking');
    const tables = new Set([...body.matchAll(/screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1]));
    expect([...tables]).toEqual(['r1_meet_bookings']);
    expect(body.match(/\bupdate screening_v2\.r1_meet_bookings set\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/\bperform\b|\binsert\b|\bdelete\b|\btruncate\b/);
    expect(body).not.toMatch(/update screening_v2\.(interview_rounds|interview_round_consents)\b/);
    // Its reasons are exactly the cancelled family of the pairing CHECK.
    const reasons = quoted(/p_reason not in \(([^)]*)\)/.exec(body)![1]!);
    expect(reasons).toEqual(familyOf('cancelled'));
    expect(body).toContain("set status = 'cancelled', reason = p_reason,");
    // An unclaimed ticket goes; a claimed one stays as evidence.
    for (const col of ['ticket_digest', 'ticket_not_before', 'ticket_expires_at']) {
      expect(body).toContain(`${col} = case when ticket_claimed_at is null then null else ${col} end`);
    }
    expect(body).not.toMatch(/ticket_claimed_at = /);
    expect(body).toContain("'bot_dispatched', v_booking.status in ('bot_joining', 'human_present', 'in_call')");
    expect(body).toContain("if v_booking.status = 'cancelled' then return jsonb_build_object('status', 'already_cancelled'");
  });

  it('reschedules with the create RPC\'s input rules, in the planned refusal order, and moves only the expiry of the round', () => {
    const body = bodyOf('r1_meet_reschedule_booking');
    const fields = [...body.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(fields).toEqual(['meet_url', 'slot', 'grace', 'now']);
    const create = bodyOf('r1_meet_create_round_from_ashby');
    for (const rule of [
      "p_meet_url is null or p_meet_url !~ '^https://meet\\.google\\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$'",
      "p_start_at is null or p_end_at is null or p_end_at <= p_start_at or p_end_at > p_start_at + interval '24 hours'",
      'p_expiry_grace_sec is null or p_expiry_grace_sec not between 900 and 86400',
      'v_expires := p_end_at + make_interval(secs => p_expiry_grace_sec);',
      "if v_expires > p_now + interval '14 days' then",
    ]) {
      expect(body, rule).toContain(rule);
      expect(create, rule).toContain(rule);
    }
    const refusals = [
      "'invalid_request', 'field', 'now'", BOOKING_LOCK, "'status', 'not_found'", "'status', 'booking_terminal'",
      "'status', 'version_conflict'", "'status', 'stale_update'", "'status', 'booking_dispatched'",
      "'status', 'bot_attached'", "'status', 'no_round'", "'status', 'not_allowed'", "'status', 'in_past'",
      "'status', 'slot_too_far'", 'r1_settings where singleton for update', "'status', 'round_not_live'",
      "'status', 'ok'",
    ];
    let last = -1;
    for (const step of refusals) {
      expect(body.indexOf(step), step).toBeGreaterThan(last);
      last = body.indexOf(step);
    }
    expect(body).toContain('if v_booking.version is distinct from p_expected_version then');
    expect(body).toContain('if p_ashby_updated_at < v_booking.ashby_updated_at then');
    expect(body).toContain("if v_booking.status in ('bot_joining', 'human_present', 'in_call') then");
    expect(body).toContain("if v_booking.status not in ('pending', 'blocked') then");
    expect(body).toContain("'retry_after', v_expires - interval '14 days'");
    // Live = the claim RPC's definition: an invited or in-progress Meet round that has not lapsed.
    expect(body).toContain(
      "if not found or v_round.channel <> 'meet' or v_round.status not in ('invited', 'in_progress') or v_round.expires_at <= p_now then",
    );
    expect(body).toContain('update screening_v2.interview_rounds set expires_at = v_expires, version = version + 1, updated_at = p_now where id = v_round.id;');
    // The booking keeps its bot generation; it goes back to pending/eligible with the new slot.
    const start = body.indexOf('update screening_v2.r1_meet_bookings set');
    const update = body.slice(start, body.indexOf(';', start));
    expect(update).not.toMatch(/\bversion\b|\bkey_attempt\b|\bround_id\b|\bcandidate_id\b|\brecall_bot_id\b/);
    for (const set of [
      'start_at = p_start_at', 'end_at = p_end_at', 'meet_url = p_meet_url',
      'ashby_updated_at = greatest(ashby_updated_at, p_ashby_updated_at)', "status = 'pending'", "reason = 'eligible'",
      'updated_at = p_now',
    ]) {
      expect(update, set).toContain(set);
    }
    expect(familyOf('pending')).toContain('eligible');
  });

  it('sets the bot by compare-and-set on both counters, within the caps of 20 keys and 50 generations', () => {
    const body = bodyOf('r1_meet_set_bot');
    expect(quoted(/p_action not in \(([^)]*)\)/.exec(body)![1]!)).toEqual(['attach', 'rotate_key', 'replace', 'release']);
    expect(body).toContain(
      'if v_booking.version is distinct from p_expected_version or v_booking.key_attempt is distinct from p_expected_key_attempt then v_answer := \'version_conflict\';',
    );
    // The compare-and-set is the first decision after the lock, for every action.
    expect(body.indexOf("v_answer := 'version_conflict'")).toBeLessThan(body.indexOf("elsif p_action = 'attach' then"));
    expect(body).toContain("elsif v_booking.key_attempt >= 20 then v_answer := 'key_attempts_exhausted';");
    expect(body).toContain("elsif v_booking.version >= 50 then v_answer := 'version_exhausted';");
    // The table caps are the same numbers.
    expect(bookings).toContain('check (version between 0 and 50)');
    expect(bookings).toContain('check (key_attempt between 0 and 20)');
    expect(body).toContain('set key_attempt = key_attempt + 1, updated_at = p_now');
    expect(body).toContain(
      'set recall_bot_id = null, version = version + 1, key_attempt = 0, ticket_digest = null, ticket_not_before = null, '
      + "ticket_expires_at = null, ticket_claimed_at = null, ticket_arms = 0, status = 'pending', reason = 'eligible', updated_at = p_now",
    );
    expect(body).toContain("set recall_bot_id = p_recall_bot_id, status = 'bot_scheduled', reason = 'eligible', updated_at = p_now");
    expect(body).toContain('set recall_bot_id = null, updated_at = p_now');
    // version is bumped only by replace; key_attempt only by rotate_key (and reset by replace).
    expect(body.match(/version = version \+ 1/g)).toHaveLength(1);
    expect(body.match(/key_attempt = key_attempt \+ 1/g)).toHaveLength(1);
    // Every status it writes pairs with eligible.
    for (const status of [...body.matchAll(/status = '([a-z_]+)', reason = '([a-z_]+)'/g)].map((m) => [m[1]!, m[2]!])) {
      expect(familyOf(status[0]!), status.join('/')).toContain(status[1]);
    }
    // attach: pending only, before the slot ends, on a live Meet round, a bot no other booking holds.
    expect(body).toContain("elsif v_booking.status <> 'pending' then v_answer := 'not_allowed'; elsif p_now >= v_booking.end_at then v_answer := 'in_past';");
    expect(body).toContain(
      "if not found or v_round.channel <> 'meet' or v_round.status not in ('invited', 'in_progress') or v_round.expires_at <= p_now then v_answer := 'round_not_live';",
    );
    expect(body).toContain('where o.recall_bot_id = p_recall_bot_id and o.id <> v_booking.id) then v_answer := \'bot_in_use\';');
    // release: terminal bookings only.
    expect(body).toContain(`if v_booking.status not in (${TERMINAL.map((s) => `'${s}'`).join(', ')}) then v_answer := 'not_allowed';`);
  });

  it('transitions exactly along the planned matrix and leaves the reason to the pairing CHECK', () => {
    const body = bodyOf('r1_meet_transition_booking');
    const start = body.indexOf('if ((p_from_status');
    const matrix = body.slice(start, body.indexOf(' is not true then', start));
    expect(start).toBeGreaterThan(-1);
    const list = (s: string) => (s.startsWith('= ') ? [s.slice(3, -1)] : quoted(s));
    const edges = new Set<string>();
    for (const m of matrix.matchAll(/\(p_from_status (= '[a-z_]+'|in \([^)]*\)) and p_to_status (= '[a-z_]+'|in \([^)]*\))\)/g)) {
      for (const from of list(m[1]!)) for (const to of list(m[2]!)) edges.add(`${from}->${to}`);
    }
    const toTerminal = ['pending', 'blocked', 'unmatched_application', 'unmapped_scheduler', ...ACTIVE.slice(1)]
      .flatMap((from) => [`${from}->failed`, `${from}->drained`]);
    expect([...edges].sort()).toEqual([
      'bot_scheduled->bot_joining', 'bot_scheduled->human_present', 'bot_joining->human_present',
      'in_call->completed', 'pending->blocked', 'blocked->blocked', ...toTerminal,
    ].sort());
    expect(edges.size).toBe(22);
    // Never from a terminal status; never into a status another RPC owns.
    for (const edge of edges) {
      const [from, to] = edge.split('->');
      expect(TERMINAL, edge).not.toContain(from);
      expect(['pending', 'unmatched_application', 'unmapped_scheduler', 'bot_scheduled', 'in_call', 'cancelled'], edge).not.toContain(to);
      expect(familyOf(to!).length, edge).toBeGreaterThan(0);
    }
    expect(body).toContain('if v_booking.status is distinct from p_from_status then');
    expect(body).toContain("v_terminal := p_to_status in ('completed', 'failed', 'drained');");
    expect(body).toContain('set status = p_to_status, reason = p_reason,');
    for (const col of ['ticket_digest', 'ticket_not_before', 'ticket_expires_at']) {
      expect(body).toContain(`${col} = case when v_terminal and ticket_claimed_at is null then null else ${col} end`);
    }
    // The reason is never checked in code: the table's pairing CHECK is the one source of truth.
    expect(body).not.toMatch(/p_reason (not )?in \(/);
  });

  it('binds only a session of the booking\'s own round to an in-call booking', () => {
    const body = bodyOf('r1_meet_bind_session');
    expect(body).toContain("if v_booking.status <> 'in_call' then return jsonb_build_object('status', 'not_in_call'");
    expect(body).toContain('select s.interview_round_id into v_session_round from screening_v2.call_sessions s where s.id = p_session_id;');
    expect(body).toContain('if v_session_round is null or v_session_round is distinct from v_booking.round_id then');
    expect(body).toContain('set session_id = p_session_id, updated_at = p_now where id = v_booking.id;');
    expect(body).toContain("'previous_session_id', v_booking.session_id");
    expect(body.indexOf("'status', 'not_in_call'")).toBeLessThan(body.indexOf("'status', 'session_mismatch'"));
    expect(body.indexOf("'status', 'session_mismatch'")).toBeLessThan(body.indexOf("'status', 'duplicate'"));
  });

  it('is exercised by the SQL suite, and the T2 re-link cancels through r1_meet_cancel_booking', () => {
    const suite = read('app/supabase/tests/r1_meet_bookings_assert.sql');
    for (const rpc of RPCS) expect(suite, rpc.name).toContain(`screening_v2.${rpc.name}(`);
    for (const section of ['-- T3-A. ', '-- T3-B. ', '-- T3-C. ', '-- T3-D. ', '-- T3-E. ', '-- T3-F. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
    }
    expect(suite.indexOf('-- T3-A. ')).toBeGreaterThan(suite.indexOf('-- T2-H. '));
    // No fixture shortcut for a cancel is left anywhere.
    expect(suite).not.toMatch(/set status = 'cancelled'/);
    expect(suite).not.toMatch(/T3 replaces/);
    const relink = suite.slice(suite.indexOf('-- T2-G. '), suite.indexOf('-- T2-H. '));
    expect(relink.match(/screening_v2\.r1_meet_cancel_booking\(/g)).toHaveLength(2);
    expect(relink).toContain('_r1_meet_tests.round_state(r_id) = st_before');
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
