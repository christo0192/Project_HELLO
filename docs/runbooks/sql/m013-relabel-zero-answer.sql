-- M013 S02 — relabel a ZERO-ANSWER phone screening "Abandoned: dropped before
-- screening" (engagement failed / screening_abandoned), never "Screened".
--
-- OWNER-RUN, through the sanctioned production SQL path only. Requires
-- migration 0115 to be applied. Background and rules:
-- docs/runbooks/session-lifecycle.md ("Phone engagement terminal relabels")
-- and docs/runbooks/phone-safe-dialer.md §13.
--
-- ── PLACEHOLDERS ─────────────────────────────────────────────────────
-- This file deliberately carries NO real ids. Before running, find and
-- replace EVERY occurrence of:
--
--   <ENGAGEMENT_ID>     the phone_engagements.id to relabel
--   <OPERATOR_USER_ID>  the operator's own auth user id (the RPC audits it
--                       as actor_type `recruiter`). Never the all-zero
--                       system sentinel, which is reserved for the API.
--
-- An unreplaced placeholder is not a valid uuid, so the statement fails
-- before it reads or writes anything.
--
-- ── WHAT THE RPC DOES, AND DOES NOT DO ───────────────────────────────
-- relabel_zero_answer_phone_engagement re-checks everything under the
-- engagement row lock (the pre-check below is a preview, not the decision):
--   * engagement completed -> failed / screening_abandoned (state,
--     state_reason, version, updated_at only; terminal_at untouched);
--   * candidate screened -> screening, only if this is their latest
--     assessment, they are not decision-blocked and no human changed their
--     status since. NEVER `queued`. Already `screening`: left as is;
--   * audit rows: `screening_failed` (phone_engagement) and, when the
--     candidate moved, `candidate_status_changed`, with metadata
--     {from, to, reason: 'screening_abandoned', migration: '0115'}.
-- It NEVER requeues, rescreens, creates an attempt, a ledger row or a queue
-- job, and never touches the Ashby link (it stays parked). Nothing redials.
--
-- Answers: applied | already (idempotent, writes nothing) |
-- not_eligible (reason: invalid_request | not_found | not_completed |
-- not_zero_answer; writes nothing).
--
-- Relabelling any engagement other than the one the owner approved needs
-- the owner's approval first (step 0 lists candidates; it changes nothing).


-- ── 0. DISCOVERY (read-only, optional) ───────────────────────────────
-- Completed phone engagements whose bound session's LATEST assessment is a
-- phone row graded insufficient with a MEASURED 0 answers, i.e. exactly the
-- rows the RPC would accept. Opaque ids and codes only.
select e.id                as engagement_id,
       e.session_id,
       e.terminal_at,
       l.evidence_reason,
       c.status            as candidate_status
  from screening_v2.phone_engagements e
  join lateral (
    select a.source, a.evidence_grade, a.evidence_answered, a.evidence_reason
      from screening_v2.assessments a
     where a.session_id = e.session_id
     order by a.created_at desc, a.revision desc, a.id desc
     limit 1
  ) l on true
  join screening_v2.candidates c on c.id = e.candidate_id
 where e.state = 'completed'
   and e.terminal_at is not null
   and e.session_id is not null
   and l.source = 'phone'
   and l.evidence_grade = 'insufficient'
   and l.evidence_answered = 0
 order by e.terminal_at;


-- ── 1. PRE-CHECK (read-only) ─────────────────────────────────────────
-- Expected before a historical correction:
--   eng_state = 'completed', eng_terminal = true, session_id not null
--   asm_source = 'phone', asm_grade = 'insufficient', asm_answered = 0
--   candidate_status = 'screened' (or 'screening': it will be left as is)
--   decision_blocked = false, candidate_latest_is_this = true,
--   human_status_change_since = false (true: the candidate will NOT move.
--     After an operator relabel this reads true because of that run's own
--     `recruiter` audit; on a re-run, ignore it.)
-- Record session_status, duration_sec, duration_unobserved_legs,
-- link_lifecycle and the four baseline counts: step 3 compares against them.
-- If eng_state is not 'completed' or the assessment is not a measured
-- 0-answer phone row, STOP: the RPC will answer not_eligible.
with p as (select '<ENGAGEMENT_ID>'::uuid as engagement_id),
eng as (
  select e.* from screening_v2.phone_engagements e, p
   where e.id = p.engagement_id
),
asm as (
  select a.* from screening_v2.assessments a, eng
   where a.session_id = eng.session_id
   order by a.created_at desc, a.revision desc, a.id desc
   limit 1
)
select
  eng.state                                   as eng_state,
  eng.state_reason                            as eng_state_reason,
  eng.terminal_at is not null                 as eng_terminal,
  eng.session_id,
  asm.source                                  as asm_source,
  asm.evidence_grade                          as asm_grade,
  asm.evidence_answered                       as asm_answered,
  asm.evidence_reason                         as asm_reason,
  c.status                                    as candidate_status,
  c.decision_use_blocked_at is not null       as decision_blocked,
  (select l.id from screening_v2.assessments l
    where l.candidate_id = c.id
    order by l.created_at desc, l.revision desc, l.id desc
    limit 1) = asm.id                         as candidate_latest_is_this,
  exists (select 1 from screening_v2.audit_events ae
           where ae.action = 'candidate_status_changed'
             and ae.target_type = 'candidate'
             and ae.target_id = c.id::text
             and ae.actor_type <> 'system'
             and ae.created_at >= asm.created_at) as human_status_change_since,
  s.status                                    as session_status,
  s.duration_sec,
  s.duration_unobserved_legs,
  (select k.lifecycle from screening_v2.ashby_application_links k
    where k.id = eng.application_link_id)     as link_lifecycle,
  (select count(*) from screening_v2.phone_call_attempts t
    where t.engagement_id = eng.id)           as attempts,
  (select count(*) from screening_v2.phone_call_events ev
    where ev.engagement_id = eng.id)          as ledger_rows,
  (select count(*) from screening_v2.phone_rescreen_requests r
    where r.predecessor_engagement_id = eng.id) as rescreen_requests,
  (select count(*) from screening_v2.job_queue j
    where j.payload->>'session_id' = eng.session_id::text) as queue_jobs
  from eng
  left join asm on true
  left join screening_v2.candidates c on c.id = asm.candidate_id
  left join screening_v2.call_sessions s on s.id = eng.session_id;


