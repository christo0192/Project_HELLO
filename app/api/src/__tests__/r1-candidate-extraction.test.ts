/**
 * M034 S04: delegation pin for the R1 candidate router.
 *
 * S04 moved four pieces of the browser exchange out of `createR1CandidateRouter` into lib/r1:
 * the candidate join mint (candidate-join.ts), the marked-room provisioning (marked-room.ts),
 * the worker join gate (join-gate.ts) and the admission-time consent re-check (consent.ts).
 * The Meet exchange (S05) reuses those same functions, so this file stops a later edit from
 * quietly re-forking the browser path: the router must import and call the lib helpers, must
 * not grow local copies of them, must not call the bare worker gate (which skips the M019
 * shared-name interlock), and must not mint a subscribing candidate grant itself.
 *
 * The router is read with comments stripped, exactly as the room-isolation fence does, so
 * prose can neither satisfy nor trip a check. Control cases prove every matcher can fire.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../routes/r1-candidate.ts');

/** Strip comments so a pin cannot be satisfied (or tripped) by prose (r1-room-isolation.test.ts). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The value names imported from `modulePath` (for example '../lib/r1/join-gate.js'), across
 * every `import { ... } from` statement for it, tolerant of line breaks and trailing commas.
 * `import type { ... }` statements and inline `type X` specifiers are not value imports, so
 * they are left out. An aliased specifier counts under its exported name.
 */
