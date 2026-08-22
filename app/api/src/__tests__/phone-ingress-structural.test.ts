/**
 * Structural boundaries for `integrations/livekit-phone/**` and the route.
 *
 * The P2 domain core has its own structural suite; this is the P3 equivalent
 * for the layer that was allowed to import a provider SDK. Every "it cannot"
 * in the P3 documentation is asserted here over the source text, because "we
 * won't" is not a control.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = fileURLToPath(new URL('../integrations/livekit-phone/', import.meta.url));
const ROUTE_PATH = fileURLToPath(new URL('../routes/phone-webhook.ts', import.meta.url));
const APP_PATH = fileURLToPath(new URL('../app.ts', import.meta.url));

function readModuleFiles(): Array<{ name: string; source: string }> {
  const names = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts')).sort();
  if (names.length === 0) throw new Error('livekit-phone module is empty');
  return names.map((name) => ({
    name,
    source: readFileSync(path.join(MODULE_DIR, name), 'utf8'),
  }));
}

const MODULE_FILES = readModuleFiles();
const ROUTE_SOURCE = readFileSync(ROUTE_PATH, 'utf8');
const ALL_P3 = [...MODULE_FILES, { name: 'routes/phone-webhook.ts', source: ROUTE_SOURCE }];

/**
 * Source with block and line comments removed — for call-site assertions.
 *
 * The naive stripper the P2 suite uses cannot be reused verbatim here. The
 * route passes express.raw the MIME wildcard (star, slash, star) as a string
 * literal. Its leading slash-star reads to a regex stripper as a BLOCK-COMMENT
 * OPENER, so the stripper deletes everything from there to the next
 * star-slash — in this file, most of the handler. Every `not.toContain`
 * assertion below would then have passed because the code was GONE, not
 * because the pattern was absent.
 *
 * So the literal is masked before stripping and the mask is asserted on. This
 * is the same lesson P2 paid for with its migration extractor: an assertion is
 * only as good as the extractor underneath it.
 */
const WILDCARD_MIME_MASK = '__WILDCARD_MIME__';

