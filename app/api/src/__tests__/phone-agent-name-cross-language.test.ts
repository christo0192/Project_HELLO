/**
 * M009 E2 — the two-sided pin between the Python worker's per-machine
 * registration name and the API's agent-name helpers.
 *
 * ── WHY THIS IS A CROSS-LANGUAGE TEST ─────────────────────────────────
 * The worker (app/voice-livekit/agent.py `phone_registered_agent_name`)
 * REGISTERS `<base>-<FLY_MACHINE_ID>` with LiveKit and reports it on its
 * ready ping; the API (`agent-name.ts`) only dispatches to a reported name
 * that `isReportedAgentNameFor` accepts. If the two disagree on which machine
 * ids are valid, one of two silent failures follows:
 *
 *   * the worker registers a name the API rejects → every ready ping 400s
 *     (fail-open), the gate times out, and every dial defers;
 *   * the API would accept a name the worker never registers → a dispatch to
 *     a name nothing listens on (the dial-into-silence the join barrier
 *     exists to catch, but should never have to).
 *
 * So this file READS THE PYTHON SOURCE, extracts the two regex literals and
 * the f-string that composes the name, and runs one fixture list through
 * both sides. It deliberately does not execute Python: CI's API job has no
 * interpreter guarantee, and a literal comparison plus a shared fixture list
 * is enough to make drift on either side go red.
 *
 * Python's `$` also matches before a trailing newline; the worker therefore
 * uses `fullmatch`. That is asserted from the source too, because with
 * `match` the same literal would accept `"<id>\n"` where JavaScript rejects.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AGENT_NAME_RE,
  PER_MACHINE_ID_RE,
  isReportedAgentNameFor,
  phoneMachineAgentName,
} from '../integrations/livekit-phone-dial/agent-name.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AGENT_PY = readFileSync(path.join(REPO, 'app/voice-livekit/agent.py'), 'utf8');

/**
 * Read `NAME = re.compile(r'...')` — a single-quoted raw-string literal on one
 * line, the only form the worker uses for these constants. Narrow on purpose:
 * an extractor that accepts more forms than the source contains can return
 * the wrong thing silently.
 */
function pyRawRegex(source: string, name: string): string {
  const match = new RegExp(`^${name} = re\\.compile\\(r'([^'\\n]*)'\\)\\s*$`, 'm').exec(source);
  if (match === null) throw new Error(`python regex constant not found: ${name}`);
  return match[1] as string;
}

