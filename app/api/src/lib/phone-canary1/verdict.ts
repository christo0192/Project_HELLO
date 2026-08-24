/**
 * lib/phone-canary1/verdict.ts — the emitter, and the reason there is no file
 * writer in this package.
 *
 * ── THE SANITIZER IS A PARSER, NOT A REDACTOR ─────────────────────────
 * Canary-0's `PROTOCOL.md` defines four line shapes with no free-text field.
 * A uuid, a phone number, a room name, an object key, a transcript fragment or
 * a provider payload cannot be EXPRESSED in that grammar, so there is nothing
 * to strip. Canary-1 extends the same grammar with a new `scenario` value
 * (`canary1`) rather than inventing a second protocol, and validates every
 * field against the same regexes before printing.
 *
 * Anything that fails validation prints `emitter_refused|FAIL|unprintable` —
 * a grammar-legal line saying that a line was refused. It does NOT print the
 * offending value, and it does not throw: a throw here, inside a run that has
 * already dialled, would skip teardown.
 *
 * ── AND THERE IS NO `--out` ───────────────────────────────────────────
 * An earlier revision of the design had the CLI write an evidence file. That
 * contradicted the "no `node:fs` write anywhere in the closure" assertion, and
 * the contradiction was resolved in the safer direction: the file writer is
 * gone. The evidence is the terminal transcript, which this grammar guarantees
 * is safe to keep — which is a stronger property than a redacted file, because
 * it needs no redactor to be correct.
 *
 * No I/O beyond the injected `write`.
 */

import { CANARY1_SCENARIO } from './plan.js';

/** `PROTOCOL.md`'s field grammar, mirrored byte-for-byte. */
export const CANARY1_GRAMMAR = {
  scenario: /^[a-z][a-z0-9_]{2,63}$/,
  check: /^[a-z][a-z0-9_]{2,79}$/,
  code: /^[a-z][a-z0-9_]{0,63}$/,
  key: /^[a-z][a-z0-9_]{2,47}$/,
  integer: /^(0|[1-9][0-9]{0,8})$/,
} as const;

/** The line the emitter prints when it refuses to print something else. */
export const CANARY1_UNPRINTABLE_LINE =
  `CANARY|${CANARY1_SCENARIO}|emitter_refused|FAIL|unprintable`;

function validScenario(): boolean {
  return CANARY1_GRAMMAR.scenario.test(CANARY1_SCENARIO);
}

/**
 * A `CANARY|` verdict line, or the refusal line.
 *
 * `pass` is a boolean rather than a string so no caller can pass `'PASS'` when
 * it meant `'FAIL'` — the two differ by four characters and one of them is a
 * lie about a live call.
 */
export function canary1VerdictLine(check: string, pass: boolean, code: string): string {
  if (!validScenario() || !CANARY1_GRAMMAR.check.test(check) || !CANARY1_GRAMMAR.code.test(code)) {
    return CANARY1_UNPRINTABLE_LINE;
  }
  return `CANARY|${CANARY1_SCENARIO}|${check}|${pass ? 'PASS' : 'FAIL'}|${code}`;
}

/** A `CANARYCOUNT|` line. Bounded integers only — never a duration in a string. */
export function canary1CountLine(key: string, value: number): string {
  const rendered = Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  if (
    !validScenario()
    || !CANARY1_GRAMMAR.key.test(key)
    || !CANARY1_GRAMMAR.integer.test(rendered)
  ) {
    return CANARY1_UNPRINTABLE_LINE;
  }
  return `CANARYCOUNT|${CANARY1_SCENARIO}|${key}|${rendered}`;
}

/** The terminator. One scenario, always. */
export function canary1DoneLine(scenarioCount = 1): string {
  const rendered = Number.isSafeInteger(scenarioCount) && scenarioCount >= 0
    ? String(scenarioCount)
    : '';
  if (!CANARY1_GRAMMAR.integer.test(rendered)) return CANARY1_UNPRINTABLE_LINE;
  return `CANARYDONE|${rendered}`;
}

export interface Canary1Emitter {
  check(check: string, pass: boolean, code: string): void;
  count(key: string, value: number): void;
  done(scenarioCount?: number): void;
  /** Every line emitted, in order. For assertions, never for a file. */
  lines(): readonly string[];
  /** True once any FAIL line has been emitted. Drives the exit code. */
  failed(): boolean;
}

/**
 * Build an emitter over an injected `write`.
 *
 * Injected rather than reaching for `console.log` directly, because the
 * structural test asserts this package names no console method — the entry
 * script owns the one write, so there is exactly one place to look when asking
 * "what can this print?".
 */
export function createCanary1Emitter(write: (line: string) => void): Canary1Emitter {
  const emitted: string[] = [];
  let anyFailure = false;

  const push = (line: string): void => {
    emitted.push(line);
    if (line === CANARY1_UNPRINTABLE_LINE || line.includes('|FAIL|')) anyFailure = true;
    write(line);
  };

  return {
    check(check, pass, code) {
      push(canary1VerdictLine(check, pass, code));
    },
    count(key, value) {
      push(canary1CountLine(key, value));
    },
    done(scenarioCount = 1) {
      push(canary1DoneLine(scenarioCount));
    },
    lines: () => Object.freeze([...emitted]),
    failed: () => anyFailure,
  };
}
