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

  it('screening.not_started is NOT worker-postable', () => {
    // It is posted by the API runtime from the partial-finalize sweep, which
    // has PROVEN there is no candidate turn. A worker able to post it could
    // assert "no screening happened" about a call it did not finish reading,
    // and drive a redial on that claim.
    expect(py.has('screening.not_started')).toBe(false);
    expect(WORKER_PHONE_EVENTS).not.toContain('screening.not_started');
  });
});
