/** Manual-only R1 role/scorecard seed. Defaults to a read-only dry run. */
import { createHash } from 'node:crypto';
import { supabase } from '../src/lib/supabase.js';

const apply = process.argv.includes('--apply');
const jd = `Program Advisor - India — Bengaluru — Interview Kickstart

Interview Kickstart is a career transformation platform helping technology professionals prepare for interviews through expert-led courses and coaching. Program Advisors understand customer goals, explain appropriate preparation options, and build a professional relationship through the decision process.`;
const metrics = [
  ['r1_probing_discovery', 'Probing & discovery', 2500, ['No discovery; opens with features or price.', 'Mostly closed questions or early pitch; needs surface only when raised.', 'At least 2 open questions before pitching, a follow-up, and a revealed need linked to the pitch.', 'At least 4 open questions before pitch, 2 follow-ups, 2 logged deep needs, summary and pitch tied to 2 needs.']],
  ['r1_objection_handling', 'Objection handling', 2500, ['Argues, dismisses, or makes prohibited promises.', 'Generic or defensive; an objection is ignored or unresolved.', 'Answers most objections with relevant facts but sometimes skips clarification or a resolution check.', 'For each raised objection: acknowledges, clarifies/reframes, gives permitted facts tied to need, and checks resolution.']],
  ['r1_communication_rapport', 'Communication & rapport', 2000, ['Rude, incoherent, or unprofessional.', 'Frequent monologues, three barge-ins, or disorganised.', 'Clear and polite; one long monologue or slightly out-of-range talk share.', 'Clear structured icebreaker; refers to learner words twice; 40–65% talk share; no monologue over 90 seconds.']],
  ['r1_urgency_close', 'Urgency & close', 1500, ['Coercive/fabricated pressure or contradicts the facts sheet.', 'Vague urgency or no clear ask.', 'Some relevant urgency and a next-step ask.', 'Urgency tied to stated need and permitted lever; non-coercive commitment or dated next step with decision-maker.']],
  ['r1_negotiation_discount', 'Negotiation & discount discipline', 1500, ['Exceeds $1,500, accepts $7,000 anchor, or invents discounts/freebies.', 'Offers maximum quickly or unconditionally.', 'Within ladder and conditional but concedes first ask or without a trade.', 'Defends value first; any ≤$1,500 discount is permitted, conditional and traded for commitment.']],
] as const;
const rubric = (anchors: readonly string[]) => ({ '1': anchors[0], '2': anchors[1], '3': anchors[2], '4': anchors[3], '5': anchors[3] });

const { data: existing } = await supabase.from('roles').select('id,title').eq('interview_kind', 'sales_r1').maybeSingle();
if (!apply) { console.log(JSON.stringify({ dry_run: true, existing_role_id: existing?.id ?? null, title: 'Sales Program Advisor', metrics: metrics.map(([key, name, weight_bps]) => ({ key, name, weight_bps })) }, null, 2)); process.exit(0); }
const rolePayload = { title: 'Sales Program Advisor', agent_name: 'R1 Role-play', interview_kind: 'sales_r1', jd, required_skills: ['Sales discovery', 'Objection handling', 'Professional communication'], screening_template: [] };
const role = existing
  ? (await supabase.from('roles').update(rolePayload).eq('id', existing.id).select('id').single())
  : await supabase.from('roles').insert(rolePayload).select('id').single();
if (role.error || !role.data) throw new Error(`role seed failed: ${role.error?.message ?? 'unknown'}`);
for (const [key, name, _weight, anchors] of metrics) {
  const { error } = await supabase.from('scorecard_metric_library').upsert({ key, name, description: `R1 ${name} assessment.`, default_instruction: `Assess only observable R1 role-play evidence for ${name}.`, rubric: rubric(anchors) }, { onConflict: 'key' });
  if (error) throw new Error(`metric seed failed: ${error.message}`);
}
const { data: libraries, error: librariesError } = await supabase.from('scorecard_metric_library').select('id,key').in('key', metrics.map(m => m[0]));
if (librariesError || !libraries || libraries.length !== metrics.length) throw new Error('R1 metric lookup failed');
const hash = createHash('sha256').update(`${role.data.id}|r1-scorecard-v1`).digest('hex');
const { data: previous } = await supabase.from('role_scorecard_versions').select('version').eq('role_id', role.data.id).order('version', { ascending: false }).limit(1);
const nextVersion = Number(previous?.[0]?.version ?? 0) + 1;
const { data: version, error: versionError } = await supabase.from('role_scorecard_versions').insert({ role_id: role.data.id, version: nextVersion, configuration_hash: hash }).select('id').single();
if (versionError || !version) throw new Error(`scorecard version failed: ${versionError?.message ?? 'unknown'}`);
const library = new Map(libraries.map((m: any) => [m.key, m.id]));
const { error: rowsError } = await supabase.from('role_scorecard_version_metrics').insert(metrics.map(([key, name, weight_bps, anchors], display_order) => ({ scorecard_version_id: version.id, library_metric_id: library.get(key), metric_key: key, name, instruction: `Assess observable R1 role-play evidence for ${name}.`, rubric: rubric(anchors), weight_bps, display_order })));
if (rowsError) throw new Error(`scorecard rows failed: ${rowsError.message}`);
const { error: pointerError } = await supabase.from('roles').update({ active_scorecard_version_id: version.id }).eq('id', role.data.id);
if (pointerError) throw new Error(`scorecard pointer failed: ${pointerError.message}`);
console.log(`Seeded R1 role ${role.data.id} and five-metric scorecard.`);
