-- 0093 — Scorecard rubric scale 1–5 → 1–4 (owner decision 2026-09-10, #275 / PR #284).
--
-- WHY: Ashby `Score` fields are four-point. Since PR #284 a dashboard metric is
-- written to the Ashby scorecard field that carries its name; with a four-level
-- rubric that value is written 1:1, with no bucketing (previously 4 and 5 both
-- collapsed onto 4). New levels: 1 Poor · 2 Average · 3 Good · 4 Excellent.
--
-- HOW THE REWRITE RESPECTS IMMUTABILITY. `role_scorecard_version_metrics` rows
-- are immutable by trigger (0088 `prevent_scorecard_version_mutation`) — an
-- assessment's configuration snapshot must never change under it. So this
-- migration does NOT edit them. It does what a recruiter editing a scorecard
-- does: for every role whose ACTIVE version still carries a five-level rubric it
-- INSERTS a new version (version = max+1) with four-level rubrics and repoints
-- `roles.active_scorecard_version_id`. Old versions stay exactly as scored.
--
-- The rubric text maps deterministically: the new labels equal the OLD levels
-- 1 / 3 / 4 / 5, so `{1: old1, 2: old3, 3: old4, 4: old5}`; the old level 2
-- ("Below average") text is dropped. The mutable metric LIBRARY is rewritten in
-- place (it is versioned by `version`, not immutable) and bumps its version.
--
-- CHECK CONSTRAINTS. `is_scorecard_rubric` must keep accepting the five-level
-- rubrics still held by historical versions, so it now accepts four OR five
-- levels and is documented as "five = legacy, never for new configurations".
-- New configurations are held to four levels by the API (`validateRubric`) and,
-- on the mutable library table, by a dedicated four-level CHECK.
--
-- HISTORY: assessments already scored on 1–5 are NOT rescored. Each assessment
-- records the scale it was scored on (`score_scale_max`: 5 for every row that
-- exists at migration time, 4 for rows written afterwards), so readers display
-- and project each row on its own scale. `weighted_score_5` keeps its name; its
-- range is 1..score_scale_max.
--
-- Idempotent: every step is keyed on "does a five-level rubric still exist",
-- so a re-apply is a no-op.

-- ── 1. Validator: four levels (current) or five (legacy, historical only) ────
create or replace function screening_v2.is_scorecard_rubric(value jsonb)
returns boolean language sql immutable strict set search_path = pg_catalog as $$
  select jsonb_typeof(value) = 'object'
    and value ?& array['1','2','3','4']
    and (select count(*) from jsonb_object_keys(value)) = case when value ? '5' then 5 else 4 end
    and jsonb_typeof(value->'1') = 'string' and char_length(value->>'1') between 1 and 500
    and jsonb_typeof(value->'2') = 'string' and char_length(value->>'2') between 1 and 500
    and jsonb_typeof(value->'3') = 'string' and char_length(value->>'3') between 1 and 500
    and jsonb_typeof(value->'4') = 'string' and char_length(value->>'4') between 1 and 500
    and (not value ? '5' or (jsonb_typeof(value->'5') = 'string' and char_length(value->>'5') between 1 and 500));
$$;

comment on function screening_v2.is_scorecard_rubric(jsonb) is
  'Rubric levels 1..4 (1 Poor, 2 Average, 3 Good, 4 Excellent), each 1..500 chars. A five-level rubric is accepted ONLY because immutable pre-0093 role scorecard versions still carry one; new configurations are four-level (API validateRubric + chk_scorecard_metric_library_rubric_four_level).';

-- ── 2. Metric library (mutable, versioned): rewrite to four levels ──────────
update screening_v2.scorecard_metric_library
   set rubric = jsonb_build_object(
         '1', rubric->>'1',
         '2', rubric->>'3',
         '3', rubric->>'4',
         '4', rubric->>'5'),
       version = version + 1,
       updated_at = now()
 where rubric ? '5';

-- New library rows and edits must be four-level from here on.
alter table screening_v2.scorecard_metric_library
  drop constraint if exists chk_scorecard_metric_library_rubric_four_level;
alter table screening_v2.scorecard_metric_library
  add constraint chk_scorecard_metric_library_rubric_four_level check (not (rubric ? '5'));

-- ── 3. New immutable version per role whose ACTIVE one is still five-level ──
-- Same shape as 0089's seeding: insert the version, then all of its metrics in
-- ONE statement (the exact-10,000-bps trigger validates the set), then repoint.
insert into screening_v2.role_scorecard_versions(role_id, version, configuration_hash)
select r.id,
       (select max(v2.version) from screening_v2.role_scorecard_versions v2 where v2.role_id = r.id) + 1,
       encode(extensions.digest(r.id::text || '|scorecard-scale-1-4', 'sha256'), 'hex')
from screening_v2.roles r
join screening_v2.role_scorecard_versions v on v.id = r.active_scorecard_version_id
where exists (
  select 1 from screening_v2.role_scorecard_version_metrics m
  where m.scorecard_version_id = v.id and m.rubric ? '5'
)
and not exists (
  select 1 from screening_v2.role_scorecard_versions nv
  where nv.role_id = r.id
    and nv.configuration_hash = encode(extensions.digest(r.id::text || '|scorecard-scale-1-4', 'sha256'), 'hex')
);

insert into screening_v2.role_scorecard_version_metrics
  (scorecard_version_id, library_metric_id, metric_key, name, instruction, rubric, weight_bps, display_order)
select nv.id, m.library_metric_id, m.metric_key, m.name, m.instruction,
       case when m.rubric ? '5'
            then jsonb_build_object('1', m.rubric->>'1', '2', m.rubric->>'3', '3', m.rubric->>'4', '4', m.rubric->>'5')
            else m.rubric end,
       m.weight_bps, m.display_order
from screening_v2.role_scorecard_versions nv
join screening_v2.roles r on r.id = nv.role_id
join screening_v2.role_scorecard_version_metrics m on m.scorecard_version_id = r.active_scorecard_version_id
where nv.configuration_hash = encode(extensions.digest(r.id::text || '|scorecard-scale-1-4', 'sha256'), 'hex')
  and not exists (
    select 1 from screening_v2.role_scorecard_version_metrics existing
    where existing.scorecard_version_id = nv.id
  );

update screening_v2.roles r
   set active_scorecard_version_id = nv.id
  from screening_v2.role_scorecard_versions nv
 where nv.role_id = r.id
   and nv.configuration_hash = encode(extensions.digest(r.id::text || '|scorecard-scale-1-4', 'sha256'), 'hex')
   and r.active_scorecard_version_id is distinct from nv.id;

-- ── 4. Per-assessment scale marker ─────────────────────────────────────────
-- Existing rows were all scored on 1–5 → 5; the default then flips to 4 for
-- everything written from now on.
alter table screening_v2.assessments
  add column if not exists score_scale_max smallint not null default 5;
alter table screening_v2.assessments
  alter column score_scale_max set default 4;
alter table screening_v2.assessments drop constraint if exists chk_assessments_score_scale_max;
alter table screening_v2.assessments
  add constraint chk_assessments_score_scale_max check (score_scale_max in (4, 5));
alter table screening_v2.assessments drop constraint if exists chk_assessments_weighted_within_scale;
alter table screening_v2.assessments
  add constraint chk_assessments_weighted_within_scale
  check (weighted_score_5 is null or weighted_score_5 <= score_scale_max);

comment on column screening_v2.assessments.score_scale_max is
  'Rubric scale this assessment was scored on: 5 for rows persisted before 0093 (kept as scored, never rescored), 4 afterwards. weighted_score_5 ranges 1..score_scale_max.';
