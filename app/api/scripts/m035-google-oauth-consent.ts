/**
 * M035 S03 T4: the ONE-TIME OAuth consent helper for Dex's Google user (owner-run, local, once).
 *
 * The public booking link puts each interview on Dex's own Google calendar. Dex is a normal,
 * non-admin user in the company Workspace, so no service account may impersonate anyone there
 * (owner decision 2026-11-26): the API authenticates as Dex with an OAuth client ("Desktop app"
 * type) and a refresh token. This script mints that refresh token. The owner runs it ONCE, on a
 * laptop, with the default browser signed in as Dex:
 *
 *   npx tsx scripts/m035-google-oauth-consent.ts --out=<file OUTSIDE any git checkout>
 *       [--space] [--dex-email=<dex email>] [--no-open] [--timeout-sec=<30..900>]
 *
 * It reads R1_MEET_GOOGLE_OAUTH_CLIENT_ID, R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET,
 * R1_MEET_GOOGLE_DEX_EMAIL and R1_MEET_GOOGLE_MEET_MODE through the API's own config reader
 * (`getR1MeetGoogleOAuthClientInputs`), and prompts for whatever is unset or malformed there (the
 * secret prompt echoes nothing). Typed values go through the same reader, so they meet the same rules
 * the API applies later.
 *
 * Flow: `--out` is checked FIRST and refused (exit 2, before any prompt, listener or network) when
 * its folder does not exist, the file already exists, or the path lies inside ANY git working tree
 * (every ancestor folder is checked for a `.git` file or folder) or inside this script's repository.
 * Then a PKCE S256 verifier and a random `state` are made, a listener starts on 127.0.0.1 with a
 * random port (redirect `http://127.0.0.1:<port>`, nothing to register for a Desktop client), and the
 * consent page opens with `access_type=offline`, `prompt=consent` (so Google always returns a refresh
 * token), `login_hint` = Dex and the two scopes `calendar.events.owned` + `meetings.space.settings`
 * (+ `meetings.space.created` with `--space` or `R1_MEET_GOOGLE_MEET_MODE=space`). The consent URL
 * holds no secret; it is printed ONLY when no browser could be opened. A `GET /` carrying `code` or
 * `error` is taken only when its `state` matches (compared in constant time); one with another state
 * is answered 400 and IGNORED, so a stray or forged request cannot end the run (the wait goes on, and
 * a run that then times out says `state_mismatch`). Exactly one matching callback is accepted; the
 * browser gets a fixed page that echoes nothing. The code is exchanged at the token endpoint with the
 * verifier; the answer must carry a refresh token and every requested scope (granular consent can
 * drop one). The file gets ONE line `R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN=<token>`, created
 * exclusively (`wx`) with mode 0600.
 *
 * The helper CANNOT tell which Google account consented (`login_hint` is only a hint, and the two
 * scopes carry no identity). So its next steps put the check first: run the live spike with the token
 * and import it only after `PASS organizer` (the event's organizer is the Dex email).
 *
 * Output: a waiting line, the written path, the next commands (load the token into the shell, the
 * spike, `fly secrets import` in PowerShell and bash, then delete the file), or one
 * `FAIL <word>` line, the word from `CONSENT_FAIL_WORDS`. NEVER the refresh token, the authorization
 * code, the client secret, the PKCE verifier or an access token, and never an error message. The
 * listener is closed in every case. Exit 0 = written, 1 = the consent or the exchange failed, 2 =
 * usage, a refused `--out` or an invalid input. Never run in CI and never by the API.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getR1MeetGoogleOAuthClientInputs,
  type R1MeetGoogleOAuthClientInputs,
} from '../src/lib/r1/meet/config.js';
import { isGoogleError, type GoogleErrorCode } from '../src/integrations/google/errors.js';
import { GOOGLE_TOKEN_URL, sendGoogleRequest, type GoogleTransport } from '../src/integrations/google/http.js';
import { GOOGLE_OAUTH_AUTHORIZE_URL, GOOGLE_SCOPES } from '../src/integrations/google/token.js';

export interface ConsentPromptOptions {
  /** The answer must not be echoed (the client secret). */
  hidden: boolean;
}

