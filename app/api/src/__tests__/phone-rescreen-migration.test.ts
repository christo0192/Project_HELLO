import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0057_phone_rescreen_cycles.sql', import.meta.url)),
  'utf8',
);

describe('0057 phone re-screen cycle migration', () => {
  it('is append-only at the data model boundary and preserves one active cycle', () => {
    expect(MIGRATION).toContain('TST-15 SANCTION');
    expect(MIGRATION).toContain('add column if not exists cycle_number integer');
    expect(MIGRATION).toContain('uq_phone_engagements_application_cycle');
    expect(MIGRATION).toContain('uq_phone_engagements_one_active_cycle');
    expect(MIGRATION).toContain('phone_rescreen_requests');
    expect(MIGRATION).toContain('uq_phone_rescreen_request_key');
    expect(MIGRATION).toContain('uq_phone_rescreen_new_engagement');
  });

  it('keeps explicit intent and verification as the only new-cycle doors', () => {
    expect(MIGRATION).toContain('create or replace function screening_v2.request_phone_rescreen(');
    expect(MIGRATION).toContain('create or replace function screening_v2.verify_candidate_phone(');
    expect(MIGRATION).toContain("p_source = 'hr_manual' and p_actor_id is null");
    expect(MIGRATION).toContain("v_prev.state = 'opted_out'");
    expect(MIGRATION).toContain("v_prev.state = 'wrong_number'");
    expect(MIGRATION).toContain('wrong_number_unverified');
    expect(MIGRATION).toContain('cycle_limit_reached');
  });

  it('changes admission and terminal charging to the cycle budget', () => {
    expect(MIGRATION).toContain('v_eng.no_answer_attempts >= v_eng.no_answer_limit');
    expect(MIGRATION).toContain('v_eng.no_answer_attempts + 1 >= v_eng.no_answer_limit');
    expect(MIGRATION).toContain('no_answer_limit, state, state_reason');
    expect(MIGRATION).toContain("'phone_rescreen_requested'");
    expect(MIGRATION).toContain("'phone_number_reverified'");
  });

  it('does not introduce direct queue admission or provider calls', () => {
    const requestStart = MIGRATION.indexOf('create or replace function screening_v2.request_phone_rescreen(');
    const requestEnd = MIGRATION.indexOf('\n$$;', requestStart);
    const requestBody = MIGRATION.slice(requestStart, requestEnd);
    expect(requestBody).not.toContain('job_queue');
    expect(requestBody).not.toContain('phone_call_attempts');
    expect(requestBody).not.toContain('dial');
  });
});
