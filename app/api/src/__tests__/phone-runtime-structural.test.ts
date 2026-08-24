/**
 * Structural boundaries for `lib/phone-runtime/**`.
 *
 * This package is the phone lane's runtime orchestration, and it is the FIRST
 * place in the repository that reads a candidate's `phone_e164` out of SQL —
 * until now that column never left the database. `lib/phone-screening/` carries
 * a directory-wide assertion that the column may not appear at all; that
 * assertion cannot cover this package, because this package is precisely the
 * exception. So the guarantee has to be re-established HERE, narrower and
 * asserted over the source text, or it is not a guarantee at all.
 *
 * The mechanics are deliberately the same as `phone-screening-structural.test.ts`:
 * `readdirSync` the module directory and fail closed if it is empty, and strip
 * block and line comments before every call-site assertion so that a comment may
 * legitimately NAME a forbidden thing while the code may not. Every sweep is
 * bounded below by a count, because a sweep over nothing passes everything.
 *
 * Families:
 *   1. FILE INVENTORY — asserted as a bijection, so a new file cannot join this
 *      package without a reviewer touching this test.
 *   2. THE NUMBER IS READ IN EXACTLY ONE FILE.
 *   3. THE RAW NUMBER NEVER BECOMES A VALUE — asserted at the line level.
 *   4. NO LOGGER, NO CONSOLE, except the one file that legitimately has one.
 *   5. EVERY THROWN ERROR IS A BARE STABLE CODE.
 *   6. NO DIALABLE LITERAL.
 *   7. TIMERS LIVE ONLY WHERE THEY BELONG.
 *   8. THE SDK IS LAZY.
 *   9. READS ARE COLUMN-EXPLICIT AND BOUNDED.
 *  10. NO WRITE FROM THE READ SEAM.
 *  11. CONTROLS — that the extractors above are not vacuous.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = fileURLToPath(new URL('../lib/phone-runtime/', import.meta.url));

/** Source with block and line comments removed — for call-site assertions. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readModuleFiles(): Array<{ name: string; source: string }> {
  const names = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts')).sort();
  // Fail closed. Every assertion below is a `for` over this array; an empty one
  // would make the whole suite green while asserting nothing.
  if (names.length === 0) throw new Error('phone-runtime module is empty');
  return names.map((name) => ({
    name,
    source: readFileSync(path.join(MODULE_DIR, name), 'utf8'),
  }));
}

const MODULE_FILES = readModuleFiles();

function body(name: string): string {
  const file = MODULE_FILES.find((f) => f.name === name);
  if (file === undefined) throw new Error(`missing file: ${name}`);
  return code(file.source);
}

/**
 * The `const X_COLUMNS = '...'` declarations of a module, as name → list.
 *
 * Extracting the DECLARATIONS is the point: a sweep over `.select(` arguments
 * only ever sees identifiers, so it can assert things about an identifier's
 * spelling and nothing about what the identifier HOLDS. A column list must be
 * exactly ONE plain string literal; anything computed is reported as malformed
 * and fails, because partially inspecting a computed initializer is worse than
 * refusing it — `A + B` would let the star check see only the first half.
 */
function columnConstants(source: string): { lists: Map<string, string>; malformed: string[] } {
  const lists = new Map<string, string>();
  const malformed: string[] = [];
  for (const m of source.matchAll(/const\s+([A-Z][A-Z0-9_]*_COLUMNS)\s*=\s*([^;]*);/g)) {
    const initializer = m[2].trim().replace(/\s+/g, ' ');
    const single = /^'([^']*)'$/.exec(initializer);
    if (!single) {
      malformed.push(`${m[1]} = ${initializer}`);
      continue;
    }
    lists.set(m[1], single[1]);
  }
  return { lists, malformed };
}

/** The one file allowed to read the subscriber number out of SQL. */
const READ_SEAM = 'read.ts';
/** The one file allowed to construct a logger — for queue-event metadata. */
const LOGGER_FILE = 'runtime.ts';

