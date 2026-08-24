/**
 * lib/phone-canary1/entry.ts — argv, environment, the one permitted file read,
 * and the hidden TTY double entry.
 *
 * ── WHERE THE NUMBER MAY EXIST, AND WHERE IT PROVABLY MAY NOT ─────────
 * It may exist in the TTY buffer, in this process's V8 heap for the length of
 * one short run, and in the TLS body to LiveKit. Everywhere else is closed by
 * a control rather than by intention:
 *
 *   * argv / shell history — `--number`, `--to`, `--dest` and any number-shaped
 *     positional are REFUSED WITH A REASON. `/proc/<pid>/cmdline` is
 *     world-readable and a shell history file is forever.
 *   * environment — no destination env var is read anywhere in this package,
 *     and a destination-shaped variable being SET is itself a refusal.
 *   * a pipe or heredoc — a non-TTY stdin is refused, because a pipe means a
 *     file, a heredoc or a history entry is holding the value.
 *   * readline history — `historySize: 0`, and the history array is emptied and
 *     the interface closed after EACH entry, not once at the end.
 *   * any file — this package writes none. There is no `--out`.
 *
 * ── THE ONE `node:fs` READ, AND WHY IT IS ALLOWED ─────────────────────
 * The credential refusal has to know whether `app/api/.env` exists and carries
 * a `LIVEKIT_*` key, because a dotfile holding production LiveKit credentials
 * is exactly the durability the rest of this design avoids. That needs a read.
 *
 * So the permission is MOVED, not granted twice: `node:fs` is importable from
 * this file and from nowhere else in the closure, the write side stays
 * absolutely forbidden everywhere including here, the path is a pinned
 * constant rather than an argument, and the contents are never bound to
 * anything that outlives the predicate and never emitted. This is the same
 * single-exception-with-a-name shape `canary0.test.mjs` uses for `exec.mjs`'s
 * `node:child_process`, including the control proving the scanner MOVED the
 * permission rather than gaining a second one.
 *
 * ── DOUBLE ENTRY IS THE REAL CONTROL ──────────────────────────────────
 * The allowlist check on this path is vacuous by construction (see
 * `originate.ts`). What actually stands between a typo and a stranger's
 * handset is typing the number twice and comparing the DIGESTS — never the
 * strings, never printed. A mismatch exits WITHOUT a retry: a retry loop is a
 * second chance to typo into a live carrier.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { wrapDialableNumber, type DialableNumber } from '../../integrations/livekit-phone-dial/index.js';

/** Every stable refusal this module can produce. */
export const CANARY1_ENTRY_REFUSALS = [
  'unknown_flag',
  'destination_in_argv',
  'destination_in_environment',
  'credentials_persisted',
  'not_a_tty',
  'confirmation_required',
  'destination_mismatch',
  'phone_number_not_dialable',
  'flag_value_missing',
  'flag_value_not_an_integer',
] as const;

export type Canary1EntryRefusal = (typeof CANARY1_ENTRY_REFUSALS)[number];

/** The exact phrase `--execute` requires. Long and awkward on purpose. */
export const CANARY1_CONFIRM_PHRASE = 'CALL MY OWN PHONE';

/**
 * Argv tokens whose very presence is a refusal, because each of them is a way
 * of putting a destination on a command line.
 */
export const CANARY1_FORBIDDEN_FLAGS = ['--number', '--to', '--dest', '--destination', '--out'] as const;

/**
 * A number-shaped argv token.
 *
 * Deliberately a REFUSAL PREDICATE, not a parser: it recognises the shapes a
 * person actually types a phone number in — `+919812345670`, `919812345670`,
 * `+91 98123 45670`, `(98123)-45670` — by removing the separators a human uses
 * and asking whether seven or more digits are left. An earlier form anchored on
 * a leading digit and let `(98123)-45670` through to `unknown_flag`, which
 * still refused the run but told the operator the wrong thing. In a mechanism
 * whose refusals are supposed to teach, the wrong reason is a defect.
 *
 * It is loose on purpose. A false positive costs an operator one confusing
 * refusal; a false negative puts a number in `/proc/<pid>/cmdline` and in a
 * shell history file forever.
 */
export const CANARY1_ARGV_SEPARATORS_RE = /[\s()+.-]/g;

export function looksLikeDestination(token: string): boolean {
  const digits = token.replace(CANARY1_ARGV_SEPARATORS_RE, '');
  return /^[0-9]{7,}$/.test(digits);
}

/**
 * Kept as the exported name the closure's structural test and the runbook both
 * refer to. It answers the same question as `looksLikeDestination` for the
 * unseparated forms, and the predicate above is what argv is actually checked
 * against.
 */
