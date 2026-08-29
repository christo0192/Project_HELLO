/**
 * PR105 — the REAL two-sided pin between the TypeScript and Python halves.
 *
 * ── WHY THIS IS BUILT AND NOT INHERITED ───────────────────────────────
 * The Canary-1 design's first revision cited `HEARTBEAT_PATH` as an existing
 * two-sided cross-language pin to copy. Verified against the tree, it is not
 * one: `phone.py:287` declares the constant, `test_phone_heartbeat.py` asserts
 * only that it STARTS WITH `/api/internal/phone/`, and `contract-openapi.test.ts`
 * declares the full literal SEPARATELY. Two hardcoded strings and a prefix
 * check can drift in the middle and nothing goes red.
 *
 * So this file builds one. It READS THE PYTHON SOURCE and compares, byte for
 * byte, against the TypeScript constants:
 *
 *   * the spoken copy — the disclosure, every question, the closing line;
 *   * the canary dispatch and room key sets;
 *   * the dispatch `mode` value;
 *   * the `PHONE_CANARY_PARTICIPANT_WAIT_SEC` default against the CLI's
 *     `--ring-seconds` default, and the inequality that relates them.
 *
 * The last pair is the one that matters operationally. The CLI cannot read the
 * worker's environment, so `waits_misordered` refuses on the CLI's own numbers.
 * If the Python default moved and the TypeScript one did not, the CLI would
 * pass a preflight about an inequality that no longer held on the worker — the
 * refusal would be about the wrong system. Pinning the pair is what stops the
 * two ends agreeing on paper and disagreeing in production.
 *
 * ── AND WHY THE COPY IS PINNED AT ALL ─────────────────────────────────
 * Because the disclosure is going to TEL-04 for approval as written, and a
 * spoken line that drifted after approval would be the system saying something
 * Legal did not approve, to a person, over a phone.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CANARY1_BOUNDS,
  CANARY1_CLOSING_TEXT,
  CANARY1_DISCLOSURE_TEXT,
  CANARY1_DISPATCH_METADATA_KEYS,
  CANARY1_DISPATCH_MODE,
  CANARY1_PARTICIPANT_WAIT_MARGIN_SEC,
  CANARY1_QUESTIONS,
  CANARY1_ROOM_METADATA_KEYS,
  CANARY1_WORKER_ENV_VARS,
} from '../lib/phone-canary1/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PHONE_CANARY_PY = readFileSync(path.join(REPO, 'app/voice-livekit/phone_canary.py'), 'utf8');
const PHONE_PY = readFileSync(path.join(REPO, 'app/voice-livekit/phone.py'), 'utf8');
const AGENT_PY = readFileSync(path.join(REPO, 'app/voice-livekit/agent.py'), 'utf8');

/**
 * Read a Python string constant written as an implicitly-concatenated literal:
 *
 *     NAME = (
 *         "part one "
 *         "part two"
 *     )
 *
 * Deliberately narrow. A general Python parser would accept forms this
 * repository does not use, and an extractor that accepts more than the source
 * contains is an extractor that can silently return the wrong thing.
 */
