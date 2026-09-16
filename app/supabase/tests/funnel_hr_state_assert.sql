\set ON_ERROR_STOP on
-- ═══════════════════════════════════════════════════════════════════════════
-- 0098 — v_funnel_hr_state, the HR columns on the rollup, and the one-shot
-- backfill, EXECUTED on real Postgres.
--
-- WHY THIS FILE EXISTS. Every other check on 0098 is text-matching or a mocked
-- Supabase client, so none of them run a line of its SQL. Migrations here are
-- applied by the owner via `supabase db push`, not by CI — which means without
-- this file the first execution of 0098 would be against PRODUCTION, and a
-- syntax error, a wrong join grain or a silently-inverted CASE branch would be
-- discovered there.
--
-- It runs AFTER funnel_views_assert.sql, deliberately: that file has already
-- populated `funnel_stage_daily` through `refresh_funnel_rollup`, so the rows
-- 0098's backfill had to repair actually exist by the time 0098 is applied.
-- The backfill is a one-shot statement inside the migration; this is the only
-- place it is ever observed doing its job.
--
-- THE PROPERTY THIS FILE EXISTS TO DEFEND. `hr_state` must return 'unknown',
-- never 'disqualified', whenever the candidate's Ashby stage cannot actually be
-- observed. An `else 'disqualified'` would absorb three completely different
-- situations — no application link at all (every recruiter-uploaded résumé), a
-- link whose stage has not synced, and a mapping still missing a stage id — and
-- report each as an HR rejection. That is the exact artefact 0098 was written
-- to remove, and it is invisible in any test that only uses a fully-configured
-- fixture. Cases C4, D3 and E1 below each defeat it from a different direction.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── PART A: the one-shot backfill, already executed when 0098 was applied ──
do $$
declare r record;
begin
  select * into r from screening_v2.funnel_stage_daily
   where role_id = '10000000-0000-0000-0000-000000000001'
   order by cohort_day desc limit 1;
  if r is null then raise exception 'backfill: no rollup row from the 0090 fixture'; end if;

  -- `add column ... default 0` stamped a literal zero onto this pre-existing
  -- row. `refresh_funnel_rollup` would not repair it outside its trailing
  -- window, so the backfill is the ONLY thing that can — and a backfill that
  -- silently matched nothing leaves exactly these zeros behind.
  if r.candidates_total <> 4 then
    raise exception 'backfill: candidates_total 4 expected, got % (a no-op backfill leaves 0)', r.candidates_total;
  end if;

  -- C1 is at the mapped reference-check stage. C4 has an assessment but NO
  -- application link at all, so its stage is unobservable: `unknown`, and
  -- emphatically NOT an HR rejection.
  if r.hr_qualified <> 1 then raise exception 'backfill: hr_qualified 1, got %', r.hr_qualified; end if;
  if r.hr_unknown <> 1 then raise exception 'backfill: hr_unknown 1, got %', r.hr_unknown; end if;
  if r.hr_disqualified <> 0 then
    raise exception 'backfill: hr_disqualified MUST be 0 — a linkless candidate was counted as an HR rejection, got %', r.hr_disqualified;
  end if;
  if r.hr_awaiting <> 0 then raise exception 'backfill: hr_awaiting 0, got %', r.hr_awaiting; end if;

  -- The backfill touches ONLY the five new columns. If it were written as
  -- `refresh_funnel_rollup(now(), 3650)` instead it would delete and rebuild
  -- the whole history from the live views, destroying rollup rows whose source
  -- data has since been pruned — the retention-survival property 0090 exists
  -- for. These four are 0090's numbers and must be untouched.
  if r.dialed <> 3 then raise exception 'backfill must not touch dialed (3), got %', r.dialed; end if;
  if r.connected <> 2 then raise exception 'backfill must not touch connected (2), got %', r.connected; end if;
  if r.qualified <> 2 then raise exception 'backfill must not touch qualified (2), got %', r.qualified; end if;
  if r.reached_reference_check <> 1 then
    raise exception 'backfill must not touch reached_reference_check (1), got %', r.reached_reference_check;
  end if;

  -- The shape the dashboard cannot survive: a funnel narrower at the top than
  -- in the middle. "Total candidates 0" above "Candidates dialled 3" reads as a
  -- broken product, and it is vouched for by a fresh refreshed_at.
  if r.candidates_total < r.dialed then
    raise exception 'backfill: candidates_total (%) < dialed (%) — the funnel cannot be narrower at the top',
      r.candidates_total, r.dialed;
  end if;

  raise notice 'BACKFILL ASSERTIONS PASSED';
end $$;

