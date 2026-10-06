-- ============================================================================
--  PRODUCTION GATE STATE — READ ONLY, CHANGES NOTHING
-- ============================================================================
--  One result set describing every gate that decides whether a real candidate
--  gets called and whether the result reaches Ashby. Run it in the Supabase
--  SQL editor before flipping anything, and again afterwards.
-- ============================================================================

with mappings as (
  select 1 as ord, 'MAPPING' as gate,
         m.external_job_id || '  →  ' || coalesce(r.title, '(no role)') as item,
         m.status
           || case when m.status_reason is not null then ' (' || m.status_reason || ')' else '' end
           || '  delivery=' || m.delivery_mode
           || '  ai_stage=' || case when m.ai_screening_stage_id is null then 'MISSING' else 'set' end
           || '  ta_stage=' || case when m.ta_screening_stage_id is null then 'MISSING' else 'set' end
           as detail
    from screening_v2.ashby_job_mappings m
    left join screening_v2.roles r on r.id = m.role_id
),
phone as (
  select 2, 'PHONE',
         case when pc.halted_at is null then 'Dialling halt' else 'DIALLING HALTED' end,
         case when pc.halted_at is null then 'not halted'
              else 'halted at ' || pc.halted_at::text || ' — ' || coalesce(pc.halt_reason, 'no reason given') end
    from screening_v2.phone_control pc
   where pc.control_key = 'default'
  union all
  select 2, 'PHONE', 'Calling window (IST)',
         screening_v2.phone_ist_window_open_at()::text || ' to ' || screening_v2.phone_ist_window_close_at()::text
  union all
  select 2, 'PHONE', 'Window open right now?',
         case when screening_v2.phone_ist_window_open(now()) then 'YES — a due call would dial'
              else 'NO — next opens ' || screening_v2.phone_next_window_open(now())::text end
  union all
  select 2, 'PHONE', 'Temporary 24/7 override until',
         case when screening_v2.phone_temporary_247_until() > current_date
              then 'ACTIVE until ' || screening_v2.phone_temporary_247_until()::text || ' — the window above is BYPASSED'
              else 'expired (' || screening_v2.phone_temporary_247_until()::text || ') — the window above applies' end
),
scorecards as (
  select 3, 'SCORECARD',
         r.title,
         case when r.active_scorecard_version_id is null then 'NO active scorecard — screenings take the legacy v1 path'
              else coalesce(
                     (select count(*)::text || ' metric(s): '
                             || string_agg(m.name, ', ' order by m.display_order)
                        from screening_v2.role_scorecard_version_metrics m
                       where m.scorecard_version_id = r.active_scorecard_version_id),
                     'active scorecard version exists but holds NO metrics — nothing would be scored')
              end
    from screening_v2.roles r
),
rubric as (
  select 4, 'RUBRIC',
         'Levels on the active scorecards',
         case when count(*) = 0 then 'no metrics on any active scorecard'
              when count(*) filter (where m.rubric ? '5') > 0
              then 'MIXED — ' || (count(*) filter (where m.rubric ? '5'))::text || ' of ' || count(*)::text || ' metric(s) still five-level'
              else 'four-level (1 Poor, 2 Average, 3 Good, 4 Excellent) on all ' || count(*)::text || ' metric(s)' end
    from screening_v2.role_scorecard_version_metrics m
    join screening_v2.roles r on r.active_scorecard_version_id = m.scorecard_version_id
),
work as (
  select 5, 'WORK', 'Candidates / roles',
         (select count(*)::text from screening_v2.candidates) || ' candidate(s), '
      || (select count(*)::text from screening_v2.roles) || ' role(s)'
  union all
  select 5, 'WORK', 'Phone engagements by state',
         coalesce((select string_agg(x.state || '=' || x.n::text, ', ' order by x.state)
                     from (select state, count(*) as n from screening_v2.phone_engagements group by state) x), 'none')
  union all
  select 5, 'WORK', 'Ashby operations by state',
         coalesce((select string_agg(x.state || '=' || x.n::text, ', ' order by x.state)
                     from (select state, count(*) as n from screening_v2.ashby_operations group by state) x), 'none')
  union all
  select 5, 'WORK', 'Queue depth / dead letters',
         (select count(*)::text from screening_v2.job_queue) || ' queued, '
      || (select count(*)::text from screening_v2.job_dlq) || ' dead-lettered'
  union all
  select 5, 'WORK', 'Do-not-call suppressions',
         (select count(*)::text from screening_v2.phone_suppressions)
)
select gate, item, detail from (
  select * from mappings union all select * from phone
  union all select * from scorecards union all select * from rubric union all select * from work
) x order by ord, item;