describe('1. file inventory', () => {
  const EXPECTED_FILES = [
    'config.ts',
    'dial-handler.ts',
    'due-loop.ts',
    'health.ts',
    'index.ts',
    'livekit-clients.ts',
    'read.ts',
    'runtime.ts',
  ];

  it('the package holds exactly the enumerated files, in both directions', () => {
    // A BIJECTION, not a subset. Every rule below is expressed as a sweep over
    // this directory, so an unlisted new file would be swept — but nobody would
    // have had to think about whether the rules still say the right thing for
    // it. Pinning the inventory forces that thought onto a reviewer: adding a
    // file fails here, and so does deleting one.
    const actual = MODULE_FILES.map((f) => f.name);
    expect(actual).toEqual(EXPECTED_FILES);
    for (const name of EXPECTED_FILES) {
      expect(actual, `${name} is missing from the package`).toContain(name);
    }
  });

  it('no file is a stub that satisfies the other rules vacuously', () => {
    // Every rule below is a NEGATIVE assertion over source text — no logger, no
    // timer, no bare number. An empty file passes all of them. The length floor
    // is what stops "the rule holds" from collapsing into "there is no code".
    for (const { name, source } of MODULE_FILES) {
      expect(code(source).trim().length, `${name} is too short to be real`).toBeGreaterThan(200);
    }
  });
});

describe('2. the number is read in exactly one file', () => {
  it('`phone_e164` appears in read.ts and in no other file', () => {
    // Comment-stripped: several files DISCUSS the column in their headers, and
    // documenting why the boundary exists must not be what breaks it.
    const mentions = MODULE_FILES
      .filter((f) => code(f.source).includes('phone_e164'))
      .map((f) => f.name);
    expect(mentions).toEqual([READ_SEAM]);
    expect(mentions.length, 'the column is read in more than one place').toBe(1);
  });

  it('no other file names a phone-bearing identifier either', () => {
    // `phone_e164` is the SQL spelling. A second reader would more likely
    // arrive as a camelCase field on a DTO than as the raw column name, so the
    // ban covers the shapes the value could take on its way out.
    const PHONE_BEARING = [
      'phoneE164', 'phone_raw', 'phoneRaw', 'phoneNumber', 'phone_number',
      'msisdn', 'callerId', 'caller_id', 'toNumber', 'fromNumber',
    ];
    for (const { name, source } of MODULE_FILES) {
      for (const field of PHONE_BEARING) {
        expect(code(source), `${name} names ${field}`).not.toContain(field);
      }
    }
  });
});

describe('3. the raw number never becomes a value', () => {
  /**
   * The claim being asserted is "the string read from `phone_e164` is wrapped
   * in the same expression that reads it, so no local, field or return value
   * ever holds it bare".
   *
   * HONEST SCOPE: this is a LINE-LEVEL proof, not an AST-level one. What is
   * actually proved is that the identifier `raw` occurs on exactly three lines
   * of the comment-stripped seam and that each of those three lines is one of
   * three enumerated forms — a declaration from `row.phone_e164`, a typeof
   * guard, and the wrap call. Anything else done with `raw` — assigning it
   * onward, logging it, putting it in an object, passing it to a second
   * function — changes one of those lines or adds a fourth, and fails here.
   * A multi-line expression that split `raw` across lines could in principle
   * evade the enumeration, which is why the count is pinned too: a fourth line
   * fails whatever it says.
   */
  it('`phone_e164` is read only into `raw`, and only inside wrapDialableNumber(raw)', () => {
    const readSeam = body(READ_SEAM);

    // The wrap happens in the reading expression.
    expect(readSeam).toContain('wrapDialableNumber(raw)');

    // Every CODE line naming the column is either the declared column list or
    // the single read into `raw`. Nothing else may touch it.
    const columnLines = readSeam
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('phone_e164'));
    expect(columnLines.length, 'the column is named nowhere — extractor is vacuous')
      .toBeGreaterThanOrEqual(2);
    for (const line of columnLines) {
      const ok = /^const [A-Z][A-Z0-9_]*_COLUMNS =$/.test(line)
        || /^const [A-Z][A-Z0-9_]*_COLUMNS = '[^']*';$/.test(line)
        || /^'[^']*';$/.test(line)
        || line === 'const raw = row.phone_e164;';
      expect(ok, `read.ts uses phone_e164 in an unexpected form: ${line}`).toBe(true);
    }

    // Every CODE line naming `raw` is one of exactly three forms, and there are
    // exactly three of them.
    const rawLines = readSeam
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\braw\b/.test(l));
    const EXPECTED_RAW_FORMS = [
      "const raw = row.phone_e164;",
      "if (typeof raw !== 'string') continue;",
      'out.set(id, wrapDialableNumber(raw));',
    ];
    expect(rawLines.sort()).toEqual([...EXPECTED_RAW_FORMS].sort());
    expect(rawLines.length, 'raw appears on an unexpected number of lines').toBe(3);
  });

  it('the wrapped type, not the string, is what the seam returns', () => {
    const readSeam = body(READ_SEAM);
    // The map the reader hands back is typed in the OPAQUE wrapper, so a caller
    // that wanted the bare string would have to unwrap it somewhere this test
    // can see. A `Map<string, string>` would be the tell that it did not.
    expect(readSeam).toMatch(/ReadonlyMap<string,\s*DialableNumber>/);
    expect(readSeam).toMatch(/new Map<string,\s*DialableNumber>\(\)/);
  });

  it('no file in the package unwraps a dialable number', () => {
    // The wrapper is only a boundary while nothing on this side reverses it.
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} unwraps a dialable number`)
        .not.toMatch(/unwrapDialableNumber|\.value\b|revealDialableNumber/);
    }
  });
});

describe('4. no logger, no console', () => {
  it('runtime.ts is the ONLY file that mentions a logger', () => {
    // runtime.ts constructs one legitimately: queue-event metadata for an
    // unrecognised event has to go somewhere, and that record carries no
    // candidate field. Every other file in the package is downstream of a value
    // that must never be rendered, so none of them may hold the thing that
    // renders. Asserted as an exact set, so the exemption cannot spread.
    const withLogger = MODULE_FILES
      .filter((f) => /logger/i.test(code(f.source)))
      .map((f) => f.name);
    expect(withLogger).toEqual([LOGGER_FILE]);
  });

  it('no file writes to the console', () => {
    // `console` bypasses the logger's redaction entirely, so it is banned
    // everywhere including the file that is allowed a logger.
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} writes to the console`).not.toMatch(/console\.\w+\(/);
    }
  });
});