export interface ConsentDeps {
  /** Default: `getR1MeetGoogleOAuthClientInputs()` (the environment, through the API's reader). */
  inputs?: R1MeetGoogleOAuthClientInputs;
  /** Default: a readline question on stdin; a hidden question echoes nothing. */
  prompt?: (question: string, options: ConsentPromptOptions) => Promise<string>;
  /** Open the consent page; resolves false when no browser could be started. Default: spawn, no shell. */
  openUrl?: (url: string) => Promise<boolean>;
  /** The token endpoint transport. Default: the Google client's fetch transport. */
  transport?: GoogleTransport;
  out?: (line: string) => void;
  /** Random bytes for the PKCE verifier and the state. Default `crypto.randomBytes`. */
  random?: (bytes: number) => Buffer;
  /** How long to wait for Google's redirect. Default 300 000 ms; `--timeout-sec` overrides it. */
  timeoutMs?: number;
  /** The repository the script belongs to (an `--out` inside it is refused). Default: found from this file. */
  repoRoot?: string | null;
}

/** The one line the file holds is `<this name>=<refresh token>`. */
export const CONSENT_ENV_NAME = 'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN';
export const CONSENT_FLY_APP = 'project-hello-api';
export const CONSENT_DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 900;
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/**
 * Every word a `FAIL <word>` line of this helper can carry, closed (the runbook explains each one;
 * a test pins that). `scope_missing` is followed by the short name of the scope that was not granted.
 */
export const CONSENT_FAIL_WORDS = Object.freeze([
  'out_parent_missing',
  'out_exists',
  'out_inside_git',
  'out_inside_repo',
  'invalid_client_id',
  'invalid_client_secret',
  'invalid_dex_email',
  'listener',
  'timeout',
  'state_mismatch',
  'consent_access_denied',
  'consent_error',
  'exchange_auth_revoked',
  'exchange_setup_forbidden',
  'exchange_quota',
  'exchange_unavailable',
  'exchange_timeout',
  'exchange_malformed_response',
  'exchange_invalid_request',
  'no_refresh_token',
  'scope_missing',
  'write_failed',
  'unexpected',
] as const);
export type ConsentFailWord = (typeof CONSENT_FAIL_WORDS)[number];

/**
 * What the token endpoint's answer to the code exchange becomes (the Google client's token-context
 * map: `invalid_grant` = auth_revoked, any other 4xx = setup_forbidden). Any other code, or a non-Google
 * failure, is `exchange_unavailable`.
 */
const EXCHANGE_FAIL_WORDS: Readonly<Partial<Record<GoogleErrorCode, ConsentFailWord>>> = Object.freeze({
  auth_revoked: 'exchange_auth_revoked',
  setup_forbidden: 'exchange_setup_forbidden',
  quota: 'exchange_quota',
  unavailable: 'exchange_unavailable',
  timeout: 'exchange_timeout',
  malformed_response: 'exchange_malformed_response',
  invalid_request: 'exchange_invalid_request',
});

const USAGE =
  'usage: npx tsx scripts/m035-google-oauth-consent.ts --out=<file outside any git checkout> ' +
  '[--space] [--dex-email=<dex email>] [--no-open] [--timeout-sec=<30..900>] ' +
  '(reads R1_MEET_GOOGLE_OAUTH_CLIENT_ID, R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET, R1_MEET_GOOGLE_DEX_EMAIL ' +
  'and R1_MEET_GOOGLE_MEET_MODE when set, prompts otherwise; run it signed in as the Dex user)';

/** A refresh token as the API accepts it (config.ts): 1..512 printable ASCII, no whitespace. */
const REFRESH_TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
/** An authorization code as Google sends it: printable ASCII, no whitespace. */
const AUTH_CODE_RE = /^[\x21-\x7e]{1,2048}$/;

