/**
 * M034 S06 T2: releasing a Recall bot and the Recall retry policy (lib/r1/meet/recall-actions.ts),
 * against the S01 Recall fake through the REAL client.
 *
 * Pinned (D-S06-11, D-S06-12):
 *  - exactly ONE GET before any destructive call, and then only what the bot's state allows: an
 *    undispatched bot is DELETEd (a 405 there means leave_call), a dispatched one gets leave_call (or
 *    nothing in `undispatched_only` mode), an ended one gets nothing, and 404 at any step is `gone`;
 *  - the two leave_call vendor codes: `cannot_command_completed_bot` is ended, `cannot_command_unstarted_bot`
 *    is retry;
 *  - a Recall failure becomes a bounded deferral (Retry-After clamped to 5..300 s), an alert and a 300 s
 *    deferral for 401/402/403, or a throw of `r1_meet_recall_<category>`; past the deferral bound it
 *    throws too; anything that is not a RecallError passes through unchanged;
 *  - no request ever uses a method other than GET, POST and DELETE (no PATCH, S01 R30/R31).
 */

import { describe, expect, it } from 'vitest';
import { RecallError } from '../integrations/recall/errors.js';
import { R1MeetJobError, type R1MeetJobResult } from '../lib/r1/meet/jobs.js';
import {
  R1_MEET_ALERTS,
  R1_MEET_RECALL_UNAVAILABLE,
  r1MeetBotEnded,
  r1MeetBotUndispatched,
  r1MeetRecallFailure,
  r1MeetRecallRejected,
  releaseRecallBot,
} from '../lib/r1/meet/recall-actions.js';
import { MEET_URL, createR1MeetHarness, type R1MeetHarness } from './support/r1-meet-harness.js';

const NOW_MS = Date.parse('2030-01-01T10:00:00.000Z');

/** A bot at the fake, created through the client (so its id is real). */
async function makeBot(h: R1MeetHarness): Promise<string> {
  const bot = await h.client.createBot(
    { meeting_url: MEET_URL, join_at: '2030-01-02T09:58:00.000Z' },
    { idempotencyKey: `test-create-${Math.random().toString(36).slice(2, 10)}` },
  );
  h.requests.length = 0;
  h.timeline.length = 0;
  return bot.id;
}

const ops = (h: R1MeetHarness): string[] => h.requests.map((request) => request.op);

function expectOnlyKnownMethods(h: R1MeetHarness): void {
  for (const request of h.requests) expect(['GET', 'POST', 'DELETE']).toContain(request.method);
}