-- ── Fixtures for the remaining states ─────────────────────────────────────
-- A SECOND role with a FULLY wired mapping (both stage ids), so `disqualified`
-- is reachable at all, and a THIRD with a half-wired one — which is how 0090
-- ships and how the live tenant is configured today.
insert into screening_v2.roles (id, title) values
  ('10000000-0000-0000-0000-000000000002', 'Sales Program Advisor Manager'),
  ('10000000-0000-0000-0000-000000000003', 'Associate Customer Success');

insert into screening_v2.ashby_job_mappings (id, role_id, ai_screening_stage_id, reference_check_stage_id) values
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'stage_ai', 'stage_ref2'),
  -- Half-wired ON PURPOSE: reference_check_stage_id is the placeholder 0090
  -- adds as NULL, and nobody has filled it in. This is the live configuration.
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'stage_ai3', null);

insert into screening_v2.candidates (id, role_id, phone_valid, parsed) values
  ('20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000002', true, '{}'),  -- D1 awaiting
  ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000002', true, '{}'),  -- D2 disqualified
  ('20000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000002', true, '{}'),  -- D3 unknown (stage unsynced)
  ('20000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000002', true, '{}'),  -- D4 null (no assessment)
  ('20000000-0000-0000-0000-000000000015', '10000000-0000-0000-0000-000000000002', true, '{}'),  -- D5 qualified via precedence
  ('20000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000003', true, '{}');  -- E1 unknown (mapping half-wired)

insert into screening_v2.call_sessions (id, candidate_id, status) values
  ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', 'completed'),
  ('30000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000012', 'completed'),
  ('30000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000013', 'completed'),
  ('30000000-0000-0000-0000-000000000015', '20000000-0000-0000-0000-000000000015', 'completed'),
  ('30000000-0000-0000-0000-000000000021', '20000000-0000-0000-0000-000000000021', 'completed');

-- D4 deliberately has NO assessment: the bot has not decided, so HR owes
-- nothing yet and the state must be NULL — not 'awaiting', even though the
-- candidate is sitting in the AI screening stage.
insert into screening_v2.assessments (session_id, candidate_id, recommendation, scoring_status) values
  ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', 'advance', 'complete'),
  ('30000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000012', 'advance', 'complete'),
  ('30000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000013', 'reject',  'complete'),
  ('30000000-0000-0000-0000-000000000015', '20000000-0000-0000-0000-000000000015', 'advance', 'complete'),
  ('30000000-0000-0000-0000-000000000021', '20000000-0000-0000-0000-000000000021', 'advance', 'complete');

insert into screening_v2.ashby_application_links (id, external_application_id, external_stage_id, job_mapping_id, candidate_id) values
  ('70000000-0000-0000-0000-000000000011', 'app_d1', 'stage_ai',       '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000011'),
  -- D2 is the ONLY genuine HR rejection here: a human moved them off the
  -- screening stage, on a mapping where both stages are known.
  ('70000000-0000-0000-0000-000000000012', 'app_d2', 'stage_rejected', '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000012'),
  -- D3's link exists but its stage has not synced. Indistinguishable from D2
  -- to any check that does not look at whether the stage is KNOWN.
  ('70000000-0000-0000-0000-000000000013', 'app_d3', null,             '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000013'),
  ('70000000-0000-0000-0000-000000000014', 'app_d4', 'stage_ai',       '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000014'),
  -- D5 holds TWO links: one still in screening, one already at reference
  -- check. Precedence must pick 'qualified', and the candidate must be counted
  -- ONCE — the view groups by candidate, so a regression to a per-LINK grain
  -- would both double-count them and let them land in two buckets at once.
  ('70000000-0000-0000-0000-000000000015', 'app_d5a', 'stage_ai',   '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000015'),
  ('70000000-0000-0000-0000-000000000016', 'app_d5b', 'stage_ref2', '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000015'),
  -- E1 sits at a stage that is neither mapped stage, on a mapping whose
  -- reference_check_stage_id is NULL. "Not at either mapped stage" here means
  -- "we cannot see where they are", NOT "a human rejected them".
  ('70000000-0000-0000-0000-000000000021', 'app_e1', 'stage_other',  '60000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000021');

