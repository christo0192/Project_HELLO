/**
 * PR105 — Canary-1's refusals, its identifiers, and its bounds arithmetic.
 *
 * Every refusal here is a REFUSAL WITH A REASON, in the `--token` tradition
 * from `halt-drill.mjs`: an operator who typed the wrong thing is told which
 * control stopped them and why it exists, because a bare "invalid input" on a
 * mechanism this careful just gets worked around.
 *
 * Nothing here touches a provider. Everything is a pure function or a fake.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

import {
  CANARY1_CONFIRM_PHRASE,
  CANARY1_DESTINATION_ENV_RE,
  CANARY1_ENV_PATH,
  CANARY1_ID_MINT_FAILED,
  CANARY1_LIVEKIT_ENV_KEY_RE,
  CANARY1_ORIGINATE_MARGIN_SEC,
  CANARY1_PARTICIPANT_WAIT_MARGIN_SEC,
  CANARY1_QUESTIONS,
  CANARY1_ROOM_EMPTY_MARGIN_SEC,
  CANARY1_UNPRINTABLE_LINE,
  CANARY1_WALL_CLOCK_MARGIN_SEC,
  canary1CountLine,
  canary1DoneLine,
  canary1MinimumWallClockSeconds,
  canary1RoomEmptyTimeoutSeconds,
  canary1VerdictLine,
  createCanary1Emitter,
  destinationInEnvironment,
  livekitCredentialsPersisted,
  mintCanary1Ids,
  looksLikeDestination,
  openCanary1Prompt,
  parseCanary1Argv,
  quietEnv,
  readCanary1Destination,
  runCanary1Preflight,
  sanitizeCanary1TrunkId,
  scrubVerbosity,
  type Canary1PromptInterface,
  type Canary1TimeBounds,
} from '../lib/phone-canary1/index.js';
import { CANARY1_BOUNDS } from '../lib/phone-canary1/plan.js';
import { containsDigitRun } from '../lib/phone-canary1/metadata.js';
import { installCanary1Containment } from '../lib/phone-canary1/containment.js';

/**
 * SYNTHETIC, and never the owner's. The same value `test_phone_gate.py` uses as
 * `_NUMBER_LIKE`, kept identical on purpose so a grep for a number-shaped
 * literal in this repository finds one fixture rather than several. It exists
 * only to be proved ABSENT from output.
 */
const FAKE_NUMBER = '+919812345670';

// ══════════════════════════════════════════════════════════════════════
// 1. argv — every way a destination could reach a command line is refused.
// ══════════════════════════════════════════════════════════════════════

