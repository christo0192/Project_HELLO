/**
 * M034 S06 T2: the in-memory 0142 port (support/r1-meet-fake-db.ts) is held to the migration text, so
 * the runtime suites that run on it cannot drift from the database they stand in for.
 *
 * Pinned:
 *  - the status/reason pairing and the transition matrix equal the SQL of
 *    `chk_r1_meet_bookings_status_reason` (as 0143 swapped it: 0142's pairs plus two) and
 *    `r1_meet_transition_booking` (0142);
 *  - every answer of every RPC the runtime and the bridge page call is reachable through the port, and
 *    the set of answers equals the RPC's catalog comment (the one answer the CHECKs make unreachable is
 *    named, with why);
 *  - a write that breaks a CHECK (pairing, round and bot binding, ticket, counters) answers
 *    `{ code: '23514' }` and rolls the whole call back; a unique index answers `23505`;
 *  - the first refusal wins, in the SQL's order;
 *  - the tables answer the store's reads (projection, count, JSON paths, compare-and-set update), the
 *    two triggers, the queue dedup, and `failNext`;
 *  - (M035 S02) the `source` column of 0143 and its two CHECKs (`chk_r1_meet_bookings_source`,
 *    `chk_r1_meet_bookings_source_ids`), and the public seed (`seedPublicBooking`, `createPublicBooking`);
 *  - (M035 S05) the calendar half of 0143: the public columns' CHECKs and unique indexes, the throttle
 *    table, the three RPCs `r1_meet_public_set_manage_digest`, `r1_meet_public_set_calendar_state`
 *    (its `v_allowed` matrix) and `r1_meet_public_throttle_prune` (every answer, its keys, the refusal
 *    order), the two triggers (payloads, dedup keys, attempts, WHEN clauses; opt-in, off by default),
 *    and the public seed's calendar defaults.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { R1_MEET_BOOKING_REASONS, R1_MEET_BOOKING_STATUSES } from '../lib/r1/meet/bookings-read.js';
import { R1_MEET_BOOKING_COLUMNS, R1_MEET_RPC_ANSWERS, type R1MeetRpcName } from '../lib/r1/meet/runtime-store.js';
import { r1MeetTicketDigest, r1MeetTicketWindow } from '../lib/r1/meet/ticket.js';
import {
  FAKE_CALENDAR_ALLOWED_FROM,
  FAKE_CALENDAR_STATES,
  FAKE_PUBLIC_TRIGGER_RULES,
  FAKE_STATUS_REASONS,
  FAKE_TRANSITIONS,
  createR1MeetFakeDb,
  type FakeAnswer,
  type R1MeetFakeDb,
  type Row,
} from './support/r1-meet-fake-db.js';
import {
  BRIDGE_SOURCE,
  MEET_URL,
  OTHER_MEET_URL,
  SCHEDULER_ID,
  STAFF_USER_ID,
  createR1MeetHarness,
  fixtureId,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';

// ── Migration 0142 ───────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql'), 'utf8').replace(/\r\n/g, '\n');
const sql = raw.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');
const quoted = (list: string): string[] => [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
/** Migration 0143 (M035 S01), comments stripped and whitespace collapsed as `sql`. */
const sql0143 = readFileSync(path.resolve(here, '../../../supabase/migrations/0143_r1_meet_public_bookings.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/^\s*--.*$/gm, '')
  .replace(/\s+/g, ' ');

/** The reasons of each status in one `chk_r1_meet_bookings_status_reason` text (8 families). */
function statusReasons(block: string): Record<string, string[]> {
  const pairs = [...block.matchAll(/status in \(([^)]*)\) and reason in \(([^)]*)\)/g)];
  expect(pairs.length).toBe(8);
  const out: Record<string, string[]> = {};
  for (const [, statuses, reasons] of pairs) {
    for (const s of quoted(statuses!)) out[s] = [...(out[s] ?? []), ...quoted(reasons!)];
  }
  return out;
}