describe('5. every thrown error is a bare stable code', () => {
  it('no error argument interpolates anything', () => {
    // A PostgREST error carries the failing statement and can carry row values;
    // a template literal in an error message is the shortest path from a
    // subscriber number to an error tracker. The message must be a stable code
    // and nothing else — no interpolation, no template literal, no concatenation.
    let seen = 0;
    for (const { name, source } of MODULE_FILES) {
      for (const m of code(source).matchAll(/new Error\(([^)]*)\)/g)) {
        seen += 1;
        expect(m[1].trim(), `${name} throws a non-literal error`).toMatch(/^'[a-z0-9_]+'$/);
      }
    }
    // Fail closed: a package that threw nothing would pass the loop above.
    expect(seen, 'no thrown errors found — the sweep is vacuous').toBeGreaterThanOrEqual(5);
  });

  it('no file attaches an error cause', () => {
    // `cause:` smuggles the raw driver error — statement text and all — past
    // the bare-code rule above.
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} attaches an error cause`).not.toMatch(/\bcause:/);
    }
  });
});

describe('6. no dialable literal', () => {
  it('no file carries a dialable Indian mobile, or any +91 literal at all', () => {
    // The bar is the substrate's own gate, `^\+91[6-9][0-9]{9}$`. India
    // publishes no reserved documentation range — there is no +1-555
    // equivalent — so the only safe committed literal is none, and the second
    // assertion is the stricter one on purpose.
    for (const { name, source } of MODULE_FILES) {
      expect(source, `${name} carries a dialable +91 literal`).not.toMatch(/\+91[6-9]\d{9}/);
      expect(source, `${name} carries a +91 literal`).not.toMatch(/\+91\d/);
    }
  });

  it('every UUID literal is the all-zero sentinel', () => {
    // A UUID's last group is twelve hex characters and can be all digits, so a
    // real one would read as a plausible identifier for a real person. The
    // documented system sentinel is the only one that may be committed.
    for (const { name, source } of MODULE_FILES) {
      const uuids = [...code(source).matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g)]
        .map((m) => m[0]);
      for (const uuid of uuids) {
        expect(uuid, `${name} carries a non-sentinel UUID`)
          .toBe('00000000-0000-0000-0000-000000000000');
      }
    }
  });
});

describe('7. timers live only where they belong', () => {
  it('no file arms a timer directly', () => {
    // The cadence comes from `lib/scheduler.ts` and the heartbeat from
    // `lib/queue/runner.ts`. Both are supervised: they are registered, they can
    // be stopped, and their liveness is observable. A `setInterval` here would
    // be a second, UNMANAGED timer that no shutdown path knows to clear and no
    // health view knows to report — it would keep firing after the runtime was
    // told to stop.
    for (const verb of ['setInterval', 'setTimeout', 'setImmediate']) {
      for (const { name, source } of MODULE_FILES) {
        expect(code(source), `${name} calls ${verb}(`).not.toContain(`${verb}(`);
      }
    }
  });

  it('the supervised cadence sources are the ones actually used', () => {
    // The negative above is only meaningful if the cadence comes from
    // somewhere. If neither supervised source were imported, "no timer here"
    // would be true of a package that simply never runs.
    const importsScheduler = MODULE_FILES.some((f) => /scheduler\.js/.test(code(f.source)));
    const importsRunner = MODULE_FILES.some((f) => /queue\/runner\.js/.test(code(f.source)));
    expect(importsScheduler || importsRunner, 'no supervised cadence source is imported')
      .toBe(true);
  });
});

describe('8. the SDK is lazy', () => {
  it('livekit-server-sdk is never statically imported', () => {
    // A static import pulls the SDK — and its transitive network stack — into
    // every process that touches this barrel, including request handlers and
    // tests that never dial. Behind `await import(` it is loaded only on the
    // path that actually needs a room client.
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} statically imports the SDK`)
        .not.toMatch(/^\s*import\s[^;]*from\s+['"]livekit-server-sdk['"]/m);
      expect(code(source), `${name} statically imports the SDK`)
        .not.toMatch(/^\s*import\s+['"]livekit-server-sdk['"]/m);
    }
  });

  it('every mention of the SDK is inside an `await import(`', () => {
    let seen = 0;
    for (const { name, source } of MODULE_FILES) {
      const lines = code(source).split('\n').filter((l) => l.includes('livekit-server-sdk'));
      for (const line of lines) {
        seen += 1;
        expect(line, `${name} names the SDK outside a dynamic import`)
          .toMatch(/await import\(\s*['"]livekit-server-sdk['"]\s*\)/);
      }
    }
    // Fail closed: a package that never named the SDK would pass the loop.
    expect(seen, 'the SDK is never mentioned — the sweep is vacuous').toBeGreaterThanOrEqual(1);
  });
});

describe('9. reads are column-explicit and bounded', () => {
  it('the read seam never selects a star', () => {
    const readSeam = body(READ_SEAM);
    expect(readSeam, "read.ts uses select('*')").not.toContain("select('*')");
    expect(readSeam, 'read.ts uses select("*")').not.toContain('select("*")');
  });

  it('every `.select(` argument is a declared, star-free column constant', () => {
    // Two assertions, not one. Asserting that the `.select(` ARGUMENTS contain
    // no asterisk asserts nothing at all — they are identifiers, and
    // `const X_COLUMNS = '*'` would sail straight through. So: every declared
    // list is checked for a star, AND every `.select(` argument is checked to
    // be one of those declared identifiers, which is what stops an inline
    // `select('*')` being added beside them.
    const readSeam = body(READ_SEAM);
    const { lists: declared, malformed } = columnConstants(readSeam);
    expect(malformed, 'a column list is not a single plain literal').toEqual([]);
    expect(declared.size, 'no column constants found — the sweep is vacuous')
      .toBeGreaterThanOrEqual(5);
    for (const [name, list] of declared) {
      expect(list, `${name} is a star select`).not.toContain('*');
      expect(list.length, `${name} is empty`).toBeGreaterThan(0);
    }

    const selects = [...readSeam.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(selects.length, 'no selects found — the sweep is vacuous').toBeGreaterThanOrEqual(5);
    for (const arg of selects) {
      expect(declared.has(arg), `read.ts selects ${arg}, not a declared column list`).toBe(true);
    }
  });

  it('every table read is bounded by a `.limit(`', () => {
    // An unbounded read on `phone_engagements` or `candidates` is a table scan
    // that also lands every matching row in process memory — including, on the
    // candidates read, every subscriber number in the filter set.
    const readSeam = body(READ_SEAM);
    const froms = [...readSeam.matchAll(/\.from\(/g)].length;
    const limits = [...readSeam.matchAll(/\.limit\(/g)].length;
    expect(froms, 'no table reads found — the sweep is vacuous').toBeGreaterThanOrEqual(1);
    expect(limits, `${froms} .from( but only ${limits} .limit(`).toBeGreaterThanOrEqual(froms);
  });
});

describe('10. no write from the read seam', () => {
  it('read.ts performs no table write', () => {
    // The read seam holds a client, which is the whole capability. Nothing but
    // the name of the file stops it writing, so the name is backed up here:
    // every phone write in this lane goes through an RPC that carries 0042's
    // advisory lock, budgets and uniqueness index, and a direct write from here
    // would satisfy every type in the repository while bypassing all of them.
    const readSeam = body(READ_SEAM);
    for (const verb of ['insert', 'update', 'upsert', 'delete']) {
      expect(readSeam, `read.ts performs a .${verb}()`).not.toMatch(
        new RegExp(String.raw`\.\s*${verb}\s*\(`),
      );
    }
  });

  it('read.ts calls no rpc either', () => {
    // An RPC name is a mutation the read seam could invoke without ever writing
    // a table. The seam reads; it does not command.
    expect(body(READ_SEAM), 'read.ts calls an rpc').not.toMatch(/\.\s*rpc\s*\(/);
  });
});

describe('11. CONTROLS — the extractors above are not vacuous', () => {
  it('CONTROL: the file sweep actually found files', () => {
    // Every rule in this suite is a `for` over MODULE_FILES. If the directory
    // moved or the filter stopped matching, all of them would pass while
    // asserting nothing. This is the assertion that would fail instead.
    expect(MODULE_FILES.length).toBe(8);
    expect(MODULE_FILES.every((f) => f.source.length > 0)).toBe(true);
  });

  it('CONTROL: code() really removes a comment that names a forbidden thing', () => {
    // The comment-stripping is what lets a header say "no file here may call
    // setInterval" without that sentence tripping the setInterval rule. If
    // code() silently stopped stripping, several rules would start failing
    // loudly — but if it stripped TOO MUCH, they would start passing silently.
    // Both directions are asserted.
    const sample = [
      '/**',
      ' * setInterval( and phone_e164 and console.log( and livekit-server-sdk',
      ' */',
      "const KEPT_COLUMNS = 'id,state';",
      '// logger and setTimeout( and +919876543210',
      'const kept = wrapDialableNumber(raw);',
    ].join('\n');
    const stripped = code(sample);

    // Removed: everything that lived inside a comment.
    expect(stripped).not.toContain('setInterval(');
    expect(stripped).not.toContain('phone_e164');
    expect(stripped).not.toContain('console.log(');
    expect(stripped).not.toContain('livekit-server-sdk');
    expect(stripped).not.toMatch(/logger/i);
    expect(stripped).not.toContain('setTimeout(');
    expect(stripped).not.toMatch(/\+91[6-9]\d{9}/);

    // Kept: the code between the comments. A stripper that ate this would make
    // every negative assertion in the suite trivially true.
    expect(stripped).toContain("const KEPT_COLUMNS = 'id,state';");
    expect(stripped).toContain('wrapDialableNumber(raw)');
  });

  it('CONTROL: columnConstants() rejects a computed initializer', () => {
    // The malformed list is the guard against `A + B`, where a star check on
    // the first literal would report a clean list while the second half named
    // anything at all. Proving the guard fires is what makes `malformed` being
    // empty in rule 9 mean something.
    const good = columnConstants("const A_COLUMNS = 'id,state';");
    expect(good.malformed).toEqual([]);
    expect(good.lists.get('A_COLUMNS')).toBe('id,state');

    const bad = columnConstants("const B_COLUMNS = 'id' + ',phone_e164';");
    expect(bad.malformed.length).toBe(1);
    expect(bad.lists.size).toBe(0);

    const star = columnConstants("const C_COLUMNS = '*';");
    expect(star.lists.get('C_COLUMNS')).toBe('*');
  });

  it('CONTROL: the `raw` line extractor finds lines in the real seam', () => {
    // Rule 3 asserts every `raw` line is one of three forms. If the extractor
    // found NO lines, that assertion would be an empty set comparison against
    // an empty set — green, and meaningless. It finds exactly three.
    const rawLines = body(READ_SEAM)
      .split('\n')
      .filter((l) => /\braw\b/.test(l));
    expect(rawLines.length).toBe(3);
  });
});
