/**
 * PR108 — the Canary-1 CLI's RUNTIME import closure.
 *
 * ── THE INCIDENT ──────────────────────────────────────────────────────
 * The first Canary-1 dry run on a disarmed main printed exactly one line:
 *
 *     CANARY|canary1|process_containment|FAIL|uncaught_exception
 *
 * …and stopped, before the arming gate, before any prompt. The containment
 * layer did its job — no error object reached the terminal — which is also why
 * the operator was told nothing about the cause.
 *
 * The cause was an import. `originate.ts` reached `resolvePhoneSipClient`
 * through `integrations/livekit-phone-dial/index.js`, and `entry.ts` reached
 * `wrapDialableNumber` through the same barrel. A barrel re-export is EAGER:
 * naming one symbol evaluates every module the barrel re-exports. That barrel
 * re-exports `phone-room.ts` -> `lib/room-provisioning.ts` -> `lib/env.ts`,
 * and `lib/env.ts` throws at module scope when `SUPABASE_URL` is unset.
 *
 * The canary CLI is not the API. It is a short-lived operator process holding
 * LiveKit credentials and a trunk id; it has no Supabase credential and must
 * require none.
 *
 * ── WHY NO EXISTING SUITE COULD HAVE CAUGHT IT ────────────────────────
 * `vitest.setup.ts` assigns `SUPABASE_URL` before any test module loads, so
 * inside this suite `lib/env.ts` imports cleanly. Every canary test therefore
 * passed while the CLI could not start. A test of this defect must either walk
 * the graph WITHOUT loading it, or load it in a child process whose
 * environment vitest has not already populated. This file does both, because
 * each covers the other's blind spot: the walker sees a re-entry the moment it
 * is written but only reasons about text, and the child process runs the real
 * loader but only proves today's configuration.
 *
 * ── AND A SECOND THING THE BARREL DID ─────────────────────────────────
 * `lib/env.ts` begins `import 'dotenv/config'`, which reads `.env` FROM THE
 * PROCESS CWD and merges it into `process.env`. This mechanism refuses to run
 * beside persisted LiveKit credentials — `credentials_persisted` — but that
 * check reads a path pinned relative to the module (`app/api/.env`), so the
 * barrel could load a dotfile from a different cwd that the refusal never
 * looked at. Removing the barrel removes `dotenv` from the closure entirely,
 * which is why the bare-specifier allowlist below names it.
 *
 * ── PR109: THIS SUITE MUST BE BRANCH-NEUTRAL ──────────────────────────
 * The property under test — the CLI STARTS rather than dying in its own
 * containment handler — is true of `main` and of the activation artifact
 * `canary1/arm` alike, and it is on `canary1/arm` that the property actually
 * matters, because that is the only branch from which the CLI is ever run.
 *
 * But the TERMINUS differs by branch, and PR108 asserted the terminus by
 * naming `main`'s. `runCanary1` checks the arming constant ahead of every
 * credential and bound gate, so a disarmed tree stops at
 * `armed|FAIL|canary1_not_armed` while an armed one walks on through
 * `armed|PASS` and `credentials_transient|PASS` to the first gate a bare
 * environment cannot satisfy — `preflight_trunk_configured|FAIL|
 * trunk_not_configured`. Pinning `main`'s terminus therefore made this suite
 * fail on the arm branch: a regression test for a start-up crash that itself
 * goes red on the one branch that starts the program.
 *
 * The repair is to DERIVE the expected terminus from `CANARY1_ARMED` — the
 * same constant the child process reads — instead of naming one branch's. The
 * two expectations stay mutually exclusive (a control below pins that), so
 * this is not the other, easy fix of accepting any terminus at all. Everything
 * ABOVE the terminus is asserted unconditionally, and a new unconditional
 * invariant is added in both directions: a `--dry-run` in a bare child must
 * reach NO provider seam on either branch.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The constant the CHILD will read, read here by the same means, so the
// expected terminus is derived from the tree under test rather than from an
// assumption about which branch this is. `arming.ts` imports nothing at all,
// so naming it here adds no module to this suite's own graph.
import { CANARY1_ARMED } from '../lib/phone-canary1/arming.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(API_ROOT, 'src');
const TESTS_DIR = fileURLToPath(new URL('./', import.meta.url));

/** The two roots. The entry script static-imports containment and reaches the
 *  orchestrator by `await import`; both are walked, so the dynamic hop that
 *  makes the containment ordering assertable does not also make the graph
 *  invisible. */