describe('releaseRecallBot: one GET, then what the state allows (D-S06-11)', () => {
  it('an undispatched bot: one GET, then DELETE', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('deleted');
    expect(ops(h)).toEqual(['get', 'delete']);
    expect(h.recall.bots.has(bot)).toBe(false);
    expectOnlyKnownMethods(h);
  });

  it('undispatched_only on an undispatched bot is the same DELETE', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    await expect(releaseRecallBot(h.client, bot, 'undispatched_only')).resolves.toBe('deleted');
    expect(ops(h)).toEqual(['get', 'delete']);
  });

  it('a DELETE answered 405 (dispatched inside the last 10 minutes) becomes leave_call, in both modes', async () => {
    for (const mode of ['any', 'undispatched_only'] as const) {
      const h = createR1MeetHarness();
      const bot = await makeBot(h);
      // Recall dispatched it but has not reported a new status yet: the history still reads `ready`.
      h.recall.bots.get(bot)!.dispatched = true;
      await expect(releaseRecallBot(h.client, bot, mode)).resolves.toBe('left');
      expect(ops(h), mode).toEqual(['get', 'delete', 'leave']);
      expectOnlyKnownMethods(h);
    }
  });

  it('a dispatched bot gets leave_call in mode any (no DELETE is tried)', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.recall.markDispatched(bot);
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('left');
    expect(ops(h)).toEqual(['get', 'leave']);
  });

  it('undispatched_only on a dispatched bot answers dispatched and sends nothing after the GET', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.recall.markDispatched(bot);
    h.recall.setStatus(bot, 'in_call_recording');
    await expect(releaseRecallBot(h.client, bot, 'undispatched_only')).resolves.toBe('dispatched');
    expect(ops(h)).toEqual(['get']);
  });

  it.each(['call_ended', 'done', 'fatal'])('a bot whose history holds %s is ended: GET only', async (code) => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.recall.markDispatched(bot);
    h.recall.setStatus(bot, code);
    // A later, unrelated status does not hide the end of the call.
    if (code === 'done') h.recall.setStatus(bot, 'analysis_done');
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('ended');
    expect(ops(h)).toEqual(['get']);
  });

  it('404 at the GET is gone, with nothing else sent', async () => {
    const h = createR1MeetHarness();
    await expect(releaseRecallBot(h.client, '00000000-0000-4000-8000-0000000000ff', 'any')).resolves.toBe('gone');
    expect(ops(h)).toEqual(['get']);
  });

  it('404 at the DELETE is gone', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.intercept('delete', { status: 404, body: { detail: 'Not found.' } });
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('gone');
    expect(ops(h)).toEqual(['get', 'delete']);
  });

  it('404 at leave_call is gone', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.recall.markDispatched(bot);
    h.intercept('leave', { status: 404, body: { detail: 'Not found.' } });
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('gone');
    expect(ops(h)).toEqual(['get', 'leave']);
  });

  it('leave_call: cannot_command_completed_bot is ended, cannot_command_unstarted_bot is retry', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.recall.markDispatched(bot);
    h.intercept('leave', { status: 400, body: { code: 'cannot_command_completed_bot' } });
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('ended');
    h.intercept('leave', { status: 400, body: { code: 'cannot_command_unstarted_bot' } });
    await expect(releaseRecallBot(h.client, bot, 'any')).resolves.toBe('retry');
    // Each run read the bot exactly once.
    expect(ops(h)).toEqual(['get', 'leave', 'get', 'leave']);
  });

  it('any other Recall failure is thrown as the RecallError (for r1MeetRecallFailure)', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.intercept('get', { status: 503 });
    await expect(releaseRecallBot(h.client, bot, 'any')).rejects.toMatchObject({ category: 'http_server_error', retriable: true });
    h.intercept('delete', { status: 429, headers: { 'Retry-After': '7' } });
    await expect(releaseRecallBot(h.client, bot, 'any')).rejects.toMatchObject({ category: 'rate_limited', retryAfterMs: 7000 });
    h.recall.markDispatched(bot);
    h.intercept('leave', { status: 400, body: { code: 'request_blocked' } });
    await expect(releaseRecallBot(h.client, bot, 'any')).rejects.toMatchObject({ category: 'bad_request', code: 'request_blocked' });
    h.intercept('get', 'network');
    await expect(releaseRecallBot(h.client, bot, 'any')).rejects.toMatchObject({ category: 'network' });
    expectOnlyKnownMethods(h);
  });

  it('reads the history through the two pure helpers', () => {
    const bot = (codes: string[]) => ({
      id: '00000000-0000-4000-8000-000000000001',
      joinAt: null,
      statusChanges: codes.map((code) => ({ code, subCode: null, createdAt: '2030-01-01T10:00:00Z' })),
      latestStatus: codes.at(-1) ?? null,
      metadata: {},
    });
    expect(r1MeetBotUndispatched(bot([]))).toBe(true);
    expect(r1MeetBotUndispatched(bot(['ready']))).toBe(true);
    expect(r1MeetBotUndispatched(bot(['ready', 'joining_call']))).toBe(false);
    expect(r1MeetBotEnded(bot(['ready', 'joining_call', 'call_ended', 'done']))).toBe(true);
    expect(r1MeetBotEnded(bot(['ready', 'in_call_recording']))).toBe(false);
  });
});

