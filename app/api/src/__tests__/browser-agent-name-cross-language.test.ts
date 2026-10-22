/**
 * M019 — the two-sided pin between the Python R1 browser worker's per-machine
 * registration name and the API's shared per-machine name helpers.
 *
 * ── WHY THIS IS A CROSS-LANGUAGE TEST ─────────────────────────────────
 * The browser worker (app/voice-livekit/agent.py
 * `browser_registered_agent_name`) REGISTERS `<BROWSER_AGENT_NAME>-<FLY_MACHINE_ID>`
 * with LiveKit and reports it on its post-registration ready post; the R1 gate
 * (`browser-orchestration.ts`) dispatches only to a reported name that
 * `lib/worker-agent-name.ts` accepts for the lease's machine. If the two
 * disagree, either every ready post 400s and every exchange defers, or the
 * API dispatches to a name no worker listens on. The phone lane has the same
 * pin (`phone-agent-name-cross-language.test.ts`); this one covers the browser
 * helper, its flag gate and the browser base name the two deploy configs set.
 *
 * Like the phone pin it READS THE PYTHON SOURCE and runs one fixture list
 * through both sides without executing Python (CI's API job has no
 * interpreter guarantee).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AGENT_NAME_RE,
  PER_MACHINE_ID_RE,
  isMachineAgentNameUnder,
  isReportedMachineAgentName,
  machineAgentName,
} from '../lib/worker-agent-name.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');
const AGENT_PY = read('app/voice-livekit/agent.py');

/** `NAME = re.compile(r'...')`, a single-quoted raw string on one line. */
function pyRawRegex(source: string, name: string): string {
  const match = new RegExp(`^${name} = re\\.compile\\(r'([^'\\n]*)'\\)\\s*$`, 'm').exec(source);
  if (match === null) throw new Error(`python regex constant not found: ${name}`);
  return match[1] as string;
}