const ROOTS = [
  path.join(API_ROOT, 'scripts/phone-canary1.ts'),
  path.join(SRC, 'lib/phone-canary1/index.ts'),
] as const;

/** Files subject to the DIRECT-IMPORT rule: the package plus the entry script. */
const CANARY_OWN_FILES = ROOTS.concat();

const rel = (abs: string): string => path.relative(SRC, abs).split(path.sep).join('/');

/**
 * Strip what the RUNTIME never loads: comments, and type-only import/export
 * statements. `import type { X } from 'y'` is erased by TypeScript and loads
 * nothing, so counting it would forbid specifiers the process never resolves —
 * `@supabase/supabase-js` appears exactly that way in `phone-screening`.
 *
 * `import { a, type B } from 'y'` is NOT stripped and MUST NOT be: that form
 * still evaluates `y` at runtime. A control below pins both halves.
 */
export function stripToRuntime(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^[ \t]*(?:import|export)[ \t]+type[ \t][\s\S]*?from[ \t]*['"][^'"]+['"];?[ \t]*$/gm, '');
}

/** Every specifier the runtime would resolve from this source. */
function runtimeSpecifiers(source: string): string[] {
  const body = stripToRuntime(source);
  return [
    ...[...body.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
    // Side-effect imports carry no `from` clause and load the module anyway.
    // `lib/env.ts` opens with `import 'dotenv/config';` — the single most
    // consequential specifier in this whole incident — so a walker that only
    // matched `from` would have missed the thing it exists to find.
    ...[...body.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] as string),
    ...[...body.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
    ...[...body.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
  ];
}

interface Closure {
  /** Absolute paths of every first-party module the roots can reach. */
  readonly modules: readonly string[];
  /** Bare (package / node:) specifier -> the reaching modules, relative to src. */
  readonly bare: ReadonlyMap<string, readonly string[]>;
  /** Specifiers the canary's OWN files name, keyed by file (raw, as written). */
  readonly ownSpecifiers: ReadonlyMap<string, readonly string[]>;
  /** `file -> absolute path` for every relative specifier the OWN files name. */
  readonly ownTargets: ReadonlyMap<string, readonly string[]>;
}

/**
 * Walk the static+dynamic graph from the roots.
 *
 * `overrides` replaces a file's source without touching the tree — that is how
 * the mutation controls reintroduce the barrel and prove this walker bites.
 */
function walkClosure(overrides: ReadonlyMap<string, string> = new Map()): Closure {
  const read = (abs: string): string => overrides.get(abs) ?? readFileSync(abs, 'utf8');
  const seen = new Set<string>(ROOTS);
  const bare = new Map<string, string[]>();
  const ownSpecifiers = new Map<string, string[]>();
  const ownTargets = new Map<string, string[]>();
  const queue: string[] = [...ROOTS];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const specs = runtimeSpecifiers(read(current));
    const isOwn =
      CANARY_OWN_FILES.includes(current as (typeof ROOTS)[number]) ||
      current.startsWith(path.join(SRC, 'lib/phone-canary1') + path.sep);
    if (isOwn) ownSpecifiers.set(rel(current), specs);
    for (const spec of specs) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const resolved = path.resolve(path.dirname(current), spec.replace(/\.js$/, '.ts'));
        if (isOwn) {
          const targets = ownTargets.get(rel(current)) ?? [];
          targets.push(resolved);
          ownTargets.set(rel(current), targets);
        }
        if (!existsSync(resolved)) {
          // Loud, and named. An unresolvable specifier would otherwise surface
          // as a bare ENOENT from `readFileSync` several hops later.
          throw new Error(`closure walk: ${rel(current)} imports ${spec}, which resolves to no file`);
        }
        if (!seen.has(resolved)) {
          seen.add(resolved);
          queue.push(resolved);
        }
        continue;
      }
      const reachers = bare.get(spec) ?? [];
      reachers.push(rel(current));
      bare.set(spec, reachers);
    }
  }
  return { modules: [...seen], bare, ownSpecifiers, ownTargets };
}

const CLOSURE = walkClosure();
const reachable = (c: Closure): string[] => c.modules.map(rel).sort();

