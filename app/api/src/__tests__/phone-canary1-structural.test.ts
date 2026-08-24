/**
 * PR105 — Canary-1's structural closure.
 *
 * ── WHY THE FILE LIST IS EXPLICIT AND NOT A DIRECTORY WALK ────────────
 * `config/environment.schema.json` declares the api component's `sourceRoots`
 * as `["app/api/src"]`, so `app/api/scripts/` is scanned by NEITHER the
 * environment contract NOR any directory-walking structural suite in this
 * repository. It is genuinely unwatched. An earlier revision of the Canary-1
 * design asserted the closure over `lib/phone-canary1/**` and left the entry
 * script outside it — which is exactly where a `console.error(err)` would have
 * survived review.
 *
 * So the closure is a HARDCODED list that names both the package files and
 * `app/api/scripts/phone-canary1.ts`, every entry gets the same rules, and §0
 * proves the list is neither stale nor short.
 *
 * ── THE ONE PERMITTED `node:fs` READ ──────────────────────────────────
 * The M-4 credential refusal has to read `app/api/.env` to know whether it
 * holds a `LIVEKIT_*` key, and the H-1 repair asserted "no `node:fs`, read or
 * write". Both cannot hold. The resolution is pinned in the safer direction and
 * asserted here: the WRITE side stays absolutely forbidden everywhere, and the
 * READ permission is MOVED to exactly one file — `entry.ts` — with a control
 * proving the scanner moved it rather than gaining a second exception. That is
 * the same shape `canary0.test.mjs` uses for `exec.mjs`'s `node:child_process`.
 *
 * The risk this control exists for is not that the contradiction ships; CI
 * catches that on day one. It is that somebody resolves it by DELETING the
 * `credentials_persisted` refusal, which un-closes the finding with nothing
 * recording that it happened.
 *
 * Everything here is offline: file reads and regexes. No network, no clients.
 */

import { describe, it, expect } from 'vitest';
import { canary1VerdictLine } from '../lib/phone-canary1/verdict.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = fileURLToPath(new URL('../lib/phone-canary1/', import.meta.url));
const ENTRY_SCRIPT = fileURLToPath(new URL('../../scripts/phone-canary1.ts', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('./', import.meta.url));

interface SourceFile {
  readonly name: string;
  readonly source: string;
}

/**
 * THE CLOSURE. Hardcoded, in the order the design lists it, with the entry
 * script last so its presence is visible rather than inferred.
 */
const CLOSURE_NAMES = [
  'arming.ts',
  'containment.ts',
  'entry.ts',
  'ids.ts',
  'index.ts',
  'metadata.ts',
  'originate.ts',
  'plan.ts',
  'preflight.ts',
  'teardown.ts',
  'verdict.ts',
  'scripts/phone-canary1.ts',
] as const;

function readClosure(): SourceFile[] {
  return CLOSURE_NAMES.map((name) => ({
    name,
    source: readFileSync(
      name.startsWith('scripts/') ? ENTRY_SCRIPT : path.join(MODULE_DIR, name),
      'utf8',
    ),
  }));
}

const FILES = readClosure();
const file = (name: string): SourceFile => {
  const found = FILES.find((f) => f.name === name);
  if (found === undefined) throw new Error(`missing closure file ${name}`);
  return found;
};

/** Comment-stripped source. Every assertion below runs on this, never on prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ══════════════════════════════════════════════════════════════════════
// 0. THE SUITE IS NOT VACUOUS — the list is complete and the stripper honest.
// ══════════════════════════════════════════════════════════════════════

describe('0. the closure list is complete and the extractor keeps code', () => {
  it('names every file in lib/phone-canary1 — a new module cannot escape the rules', () => {
    const onDisk = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts')).sort();
    const listed = CLOSURE_NAMES.filter((n) => !n.startsWith('scripts/')).slice().sort();
    expect(listed).toEqual(onDisk);
  });

  it('includes the entry script, which no other suite in this repo scans', () => {
    expect(CLOSURE_NAMES).toContain('scripts/phone-canary1.ts');
    expect(file('scripts/phone-canary1.ts').source).toContain('installCanary1Containment');
  });

  it('the stripper leaves real code behind in every file', () => {
    // A file that stripped to nothing would satisfy every "must not contain"
    // assertion below by containing nothing at all. A byte floor alone is a
    // weak check on a small file, so each entry also carries a MARKER the
    // stripper must not have eaten.
    const markers: Readonly<Record<string, string>> = {
      'arming.ts': 'CANARY1_ARMED',
      'containment.ts': 'installCanary1Containment',
      'entry.ts': 'readCanary1Destination',
      'ids.ts': 'mintCanary1Ids',
      'index.ts': 'runCanary1',
      'metadata.ts': 'buildCanary1DispatchMetadata',
      'originate.ts': 'createSipParticipant',
      'plan.ts': 'CANARY1_BOUNDS',
      'preflight.ts': 'runCanary1Preflight',
      'teardown.ts': 'tearDownCanary1Room',
      'verdict.ts': 'createCanary1Emitter',
      'scripts/phone-canary1.ts': 'installCanary1Containment',
    };
    for (const { name, source } of FILES) {
      const body = code(source);
      expect(body.trim().length, `${name} stripped to nothing`).toBeGreaterThan(80);
      expect(body, `${name} lost its marker to the stripper`).toContain(markers[name] as string);
    }
    expect(Object.keys(markers).sort()).toEqual([...CLOSURE_NAMES].sort());
  });

  it('CONTROL — the stripper removes comments and keeps statements', () => {
    const seeded = ['/* import fs from "node:fs"; */', '// import fs from "node:fs";',
      'const keep = 1;'].join('\n');
    expect(code(seeded)).not.toContain('node:fs');
    expect(code(seeded)).toContain('const keep = 1;');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 1. Forbidden imports — with the fs permission MOVED, not duplicated.
