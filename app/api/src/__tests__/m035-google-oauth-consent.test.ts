/**
 * M035 S03 T4: the owner's one-time OAuth consent helper (scripts/m035-google-oauth-consent.ts).
 *
 * The "network" is the Google fake's token endpoint (its authorization_code grant checks the code,
 * the redirect URI, the client and the PKCE verifier) plus the helper's REAL loopback listener on
 * 127.0.0.1, which the simulated browser below calls with `fetch`. Nothing ever reaches Google.
 * Fixtures are low-entropy strings built at run time (S03 plan R18).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_DEFAULT_TIMEOUT_MS,
  CONSENT_ENV_NAME,
  CONSENT_FLY_APP,
  runConsent,
  type ConsentDeps,
  type ConsentPromptOptions,
} from '../../scripts/m035-google-oauth-consent.js';
import { GOOGLE_TOKEN_URL } from '../integrations/google/http.js';
import { GOOGLE_OAUTH_AUTHORIZE_URL, GOOGLE_SCOPES } from '../integrations/google/token.js';
import {
  getR1MeetGoogleOAuthClientInputs,
  R1_MEET_PUBLIC_SECRET_VARIABLES,
  type R1MeetGoogleOAuthClientInputs,
} from '../lib/r1/meet/config.js';
import {
  createFakeGoogle,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_DEX_EMAIL,
  FAKE_GOOGLE_REFRESH_TOKEN,
  type FakeGoogle,
  type FakeGoogleAuthorizationCodeGrant,
  type FakeGoogleOptions,
} from './support/google-fake.js';

const API_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = path.join(API_ROOT, 'scripts', 'm035-google-oauth-consent.ts');
const TWO_SCOPES = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
const THREE_SCOPES = [...TWO_SCOPES, GOOGLE_SCOPES.meetSpaceCreated];
/** Listener tests do real loopback I/O (a refused connect can take ~2 s on Windows). */
const LISTENER_TEST_MS = 20_000;

// ── Temp folders (created here, removed here by exact path) ─────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'm035-consent-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Inputs (through the API's reader, like the helper's default) ────────────

function envInputs(overrides: Record<string, string | undefined> = {}): R1MeetGoogleOAuthClientInputs {
  return getR1MeetGoogleOAuthClientInputs({
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
    R1_MEET_GOOGLE_DEX_EMAIL: FAKE_GOOGLE_DEX_EMAIL,
    ...overrides,
  });
}
const NO_INPUTS = (): R1MeetGoogleOAuthClientInputs => getR1MeetGoogleOAuthClientInputs({});

// ── The simulated browser ───────────────────────────────────────────────────

interface BrowserPlan {
  /** Overrides of what the user "granted" for the code (default: every requested scope). */
  grant?: (requested: string[]) => Partial<FakeGoogleAuthorizationCodeGrant>;
  /** Come back with `error=<value>` instead of a code. */
  error?: string;
  /** Change the `state` sent back. */
  state?: (sent: string) => string;
  /** Never come back (the user walks away). */
  never?: boolean;
  /** Hit `/favicon.ico` and a bare `/` first, like a real browser may. */
  noise?: boolean;
}

interface Visits {
  consent?: URL;
  redirect?: string;
  code?: string;
  replyStatus?: number;
  replyBody?: string;
  noise?: number[];
}

