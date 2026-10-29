/**
 * The R1 worker's acknowledgement-turn classifier, ported for the gate's speech-to-text check.
 *
 * Voice barge-in (owner decision 2026-10-28, worker `R1_INTERRUPT_MIN_WORDS` 0) commits every lone
 * acknowledgement the candidate says ("Okay", "Hmm", "Yeah, okay", "Okay, continue.") as its own
 * role-play turn, where the SDK used to bank it into the next one. Those turns are what the
 * candidate meant, not speech-to-text chopping a long answer into fragments, so the gate's
 * `stt_sanity` must not count them (owner test 1eb18cd4: 7 of its 8 short role-play turns were
 * acknowledgements, 21% short, and a normal session failed the gate on that check alone).
 *
 * This is a line-for-line port of `is_acknowledgement_turn` and `fold_speech` in
 * `app/voice-livekit/r1_session.py`, the classification the worker passes to the role-play engine
 * as `backchannel=` (its own fidelity check leaves the same turns out).
 * `r1-acknowledgement-cross-language.test.ts` reads the Python source and pins the word lists and
 * phrases below to it, and runs the shared fixture `app/voice-livekit/tests/fixtures/
 * r1_acknowledgement_turns.json` through this port; the worker's `test_r1_core.py` runs the same
 * fixture through the Python original.
 *
 * Pure: no I/O.
 */

/** `r1_session._ACK_WORDS`. */
export const R1_ACK_WORDS: ReadonlySet<string> = new Set([
  'yeah', 'yep', 'yup', 'okay', 'ok', 'alright', 'right', 'sure',
  'hmm', 'hm', 'mm', 'mmm', 'mhm', 'uh', 'um', 'ah', 'oh',
]);

/** `r1_session._YIELD_SOFTENERS`: next to a hand-back ("Sorry, go ahead.") these only soften it. */
export const R1_YIELD_SOFTENERS: ReadonlySet<string> = new Set(['sorry', 'please', 'no']);

/** `r1_session._ACK_PHRASE_RE` alternatives. */
export const R1_ACK_PHRASES: readonly string[] = [
  'uh huh', 'mm hmm', 'm hmm', 'got it', 'i see', 'all right',
];

/** `r1_session._YIELD_RE` alternatives: handing the floor back. */
export const R1_YIELD_PHRASES: readonly string[] = [
  'go ahead', 'go on', 'carry on', 'please continue', 'continue', 'you were saying',
];

/** `r1_session._APOSTROPHES`. */
const APOSTROPHES: ReadonlySet<string> = new Set(["'", '’', '‘', 'ʼ', '`', '´']);

// Python's `\w` on str is Unicode-aware (letters, digits and numbers of any script, and "_"); a
// JavaScript `\w` is ASCII only, so the boundaries are spelled out.
const WORD = '[\\p{L}\\p{N}_]';
const EDGE_APOSTROPHES = new RegExp(`(?<!${WORD})'+|'+(?!${WORD})`, 'gu');
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;

function phraseRegExp(phrases: readonly string[], flags: string): RegExp {
  return new RegExp(`(?<!${WORD})(?:${phrases.join('|')})(?!${WORD})`, flags);
}

// The `g` forms replace every occurrence (Python's `sub`); the test uses its own stateless form.
const ACK_PHRASE = phraseRegExp(R1_ACK_PHRASES, 'gu');
const YIELD = phraseRegExp(R1_YIELD_PHRASES, 'gu');
const YIELD_ANYWHERE = phraseRegExp(R1_YIELD_PHRASES, 'u');

/**
 * `r1_session.fold_speech`: lower-case, every punctuation mark and symbol a space, apostrophe
 * look-alikes folded to `'` (kept only inside a word), whitespace collapsed.
 */
export function foldSpeech(text: string): string {
  let folded = '';
  for (const char of text.toLowerCase()) {
    if (APOSTROPHES.has(char)) folded += "'";
    else if (PUNCTUATION_OR_SYMBOL.test(char)) folded += ' ';
    else folded += char;
  }
  return folded.replace(EDGE_APOSTROPHES, ' ').split(/\s+/).filter(Boolean).join(' ');
}

/**
 * True for a turn that only acknowledges or hands the floor back ("Yeah.", "Mm-hmm.", "Go on",
 * "Okay, continue."). Not "Yes." or "No." (they can answer or deny), not a greeting or a name
 * ("Hi Pooja"), and nothing with a question mark ("Okay?").
 */
export function isAcknowledgementTurn(text: string): boolean {
  if (text.includes('?') || text.includes('？')) return false;
  const folded = foldSpeech(text);
  if (!folded) return false;
  const handedBack = YIELD_ANYWHERE.test(folded);
  const rest = folded.replace(ACK_PHRASE, ' ').replace(YIELD, ' ');
  const words = rest.split(/\s+/).filter(Boolean);
  return words.every(
    (word) => R1_ACK_WORDS.has(word) || (handedBack && R1_YIELD_SOFTENERS.has(word)),
  );
}