-- ── PART B: every branch of hr_state ──────────────────────────────────────
do $$
declare t text; v int;
begin
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000011';
  if t is distinct from 'awaiting' then raise exception 'D1 awaiting, got %', t; end if;

  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000012';
  if t is distinct from 'disqualified' then raise exception 'D2 disqualified, got %', t; end if;

  -- THE GATE, from three directions. Each of these is 'disqualified' the
  -- moment the `observable` guard is weakened.
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000013';
  if t is distinct from 'unknown' then
    raise exception 'D3 (link present, stage NOT synced) MUST be unknown, got % — an unsynced stage is not an HR rejection', t;
  end if;
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000021';
  if t is distinct from 'unknown' then
    raise exception 'E1 (mapping has NO reference_check_stage_id) MUST be unknown, got % — this is how 0090 ships, so this branch decides whether an unconfigured tenant reads as a wall of HR rejections', t;
  end if;
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000004';
  if t is distinct from 'unknown' then
    raise exception 'C4 (assessment, NO application link at all) MUST be unknown, got %', t;
  end if;

  -- No assessment ⇒ the bot has not decided ⇒ NULL, even though D4 is sitting
  -- in the screening stage. 'awaiting' here would count un-screened people as
  -- an HR backlog.
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000014';
  if t is not null then raise exception 'D4 (no assessment) MUST be null, got %', t; end if;

  -- Precedence, and the per-candidate grain.
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000015';
  if t is distinct from 'qualified' then
    raise exception 'D5 (links at BOTH screening and reference check) MUST be qualified, got %', t;
  end if;
  select count(*) into v from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000015';
  if v <> 1 then raise exception 'D5 has two links but MUST yield ONE row, got % — the view is per-candidate, not per-link', v; end if;

  -- Grain: exactly one row per candidate, no more and no fewer. A join that
  -- multiplied rows would inflate every count(*) filter downstream.
  select count(*) into v from screening_v2.v_funnel_hr_state;
  if v <> (select count(*) from screening_v2.candidates) then
    raise exception 'v_funnel_hr_state must be one row per candidate: % rows vs % candidates',
      v, (select count(*) from screening_v2.candidates);
  end if;

  raise notice 'HR STATE ASSERTIONS PASSED';
end $$;

-- ── PART C: the refresh RPC carries the new columns ───────────────────────
select screening_v2.refresh_funnel_rollup(now(), 30);
do $$
declare r record;
begin
  select * into r from screening_v2.funnel_stage_daily
   where role_id = '10000000-0000-0000-0000-000000000002'
   order by cohort_day desc limit 1;
  if r is null then raise exception 'no rollup row for the fully-wired role'; end if;

  if r.candidates_total <> 5 then raise exception 'role2 candidates_total 5, got %', r.candidates_total; end if;
  if r.hr_qualified <> 1 then raise exception 'role2 hr_qualified 1 (D5), got %', r.hr_qualified; end if;
  if r.hr_awaiting <> 1 then raise exception 'role2 hr_awaiting 1 (D1), got %', r.hr_awaiting; end if;
  if r.hr_disqualified <> 1 then raise exception 'role2 hr_disqualified 1 (D2 only), got %', r.hr_disqualified; end if;
  if r.hr_unknown <> 1 then raise exception 'role2 hr_unknown 1 (D3), got %', r.hr_unknown; end if;
  -- D4 has no assessment, so it is in candidates_total and in NO hr bucket.
  if r.hr_qualified + r.hr_disqualified + r.hr_awaiting + r.hr_unknown <> 4 then
    raise exception 'role2: the four hr buckets must sum to the 4 SCREENED candidates, got %',
      r.hr_qualified + r.hr_disqualified + r.hr_awaiting + r.hr_unknown;
  end if;

  select * into r from screening_v2.funnel_stage_daily
   where role_id = '10000000-0000-0000-0000-000000000003'
   order by cohort_day desc limit 1;
  if r is null then raise exception 'no rollup row for the half-wired role'; end if;
  -- The live tenant's shape: nothing is decidable, so nothing may be reported
  -- as decided. A single hr_disqualified here is the artefact this migration
  -- was written to remove.
  if r.hr_disqualified <> 0 then
    raise exception 'role3 (no reference_check_stage_id) hr_disqualified MUST be 0, got %', r.hr_disqualified;
  end if;
  if r.hr_unknown <> 1 then raise exception 'role3 hr_unknown 1 (E1), got %', r.hr_unknown; end if;

  raise notice 'ROLLUP HR COLUMN ASSERTIONS PASSED';
end $$;

-- Idempotency across the new columns too: the refresh is delete-then-insert,
-- so a second pass must not duplicate rows or double the HR counts.
select screening_v2.refresh_funnel_rollup(now(), 30);
do $$
declare v int; r record;
begin
  select count(*) into v from screening_v2.funnel_stage_daily
   where role_id = '10000000-0000-0000-0000-000000000002';
  if v <> 1 then raise exception 'expected 1 rollup row for role2 after re-refresh, got %', v; end if;

  select * into r from screening_v2.funnel_stage_daily
   where role_id = '10000000-0000-0000-0000-000000000002' limit 1;
  if r.hr_disqualified <> 1 or r.candidates_total <> 5 then
    raise exception 're-refresh changed the HR counts: hr_disqualified=%, candidates_total=%',
      r.hr_disqualified, r.candidates_total;
  end if;

  raise notice 'HR IDEMPOTENCY ASSERTION PASSED';
end $$;
