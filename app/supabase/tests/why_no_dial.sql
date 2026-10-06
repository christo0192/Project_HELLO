-- ============================================================================
--  WHY IS NOTHING DIALLING? — READ ONLY
-- ============================================================================
--  The runtime's own `phone_due_diag` log line is arriving with its detail
--  field nulled by the logger's value defense, so the answer has to come from
--  the database. This checks every precondition admission tests, per
--  engagement, and names the first one that fails.
-- ============================================================================

-- A. The engine-level view (halt, states, admission counters, attempts).
select screening_v2.phone_backlog(now()) as backlog;

-- B. Per candidate: which precondition is blocking the dial.
select
  c.name                                                    as candidate,
  e.state,
  coalesce(e.next_eligible_at::text, 'now')                 as eligible_from,
  c.phone_valid                                             as number_ok,
  (c.consent_source is not null or e.consent_record_id is not null) as consent_ok,
  (select count(*) from screening_v2.phone_suppressions s
    where s.candidate_id = c.id)                            as suppressions,
  coalesce(i.state, 'no ingestion row')                     as ingestion_state,
  coalesce(m.status, 'NO MAPPING')                          as mapping_status,
  (select count(*) from screening_v2.phone_call_attempts a
    where a.engagement_id = e.id
      and a.ist_date = screening_v2.phone_ist_date(now()))   as attempts_today,
  case
    when e.state <> 'eligible'                    then 'state is ' || e.state || ', not eligible'
    when c.phone_valid is not true                then 'phone_invalid — no dialable number'
    when e.next_eligible_at > now()               then 'held until ' || e.next_eligible_at::text
    when (select count(*) from screening_v2.phone_suppressions s
           where s.candidate_id = c.id) > 0       then 'suppressed — do-not-call record'
    when m.status is distinct from 'enabled'      then 'mapping ' || coalesce(m.status, 'missing')
    when i.state is distinct from 'ready'         then 'ingestion_not_ready — resume state is '
                                                        || coalesce(i.state, 'absent')
    when (select count(*) from screening_v2.phone_call_attempts a
           where a.engagement_id = e.id
             and a.ist_date = screening_v2.phone_ist_date(now())) > 0
                                                  then 'daily_attempt_exists — already tried today'
    when c.consent_source is null
     and e.consent_record_id is null              then 'consent_missing — no consent on file'
    else 'no blocker found here — see the backlog above (capacity / worker gate)'
  end                                                       as likely_blocker
from screening_v2.phone_engagements e
join screening_v2.candidates c              on c.id = e.candidate_id
left join screening_v2.ashby_application_links l on l.id = e.application_link_id
left join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id
left join screening_v2.ashby_resume_ingestions i on i.application_link_id = l.id
order by c.name;