// ══════════════════════════════════════════════════════════════════════

/** Specifiers no file in the closure may import, with `node:fs` handled apart. */
const FORBIDDEN_SPECIFIERS = [
  '@supabase/supabase-js',
  'node:child_process',
  'child_process',
  'pino',
  'winston',
  'node:worker_threads',
  'node:cluster',
] as const;

/** The ONE file permitted to import `node:fs`, and only for the pinned read. */
const FS_PERMITTED_FILE = 'entry.ts';

function importSpecifiers(source: string): string[] {
  const body = code(source);
  return [
    ...[...body.matchAll(/(?:^|[\s(=])(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1] as string),
    ...[...body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
  ];
}

/** The scanner. Returns `file:specifier` for every violation. */
function forbiddenImportViolations(files: readonly SourceFile[]): string[] {
  const bad: string[] = [];
  for (const { name, source } of files) {
    for (const spec of importSpecifiers(source)) {
      if (spec === 'node:fs' || spec === 'fs' || spec === 'node:fs/promises') {
        if (name !== FS_PERMITTED_FILE) bad.push(`${name}:${spec}`);
        continue;
      }
      if ((FORBIDDEN_SPECIFIERS as readonly string[]).includes(spec)) bad.push(`${name}:${spec}`);
    }
  }
  return bad;
}

describe('1. the closure imports no persistence, no shell, no logger', () => {
  it('every file is clean', () => {
    expect(forbiddenImportViolations(FILES)).toEqual([]);
  });

  it('POSITIVE CONTROL — the scanner bites, per file, including the entry script', () => {
    const seeded = forbiddenImportViolations([
      { name: 'arming.ts', source: "import { createClient } from '@supabase/supabase-js';" },
      { name: 'plan.ts', source: "import { spawn } from 'node:child_process';" },
      { name: 'verdict.ts', source: "import pino from 'pino';" },
      { name: 'scripts/phone-canary1.ts', source: "import { writeFileSync } from 'node:fs';" },
      { name: 'index.ts', source: "const x = require('child_process');" },
    ]);
    expect(seeded.sort()).toEqual([
      'arming.ts:@supabase/supabase-js',
      'index.ts:child_process',
      'plan.ts:node:child_process',
      'scripts/phone-canary1.ts:node:fs',
      'verdict.ts:pino',
    ]);
  });

  it('POSITIVE CONTROL — the fs permission was MOVED, not gained a second time', () => {
    // The permitted file may import node:fs...
    expect(forbiddenImportViolations([
      { name: 'entry.ts', source: "import { readFileSync } from 'node:fs';" },
    ])).toEqual([]);
    // ...and may NOT import the things nobody may import.
    expect(forbiddenImportViolations([
      { name: 'entry.ts', source: "import { spawn } from 'node:child_process';" },
    ])).toEqual(['entry.ts:node:child_process']);
    // ...and no OTHER file inherits the fs permission.
    expect(forbiddenImportViolations([
      { name: 'originate.ts', source: "import { readFileSync } from 'node:fs';" },
    ])).toEqual(['originate.ts:node:fs']);
  });

  it('only entry.ts names node:fs at all', () => {
    for (const { name, source } of FILES) {
      if (name === FS_PERMITTED_FILE) continue;
      expect(code(source), `${name} names node:fs`).not.toMatch(/['"]node:fs['"]/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. No file write anywhere — the `--out` that was deleted stays deleted.
// ══════════════════════════════════════════════════════════════════════

/** Every way Node writes a file. The list is the assertion. */
const FS_WRITE_APIS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'unlink', 'unlinkSync',
  'rename', 'renameSync', 'copyFile', 'copyFileSync', 'truncate', 'truncateSync',
  'writeSync', 'openSync',
] as const;

function writeApiHits(files: readonly SourceFile[]): string[] {
  const hits: string[] = [];
  for (const { name, source } of files) {
    const body = code(source);
    for (const api of FS_WRITE_APIS) {
      if (new RegExp(`\\b${api}\\s*\\(`).test(body)) hits.push(`${name}:${api}`);
    }
  }
  return hits;
}

describe('2. the mechanism writes no file at all', () => {
  it('no write API is called anywhere in the closure', () => {
    expect(writeApiHits(FILES)).toEqual([]);
  });

  it('POSITIVE CONTROL — the write scanner bites', () => {
    expect(writeApiHits([
      { name: 'verdict.ts', source: 'writeFileSync(out, line);' },
      { name: 'scripts/phone-canary1.ts', source: 'const s = createWriteStream(p);' },
    ]).sort()).toEqual(['scripts/phone-canary1.ts:createWriteStream', 'verdict.ts:writeFileSync']);
  });

  it('there is no --out flag, and the token is refused if it appears in argv', () => {
    for (const { name, source } of FILES) {
      expect(code(source), `${name} declares an --out flag`).not.toMatch(/case\s+'--out'/);
    }
    // It is not merely absent: it is on the refusal list.
    expect(code(file('entry.ts').source)).toContain("'--out'");
  });

  it('exactly ONE fs read call exists, in entry.ts, against a pinned path', () => {
    const body = code(file('entry.ts').source);
    const readCalls = [...body.matchAll(/\breadFileSync\s*\(/g)];
    expect(readCalls, 'entry.ts must hold exactly one fs read').toHaveLength(1);
    // The path is a module constant, not a parameter — a path parameter is how
    // one permitted read becomes an arbitrary file reader.
    expect(body).toMatch(/readFileSync\(CANARY1_ENV_PATH, 'utf8'\)/);
    expect(body).toMatch(/CANARY1_ENV_PATH = new URL\('\.\.\/\.\.\/\.\.\/\.env'/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Containment — nothing prints an error, nothing throws a value.
// ══════════════════════════════════════════════════════════════════════

describe('3. no error object can reach a terminal', () => {
  it('no file logs an error object or uses console at all', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      expect(body, `${name} calls console`).not.toMatch(/\bconsole\.\w+\s*\(/);
      expect(body, `${name} logs a caught error`).not.toMatch(/\(\s*(?:err|error|e)\s*\)\s*=>/);
    }
  });

  it('every catch clause is bare — no binding a later edit could print', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      const bound = [...body.matchAll(/\bcatch\s*\(([^)]*)\)/g)]
        .map((m) => (m[1] ?? '').trim())
        .filter((binding) => binding !== '');
      expect(bound, `${name} binds a caught error: ${bound.join(', ')}`).toEqual([]);
    }
  });

  it('every throw carries a BARE code — no interpolation, no value', () => {
    const throws: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of code(source).matchAll(/\bthrow\s+([^;]+);/g)) {
        throws.push(`${name}::${(match[1] ?? '').trim()}`);
      }
    }
    // Non-vacuous: the package does throw, in the two places that must.
    expect(throws.length).toBeGreaterThan(0);
    for (const t of throws) {
      expect(t, `interpolated throw: ${t}`).not.toContain('`');
      expect(t, `interpolated throw: ${t}`).toMatch(/new Error\((?:'[a-z_]+'|[A-Z0-9_]+)\)$/);
    }
  });

  it('the process handlers take NO parameter, so no error is ever bound', () => {
    const body = code(file('containment.ts').source);
    expect(body).toMatch(/proc\.on\('uncaughtException', \(\) =>/);
    expect(body).toMatch(/proc\.on\('unhandledRejection', \(\) =>/);
  });

  it('teardown runs INSIDE the containment handler, not beside it', () => {
    const body = code(file('containment.ts').source);
    const handler = body.slice(body.indexOf('const contain'));
    expect(handler).toContain('await deps.teardown()');
    expect(handler).toContain("deps.emit('teardown_failed_in_containment')");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Ordering — handlers installed before the destination can be read.
// ══════════════════════════════════════════════════════════════════════

describe('4. the entry script installs containment before it loads the prompt', () => {
  const body = code(file('scripts/phone-canary1.ts').source);

  it('reaches the orchestrator through a DYNAMIC import', () => {
    // In ESM every static import is evaluated before any statement in this
    // module's body, so "installed before the prompt module is imported" is
    // unachievable with a static import — and an ordering nobody can assert is
    // an ordering a later edit silently loses.
    expect(body).toMatch(/await import\(\s*\n?\s*'\.\.\/src\/lib\/phone-canary1\/index\.js'/);
    expect(body, 'the orchestrator is statically imported')
      .not.toMatch(/^import\s[^;]*from\s+'\.\.\/src\/lib\/phone-canary1\/index\.js'/m);
    expect(body, 'the prompt module is statically imported')
      .not.toMatch(/^import\s[^;]*from\s+'\.\.\/src\/lib\/phone-canary1\/entry\.js'/m);
  });

  it('installs the handlers before that dynamic import', () => {
    const install = body.indexOf('installCanary1Containment({');
    const dynamic = body.indexOf('await import(');
    expect(install).toBeGreaterThan(-1);
    expect(dynamic).toBeGreaterThan(-1);
    expect(install).toBeLessThan(dynamic);
  });

  it('CONTROL — the ordering assertion could have come out the other way', () => {
    const inverted = "const m = await import('./index.js');\ninstallCanary1Containment({});";
    expect(inverted.indexOf('installCanary1Containment({'))
      .toBeGreaterThan(inverted.indexOf('await import('));
  });

  it('the entry script passes NO arming override — this is the whole PR\'s predicate', () => {
    // `runCanary1` accepts `armed?: boolean` so the orchestration tests can
    // exercise the armed path without shipping an armed constant. That seam
    // must never be reachable from production.
    //
    // §9's arming pin is NOT this control. It checks that the constant is the
    // literal `false` and that no closure file ASSIGNS it — and neither fires
    // if a future edit adds `armed: process.env.CANARY1_ARM === 'true'` to the
    // entry script. That single line would turn "this branch structurally
    // cannot place a call" into "this branch places a call when an environment
    // variable says so", with every check still green and `CANARY1_ARMED`
    // still literally `false`. The whole rhetorical weight of PR105 rests on
    // this one predicate, so the seam gets the same treatment `readEnvFile`
    // already had.
    expect(body, 'the entry script injects an arming override').not.toMatch(/\barmed\b/);
    // Nor may it reach the constant to re-derive one.
    expect(body, 'the entry script names the arming constant').not.toContain('CANARY1_ARMED');
  });

  it('CONTROL — the arming-override matcher bites on the line it exists to catch', () => {
    const seeded = "  armed: process.env.CANARY1_ARM === 'true',";
    expect(/\barmed\b/.test(seeded)).toBe(true);
    // ...and does not fire on ordinary entry-script vocabulary.
    expect(/\barmed\b/.test('const disarmedNote = 1;')).toBe(false);
  });

  it('the entry script passes NO env reader, so the credential refusal cannot be bypassed', () => {
    // `runCanary1` accepts an injectable reader so the orchestration tests are
    // hermetic on a machine that has a real `app/api/.env`. That seam must not
    // become the way the refusal is turned off in production, so the script is
    // asserted never to use it.
    expect(body, 'the entry script injects an env reader').not.toContain('readEnvFile');
  });

  it('the containment emitter in the script produces a grammar-legal line', () => {
    // It writes directly rather than through the emitter, so its shape is
    // pinned here. Every containment code is a closed union member, and the
    // line it forms parses under `PROTOCOL.md`.
    const shape = /^CANARY\|canary1\|process_containment\|FAIL\|\$\{code\}$/m;
    expect(body).toMatch(/CANARY\|canary1\|process_containment\|FAIL\|\$\{code\}/);
    void shape;
    for (const code of ['uncaught_exception', 'unhandled_rejection', 'seam_failed',
      'teardown_failed_in_containment']) {
      expect(canary1VerdictLine('process_containment', false, code))
        .toBe(`CANARY|canary1|process_containment|FAIL|${code}`);
    }
  });

  it('the abort and the containment both END the process', () => {
    // Installing an `uncaughtException` handler SUPPRESSES Node's own exit, so
    // a handler that only sets `process.exitCode` leaves the process alive
    // after its own fatal error — with a live carrier leg attached. And an
    // abort that does not end the process is not an abort: it lets an
    // originate the operator just cancelled run to completion.
    expect(body).toMatch(/process\.exit\(code\);/);
    expect(body).toMatch(/process\.exit\(1\);/);
    // A second Ctrl-C must not race the first teardown.
    expect(body).toContain('if (aborting) return;');
    // Both signals are handled, not just SIGINT.
    expect(body).toContain("['SIGINT', 'SIGTERM'] as const");
  });

  it('the only static import in the script is the containment module', () => {
    const statics = [...body.matchAll(/^import\s[^;]*from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(statics).toEqual(['../src/lib/phone-canary1/containment.js']);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. SDK verbosity, and the SDK itself, are reached lazily or not at all.
// ══════════════════════════════════════════════════════════════════════

describe('5. no SDK debug channel is opened', () => {
  it('the SDK is never imported statically anywhere in the closure', () => {
    for (const { name, source } of FILES) {
      expect(code(source), `${name} statically imports the SDK`)
        .not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'livekit-server-sdk'/m);
    }
  });

  it('every mention of the SDK is inside an await-import', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      const mentions = [...body.matchAll(/'livekit-server-sdk'/g)].length;
      const lazy = [...body.matchAll(/await import\('livekit-server-sdk'\)/g)].length;
      expect(lazy, `${name} names the SDK outside an await-import`).toBe(mentions);
    }
  });

  it('the verbosity scrub MUTATES the map the SDK reads, and is not a copy', () => {
    // A scrubbed CLONE handed to a constructor that never reads it is a
    // control that reads like a guarantee and is not one — the SDK and Node's
    // own `NODE_DEBUG` machinery read `process.env` directly. So the scrub is
    // asserted to be the mutating one, in both places it runs.
    expect(code(file('originate.ts').source)).toContain('scrubVerbosity(env)');
    expect(code(file('scripts/phone-canary1.ts').source))
      .toContain('scrubVerbosity(process.env)');
    // ...and the pure copy is NOT what either seam uses.
    expect(code(file('originate.ts').source), 'originate.ts scrubs a copy')
      .not.toContain('quietEnv(');
    expect(code(file('scripts/phone-canary1.ts').source), 'the entry script scrubs a copy')
      .not.toContain('quietEnv(');
    // The scrub deletes rather than reassigns.
    expect(code(file('containment.ts').source)).toMatch(/delete env\[key\];/);
    for (const key of ['DEBUG', 'LIVEKIT_LOG_LEVEL', 'LOG_LEVEL', 'NODE_DEBUG']) {
      expect(code(file('containment.ts').source)).toContain(`'${key}'`);
    }
  });

  it('no debug or log-level option is passed to any client constructor', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      expect(body, `${name} passes a log level`).not.toMatch(/\blogLevel\s*:/);
      expect(body, `${name} passes a debug flag`).not.toMatch(/\bdebug\s*:\s*true/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. No destination may enter through the environment.
// ══════════════════════════════════════════════════════════════════════

describe('6. the destination cannot arrive by environment variable', () => {
  it('no file reads a destination-shaped environment variable', () => {
    const pattern = /process\.env\.((?:PHONE|CANARY)_[A-Z0-9_]*)/g;
    const suffix = /(?:^|_)(?:NUMBER|DEST|DESTINATION|E164|TO)$/;
    for (const { name, source } of FILES) {
      for (const match of code(source).matchAll(pattern)) {
        expect(suffix.test(match[1] as string), `${name} reads ${match[1]}`).toBe(false);
      }
    }
  });

  it('POSITIVE CONTROL — the scanner would catch a seeded destination read', () => {
    const seeded = 'const n = process.env.PHONE_DEST_NUMBER;';
    const hit = [...seeded.matchAll(/process\.env\.((?:PHONE|CANARY)_[A-Z0-9_]*)/g)];
    expect(hit).toHaveLength(1);
    expect(/(?:^|_)(?:NUMBER|DEST|DESTINATION|E164|TO)$/.test(hit[0]?.[1] as string)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. One originate, never a loop; and no test may build a live client.
// ══════════════════════════════════════════════════════════════════════

describe('7. one invocation, one destination, at most one originate', () => {
  it('no loop anywhere in the closure encloses the originate seam', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      if (!body.includes('createSipParticipant')) continue;
      // Any `for`/`while`/`do` textually preceding the seam inside the same
      // file would be a retry a reviewer has to reason about. There are none.
      const seam = body.indexOf('createSipParticipant');
      const before = body.slice(0, seam);
      expect(before, `${name} loops around the originate`).not.toMatch(/\b(?:for|while|do)\s*[({]/);
    }
  });

  it('the originate is not retried — there is no retry vocabulary on that path', () => {
    const body = code(file('originate.ts').source);
    expect(body).not.toMatch(/\bretry|\battempts\s*[<>]=?/i);
  });

  /**
   * SCOPED, AND THE SCOPE IS THE HONEST PART.
   *
   * The Canary-1 design asserts "no test ANYWHERE constructs
   * `createLiveSipClient`". Verified against the tree, that is FALSE:
   * `phone-dial-sip.test.ts` constructs it at eleven call sites, against a
   * `vi.mock`ed `livekit-server-sdk`, which is how P4a proved the SDK call's
   * argument shape and its units. Those tests are correct and are not being
   * changed.
   *
   * So the claim is narrowed to the one that is true and load-bearing: NO
   * CANARY-1 TEST constructs it. The sweep is over `phone-canary1-*.test.ts`,
   * the exemption is a named list rather than a silent absence, and the
   * exemption is asserted to be exactly the files that genuinely do it — so a
   * NEW file quietly joining them fails here.
   *
   * This is also why `docs/runbooks/phone-canary1.md` records that this
   * suite's zero-network claim is WEAKER than Canary-0's. In
   * `app/api/src/__tests__` the telephony SDK is resolvable, so the property
   * rests on dependency injection and the two assertions below, not on the SDK
   * being unreachable the way it is from `scripts/phone-canary/`.
   */
  it('NO CANARY-1 test constructs the live SIP client', () => {
    const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));
    expect(testFiles.length, 'the sweep found no test files').toBeGreaterThan(20);

    // The scan is on the IMPORT, not on a call shape. An earlier form matched
    // `createLiveSipClient\s*\(\s*URL`, which found the one existing file only
    // because its fixture happens to be named `URL_` — a new file writing
    // `createLiveSipClient(url, key, secret)` would have slipped straight
    // past the pin that claims to catch exactly that. Importing the symbol is
    // the real precondition for constructing it, and it cannot be spelled
    // around.
    const importsLive = (name: string): boolean =>
      /import\s*\{[^}]*\bcreateLiveSipClient\b[^}]*\}/s
        .test(readFileSync(path.join(TESTS_DIR, name), 'utf8'));

    // THIS file is excluded, by name and for a stated reason: it is the
    // scanner, and it carries the seeded control below, so it must be able to
    // write the pattern it looks for. Exactly one exclusion, asserted, so the
    // exemption cannot quietly grow.
    const SCANNER = 'phone-canary1-structural.test.ts';
    const scanned = testFiles.filter((f) => f !== SCANNER);
    expect(testFiles).toContain(SCANNER);

    const canary1 = scanned.filter((f) => f.startsWith('phone-canary1-'));
    expect(canary1.length, 'the canary-1 suite was not found').toBeGreaterThanOrEqual(6);
    expect(canary1.filter(importsLive)).toEqual([]);

    // And the pre-existing exemption is PINNED by name, so a new file joining
    // it is a failure rather than an unremarked drift.
    expect(scanned.filter(importsLive)).toEqual(['phone-dial-sip.test.ts']);

    // NON-VACUOUS: the matcher finds the one file that really does import it,
    // in the multi-line form that file actually uses.
    expect(importsLive('phone-dial-sip.test.ts')).toBe(true);
    expect(/import\s*\{[^}]*\bcreateLiveSipClient\b[^}]*\}/s
      .test("import {\n  createLiveSipClient,\n} from './x.js';")).toBe(true);
  });

  it('the canary resolves its client by injection, never by construction', () => {
    const body = code(file('originate.ts').source);
    // `resolvePhoneSipClient` yields the SYNTHETIC client unless every gate
    // holds, so an un-injected test path cannot reach a carrier even in error.
    expect(body).toContain('deps.resolve ?? resolvePhoneSipClient');
    expect(body).toContain("resolution.client.mode !== 'live'");
    expect(body, 'originate.ts constructs a live client directly')
      .not.toMatch(/\bcreateLiveSipClient\s*\(/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. The canary metadata builders, and production's closed key sets.
// ══════════════════════════════════════════════════════════════════════

describe('8. canary and production metadata cannot be confused', () => {
  const production = readFileSync(
    fileURLToPath(new URL('../integrations/livekit-phone-dial/phone-room.ts', import.meta.url)),
    'utf8',
  );

  it('the production builders are literal closed-key constructors', () => {
    const body = code(production);
    expect(body).toContain('export function buildPhoneRoomMetadata');
    expect(body).toContain('export function buildPhoneDispatchMetadata');
  });

  it('production cannot emit `canary` or `mode` — the disjointness is structural', () => {
    const body = code(production);
    expect(body, 'a production builder gained a canary key').not.toMatch(/\bcanary\s*:/);
    expect(body, 'a production builder gained a mode key').not.toMatch(/\bmode\s*:/);
  });

  it('the canary builders do not emit attempt_id or epoch', () => {
    const body = code(file('metadata.ts').source);
    expect(body, 'the canary dispatch gained an attempt id').not.toMatch(/attempt_id\s*:/);
    expect(body, 'the canary dispatch gained an epoch').not.toMatch(/\bepoch\s*:/);
  });

  it('the canary key sets are exactly four each and are declared, not inferred', () => {
    const body = code(file('metadata.ts').source);
    expect(body).toContain("'session_id',\n  'room_name',\n  'channel',\n  'canary',");
    expect(body).toContain("'session_id',\n  'channel',\n  'mode',\n  'canary_id',");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 9. The arming constant is `false` on `main`.
// ══════════════════════════════════════════════════════════════════════

describe('9. PR105 ships structurally disarmed', () => {
  it('CANARY1_ARMED is the literal false in source', () => {
    const body = code(file('arming.ts').source);
    expect(body).toMatch(/export const CANARY1_ARMED:\s*boolean\s*=\s*false;/);
    expect(body, 'the arming constant became true').not.toMatch(/CANARY1_ARMED[^=]*=\s*true/);
  });

  it('nothing in the closure can flip it at runtime', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      expect(body, `${name} assigns CANARY1_ARMED`).not.toMatch(/CANARY1_ARMED\s*=\s*(?!=)/);
    }
  });
});