function makeBrowser(fake: FakeGoogle, plan: BrowserPlan = {}) {
  const visits: Visits = {};
  /** What Google's consent page does: redirect back to the loopback listener. */
  const visit = async (raw: string): Promise<void> => {
    const consent = new URL(raw);
    visits.consent = consent;
    const query = consent.searchParams;
    const redirect = query.get('redirect_uri') as string;
    visits.redirect = redirect;
    if (plan.never) return;
    if (plan.noise) {
      const favicon = await fetch(new URL('/favicon.ico', redirect));
      const bare = await fetch(new URL('/', redirect));
      visits.noise = [favicon.status, bare.status];
      await favicon.text();
      await bare.text();
    }
    const back = new URL(redirect);
    const sent = query.get('state') as string;
    back.searchParams.set('state', plan.state ? plan.state(sent) : sent);
    if (plan.error !== undefined) {
      back.searchParams.set('error', plan.error);
    } else {
      const requested = (query.get('scope') ?? '').split(' ');
      const code = fake.issueAuthorizationCode({
        redirectUri: redirect,
        codeChallenge: query.get('code_challenge') as string,
        scopes: requested,
        ...(plan.grant?.(requested) ?? {}),
      });
      visits.code = code;
      back.searchParams.set('code', code);
      back.searchParams.set('scope', requested.join(' '));
    }
    const reply = await fetch(back);
    visits.replyStatus = reply.status;
    visits.replyBody = await reply.text();
  };
  const openUrl = vi.fn(async (raw: string) => {
    await visit(raw);
    return true;
  });
  return { visits, visit, openUrl };
}

function rig(plan: BrowserPlan = {}, fakeOptions: FakeGoogleOptions = {}) {
  const fake = createFakeGoogle(fakeOptions);
  const browser = makeBrowser(fake, plan);
  const lines: string[] = [];
  const prompt = vi.fn(async (_question: string, _options: ConsentPromptOptions): Promise<string> => {
    throw new Error('no prompt expected in this test');
  });
  const deps: ConsentDeps = {
    inputs: envInputs(),
    prompt,
    openUrl: browser.openUrl,
    transport: fake.transport,
    out: (line) => lines.push(line),
    timeoutMs: 10_000,
  };
  const outFile = path.join(tempDir(), 'dex-google.env');
  return { fake, browser, lines, prompt, deps, outFile };
}

/** The verifier the helper sent with the code exchange (null when no exchange happened). */
function sentVerifier(fake: FakeGoogle): string | null {
  const call = fake.calls.find((item) => (item.body as Record<string, string> | null)?.grant_type === 'authorization_code');
  return call ? ((call.body as Record<string, string>).code_verifier ?? null) : null;
}