function code(source: string): string {
  return source
    .split("'*/*'").join(`'${WILDCARD_MIME_MASK}'`)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('1. the module exists and the suite is not vacuous', () => {
  it('reads every P3 file', () => {
    expect(MODULE_FILES.map((f) => f.name)).toEqual([
      'config.ts', 'events.ts', 'index.ts', 'ingress.ts',
      'ports.ts', 'reconciliation.ts', 'stores.ts', 'verify.ts',
    ]);
    // Control: the comment stripper must not empty a file, or every
    // `not.toContain` below would pass for the wrong reason.
    for (const { name, source } of ALL_P3) {
      expect(code(source).trim().length, `${name} stripped to nothing`).toBeGreaterThan(200);
    }
  });

  it('control: the wildcard mask is load-bearing, not decorative', () => {
    // Prove the hazard is REAL and that the mask is what defeats it. A naive
    // stripper — the one the P2 suite uses — swallows the route's handler
    // whole, because the MIME wildcard literal opens a block comment it never
    // meant to open.
    const naive = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(naive(ROUTE_SOURCE)).not.toContain('phone_webhook_disabled');
    expect(code(ROUTE_SOURCE)).toContain('phone_webhook_disabled');
    expect(code(ROUTE_SOURCE)).toContain('router.post(');
    expect(code(ROUTE_SOURCE).length).toBeGreaterThan(naive(ROUTE_SOURCE).length + 500);
  });
});

describe('2. no dialing, no origination, no provider mutation', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['SIP origination', /createSipParticipant|CreateSIPParticipant|SipClient|sipTrunk|createSipOutboundTrunk|transferSipParticipant/i],
    ['a room mutation', /createRoom|deleteRoom|removeParticipant|updateParticipant|updateRoomMetadata|mutePublishedTrack/],
    ['token minting', /\bAccessToken\b|addGrant|toJwt/],
    ['egress control', /EgressClient|startRoomCompositeEgress|stopEgress/],
    ['a provider name', /\bplivo\b|\btwilio\b|\bexotel\b|\bknowlarity\b/i],
    ['an Ashby module', /integrations\/ashby/],
    ['a stage move or scorecard write', /stage_move|scorecard|advance_ashby|ashby_operations/i],
    ['email delivery', /sendMail|nodemailer|invite-delivery/i],
    ['a timer', /setInterval\(|setTimeout\(|setImmediate\(/],
    ['a child process', /node:child_process/],
    ['the dead 0001 schema', /call_queue|sms_follow_ups/],
  ];

  for (const [label, pattern] of FORBIDDEN) {
    it(`no P3 file references ${label}`, () => {
      for (const { name, source } of ALL_P3) {
        expect(code(source), `${name} references ${label}`).not.toMatch(pattern);
      }
    });
  }

  it('verification is never skippable', () => {
    const verify = MODULE_FILES.find((f) => f.name === 'verify.ts')!;
    const body = code(verify.source);
    // The SDK's third positional parameter disables verification entirely.
    expect(body).toContain('receiver.receive(body, authHeader, false, toleranceSeconds)');
    expect(body).not.toMatch(/skipAuth\s*[:=]\s*true/);
    expect(body).not.toMatch(/,\s*true\s*,\s*toleranceSeconds/);
  });

  it('only stores.ts and verify.ts may name the LiveKit SDK, and only lazily', () => {
    for (const { name, source } of ALL_P3) {
      const body = code(source);
      if (name === 'stores.ts' || name === 'verify.ts') {
        // A STATIC value import would drag the SDK into app.ts's module graph
        // and break every existing suite that partially mocks it.
        // Any STATIC form — named, default, namespace or bare side-effect —
        // would drag the SDK into app.ts's graph. Matching only the named
        // form would let `import * as sdk from ...` through.
        expect(body, `${name} statically imports the SDK`)
          .not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'livekit-server-sdk'/m);
        expect(body, `${name} side-effect imports the SDK`)
          .not.toMatch(/^import\s+'livekit-server-sdk'/m);
        expect(body, `${name} should import the SDK lazily`)
          .toMatch(/await import\('livekit-server-sdk'\)/);
        continue;
      }
      expect(body, `${name} names the LiveKit SDK`).not.toContain('livekit-server-sdk');
    }
  });
});

describe('3. every phone write goes through the 0042 RPC', () => {
  it('no P3 file reaches a phone table to WRITE, or the job queue at all', () => {
    for (const { name, source } of ALL_P3) {
      const body = code(source);
      for (const write of ['insert(', 'update(', 'upsert(', 'delete(']) {
        expect(body, `${name} performs a ${write} write`).not.toContain(`.${write}`);
      }
      expect(body, `${name} reaches the job queue`).not.toMatch(/\.from\(\s*['"`]job_queue/);
    }
  });

  it('only stores.ts holds a client, and its ONLY table read is bounded', () => {
    for (const { name, source } of ALL_P3) {
      if (name === 'stores.ts') continue;
      expect(code(source), `${name} imports a supabase client`)
        .not.toMatch(/@supabase\/supabase-js/);
    }
    const stores = code(MODULE_FILES.find((f) => f.name === 'stores.ts')!.source);
    // A type-only import of the client type is fine; a VALUE import is not.
    expect(stores).toMatch(/import type \{ SupabaseClient \}/);
    const tables = [...stores.matchAll(/\.from\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(tables).toEqual(['phone_call_attempts']);
    // The window and the count are applied in SQL, not after the fetch.
    for (const bound of ['.lte(', '.gte(', '.limit(']) expect(stores).toContain(bound);
  });

  it('no P3 file calls an RPC directly — applyEvent is the only writer', () => {
    for (const { name, source } of ALL_P3) {
      expect(code(source), `${name} calls an rpc directly`).not.toMatch(/\.rpc\(/);
    }
    const callers = ALL_P3.filter((f) => /applyEvent\(/.test(code(f.source))).map((f) => f.name);
    expect(callers.sort()).toEqual(['ingress.ts', 'reconciliation.ts']);
  });
});

describe('4. no phone number, attribute or provider payload can escape', () => {
  const PHONE_BEARING = [
    'phone_e164', 'phoneE164', 'phone_raw', 'phoneRaw', 'phoneNumber', 'phone_number',
    'msisdn', 'callerId', 'caller_id', 'toNumber', 'fromNumber', 'trunkPhoneNumber',
  ];

  it('no P3 file names a phone-bearing field at a call site', () => {
    for (const { name, source } of ALL_P3) {
      const body = code(source);
      for (const field of PHONE_BEARING) {
        expect(body, `${name} names ${field}`).not.toContain(field);
      }
    }
  });

  it('the attribute reader indexes an allowlist and never enumerates', () => {
    const events = code(MODULE_FILES.find((f) => f.name === 'events.ts')!.source);
    // Enumerating the attribute map is how `sip.phoneNumber` would get in.
    for (const enumerate of [
      'Object.keys(attributes', 'Object.entries(attributes', 'Object.values(attributes',
      '...attributes', 'attributes)',
    ]) {
      expect(events, `events.ts enumerates attributes via ${enumerate}`)
        .not.toContain(enumerate);
    }
    // And the allowlist itself has exactly one member.
    const declared = /APPROVED_PARTICIPANT_ATTRIBUTES = \[([^\]]*)\]/.exec(events);
    expect(declared).not.toBeNull();
    expect(declared![1].match(/'[^']+'/g)).toEqual(["'phone_epoch'"]);
  });

  it('no committed literal in the P3 tree is a dialable Indian mobile', () => {
    // `STRICT_IN_MOBILE_E164` is 0042's own dialability predicate. A plausible
    // fixture is exactly how a real number gets committed by accident, so the
    // rule this lane already established in P2 applies here too: a committed
    // +91 literal must be a shape the DATABASE ITSELF REFUSES. The fixtures
    // below use `+91` followed by a leading `0`, which fails 0042's `[6-9]`
    // class, so they exercise the SIP-attribute paths identically while being
    // undialable by construction.
    //
    // An earlier version of this test accepted any occurrence "followed by a
    // `)`", which is satisfied by essentially every literal inside a call — it
    // reported green while proving nothing. This one admits no occurrences at
    // all outside the seeded control below.
    const STRICT_IN_MOBILE = /\+91[6-9][0-9]{9}/;
    const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
    const testFiles = readdirSync(TEST_DIR)
      .filter((f) => f.startsWith('phone-webhook') || f.startsWith('phone-ingress')
        || f.startsWith('phone-reconciliation'))
      .map((f) => ({ name: f, source: readFileSync(path.join(TEST_DIR, f), 'utf8') }));
    expect(testFiles.length).toBe(4);

    const SEEDED_CONTROL = 'const attackerNumber = "+919812345678";';
    for (const { name, source } of [...ALL_P3, ...testFiles]) {
      for (const line of source.split('\n')) {
        if (!STRICT_IN_MOBILE.test(line)) continue;
        // The one permitted occurrence in the whole tree is the control on
        // the next assertion, which exists to prove this scan still bites.
        expect(line.includes(SEEDED_CONTROL), `${name} commits a dialable mobile: ${line.trim()}`)
          .toBe(true);
      }
    }

    // Non-vacuity: the scan must actually catch a seeded violation, or a
    // silently-broken regex would make the loop above pass over anything.
    expect(STRICT_IN_MOBILE.test(SEEDED_CONTROL)).toBe(true);
    expect(STRICT_IN_MOBILE.test("{ 'sip.phoneNumber': '+910000000000' }")).toBe(false);
  });

  it('the route logs only closed metadata tokens, never a payload field', () => {
    const body = code(ROUTE_SOURCE);
    const logCalls = [...body.matchAll(/logger\.(info|warn|error)\([\s\S]*?\{([\s\S]*?)\}/g)];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const [, , meta] of logCalls) {
      const keys = [...meta.matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]);
      for (const key of keys) {
        expect(['error_category', 'error_type', 'http_status']).toContain(key);
      }
    }
    // Nothing derived from the envelope or the body is logged.
    expect(body).not.toMatch(/logger\.[a-z]+\([^)]*rawBody/);
    expect(body).not.toMatch(/logger\.[a-z]+\([^)]*envelope/);
    expect(body).not.toMatch(/logger\.[a-z]+\([^)]*authHeader/);
    expect(body).not.toMatch(/logger\.[a-z]+\([^)]*apiSecret/);
  });

  it('no thrown error interpolates anything', () => {
    for (const { name, source } of ALL_P3) {
      for (const [, message] of code(source).matchAll(/new Error\(([^)]*)\)/g)) {
        expect(message, `${name} interpolates a thrown message`).not.toContain('${');
        expect(message.trim(), `${name} throws a non-literal`).toMatch(/^'[a-z0-9_]+'$/);
      }
    }
  });
});

describe('5. the mount is pre-auth and exactly one path', () => {
  const APP_SOURCE = readFileSync(APP_PATH, 'utf8');

  it('mounts the phone webhook BEFORE the auth middleware', () => {
    const mount = APP_SOURCE.indexOf("app.use('/api/integrations/livekit-phone'");
    const auth = APP_SOURCE.indexOf('const requireAuth = createRequireAuth');
    expect(mount).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(auth);
  });

  it('mounts it AFTER the global per-IP rate limiter, which is unchanged', () => {
    const limiter = APP_SOURCE.indexOf("prefix: 'global:ip:'");
    const mount = APP_SOURCE.indexOf("app.use('/api/integrations/livekit-phone'");
    expect(limiter).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(mount);
    // No phone-specific rate-limit or CSP exemption was introduced.
    expect(APP_SOURCE).not.toMatch(/livekit-phone[^\n]*rateLimit/i);
    expect(APP_SOURCE).not.toMatch(/livekit-phone[^\n]*csp/i);
  });

  it('mounts it BEFORE the global JSON body parser', () => {
    const mount = APP_SOURCE.indexOf("app.use('/api/integrations/livekit-phone'");
    const json = APP_SOURCE.indexOf('app.use(express.json(');
    expect(json).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(json);
  });

  it('declares exactly one method and path on the router', () => {
    const routes = [...code(ROUTE_SOURCE).matchAll(/router\.([a-z]+)\(\s*'([^']*)'/g)]
      .map(([, method, p]) => `${method.toUpperCase()} ${p}`);
    expect(routes).toEqual(['POST /webhook']);
  });

  it('bounds the raw body at the transport AND semantically', () => {
    const body = code(ROUTE_SOURCE);
    expect(body).toMatch(
      new RegExp(`express\\.raw\\(\\{\\s*type:\\s*'${WILDCARD_MIME_MASK}',\\s*limit:\\s*TRANSPORT_BODY_LIMIT`),
    );
    // The semantic bound is the operator-visible knob, checked in the verifier.
    expect(body).toContain('maxBytes: config.phone.webhookMaxBytes');
    expect(body).toContain('toleranceSeconds: config.phone.webhookToleranceSeconds');
  });

  it('resolves every dependency lazily so the 503 path touches nothing', () => {
    // Scope to the HANDLER, not the whole file: the resolver DECLARATIONS sit
    // above `router.post` by necessity, so a file-wide indexOf would find
    // those and prove nothing about when they are CALLED.
    const handler = code(ROUTE_SOURCE).slice(code(ROUTE_SOURCE).indexOf('router.post('));
    expect(handler.length).toBeGreaterThan(500);
    const disabledIndex = handler.indexOf('phone_webhook_disabled');
    expect(disabledIndex).toBeGreaterThan(-1);
    for (const marker of ['resolveStores()', 'resolveVerifier(config)']) {
      const callIndex = handler.indexOf(marker);
      expect(callIndex, `${marker} is never called in the handler`).toBeGreaterThan(-1);
      expect(callIndex, `${marker} is resolved before the enablement gate`)
        .toBeGreaterThan(disabledIndex);
    }
    // The config itself is resolved lazily too — a module-level
    // `loadLiveKitPhoneConfig()` would read env at import time.
    expect(code(ROUTE_SOURCE)).not.toMatch(/^const .*= loadLiveKitPhoneConfig\(\)/m);
  });
});
