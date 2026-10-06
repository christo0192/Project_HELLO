-- ============================================================================
--  WHO WOULD BE DIALLED THE MOMENT THE HALT CLEARS — READ ONLY
-- ============================================================================
--  Clearing screening_v2.clear_phone_halt() puts every `eligible` engagement
--  back in front of the dialer within one scheduler tick, and these are real
--  people. Run this first and read the "verdict" column.
-- ============================================================================

select
  c.name                                             as candidate,
  c.phone_valid                                      as dialable,
  e.state,
  e.cycle_number                                     as cycle,
  e.no_answer_attempts                               as no_answer,
  coalesce(e.state_reason, '—')                      as why_this_state,
  coalesce(e.last_attempt_at::text, 'never called')  as last_attempt,
  coalesce(e.next_eligible_at::text, 'now')          as eligible_from,
  (select count(*) from screening_v2.phone_call_attempts a where a.engagement_id = e.id) as attempts_so_far,
  (select count(*) from screening_v2.assessments s where s.candidate_id = c.id)          as assessments,
  case
    when c.phone_valid is not true
      then 'WILL NOT DIAL — no dialable number'
    when e.next_eligible_at is not null and e.next_eligible_at > now()
      then 'not yet — held until ' || e.next_eligible_at::text
    when (select count(*) from screening_v2.assessments s where s.candidate_id = c.id) > 0
      then 'WOULD DIAL — but this candidate ALREADY HAS A SCORED ASSESSMENT, so this is a repeat call'
    else 'WOULD DIAL on the next tick'
  end                                                as verdict
from screening_v2.phone_engagements e
join screening_v2.candidates c on c.id = e.candidate_id
where e.state = 'eligible'
order by c.name;
