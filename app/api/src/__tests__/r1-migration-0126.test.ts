/**
 * Static guarantees for migration 0126 (R1 smoke readiness, PR-B). The behavioural SQL assertions
 * run in supabase-ci (app/supabase/tests/r1_incomplete_attempts_assert.sql, wired by
 * scripts/test-r1-foundation.sh); these checks keep the migration to exactly what it claims: two
 * re-declared functions, each its predecessor VERBATIM except for one stated change, and in step
 * with the TypeScript scorer that consumes the job it enqueues.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { R1_ASSESSMENT_QUEUE } from '../lib/r1/assessment-handler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0126_r1_score_incomplete_attempts.sql';
const read = (name: string): string =>
  readFileSync(path.join(migrations, name), 'utf8').replace(/\r\n/g, '\n');
const sql = read(FILE);
const code = sql.replace(/^\s*--.*$/gm, '');

/** Comments dropped and every whitespace run collapsed: a verbatim comparison that survives rewrapping. */
const norm = (text: string): string =>
  text.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();

/** One `create or replace function screening_v2.<name>(` from header to its closing `$$;`. */
function declaration(text: string, name: string): string {
  const start = text.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = text.indexOf('\n$$;', start);
  expect(end, `${name} terminator`).toBeGreaterThan(start);
  return text.slice(start, end + 4);
}

describe('migration 0126', () => {
  it('is the only migration with its number, carries the _r1_ infix, and changes no table', () => {
    const number = FILE.slice(0, 4);
    expect(readdirSync(migrations).filter((name) => name.startsWith(`${number}_`))).toEqual([FILE]);
    expect(FILE).toMatch(/^\d{4}_r1_/);
    expect(code).toMatch(/set local lock_timeout = '10s';/);
    expect(code).not.toMatch(/\bdrop\b|\btruncate\b|\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\balter\s+table\b|\bcreate\s+(unique\s+)?index\b|\bcreate\s+table\b|\bcreate\s+view\b/i);
    // The migrate-rollback verifier cannot classify CREATE OR REPLACE TRIGGER, and this adds none.
    expect(code).not.toMatch(/\bcreate\s+(or\s+replace\s+)?trigger\b/i);
    expect(code.match(/create or replace function/g)).toHaveLength(2);
  });

  it('r1_settle_attempt is 0120 verbatim plus ONE enqueue for a counted FAILED attempt with a live consent', () => {
    const previous = norm(declaration(read('0120_r1_candidate_route_primitives.sql'), 'r1_settle_attempt'));
    const next = norm(declaration(sql, 'r1_settle_attempt'));
    expect(next).not.toBe(previous);
    // Remove exactly the added block: from its `if` to the `end if;` that closes it.
    const start = next.indexOf("if v_session_status = 'failed'");
    expect(start).toBeGreaterThan(-1);
    const closer = 'on conflict do nothing; end if;';
    const end = next.indexOf(closer, start);
    expect(end).toBeGreaterThan(start);
    const withoutBlock = `${next.slice(0, start)}${next.slice(end + closer.length)}`.replace(/\s+/g, ' ');
    expect(withoutBlock.replace(/\s+/g, ' ')).toBe(previous.replace(/\s+/g, ' '));
  });

  it('the enqueue matches the 0116 trigger and the queue the handler is registered for', () => {
    const block = norm(declaration(sql, 'r1_settle_attempt'));
    const trigger = norm(read('0116_r1_shared_session_fields.sql'));
    expect(R1_ASSESSMENT_QUEUE).toBe('r1.assessment');
    for (const part of [
      "insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)",
      "values ('r1.assessment', jsonb_build_object('session_id', p_session_id), 'r1.assessment:' || p_session_id::text, 5)",
      'on conflict do nothing',
    ]) expect(block, part).toContain(part);
    // The very same shape the completion trigger writes (name, payload key, dedup key, attempts).
    expect(trigger).toContain("values ('r1.assessment', jsonb_build_object('session_id', new.id), 'r1.assessment:' || new.id::text, 5)");
  });

  it('only a FAILED session with a LIVE consent is queued: never a cancelled one, never a withdrawn consent', () => {
    const body = norm(declaration(sql, 'r1_settle_attempt'));
    expect(body).toContain("if v_session_status = 'failed' and exists ( select 1 from screening_v2.interview_round_consents c where c.round_id = v_attempt.round_id and c.withdrawn_at is null )");
    // The enqueue sits inside the `if v_counted` branch (an uncounted attempt is never scored).
    const counted = body.indexOf('if v_counted then');
    const enqueue = body.indexOf("if v_session_status = 'failed'");
    const closeCounted = body.indexOf('end if; return jsonb_build_object', enqueue);
    expect(counted).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(counted);
    expect(closeCounted).toBeGreaterThan(enqueue);
  });

  it('r1_transition_round is 0119 verbatim except the grant-retake count (no completed-session join)', () => {
    const previous = norm(declaration(read('0119_r1_capacity_model.sql'), 'r1_transition_round'));
    const next = norm(declaration(sql, 'r1_transition_round'));
    const oldCount = "(select count(*) from screening_v2.interview_round_attempts a join screening_v2.call_sessions s on s.id=a.session_id where a.round_id=v.id and a.counted and s.status='completed') <> 1";
    const newCount = '(select count(*) from screening_v2.interview_round_attempts a where a.round_id=v.id and a.counted) <> 1';
    expect(previous).toContain(oldCount);
    expect(next).toContain(newCount);
    expect(next).not.toContain('s.status=\'completed\'');
    expect(next.replace(newCount, oldCount)).toBe(previous);
  });

  it('keeps both functions security definer with a pinned search_path and service_role-only execute', () => {
    for (const name of ['r1_settle_attempt', 'r1_transition_round']) {
      const fn = declaration(sql, name);
      expect(fn, name).toMatch(/security definer/);
      expect(fn, name).toMatch(/set search_path = pg_catalog, screening_v2/);
    }
    const flat = code.replace(/\s+/g, ' ');
    expect(flat).toContain('revoke all on function screening_v2.r1_settle_attempt(uuid, text, timestamptz) from public, anon, authenticated;');
    expect(flat).toContain('grant execute on function screening_v2.r1_settle_attempt(uuid, text, timestamptz) to service_role;');
    expect(flat).toContain('revoke all on function screening_v2.r1_transition_round(uuid, text, integer, text, timestamptz, timestamptz) from public, anon, authenticated;');
    expect(flat).toContain('grant execute on function screening_v2.r1_transition_round(uuid, text, integer, text, timestamptz, timestamptz) to service_role;');
  });

  it('its behavioural assertions exist and are wired into the R1 SQL runner', () => {
    const runner = readFileSync(path.resolve(here, '../../../../scripts/test-r1-foundation.sh'), 'utf8');
    expect(runner).toContain('"$TESTS/r1_incomplete_attempts_assert.sql"');
    const assertions = readFileSync(
      path.resolve(here, '../../../supabase/tests/r1_incomplete_attempts_assert.sql'),
      'utf8',
    );
    for (const label of [
      'enqueues exactly one deduped r1.assessment job',
      'HR can grant the retake of a counted FAILED attempt',
      'a withdrawn consent is counted but never scored',
      'leaving before TRANSITION is uncounted and queues nothing',
    ]) expect(assertions, label).toContain(label);
  });
});
