/**
 * 0104 — the dial grace, asserted against the migration TEXT.
 *
 * This RPC is deliberately outside the phone-domain contract in
 * `rpc-contract.ts`: that list is in BIJECTION with `phone-screening/
 * stores.ts` (`phone-screening-stores.test.ts` pins
 * `attempts.toHaveLength(PHONE_RPC_NAMES.length)`), and this RPC is called
 * from the Ashby ingestion path instead. Its sibling
 * `ensure_ashby_phone_engagement` — which creates the very engagement this one
 * defers — is absent for the same reason.
 *
 * BUT THAT SIBLING HAS NO DRIFT COVERAGE EITHER, so "the same style as the
 * sibling" would have meant none. (An earlier version of this comment claimed
 * `phone-candidate-scheduling-migration.test.ts` provides it; review checked,
 * and that file only asserts that 0058's wrapper CALLS the sibling.) So this
 * file is written to actually replace what the contract would have given:
 * parameter names, the status vocabulary, a clock-free body, and posture.
 *
 * WHAT THIS FILE CANNOT DO is prove behaviour — text is not execution. The
 * real Postgres harness (`scripts/test-candidate-questions.sh`, Part 5 of
 * `candidate_questions_assert.sql`) is what proves the clamp direction, the
 * refusals and the state guard by running them. Every guard here is
 * neutralisable in place by an `and false`, and only the harness catches that.
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

/**
 * The function body with COMMENTS STRIPPED and whitespace collapsed.
 *
 * Both halves are load-bearing. Without stripping comments, every assertion
 * below is satisfied by moving the code it checks INTO a comment — review
 * verified that replacing the `greatest(...)` assignment with a plain
 * `p_now + grace` and pasting the original after `--` kept all nine green, and
 * this file is 40% comment, so that is not a contrived edit. Without
 * collapsing whitespace, the assertions pin column alignment and break on a
 * reformat that changes nothing.
 */
function body(): string {
  const start = MIGRATION.indexOf('as $$');
  const end = MIGRATION.indexOf('\n$$;');
  expect(start, 'the function is not dollar-quoted as expected').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return MIGRATION.slice(start, end)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ');
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
    // unconditionally would drag that candidate FORWARD and ring their phone
    // at two in the morning.
    expect(body()).toContain(
      'greatest(coalesce(v_eng.next_eligible_at, p_now), p_now + make_interval(secs => p_grace_seconds))',
    );
    // And that expression is the ONLY thing ever assigned to the column.
    const assigned = [...body().matchAll(/set next_eligible_at = ([a-z_0-9.]+)/g)].map((m) => m[1]);
    expect(assigned).toEqual(['v_next']);
  });

  it('NEVER PUSHES A CANDIDATE PAST THE CLOSE OF THE CALLING WINDOW', () => {
    // At 20:58 IST a 150s push lands at 21:00:30 — outside the window. Nothing
    // anywhere re-normalises a `next_eligible_at` that sits past the close, so
    // the candidate would wait until 09:00 the NEXT DAY. Trading a 150-second
    // race for a twelve-hour delay is not a trade.
    expect(body()).toContain('if not screening_v2.phone_ist_window_open(v_next)');
    expect(body()).toContain("'window_edge'");
  });

  it('HOLDS ONLY AN ENGAGEMENT STILL WAITING FOR ITS FIRST DIAL', () => {
    // `engagement_active` covers dialing, in_call, reconnecting and scheduled.
    // Moving `next_eligible_at` for those is pointless or harmful — a
    // reconnect is not even scheduled by this column.
    expect(body()).toContain("if v_eng.state <> 'eligible'");
    expect(body()).toContain("'engagement_not_waiting'");
  });

  it('WRITES NO updated_at — that column is the reconnect due clock', () => {
    // `read.ts`: "`updated_at + backoff`, `next_eligible_at` does not carry
    // it". Bumping it would push a candidate who was just cut off another
    // backoff further away, which is the opposite of this feature's point.
    // `phone_engagements` has no set_updated_at trigger, so a write here lands
    // verbatim.
    expect(body()).not.toMatch(/set[^;]*\bupdated_at\s*=/);
  });

  it('REFUSES a grace nobody meant, rather than clamping it', () => {
    // Silently accepting an hour would park a candidate nobody could find.
    expect(body()).toContain('p_grace_seconds is null or p_grace_seconds < 0 or p_grace_seconds > 600');
    expect(body()).toContain("'invalid_grace'");
  });

  it('answers with the WHOLE status vocabulary the caller branches on', () => {
    // The contract file would have enumerated these; since 0104 is outside it,
    // enumerate them here. The caller treats `deferred`/`unchanged` as held
    // and everything else as NOT held, so a status that exists in the SQL and
    // nowhere else is a silent refusal.
    const emitted = [...body().matchAll(/'status', '(\w+)'/g)].map((m) => m[1]).sort();
    expect([...new Set(emitted)]).toEqual([
      'deferred',
      'engagement_not_waiting',
      'engagement_terminal',
      'invalid_grace',
      'unchanged',
      'unknown_engagement',
      'window_edge',
    ]);
  });

  it('locks the engagement before reading it, so two ingestions cannot interleave', () => {
    expect(body()).toMatch(/from screening_v2\.phone_engagements where id = p_engagement_id for update/);
  });

  it('leaves a terminal engagement alone', () => {
    // 0045's transition trigger raises on ANY change to a terminal row, so
    // without this the function throws instead of answering with a status.
    expect(body()).toContain('v_eng.terminal_at is not null');
    expect(body()).toContain("'engagement_terminal'");
  });

  it('does not read the machine clock — time is injected', () => {
    // A boundary test that reads the machine clock passes in Asia and fails in
    // CI. The DEFAULT in the signature may be now(); the body may not. Case
    // matters: `NOW()` is the same function, so these are anchored
    // case-insensitively.
    expect(body()).not.toMatch(/\bnow\s*\(/i);
    expect(body()).not.toMatch(/\bcurrent_timestamp\b/i);
    expect(body()).not.toMatch(/\bclock_timestamp\s*\(/i);
    expect(body()).not.toMatch(/\bstatement_timestamp\s*\(/i);
  });

  it('never swallows an error into a fail-open path', () => {
    // Not just `when others`: `exception when sqlstate 'P0001'` would catch
    // exactly the raise this function is designed around.
    expect(body()).not.toMatch(/\bexception\s+when\b/i);
  });

  it('is service-role only, definer, with a pinned search_path', () => {
    expect(MIGRATION).toContain('security definer');
    expect(MIGRATION).toContain('set search_path = pg_catalog, screening_v2');
    expect(MIGRATION).toMatch(
      /revoke all on function screening_v2\.defer_phone_dial_for_questions\(uuid, integer, timestamptz\)\s*from public, anon, authenticated;/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function screening_v2\.defer_phone_dial_for_questions\(uuid, integer, timestamptz\)\s*to service_role;/,
    );
    // Granted to nobody else.
    const grantTargets = [...MIGRATION.matchAll(/grant execute on function[\s\S]*?to ([a-z_, ]+);/g)]
      .map((m) => m[1].trim());
    expect(grantTargets).toEqual(['service_role']);
  });

  it('bumps the row version, so a concurrent reader can tell it moved', () => {
    expect(body()).toContain('version = version + 1');
  });
});
