-- R1's deliberately small shared-table extension. All fields are nullable.
set local lock_timeout = '10s';

alter table screening_v2.call_sessions
  add column if not exists interview_round_id uuid null;

-- NOT VALID avoids the initial scan while enforcing new writes immediately.
-- At the 2026-10-06 production size (82 call_sessions / 304 kB; 407
-- transcript_turns), validating in this file is acceptable: VALIDATE permits
-- normal DML, matching the repo's 0008/0014/0021/0044 precedent.
alter table screening_v2.call_sessions
  add constraint fk_call_sessions_interview_round
    foreign key (interview_round_id) references screening_v2.interview_rounds(id)
    on delete cascade not valid;
alter table screening_v2.call_sessions
  validate constraint fk_call_sessions_interview_round;

-- Keep these transactional/non-concurrent. Repo precedent 0107:27 and
-- 0112:74-78 builds call_sessions indexes this way, and `supabase db push`
-- applies migrations transactionally. The merge runs in the off-hours window
-- behind the zero-live gate; the tables are only 82 call_sessions / 304 kB
-- and 407 transcript_turns as measured read-only on 2026-10-06.
create unique index if not exists uq_call_sessions_interview_round_live
  on screening_v2.call_sessions(interview_round_id)
  where interview_round_id is not null and status in ('created', 'waiting', 'in_progress');
create index if not exists idx_call_sessions_interview_round
  on screening_v2.call_sessions(interview_round_id)
  where interview_round_id is not null;

alter table screening_v2.transcript_turns
  add column if not exists phase text null,
  add column if not exists interrupted boolean null;

alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_phase
    check (phase in ('opening', 'icebreaker', 'transition', 'roleplay', 'aside', 'roleplay_exit', 'wrapup', 'closing')) not valid;
alter table screening_v2.transcript_turns
  validate constraint chk_transcript_turns_phase;

create or replace function screening_v2.enqueue_r1_assessment()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
  values ('r1.assessment', jsonb_build_object('session_id', new.id),
          'r1.assessment:' || new.id::text, 5)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists enqueue_r1_assessment on screening_v2.call_sessions;
create trigger enqueue_r1_assessment
  after update of status on screening_v2.call_sessions
  for each row
  when (new.interview_round_id is not null and new.status = 'completed'
        and old.status is distinct from 'completed')
  execute function screening_v2.enqueue_r1_assessment();

revoke all on function screening_v2.enqueue_r1_assessment() from public, anon, authenticated;
