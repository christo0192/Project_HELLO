import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0058_phone_candidate_scheduling.sql', import.meta.url)),
  'utf8',
);

describe('0058 candidate-scoped scheduling migration', () => {
  it('exposes one atomic candidate booking wrapper', () => {
    expect(MIGRATION).toContain('create or replace function screening_v2.schedule_candidate_phone_appointment(');
    expect(MIGRATION).toContain("screening_v2.ensure_ashby_phone_engagement(v_link_id, p_now)");
    expect(MIGRATION).toContain("screening_v2.schedule_phone_appointment(");
    expect(MIGRATION).toContain("'rescreen_required'");
  });

  it('does not create dial work or expose the wrapper to browser roles', () => {
    const body = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function screening_v2.schedule_candidate_phone_appointment('),
      MIGRATION.indexOf('\n$$;'),
    );
    expect(body).not.toContain('phone_call_attempts');
    expect(body).not.toContain('job_queue');
    expect(MIGRATION).toContain('revoke all on function screening_v2.schedule_candidate_phone_appointment');
    expect(MIGRATION).not.toMatch(/grant execute on function screening_v2\.schedule_candidate_phone_appointment[^;]*to (?:anon|authenticated|public)/);
  });
});
