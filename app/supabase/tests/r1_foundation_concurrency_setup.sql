-- Two distinct eligible candidates contend for the same 55-minute Send-R1 hold.
insert into screening_v2.candidates (id, role_id, name) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'race one'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'race two');
-- This creates genuine first-of-month contention: neither caller can observe a
-- pre-existing budget row before the blocker releases the settings lock.
delete from screening_v2.r1_budget_month where month_start = date_trunc('month', now())::date;
-- Mode A (self-hosted R1): the R1 allocation (monthly_cap_minutes) is the only
-- binding check, so the Cloud pause line is parked far above any pool estimate.
update screening_v2.r1_settings set enabled = true, paused = false, livekit_target = 'r1',
  pause_line_minutes = 100000, dashboard_minutes = 0, dashboard_read_at = null,
  dashboard_estimate_baseline = null;
-- Earlier suites leave sessions that feed the estimate, so pin the allocation to
-- the committed R1 minutes the RPC will compute (taken from the SAME shared
-- snapshot function, so the rule is not restated here) + exactly one 55-minute
-- hold: the first racer fits, and the second cannot, because the first racer's
-- outstanding hold now counts.
update screening_v2.r1_settings s
   set monthly_cap_minutes = ceil((c.snapshot->>'r1_committed')::numeric) + 55
  from (select screening_v2.r1_capacity_snapshot(now(), 0) as snapshot) c
 where s.singleton;
