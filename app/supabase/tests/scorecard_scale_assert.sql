-- Behavioural assertions for 0093 (rubric 1–5 → 1–4), run against a real
-- Postgres that has had 0088, 0089 and 0093 (twice) applied.
--
-- The point of each assertion is the invariant it protects:
--   * an immutable scored configuration is NEVER edited — the rescale creates a
--     NEW version and repoints the role, the way a recruiter edit does;
--   * the rubric text mapping is the agreed deterministic one;
--   * a second apply changes nothing (deploys re-run migrations);
--   * an assessment already scored on 1–5 keeps its score, its configuration
--     snapshot, and is tagged with the scale it was scored on;
--   * new configurations can no longer be five-level, and a weighted score
--     outside a row's own scale is rejected.
\set ON_ERROR_STOP on

do $$
declare
  n integer; s smallint; v integer;
  oldv uuid; newv uuid;
begin
  select id into oldv from public.pin_old_version;
  select active_scorecard_version_id into newv from screening_v2.roles limit 1;

  -- 1. The immutable, already-scored version is untouched and still five-level.
  select count(*) into n
    from screening_v2.role_scorecard_version_metrics
   where scorecard_version_id = oldv and rubric ? '5';
  if n <> 5 then raise exception '0093 mutated an immutable version (five-level rows now %)', n; end if;

  -- 2. A NEW four-level version exists, carries the whole configuration, and is active.
  if newv is null or newv = oldv then raise exception 'role still points at the five-level version'; end if;
  select count(*) into n from screening_v2.role_scorecard_version_metrics where scorecard_version_id = newv;
  if n <> 5 then raise exception 'new version has % metrics (expected 5)', n; end if;
  select count(*) into n
    from screening_v2.role_scorecard_version_metrics
   where scorecard_version_id = newv and rubric ? '5';
  if n <> 0 then raise exception 'new version is still five-level'; end if;

  -- 3. Rubric text mapped {1: old1, 2: old3, 3: old4, 4: old5}.
  select count(*) into n
    from screening_v2.role_scorecard_version_metrics nm
    join screening_v2.role_scorecard_version_metrics om
      on om.scorecard_version_id = oldv and om.metric_key = nm.metric_key
   where nm.scorecard_version_id = newv
     and (nm.rubric->>'1' is distinct from om.rubric->>'1'
       or nm.rubric->>'2' is distinct from om.rubric->>'3'
       or nm.rubric->>'3' is distinct from om.rubric->>'4'
       or nm.rubric->>'4' is distinct from om.rubric->>'5');
  if n <> 0 then raise exception 'rubric text mapping wrong for % metrics', n; end if;

  -- 4. Idempotent: the second apply created no third version and bumped the
  --    mutable library exactly once.
  select count(*) into n from screening_v2.role_scorecard_versions;
  if n <> 2 then raise exception 'expected exactly 2 versions after two applies, got %', n; end if;
  select count(*) into n from screening_v2.scorecard_metric_library where rubric ? '5';
  if n <> 0 then raise exception 'library still five-level: % rows', n; end if;
  select min(version) into v from screening_v2.scorecard_metric_library;
  if v <> 2 then raise exception 'library version % (expected 2 — bumped exactly once)', v; end if;

  -- 5. The historical assessment keeps its score, its snapshot, and its scale.
  select score_scale_max into s from screening_v2.assessments where weighted_score_5 = 4.6;
  if s <> 5 then raise exception 'historical row tagged scale % (expected 5)', s; end if;
  select count(*) into n
    from screening_v2.assessments
   where weighted_score_5 = 4.6 and scorecard_version_id = oldv and overall_score = 90;
  if n <> 1 then raise exception 'historical assessment was rescored or lost its snapshot'; end if;

  -- 6. New rows default to the four-point scale.
  insert into screening_v2.assessments(schema_version, metric_results, weighted_score_5, scoring_status)
  values (2, '[]'::jsonb, 3.5, 'complete');
  select score_scale_max into s from screening_v2.assessments where weighted_score_5 = 3.5;
  if s <> 4 then raise exception 'new row tagged scale % (expected 4)', s; end if;

  -- 7. A five-level rubric can no longer enter the mutable library…
  begin
    insert into screening_v2.scorecard_metric_library(key, name, default_instruction, rubric)
    values ('bad_five', 'Bad', 'i', '{"1":"a","2":"b","3":"c","4":"d","5":"e"}'::jsonb);
    raise exception 'a five-level library rubric was accepted';
  exception when check_violation then null;
  end;
  --    …a four-level one does…
  insert into screening_v2.scorecard_metric_library(key, name, default_instruction, rubric)
  values ('good_four', 'Good', 'i', '{"1":"Poor","2":"Average","3":"Good","4":"Excellent"}'::jsonb);
  --    …and a short rubric is refused by the shared validator.
  begin
    insert into screening_v2.scorecard_metric_library(key, name, default_instruction, rubric)
    values ('bad_three', 'Bad3', 'i', '{"1":"a","2":"b","3":"c"}'::jsonb);
    raise exception 'a three-level rubric was accepted';
  exception when check_violation then null;
  end;

  -- 8. A weighted score outside the row's own scale is rejected.
  begin
    insert into screening_v2.assessments(schema_version, metric_results, weighted_score_5, scoring_status, score_scale_max)
    values (2, '[]'::jsonb, 4.5, 'complete', 4);
    raise exception 'a weighted score above the row scale was accepted';
  exception when check_violation then null;
  end;

  raise notice 'PASS — 0093 rescale verified (immutability, mapping, idempotency, history, CHECKs).';
end $$;
