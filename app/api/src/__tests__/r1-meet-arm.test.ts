/**
 * M034 S06 T2: arming the bridge (lib/r1/meet/arm.ts), through the REAL Recall client over the S01
 * fake and the in-memory 0142 port.
 *
 * Pinned (D-S06-25, D-S06-26, contract section 9 "S05 T1" item 6):
 *  - the order GET -> r1_meet_arm_ticket -> bridge_check job (+45 s, keyed by the answered arm) ->
 *    output_media, each only after the previous one succeeded; no Idempotency-Key on output_media;
 *  - the page URL is `<origin>/candidate/r1/meet#t=<ticket>` and the stored digest is that ticket's;
 *    `not_before` lies at or before the bot's join time;
 *  - `digest_in_use` and `duplicate` mint again (at most 3); any other refusal alerts and stops; an
 *    ended or deleted bot gets nothing; a retriable output_media is retried in the same run with the
 *    same URL after 2, 4 and 8 s (no new arm, within 30 s), then the job defers 20 s, doubling per
 *    deferral up to 120 s (S06-R4); a permanent refusal alerts;
 *  - at create: the body carries the page, the derived ticket is identical for a retried create and
 *    different per generation and key attempt, armed right after the attach (`duplicate` is success);
 *    no secret means no output media;
 *  - the ticket and its digest never reach a log line, a job payload or a thrown error.
 */

import { describe, expect, it } from 'vitest';
import { ensureBot } from '../lib/r1/meet/bot-flow.js';
import {
  R1_MEET_CREATE_TICKET_DOMAIN,
  R1_MEET_OUTPUT_MEDIA_RETRY_BUDGET_MS,
  R1_MEET_OUTPUT_MEDIA_RETRY_WAITS_MS,
  armBridge,
  armR1MeetCreateTicket,
  deriveR1MeetCreateTicket,
  r1MeetOutputMediaDeferSeconds,
} from '../lib/r1/meet/arm.js';
import type { R1MeetBooking } from '../lib/r1/meet/runtime-store.js';
import {
  R1_MEET_TICKET_PATTERN,
  r1MeetDerivedKey,
  r1MeetTicketDigest,
  r1MeetTicketWindow,
} from '../lib/r1/meet/ticket.js';
import {
  BRIDGE_PAGE_URL,
  BRIDGE_SOURCE,
  createR1MeetHarness,
  fixtureId,
  type HarnessOptions,
  type R1MeetHarness,
} from './support/r1-meet-harness.js';

/** Distinct, predictable random bytes per mint: byte value n for the n-th mint. */
function countingRandom(): (bytes: number) => Buffer {
  let n = 0;
  return (bytes) => Buffer.alloc(bytes, ++n);
}
const ticketOfFill = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');
const digestOf = (ticket: string): string => r1MeetTicketDigest(ticket, BRIDGE_SOURCE)!;

/** A booking with an attached bot, moved to human_present, as the event handler would hand it over. */
async function humanPresent(options: HarnessOptions = {}): Promise<{ h: R1MeetHarness; booking: R1MeetBooking; botId: string }> {
  const h = createR1MeetHarness({ random: countingRandom(), ...options });
  const created = await h.createBooking();
  await ensureBot(h.deps, created.bookingId, h.meta());
  const moved = await h.db.store.transition({
    bookingId: created.bookingId,
    from: 'bot_scheduled',
    to: 'human_present',
    reason: 'eligible',
    nowIso: new Date(h.now()).toISOString(),
  });
  expect(moved.status).toBe('ok');
  const booking = (await h.db.store.getBooking(created.bookingId))!;
  h.timeline.length = 0;
  h.requests.length = 0;
  h.logs.length = 0;
  return { h, booking, botId: booking.recallBotId! };
}

const outputMedia = (h: R1MeetHarness) => h.requests.filter((request) => request.op === 'output_media');
const pageUrlOf = (request: { body: unknown }) => (request.body as { camera: { config: { url: string } } }).camera.config.url;

