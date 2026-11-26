/**
 * M034 S01: the R1-over-Google-Meet modules ship as DARK libraries.
 *
 * S01 shipped libraries only. S03 wires the Recall receivers and the Ashby schedule routing, S05 the
 * Meet bridge exchange in the candidate router and the HR read of the Meet bookings
 * (routes/r1-meet-bookings.ts), and nothing else: exactly the importers and imports in
 * `WIRED_IMPORTS`. S06 (runtime) must narrow this pin again in the same PR that wires it.
 * S06 wired the runtime: lib/r1/runtime.ts hosts the `r1-meet` lane, the maintenance tick and the
 * drain backstop (built only when R1 and Meet are on, or, for the drain, when the Meet flag is
 * deliberately off and a Recall key is set), and routes/r1.ts queues the bot's leave after a settled
 * attempt (it reads nothing while Meet is off: r1-attempt-outcome.test.ts).
 * S09 adds one import to lib/r1/runtime.ts: the scorecard-ready hook (meet/feedback-notify.ts), the
 * assessment handler's `onResult`, which queues Dex's Ashby feedback for a Meet round and reads
 * nothing while Meet is off or the feedback form setting is blank (r1-meet-feedback-notify.test.ts,
 * r1-runtime.test.ts).
 * M035 S03 adds the owner-run Google scripts under app/api/scripts (local, never in CI or the API
 * process), each pinned in `WIRED_IMPORTS` with its exact targets rather than exempted by folder.
 *
 * What "dark" means here (S01 plan R21, R30, R31; S03 plan R16; S05 plan D-S05-18; D-M034-11):
 *  (a) no runtime file outside the four Meet folders (integrations/recall, integrations/google-meet,
 *      integrations/google since M035 S03, lib/r1/meet) imports a module inside them, except each
 *      `WIRED_IMPORTS` importer, whose Meet imports must EQUAL its list (so the allowlist can neither
 *      go stale nor widen silently).
 *      Static, side-effect, re-export, dynamic `import()` and `require()` specifiers are resolved
 *      relative to the importing file; type-only imports count too. A second check refuses any Meet
 *      module path written as text (a computed specifier would otherwise slip past the resolver),
 *      outside the wired importers, app.ts (the Recall mount string and the bridge route of its
 *      per-ticket limiter) and lib/auth.ts (the bridge route's public entry); neither of those two
 *      imports a Meet module, which a control proves. The routes stay dark behind R1_MEET_ENABLED:
 *      the exchange answers 503 meet_disabled before anything is read (r1-meet-exchange.test.ts), and
 *      the bookings read answers an empty page and reads nothing (r1-meet-bookings-route.test.ts).
 *  (b) no runtime file imports the test tree (`__tests__`, which holds the Meet fakes, the Ashby
 *      schedule fixture and the Svix test signer in `__tests__/support`).
 *  (c) no fly*.toml under app/ names a Meet variable: the flag defaults OFF and the two Recall
 *      credentials are Fly secrets on the API only.
 *  (d) the retired booking vendor of the first plan is gone from the API source and the env contract
 *      (its name is built from two halves below so this file never contains it).
 *  (e) no Recall Calendar V2 and no Recall PATCH: S06 deletes a scheduled bot and creates a new one.
 *      M035 S03: the Google Calendar/Meet client in integrations/google uses PATCH on purpose
 *      (events.patch, and spaces.patch with a narrow updateMask), so it is exempt from the PATCH ban
 *      and pinned to the exact set of its files that write the verb; the Recall rule stays, and the
 *      Calendar V2 ban covers every Meet folder, google included.
 *  (f) loading every Meet module performs no network call, and an empty environment is `disabled`.
 *
 * Each walker has a control that feeds it a synthetic violation, so the pin cannot pass by matching
 * nothing. Comments are NOT stripped before scanning: a false positive fails loudly and is fixed by
 * rewording, while a false negative would pass silently.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Type-only: erased at runtime, so this file loads no Meet module before the fetch spy in (f).
import type { RecallTransportRequest } from '../integrations/recall/client.js';

const SRC = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const API_ROOT = path.dirname(SRC);
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'app');
const TESTS_DIR = path.join(SRC, '__tests__');

const MEET_DIRS = [
  path.join(SRC, 'integrations', 'recall'),
  path.join(SRC, 'integrations', 'google-meet'),
  // M035 S03: the Google Calendar and Meet client for Dex (public booking link).
  path.join(SRC, 'integrations', 'google'),
  path.join(SRC, 'lib', 'r1', 'meet'),
] as const;
const MEET_CONFIG = path.join(SRC, 'lib', 'r1', 'meet', 'config.ts');
const RECALL_CLIENT = path.join(SRC, 'integrations', 'recall', 'client.ts');
/** M035 S03: the one Meet folder that may write the PATCH verb (events.patch, spaces.patch). */
const GOOGLE_DIR = path.join(SRC, 'integrations', 'google');
/** The Meet test doubles: test-only, but they must not drift toward Calendar V2 either. */
const MEET_SUPPORT_FILES = ['recall-fake.ts', 'meet-webhook-signing.ts', 'ashby-schedule-fixture.ts'].map(
  (name) => path.join(TESTS_DIR, 'support', name),
);
/** The Google double (M035 S03): it answers PATCH like Google, so only the Calendar V2 ban applies. */
const GOOGLE_SUPPORT_FILES = ['google-fake.ts'].map((name) => path.join(TESTS_DIR, 'support', name));

