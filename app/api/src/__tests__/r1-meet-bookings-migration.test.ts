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

  it('re-creates each of its four triggers after a guarded drop on the same table', () => {
    const creates = [...lc.matchAll(/create trigger ([a-z0-9_]+) (?:before|after) [a-z_ ]+? on ([a-z0-9_.]+)/g)]
      .map((m) => `${m[1]} on ${m[2]}`);
    expect(creates).toEqual([
      'trg_interview_rounds_channel_locked on screening_v2.interview_rounds',
      'enqueue_r1_meet_bot_release on screening_v2.r1_meet_bookings',
      'trg_interview_rounds_meet_link_locked on screening_v2.interview_rounds',
      'enqueue_r1_meet_round_cancelled on screening_v2.interview_rounds',
    ]);
    expect(lc.match(/\bcreate trigger\b/g)).toHaveLength(creates.length);
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
    // The one call of r1_transition_round is the sweep's expiry of a lapsed Meet round (create RPC
    // step 8a); no reissue anywhere.
    const transitions = [...lc.matchAll(/r1_transition_round\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(transitions).toEqual(["v_lapsed_id, 'expire', v_lapsed_version, null, null, p_now"]);
    expect(lc).not.toMatch(/'reissue'/);
    const queueInserts = lc.match(/insert into screening_v2\.job_queue\b/g) ?? [];
    const named = [...lc.matchAll(/insert into screening_v2\.job_queue \(name, [^)]*\) (?:values \(|select )'([^']*)'/g)].map((m) => m[1]);
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
    for (const fn of [
      'reject_interview_round_channel_change', 'enqueue_r1_meet_bot_release',
      'reject_meet_round_link_reissue', 'enqueue_r1_meet_round_cancelled',
    ]) {
      expect(code).toContain(`revoke all on function screening_v2.${fn}() from public, anon, authenticated;`);
    }
  });

  it('fences the app\'s round actions on a Meet round: no link reissue, and a cancel queues one round_cancelled job per live booking (review F3)', () => {
    expect(sql.split('-- §6. ').length - 1).toBe(1);
    expect(sql.indexOf('-- §6. ')).toBeGreaterThan(sql.indexOf('-- §5. '));
    expect(sql.indexOf('-- §6. ')).toBeLessThan(sql.indexOf('-- §10. '));
    // reissue is the only writer of link_token_digest after the Send (0128 r1_transition_round).
    const reissue = functionBody('reject_meet_round_link_reissue');
    expect(reissue).toContain('returns trigger language plpgsql security invoker set search_path = pg_catalog as $$');
    expect(reissue).toContain(
      "if old.channel = 'meet' and new.link_token_digest is distinct from old.link_token_digest then "
      + "raise exception 'interview round % is a Meet round: its link is never reissued', old.id using errcode = 'P0001';",
    );
    expect(code).toContain(
      'create trigger trg_interview_rounds_meet_link_locked before update of link_token_digest on screening_v2.interview_rounds '
      + 'for each row execute function screening_v2.reject_meet_round_link_reissue();',
    );
    const transition = readFileSync(path.join(migrations, '0128_r1_twenty_minute_roleplay.sql'), 'utf8');
    expect(transition).toContain('update screening_v2.interview_rounds set link_token_digest=p_link_token_digest,expires_at=p_expires_at');
    // The cancel only queues ids (no booking lock, so no lock-order inversion with the Meet RPCs).
    const cancelled = functionBody('enqueue_r1_meet_round_cancelled');
    expect(cancelled).toContain('returns trigger language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$');
    expect(cancelled).toContain(
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts) select 'r1-meet', "
      + "jsonb_build_object('kind', 'round_cancelled', 'booking_id', b.id, 'round_id', new.id), "
      + "'r1-meet:round-cancelled:' || b.id::text, 10 from screening_v2.r1_meet_bookings b where b.round_id = new.id "
      + `and b.status not in (${TERMINAL.map((s) => `'${s}'`).join(', ')}) on conflict do nothing; return null;`,
    );
    expect(cancelled).not.toMatch(/\bfor update\b|\bupdate screening_v2\./);
    expect(code).toContain(
      'create trigger enqueue_r1_meet_round_cancelled after update of status on screening_v2.interview_rounds for each row '
      + "when (new.channel = 'meet' and new.status = 'cancelled' and old.status is distinct from 'cancelled') "
      + 'execute function screening_v2.enqueue_r1_meet_round_cancelled();',
    );
    // The reason S06 then writes is in the cancelled family.
    expect(pairingFamilies().find((f) => f.statuses.includes('cancelled'))!.reasons).toContain('round_cancelled');
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
    // Review F6: the event's booking is read BEFORE any in_past answer, so a replay for an event
    // that has a booking always reads that booking, also after the slot started.
    expect(lastInvalid).toBeLessThan(body.indexOf('pg_advisory_xact_lock('));
    expect(body.indexOf('pg_advisory_xact_lock(')).toBeLessThan(body.indexOf("'in_past'"));
    // The same shapes as the table CHECKs and the S01 contracts.
    expect(body).toContain(`c_uuid constant text := '${UUID_RE}';`);
    const tableUrl = /constraint chk_r1_meet_bookings_meet_url check \( meet_url ~ '([^']+)' \)/.exec(bookings)![1]!;
    expect(body).toContain(`p_meet_url !~ '${tableUrl}'`);
    expect(quoted(/p_objective_profile not in \(([^)]*)\)/.exec(body)![1]!)).toEqual([...R1_MEET_PROFILE_IDS]);
    expect(body).toContain("p_end_at <= p_start_at or p_end_at > p_start_at + interval '24 hours'");
    expect(body).toContain("p_attested_at is null or p_attested_at > p_now + interval '5 minutes'");
    expect(body).toContain('p_expiry_grace_sec not between 900 and 86400');
    expect(body).toContain("if p_start_at <= p_now then return jsonb_build_object('status', 'in_past', 'booking_id', v_booking.id); end if;");
    expect(body).toContain("elsif p_start_at <= p_now then return jsonb_build_object('status', 'in_past'); end if;");
  });

  it('locks the event first, then (through r1_send_round) settings and month, then the hold month and the round', () => {
    const order = [
      "perform pg_advisory_xact_lock(hashtextextended('r1_meet_booking:' || p_ashby_interview_event_id::text, 0));",
      'from screening_v2.r1_meet_bookings b where b.ashby_interview_event_id = p_ashby_interview_event_id for update;',
      "perform screening_v2.r1_transition_round(v_lapsed_id, 'expire', v_lapsed_version, null, null, p_now);",
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
    const terminal = body.indexOf("v_booking.status in ('completed', 'cancelled', 'drained')");
    const exists = body.indexOf("'status', 'exists'");
    const stale = body.indexOf('if p_ashby_updated_at < v_booking.ashby_updated_at then');
    const bot = body.indexOf("'status', 'bot_attached'");
    const exhausted = body.indexOf("'status', 'version_exhausted'");
    const started = body.indexOf("'status', 'in_past', 'booking_id'");
    const match = body.indexOf('from screening_v2.ashby_application_links l');
    expect(terminal).toBeGreaterThan(-1);
    expect(exists).toBeGreaterThan(terminal);
    expect(stale).toBeGreaterThan(exists);
    expect(bot).toBeGreaterThan(stale);
    expect(exhausted).toBeGreaterThan(bot);
    expect(started).toBeGreaterThan(exhausted);
    expect(match).toBeGreaterThan(started);
  });

  it('revives a failed booking moved to a new slot, and re-binds a lapsed round before dispatch, as a new bot generation (review F1)', () => {
    // Only a failed booking whose slot or link moved, and has not started, is revived.
    expect(body).toContain(
      "or (v_booking.status = 'failed' and (p_start_at <= p_now or (p_start_at, p_end_at, p_meet_url) "
      + 'is not distinct from (v_booking.start_at, v_booking.end_at, v_booking.meet_url))) then '
      + "return jsonb_build_object('status', 'booking_terminal'",
    );
    // A booking with a round re-binds only when the round lapsed (expired, or live statuses past
    // the expiry: never cancelled or completed), before dispatch, for a slot that has not started.
    expect(body).toContain(
      "v_round_lapsed := coalesce(v_old_status = 'expired' or (v_old_status in ('invited', 'in_progress') and v_old_expires <= p_now), false);",
    );
    expect(body).toContain(
      "if not v_round_lapsed or v_booking.status in ('bot_joining', 'human_present', 'in_call') or p_start_at <= p_now then",
    );
    expect(body).toContain("'round_live', v_round_live");
    expect(body).toContain("v_rebind := v_booking.round_id is not null or v_booking.status = 'failed';");
    expect(body).toContain('if v_rebind and v_booking.version >= 50 then');
    expect(body).toContain('if v_booking.recall_bot_id is not null then return jsonb_build_object(\'status\', \'bot_attached\'');
    // The write: a new generation (the next Recall create uses a new Idempotency-Key), no old ticket or session.
    const start = body.indexOf('update screening_v2.r1_meet_bookings set');
    const update = body.slice(start, body.indexOf(';', start));
    for (const set of [
      'version = case when v_rebind then version + 1 else version end',
      'key_attempt = case when v_rebind then 0 else key_attempt end',
      'ticket_digest = case when v_rebind then null else ticket_digest end',
      'ticket_claimed_at = case when v_rebind then null else ticket_claimed_at end',
      'ticket_arms = case when v_rebind then 0 else ticket_arms end',
      'session_id = case when v_rebind then null else session_id end',
    ]) {
      expect(update, set).toContain(set);
    }
    expect(body).toContain("if v_rebind then v_out := v_out || jsonb_build_object('rebound', true); end if;");
    // Step 8a: only a lapsed, never-started Meet round with no live session and no live booking of
    // another event is expired, through the sweep's own transition.
    for (const condition of [
      "r.candidate_id = v_candidate_id and r.kind = 'sales_r1' and r.channel = 'meet'",
      "r.status = 'invited' and r.starts_used = 0 and r.expires_at <= p_now",
      "s.interview_round_id = r.id and s.status in ('created', 'waiting', 'in_progress')",
      "o.round_id = r.id and o.status not in ('completed', 'cancelled', 'failed', 'drained') and o.ashby_interview_event_id <> p_ashby_interview_event_id",
    ]) {
      expect(body, condition).toContain(condition);
    }
    const sweep = readFileSync(path.join(migrations, '0119_r1_capacity_model.sql'), 'utf8').replace(/\s+/g, ' ');
    expect(sweep).toContain("if r.status='invited' then v_result := screening_v2.r1_transition_round(r.id,'expire',r.version,null,null,p_now);");
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
    // r1_transition_round only expires a lapsed round (step 8a), never reissues.
    expect(bodyLc.match(/r1_transition_round\(/g)).toHaveLength(1);
    expect(bodyLc).toContain("r1_transition_round(v_lapsed_id, 'expire',");
    expect(bodyLc).not.toContain('reissue');
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
        'version_exhausted', 'round_not_live',
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
      "'status', 'slot_too_far'", "'status', 'version_exhausted'", 'r1_settings where singleton for update',
      "'status', 'round_not_live'", "'status', 'ok'",
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
    // Review F2: a new slot or Meet link is a new bot generation (the Idempotency-Key follows the
    // body); a reschedule that moves neither keeps both counters. Back to pending/eligible.
    expect(body).toContain(
      'v_moved := (p_start_at, p_end_at, p_meet_url) is distinct from (v_booking.start_at, v_booking.end_at, v_booking.meet_url);',
    );
    expect(body).toContain("if v_moved and v_booking.version >= 50 then return jsonb_build_object('status', 'version_exhausted'");
    const start = body.indexOf('update screening_v2.r1_meet_bookings set');
    const update = body.slice(start, body.indexOf(';', start));
    expect(update).not.toMatch(/\bround_id\b|\bcandidate_id\b|\brecall_bot_id\b/);
    expect(update.match(/\bversion\b/g)).toHaveLength(3);
    expect(update.match(/\bkey_attempt\b/g)).toHaveLength(2);
    for (const set of [
      'start_at = p_start_at', 'end_at = p_end_at', 'meet_url = p_meet_url',
      'version = case when v_moved then version + 1 else version end',
      'key_attempt = case when v_moved then 0 else key_attempt end',
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
    // Within set_bot, version is bumped only by replace and key_attempt only by rotate_key (reset by
    // replace). The reschedule and create RPCs start new generations of their own (T3-C, T3-G).
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
    let last = suite.indexOf('-- T2-H. ');
    for (const section of ['-- T3-A. ', '-- T3-B. ', '-- T3-C. ', '-- T3-D. ', '-- T3-E. ', '-- T3-F. ', '-- T3-G. ', '-- T3-H. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
      expect(suite.indexOf(section), section).toBeGreaterThan(last);
      last = suite.indexOf(section);
    }
    expect(suite.indexOf('-- T4-A. ')).toBeGreaterThan(last);
    // The review fixes (F1, F2, F3, F6) each have labelled assertions.
    for (const label of [
      'T3-C a new slot alone is a new generation: version 1, key attempt 0',
      'T3-C the bot that the lost slot-A create made cannot attach: version_conflict, no bot',
      'T3-C a reschedule that moves neither the slot nor the link keeps the generation and the key attempt',
      'T3-C a move at generation 50: version_exhausted, nothing written',
      'T3-G the create replay re-binds a blocked booking whose round lapsed: a fresh round, generation 1',
      'T3-G a lapsed round under a scheduled bot: bot_attached, nothing written',
      'T3-G a dispatched booking with a lapsed round: exists, round_live false',
      'T3-G a replay during the slot answers exists, not in_past',
      'T3-G a failed booking that Ashby moved to a future slot is revived on a fresh round, generation 1',
      'T3-G a failed booking whose round is live is revived by re-linking that round',
      'T3-G a moved failed booking that still holds a bot: bot_attached',
      'T3-G a cancelled booking on a moved slot: booking_terminal, nothing written',
      'T3-G a booking on a round HR cancelled: exists, round_live false, nothing written',
      'T3-G a lapsed browser round is left alone: blocked/round_active',
      'T3-G a revival resets the rotated key and the spent arm budget: key attempt 0, no arms, generation 1',
      'T3-G the revived booking arms the bridge ticket for the new slot',
      'T3-G a revival clears the claimed ticket and the bound session of the old attempt',
      'T3-G after the revival the old ticket is unknown; the old session itself is kept',
      'T3-G step 8a leaves a lapsed round held by the live booking of another event: blocked/round_active',
      'T3-G a round the sweep already expired is re-bound by the create replay: a fresh round, generation 1',
      'T3-H reissuing the link of a Meet round raises P0001',
      'T3-H a browser round is reissued unchanged',
      'T3-H exactly one r1-meet round_cancelled job, ids only',
      'T3-H no job for a round with no live booking, a browser round, or an expiry',
      'T2-G a lapsed Meet round is not re-linked: it is expired (hold released) and a fresh round is created',
    ]) {
      expect(suite, label).toContain(label);
    }
    // No fixture shortcut for a cancel is left anywhere.
    expect(suite).not.toMatch(/set status = 'cancelled'/);
    expect(suite).not.toMatch(/T3 replaces/);
    const relink = suite.slice(suite.indexOf('-- T2-G. '), suite.indexOf('-- T2-H. '));
    expect(relink.match(/screening_v2\.r1_meet_cancel_booking\(/g)).toHaveLength(2);
    expect(relink).toContain('_r1_meet_tests.round_state(r_id) = st_before');
  });
});

describe('migration 0142: the bridge ticket, receipts and prune RPCs (T4)', () => {
  const RPCS = [
    {
      name: 'r1_meet_arm_ticket',
      section: '-- §16. ',
      args: 'p_booking_id uuid, p_ticket_digest text, p_not_before timestamptz, p_expires_at timestamptz, '
        + 'p_now timestamptz default now()',
      sig: 'uuid, text, timestamptz, timestamptz, timestamptz',
      statuses: [
        'ok', 'duplicate', 'invalid_ticket', 'invalid_request', 'invalid_window', 'not_found', 'not_armable',
        'digest_in_use', 'ticket_arms_exhausted',
      ],
    },
    {
      name: 'r1_meet_claim_ticket',
      section: '-- §17. ',
      args: 'p_ticket_digest text, p_now timestamptz default now()',
      sig: 'text, timestamptz',
      statuses: [
        'ok', 'invalid_ticket', 'invalid_request', 'ticket_unknown', 'ticket_already_claimed',
        'booking_not_claimable', 'ticket_not_yet_valid', 'ticket_expired', 'round_not_live',
      ],
    },
    {
      name: 'r1_meet_record_receipt',
      section: '-- §18. ',
      args: 'p_source text, p_dedupe_key text, p_event_type text, p_booking_id uuid default null, '
        + 'p_enqueue boolean default false, p_payload jsonb default null, p_scheduled_at timestamptz default null, '
        + 'p_now timestamptz default now()',
      sig: 'text, text, text, uuid, boolean, jsonb, timestamptz, timestamptz',
      statuses: [
        'inserted', 'duplicate', 'invalid_source', 'invalid_dedupe_key', 'invalid_event_type', 'invalid_request',
        'invalid_payload', 'payload_too_large', 'invalid_scheduled_at',
      ],
    },
    {
      name: 'r1_meet_prune_receipts',
      section: '-- §19. ',
      args: 'p_older_than timestamptz, p_limit integer default 500, p_now timestamptz default now()',
      sig: 'timestamptz, integer, timestamptz',
      statuses: ['ok', 'invalid_request', 'retention_too_short'],
    },
    {
      name: 'r1_meet_prune_bookings',
      section: '-- §20. ',
      args: 'p_older_than timestamptz, p_limit integer default 500, p_now timestamptz default now()',
      sig: 'timestamptz, integer, timestamptz',
      statuses: ['ok', 'invalid_request', 'retention_too_short'],
    },
  ] as const;

  /** The plpgsql body of an RPC (after `as $$`), comments stripped, whitespace collapsed. */
  const bodyOf = (name: string): string => {
    const fn = functionBody(name);
    return fn.slice(fn.indexOf(' as $$') + ' as $$'.length);
  };
  const ARMABLE = ['bot_scheduled', 'bot_joining', 'human_present', 'in_call'];
  const armableList = ARMABLE.map((s) => `'${s}'`).join(', ');
  const ROUND_LIVE =
    "if not found or v_round.channel <> 'meet' or v_round.status not in ('invited', 'in_progress') or v_round.expires_at <= p_now then";
  const families = pairingFamilies();
  const familyOf = (status: string) => families.find((f) => f.statuses.includes(status))!.reasons;
  const suite = read('app/supabase/tests/r1_meet_bookings_assert.sql');

  it('sits in sections §16 to §20, in order, between §15 and §90', () => {
    let last = sql.indexOf('-- §15. ');
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
    // The header lists the four new objects.
    const header = sql.slice(0, sql.indexOf("set local lock_timeout = '10s';"));
    for (const rpc of RPCS) expect(header, rpc.name).toContain(`${rpc.section.slice(3).trim().replace('.', '')} ${rpc.name}`);
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
      const answered = new Set([...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!));
      const computed = [...body.matchAll(/'status', (?!')([a-z_]+)/g)].map((m) => m[1]);
      if (rpc.name === 'r1_meet_record_receipt') {
        // The only computed status: inserted or duplicate, from the insert-or-noop.
        expect(computed).toEqual(['case']);
        expect(body).toContain("'status', case when v_created then 'inserted' else 'duplicate' end,");
        answered.add('inserted');
        answered.add('duplicate');
      } else {
        expect(computed, rpc.name).toEqual([]);
      }
      expect([...answered].sort(), rpc.name).toEqual([...rpc.statuses].sort());
    }
  });

  it('reads no clock, catches nothing but the outbox race, writes no session, round or audit row, and returns no secret', () => {
    for (const rpc of RPCS) {
      const bodyLc = bodyOf(rpc.name).toLowerCase();
      expect(bodyLc, rpc.name).not.toMatch(/\bnow\s*\(|\bcurrent_timestamp\b|\bclock_timestamp\s*\(|\bstatement_timestamp\s*\(/);
      expect(bodyLc, rpc.name).not.toMatch(/\bwhen others\b/);
      const handlers = bodyLc.match(/\bexception\s+when\b[^;]*?then/g) ?? [];
      expect(handlers, rpc.name).toEqual(rpc.name === 'r1_meet_record_receipt' ? ['exception when unique_violation then'] : []);
      expect(bodyLc, rpc.name).not.toMatch(/(insert into|update|delete from) screening_v2\.(call_sessions|audit_events|interview_rounds|interview_round_consents|candidates|r1_budget_month|r1_settings)\b/);
      expect(bodyLc, rpc.name).not.toMatch(/r1_transition_round|link_token_digest|r1_send_round|r1_admit_attempt/);
      const returns = [...bodyLc.matchAll(/return jsonb_build_object\(/g)].map((m) => bodyLc.slice(m.index!, bodyLc.indexOf(';', m.index!)));
      expect(returns.length, rpc.name).toBeGreaterThan(1);
      // Values only (string literals blanked): never a digest, a token, a link, the attester, the key or the payload.
      for (const r of returns) {
        expect(r.replace(/'[^']*'/g, "''"), rpc.name).not.toMatch(/digest|token|meet_url|scheduled_by|dedupe_key|payload/);
      }
    }
  });

  it('arms only a bot-holding booking, inside the slot, at most 5 times per generation, and never re-arms a spent digest', () => {
    const body = bodyOf('r1_meet_arm_ticket');
    const BOOKING_LOCK = 'from screening_v2.r1_meet_bookings b where b.id = p_booking_id for update;';
    expect(body.split(BOOKING_LOCK)).toHaveLength(2);
    expect(body.toLowerCase().match(/\bfor update\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/r1_settings|r1_budget_month|interview_rounds/);
    // The digest shape is the table's.
    const tableDigest = /constraint chk_r1_meet_bookings_ticket_digest check \( ticket_digest is null or ticket_digest ~ '([^']+)' \)/.exec(bookings)![1]!;
    expect(body).toContain(`if p_ticket_digest is null or p_ticket_digest !~ '${tableDigest}' then`);
    expect(body).toContain('if p_not_before is null or p_expires_at is null or p_not_before >= p_expires_at or p_expires_at <= p_now then');
    expect(body).toContain(
      "if p_not_before < v_booking.start_at - interval '15 minutes' or p_expires_at > v_booking.end_at + interval '30 minutes' then",
    );
    expect(body).toContain(`if v_booking.status not in (${armableList}) then return jsonb_build_object('status', 'not_armable'`);
    // Every armable status may hold a ticket (chk_r1_meet_bookings_ticket).
    const ticketStatuses = quoted(/or status in \(([^)]*)\)\) \)/.exec(block('constraint chk_r1_meet_bookings_ticket check (', 'create unique index'))![1]!);
    for (const s of ARMABLE) expect(ticketStatuses, s).toContain(s);
    // The arm budget is the table's cap.
    expect(body).toContain("if v_booking.ticket_arms >= 5 then return jsonb_build_object('status', 'ticket_arms_exhausted'");
    expect(bookings).toContain('check (ticket_arms between 0 and 5)');
    // A spent digest is refused before the idempotent duplicate and before the budget.
    const order = [
      "'status', 'invalid_ticket'", "'status', 'invalid_request', 'field', 'now'", "'status', 'invalid_window')", BOOKING_LOCK,
      "'status', 'not_found'", "'status', 'invalid_window', 'booking_id'", "'status', 'not_armable'",
      'if v_booking.ticket_digest = p_ticket_digest then if v_booking.ticket_claimed_at is not null then return jsonb_build_object(\'status\', \'digest_in_use\'',
      "'status', 'duplicate'", "'status', 'ticket_arms_exhausted'",
      'where o.ticket_digest = p_ticket_digest and o.id <> v_booking.id) then return jsonb_build_object(\'status\', \'digest_in_use\'',
      "'status', 'ok'",
    ];
    let last = -1;
    for (const step of order) {
      expect(body.indexOf(step), step).toBeGreaterThan(last);
      last = body.indexOf(step);
    }
    expect(body).toContain('if v_booking.ticket_not_before = p_not_before and v_booking.ticket_expires_at = p_expires_at then');
    // The write: the ticket and its window, unclaimed, one more arm; the status never moves.
    const start = body.indexOf('update screening_v2.r1_meet_bookings set');
    const update = body.slice(start, body.indexOf(';', start));
    expect(update).toBe(
      'update screening_v2.r1_meet_bookings set ticket_digest = p_ticket_digest, ticket_not_before = p_not_before, '
      + 'ticket_expires_at = p_expires_at, ticket_claimed_at = null, ticket_arms = ticket_arms + 1, updated_at = p_now '
      + 'where id = v_booking.id returning * into v_booking',
    );
    expect(body.match(/\bupdate screening_v2\./g)).toHaveLength(1);
  });

  it('claims a ticket once, under the row lock, inside its window, on a live Meet round, and answers the binding', () => {
    const body = bodyOf('r1_meet_claim_ticket');
    const CLAIM_LOCK = 'from screening_v2.r1_meet_bookings b where b.ticket_digest = p_ticket_digest for update;';
    expect(body.split(CLAIM_LOCK)).toHaveLength(2);
    expect(body.toLowerCase().match(/\bfor update\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/r1_settings|r1_budget_month/);
    const order = [
      "'status', 'invalid_ticket'", "'status', 'invalid_request', 'field', 'now'", CLAIM_LOCK, "'status', 'ticket_unknown'",
      "if v_booking.ticket_claimed_at is not null then return jsonb_build_object('status', 'ticket_already_claimed', 'booking_id', v_booking.id);",
      `if v_booking.status not in (${armableList}) then return jsonb_build_object('status', 'booking_not_claimable'`,
      "if p_now < v_booking.ticket_not_before then return jsonb_build_object('status', 'ticket_not_yet_valid'",
      "if p_now >= v_booking.ticket_expires_at then return jsonb_build_object('status', 'ticket_expired'",
      ROUND_LIVE, "'status', 'round_not_live'", 'update screening_v2.r1_meet_bookings set', "'status', 'ok'",
    ];
    let last = -1;
    for (const step of order) {
      expect(body.indexOf(step), step).toBeGreaterThan(last);
      last = body.indexOf(step);
    }
    // The same "live round" as the reschedule and the attach.
    expect(bodyOf('r1_meet_reschedule_booking')).toContain(ROUND_LIVE);
    // Single use: claimed at p_now, in_call (paired with eligible); only the booking row is written.
    expect(body).toContain(
      "set ticket_claimed_at = p_now, status = 'in_call', reason = 'eligible', updated_at = p_now where id = v_booking.id",
    );
    expect(familyOf('in_call')).toContain('eligible');
    expect(body.match(/\bupdate screening_v2\./g)).toHaveLength(1);
    expect(body).toContain('select * into v_round from screening_v2.interview_rounds r where r.id = v_booking.round_id;');
    const ok = body.slice(body.indexOf("return jsonb_build_object('status', 'ok'"));
    expect([...ok.slice(0, ok.indexOf(';')).matchAll(/'([a-z_]+)', v_booking\.([a-z_]+)/g)].map((m) => `${m[1]}=${m[2]}`)).toEqual([
      'booking_id=id', 'round_id=round_id', 'candidate_id=candidate_id', 'objective_profile=objective_profile',
      'ashby_interview_event_id=ashby_interview_event_id', 'session_id=session_id', 'start_at=start_at', 'end_at=end_at',
    ]);
  });

  it('records a receipt with the table rules and runs the 0030 outbox into the one r1-meet queue', () => {
    const rpc = RPCS.find((r) => r.name === 'r1_meet_record_receipt')!;
    const body = bodyOf(rpc.name);
    // The caller cannot name a queue, a dedup key or an attempt budget.
    const names = rpc.args.split(', ').map((p) => p.split(' ')[0]);
    expect(names).toEqual([
      'p_source', 'p_dedupe_key', 'p_event_type', 'p_booking_id', 'p_enqueue', 'p_payload', 'p_scheduled_at', 'p_now',
    ]);
    expect(lc).not.toMatch(/function screening_v2\.r1_meet_record_receipt\([^)]*\b(p_queue\w*|p_dedup_key|p_max_attempts|p_name)\b/);
    expect(body).not.toMatch(/\bp_queue\w*|\bp_dedup_key\b|\bp_max_attempts\b/);
    // Validation = the table CHECKs (no 23514 reaches the caller).
    expect(body).toContain("if p_source is null or p_source not in ('recall', 'ashby') then");
    expect(receipts).toContain("check (source in ('recall', 'ashby'))");
    const keyCheck = /char_length\(dedupe_key\) between 1 and (\d+) and dedupe_key ~ '([^']+)'/.exec(receipts)!;
    expect(body).toContain(
      `if p_dedupe_key is null or char_length(p_dedupe_key) not between 1 and ${keyCheck[1]} or p_dedupe_key !~ '${keyCheck[2]}' `
      + "or (p_source = 'ashby') <> (p_dedupe_key like 'ashby-schedule:%') then",
    );
    expect(receipts).toContain("(source = 'ashby') = (dedupe_key like 'ashby-schedule:%')");
    const eventRe = /constraint chk_r1_meet_receipts_event_type check \(event_type ~ '([^']+)'\)/.exec(receipts)![1]!;
    expect(body).toContain(`if p_event_type is null or p_event_type !~ '${eventRe}' then`);
    expect(body).toContain(
      "or jsonb_typeof(p_payload) <> 'object' or jsonb_typeof(p_payload -> 'kind') is distinct from 'string' "
      + "or (p_payload ->> 'kind') !~ '^[a-z][a-z0-9_]{0,39}$' then",
    );
    expect(body).toContain("if octet_length(p_payload::text) > 4096 then return jsonb_build_object('status', 'payload_too_large');");
    expect(body).toContain("elsif p_payload is not null then return jsonb_build_object('status', 'invalid_payload');");
    expect(body).toContain(
      "if p_scheduled_at is not null and (not v_enqueue or p_scheduled_at < p_now - interval '1 hour' "
      + "or p_scheduled_at > p_now + interval '30 days') then",
    );
    // An unknown booking is stored as NULL: looked up (key share, so it outlives the insert), never refused.
    expect(body).toContain('select b.id into v_booking_id from screening_v2.r1_meet_bookings b where b.id = p_booking_id for key share;');
    expect(body).not.toMatch(/'status', 'not_found'|booking_not_found/);
    // Insert-or-report-duplicate, then the locked winner.
    expect(body).toContain('on conflict (dedupe_key) do nothing returning id, outcome, booking_id into v_id, v_outcome, v_linked;');
    expect(body).toContain('from screening_v2.r1_meet_receipts r where r.dedupe_key = p_dedupe_key for update; exit when found; end loop;');
    expect(body).toContain("case when v_enqueue then 'enqueued' else 'recorded' end, p_now)");
    // The outbox: settled outcomes, the live statuses of the 0009 partial index, one job named r1-meet.
    const outcomes = quoted(/check \( outcome in \(([^)]*)\) \)/.exec(receipts)![1]!);
    const settled = outcomes.filter((o) => !['recorded', 'enqueued'].includes(o));
    expect(body).toContain(`if v_outcome in (${settled.map((o) => `'${o}'`).join(', ')}) then v_work_pending := true;`);
    const live = /where dedup_key is not null and status in \(([^)]*)\)/.exec(
      readFileSync(path.join(migrations, '0009_queue.sql'), 'utf8').replace(/\s+/g, ' '),
    )![1]!;
    expect(body).toContain(`and j.status in (${live})`);
    const jobKey = "'r1-meet:receipt:' || v_id::text";
    expect(body.split(jobKey)).toHaveLength(3);
    expect(body.match(/insert into screening_v2\.job_queue\b/g)).toHaveLength(1);
    expect(body).toContain(
      'insert into screening_v2.job_queue (name, payload, status, dedup_key, attempts, max_attempts, priority, scheduled_at, created_at) '
      + "values ('r1-meet', p_payload || jsonb_build_object('receipt_id', v_id, 'source', p_source), "
      + `'pending', ${jobKey}, 0, 5, 0, coalesce(p_scheduled_at, p_now), p_now);`,
    );
    expect(body).toContain('exception when unique_violation then v_work_pending := true; end;');
    // The re-drive runs while the receipt is enqueued; a recorded-only receipt asked for work becomes enqueued.
    expect(body).toContain(
      "if not v_created and v_enqueue and v_outcome = 'recorded' then update screening_v2.r1_meet_receipts set outcome = 'enqueued' where id = v_id",
    );
    expect(body.match(/\bupdate screening_v2\.r1_meet_receipts\b/g)).toHaveLength(1);
    // Lock order: the booking, then the receipt.
    expect(body.indexOf('for key share')).toBeLessThan(body.indexOf('insert into screening_v2.r1_meet_receipts'));
  });

  it('prunes only settled receipts older than the cutoff, in bounded batches, never under 7 days of retention', () => {
    const body = bodyOf('r1_meet_prune_receipts');
    const fields = [...body.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(fields).toEqual(['now', 'older_than', 'limit']);
    expect(body).toContain('if p_limit is null or p_limit not between 1 and 5000 then');
    expect(body).toContain("if p_older_than > p_now - interval '7 days' then return jsonb_build_object('status', 'retention_too_short');");
    // Review F5: an enqueued receipt goes once no live job (the 0009 live set) can settle it.
    const live = /where dedup_key is not null and status in \(([^)]*)\)/.exec(
      readFileSync(path.join(migrations, '0009_queue.sql'), 'utf8').replace(/\s+/g, ' '),
    )![1]!;
    expect(body).toContain(
      'delete from screening_v2.r1_meet_receipts where id in ( select r.id from screening_v2.r1_meet_receipts r '
      + "where r.received_at < p_older_than and (r.outcome in ('recorded', 'processed', 'ignored', 'failed') "
      + "or (r.outcome = 'enqueued' and not exists (select 1 from screening_v2.job_queue j "
      + `where j.dedup_key = 'r1-meet:receipt:' || r.id::text and j.status in (${live})))) `
      + 'order by r.received_at limit p_limit for update skip locked);',
    );
    expect(body).toContain('get diagnostics v_deleted = row_count;');
    expect(body.match(/\bdelete from\b/g)).toHaveLength(1);
    // Every outcome but enqueued (work in flight) is prunable outright.
    const outcomes = quoted(/check \( outcome in \(([^)]*)\) \)/.exec(receipts)![1]!);
    const prunable = quoted(/r\.outcome in \(([^)]*)\)/.exec(body)![1]!);
    expect([...prunable, 'enqueued'].sort()).toEqual([...outcomes].sort());
    // The job key is the outbox's own.
    expect(bodyOf('r1_meet_record_receipt')).toContain("'r1-meet:receipt:' || v_id::text");
  });

  it('prunes only round-less bookings that hold no bot, whose slot ended before the cutoff, never under 7 days (review F5)', () => {
    const body = bodyOf('r1_meet_prune_bookings');
    const fields = [...body.matchAll(/'status', 'invalid_request', 'field', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(fields).toEqual(['now', 'older_than', 'limit']);
    expect(body).toContain('if p_limit is null or p_limit not between 1 and 5000 then');
    expect(body).toContain("if p_older_than > p_now - interval '7 days' then return jsonb_build_object('status', 'retention_too_short');");
    expect(body).toContain(
      'delete from screening_v2.r1_meet_bookings where id in ( select b.id from screening_v2.r1_meet_bookings b '
      + 'where b.round_id is null and b.recall_bot_id is null and b.end_at < p_older_than '
      + 'order by b.end_at limit p_limit for update skip locked);',
    );
    expect(body.match(/\bdelete from\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/\bupdate screening_v2\.|\binsert into\b/);
    // A booking with a round goes only with its round (the cascade): the predicate never reaches it.
    expect(bookings).toContain('round_id uuid references screening_v2.interview_rounds(id) on delete cascade');
  });

  it('ends with exactly the eleven RPCs and the four trigger functions, each RPC revoked and granted to service_role', () => {
    // Lazy up to the first " ) returns": a parameter default such as now() cannot end the list early.
    const created = [...code.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\(([\s\S]*?) ?\) returns /g)]
      .map((m) => {
        const params = m[2]!.trim();
        const types = params === '' ? '' : params.split(', ').map((p) => p.split(' ')[1]).join(', ');
        return `${m[1]}(${types})`;
      });
    const RPC_SIGS = [
      'r1_meet_create_round_from_ashby(uuid, text, text, text, text, text, timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz)',
      'r1_meet_reschedule_booking(uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz)',
      'r1_meet_cancel_booking(uuid, text, timestamptz)',
      'r1_meet_set_bot(uuid, text, integer, integer, uuid, timestamptz)',
      'r1_meet_transition_booking(uuid, text, text, text, timestamptz)',
      'r1_meet_bind_session(uuid, uuid, timestamptz)',
      'r1_meet_arm_ticket(uuid, text, timestamptz, timestamptz, timestamptz)',
      'r1_meet_claim_ticket(text, timestamptz)',
      'r1_meet_record_receipt(text, text, text, uuid, boolean, jsonb, timestamptz, timestamptz)',
      'r1_meet_prune_receipts(timestamptz, integer, timestamptz)',
      'r1_meet_prune_bookings(timestamptz, integer, timestamptz)',
    ];
    const TRIGGER_FNS = [
      'reject_interview_round_channel_change()',
      'enqueue_r1_meet_bot_release()',
      'reject_meet_round_link_reissue()',
      'enqueue_r1_meet_round_cancelled()',
    ];
    expect(created).toEqual([...TRIGGER_FNS, ...RPC_SIGS]);
    for (const sig of RPC_SIGS) {
      expect(code, sig).toContain(`revoke all on function screening_v2.${sig} from public, anon, authenticated;`);
      expect(code, sig).toContain(`grant execute on function screening_v2.${sig} to service_role;`);
      expect(code, sig).toContain(`comment on function screening_v2.${sig} is`);
    }
    expect(lc.match(/\bgrant execute on function\b/g)).toHaveLength(RPC_SIGS.length);
    expect(lc.match(/\brevoke all on function\b/g)).toHaveLength(RPC_SIGS.length + TRIGGER_FNS.length);
    // The SQL suite's privilege proof names exactly these eleven.
    const proof = suite.slice(suite.indexOf('-- T4-D. '));
    const listed = quoted(/rpcs constant text\[\] := array\[([\s\S]*?)\];/.exec(proof)![1]!);
    expect(listed).toEqual(RPC_SIGS.map((s) => `screening_v2.${s}`));
    const denied = quoted(/denied_calls constant text\[\] := array\[([\s\S]*?)\];/.exec(proof)![1]!);
    expect(denied.map((c) => /screening_v2\.([a-z0-9_]+)\(/.exec(c)![1])).toEqual(RPC_SIGS.map((s) => s.slice(0, s.indexOf('('))));
    for (const sig of RPC_SIGS) {
      const name = sig.slice(0, sig.indexOf('('));
      expect(proof, name).toContain(`_r1_meet_tests.runs_as('service_role', 'T4-D ${name}'`);
    }
  });

  it('is exercised by the SQL suite, with a labelled assertion for every case the brief lists', () => {
    for (const rpc of RPCS) expect(suite, rpc.name).toContain(`screening_v2.${rpc.name}(`);
    let last = suite.indexOf('-- T3-F. ');
    expect(last).toBeGreaterThan(-1);
    for (const section of ['-- T4-A. ', '-- T4-B. ', '-- T4-C. ', '-- T4-D. ']) {
      expect(suite.split(section).length - 1, section).toBe(1);
      expect(suite.indexOf(section), section).toBeGreaterThan(last);
      last = suite.indexOf(section);
    }
    for (const label of [
      // The ticket: armable states, the window, single use, replay, expiry, re-arm, the budget.
      'T4-A arm on a pending booking: not_armable',
      'T4-A arm on a bot_scheduled booking with the widest window',
      'T4-A arm on a bot_joining booking: ok',
      'T4-A arm on a human_present booking: ok',
      'T4-A a window opening before start - 15 min: invalid_window',
      'T4-A a window closing after end + 30 min: invalid_window',
      'T4-A an empty window (not_before = expires_at): invalid_window',
      'T4-A a window already closed (expires_at = p_now): invalid_window',
      'T4-A a claim before not_before: ticket_not_yet_valid',
      'T4-A a claim inside the window: ok with the booking, round, candidate, profile, event',
      'T4-A the claim moved the booking to in_call and spent the ticket',
      'T4-A a second claim of the same ticket: ticket_already_claimed with the booking id',
      'T4-A a replay after the window closed: still ticket_already_claimed',
      'T4-A a claim at expires_at: ticket_expired',
      'T4-A a claim of a ticket never armed: ticket_unknown',
      "T4-A a claim of ''xyz'': invalid_ticket",
      'T4-A a claim on a cancelled booking that still holds an unclaimed ticket: booking_not_claimable',
      'T4-A arming a digest another booking holds (unclaimed): digest_in_use',
      'T4-A re-arming the spent (claimed) digest: digest_in_use',
      'T4-A a re-arm in in_call: ok, a fresh unclaimed ticket',
      'T4-A the same unclaimed ticket and window again: duplicate',
      'T4-A a sixth arm in one bot generation: ticket_arms_exhausted',
      'T4-A a claim whose round is not a Meet round (channel browser): round_not_live',
      'T4-A a claim whose Meet round was cancelled: round_not_live',
      'T4-A no call_sessions row was created by any arm or claim',
      // Receipts: dedupe, the outbox, re-drive, settled work, the booking link, the S01 key.
      'T4-B a first delivery without work: inserted, recorded, nothing queued',
      'T4-B the same dedupe key again: duplicate with the same id',
      'T4-B exactly one r1-meet job',
      'T4-B a duplicate while the job is live: no second job',
      'T4-B the job finished but the receipt is still enqueued: the duplicate re-drives exactly one job',
      'T4-B a processed receipt: the duplicate queues nothing',
      'T4-B a recorded-only receipt asked for work by a later delivery',
      'T4-B an unknown booking id is stored as NULL',
      'T4-B the 86-character S01 Ashby key is accepted by the RPC',
      'T4-B the refused deliveries wrote no receipt and queued no job',
      // The prune.
      'T4-C six days of retention: retention_too_short',
      'T4-C a limit of 0: invalid_request (limit)',
      'T4-C a batch of 2: the two oldest settled receipts go; the older enqueued one stays',
      'T4-C the rest: old ignored, failed and recorded receipts go; enqueued and recent ones stay',
      // The privilege proof (anon / authenticated refused; service_role runs every RPC).
      "'T4-D execute ' || split_part(fn, '(', 1)",
      "'T4-D ' || fn || ' is executable by service_role only (catalog)'",
      "'T4-D ' || fn || ' is security definer with search_path pg_catalog, screening_v2'",
      "'T4-D select from ' || tbl", "'T4-D insert into ' || tbl", "'T4-D update ' || tbl", "'T4-D delete from ' || tbl",
      "'T4-D service_role reads ' || tbl",
      'T4-D the eleven RPCs are the only screening_v2 functions named r1_meet_*, one overload each',
      // The retention fixes (review F5).
      'T4-C an old enqueued receipt whose job dead-lettered goes; one whose job is still live stays',
      'T4-C (bookings) a batch of 2: the two oldest round-less bookings go',
      'T4-C (bookings) the rest: a terminal round-less booking goes; a booking with a round and a recent one stay',
      'T4-C (bookings) six days after the slot: retention_too_short',
      'T4-D the service_role calls left nothing behind (rolled back)',
    ]) {
      expect(suite, label).toContain(label);
    }
    // Every refusal code of the receipt RPC has a row in the refusal table.
    const refusals = RPCS.find((r) => r.name === 'r1_meet_record_receipt')!.statuses.filter((s) => !['inserted', 'duplicate'].includes(s));
    const t4b = suite.slice(suite.indexOf('-- T4-B. '), suite.indexOf('-- T4-C. '));
    for (const code of refusals) expect(t4b, code).toContain(`('${code}', `);
    // The anon / authenticated refusals and the service_role runs go through the role helpers.
    const t4d = suite.slice(suite.indexOf('-- T4-D. '));
    expect(t4d).toContain("foreach who in array array['anon', 'authenticated'] loop");
    expect(t4d.match(/_r1_meet_tests\.raises_as\(who, /g)).toHaveLength(5);
    expect(t4d.match(/'42501'\);/g)!.length).toBe(5);
    expect(t4d.match(/_r1_meet_tests\.runs_as\('service_role', /g)).toHaveLength(12);
    // Ticket digests are computed at run time, never written.
    const t4 = suite.slice(suite.indexOf('-- T4-A. '));
    expect(t4).not.toMatch(/'[a-f0-9]{16,}'/);
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

describe('migration 0142: docs (T5)', () => {
  /** The text from `heading` up to the next heading of the same or a higher level. */
  function section(doc: string, heading: string, level: number): string {
    const start = doc.indexOf(`\n${heading}\n`);
    expect(start, heading).toBeGreaterThan(-1);
    const rest = doc.slice(start + heading.length + 2);
    const next = rest.search(new RegExp(`\\n#{1,${level}} `));
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('docs/data-classification.md classifies both tables and every new column, after the 0141 section', () => {
    const doc = read('docs/data-classification.md');
    const heading = '### R1 Meet bookings (0142, M034)';
    expect(doc.indexOf(heading)).toBeGreaterThan(doc.indexOf('### Ashby pipeline progress written by the webhook nudge (0141, M031 S4)'));
    expect(doc.indexOf(heading)).toBeLessThan(doc.indexOf('## Classification summary'));
    const text = section(doc, heading, 3);
    expect(text).toContain(FILE);
    for (const table of ['r1_meet_bookings', 'r1_meet_receipts']) expect(text).toContain(`screening_v2.${table}`);
    const row = (column: string): string => {
      const line = text.split('\n').find((l) => l.startsWith('| ') && l.split('|')[1]!.includes(`\`${column}\``));
      expect(line, column).toBeDefined();
      return line!;
    };
    expect(row('ticket_digest')).toContain('**Secret**');
    expect(row('meet_url')).toContain('**Confidential**');
    expect(row('ashby_scheduled_by_user_id')).toContain('**Confidential**');
    expect(row('interview_round_consents.attested_by_external_id')).toContain('**Confidential**');
    for (const column of [
      'recall_bot_id',
      'status',
      'version',
      'start_at',
      'interview_rounds.channel',
      'interview_round_consents.method',
      'interview_round_consents.attested_at',
      'interview_round_consents.india_location_attested',
    ]) {
      expect(row(column), column).toContain('| Internal |');
    }
    // Every column of both tables is named in the first cell of a classification row.
    const columnsOf = (create: string): string[] =>
      [...create.matchAll(/(?:\( |, )([a-z_]+) (?:uuid|text|integer|timestamptz|boolean)\b/g)].map((m) => m[1]!);
    const classified = (table: string): Set<string> => {
      const part = section(text, `#### \`screening_v2.${table}\``, 4);
      const firstCells = part.split('\n').filter((l) => l.startsWith('| ')).map((l) => l.split('|')[1]!);
      return new Set(firstCells.flatMap((cell) => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!)));
    };
    const bookingColumns = columnsOf(bookings);
    const receiptColumns = columnsOf(receipts);
    expect(bookingColumns).toHaveLength(27);
    expect(receiptColumns).toHaveLength(8);
    for (const column of bookingColumns) expect(classified('r1_meet_bookings').has(column), column).toBe(true);
    for (const column of receiptColumns) expect(classified('r1_meet_receipts').has(column), column).toBe(true);
    // DSAR, the bot release, retention and the job payload rule.
    expect(text).toContain('ON DELETE CASCADE');
    expect(text).toContain('enqueue_r1_meet_bot_release');
    expect(text).toContain("kind: 'bot_release'");
    expect(text).toContain('r1_meet_prune_receipts');
    expect(text).toMatch(/30 days/);
    expect(text).toMatch(/less than 7 days/);
    expect(text).toContain('scheduledByEmail');
    // Review F5: round-less bookings, dead-lettered receipts, job rows and the round-cancel job.
    expect(text).toContain('r1_meet_prune_bookings');
    expect(text).toContain('whose job is no longer live');
    expect(text).toContain('enqueue_r1_meet_round_cancelled');
    expect(text).toContain("kind: 'round_cancelled'");
    expect(text).toContain('reap_completed_jobs');
    expect(text).toContain('job_dlq');
    expect(text).toContain('Only\nan Ashby interview-schedule job may also carry the canonical Meet URL');
    expect(text).not.toContain('Clearing stale unmatched bookings is left to the runtime slices');
  });

  it('docs/runbooks/r1-operations.md has the 0142 deploy note between the 0119 note and Scoring', () => {
    const doc = read('docs/runbooks/r1-operations.md');
    const heading = '### Deploying 0142 (M034 S02, Meet bookings, dark)';
    expect(doc.indexOf(heading)).toBeGreaterThan(doc.indexOf('### Deploying 0119'));
    expect(doc.indexOf(heading)).toBeLessThan(doc.indexOf('## Scoring, status effects and the override monitor'));
    const text = section(doc, heading, 3);
    expect(text).toContain('R1_MEET_ENABLED');
    expect(text).toContain("status in ('created', 'waiting', 'in_progress')");
    expect(text).toMatch(/14 days/);
    expect(text).toMatch(/last 72 hours/);
    expect(text).toContain('consent_missing');
    expect(text).toContain('bot_release');
    expect(text).toContain('r1-meet:bot-release:');
    expect(text).toMatch(/forward-only/);
    // Review F4: the template-release recovery is a new HR act after the old booking is cancelled
    // (a new event while it is live is refused), never an automatic re-attestation.
    expect(text).toContain('Nothing re-attests automatically');
    expect(text).toContain('HR cancels the Lexy interview');
    expect(text).toContain('`blocked/round_active`, so the cancel comes first');
    expect(text).not.toContain('Recovery: HR schedules a new Lexy event in Ashby. The Meet round RPC then');
    // Review F1 and F3: per-event recovery and the fenced round actions.
    expect(text).toContain('`rebound: true`');
    expect(text).toContain('r1-meet:round-cancelled:');
    expect(text).toContain('503 `service_unavailable`');
    // Its SQL is read-only.
    const sqlBlocks = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.replace(/--.*$/gm, ''));
    expect(sqlBlocks.length).toBeGreaterThan(0);
    for (const block of sqlBlocks) expect(block).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
  });
});