function expectSecretsAbsent(h: R1MeetHarness, secrets: readonly string[], extra: readonly unknown[] = []): void {
  const haystack = JSON.stringify({ logs: h.logs, jobs: h.db.tables.job_queue, extra });
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

describe('armBridge: the human-present arm (D-S06-25)', () => {
  it('runs GET -> arm -> bridge_check -> output_media and posts the page URL of the armed ticket', async () => {
    const { h, booking, botId } = await humanPresent();
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toEqual({ outcome: 'done', receipt: 'processed', code: 'armed' });
    expect(h.timeline).toEqual(['recall:get', 'db:arm_ticket', 'queue:bridge_check', 'recall:output_media']);

    const [post] = outputMedia(h);
    expect(post!.path).toBe(`/api/v1/bot/${botId}/output_media/`);
    expect(post!.headers['idempotency-key']).toBeUndefined();
    const url = pageUrlOf(post!);
    expect(url.startsWith(`${BRIDGE_PAGE_URL}#t=`)).toBe(true);
    const ticket = url.slice(`${BRIDGE_PAGE_URL}#t=`.length);
    expect(ticket).toMatch(R1_MEET_TICKET_PATTERN);
    expect(ticket).toBe(ticketOfFill(1));

    const row = h.db.booking(booking.id)!;
    expect(row.ticket_digest).toBe(digestOf(ticket));
    expect(row.ticket_arms).toBe(1);
    expect(row.ticket_claimed_at).toBeNull();
    // The window opens at or before the bot's join time (start - 120 s): a 425 never meets the page.
    const joinAt = Date.parse(booking.startAt) - 120_000;
    expect(Date.parse(row.ticket_not_before)).toBeLessThanOrEqual(joinAt);
    expect(row.ticket_not_before).toBe(new Date(Date.parse(booking.startAt) - 300_000).toISOString());
    expect(row.ticket_expires_at).toBe(new Date(Date.parse(booking.endAt) + 900_000).toISOString());

    const [check] = h.db.jobs('bridge_check');
    expect(check).toMatchObject({
      payload: { kind: 'bridge_check', booking_id: booking.id, version: 0, arm: 1 },
      dedup_key: `r1-meet:bridge-check:${booking.id}:v0:a1`,
      max_attempts: 10,
      scheduled_at: new Date(h.now() + 45_000).toISOString(),
    });
    expect(h.recall.bots.get(botId)!.outputMedia).toBe('webpage');
    expectSecretsAbsent(h, [ticket, row.ticket_digest, url, booking.meetUrl]);
  });

  it('the bridge page can claim exactly the armed ticket (the page half of the fake)', async () => {
    const { h, booking } = await humanPresent();
    await armBridge(h.deps, booking, h.meta());
    const ticket = pageUrlOf(outputMedia(h)[0]!).split('#t=')[1]!;
    h.advance(24 * 3600 * 1000 - 200_000); // inside the window (start - 5 min .. end + 15 min)
    const claimed = await h.db.claimTicket(ticket, new Date(h.now()).toISOString(), BRIDGE_SOURCE);
    expect(claimed.data).toMatchObject({ status: 'ok', booking_id: booking.id });
    expect(h.db.booking(booking.id)).toMatchObject({ status: 'in_call' });
    const again = await h.db.claimTicket(ticket, new Date(h.now()).toISOString(), BRIDGE_SOURCE);
    expect(again.data).toMatchObject({ status: 'ticket_already_claimed' });
  });

  it('digest_in_use mints again: the second ticket is armed and posted', async () => {
    const { h, booking } = await humanPresent();
    // Another booking already holds the digest of the first ticket the seam will produce.
    const round = h.db.addRound();
    const window = r1MeetTicketWindow({ startAt: booking.startAt, endAt: booking.endAt, botJoinLeadSec: 120, nowMs: h.now() })!;
    h.db.seedBooking({
      round_id: round.id,
      status: 'bot_scheduled',
      recall_bot_id: fixtureId(),
      start_at: booking.startAt,
      end_at: booking.endAt,
      ticket_digest: digestOf(ticketOfFill(1)),
      ticket_not_before: window.not_before,
      ticket_expires_at: window.expires_at,
      ticket_arms: 1,
    });
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'armed' });
    expect(h.timeline).toEqual(['recall:get', 'db:arm_ticket', 'db:arm_ticket', 'queue:bridge_check', 'recall:output_media']);
    expect(pageUrlOf(outputMedia(h)[0]!)).toBe(`${BRIDGE_PAGE_URL}#t=${ticketOfFill(2)}`);
    expect(h.db.booking(booking.id)!.ticket_digest).toBe(digestOf(ticketOfFill(2)));
  });

  it('duplicate (the same unclaimed ticket again) mints again; the check is keyed by the new arm count', async () => {
    const { h, booking } = await humanPresent();
    const window = r1MeetTicketWindow({ startAt: booking.startAt, endAt: booking.endAt, botJoinLeadSec: 120, nowMs: h.now() })!;
    const first = await h.db.store.armTicket({
      bookingId: booking.id,
      ticketDigest: digestOf(ticketOfFill(1)),
      notBefore: window.not_before,
      expiresAt: window.expires_at,
      nowIso: new Date(h.now()).toISOString(),
    });
    expect(first).toMatchObject({ status: 'ok', ticketArms: 1 });
    h.timeline.length = 0;
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'armed' });
    expect(h.timeline.filter((step) => step === 'db:arm_ticket')).toHaveLength(2);
    expect(h.db.booking(booking.id)!.ticket_arms).toBe(2);
    expect(h.db.jobs('bridge_check')[0]!.payload).toEqual({ kind: 'bridge_check', booking_id: booking.id, version: 0, arm: 2 });
  });

  it('three refused mints stop with an alert: no check, no output_media', async () => {
    const { h, booking } = await humanPresent({ random: (bytes) => Buffer.alloc(bytes, 7) });
    const round = h.db.addRound();
    const window = r1MeetTicketWindow({ startAt: booking.startAt, endAt: booking.endAt, botJoinLeadSec: 120, nowMs: h.now() })!;
    h.db.seedBooking({
      round_id: round.id,
      status: 'bot_scheduled',
      recall_bot_id: fixtureId(),
      ticket_digest: digestOf(ticketOfFill(7)),
      ticket_not_before: window.not_before,
      ticket_expires_at: window.expires_at,
      start_at: booking.startAt,
      end_at: booking.endAt,
    });
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toEqual({ outcome: 'done', receipt: 'ignored', code: 'arm_remint_exhausted' });
    expect(h.timeline).toEqual(['recall:get', 'db:arm_ticket', 'db:arm_ticket', 'db:arm_ticket']);
    expect(h.logs.map((line) => line.meta).filter((meta) => meta.error_category === 'r1_meet_arm_refused')).toEqual([
      { error_category: 'r1_meet_arm_refused', error_type: 'remint_exhausted' },
    ]);
    expect(h.db.jobs('bridge_check')).toEqual([]);
  });

  it('ticket_arms_exhausted and not_armable alert and stop', async () => {
    const exhausted = await humanPresent();
    exhausted.h.db.booking(exhausted.booking.id)!.ticket_arms = 5;
    await expect(armBridge(exhausted.h.deps, exhausted.booking, exhausted.h.meta())).resolves.toMatchObject({
      receipt: 'ignored',
      code: 'arm_ticket_arms_exhausted',
    });
    expect(outputMedia(exhausted.h)).toEqual([]);
    expect(exhausted.h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_arm_refused', error_type: 'ticket_arms_exhausted' },
    ]);

    // The booking moved on (cancelled) after the caller read it.
    const moved = await humanPresent();
    await moved.h.db.store.cancel({ bookingId: moved.booking.id, reason: 'cancelled', nowIso: new Date(moved.h.now()).toISOString() });
    await expect(armBridge(moved.h.deps, moved.booking, moved.h.meta())).resolves.toMatchObject({ code: 'arm_not_armable' });
    expect(outputMedia(moved.h)).toEqual([]);
    expect(moved.h.db.jobs('bridge_check')).toEqual([]);
  });

  it('an ended or deleted bot gets no ticket: GET only', async () => {
    const ended = await humanPresent();
    ended.h.recall.markDispatched(ended.botId);
    ended.h.recall.setStatus(ended.botId, 'call_ended');
    await expect(armBridge(ended.h.deps, ended.booking, ended.h.meta())).resolves.toMatchObject({ receipt: 'ignored', code: 'bot_ended' });
    expect(ended.h.timeline).toEqual(['recall:get']);
    expect(ended.h.db.booking(ended.booking.id)!.ticket_arms).toBe(0);

    const gone = await humanPresent();
    gone.h.recall.bots.delete(gone.botId);
    await expect(armBridge(gone.h.deps, gone.booking, gone.h.meta())).resolves.toMatchObject({ code: 'bot_gone' });
    expect(gone.h.timeline).toEqual(['recall:get']);

    const down = await humanPresent();
    down.h.intercept('get', { status: 503 });
    await expect(armBridge(down.h.deps, down.booking, down.h.meta())).resolves.toMatchObject({ outcome: 'defer', code: 'r1_meet_recall_unavailable' });
    expect(down.h.timeline).toEqual(['recall:get']);
  });

  it('a retriable output_media is retried in the same run after 2 s with the SAME URL (no new arm)', async () => {
    const { h, booking } = await humanPresent();
    h.intercept('output_media', { status: 503 });
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'armed' });
    const posts = outputMedia(h);
    expect(posts).toHaveLength(2);
    expect(pageUrlOf(posts[0]!)).toBe(pageUrlOf(posts[1]!));
    expect(h.sleeps).toEqual([2_000]);
    expect(h.db.booking(booking.id)!.ticket_arms).toBe(1);
  });

  it('three retriable failures: retried after 2, 4 and 8 s, the fourth post of the same page lands', async () => {
    const { h, booking } = await humanPresent();
    h.intercept('output_media', 'network');
    h.intercept('output_media', { status: 502 });
    h.intercept('output_media', { status: 504 });
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'armed' });
    expect(outputMedia(h)).toHaveLength(4);
    expect(new Set(outputMedia(h).map(pageUrlOf)).size).toBe(1);
    expect(h.sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(h.db.booking(booking.id)!.ticket_arms).toBe(1);
  });

  describe('Retry-After is honoured in the run (PR #444 review round 2, S06-R4)', () => {
    it('a 429 asking for 30 s or more is not re-posted in this run: the job defers by its Retry-After', async () => {
      for (const [seconds, delay] of [['31', 31], ['45', 45], ['600', 300]] as const) {
        const { h, booking } = await humanPresent();
        h.intercept('output_media', { status: 429, headers: { 'Retry-After': seconds } });
        await expect(armBridge(h.deps, booking, h.meta()), seconds).resolves.toEqual({
          outcome: 'defer',
          code: 'r1_meet_recall_unavailable',
          delaySeconds: delay,
        });
        expect(outputMedia(h), seconds).toHaveLength(1);
        expect(h.sleeps, seconds).toEqual([]);
        expect(h.db.booking(booking.id)!.ticket_arms, seconds).toBe(1);
      }
    });

    it('a 429 asking for a short wait is re-posted after that wait (never sooner), with the same page', async () => {
      const { h, booking } = await humanPresent();
      h.intercept('output_media', { status: 429, headers: { 'Retry-After': '5' } });
      h.intercept('output_media', { status: 429, headers: { 'Retry-After': '1' } });
      await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'armed' });
      // max(2 s planned, 5 s asked), then max(4 s planned, 1 s asked).
      expect(h.sleeps).toEqual([5_000, 4_000]);
      expect(outputMedia(h)).toHaveLength(3);
      expect(new Set(outputMedia(h).map(pageUrlOf)).size).toBe(1);
      expect(h.db.booking(booking.id)!.ticket_arms).toBe(1);
    });

    it('a 429 without Retry-After waits the client fallback (30 s), and a second one defers 30 s', async () => {
      const { h, booking } = await humanPresent();
      h.intercept('output_media', { status: 429 });
      h.intercept('output_media', { status: 429 });
      await expect(armBridge(h.deps, booking, h.meta())).resolves.toEqual({
        outcome: 'defer',
        code: 'r1_meet_recall_unavailable',
        delaySeconds: 30,
      });
      expect(h.sleeps).toEqual([30_000]);
      expect(outputMedia(h)).toHaveLength(2);
    });

    it('a 503 or 507 with a long Retry-After defers by it; a 503 without one keeps the 2 s schedule', async () => {
      for (const status of [503, 507]) {
        const { h, booking } = await humanPresent();
        h.intercept('output_media', { status, headers: { 'Retry-After': '60' } });
        await expect(armBridge(h.deps, booking, h.meta()), String(status)).resolves.toEqual({
          outcome: 'defer',
          code: 'r1_meet_recall_unavailable',
          delaySeconds: 60,
        });
        expect(outputMedia(h), String(status)).toHaveLength(1);
        expect(h.sleeps, String(status)).toEqual([]);
      }
      const { h, booking } = await humanPresent();
      h.intercept('output_media', { status: 503 });
      await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'armed' });
      expect(h.sleeps).toEqual([2_000]);
    });
  });

  it('four retriable failures defer the job 20 s (a re-run arms a fresh ticket); the floor doubles per deferral', async () => {
    const { h, booking } = await humanPresent();
    for (const response of ['network', { status: 502 }, { status: 503 }, 'network'] as const) h.intercept('output_media', response);
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toEqual({
      outcome: 'defer',
      code: 'r1_meet_recall_unavailable',
      delaySeconds: 20,
    });
    expect(outputMedia(h)).toHaveLength(4);
    // The check of this arm is queued already, so a dead run still gets its recovery.
    expect(h.db.jobs('bridge_check')).toHaveLength(1);

    // The re-run (first deferral) fails the same way: it waits 40 s.
    for (let i = 0; i < 4; i += 1) h.intercept('output_media', { status: 503 });
    const second = await armBridge(h.deps, (await h.db.store.getBooking(booking.id))!, h.meta({ deferCount: 1 }));
    expect(second).toEqual({ outcome: 'defer', code: 'r1_meet_recall_unavailable', delaySeconds: 40 });
    expect(h.db.booking(booking.id)!.ticket_arms).toBe(2);

    const rerun = await armBridge(h.deps, (await h.db.store.getBooking(booking.id))!, h.meta({ deferCount: 2 }));
    expect(rerun).toMatchObject({ code: 'armed' });
    expect(h.db.booking(booking.id)!.ticket_arms).toBe(3);
    expect(pageUrlOf(outputMedia(h)[8]!)).toBe(`${BRIDGE_PAGE_URL}#t=${ticketOfFill(3)}`);
  });

  it('the in-run retries stop at the 30 s budget (slow failures), and the deferral floor is 20, 40, 80, 120 s', async () => {
    expect([...R1_MEET_OUTPUT_MEDIA_RETRY_WAITS_MS]).toEqual([2_000, 4_000, 8_000]);
    expect(R1_MEET_OUTPUT_MEDIA_RETRY_BUDGET_MS).toBe(30_000);
    expect([0, 1, 2, 3, 4, 30, -1, Number.NaN].map(r1MeetOutputMediaDeferSeconds)).toEqual([20, 40, 80, 120, 120, 120, 20, 20]);

    const { h, booking } = await humanPresent();
    // Each failure comes back after 13 s (a slow gateway): the 30 s budget ends the retries.
    let posts = 0;
    const slow503 = (_req: unknown, op: string): boolean => {
      if (op !== 'output_media') return false;
      posts += 1;
      h.advance(13_000);
      return true;
    };
    for (let i = 0; i < 4; i += 1) h.intercept(slow503, { status: 503 });
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ outcome: 'defer', delaySeconds: 20 });
    // 13 s + 2 s + 13 s = 28 s spent; a 4 s wait would pass 30 s.
    expect(posts).toBe(2);
    expect(h.sleeps).toEqual([2_000]);
  });

  it('a permanent refusal alerts without a retry; 404, completed and unstarted bots, and 401 are mapped', async () => {
    const refused = await humanPresent();
    refused.h.intercept('output_media', { status: 400, body: { camera: ['Invalid.'] } });
    await expect(armBridge(refused.h.deps, refused.booking, refused.h.meta())).resolves.toMatchObject({
      receipt: 'ignored',
      code: 'output_media_refused',
    });
    expect(outputMedia(refused.h)).toHaveLength(1);
    expect(refused.h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_output_media_refused', error_type: 'bad_request', http_status: 400 },
    ]);

    const cases: Array<[unknown, Record<string, unknown>]> = [
      [{ status: 404, body: { detail: 'Not found.' } }, { code: 'bot_gone' }],
      [{ status: 400, body: { code: 'cannot_command_completed_bot' } }, { code: 'bot_ended' }],
      [{ status: 400, body: { code: 'cannot_command_unstarted_bot' } }, { outcome: 'defer', delaySeconds: 20 }],
      [{ status: 401 }, { outcome: 'defer', code: 'r1_meet_recall_rejected', delaySeconds: 300 }],
    ];
    for (const [response, expected] of cases) {
      const { h, booking } = await humanPresent();
      h.intercept('output_media', response as { status: number });
      await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject(expected);
      expect(outputMedia(h)).toHaveLength(1);
    }
  });

  it('no bridge key, or a closed window, arms nothing and alerts', async () => {
    const { h, booking } = await humanPresent({ ticketSource: {} as NodeJS.ProcessEnv });
    await expect(armBridge(h.deps, booking, h.meta())).resolves.toMatchObject({ code: 'arm_no_ticket' });
    expect(h.timeline).toEqual(['recall:get']);
    expect(h.alerts()).toEqual(['r1_meet_arm_refused']);

    const late = await humanPresent();
    late.h.setNow(Date.parse(late.booking.endAt) + 900_000);
    await expect(armBridge(late.h.deps, late.booking, late.h.meta())).resolves.toMatchObject({ code: 'arm_no_ticket' });
  });

  it('the ticket and digest never reach a log, a payload or a thrown error', async () => {
    const { h, booking } = await humanPresent();
    h.db.failNext('r1_meet_arm_ticket', 'lost');
    const thrown = await armBridge(h.deps, booking, h.meta()).catch((error: unknown) => error);
    expect((thrown as Error).message).toBe('r1_meet_db_error');
    // The lost answer committed the arm; the retry arms a fresh one and posts it.
    for (let i = 0; i < 4; i += 1) h.intercept('output_media', 'network');
    const deferred = await armBridge(h.deps, (await h.db.store.getBooking(booking.id))!, h.meta({ attempts: 2 }));
    expect(deferred).toMatchObject({ outcome: 'defer' });
    const tickets = [ticketOfFill(1), ticketOfFill(2)];
    const secrets = [...tickets, ...tickets.map(digestOf), ...tickets.map((ticket) => `${BRIDGE_PAGE_URL}#t=${ticket}`)];
    expectSecretsAbsent(h, secrets, [thrown, String(thrown), deferred]);
  });
});