/** The fixed pages the browser gets; none of them echoes anything from the request. */
const PAGE_RECEIVED = page('Google answered. Return to the terminal for the result; you can close this tab.');
const PAGE_NOT_COMPLETED = page('Google consent was not completed. Return to the terminal; you can close this tab.');
const PAGE_ALREADY = page('An answer was already received. You can close this tab.');
const PAGE_IGNORED = page('Not found.');

function page(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hello R1</title></head><body><p>${text}</p></body></html>`;
}

// ── Arguments ───────────────────────────────────────────────────────────────

interface ConsentArgs {
  out: string;
  dexEmail: string | null;
  space: boolean;
  noOpen: boolean;
  timeoutSec: number | null;
}

function parseArgs(argv: readonly string[]): ConsentArgs | 'usage' | 'help' {
  let out: string | null = null;
  let dexEmail: string | null = null;
  let space = false;
  let noOpen = false;
  let timeoutSec: number | null = null;
  const seen = new Set<string>();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? null : arg.slice(equals + 1);
    if (seen.has(name)) return 'usage';
    seen.add(name);
    if (name === '--out' && value !== null && value.trim() !== '') out = value;
    else if (name === '--dex-email' && value !== null) dexEmail = value;
    else if (name === '--space' && value === null) space = true;
    else if (name === '--no-open' && value === null) noOpen = true;
    else if (name === '--timeout-sec' && value !== null && /^\d{1,4}$/.test(value)) {
      const seconds = Number(value);
      if (seconds < MIN_TIMEOUT_SEC || seconds > MAX_TIMEOUT_SEC) return 'usage';
      timeoutSec = seconds;
    } else {
      return 'usage';
    }
  }
  if (out === null) return 'usage';
  return { out, dexEmail, space, noOpen, timeoutSec };
}

// ── The --out checks ────────────────────────────────────────────────────────

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Whether `directory` or any of its ancestors holds a `.git` file (a worktree) or folder. */
function insideGitWorkingTree(directory: string): boolean {
  let current = path.resolve(directory);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** The first ancestor of this script's folder that holds `.git`; null when there is none. */
function findRepoRoot(): string | null {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function realDirectory(directory: string): string | null {
  try {
    if (!statSync(directory).isDirectory()) return null;
    return realpathSync.native(directory);
  } catch {
    return null;
  }
}

/** The absolute target path, or the closed word of the refusal (R13). Touches nothing. */
function checkOutPath(raw: string, repoRoot: string | null): { path: string } | { refused: ConsentFailWord } {
  const target = path.resolve(raw);
  const parent = path.dirname(target);
  const realParent = realDirectory(parent);
  if (realParent === null) return { refused: 'out_parent_missing' };
  let exists = true;
  try {
    lstatSync(target);
  } catch {
    exists = false;
  }
  if (exists) return { refused: 'out_exists' };
  // Both the written path and the real one: a link into, or out of, a checkout is refused either way.
  if (insideGitWorkingTree(parent) || insideGitWorkingTree(realParent)) return { refused: 'out_inside_git' };
  if (repoRoot !== null) {
    const realRoot = realDirectory(repoRoot) ?? path.resolve(repoRoot);
    if (isInside(parent, path.resolve(repoRoot)) || isInside(realParent, realRoot)) return { refused: 'out_inside_repo' };
  }
  return { path: target };
}

// ── Defaults (the real terminal and browser) ────────────────────────────────

async function defaultPrompt(question: string, options: ConsentPromptOptions): Promise<string> {
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');
  let muted = false;
  // The question is written before muting starts; after that a hidden answer is never echoed.
  const output = new Writable({
    write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
  try {
    return await new Promise<string>((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question(question, (answer) => resolve(answer));
      muted = options.hidden;
    });
  } finally {
    if (options.hidden) process.stdout.write('\n');
    rl.close();
  }
}

/** Start the default browser on the consent URL with spawn and NO shell. */
function defaultOpenUrl(url: string): Promise<boolean> {
  if (!url.startsWith(`${GOOGLE_OAUTH_AUTHORIZE_URL}?`)) return Promise.resolve(false);
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

// ── The loopback listener ───────────────────────────────────────────────────

type ConsentCallback =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; state: string };

interface Listener {
  server: Server;
  port: number;
  /** Resolves with the first `GET /` that carries `code` or `error` AND the expected `state`. */
  callback: Promise<ConsentCallback>;
  /** Whether a callback with another `state` was answered and ignored. */
  sawStateMismatch(): boolean;
}

function startListener(expectedState: string): Promise<Listener> {
  let settle: (value: ConsentCallback) => void = () => {};
  const callback = new Promise<ConsentCallback>((resolve) => {
    settle = resolve;
  });
  let expectedHost = '';
  let accepted = false;
  let mismatched = false;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const reply = (status: number, html: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        connection: 'close',
      });
      res.end(html);
    };
    try {
      if (req.method !== 'GET') return reply(405, PAGE_IGNORED);
      // Only the loopback address this listener answers on (a rebound host name is not Google's redirect).
      if (req.headers.host !== expectedHost) return reply(400, PAGE_IGNORED);
      const url = new URL(req.url ?? '/', `http://${expectedHost}`);
      if (url.pathname !== '/') return reply(404, PAGE_IGNORED);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (code === null && error === null) return reply(400, PAGE_IGNORED);
      if (accepted) return reply(409, PAGE_ALREADY);
      // Not Google's answer to THIS run: ignored, so it cannot end the run (the wait goes on).
      const state = url.searchParams.get('state') ?? '';
      if (!sameState(expectedState, state)) {
        mismatched = true;
        return reply(400, PAGE_IGNORED);
      }
      accepted = true;
      if (error !== null) {
        reply(200, PAGE_NOT_COMPLETED);
        settle({ kind: 'error', error, state });
      } else {
        reply(200, PAGE_RECEIVED);
        settle({ kind: 'code', code: code as string, state });
      }
    } catch {
      reply(400, PAGE_IGNORED);
    }
  };

  return new Promise<Listener>((resolve, reject) => {
    const server = createServer(handle);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as AddressInfo).port;
      expectedHost = `127.0.0.1:${port}`;
      resolve({ server, port, callback, sawStateMismatch: () => mismatched });
    });
  });
}