/**
 * The thirty-five Meet variables (config/environment.schema.json, api), in `R1_MEET_ENV_VARIABLES`
 * order: the twelve M034 ones, then the twenty-three M035 public booking ones.
 */
const MEET_ENV_NAMES = [
  'R1_MEET_ENABLED',
  'R1_MEET_BOT_NAME',
  'R1_MEET_DAILY_BOT_CAP',
  'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
  'R1_MEET_SERVICE_USER_ID',
  'RECALL_BASE_URL',
  'R1_MEET_ARM_AT_CREATE',
  'R1_MEET_MULTI_HUMAN_POLICY',
  'R1_MEET_ASHBY_DEX_USER_ID',
  'R1_MEET_ASHBY_FEEDBACK_FORM_ID',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
  // M035 public booking link (S03), in R1_MEET_PUBLIC_ENV_VARIABLES order.
  'R1_MEET_PUBLIC_BOOKING_ENABLED',
  'R1_MEET_GOOGLE_AUTH_MODE', // oauth_refresh (default) or service_account
  'R1_MEET_GOOGLE_OAUTH_CLIENT_ID', // oauth_refresh mode
  'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', // oauth_refresh mode, a Fly secret
  'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', // oauth_refresh mode, a Fly secret
  'R1_MEET_GOOGLE_SA_KEY_B64', // service_account mode, a Fly secret
  'R1_MEET_GOOGLE_DEX_EMAIL',
  'R1_MEET_GOOGLE_MEET_MODE',
  'R1_MEET_PUBLIC_SLOT_MINUTES',
  'R1_MEET_PUBLIC_SLOT_STEP_MINUTES',
  'R1_MEET_PUBLIC_HOURS_IST',
  'R1_MEET_PUBLIC_DAYS',
  'R1_MEET_PUBLIC_CLOSED_DATES',
  'R1_MEET_PUBLIC_MIN_NOTICE_MINUTES',
  'R1_MEET_PUBLIC_HORIZON_DAYS',
  'R1_MEET_PUBLIC_SLOT_CAPACITY',
  'R1_MEET_PUBLIC_BROWSER_HEADROOM',
  'R1_MEET_PUBLIC_DAILY_CAP',
  'R1_MEET_PUBLIC_MAX_MOVES',
  'R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES',
  'R1_MEET_PUBLIC_REQUIRE_R1_STAGE',
  'R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS',
  'R1_MEET_PUBLIC_PRESLOT_RECHECK',
] as const;

/** D-M034-11 retired this booking vendor; built from halves so this file never names it. */
const RETIRED_BOOKING_VENDOR = 'calen' + 'dly';

const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
const inside = (file: string, directory: string): boolean =>
  file === directory || file.startsWith(directory + path.sep);
const inMeet = (file: string): boolean => MEET_DIRS.some((directory) => inside(file, directory));

function walk(directory: string, skipDirectory: (name: string) => boolean = () => false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) return skipDirectory(entry.name) ? [] : walk(item, skipDirectory);
    return entry.isFile() ? [item] : [];
  });
}

const CODE_FILE = /\.(?:[cm]?ts|[cm]?js)$/;
const TEST_FILE = /\.test\.[cm]?[jt]s$/;

