-- Two distinct eligible candidates contend for the same 55-minute Send-R1 hold.
insert into screening_v2.candidates (id, role_id, name) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'race one'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'race two');
-- This creates genuine first-of-month contention: neither caller can observe a
-- pre-existing budget row before the blocker releases the settings lock.
delete from screening_v2.r1_budget_month where month_start = date_trunc('month', now())::date;
update screening_v2.r1_settings set enabled = true, paused = false, livekit_target = 'r1',
  monthly_cap_minutes = 55, pause_line_minutes = 55, dashboard_minutes = 0;
