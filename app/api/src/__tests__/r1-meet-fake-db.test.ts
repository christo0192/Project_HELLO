/**
 * M034 S06 T2: the in-memory 0142 port (support/r1-meet-fake-db.ts) is held to the migration text, so
 * the runtime suites that run on it cannot drift from the database they stand in for.
 *
 * Pinned:
 *  - the status/reason pairing and the transition matrix equal the SQL of
 *    `chk_r1_meet_bookings_status_reason` and `r1_meet_transition_booking`, parsed from 0142;
 *  - every answer of every RPC the runtime and the bridge page call is reachable through the port, and
 *    the set of answers equals the RPC's catalog comment (the one answer the CHECKs make unreachable is
 *    named, with why);
 *  - a write that breaks a CHECK (pairing, round and bot binding, ticket, counters) answers
 *    `{ code: '23514' }` and rolls the whole call back; a unique index answers `23505`;
 *  - the first refusal wins, in the SQL's order;
 *  - the tables answer the store's reads (projection, count, JSON paths, compare-and-set update), the
 *    two triggers, the queue dedup, and `failNext`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { R1_MEET_BOOKING_REASONS, R1_MEET_BOOKING_STATUSES } from '../lib/r1/meet/bookings-read.js';
import { R1_MEET_BOOKING_COLUMNS, R1_MEET_RPC_ANSWERS, type R1MeetRpcName } from '../lib/r1/meet/runtime-store.js';
import { r1MeetTicketDigest, r1MeetTicketWindow } from '../lib/r1/meet/ticket.js';
import {
  FAKE_STATUS_REASONS,
  FAKE_TRANSITIONS,
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

function functionText(name: string): string {
  const start = sql.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

function catalogAnswers(name: string): string[] {
  const statement = new RegExp(String.raw`comment on function screening_v2\.${name}\([^)]*\) is ((?:'(?:[^']|'')*' ?)+);`).exec(sql);
  expect(statement, name).not.toBeNull();
  const text = [...statement![1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!).join('');
  const list = text.slice(text.indexOf('Answers ') + 'Answers '.length);
  return list.split('|').map((part) => /^\s*([a-z_]+)/.exec(part)?.[1] ?? `unreadable: ${part}`);
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
  it('chk_r1_meet_bookings_status_reason: the reasons of each status', () => {
    const start = sql.indexOf('constraint chk_r1_meet_bookings_status_reason check (');
    const block = sql.slice(start, sql.indexOf('constraint chk_r1_meet_bookings_version', start));
    const pairs = [...block.matchAll(/status in \(([^)]*)\) and reason in \(([^)]*)\)/g)];
    expect(pairs.length).toBe(8);
    const fromSql: Record<string, string[]> = {};
    for (const [, statuses, reasons] of pairs) {
      for (const s of quoted(statuses!)) fromSql[s] = [...(fromSql[s] ?? []), ...quoted(reasons!)];
    }
    const sorted = (record: Readonly<Record<string, readonly string[]>>): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(record)
          .map(([key, list]): [string, string[]] => [key, [...list].sort()])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    expect(sorted(FAKE_STATUS_REASONS)).toEqual(sorted(fromSql));
    expect(Object.keys(FAKE_STATUS_REASONS).sort()).toEqual([...R1_MEET_BOOKING_STATUSES].sort());
    expect([...new Set(Object.values(FAKE_STATUS_REASONS).flat())].sort()).toEqual([...R1_MEET_BOOKING_REASONS].sort());
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