-- ── 2. RUN ───────────────────────────────────────────────────────────
-- One transaction. Read the RPC's answer and the post-check BEFORE
-- committing; roll back on anything unexpected.
begin;

select screening_v2.relabel_zero_answer_phone_engagement(
         '<ENGAGEMENT_ID>'::uuid,
         '<OPERATOR_USER_ID>'::uuid,
         now()
       ) as result;
-- Expected: {"status": "applied", "candidate_moved": true, ...}
--   candidate_moved false is correct when the candidate was already
--   `screening`, or a human changed their status since the assessment.
--   "already" on a re-run is fine (nothing written).
--   "not_eligible" wrote nothing: roll back and re-read step 1.


-- ── 3. POST-CHECK (run inside the transaction, then again after) ─────
-- Expected:
--   eng_state = 'failed', eng_state_reason = 'screening_abandoned',
--     eng_terminal = true (terminal_at unchanged)
--   candidate_status = 'screening' (NEVER 'queued', not 'screened'),
--     unless step 1 showed a human status change, in which case unchanged
--   engagement_audits = 1; candidate_audits = 1 if the candidate moved, else 0
--   session_status, duration_sec, duration_unobserved_legs, link_lifecycle:
--     unchanged from step 1
--   attempts, ledger_rows, rescreen_requests, queue_jobs: EQUAL to step 1
--     (no new attempt, ledger row, rescreen or job)
-- The display then reads "Abandoned: dropped before screening".
with p as (select '<ENGAGEMENT_ID>'::uuid as engagement_id),
eng as (
  select e.* from screening_v2.phone_engagements e, p
   where e.id = p.engagement_id
),
asm as (
  select a.* from screening_v2.assessments a, eng
   where a.session_id = eng.session_id
   order by a.created_at desc, a.revision desc, a.id desc
   limit 1
)
select
  eng.state                                   as eng_state,
  eng.state_reason                            as eng_state_reason,
  eng.terminal_at is not null                 as eng_terminal,
  c.status                                    as candidate_status,
  (select count(*) from screening_v2.audit_events ae
    where ae.action = 'screening_failed'
      and ae.target_type = 'phone_engagement'
      and ae.target_id = eng.id::text
      and ae.metadata->>'reason' = 'screening_abandoned') as engagement_audits,
  (select count(*) from screening_v2.audit_events ae
    where ae.action = 'candidate_status_changed'
      and ae.target_type = 'candidate'
      and ae.target_id = c.id::text
      and ae.metadata->>'reason' = 'screening_abandoned') as candidate_audits,
  s.status                                    as session_status,
  s.duration_sec,
  s.duration_unobserved_legs,
  (select k.lifecycle from screening_v2.ashby_application_links k
    where k.id = eng.application_link_id)     as link_lifecycle,
  (select count(*) from screening_v2.phone_call_attempts t
    where t.engagement_id = eng.id)           as attempts,
  (select count(*) from screening_v2.phone_call_events ev
    where ev.engagement_id = eng.id)          as ledger_rows,
  (select count(*) from screening_v2.phone_rescreen_requests r
    where r.predecessor_engagement_id = eng.id) as rescreen_requests,
  (select count(*) from screening_v2.job_queue j
    where j.payload->>'session_id' = eng.session_id::text) as queue_jobs
  from eng
  left join asm on true
  left join screening_v2.candidates c on c.id = asm.candidate_id
  left join screening_v2.call_sessions s on s.id = eng.session_id;

commit;