/** Every file the API process can load: src and the API scripts, minus the test tree. */
const RUNTIME_FILES = [SRC, path.join(API_ROOT, 'scripts')]
  .flatMap((root) => walk(root))
  .filter((file) => CODE_FILE.test(file) && !TEST_FILE.test(file) && !inside(file, TESTS_DIR));
const OUTSIDE_FILES = RUNTIME_FILES.filter((file) => !inMeet(file));

/** Every module specifier written in `source`, in pattern order. */
function specifiers(source: string): string[] {
  const patterns = [
    // import … from '…', import type … from '…', export … from '…'
    /\bfrom\s*['"]([^'"\r\n]+)['"]/g,
    // Side-effect import: no `from` clause, still loads the module.
    /^[ \t]*import\s*['"]([^'"\r\n]+)['"]/gm,
    // Dynamic import, with or without an options argument.
    /\bimport\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*[,)]/g,
    // require('…') and require.resolve('…').
    /\brequire(?:\s*\.\s*resolve)?\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] as string));
}

/** The absolute targets of the relative specifiers in `source`, resolved against `importer`. */
function relativeTargets(importer: string, source: string): string[] {
  return specifiers(source)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.resolve(path.dirname(importer), specifier));
}

const meetImports = (importer: string, source: string): string[] =>
  relativeTargets(importer, source).filter(inMeet);

/**
 * S03 plan R16 and S05 plan D-S05-18: the runtime files outside the Meet folders that may import Meet
 * modules, each with the EXACT repo-relative resolved targets of its Meet imports (type-only imports
 * included).
 */
const WIRED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'app/api/src/routes/ashby-webhook.ts': [
    'app/api/src/lib/r1/meet/ashby-schedule-jobs.js',
    'app/api/src/lib/r1/meet/ashby-schedule.js',
    'app/api/src/lib/r1/meet/config.js',
    'app/api/src/lib/r1/meet/receipts.js',
  ],
  'app/api/src/routes/r1-candidate.ts': [
    'app/api/src/lib/r1/meet/bridge-store.js',
    'app/api/src/lib/r1/meet/config.js',
    'app/api/src/lib/r1/meet/profiles.js',
    'app/api/src/lib/r1/meet/resume-token.js',
    'app/api/src/lib/r1/meet/ticket.js',
  ],
  'app/api/src/routes/r1-meet-bookings.ts': [
    'app/api/src/lib/r1/meet/bookings-read.js',
    'app/api/src/lib/r1/meet/config.js',
  ],
  'app/api/src/routes/recall-webhook.ts': [
    'app/api/src/integrations/recall/webhook-verify.js',
    'app/api/src/lib/r1/meet/config.js',
    'app/api/src/lib/r1/meet/receipts.js',
    'app/api/src/lib/r1/meet/recall-event.js',
  ],
  // M034 S06: the runtime host (the lane, the sweep tick) and the attempt-outcome hook.
  'app/api/src/lib/r1/runtime.ts': [
    'app/api/src/lib/r1/meet/config.js',
    // M034 S09: the scorecard-ready hook
    'app/api/src/lib/r1/meet/feedback-notify.js',
    'app/api/src/lib/r1/meet/runtime.js',
  ],
  'app/api/src/routes/r1.ts': [
    'app/api/src/lib/r1/meet/attempt-ended.js',
  ],
  // M035 S03: the owner-run OAuth consent helper (local, never in CI or the API process).
  'app/api/scripts/m035-google-oauth-consent.ts': [
    'app/api/src/integrations/google/errors.js',
    'app/api/src/integrations/google/http.js',
    'app/api/src/integrations/google/token.js',
    'app/api/src/lib/r1/meet/config.js',
  ],
  // M035 S03: the owner-run Google spike for Dex's meetings (local, never in CI or the API process).
  'app/api/scripts/m035-google-spike.ts': [
    'app/api/src/integrations/google/client.js',
    'app/api/src/integrations/google/errors.js',
    'app/api/src/lib/r1/meet/config.js',
  ],
};
const AUTH_FILE = path.join(SRC, 'lib', 'auth.ts');
const APP_FILE = path.join(SRC, 'app.ts');
/** The Recall router's mount string (app.ts). */
const RECALL_MOUNT_LITERAL = "'/api/integrations/recall'";
/** The bridge exchange's public route (lib/auth.ts, and app.ts for its per-ticket limiter). */
const BRIDGE_ROUTE_LITERAL = "'/api/r1/meet/exchange'";
/** Files that may write a Meet path as text but import no Meet module, with exactly what they may write. */
const ROUTE_TEXT_ONLY: ReadonlyArray<{ file: string; literals: readonly string[] }> = [
  { file: AUTH_FILE, literals: [BRIDGE_ROUTE_LITERAL] },
  { file: APP_FILE, literals: [RECALL_MOUNT_LITERAL, BRIDGE_ROUTE_LITERAL] },
];
/** Files allowed to write a Meet module path as text: the wired importers, plus the text-only ones. */
const PATH_TEXT_ALLOWED: ReadonlySet<string> = new Set([
  ...Object.keys(WIRED_IMPORTS),
  ...ROUTE_TEXT_ONLY.map(({ file }) => rel(file)),
]);