/** The body of a top-level Python function, up to the next top-level def. */
function pyFunctionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^def ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`python function not found: ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(def |class |[A-Za-z_][A-Za-z0-9_]* = )/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const PY_ID_RE_SOURCE = pyRawRegex(AGENT_PY, '_PER_MACHINE_ID_RE');
const PY_NAME_RE_SOURCE = pyRawRegex(AGENT_PY, '_PER_MACHINE_AGENT_NAME_RE');
const PY_HELPER = pyFunctionBody(AGENT_PY, 'phone_registered_agent_name');

// Both patterns are anchored and use only syntax Python and JavaScript read
// identically (character classes, bounded repetition), so compiling the
// Python source as a JS RegExp is a faithful model of `fullmatch`.
const PY_ID_RE = new RegExp(PY_ID_RE_SOURCE);
const PY_NAME_RE = new RegExp(PY_NAME_RE_SOURCE);

/** Model of the worker helper's naming decision (orchestrated + flag on). */
function pythonRegisteredName(base: string, machineId: string | undefined): string {
  const id = machineId ?? '';
  if (!id || !PY_ID_RE.test(id)) return base;
  const composed = `${base}-${id}`;
  return PY_NAME_RE.test(composed) ? composed : base;
}

const BASE = 'phone-screener';

// [machine id, valid?] — shared across both sides.
const MACHINE_IDS: ReadonlyArray<readonly [string, boolean]> = [
  ['d895472c499e38', true],
  ['7812736a540d58', true],
  ['185121df799d98', true],
  ['abcdefgh', true],
  ['a'.repeat(32), true],
  ['0123456789', true],
  ['', false],
  ['ABC', false],
  ['D895472C499E38', false],
  ['abcdefg', false],
  ['a'.repeat(33), false],
  ['a.b', false],
  ['a.bcdefgh', false],
  ['ab-cdefgh', false],
  ['abc_defgh', false],
  [' d895472c499e38', false],
  ['d895472c499e38\n', false],
];

describe('per-machine agent name: Python worker ⇄ TypeScript API', () => {
  it('the machine-id pattern is the same literal on both sides', () => {
    expect(PY_ID_RE_SOURCE).toBe(PER_MACHINE_ID_RE.source);
    expect(PER_MACHINE_ID_RE.flags).toBe('');
  });

  it('the composed-name pattern is the same literal on both sides', () => {
    expect(PY_NAME_RE_SOURCE).toBe(AGENT_NAME_RE.source);
    expect(AGENT_NAME_RE.flags).toBe('');
  });

  it('the worker composes `<base>-<machine id>` and matches with fullmatch', () => {
    expect(PY_HELPER).toMatch(/f"\{base\}-\{machine_id\}"/);
    expect(PY_HELPER).toMatch(/_PER_MACHINE_ID_RE\.fullmatch\(machine_id\)/);
    expect(PY_HELPER).toMatch(/_PER_MACHINE_AGENT_NAME_RE\.fullmatch\(registered\)/);
    // `.match(` would accept a trailing newline that JavaScript rejects.
    expect(PY_HELPER).not.toMatch(/_PER_MACHINE_(ID|AGENT_NAME)_RE\.match\(/);
    // The flag gate the API's rollout depends on.
    expect(AGENT_PY).toMatch(/os\.getenv\("PHONE_PER_MACHINE_AGENT_NAME"\)[^\n]*\.strip\(\)\.lower\(\) == "true"/);
  });

  it.each(MACHINE_IDS)('machine id %j: both sides agree (valid=%s)', (id, valid) => {
    expect(PER_MACHINE_ID_RE.test(id)).toBe(valid);
    expect(PY_ID_RE.test(id)).toBe(valid);

    const tsName = phoneMachineAgentName(BASE, id);
    const pyName = pythonRegisteredName(BASE, id);
    if (valid) {
      expect(tsName).toBe(`${BASE}-${id}`);
      expect(pyName).toBe(tsName);
      // What the worker registers and reports is exactly what the API trusts
      // for this lease's machine.
      expect(isReportedAgentNameFor(BASE, id, pyName)).toBe(true);
      expect(AGENT_NAME_RE.test(pyName)).toBe(true);
    } else {
      expect(tsName).toBeNull();
      // The worker falls back to the BASE name and reports none — the API
      // then dispatches the base name, which is what was registered.
      expect(pyName).toBe(BASE);
      expect(isReportedAgentNameFor(BASE, id, pyName)).toBe(false);
    }
  });

  it('a missing FLY_MACHINE_ID registers the base name', () => {
    expect(pythonRegisteredName(BASE, undefined)).toBe(BASE);
  });

  it('a name reported for ANOTHER machine is never trusted for this one', () => {
    const reported = pythonRegisteredName(BASE, 'd895472c499e38');
    expect(isReportedAgentNameFor(BASE, '7812736a540d58', reported)).toBe(false);
    expect(isReportedAgentNameFor('other-base', 'd895472c499e38', reported)).toBe(false);
  });

  it('a base the API contract rejects falls back on both sides', () => {
    for (const base of ['p'.repeat(65), 'phone.screener', 'phone screener']) {
      expect(phoneMachineAgentName(base, 'd895472c499e38')).toBeNull();
      expect(pythonRegisteredName(base, 'd895472c499e38')).toBe(base);
    }
  });
});