/** No line holds a refresh token, an access token, the code, the client secret or the verifier. */
function expectNoSecrets(lines: string[], fake: FakeGoogle, code?: string, extra: string[] = []): void {
  const text = lines.join('\n');
  const secrets = [FAKE_GOOGLE_REFRESH_TOKEN, FAKE_GOOGLE_CLIENT_SECRET, ...fake.tokensIssued, ...extra];
  if (code !== undefined) secrets.push(code);
  const verifier = sentVerifier(fake);
  if (verifier !== null) secrets.push(verifier);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

/** The listener is gone: a new request to the old redirect URI fails. */
async function expectListenerClosed(redirect: string | undefined): Promise<void> {
  expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await expect(fetch(`${redirect}/?code=late&state=late`)).rejects.toThrow();
}

const exchangeCalls = (fake: FakeGoogle) =>
  fake.calls.filter((call) => (call.body as Record<string, string> | null)?.grant_type === 'authorization_code');

// ── Happy path ──────────────────────────────────────────────────────────────

describe('m035-google-oauth-consent: the happy path', () => {
  it(
    'opens the consent URL with every parameter, exchanges the code with PKCE and writes ONE line',
    async () => {
      const { fake, browser, lines, prompt, deps, outFile } = rig();
      const code = await runConsent([`--out=${outFile}`], deps);
      expect(code).toBe(0);

      // The consent URL (it holds no secret).
      expect(browser.openUrl).toHaveBeenCalledTimes(1);
      const raw = browser.openUrl.mock.calls[0]![0] as string;
      expect(raw.startsWith(`${GOOGLE_OAUTH_AUTHORIZE_URL}?`)).toBe(true);
      const consent = browser.visits.consent!;
      const query = consent.searchParams;
      expect([...query.keys()].sort()).toEqual(
        [
          'access_type',
          'client_id',
          'code_challenge',
          'code_challenge_method',
          'login_hint',
          'prompt',
          'redirect_uri',
          'response_type',
          'scope',
          'state',
        ].sort(),
      );
      expect(query.get('client_id')).toBe(FAKE_GOOGLE_CLIENT_ID);
      expect(query.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
      expect(query.get('response_type')).toBe('code');
      expect(query.get('scope')).toBe(TWO_SCOPES.join(' '));
      expect(query.get('access_type')).toBe('offline');
      expect(query.get('prompt')).toBe('consent');
      expect(query.get('login_hint')).toBe(FAKE_GOOGLE_DEX_EMAIL);
      expect(query.get('code_challenge_method')).toBe('S256');
      expect(query.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(raw).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);

      // The browser got the fixed page, which echoes nothing.
      expect(browser.visits.replyStatus).toBe(200);
      expect(browser.visits.replyBody).toContain('Return to the terminal');
      expect(browser.visits.replyBody).not.toContain(browser.visits.code!);
      expect(browser.visits.replyBody).not.toContain(query.get('state')!);

      // Exactly one exchange: the authorization-code grant with the verifier of the challenge.
      expect(fake.calls).toHaveLength(1);
      const exchange = fake.calls[0]!;
      expect(exchange.method).toBe('POST');
      expect(exchange.url).toBe(GOOGLE_TOKEN_URL);
      expect(exchange.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const form = exchange.body as Record<string, string>;
      expect(Object.keys(form).sort()).toEqual(
        ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri'].sort(),
      );
      expect(form.grant_type).toBe('authorization_code');
      expect(form.code).toBe(browser.visits.code);
      expect(form.client_id).toBe(FAKE_GOOGLE_CLIENT_ID);
      expect(form.client_secret).toBe(FAKE_GOOGLE_CLIENT_SECRET);
      expect(form.redirect_uri).toBe(browser.visits.redirect);
      expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(query.get('code_challenge'));

      // The file: exactly one line, the refresh token the fake minted.
      expect(readFileSync(outFile, 'utf8')).toBe(`${CONSENT_ENV_NAME}=${FAKE_GOOGLE_REFRESH_TOKEN}\n`);
      if (process.platform !== 'win32') expect(statSync(outFile).mode & 0o777).toBe(0o600);

      // The output: the path and the next commands, never a secret; no URL (the browser opened).
      const text = lines.join('\n');
      expect(text).toContain(outFile);
      expect(text).toContain(`Get-Content -Raw '${outFile}' | fly secrets import -a ${CONSENT_FLY_APP}`);
      expect(text).toContain(`fly secrets import -a ${CONSENT_FLY_APP} < '${outFile}'`);
      expect(text).toContain(`Remove-Item '${outFile}'`);
      expect(text).not.toContain('accounts.google.com');
      expect(text).not.toMatch(/^FAIL/m);
      expectNoSecrets(lines, fake, browser.visits.code);
      expect(prompt).not.toHaveBeenCalled();

      await expectListenerClosed(browser.visits.redirect);
    },
    LISTENER_TEST_MS,
  );

  it(
    'ignores a favicon request and a bare GET / before the real redirect',
    async () => {
      const { browser, deps, outFile } = rig({ noise: true });
      expect(await runConsent([`--out=${outFile}`], deps)).toBe(0);
      expect(browser.visits.noise).toEqual([404, 400]);
      expect(existsSync(outFile)).toBe(true);
      await expectListenerClosed(browser.visits.redirect);
    },
    LISTENER_TEST_MS,
  );

  it(
    '--space asks for the three scopes, and so does R1_MEET_GOOGLE_MEET_MODE=space',
    async () => {
      const flag = rig();
      expect(await runConsent([`--out=${flag.outFile}`, '--space'], flag.deps)).toBe(0);
      expect(flag.browser.visits.consent!.searchParams.get('scope')).toBe(THREE_SCOPES.join(' '));
      await expectListenerClosed(flag.browser.visits.redirect);

      const env = rig();
      env.deps.inputs = envInputs({ R1_MEET_GOOGLE_MEET_MODE: 'space' });
      expect(await runConsent([`--out=${env.outFile}`], env.deps)).toBe(0);
      expect(env.browser.visits.consent!.searchParams.get('scope')).toBe(THREE_SCOPES.join(' '));
      expect(readFileSync(env.outFile, 'utf8')).toBe(`${CONSENT_ENV_NAME}=${FAKE_GOOGLE_REFRESH_TOKEN}\n`);
    },
    LISTENER_TEST_MS,
  );

  it(
    '--no-open prints the consent URL instead of opening a browser',
    async () => {
      const { fake, browser, deps, outFile } = rig();
      const lines: string[] = [];
      let visiting: Promise<void> | null = null;
      deps.out = (line) => {
        lines.push(line);
        if (line.startsWith(`${GOOGLE_OAUTH_AUTHORIZE_URL}?`)) visiting = browser.visit(line);
      };
      expect(await runConsent([`--out=${outFile}`, '--no-open'], deps)).toBe(0);
      await visiting;
      expect(browser.openUrl).not.toHaveBeenCalled();
      expect(lines.filter((line) => line.startsWith(GOOGLE_OAUTH_AUTHORIZE_URL))).toHaveLength(1);
      expect(existsSync(outFile)).toBe(true);
      expectNoSecrets(lines, fake, browser.visits.code);
      await expectListenerClosed(browser.visits.redirect);
    },
    LISTENER_TEST_MS,
  );

  it(
    'prints the consent URL when the browser could not be opened, and carries on',
    async () => {
      const { browser, deps, outFile } = rig();
      const lines: string[] = [];
      let visiting: Promise<void> | null = null;
      const openUrl = vi.fn(async () => false);
      deps.openUrl = openUrl;
      deps.out = (line) => {
        lines.push(line);
        if (line.startsWith(`${GOOGLE_OAUTH_AUTHORIZE_URL}?`)) visiting = browser.visit(line);
      };
      expect(await runConsent([`--out=${outFile}`], deps)).toBe(0);
      await visiting;
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(lines.some((line) => line.startsWith(GOOGLE_OAUTH_AUTHORIZE_URL))).toBe(true);
      expect(existsSync(outFile)).toBe(true);
      await expectListenerClosed(browser.visits.redirect);
    },
    LISTENER_TEST_MS,
  );

  it('--help prints the usage and exits 0 without doing anything', async () => {
    const { fake, browser, lines, prompt, deps, outFile } = rig();
    expect(await runConsent(['--help'], deps)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: /);
    expect(browser.openUrl).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(outFile)).toBe(false);
  });
});

// ── --out refusals: exit 2 before any prompt, listener or network ───────────

describe('m035-google-oauth-consent: --out is refused before anything else happens', () => {
  async function expectRefused(argv: string[], deps: ConsentDeps, expected: string): Promise<string[]> {
    const lines: string[] = [];
    const openUrl = vi.fn(async () => true);
    const prompt = vi.fn(async () => '');
    const fake = createFakeGoogle();
    const code = await runConsent(argv, { ...deps, openUrl, prompt, transport: fake.transport, out: (line) => lines.push(line) });
    expect(code).toBe(2);
    expect(lines).toEqual([expected]);
    expect(openUrl).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    return lines;
  }

  it('a file inside this repository (a git working tree) is refused', async () => {
    const inside = path.join(API_ROOT, `m035-consent-${randomBytes(6).toString('hex')}.env`);
    await expectRefused([`--out=${inside}`], { inputs: envInputs() }, 'FAIL out_inside_git');
    expect(existsSync(inside)).toBe(false);
    // Deeper inside too, and through a relative path.
    const deeper = path.join(API_ROOT, 'src', '__tests__', `m035-consent-${randomBytes(6).toString('hex')}.env`);
    await expectRefused([`--out=${deeper}`], { inputs: envInputs() }, 'FAIL out_inside_git');
    expect(existsSync(deeper)).toBe(false);
    const relative = path.relative(process.cwd(), inside);
    await expectRefused([`--out=${relative}`], { inputs: envInputs() }, 'FAIL out_inside_git');
    expect(existsSync(inside)).toBe(false);
  });

  it('a file anywhere under a folder holding a .git folder is refused', async () => {
    const checkout = path.join(tempDir(), 'checkout');
    mkdirSync(path.join(checkout, '.git'), { recursive: true });
    mkdirSync(path.join(checkout, 'deep', 'er'), { recursive: true });
    const target = path.join(checkout, 'deep', 'er', 'dex-google.env');
    await expectRefused([`--out=${target}`], { inputs: envInputs(), repoRoot: null }, 'FAIL out_inside_git');
    expect(existsSync(target)).toBe(false);
  });

  it('a file under a folder holding a .git FILE (a git worktree) is refused', async () => {
    const worktree = path.join(tempDir(), 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
    const target = path.join(worktree, 'dex-google.env');
    await expectRefused([`--out=${target}`], { inputs: envInputs(), repoRoot: null }, 'FAIL out_inside_git');
    expect(existsSync(target)).toBe(false);
  });

  it("a file inside the script's repository root is refused even without a .git there", async () => {
    const repo = path.join(tempDir(), 'repo');
    mkdirSync(path.join(repo, 'sub'), { recursive: true });
    await expectRefused([`--out=${path.join(repo, 'dex-google.env')}`], { inputs: envInputs(), repoRoot: repo }, 'FAIL out_inside_repo');
    await expectRefused(
      [`--out=${path.join(repo, 'sub', 'dex-google.env')}`],
      { inputs: envInputs(), repoRoot: repo },
      'FAIL out_inside_repo',
    );
    expect(existsSync(path.join(repo, 'dex-google.env'))).toBe(false);
  });

  it('an existing file is refused and left untouched', async () => {
    const target = path.join(tempDir(), 'dex-google.env');
    writeFileSync(target, 'keep me\n');
    await expectRefused([`--out=${target}`], { inputs: envInputs() }, 'FAIL out_exists');
    expect(readFileSync(target, 'utf8')).toBe('keep me\n');
    // A folder at that path is refused the same way.
    const folder = path.join(tempDir(), 'a-folder');
    mkdirSync(folder);
    await expectRefused([`--out=${folder}`], { inputs: envInputs() }, 'FAIL out_exists');
  });

  it('a missing parent folder is refused', async () => {
    const target = path.join(tempDir(), 'missing', 'dex-google.env');
    await expectRefused([`--out=${target}`], { inputs: envInputs() }, 'FAIL out_parent_missing');
    expect(existsSync(path.dirname(target))).toBe(false);
  });

  it.each([
    [[] as string[]],
    [['--out=']],
    [['--out']],
    [['--space']],
    [['--out=x.env', '--bogus']],
    [['--out=x.env', '--space', '--space']],
    [['--out=x.env', '--timeout-sec=29']],
    [['--out=x.env', '--timeout-sec=901']],
    [['--out=x.env', '--timeout-sec=abc']],
    [['--out=x.env', '--no-open=yes']],
  ])('arguments %j print the usage and exit 2', async (argv) => {
    const lines: string[] = [];
    const openUrl = vi.fn(async () => true);
    const prompt = vi.fn(async () => '');
    const fake = createFakeGoogle();
    const code = await runConsent(argv, {
      inputs: envInputs(),
      openUrl,
      prompt,
      transport: fake.transport,
      out: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: /);
    expect(openUrl).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });
});

// ── Failures: exit 1, nothing written, the listener closed ──────────────────

describe('m035-google-oauth-consent: failures write nothing', () => {
  async function expectFailure(
    plan: BrowserPlan,
    expected: string,
    tweak: (deps: ConsentDeps, fake: FakeGoogle) => void = () => {},
    argv: string[] = [],
  ) {
    const r = rig(plan);
    tweak(r.deps, r.fake);
    const code = await runConsent([`--out=${r.outFile}`, ...argv], r.deps);
    expect(code).toBe(1);
    expect(r.lines.filter((line) => line.startsWith('FAIL'))).toEqual([expected]);
    expect(existsSync(r.outFile)).toBe(false);
    expect(r.lines.join('\n')).not.toContain(CONSENT_ENV_NAME);
    expectNoSecrets(r.lines, r.fake, r.browser.visits.code);
    await expectListenerClosed(r.browser.visits.redirect);
    return r;
  }

  it(
    'a state that does not match (same length or not) is refused before any exchange',
    async () => {
      const flipped = await expectFailure(
        { state: (sent) => (sent[0] === 'A' ? 'B' : 'A') + sent.slice(1) },
        'FAIL state_mismatch',
      );
      expect(exchangeCalls(flipped.fake)).toHaveLength(0);
      const longer = await expectFailure({ state: (sent) => `${sent}x` }, 'FAIL state_mismatch');
      expect(exchangeCalls(longer.fake)).toHaveLength(0);
    },
    LISTENER_TEST_MS * 2,
  );

  it(
    'error=access_denied is consent_access_denied; any other error is consent_error',
    async () => {
      const denied = await expectFailure({ error: 'access_denied' }, 'FAIL consent_access_denied');
      expect(denied.fake.calls).toHaveLength(0);
      expect(denied.browser.visits.replyStatus).toBe(200);
      expect(denied.browser.visits.replyBody).toContain('not completed');
      expect(denied.browser.visits.replyBody).not.toContain('access_denied');
      const other = await expectFailure({ error: 'server_error' }, 'FAIL consent_error');
      expect(other.fake.calls).toHaveLength(0);
    },
    LISTENER_TEST_MS * 2,
  );

  it(
    'a client the token endpoint does not know is exchange_setup_forbidden (invalid_client)',
    async () => {
      const r = await expectFailure({}, 'FAIL exchange_setup_forbidden', (deps) => {
        deps.inputs = envInputs({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'cs-' + 't'.repeat(32) });
      });
      expect(exchangeCalls(r.fake)).toHaveLength(1);
      expect(r.lines.join('\n')).not.toContain('cs-' + 't'.repeat(32));
    },
    LISTENER_TEST_MS,
  );

  it(
    'other token-endpoint answers map to exchange_<code>',
    async () => {
      await expectFailure({}, 'FAIL exchange_unavailable', (_deps, fake) => fake.failNext({ status: 503, body: 'down' }));
      await expectFailure({}, 'FAIL exchange_auth_revoked', (_deps, fake) =>
        fake.failNext({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad code.' } }),
      );
      await expectFailure({}, 'FAIL exchange_malformed_response', (_deps, fake) =>
        fake.failNext({ status: 200, body: 'not json' }),
      );
    },
    LISTENER_TEST_MS * 3,
  );

  it(
    'an answer without a refresh token is no_refresh_token',
    async () => {
      await expectFailure({ grant: () => ({ withoutRefreshToken: true }) }, 'FAIL no_refresh_token');
    },
    LISTENER_TEST_MS,
  );

  it(
    'a scope the user did not grant is scope_missing <short name>',
    async () => {
      await expectFailure(
        { grant: () => ({ scopes: [GOOGLE_SCOPES.calendarEventsOwned] }) },
        'FAIL scope_missing meetings.space.settings',
      );
      await expectFailure(
        { grant: () => ({ scopes: TWO_SCOPES }) },
        'FAIL scope_missing meetings.space.created',
        () => {},
        ['--space'],
      );
    },
    LISTENER_TEST_MS * 2,
  );

  it(
    'no redirect within the timeout is FAIL timeout, and the listener is closed',
    async () => {
      const r = await expectFailure({ never: true }, 'FAIL timeout', (deps) => {
        deps.timeoutMs = 200;
      });
      expect(r.fake.calls).toHaveLength(0);
      expect(r.browser.openUrl).toHaveBeenCalledTimes(1);
    },
    LISTENER_TEST_MS,
  );

  it(
    'an opener that never returns still times out',
    async () => {
      const r = rig();
      let redirect: string | undefined;
      r.deps.timeoutMs = 200;
      r.deps.openUrl = (url) => {
        redirect = new URL(url).searchParams.get('redirect_uri') ?? undefined;
        return new Promise<boolean>(() => {});
      };
      expect(await runConsent([`--out=${r.outFile}`], r.deps)).toBe(1);
      expect(r.lines).toEqual(['FAIL timeout']);
      expect(existsSync(r.outFile)).toBe(false);
      await expectListenerClosed(redirect);
    },
    LISTENER_TEST_MS,
  );

  it(
    'a second callback after the first is answered and ignored',
    async () => {
      const r = rig();
      let second: number | undefined;
      const inner = r.browser.openUrl.getMockImplementation()!;
      r.deps.openUrl = async (url) => {
        await inner(url);
        const again = await fetch(`${r.browser.visits.redirect}/?code=again&state=again`).catch(() => null);
        second = again?.status;
        await again?.text();
        return true;
      };
      expect(await runConsent([`--out=${r.outFile}`], r.deps)).toBe(0);
      expect(second).toBe(409);
      expect(exchangeCalls(r.fake)).toHaveLength(1);
      await expectListenerClosed(r.browser.visits.redirect);
    },
    LISTENER_TEST_MS,
  );
});

// ── Prompts ─────────────────────────────────────────────────────────────────

describe('m035-google-oauth-consent: prompts for what the environment does not give', () => {
  it(
    'asks for the client id, the secret (hidden) and the Dex email, and validates them like the API',
    async () => {
      const r = rig();
      r.deps.inputs = NO_INPUTS();
      const answers = [`  ${FAKE_GOOGLE_CLIENT_ID}  `, FAKE_GOOGLE_CLIENT_SECRET, FAKE_GOOGLE_DEX_EMAIL.toUpperCase()];
      const prompt = vi.fn(async (_question: string, _options: ConsentPromptOptions) => answers.shift() ?? '');
      r.deps.prompt = prompt;
      expect(await runConsent([`--out=${r.outFile}`], r.deps)).toBe(0);
      expect(prompt).toHaveBeenCalledTimes(3);
      expect(prompt.mock.calls.map((call) => call[1])).toEqual([{ hidden: false }, { hidden: true }, { hidden: false }]);
      for (const [question] of prompt.mock.calls) expect(question).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
      expect(r.browser.visits.consent!.searchParams.get('client_id')).toBe(FAKE_GOOGLE_CLIENT_ID);
      expect(r.browser.visits.consent!.searchParams.get('login_hint')).toBe(FAKE_GOOGLE_DEX_EMAIL);
      expect(readFileSync(r.outFile, 'utf8')).toBe(`${CONSENT_ENV_NAME}=${FAKE_GOOGLE_REFRESH_TOKEN}\n`);
      expectNoSecrets(r.lines, r.fake, r.browser.visits.code);
      await expectListenerClosed(r.browser.visits.redirect);
    },
    LISTENER_TEST_MS,
  );

  it('a placeholder secret in the environment is prompted for, hidden', async () => {
    const r = rig();
    r.deps.inputs = envInputs({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'replace_me' });
    const prompt = vi.fn(async (_question: string, _options: ConsentPromptOptions) => 'bad secret with spaces');
    r.deps.prompt = prompt;
    expect(await runConsent([`--out=${r.outFile}`], r.deps)).toBe(2);
    expect(r.lines).toEqual(['FAIL invalid_client_secret']);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![1]).toEqual({ hidden: true });
    expect(r.browser.openUrl).not.toHaveBeenCalled();
    expect(r.fake.calls).toHaveLength(0);
    expect(existsSync(r.outFile)).toBe(false);
  });

  it.each([
    ['client id', { R1_MEET_GOOGLE_OAUTH_CLIENT_ID: undefined }, 'not-a-client-id', 'FAIL invalid_client_id'],
    ['client secret', { R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: undefined }, '', 'FAIL invalid_client_secret'],
    ['Dex email', { R1_MEET_GOOGLE_DEX_EMAIL: undefined }, 'dex at hello', 'FAIL invalid_dex_email'],
  ])('an invalid typed %s exits 2 before any listener or network', async (_name, unset, typed, expected) => {
    const r = rig();
    r.deps.inputs = envInputs(unset);
    const prompt = vi.fn(async () => typed);
    r.deps.prompt = prompt;
    expect(await runConsent([`--out=${r.outFile}`], r.deps)).toBe(2);
    expect(r.lines).toEqual([expected]);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(r.browser.openUrl).not.toHaveBeenCalled();
    expect(r.fake.calls).toHaveLength(0);
    expect(existsSync(r.outFile)).toBe(false);
  });

  it('a prompt that fails counts as an empty answer', async () => {
    const r = rig();
    r.deps.inputs = NO_INPUTS();
    r.deps.prompt = vi.fn(async () => {
      throw new Error('stdin closed');
    });
    expect(await runConsent([`--out=${r.outFile}`], r.deps)).toBe(2);
    expect(r.lines).toEqual(['FAIL invalid_client_id']);
  });

  it(
    '--dex-email overrides the environment (lower-cased) and is validated the same way',
    async () => {
      const r = rig();
      expect(await runConsent([`--out=${r.outFile}`, '--dex-email=Other.Dex@Hello.Example.Test'], r.deps)).toBe(0);
      expect(r.browser.visits.consent!.searchParams.get('login_hint')).toBe('other.dex@hello.example.test');
      await expectListenerClosed(r.browser.visits.redirect);

      const bad = rig();
      expect(await runConsent([`--out=${bad.outFile}`, '--dex-email=nobody'], bad.deps)).toBe(2);
      expect(bad.lines).toEqual(['FAIL invalid_dex_email']);
      expect(bad.prompt).not.toHaveBeenCalled();
      expect(bad.browser.openUrl).not.toHaveBeenCalled();
    },
    LISTENER_TEST_MS,
  );
});

// ── Static pins on the script ───────────────────────────────────────────────

describe('m035-google-oauth-consent: what the script may do', () => {
  const source = readFileSync(SCRIPT, 'utf8');

  it('reads the environment only through the API config reader', () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).toContain("from '../src/lib/r1/meet/config.js'");
  });

  it('opens the browser with spawn and no shell, and never prints an error message', () => {
    expect(source).toContain("spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false })");
    expect(source).toContain("['rundll32', ['url.dll,FileProtocolHandler', url]]");
    expect(source).not.toMatch(/\.message\b/);
    expect(source).not.toMatch(/\bconsole\.(?:log|error)\([^)]*(?:error|err)\b/);
  });

  it('defaults to a five-minute wait', () => {
    expect(CONSENT_DEFAULT_TIMEOUT_MS).toBe(300_000);
  });

  it('writes the refresh-token variable the API reads, which is a public-booking secret', () => {
    expect(R1_MEET_PUBLIC_SECRET_VARIABLES).toContain(CONSENT_ENV_NAME);
    expect(CONSENT_ENV_NAME.endsWith('_REFRESH_TOKEN')).toBe(true);
  });
});
