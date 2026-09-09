-- 0089 — Seed the requested global Scorebar defaults and attach immutable
-- 20%-each snapshots to existing and future roles. No assessment is modified.

insert into screening_v2.scorecard_metric_library
  (key, name, description, default_instruction, rubric)
values
  ('profile_relevance', 'Profile relevance', 'How closely the demonstrated experience matches this role.',
   'Assess evidence that the candidate''s experience, skills, and examples are relevant to this role. Do not infer missing experience.',
   '{"1":"Experience is unrelated and no relevant evidence is provided.","2":"Only limited or indirect relevant experience is evidenced.","3":"Relevant experience meets the baseline role expectation.","4":"Strong, directly relevant experience is evidenced with clear examples.","5":"Exceptional, highly relevant experience is evidenced with sustained impact."}'),
  ('communication', 'Communication', 'Clarity, listening, structure, and professional communication during the screening.',
   'Assess only how clearly, accurately, and professionally the candidate communicates in the recorded screening. Account for language differences without penalizing accent.',
   '{"1":"Communication prevents a reliable evaluation.","2":"Communication is often unclear, incomplete, or difficult to follow.","3":"Communication is adequately clear and responsive.","4":"Communication is clear, structured, and consistently responsive.","5":"Communication is exceptionally clear, concise, thoughtful, and engaging."}'),
  ('night_shift_fit', 'Night-shift fit', 'Evidence of availability and willingness for the role''s required night schedule.',
   'Assess only explicit evidence about the candidate''s ability and willingness to work the role''s stated night schedule. Mark insufficient evidence when it was not discussed.',
   '{"1":"The candidate explicitly cannot meet the required night schedule.","2":"The candidate expresses substantial uncertainty or constraints about the schedule.","3":"The candidate can meet the stated schedule with ordinary conditions.","4":"The candidate clearly confirms reliable availability for the schedule.","5":"The candidate gives strong, specific evidence of sustained success in comparable shifts."}'),
  ('compensation_fit', 'Compensation fit', 'Alignment between stated compensation expectations and the role''s stated range.',
   'Assess only explicit compensation expectations against the role''s stated range. Mark insufficient evidence when either side was not available; never infer salary fit.',
   '{"1":"Stated expectations are clearly incompatible with the stated range.","2":"Expectations materially exceed or conflict with the stated range.","3":"Expectations are broadly compatible but material details remain open.","4":"Expectations are clearly compatible with the stated range.","5":"Expectations are explicitly aligned and the candidate provides clear supporting context."}'),
  ('stability', 'Stability', 'Evidence of sustainable employment history, transition reasons, and commitment.',
   'Assess evidence about employment continuity, transition reasons, and realistic commitment. Do not penalize protected leave, layoffs, caregiving, or unsupported assumptions.',
   '{"1":"Evidence shows serious unresolved stability concerns relevant to the role.","2":"Evidence suggests material stability concerns that remain unresolved.","3":"History is broadly stable or concerns are reasonably explained.","4":"History and explanations show clear stability and realistic commitment.","5":"History shows sustained, well-evidenced stability with thoughtful career decisions."}')
on conflict (key) do nothing;

-- The immutable version is created only for roles that do not yet point at
-- a scorecard. This makes reapplication safe and never overwrites a recruiter
-- configuration. The five metrics are inserted in a single statement so the
-- deferred exact-10,000-bps constraint sees the complete configuration.
insert into screening_v2.role_scorecard_versions(role_id, version, configuration_hash)
select r.id,
       coalesce((select max(v.version) from screening_v2.role_scorecard_versions v where v.role_id = r.id), 0) + 1,
       encode(extensions.digest(r.id::text || '|scorecard-default-v1', 'sha256'), 'hex')
from screening_v2.roles r
where r.active_scorecard_version_id is null;

insert into screening_v2.role_scorecard_version_metrics
  (scorecard_version_id, library_metric_id, metric_key, name, instruction, rubric, weight_bps, display_order)
select v.id, l.id, l.key, l.name, l.default_instruction, l.rubric, 2000,
       row_number() over (partition by v.id order by l.key) - 1
from screening_v2.role_scorecard_versions v
join screening_v2.scorecard_metric_library l
  on l.key in ('profile_relevance', 'communication', 'night_shift_fit', 'compensation_fit', 'stability')
where exists (
  select 1 from screening_v2.roles r
  where r.id = v.role_id and r.active_scorecard_version_id is null
    and v.configuration_hash = encode(extensions.digest(r.id::text || '|scorecard-default-v1', 'sha256'), 'hex')
);

update screening_v2.roles r
set active_scorecard_version_id = v.id
from screening_v2.role_scorecard_versions v
where v.role_id = r.id and r.active_scorecard_version_id is null
  and v.configuration_hash = encode(extensions.digest(r.id::text || '|scorecard-default-v1', 'sha256'), 'hex');

-- Future roles receive the same immutable copied snapshots. Template edits
-- never rewrite a role version already created by this trigger.
create or replace function screening_v2.attach_default_scorecard_to_new_role()
returns trigger language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_version_id uuid;
begin
  if new.active_scorecard_version_id is not null then return new; end if;

  insert into screening_v2.role_scorecard_versions(role_id, version, configuration_hash)
  values (new.id, 1, encode(extensions.digest(new.id::text || '|scorecard-default-v1', 'sha256'), 'hex'))
  returning id into v_version_id;

  insert into screening_v2.role_scorecard_version_metrics
    (scorecard_version_id, library_metric_id, metric_key, name, instruction, rubric, weight_bps, display_order)
  select v_version_id, l.id, l.key, l.name, l.default_instruction, l.rubric, 2000,
         row_number() over (order by l.key) - 1
  from screening_v2.scorecard_metric_library l
  where l.key in ('profile_relevance', 'communication', 'night_shift_fit', 'compensation_fit', 'stability');

  update screening_v2.roles set active_scorecard_version_id = v_version_id where id = new.id;
  return new;
end;
$$;
drop trigger if exists trg_attach_default_scorecard_to_new_role on screening_v2.roles;
create trigger trg_attach_default_scorecard_to_new_role
  after insert on screening_v2.roles
  for each row execute function screening_v2.attach_default_scorecard_to_new_role();
