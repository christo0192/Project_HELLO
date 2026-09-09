import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../supabase/migrations/0088_role_scorecards.sql', import.meta.url),
  'utf8',
);

describe('0088 role scorecards migration contract', () => {
  it('is additive and retains legacy assessments as v1', () => {
    expect(migration).toContain('Additive only: existing assessments stay schema_version=1');
    expect(migration).toContain("add column if not exists schema_version integer not null default 1");
    expect(migration).toContain("schema_version in (1,2)");
    expect(migration).toContain("schema_version = 1 and scorecard_version_id is null");
  });

  it('creates immutable library/version/snapshot tables with exact-weight enforcement', () => {
    for (const table of [
      'scorecard_metric_library',
      'role_scorecard_versions',
      'role_scorecard_version_metrics',
    ]) expect(migration).toContain(`screening_v2.${table}`);
    expect(migration).toContain('trg_role_scorecard_exact_weights');
    expect(migration).toContain('v_count < 1 or v_count > 20 or v_total <> 10000');
    expect(migration).toContain('scorecard configuration versions are immutable');
    expect(migration).toContain('active scorecard version must belong to the role');
  });

  it('pins v2 assessment revision/idempotency without permitting duplicate initial phone scoring', () => {
    expect(migration).toContain('uq_assessments_phone_session');
    expect(migration).toContain("source = 'phone' and revision = 1");
    expect(migration).toContain('uq_assessments_v2_session_revision');
    expect(migration).toContain('uq_assessments_rescore_request');
  });

  it('keeps scorecard tables behind RLS and grants only service role access', () => {
    expect(migration.match(/enable row level security/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain('from anon, authenticated');
    expect(migration).toContain('to service_role');
  });
});
