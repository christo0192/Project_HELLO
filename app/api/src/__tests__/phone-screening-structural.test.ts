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

/**
 * The `const X_COLUMNS = '...'` declarations of a module, as name → list.
 *
 * Extracting the DECLARATIONS is the point: a sweep over `.select(` arguments
 * sees identifiers, so it can only ever assert things about the identifier's
 * spelling. What matters is what the identifier HOLDS.
 */
function columnConstants(body: string): {
  lists: Map<string, string>;
  malformed: string[];
} {
  const lists = new Map<string, string>();
  const malformed: string[] = [];
  // The WHOLE initializer, up to its semicolon — not just the first quoted
  // literal, and a column list MUST be exactly one plain literal.
  //
  // Taking the first literal would let
  // `const ATTEMPT_COLUMNS = 'id,...,ended_at' + ',lease_token'` through: the
  // star check sees only the first half, and splitting the raw text on commas
  // yields the token `lease_token'` WITH a trailing quote, which no
  // forbidden-name comparison matches. Partially inspecting a computed
  // initializer is worse than refusing it, so anything that is not a single
  // literal is reported as malformed and fails the suite.
  for (const m of body.matchAll(/const\s+([A-Z][A-Z0-9_]*_COLUMNS)\s*=\s*([^;]*);/g)) {
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

/**
 * The two files allowed to name a database client at all. `stores.ts` is the
 * WRITE seam and may only `.rpc(`; `read-stores.ts` is the READ seam and may
 * only `.select(`. Splitting the capability across two files is what lets each
 * one's absence be asserted in the other — a single file holding both could
 * only be checked against a weaker, hand-waved rule.
 */
const WRITE_SEAM = 'stores.ts';
const READ_SEAM = 'read-stores.ts';
const CLIENT_FILES = new Set([WRITE_SEAM, READ_SEAM]);

describe('1. every phone write goes through an RPC', () => {
  it('no module touches the job queue directly', () => {
    for (const { name, source } of MODULE_FILES) {
      expect(code(source), `${name} reaches the job queue directly`)
        .not.toMatch(/\.from\(\s*['"`]job_queue/);
    }
  });

  it('no module anywhere performs a table WRITE', () => {
    // The rule that matters. 0042's guarantees — the global admission advisory
    // lock, the pinned lock order, the per-IST-day uniqueness index, the three
    // budgets and the insert-once ledger — live entirely INSIDE the RPCs. A
    // direct write would satisfy every type in this repository and bypass all
    // of them at once. A direct READ bypasses nothing, which is why the read
    // seam exists and this assertion is about writes rather than about `.from`.
    for (const { name, source } of MODULE_FILES) {
      const body = code(source);
      for (const verb of ['insert', 'update', 'upsert', 'delete']) {
        expect(body, `${name} performs a .${verb}()`).not.toMatch(
          new RegExp(String.raw`\.\s*${verb}\s*\(`),
        );
      }
    }
  });

  it('only the two seam files hold a client, and each holds ONE capability', () => {
    for (const { name, source } of MODULE_FILES) {
      if (CLIENT_FILES.has(name)) continue;
      expect(code(source), `${name} imports a supabase client`)
        .not.toMatch(/@supabase\/supabase-js/);
      expect(code(source), `${name} imports the process-wide client`)
        .not.toMatch(/from ['"][^'"]*\/supabase\.js['"]/);
      // Nor any table accessor: outside the two seams the ports interfaces
      // expose no such capability, so a `.from(` would be one the seam denies.
      expect(code(source), `${name} uses a table accessor`)
        .not.toMatch(/\bclient\s*\.\s*from\s*\(/);
    }

    const stores = MODULE_FILES.find((f) => f.name === WRITE_SEAM);
    expect(stores).toBeDefined();
    const writeBody = code(stores!.source);
    const rpcCalls = [...writeBody.matchAll(/client\.rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    // TWENTY-TWO since 0051 added the session-level egress stamp that makes a
    // phone MP3 visible to the session-keyed finalizer and download route.
    // 0045 added four before it: the epoch-fenced heartbeat, two bounded
    // sweeps, and the sweep claim. 0067 added `commit_phone_gate_turns`, and
    // 0068 added candidate callback confirmation. The count is pinned rather
    // than merely non-zero so a seam that quietly stops routing one call
    // through an RPC fails here. 0071 added two: the per-item transcript writer
    // (commit_phone_item_turn) and the crashed-session recording sweep
    // (sweep_phone_stranded_recordings).
    expect(new Set(rpcCalls).size).toBe(31);
    // The write seam reaches NO table, only RPCs.
    expect(writeBody, 'stores.ts uses a table accessor').not.toMatch(/\bclient\s*\.\s*from\s*\(/);
    // A type-only import of the client type is fine; a VALUE import is not.
    expect(writeBody).toMatch(/import type \{ SupabaseClient \}/);

    const reads = MODULE_FILES.find((f) => f.name === READ_SEAM);
    expect(reads).toBeDefined();
    const readBody = code(reads!.source);
    // The read seam calls NO rpc — it cannot invoke a mutation by name.
    expect(readBody, 'read-stores.ts calls an rpc').not.toMatch(/\.\s*rpc\s*\(/);
    expect(readBody).toMatch(/import type \{ SupabaseClient \}/);
    // …and every table it touches is selected with an EXPLICIT column list.
    // `select('*')` is what turns "we do not expose the lease token" into "we
    // have not exposed it yet": the column arrives in the row and only a
    // hand-written mapper stands between it and a response.
    //
    // The check runs over the DECLARED CONSTANTS, not over the `.select(`
    // arguments. Those arguments are identifiers — `APPOINTMENT_COLUMNS` and
    // friends — so asserting they contain no asterisk asserts nothing about
    // what they hold, and `const ENGAGEMENT_COLUMNS = '*'` would sail through.
    // Two assertions instead: every declared list is star-free, and every
    // `.select(` argument is one of those declared identifiers, which is what
    // stops an inline `select('*')` being added beside them.
    const { lists: declared, malformed } = columnConstants(readBody);
    expect(malformed, 'a column list is not a single plain literal').toEqual([]);
    expect(declared.size).toBeGreaterThanOrEqual(4);
    for (const [name, list] of declared) {
      expect(list, `${name} is a star select`).not.toContain('*');
    }
    const selects = [...readBody.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(selects.length).toBeGreaterThanOrEqual(5);
    for (const arg of selects) {
      expect(declared.has(arg), `read-stores.ts selects ${arg}, not a declared column list`)
        .toBe(true);
    }
  });

  it('no column list in the read seam names a forbidden column', () => {
    // Omission is the control, not redaction: a column that is never SELECTED
    // cannot be serialized by a later edit that forgets why it was masked.
    const reads = MODULE_FILES.find((f) => f.name === READ_SEAM);
    const { lists: declared, malformed } = columnConstants(code(reads!.source));
    expect(malformed, 'a column list is not a single plain literal').toEqual([]);
    const FORBIDDEN = [
      'sip_call_id', 'room_name', 'participant_identity', 'egress_id', 'egress_status',
      'lease_token', 'lease_owner', 'lease_expires_at', 'provider_event_id', 'phone_sha256',
      'metadata', 'email', 'phone_raw', 'phone_e164', 'phone_valid', 'text_extracted',
      'parsed', 'skills', 'created_by', 'application_link_id',
    ];
    // Fail closed: an empty sweep would make this assertion vacuous.
    expect(declared.size).toBeGreaterThanOrEqual(4);
    for (const [name, list] of declared) {
      const columns = list.split(',');
      for (const forbidden of FORBIDDEN) {
        expect(columns, `${name} selects ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the ROUTE cannot reach a table or an RPC either', () => {
    // The sweeps above run over `lib/phone-screening` only, which was complete
    // while nothing outside it held a client. `routes/phone.ts` now imports the
    // process-wide singleton, so it could `.from('phone_appointments').update()`
    // with every assertion in this file still green. The seam is only a seam if
    // the module in front of it cannot go around it.
    const route = readFileSync(path.join(SRC_DIR, 'routes/phone.ts'), 'utf8');
    const schema = readFileSync(path.join(SRC_DIR, 'schemas/phone-api.ts'), 'utf8');
    for (const [name, source] of [['routes/phone.ts', route], ['schemas/phone-api.ts', schema]] as const) {
      const body = code(source);
      expect(body, `${name} reaches a table directly`).not.toMatch(/\.\s*from\s*\(/);
      expect(body, `${name} calls an rpc directly`).not.toMatch(/\.\s*rpc\s*\(/);
      // Express route REGISTRATIONS are removed first, so `router.delete(` —
      // the HTTP verb — is not mistaken for a table write. Stripping them is
      // more robust than a lookbehind on the receiver name, which would quietly
      // stop excluding the moment somebody renamed `router` to `phoneRouter`.
      const withoutRegistrations = body.replace(
        /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\(/g,
        '',
      );
      for (const verb of ['insert', 'update', 'upsert', 'delete']) {
        expect(withoutRegistrations, `${name} performs a .${verb}()`).not.toMatch(
          new RegExp(String.raw`\.\s*${verb}\s*\(`),
        );
      }
    }
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

  it('only the enumerated phone importers reach this module', () => {
    // P2 shipped this as a dormant domain core and this assertion read
    // "nothing imports it yet". TWO lanes wired it in — P3's LiveKit ingress
    // and P6's operator API — so the assertion moves rather than dies: an
    // ALLOWLIST of importers keeps the original control alive (an unnoticed
    // import still fails) while recording, in one place, every file that was
    // deliberately allowed to make the module live.
    //
    // Deleting it instead would have been the worse trade: a tripwire that
    // cannot fire once the thing it guards changes is not a weaker control,
    // it is a misleading one.
    //
    // Note what is NOT here: no worker, no timer, no scheduler and no
    // composition-root entry. Both live surfaces are request-scoped — one
    // pre-auth webhook with its own signature boundary, one recruiter-
    // authenticated API. Nothing in this repository yet runs the phone domain
    // on a loop, and adding the first thing that does is a later phase's
    // decision, not a merge artefact.
    const ALLOWED_IMPORTERS = new Set([
      // P3 — LiveKit phone webhook ingress and reconciliation.
      'integrations/livekit-phone/config.ts',
      'integrations/livekit-phone/ingress.ts',
      'integrations/livekit-phone/reconciliation.ts',
      'integrations/livekit-phone/stores.ts',
      'routes/phone-webhook.ts',
      // P6 — the operator calendar/engagement/health/control API.
      'routes/phone.ts',
      'schemas/phone-api.ts',
      // P4 — the safe outbound dialer. A SEPARATE directory from the P3
      // ingress on purpose: `livekit-phone` carries a directory-wide "nothing
      // here dials" assertion, and housing the dialer beside it would have
      // forced that assertion to be weakened into a per-file allowlist. A
      // weakened tripwire is worse than none, because it still reads like a
      // guarantee.
      'integrations/livekit-phone-dial/dial.ts',
      'integrations/livekit-phone-dial/recording.ts',
      'integrations/livekit-phone-dial/recording-purge.ts',
      'integrations/livekit-phone-dial/sip.ts',
      'routes/phone-worker.ts',
      // Answer-first origination ("bounce") — the Plivo callbacks. The store
      // reads the closed vocabulary predicates (`isLiveAttemptState`,
      // `isTerminalEngagementState`) to decide bridgeability; the route applies
      // events through `createPhoneStores`. Both consume the domain core's PURE
      // reads/verdicts and neither re-implements a transition, exactly like the
      // dialer files above.
      'integrations/plivo-phone/stores.ts',
      'routes/plivo-webhook.ts',
      // P5 — the runtime orchestration. It lives in its own package for a
      // structural reason, not a stylistic one: a worker loop needs
      // `setInterval`, the queue library and a logger, and all three are
      // forbidden in this module by the FORBIDDEN table above. So the loops
      // sit beside the domain core and import it, exactly as `lib/recording/`
      // sits beside the recording domain.
      //
      // These are the files that touch the core. `config.ts`,
      // `dial-handler.ts` and `livekit-clients.ts` are deliberately absent —
      // they do not import it, and this set is asserted as a BIJECTION, so
      // listing a file that does not import would fail exactly as loudly as
      // omitting one that does.
      'lib/phone-runtime/due-loop.ts',
      'lib/phone-runtime/read.ts',
      'lib/phone-runtime/runtime.ts',
      // PR105 — Canary-1's operator CLI. It imports the domain core for ONE
      // reason: it builds a `PhoneScreeningConfig` IN PROCESS and calls
      // `isDialAllowedForDigest` on it, so the real permission gate is on the
      // real path. That is possible only because the gates are pure functions
      // over injected data — which is exactly what lets Canary-1 obtain a live
      // client while CHANGING NO ENVIRONMENT VARIABLE ANYWHERE, and therefore
      // weakening nothing that protects a real candidate.
      //
      // `originate.ts` is the only file in that package that touches the core.
      // The other ten do not, and this set is a BIJECTION, so listing one that
      // does not import would fail as loudly as omitting one that does.
      'lib/phone-canary1/originate.ts',
      // P-1 role admission uses the same pure question contract so malformed
      // candidate-facing templates cannot be written.
      'schemas/roles.ts',
    ]);
    const seen = new Set<string>();
    for (const file of allSourceFiles(SRC_DIR)) {
      if (file.startsWith(MODULE_DIR)) continue;
      // Match an IMPORT SPECIFIER, not the words: `phone-screening` also
      // appears in ordinary English inside a scoring prompt.
      const imports = /from\s+['"][^'"]*phone-screening[^'"]*['"]/
        .test(readFileSync(file, 'utf8'));
      if (!imports) continue;
      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
      expect(ALLOWED_IMPORTERS.has(rel), `${rel} imports phone-screening`).toBe(true);
      seen.add(rel);
    }
    // The allowlist must not outlive its entries either: a stale name would
    // silently permit a future file to reuse it, and a lane that stopped
    // importing the domain core would be reimplementing it.
    expect([...seen].sort()).toEqual([...ALLOWED_IMPORTERS].sort());
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
