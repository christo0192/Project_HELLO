import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(fileURLToPath(new URL(
  '../../../supabase/migrations/0077_phone_objective_coverage_cursor_fix.sql',
  import.meta.url,
)), 'utf8').toLowerCase();

describe('0077 phone objective coverage cursor fix', () => {
  it('persists the same cursor that the coverage RPC returns', () => {
    expect(SQL).toContain('create or replace function screening_v2.commit_phone_question_boundary_with_coverage');
    expect(SQL).toContain(
      'set current_question_index = v_cursor + 1 + cardinality(p_covered_question_keys)',
    );
    expect(SQL).toContain(
      "to_jsonb(v_cursor + 1 + coalesce(cardinality(p_covered_question_keys), 0))",
    );
    expect(SQL).not.toContain(
      'set current_question_index = v_cursor + cardinality(p_covered_question_keys)',
    );
  });

  it('keeps coverage provenance contiguous without creating transcript turns', () => {
    expect(SQL).toContain('v_cursor + v_idx');
    expect(SQL).toContain("p_source_event_id || ':coverage:' || md5(v_key)");
    expect(SQL).toContain('commit_phone_question_boundary(');
    expect(SQL).toContain('grant execute on function');
  });
});
