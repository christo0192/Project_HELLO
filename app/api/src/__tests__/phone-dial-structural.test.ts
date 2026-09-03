/**
 * Structural boundaries for `integrations/livekit-phone-dial/**`.
 *
 * `livekit-phone` (the ingress) has its own structural suite asserting nothing
 * under it can dial. This is the mirror for the one directory that IS allowed
 * to reach a carrier, and every "it cannot" in the dialer's documentation is
 * asserted here over the source text — because "we won't" is not a control.
 *
 * The four properties, and why each is structural rather than conditional:
 *
 *   * THE SYNTHETIC CLIENT CANNOT REACH THE SDK. Not "is configured not to":
 *     its body names no SDK symbol, so `synthetic` mode is a code path from
 *     which a carrier is unreachable. A boolean guard inside one shared client
 *     is one refactor away from being inverted; an absent import is not.
 *   * THE SDK IS NAMED ONLY LAZILY. A static import would drag the SDK into
 *     `app.ts`'s module graph and break every suite that partially mocks it.
 *   * NO PHONE-BEARING IDENTIFIER AT A CALL SITE, bar a documented handful.
 *   * ASK FIRST, RECORD SECOND — asserted on the ORDER OF THE TWO CALLS.
 *
 * ── THE EXTRACTOR IS PART OF THE CONTROL ──────────────────────────────
 * Every assertion below runs over comment-stripped source, and a stripper that
 * silently eats real code turns every `not.toContain` green for the wrong
 * reason. This lane has been bitten by exactly that: the ingress route passes
 * `express.raw` the MIME wildcard as a string literal, whose leading slash-star
 * reads to a regex stripper as a BLOCK-COMMENT OPENER and deletes the handler.
 * So the mask is carried here too, and §1 proves the hazard is real, proves the
 * mask defeats it, and proves the stripper leaves this directory's real code
 * standing.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = fileURLToPath(new URL('../integrations/livekit-phone-dial/', import.meta.url));

interface SourceFile {
  readonly name: string;
  readonly source: string;
}

function readModuleFiles(): SourceFile[] {
  const names = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts')).sort();
  if (names.length === 0) throw new Error('livekit-phone-dial module is empty');
  return names.map((name) => ({
    name,
    source: readFileSync(path.join(MODULE_DIR, name), 'utf8'),
  }));
}

const FILES = readModuleFiles();
const file = (name: string): SourceFile => {
  const found = FILES.find((f) => f.name === name);
  if (found === undefined) throw new Error(`missing file ${name}`);
  return found;
};

const WILDCARD_MIME_MASK = '__WILDCARD_MIME__';

/** Comment-stripped source, with the block-comment-opening MIME literal masked. */
function code(source: string): string {
  return source
    .split("'*/*'").join(`'${WILDCARD_MIME_MASK}'`)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The naive stripper, kept only so §1 can show what it costs. */
function naive(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Extract one top-level function body by brace matching over stripped source.
 * Returns the text BETWEEN the outermost braces, so a reference in the
 * function's own doc comment or signature cannot satisfy an assertion about
 * what the body does.
 */
function functionBody(source: string, declaration: string): string {
  const body = code(source);
  const start = body.indexOf(declaration);
  if (start === -1) throw new Error(`declaration not found: ${declaration}`);
  const open = body.indexOf('{', start + declaration.length - 1);
  if (open === -1) throw new Error(`no body for: ${declaration}`);
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced body for: ${declaration}`);
}

const SYNTHETIC_DECL = 'export function createSyntheticSipClient(): PhoneSipClient {';
const LIVE_DECL = 'export function createLiveSipClient(';

// ═══════════════════════════════════════════════════════════════════════
// 1. THE SUITE IS NOT VACUOUS — the files exist and the stripper is honest.
// ═══════════════════════════════════════════════════════════════════════

describe('1. the module exists and the extractor does not swallow code', () => {
  it('reads every dialer file', () => {
    expect(FILES.map((f) => f.name)).toEqual([
      'config.ts',
      'dial.ts',
      'dialable-number.ts',
      'egress-output.ts',
      'index.ts',
      'phone-room.ts',
      'recording-purge.ts',
      'recording.ts',
      'sip.ts',
      'worker-recording.ts',
    ]);
  });

  it('control: no file strips to nothing, and each keeps a known marker', () => {
    // A `not.toContain` over an empty string passes for free. Two independent
    // witnesses: a size floor, and a marker that must SURVIVE the stripper.
    const markers: Record<string, string> = {
      'config.ts': 'export function loadPhoneDialConfig(',
      'dial.ts': 'export async function dialPhoneAttempt(',
      'dialable-number.ts': 'export function wrapDialableNumber(',
      'egress-output.ts': 'export async function createPhoneEgressOutput(',
      'index.ts': "} from './sip.js';",
      'phone-room.ts': 'export async function provisionPhoneRoom(',
      'recording-purge.ts': 'export async function purgePhoneEngagementRecordings(',
      'recording.ts': 'export async function startPhoneAttemptRecording(',
      'sip.ts': SYNTHETIC_DECL,
      'worker-recording.ts': 'export async function prepareWorkerRecording(',
    };
    for (const { name, source } of FILES) {
      const body = code(source);
      expect(body.trim().length, `${name} stripped to nothing`).toBeGreaterThan(200);
      expect(body, `${name} lost its marker to the stripper`).toContain(markers[name]);
    }
  });

  it('control: the wildcard mask is load-bearing, not decorative', () => {
    // The hazard is not hypothetical — it cost this lane a whole suite of
    // vacuously-green `not.toContain`s once. Proven on a seeded sample so the
    // control keeps biting even though this directory carries no such literal
    // today, which is exactly when a future one would slip in unnoticed.
    const seeded = [
      "const mime = '*/*';",
      "export function handler() { return dialTheNumber(); }",
      '/* a real comment */',
      "const after = 'still here';",
    ].join('\n');

    expect(naive(seeded), 'the naive stripper is no longer hazardous — revisit this control')
      .not.toContain('dialTheNumber');
    expect(code(seeded)).toContain('dialTheNumber');
    expect(code(seeded)).toContain("const after = 'still here';");
    expect(code(seeded)).not.toContain('a real comment');
  });

  it('control: the function-body extractor returns a body, not a whole file', () => {
    const synthetic = functionBody(file('sip.ts').source, SYNTHETIC_DECL);
    const live = functionBody(file('sip.ts').source, LIVE_DECL);

    // Non-empty, plausibly sized, and DISJOINT — if the matcher over-ran, the
    // synthetic body would contain the live one.
    expect(synthetic.trim().length).toBeGreaterThan(100);
    expect(live.trim().length).toBeGreaterThan(100);
    expect(synthetic).toContain("mode: 'synthetic'");
    expect(live).toContain("mode: 'live'");
    expect(synthetic).not.toContain("mode: 'live'");
    expect(live).not.toContain("mode: 'synthetic'");
    expect(synthetic.length).toBeLessThan(code(file('sip.ts').source).length);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. THE SYNTHETIC CLIENT CANNOT REACH THE SDK.
// ═══════════════════════════════════════════════════════════════════════

describe('2. the synthetic client contains no path to a carrier', () => {
  const SDK_MODULE = 'livekit-server-sdk';
  // `PhoneSipClient` contains `SipClient` as a substring, so the class name
  // must be matched with a left boundary or the assertion would be
  // unsatisfiable — green only because it could never be written.
  const SDK_CLASS = /(?<![A-Za-z])SipClient\b/;

  it("createSyntheticSipClient's body names no SDK module, class or dynamic import", () => {
    const body = functionBody(file('sip.ts').source, SYNTHETIC_DECL);

    expect(body, 'the synthetic body names the SDK module').not.toContain(SDK_MODULE);
    expect(body, 'the synthetic body names SipClient').not.toMatch(SDK_CLASS);
    expect(body, 'the synthetic body performs a dynamic import').not.toContain('import(');
    expect(body).not.toContain('require(');
    // Nor does it reach a network by any other route.
    expect(body).not.toMatch(/\bfetch\(|new WebSocket|https?:\/\//);
  });

  it('NEGATIVE CONTROL: the SAME extractor finds the SDK in createLiveSipClient', () => {
    // Without this, the three assertions above would pass identically if
    // `functionBody` returned an empty string, or if it silently matched the
    // wrong declaration, or if the patterns themselves were broken.
    const live = functionBody(file('sip.ts').source, LIVE_DECL);

    expect(live).toContain(SDK_MODULE);
    expect(live).toMatch(SDK_CLASS);
    expect(live).toContain('import(');
    // And the exact call the synthetic body must not have.
    expect(live).toContain("await import('livekit-server-sdk')");
  });

  it('the two clients are the only implementations, and the selector is the only chooser', () => {
    const sip = code(file('sip.ts').source);
    const factories = [...sip.matchAll(/export function (create\w*SipClient)/g)].map((m) => m[1]);
    expect(factories.sort()).toEqual(['createLiveSipClient', 'createSyntheticSipClient']);
    // `createLiveSipClient` is referenced in exactly one place other than its
    // own declaration: the selector's default. A second caller would be a
    // second way to reach a carrier.
    const liveRefs = [...sip.matchAll(/createLiveSipClient/g)].length;
    expect(liveRefs).toBe(2);
    expect(sip).toContain('const makeLive = deps.live ?? createLiveSipClient;');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. THE SDK IS NAMED ONLY VIA `await import(...)`, NOWHERE STATICALLY.
// ═══════════════════════════════════════════════════════════════════════

describe('3. the LiveKit SDK is reached lazily or not at all', () => {
  const SDK_MODULE = 'livekit-server-sdk';
  const LAZY = /await import\('livekit-server-sdk'\)/g;

  it('no dialer file statically imports the SDK, in any form', () => {
    for (const { name, source } of FILES) {
      const body = code(source);
      // Named, default and namespace forms all begin the same way.
      expect(body, `${name} statically imports the SDK`)
        .not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'livekit-server-sdk'/m);
      // A bare side-effect import would still pull it into the graph.
      expect(body, `${name} side-effect imports the SDK`)
        .not.toMatch(/^import\s+'livekit-server-sdk'/m);
      expect(body, `${name} re-exports the SDK`)
        .not.toMatch(/^export\s+[^;]*from\s+'livekit-server-sdk'/m);
    }
  });

  it('every mention of the SDK anywhere in the directory IS an await-import', () => {
    let totalMentions = 0;
    let totalLazy = 0;
    for (const { name, source } of FILES) {
      const body = code(source);
      const mentions = [...body.matchAll(/livekit-server-sdk/g)].length;
      const lazy = [...body.matchAll(LAZY)].length;
      expect(lazy, `${name} names the SDK outside an await-import`).toBe(mentions);
      totalMentions += mentions;
      totalLazy += lazy;
    }
    // Non-vacuity: the SDK IS reached somewhere in this directory, and every
    // mention of it is lazy. Asserted as a total AND pinned per file for the
    // originate seam, so the loop above cannot pass by finding nothing.
    expect(totalMentions).toBeGreaterThan(0);
    expect(totalMentions).toBe(totalLazy);
    const sipMentions = [...code(file('sip.ts').source).matchAll(/livekit-server-sdk/g)];
    expect(sipMentions, 'the originate seam names the SDK more than once').toHaveLength(1);
    expect(code(file('sip.ts').source)).toContain("await import('livekit-server-sdk')");
    // `recording.ts` owns the disclosure ordering and names NO SDK symbol at
    // all — the output descriptor is injected precisely so it does not have to.
    expect(code(file('recording.ts').source)).not.toContain('livekit-server-sdk');
  });

  it('NEGATIVE CONTROL: the static-import matchers bite on a seeded violation', () => {
    const seeded = [
      "import { SipClient } from 'livekit-server-sdk';",
      "import * as sdk from 'livekit-server-sdk';",
      "import sdk from 'livekit-server-sdk';",
      "import 'livekit-server-sdk';",
      "export { SipClient } from 'livekit-server-sdk';",
    ];
    const patterns = [
      /^import\s+(?!type\b)[^;]*from\s+'livekit-server-sdk'/m,
      /^import\s+'livekit-server-sdk'/m,
      /^export\s+[^;]*from\s+'livekit-server-sdk'/m,
    ];
    for (const line of seeded) {
      expect(patterns.some((p) => p.test(line)), `unmatched violation: ${line}`).toBe(true);
    }
    // And the lazy form is NOT caught by any of them, or the rule would be
    // "never name the SDK", which the live client could not satisfy.
    const lazyLine = "      const { SipClient } = await import('livekit-server-sdk');";
    expect(patterns.some((p) => p.test(lazyLine))).toBe(false);
    // A type-only import stays allowed, deliberately: it erases at compile time.
    expect(patterns.some((p) => p.test("import type { SipClient } from 'livekit-server-sdk';")))
      .toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. NO PHONE-BEARING IDENTIFIER, BAR A DOCUMENTED HANDFUL.
// ═══════════════════════════════════════════════════════════════════════

describe('4. the number is named in as few places as the dialer can manage', () => {
  const PHONE_BEARING = [
    'phone_e164', 'phoneE164', 'phoneNumber', 'e164',
    'msisdn', 'caller_id', 'toNumber', 'fromNumber',
  ];

  /** Case-insensitive so `PhoneNumber`, `E164` and `MSISDN` all count. */
  function scan(source: string): Array<{ line: string; token: string }> {
    const hits: Array<{ line: string; token: string }> = [];
    for (const line of code(source).split('\n')) {
      for (const token of PHONE_BEARING) {
        if (line.toLowerCase().includes(token.toLowerCase())) {
          hits.push({ line: line.trim(), token });
        }
      }
    }
    return hits;
  }

  /**
   * The complete, documented list of permitted occurrences. Each is here for a
   * stated reason and each must be present EXACTLY ONCE, so this allowlist
   * cannot rot into a set of dead entries that quietly permits anything.
   */
  const PERMITTED: Array<{ file: string; line: string; why: string }> = [
    {
      file: 'dialable-number.ts',
      line: "const DIGITS = Symbol('phone.e164');",
      why: 'the private brand — not exported, so no other module can read it',
    },
    {
      file: 'dialable-number.ts',
      line: 'const STRICT_IN_MOBILE_E164 = /^\\+91[6-9][0-9]{9}$/;',
      why: "0042's own dialability predicate, mirrored rather than re-invented",
    },
    {
      file: 'dialable-number.ts',
      line: "if (typeof raw !== 'string' || !STRICT_IN_MOBILE_E164.test(raw)) {",
      why: 'the guard that applies it',
    },
    {
      file: 'sip.ts',
      line: 'hidePhoneNumber: true,',
      why: 'the SDK option that SUPPRESSES the number in the room — it carries nothing',
    },
  ];

  it('every occurrence in the directory is one of the four documented ones', () => {
    for (const { name, source } of FILES) {
      for (const hit of scan(source)) {
        const permitted = PERMITTED.some((p) => p.file === name && p.line === hit.line);
        expect(
          permitted,
          `${name} names ${hit.token} at an undocumented site: ${hit.line}`,
        ).toBe(true);
      }
    }
  });

  it('and each documented occurrence still exists exactly once', () => {
    // A stale allowlist entry is a hole: it permits a line nobody checks any
    // more. Each entry must still be found, and found once.
    for (const entry of PERMITTED) {
      const lines = code(file(entry.file).source)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l === entry.line);
      expect(lines.length, `stale allowlist entry (${entry.why}): ${entry.line}`).toBe(1);
    }
    expect(PERMITTED).toHaveLength(4);
  });

  it('NEGATIVE CONTROL: the scanner catches a seeded phone-bearing call site', () => {
    const seeded = [
      'const phoneNumber = candidate.phone_e164;',
      'client.dial({ toNumber: row.e164, fromNumber: TRUNK_MSISDN });',
      'logger.info("dialing", { caller_id: n });',
      'const x = { phoneE164: raw };',
    ].join('\n');
    const hits = scan(seeded);
    expect(hits.length).toBeGreaterThan(4);
    // Every token in the list is reachable by the scanner — a token that could
    // never match would be a silent hole in the rule.
    for (const token of PHONE_BEARING) {
      expect(
        scan(`const probe = { ${token}: 1 };`).map((h) => h.token),
        `token ${token} is unmatchable`,
      ).toContain(token);
    }
    // And none of the seeded lines is on the allowlist.
    for (const hit of hits) {
      expect(PERMITTED.some((p) => p.line === hit.line)).toBe(false);
    }
  });

  it('the unwrap has exactly ONE call site in the whole directory, and it is the SDK call', () => {
    const callSites: Array<{ name: string; line: string }> = [];
    for (const { name, source } of FILES) {
      for (const line of code(source).split('\n')) {
        // The declaration and the type-free re-export are not call sites.
        if (!/unwrapDialableNumber\(/.test(line)) continue;
        if (/export function unwrapDialableNumber\(/.test(line)) continue;
        callSites.push({ name, line: line.trim() });
      }
    }
    expect(callSites).toEqual([
      { name: 'sip.ts', line: '? unwrapDialableNumber(request.target.number)' },
    ]);
    // And that call site sits inside the LIVE client, not the synthetic one.
    expect(functionBody(file('sip.ts').source, LIVE_DECL)).toContain('unwrapDialableNumber(');
    expect(functionBody(file('sip.ts').source, SYNTHETIC_DECL))
      .not.toContain('unwrapDialableNumber(');
  });

  it('no thrown error in the directory interpolates anything', () => {
    // A thrown message is the shortest path from a value to a log line. The
    // house rule is a bare code and nothing else.
    let thrown = 0;
    for (const { name, source } of FILES) {
      for (const [, message] of code(source).matchAll(/new Error\(([^)]*)\)/g)) {
        thrown += 1;
        expect(message, `${name} interpolates a thrown message`).not.toContain('${');
        expect(message.trim(), `${name} throws a non-literal`).toMatch(/^'[a-z0-9_]+'$/);
      }
    }
    // Non-vacuity: there IS at least one throw, so the loop ran.
    expect(thrown).toBeGreaterThan(0);
  });

  it('no committed literal in the directory is a dialable Indian mobile', () => {
    const STRICT_IN_MOBILE = /\+91[6-9][0-9]{9}/;
    for (const { name, source } of FILES) {
      for (const line of source.split('\n')) {
        expect(STRICT_IN_MOBILE.test(line), `${name} commits a dialable mobile: ${line.trim()}`)
          .toBe(false);
      }
    }
    // Non-vacuity: the scan bites on a real one and not on 0042-undialable
    // shapes, so the loop above is a claim and not a no-op.
    expect(STRICT_IN_MOBILE.test('+919876543210')).toBe(true);
    expect(STRICT_IN_MOBILE.test('+910000000000')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. NOTHING LOGS, AND NOTHING ARMS A TIMER.
// ═══════════════════════════════════════════════════════════════════════

describe('5. the dialer neither logs nor schedules', () => {
  const CONSOLE = /\bconsole\s*\.\s*[a-z]+\s*\(/;
  const LOGGER = /\blog(ger)?\s*\.\s*[a-z]+\s*\(/;
  const TIMER = /\b(setInterval|setTimeout|setImmediate)\s*\(/;

  it('no dialer file makes a console call', () => {
    for (const { name, source } of FILES) {
      expect(code(source), `${name} calls console`).not.toMatch(CONSOLE);
    }
  });

  it('no dialer file makes a logger call at all — so none can carry the number', () => {
    // The strongest available form of "no logger call carries the number":
    // there is no logger call. A per-call-site argument scan would have to
    // decide what a phone-bearing argument looks like, and a `DialableNumber`
    // passed to a logger renders `[redacted]` — which is exactly the kind of
    // "safe enough" reasoning this directory refuses to depend on.
    for (const { name, source } of FILES) {
      expect(code(source), `${name} calls a logger`).not.toMatch(LOGGER);
    }
  });

  it('no dialer file arms a timer', () => {
    // A timer in this directory would be a dial or an egress that outlives the
    // request that asked for it, with no lease and no observer.
    for (const { name, source } of FILES) {
      expect(code(source), `${name} arms a timer`).not.toMatch(TIMER);
    }
  });

  it('NEGATIVE CONTROL: all three matchers bite on seeded violations', () => {
    for (const seeded of [
      'console.log(number);',
      'console.error("boom");',
      '  console . warn ( x );',
    ]) expect(CONSOLE.test(seeded), `console matcher missed: ${seeded}`).toBe(true);

    for (const seeded of [
      'logger.info("dialing", { n });',
      'log.warn(number);',
      'deps.logger.error(e);',
    ]) expect(LOGGER.test(seeded), `logger matcher missed: ${seeded}`).toBe(true);

    for (const seeded of [
      'setInterval(sweep, 1000);',
      'setTimeout(() => {}, 5);',
      'setImmediate(run);',
      '  const t = setTimeout ( fn , 1 );',
    ]) expect(TIMER.test(seeded), `timer matcher missed: ${seeded}`).toBe(true);

    // And none of the three fires on ordinary dialer code, or the rules would
    // be unfalsifiable in the other direction.
    expect(CONSOLE.test('const info = await client.createSipParticipant(a, b, c, d);')).toBe(false);
    expect(LOGGER.test('const info = await client.createSipParticipant(a, b, c, d);')).toBe(false);
    expect(TIMER.test('const info = await client.createSipParticipant(a, b, c, d);')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. ASK FIRST, RECORD SECOND — asserted on the order of the two calls.
// ═══════════════════════════════════════════════════════════════════════

describe('6. recording.ts binds the keys before any audio is captured', () => {
  const ATTACH_CALL = 'deps.stores.attachAttemptRecording(';
  const EGRESS_CALL = 'deps.egress.startRoomCompositeEgress(';

  it('the attach CALL appears textually before the egress CALL', () => {
    const body = code(file('recording.ts').source);
    const attach = body.indexOf(ATTACH_CALL);
    const egress = body.indexOf(EGRESS_CALL);

    // Both present — an ordering assertion over two -1s would be trivially
    // satisfied and would survive the deletion of the gate entirely.
    expect(attach, 'the attach call is missing').toBeGreaterThan(-1);
    expect(egress, 'the egress call is missing').toBeGreaterThan(-1);
    expect(attach).toBeLessThan(egress);

    // CALL SITES, not the interface declaration. `startRoomCompositeEgress`
    // also appears in `PhoneEgressClientLike` at the top of the file, ABOVE
    // the attach call — so a matcher keyed on the bare method name would read
    // the order backwards and fail on correct code.
    expect(body.indexOf('startRoomCompositeEgress(')).toBeLessThan(attach);

    // Each call site occurs exactly once: a second egress call further down
    // would satisfy an `indexOf` comparison while recording twice.
    expect([...body.matchAll(/deps\.stores\.attachAttemptRecording\(/g)]).toHaveLength(1);
    expect([...body.matchAll(/deps\.egress\.startRoomCompositeEgress\(/g)]).toHaveLength(1);
  });

  it('and the egress sits after the refusal returns, not before them', () => {
    const body = code(file('recording.ts').source);
    const egress = body.indexOf(EGRESS_CALL);
    for (const refusal of ["refusal: 'role_undecidable'", "refusal: attached.status"]) {
      const at = body.indexOf(refusal);
      expect(at, `missing refusal ${refusal}`).toBeGreaterThan(-1);
      expect(at, `${refusal} is returned after the egress starts`).toBeLessThan(egress);
    }
  });

  it('NEGATIVE CONTROL: the ordering matcher fails on an inverted source', () => {
    // Without this, `toBeLessThan` between two indices proves nothing about
    // whether the comparison could ever have come out the other way.
    const inverted = [
      'const info = await deps.egress.startRoomCompositeEgress(room, out, opts);',
      'const attached = await deps.stores.attachAttemptRecording({ attemptId });',
    ].join('\n');
    const attach = inverted.indexOf(ATTACH_CALL);
    const egress = inverted.indexOf(EGRESS_CALL);
    expect(attach).toBeGreaterThan(-1);
    expect(egress).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(egress);
  });
});
