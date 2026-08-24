/**
 * PR105 — the privacy property, stated as a property test rather than a review.
 *
 * ── WHY THE DIGEST IS THE PRIMARY ASSERTION ───────────────────────────
 * `PHONE_DIAL_ALLOWLIST` holds UNSALTED SHA-256 digests of E.164 values. For
 * an Indian mobile the space is `+91[6-9]` plus nine digits — about four
 * billion, exhaustible on a laptop in minutes. A published digest of the
 * owner's number IS the number for anyone who can read the repository, the
 * database or a log pipeline.
 *
 * So "no 4+ digit run appears in the output" is the WEAKER leg, and it is the
 * one an earlier revision of the design led with. A hex digest contains digit
 * runs only by chance; a leak that printed one could sail past a substring
 * check while handing an attacker the whole number. Digest-absence is asserted
 * first, and the substring leg is scoped to DECIMAL runs of the actual input.
 *
 * ── AND WHY THE ERROR-LEAK TEST ASSERTS THE ABSENCE OF A STACK ────────
 * `dial.ts` discards the originate error because *a provider message may quote
 * the dialled number*. The stronger assertion is not "the captured output does
 * not contain the number" — that passes when the leak happens to be phrased
 * differently — but "no `Error:` line and no stack frame reached the terminal
 * at all". Nothing can be quoted by a message that was never printed.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';

import {
  CANARY1_CONFIRM_PHRASE,
  buildCanary1DispatchMetadata,
  buildCanary1RoomMetadata,
  mintCanary1Ids,
  installCanary1Containment,
  runCanary1,
  type Canary1DispatchClientLike,
  type Canary1PromptInterface,
  type Canary1RoomClientLike,
  type Canary1RunDeps,
} from '../lib/phone-canary1/index.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/index.js';

/** Pinned so a failure is reproducible rather than "it went red once". */
const SEED = 0x0ca9a71;
const NUM_RUNS = 200;

/** Valid Indian mobiles, the only shape `wrapDialableNumber` admits. */
const validNumber = fc
  .tuple(fc.integer({ min: 6, max: 9 }), fc.array(fc.integer({ min: 0, max: 9 }), {
    minLength: 9, maxLength: 9,
  }))
  .map(([lead, rest]) => `+91${lead}${rest.join('')}`);

const CREDS = { url: 'wss://example.invalid', apiKey: 'key', apiSecret: 'secret' };

/** Every decimal run of four or more digits inside a string. */
function decimalRuns(value: string): string[] {
  return [...value.matchAll(/\d{4,}/g)].map((m) => m[0]);
}

