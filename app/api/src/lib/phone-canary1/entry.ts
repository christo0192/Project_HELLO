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
// PR108. Was `livekit-phone-dial/index.js`. `dialable-number.ts` imports
// `node:crypto` and nothing else, whereas the barrel is an EAGER re-export of
// `phone-room.ts` -> `lib/room-provisioning.ts` -> `lib/env.ts`, which throws
// at module scope without `SUPABASE_URL`. See the header of `originate.ts`.
import { wrapDialableNumber, type DialableNumber } from '../../integrations/livekit-phone-dial/dialable-number.js';
// The PRODUCTION loader, imported from `config.js` DIRECTLY rather than from
// the directory barrel. `config.ts` has zero imports of its own, so this adds
// no transitive dependency; the barrel re-exports `sip.ts`, and pulling the
// originate seam into this module's graph in order to sanitise a string would
// be the wrong shape whatever the structural suite made of it.
import { loadPhoneDialConfig } from '../../integrations/livekit-phone-dial/config.js';
import { containsDigitRun } from './metadata.js';

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
 * It is loose on purpose, and it is applied to FLAG VALUES as well as to bare
 * positionals. A consequence worth stating rather than discovering:
 * `--max-call-seconds 1234567` is refused `destination_in_argv`, not
 * `flag_value_not_an_integer`, because seven consecutive digits in an argv
 * token is the shape this predicate exists to catch and the two cases are not
 * distinguishable from the token alone. That is the safe direction to be wrong
 * in — a false positive costs an operator one confusing refusal; a false
 * negative puts a number in `/proc/<pid>/cmdline` and in a shell history file
 * forever. Every bound this could plausibly collide with is at most three
 * digits, so no legitimate value reaches seven.
 */
export const CANARY1_ARGV_SEPARATORS_RE = /[\s()+.-]/g;

export function looksLikeDestination(token: string): boolean {
  const digits = token.replace(CANARY1_ARGV_SEPARATORS_RE, '');
  return /^[0-9]{7,}$/.test(digits);
}

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
  readonly joinWaitSeconds: number | undefined;
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
 * can type it. A bare invocation is a dry run that refuses on the arming
 * constant and says so — and that is true of a BARE invocation, on a machine
 * with no credentials and no trunk exported, because `runCanary1` checks
 * arming ahead of every credential and bound gate. An earlier ordering put the
 * trunk and credential refusals first, so the message an operator actually saw
 * on `main` was about a missing trunk, and the disarmed state — the property
 * this whole mechanism is about — was never printed.
 */
export function parseCanary1Argv(argv: readonly string[]): Canary1ParseResult {
  const flags = {
    execute: false,
    confirm: '',
    questions: undefined as number | undefined,
    maxCallSeconds: undefined as number | undefined,
    ringSeconds: undefined as number | undefined,
    participantWaitSeconds: undefined as number | undefined,
    joinWaitSeconds: undefined as number | undefined,
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
        // The destination scan FIRST, exactly as every other value-taking flag
        // does it. This was the one exception, and the exception was the
        // defect: the value reaches `/proc/<pid>/cmdline`, shell history, and
        // `createDispatch`'s agent name — a field OUTSIDE the metadata blob,
        // so the worker's digit-run guard never sees it.
        //
        // TWO predicates, because one is not enough for THIS field. The
        // separator-stripping scan catches the forms a person types a number
        // in, but the shape check below admits `a919812345670`: a leading
        // letter makes it a legal identifier and not a legal destination. So
        // the digit-run rule is applied as well — the SAME rule
        // `validate-voice-worker-apps.mjs` already applies to
        // `PHONE_AGENT_NAME` ("must be a dispatch name, not a phone/trunk
        // number"), mirrored here so the CLI and the config validator agree
        // about what an agent name may say.
        if (looksLikeDestination(raw) || containsDigitRun(raw)) {
          return refuse('destination_in_argv');
        }
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
      case '--join-wait-seconds':
        bad = numeric((n) => { flags.joinWaitSeconds = n; });
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

/**
 * The trunk id, through the PRODUCTION loader.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────
 * The production lane loads the trunk through `loadPhoneDialConfig` ->
 * `boundedOpaqueId`, which admits only `^[A-Za-z0-9_-]{1,128}$`. `config.ts`
 * states the reason plainly: `+` and space are outside the class DELIBERATELY,
 * so the field can never be talked into holding an E.164 value. The canary
 * reached the same SDK seam without any of it — `process.env.PHONE_SIP_TRUNK_ID
 * ?? ''` raw, non-emptiness in the preflight, then passed verbatim.
 *
 * The realistic failure is not an attack. The operator pastes the trunk id at
 * a `read -rs` prompt, CANNOT SEE IT, and the paste carries a trailing space or
 * newline. Everything passes, the destination is typed twice, the room is
 * created, the worker is dispatched, and the SDK is called with a malformed
 * trunk — after which the containment layer correctly discards the error and
 * the transcript says `originate_failed` with no detail, having already spent
 * the operator's double entry and created live provider state.
 *
 * Reusing the production LOADER rather than copying its regex is the point: a
 * second copy of the rule is a second thing to keep true, and this way
 * `trunk_not_configured` means "absent, or not a bounded opaque id" — which is
 * what the refusal already reads as. Surrounding whitespace is TRIMMED rather
 * than refused, which is the loader's own behaviour and the better outcome for
 * the one value the operator types blind.
 */
export function sanitizeCanary1TrunkId(raw: string | undefined): string {
  return loadPhoneDialConfig({ PHONE_SIP_TRUNK_ID: raw }).sipTrunkId;
}