/**
 * The API modules the canary CLI must never reach. Each is named because each
 * demands something the operator's process does not and should not have.
 */
const FORBIDDEN_MODULES = [
  'lib/env.ts',
  'lib/supabase.ts',
  'lib/room-provisioning.ts',
] as const;

/**
 * Every package the closure may resolve at RUNTIME. `livekit-server-sdk` is on
 * the list because it is what the canary is for; §5 of the structural suite
 * separately proves every mention of it sits inside an `await import`, so it is
 * not loaded merely by importing the package.
 */
const ALLOWED_BARE = ['node:crypto', 'node:fs', 'node:readline', 'livekit-server-sdk'] as const;

/**
 * Barrels the canary's own files may not name — as RESOLVED PATHS, not as
 * specifier strings. The entry script lives in `app/api/scripts`, so it spells
 * the dialer barrel `../src/integrations/...` while the package spells it
 * `../../integrations/...`. A list of literal specifiers would police one
 * spelling and wave the other through, which is precisely the shape of tripwire
 * that reads like a guarantee and is not one.
 */
const FORBIDDEN_BARRELS = [
  path.join(SRC, 'integrations/livekit-phone-dial/index.ts'),
  path.join(SRC, 'lib/phone-screening/index.ts'),
] as const;

// ══════════════════════════════════════════════════════════════════════
// 0. THE WALKER IS NOT VACUOUS.
// ══════════════════════════════════════════════════════════════════════