function harness(number: string, over: Partial<Canary1RunDeps> = {}): {
  deps: Canary1RunDeps;
  captured: string[];
} {
  const captured: string[] = [];
  let listed = 0;
  const rooms: Canary1RoomClientLike = {
    async createRoom() {},
    async deleteRoom() {},
    // OCCUPIED, since PR106. This file's subject is what happens AT and AFTER
    // the originate seam, and the worker-presence precondition now stands
    // between the dispatch and that seam: an empty room refuses
    // `room_reaped_before_join` and the originate never happens, so every
    // assertion here would pass for the wrong reason — the leak cannot occur
    // because the leaking call was never made. A joined worker is the state
    // these cases are actually about.
    async listRooms() {
      listed += 1;
      // Occupied for the join observation, then GONE, so teardown can still
      // verify absence on the same fake.
      return listed <= 1 ? [{ numParticipants: 1 }] : [];
    },
  };
  const dispatch: Canary1DispatchClientLike = {
    async createDispatch(_room, _agent, options) { captured.push(options.metadata); },
  };
  const answers = [number, number];
  const openPrompt = (): Canary1PromptInterface => ({
    question: async () => answers.shift() ?? '',
    history: [],
    close: () => {},
  });
  let clock = 0;
  return {
    captured,
    deps: {
      argv: ['--execute', '--confirm', CANARY1_CONFIRM_PHRASE],
      env: {},
      write: (line) => captured.push(line),
      prompt: { openPrompt, isTty: true },
      rooms,
      dispatch,
      credentials: CREDS,
      trunkId: 'ST_canary',
      sleep: async () => {},
      // 10 s per read. It was 100 s, which is larger than the 60 s join window
      // the worker-presence precondition polls in — so the loop's deadline had
      // already passed before its first poll and the run refused
      // `worker_never_joined` without ever reaching the seam this file is
      // about. A test clock that steps past a bound is not a fast test, it is
      // a test of a different code path.
      now: () => { clock += 10_000; return clock; },
      originate: {
        live: () => ({
          mode: 'live',
          createSipParticipant: async (request) => ({
            participantIdentity: `phone-${request.attemptId}`,
            synthetic: false,
          }),
        }),
      },
      armed: true,
      // Hermetic: a developer with a real `app/api/.env` on disk would
      // otherwise see every run here refuse `credentials_persisted`.
      // The entry script passes NO reader, which the structural suite
      // asserts, so production always uses the path-pinned read.
      readEnvFile: () => null,
      ...over,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 1. The property — over the whole valid input space.
// ══════════════════════════════════════════════════════════════════════

describe('1. no output of a whole run carries the number or its digest', () => {
  it('PRIMARY — the digest never appears, for any valid destination', async () => {
    await fc.assert(
      fc.asyncProperty(validNumber, async (number) => {
        const digest = createHash('sha256').update(number, 'utf8').digest('hex');
        const h = harness(number);
        const result = await runCanary1(h.deps);
        const output = [...h.captured, ...result.lines].join('\n');
        expect(output).not.toContain(digest);
        // Not even a recognisable prefix: an eight-hex-character head of a
        // digest is already a brute-force starting point.
        expect(output).not.toContain(digest.slice(0, 16));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('SECONDARY — no decimal run of the input survives into any line', async () => {
    await fc.assert(
      fc.asyncProperty(validNumber, async (number) => {
        const h = harness(number);
        const result = await runCanary1(h.deps);
        const output = [...h.captured, ...result.lines].join('\n');
        for (const run of decimalRuns(number)) {
          expect(output, `leaked ${run.length} digits`).not.toContain(run);
        }
        // And the number's own subscriber part, which is what identifies a
        // person even without the country code.
        expect(output).not.toContain(number.slice(3));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('POSITIVE CONTROL — a deliberately leaky emitter DOES trip both legs', async () => {
    const number = '+919812345670';
    const digest = createHash('sha256').update(number, 'utf8').digest('hex');
    // What a careless line would look like. If either assertion above were
    // vacuous, this would still pass them.
    const leaky = [`CANARY|canary1|dialing|PASS|${number}`, `digest=${digest}`].join('\n');
    expect(leaky).toContain(digest);
    expect(decimalRuns(number).some((run) => leaky.includes(run))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. The metadata builders, over the whole space.
// ══════════════════════════════════════════════════════════════════════

describe('2. the metadata a worker receives can carry nothing', () => {
  it('emits exactly the declared key sets and refuses a digit run', () => {
    const ids = mintCanary1Ids();
    const room = JSON.parse(buildCanary1RoomMetadata(ids)) as Record<string, unknown>;
    const disp = JSON.parse(buildCanary1DispatchMetadata(ids, 'canary')) as Record<string, unknown>;
    expect(Object.keys(room).sort()).toEqual(['canary', 'channel', 'room_name', 'session_id']);
    expect(Object.keys(disp).sort()).toEqual(['canary_id', 'channel', 'mode', 'session_id']);
    expect(/\d{7,}/.test(buildCanary1RoomMetadata(ids))).toBe(false);
    expect(/\d{7,}/.test(buildCanary1DispatchMetadata(ids, 'canary'))).toBe(false);
  });

  it('POSITIVE CONTROL — a digit-run identifier is REFUSED, not shipped', () => {
    // The far end refuses a blob carrying a 7+ digit run. Shipping one the
    // worker is required to reject would fail the run in the confusing place.
    const bad = {
      sessionId: '11111111-2b83-41d7-8f60-1ea55d3c9b02',
      canaryId: 'aa1b2c3d',
      originateAttemptId: 'bb1b2c3d-2b83-41d7-8f60-1ea55d3c9b02',
    };
    expect(() => buildCanary1RoomMetadata(bad)).toThrowError('canary_metadata_digit_run');
    expect(() => buildCanary1DispatchMetadata(bad, 'canary'))
      .toThrowError('canary_metadata_digit_run');
  });

  it('the wrapper renders redacted through every serialization path', () => {
    const number = wrapDialableNumber('+919812345670');
    expect(String(number)).toBe('[redacted]');
    expect(`${number}`).toBe('[redacted]');
    expect(JSON.stringify(number)).toBe('"[redacted]"');
    // The one path the three overrides miss is a spread, which is why the
    // digits live in a NON-ENUMERABLE symbol.
    expect(JSON.stringify({ ...number })).not.toContain('9812345670');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. A provider error quoting the number reaches nothing.
// ══════════════════════════════════════════════════════════════════════

describe('3. a leaking provider error produces no number, no Error, no stack', () => {
  it('the number, the message and the stack all die at the seam', async () => {
    const number = '+916012345678';
    const h = harness(number, {
      originate: {
        live: () => ({
          mode: 'live',
          createSipParticipant: async () => {
            const error = new Error(`rpc failed for ${number} on trunk ST_x`);
            error.stack = `Error: rpc failed for ${number}\n    at SipClient.create (sdk.js:1:1)`;
            throw error;
          },
        }),
      },
    });
    const result = await runCanary1(h.deps);
    const output = [...h.captured, ...result.lines].join('\n');

    expect(output).not.toContain('6012345678');
    expect(output).not.toContain('rpc failed');
    expect(output).not.toContain('ST_x');
    // The stronger assertion: nothing that could QUOTE anything was printed.
    expect(output).not.toMatch(/^Error:/m);
    expect(output).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);

    // The run still reports the fact, as a stable code, and still tears down.
    expect(result.lines)
      .toContain('CANARY|canary1|originate_answered|FAIL|originate_failed');
    expect(result.exitCode).toBe(1);
  });

  it('nothing reaches the REAL process streams — not stdout, not stderr', async () => {
    // The assertions above read an in-memory array of what `deps.write`
    // received. That cannot see a leak arriving by `console.error`, by a direct
    // `process.stderr.write`, or by Node's own top-level printer — which are
    // the three routes the containment layer exists to close. So this one
    // watches the streams themselves.
    const number = '+916012345678';
    const captured: string[] = [];
    const record = (chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    };
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(record as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(record as never);
    try {
      const h = harness(number, {
        // Write through the REAL stdout, as the entry script does.
        write: (line) => { process.stdout.write(`${line}\n`); },
        originate: {
          live: () => ({
            mode: 'live',
            createSipParticipant: async () => {
              const error = new Error(`rpc failed for ${number} on trunk ST_x`);
              error.stack = `Error: rpc failed for ${number}\n    at Sip.create (sdk.js:1:1)`;
              throw error;
            },
          }),
        },
      });
      await runCanary1(h.deps);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    const streamed = captured.join('');
    expect(streamed.length, 'the spies captured nothing at all').toBeGreaterThan(50);
    expect(streamed).not.toContain('6012345678');
    expect(streamed).not.toContain('rpc failed');
    expect(streamed).not.toContain('ST_x');
    expect(streamed).not.toMatch(/^Error:/m);
    expect(streamed).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
    expect(streamed).toContain('CANARY|canary1|originate_answered|FAIL|originate_failed');
  });

  it('the REAL process handlers print a bare code and nothing else', async () => {
    // The handler layer is registered on the real `process`, its listener is
    // taken off again immediately (so nothing else in this suite inherits it),
    // and then invoked directly with the containment's own emitter wired to the
    // real streams. Invoking it directly rather than throwing for real is
    // deliberate: a genuine uncaught exception would take the vitest worker
    // with it and prove nothing about what was printed.
    const number = '+916012345678';
    const captured: string[] = [];
    const before = process.listeners('uncaughtException').length;
    let handler: ((...args: unknown[]) => void) | undefined;
    const outSpy = vi.spyOn(process.stdout, 'write')
      .mockImplementation(((c: unknown) => { captured.push(String(c)); return true; }) as never);
    const errSpy = vi.spyOn(process.stderr, 'write')
      .mockImplementation(((c: unknown) => { captured.push(String(c)); return true; }) as never);
    try {
      installCanary1Containment({
        emit: (code) => { process.stdout.write(`CANARY|canary1|process_containment|FAIL|${code}\n`); },
        teardown: async () => {},
        exit: () => {},
      });
      const listeners = process.listeners('uncaughtException');
      expect(listeners.length, 'the handler was not registered on the real process')
        .toBe(before + 1);
      handler = listeners[listeners.length - 1] as (...args: unknown[]) => void;
      process.removeListener('uncaughtException', handler as never);
      const rejection = process.listeners('unhandledRejection');
      process.removeListener(
        'unhandledRejection', rejection[rejection.length - 1] as never);

      // THE ARITY IS THE CONTROL. Node passes the error as the first argument;
      // a handler that declared a parameter would be one careless line away
      // from printing it. This one cannot, because there is no identifier.
      expect(handler.length, 'the handler binds the error Node hands it').toBe(0);

      handler(new Error(`rpc failed for ${number}`));
      await new Promise((r) => { setTimeout(r, 0); });
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    const streamed = captured.join('');
    expect(streamed).toBe('CANARY|canary1|process_containment|FAIL|uncaught_exception\n');
    expect(streamed).not.toContain('6012345678');
    expect(process.listeners('uncaughtException').length).toBe(before);
  });

  it('POSITIVE CONTROL — the stack matchers DO fire on a real stack', () => {
    const stack = 'Error: rpc failed for +916012345678\n    at SipClient.create (sdk.js:1:1)';
    expect(stack).toMatch(/^Error:/m);
    expect(stack).toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
  });

  it('a throwing ROOM client is contained the same way', async () => {
    const number = '+916012345678';
    const h = harness(number, {
      rooms: {
        async createRoom() { throw new Error(`create failed for ${number}`); },
        async deleteRoom() {},
        async listRooms() { return []; },
      },
    });
    const result = await runCanary1(h.deps);
    const output = [...h.captured, ...result.lines].join('\n');
    expect(output).not.toContain('6012345678');
    expect(output).not.toMatch(/^Error:/m);
    expect(result.lines).toContain('CANARY|canary1|room_created|FAIL|room_create_failed');
  });

  it('every line of every run parses under the grammar, leak or no leak', async () => {
    const shapes = [
      /^CANARY\|[a-z][a-z0-9_]{2,63}\|[a-z][a-z0-9_]{2,79}\|(?:PASS|FAIL)\|[a-z][a-z0-9_]{0,63}$/,
      /^CANARYCOUNT\|[a-z][a-z0-9_]{2,63}\|[a-z][a-z0-9_]{2,47}\|(?:0|[1-9][0-9]{0,8})$/,
      /^CANARYDONE\|(?:0|[1-9][0-9]{0,8})$/,
    ];
    const h = harness('+919812345670');
    const result = await runCanary1(h.deps);
    expect(result.lines.length).toBeGreaterThan(5);
    for (const line of result.lines) {
      expect(shapes.some((s) => s.test(line)), `ungrammatical: ${line}`).toBe(true);
    }
  });
});
