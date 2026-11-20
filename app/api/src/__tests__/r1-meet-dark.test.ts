/**
 * M034 S01: the R1-over-Google-Meet modules ship as DARK libraries.
 *
 * S01 ships libraries only. S03 (Recall receivers + Ashby schedule routing), S05 (Meet routes) and
 * S06 (runtime) wire these modules and must replace this pin with a narrower one in the same PR.
 *
 * What "dark" means here (S01 plan R21, R30, R31; D-M034-11):
 *  (a) no runtime file outside the three Meet folders (integrations/recall, integrations/google-meet,
 *      lib/r1/meet) imports a module inside them. Static, side-effect, re-export, dynamic `import()`
 *      and `require()` specifiers are resolved relative to the importing file; type-only imports
 *      count too. A second check refuses any Meet module path written as text (a computed
 *      specifier would otherwise slip past the resolver).
 *  (b) no runtime file imports the test tree (`__tests__`, which holds the Meet fakes, the Ashby
 *      schedule fixture and the Svix test signer in `__tests__/support`).
 *  (c) no fly*.toml under app/ names a Meet variable: the flag defaults OFF and the two Recall
 *      credentials are Fly secrets on the API only.
 *  (d) the retired booking vendor of the first plan is gone from the API source and the env contract
 *      (its name is built from two halves below so this file never contains it).
 *  (e) no Recall Calendar V2 and no Recall PATCH: S06 deletes a scheduled bot and creates a new one.
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
  path.join(SRC, 'lib', 'r1', 'meet'),
] as const;
const MEET_CONFIG = path.join(SRC, 'lib', 'r1', 'meet', 'config.ts');
const RECALL_CLIENT = path.join(SRC, 'integrations', 'recall', 'client.ts');
/** The Meet test doubles: test-only, but they must not drift toward Calendar V2 either. */
const MEET_SUPPORT_FILES = ['recall-fake.ts', 'meet-webhook-signing.ts', 'ashby-schedule-fixture.ts'].map(
  (name) => path.join(TESTS_DIR, 'support', name),
);

/** The nine Meet variables (config/environment.schema.json, api), in `R1_MEET_ENV_VARIABLES` order. */
const MEET_ENV_NAMES = [
  'R1_MEET_ENABLED',
  'R1_MEET_BOT_NAME',
  'R1_MEET_DAILY_BOT_CAP',
  'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
  'R1_MEET_SERVICE_USER_ID',
  'RECALL_BASE_URL',
  'R1_MEET_ASHBY_DEX_USER_ID',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
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
const testTreeImports = (importer: string, source: string): string[] =>
  relativeTargets(importer, source).filter((target) => inside(target, TESTS_DIR));

/**
 * A Meet module path written as text: `integrations/recall`, `integrations/google-meet`,
 * `r1/meet` (not `r1/meeting`), or a relative `./meet/` hop from inside lib/r1.
 */
const MEET_PATH_TEXT = new RegExp(
  [
    String.raw`integrations\/(?:recall|google-meet)(?![\w-])`,
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

  it('(a) no runtime file outside the Meet folders imports a Meet module', () => {
    const offenders = OUTSIDE_FILES.flatMap((file) =>
      meetImports(file, read(file)).map((target) => `${rel(file)} -> ${rel(target)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('(a) no runtime file outside the Meet folders names a Meet module path (computed specifiers)', () => {
    const offenders = OUTSIDE_FILES.filter((file) => MEET_PATH_TEXT.test(read(file))).map(rel);
    expect(offenders).toEqual([]);
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
      // Not Meet modules: a sibling with a shared prefix, and a path that resolves under routes/.
      "import { other } from '../lib/r1/meeting.js';",
      "import { nested } from './integrations/recall/client.js';",
    ].join('\n');
    expect(meetImports(importer, source).map(rel).sort()).toEqual(
      [
        'app/api/src/integrations/google-meet/url.js',
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

  it('(e) no Recall Calendar V2 and no PATCH verb in the Recall client (R30, R31)', () => {
    const meetFiles = MEET_DIRS.flatMap((directory) => walk(directory));
    expect(meetFiles.length).toBeGreaterThanOrEqual(10);
    for (const file of [...meetFiles, ...MEET_SUPPORT_FILES]) {
      const text = read(file);
      expect(text, rel(file)).not.toMatch(/api\/v2\/calendar/i);
      expect(text, rel(file)).not.toMatch(/['"`]PATCH['"`]/i);
    }

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

    const config = loaded.get(MEET_CONFIG) as unknown as typeof import('../lib/r1/meet/config.js');
    expect(config.getR1MeetConfig({})).toStrictEqual({ enabled: false, status: 'disabled' });
    expect(config.r1MeetActive({ enabled: true }, config.getR1MeetConfig({}))).toBe(false);
    expect([...config.R1_MEET_ENV_VARIABLES]).toEqual([...MEET_ENV_NAMES]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
