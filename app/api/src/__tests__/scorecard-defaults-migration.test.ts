import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../supabase/migrations/0089_scorecard_default_metrics.sql', import.meta.url),
  'utf8',
);

describe('0089 default Scorebar migration contract', () => {
  it('seeds exactly the requested reusable defaults without mutating existing templates', () => {
    for (const key of [
      'profile_relevance', 'communication', 'night_shift_fit', 'compensation_fit', 'stability',
    ]) expect(migration).toContain(`'${key}'`);
    expect(migration).toContain('on conflict (key) do nothing');
  });

  it('copies five 2,000-bps snapshots only to roles without a configuration', () => {
    expect(migration).toContain('where r.active_scorecard_version_id is null');
    expect(migration).toContain('weight_bps, display_order)');
    expect(migration).toContain('l.rubric, 2000');
    expect(migration).toContain("'|scorecard-default-v1'");
  });

  it('attaches an immutable default snapshot for newly created roles', () => {
    expect(migration).toContain('attach_default_scorecard_to_new_role');
    expect(migration).toContain('after insert on screening_v2.roles');
    expect(migration).toContain('trg_attach_default_scorecard_to_new_role');
  });

  it('does not update assessments', () => {
    expect(migration).not.toMatch(/\bupdate\s+screening_v2\.assessments\b/i);
    expect(migration).not.toMatch(/\binsert\s+into\s+screening_v2\.assessments\b/i);
  });
});