function pyString(source: string, name: string): string {
  const match = new RegExp(`^${name} = \\(\\n([\\s\\S]*?)^\\)$`, 'm').exec(source);
  if (match === null) throw new Error(`python constant not found: ${name}`);
  const parts = [...(match[1] as string).matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*$/gm)]
    .map((m) => (m[1] as string).replace(/\\"/g, '"').replace(/\\n/g, '\n'));
  if (parts.length === 0) throw new Error(`python constant is not a string literal: ${name}`);
  return parts.join('');
}

/** Read a Python tuple of string literals. */
function pyStringTuple(source: string, name: string): string[] {
  const match = new RegExp(`^${name}[^=]*= \\(\\n([\\s\\S]*?)^\\)$`, 'm').exec(source);
  if (match === null) throw new Error(`python tuple not found: ${name}`);
  return [...(match[1] as string).matchAll(/^\s*"((?:[^"\\]|\\.)*)",\s*$/gm)]
    .map((m) => (m[1] as string).replace(/\\"/g, '"'));
}

/** Read a Python `frozenset({...})` of string literals. */
function pyFrozenset(source: string, name: string): string[] {
  const match = new RegExp(`^${name}[^=]*= frozenset\\(\\{([\\s\\S]*?)\\}\\)`, 'm').exec(source);
  if (match === null) throw new Error(`python frozenset not found: ${name}`);
  return [...(match[1] as string).matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string).sort();
}

// ══════════════════════════════════════════════════════════════════════
// 0. THE EXTRACTORS ARE NOT VACUOUS.
// ══════════════════════════════════════════════════════════════════════

describe('0. the extractors read real content and can fail', () => {
  it('the Python sources were actually read', () => {
    expect(PHONE_CANARY_PY.length).toBeGreaterThan(4_000);
    expect(PHONE_PY.length).toBeGreaterThan(20_000);
    expect(AGENT_PY.length).toBeGreaterThan(20_000);
  });

  it('CONTROL — a missing constant is an error, not an empty string', () => {
    expect(() => pyString(PHONE_CANARY_PY, 'NO_SUCH_CONSTANT')).toThrowError(/not found/);
    expect(() => pyStringTuple(PHONE_CANARY_PY, 'NO_SUCH_TUPLE')).toThrowError(/not found/);
    expect(() => pyFrozenset(PHONE_PY, 'NO_SUCH_SET')).toThrowError(/not found/);
  });

  it('CONTROL — the extractor reassembles a concatenated literal correctly', () => {
    const fixture = 'X = (\n    "alpha "\n    "beta"\n)\n';
    expect(pyString(fixture, 'X')).toBe('alpha beta');
    // And it does NOT silently return only the first fragment, which is how a
    // byte-for-byte comparison quietly becomes a prefix check.
    expect(pyString(fixture, 'X')).not.toBe('alpha ');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 1. The spoken copy, byte for byte.
// ══════════════════════════════════════════════════════════════════════

describe('1. every fixed line is identical on both sides', () => {
  it('the disclosure matches exactly', () => {
    expect(pyString(PHONE_CANARY_PY, 'CANARY_DISCLOSURE_TEXT')).toBe(CANARY1_DISCLOSURE_TEXT);
  });

  it('the closing line matches exactly', () => {
    expect(pyString(PHONE_CANARY_PY, 'CANARY_CLOSING_TEXT')).toBe(CANARY1_CLOSING_TEXT);
  });

  it('every question matches exactly, in order', () => {
    expect(pyStringTuple(PHONE_CANARY_PY, 'CANARY_QUESTIONS')).toEqual([...CANARY1_QUESTIONS]);
  });

  it('the canary disclosure is NOT the production one', () => {
    // The production copy says the call IS recorded, because a production
    // screening is. Reusing it here would make the system say something false.
    const production = pyString(PHONE_PY, 'PHONE_DISCLOSURE_TEXT');
    expect(CANARY1_DISCLOSURE_TEXT).not.toBe(production);
    expect(production).toContain('recorded so the hiring team can review it');
    expect(CANARY1_DISCLOSURE_TEXT).toContain('not being recorded');
  });

  it('no spoken line carries a digit run the worker guard would refuse', () => {
    for (const line of [CANARY1_DISCLOSURE_TEXT, CANARY1_CLOSING_TEXT, ...CANARY1_QUESTIONS]) {
      expect(/\d{7,}/.test(line), `digit run in: ${line.slice(0, 40)}`).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. The metadata contract, both directions.
// ══════════════════════════════════════════════════════════════════════

describe('2. the key sets and the mode value agree', () => {
  it('the dispatch key set is identical', () => {
    expect(pyFrozenset(PHONE_PY, 'CANARY_DISPATCH_KEYS'))
      .toEqual([...CANARY1_DISPATCH_METADATA_KEYS].sort());
  });

  it('the room key set is identical', () => {
    expect(pyFrozenset(PHONE_PY, 'CANARY_ROOM_KEYS'))
      .toEqual([...CANARY1_ROOM_METADATA_KEYS].sort());
  });

  it('the dispatch mode literal is identical', () => {
    const match = /^CANARY_MODE = "([a-z_]+)"$/m.exec(PHONE_PY);
    expect(match, 'CANARY_MODE not found in phone.py').not.toBeNull();
    expect(match?.[1]).toBe(CANARY1_DISPATCH_MODE);
  });

  it('the digit-run rule is the same length on both sides', () => {
    expect(PHONE_PY).toContain('_DIGIT_RUN_RE = re.compile(r"\\d{7,}")');
    expect(CANARY1_DISPATCH_METADATA_KEYS).not.toContain('attempt_id');
    expect(CANARY1_DISPATCH_METADATA_KEYS).not.toContain('epoch');
    // And the Python side agrees the two are absent — the control that makes
    // an un-armed dispatch inert.
    expect(pyFrozenset(PHONE_PY, 'CANARY_DISPATCH_KEYS')).not.toContain('attempt_id');
    expect(pyFrozenset(PHONE_PY, 'CANARY_DISPATCH_KEYS')).not.toContain('epoch');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. The bound pair, and the inequality that relates them.
// ══════════════════════════════════════════════════════════════════════

describe('3. the wait and the ring defaults are pinned as a PAIR', () => {
  const waitDefault = (): number => {
    const match =
      /_bounded_float\(os\.getenv\("PHONE_CANARY_PARTICIPANT_WAIT_SEC"\), ([\d.]+), ([\d.]+), ([\d.]+)\)/
        .exec(PHONE_PY);
    expect(match, 'the canary participant-wait knob was not found').not.toBeNull();
    return Number(match?.[1]);
  };

  it('the Python default is the value the CLI preflights against', () => {
    expect(waitDefault()).toBe(CANARY1_BOUNDS.participantWaitSeconds.def);
  });

  it('the pair satisfies the inequality the CLI refuses on', () => {
    // `waits_misordered`: participant wait >= ring + margin. The CLI cannot
    // read the worker's environment, so if these two drifted apart the
    // preflight would be checking an inequality about a different system.
    expect(waitDefault())
      .toBeGreaterThanOrEqual(CANARY1_BOUNDS.ringSeconds.def + CANARY1_PARTICIPANT_WAIT_MARGIN_SEC);
  });

  it('the Python clamp admits the pinned default', () => {
    const match =
      /_bounded_float\(os\.getenv\("PHONE_CANARY_PARTICIPANT_WAIT_SEC"\), ([\d.]+), ([\d.]+), ([\d.]+)\)/
        .exec(PHONE_PY);
    const [, , lo, hi] = match as RegExpExecArray;
    expect(Number(lo)).toBeLessThanOrEqual(CANARY1_BOUNDS.participantWaitSeconds.def);
    expect(Number(hi)).toBeGreaterThanOrEqual(CANARY1_BOUNDS.participantWaitSeconds.def);
  });

  it('the max-call ceiling agrees on both sides', () => {
    const match = /_bounded_float\(os\.getenv\("PHONE_CANARY_MAX_CALL_SEC"\), ([\d.]+),/.exec(PHONE_PY);
    expect(Number(match?.[1])).toBe(CANARY1_BOUNDS.maxCallSeconds.def);
  });

  it('the question default agrees, and the worker clamps to what exists', () => {
    const match = /_bounded_float\(os\.getenv\("PHONE_CANARY_QUESTIONS"\), ([\d.]+), ([\d.]+), ([\d.]+)\)/
      .exec(PHONE_PY);
    expect(Number(match?.[1])).toBe(CANARY1_BOUNDS.questions.def);
    expect(Number(match?.[3])).toBe(CANARY1_QUESTIONS.length);
    // The worker also refuses to ask more than it has copy for.
    expect(PHONE_CANARY_PY).toContain('min(phone.canary_questions(), len(CANARY_QUESTIONS))');
  });

  it('CONTROL — the pin would notice a one-sided change', () => {
    // If the Python default moved to 45 (the production value), this is what
    // the comparison would look like, and it is not equal.
    expect(45).not.toBe(CANARY1_BOUNDS.participantWaitSeconds.def);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. The recording constant is ONE object, and the branch is gated by three.
// ══════════════════════════════════════════════════════════════════════

describe('4. the worker halves are wired as the design requires', () => {
  it('there is exactly ONE definition of the no-recording constant', () => {
    expect(PHONE_PY).toContain(
      'PHONE_NO_RECORDING = {"audio": False, "transcript": False, "traces": False, "logs": False}',
    );
    // `agent.py` ALIASES it rather than declaring a second literal.
    expect(AGENT_PY).toContain('_PHONE_NO_RECORDING = phone.PHONE_NO_RECORDING');
    expect(AGENT_PY, 'agent.py re-declared the recording dict')
      .not.toMatch(/_PHONE_NO_RECORDING = \{/);
    expect(PHONE_CANARY_PY, 'phone_canary.py declared its own recording dict')
      .not.toMatch(/=\s*\{"audio":/);
  });

  it('the canary session start passes that constant', () => {
    expect(PHONE_CANARY_PY).toContain('record=dict(phone.PHONE_NO_RECORDING)');
    // And NO `session.start(` in the canary module lacks a `record=`.
    const starts = [...PHONE_CANARY_PY.matchAll(/session\.start\(([\s\S]*?)\n        \)/g)];
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(start[1], 'a canary session.start has no record= argument').toContain('record=');
    }
  });

  it('the production phone session still passes it too', () => {
    expect(AGENT_PY).toContain('record=dict(_PHONE_NO_RECORDING)');
  });

  it('phone, canary, and browser share exactly one AgentSession construction site', () => {
    // Turn-detection parity is structural: one provider/AgentSession factory is
    // used by browser WebRTC, production phone, and Canary-1. Recording remains
    // a session.start concern and does not require another AgentSession.
    const sites = [...AGENT_PY.matchAll(/AgentSession\(\n/g)].length;
    expect(sites, 'another AgentSession construction site appeared').toBe(1);

    expect(AGENT_PY).toContain('def _build_provider_session(');
    // PR #180: the factory takes the turn mode so toolless can re-enable
    // preemptive generation without touching the browser path.
    expect(AGENT_PY).toContain('def _build_phone_provider_session(turn_mode: str | None = None)');
    expect(AGENT_PY).toContain('session = AgentSession(');
    expect(AGENT_PY).toContain('return session');
    expect(AGENT_PY).toContain('session = _build_phone_provider_session(turn_mode)');
    expect(AGENT_PY).toContain('session_factory=_build_phone_provider_session');

    // Browser uses the shared factory and retains its own recording start policy.
    expect(AGENT_PY).toContain('session = _build_provider_session(');
    expect(AGENT_PY).toContain('record={"audio": True, "transcript": True');

    // And the canary constructs NONE of its own: it is handed the factory.
    expect(PHONE_CANARY_PY, 'phone_canary.py constructs its own session')
      .not.toContain('AgentSession(');
    expect(PHONE_CANARY_PY).toContain('session = session_factory()');
  });

  it('the canary branch requires all THREE conditions', () => {
    expect(AGENT_PY).toContain('if phone.phone_canary_enabled():');
    expect(AGENT_PY).toContain('phone.canary_mode_of(ctx) is not None and phone.is_canary_room(');
  });

  it('the four worker variables are declared in the environment schema', () => {
    const schema = readFileSync(path.join(REPO, 'config/environment.schema.json'), 'utf8');
    for (const name of CANARY1_WORKER_ENV_VARS) {
      expect(schema, `${name} missing from the environment schema`).toContain(`"${name}"`);
      expect(PHONE_PY, `${name} is not read by the worker`).toContain(`os.getenv("${name}")`);
    }
  });
});