async function closeListener(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// ── Small helpers ───────────────────────────────────────────────────────────

const b64url = (bytes: Buffer): string => bytes.toString('base64url');

function sameState(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const shortScope = (scope: string): string => (scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : 'unknown');

function resolveTimeoutMs(args: ConsentArgs, deps: ConsentDeps): number {
  if (args.timeoutSec !== null) return args.timeoutSec * 1000;
  const given = deps.timeoutMs;
  return typeof given === 'number' && Number.isInteger(given) && given > 0 ? given : CONSENT_DEFAULT_TIMEOUT_MS;
}

// ── The run ─────────────────────────────────────────────────────────────────

/** A closed outcome word; the run prints `FAIL <word>[ <detail>]` and returns the exit code. */
class ConsentFailure extends Error {
  constructor(
    readonly word: ConsentFailWord,
    readonly exitCode: 1 | 2,
    /** Only for `scope_missing`: the short name of the scope (no secret, no value). */
    readonly detail: string | null = null,
  ) {
    super('consent_failure');
  }

  get line(): string {
    return this.detail === null ? `FAIL ${this.word}` : `FAIL ${this.word} ${this.detail}`;
  }
}

export async function runConsent(argv: string[], deps: ConsentDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const args = parseArgs(argv);
  if (args === 'help') {
    out(USAGE);
    return 0;
  }
  if (args === 'usage') {
    out(USAGE);
    return 2;
  }
  // FIRST: nothing is prompted, listened on or sent before the target file is acceptable.
  const target = checkOutPath(args.out, deps.repoRoot === undefined ? findRepoRoot() : deps.repoRoot);
  if ('refused' in target) {
    out(`FAIL ${target.refused}`);
    return 2;
  }

  try {
    return await consent(args, deps, target.path, out);
  } catch (error) {
    out(error instanceof ConsentFailure ? error.line : 'FAIL unexpected');
    return error instanceof ConsentFailure ? error.exitCode : 1;
  }
}

async function consent(
  args: ConsentArgs,
  deps: ConsentDeps,
  outFile: string,
  out: (line: string) => void,
): Promise<number> {
  const inputs = deps.inputs ?? getR1MeetGoogleOAuthClientInputs();
  const prompt = deps.prompt ?? defaultPrompt;
  const ask = async (question: string, hidden: boolean): Promise<string> => {
    try {
      const answer = await prompt(question, { hidden });
      return typeof answer === 'string' ? answer.trim() : '';
    } catch {
      return '';
    }
  };

  // Each value comes from the environment (already through the reader) or is typed and then put
  // through the same reader, so the helper accepts exactly what the API will accept.
  const clientId =
    inputs.clientId ??
    getR1MeetGoogleOAuthClientInputs({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: await ask('Google OAuth client id: ', false) }).clientId;
  if (clientId === null) throw new ConsentFailure('invalid_client_id', 2);
  const clientSecret =
    inputs.clientSecret ??
    getR1MeetGoogleOAuthClientInputs({
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: await ask('Google OAuth client secret (not shown): ', true),
    }).clientSecret;
  if (clientSecret === null) throw new ConsentFailure('invalid_client_secret', 2);
  const dexEmail =
    args.dexEmail !== null
      ? getR1MeetGoogleOAuthClientInputs({ R1_MEET_GOOGLE_DEX_EMAIL: args.dexEmail }).dexEmail
      : (inputs.dexEmail ??
        getR1MeetGoogleOAuthClientInputs({ R1_MEET_GOOGLE_DEX_EMAIL: await ask('Dex email address: ', false) }).dexEmail);
  if (dexEmail === null) throw new ConsentFailure('invalid_dex_email', 2);

  const scopes: string[] = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
  if (args.space || inputs.meetMode === 'space') scopes.push(GOOGLE_SCOPES.meetSpaceCreated);

  const random = deps.random ?? randomBytes;
  const verifier = b64url(random(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(random(16));

  let listener: Listener;
  try {
    listener = await startListener(state);
  } catch {
    throw new ConsentFailure('listener', 1);
  }
  // A run that times out after ignoring a callback with another state says so.
  const timedOutFailure = (): ConsentFailure =>
    new ConsentFailure(listener.sawStateMismatch() ? 'state_mismatch' : 'timeout', 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redirectUri = `http://127.0.0.1:${listener.port}`;
    const consentUrl = `${GOOGLE_OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      login_hint: dexEmail,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()}`;

    const timeoutMs = resolveTimeoutMs(args, deps);
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    let opened = false;
    if (!args.noOpen) {
      const openUrl = deps.openUrl ?? defaultOpenUrl;
      const attempt = Promise.resolve()
        .then(() => openUrl(consentUrl))
        .then((value) => value === true, () => false);
      const result = await Promise.race([attempt, timedOut]);
      if (result === 'timeout') throw timedOutFailure();
      opened = result;
    }
    if (opened) {
      out('Opened the Google consent page in the default browser: sign in as the Dex user and allow access.');
    } else {
      out('Open this URL in a browser signed in as the Dex user, then allow access:');
      out(consentUrl);
    }
    out(`Waiting up to ${Math.ceil(timeoutMs / 1000)} s for Google to return to 127.0.0.1 ...`);

    const answer = await Promise.race([listener.callback, timedOut]);
    if (answer === 'timeout') throw timedOutFailure();
    // The listener only settles on the expected state; checked again here, in constant time.
    if (!sameState(state, answer.state)) throw new ConsentFailure('state_mismatch', 1);
    if (answer.kind === 'error') {
      throw new ConsentFailure(answer.error === 'access_denied' ? 'consent_access_denied' : 'consent_error', 1);
    }
    if (!AUTH_CODE_RE.test(answer.code)) throw new ConsentFailure('consent_error', 1);

    const refreshToken = await exchange({
      code: answer.code,
      clientId,
      clientSecret,
      redirectUri,
      verifier,
      scopes,
      transport: deps.transport,
    });

    try {
      writeFileSync(outFile, `${CONSENT_ENV_NAME}=${refreshToken}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch {
      throw new ConsentFailure('write_failed', 1);
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(outFile, 0o600);
      } catch {
        // The exclusive create already used mode 0600 (minus the umask); nothing more to do.
      }
    }

    out(`Wrote the Dex refresh token (one ${CONSENT_ENV_NAME} line) to: ${outFile}`);
    // login_hint is only a hint: the grant may belong to whoever was signed in. Check before import.
    out(
      'Check it FIRST: this helper cannot tell which Google account gave consent. Run the live spike with this token ' +
        '(runbook: "The Google half of the live spike") and import it ONLY after the spike prints PASS organizer.',
    );
    out(
      `1. Load it into this shell without printing it, PowerShell: Get-Content ${psQuote(outFile)} | ` +
        `ForEach-Object { $n, $v = $_ -split '=', 2; Set-Item "env:$n" $v } (bash: set -a; . ${shQuote(outFile)}; set +a); ` +
        'the spike also needs the client secret in the shell, typed without echo (runbook)',
    );
    out(
      `2. With M035_GOOGLE_SPIKE_LIVE=yes: npx tsx scripts/m035-google-spike.ts --live${args.space || inputs.meetMode === 'space' ? ' --space' : ''} ` +
        '(FAIL organizer mismatch = not Dex: delete the file and run this helper again, signed in as Dex)',
    );
    out(`3. After PASS organizer, PowerShell: Get-Content -Raw ${psQuote(outFile)} | fly secrets import -a ${CONSENT_FLY_APP}`);
    out(`   After PASS organizer, bash: fly secrets import -a ${CONSENT_FLY_APP} < ${shQuote(outFile)}`);
    out(`4. Then delete the file: Remove-Item ${psQuote(outFile)} (bash: rm -f ${shQuote(outFile)})`);
    return 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await closeListener(listener.server);
  }
}

interface ExchangeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  verifier: string;
  scopes: readonly string[];
  transport: GoogleTransport | undefined;
}

/**
 * The authorization-code grant at the token endpoint (one attempt, the Google client's deadline, byte
 * cap and token-endpoint error map). The answer must carry a refresh token and every requested scope.
 * It is sent under the `token.refresh` operation name: the closed operation set of the client is not
 * widened for an owner-run script that logs nothing, and the code grant is what mints that refresh token.
 */
async function exchange(input: ExchangeInput): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  }).toString();
  let json: unknown;
  try {
    const result = await sendGoogleRequest(
      {
        operation: 'token.refresh',
        context: 'token',
        method: 'POST',
        url: GOOGLE_TOKEN_URL,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
      input.transport === undefined ? {} : { transport: input.transport },
    );
    json = result.json;
  } catch (error) {
    throw new ConsentFailure((isGoogleError(error) ? EXCHANGE_FAIL_WORDS[error.code] : undefined) ?? 'exchange_unavailable', 1);
  }
  const answer = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const refreshToken = answer.refresh_token;
  if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_RE.test(refreshToken)) {
    throw new ConsentFailure('no_refresh_token', 1);
  }
  const granted = new Set(typeof answer.scope === 'string' ? answer.scope.split(/\s+/).filter((item) => item !== '') : []);
  for (const scope of input.scopes) {
    if (!granted.has(scope)) throw new ConsentFailure('scope_missing', 1, shortScope(scope));
  }
  return refreshToken;
}

// Run only when executed directly (`tsx scripts/m035-google-oauth-consent.ts`), not when imported by a test.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runConsent(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('FAIL unexpected');
      process.exitCode = 1;
    },
  );
}
