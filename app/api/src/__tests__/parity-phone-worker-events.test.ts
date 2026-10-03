import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: () => { throw new Error('unused') } },
}));

import { WORKER_PHONE_EVENTS, PURGE_BEFORE_EVENTS } from '../routes/phone-worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_PATH = path.join(__dirname, '../../../voice-livekit/phone.py');

/**
 * THE GAP THIS CLOSES (0095 / issue #286).
 *
 * The phone worker event allowlist exists in TWO places — `WORKER_PHONE_EVENTS`
 * here in the API route, and `PHONE_WORKER_EVENTS` in `phone.py`, which the
 * worker enforces LOCALLY before it ever makes a request. Nothing compared
 * them.
 *
 * 0095 added `consent.failed` to the server half and not the worker half. The
 * worker therefore refused to post its own new event: it short-circuited,
 * logged `consent_failed_not_applied`, and returned. The pre-consent audio was
 * not purged and the engagement was not released — issue #286 was unchanged on
 * the primary path, in a PR whose entire purpose was to fix it.
 *
 * Every test passed, because `FakeEventClient` in `test_phone_gate.py` records
 * whatever it is handed and has no allowlist. The assertions were true of the
 * double and false of production. A worker-side allowlist can only be verified
 * against the server-side one, which is what this file does.
 */
function parsePyWorkerEvents(content: string): Set<string> {
  const anchor = 'PHONE_WORKER_EVENTS: frozenset[str] = frozenset(';
  const i = content.indexOf(anchor);
  if (i === -1) throw new Error('PHONE_WORKER_EVENTS anchor missing in phone.py');
  let p = i + anchor.length;
  while (p < content.length && /\s/.test(content[p])) p++;
  const open = content[p];
  if (open !== '[' && open !== '{') throw new Error('PHONE_WORKER_EVENTS: bad open delimiter');
  const closeCh = open === '[' ? ']' : '}';
  const e = content.indexOf(closeCh, p);
  if (e === -1) throw new Error('PHONE_WORKER_EVENTS: close delimiter missing');
  const block = content.slice(p + 1, e);
  const set = new Set<string>();
  for (const line of block.split('\n')) {
    // Comment lines are stripped BEFORE literal extraction, so the prose
    // explaining an entry cannot contribute a phantom member.
    if (line.trim().startsWith('#')) continue;
    for (const m of line.match(/"([^"]*)"/g) || []) set.add(m.slice(1, -1));
  }
  return set;
}

describe('parity-phone-worker-events', () => {
  const src = fs.readFileSync(PY_PATH, 'utf-8');
  const py = parsePyWorkerEvents(src);

  it('parses a non-trivial worker allowlist out of phone.py', () => {
    // Fail closed: a parser that silently returns {} would make every
    // assertion below vacuous, which is the failure mode this whole file is
    // about.
    expect(py.size).toBeGreaterThan(5);
    expect(py.has('call.answered')).toBe(true);
  });

  it('the worker allowlist and the server allowlist are the SAME set', () => {
    expect([...py].sort()).toEqual([...WORKER_PHONE_EVENTS].sort());
  });

  it('consent.failed is postable by the worker (0095 — the event that was not)', () => {
    // Named explicitly rather than left to the set comparison, because this
    // is the specific omission that made issue #286's fix inert, and a future
    // edit that drops it should fail on the NAME, not only on a set diff.
    expect(py.has('consent.failed')).toBe(true);
    expect(WORKER_PHONE_EVENTS).toContain('consent.failed');
  });

  it('every event that triggers a recording purge is one the worker can post', () => {
    // A purge event the worker cannot post is a purge that never happens.
    for (const event of PURGE_BEFORE_EVENTS) {
      expect(py.has(event), `${event} triggers a purge but phone.py refuses to post it`).toBe(true);
    }
  });

  it('the M009 E6 pre-answer verdicts are postable on BOTH sides (0113)', () => {
    // Named, like consent.failed above: a worker that refuses its own
    // ring-out verdict locally would leave every unanswered leg to the lease
    // reclaimer — the redial loop E6 exists to end — while the set diff alone
    // would only say "sets differ".
    for (const event of ['call.no_answer', 'call.busy', 'call.failed']) {
      expect(py.has(event), `${event} missing from phone.py`).toBe(true);
      expect(WORKER_PHONE_EVENTS, `${event} missing from the route`).toContain(event);
    }
  });

  it('the worker still cannot post a PROVIDER verdict (sip.originate_*)', () => {
    for (const set of [[...py], [...WORKER_PHONE_EVENTS]]) {
      expect(set.some((e) => e.startsWith('sip.originate'))).toBe(false);
    }
  });

  it('no pre-answer verdict triggers a recording purge', () => {
    // An unanswered leg has no audio; a purge trigger here would make a
    // broken purge seam 503 the verdict that ends the attempt.
    for (const event of ['call.no_answer', 'call.busy', 'call.failed']) {
      expect(PURGE_BEFORE_EVENTS.has(event)).toBe(false);
    }
  });

  it('the documented OpenAPI enum is the SAME set as the route allowlist', () => {
    // The third copy of the vocabulary. It had already drifted (call.answered
    // and consent.failed were never documented); pinned so it cannot again.
    const yaml = fs
      .readFileSync(path.join(__dirname, '../../openapi/openapi.yaml'), 'utf-8')
      .replace(/\r\n/g, '\n');
    const start = yaml.indexOf('\n    PhoneWorkerEventRequest:\n');
    expect(start, 'PhoneWorkerEventRequest schema missing').toBeGreaterThan(-1);
    const eventType = yaml.indexOf('\n        event_type:\n', start);
    const enumAt = yaml.indexOf('\n          enum:\n', eventType);
    expect(eventType).toBeGreaterThan(start);
    expect(enumAt).toBeGreaterThan(eventType);
    const documented: string[] = [];
    for (const line of yaml.slice(enumAt + '\n          enum:\n'.length).split('\n')) {
      const m = /^ {12}- ([a-z][a-z0-9_.]*)$/.exec(line);
      if (!m) break;
      documented.push(m[1]);
    }
    expect(documented.length).toBeGreaterThan(5);
    expect([...documented].sort()).toEqual([...WORKER_PHONE_EVENTS].sort());
  });

  it('screening.not_started is NOT worker-postable', () => {
    // It is posted by the API runtime from the partial-finalize sweep, which
    // has PROVEN there is no candidate turn. A worker able to post it could
    // assert "no screening happened" about a call it did not finish reading,
    // and drive a redial on that claim.
    expect(py.has('screening.not_started')).toBe(false);
    expect(WORKER_PHONE_EVENTS).not.toContain('screening.not_started');
  });
});