/** The sorted, de-duplicated repo-relative Meet import targets of `importer`. */
const actualMeetImports = (importer: string, source: string): string[] =>
  [...new Set(meetImports(importer, source).map(rel))].sort();

/** `importer -> target` for every Meet import that its `WIRED_IMPORTS` entry (if any) does not list. */
function unwiredMeetImports(importer: string, source: string): string[] {
  const allowed = new Set(WIRED_IMPORTS[rel(importer)] ?? []);
  return meetImports(importer, source)
    .map(rel)
    .filter((target) => !allowed.has(target))
    .map((target) => `${rel(importer)} -> ${target}`);
}
const testTreeImports = (importer: string, source: string): string[] =>
  relativeTargets(importer, source).filter((target) => inside(target, TESTS_DIR));

/**
 * A Meet module path written as text: `integrations/recall`, `integrations/google-meet`,
 * `integrations/google` (M035 S03), `r1/meet` (not `r1/meeting`), or a relative `./meet/` hop from
 * inside lib/r1.
 */
const MEET_PATH_TEXT = new RegExp(
  [
    String.raw`integrations\/(?:recall|google-meet|google)(?![\w-])`,
    String.raw`\br1\/meet(?![\w-])`,
    String.raw`['"\x60](?:\.{1,2}\/)+meet(?:\/|['"\x60])`,
  ].join('|'),
);

const read = (file: string): string => readFileSync(file, 'utf8');

