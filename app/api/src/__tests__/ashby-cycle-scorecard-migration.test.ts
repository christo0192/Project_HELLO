import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0059_ashby_cycle_scorecards.sql', import.meta.url)),
  'utf8',
);

describe('0059 cycle-specific Ashby scorecards', () => {
  it('binds an operation to the exact source session', () => {
    expect(MIGRATION).toContain('add column if not exists source_session_id uuid');
    expect(MIGRATION).toContain('uq_ashby_scorecard_operation_cycle');
    expect(MIGRATION).toContain('enqueue_ashby_cycle_scorecard');
    expect(MIGRATION).toContain("source_session_id = p_session_id");
    expect(MIGRATION).toContain("'source_session_id', v_op.source_session_id");
  });

  it('keeps browser roles out of the cycle operation door', () => {
    expect(MIGRATION).toContain('revoke all on function screening_v2.enqueue_ashby_cycle_scorecard');
    expect(MIGRATION).not.toMatch(/grant execute on function screening_v2\.enqueue_ashby_cycle_scorecard[^;]*to (?:anon|authenticated|public)/);
  });
});
