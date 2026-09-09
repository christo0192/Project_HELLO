/**
 * store.ts — read the ACTIVE, immutable scorecard configuration for a role.
 *
 * Phase 1 wiring: the runtime scorer needs the role's currently-active,
 * frozen metric set (names, per-role instructions, rubric, weights) in the
 * `RoleScorecardVersion` shape the domain helpers and the scorer expect. This
 * module is a THIN mapper over the 0088 tables — all invariants (weights total
 * 10000 bps, unique keys/orders, five-level rubric, immutability) are already
 * enforced by the migration's CHECK constraints and triggers, so this reads
 * and shapes; it does not re-validate. The scorer re-validates via
 * `domain.validateMetricResults` before it trusts any model output.
 *
 * A role with no `active_scorecard_version_id` returns `null` — the caller
 * then falls through to the legacy v1 scoring path unchanged.
 */

import type {
  RoleScorecardMetric,
  RoleScorecardVersion,
  ScorecardRubric,
} from './contracts.js';

/**
 * The minimum surface of the Supabase service-role client this mapper needs.
 * The real `supabase` singleton (bound to the `screening_v2` schema) satisfies
 * it structurally, and a test can pass a hand-rolled `.from()` mock. Kept
 * deliberately loose so this module never couples to the generated Database
 * generics.
 */
export interface ScorecardStoreClient {
  from(table: string): any;
}

/** A DB `role_scorecard_version_metrics` row as this mapper reads it. */
interface MetricRow {
  id: string;
  library_metric_id: string;
  metric_key: string;
  name: string;
  instruction: string;
  rubric: unknown;
  weight_bps: number;
  display_order: number;
}

/** A DB `role_scorecard_versions` row as this mapper reads it. */
interface VersionRow {
  id: string;
  role_id: string;
  version: number;
  configuration_hash: string;
}

/**
 * Coerce the jsonb rubric ({"1": "...", ... , "5": "..."}) into the numeric-keyed
 * `ScorecardRubric` the contracts use. jsonb always presents string keys; JS
 * treats `r[1]` and `r['1']` identically, so this is a faithful, lossless map.
 */
function toRubric(value: unknown): ScorecardRubric {
  const r = (value ?? {}) as Record<string, string>;
  return {
    1: r['1'],
    2: r['2'],
    3: r['3'],
    4: r['4'],
    5: r['5'],
  };
}

function toMetric(row: MetricRow): RoleScorecardMetric {
  return {
    id: row.id,
    libraryMetricId: row.library_metric_id,
    key: row.metric_key,
    name: row.name,
    instruction: row.instruction,
    rubric: toRubric(row.rubric),
    weightBps: row.weight_bps,
    displayOrder: row.display_order,
  };
}

/**
 * Load the role's active, immutable scorecard configuration, or `null` when the
 * role has no active scorecard (or the pointer/rows cannot be read).
 *
 * Fail-quiet: any read error or missing row resolves to `null` so the caller
 * takes the legacy v1 path rather than crashing a completed screening. The rows
 * themselves are trusted (server-only tables, DB-enforced invariants).
 */
export async function loadActiveRoleScorecard(
  client: ScorecardStoreClient,
  roleId: string,
): Promise<RoleScorecardVersion | null> {
  const { data: role, error: roleErr } = await client
    .from('roles')
    .select('active_scorecard_version_id')
    .eq('id', roleId)
    .maybeSingle();
  const versionId: string | null = role?.active_scorecard_version_id ?? null;
  if (roleErr || !versionId) return null;

  const { data: version, error: versionErr } = (await client
    .from('role_scorecard_versions')
    .select('id,role_id,version,configuration_hash')
    .eq('id', versionId)
    .maybeSingle()) as { data: VersionRow | null; error: unknown };
  if (versionErr || !version) return null;

  const { data: metricRows, error: metricsErr } = (await client
    .from('role_scorecard_version_metrics')
    .select('id,library_metric_id,metric_key,name,instruction,rubric,weight_bps,display_order')
    .eq('scorecard_version_id', versionId)
    .order('display_order', { ascending: true })) as {
    data: MetricRow[] | null;
    error: unknown;
  };
  if (metricsErr || !metricRows || metricRows.length === 0) return null;

  return {
    id: version.id,
    roleId: version.role_id,
    version: version.version,
    configurationHash: version.configuration_hash,
    metrics: metricRows.map(toMetric),
  };
}