describe('1. the destination cannot arrive in argv', () => {
  it.each(['--number', '--to', '--dest', '--destination'])(
    'refuses %s with destination_in_argv',
    (flag) => {
      const result = parseCanary1Argv([flag, FAKE_NUMBER]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe('destination_in_argv');
    },
  );

  it('refuses a bare number-shaped positional, in any of its written forms', () => {
    for (const token of [FAKE_NUMBER, '919812345670', '+91 98123 45670', '(98123)-45670']) {
      const result = parseCanary1Argv([token]);
      expect(result.ok, `accepted ${token}`).toBe(false);
      if (!result.ok) expect(result.refusal).toBe('destination_in_argv');
    }
  });

  it('refuses a number smuggled in as a flag VALUE', () => {
    // The refusal is applied to the value too, not only to the token, because
    // `--confirm +919812345670` would otherwise put it in shell history.
    for (const argv of [['--confirm', FAKE_NUMBER], ['--ring-seconds', FAKE_NUMBER]]) {
      const result = parseCanary1Argv(argv);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe('destination_in_argv');
    }
  });

  it('refuses --out, which was deleted so no evidence file can exist', () => {
    const result = parseCanary1Argv(['--out', 'evidence.json']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('destination_in_argv');
  });

  it('scans the --agent-name VALUE too — no flag is exempt', () => {
    // This was the one flag out of seven whose value skipped the scan. Its
    // shape check admits `a919812345670`, which would reach
    // `/proc/<pid>/cmdline`, shell history, and `createDispatch`'s agent name —
    // a field OUTSIDE the metadata blob, so the worker's digit-run guard never
    // sees it.
    expect(parseCanary1Argv(['--agent-name', 'a919812345670']))
      .toMatchObject({ refusal: 'destination_in_argv' });
    expect(parseCanary1Argv(['--agent-name', FAKE_NUMBER]))
      .toMatchObject({ refusal: 'destination_in_argv' });
    // A digit run ANYWHERE is refused, even behind a leading letter that makes
    // it a legal identifier — the same rule the Fly-config validator already
    // applies to `PHONE_AGENT_NAME`.
    expect(parseCanary1Argv(['--agent-name', 'worker9812345670']))
      .toMatchObject({ refusal: 'destination_in_argv' });
    // The legitimate value still passes, and still through the shape check.
    const ok = parseCanary1Argv(['--agent-name', 'phone-screener']);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.flags.agentName).toBe('phone-screener');
    expect(parseCanary1Argv(['--agent-name', '9-not-an-identifier']))
      .toMatchObject({ refusal: 'unknown_flag' });
  });

  it('EVERY value-taking flag scans its value — asserted as a set, not per flag', () => {
    // The defect LOW-1 fixed was an INCONSISTENCY, so the repair is asserted as
    // a property of the whole flag set rather than of the one flag that was
    // wrong. A new value-taking flag that forgets the scan fails here.
    const valueFlags = ['--confirm', '--agent-name', '--questions', '--max-call-seconds',
      '--ring-seconds', '--participant-wait-seconds', '--wall-clock-seconds'];
    for (const flag of valueFlags) {
      expect(parseCanary1Argv([flag, FAKE_NUMBER]), `${flag} accepted a destination`)
        .toMatchObject({ refusal: 'destination_in_argv' });
    }
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    const result = parseCanary1Argv(['--yolo']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('unknown_flag');
  });

  it('refuses --execute without the exact confirmation phrase', () => {
    for (const argv of [['--execute'], ['--execute', '--confirm', 'call my own phone']]) {
      const result = parseCanary1Argv(argv);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe('confirmation_required');
    }
    const ok = parseCanary1Argv(['--execute', '--confirm', CANARY1_CONFIRM_PHRASE]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.flags.execute).toBe(true);
  });

  it('a bare invocation is a dry run and is accepted as one', () => {
    const result = parseCanary1Argv([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flags.execute).toBe(false);
  });

  it('refuses a missing or non-integer numeric flag value', () => {
    expect(parseCanary1Argv(['--questions'])).toMatchObject({ refusal: 'flag_value_missing' });
    expect(parseCanary1Argv(['--questions', 'two']))
      .toMatchObject({ refusal: 'flag_value_not_an_integer' });
  });

  it('CONTROL — the argv number matcher does not fire on ordinary flags', () => {
    for (const token of ['--dry-run', '--execute', 'phone-screener', '30', '120', '--confirm']) {
      expect(looksLikeDestination(token), `fired on ${token}`).toBe(false);
    }
    // ...and DOES fire on every separator style a person types.
    for (const token of ['+919812345670', '919812345670', '+91 98123 45670',
      '(98123)-45670', '91-98123-45670']) {
      expect(looksLikeDestination(token), `missed ${token}`).toBe(true);
    }
    // And a seven-digit FLAG VALUE is reported as a destination, deliberately:
    // seven consecutive digits is the shape the predicate exists to catch, and
    // the safe direction to be wrong in.
    expect(parseCanary1Argv(['--max-call-seconds', '1234567']))
      .toMatchObject({ refusal: 'destination_in_argv' });
    expect(parseCanary1Argv(['--max-call-seconds', '123456']))
      .toMatchObject({ ok: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. The environment — anchored to a segment boundary, both ways.
// ══════════════════════════════════════════════════════════════════════

describe('2. a destination-shaped environment variable is a refusal', () => {
  it('catches the obvious names, including the bare-suffix ones', () => {
    // An earlier anchoring required a middle segment and therefore missed all
    // three of these — the names a person would actually reach for.
    for (const name of [
      'CANARY_TO', 'PHONE_DEST', 'PHONE_E164', 'PHONE_NUMBER', 'CANARY_DESTINATION',
      'PHONE_CANARY_TO', 'PHONE_OWNER_NUMBER', 'CANARY_1_E164',
    ]) {
      expect(CANARY1_DESTINATION_ENV_RE.test(name), `missed ${name}`).toBe(true);
    }
  });

  it('does not overmatch a token, a trunk id, or a word ENDING in a suffix', () => {
    for (const name of [
      'PHONE_API_TOKEN', 'PHONE_SIP_TRUNK_ID', 'PHONE_AGENT_NAME',
      'PHONE_CANARY_ENABLED', 'PHONE_CANARY_AUTO', 'CANARY_PHOTO', 'PHONE_INTO',
      'PHONE_DESTROY', 'LIVEKIT_URL',
    ]) {
      expect(CANARY1_DESTINATION_ENV_RE.test(name), `overmatched ${name}`).toBe(false);
    }
  });

  it('an UNSET variable is not a refusal — only a set one is', () => {
    expect(destinationInEnvironment({ PHONE_DEST: undefined })).toBe(false);
    expect(destinationInEnvironment({ PHONE_DEST: '' })).toBe(true);
    expect(destinationInEnvironment({ PHONE_SIP_TRUNK_ID: 'ST_abc' })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. The ONE permitted file read — a predicate, never a value.
// ══════════════════════════════════════════════════════════════════════

describe('3. persisted LiveKit credentials are a refusal', () => {
  it('the path is pinned to app/api/.env and is not a parameter', () => {
    expect(CANARY1_ENV_PATH.pathname.endsWith('/app/api/.env')).toBe(true);
  });

  it('detects a LIVEKIT_ assignment with or without export', () => {
    for (const contents of [
      'LIVEKIT_API_KEY=abc\n',
      'export LIVEKIT_URL=wss://x\n',
      'SUPABASE_URL=y\n  LIVEKIT_API_SECRET = z\n',
    ]) {
      expect(livekitCredentialsPersisted(() => contents), contents).toBe(true);
    }
  });

  it('a missing file, or one with no LiveKit key, is not a refusal', () => {
    expect(livekitCredentialsPersisted(() => null)).toBe(false);
    expect(livekitCredentialsPersisted(() => 'SUPABASE_URL=y\nPHONE_AGENT_NAME=z\n')).toBe(false);
    // Not fooled by a mention inside a comment or another key's value.
    expect(livekitCredentialsPersisted(() => '# LIVEKIT_API_KEY=abc\n')).toBe(false);
    expect(livekitCredentialsPersisted(() => 'NOTE=see LIVEKIT_API_KEY=abc\n')).toBe(false);
  });

  it('CONTROL — the matcher is anchored per line, not across the file', () => {
    expect(CANARY1_LIVEKIT_ENV_KEY_RE.test('X=1\nLIVEKIT_API_KEY=2')).toBe(true);
    expect(CANARY1_LIVEKIT_ENV_KEY_RE.test('XLIVEKIT_API_KEY=2')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. The hidden TTY double entry.
// ══════════════════════════════════════════════════════════════════════

function fakePrompt(answers: string[]): {
  open: () => Canary1PromptInterface;
  histories: string[][];
  closes: number;
} {
  const histories: string[][] = [];
  let closes = 0;
  return {
    histories,
    get closes() { return closes; },
    open: () => {
      const history: string[] = [];
      histories.push(history);
      return {
        question: async () => {
          const answer = answers.shift() ?? '';
          // Model the real interface: an answer would land in history if the
          // interface were not configured to refuse one.
          history.push(answer);
          return answer;
        },
        history,
        close: () => { closes += 1; },
      };
    },
  };
}

describe('4. the destination is typed twice, hidden, and never retained', () => {
  it('refuses a non-TTY stdin, so it cannot be piped or heredoc’d', async () => {
    const p = fakePrompt([FAKE_NUMBER, FAKE_NUMBER]);
    const result = await readCanary1Destination(
      { openPrompt: p.open, isTty: false }, () => {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('not_a_tty');
  });

  it('accepts two identical entries and returns a self-redacting value', async () => {
    const p = fakePrompt([FAKE_NUMBER, FAKE_NUMBER]);
    const result = await readCanary1Destination({ openPrompt: p.open, isTty: true }, () => {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.number)).toBe('[redacted]');
      expect(JSON.stringify(result.number)).toBe('"[redacted]"');
      expect(result.number.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a mismatch ONCE, with no retry prompt', async () => {
    const p = fakePrompt([FAKE_NUMBER, '+919812345671']);
    const result = await readCanary1Destination({ openPrompt: p.open, isTty: true }, () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('destination_mismatch');
    // Exactly two prompts were opened. A retry loop is a second chance to typo
    // into a live carrier.
    expect(p.histories).toHaveLength(2);
  });

  it('refuses a malformed number with a bare code and no interpolation', async () => {
    const p = fakePrompt(['+1555000111', '+1555000111']);
    const result = await readCanary1Destination({ openPrompt: p.open, isTty: true }, () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('phone_number_not_dialable');
  });

  it('clears the history and closes the interface after EACH entry', async () => {
    const p = fakePrompt([FAKE_NUMBER, FAKE_NUMBER]);
    await readCanary1Destination({ openPrompt: p.open, isTty: true }, () => {});
    expect(p.histories).toHaveLength(2);
    for (const history of p.histories) expect(history).toEqual([]);
    expect(p.closes).toBe(2);
  });

  it('CONTROL — the history assertion would fail if the clear were dropped', async () => {
    // The fake pushes the answer into history exactly as readline would. If
    // `readCanary1Destination` stopped emptying it, this is what would be seen.
    const p = fakePrompt([FAKE_NUMBER, FAKE_NUMBER]);
    const rl = p.open();
    await rl.question('> ');
    expect(rl.history).toHaveLength(1);
  });

  it('never writes the entered value to the output stream', async () => {
    const written: string[] = [];
    const p = fakePrompt([FAKE_NUMBER, FAKE_NUMBER]);
    await readCanary1Destination({ openPrompt: p.open, isTty: true }, (t) => written.push(t));
    const all = written.join('');
    expect(all).not.toContain(FAKE_NUMBER);
    expect(all).not.toContain('9812345670');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4b. THE REAL readline interface — M-5, against `node:readline` itself.
// ══════════════════════════════════════════════════════════════════════

describe('4b. the real prompt suppresses echo and retains nothing', () => {
  /**
   * The tests above drive `readCanary1Destination` through a hand-written
   * fake, which proves the CALLER empties an array. It cannot prove that
   * `node:readline` was configured to keep nothing in the first place, and
   * deleting `terminal: true`, `historySize: 0` and the `_writeToOutput`
   * override would leave every one of them green.
   *
   * These construct the REAL `openCanary1Prompt` over in-memory streams.
   */
  function realPrompt(): {
    rl: ReturnType<typeof openCanary1Prompt>;
    written: string[];
    input: PassThrough;
  } {
    const input = new PassThrough();
    const written: string[] = [];
    const output = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
    return { rl: openCanary1Prompt(input, output), written, input };
  }

  it('the typed value is NEVER echoed to the output stream', async () => {
    const { rl, written, input } = realPrompt();
    const answer = rl.question('> ');
    input.write(`${FAKE_NUMBER}\n`);
    expect(await answer).toBe(FAKE_NUMBER);
    rl.close();
    const all = written.join('');
    // The prompt itself is written; not one digit of the value is.
    expect(all).toContain('> ');
    expect(all).not.toContain(FAKE_NUMBER);
    expect(all).not.toContain('9812345670');
    expect(all).not.toMatch(/\d{4,}/);
  });

  it('readline itself retains no history, before anything clears it', async () => {
    const { rl, input } = realPrompt();
    const answer = rl.question('> ');
    input.write(`${FAKE_NUMBER}\n`);
    await answer;
    // NOT cleared by the caller here — this is what `node:readline` kept on
    // its own, which is what `historySize: 0` is for.
    expect(rl.history).toEqual([]);
    rl.close();
  });

  it('the whole double entry leaves nothing in either real interface', async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const output = new Writable({
      write(chunk: Buffer | string, _enc, cb) { written.push(chunk.toString()); cb(); },
    }) as unknown as NodeJS.WritableStream;
    const opened: Array<ReturnType<typeof openCanary1Prompt>> = [];
    const result = readCanary1Destination(
      {
        isTty: true,
        openPrompt: () => {
          const rl = openCanary1Prompt(input, output);
          opened.push(rl);
          return rl;
        },
      },
      (text) => written.push(text),
    );
    input.write(`${FAKE_NUMBER}\n`);
    await new Promise((r) => { setImmediate(r); });
    input.write(`${FAKE_NUMBER}\n`);
    const destination = await result;

    expect(destination.ok).toBe(true);
    expect(opened).toHaveLength(2);
    for (const rl of opened) expect(rl.history).toEqual([]);
    const all = written.join('');
    expect(all).not.toContain(FAKE_NUMBER);
    expect(all).not.toMatch(/\d{4,}/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. Three unrelated identifiers, and the digit-run agreement.
// ══════════════════════════════════════════════════════════════════════

describe('5. the identifiers are unrelated and satisfiable by the far end', () => {
  it('mints three distinct values, none derived from another', () => {
    const ids = mintCanary1Ids();
    expect(ids.sessionId).not.toBe(ids.originateAttemptId);
    expect(ids.canaryId).toHaveLength(8);
    expect(ids.canaryId).toMatch(/^[0-9a-f]{8}$/);
    expect(ids.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids.originateAttemptId).not.toContain(ids.canaryId);
  });

  it('re-mints any identifier the worker guard would refuse', () => {
    // The first draw carries an eight-digit run — the exact shape the inbound
    // guard rejects, and one a uuid produces about 2.3% of the time per
    // segment. Without the re-mint, roughly one honest run in twelve would be
    // refused at random, which is how a real guard gets a reputation for
    // flakiness and is deleted.
    const draws = [
      '11111111-2b83-41d7-8f60-1ea55d3c9b02',
      'aa1b2c3d-2b83-41d7-8f60-1ea55d3c9b02',
      'bb1b2c3d-2b83-41d7-8f60-1ea55d3c9b02',
      'cc1b2c3d-2b83-41d7-8f60-1ea55d3c9b02',
    ];
    let i = 0;
    const ids = mintCanary1Ids(() => draws[i++] as string);
    expect(containsDigitRun(draws[0] as string)).toBe(true);
    expect(ids.sessionId).toBe('aa1b2c3d-2b83-41d7-8f60-1ea55d3c9b02');
    expect(containsDigitRun(ids.sessionId)).toBe(false);
    expect(containsDigitRun(ids.canaryId)).toBe(false);
  });

  it('refuses rather than hangs when the randomness never produces one', () => {
    expect(() => mintCanary1Ids(() => '11111111-1111-1111-1111-111111111111'))
      .toThrowError(CANARY1_ID_MINT_FAILED);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. The six bounds, and the two inequalities the CLI refuses on.
// ══════════════════════════════════════════════════════════════════════

const CREDS = { url: 'wss://x', apiKey: 'k', apiSecret: 's' };
const DEFAULT_BOUNDS: Canary1TimeBounds = {
  ringSeconds: CANARY1_BOUNDS.ringSeconds.def,
  originateTimeoutSeconds: CANARY1_BOUNDS.originateTimeoutSeconds.def,
  participantWaitSeconds: CANARY1_BOUNDS.participantWaitSeconds.def,
  joinWaitSeconds: CANARY1_BOUNDS.joinWaitSeconds.def,
  // DERIVED from the wait, exactly as `runCanary1` derives it. Writing a
  // literal here would make every case below agree with a number the product
  // does not compute.
  roomEmptyTimeoutSeconds: canary1RoomEmptyTimeoutSeconds(
    CANARY1_BOUNDS.participantWaitSeconds.def,
  ),
  maxCallSeconds: CANARY1_BOUNDS.maxCallSeconds.def,
  wallClockSeconds: CANARY1_BOUNDS.wallClockSeconds.def,
  questions: CANARY1_BOUNDS.questions.def,
};
const preflight = (over: Partial<Canary1TimeBounds> = {}, trunk = 'ST_x'): ReturnType<
  typeof runCanary1Preflight
> => runCanary1Preflight({
  bounds: { ...DEFAULT_BOUNDS, ...over },
  trunkId: trunk,
  credentials: CREDS,
  questionsAvailable: CANARY1_QUESTIONS.length,
});

describe('6. the bounds are ordered, and the outermost one is derived', () => {
  it('the shipped defaults pass, and every refusal reports providerContacted false', () => {
    expect(preflight()).toEqual({ ok: true, providerContacted: false });
  });

  it('refuses a missing trunk and missing credentials separately', () => {
    expect(preflight({}, '')).toMatchObject({ refusal: 'trunk_not_configured' });
    expect(runCanary1Preflight({
      bounds: DEFAULT_BOUNDS,
      trunkId: 'ST_x',
      credentials: { url: '', apiKey: 'k', apiSecret: 's' },
      questionsAvailable: 3,
    })).toMatchObject({ refusal: 'livekit_credentials_missing', providerContacted: false });
  });

  it('refuses bounds_out_of_range BEFORE it reasons about order', () => {
    // The declared `{min,max}` used to be read by nothing, so an operator flag
    // was unbounded: `--max-call-seconds 3600` would have set a one-hour
    // ceiling on a live PSTN leg, and `--participant-wait-seconds 500` would
    // have been checked against a value `phone.py` clamps away to 180.
    for (const over of [
      { ringSeconds: 0 },
      { ringSeconds: 61 },
      { originateTimeoutSeconds: 5 },
      { maxCallSeconds: 3_600, wallClockSeconds: 3_750 },
      { participantWaitSeconds: 500, wallClockSeconds: 900 },
      { wallClockSeconds: 60 },
      { ringSeconds: 30.5 },
    ]) {
      expect(preflight(over), JSON.stringify(over))
        .toMatchObject({ refusal: 'bounds_out_of_range', providerContacted: false });
    }
    // Every declared default is inside its own declared range — otherwise the
    // shipped configuration would refuse itself.
    for (const [name, bound] of Object.entries(CANARY1_BOUNDS)) {
      expect(bound.def, `${name} default is outside its own range`)
        .toBeGreaterThanOrEqual(bound.min);
      expect(bound.def, `${name} default is outside its own range`)
        .toBeLessThanOrEqual(bound.max);
    }
  });

  it('refuses timeouts_misordered when the originate could expire mid-ring', () => {
    // `dial.ts` gate 1a, mirrored: if the originate gives up while the carrier
    // is still ringing, the leg can STILL be answered afterwards. Both values
    // are IN RANGE, so this proves the ordering check and not the range check.
    expect(preflight({ ringSeconds: 60, originateTimeoutSeconds: 60 }))
      .toMatchObject({ refusal: 'timeouts_misordered' });
    expect(preflight({ ringSeconds: 60, originateTimeoutSeconds: 10 }))
      .toMatchObject({ refusal: 'timeouts_misordered' });
  });

  it('refuses waits_misordered — a wait charged against a failure budget', () => {
    // The worker's wait clock starts at JOB ASSIGNMENT, before the originate.
    // Both values in range, so this is the ordering check, not the range check.
    const ring = 40;
    const boundary = ring + CANARY1_PARTICIPANT_WAIT_MARGIN_SEC;
    expect(preflight({ ringSeconds: ring, participantWaitSeconds: boundary - 1 }))
      .toMatchObject({ refusal: 'waits_misordered' });
    expect(preflight({
      ringSeconds: ring,
      participantWaitSeconds: boundary,
      // The FIFTH inequality also has an opinion at this boundary: at the
      // default join wait of 60, `100 >= 60 + 40 + 15` is false, so this case
      // would refuse `origination_wait_misordered` and stop testing the third
      // inequality at all. Lowering the join wait keeps this case about the
      // one relation it is named for. That interaction is the point of
      // checking both rather than assuming they agree.
      joinWaitSeconds: 30,
      roomEmptyTimeoutSeconds: canary1RoomEmptyTimeoutSeconds(boundary),
      wallClockSeconds: boundary + DEFAULT_BOUNDS.maxCallSeconds + CANARY1_WALL_CLOCK_MARGIN_SEC,
    })).toMatchObject({ ok: true });
  });

  it('refuses bounds_misordered — the wall clock must cover what it supervises', () => {
    // The design's original 240 s wall clock is REFUSED by its own inequality:
    // a participant answering late in a 120 s wait is still talking at t=300,
    // and the teardown would cut a healthy call off mid-sentence — the exact
    // failure signature the wait bound exists to eliminate.
    expect(preflight({ wallClockSeconds: 240 }))
      .toMatchObject({ refusal: 'bounds_misordered' });
    const minimum = canary1MinimumWallClockSeconds(
      DEFAULT_BOUNDS.participantWaitSeconds, DEFAULT_BOUNDS.maxCallSeconds,
    );
    expect(minimum).toBe(330);
    expect(CANARY1_BOUNDS.wallClockSeconds.def).toBeGreaterThanOrEqual(minimum);
    expect(preflight({ wallClockSeconds: minimum - 1 }))
      .toMatchObject({ refusal: 'bounds_misordered' });
    expect(preflight({ wallClockSeconds: minimum })).toMatchObject({ ok: true });
  });

  it('refuses a question count the copy cannot honour, from BOTH ends', () => {
    // One guard, derived from the number of question texts that exist — not a
    // second range check that could never fire while the copy holds three.
    expect(preflight({ questions: 0 })).toMatchObject({ refusal: 'questions_out_of_range' });
    expect(preflight({ questions: CANARY1_QUESTIONS.length + 1 }))
      .toMatchObject({ refusal: 'questions_out_of_range' });
    // And every count the copy CAN honour is accepted.
    for (let n = 1; n <= CANARY1_QUESTIONS.length; n += 1) {
      expect(preflight({ questions: n }), `rejected ${n}`).toMatchObject({ ok: true });
    }
  });

  it('the shipped defaults satisfy all FIVE inequalities by arithmetic', () => {
    const b = DEFAULT_BOUNDS;
    expect(b.ringSeconds).toBeLessThan(b.originateTimeoutSeconds);
    expect(b.participantWaitSeconds)
      .toBeGreaterThanOrEqual(b.ringSeconds + CANARY1_PARTICIPANT_WAIT_MARGIN_SEC);
    expect(b.wallClockSeconds).toBeGreaterThanOrEqual(
      b.participantWaitSeconds + b.maxCallSeconds + CANARY1_WALL_CLOCK_MARGIN_SEC,
    );
    expect(b.roomEmptyTimeoutSeconds)
      .toBeGreaterThanOrEqual(canary1RoomEmptyTimeoutSeconds(b.participantWaitSeconds));
    // SLACK, not a tie: 120 >= 60 + 30 + 15 = 105. A tie would mean the
    // shipped configuration sat exactly on a refusal boundary, where any
    // rounding or any future margin change refuses the defaults themselves.
    const charged = b.joinWaitSeconds + b.ringSeconds + CANARY1_ORIGINATE_MARGIN_SEC;
    expect(charged).toBe(105);
    expect(b.participantWaitSeconds - charged).toBe(15);
    // And the worker-side bound stays inside `phone.py`'s clamp of [1, 180].
    expect(b.participantWaitSeconds).toBeLessThanOrEqual(180);
  });

  // ── PR106 §2.5 — the fourth and fifth inequalities ──────────────────

  it('E5 — refuses room_timeout_misordered when the room would be reaped mid-wait', () => {
    // The DEFECT this encodes: `emptyTimeout` was a chosen 120 while the join
    // window is `participantWait + 60` = 180 at the defaults. LiveKit's
    // `empty_timeout` runs from room CREATION, and the canary room is created
    // EMPTY and stays empty until the agent joins — unlike a production room,
    // which is dialled within seconds. So between t=120 and t=180 the provider
    // could reap the room while the CLI was still waiting for it.
    const required = canary1RoomEmptyTimeoutSeconds(DEFAULT_BOUNDS.participantWaitSeconds);
    expect(required).toBe(210);
    // One second under refuses; the derived value passes; above passes.
    expect(preflight({ roomEmptyTimeoutSeconds: required - 1 }))
      .toMatchObject({ refusal: 'room_timeout_misordered', providerContacted: false });
    expect(preflight({ roomEmptyTimeoutSeconds: required })).toMatchObject({ ok: true });
    expect(preflight({ roomEmptyTimeoutSeconds: required + 1 })).toMatchObject({ ok: true });
    // And THE mutation: the old chosen constant, against the shipped wait.
    expect(preflight({ roomEmptyTimeoutSeconds: 120 }))
      .toMatchObject({ refusal: 'room_timeout_misordered' });
  });

  it('E5 CONTROL — the requirement MOVES with the wait, so it cannot be a constant', () => {
    // A raised `--participant-wait-seconds` must not silently re-open the gap.
    // If the fourth inequality compared against a fixed number, the run below
    // would pass with a timeout that is 60 s short of its own join window.
    const raised = 180;
    expect(canary1RoomEmptyTimeoutSeconds(raised)).toBe(270);
    expect(preflight({
      participantWaitSeconds: raised,
      joinWaitSeconds: 30,
      wallClockSeconds: 400,
      roomEmptyTimeoutSeconds: canary1RoomEmptyTimeoutSeconds(120),
    })).toMatchObject({ refusal: 'room_timeout_misordered' });
    expect(CANARY1_ROOM_EMPTY_MARGIN_SEC).toBe(30);
  });

  it('E4 — refuses origination_wait_misordered when the pre-originate wait overspends', () => {
    // The pre-originate wait is CHARGED against the worker's own participant
    // wait, whose clock starts at JOB ASSIGNMENT. A naive "wait for the worker
    // first" consumes the resource it is protecting: the worker gives up
    // mid-ring, closes the room, and the answered handset hears nothing —
    // which is the same silent answered call the wait exists to prevent,
    // arriving from the other side.
    const b = DEFAULT_BOUNDS;
    const feasible = b.participantWaitSeconds - b.ringSeconds - CANARY1_ORIGINATE_MARGIN_SEC;
    expect(feasible).toBe(75);
    // One second over the feasible join wait refuses; at equality it passes,
    // because the relation is `>=` — `participantWait >= joinWait + ring +
    // margin`. The boundary is asserted from BOTH sides so neither a `>` nor a
    // `<` typo survives.
    expect(preflight({ joinWaitSeconds: feasible + 1 }))
      .toMatchObject({ refusal: 'origination_wait_misordered', providerContacted: false });
    expect(preflight({ joinWaitSeconds: feasible })).toMatchObject({ ok: true });
    expect(preflight({ joinWaitSeconds: feasible - 1 })).toMatchObject({ ok: true });
  });

  it('E4 CONTROL — the knob ceiling is only reachable for SOME settings of the others', () => {
    // 150 is inside `joinWaitSeconds`'s declared range, so the range check
    // accepts it — and the fifth inequality refuses it at the default ring,
    // because `150 + 30 + 15 = 195 > 180`. A knob whose maximum is reachable
    // only for some settings of another knob is exactly why the relation is
    // CHECKED rather than assumed, and why the refusal must not be a clamp.
    expect(CANARY1_BOUNDS.joinWaitSeconds.max).toBe(150);
    expect(preflight({
      joinWaitSeconds: 150,
      participantWaitSeconds: 180,
      wallClockSeconds: 400,
      roomEmptyTimeoutSeconds: canary1RoomEmptyTimeoutSeconds(180),
    })).toMatchObject({ refusal: 'origination_wait_misordered' });
    // At the MINIMUM ring it is satisfiable — `150 + 5 + 15 = 170 <= 180`.
    expect(preflight({
      joinWaitSeconds: 150,
      ringSeconds: 5,
      participantWaitSeconds: 180,
      wallClockSeconds: 400,
      roomEmptyTimeoutSeconds: canary1RoomEmptyTimeoutSeconds(180),
    })).toMatchObject({ ok: true });
    // And the knob's own range is still enforced, ahead of the relation, so
    // the refusal names the thing the operator actually typed.
    expect(preflight({ joinWaitSeconds: 29 }))
      .toMatchObject({ refusal: 'bounds_out_of_range' });
    expect(preflight({ joinWaitSeconds: 151 }))
      .toMatchObject({ refusal: 'bounds_out_of_range' });
  });

  it('E7 — the trunk id goes through the PRODUCTION sanitiser', () => {
    // The realistic failure is not an attack: the operator pastes the trunk id
    // at a `read -rs` prompt, CANNOT SEE IT, and the paste carries a trailing
    // space or a newline. Raw, that value reached the SDK — after the
    // destination had been typed twice, the room created and the worker
    // dispatched — and the transcript then said `originate_failed` with no
    // detail, having already spent the double entry and created live provider
    // state.
    expect(sanitizeCanary1TrunkId('ST_abc-123')).toBe('ST_abc-123');

    // SURROUNDING WHITESPACE IS NORMALISED, NOT REFUSED — and that is the
    // production behaviour, not a weakening. `boundedOpaqueId` trims BEFORE it
    // matches, so the blind-paste case is repaired rather than rejected, which
    // is the better outcome for the one value the operator cannot see. Stated
    // here explicitly because the accepted plan predicted a refusal for these
    // four, and a test written to the prediction rather than to the loader
    // would have pinned behaviour the product does not have.
    for (const pasted of ['ST_abc ', 'ST_abc\n', ' ST_abc\t', '  ST_abc  ']) {
      expect(sanitizeCanary1TrunkId(pasted), `mangled ${JSON.stringify(pasted)}`)
        .toBe('ST_abc');
    }

    // What DOES reduce to '' — and therefore to `trunk_not_configured` before
    // any seam — is everything the opaque-id class exists to exclude.
    for (const raw of [
      '+919812345670',        // the E.164 shape; `+` is outside the class DELIBERATELY
      '+91 98123 45670',
      'ST abc',               // an interior space is not trimmable
      'ST/abc',
      'a'.repeat(129),        // past the 128-character bound
      '',
      undefined,
    ]) {
      expect(sanitizeCanary1TrunkId(raw), `admitted ${JSON.stringify(raw)}`).toBe('');
    }

    // And an empty result is what `trunk_not_configured` is made of, so the
    // sanitiser and the refusal are ONE control rather than two that must
    // agree. `config.ts` states the reason for the class in the same terms:
    // this field can never be talked into holding an E.164 value.
    expect(preflight({}, sanitizeCanary1TrunkId('+919812345670')))
      .toMatchObject({ refusal: 'trunk_not_configured', providerContacted: false });
    // A legitimate id still reaches the preflight intact.
    expect(preflight({}, sanitizeCanary1TrunkId('ST_abc-123\n'))).toMatchObject({ ok: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. Containment behaviour, and the verbosity scrub.
// ══════════════════════════════════════════════════════════════════════

describe('7. containment emits a code, tears down, and exits non-zero', () => {
  it('installs both handlers and runs teardown inside them', async () => {
    const handlers: Record<string, () => void> = {};
    const emitted: string[] = [];
    let torn = 0;
    let exited: number | null = null;
    installCanary1Containment({
      emit: (code) => emitted.push(code),
      teardown: async () => { torn += 1; },
      exit: (code) => { exited = code; },
      proc: { on: (event, handler) => { handlers[event] = handler; return null; } },
    });
    expect(Object.keys(handlers).sort()).toEqual(['uncaughtException', 'unhandledRejection']);

    handlers.uncaughtException?.();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(emitted).toEqual(['uncaught_exception']);
    expect(torn).toBe(1);
    expect(exited).toBe(1);
  });

  it('a FAILING teardown does not become a second uncontained throw', async () => {
    const handlers: Record<string, () => void> = {};
    const emitted: string[] = [];
    let exited: number | null = null;
    installCanary1Containment({
      emit: (code) => emitted.push(code),
      teardown: async () => { throw new Error('boom'); },
      exit: (code) => { exited = code; },
      proc: { on: (event, handler) => { handlers[event] = handler; return null; } },
    });
    expect(() => handlers.unhandledRejection?.()).not.toThrow();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(emitted).toEqual(['unhandled_rejection', 'teardown_failed_in_containment']);
    expect(exited).toBe(1);
  });

  it('quietEnv is pure — a copy, and NOT the control', () => {
    const source = { DEBUG: '*', LOG_LEVEL: 'trace', LIVEKIT_LOG_LEVEL: 'debug',
      NODE_DEBUG: 'net', PHONE_SIP_TRUNK_ID: 'ST_x' };
    const quiet = quietEnv(source);
    expect(quiet).toEqual({ PHONE_SIP_TRUNK_ID: 'ST_x' });
    expect(source.DEBUG).toBe('*');
  });

  it('scrubVerbosity IS the control — it mutates the map the SDK reads', () => {
    // The SDK and Node's own NODE_DEBUG machinery read `process.env` directly,
    // so a scrubbed clone changes nothing. The control has to delete from the
    // map the reader reads, or it must not claim the property.
    const env: NodeJS.ProcessEnv = { DEBUG: '*', LOG_LEVEL: 'trace',
      LIVEKIT_LOG_LEVEL: 'debug', NODE_DEBUG: 'net', PHONE_SIP_TRUNK_ID: 'ST_x' };
    const removed = scrubVerbosity(env);
    expect(removed.sort()).toEqual(['DEBUG', 'LIVEKIT_LOG_LEVEL', 'LOG_LEVEL', 'NODE_DEBUG']);
    expect(env).toEqual({ PHONE_SIP_TRUNK_ID: 'ST_x' });
    expect('DEBUG' in env).toBe(false);
  });

  it('scrubVerbosity is idempotent and reports only what it actually removed', () => {
    const env: NodeJS.ProcessEnv = { DEBUG: '*' };
    expect(scrubVerbosity(env)).toEqual(['DEBUG']);
    expect(scrubVerbosity(env)).toEqual([]);
    // An empty string is a SET value and is removed; `undefined` is not set.
    expect(scrubVerbosity({ LOG_LEVEL: '' })).toEqual(['LOG_LEVEL']);
    expect(scrubVerbosity({ LOG_LEVEL: undefined })).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. The emitter — a parser, not a redactor.
// ══════════════════════════════════════════════════════════════════════

describe('8. nothing outside the grammar can be printed', () => {
  it('emits the four line shapes', () => {
    expect(canary1VerdictLine('room_created', true, 'ok'))
      .toBe('CANARY|canary1|room_created|PASS|ok');
    expect(canary1VerdictLine('room_created', false, 'room_create_failed'))
      .toBe('CANARY|canary1|room_created|FAIL|room_create_failed');
    expect(canary1CountLine('call_seconds', 63)).toBe('CANARYCOUNT|canary1|call_seconds|63');
    expect(canary1DoneLine()).toBe('CANARYDONE|1');
  });

  it('refuses anything a value could hide in', () => {
    for (const check of ['Room Created', 'phone-1234', 'a', 'x'.repeat(90), '']) {
      expect(canary1VerdictLine(check, true, 'ok'), check).toBe(CANARY1_UNPRINTABLE_LINE);
    }
    for (const code of [FAKE_NUMBER, 'phone-9c4a1e75', 'Failed: rpc error', 'A']) {
      expect(canary1VerdictLine('room_created', false, code), code)
        .toBe(CANARY1_UNPRINTABLE_LINE);
    }
    expect(canary1CountLine('call_seconds', -1)).toBe(CANARY1_UNPRINTABLE_LINE);
    expect(canary1CountLine('call_seconds', 1.5)).toBe(CANARY1_UNPRINTABLE_LINE);
    expect(canary1CountLine('CallSeconds', 1)).toBe(CANARY1_UNPRINTABLE_LINE);
  });

  it('the emitter records failure, including a refusal to print', () => {
    const lines: string[] = [];
    const emitter = createCanary1Emitter((l) => lines.push(l));
    emitter.check('room_created', true, 'ok');
    expect(emitter.failed()).toBe(false);
    emitter.check('Not A Check', true, 'ok');
    expect(emitter.failed()).toBe(true);
    expect(lines).toEqual(['CANARY|canary1|room_created|PASS|ok', CANARY1_UNPRINTABLE_LINE]);
  });

  it('a refusal to print does not throw — a throw here would skip teardown', () => {
    const emitter = createCanary1Emitter(() => {});
    expect(() => emitter.check('X', true, 'ok')).not.toThrow();
    expect(() => emitter.count('X', 1)).not.toThrow();
  });
});

// A guard against a stray real timer keeping the suite alive.
vi.useRealTimers();