export const CANARY1_ARGV_NUMBER_RE = /^\+?[0-9][0-9 ()-]{6,}$/;

/**
 * Environment names that would be holding a destination.
 *
 * The middle segment is OPTIONAL and, when present, must end at an underscore.
 * An earlier form required it — `^(PHONE|CANARY)_[A-Z0-9_]*_(…)$` — which
 * missed `CANARY_TO`, `PHONE_DEST` and `PHONE_E164`, the three most obvious
 * names a person would actually use. Making the segment optional without the
 * trailing underscore would swing the other way and match `PHONE_CANARY_AUTO`
 * on its final `TO`. Anchoring the suffix to a segment boundary catches all
 * three and overmatches none.
 */
export const CANARY1_DESTINATION_ENV_RE =
  /^(?:PHONE|CANARY)_(?:[A-Z0-9_]*_)?(?:NUMBER|DEST|DESTINATION|E164|TO)$/;

/** A `LIVEKIT_*` assignment in a dotfile, with or without `export`. */
export const CANARY1_LIVEKIT_ENV_KEY_RE = /^[ \t]*(?:export[ \t]+)?LIVEKIT_[A-Z0-9_]*[ \t]*=/m;

/**
 * THE PINNED PATH. A constant, never an argument: a path parameter is how a
 * single permitted read becomes an arbitrary file reader.
 */
export const CANARY1_ENV_PATH = new URL('../../../.env', import.meta.url);

export interface Canary1Flags {
  readonly execute: boolean;
  readonly confirm: string;
  readonly questions: number | undefined;
  readonly maxCallSeconds: number | undefined;
  readonly ringSeconds: number | undefined;
  readonly participantWaitSeconds: number | undefined;
  readonly wallClockSeconds: number | undefined;
  readonly agentName: string | undefined;
}

export type Canary1ParseResult =
  | { readonly ok: true; readonly flags: Canary1Flags }
  | { readonly ok: false; readonly refusal: Canary1EntryRefusal };

function refuse(refusal: Canary1EntryRefusal): Canary1ParseResult {
  return { ok: false, refusal };
}

function integerOrNull(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse argv, refusing anything that could be a destination.
 *
 * `--dry-run` is the DEFAULT and is accepted explicitly so a cautious operator
 * can type it; a bare invocation is a dry run that then refuses on the arming
 * constant and says so.
 */
export function parseCanary1Argv(argv: readonly string[]): Canary1ParseResult {
  const flags = {
    execute: false,
    confirm: '',
    questions: undefined as number | undefined,
    maxCallSeconds: undefined as number | undefined,
    ringSeconds: undefined as number | undefined,
    participantWaitSeconds: undefined as number | undefined,
    wallClockSeconds: undefined as number | undefined,
    agentName: undefined as string | undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    // The destination refusals come FIRST, before any flag is understood, so
    // no parsing order can let one through.
    if (CANARY1_FORBIDDEN_FLAGS.includes(token as (typeof CANARY1_FORBIDDEN_FLAGS)[number])) {
      return refuse('destination_in_argv');
    }
    if (looksLikeDestination(token)) return refuse('destination_in_argv');

    const numeric = (assign: (n: number) => void): Canary1ParseResult | null => {
      const raw = argv[i + 1];
      if (raw === undefined) return refuse('flag_value_missing');
      if (looksLikeDestination(raw)) return refuse('destination_in_argv');
      const value = integerOrNull(raw);
      if (value === null) return refuse('flag_value_not_an_integer');
      assign(value);
      i += 1;
      return null;
    };

    let bad: Canary1ParseResult | null = null;
    switch (token) {
      case '--dry-run':
        break;
      case '--execute':
        flags.execute = true;
        break;
      case '--confirm': {
        const raw = argv[i + 1];
        if (raw === undefined) return refuse('flag_value_missing');
        if (looksLikeDestination(raw)) return refuse('destination_in_argv');
        flags.confirm = raw;
        i += 1;
        break;
      }
      case '--agent-name': {
        const raw = argv[i + 1];
        if (raw === undefined) return refuse('flag_value_missing');
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw)) return refuse('unknown_flag');
        flags.agentName = raw;
        i += 1;
        break;
      }
      case '--questions':
        bad = numeric((n) => { flags.questions = n; });
        break;
      case '--max-call-seconds':
        bad = numeric((n) => { flags.maxCallSeconds = n; });
        break;
      case '--ring-seconds':
        bad = numeric((n) => { flags.ringSeconds = n; });
        break;
      case '--participant-wait-seconds':
        bad = numeric((n) => { flags.participantWaitSeconds = n; });
        break;
      case '--wall-clock-seconds':
        bad = numeric((n) => { flags.wallClockSeconds = n; });
        break;
      default:
        return refuse('unknown_flag');
    }
    if (bad !== null) return bad;
  }

  if (flags.execute && flags.confirm !== CANARY1_CONFIRM_PHRASE) {
    return refuse('confirmation_required');
  }
  return { ok: true, flags };
}