function valueImportsFrom(source: string, modulePath: string): string[] {
  const statement = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(modulePath)}['"]`, 'g');
  const names: string[] = [];
  for (const match of source.matchAll(statement)) {
    for (const raw of match[1].split(',')) {
      const specifier = raw.trim();
      if (!specifier || /^type\s/.test(specifier)) continue;
      names.push(specifier.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

/** The lib/r1 helpers the router must import as values, by module. */
const REQUIRED_IMPORTS: ReadonlyArray<readonly [modulePath: string, names: readonly string[]]> = [
  ['../lib/r1/candidate-join.js', ['mintCandidateJoin']],
  ['../lib/r1/marked-room.js', ['provisionMarkedRoom']],
  ['../lib/r1/join-gate.js', ['r1WorkerGateMissing', 'runR1JoinGate']],
  ['../lib/r1/consent.js', ['recheckRoundConsent']],
];

/** Each lib helper the router must actually call (an import alone could be dead). */
const REQUIRED_CALLS = ['mintCandidateJoin', 'provisionMarkedRoom', 'r1WorkerGateMissing', 'runR1JoinGate', 'recheckRoundConsent'];

/** A local definition of any moved helper, under its old router name. */
const LOCAL_COPY = /function\s+(mintCandidateJoin|provisionMarkedRoom|sharedNameDispatchSafe|r1GateMissing)\b/;

/** A direct call of the bare worker gate; the router must go through `runR1JoinGate`. */
const BARE_WORKER_GATE_CALL = /runR1WorkerGate\s*\(/;

/** A subscribing grant literal. Today the only one was the candidate token; preflight subscribes to nothing. */
const SUBSCRIBING_GRANT = /\baddGrant\([^)]*canSubscribe:\s*true/s;

/**
 * Every `addGrant(...)` argument, cut at its balanced closing parenthesis, so a grant whose
 * literal holds a call (for example `canPublishSources: sources()`) is still read whole.
 */
function addGrantArguments(source: string): string[] {
  const found: string[] = [];
  const opener = /\baddGrant\(/g;
  for (const match of source.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    found.push(source.slice(start, index - 1));
  }
  return found;
}

function subscribingGrants(source: string): string[] {
  return addGrantArguments(source).filter((argument) => /canSubscribe:\s*true/.test(argument));
}

function missingImports(source: string): string[] {
  const missing: string[] = [];
  for (const [modulePath, names] of REQUIRED_IMPORTS) {
    const imported = valueImportsFrom(source, modulePath);
    for (const name of names) if (!imported.includes(name)) missing.push(`${name} from ${modulePath}`);
  }
  return missing;
}

function missingCalls(source: string): string[] {
  return REQUIRED_CALLS.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(source));
}

const router = stripComments(readFileSync(ROUTER, 'utf8'));

describe('R1 candidate router delegates to the lib/r1 join helpers (M034 S04)', () => {
  it('reads the real router source', () => {
    expect(router).toMatch(/export function createR1CandidateRouter\s*\(/);
  });

  it('imports mintCandidateJoin, provisionMarkedRoom, r1WorkerGateMissing, runR1JoinGate and recheckRoundConsent from lib/r1', () => {
    expect(missingImports(router)).toEqual([]);
  });

  it('calls each imported helper', () => {
    expect(missingCalls(router)).toEqual([]);
  });

  it('defines no local mintCandidateJoin, provisionMarkedRoom, sharedNameDispatchSafe or r1GateMissing', () => {
    expect(router.match(LOCAL_COPY)?.[0] ?? null).toBeNull();
  });

  it('never calls the bare runR1WorkerGate (it would skip the M019 shared-name interlock)', () => {
    expect(router.match(BARE_WORKER_GATE_CALL)?.[0] ?? null).toBeNull();
  });

  it('mints no subscribing grant itself (the candidate token comes from lib/r1/candidate-join.ts)', () => {
    expect(router.match(SUBSCRIBING_GRANT)?.[0] ?? null).toBeNull();
    expect(subscribingGrants(router)).toEqual([]);
  });

  it('still holds the preflight grant, so the grant matchers are reading real addGrant calls', () => {
    const grants = addGrantArguments(router);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/canSubscribe:\s*false/);
  });
});

describe('the delegation matchers fire on synthetic sources (controls)', () => {
  const imports = [
    "import { mintCandidateJoin } from '../lib/r1/candidate-join.js';",
    "import { provisionMarkedRoom } from '../lib/r1/marked-room.js';",
    "import { r1WorkerGateMissing, runR1JoinGate, type R1JoinGateDeps } from '../lib/r1/join-gate.js';",
    "import {\n  readRoundConsent,\n  recheckRoundConsent,\n  type Read,\n} from '../lib/r1/consent.js';",
  ].join('\n');
  const calls = [
    'await mintCandidateJoin(endpoint, session, roomName, { now });',
    'await provisionMarkedRoom(session, endpoint, { provisionRoom });',
    'r1WorkerGateMissing(endpoint, joinGateDeps);',
    'await runR1JoinGate({ endpoint, sessionId, roomName }, joinGateDeps);',
    'await recheckRoundConsent(db, round);',
  ].join('\n');

  it('a well-formed synthetic router passes every check', () => {
    const source = stripComments(`${imports}\n${calls}`);
    expect(missingImports(source)).toEqual([]);
    expect(missingCalls(source)).toEqual([]);
    expect(LOCAL_COPY.test(source)).toBe(false);
    expect(BARE_WORKER_GATE_CALL.test(source)).toBe(false);
    expect(SUBSCRIBING_GRANT.test(source)).toBe(false);
  });

  it('a local function mintCandidateJoin( is caught', () => {
    const source = stripComments(`${imports}\nasync function mintCandidateJoin(endpoint, session, roomName) {}\n`);
    expect(source.match(LOCAL_COPY)?.[1]).toBe('mintCandidateJoin');
  });

  it.each(['provisionMarkedRoom', 'sharedNameDispatchSafe', 'r1GateMissing'])('a local function %s is caught', (name) => {
    expect(stripComments(`function ${name}(endpoint) {}`).match(LOCAL_COPY)?.[1]).toBe(name);
  });

  it('a commented-out local copy is ignored, a live one is not', () => {
    expect(LOCAL_COPY.test(stripComments('// function mintCandidateJoin(endpoint) {}\n/* function r1GateMissing() {} */'))).toBe(false);
    expect(LOCAL_COPY.test(stripComments('const x = 1;\n  function r1GateMissing() {}'))).toBe(true);
  });

  it('a direct runR1WorkerGate( call is caught', () => {
    expect(BARE_WORKER_GATE_CALL.test(stripComments('const gate = await runR1WorkerGate({ gate, sessionId });'))).toBe(true);
  });

  it('a subscribing addGrant literal is caught, by the plan regex and by the balanced reader', () => {
    const source = stripComments(
      'token.addGrant({\n  room: roomName,\n  roomJoin: true,\n  canPublishSources: [TrackSource.MICROPHONE],\n  canSubscribe: true,\n});',
    );
    expect(SUBSCRIBING_GRANT.test(source)).toBe(true);
    expect(subscribingGrants(source)).toHaveLength(1);
  });

  it('the balanced reader also catches a subscribing grant whose literal holds a call', () => {
    const source = 'token.addGrant({ room: name(), canPublishSources: sources(), canSubscribe: true });';
    expect(subscribingGrants(source)).toHaveLength(1);
  });

  it('a missing or type-only import is reported, and a commented-out import does not count', () => {
    const typeOnly = imports.replace(
      "import { mintCandidateJoin } from '../lib/r1/candidate-join.js';",
      "import type { mintCandidateJoin } from '../lib/r1/candidate-join.js';",
    );
    expect(missingImports(stripComments(typeOnly))).toEqual(['mintCandidateJoin from ../lib/r1/candidate-join.js']);

    const inlineType = imports.replace('r1WorkerGateMissing, runR1JoinGate', 'r1WorkerGateMissing, type runR1JoinGate');
    expect(missingImports(stripComments(inlineType))).toEqual(['runR1JoinGate from ../lib/r1/join-gate.js']);

    const commented = imports.replace(
      "import { provisionMarkedRoom } from '../lib/r1/marked-room.js';",
      "// import { provisionMarkedRoom } from '../lib/r1/marked-room.js';",
    );
    expect(missingImports(stripComments(commented))).toEqual(['provisionMarkedRoom from ../lib/r1/marked-room.js']);
  });

  it('an imported helper that is never called is reported', () => {
    const source = stripComments(`${imports}\n${calls.replace('await runR1JoinGate(', 'await somethingElse(')}`);
    expect(missingCalls(source)).toEqual(['runR1JoinGate']);
  });
});
