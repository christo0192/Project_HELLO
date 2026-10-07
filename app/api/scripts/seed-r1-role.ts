/**
 * Manual-only R1 role/scorecard seed. Defaults to a read-only dry run.
 *
 * The five metrics, weights and four-level anchors come from `src/lib/r1/rubric.ts`, the single
 * definition the scorer also reads (PR-5). The anchors are four levels exactly: the metric
 * library CHECK `chk_scorecard_metric_library_rubric_four_level` (0093) rejects a fifth key.
 */
import { createHash } from 'node:crypto';
import { supabase } from '../src/lib/supabase.js';
import { R1_METRICS, R1_RUBRIC_VERSION, r1RubricSha } from '../src/lib/r1/rubric.js';

const apply = process.argv.includes('--apply');
const jd = `Program Advisor - India — Bengaluru — Interview Kickstart

Interview Kickstart is a career transformation platform helping technology professionals prepare for interviews through expert-led courses and coaching. Program Advisors understand customer goals, explain appropriate preparation options, and build a professional relationship through the decision process.`;

const rubricJson = (rubric: Record<1 | 2 | 3 | 4, string>) => ({
  '1': rubric[1],
  '2': rubric[2],
  '3': rubric[3],
  '4': rubric[4],
});

const { data: existing } = await supabase.from('roles').select('id,title').eq('interview_kind', 'sales_r1').maybeSingle();
if (!apply) {
  console.log(JSON.stringify({
    dry_run: true,
    existing_role_id: existing?.id ?? null,
    title: 'Sales Program Advisor',
    rubric_version: R1_RUBRIC_VERSION,
    rubric_sha: r1RubricSha(),
    metrics: R1_METRICS.map(({ key, name, weightBps }) => ({ key, name, weight_bps: weightBps })),
  }, null, 2));
  process.exit(0);
}
const rolePayload = { title: 'Sales Program Advisor', agent_name: 'R1 Role-play', interview_kind: 'sales_r1', jd, required_skills: ['Sales discovery', 'Objection handling', 'Professional communication'], screening_template: [] };
const role = existing
  ? (await supabase.from('roles').update(rolePayload).eq('id', existing.id).select('id').single())
  : await supabase.from('roles').insert(rolePayload).select('id').single();
if (role.error || !role.data) throw new Error(`role seed failed: ${role.error?.message ?? 'unknown'}`);
for (const metric of R1_METRICS) {
  const { error } = await supabase.from('scorecard_metric_library').upsert({
    key: metric.key,
    name: metric.name,
    description: `R1 ${metric.name} assessment.`,
    default_instruction: metric.instruction,
    rubric: rubricJson(metric.rubric),
  }, { onConflict: 'key' });
  if (error) throw new Error(`metric seed failed: ${error.message}`);
}
const { data: libraries, error: librariesError } = await supabase.from('scorecard_metric_library').select('id,key').in('key', R1_METRICS.map((metric) => metric.key));
if (librariesError || !libraries || libraries.length !== R1_METRICS.length) throw new Error('R1 metric lookup failed');
const hash = createHash('sha256').update(`${role.data.id}|${R1_RUBRIC_VERSION}|${r1RubricSha()}`).digest('hex');
const { data: previous } = await supabase.from('role_scorecard_versions').select('version').eq('role_id', role.data.id).order('version', { ascending: false }).limit(1);
const nextVersion = Number(previous?.[0]?.version ?? 0) + 1;
const { data: version, error: versionError } = await supabase.from('role_scorecard_versions').insert({ role_id: role.data.id, version: nextVersion, configuration_hash: hash }).select('id').single();
if (versionError || !version) throw new Error(`scorecard version failed: ${versionError?.message ?? 'unknown'}`);
const library = new Map(libraries.map((m: any) => [m.key, m.id]));
const { error: rowsError } = await supabase.from('role_scorecard_version_metrics').insert(R1_METRICS.map((metric, display_order) => ({
  scorecard_version_id: version.id,
  library_metric_id: library.get(metric.key),
  metric_key: metric.key,
  name: metric.name,
  instruction: metric.instruction,
  rubric: rubricJson(metric.rubric),
  weight_bps: metric.weightBps,
  display_order,
})));
if (rowsError) throw new Error(`scorecard rows failed: ${rowsError.message}`);
const { error: pointerError } = await supabase.from('roles').update({ active_scorecard_version_id: version.id }).eq('id', role.data.id);
if (pointerError) throw new Error(`scorecard pointer failed: ${pointerError.message}`);
console.log(`Seeded R1 role ${role.data.id} and five-metric scorecard (${R1_RUBRIC_VERSION}).`);