/** True when any set variable name looks like it is holding a destination. */
export function destinationInEnvironment(source: NodeJS.ProcessEnv): boolean {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CANARY1_DESTINATION_ENV_RE.test(name)) return true;
  }
  return false;
}

/**
 * THE ONE READ. Path-pinned, contents never bound outside this function, never
 * emitted, never returned. Returns only a boolean.
 *
 * A missing file is not an error — the absence of a dotfile is the state this
 * check is trying to confirm.
 */
export function livekitCredentialsPersisted(
  read: () => string | null = readPinnedEnvFile,
): boolean {
  const contents = read();
  return contents !== null && CANARY1_LIVEKIT_ENV_KEY_RE.test(contents);
}

function readPinnedEnvFile(): string | null {
  try {
    return readFileSync(CANARY1_ENV_PATH, 'utf8');
  } catch {
    return null;
  }
}

/** The narrow slice of a readline interface this module uses. */
export interface Canary1PromptInterface {
  question(prompt: string): Promise<string>;
  history: string[];
  close(): void;
}

export interface Canary1PromptDeps {
  /** Builds ONE interface per entry. Injected so a test can observe its options. */
  readonly openPrompt: () => Canary1PromptInterface;
  readonly isTty: boolean;
}

export type Canary1DestinationResult =
  | { readonly ok: true; readonly number: DialableNumber }
  | { readonly ok: false; readonly refusal: Canary1EntryRefusal };

/**
 * Build the muted readline interface.
 *
 * `terminal: true` is required or `_writeToOutput` is never consulted and the
 * digits echo. `historySize: 0` stops the entry entering `rl.history` in the
 * first place; the explicit clear afterwards is the belt, because a zero
 * history size is a configuration and an empty array is an observation.
 */
export function openCanary1Prompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Canary1PromptInterface {
  const rl = createInterface({
    input,
    output,
    terminal: true,
    historySize: 0,
  }) as unknown as {
    question(prompt: string, cb: (answer: string) => void): void;
    history: string[];
    close(): void;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    _writeToOutput?: (text: string) => void;
  };
  rl._writeToOutput = (): void => {
    // Echo suppressed entirely. Not masked with bullets — a mask still leaks
    // the LENGTH of the value to anyone watching the screen.
  };
  return {
    question: (prompt: string) =>
      new Promise<string>((resolve) => {
        output.write(prompt);
        rl.question('', (answer) => resolve(answer));
      }),
    get history(): string[] {
      return rl.history;
    },
    close: () => rl.close(),
  };
}

/**
 * Read the destination twice and return it wrapped, or refuse.
 *
 * The raw string is passed DIRECTLY into `wrapDialableNumber` and is never
 * bound to a local that outlives the expression. Comparison is by digest.
 * Neither the string nor the digest is ever printed.
 */
export async function readCanary1Destination(
  deps: Canary1PromptDeps,
  write: (text: string) => void,
): Promise<Canary1DestinationResult> {
  if (!deps.isTty) return { ok: false, refusal: 'not_a_tty' };

  const once = async (prompt: string): Promise<DialableNumber | null> => {
    const rl = deps.openPrompt();
    try {
      return wrapDialableNumber(await rl.question(prompt));
    } catch {
      // `wrapDialableNumber` throws a bare code. It is discarded rather than
      // read, because the containment house rule is that no error object
      // survives a seam — and a malformed entry is answered with a refusal
      // code the caller owns.
      return null;
    } finally {
      rl.history.length = 0;
      rl.close();
    }
  };

  write("Destination (owner's own number, +91XXXXXXXXXX). Input is hidden.\n");
  const first = await once('> ');
  if (first === null) return { ok: false, refusal: 'phone_number_not_dialable' };

  write('\nRe-enter to confirm.\n');
  const second = await once('> ');
  write('\n');
  if (second === null) return { ok: false, refusal: 'phone_number_not_dialable' };

  // Digests, never strings. And no retry: a retry is a second chance to typo
  // into a live carrier.
  if (first.digest !== second.digest) return { ok: false, refusal: 'destination_mismatch' };
  return { ok: true, number: first };
}
