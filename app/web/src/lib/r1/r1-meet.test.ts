import { describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { ApiError } from '../api-client';
import { R1ApiError, type R1MeetExchangeResult } from './r1-api';
import {
  classifyMeetExchangeError,
  R1_MEET_DISABLED_CODE,
  R1_MEET_EXCHANGE_DEADLINE_MS,
  R1_MEET_EXCHANGE_ERROR_CODES,
  R1_MEET_EXCHANGE_ERRORS,
  R1_MEET_EXCHANGE_MAX_CALLS,
  R1_MEET_EXCHANGE_WAITS_MS,
  R1_MEET_RETRY_AFTER_CAP_MS,
  runMeetExchange,
  type R1MeetExchangeDeps,
} from './r1-meet';

const TICKET = 'meet-ticket-not-a-secret_0123456789ABCDEFxy';

// ── The classifier ────────────────────────────────────────────────────────────

describe('classifyMeetExchangeError', () => {
  const verdict = (code: string, status: number) => classifyMeetExchangeError(new R1ApiError(code, status));

  it('names exactly the seven exchange codes of the contract', () => {
    expect([...R1_MEET_EXCHANGE_ERROR_CODES].sort()).toEqual(
      [
        'invalid_request',
        'meet_disabled',
        'round_not_live',
        'ticket_already_claimed',
        'ticket_expired',
        'ticket_not_yet_valid',
        'ticket_unknown',
      ].sort(),
    );
    expect(R1_MEET_DISABLED_CODE).toBe('meet_disabled');
    expect(Object.isFrozen(R1_MEET_EXCHANGE_ERRORS)).toBe(true);
    expect(Object.isFrozen(R1_MEET_EXCHANGE_ERROR_CODES)).toBe(true);
  });

  it.each([
    ['meet_disabled', 503, { kind: 'disabled' }],
    ['invalid_request', 400, { kind: 'failed', reason: 'invalid' }],
    ['ticket_unknown', 404, { kind: 'failed', reason: 'invalid' }],
    ['ticket_already_claimed', 409, { kind: 'failed', reason: 'claimed' }],
    ['ticket_not_yet_valid', 425, { kind: 'failed', reason: 'not_yet' }],
    ['ticket_expired', 410, { kind: 'failed', reason: 'expired' }],
    ['round_not_live', 409, { kind: 'failed', reason: 'round_closed' }],
    ['r1_malformed_response', 500, { kind: 'failed', reason: 'malformed' }],
    ['network_unreachable', 0, { kind: 'retry' }],
    ['http_502', 502, { kind: 'retry' }],
    ['http_504', 504, { kind: 'retry' }],
    ['http_429', 429, { kind: 'failed', reason: 'rate_limited' }],
    ['http_410', 410, { kind: 'failed', reason: 'expired' }],
    ['http_425', 425, { kind: 'failed', reason: 'not_yet' }],
    ['http_400', 400, { kind: 'failed', reason: 'invalid' }],
    ['http_401', 401, { kind: 'failed', reason: 'invalid' }],
    ['http_403', 403, { kind: 'failed', reason: 'invalid' }],
    ['http_404', 404, { kind: 'failed', reason: 'invalid' }],
    // Maintenance reads `http_503`: terminal, never retried (each call can boot a worker).
    ['http_503', 503, { kind: 'failed', reason: 'unavailable' }],
    ['service_unavailable', 503, { kind: 'failed', reason: 'unavailable' }],
    ['http_500', 500, { kind: 'failed', reason: 'unavailable' }],
    ['something_new', 409, { kind: 'failed', reason: 'unavailable' }],
    ['http_418', 418, { kind: 'failed', reason: 'unavailable' }],
  ])('reads %s (%d) as %j', (code, status, expected) => {
    expect(verdict(code, status)).toEqual(expected);
  });

  it('reads an exchange code by name, whatever status carries it', () => {
    for (const status of [400, 404, 409, 500, 502, 504, 0]) {
      expect(verdict('ticket_already_claimed', status), String(status)).toEqual({
        kind: 'failed',
        reason: 'claimed',
      });
      expect(verdict('meet_disabled', status), String(status)).toEqual({ kind: 'disabled' });
    }
  });

  it('never reads an Object.prototype name as a code', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(verdict(name, 409), name).toEqual({ kind: 'failed', reason: 'unavailable' });
      expect(verdict(name, 502), name).toEqual({ kind: 'retry' });
    }
  });

  it('reads a plain ApiError like an R1ApiError, and anything else as unavailable', () => {
    expect(classifyMeetExchangeError(new ApiError('ticket_expired', 410))).toEqual({
      kind: 'failed',
      reason: 'expired',
    });
    for (const odd of [new Error('boom'), new TypeError('Failed to fetch'), undefined, 'ticket_expired']) {
      expect(classifyMeetExchangeError(odd), String(odd)).toEqual({
        kind: 'failed',
        reason: 'unavailable',
      });
    }
  });
});