describe('r1MeetRecallFailure: the retry policy (D-S06-12)', () => {
  const firstRun = { deferCount: 0, deferredAt: null };
  const logs = () => {
    const lines: Array<{ level: string; meta: unknown }> = [];
    return {
      lines,
      log: {
        info: (meta: unknown) => lines.push({ level: 'info', meta }),
        warn: (meta: unknown) => lines.push({ level: 'warn', meta }),
        error: (meta: unknown) => lines.push({ level: 'error', meta }),
      },
    };
  };
  const retriable = (category: ConstructorParameters<typeof RecallError>[0], retryAfterMs: number | null, httpStatus?: number) =>
    new RecallError(category, { retriable: true, retryAfterMs, httpStatus, operation: 'bot.create' });

  async function realFailure(status: number, headers: Record<string, string> = {}): Promise<unknown> {
    const h = createR1MeetHarness();
    h.intercept('get', { status, headers });
    return h.client.getBot('00000000-0000-4000-8000-000000000001').catch((error: unknown) => error);
  }

  it('429 with Retry-After defers for the hint; the hint is clamped to 5..300 s', async () => {
    const { log } = logs();
    expect(r1MeetRecallFailure(await realFailure(429, { 'Retry-After': '7' }), { meta: firstRun, nowMs: NOW_MS, log })).toEqual({
      outcome: 'defer',
      code: R1_MEET_RECALL_UNAVAILABLE,
      delaySeconds: 7,
    });
    expect(r1MeetRecallFailure(await realFailure(429, { 'Retry-After': '1' }), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ delaySeconds: 5 });
    expect(r1MeetRecallFailure(retriable('rate_limited', 900_000), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ delaySeconds: 300 });
    expect(r1MeetRecallFailure(retriable('rate_limited', null), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ delaySeconds: 5 });
  });

  it('5xx, 507, 409 in progress, network and timeout defer with the client hint', async () => {
    const { log, lines } = logs();
    expect(r1MeetRecallFailure(await realFailure(500), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ outcome: 'defer', delaySeconds: 10 });
    expect(r1MeetRecallFailure(await realFailure(507), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ outcome: 'defer', delaySeconds: 30 });
    expect(r1MeetRecallFailure(retriable('conflict', 5000, 409), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ delaySeconds: 5 });
    expect(r1MeetRecallFailure(retriable('network', 5000), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ delaySeconds: 5 });
    expect(r1MeetRecallFailure(retriable('timeout', 5000), { meta: firstRun, nowMs: NOW_MS, log })).toMatchObject({ delaySeconds: 5 });
    expect(lines).toEqual([]);
  });

  it('a floor raises the delay (output_media waits at least 20 s)', () => {
    const { log } = logs();
    expect(r1MeetRecallFailure(retriable('network', 5000), { meta: firstRun, nowMs: NOW_MS, log, minDelaySeconds: 20 })).toMatchObject({
      delaySeconds: 20,
    });
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [403, 'forbidden'],
  ] as const)('%i alerts r1_meet_recall_rejected and defers 300 s', async (status, category) => {
    const { log, lines } = logs();
    const error = await realFailure(status);
    expect(r1MeetRecallRejected(error)).toBe(true);
    expect(r1MeetRecallFailure(error, { meta: firstRun, nowMs: NOW_MS, log })).toEqual({
      outcome: 'defer',
      code: R1_MEET_ALERTS.recallRejected,
      delaySeconds: 300,
    });
    expect(lines).toEqual([
      { level: 'error', meta: { error_category: 'r1_meet_recall_rejected', error_type: `bot.get:${category}`, http_status: status } },
    ]);
  });

  it('anything else throws r1_meet_recall_<category>, the message being that code alone', async () => {
    const { log } = logs();
    for (const [status, code] of [
      [400, 'r1_meet_recall_bad_request'],
      [404, 'r1_meet_recall_not_found'],
      [405, 'r1_meet_recall_not_allowed'],
      [418, 'r1_meet_recall_http_client_error'],
    ] as const) {
      const error = await realFailure(status);
      let thrown: unknown;
      try {
        r1MeetRecallFailure(error, { meta: firstRun, nowMs: NOW_MS, log });
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown, String(status)).toBeInstanceOf(R1MeetJobError);
      expect((thrown as Error).message).toBe(code);
    }
  });

  it('past the deferral bound (30 deferrals, or a 60-minute streak) a retriable or rejected failure throws', () => {
    const { log } = logs();
    const spent = [
      { deferCount: 30, deferredAt: null },
      { deferCount: 3, deferredAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString() },
    ];
    for (const meta of spent) {
      expect(() => r1MeetRecallFailure(retriable('http_server_error', 10_000), { meta, nowMs: NOW_MS, log })).toThrow(
        'r1_meet_recall_http_server_error',
      );
      expect(() =>
        r1MeetRecallFailure(new RecallError('payment_required', { httpStatus: 402 }), { meta, nowMs: NOW_MS, log }),
      ).toThrow('r1_meet_recall_payment_required');
    }
    // Just inside both bounds it still defers.
    const inside = { deferCount: 29, deferredAt: new Date(NOW_MS - 59 * 60 * 1000).toISOString() };
    expect((r1MeetRecallFailure(retriable('http_server_error', 10_000), { meta: inside, nowMs: NOW_MS, log }) as R1MeetJobResult).outcome).toBe(
      'defer',
    );
  });

  it('a failure that is not a RecallError passes through unchanged', () => {
    const { log } = logs();
    const dbError = new R1MeetJobError('r1_meet_db_error');
    expect(() => r1MeetRecallFailure(dbError, { meta: firstRun, nowMs: NOW_MS, log })).toThrow(dbError);
    const bug = new TypeError('boom');
    expect(() => r1MeetRecallFailure(bug, { meta: firstRun, nowMs: NOW_MS, log })).toThrow(bug);
  });
});

