-- Two distinct eligible candidates contend for the same 55-minute Send-R1 hold.
insert into screening_v2.candidates (id, role_id, name) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'race one'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'race two');
-- This creates genuine first-of-month contention: neither caller can observe a
-- pre-existing budget row before the blocker releases the settings lock.
delete from screening_v2.r1_budget_month where month_start = date_trunc('month', now())::date;
update screening_v2.r1_settings set enabled = true, paused = false, livekit_target = 'r1',
  dashboard_minutes = 0;
-- Earlier suites leave sessions that feed the WebRTC estimate, so pin the cap to
-- (the guard the RPC will compute) + exactly one 55-minute hold: the first racer
-- fits, and the second cannot, because its outstanding hold now counts.
update screening_v2.r1_settings s
   set monthly_cap_minutes = ceil(g.guard) + 55, pause_line_minutes = ceil(g.guard) + 55
  from (select greatest(
          coalesce((select sum(l.seconds) / 60.0 from screening_v2.r1_usage_ledger l
                     where l.occurred_at >= coalesce(x.dashboard_read_at, now())), 0),
          coalesce((select e.r1_minutes + e.phone_minutes + e.legacy_browser_minutes
                      from screening_v2.v_webrtc_minutes_estimate e
                     where e.month_start = date_trunc('month', now())::date), 0)
        ) * 1.15 as guard
          from screening_v2.r1_settings x where x.singleton) g
 where s.singleton;