describe('M034 S01: the Meet modules are dark libraries', () => {
  it('finds the runtime tree and the Meet modules', () => {
    expect(RUNTIME_FILES.length).toBeGreaterThan(100);
    for (const directory of MEET_DIRS) {
      expect(RUNTIME_FILES.some((file) => inside(file, directory)), rel(directory)).toBe(true);
    }
    expect(RUNTIME_FILES).toContain(MEET_CONFIG);
    expect(RUNTIME_FILES).toContain(RECALL_CLIENT);
    expect(OUTSIDE_FILES).not.toContain(MEET_CONFIG);
    expect(RUNTIME_FILES.some((file) => inside(file, TESTS_DIR))).toBe(false);
  });

  it('(a) no runtime file outside the Meet folders imports a Meet module, except the wired importers', () => {
    const offenders = OUTSIDE_FILES.flatMap((file) => unwiredMeetImports(file, read(file)));
    expect(offenders).toEqual([]);
  });

  it('(a) each wired importer imports EXACTLY its listed Meet modules (no stale or silent widening)', () => {
    const wired = Object.keys(WIRED_IMPORTS).sort();
    expect(wired).toEqual([
      'app/api/scripts/m035-google-oauth-consent.ts',
      'app/api/scripts/m035-google-spike.ts',
      'app/api/src/lib/r1/runtime.ts',
      'app/api/src/routes/ashby-webhook.ts',
      'app/api/src/routes/r1-candidate.ts',
      'app/api/src/routes/r1-meet-bookings.ts',
      'app/api/src/routes/r1.ts',
      'app/api/src/routes/recall-webhook.ts',
    ]);
    for (const key of wired) {
      const file = path.join(REPO_ROOT, ...key.split('/'));
      expect(OUTSIDE_FILES, key).toContain(file);
      expect(actualMeetImports(file, read(file)), key).toEqual([...WIRED_IMPORTS[key]!].sort());
    }
  });

  it('(a) no runtime file outside the Meet folders names a Meet module path (computed specifiers)', () => {
    const offenders = OUTSIDE_FILES.filter((file) => !PATH_TEXT_ALLOWED.has(rel(file)) && MEET_PATH_TEXT.test(read(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('(a) control: lib/auth.ts and app.ts import no Meet module and name a Meet path only in their route literals', () => {
    for (const { file, literals } of ROUTE_TEXT_ONLY) {
      const text = read(file);
      expect(OUTSIDE_FILES, rel(file)).toContain(file);
      expect(meetImports(file, text), rel(file)).toEqual([]);
      // Each literal is there, and each one alone is what the text scan would catch.
      for (const literal of literals) {
        expect(text, rel(file)).toContain(literal);
        expect(MEET_PATH_TEXT.test(literal), literal).toBe(true);
      }
      const stripped = literals.reduce((left, literal) => left.split(literal).join(''), text);
      expect(MEET_PATH_TEXT.test(stripped), rel(file)).toBe(false);
    }
    // lib/auth.ts never names the Recall mount: the receivers are mounted ahead of authentication.
    expect(read(AUTH_FILE)).not.toContain(RECALL_MOUNT_LITERAL);
  });

  it('(a) control: a wired importer that widens its Meet imports, or any other importer, is caught', () => {
    const recallRoute = path.join(SRC, 'routes', 'recall-webhook.ts');
    const widened = [
      "import { verifyRecallWebhook } from '../integrations/recall/webhook-verify.js';",
      "import { buildR1MeetRecallBotCreate } from '../lib/r1/meet/recall-bot.js';",
    ].join('\n');
    expect(unwiredMeetImports(recallRoute, widened)).toEqual([
      'app/api/src/routes/recall-webhook.ts -> app/api/src/lib/r1/meet/recall-bot.js',
    ]);
    expect(actualMeetImports(recallRoute, widened)).not.toEqual(
      [...WIRED_IMPORTS['app/api/src/routes/recall-webhook.ts']!].sort(),
    );
    const other = path.join(SRC, 'routes', 'example-importer.ts');
    expect(unwiredMeetImports(other, "import { getR1MeetConfig } from '../lib/r1/meet/config.js';")).toEqual([
      'app/api/src/routes/example-importer.ts -> app/api/src/lib/r1/meet/config.js',
    ]);
    // M034 S05: the candidate router and the bookings route are held to their own lists.
    const router = path.join(SRC, 'routes', 'r1-candidate.ts');
    expect(unwiredMeetImports(router, widened)).toEqual([
      'app/api/src/routes/r1-candidate.ts -> app/api/src/integrations/recall/webhook-verify.js',
      'app/api/src/routes/r1-candidate.ts -> app/api/src/lib/r1/meet/recall-bot.js',
    ]);
    expect(actualMeetImports(router, widened)).not.toEqual(
      [...WIRED_IMPORTS['app/api/src/routes/r1-candidate.ts']!].sort(),
    );
    const bookingsRoute = path.join(SRC, 'routes', 'r1-meet-bookings.ts');
    expect(unwiredMeetImports(bookingsRoute, "import { peekR1MeetTicket } from '../lib/r1/meet/bridge-store.js';")).toEqual([
      'app/api/src/routes/r1-meet-bookings.ts -> app/api/src/lib/r1/meet/bridge-store.js',
    ]);
    // lib/auth.ts and app.ts may write their route strings, never import a Meet module.
    expect(unwiredMeetImports(AUTH_FILE, "import { getR1MeetConfig } from './r1/meet/config.js';")).toEqual([
      'app/api/src/lib/auth.ts -> app/api/src/lib/r1/meet/config.js',
    ]);
    expect(unwiredMeetImports(APP_FILE, "import { getR1MeetConfig } from './lib/r1/meet/config.js';")).toEqual([
      'app/api/src/app.ts -> app/api/src/lib/r1/meet/config.js',
    ]);
  });

  it('(a) control: every specifier form is caught and resolved relative to the importer', () => {
    const importer = path.join(SRC, 'routes', 'example-importer.ts');
    const source = [
      "import { getR1MeetConfig } from '../lib/r1/meet/config.js';",
      "import type { RecallBot } from '../integrations/recall/types.js';",
      "export { normalizeGoogleMeetUrl } from '../integrations/google-meet/url.js';",
      "import '../lib/r1/meet/profiles.js';",
      "const builder = await import('../lib/r1/meet/recall-bot.js');",
      "const client = require('../integrations/recall/client.js');",
      // M035 S03: the Google client for Dex is a Meet module too.
      "import { createR1MeetGoogle } from '../integrations/google/client.js';",
      // Not Meet modules: a sibling with a shared prefix, and a path that resolves under routes/.
      "import { other } from '../lib/r1/meeting.js';",
      "import { nested } from './integrations/recall/client.js';",
      "import { lookalike } from '../integrations/googleish/client.js';",
    ].join('\n');
    expect(meetImports(importer, source).map(rel).sort()).toEqual(
      [
        'app/api/src/integrations/google-meet/url.js',
        'app/api/src/integrations/google/client.js',
        'app/api/src/integrations/recall/client.js',
        'app/api/src/integrations/recall/types.js',
        'app/api/src/lib/r1/meet/config.js',
        'app/api/src/lib/r1/meet/profiles.js',
        'app/api/src/lib/r1/meet/recall-bot.js',
      ],
    );

    // The same import from inside lib/r1 (a `./meet/` hop) is caught by both checks.
    const r1Importer = path.join(SRC, 'lib', 'r1', 'example-importer.ts');
    const r1Source = "import { getR1MeetConfig } from './meet/config.js';";
    expect(meetImports(r1Importer, r1Source).map(rel)).toEqual(['app/api/src/lib/r1/meet/config.js']);
    expect(MEET_PATH_TEXT.test(r1Source)).toBe(true);
    expect(MEET_PATH_TEXT.test('const file = `../integrations/recall/${name}.js`;')).toBe(true);
    expect(MEET_PATH_TEXT.test("import { x } from '../lib/r1/meeting.js';")).toBe(false);
    // M035 S03: the Google client path is caught as text; a look-alike folder name is not.
    expect(MEET_PATH_TEXT.test("import { createR1MeetGoogle } from '../integrations/google/client.js';")).toBe(true);
    expect(MEET_PATH_TEXT.test('const file = `../integrations/google/${name}.js`;')).toBe(true);
    expect(MEET_PATH_TEXT.test("import { x } from '../integrations/googleish/client.js';")).toBe(false);
  });

  it('(b) no runtime file imports the test tree (fakes, fixtures, the Svix test signer)', () => {
    const offenders = RUNTIME_FILES.flatMap((file) =>
      testTreeImports(file, read(file)).map((target) => `${rel(file)} -> ${rel(target)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('(b) control: an import of a Meet fake from a runtime file is caught', () => {
    const importer = path.join(SRC, 'lib', 'r1', 'meet', 'example-importer.ts');
    const source = [
      "import { createFakeRecall } from '../../../__tests__/support/recall-fake.js';",
      "import { makeAshbyInterviewSchedule } from '../../../__tests__/support/ashby-schedule-fixture.js';",
    ].join('\n');
    expect(testTreeImports(importer, source).map(rel)).toEqual([
      'app/api/src/__tests__/support/recall-fake.js',
      'app/api/src/__tests__/support/ashby-schedule-fixture.js',
    ]);
  });

  it('(c) no fly*.toml under app/ names a Meet variable', () => {
    const skip = (name: string): boolean =>
      name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', '__pycache__'].includes(name);
    const flyFiles = walk(APP_ROOT, skip).filter((file) => /^fly[^\\/]*\.toml$/.test(path.basename(file)));
    expect(flyFiles.map(rel)).toContain('app/api/fly.toml');
    expect(flyFiles.length).toBeGreaterThanOrEqual(2);
    const offenders = flyFiles.flatMap((file) => {
      const text = read(file);
      return MEET_ENV_NAMES.filter((name) => text.includes(name)).map((name) => `${rel(file)}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });

  it('(d) the retired booking vendor is gone from the API source and the env contract', () => {
    expect(existsSync(path.join(SRC, 'integrations', RETIRED_BOOKING_VENDOR))).toBe(false);
    const files = [
      ...walk(SRC),
      path.join(REPO_ROOT, 'config', 'environment.schema.json'),
      path.join(API_ROOT, '.env.example'),
    ];
    expect(files.length).toBeGreaterThan(500);
    for (const file of files.slice(-2)) expect(existsSync(file), rel(file)).toBe(true);
    const offenders = files
      .filter(
        (file) =>
          rel(file).toLowerCase().includes(RETIRED_BOOKING_VENDOR)
          || readFileSync(file, 'latin1').toLowerCase().includes(RETIRED_BOOKING_VENDOR),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('(e) no Recall Calendar V2 anywhere, and no PATCH verb outside the Google client (R30, R31; M035 S03 R15)', () => {
    const meetFiles = MEET_DIRS.flatMap((directory) => walk(directory));
    expect(meetFiles.length).toBeGreaterThanOrEqual(10);
    const googleFiles = walk(GOOGLE_DIR);
    expect(googleFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of googleFiles) expect(meetFiles, rel(file)).toContain(file);
    // Calendar V2: every Meet file, the Google client included, and every Meet double.
    for (const file of [...meetFiles, ...MEET_SUPPORT_FILES, ...GOOGLE_SUPPORT_FILES]) {
      expect(read(file), rel(file)).not.toMatch(/api\/v2\/calendar/i);
    }
    // PATCH: every Meet file except the Google client, and the Recall-side doubles.
    const patchBanned = [...meetFiles.filter((file) => !inside(file, GOOGLE_DIR)), ...MEET_SUPPORT_FILES];
    expect(patchBanned.length).toBe(meetFiles.length - googleFiles.length + MEET_SUPPORT_FILES.length);
    for (const file of patchBanned) {
      expect(read(file), rel(file)).not.toMatch(/['"`]PATCH['"`]/i);
    }
    // The exemption is exact: these Google files write the verb, and no other file there may.
    const googlePatchFiles = googleFiles
      .filter((file) => /['"`]PATCH['"`]/i.test(read(file)))
      .map((file) => path.basename(file))
      .sort();
    expect(googlePatchFiles).toEqual(['calendar.ts', 'http.ts', 'meet.ts']);

    // Both method unions in the client (the transport request and the prepared request).
    const client = read(RECALL_CLIENT);
    const unions = [...client.matchAll(/\bmethod\??\s*:\s*((?:'[A-Za-z]+'\s*\|\s*)*'[A-Za-z]+')\s*;/g)].map(
      (match) => (match[1] as string).replace(/\s+/g, ' '),
    );
    expect(unions).toEqual(["'GET' | 'POST' | 'DELETE'", "'GET' | 'POST' | 'DELETE'"]);

    // Compile-time pin: adding PATCH to the transport union turns this type into `true` and fails tsc.
    const patchIsATransportMethod: 'PATCH' extends RecallTransportRequest['method'] ? true : false = false;
    expect(patchIsATransportMethod).toBe(false);
  });
});

describe('(f) loading the Meet modules is inert', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports every Meet module with fetch spied: zero network calls; an empty environment is disabled', async () => {
    // The spy goes in BEFORE any Meet module loads, so even a module that captured `fetch` at
    // import time would hold the spy.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('r1-meet-dark: unexpected network call');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Control: the spy is what a bare `fetch(...)` reaches (the Recall client's default transport).
    await expect(fetch('https://example.invalid/r1-meet-dark')).rejects.toThrow('unexpected network call');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    vi.resetModules();
    const modules = MEET_DIRS.flatMap((directory) => walk(directory)).filter((file) => file.endsWith('.ts')).sort();
    expect(modules.length).toBeGreaterThanOrEqual(10);
    const loaded = new Map<string, Record<string, unknown>>();
    for (const file of modules) {
      const specifier = '../' + path.relative(SRC, file).split(path.sep).join('/');
      loaded.set(file, (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>);
    }
    for (const file of modules) expect(Object.keys(loaded.get(file)!).length, rel(file)).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // M035 S03: the Google client modules are among them, and loading them built nothing.
    expect(modules.filter((file) => inside(file, GOOGLE_DIR)).length).toBeGreaterThanOrEqual(6);
    expect(typeof loaded.get(path.join(GOOGLE_DIR, 'client.ts'))!.createR1MeetGoogle).toBe('function');

    const config = loaded.get(MEET_CONFIG) as unknown as typeof import('../lib/r1/meet/config.js');
    expect(config.getR1MeetConfig({})).toStrictEqual({ enabled: false, status: 'disabled' });
    expect(config.r1MeetActive({ enabled: true }, config.getR1MeetConfig({}))).toBe(false);
    expect([...config.R1_MEET_ENV_VARIABLES]).toEqual([...MEET_ENV_NAMES]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
