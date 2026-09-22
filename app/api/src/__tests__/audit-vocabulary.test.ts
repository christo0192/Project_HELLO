/**
 * The `AuditEvent` union against `chk_audit_action`, the closed allowlist the
 * database actually enforces.
 *
 * WHY THIS TEST EXISTS. "Ask Hello" added the event `resource.generate` and
 * shipped to CI with no migration widening the constraint. Every failure mode
 * in the chain is silent by design, and together they hide the bug completely:
 *
 *   - the insert violates the CHECK, so the sink throws;
 *   - `resource.generate` is not in `FAIL_CLOSED_EVENTS`, so `recordAudit`
 *     swallows the throw;
 *   - the route wraps the call in its own try/catch ON PURPOSE, because a
 *     drafting request writes no role and must not be lost to a dead sink.
 *
 * Result: zero audit rows, forever, and the only signal is an
 * `audit_sink_failure` line among the logs. The route test did not catch it
 * either — it mocks `../lib/audit.js`, so it asserts the CALL and never the
 * write. That is the general shape of the trap: a mocked sink cannot fail the
 * way a real constraint does.
 *
 * So the check has to come from the SQL. This reads the last migration that
 * re-created the constraint and compares it to the union in the source. Adding
 * an `AuditEvent` without a migration now fails here, at the desk, instead of
 * in production where nothing reports it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../../supabase/migrations');
const AUDIT_TS = path.resolve(HERE, '../lib/audit.ts');

/**
 * The action list from the LAST migration that re-creates `chk_audit_action`.
 *
 * Last, not merged-across-all: the constraint is dropped and re-created whole
 * every time, so only the final definition is live. A test that unioned every
 * migration's list would pass while the live constraint was missing members.
 */
function liveAuditActions(): { migration: string; actions: Set<string> } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { migration: string; actions: Set<string> } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const m = sql.match(
      /add constraint chk_audit_action check \(\s*action = any \(array\[([\s\S]*?)\]\s*\)/,
    );
    if (!m) continue;
    const body = m[1]
      // strip `-- 0097` style generation markers before splitting
      .replace(/--[^\n]*/g, '');
    const actions = new Set(
      [...body.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]),
    );
    found = { migration: file, actions };
  }
  if (!found) throw new Error('no migration defines chk_audit_action');
  return found;
}

/**
 * The `AuditEvent` union, read from the source rather than imported.
 *
 * A type cannot be enumerated at runtime, and re-declaring the list here would
 * be a third copy that drifts with the other two.
 */
function auditEvents(): Set<string> {
  // COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The union is
  // annotated, and one of those annotations ends '...so the union is stable;
  // L6 uses it.' — a semicolon inside a line comment. Matching up to the
  // first ';' therefore captured 17 of the ~90 members and every assertion
  // below passed against that stump. The scaffolding tests in this file exist
  // because that is exactly how a parity test dies quietly.
  const src = readFileSync(AUDIT_TS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const m = src.match(/export type AuditEvent =([\s\S]*?);/);
  if (!m) throw new Error('could not find the AuditEvent union');
  return new Set([...m[1].matchAll(/'([a-z0-9_.]+)'/g)].map((x) => x[1]));
}

/** What the sink writes for an event — the transform is in `audit.ts`. */
const toAction = (event: string) => event.replaceAll('.', '_');

describe('audit vocabulary', () => {
  it('finds the live constraint at all', () => {
    // If the regex above ever stops matching, every assertion below would
    // vacuously pass against an empty set. Fail loudly instead.
    const { migration, actions } = liveAuditActions();
    expect(migration).toMatch(/^\d{4}_/);
    expect(actions.size).toBeGreaterThan(80);
    expect(actions.has('login_success')).toBe(true);
  });

  it('finds the union at all', () => {
    const events = auditEvents();
    expect(events.size).toBeGreaterThan(25);
    // One from the TOP of the union and one from the very BOTTOM: a parser
    // that stops early still finds the first, so only the last proves the
    // whole declaration was read. This caught a real bug in this file — the
    // first version matched to the first `;`, which lives inside a line
    // comment mid-union, and parsed 17 of 28 members. Every assertion below
    // passed against that stump.
    expect(events.has('auth.login_success')).toBe(true);
    expect(events.has('appeal.review')).toBe(true);
  });

  it('EVERY AuditEvent is writable — the constraint admits it', () => {
    // The direction that matters. An event the database refuses is an audit
    // record that does not exist, discovered only by reading logs nobody reads.
    const { migration, actions } = liveAuditActions();
    const missing = [...auditEvents()]
      .map(toAction)
      .filter((a) => !actions.has(a))
      .sort();
    expect(
      missing,
      `these AuditEvents are not in chk_audit_action (last set by ${migration}) — ` +
        'add a migration re-creating the constraint with the full list plus these',
    ).toEqual([]);
  });

  it('admits `resource_generate` specifically', () => {
    // The one that shipped broken. Named on its own so a regression reads as
    // itself rather than as a diff of two large sets.
    expect(liveAuditActions().actions.has('resource_generate')).toBe(true);
    expect(auditEvents().has('resource.generate')).toBe(true);
  });

  it('is deliberately ONE-DIRECTIONAL, and says why', () => {
    // I wrote the reverse assertion first — "no constraint member is
    // unwritable" — and it failed with ~60 names. That is not a defect: the
    // TypeScript `AuditEvent` union is only the EXPRESS API's writers. The
    // phone and Ashby vocabularies belong to the Python voice worker and to
    // SQL RPCs, which never pass through `recordAudit`, so the constraint is
    // correctly a superset. Asserting a bijection here would have forced
    // someone to either delete live vocabulary or add dead union members.
    //
    // Pinned as a fact rather than deleted, so the next person to have the
    // same idea reads the answer instead of rediscovering it.
    const { actions } = liveAuditActions();
    const writable = new Set([...auditEvents()].map(toAction));
    const outsideTypescript = [...actions].filter((a) => !writable.has(a));
    expect(outsideTypescript.length).toBeGreaterThan(0);
    expect(outsideTypescript).toContain('phone_suppression_released');
  });
});