describe('the Recall client logger adapter', () => {
  it('maps the client metadata to r1_meet_recall_ok / r1_meet_recall_failed lines with no id or URL', async () => {
    const h = createR1MeetHarness();
    const bot = await makeBot(h);
    h.logs.length = 0;
    await h.client.getBot(bot);
    h.intercept('get', { status: 503 });
    await h.client.getBot(bot).catch(() => undefined);
    expect(h.logs).toEqual([
      { level: 'info', meta: { error_category: 'r1_meet_recall_ok', error_type: 'bot.get', http_status: 200 } },
      { level: 'warn', meta: { error_category: 'r1_meet_recall_failed', error_type: 'bot.get:http_server_error', http_status: 503 } },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain(bot);
  });
});

// M035 S11 (contracts section 9): `ashbyTagFailed` is appended after the three S09 words.
describe('R1_MEET_ALERTS: closed words, append-only (plan 2.6, M035 S09 D-S09-4, M035 S11)', () => {
  it('the 16 M034 words in their order, then the three S09 ones, then the S11 one; frozen; every word a logger safe identifier', () => {
    expect(Object.entries(R1_MEET_ALERTS)).toEqual([
      ['botCapReached', 'r1_meet_bot_cap_reached'],
      ['botCreateFailed', 'r1_meet_bot_create_failed'],
      ['generationExhausted', 'r1_meet_generation_exhausted'],
      ['recallRejected', 'r1_meet_recall_rejected'],
      ['strayBot', 'r1_meet_stray_bot'],
      ['botInUse', 'r1_meet_bot_in_use'],
      ['releaseOwed', 'r1_meet_release_owed'],
      ['armRefused', 'r1_meet_arm_refused'],
      ['outputMediaRefused', 'r1_meet_output_media_refused'],
      ['bridgeGaveUp', 'r1_meet_bridge_gave_up'],
      ['multipleHumans', 'r1_meet_multiple_humans'],
      ['profileUnknown', 'r1_meet_profile_unknown'],
      ['drainFailed', 'r1_meet_drain_failed'],
      ['malformedPayload', 'r1_meet_malformed_payload'],
      ['unknownKind', 'r1_meet_unknown_kind'],
      ['jobFailed', 'r1_meet_job_failed'],
      ['botWaitingRoom', 'r1_meet_bot_waiting_room'],
      ['botAdmissionBlocked', 'r1_meet_bot_admission_blocked'],
      ['botSignInFailed', 'r1_meet_bot_sign_in_failed'],
      ['ashbyTagFailed', 'r1_meet_ashby_tag_failed'],
    ]);
    expect(Object.isFrozen(R1_MEET_ALERTS)).toBe(true);
    // Copied from lib/logger.ts:111 (SAFE_IDENT_RE): an error_category that fails it is dropped.
    for (const word of Object.values(R1_MEET_ALERTS)) expect(word).toMatch(/^[a-zA-Z0-9_:.\-]{1,64}$/);
  });
});
