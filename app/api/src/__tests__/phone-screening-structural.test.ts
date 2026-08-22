/**
 * Structural boundaries for `lib/phone-screening/**`.
 *
 * Every claim in this module's documentation that takes the form "it cannot"
 * is asserted HERE, over the source text, because "we won't" is not a control
 * and "it cannot compile / cannot pass CI" is. Four families:
 *
 *   1. NO WRITE MAY BYPASS AN RPC. Bypass does not need a provider import —
 *      `client.from('phone_call_attempts').insert(...)` or a direct
 *      `job_queue` insert would do it, and 0042's guarantees live entirely
 *      inside the RPCs.
 *   2. NO PROVIDER, NO DIALING, NO NETWORK, NO ASHBY MUTATION.
 *   3. NO PHONE-BEARING FIELD REACHES A LOGGER, A METADATA OBJECT OR AN ERROR
 *      — asserted at the CALL SITE. The rendered-output check is a backstop
 *      only, and is labelled as one, because `logger.ts` redacts any run of
 *      ten or more digits and would make an output-only test pass even if the
 *      code handed it the number.
 *   4. MUTUAL INDEPENDENCE from the resume-phone-number lane.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = fileURLToPath(new URL('../lib/phone-screening/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('./', import.meta.url));

function readModuleFiles(): Array<{ name: string; source: string }> {
  const names = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts')).sort();
  if (names.length === 0) throw new Error('phone-screening module is empty');
  return names.map((name) => ({
    name,
    source: readFileSync(path.join(MODULE_DIR, name), 'utf8'),
  }));
}

const MODULE_FILES = readModuleFiles();

/** Source with block and line comments removed — for call-site assertions. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `.ts` file under `src/`, excluding the test tree. */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.resolve(full) === path.resolve(TESTS_DIR)) continue;
      out.push(...allSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('1. every phone write goes through an RPC', () => {
  it('no module touches a phone table or the job queue directly', () => {
    for (const { name, source } of MODULE_FILES) {
      const body = code(source);
      expect(body, `${name} reaches a phone table directly`).not.toMatch(/\.from\(\s*['"`]phone_/);
      expect(body, `${name} reaches the job queue directly`)
        .not.toMatch(/\.from\(\s*['"`]job_queue/);
      // Nor any other table: the ports interface exposes no table accessor at
      // all, so a `.from(` here would be a capability the seam denies.
      expect(body, `${name} uses a table accessor`).not.toMatch(/\bclient\s*\.\s*from\s*\(/);
    }
  });

  it('only stores.ts holds a client, and it only calls .rpc', () => {
    for (const { name, source } of MODULE_FILES) {
      if (name === 'stores.ts') continue;
      expect(code(source), `${name} imports a supabase client`)
        .not.toMatch(/@supabase\/supabase-js/);
      expect(code(source), `${name} imports the process-wide client`)
        .not.toMatch(/from ['"][^'"]*\/supabase\.js['"]/);
    }
    const stores = MODULE_FILES.find((f) => f.name === 'stores.ts');
    expect(stores).toBeDefined();
    const rpcCalls = [...code(stores!.source).matchAll(/client\.rpc\(\s*'([a-z_]+)'/g)]
      .map((m) => m[1]);
    expect(new Set(rpcCalls).size).toBe(10);
    // A type-only import of the client type is fine; a VALUE import is not.
    expect(code(stores!.source)).toMatch(/import type \{ SupabaseClient \}/);
  });

  it('no module re-declares a vocabulary that vocabulary.ts owns', () => {
    // The drift test compares `vocabulary.ts` against 0042. A SECOND,
    // hand-copied list elsewhere would sit outside that comparison, and its
    // failure mode is silent: the parsers DROP a value they do not recognise,
    // so a missing member makes a field vanish rather than raise. One
    // definition, imported everywhere.
    const OWNED = [
      "'pending_prereqs'", "'answered_unclassified'", "'no_answer_retry'",
      "'stale_epoch'", "'system_deferral'", "'operator_pause'",
    ];
    for (const { name, source } of MODULE_FILES) {
      if (name === 'vocabulary.ts') continue;
      for (const literal of OWNED) {
        expect(code(source), `${name} re-declares ${literal}`).not.toContain(literal);
      }
    }
  });

  it('nothing constructs a supabase client', () => {
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} constructs a client`).not.toContain('createClient');
    }
  });
});

describe('2. no provider, no dialing, no network, no Ashby mutation', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['SIP', /\bSIP\b|createSipParticipant|CreateSIPParticipant|sipTrunk/i],
    ['LiveKit SDK', /livekit-server-sdk|RoomServiceClient|AccessToken/],
    ['a provider name', /\bplivo\b|\btwilio\b|\bexotel\b|\bknowlarity\b/i],
    ['network access', /\bfetch\(|node:https?\b|from ['"]https?['"]|axios|undici|got\(/],
    ['a socket', /node:net\b|node:dgram\b|node:tls\b/],
    ['a child process', /node:child_process/],
    ['a timer', /setInterval\(|setTimeout\(|setImmediate\(/],
    ['an Ashby module', /integrations\/ashby/],
    ['a stage move or scorecard write', /stage_move|scorecard|advance_ashby|ashby_operations/i],
    ['email delivery', /sendMail|nodemailer|invite-delivery/i],
    ['the dead 0001 schema', /call_queue|sms_follow_ups/],
  ];

  for (const [label, pattern] of FORBIDDEN) {
    it(`no module references ${label}`, () => {
      for (const { name, source } of MODULE_FILES) {
        expect(code(source), `${name} references ${label}`).not.toMatch(pattern);
      }
    });
  }

  it('the module imports nothing outside itself but the supabase TYPE', () => {
    for (const { name, source } of MODULE_FILES) {
      const imports = [...code(source).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        const ok = spec.startsWith('./') || spec === '@supabase/supabase-js';
        expect(ok, `${name} imports ${spec}`).toBe(true);
      }
    }
  });

  it('nothing in the repository imports this module yet', () => {
    // P2 is a domain core. Wiring it into a route, a worker or the composition
    // root is a later phase's decision, and an unnoticed import would make a
    // dormant module live.
    for (const file of allSourceFiles(SRC_DIR)) {
      if (file.startsWith(MODULE_DIR)) continue;
      // Match an IMPORT SPECIFIER, not the words: `phone-screening` also
      // appears in ordinary English inside a scoring prompt.
      expect(readFileSync(file, 'utf8'), `${file} imports phone-screening`)
        .not.toMatch(/from\s+['"][^'"]*phone-screening[^'"]*['"]/);
    }
  });
});

describe('3. no phone-bearing field reaches a logger, metadata or an error', () => {
  /** Identifiers that would carry, or could carry, a subscriber number. */
  const PHONE_BEARING = [
    'phone_e164', 'phoneE164', 'phone_raw', 'phoneRaw', 'phoneNumber', 'phone_number',
    'e164', 'msisdn', 'callerId', 'caller_id', 'toNumber', 'fromNumber',
  ];

  it('the module never names a phone-bearing field at all', () => {
    for (const { name, source } of MODULE_FILES) {
      const body = code(source);
      for (const field of PHONE_BEARING) {
        // The one legitimate mention is the SQL column admission reads INSIDE
        // the database, which appears only in a comment — stripped above.
        expect(body, `${name} names ${field}`).not.toContain(field);
      }
    }
  });

  it('the module makes no logger call at all', () => {
    // Call-site assertion, not an output one. A structural absence is the
    // control; see the backstop below for why an output test cannot be.
    for (const { name, source } of MODULE_FILES) {
      const body = code(source);
      expect(body, `${name} imports a logger`).not.toMatch(/logger/i);
      expect(body, `${name} writes to the console`).not.toMatch(/console\.\w+\(/);
    }
  });

  it('every thrown error message is a bare stable code with no interpolation', () => {
    for (const { name, source } of MODULE_FILES) {
      for (const m of code(source).matchAll(/new Error\(([^)]*)\)/g)) {
        const arg = m[1].trim();
        expect(arg, `${name} throws a non-literal error`).toMatch(/^'[a-z0-9_:]+'$/);
      }
      // No `cause`, which would smuggle the raw driver error through.
      expect(code(source), `${name} attaches an error cause`).not.toMatch(/\bcause:\s/);
    }
  });

  it('BACKSTOP ONLY — a rendered log line would also be redacted', () => {
    // Deliberately labelled. `logger.ts` drops any string value containing ten
    // or more consecutive digits, so a test that renders a line and greps for
    // a number PASSES EVEN IF the code handed the number straight to the
    // logger. That is why the real controls are the two call-site assertions
    // above, and why this one asserts a property of the LOGGER, not of this
    // module.
    const loggerSource = readFileSync(path.join(SRC_DIR, 'lib/logger.ts'), 'utf8');
    expect(loggerSource).toContain("'|\\\\d{10,}'");
  });

  it('no committed literal anywhere in this lane is a DIALABLE Indian mobile', () => {
    // The bar is the substrate's own gate, `^\\+91[6-9][0-9]{9}$`, applied to the
    // module AND to its tests — the tree the module-only guard below cannot
    // reach, and the one where a plausible-looking fixture would actually be
    // written. India publishes no reserved documentation range, so the only
    // safe committed literal is one 0042 would itself refuse.
    const DIALABLE = /\+91[6-9]\d{9}/;
    const laneFiles = [
      ...MODULE_FILES.map((f) => ({ name: f.name, source: f.source })),
      ...readdirSync(TESTS_DIR)
        .filter((f) => f.startsWith('phone-screening-') && f.endsWith('.ts'))
        .map((f) => ({ name: f, source: readFileSync(path.join(TESTS_DIR, f), 'utf8') })),
      {
        name: 'support/phone-migration.ts',
        source: readFileSync(path.join(TESTS_DIR, 'support/phone-migration.ts'), 'utf8'),
      },
    ];
    // Fail closed: an empty sweep would make this assertion vacuous.
    expect(laneFiles.length).toBeGreaterThanOrEqual(18);
    for (const { name, source } of laneFiles) {
      expect(source, `${name} carries a dialable +91 literal`).not.toMatch(DIALABLE);
    }
  });

  it('no synthetic fixture value resembling a real subscriber number is stored here', () => {
    // India publishes NO reserved documentation range — there is no +1-555
    // equivalent — so fixtures live only in ephemeral test containers, and the
    // domain module carries none at all.
    for (const { name, source } of MODULE_FILES) {
      expect(source, `${name} carries a +91 literal`).not.toMatch(/\+91\d/);
      // A UUID's last group is twelve hex characters and can be all digits, so
      // the all-zero system sentinel would trip a naive digit-run scan. Strip
      // UUID-shaped literals first, then assert BOTH that no other long digit
      // run survives AND that every UUID present is the documented sentinel.
      const uuids = [...code(source).matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g)]
        .map((m) => m[0]);
      for (const uuid of uuids) {
        expect(uuid, `${name} carries a non-sentinel UUID`)
          .toBe('00000000-0000-0000-0000-000000000000');
      }
      const withoutUuids = code(source)
        .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '<uuid>');
      expect(withoutUuids, `${name} carries a long digit run`).not.toMatch(/\d{10,}/);
    }
  });
});

describe('4. mutual independence from the resume phone-number lane', () => {
  it('this module does not import lib/phone.ts, nor libphonenumber', () => {
    for (const { name, source } of MODULE_FILES) {
      const body = code(source);
      expect(body, `${name} imports lib/phone.ts`).not.toMatch(/from ['"][^'"]*\/phone\.js['"]/);
      expect(body, `${name} imports libphonenumber`).not.toContain('libphonenumber');
      expect(body, `${name} calls normalizePhone`).not.toContain('normalizePhone');
    }
  });

  it('nothing outside this module has grown a dependency on it', () => {
    // The two lanes are independent by construction: P2 is database-mocked and
    // must not depend on a validated number shipping, and that lane must not
    // import anything from here.
    const phoneTs = readFileSync(path.join(SRC_DIR, 'lib/phone.ts'), 'utf8');
    expect(phoneTs).not.toMatch(/from\s+['"][^'"]*phone-screening[^'"]*['"]/);
  });

  it('the directory name cannot be confused with the existing lib/phone.ts', () => {
    // `moduleResolution: "Bundler"` would resolve an extensionless
    // `'../lib/phone'` to the FILE, silently. A distinct directory name means
    // there is nothing to confuse.
    expect(MODULE_DIR).toContain('phone-screening');
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} uses an extensionless relative import`)
        .not.toMatch(/from\s+['"]\.[^'"]*(?<!\.js)['"]/);
    }
  });
});
