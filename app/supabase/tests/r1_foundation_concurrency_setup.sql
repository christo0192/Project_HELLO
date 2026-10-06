-- Two distinct eligible rounds contend for the same 55-minute monthly hold.
insert into screening_v2.candidates (id, role_id, name) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'race one'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'race two');
insert into screening_v2.interview_rounds (id, candidate_id, role_id, link_token_digest, expires_at, created_by) values
  ('20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', repeat('c', 64), now() + interval '1 day', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', repeat('d', 64), now() + interval '1 day', '10000000-0000-4000-8000-000000000001');
insert into screening_v2.interview_round_consents (round_id, template_id) values
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000052'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000052');
-- This creates genuine first-of-month contention: neither caller can observe a
-- pre-existing budget row before the blocker releases the settings lock.
delete from screening_v2.r1_budget_month where month_start = date_trunc('month', now())::date;
update screening_v2.r1_settings set enabled = true, paused = false, livekit_target = 'r1',
  monthly_cap_minutes = 55, pause_line_minutes = 55, dashboard_minutes = 0;