describe('0. the walker actually walks', () => {
  it('reaches modules several hops from both roots', () => {
    const names = reachable(CLOSURE);
    // One hop from the entry script, and three or more from the orchestrator.
    for (const expected of [
      'lib/phone-canary1/containment.ts',
      'lib/phone-canary1/originate.ts',
      'integrations/livekit-phone-dial/sip.ts',
      'integrations/livekit-phone-dial/dialable-number.ts',
      'integrations/livekit-phone/events.ts',
      'lib/phone-screening/config.ts',
      'lib/phone-screening/index.ts',
    ]) {
      expect(names, `walker never reached ${expected}`).toContain(expected);
    }
    expect(names.length).toBeGreaterThan(20);
  });

  it('follows the entry script\'s DYNAMIC import, not only its static one', () => {
    // The orchestrator is reached by `await import('../src/lib/phone-canary1/index.js')`.
    // A walker blind to that hop would see two files and declare the closure clean.
    const entryScriptSpecs = CLOSURE.ownSpecifiers.get(rel(ROOTS[0])) as readonly string[];
    expect(entryScriptSpecs).toContain('../src/lib/phone-canary1/index.js');
  });

  it('CONTROL — the runtime stripper drops type-only imports and keeps value imports', () => {
    const seeded = [
      "import type { SupabaseClient } from '@supabase/supabase-js';",
      "export type { Foo } from './foo.js';",
      "import { isDialAllowedForDigest, type PhoneScreeningConfig } from './config.js';",
      "import { env } from '../../lib/env.js';",
    ].join('\n');
    const specs = runtimeSpecifiers(seeded);
    expect(specs).not.toContain('@supabase/supabase-js');
    expect(specs).not.toContain('./foo.js');
    // A mixed value+type clause still LOADS the module. Losing this would make
    // the whole walk silently under-report.
    expect(specs).toContain('./config.js');
    expect(specs).toContain('../../lib/env.js');
  });

  it('CONTROL — a bare side-effect import is seen', () => {
    // The first line of `lib/env.ts`. Without this arm the walker would report
    // a clean bare-specifier set for a closure that reads a dotfile.
    expect(runtimeSpecifiers("import 'dotenv/config';")).toContain('dotenv/config');
    expect(runtimeSpecifiers("import './side-effect.js';")).toContain('./side-effect.js');
    // …and it must not mistake a value import for one.
    expect(runtimeSpecifiers("import x from 'y';")).toEqual(['y']);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 1. THE DIRECT-IMPORT CONTRACT — no directory barrel in the canary's own files.
// ══════════════════════════════════════════════════════════════════════

describe('1. the canary CLI imports leaf modules, never a directory barrel', () => {
  it('no file in the package or the entry script names a forbidden barrel', () => {
    const violations: string[] = [];
    for (const [name, targets] of CLOSURE.ownTargets) {
      for (const target of targets) {
        if ((FORBIDDEN_BARRELS as readonly string[]).includes(target)) {
          violations.push(`${name} -> ${rel(target)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the two symbols the incident turned on come from their defining modules', () => {
    const originate = readFileSync(path.join(SRC, 'lib/phone-canary1/originate.ts'), 'utf8');
    const entry = readFileSync(path.join(SRC, 'lib/phone-canary1/entry.ts'), 'utf8');
    expect(stripToRuntime(originate)).toMatch(
      /resolvePhoneSipClient[\s\S]*?from '\.\.\/\.\.\/integrations\/livekit-phone-dial\/sip\.js'/,
    );
    expect(stripToRuntime(entry)).toMatch(
      /wrapDialableNumber[\s\S]*?from '\.\.\/\.\.\/integrations\/livekit-phone-dial\/dialable-number\.js'/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. THE CLOSURE ITSELF — transitively free of API environment and persistence.
// ══════════════════════════════════════════════════════════════════════

describe('2. nothing the canary CLI loads requires the API environment', () => {
  it('no forbidden API module is reachable', () => {
    const names = reachable(CLOSURE);
    const hit = FORBIDDEN_MODULES.filter((m) => names.includes(m));
    expect(hit).toEqual([]);
  });

  it('every runtime package the closure resolves is on the allowlist', () => {
    const offenders = [...CLOSURE.bare.entries()]
      .filter(([spec]) => !(ALLOWED_BARE as readonly string[]).includes(spec))
      .map(([spec, reachers]) => `${spec} <- ${reachers.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('specifically: neither dotenv nor the Supabase client is loaded', () => {
    // Named apart from the allowlist because these two ARE the incident: the
    // first reads a dotfile this mechanism refuses to run beside, the second
    // is a credential the operator's process does not hold.
    expect([...CLOSURE.bare.keys()]).not.toContain('dotenv');
    expect([...CLOSURE.bare.keys()]).not.toContain('dotenv/config');
    expect([...CLOSURE.bare.keys()]).not.toContain('@supabase/supabase-js');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. MUTATION CONTROLS — reintroducing the barrel must fail these assertions.
// ══════════════════════════════════════════════════════════════════════

describe('3. reintroducing the barrel import fails', () => {
  /** Re-run the walk with one file rewritten back to its pre-PR108 import. */
  function withBarrelRestored(fileRel: string, from: string, to: string): Closure {
    const abs = path.join(SRC, fileRel);
    const source = readFileSync(abs, 'utf8');
    expect(source, `${fileRel} no longer contains ${from}`).toContain(from);
    return walkClosure(new Map([[abs, source.replace(from, to)]]));
  }

  it('MUTANT — originate.ts back on the dialer barrel reaches lib/env and dotenv', () => {
    const mutated = withBarrelRestored(
      'lib/phone-canary1/originate.ts',
      "} from '../../integrations/livekit-phone-dial/sip.js';",
      "} from '../../integrations/livekit-phone-dial/index.js';",
    );
    const names = reachable(mutated);
    expect(names).toContain('lib/env.ts');
    expect(names).toContain('lib/room-provisioning.ts');
    expect([...mutated.bare.keys()]).toContain('dotenv/config');
    expect([...mutated.bare.keys()]).toContain('@supabase/supabase-js');
    // And the direct-import rule reports it by name rather than only by effect.
    const named = [...mutated.ownTargets.values()].flat().map(rel);
    expect(named).toContain('integrations/livekit-phone-dial/index.ts');
  });

  it('MUTANT — entry.ts back on the dialer barrel reaches lib/env', () => {
    const mutated = withBarrelRestored(
      'lib/phone-canary1/entry.ts',
      "from '../../integrations/livekit-phone-dial/dialable-number.js';",
      "from '../../integrations/livekit-phone-dial/index.js';",
    );
    expect(reachable(mutated)).toContain('lib/env.ts');
    expect([...mutated.bare.keys()]).toContain('dotenv/config');
  });

  it('MUTANT — the ENTRY SCRIPT\'s own spelling of the barrel is caught too', () => {
    // `app/api/scripts/phone-canary1.ts` reaches into `../src/...`, so it spells
    // the dialer barrel differently from every file in the package. This is the
    // case a specifier-string allowlist would have missed.
    const abs = ROOTS[0];
    const source = readFileSync(abs, 'utf8');
    const mutated = walkClosure(
      new Map([[
        abs,
        source.replace(
          "import {\n  installCanary1Containment,",
          "import { wrapDialableNumber } from '../src/integrations/livekit-phone-dial/index.js';\n"
            + 'void wrapDialableNumber;\n'
            + 'import {\n  installCanary1Containment,',
        ),
      ]]),
    );
    const named = [...mutated.ownTargets.values()].flat().map(rel);
    expect(named).toContain('integrations/livekit-phone-dial/index.ts');
    expect(reachable(mutated)).toContain('lib/env.ts');
  });

  it('MUTANT — a direct lib/env import anywhere in the package is reported', () => {
    const abs = path.join(SRC, 'lib/phone-canary1/plan.ts');
    const source = readFileSync(abs, 'utf8');
    const mutated = walkClosure(
      new Map([[abs, `import { env } from '../env.js';\nvoid env;\n${source}`]]),
    );
    expect(reachable(mutated)).toContain('lib/env.ts');
    expect([...mutated.bare.keys()]).toContain('dotenv/config');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. THE REAL LOADER, in a child process vitest has not pre-populated.
// ══════════════════════════════════════════════════════════════════════

/**
 * A deliberately bare environment. `PATH` and `HOME` only — no `SUPABASE_*`, no
 * `LIVEKIT_*`, nothing this repo's `.env.example` names. The cwd is this test
 * directory rather than `app/api`, so a developer's own `app/api/.env` cannot
 * be picked up by a cwd-relative dotenv read and quietly satisfy the very
 * variable the positive control depends on being absent.
 */
const BARE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
};

function runInBareChild(args: readonly string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', ...args], {
      cwd: TESTS_DIR,
      env: BARE_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

/**
 * ── THE TERMINUS, DERIVED ─────────────────────────────────────────────
 * `runCanary1` checks arming ahead of every credential and bound gate, so the
 * last check line a bare child can print is a function of `CANARY1_ARMED` and
 * of nothing else this suite can vary.
 *
 * Disarmed: the run stops AT the arming gate.
 * Armed: it passes arming, passes `credentials_transient` (a bare child has no
 * `app/api/.env` — unless the operator running this holds persisted LiveKit
 * credentials at the pinned path, which is the second legal armed terminus),
 * and stops at the first gate a bare environment cannot satisfy: the trunk.
 *
 * Every one of these is a REFUSAL BEFORE A SEAM. None of them contacts a
 * provider, which is why this suite may assert them from CI on either branch.
 */
const DISARMED_TERMINI = ['CANARY|canary1|armed|FAIL|canary1_not_armed'] as const;

const ARMED_TERMINI = [
  'CANARY|canary1|preflight_trunk_configured|FAIL|trunk_not_configured',
  'CANARY|canary1|credentials_transient|FAIL|credentials_persisted',
] as const;

const EXPECTED_TERMINI: readonly string[] = CANARY1_ARMED ? ARMED_TERMINI : DISARMED_TERMINI;

/**
 * Check names that can only be printed AFTER a provider client has been asked
 * to do something. A bare `--dry-run` must reach none of them on EITHER branch:
 * on `main` the arming gate stops it, on `canary1/arm` the trunk gate does. If
 * this list ever appears in the transcript of this test, a CI run has touched
 * LiveKit.
 */
const PROVIDER_SEAM_CHECKS = [
  'room_created',
  'dispatch_created',
  'worker_present_before_originate',
  'originate_answered',
  'originate_skipped',
  'conversation_observed',
  'teardown_room_absent',
] as const;

/** The last `CANARY|` check line, which is the run's terminus. */
function terminusOf(stdout: string): string {
  const lines = stdout.split('\n').filter((l) => l.startsWith('CANARY|'));
  return lines[lines.length - 1] ?? '<no CANARY line at all>';
}

describe('4. the CLI starts under an environment holding no API variables', () => {
  it('PRECONDITION — the child cwd holds no dotfile that could populate it', () => {
    expect(existsSync(path.join(TESTS_DIR, '.env'))).toBe(false);
    expect(Object.keys(BARE_ENV).sort()).toEqual(['HOME', 'PATH']);
  });

  it('POSITIVE CONTROL — lib/env.ts still throws in exactly this child', () => {
    // Without this, a green test below would be indistinguishable from a child
    // that inherited a populated environment after all.
    const envModule = path.join(SRC, 'lib/env.ts');
    const { stdout } = runInBareChild([
      '-e',
      `import(${JSON.stringify(envModule)}).then(` +
        `() => console.log('LOADED'), (e) => console.log('THREW:' + e.message))`,
    ]);
    expect(stdout).toContain('THREW:');
    expect(stdout).toContain('SUPABASE_URL');
    expect(stdout).not.toContain('LOADED');
  });

  it('CONTROL — the two terminus expectations are disjoint, so neither branch is waved through', () => {
    // The lazy repair for a branch-sensitive assertion is to accept both sets
    // on both branches, which would pass a disarmed tree that silently armed
    // itself and an armed tree that silently disarmed. This arm is what makes
    // the derivation above a gate rather than a widening.
    for (const armed of ARMED_TERMINI) {
      expect(DISARMED_TERMINI as readonly string[], 'terminus sets overlap').not.toContain(armed);
    }
    expect(EXPECTED_TERMINI).toEqual(CANARY1_ARMED ? ARMED_TERMINI : DISARMED_TERMINI);
    // …and the constant is the one the CHILD reads, not a copy.
    const armingSource = readFileSync(path.join(SRC, 'lib/phone-canary1/arming.ts'), 'utf8');
    expect(stripToRuntime(armingSource)).toContain(
      `export const CANARY1_ARMED: boolean = ${String(CANARY1_ARMED)};`,
    );
  });

  it('the dry run reaches its refusal grammar instead of crashing', () => {
    const { stdout } = runInBareChild([path.join(API_ROOT, 'scripts/phone-canary1.ts'), '--dry-run']);
    // THE REGRESSION. This exact line, alone, is what the incident produced.
    // Unconditional: it is a crash on any branch.
    expect(stdout).not.toContain('process_containment|FAIL|uncaught_exception');
    // Everything above the arming gate is branch-independent, and is asserted
    // as such rather than folded into the terminus.
    expect(stdout).toContain('CANARY|canary1|argv_accepted|PASS|ok');
    expect(stdout).toContain('CANARY|canary1|environment_accepted|PASS|ok');
    expect(stdout).toContain('CANARYDONE|');

    // The terminus itself, DERIVED — see EXPECTED_TERMINI. Asserted as the LAST
    // check line rather than as "appears somewhere", which is strictly stronger
    // than the alternation this replaces.
    const terminus = terminusOf(stdout);
    expect(EXPECTED_TERMINI, `unexpected terminus for CANARY1_ARMED=${String(CANARY1_ARMED)}`)
      .toContain(terminus);

    // The arming gate's own verdict must match the constant in BOTH directions,
    // so an armed tree cannot pass by printing the disarmed refusal or vice
    // versa.
    if (CANARY1_ARMED) {
      expect(stdout).toContain('CANARY|canary1|armed|PASS|ok');
      expect(stdout).not.toContain('canary1_not_armed');
    } else {
      expect(stdout).toContain('CANARY|canary1|armed|FAIL|canary1_not_armed');
      expect(stdout).not.toContain('CANARY|canary1|armed|PASS|ok');
    }
  });

  it('UNCONDITIONAL — a bare dry run reaches no provider seam on either branch', () => {
    // This is the invariant that lets the assertion above be branch-derived
    // without the armed branch quietly gaining reach: whichever gate stops the
    // run, it stops BEFORE any client is asked for anything.
    const { stdout } = runInBareChild([path.join(API_ROOT, 'scripts/phone-canary1.ts'), '--dry-run']);
    const reached = PROVIDER_SEAM_CHECKS.filter((check) => stdout.includes(`|${check}|`));
    expect(reached, 'a bare-environment dry run touched a provider seam').toEqual([]);
  });

  it('the orchestrator module imports cleanly with no API variable set', () => {
    const orchestrator = path.join(SRC, 'lib/phone-canary1/index.ts');
    const { stdout } = runInBareChild([
      '-e',
      `import(${JSON.stringify(orchestrator)}).then(` +
        `(m) => console.log('OK:' + typeof m.runCanary1), (e) => console.log('THREW:' + e.message))`,
    ]);
    expect(stdout).toContain('OK:function');
    expect(stdout).not.toContain('THREW:');
  });
});
