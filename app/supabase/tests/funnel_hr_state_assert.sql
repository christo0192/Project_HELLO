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
-- THE PROPERTY THIS FILE EXISTS TO DEFEND. `hr_state` must return 'unknown'
-- whenever the candidate's Ashby stage cannot actually be observed — and that
-- includes 'awaiting', not just 'disqualified'.
--
-- The trap is that `external_stage_id` is NOT a current stage. It is written
-- once, at import, and signal-worker.ts guarantees it equals the mapping's
-- `ai_screening_stage_id`; nothing ever updates it. So a view that reads it
-- naively finds every scored Ashby candidate "still in AI screening" forever:
-- `qualified` and `disqualified` become unreachable and `awaiting` claims HR
-- has not opened someone they rejected weeks ago. `stage_synced_at` is the
-- proof-of-observation that gates all three. See 0098 §0.
--
-- A fixture that sets external_stage_id to some other stage is therefore a
-- state PRODUCTION CANNOT REACH, and a suite built only from those would have
-- passed this migration while it was structurally broken. F1 and F2 below use
-- the real production shape — link synced never, stage stuck at the screening
-- stage — and must read `unknown`.
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

  -- BOTH screened candidates here are `unknown`, and that is the correct — and
  -- most important — answer in this file.
  --
  -- C4 has an assessment and no application link at all (every
  -- recruiter-uploaded résumé looks like this). C1 DOES sit at the mapped
  -- reference-check stage, and would have read `qualified` under a naive view —
  -- but its link was created by the 0090 fixture, before `stage_synced_at`
  -- existed, so its stage has never been confirmed since import. That is the
  -- shape of every link in the live database. We do not know where C1 is, so we
  -- say so.
  --
  -- This is also why the counts below are not a regression from the earlier
  -- version of this file: the earlier version asserted `hr_qualified = 1` off a
  -- link whose "current stage" was an import-time constant. It was asserting
  -- the bug.
  if r.hr_unknown <> 2 then
    raise exception 'backfill: hr_unknown 2 expected (C1 + C4, neither stage confirmed since import), got %', r.hr_unknown;
  end if;
  if r.hr_qualified <> 0 then
    raise exception 'backfill: hr_qualified MUST be 0 — C1''s stage has never been confirmed since import, so "at reference check" is an unproven reading of a constant. Got %', r.hr_qualified;
  end if;
  if r.hr_disqualified <> 0 then
    raise exception 'backfill: hr_disqualified MUST be 0 — a linkless candidate was counted as an HR rejection, got %', r.hr_disqualified;
  end if;
  if r.hr_awaiting <> 0 then
    raise exception 'backfill: hr_awaiting MUST be 0 — an unconfirmed stage is not a claim that HR has not looked, got %', r.hr_awaiting;
  end if;

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

-- `stage_synced_at` set = we have CONFIRMED this link's stage since import.
-- Without it every one of these reads `unknown`, which is the production state
-- and is asserted separately by F1/F2.
insert into screening_v2.ashby_application_links
  (id, external_application_id, external_stage_id, job_mapping_id, candidate_id, stage_synced_at) values
  ('70000000-0000-0000-0000-000000000011', 'app_d1', 'stage_ai',       '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000011', now()),
  -- D2 is the ONLY genuine HR rejection here: a human moved them off the
  -- screening stage, on a mapping where both stages are known.
  ('70000000-0000-0000-0000-000000000012', 'app_d2', 'stage_rejected', '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000012', now()),
  -- D3's link exists but its stage has not synced. Indistinguishable from D2
  -- to any check that does not look at whether the stage is KNOWN.
  ('70000000-0000-0000-0000-000000000013', 'app_d3', null,             '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000013', now()),
  ('70000000-0000-0000-0000-000000000014', 'app_d4', 'stage_ai',       '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000014', now()),
  -- D5 holds TWO links: one still in screening, one already at reference
  -- check. Precedence must pick 'qualified', and the candidate must be counted
  -- ONCE — the view groups by candidate, so a regression to a per-LINK grain
  -- would both double-count them and let them land in two buckets at once.
  ('70000000-0000-0000-0000-000000000015', 'app_d5a', 'stage_ai',   '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000015', now()),
  ('70000000-0000-0000-0000-000000000016', 'app_d5b', 'stage_ref2', '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000015', now()),
  -- E1 sits at a stage that is neither mapped stage, on a mapping whose
  -- reference_check_stage_id is NULL. "Not at either mapped stage" here means
  -- "we cannot see where they are", NOT "a human rejected them".
  ('70000000-0000-0000-0000-000000000021', 'app_e1', 'stage_other',  '60000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000021', now());