/** The body of a top-level Python function, up to the next top-level statement. */
function pyFunctionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^def ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`python function not found: ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(def |class |[A-Za-z_][A-Za-z0-9_]* = )/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** A quoted `KEY = "value"` inside a fly.toml [env] table, or undefined. */
function flyEnvValue(text: string, key: string): string | undefined {
  let inEnv = false;
  for (const raw of text.split('\n')) {
    if (/^\s*\[env\]\s*$/.test(raw)) { inEnv = true; continue; }
    if (inEnv && /^\s*\[[^\]]+\]\s*$/.test(raw)) break;
    if (!inEnv) continue;
    const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return undefined;
}

const PY_ID_RE_SOURCE = pyRawRegex(AGENT_PY, '_PER_MACHINE_ID_RE');
const PY_NAME_RE_SOURCE = pyRawRegex(AGENT_PY, '_PER_MACHINE_AGENT_NAME_RE');
const PY_HELPER = pyFunctionBody(AGENT_PY, 'browser_registered_agent_name');
const PY_GATE = pyFunctionBody(AGENT_PY, '_browser_per_machine_agent_name_enabled');

// Anchored, character classes and bounded repetition only: Python and
// JavaScript read them identically, so this is a faithful model of fullmatch.
const PY_ID_RE = new RegExp(PY_ID_RE_SOURCE);
const PY_NAME_RE = new RegExp(PY_NAME_RE_SOURCE);

/** Model of the worker helper's naming decision (opted in on the R1 lane). */
function pythonRegisteredName(base: string, machineId: string | undefined): string {
  const id = machineId ?? '';
  if (!id || !PY_ID_RE.test(id)) return base;
  const composed = `${base}-${id}`;
  return PY_NAME_RE.test(composed) ? composed : base;
}

const BASE = 'browser-screener';

// [machine id, valid?] — shared across both sides (same list as the phone pin).
const MACHINE_IDS: ReadonlyArray<readonly [string, boolean]> = [
  ['89122ec60edd28', true],
  ['d895472c499e38', true],
  ['7812736a540d58', true],
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

describe('per-machine BROWSER agent name: Python worker ⇄ TypeScript API', () => {
  it('the worker uses the same two literals the shared API module does', () => {
    expect(PY_ID_RE_SOURCE).toBe(PER_MACHINE_ID_RE.source);
    expect(PY_NAME_RE_SOURCE).toBe(AGENT_NAME_RE.source);
    expect(PER_MACHINE_ID_RE.flags).toBe('');
    expect(AGENT_NAME_RE.flags).toBe('');
  });

  it('the browser helper composes `<base>-<machine id>` with fullmatch', () => {
    expect(PY_HELPER).toMatch(/base = _browser_agent_name\(\)/);
    expect(PY_HELPER).toMatch(/f"\{base\}-\{machine_id\}"/);
    expect(PY_HELPER).toMatch(/_PER_MACHINE_ID_RE\.fullmatch\(machine_id\)/);
    expect(PY_HELPER).toMatch(/_PER_MACHINE_AGENT_NAME_RE\.fullmatch\(registered\)/);
    // `.match(` would accept a trailing newline that JavaScript rejects.
    expect(PY_HELPER).not.toMatch(/_PER_MACHINE_(ID|AGENT_NAME)_RE\.match\(/);
    expect(PY_HELPER).toMatch(/if not _browser_per_machine_agent_name_enabled\(\):\s*\n\s*return base/);
  });

  it('the worker gate is the exact flag, bounded by the R1 readiness switch', () => {
    // Exact "true": the API rollout reads the worker's posture from this.
    expect(PY_GATE).toMatch(/os\.getenv\("BROWSER_PER_MACHINE_AGENT_NAME"\) == "true"/);
    expect(PY_GATE).not.toMatch(/BROWSER_PER_MACHINE_AGENT_NAME"\)[^\n]*\.(strip|lower)\(/);
    // The Cloud API dispatches the shared name, so the worker may only use a
    // per-machine name on the R1 lane (R1_READINESS_HOST=on).
    expect(PY_GATE).toMatch(/return _browser_r1_readiness\(\) and /);
  });

  it.each(MACHINE_IDS)('machine id %j: both sides agree (valid=%s)', (id, valid) => {
    expect(PER_MACHINE_ID_RE.test(id)).toBe(valid);
    expect(PY_ID_RE.test(id)).toBe(valid);

    const tsName = machineAgentName(BASE, id);
    const pyName = pythonRegisteredName(BASE, id);
    if (valid) {
      expect(tsName).toBe(`${BASE}-${id}`);
      expect(pyName).toBe(tsName);
      // What the worker registers and reports is exactly what the R1 gate
      // trusts for this lease's machine, and recognises as its own dispatch.
      expect(isReportedMachineAgentName(BASE, id, pyName)).toBe(true);
      expect(isMachineAgentNameUnder(BASE, pyName)).toBe(true);
      expect(AGENT_NAME_RE.test(pyName)).toBe(true);
    } else {
      expect(tsName).toBeNull();
      // The worker falls back to the BASE name and reports none; the API then
      // dispatches the base name, which is what was registered.
      expect(pyName).toBe(BASE);
      expect(isReportedMachineAgentName(BASE, id, pyName)).toBe(false);
      expect(isMachineAgentNameUnder(BASE, pyName)).toBe(false);
    }
  });

  it('a missing FLY_MACHINE_ID registers the base name', () => {
    expect(pythonRegisteredName(BASE, undefined)).toBe(BASE);
  });

  it('a name reported for ANOTHER machine is never trusted for this lease', () => {
    const reported = pythonRegisteredName(BASE, 'd895472c499e38');
    expect(isReportedMachineAgentName(BASE, '7812736a540d58', reported)).toBe(false);
    expect(isReportedMachineAgentName('phone-screener', 'd895472c499e38', reported)).toBe(false);
  });

  it('a base the API contract rejects falls back on both sides', () => {
    for (const base of ['b'.repeat(65), 'browser.screener', 'browser screener']) {
      expect(machineAgentName(base, 'd895472c499e38')).toBeNull();
      expect(pythonRegisteredName(base, 'd895472c499e38')).toBe(base);
    }
    // The boundary: a 64-character base composes on both sides.
    const base64 = 'b'.repeat(64);
    expect(pythonRegisteredName(base64, 'd895472c499e38')).toBe(machineAgentName(base64, 'd895472c499e38'));
  });

  it('the shipped worker and API deploy configs name the same base, and it composes', () => {
    const workerBase = flyEnvValue(read('app/voice-livekit/fly.toml'), 'BROWSER_AGENT_NAME');
    const apiBase = flyEnvValue(read('app/api/fly.toml'), 'BROWSER_AGENT_NAME');
    expect(workerBase).toBeDefined();
    expect(workerBase).toBe(apiBase);
    const id = '89122ec60edd28';
    const pyName = pythonRegisteredName(workerBase as string, id);
    expect(pyName).toBe(`${workerBase}-${id}`);
    expect(isReportedMachineAgentName(apiBase as string, id, pyName)).toBe(true);
  });
});
