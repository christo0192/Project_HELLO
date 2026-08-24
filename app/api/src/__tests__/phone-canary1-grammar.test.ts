/**
 * PR105 — Canary-1's transcript is parsed by CANARY-0'S OWN PARSER.
 *
 * ── WHY THIS IS THE STRONGEST FORM OF THE ASSERTION ───────────────────
 * A grammar test that re-declares the regexes it checks against proves only
 * that a file agrees with itself. This one imports `PATTERNS`, `parseProtocol`
 * and `LEAK_PATTERNS` from `scripts/phone-canary/manifest.mjs` — the code
 * Canary-0 actually validates its output with — and feeds a whole Canary-1 run
 * through them. If the two grammars ever drift, or if a Canary-1 line stops
 * being expressible in the shared protocol, this goes red.
 *
 * It also runs Canary-0's INDEPENDENT LEAK SCAN over every emitted line. That
 * scanner looks for a uuid, an E.164 value, a 7+ digit run, a credential word,
 * an object key, a url, an email and a room name. Canary-1 has a phone number
 * in memory and mints uuids and a room name, so it is the one scenario with
 * something for that scanner to find — and it finds nothing.
 *
 * ── AND THE ZERO-NETWORK LEG, HONESTLY LABELLED ───────────────────────
 * Canary-0's traps are armed around a whole Canary-1 run and must end at zero,
 * with the positive control firing. That is genuinely weaker than Canary-0's
 * own claim: from `scripts/phone-canary/` the telephony SDK is not RESOLVABLE
 * at all, whereas here it is. The property rests on dependency injection plus
 * the traps, and saying so is the honest description.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  CANARY1_CONFIRM_PHRASE,
  CANARY1_GRAMMAR,
  CANARY1_SCENARIO,
  CANARY1_UNPRINTABLE_LINE,
  canary1VerdictLine,
  runCanary1,
  type Canary1DispatchClientLike,
  type Canary1PromptInterface,
  type Canary1RoomClientLike,
  type Canary1RunDeps,
} from '../lib/phone-canary1/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CANARY_DIR = path.join(REPO, 'scripts/phone-canary');
const PROTOCOL = readFileSync(path.join(CANARY_DIR, 'PROTOCOL.md'), 'utf8');

/**
 * Canary-0's own validator and its own network traps, imported directly.
 *
 * The shapes are declared here rather than borrowed, because the modules are
 * untyped `.mjs`. Every member named below is asserted to EXIST before it is
 * relied on (§0), so a rename upstream fails loudly instead of silently
 * resolving to `undefined` and making these tests vacuous.
 */
interface ManifestModule {
  readonly PATTERNS: Readonly<Record<'scenario' | 'check' | 'code' | 'countKey', RegExp>>;
  readonly LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]>;
  parseProtocol(stdout: string): {
    verdicts: Array<{ scenario: string; check: string; ok: boolean; code: string }>;
    counts: Array<{ scenario: string; key: string; value: number }>;
    scenarioCount: number;
    errors: string[];
  };
}
interface NetGuardModule {
  createNetGuard(): {
    armed: readonly string[];
    measuredCalls(): number;
    controlCalls(): number;
    hits(): readonly string[];
    runPositiveControl(): 'fired' | 'not_fired';
    dispose(): void;
  };
  sdkImportable(specifier?: string): Promise<boolean>;
}

const manifest = (await import(path.join(CANARY_DIR, 'manifest.mjs'))) as unknown as ManifestModule;
const netguard = (await import(path.join(CANARY_DIR, 'netguard.mjs'))) as unknown as NetGuardModule;

const CREDS = { url: 'wss://example.invalid', apiKey: 'key', apiSecret: 'secret' };