// ── The schedule ──────────────────────────────────────────────────────────────

describe('the retry schedule', () => {
  it('allows at most ten calls with nine waits between them', () => {
    expect(R1_MEET_EXCHANGE_MAX_CALLS).toBe(10);
    expect(R1_MEET_EXCHANGE_WAITS_MS).toHaveLength(R1_MEET_EXCHANGE_MAX_CALLS - 1);
    expect([...R1_MEET_EXCHANGE_WAITS_MS]).toEqual([
      3_000, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 30_000, 30_000,
    ]);
    expect(Object.isFrozen(R1_MEET_EXCHANGE_WAITS_MS)).toBe(true);
  });

  it('never waits less than 3 s, never shortens, and fits inside the deadline', () => {
    const waits = [...R1_MEET_EXCHANGE_WAITS_MS];
    for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(3_000);
    for (let i = 1; i < waits.length; i += 1) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    const total = waits.reduce((sum, wait) => sum + wait, 0);
    expect(total).toBe(168_000);
    expect(total).toBeLessThanOrEqual(R1_MEET_EXCHANGE_DEADLINE_MS);
    expect(R1_MEET_EXCHANGE_DEADLINE_MS).toBe(180_000);
    expect(R1_MEET_RETRY_AFTER_CAP_MS).toBe(30_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(R1_MEET_RETRY_AFTER_CAP_MS);
  });
});

// ── The runner ────────────────────────────────────────────────────────────────

type Step = R1MeetExchangeResult | Error | ((call: number) => R1MeetExchangeResult | Error);

const preparing = (resume = 'resume-1', retry: number | null = 3): R1MeetExchangeResult => ({
  status: 'preparing',
  resume_token: resume,
  retry_after_sec: retry,
});

const READY: R1MeetExchangeResult = {
  status: 'ready',
  url: 'wss://lk.invalid',
  livekit_token: 'room-token',
  expires_at: null,
};

const network = () => new R1ApiError('network_unreachable', 0);

interface Harness {
  deps: R1MeetExchangeDeps;
  /** The resume token each call presented. */
  calls: Array<string | null>;
  sleeps: number[];
  preparingSeen: () => number;
  clock: { t: number };
}

/**
 * A fake exchange answering from `steps` (the last step repeats), a virtual clock that the sleeps
 * advance (plus `callCostMs` per call), and a cancel flag the test can flip.
 */
function harness(
  steps: Step[],
  options: { callCostMs?: number; cancelled?: () => boolean } = {},
): Harness {
  const calls: Array<string | null> = [];
  const sleeps: number[] = [];
  const clock = { t: 1_000_000 };
  let preparingCount = 0;
  const deps: R1MeetExchangeDeps = {
    ticket: TICKET,
    exchange: async (ticket, resume) => {
      expect(ticket).toBe(TICKET);
      calls.push(resume);
      clock.t += options.callCostMs ?? 0;
      const raw = steps[Math.min(calls.length - 1, steps.length - 1)];
      const step = typeof raw === 'function' ? raw(calls.length) : raw;
      if (step instanceof Error) throw step;
      return step;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    isCancelled: options.cancelled ?? (() => false),
    onPreparing: () => {
      preparingCount += 1;
    },
  };
  return { deps, calls, sleeps, preparingSeen: () => preparingCount, clock };
}

describe('runMeetExchange', () => {
  it('returns the grant of a first-call 200, without a resume token or a wait', async () => {
    const h = harness([READY]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'ready', grant: READY });
    expect(h.calls).toEqual([null]);
    expect(h.sleeps).toEqual([]);
    expect(h.preparingSeen()).toBe(0);
  });

  it('gives up after exactly ten calls when the worker never gets ready, on the schedule', async () => {
    const h = harness([preparing()]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    expect(h.calls).toHaveLength(10);
    expect(h.sleeps).toEqual([...R1_MEET_EXCHANGE_WAITS_MS]);
    expect(h.calls[0]).toBeNull();
    expect(h.calls.slice(1).every((resume) => resume === 'resume-1')).toBe(true);
    expect(h.preparingSeen()).toBe(10);
  });

  it('caps the server hint at 30 s and still stops within 180 s of the first call', async () => {
    const h = harness([preparing('resume-1', 60)]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    expect(h.sleeps.every((ms) => ms === R1_MEET_RETRY_AFTER_CAP_MS)).toBe(true);
    // Calls at 0, 30, ..., 180 s: seven calls; an eighth would start 210 s after the first.
    expect(h.calls).toHaveLength(7);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(R1_MEET_EXCHANGE_DEADLINE_MS);
  });

  it('lets a hint lengthen a wait, never shorten it', async () => {
    const short = harness([preparing('resume-1', 1)]);
    await runMeetExchange(short.deps);
    expect(short.sleeps).toEqual([...R1_MEET_EXCHANGE_WAITS_MS]);

    const zero = harness([preparing('resume-1', 0)]);
    await runMeetExchange(zero.deps);
    expect(zero.sleeps).toEqual([...R1_MEET_EXCHANGE_WAITS_MS]);

    const none = harness([preparing('resume-1', null)]);
    await runMeetExchange(none.deps);
    expect(none.sleeps).toEqual([...R1_MEET_EXCHANGE_WAITS_MS]);

    // 12 s beats the 3 s and 5 s and 10 s waits, and loses to the 15 s and later ones.
    const mid = harness([preparing('resume-1', 12)]);
    await runMeetExchange(mid.deps);
    expect(mid.sleeps.slice(0, 4)).toEqual([12_000, 12_000, 12_000, 15_000]);
  });

  it('carries the resume token of a 202 into the call that gets the 200', async () => {
    const h = harness([preparing('resume-a'), READY]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'ready', grant: READY });
    expect(h.calls).toEqual([null, 'resume-a']);
    expect(h.sleeps).toEqual([3_000]);
    expect(h.preparingSeen()).toBe(1);
  });

  it('always presents the newest resume token', async () => {
    const h = harness([preparing('resume-a'), preparing('resume-b'), preparing('resume-c'), READY]);
    await runMeetExchange(h.deps);
    expect(h.calls).toEqual([null, 'resume-a', 'resume-b', 'resume-c']);
  });

  it('retries a network failure within the same budget, keeping the token it holds', async () => {
    const h = harness([
      preparing('resume-a'),
      network(),
      new R1ApiError('http_502', 502),
      preparing('resume-b'),
      new R1ApiError('http_504', 504),
      READY,
    ]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'ready', grant: READY });
    expect(h.calls).toEqual([null, 'resume-a', 'resume-a', 'resume-a', 'resume-b', 'resume-b']);
    expect(h.sleeps).toEqual(R1_MEET_EXCHANGE_WAITS_MS.slice(0, 5));
    expect(h.preparingSeen()).toBe(2);
  });

  it('retries a first-call network failure with the ticket alone', async () => {
    const h = harness([network(), READY]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'ready', grant: READY });
    expect(h.calls).toEqual([null, null]);
    expect(h.preparingSeen()).toBe(0);
  });

  it('gives up after ten calls when the network never comes back', async () => {
    const h = harness([network()]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    expect(h.calls).toHaveLength(10);
    expect(h.sleeps).toEqual([...R1_MEET_EXCHANGE_WAITS_MS]);
  });

  it('stops on the deadline before the count when each call is slow', async () => {
    // Each call takes 100 s: call 1 ends at 100 s, the 3 s wait ends at 103 s, call 2 ends at
    // 203 s, and a further 5 s wait would pass 180 s.
    const h = harness([preparing()], { callCostMs: 100_000 });
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([3_000]);
  });

  it('never starts a wait that would end past the deadline', async () => {
    // 60 s per call: 0-60, wait 3 to 63, 63-123, wait 5 to 128, 128-188, then stop.
    const h = harness([network()], { callCostMs: 60_000 });
    await runMeetExchange(h.deps);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([3_000, 5_000]);
  });

  it('idles after one call when the server has the Meet bridge switched off', async () => {
    const h = harness([new R1ApiError('meet_disabled', 503)]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'disabled' });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('idles when the switch goes off between retries', async () => {
    const h = harness([preparing('resume-a'), new R1ApiError('meet_disabled', 503)]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'disabled' });
    expect(h.calls).toEqual([null, 'resume-a']);
  });

  it.each([
    ['invalid_request', 400, 'invalid'],
    ['ticket_unknown', 404, 'invalid'],
    ['ticket_already_claimed', 409, 'claimed'],
    ['ticket_not_yet_valid', 425, 'not_yet'],
    ['ticket_expired', 410, 'expired'],
    ['round_not_live', 409, 'round_closed'],
    ['http_503', 503, 'unavailable'],
    ['http_500', 500, 'unavailable'],
    ['http_429', 429, 'rate_limited'],
    ['r1_malformed_response', 500, 'malformed'],
  ])('stops after one call, without a wait, on %s (%d)', async (code, status, reason) => {
    const h = harness([new R1ApiError(code, status), READY]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('stops at once on a terminal refusal after a 202, with no further call', async () => {
    const h = harness([preparing('resume-a'), new R1ApiError('round_not_live', 409), READY]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'round_closed' });
    expect(h.calls).toEqual([null, 'resume-a']);
    expect(h.sleeps).toEqual([3_000]);
  });

  it('stops on something that is not an API error (a bug in the call) without retrying', async () => {
    const h = harness([new TypeError('boom'), READY]);
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(h.calls).toHaveLength(1);
  });

  it('makes no call at all when the page is already gone', async () => {
    const h = harness([READY], { cancelled: () => true });
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'cancelled' });
    expect(h.calls).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });

  it('makes no further call when the page goes during a wait', async () => {
    let gone = false;
    const h = harness([preparing()], { cancelled: () => gone });
    const sleep = h.deps.sleep;
    h.deps.sleep = async (ms) => {
      await sleep(ms);
      gone = true;
    };
    await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'cancelled' });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([3_000]);
  });

  it('drops a grant that arrives after the page went, and a refusal or 202 likewise', async () => {
    for (const answer of [READY, preparing(), network(), new R1ApiError('ticket_expired', 410)] as Step[]) {
      let gone = false;
      const h = harness(
        [
          () => {
            gone = true;
            return typeof answer === 'function' ? answer(1) : answer;
          },
        ],
        { cancelled: () => gone },
      );
      await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'cancelled' });
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
      expect(h.preparingSeen()).toBe(0);
    }
  });

  it('can never make an eleventh call or wait less than 3 s, whatever the server says', async () => {
    const hints: Array<number | null> = [null, 0, 1, 3, 29, 30, 31, 600];
    const costs = [0, 1, 999, 5_000];
    for (const hint of hints) {
      for (const cost of costs) {
        const h = harness(
          [(call) => (call % 3 === 0 ? network() : preparing(`resume-${call}`, hint))],
          { callCostMs: cost },
        );
        await expect(runMeetExchange(h.deps)).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
        expect(h.calls.length, `${hint}/${cost}`).toBeLessThanOrEqual(R1_MEET_EXCHANGE_MAX_CALLS);
        expect(h.sleeps.length).toBe(h.calls.length - 1);
        for (const ms of h.sleeps) {
          expect(ms).toBeGreaterThanOrEqual(3_000);
          expect(ms).toBeLessThanOrEqual(R1_MEET_RETRY_AFTER_CAP_MS);
        }
        expect(h.clock.t - 1_000_000 - cost).toBeLessThanOrEqual(R1_MEET_EXCHANGE_DEADLINE_MS);
      }
    }
  });
});