-- ── THE PRODUCTION SHAPE ──────────────────────────────────────────────────
-- Two candidates on the FULLY-wired job whose links look exactly like every
-- link in the live database: imported, stage stuck at the AI screening stage,
-- never confirmed since. Their real stage is unknown to us, so both must read
-- `unknown` — including F2, whom a human moved to Reference Check in Ashby
-- without us ever hearing about it. Any version of this view that reads
-- `external_stage_id` without `stage_synced_at` calls both of them 'awaiting'.
insert into screening_v2.candidates (id, role_id, phone_valid, parsed) values
  ('20000000-0000-0000-0000-000000000031', '10000000-0000-0000-0000-000000000002', true, '{}'),
  ('20000000-0000-0000-0000-000000000032', '10000000-0000-0000-0000-000000000002', true, '{}');
insert into screening_v2.call_sessions (id, candidate_id, status) values
  ('30000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-000000000031', 'completed'),
  ('30000000-0000-0000-0000-000000000032', '20000000-0000-0000-0000-000000000032', 'completed');
insert into screening_v2.assessments (session_id, candidate_id, recommendation, scoring_status) values
  ('30000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-000000000031', 'advance', 'complete'),
  ('30000000-0000-0000-0000-000000000032', '20000000-0000-0000-0000-000000000032', 'advance', 'complete');
-- stage_synced_at omitted = NULL = never confirmed. This is the default, and
-- today it is the ONLY state any production link is ever in.
insert into screening_v2.ashby_application_links
  (id, external_application_id, external_stage_id, job_mapping_id, candidate_id) values
  ('70000000-0000-0000-0000-000000000031', 'app_f1', 'stage_ai', '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000031'),
  ('70000000-0000-0000-0000-000000000032', 'app_f2', 'stage_ai', '60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000032');

do $$
declare t text;
begin
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000031';
  if t is distinct from 'unknown' then
    raise exception 'F1 (import-time link, stage never confirmed — EVERY production link) MUST be unknown, got %. external_stage_id is a constant equal to the AI screening stage; reading it as a current stage makes qualified/disqualified unreachable and turns awaiting into a claim about someone HR may have decided on weeks ago', t;
  end if;
  select hr_state into t from screening_v2.v_funnel_hr_state where candidate_id = '20000000-0000-0000-0000-000000000032';
  if t is distinct from 'unknown' then
    raise exception 'F2 MUST be unknown, got %', t;
  end if;
  raise notice 'PRODUCTION-SHAPE ASSERTIONS PASSED';
end $$;

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

  if r.candidates_total <> 7 then raise exception 'role2 candidates_total 7, got %', r.candidates_total; end if;
  if r.hr_qualified <> 1 then raise exception 'role2 hr_qualified 1 (D5), got %', r.hr_qualified; end if;
  if r.hr_awaiting <> 1 then raise exception 'role2 hr_awaiting 1 (D1 only — F1/F2 are NOT awaiting), got %', r.hr_awaiting; end if;
  if r.hr_disqualified <> 1 then raise exception 'role2 hr_disqualified 1 (D2 only), got %', r.hr_disqualified; end if;
  if r.hr_unknown <> 3 then raise exception 'role2 hr_unknown 3 (D3, F1, F2), got %', r.hr_unknown; end if;
  -- D4 has no assessment, so it is in candidates_total and in NO hr bucket.
  if r.hr_qualified + r.hr_disqualified + r.hr_awaiting + r.hr_unknown <> 6 then
    raise exception 'role2: the four hr buckets must sum to the 6 SCREENED candidates, got %',
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
  if r.hr_disqualified <> 1 or r.candidates_total <> 7 then
    raise exception 're-refresh changed the HR counts: hr_disqualified=%, candidates_total=%',
      r.hr_disqualified, r.candidates_total;
  end if;

  raise notice 'HR IDEMPOTENCY ASSERTION PASSED';
end $$;

-- ── PART D: the roll-up heartbeat ─────────────────────────────────────────
-- `max(refreshed_at)` over the DATA answers "when was a row last written",
-- which is a different question from "when did the roll-up last run": an empty
-- window writes nothing and rows outside the window are never re-stamped. A
-- tenant with a month of no intake had the loop running every 15 minutes and a
-- dashboard reporting a date from last quarter.
do $$
declare r record; v_before timestamptz;
begin
  select * into r from screening_v2.funnel_rollup_runs where id = 1;
  if r is null then raise exception 'no heartbeat row after two refreshes'; end if;
  v_before := r.ran_at;

  -- The load-bearing case: a window that matches NOTHING still counts as a run.
  perform screening_v2.refresh_funnel_rollup(now() + interval '400 days', 1);
  select * into r from screening_v2.funnel_rollup_runs where id = 1;
  if r.ran_at <= v_before then
    raise exception 'a refresh that wrote no rows MUST still stamp the heartbeat (was %, now %)', v_before, r.ran_at;
  end if;
  if r.rows_written <> 0 then
    raise exception 'expected 0 rows written for an empty window, got %', r.rows_written;
  end if;

  -- Singleton: the dashboard reads `id = 1`, so a second row would be invisible.
  if (select count(*) from screening_v2.funnel_rollup_runs) <> 1 then
    raise exception 'the heartbeat must stay a single row';
  end if;

  raise notice 'HEARTBEAT ASSERTIONS PASSED';
end $$;
