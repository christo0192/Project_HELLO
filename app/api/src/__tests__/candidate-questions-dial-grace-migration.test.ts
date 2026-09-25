/**
 * 0104 — the dial grace, asserted against the migration TEXT.
 *
 * This RPC is deliberately outside the phone-domain contract in
 * `rpc-contract.ts`: it is called from the Ashby ingestion path, and that list
 * is in bijection with `phone-screening/stores.ts`. Its sibling
 * `ensure_ashby_phone_engagement` — which creates the very engagement this one
 * defers — is absent for the same reason. So the drift coverage the phone
 * contract would have given it lives here instead, in the per-migration style
 * `phone-candidate-scheduling-migration.test.ts` uses for exactly that sibling.
 *
 * The real Postgres harness (`scripts/test-candidate-questions.sh`) proves the
 * BEHAVIOUR by execution. This file guards the properties that are invisible
 * until the day someone edits the SQL: the direction of the clamp, the posture,
 * and the bound.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../../supabase/migrations/0104_candidate_questions_dial_grace.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

/** Everything between the function's opening dollar-quote and its close. */
function body(): string {
  const start = MIGRATION.indexOf('as $$');
  const end = MIGRATION.indexOf('\n$$;');
  expect(start, 'the function is not dollar-quoted as expected').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return MIGRATION.slice(start, end);
}

describe('0104 candidate-questions dial grace', () => {
  it('declares exactly one function, and it is the dial grace', () => {
    const declared = [...MIGRATION.matchAll(/create or replace function screening_v2\.(\w+)/g)]
      .map((m) => m[1]);
    expect(declared).toEqual(['defer_phone_dial_for_questions']);
  });

  it('MOVES THE DIAL ONLY LATER — the one property that cannot be got wrong', () => {
    // `next_eligible_at` is also what holds a candidate imported outside the
    // IST calling window until the window opens. Writing `now + grace`
    // unconditionally would drag that candidate FORWARD and ring their phone at
    // two in the morning. `greatest` is the whole safety argument, and a future
    // edit that drops it looks locally harmless.
    expect(body()).toContain(
      'greatest(coalesce(v_eng.next_eligible_at, p_now), p_now + make_interval(secs => p_grace_seconds))',
    );
    // And it is the ONLY expression assigned to the column.
    const assignments = [...body().matchAll(/set\s+next_eligible_at\s*=\s*([^\n,]+)/g)]
      .map((m) => m[1].trim());
    expect(assignments).toEqual(['v_next']);
  });

  it('REFUSES a grace nobody meant, rather than clamping it', () => {
    // Silently accepting an hour would park a candidate nobody could find.
    expect(body()).toContain('p_grace_seconds is null or p_grace_seconds < 0 or p_grace_seconds > 600');
    expect(body()).toContain("'invalid_grace'");
  });

  it('locks the engagement before reading it, so two ingestions cannot interleave', () => {
    expect(body()).toMatch(/from screening_v2\.phone_engagements\s+where id = p_engagement_id for update/);
  });

  it('leaves a terminal engagement alone', () => {
    // 0045's transition trigger raises on ANY change to a terminal row, so
    // without this the function throws instead of answering with a status.
    expect(body()).toContain('v_eng.terminal_at is not null');
    expect(body()).toContain("'engagement_terminal'");
  });

  it('does not read the machine clock — time is injected', () => {
    // A boundary test that reads the machine clock passes in Asia and fails in
    // CI. The DEFAULT in the signature may be now(); the body may not.
    expect(body()).not.toMatch(/\bnow\s*\(/);
    expect(body()).not.toMatch(/\bcurrent_timestamp\b/i);
    expect(body()).not.toMatch(/\bclock_timestamp\s*\(/);
  });

  it('never swallows an error into a fail-open path', () => {
    expect(body()).not.toMatch(/when\s+others/i);
  });

  it('is service-role only, definer, with a pinned search_path', () => {
    expect(MIGRATION).toContain('security definer');
    expect(MIGRATION).toContain('set search_path = pg_catalog, screening_v2');
    expect(MIGRATION).toMatch(
      /revoke all on function screening_v2\.defer_phone_dial_for_questions\(uuid, integer, timestamptz\)\s*\n?\s*from public, anon, authenticated;/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function screening_v2\.defer_phone_dial_for_questions\(uuid, integer, timestamptz\)\s*\n?\s*to service_role;/,
    );
    // Granted to nobody else. `to service_role` is the only grant target.
    const grantTargets = [...MIGRATION.matchAll(/grant execute on function[\s\S]*?to ([a-z_, ]+);/g)]
      .map((m) => m[1].trim());
    expect(grantTargets).toEqual(['service_role']);
  });

  it('bumps the row version, so a concurrent reader can tell it moved', () => {
    expect(body()).toContain('version          = version + 1');
  });
});