describe('arm at create (D-S06-26)', () => {
  it('the create body carries the page; the derived ticket is armed right after the attach', async () => {
    const h = createR1MeetHarness({ config: { armAtCreate: true } });
    const created = await h.createBooking();
    h.timeline.length = 0;
    await expect(ensureBot(h.deps, created.bookingId, h.meta())).resolves.toMatchObject({ code: 'bot_scheduled' });
    expect(h.timeline).toEqual(['recall:create', 'db:set_bot:attach', 'db:arm_ticket']);
    const body = h.requests.find((request) => request.op === 'create')!.body as Record<string, any>;
    const url = body.output_media.camera.config.url as string;
    expect(body.output_media).toEqual({ camera: { kind: 'webpage', config: { url } } });
    const ticket = url.slice(`${BRIDGE_PAGE_URL}#t=`.length);
    expect(ticket).toMatch(R1_MEET_TICKET_PATTERN);
    const row = h.db.booking(created.bookingId)!;
    expect(row.ticket_digest).toBe(digestOf(ticket));
    expect(row.ticket_arms).toBe(1);
    expect(h.recall.bots.get(row.recall_bot_id)!.outputMedia).toBe('webpage');
    expectSecretsAbsent(h, [ticket, row.ticket_digest, url]);
  });

  it('a retried create (lost answer) sends the SAME page, so the armed ticket is the one the bot shows', async () => {
    const h = createR1MeetHarness({ config: { armAtCreate: true } });
    const created = await h.createBooking();
    h.intercept('create', 'lost');
    await expect(ensureBot(h.deps, created.bookingId, h.meta())).resolves.toMatchObject({ outcome: 'defer' });
    h.advance(60_000);
    await expect(ensureBot(h.deps, created.bookingId, h.meta({ deferCount: 1 }))).resolves.toMatchObject({ code: 'bot_scheduled' });
    const [first, second] = h.requests.filter((request) => request.op === 'create');
    expect(second!.body).toEqual(first!.body);
    const url = (first!.body as Record<string, any>).output_media.camera.config.url as string;
    expect(h.db.booking(created.bookingId)!.ticket_digest).toBe(digestOf(url.split('#t=')[1]!));
    expect(h.recall.bots.size).toBe(1);
  });

  it('a rotated key derives a different ticket for the new create', async () => {
    const h = createR1MeetHarness({ config: { armAtCreate: true } });
    const created = await h.createBooking();
    h.recall.failNext(500);
    await ensureBot(h.deps, created.bookingId, h.meta());
    await ensureBot(h.deps, created.bookingId, h.meta({ deferCount: 1 }));
    const [first, second] = h.requests.filter((request) => request.op === 'create').map((request) => (request.body as Record<string, any>).output_media.camera.config.url);
    expect(first).not.toBe(second);
    expect(h.db.booking(created.bookingId)!.ticket_digest).toBe(digestOf((second as string).split('#t=')[1]!));
  });

  it('the derivation: same booking, version and key attempt -> same ticket; any change -> another', () => {
    const base = { id: '7f000000-0000-4000-8000-0000000000d1', version: 3, keyAttempt: 1, startAt: '2030-01-02T10:00:00.000Z', endAt: '2030-01-02T10:45:00.000Z' };
    const nowMs = Date.parse('2030-01-01T10:00:00.000Z');
    const deps = { ticketSource: BRIDGE_SOURCE };
    const a = deriveR1MeetCreateTicket(deps, base, 120, nowMs)!;
    expect(deriveR1MeetCreateTicket(deps, base, 120, nowMs + 3_600_000)).toEqual(a);
    expect(a.ticket).toMatch(R1_MEET_TICKET_PATTERN);
    expect(a.digest).toBe(digestOf(a.ticket));
    const others = [
      { ...base, version: 4 },
      { ...base, keyAttempt: 2 },
      { ...base, id: '7f000000-0000-4000-8000-0000000000d2' },
    ].map((booking) => deriveR1MeetCreateTicket(deps, booking, 120, nowMs)!.ticket);
    expect(new Set([a.ticket, ...others]).size).toBe(4);
    // Another worker secret derives another ticket; its domain is a bridge domain of its own.
    expect(deriveR1MeetCreateTicket({ ticketSource: { WORKER_CONTEXT_SECRET: 'v'.repeat(40) } as NodeJS.ProcessEnv }, base, 120, nowMs)!.ticket).not.toBe(a.ticket);
    expect(r1MeetDerivedKey(R1_MEET_CREATE_TICKET_DOMAIN, BRIDGE_SOURCE)).not.toBeNull();
    // No secret, or a closed window: nothing.
    expect(deriveR1MeetCreateTicket({ ticketSource: {} as NodeJS.ProcessEnv }, base, 120, nowMs)).toBeNull();
    expect(deriveR1MeetCreateTicket(deps, base, 120, Date.parse(base.endAt) + 900_000)).toBeNull();
  });

  it('armR1MeetCreateTicket: duplicate on a retry is success; a refusal alerts and answers false', async () => {
    const h = createR1MeetHarness({ config: { armAtCreate: true } });
    const created = await h.createBooking();
    await ensureBot(h.deps, created.bookingId, h.meta());
    const booking = (await h.db.store.getBooking(created.bookingId))!;
    const minted = deriveR1MeetCreateTicket(h.deps, booking, 120, h.now())!;
    await expect(armR1MeetCreateTicket(h.deps, booking.id, minted, new Date(h.now()).toISOString())).resolves.toBe(true);
    expect(h.db.booking(booking.id)!.ticket_arms).toBe(1);

    h.db.booking(booking.id)!.ticket_arms = 5;
    const other = deriveR1MeetCreateTicket(h.deps, { ...booking, keyAttempt: 9 }, 120, h.now())!;
    h.logs.length = 0;
    await expect(armR1MeetCreateTicket(h.deps, booking.id, other, new Date(h.now()).toISOString())).resolves.toBe(false);
    expect(h.logs.map((line) => line.meta)).toEqual([{ error_category: 'r1_meet_arm_refused', error_type: 'create_ticket_arms_exhausted' }]);

    h.db.failNext('r1_meet_arm_ticket');
    h.logs.length = 0;
    await expect(armR1MeetCreateTicket(h.deps, booking.id, other, new Date(h.now()).toISOString())).resolves.toBe(false);
    expect(h.logs.map((line) => line.meta)).toEqual([{ error_category: 'r1_meet_arm_refused', error_type: 'create_db_error' }]);
  });

  it('without a bridge key the bot is created without output media and nothing is armed', async () => {
    const h = createR1MeetHarness({ config: { armAtCreate: true }, ticketSource: {} as NodeJS.ProcessEnv });
    const created = await h.createBooking();
    await expect(ensureBot(h.deps, created.bookingId, h.meta())).resolves.toMatchObject({ code: 'bot_scheduled' });
    const body = h.requests.find((request) => request.op === 'create')!.body as Record<string, unknown>;
    expect('output_media' in body).toBe(false);
    expect(h.db.booking(created.bookingId)).toMatchObject({ ticket_digest: null, ticket_arms: 0 });
    expect(h.timeline).not.toContain('db:arm_ticket');
  });

  it('with the switch off the body never carries output media', async () => {
    const h = createR1MeetHarness();
    const created = await h.createBooking();
    await ensureBot(h.deps, created.bookingId, h.meta());
    expect('output_media' in (h.requests.find((request) => request.op === 'create')!.body as Record<string, unknown>)).toBe(false);
  });
});