function harness(): { deps: Canary1RunDeps; lines: string[] } {
  const lines: string[] = [];
  const rooms: Canary1RoomClientLike = {
    async createRoom() {},
    async deleteRoom() {},
    async listRooms() { return []; },
  };
  const dispatch: Canary1DispatchClientLike = { async createDispatch() {} };
  // SYNTHETIC, and never the owner's — the same fixture value the rest of
  // this lane's tests use. It exists only to be proved absent from output.
  const answers = ['+919812345670', '+919812345670'];
  const openPrompt = (): Canary1PromptInterface => ({
    question: async () => answers.shift() ?? '',
    history: [],
    close: () => {},
  });
  let clock = 0;
  return {
    lines,
    deps: {
      argv: ['--execute', '--confirm', CANARY1_CONFIRM_PHRASE],
      env: {},
      write: (line) => lines.push(line),
      prompt: { openPrompt, isTty: true },
      rooms,
      dispatch,
      credentials: CREDS,
      trunkId: 'ST_canary',
      sleep: async () => {},
      now: () => { clock += 100_000; return clock; },
      originate: {
        live: () => ({
          mode: 'live',
          createSipParticipant: async (request) => ({
            participantIdentity: `phone-${request.attemptId}`,
            synthetic: false,
          }),
        }),
      },
      armed: true,
      // Hermetic: a developer with a real `app/api/.env` on disk would
      // otherwise see every run here refuse `credentials_persisted`.
      // The entry script passes NO reader, which the structural suite
      // asserts, so production always uses the path-pinned read.
      readEnvFile: () => null,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 1. The emitter's grammar IS Canary-0's grammar.
// ══════════════════════════════════════════════════════════════════════

describe('0. the imported Canary-0 machinery is real', () => {
  it('every member these tests rely on exists', () => {
    // Without this, a rename upstream turns each assertion below into a
    // comparison against `undefined` that quietly passes.
    for (const key of ['scenario', 'check', 'code', 'countKey'] as const) {
      expect(manifest.PATTERNS[key], `PATTERNS.${key}`).toBeInstanceOf(RegExp);
    }
    expect(manifest.LEAK_PATTERNS.length).toBeGreaterThanOrEqual(8);
    expect(typeof manifest.parseProtocol).toBe('function');
    expect(typeof netguard.createNetGuard).toBe('function');
  });
});

describe('1. one protocol, two scenarios', () => {
  it('the emitter uses the SAME field patterns the manifest validates with', () => {
    expect(CANARY1_GRAMMAR.scenario.source).toBe(manifest.PATTERNS.scenario.source);
    expect(CANARY1_GRAMMAR.check.source).toBe(manifest.PATTERNS.check.source);
    expect(CANARY1_GRAMMAR.code.source).toBe(manifest.PATTERNS.code.source);
    expect(CANARY1_GRAMMAR.key.source).toBe(manifest.PATTERNS.countKey.source);
  });

  it('PROTOCOL.md declares those same patterns, verbatim', () => {
    // The document a human reads must not be able to disagree with the code.
    for (const [label, pattern] of [
      ['scenario', manifest.PATTERNS.scenario],
      ['check', manifest.PATTERNS.check],
      ['code', manifest.PATTERNS.code],
    ] as const) {
      expect(PROTOCOL, `PROTOCOL.md lost the ${label} pattern`)
        .toContain(pattern.source);
    }
    expect(PROTOCOL).toContain('canary1');
  });

  it('the scenario name is legal, and the file was actually read', () => {
    expect(manifest.PATTERNS.scenario.test(CANARY1_SCENARIO)).toBe(true);
    expect(PROTOCOL.length).toBeGreaterThan(1_000);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. A whole run, through Canary-0's parser and Canary-0's leak scan.
// ══════════════════════════════════════════════════════════════════════

describe('2. a whole Canary-1 run is parseable and leak-free', () => {
  it('parseProtocol accepts every line with zero errors', async () => {
    const h = harness();
    const result = await runCanary1(h.deps);
    expect(result.lines.length).toBeGreaterThan(8);
    const parsed = manifest.parseProtocol(result.lines.join('\n'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.scenarioCount).toBe(1);
    for (const verdict of parsed.verdicts) expect(verdict.scenario).toBe(CANARY1_SCENARIO);
    for (const count of parsed.counts) expect(count.scenario).toBe(CANARY1_SCENARIO);
  });

  it("Canary-0's INDEPENDENT leak scan finds nothing in the transcript", async () => {
    const h = harness();
    const result = await runCanary1(h.deps);
    const found: string[] = [];
    for (const line of result.lines) {
      for (const [name, re] of manifest.LEAK_PATTERNS) {
        if (re.test(line)) found.push(`${name}:${line}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('POSITIVE CONTROL — the leak scan bites on what a careless line would carry', () => {
    // Every pattern that could plausibly fire on this mechanism's own values:
    // it mints uuids, names a room `phone-<uuid>`, and holds an E.164 number.
    const seeded = [
      'CANARY|canary1|room|PASS|9c4a1e75-2b83-41d7-8f60-1ea55d3c9b02',
      'CANARY|canary1|dialing|PASS|+919812345670',
      'CANARY|canary1|room|PASS|phone-9c4a1e75-2b83',
      'CANARYCOUNT|canary1|digits|9812345670',
    ];
    const fired = new Set<string>();
    for (const line of seeded) {
      for (const [name, re] of manifest.LEAK_PATTERNS) if (re.test(line)) fired.add(name);
    }
    expect([...fired].sort()).toEqual(['digit_run', 'e164', 'room_name', 'uuid']);
  });

  it('an ungrammatical field becomes the refusal line, never the value', () => {
    // The one line that can be emitted when something outside the grammar was
    // attempted. It is itself grammatical, so the transcript stays parseable.
    expect(canary1VerdictLine('Bad Check', true, '+919812345670'))
      .toBe(CANARY1_UNPRINTABLE_LINE);
    const parsed = manifest.parseProtocol(`${CANARY1_UNPRINTABLE_LINE}\nCANARYDONE|1`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.verdicts[0]).toMatchObject({ check: 'emitter_refused', ok: false });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Zero network, with the control on the control.
// ══════════════════════════════════════════════════════════════════════

describe('3. the measured window ends at zero, and the traps are proven armed', () => {
  it('a whole run makes no network call, and the positive control fires', async () => {
    const guard = netguard.createNetGuard();
    try {
      const h = harness();
      const result = await runCanary1(h.deps);
      expect(result.lines.at(-1)).toBe('CANARYDONE|1');
      expect(guard.measuredCalls(), `hits: ${guard.hits().join(', ')}`).toBe(0);
      // A counter that reads zero and a counter that is broken are the same
      // observation, so the traps are made to fire before the zero is trusted.
      expect(guard.runPositiveControl()).toBe('fired');
      expect(guard.controlCalls()).toBe(guard.armed.length);
    } finally {
      guard.dispose();
    }
  });

  it('CONTROL ON THE CONTROL — a disarmed trap reports not_fired', () => {
    const guard = netguard.createNetGuard();
    const stolen = globalThis.fetch;
    globalThis.fetch = (() => undefined) as unknown as typeof fetch;
    const verdict = guard.runPositiveControl();
    globalThis.fetch = stolen;
    guard.dispose();
    expect(verdict).toBe('not_fired');
  });

  it('LABELLED LIMIT — the SDK IS resolvable from here, unlike from Canary-0', () => {
    // Stated rather than glossed, and ASSERTED rather than written in a
    // comment. Canary-0's structural leg 1 is "the telephony SDK is not
    // resolvable from this directory at all" — `scripts/` has no
    // `node_modules`. That leg is UNAVAILABLE here: `app/api` depends on the
    // SDK, so it resolves. This suite's zero-network claim therefore rests on
    // dependency injection plus the runtime traps, and is WEAKER than
    // Canary-0's. Pinning the difference means a future reader cannot borrow
    // Canary-0's stronger claim by accident.
    const require_ = createRequire(import.meta.url);
    expect(() => require_.resolve('livekit-server-sdk')).not.toThrow();

    // And the contrast is real, not asserted: from `scripts/phone-canary/`
    // the same specifier does NOT resolve — which is Canary-0's leg 1.
    const fromCanaryDir = createRequire(path.join(CANARY_DIR, 'netguard.mjs'));
    expect(() => fromCanaryDir.resolve('livekit-server-sdk')).toThrow();
  });
});