function functionText(name: string): string {
  const start = sql.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

function catalogAnswers(name: string, text0: string = sql): string[] {
  const statement = new RegExp(String.raw`comment on function screening_v2\.${name}\([^)]*\) is ((?:'(?:[^']|'')*' ?)+);`).exec(text0);
  expect(statement, name).not.toBeNull();
  const text = [...statement![1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!).join('');
  const list = text.slice(text.indexOf('Answers ') + 'Answers '.length);
  return list.split('|').map((part) => /^\s*([a-z_]+)/.exec(part)?.[1] ?? `unreadable: ${part}`);
}

/** `functionText` over 0143 (M035 S05). */
function functionText0143(name: string): string {
  const start = sql0143.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql0143.slice(start, sql0143.indexOf('$$;', start));
}

/** `catalogAnswers` over 0143 (M035 S05). */
function catalogAnswers0143(name: string): string[] {
  return catalogAnswers(name, sql0143);
}

/**
 * Every `return jsonb_build_object(...)` of one function text, as `status -> its sorted keys`, and the
 * `invalid_request` fields in their order (the refusal order).
 */
function answerShapes(fn: string): { shapes: Record<string, string[]>; fields: string[] } {
  const shapes: Record<string, string[]> = {};
  const fields: string[] = [];
  for (const [, args] of fn.matchAll(/return jsonb_build_object\(([^;]*)\);/g)) {
    const parts = args!.split(', ');
    const keys = parts.filter((_, i) => i % 2 === 0).map((part) => part.replace(/'/g, '')).sort();
    const answer = parts[1]!.replace(/'/g, '');
    if (shapes[answer] !== undefined) expect(shapes[answer], answer).toEqual(keys);
    shapes[answer] = keys;
    if (answer === 'invalid_request') fields.push(parts[3]!.replace(/'/g, ''));
  }
  return { shapes, fields };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2030-01-01T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

async function call(db: R1MeetFakeDb, name: string, args: Record<string, unknown>): Promise<FakeAnswer> {
  return (await db.client.rpc(name as never, args as never)) as unknown as FakeAnswer;
}
async function status(db: R1MeetFakeDb, name: string, args: Record<string, unknown>): Promise<string> {
  const answer = await call(db, name, args);
  if (answer.error) return `error:${answer.error.code}`;
  return (answer.data as Row).status as string;
}

function createArgs(applicationId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    p_ashby_interview_event_id: fixtureId(),
    p_ashby_schedule_id: fixtureId(),
    p_ashby_application_id: applicationId,
    p_ashby_interview_stage_id: null,
    p_ashby_interview_id: null,
    p_ashby_scheduled_by_user_id: SCHEDULER_ID,
    p_attested_at: NOW,
    p_ashby_updated_at: NOW,
    p_meet_url: MEET_URL,
    p_start_at: at(DAY),
    p_end_at: at(DAY + 45 * MIN),
    p_created_by: STAFF_USER_ID,
    p_objective_profile: 'r1_dex_sales',
    p_expiry_grace_sec: 7200,
    p_now: NOW,
    ...over,
  };
}

function rescheduleArgs(bookingId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    p_booking_id: bookingId,
    p_expected_version: 0,
    p_start_at: at(DAY + 60 * MIN),
    p_end_at: at(DAY + 105 * MIN),
    p_meet_url: OTHER_MEET_URL,
    p_ashby_updated_at: NOW,
    p_expiry_grace_sec: 7200,
    p_now: NOW,
    ...over,
  };
}

const setBotArgs = (bookingId: string, action: string, over: Record<string, unknown> = {}) => ({
  p_booking_id: bookingId,
  p_action: action,
  p_expected_version: 0,
  p_expected_key_attempt: 0,
  p_recall_bot_id: null,
  p_now: NOW,
  ...over,
});

/** A `pending` booking with a live Meet round, through the create RPC. */
async function pending(h: R1MeetHarness, eventId = fixtureId()): Promise<Row> {
  const created = await h.createBooking({ eventId });
  return h.db.booking(created.bookingId)!;
}

/** A `bot_scheduled` booking holding `botId`. */
async function scheduled(h: R1MeetHarness, botId = fixtureId()): Promise<Row> {
  const booking = await pending(h);
  expect(await status(h.db, 'r1_meet_set_bot', setBotArgs(booking.id, 'attach', { p_recall_bot_id: botId }))).toBe('ok');
  return h.db.booking(booking.id)!;
}

async function move(h: R1MeetHarness, booking: Row, from: string, to: string, reason: string): Promise<void> {
  expect(
    await status(h.db, 'r1_meet_transition_booking', { p_booking_id: booking.id, p_from_status: from, p_to_status: to, p_reason: reason, p_now: NOW }),
  ).toBe('ok');
}

const ticketOf = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');
const digestOf = (fill: number): string => r1MeetTicketDigest(ticketOf(fill), BRIDGE_SOURCE)!;

function armArgs(booking: Row, digest: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const window = r1MeetTicketWindow({ startAt: booking.start_at, endAt: booking.end_at, botJoinLeadSec: 120, nowMs: NOW_MS })!;
  return {
    p_booking_id: booking.id,
    p_ticket_digest: digest,
    p_not_before: window.not_before,
    p_expires_at: window.expires_at,
    p_now: NOW,
    ...over,
  };
}

function expectAnswerSet(name: string, seen: Set<string>, expected: readonly string[]): void {
  expect([...seen].sort(), name).toEqual([...expected].sort());
}

// ── The port's vocabulary is the migration's ─────────────────────────────────

describe('the port is pinned to the 0142 text', () => {
  it('chk_r1_meet_bookings_status_reason: the reasons of each status are 0143 swapped CHECK (0142 plus two)', () => {
    const start = sql.indexOf('constraint chk_r1_meet_bookings_status_reason check (');
    const from0142 = statusReasons(sql.slice(start, sql.indexOf('constraint chk_r1_meet_bookings_version', start)));
    // 0143 (M035 S01) drops and re-adds the CHECK: this text is the one the database enforces.
    const start0143 = sql0143.indexOf('add constraint chk_r1_meet_bookings_status_reason check (');
    expect(start0143, '0143 chk_r1_meet_bookings_status_reason').toBeGreaterThan(-1);
    const fromSql = statusReasons(sql0143.slice(start0143, sql0143.indexOf(') not valid;', start0143)));
    expect(Object.keys(fromSql)).toEqual(Object.keys(from0142));
    // 0143 only appends: each status keeps 0142's reasons in 0142's order, and what it adds is new to
    // 0142 and is exactly the two reasons 0143 appends to the reason CHECK.
    const added: string[] = [];
    for (const [s, reasons] of Object.entries(fromSql)) {
      expect(reasons.slice(0, from0142[s]!.length), s).toEqual(from0142[s]);
      const delta = reasons.slice(from0142[s]!.length);
      for (const reason of delta) expect(Object.values(from0142).flat(), reason).not.toContain(reason);
      // The fake lists each status's reasons in the migration's order, so the delta is appended too.
      expect([...FAKE_STATUS_REASONS[s]!], s).toEqual(reasons);
      added.push(...delta);
    }
    const reasonList0143 = /add constraint chk_r1_meet_bookings_reason check \(reason in \(([^)]*)\)\) not valid;/.exec(sql0143);
    expect(reasonList0143, '0143 chk_r1_meet_bookings_reason').not.toBeNull();
    expect(added.sort()).toEqual(quoted(reasonList0143![1]!).slice(32).sort());
    expect(added).toHaveLength(2);
    const sorted = (record: Readonly<Record<string, readonly string[]>>): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(record)
          .map(([key, list]): [string, string[]] => [key, [...list].sort()])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    expect(sorted(FAKE_STATUS_REASONS)).toEqual(sorted(fromSql));
    expect(Object.keys(FAKE_STATUS_REASONS).sort()).toEqual([...R1_MEET_BOOKING_STATUSES].sort());
    // The flat reason set is the runtime's closed list, the two public reasons included (34).
    const flat = [...new Set(Object.values(FAKE_STATUS_REASONS).flat())];
    expect(flat).toHaveLength(34);
    expect(flat.sort()).toEqual([...R1_MEET_BOOKING_REASONS].sort());
  });

  it('the 0143 pairs: cancelled/candidate_cancelled and failed/invite_undeliverable write; crossed over they are 23514', async () => {
    const h = createR1MeetHarness();
    // Seeded (the CHECK alone): either source, terminal and bot-less.
    for (const seed of [h.db.seedBooking.bind(h.db), h.db.seedPublicBooking.bind(h.db)]) {
      expect(seed({ status: 'cancelled', reason: 'candidate_cancelled' })).toMatchObject({ status: 'cancelled', reason: 'candidate_cancelled' });
      expect(seed({ status: 'failed', reason: 'invite_undeliverable' })).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
    }
    const written = h.db.tables.r1_meet_bookings.length;
    expect(() => h.db.seedBooking({ status: 'cancelled', reason: 'invite_undeliverable' })).toThrow('23514 chk_r1_meet_bookings_status_reason');
    expect(() => h.db.seedPublicBooking({ status: 'failed', reason: 'candidate_cancelled' })).toThrow('23514 chk_r1_meet_bookings_status_reason');
    expect(h.db.tables.r1_meet_bookings).toHaveLength(written);

    // Through the transition RPC (pending -> failed is in the matrix): the new failed reason writes,
    // the new cancelled reason on failed is the pairing CHECK and rolls back.
    const pb = h.createPublicBooking();
    const before = structuredClone(h.db.booking(pb.bookingId));
    const refused = await call(h.db, 'r1_meet_transition_booking', {
      p_booking_id: pb.bookingId, p_from_status: 'pending', p_to_status: 'failed', p_reason: 'candidate_cancelled', p_now: NOW,
    });
    expect(refused).toEqual({ data: null, error: { code: '23514', message: 'chk_r1_meet_bookings_status_reason' } });
    expect(h.db.booking(pb.bookingId)).toEqual(before);
    expect(await status(h.db, 'r1_meet_transition_booking', {
      p_booking_id: pb.bookingId, p_from_status: 'pending', p_to_status: 'failed', p_reason: 'invite_undeliverable', p_now: NOW,
    })).toBe('ok');
    expect(h.db.booking(pb.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable' });
    // And the store reads it back with its reason.
    expect(await h.db.store.getBooking(pb.bookingId)).toMatchObject({ status: 'failed', reason: 'invite_undeliverable', source: 'public_page' });
  });

  it('r1_meet_transition_booking: the matrix', () => {
    const text = functionText('r1_meet_transition_booking');
    const condition = text.slice(text.indexOf('if ((p_from_status'), text.indexOf('is not true then'));
    const rows = [
      ...condition.matchAll(/p_from_status (?:= '(\w+)'|in \(([^)]*)\)) and p_to_status (?:= '(\w+)'|in \(([^)]*)\))/g),
    ].map((match) => [match[1] ? [match[1]] : quoted(match[2]!), match[3] ? [match[3]] : quoted(match[4]!)]);
    expect(rows.length).toBe(5);
    expect(rows).toEqual(FAKE_TRANSITIONS.map(([from, to]) => [[...from], [...to]]));
  });

  it('every pair the matrix allows writes; every pair it refuses is invalid_transition', async () => {
    const h = createR1MeetHarness();
    const allowed = new Set(FAKE_TRANSITIONS.flatMap(([from, to]) => from.flatMap((f) => to.map((t) => `${f}->${t}`))));
    for (const from of ['pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed']) {
      for (const to of R1_MEET_BOOKING_STATUSES) {
        const booking = await pending(h);
        if (from === 'blocked') await move(h, booking, 'pending', 'blocked', 'paused');
        if (['bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed'].includes(from)) {
          await call(h.db, 'r1_meet_set_bot', setBotArgs(booking.id, 'attach', { p_recall_bot_id: fixtureId() }));
          // Bring it to `from` directly: the claim RPC (in_call) and the settle are other slices' moves.
          Object.assign(h.db.booking(booking.id)!, { status: from, reason: from === 'completed' ? 'attempt_settled' : 'eligible' });
        }
        const reason = FAKE_STATUS_REASONS[to]![0]!;
        const answer = await status(h.db, 'r1_meet_transition_booking', {
          p_booking_id: booking.id,
          p_from_status: from,
          p_to_status: to,
          p_reason: reason,
          p_now: NOW,
        });
        const expected = allowed.has(`${from}->${to}`) ? 'ok' : 'invalid_transition';
        expect(answer, `${from}->${to}`).toBe(expected);
      }
    }
  });
});

// ── Every answer of every RPC ───────────────────────────────────────────────

describe('every answer of every RPC is reachable through the port, and they are the catalog', () => {
  it('r1_meet_create_round_from_ashby', async () => {
    const h = createR1MeetHarness();
    const db = h.db;
    const seen = new Set<string>();
    const st = async (args: Record<string, unknown>) => {
      const answer = await status(db, 'r1_meet_create_round_from_ashby', args);
      seen.add(answer);
      return answer;
    };
    const app = fixtureId();
    db.linkApplication(app, fixtureId());
    const eventA = fixtureId();
    expect(await st(createArgs(app, { p_ashby_interview_event_id: eventA }))).toBe('created');
    expect(await st(createArgs(app, { p_ashby_interview_event_id: eventA }))).toBe('exists');
    const a = db.tables.r1_meet_bookings.find((b) => b.ashby_interview_event_id === eventA)!;
    // The HR-attested consent names the Ashby scheduler and the attestation time.
    expect(db.tables.interview_round_consents).toEqual([
      expect.objectContaining({
        round_id: a.round_id,
        method: 'hr_attested_ashby',
        attested_by_external_id: SCHEDULER_ID,
        attested_at: NOW,
        india_location_attested: true,
        withdrawn_at: null,
      }),
    ]);
    await db.store.cancel({ bookingId: a.id, reason: 'cancelled', nowIso: NOW });
    expect(await st(createArgs(app, { p_ashby_interview_event_id: eventA }))).toBe('booking_terminal');
    // A new event for the same candidate re-links the live Meet round the cancelled booking left.
    expect(await st(createArgs(app))).toBe('relinked');
    expect(db.tables.interview_round_consents.map((c) => c.withdrawn_at !== null)).toEqual([true, false]);

    const unlinked = fixtureId();
    const eventU = fixtureId();
    expect(await st(createArgs(unlinked, { p_ashby_interview_event_id: eventU }))).toBe('unmatched_application');
    expect(await st(createArgs(unlinked, { p_ashby_interview_event_id: eventU, p_ashby_updated_at: at(-MIN) }))).toBe('stale_update');

    const app2 = fixtureId();
    db.linkApplication(app2, fixtureId());
    expect(await st(createArgs(app2, { p_created_by: null }))).toBe('unmapped_scheduler');
    db.settings.sendRound = 'paused';
    expect(await st(createArgs(app2))).toBe('blocked');
    db.settings.sendRound = 'ok';
    expect(await st(createArgs(app2, { p_start_at: at(-MIN), p_end_at: at(30 * MIN) }))).toBe('in_past');
    expect(await st(createArgs(app2, { p_meet_url: 'https://meet.google.com/ab-cdef-ghi' }))).toBe('invalid_request');

    // A failed booking Ashby moved, still holding its bot, then without it at generation 50.
    const eventF = fixtureId();
    const failed = await h.createBooking({ eventId: eventF });
    await call(db, 'r1_meet_set_bot', setBotArgs(failed.bookingId, 'attach', { p_recall_bot_id: fixtureId() }));
    await move(h, db.booking(failed.bookingId)!, 'bot_scheduled', 'failed', 'no_show');
    const app3 = db.booking(failed.bookingId)!.ashby_application_id as string;
    const moved = { p_ashby_interview_event_id: eventF, p_start_at: at(2 * DAY), p_end_at: at(2 * DAY + 45 * MIN) };
    expect(await st(createArgs(app3, moved))).toBe('bot_attached');
    await call(db, 'r1_meet_set_bot', setBotArgs(failed.bookingId, 'release'));
    db.booking(failed.bookingId)!.version = 50;
    expect(await st(createArgs(app3, moved))).toBe('version_exhausted');

    expectAnswerSet('create', seen, R1_MEET_RPC_ANSWERS.r1_meet_create_round_from_ashby);
  });

  it('r1_meet_create_round_from_ashby: the revival and the re-bind start a new generation', async () => {
    const h = createR1MeetHarness();
    const db = h.db;
    // Revival: failed, bot released, moved by Ashby to a new slot.
    const eventF = fixtureId();
    const failed = await h.createBooking({ eventId: eventF });
    await move(h, db.booking(failed.bookingId)!, 'pending', 'failed', 'round_expired');
    const app = db.booking(failed.bookingId)!.ashby_application_id as string;
    const revived = await call(db, 'r1_meet_create_round_from_ashby', createArgs(app, { p_ashby_interview_event_id: eventF, p_start_at: at(2 * DAY), p_end_at: at(2 * DAY + 45 * MIN) }));
    expect(revived.data).toMatchObject({ status: 'relinked', rebound: true, version: 1, key_attempt: 0, booking_status: 'pending' });

    // Re-bind: a pending booking whose round lapsed before its bot was dispatched.
    const eventL = fixtureId();
    const lapsed = await h.createBooking({ eventId: eventL });
    const round = db.tables.interview_rounds.find((r) => r.id === db.booking(lapsed.bookingId)!.round_id)!;
    round.status = 'expired';
    const appL = db.booking(lapsed.bookingId)!.ashby_application_id as string;
    const rebound = await call(db, 'r1_meet_create_round_from_ashby', createArgs(appL, { p_ashby_interview_event_id: eventL, p_start_at: db.booking(lapsed.bookingId)!.start_at, p_end_at: db.booking(lapsed.bookingId)!.end_at }));
    expect(rebound.data).toMatchObject({ status: 'created', rebound: true, version: 1 });
    expect(db.booking(lapsed.bookingId)!.round_id).not.toBe(round.id);

    // A slot beyond 14 days answers blocked/slot_too_far with retry_after = expiry - 14 days.
    const app2 = fixtureId();
    db.linkApplication(app2, fixtureId());
    const far = await call(db, 'r1_meet_create_round_from_ashby', createArgs(app2, { p_start_at: at(20 * DAY), p_end_at: at(20 * DAY + 45 * MIN) }));
    expect(far.data).toMatchObject({ status: 'blocked', reason: 'slot_too_far', retry_after: at(6 * DAY + 45 * MIN + 2 * 60 * MIN) });
  });

  it('r1_meet_reschedule_booking', async () => {
    const h = createR1MeetHarness();
    const db = h.db;
    const seen = new Set<string>();
    const st = async (args: Record<string, unknown>) => {
      const answer = await status(db, 'r1_meet_reschedule_booking', args);
      seen.add(answer);
      return answer;
    };
    const p = await pending(h);
    expect(await st(rescheduleArgs(p.id, { p_meet_url: 'nope' }))).toBe('invalid_request');
    expect(await st(rescheduleArgs(fixtureId()))).toBe('not_found');
    expect(await st(rescheduleArgs(p.id, { p_expected_version: 3 }))).toBe('version_conflict');
    expect(await st(rescheduleArgs(p.id, { p_ashby_updated_at: at(-DAY) }))).toBe('stale_update');
    expect(await st(rescheduleArgs(p.id, { p_start_at: at(-MIN), p_end_at: at(30 * MIN) }))).toBe('in_past');
    expect(await st(rescheduleArgs(p.id, { p_start_at: at(20 * DAY), p_end_at: at(20 * DAY + 45 * MIN) }))).toBe('slot_too_far');
    expect(await st(rescheduleArgs(p.id))).toBe('ok');
    expect(db.booking(p.id)).toMatchObject({ version: 1, key_attempt: 0, meet_url: OTHER_MEET_URL, status: 'pending' });
    // A reschedule that moves nothing keeps both counters.
    expect(await st(rescheduleArgs(p.id, { p_expected_version: 1 }))).toBe('ok');
    expect(db.booking(p.id)!.version).toBe(1);
    db.booking(p.id)!.version = 50;
    expect(await st(rescheduleArgs(p.id, { p_expected_version: 50, p_start_at: at(DAY + 2 * 60 * MIN), p_end_at: at(DAY + 3 * 60 * MIN) }))).toBe('version_exhausted');

    const s = await scheduled(h);
    expect(await st(rescheduleArgs(s.id))).toBe('bot_attached');
    await move(h, s, 'bot_scheduled', 'bot_joining', 'eligible');
    expect(await st(rescheduleArgs(s.id))).toBe('booking_dispatched');
    await move(h, s, 'bot_joining', 'failed', 'no_show');
    expect(await st(rescheduleArgs(s.id))).toBe('booking_terminal');

    const unlinked = await call(db, 'r1_meet_create_round_from_ashby', createArgs(fixtureId()));
    expect(await st(rescheduleArgs((unlinked.data as Row).booking_id))).toBe('no_round');

    const lapsed = await pending(h);
    db.tables.interview_rounds.find((r) => r.id === lapsed.round_id)!.expires_at = at(-MIN);
    expect(await st(rescheduleArgs(lapsed.id))).toBe('round_not_live');

    // `not_allowed` needs a round-bound, bot-less booking that is neither pending nor blocked: the
    // round and bot binding CHECKs leave no such status, so it cannot be reached (nor here).
    expectAnswerSet('reschedule', seen, R1_MEET_RPC_ANSWERS.r1_meet_reschedule_booking.filter((answer) => answer !== 'not_allowed'));
  });

  it('r1_meet_cancel_booking', async () => {
    const h = createR1MeetHarness();
    const seen = new Set<string>();
    const st = async (args: Record<string, unknown>) => {
      const answer = await status(h.db, 'r1_meet_cancel_booking', args);
      seen.add(answer);
      return answer;
    };
    const s = await scheduled(h);
    const answer = await call(h.db, 'r1_meet_cancel_booking', { p_booking_id: s.id, p_reason: 'dex_absent', p_now: NOW });
    seen.add((answer.data as Row).status);
    expect(answer.data).toEqual({ status: 'ok', booking_id: s.id, previous_status: 'bot_scheduled', recall_bot_id: s.recall_bot_id, bot_dispatched: false });
    // The bot stays until S06 confirms its release: an owed release.
    expect(h.db.booking(s.id)).toMatchObject({ status: 'cancelled', reason: 'dex_absent', recall_bot_id: s.recall_bot_id });
    expect(await st({ p_booking_id: s.id, p_reason: 'cancelled', p_now: NOW })).toBe('already_cancelled');
    const f = await pending(h);
    await move(h, f, 'pending', 'failed', 'round_expired');
    expect(await st({ p_booking_id: f.id, p_reason: 'cancelled', p_now: NOW })).toBe('booking_terminal');
    expect(await st({ p_booking_id: fixtureId(), p_reason: 'cancelled', p_now: NOW })).toBe('not_found');
    expect(await st({ p_booking_id: f.id, p_reason: 'flag_off', p_now: NOW })).toBe('invalid_reason');
    expect(await st({ p_booking_id: f.id, p_reason: 'cancelled', p_now: null })).toBe('invalid_request');
    expectAnswerSet('cancel', seen, R1_MEET_RPC_ANSWERS.r1_meet_cancel_booking);
  });

  it('r1_meet_set_bot', async () => {
    const h = createR1MeetHarness();
    const seen = new Set<string>();
    const st = async (args: Record<string, unknown>) => {
      const answer = await status(h.db, 'r1_meet_set_bot', args);
      seen.add(answer);
      return answer;
    };
    const bot = fixtureId();
    const p = await pending(h);
    expect(await st(setBotArgs(p.id, 'attach'))).toBe('invalid_request');
    expect(await st(setBotArgs(p.id, 'move'))).toBe('invalid_action');
    expect(await st(setBotArgs(fixtureId(), 'release'))).toBe('not_found');
    expect(await st(setBotArgs(p.id, 'attach', { p_recall_bot_id: bot, p_expected_version: 1 }))).toBe('version_conflict');
    expect(await st(setBotArgs(p.id, 'replace'))).toBe('not_allowed');
    expect(await st(setBotArgs(p.id, 'attach', { p_recall_bot_id: bot, p_now: p.end_at }))).toBe('in_past');
    expect(await st(setBotArgs(p.id, 'rotate_key'))).toBe('ok');
    expect(h.db.booking(p.id)!.key_attempt).toBe(1);
    expect(await st(setBotArgs(p.id, 'attach', { p_recall_bot_id: bot, p_expected_key_attempt: 1 }))).toBe('ok');
    expect(await st(setBotArgs(p.id, 'attach', { p_recall_bot_id: bot, p_expected_key_attempt: 1 }))).toBe('duplicate');
    expect(await st(setBotArgs(p.id, 'attach', { p_recall_bot_id: fixtureId(), p_expected_key_attempt: 1 }))).toBe('bot_conflict');
    expect(await st(setBotArgs(p.id, 'rotate_key', { p_expected_key_attempt: 1 }))).toBe('not_allowed');
    expect(await st(setBotArgs(p.id, 'release', { p_expected_key_attempt: 1 }))).toBe('not_allowed');
    expect(await st(setBotArgs(p.id, 'replace', { p_expected_key_attempt: 1 }))).toBe('ok');
    expect(h.db.booking(p.id)).toMatchObject({ status: 'pending', recall_bot_id: null, version: 1, key_attempt: 0, ticket_arms: 0 });

    const q = await pending(h);
    await move(h, q, 'pending', 'blocked', 'paused');
    expect(await st(setBotArgs(q.id, 'attach', { p_recall_bot_id: fixtureId() }))).toBe('not_allowed');
    const r = await pending(h);
    h.db.tables.interview_rounds.find((round) => round.id === r.round_id)!.status = 'cancelled';
    expect(await st(setBotArgs(r.id, 'attach', { p_recall_bot_id: fixtureId() }))).toBe('round_not_live');
    const held = await scheduled(h);
    const t = await pending(h);
    expect(await st(setBotArgs(t.id, 'attach', { p_recall_bot_id: held.recall_bot_id }))).toBe('bot_in_use');
    h.db.booking(t.id)!.key_attempt = 20;
    expect(await st(setBotArgs(t.id, 'rotate_key', { p_expected_key_attempt: 20 }))).toBe('key_attempts_exhausted');
    h.db.booking(held.id)!.version = 50;
    expect(await st(setBotArgs(held.id, 'replace', { p_expected_version: 50 }))).toBe('version_exhausted');
    await move(h, held, 'bot_scheduled', 'drained', 'flag_off');
    expect(await st(setBotArgs(held.id, 'release', { p_expected_version: 50 }))).toBe('ok');
    expect(h.db.booking(held.id)!.recall_bot_id).toBeNull();
    expect(await st(setBotArgs(held.id, 'release', { p_expected_version: 50 }))).toBe('duplicate');
    expectAnswerSet('set_bot', seen, R1_MEET_RPC_ANSWERS.r1_meet_set_bot);
  });

  it('r1_meet_transition_booking', async () => {
    const h = createR1MeetHarness();
    const seen = new Set<string>();
    const st = async (args: Record<string, unknown>) => {
      const answer = await status(h.db, 'r1_meet_transition_booking', args);
      seen.add(answer);
      return answer;
    };
    const p = await pending(h);
    const base = { p_booking_id: p.id, p_from_status: 'pending', p_to_status: 'blocked', p_reason: 'bot_cap_reached', p_now: NOW };
    expect(await st({ ...base, p_now: null })).toBe('invalid_request');
    expect(await st({ ...base, p_booking_id: fixtureId() })).toBe('not_found');
    expect(await st({ ...base, p_from_status: 'bot_scheduled' })).toBe('status_conflict');
    expect(await st({ ...base, p_to_status: 'completed', p_reason: 'attempt_settled' })).toBe('invalid_transition');
    expect(await st(base)).toBe('ok');
    expectAnswerSet('transition', seen, R1_MEET_RPC_ANSWERS.r1_meet_transition_booking);
  });

  it('r1_meet_arm_ticket', async () => {
    const h = createR1MeetHarness();
    const seen = new Set<string>();
    const st = async (args: Record<string, unknown>) => {
      const answer = await status(h.db, 'r1_meet_arm_ticket', args);
      seen.add(answer);
      return answer;
    };
    const s = await scheduled(h);
    expect(await st(armArgs(s, 'not-a-digest'))).toBe('invalid_ticket');
    expect(await st(armArgs(s, digestOf(1), { p_now: null }))).toBe('invalid_request');
    expect(await st(armArgs(s, digestOf(1), { p_not_before: at(2 * DAY), p_expires_at: at(DAY) }))).toBe('invalid_window');
    expect(await st(armArgs(s, digestOf(1), { p_booking_id: fixtureId() }))).toBe('not_found');
    // Outside the slot bounds: start - 15 min .. end + 30 min.
    expect(await status(h.db, 'r1_meet_arm_ticket', armArgs(s, digestOf(1), { p_not_before: new Date(Date.parse(s.start_at) - 16 * MIN).toISOString() }))).toBe('invalid_window');
    const p = await pending(h);
    expect(await st(armArgs(p, digestOf(1)))).toBe('not_armable');
    expect(await st(armArgs(s, digestOf(1)))).toBe('ok');
    expect(await st(armArgs(s, digestOf(1)))).toBe('duplicate');
    const other = await scheduled(h);
    expect(await st(armArgs(other, digestOf(1)))).toBe('digest_in_use');
    // A claimed digest is never armed again.
    h.setNow(Date.parse(s.start_at) - 60_000);
    await h.db.claimTicket(ticketOf(1), new Date(h.now()).toISOString(), BRIDGE_SOURCE);
    expect(await st(armArgs(s, digestOf(1)))).toBe('digest_in_use');
    h.db.booking(other.id)!.ticket_arms = 5;
    expect(await st(armArgs(other, digestOf(2)))).toBe('ticket_arms_exhausted');
    expectAnswerSet('arm', seen, R1_MEET_RPC_ANSWERS.r1_meet_arm_ticket);
  });

  it('r1_meet_prune_receipts and r1_meet_prune_bookings', async () => {
    const h = createR1MeetHarness();
    for (const name of ['r1_meet_prune_receipts', 'r1_meet_prune_bookings'] as const) {
      const seen = new Set<string>();
      const st = async (args: Record<string, unknown>) => {
        const answer = await status(h.db, name, args);
        seen.add(answer);
        return answer;
      };
      expect(await st({ p_older_than: at(-30 * DAY), p_limit: 500, p_now: null })).toBe('invalid_request');
      expect(await st({ p_older_than: null, p_limit: 500, p_now: NOW })).toBe('invalid_request');
      expect(await st({ p_older_than: at(-30 * DAY), p_limit: 0, p_now: NOW })).toBe('invalid_request');
      expect(await st({ p_older_than: at(-6 * DAY), p_limit: 500, p_now: NOW })).toBe('retention_too_short');
      expect(await st({ p_older_than: at(-30 * DAY), p_limit: 500, p_now: NOW })).toBe('ok');
      expectAnswerSet(name, seen, R1_MEET_RPC_ANSWERS[name as R1MeetRpcName]);
    }
  });

  it('prunes what 0142 prunes, and nothing else', async () => {
    const h = createR1MeetHarness();
    const db = h.db;
    const receipt = async (key: string, now: string, enqueue: boolean) =>
      (await call(db, 'r1_meet_record_receipt', {
        p_source: 'recall',
        p_dedupe_key: key,
        p_event_type: 'bot.done',
        p_booking_id: null,
        p_enqueue: enqueue,
        p_payload: enqueue ? { kind: 'recall_event' } : null,
        p_scheduled_at: null,
        p_now: now,
      })).data as Row;
    const old = at(-40 * DAY);
    const settled = await receipt('msg_old_settled', old, false);
    const liveJob = await receipt('msg_old_live', old, true);
    const deadJob = await receipt('msg_old_dead', old, true);
    db.tables.job_queue.find((job) => job.dedup_key === `r1-meet:receipt:${deadJob.id}`)!.status = 'failed';
    const recent = await receipt('msg_recent', at(-DAY), false);
    const pruned = await call(db, 'r1_meet_prune_receipts', { p_older_than: at(-30 * DAY), p_limit: 500, p_now: NOW });
    expect(pruned.data).toEqual({ status: 'ok', deleted: 2 });
    expect(db.tables.r1_meet_receipts.map((r) => r.id).sort()).toEqual([liveJob.id, recent.id].sort());
    expect(settled.id).toBeDefined();

    // Bookings: round-less, bot-less, slot ended before the cutoff; oldest first, up to the limit.
    const oldSlot = { start_at: at(-40 * DAY), end_at: at(-40 * DAY + 30 * MIN) };
    const gone1 = db.seedBooking({ ...oldSlot, status: 'unmatched_application', reason: 'application_unknown' });
    const gone2 = db.seedBooking({ start_at: at(-39 * DAY), end_at: at(-39 * DAY + 30 * MIN), status: 'failed', reason: 'in_past' });
    const withBot = db.seedBooking({ ...oldSlot, status: 'cancelled', reason: 'cancelled', recall_bot_id: fixtureId() });
    const round = db.addRound();
    const withRound = db.seedBooking({ ...oldSlot, round_id: round.id, status: 'failed', reason: 'no_show' });
    const fresh = db.seedBooking({ start_at: at(-DAY), end_at: at(-DAY + 30 * MIN), status: 'failed', reason: 'in_past' });
    expect((await call(db, 'r1_meet_prune_bookings', { p_older_than: at(-30 * DAY), p_limit: 1, p_now: NOW })).data).toEqual({ status: 'ok', deleted: 1 });
    expect(db.booking(gone1.id)).toBeUndefined();
    expect(db.booking(gone2.id)).toBeDefined();
    await call(db, 'r1_meet_prune_bookings', { p_older_than: at(-30 * DAY), p_limit: 500, p_now: NOW });
    expect(db.booking(gone2.id)).toBeUndefined();
    for (const kept of [withBot, withRound, fresh]) expect(db.booking(kept.id)).toBeDefined();
  });

  it('the bridge page half: r1_meet_claim_ticket and r1_meet_bind_session', async () => {
    const h = createR1MeetHarness();
    const db = h.db;
    const claims = new Set<string>();
    const binds = new Set<string>();
    const claim = async (ticket: string, now: string) => {
      const answer = await db.claimTicket(ticket, now, BRIDGE_SOURCE);
      const value = answer.error ? `error:${answer.error.code}` : ((answer.data as Row).status as string);
      claims.add(value);
      return value;
    };
    const s = await scheduled(h);
    await call(db, 'r1_meet_arm_ticket', armArgs(s, digestOf(1)));
    const start = Date.parse(s.start_at);
    claims.add(await status(db, 'r1_meet_claim_ticket', { p_ticket_digest: 'x', p_now: NOW }));
    claims.add(await status(db, 'r1_meet_claim_ticket', { p_ticket_digest: digestOf(1), p_now: null }));
    expect(await claim(ticketOf(9), NOW)).toBe('ticket_unknown');
    expect(await claim(ticketOf(1), new Date(start - 6 * MIN).toISOString())).toBe('ticket_not_yet_valid');
    expect(await claim(ticketOf(1), new Date(Date.parse(s.end_at) + 15 * MIN).toISOString())).toBe('ticket_expired');
    db.tables.interview_rounds.find((r) => r.id === s.round_id)!.status = 'cancelled';
    expect(await claim(ticketOf(1), new Date(start - MIN).toISOString())).toBe('round_not_live');
    db.tables.interview_rounds.find((r) => r.id === s.round_id)!.status = 'invited';
    expect(await claim(ticketOf(1), new Date(start - MIN).toISOString())).toBe('ok');
    expect(db.booking(s.id)).toMatchObject({ status: 'in_call', ticket_claimed_at: new Date(start - MIN).toISOString() });
    expect(await claim(ticketOf(1), new Date(start).toISOString())).toBe('ticket_already_claimed');
    // A terminal row that still carries an unclaimed digest (the CHECK allows it) is not claimable.
    const round = db.addRound();
    const window = r1MeetTicketWindow({ startAt: s.start_at, endAt: s.end_at, botJoinLeadSec: 120, nowMs: NOW_MS })!;
    db.seedBooking({
      round_id: round.id,
      status: 'failed',
      reason: 'no_show',
      start_at: s.start_at,
      end_at: s.end_at,
      ticket_digest: digestOf(3),
      ticket_not_before: window.not_before,
      ticket_expires_at: window.expires_at,
    });
    expect(await claim(ticketOf(3), new Date(start).toISOString())).toBe('booking_not_claimable');
    expect([...claims].sort()).toEqual(catalogAnswers('r1_meet_claim_ticket').sort());

    const bind = async (bookingId: string, sessionId: string, now: unknown = NOW) => {
      const value = await status(db, 'r1_meet_bind_session', { p_booking_id: bookingId, p_session_id: sessionId, p_now: now });
      binds.add(value);
      return value;
    };
    const session = db.addSession({ interview_round_id: s.round_id });
    const foreign = db.addSession({ interview_round_id: db.addRound().id });
    expect(await bind(s.id, session.id, null)).toBe('invalid_request');
    expect(await bind(fixtureId(), session.id)).toBe('not_found');
    expect(await bind(s.id, foreign.id)).toBe('session_mismatch');
    expect(await bind(s.id, session.id)).toBe('ok');
    expect(await bind(s.id, session.id)).toBe('duplicate');
    const p = await pending(h);
    expect(await bind(p.id, session.id)).toBe('not_in_call');
    expect(db.booking(s.id)!.session_id).toBe(session.id);
    expect([...binds].sort()).toEqual(catalogAnswers('r1_meet_bind_session').sort());
  });

  it('r1_meet_record_receipt (the S03 receivers; the port re-drives one live job per receipt)', async () => {
    const h = createR1MeetHarness();
    const db = h.db;
    const seen = new Set<string>();
    const base = {
      p_source: 'recall',
      p_dedupe_key: 'msg_one',
      p_event_type: 'bot.joining_call',
      p_booking_id: null,
      p_enqueue: true,
      p_payload: { kind: 'recall_event', recall_bot_id: fixtureId() },
      p_scheduled_at: null,
      p_now: NOW,
    };
    const st = async (over: Record<string, unknown>) => {
      const answer = await status(db, 'r1_meet_record_receipt', { ...base, ...over });
      seen.add(answer);
      return answer;
    };
    expect(await st({ p_source: 'calendar' })).toBe('invalid_source');
    expect(await st({ p_dedupe_key: 'ashby-schedule:x' })).toBe('invalid_dedupe_key');
    expect(await st({ p_event_type: 'bad type' })).toBe('invalid_event_type');
    expect(await st({ p_now: null })).toBe('invalid_request');
    expect(await st({ p_payload: { kind: 'Bad' } })).toBe('invalid_payload');
    expect(await st({ p_payload: { kind: 'recall_event', pad: 'x'.repeat(5000) } })).toBe('payload_too_large');
    expect(await st({ p_scheduled_at: at(31 * DAY) })).toBe('invalid_scheduled_at');
    expect(await st({})).toBe('inserted');
    expect(await st({})).toBe('duplicate');
    const [job] = db.jobs('recall_event');
    const receiptId = db.tables.r1_meet_receipts[0]!.id;
    expect(job).toMatchObject({ dedup_key: `r1-meet:receipt:${receiptId}`, max_attempts: 5, status: 'pending' });
    expect(job!.payload).toMatchObject({ kind: 'recall_event', receipt_id: receiptId, source: 'recall' });
    expect(db.jobs('recall_event')).toHaveLength(1);
    // The job died without settling the receipt: a re-delivery re-drives exactly one job.
    job!.status = 'failed';
    await st({});
    expect(db.jobs('recall_event').filter((j) => j.status === 'pending')).toHaveLength(1);
    expect([...seen].sort()).toEqual(catalogAnswers('r1_meet_record_receipt').sort());
  });
});

// ── CHECKs, unique indexes and the first refusal ────────────────────────────

describe('CHECK violations answer 23514 and roll the whole call back', () => {
  it('a transition to a reason its status does not accept (the pairing CHECK)', async () => {
    const h = createR1MeetHarness();
    const p = await pending(h);
    const before = structuredClone(h.db.booking(p.id));
    const answer = await call(h.db, 'r1_meet_transition_booking', {
      p_booking_id: p.id,
      p_from_status: 'pending',
      p_to_status: 'failed',
      p_reason: 'flag_off',
      p_now: at(MIN),
    });
    expect(answer).toEqual({ data: null, error: { code: '23514', message: 'chk_r1_meet_bookings_status_reason' } });
    expect(h.db.booking(p.id)).toEqual(before);
    // Through the store it is the closed db error, and the message is that code alone.
    await expect(
      h.db.store.transition({ bookingId: p.id, from: 'pending', to: 'blocked', reason: 'no_show' as never, nowIso: NOW }),
    ).rejects.toThrow(/^r1_meet_db_error$/);
  });

  it('the round binding, bot binding, ticket and counter CHECKs', () => {
    const h = createR1MeetHarness();
    const round = h.db.addRound();
    const bad: Array<[string, Record<string, unknown>]> = [
      ['chk_r1_meet_bookings_round_binding', { status: 'pending' }],
      ['chk_r1_meet_bookings_round_binding', { status: 'unmatched_application', reason: 'application_unknown', round_id: round.id }],
      ['chk_r1_meet_bookings_bot_binding', { status: 'bot_scheduled', round_id: round.id }],
      ['chk_r1_meet_bookings_bot_binding', { status: 'blocked', reason: 'paused', round_id: round.id, recall_bot_id: fixtureId() }],
      ['chk_r1_meet_bookings_ticket', { status: 'bot_scheduled', round_id: round.id, recall_bot_id: fixtureId(), ticket_digest: digestOf(1) }],
      ['chk_r1_meet_bookings_ticket', { status: 'blocked', reason: 'paused', round_id: round.id, ticket_digest: digestOf(1), ticket_not_before: at(DAY - 5 * MIN), ticket_expires_at: at(DAY + 60 * MIN) }],
      ['chk_r1_meet_bookings_version', { status: 'failed', reason: 'in_past', version: 51 }],
      ['chk_r1_meet_bookings_key_attempt', { status: 'failed', reason: 'in_past', key_attempt: 21 }],
      ['chk_r1_meet_bookings_ticket_arms', { status: 'failed', reason: 'in_past', ticket_arms: 6 }],
      ['chk_r1_meet_bookings_slot', { status: 'failed', reason: 'in_past', start_at: at(DAY), end_at: at(DAY) }],
      ['chk_r1_meet_bookings_meet_url', { status: 'failed', reason: 'in_past', meet_url: 'https://meet.google.com/ABC-defg-hij' }],
    ];
    for (const [constraint, row] of bad) {
      expect(() => h.db.seedBooking(row), constraint).toThrow(`23514 ${constraint}`);
    }
    expect(h.db.tables.r1_meet_bookings).toEqual([]);
  });

  it('unique indexes answer 23505: one bot, one digest, one live booking per round', async () => {
    const h = createR1MeetHarness();
    const s = await scheduled(h);
    const round = h.db.addRound();
    expect(() => h.db.seedBooking({ status: 'cancelled', reason: 'cancelled', recall_bot_id: s.recall_bot_id })).toThrow('23505 uq_r1_meet_bookings_recall_bot');
    expect(() => h.db.seedBooking({ status: 'pending', round_id: s.round_id })).toThrow('23505 uq_r1_meet_bookings_live_round');
    expect(() => h.db.seedBooking({ status: 'pending', round_id: round.id, ashby_interview_event_id: s.ashby_interview_event_id })).toThrow('23505 uq_r1_meet_bookings_event');
  });
});

describe('the first refusal wins, in the SQL order', () => {
  it('set_bot: the generation is compared before the action is judged', async () => {
    const h = createR1MeetHarness();
    const s = await scheduled(h);
    // replace on bot_scheduled would be ok, release would be not_allowed: both lose to the counters.
    expect(await status(h.db, 'r1_meet_set_bot', setBotArgs(s.id, 'replace', { p_expected_key_attempt: 4 }))).toBe('version_conflict');
    expect(await status(h.db, 'r1_meet_set_bot', setBotArgs(s.id, 'release', { p_expected_version: 2 }))).toBe('version_conflict');
    // invalid_action and invalid_request come before the booking is even read.
    expect(await status(h.db, 'r1_meet_set_bot', setBotArgs(fixtureId(), 'nope'))).toBe('invalid_action');
    expect(await status(h.db, 'r1_meet_set_bot', setBotArgs(fixtureId(), 'release', { p_now: null }))).toBe('invalid_request');
  });

  it('reschedule: terminal, then the generation, then the Ashby order, then dispatch, then the bot', async () => {
    const h = createR1MeetHarness();
    const s = await scheduled(h);
    const stale = { p_expected_version: 7, p_ashby_updated_at: at(-DAY) };
    expect(await status(h.db, 'r1_meet_reschedule_booking', rescheduleArgs(s.id, stale))).toBe('version_conflict');
    expect(await status(h.db, 'r1_meet_reschedule_booking', rescheduleArgs(s.id, { p_ashby_updated_at: at(-DAY) }))).toBe('stale_update');
    await move(h, s, 'bot_scheduled', 'bot_joining', 'eligible');
    expect(await status(h.db, 'r1_meet_reschedule_booking', rescheduleArgs(s.id, { p_start_at: at(-MIN), p_end_at: at(MIN) }))).toBe('booking_dispatched');
    await move(h, s, 'bot_joining', 'failed', 'no_show');
    expect(await status(h.db, 'r1_meet_reschedule_booking', rescheduleArgs(s.id, stale))).toBe('booking_terminal');
  });

  it('create: a replay reads the event booking before the in_past check', async () => {
    const h = createR1MeetHarness();
    const eventId = fixtureId();
    const p = await pending(h, eventId);
    h.setNow(Date.parse(p.start_at) + MIN);
    const replay = await status(h.db, 'r1_meet_create_round_from_ashby', createArgs(p.ashby_application_id, {
      p_ashby_interview_event_id: eventId,
      p_start_at: p.start_at,
      p_end_at: p.end_at,
      p_now: new Date(h.now()).toISOString(),
    }));
    expect(replay).toBe('exists');
  });

  it('arm: the digest shape, then now, then the window, then the booking', async () => {
    const h = createR1MeetHarness();
    expect(await status(h.db, 'r1_meet_arm_ticket', { p_booking_id: fixtureId(), p_ticket_digest: 'x', p_not_before: null, p_expires_at: null, p_now: null })).toBe('invalid_ticket');
    expect(await status(h.db, 'r1_meet_arm_ticket', { p_booking_id: fixtureId(), p_ticket_digest: digestOf(1), p_not_before: null, p_expires_at: null, p_now: null })).toBe('invalid_request');
    expect(await status(h.db, 'r1_meet_arm_ticket', { p_booking_id: fixtureId(), p_ticket_digest: digestOf(1), p_not_before: null, p_expires_at: null, p_now: NOW })).toBe('invalid_window');
  });
});

// ── Tables, triggers and test aids ──────────────────────────────────────────

describe('the tables answer the store, and the test aids work', () => {
  it('reads project to the selected columns: no ticket_digest, no candidate_id', async () => {
    const h = createR1MeetHarness();
    const s = await scheduled(h);
    await call(h.db, 'r1_meet_arm_ticket', armArgs(s, digestOf(1)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = h.db.client as any;
    const answer = (await client.from('r1_meet_bookings').select(R1_MEET_BOOKING_COLUMNS).eq('id', s.id).maybeSingle()) as FakeAnswer;
    const row = answer.data as Row;
    expect(Object.keys(row).sort()).toEqual(R1_MEET_BOOKING_COLUMNS.split(',').map((c) => c.trim()).sort());
    expect(JSON.stringify(row)).not.toContain(digestOf(1));
    const booking = await h.db.store.getBooking(s.id);
    expect(booking).toMatchObject({ id: s.id, status: 'bot_scheduled', recallBotId: s.recall_bot_id, ticketArms: 1 });
    expect(await h.db.store.getBookingByBot(s.recall_bot_id)).toMatchObject({ id: s.id });
    expect(await h.db.store.getBookingByEvent(s.ashby_interview_event_id)).toMatchObject({ id: s.id });
  });

  it('count, ordered lists, the owed releases and the JSON paths of the participant events', async () => {
    const h = createR1MeetHarness();
    const a = await scheduled(h);
    const b = await scheduled(h);
    await move(h, b, 'bot_scheduled', 'failed', 'no_show');
    expect(await h.db.store.countBotsInDay({ from: at(0), to: at(2 * DAY), excludeId: a.id })).toBe(1);
    expect((await h.db.store.listOwedReleases(10)).map((x) => x.id)).toEqual([b.id]);
    const bot = a.recall_bot_id as string;
    const event = (type: string, id: number | null, isBot: boolean | null, receipt: string) => ({
      kind: 'recall_event',
      event_type: type,
      recall_bot_id: bot,
      booking_id: a.id,
      occurred_at: NOW,
      sub_code: null,
      participant: { id, is_host: null, is_bot: isBot },
      receipt_id: receipt,
      source: 'recall',
    });
    const r1 = fixtureId();
    h.db.enqueue({ payload: event('participant_events.join', 11, null, r1), dedupKey: `r1-meet:receipt:${r1}`, maxAttempts: 5 });
    h.db.enqueue({ payload: event('participant_events.leave', 11, null, fixtureId()), dedupKey: 'r1-meet:receipt:x2', maxAttempts: 5 });
    h.db.enqueue({ payload: { ...event('participant_events.join', 12, null, fixtureId()), recall_bot_id: fixtureId() }, dedupKey: 'r1-meet:receipt:x3' });
    h.db.enqueue({ payload: { kind: 'recall_event', event_type: 'bot.done', recall_bot_id: bot, booking_id: a.id, occurred_at: NOW, sub_code: null, participant: null }, dedupKey: 'r1-meet:receipt:x4' });
    const events = await h.db.store.participantEvents(bot);
    expect(events).toEqual([
      { type: 'leave', participantId: 11, isBot: null, occurredAt: NOW },
      { type: 'join', participantId: 11, isBot: null, occurredAt: NOW },
    ]);
  });

  it('finishReceipt is a compare-and-set on the outcome', async () => {
    const h = createR1MeetHarness();
    const answer = await call(h.db, 'r1_meet_record_receipt', {
      p_source: 'recall', p_dedupe_key: 'msg_cas', p_event_type: 'bot.done', p_booking_id: null,
      p_enqueue: true, p_payload: { kind: 'recall_event' }, p_scheduled_at: null, p_now: NOW,
    });
    const id = (answer.data as Row).id as string;
    await expect(h.db.store.finishReceipt(id, 'processed', NOW)).resolves.toBe(true);
    await expect(h.db.store.finishReceipt(id, 'failed', NOW)).resolves.toBe(false);
    expect(h.db.tables.r1_meet_receipts[0]).toMatchObject({ outcome: 'processed', processed_at: NOW });
  });

  it('the two triggers: a deleted booking with a bot queues bot_release; a cancelled Meet round queues round_cancelled', async () => {
    const h = createR1MeetHarness();
    const s = await scheduled(h);
    const p = await pending(h);
    h.db.deleteBooking(s.id);
    h.db.deleteBooking(p.id);
    expect(h.db.jobs().map((job) => [job.payload, job.dedup_key, job.max_attempts])).toEqual([
      [{ kind: 'bot_release', recall_bot_id: s.recall_bot_id, booking_id: s.id }, `r1-meet:bot-release:${s.recall_bot_id}`, 10],
    ]);
    const live = await pending(h);
    h.db.cancelRound(live.round_id);
    h.db.cancelRound(live.round_id);
    expect(h.db.jobs('round_cancelled').map((job) => [job.payload, job.dedup_key])).toEqual([
      [{ kind: 'round_cancelled', booking_id: live.id, round_id: live.round_id }, `r1-meet:round-cancelled:${live.id}`],
    ]);
  });

  it('enqueue dedups against LIVE jobs only (uq_job_queue_dedup_active)', () => {
    const h = createR1MeetHarness();
    const spec = { payload: { kind: 'ensure_bot', booking_id: fixtureId() }, dedupKey: 'r1-meet:ensure-bot:x', maxAttempts: 10 };
    const first = h.db.enqueue(spec);
    expect(h.db.enqueue(spec)).toBe(first);
    first.status = 'completed';
    expect(h.db.enqueue(spec, { scheduledAt: at(MIN) })).not.toBe(first);
    expect(h.db.jobs('ensure_bot')).toHaveLength(2);
    expect(h.db.jobs('ensure_bot')[1]!.scheduled_at).toBe(at(MIN));
    expect(h.timeline).toEqual(['queue:ensure_bot', 'queue:ensure_bot']);
  });

  it('failNext: error writes nothing; lost commits and loses the answer; tables can fail too', async () => {
    const h = createR1MeetHarness();
    const p = await pending(h);
    h.db.failNext('r1_meet_set_bot');
    await expect(h.db.store.setBot({ bookingId: p.id, action: 'rotate_key', expectedVersion: 0, expectedKeyAttempt: 0, nowIso: NOW })).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(p.id)!.key_attempt).toBe(0);
    h.db.failNext('r1_meet_set_bot', 'lost');
    await expect(h.db.store.setBot({ bookingId: p.id, action: 'rotate_key', expectedVersion: 0, expectedKeyAttempt: 0, nowIso: NOW })).rejects.toThrow('r1_meet_db_error');
    expect(h.db.booking(p.id)!.key_attempt).toBe(1);
    h.db.failNext('r1_meet_bookings');
    await expect(h.db.store.getBooking(p.id)).rejects.toThrow('r1_meet_db_error');
    await expect(h.db.store.getBooking(p.id)).resolves.toMatchObject({ id: p.id, keyAttempt: 1 });
    expect(h.db.calls.filter((c) => c.kind === 'rpc').map((c) => c.name).slice(-2)).toEqual(['r1_meet_set_bot', 'r1_meet_set_bot']);
  });
});

// ── 0143's source (M035 S02) ────────────────────────────────────────────────

describe('the source of 0143 (M035 S02): the column, its two CHECKs and the public seed', () => {
  it('every row the create RPC or seedBooking writes is an Ashby row', async () => {
    const h = createR1MeetHarness();
    const created = await h.createBooking();
    expect(h.db.booking(created.bookingId)!.source).toBe('ashby');
    const round = h.db.addRound();
    expect(h.db.seedBooking({ round_id: round.id }).source).toBe('ashby');
  });

  it('an Ashby row without one of its three schedule ids, or a public row with one, is 23514 source_ids', () => {
    const h = createR1MeetHarness();
    const bad: Array<[string, () => Row]> = [
      ['chk_r1_meet_bookings_source_ids', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', ashby_schedule_id: null })],
      ['chk_r1_meet_bookings_source_ids', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', ashby_interview_event_id: null })],
      ['chk_r1_meet_bookings_source_ids', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', ashby_scheduled_by_user_id: null })],
      ['chk_r1_meet_bookings_source_ids', () => h.db.seedPublicBooking({ status: 'failed', reason: 'in_past', ashby_interview_event_id: fixtureId() })],
      ['chk_r1_meet_bookings_source_ids', () => h.db.seedPublicBooking({ status: 'failed', reason: 'in_past', ashby_schedule_id: fixtureId() })],
      ['chk_r1_meet_bookings_source_ids', () => h.db.seedPublicBooking({ status: 'failed', reason: 'in_past', ashby_scheduled_by_user_id: SCHEDULER_ID })],
      ['chk_r1_meet_bookings_source', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', source: 'csv' })],
      ['chk_r1_meet_bookings_source', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', source: null })],
      ['chk_r1_meet_bookings_source', () => h.db.seedPublicBooking({ status: 'failed', reason: 'in_past', source: 'PUBLIC_PAGE' })],
      ['chk_r1_meet_bookings_ashby_application_id', () => h.db.seedPublicBooking({ status: 'failed', reason: 'in_past', ashby_application_id: null })],
      ['chk_r1_meet_bookings_ashby_schedule_id', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', ashby_schedule_id: 'x' })],
      ['chk_r1_meet_bookings_ashby_scheduled_by_user_id', () => h.db.seedBooking({ status: 'failed', reason: 'in_past', ashby_scheduled_by_user_id: 'x' })],
    ];
    for (const [constraint, seed] of bad) {
      expect(seed, constraint).toThrow(`23514 ${constraint}`);
    }
    expect(h.db.tables.r1_meet_bookings).toEqual([]);
  });

  it('a public seed stores the public shape and reads back through the store', async () => {
    const h = createR1MeetHarness();
    const pb = h.createPublicBooking();
    const row = h.db.booking(pb.bookingId)!;
    expect(row).toMatchObject({
      source: 'public_page',
      ashby_interview_event_id: null,
      ashby_schedule_id: null,
      ashby_scheduled_by_user_id: null,
      ashby_interview_stage_id: null,
      ashby_interview_id: null,
      ashby_updated_at: null,
      ashby_application_id: pb.applicationId,
      round_id: pb.roundId,
      candidate_id: pb.candidateId,
      status: 'pending',
      reason: 'eligible',
      version: 0,
      key_attempt: 0,
      recall_bot_id: null,
    });
    expect(h.db.tables.ashby_application_links).toContainEqual({
      provider: 'ashby',
      external_application_id: pb.applicationId,
      candidate_id: pb.candidateId,
      terminal_state: null,
    });
    const booking = await h.db.store.getBooking(pb.bookingId);
    expect(booking).toMatchObject({
      id: pb.bookingId,
      source: 'public_page',
      eventId: null,
      scheduleId: null,
      scheduledByUserId: null,
      applicationId: pb.applicationId,
      roundId: pb.roundId,
      status: 'pending',
    });
    // Two public rows: the event unique index ignores their NULL event ids.
    const other = h.createPublicBooking();
    expect(await h.db.store.getBooking(other.bookingId)).toMatchObject({ source: 'public_page', eventId: null });
    // A public row projects to exactly the selected columns too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = h.db.client as any;
    const answer = (await client.from('r1_meet_bookings').select(R1_MEET_BOOKING_COLUMNS).eq('id', pb.bookingId).maybeSingle()) as FakeAnswer;
    expect(Object.keys(answer.data as Row).sort()).toEqual(R1_MEET_BOOKING_COLUMNS.split(',').map((c) => c.trim()).sort());
    expect((answer.data as Row).source).toBe('public_page');
  });
});

// ── 0143's calendar half (M035 S05) ─────────────────────────────────────────

/** 64-hex fixtures, built at run time (never a digest-shaped literal). */
const A_DIGEST = 'a'.repeat(64);
const B_DIGEST = 'b'.repeat(64);
const KEY_A_DIGEST = 'c'.repeat(64);
const KEY_B_DIGEST = 'd'.repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOT_STATUSES = ['bot_scheduled', 'bot_joining', 'human_present', 'in_call'];

/** A public booking at `status` on its own round (and a bot where the status holds one). */
function publicAt(h: R1MeetHarness, status: string, over: Record<string, unknown> = {}): Row {
  const round = h.db.addRound();
  return h.db.seedPublicBooking({
    round_id: round.id,
    status,
    reason: FAKE_STATUS_REASONS[status]![0]!,
    recall_bot_id: BOT_STATUSES.includes(status) ? fixtureId() : null,
    ...over,
  });
}

/** The same for an Ashby booking. */
function ashbyAt(h: R1MeetHarness, status: string, over: Record<string, unknown> = {}): Row {
  const round = h.db.addRound();
  return h.db.seedBooking({
    round_id: round.id,
    status,
    reason: FAKE_STATUS_REASONS[status]![0]!,
    recall_bot_id: BOT_STATUSES.includes(status) ? fixtureId() : null,
    ...over,
  });
}

/** A plain table UPDATE of the status (the 0143 §3 trigger is on any UPDATE OF status). */
async function setStatus(h: R1MeetHarness, id: string, to: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = h.db.client as any;
  const answer = (await client.from('r1_meet_bookings').update({ status: to, reason: FAKE_STATUS_REASONS[to]![0]! }).eq('id', id)) as FakeAnswer;
  expect(answer.error, `${id} -> ${to}`).toBeNull();
}

/** The jobs of one booking, as [payload, dedup key, max attempts]. */
const jobsOf = (h: R1MeetHarness, id: string): Array<[Row, string, number]> =>
  h.db.jobs().filter((job) => job.payload.booking_id === id).map((job) => [job.payload, job.dedup_key, job.max_attempts]);

/** The two 0143 triggers as the migration writes them: the job inserts and the WHEN lists. */
function triggerSql() {
  const INSERT = /values \('r1-meet', jsonb_build_object\('kind', '(\w+)', 'op', '(\w+)', 'booking_id', (new|old)\.id\), '([^']+)' \|\| (?:new|old)\.id::text \|\| '([^']+)', (\d+)\) on conflict do nothing;/g;
  const inserts = (fn: string) =>
    [...fn.matchAll(INSERT)].map((m) => ({ kind: m[1]!, op: m[2]!, row: m[3]!, prefix: m[4]!, suffix: m[5]!, attempts: Number(m[6]) }));
  const terminalFn = functionText0143('enqueue_r1_meet_public_terminal');
  const purgeFn = functionText0143('enqueue_r1_meet_calendar_purge');
  const cancelIf = /if new\.calendar_state in \(([^)]*)\) then/.exec(terminalFn);
  const terminalWhen = new RegExp(
    String.raw`create trigger enqueue_r1_meet_public_terminal after update of status on screening_v2\.r1_meet_bookings for each row `
      + String.raw`when \(new\.source = 'public_page' and new\.status in \(([^)]*)\) and old\.status not in \(([^)]*)\)\) `
      + String.raw`execute function screening_v2\.enqueue_r1_meet_public_terminal\(\);`,
  ).exec(sql0143);
  const purgeWhen = new RegExp(
    String.raw`create trigger enqueue_r1_meet_calendar_purge after delete on screening_v2\.r1_meet_bookings for each row `
      + String.raw`when \(old\.source = 'public_page' and old\.calendar_state in \(([^)]*)\)\) `
      + String.raw`execute function screening_v2\.enqueue_r1_meet_calendar_purge\(\);`,
  ).exec(sql0143);
  expect(cancelIf, 'the terminal trigger cancel if').not.toBeNull();
  expect(terminalWhen, 'the terminal trigger WHEN').not.toBeNull();
  expect(purgeWhen, 'the purge trigger WHEN').not.toBeNull();
  return {
    terminalFn,
    terminal: inserts(terminalFn),
    purge: inserts(purgeFn),
    cancelWhen: quoted(cancelIf![1]!),
    newStatuses: quoted(terminalWhen![1]!),
    oldNotIn: quoted(terminalWhen![2]!),
    purgeWhen: quoted(purgeWhen![1]!),
  };
}

/** One RPC answer: its status (or `error:<code>`), and every reached status's sorted keys and fields. */
function answerRecorder(db: R1MeetFakeDb, name: string) {
  const shapes: Record<string, string[]> = {};
  const fields: string[] = [];
  return {
    shapes,
    fields,
    async st(args: Record<string, unknown>): Promise<string> {
      const answer = await call(db, name, args);
      if (answer.error) return `error:${answer.error.code}`;
      const data = answer.data as Row;
      shapes[data.status as string] = Object.keys(data).sort();
      if (data.status === 'invalid_request' && !fields.includes(data.field as string)) fields.push(data.field as string);
      return data.status as string;
    },
  };
}

describe('the 0143 calendar half (M035 S05)', () => {
  it('the public columns, their CHECKs, the unique indexes and the throttle table are the 0143 text', () => {
    const state = /constraint chk_r1_meet_bookings_calendar_state check \(calendar_state is null or calendar_state in \(([^)]*)\)\)/.exec(sql0143);
    expect(state).not.toBeNull();
    expect(quoted(state![1]!)).toEqual([...FAKE_CALENDAR_STATES]);
    expect(sql0143).toContain("constraint chk_r1_meet_bookings_manage_digest check (manage_token_digest is null or manage_token_digest ~ '^[a-f0-9]{64}$')");
    expect(sql0143).toContain('constraint chk_r1_meet_bookings_move_count check (move_count between 0 and 10)');
    expect(sql0143).toContain(
      "add constraint chk_r1_meet_bookings_calendar_event_id check ( google_calendar_event_id is null or google_calendar_event_id = replace(id::text, '-', '') ) not valid;",
    );
    expect(sql0143).toContain(
      "add constraint chk_r1_meet_bookings_public_columns check ( (source = 'ashby' and google_calendar_event_id is null and calendar_state is null "
        + 'and invite_sent_at is null and public_request_id is null and manage_token_digest is null and move_count = 0) '
        + "or (source = 'public_page' and google_calendar_event_id is not null and calendar_state is not null and public_request_id is not null "
        + "and (invite_sent_at is null or calendar_state in ('invited', 'cancelled', 'purged'))) ) not valid;",
    );
    // The six columns: five nullable without a default, move_count 0 by default.
    for (const column of ['google_calendar_event_id text;', 'calendar_state text', 'invite_sent_at timestamptz;', 'public_request_id uuid;', 'manage_token_digest text']) {
      expect(sql0143, column).toContain(`add column if not exists ${column}`);
    }
    expect(sql0143).toContain('add column if not exists move_count smallint not null default 0');
    expect(sql0143).toContain(
      'create unique index if not exists uq_r1_meet_bookings_public_request on screening_v2.r1_meet_bookings (public_request_id) where public_request_id is not null;',
    );
    expect(sql0143).toContain(
      'create unique index if not exists uq_r1_meet_bookings_manage_digest on screening_v2.r1_meet_bookings (manage_token_digest) where manage_token_digest is not null;',
    );
    expect(sql0143).toContain(
      "constraint pk_r1_meet_public_throttle primary key (key_digest, bucket_start), constraint chk_r1_meet_public_throttle_key check (key_digest ~ '^[a-f0-9]{64}$'), constraint chk_r1_meet_public_throttle_hits check (hits >= 0)",
    );
  });

  it('every public-column CHECK answers 23514 by its name (after every 0142 name); the unique indexes 23505', () => {
    const h = createR1MeetHarness();
    const done = { status: 'failed', reason: 'in_past' };
    const ashbyId = fixtureId();
    const bad: Array<[string, () => Row]> = [
      ['chk_r1_meet_bookings_calendar_event_id', () => h.db.seedPublicBooking({ ...done, google_calendar_event_id: 'f'.repeat(32) })],
      ['chk_r1_meet_bookings_calendar_event_id', () => {
        const id = fixtureId();
        return h.db.seedPublicBooking({ ...done, id, google_calendar_event_id: id });
      }],
      ['chk_r1_meet_bookings_calendar_state', () => h.db.seedPublicBooking({ ...done, calendar_state: 'sent' })],
      ['chk_r1_meet_bookings_manage_digest', () => h.db.seedPublicBooking({ ...done, manage_token_digest: 'A'.repeat(64) })],
      ['chk_r1_meet_bookings_manage_digest', () => h.db.seedPublicBooking({ ...done, manage_token_digest: 'a'.repeat(63) })],
      ['chk_r1_meet_bookings_move_count', () => h.db.seedPublicBooking({ ...done, move_count: 11 })],
      ['chk_r1_meet_bookings_move_count', () => h.db.seedPublicBooking({ ...done, move_count: -1 })],
      ['chk_r1_meet_bookings_move_count', () => h.db.seedPublicBooking({ ...done, move_count: 1.5 })],
      // An Ashby row with any public column.
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedBooking({ ...done, id: ashbyId, google_calendar_event_id: ashbyId.replace(/-/g, '') })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedBooking({ ...done, calendar_state: 'created' })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedBooking({ ...done, invite_sent_at: NOW })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedBooking({ ...done, public_request_id: fixtureId() })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedBooking({ ...done, manage_token_digest: A_DIGEST })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedBooking({ ...done, move_count: 1 })],
      // A public row without one of its three, or with an invite time before it was invited.
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedPublicBooking({ ...done, google_calendar_event_id: null })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedPublicBooking({ ...done, calendar_state: null })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedPublicBooking({ ...done, public_request_id: null })],
      ['chk_r1_meet_bookings_public_columns', () => h.db.seedPublicBooking({ ...done, calendar_state: 'created', invite_sent_at: NOW })],
      // Appended AFTER the 0142 CHECKs: a row breaking both answers the 0142 name.
      ['chk_r1_meet_bookings_version', () => h.db.seedPublicBooking({ ...done, version: 51, calendar_state: 'sent' })],
      ['chk_r1_meet_bookings_status_reason', () => h.db.seedBooking({ status: 'failed', reason: 'flag_off', move_count: 1 })],
    ];
    for (const [constraint, seed] of bad) {
      expect(seed, constraint).toThrow(`23514 ${constraint}`);
    }
    expect(h.db.tables.r1_meet_bookings).toEqual([]);

    // What the CHECKs accept: an invite time once invited, cancelled or purged; a digest; 10 moves.
    for (const state of ['invited', 'cancelled', 'purged']) {
      expect(h.db.seedPublicBooking({ ...done, calendar_state: state, invite_sent_at: NOW })).toMatchObject({ calendar_state: state, invite_sent_at: NOW });
    }
    const withDigest = h.db.seedPublicBooking({ ...done, manage_token_digest: A_DIGEST, move_count: 10 });
    expect(withDigest).toMatchObject({ manage_token_digest: A_DIGEST, move_count: 10 });

    // The two unique indexes (partial: NULLs never collide).
    expect(() => h.db.seedPublicBooking({ ...done, manage_token_digest: A_DIGEST })).toThrow('23505 uq_r1_meet_bookings_manage_digest');
    expect(() => h.db.seedPublicBooking({ ...done, public_request_id: withDigest.public_request_id })).toThrow('23505 uq_r1_meet_bookings_public_request');
    expect(h.db.tables.r1_meet_bookings).toHaveLength(4);

    // The throttle table.
    expect(() => h.db.seedThrottle({ key_digest: 'x', hits: 1 })).toThrow('23514 chk_r1_meet_public_throttle_key');
    expect(() => h.db.seedThrottle({ key_digest: null, hits: 1 })).toThrow('23514 chk_r1_meet_public_throttle_key');
    expect(() => h.db.seedThrottle({ key_digest: KEY_A_DIGEST, hits: -1 })).toThrow('23514 chk_r1_meet_public_throttle_hits');
    const hit = h.db.seedThrottle({ key_digest: KEY_A_DIGEST, bucket_start: NOW, hits: 3 });
    expect(hit).toEqual({ key_digest: KEY_A_DIGEST, bucket_start: NOW, hits: 3 });
    expect(() => h.db.seedThrottle({ key_digest: KEY_A_DIGEST, bucket_start: '2030-01-01T10:00:00Z', hits: 1 })).toThrow('23505 pk_r1_meet_public_throttle');
    h.db.seedThrottle({ key_digest: KEY_B_DIGEST, bucket_start: NOW, hits: 1 });
    expect(h.db.tables.r1_meet_public_throttle).toHaveLength(2);
  });

  it('the public seed carries the calendar defaults; every Ashby row carries null and 0; the helpers', async () => {
    const h = createR1MeetHarness();
    const pb = h.createPublicBooking();
    const row = h.db.booking(pb.bookingId)!;
    expect(row).toMatchObject({
      source: 'public_page',
      google_calendar_event_id: pb.bookingId.replace(/-/g, ''),
      calendar_state: 'created',
      invite_sent_at: null,
      manage_token_digest: null,
      move_count: 0,
    });
    expect(row.google_calendar_event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.public_request_id).toMatch(UUID_RE);
    // A given id drives the event id; each seed has its own request id; `row` overrides any default.
    const id = fixtureId();
    const given = h.db.seedPublicBooking({ id, status: 'failed', reason: 'in_past' });
    expect(given).toMatchObject({ id, google_calendar_event_id: id.replace(/-/g, '') });
    expect(given.public_request_id).not.toBe(row.public_request_id);
    expect(h.db.seedPublicBooking({ status: 'failed', reason: 'in_past', calendar_state: 'invited', invite_sent_at: '2030-01-01T10:00:00Z', move_count: 2 }))
      .toMatchObject({ calendar_state: 'invited', invite_sent_at: NOW, move_count: 2 });

    const ashbyValues = { google_calendar_event_id: null, calendar_state: null, invite_sent_at: null, public_request_id: null, manage_token_digest: null, move_count: 0 };
    const created = await h.createBooking();
    expect(h.db.booking(created.bookingId)).toMatchObject({ source: 'ashby', ...ashbyValues });
    expect(h.db.seedBooking({ status: 'failed', reason: 'in_past' })).toMatchObject({ source: 'ashby', ...ashbyValues });

    // linkApplication rows keep their four keys; only linkAshbyCandidate sets external_candidate_id.
    const link = h.db.tables.ashby_application_links.find((l) => l.external_application_id === pb.applicationId)!;
    expect(Object.keys(link).sort()).toEqual(['candidate_id', 'external_application_id', 'provider', 'terminal_state']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = h.db.client as any;
    const before = (await client.from('ashby_application_links').select('external_candidate_id').eq('external_application_id', pb.applicationId).maybeSingle()) as FakeAnswer;
    expect(before.data).toEqual({ external_candidate_id: null });
    const ashbyCandidate = fixtureId();
    expect(h.db.linkAshbyCandidate(pb.applicationId, ashbyCandidate)).toMatchObject({ external_candidate_id: ashbyCandidate, candidate_id: pb.candidateId });
    const after = (await client.from('ashby_application_links').select('external_candidate_id').eq('external_application_id', pb.applicationId).maybeSingle()) as FakeAnswer;
    expect(after.data).toEqual({ external_candidate_id: ashbyCandidate });
    expect(() => h.db.linkAshbyCandidate(fixtureId(), ashbyCandidate)).toThrow('no ashby link');

    // candidates: id and email.
    const candidate = h.db.seedCandidate({ id: pb.candidateId, email: 'sentinel@example.test' });
    expect(candidate).toEqual({ id: pb.candidateId, email: 'sentinel@example.test' });
    expect(h.db.seedCandidate({}).id).toMatch(UUID_RE);
    const read = (await client.from('candidates').select('email').eq('id', pb.candidateId).maybeSingle()) as FakeAnswer;
    expect(read.data).toEqual({ email: 'sentinel@example.test' });
  });

  it('r1_meet_public_set_manage_digest: every answer and its keys are the 0143 catalog; updated_at unchanged; rotation; 23505', async () => {
    const h = createR1MeetHarness();
    const name = 'r1_meet_public_set_manage_digest';
    const rec = answerRecorder(h.db, name);
    const pub = publicAt(h, 'pending');
    const base = { p_booking_id: pub.id, p_digest: A_DIGEST, p_now: at(MIN) };
    expect(await rec.st({ ...base, p_booking_id: null })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_digest: null })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_digest: 'A'.repeat(64) })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_now: null })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_booking_id: fixtureId() })).toBe('not_found');
    expect(await rec.st({ ...base, p_booking_id: ashbyAt(h, 'pending').id })).toBe('not_public');
    for (const terminal of ['completed', 'cancelled', 'failed', 'drained']) {
      expect(await rec.st({ ...base, p_booking_id: publicAt(h, terminal).id }), terminal).toBe('booking_terminal');
    }
    let fill = 0;
    for (const live of ['blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call']) {
      fill += 1;
      expect(await rec.st({ ...base, p_booking_id: publicAt(h, live).id, p_digest: fill.toString(16).repeat(64) }), live).toBe('ok');
    }
    expect(await rec.st({ ...base, p_booking_id: 'not-a-uuid' })).toBe('error:22P02');

    const before = structuredClone(h.db.booking(pub.id)!);
    expect(await rec.st(base)).toBe('ok');
    expect(h.db.booking(pub.id)).toEqual({ ...before, manage_token_digest: A_DIGEST });
    // Rotation: a new digest replaces the old one (the old link dies), updated_at still unchanged.
    expect(await rec.st({ ...base, p_digest: B_DIGEST })).toBe('ok');
    expect(h.db.booking(pub.id)).toEqual({ ...before, manage_token_digest: B_DIGEST });
    // A digest on another booking is the unique index; the call rolls back.
    const other = publicAt(h, 'pending');
    expect(await call(h.db, name, { ...base, p_booking_id: other.id, p_digest: B_DIGEST })).toEqual({
      data: null,
      error: { code: '23505', message: 'uq_r1_meet_bookings_manage_digest' },
    });
    expect(h.db.booking(other.id)!.manage_token_digest).toBeNull();

    const fn = answerShapes(functionText0143(name));
    expect(Object.keys(rec.shapes).sort()).toEqual(catalogAnswers0143(name).sort());
    expect(rec.shapes).toEqual(fn.shapes);
    expect(rec.fields).toEqual([...new Set(fn.fields)]);
    expect(rec.fields).toEqual(['booking_id', 'digest', 'now']);
  });

  it('r1_meet_public_set_manage_digest: the first refusal wins, in the SQL order', async () => {
    const h = createR1MeetHarness();
    const field = async (args: Record<string, unknown>) => ((await call(h.db, 'r1_meet_public_set_manage_digest', args)).data as Row).field;
    expect(await field({ p_booking_id: null, p_digest: 'x', p_now: null })).toBe('booking_id');
    expect(await field({ p_booking_id: fixtureId(), p_digest: 'x', p_now: null })).toBe('digest');
    expect(await field({ p_booking_id: fixtureId(), p_digest: A_DIGEST, p_now: null })).toBe('now');
    // not_public before booking_terminal: an Ashby row that is terminal is not_public.
    const ashby = ashbyAt(h, 'cancelled');
    expect(await status(h.db, 'r1_meet_public_set_manage_digest', { p_booking_id: ashby.id, p_digest: A_DIGEST, p_now: NOW })).toBe('not_public');
  });

  it('r1_meet_public_set_calendar_state: every answer and its keys are the 0143 catalog; invite_sent_at coalesces; updated_at and status untouched', async () => {
    const h = createR1MeetHarness({ publicTriggers: true });
    const name = 'r1_meet_public_set_calendar_state';
    const rec = answerRecorder(h.db, name);
    const pub = publicAt(h, 'pending');
    const base = { p_booking_id: pub.id, p_from: ['created'], p_to: 'invited', p_now: at(MIN) };
    expect(await rec.st({ ...base, p_booking_id: null })).toBe('invalid_request');
    for (const to of [null, 'gone', 'created', 'INVITED']) expect(await rec.st({ ...base, p_to: to }), String(to)).toBe('invalid_request');
    for (const from of [null, 'created', [], [['created']], ['created', 'invited', 'created', 'invited'], [null], ['created', null], ['purged'], ['cancelled']]) {
      expect((await call(h.db, name, { ...base, p_from: from })).data, JSON.stringify(from)).toEqual({ status: 'invalid_request', field: 'from' });
    }
    expect(await rec.st({ ...base, p_from: null })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_to: 'cancelled', p_from: ['purged'] })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_now: null })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_booking_id: fixtureId() })).toBe('not_found');
    expect(await rec.st({ ...base, p_booking_id: ashbyAt(h, 'pending').id })).toBe('not_public');
    expect(await rec.st({ ...base, p_from: ['invited'] })).toBe('state_conflict');
    expect((await call(h.db, name, { ...base, p_from: ['invited'] })).data).toEqual({ status: 'state_conflict', current: 'created' });
    expect(h.db.booking(pub.id)!.calendar_state).toBe('created');

    const before = structuredClone(h.db.booking(pub.id)!);
    expect(await rec.st(base)).toBe('ok');
    expect(h.db.booking(pub.id)).toEqual({ ...before, calendar_state: 'invited', invite_sent_at: at(MIN) });
    // A re-send after a move keeps the FIRST invite time; duplicates in p_from are fine (cardinality <= 3).
    expect((await call(h.db, name, { ...base, p_from: ['created', 'invited', 'invited'], p_now: at(5 * MIN) })).data).toEqual({ status: 'ok', calendar_state: 'invited' });
    expect(h.db.booking(pub.id)).toMatchObject({ calendar_state: 'invited', invite_sent_at: at(MIN) });
    expect(await rec.st({ ...base, p_from: ['invited'], p_to: 'cancelled', p_now: at(6 * MIN) })).toBe('ok');
    expect(await rec.st({ ...base, p_from: ['cancelled'], p_to: 'purged', p_now: at(7 * MIN) })).toBe('ok');
    expect(h.db.booking(pub.id)).toEqual({ ...before, calendar_state: 'purged', invite_sent_at: at(MIN) });
    // No status change: the §3 trigger never fires from here, so nothing was queued.
    expect(h.db.jobs()).toEqual([]);
    expect((await call(h.db, name, { ...base, p_from: ['created', 'invited', 'cancelled'], p_to: 'purged' })).data).toEqual({ status: 'state_conflict', current: 'purged' });

    const fn = answerShapes(functionText0143(name));
    expect(Object.keys(rec.shapes).sort()).toEqual(catalogAnswers0143(name).sort());
    expect(rec.shapes).toEqual(fn.shapes);
    expect(rec.fields).toEqual([...new Set(fn.fields)]);
    expect(rec.fields).toEqual(['booking_id', 'to', 'from', 'now']);
  });

  it('r1_meet_public_set_calendar_state: v_allowed is the port\'s matrix, and every (state, from, to) answers by it', async () => {
    const fn = functionText0143('r1_meet_public_set_calendar_state');
    const tos = /p_to is null or p_to not in \(([^)]*)\)/.exec(fn);
    const allowed = /v_allowed := case p_to when '(\w+)' then array\[([^\]]*)\] else array\[([^\]]*)\] end;/.exec(fn);
    expect(tos).not.toBeNull();
    expect(allowed).not.toBeNull();
    expect(fn).toContain('if cardinality(p_from) not between 1 and 3 or cardinality(array_remove(p_from, null)) <> cardinality(p_from) or not (p_from <@ v_allowed) then');
    expect(fn).toContain('if v_booking.calendar_state <> all(p_from) then');
    expect(fn).toContain("invite_sent_at = case when p_to = 'invited' then coalesce(invite_sent_at, p_now) else invite_sent_at end");
    const fromSql = Object.fromEntries(
      quoted(tos![1]!).map((to) => [to, to === allowed![1] ? quoted(allowed![2]!) : quoted(allowed![3]!)]),
    );
    expect(fromSql).toEqual({ invited: ['created', 'invited'], cancelled: ['created', 'invited'], purged: ['created', 'invited', 'cancelled'] });
    expect(Object.fromEntries(Object.entries(FAKE_CALENDAR_ALLOWED_FROM).map(([to, list]) => [to, [...list]]))).toEqual(fromSql);

    const h = createR1MeetHarness();
    for (const [to, legal] of Object.entries(fromSql)) {
      for (const current of FAKE_CALENDAR_STATES) {
        for (const from of FAKE_CALENDAR_STATES) {
          const row = publicAt(h, 'cancelled', { calendar_state: current });
          const answer = (await call(h.db, 'r1_meet_public_set_calendar_state', { p_booking_id: row.id, p_from: [from], p_to: to, p_now: NOW })).data as Row;
          const label = `${current} [${from}] -> ${to}`;
          if (!legal.includes(from)) expect(answer, label).toEqual({ status: 'invalid_request', field: 'from' });
          else if (from === current) expect(answer, label).toEqual({ status: 'ok', calendar_state: to });
          else expect(answer, label).toEqual({ status: 'state_conflict', current });
          expect(h.db.booking(row.id)!.calendar_state, label).toBe(legal.includes(from) && from === current ? to : current);
        }
        // The whole legal list: ok exactly when the current state is in it.
        const row = publicAt(h, 'cancelled', { calendar_state: current });
        const whole = (await call(h.db, 'r1_meet_public_set_calendar_state', { p_booking_id: row.id, p_from: legal, p_to: to, p_now: NOW })).data as Row;
        expect(whole.status, `${current} ${JSON.stringify(legal)} -> ${to}`).toBe(legal.includes(current) ? 'ok' : 'state_conflict');
      }
    }
  });

  it('r1_meet_public_throttle_prune: every answer is the catalog; strictly older buckets, oldest first, then key order, up to the limit', async () => {
    const h = createR1MeetHarness();
    const name = 'r1_meet_public_throttle_prune';
    const rec = answerRecorder(h.db, name);
    const base = { p_older_than_sec: 172800, p_limit: 5000, p_now: NOW };
    for (const older of [null, 3599, 31536001]) expect(await rec.st({ ...base, p_older_than_sec: older }), String(older)).toBe('invalid_request');
    for (const limit of [null, 0, 5001]) expect(await rec.st({ ...base, p_limit: limit }), String(limit)).toBe('invalid_request');
    expect(await rec.st({ ...base, p_now: null })).toBe('invalid_request');
    expect(await rec.st({ ...base, p_older_than_sec: 3600.5 })).toBe('error:22P02');
    for (const edge of [{ p_older_than_sec: 3600 }, { p_older_than_sec: 31536000 }, { p_limit: 1 }, { p_limit: 5000 }]) {
      expect(await rec.st({ ...base, ...edge }), JSON.stringify(edge)).toBe('ok');
    }

    const bucket = (offsetMs: number, key: string) => h.db.seedThrottle({ key_digest: key, bucket_start: at(offsetMs), hits: 1 });
    bucket(-3 * DAY, KEY_B_DIGEST);
    bucket(-4 * DAY, KEY_B_DIGEST);
    bucket(-3 * DAY, KEY_A_DIGEST);
    bucket(-2 * DAY, KEY_A_DIGEST); // exactly at the cutoff: not older, kept
    bucket(-DAY, KEY_A_DIGEST);
    const left = () => h.db.tables.r1_meet_public_throttle.map((t) => [t.bucket_start, String(t.key_digest)[0]]);
    // Oldest bucket first (-4 d), then the -3 d bucket in key order (c before d).
    expect((await call(h.db, name, { ...base, p_limit: 2 })).data).toEqual({ status: 'ok', deleted: 2 });
    expect(left()).toEqual([[at(-3 * DAY), 'd'], [at(-2 * DAY), 'c'], [at(-DAY), 'c']]);
    expect((await call(h.db, name, base)).data).toEqual({ status: 'ok', deleted: 1 });
    expect((await call(h.db, name, base)).data).toEqual({ status: 'ok', deleted: 0 });
    expect(left()).toEqual([[at(-2 * DAY), 'c'], [at(-DAY), 'c']]);

    const fn = answerShapes(functionText0143(name));
    expect(Object.keys(rec.shapes).sort()).toEqual(catalogAnswers0143(name).sort());
    expect(rec.shapes).toEqual(fn.shapes);
    expect(rec.fields).toEqual([...new Set(fn.fields)]);
    expect(rec.fields).toEqual(['older_than', 'limit', 'now']);
  });

  it('the triggers are the 0143 text: payloads, dedup keys, attempts and WHEN clauses', async () => {
    const t = triggerSql();
    expect(t.terminal).toEqual([
      { kind: 'calendar_sync', op: 'cancel', row: 'new', prefix: 'r1-meet:calendar:', suffix: ':cancel', attempts: 10 },
      { kind: 'ashby_booked_tag', op: 'remove', row: 'new', prefix: 'r1-meet:ashby-tag:', suffix: ':remove', attempts: 10 },
    ]);
    expect(t.purge).toEqual([
      { kind: 'calendar_sync', op: 'purge', row: 'old', prefix: 'r1-meet:calendar:', suffix: ':purge', attempts: 10 },
    ]);
    // The calendar cancel sits inside the event-exists `if`; the tag removal after it, always.
    const cancelAt = t.terminalFn.indexOf("'op', 'cancel'");
    const endIf = t.terminalFn.indexOf('end if;');
    expect(cancelAt).toBeGreaterThan(t.terminalFn.indexOf('if new.calendar_state in'));
    expect(endIf).toBeGreaterThan(cancelAt);
    expect(t.terminalFn.indexOf("'op', 'remove'")).toBeGreaterThan(endIf);
    expect({
      newStatuses: t.newStatuses,
      oldNotIn: t.oldNotIn,
      cancelWhen: t.cancelWhen,
      purgeWhen: t.purgeWhen,
    }).toEqual({
      newStatuses: [...FAKE_PUBLIC_TRIGGER_RULES.terminal.newStatuses],
      oldNotIn: [...FAKE_PUBLIC_TRIGGER_RULES.terminal.oldNotIn],
      cancelWhen: [...FAKE_PUBLIC_TRIGGER_RULES.terminal.cancelWhen],
      purgeWhen: [...FAKE_PUBLIC_TRIGGER_RULES.purge.when],
    });

    // The port writes exactly those rows: ids only, in the jsonb_build_object key order.
    const h = createR1MeetHarness({ publicTriggers: true });
    const ended = publicAt(h, 'pending');
    await setStatus(h, ended.id, 'cancelled');
    expect(jobsOf(h, ended.id)).toEqual(
      t.terminal.map((spec) => [{ kind: spec.kind, op: spec.op, booking_id: ended.id }, `${spec.prefix}${ended.id}${spec.suffix}`, spec.attempts]),
    );
    for (const job of h.db.jobs()) {
      expect(Object.keys(job.payload)).toEqual(['kind', 'op', 'booking_id']);
      expect(job).toMatchObject({ name: 'r1-meet', status: 'pending', scheduled_at: NOW, attempts: 0 });
    }
    const deleted = publicAt(h, 'pending');
    h.db.deleteBooking(deleted.id);
    expect(jobsOf(h, deleted.id)).toEqual(
      t.purge.map((spec) => [{ kind: spec.kind, op: spec.op, booking_id: deleted.id }, `${spec.prefix}${deleted.id}${spec.suffix}`, spec.attempts]),
    );
    expect(h.timeline.filter((step) => step.startsWith('queue:'))).toEqual(['queue:calendar_sync', 'queue:ashby_booked_tag', 'queue:calendar_sync']);
  });

  it('the terminal trigger fires exactly by its WHEN: every old status x end status x event state, and never for Ashby rows', async () => {
    const t = triggerSql();
    const h = createR1MeetHarness({ publicTriggers: true });
    const olds = ['pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained'];
    const ends = ['completed', 'cancelled', 'failed', 'drained'];
    for (const source of ['public_page', 'ashby']) {
      for (const state of source === 'ashby' ? [null] : [...FAKE_CALENDAR_STATES]) {
        for (const old of olds) {
          for (const end of ends) {
            const row = source === 'ashby' ? ashbyAt(h, old) : publicAt(h, old, { calendar_state: state });
            await setStatus(h, row.id, end);
            const fires = source === 'public_page' && t.newStatuses.includes(end) && !t.oldNotIn.includes(old);
            const expected = !fires ? [] : [
              ...(t.cancelWhen.includes(state as string) ? [[{ kind: 'calendar_sync', op: 'cancel', booking_id: row.id }, `r1-meet:calendar:${row.id}:cancel`, 10]] : []),
              [{ kind: 'ashby_booked_tag', op: 'remove', booking_id: row.id }, `r1-meet:ashby-tag:${row.id}:remove`, 10],
            ];
            expect(jobsOf(h, row.id), `${source} ${String(state)} ${old} -> ${end}`).toEqual(expected);
          }
        }
      }
    }
    // A live-to-live move never fires; a second terminal update (a reason change) adds nothing.
    for (const [from, to] of [['pending', 'blocked'], ['bot_scheduled', 'bot_joining'], ['bot_joining', 'human_present'], ['human_present', 'in_call']] as const) {
      const row = publicAt(h, from);
      await setStatus(h, row.id, to);
      expect(jobsOf(h, row.id), `${from} -> ${to}`).toEqual([]);
    }
    const twice = publicAt(h, 'pending');
    await setStatus(h, twice.id, 'failed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.db.client as any).from('r1_meet_bookings').update({ reason: 'no_show' }).eq('id', twice.id);
    expect(h.db.booking(twice.id)!.reason).toBe('no_show');
    expect(jobsOf(h, twice.id)).toHaveLength(2);
  });

  it('the purge trigger fires exactly by its WHEN, after the 0142 bot release, through deleteBooking and a table delete', async () => {
    const t = triggerSql();
    const h = createR1MeetHarness({ publicTriggers: true });
    for (const state of FAKE_CALENDAR_STATES) {
      const row = publicAt(h, 'failed', { calendar_state: state });
      h.db.deleteBooking(row.id);
      expect(jobsOf(h, row.id), state).toEqual(
        t.purgeWhen.includes(state) ? [[{ kind: 'calendar_sync', op: 'purge', booking_id: row.id }, `r1-meet:calendar:${row.id}:purge`, 10]] : [],
      );
    }
    const ashby = ashbyAt(h, 'failed');
    h.db.deleteBooking(ashby.id);
    expect(jobsOf(h, ashby.id)).toEqual([]);

    h.timeline.length = 0;
    const held = publicAt(h, 'bot_scheduled');
    h.db.deleteBooking(held.id);
    expect(h.db.jobs().filter((job) => job.payload.booking_id === held.id).map((job) => job.payload.kind)).toEqual(['bot_release', 'calendar_sync']);
    expect(h.timeline).toEqual(['queue:bot_release', 'queue:calendar_sync']);

    const invited = publicAt(h, 'cancelled', { calendar_state: 'invited' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answer = (await (h.db.client as any).from('r1_meet_bookings').delete().eq('id', invited.id)) as FakeAnswer;
    expect(answer.error).toBeNull();
    expect(jobsOf(h, invited.id).map(([payload]) => payload)).toEqual([{ kind: 'calendar_sync', op: 'purge', booking_id: invited.id }]);
  });

  it('the triggers fire from the RPCs and the store, roll back with their transaction, and keep a live job (on conflict do nothing)', async () => {
    const h = createR1MeetHarness({ publicTriggers: true });
    const kinds = (id: string) => jobsOf(h, id).map(([payload]) => `${String(payload.kind)}:${String(payload.op)}`);

    // The transition RPC: the jobs follow the move in the same transaction.
    const failed = publicAt(h, 'pending');
    h.timeline.length = 0;
    expect(await status(h.db, 'r1_meet_transition_booking', { p_booking_id: failed.id, p_from_status: 'pending', p_to_status: 'failed', p_reason: 'invite_undeliverable', p_now: NOW })).toBe('ok');
    expect(h.timeline).toEqual(['db:transition:failed', 'queue:calendar_sync', 'queue:ashby_booked_tag']);
    expect(kinds(failed.id)).toEqual(['calendar_sync:cancel', 'ashby_booked_tag:remove']);

    // A refused write (the pairing CHECK) rolls the jobs back with it.
    const refused = publicAt(h, 'pending');
    expect(await call(h.db, 'r1_meet_transition_booking', { p_booking_id: refused.id, p_from_status: 'pending', p_to_status: 'failed', p_reason: 'candidate_cancelled', p_now: NOW }))
      .toEqual({ data: null, error: { code: '23514', message: 'chk_r1_meet_bookings_status_reason' } });
    expect(kinds(refused.id)).toEqual([]);

    // The cancel RPC (a bot held: its release stays owed), then its replay adds nothing.
    const cancelled = publicAt(h, 'bot_scheduled');
    expect(await status(h.db, 'r1_meet_cancel_booking', { p_booking_id: cancelled.id, p_reason: 'round_cancelled', p_now: NOW })).toBe('ok');
    expect(await status(h.db, 'r1_meet_cancel_booking', { p_booking_id: cancelled.id, p_reason: 'cancelled', p_now: NOW })).toBe('already_cancelled');
    expect(kinds(cancelled.id)).toEqual(['calendar_sync:cancel', 'ashby_booked_tag:remove']);

    // Through the store; and a completed booking ended used, so nothing.
    const drained = publicAt(h, 'bot_scheduled');
    await h.db.store.transition({ bookingId: drained.id, from: 'bot_scheduled', to: 'drained', reason: 'flag_off', nowIso: NOW });
    expect(kinds(drained.id)).toEqual(['calendar_sync:cancel', 'ashby_booked_tag:remove']);
    const used = publicAt(h, 'in_call');
    expect(await status(h.db, 'r1_meet_transition_booking', { p_booking_id: used.id, p_from_status: 'in_call', p_to_status: 'completed', p_reason: 'attempt_settled', p_now: NOW })).toBe('ok');
    expect(kinds(used.id)).toEqual([]);

    // A cancelled event leaves nothing to purge.
    expect(await status(h.db, 'r1_meet_public_set_calendar_state', { p_booking_id: failed.id, p_from: ['created'], p_to: 'cancelled', p_now: NOW })).toBe('ok');
    h.db.deleteBooking(failed.id);
    expect(kinds(failed.id)).toEqual(['calendar_sync:cancel', 'ashby_booked_tag:remove']);

    // A live job with the same key wins; a finished one does not.
    const deduped = publicAt(h, 'pending');
    const key = `r1-meet:calendar:${deduped.id}:cancel`;
    const live = h.db.enqueue({ payload: { kind: 'calendar_sync', op: 'cancel', booking_id: deduped.id }, dedupKey: key, maxAttempts: 10 });
    await setStatus(h, deduped.id, 'failed');
    expect(h.db.jobs().filter((job) => job.dedup_key === key)).toEqual([live]);
    const again = publicAt(h, 'pending');
    const againKey = `r1-meet:calendar:${again.id}:cancel`;
    const done = h.db.enqueue({ payload: { kind: 'calendar_sync', op: 'cancel', booking_id: again.id }, dedupKey: againKey, maxAttempts: 10 });
    done.status = 'completed';
    await setStatus(h, again.id, 'drained');
    expect(h.db.jobs().filter((job) => job.dedup_key === againKey)).toHaveLength(2);

    // `lost`: the RPC commits (and its trigger with it), then the answer is lost.
    const lost = publicAt(h, 'pending');
    h.db.failNext('r1_meet_transition_booking', 'lost');
    expect(await status(h.db, 'r1_meet_transition_booking', { p_booking_id: lost.id, p_from_status: 'pending', p_to_status: 'failed', p_reason: 'in_past', p_now: NOW })).toBe('error:08006');
    expect(kinds(lost.id)).toEqual(['calendar_sync:cancel', 'ashby_booked_tag:remove']);
  });

  it('publicTriggers is off by default: the same moves queue nothing new (the M034 suites and S02 twins stay equal)', async () => {
    for (const h of [createR1MeetHarness(), createR1MeetHarness({ publicTriggers: false })]) {
      const ended = publicAt(h, 'bot_scheduled');
      await h.db.store.transition({ bookingId: ended.id, from: 'bot_scheduled', to: 'failed', reason: 'no_show', nowIso: NOW });
      const cancelled = publicAt(h, 'pending');
      await h.db.store.cancel({ bookingId: cancelled.id, reason: 'cancelled', nowIso: NOW });
      const deleted = publicAt(h, 'bot_scheduled');
      h.db.deleteBooking(deleted.id);
      expect(h.db.jobs().map((job) => job.payload.kind)).toEqual(['bot_release']);
      expect(h.timeline).toEqual(['db:transition:failed', 'db:cancel_booking', 'queue:bot_release']);
    }
    const db = createR1MeetFakeDb();
    const row = db.seedPublicBooking({ status: 'pending', reason: 'eligible', round_id: db.addRound().id });
    db.deleteBooking(row.id);
    expect(db.jobs()).toEqual([]);
  });
});
