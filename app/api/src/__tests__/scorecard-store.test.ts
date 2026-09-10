/**
 * store.ts — loadActiveRoleScorecard maps the 0088 DB rows into the
 * RoleScorecardVersion shape and returns null when a role has no active
 * scorecard (or a read fails). The Supabase client is a hand-rolled mock.
 */

import { describe, it, expect } from 'vitest';
import { loadActiveRoleScorecard, type ScorecardStoreClient } from '../lib/scorecards/store.js';

interface TableResponse {
  data: unknown;
  error: unknown;
}

function makeClient(responses: Record<string, TableResponse>): ScorecardStoreClient {
  return {
    from(table: string) {
      const cfg = responses[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'maybeSingle', 'single']) {
        builder[m] = () => builder;
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(cfg).then(resolve);
      return builder;
    },
  };
}

const versionRow = {
  id: 'ver-1',
  role_id: 'role-1',
  version: 3,
  configuration_hash: 'a'.repeat(64),
};

const metricRows = [
  {
    id: 'm-0',
    library_metric_id: 'lib-0',
    metric_key: 'communication',
    name: 'Communication',
    instruction: 'Judge clarity.',
    rubric: { '1': 'one', '2': 'two', '3': 'three', '4': 'four' },
    weight_bps: 6000,
    display_order: 0,
  },
  {
    id: 'm-1',
    library_metric_id: 'lib-1',
    metric_key: 'motivation',
    name: 'Motivation',
    instruction: 'Judge intent.',
    rubric: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' },
    weight_bps: 4000,
    display_order: 1,
  },
];

/**
 * A row written before 0093, still carrying the retired fifth level in its jsonb
 * rubric. 0093 migrates these, but a lagging replica / un-migrated tenant row
 * must not produce a five-key rubric in memory.
 */
const legacyFiveLevelMetricRow = {
  ...metricRows[0],
  rubric: { '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five' },
};

describe('loadActiveRoleScorecard — mapping', () => {
  it('maps DB rows into a RoleScorecardVersion (camelCase, coerced rubric)', async () => {
    const client = makeClient({
      roles: { data: { active_scorecard_version_id: 'ver-1' }, error: null },
      role_scorecard_versions: { data: versionRow, error: null },
      role_scorecard_version_metrics: { data: metricRows, error: null },
    });

    const result = await loadActiveRoleScorecard(client, 'role-1');
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      id: 'ver-1',
      roleId: 'role-1',
      version: 3,
      configurationHash: 'a'.repeat(64),
    });
    expect(result!.metrics).toHaveLength(2);

    const [m0, m1] = result!.metrics;
    expect(m0).toEqual({
      id: 'm-0',
      libraryMetricId: 'lib-0',
      key: 'communication',
      name: 'Communication',
      instruction: 'Judge clarity.',
      rubric: { 1: 'one', 2: 'two', 3: 'three', 4: 'four' },
      weightBps: 6000,
      displayOrder: 0,
    });
    // Numeric rubric indexing works after coercion from jsonb string keys.
    expect(m0.rubric[1]).toBe('one');
    expect(m0.rubric[4]).toBe('four');
    expect(m1.key).toBe('motivation');
    expect(m1.weightBps).toBe(4000);
  });

  it('coerces a pre-0093 five-level jsonb rubric down to exactly the four live levels', async () => {
    const client = makeClient({
      roles: { data: { active_scorecard_version_id: 'ver-1' }, error: null },
      role_scorecard_versions: { data: versionRow, error: null },
      role_scorecard_version_metrics: { data: [legacyFiveLevelMetricRow], error: null },
    });

    const result = await loadActiveRoleScorecard(client, 'role-1');
    expect(result).not.toBeNull();
    const rubric = result!.metrics[0].rubric;
    // The retired level 5 is DROPPED, not carried through: the prompt renders
    // levels 1..4 and domain.validateRubric refuses a five-key rubric, so a
    // stale row must never reach either with an extra level attached.
    expect(Object.keys(rubric)).toEqual(['1', '2', '3', '4']);
    expect(rubric).toEqual({ 1: 'one', 2: 'two', 3: 'three', 4: 'four' });
    expect((rubric as Record<string, unknown>)['5']).toBeUndefined();
  });
});

describe('loadActiveRoleScorecard — null cases', () => {
  it('returns null when the role has no active scorecard version', async () => {
    const client = makeClient({
      roles: { data: { active_scorecard_version_id: null }, error: null },
    });
    expect(await loadActiveRoleScorecard(client, 'role-1')).toBeNull();
  });

  it('returns null when the role row is missing', async () => {
    const client = makeClient({ roles: { data: null, error: null } });
    expect(await loadActiveRoleScorecard(client, 'role-x')).toBeNull();
  });

  it('returns null when the role read errors', async () => {
    const client = makeClient({
      roles: { data: null, error: { message: 'boom' } },
    });
    expect(await loadActiveRoleScorecard(client, 'role-1')).toBeNull();
  });

  it('returns null when the version row cannot be read', async () => {
    const client = makeClient({
      roles: { data: { active_scorecard_version_id: 'ver-1' }, error: null },
      role_scorecard_versions: { data: null, error: null },
      role_scorecard_version_metrics: { data: metricRows, error: null },
    });
    expect(await loadActiveRoleScorecard(client, 'role-1')).toBeNull();
  });

  it('returns null when the version carries no metric rows', async () => {
    const client = makeClient({
      roles: { data: { active_scorecard_version_id: 'ver-1' }, error: null },
      role_scorecard_versions: { data: versionRow, error: null },
      role_scorecard_version_metrics: { data: [], error: null },
    });
    expect(await loadActiveRoleScorecard(client, 'role-1')).toBeNull();
  });
});
