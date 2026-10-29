/**
 * The two-sided pin between the Python R1 worker's acknowledgement classifier and the API port the
 * gate's speech-to-text check uses.
 *
 * ── WHY THIS IS A CROSS-LANGUAGE TEST ─────────────────────────────────
 * The worker (`app/voice-livekit/r1_session.py` `is_acknowledgement_turn`) passes the
 * classification to the role-play engine as `backchannel=`, and the engine's own `stt_sanity`
 * leaves those turns out. The API gate (`lib/r1/transcript.ts` `computeTranscriptStats`) computes
 * the same check from the transcript rows, through `lib/r1/acknowledgement.ts`. If the two
 * disagree, a session the worker calls clean fails the gate (or the other way round), which is
 * exactly how owner test 1eb18cd4 failed: 21% short role-play turns, 7 of 8 of them "Okay"-type.
 *
 * Like the agent-name pins it READS THE PYTHON SOURCE (CI's API job has no interpreter guarantee)
 * and runs one fixture list through this side; `test_r1_core.py` runs the same fixture through the
 * Python original.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  R1_ACK_PHRASES,
  R1_ACK_WORDS,
  R1_YIELD_PHRASES,
  R1_YIELD_SOFTENERS,
  foldSpeech,
  isAcknowledgementTurn,
} from '../lib/r1/acknowledgement.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');
const SESSION_PY = read('app/voice-livekit/r1_session.py');
const FIXTURE = JSON.parse(
  read('app/voice-livekit/tests/fixtures/r1_acknowledgement_turns.json'),
) as { text: string; acknowledgement: boolean }[];

/** The quoted words of a top-level `NAME = frozenset(...)` literal. */
function pyFrozensetWords(source: string, name: string): string[] {
  const match = new RegExp(`^${name} = frozenset\\(([\\s\\S]*?)\\)\\n`, 'm').exec(source);
  if (match === null) throw new Error(`python frozenset not found: ${name}`);
  return [...(match[1] as string).matchAll(/"([^"]*)"/g)].map((m) => m[1] as string).sort();
}

/** The alternatives of a top-level `NAME = re.compile(r"\b(?:a|b|c)\b")`. */
function pyPhraseAlternatives(source: string, name: string): string[] {
  const match = new RegExp(`^${name} = re\\.compile\\(r"\\\\b\\(\\?:([^)"]*)\\)\\\\b"\\)\\s*$`, 'm')
    .exec(source);
  if (match === null) throw new Error(`python phrase regex not found: ${name}`);
  return (match[1] as string).split('|');
}

describe('acknowledgement turns: Python worker ⇄ TypeScript API', () => {
  it('uses the worker\'s word lists and phrases, in the worker\'s order', () => {
    expect([...R1_ACK_WORDS].sort()).toEqual(pyFrozensetWords(SESSION_PY, '_ACK_WORDS'));
    expect([...R1_YIELD_SOFTENERS].sort())
      .toEqual(pyFrozensetWords(SESSION_PY, '_YIELD_SOFTENERS'));
    expect([...R1_ACK_PHRASES]).toEqual(pyPhraseAlternatives(SESSION_PY, '_ACK_PHRASE_RE'));
    expect([...R1_YIELD_PHRASES]).toEqual(pyPhraseAlternatives(SESSION_PY, '_YIELD_RE'));
  });

  it('the worker still classifies as this port does (the body is the one ported)', () => {
    const start = SESSION_PY.search(/^def is_acknowledgement_turn\(/m);
    expect(start).toBeGreaterThan(0);
    const rest = SESSION_PY.slice(start + 1);
    const body = rest.slice(0, rest.search(/^(def |class |[A-Za-z_][A-Za-z0-9_]* = )/m));
    for (const line of [
      'if _has_question_mark(text):',
      'folded = fold_speech(text)',
      'handed_back = _YIELD_RE.search(folded) is not None',
      'rest = _YIELD_RE.sub(" ", _ACK_PHRASE_RE.sub(" ", folded))',
      'allowed = _ACK_WORDS | _YIELD_SOFTENERS if handed_back else _ACK_WORDS',
      'return all(word in allowed for word in rest.split())',
    ]) {
      expect(body).toContain(line);
    }
  });

  it('agrees with the worker on every turn of the shared fixture', () => {
    expect(FIXTURE.length).toBeGreaterThan(50);
    for (const { text, acknowledgement } of FIXTURE) {
      expect([text, isAcknowledgementTurn(text)]).toEqual([text, acknowledgement]);
    }
  });

  it('folds speech as the worker does', () => {
    expect(foldSpeech('No, thank you.')).toBe('no thank you');
    expect(foldSpeech('Let’s start!')).toBe("let's start");
    expect(foldSpeech("'quoted' words")).toBe('quoted words');
    expect(foldSpeech('Mm-hmm.')).toBe('mm hmm');
    expect(foldSpeech('  Okay…  ')).toBe('okay');
    expect(foldSpeech('हाँ, ठीक है')).toBe('हाँ ठीक है');
  });
});
