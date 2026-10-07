-- =====================================================================
-- 0122 — R1 scorer (PR-5): administration facts, assessment attach, status
-- effects with a cancellable 24 h pending reject, the override monitor, and
-- R1-aware funnel views.
--
-- Additive and backward compatible. R1 tables only, plus two CREATE OR
-- REPLACE VIEW restatements whose column lists are unchanged:
--   * r1_admin_log        gains one trusted worker event type, `session_facts`
--                         (worker-computed communication + fidelity facts).
--   * interview_rounds    gains the status-effect bookkeeping columns.
--   * r1_settings         gains `override_window_reset_at`, stamped by a BEFORE
--                         UPDATE trigger whenever auto-status is switched back
--                         on, so the override monitor only ever judges decisions
--                         resolved since the owner last re-enabled it.
--   * r1_attach_assessment, r1_apply_status_effect,
--     r1_apply_due_pending_rejects, r1_cancel_pending_reject,
--     r1_check_override_rate   security definer, pinned search_path,
--                         service_role only.
--   * v_funnel_candidate  the `asmt` CTE excludes R1 assessments (plan 8.1 M3),
--                         so an R1 score never becomes a candidate's phone
--                         "latest assessment". Every other line is the 0090 text.
--   * v_funnel_hr_state   the `latest_assessment` CTE excludes R1 assessments for
--                         the same reason, so the two views keep agreeing on who
--                         is "scored". Every other line is the 0098 text.
--   * v_funnel_failures   restates the 0091 body plus the `r1.*` DLQ branch.
--                         The phone branches are byte-for-byte the 0091 text.
--
-- Lock order in every capacity/status writer: r1_settings, then the round,
-- then the candidate (admission locks settings, month, round). All five RPCs
-- take the settings row FOR UPDATE first so none of them can deadlock with
-- admission or with each other when the override monitor flips the flag.
-- =====================================================================
set local lock_timeout = '10s';

-- ---------------------------------------------------------------------
-- 1. r1_admin_log: one more trusted worker event type.
-- ---------------------------------------------------------------------
-- 0117 declared the CHECK inline, so Postgres named it r1_admin_log_event_type_check.
alter table screening_v2.r1_admin_log
  drop constraint if exists r1_admin_log_event_type_check;
alter table screening_v2.r1_admin_log
  drop constraint if exists chk_r1_admin_log_event_type;
-- NOT VALID then VALIDATE: the table is R1-only and tiny, and VALIDATE permits
-- normal DML (repo precedent 0008, 0014, 0021, 0044).
alter table screening_v2.r1_admin_log
  add constraint chk_r1_admin_log_event_type check (event_type in (
    'need_revealed', 'family_delivered', 'push_delivered', 'counter_delivered',
    'discount_detected', 'guard_hit', 'time_cue', 'session_facts'
  )) not valid;
alter table screening_v2.r1_admin_log
  validate constraint chk_r1_admin_log_event_type;

-- ---------------------------------------------------------------------
-- 2. interview_rounds: status-effect bookkeeping.
-- ---------------------------------------------------------------------
alter table screening_v2.interview_rounds
  add column if not exists status_write text,
  add column if not exists status_write_assessment_id uuid,
  -- The audit metadata (scorer, rubric, deck-facts and thresholds versions) the pending
  -- reject was opened with, so the write that happens 24 h later carries it too (plan 6.5).
  add column if not exists status_write_audit jsonb,
  add column if not exists pending_reject_cancelled_at timestamptz,
  add column if not exists pending_reject_cancelled_by uuid;

alter table screening_v2.interview_rounds
  drop constraint if exists chk_interview_rounds_status_write;
alter table screening_v2.interview_rounds
  add constraint chk_interview_rounds_status_write check (status_write is null or status_write in (
    'human_review', 'hold_flag', 'flag_off', 'advanced', 'pending_reject', 'rejected',
    'pending_reject_cancelled', 'pending_reject_dropped', 'cas_lost', 'decision_blocked',
    'round_not_final'
  )) not valid;
alter table screening_v2.interview_rounds
  validate constraint chk_interview_rounds_status_write;

create index if not exists idx_interview_rounds_pending_reject
  on screening_v2.interview_rounds(pending_reject_until)
  where status_write = 'pending_reject' and status_written_at is null;
create index if not exists idx_interview_rounds_override_window
  on screening_v2.interview_rounds(status_written_at, pending_reject_cancelled_at)
  where status_write in ('rejected', 'pending_reject_cancelled');

-- ---------------------------------------------------------------------
-- 2b. r1_settings: the override window restarts when the owner re-enables auto-status.
-- ---------------------------------------------------------------------
-- The override monitor switches auto-status off at >10 % over a rolling 20 resolved
-- decisions. While it is off no new decision can resolve (an open window is dropped, a
-- new reject records `flag_off`), so a window that tripped the monitor can never refill.
-- Judging that same window again after the owner reviewed it and switched auto-status
-- back on would re-trip it on the very next status tick, forever. The owner's re-enable
-- is therefore the START of a new window: only decisions resolved after it count.
-- NULL means "no reset yet": the whole history counts.
alter table screening_v2.r1_settings
  add column if not exists override_window_reset_at timestamptz;

create or replace function screening_v2.r1_settings_stamp_override_reset()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.auto_status_enabled and not old.auto_status_enabled then
    new.override_window_reset_at := now();
  end if;
  return new;
end;
$$;

-- CREATE OR REPLACE TRIGGER (Postgres 14+; the stack is 17) keeps the migration re-runnable
-- without a destructive DROP.
create or replace trigger trg_r1_settings_override_reset
  before update on screening_v2.r1_settings
  for each row execute function screening_v2.r1_settings_stamp_override_reset();

-- ---------------------------------------------------------------------
-- 3. r1_attach_assessment: attach the deciding assessment to its round.
-- ---------------------------------------------------------------------
-- The later attempt wins; within one attempt the higher revision wins; an older
-- one answers `superseded_by_newer` and changes nothing. Re-running with the
-- assessment already attached is an idempotent no-op. A valid gated score (or
-- the retake being used up) makes the round final: status `completed`.
--
-- CONTRACT WITH ADMISSION (PR-3, `r1_admit_attempt`). "The later attempt wins" is only safe
-- if attempt 2 can start solely when attempt 1 has no valid gated score (D1: the automatic
-- retake) or HR granted the manual retake. Between attempt 1's completion and its attach
-- (queue poll plus three model runs) the round is still `in_progress` with one attempt
-- counted, so admission MUST refuse a new attempt while the latest counted attempt's session
-- is `completed` but the round holds no `assessment_id` for it. Otherwise attempt 2's score
-- would silently replace a VALID attempt-1 score here. Documented in
-- docs/runbooks/r1-operations.md ("Admission contract").
create or replace function screening_v2.r1_attach_assessment(
  p_round_id uuid,
  p_session_id uuid,
  p_assessment_id uuid,
  p_recommendation text,
  p_overall numeric,
  p_valid boolean,
  p_audit jsonb default '{}'::jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_round screening_v2.interview_rounds%rowtype;
  v_settings_locked boolean;
  v_attempt integer;
  v_revision integer;
  v_cur_attempt integer;
  v_cur_revision integer;
  v_final boolean;
  -- Only a VALID gated score carries a recommendation on the round: a score that failed the
  -- coverage/fidelity gate can never be applied as a status effect, whatever the caller passes.
  v_rec text := case
    when coalesce(p_valid, false) and p_recommendation in ('advance', 'hold', 'reject')
      then p_recommendation
    else null
  end;
  v_audit jsonb := case
    when octet_length(coalesce(p_audit, '{}'::jsonb)::text) <= 2048 then coalesce(p_audit, '{}'::jsonb)
    else jsonb_build_object('audit_input', 'truncated')
  end;
begin
  select true into v_settings_locked from screening_v2.r1_settings where singleton for update;
  if not found then return jsonb_build_object('status', 'settings_missing'); end if;

  select a.attempt_number into v_attempt
    from screening_v2.interview_round_attempts a
   where a.session_id = p_session_id and a.round_id = p_round_id;
  if not found then return jsonb_build_object('status', 'session_not_in_round'); end if;

  select s.revision into v_revision
    from screening_v2.assessments s
   where s.id = p_assessment_id and s.session_id = p_session_id;
  if not found then return jsonb_build_object('status', 'assessment_not_for_session'); end if;

  select * into v_round from screening_v2.interview_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('status', 'round_not_found'); end if;

  if v_round.assessment_id = p_assessment_id then
    return jsonb_build_object('status', 'ok', 'attached', true, 'unchanged', true,
                              'round_status', v_round.status);
  end if;

  if v_round.assessment_id is not null then
    select att.attempt_number, a2.revision into v_cur_attempt, v_cur_revision
      from screening_v2.assessments a2
      left join screening_v2.interview_round_attempts att on att.session_id = a2.session_id
     where a2.id = v_round.assessment_id;
    if v_cur_attempt is not null
       and (v_cur_attempt > v_attempt or (v_cur_attempt = v_attempt and v_cur_revision >= v_revision)) then
      return jsonb_build_object('status', 'superseded_by_newer');
    end if;
  end if;

  -- A new deciding assessment invalidates an unresolved pending reject: the
  -- reject belonged to the assessment it replaces.
  if v_round.status_write = 'pending_reject' and v_round.status_written_at is null then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'candidate_status_changed',
       'candidate', v_round.candidate_id::text, 'failure',
       jsonb_build_object('actor', 'system:r1', 'stage', 'pending_reject_superseded',
                          'round_id', p_round_id, 'assessment_id', v_round.assessment_id,
                          'new_assessment_id', p_assessment_id));
    update screening_v2.interview_rounds
       set status_write = 'pending_reject_dropped'
     where id = p_round_id;
  end if;

  v_final := coalesce(p_valid, false) or v_round.attempts_counted >= v_round.attempts_allowed;
  update screening_v2.interview_rounds
     set assessment_id = p_assessment_id,
         recommendation = v_rec,
         overall = case when p_overall is null then null else least(100, greatest(0, p_overall)) end,
         pending_reject_until = null,
         status = case when v_final and status in ('invited', 'in_progress') then 'completed' else status end,
         version = version + 1,
         updated_at = p_now
   where id = p_round_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'assessment_recorded',
     'assessment', p_assessment_id::text, 'success',
     v_audit || jsonb_build_object(
       'actor', 'system:r1', 'round_id', p_round_id, 'session_id', p_session_id,
       'attempt_number', v_attempt, 'recommendation', coalesce(v_rec, 'human_review'),
       'valid', coalesce(p_valid, false)));

  return jsonb_build_object('status', 'ok', 'attached', true, 'unchanged', false,
                            'final', v_final);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. r1_apply_status_effect: the audited status CAS (plan 6.5).
-- ---------------------------------------------------------------------
-- advance -> `advanced`; reject -> a pending reject for 24 h; hold -> a flag only.
-- The candidate write is a compare-and-set on
-- candidates.status = candidate_status_at_send AND decision_use_blocked_at IS NULL,
-- so a human change made after sending wins. With auto_status_enabled = false
-- (the shipped default) no candidate write ever happens: the outcome is recorded
-- as `flag_off` and is never retro-applied. A round that is not final (`completed`
-- or `expired`), because HR cancelled it or a manual retake re-opened it, records
-- `round_not_final` and writes nothing either.
create or replace function screening_v2.r1_apply_status_effect(
  p_round_id uuid,
  p_assessment_id uuid,
  p_recommendation text,
  p_audit jsonb default '{}'::jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_settings screening_v2.r1_settings%rowtype;
  v_round screening_v2.interview_rounds%rowtype;
  v_cand screening_v2.candidates%rowtype;
  v_rec text := case when p_recommendation in ('advance', 'hold', 'reject') then p_recommendation else null end;
  v_audit jsonb := case
    when octet_length(coalesce(p_audit, '{}'::jsonb)::text) <= 2048 then coalesce(p_audit, '{}'::jsonb)
    else jsonb_build_object('audit_input', 'truncated')
  end;
  v_write text;
  v_written timestamptz;
  v_pending timestamptz;
  v_prior text;
  v_updated integer;
begin
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found then return jsonb_build_object('status', 'settings_missing'); end if;

  select * into v_round from screening_v2.interview_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('status', 'round_not_found'); end if;
  if v_round.assessment_id is distinct from p_assessment_id then
    return jsonb_build_object('status', 'superseded');
  end if;
  if v_round.status_write_assessment_id is not distinct from p_assessment_id then
    return jsonb_build_object('status', 'already_applied', 'status_write', v_round.status_write);
  end if;
  -- The recommendation attach stored on the round (null unless the score was valid) is the
  -- only one that may be applied.
  if v_round.recommendation is distinct from v_rec then
    return jsonb_build_object('status', 'recommendation_mismatch');
  end if;

  if v_rec is null then
    v_write := 'human_review';
  elsif v_rec = 'hold' then
    v_write := 'hold_flag';
  elsif v_round.status not in ('completed', 'expired') then
    -- D1: a candidate status is written only when the round is FINAL. A round HR cancelled
    -- before the scorer attached, or one a manual retake re-opened (`invited`), has been
    -- changed by a human since the session ended: that change wins and nothing is written.
    v_write := 'round_not_final';
  elsif not v_settings.auto_status_enabled then
    v_write := 'flag_off';
  else
    select * into v_cand from screening_v2.candidates where id = v_round.candidate_id for update;
    if not found then
      v_write := 'cas_lost';
    elsif v_cand.decision_use_blocked_at is not null then
      v_write := 'decision_blocked';
    elsif v_round.candidate_status_at_send is null or v_cand.status <> v_round.candidate_status_at_send then
      v_write := 'cas_lost';
    else
      v_prior := v_cand.status;
      if v_rec = 'advance' then
        update screening_v2.candidates
           set status = 'advanced'
         where id = v_cand.id
           and status = v_round.candidate_status_at_send
           and decision_use_blocked_at is null;
        get diagnostics v_updated = row_count;
        if v_updated = 1 then
          v_write := 'advanced';
          v_written := p_now;
          insert into screening_v2.audit_events
            (actor_id, actor_type, action, target_type, target_id, result, metadata)
          values
            ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'candidate_status_changed',
             'candidate', v_cand.id::text, 'success',
             v_audit || jsonb_build_object(
               'actor', 'system:r1', 'stage', 'applied', 'round_id', p_round_id,
               'assessment_id', p_assessment_id, 'prior_status', v_prior,
               'new_status', 'advanced'));
        else
          v_write := 'cas_lost';
        end if;
      else
        -- reject: open the cancellable 24 h window; the candidate is untouched until it closes.
        v_write := 'pending_reject';
        v_pending := p_now + interval '24 hours';
        insert into screening_v2.audit_events
          (actor_id, actor_type, action, target_type, target_id, result, metadata)
        values
          ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'candidate_status_changed',
           'candidate', v_cand.id::text, 'pending',
           v_audit || jsonb_build_object(
             'actor', 'system:r1', 'stage', 'pending_reject_opened', 'round_id', p_round_id,
             'assessment_id', p_assessment_id, 'prior_status', v_prior,
             'new_status', 'rejected', 'pending_until', v_pending));
      end if;
    end if;
  end if;

  update screening_v2.interview_rounds
     set status_write = v_write,
         status_write_assessment_id = p_assessment_id,
         status_written_at = coalesce(v_written, status_written_at),
         pending_reject_until = case when v_write = 'pending_reject' then v_pending else null end,
         -- Kept only while a window is open: the close of the window audits with the same versions.
         status_write_audit = case when v_write = 'pending_reject' then v_audit else null end,
         updated_at = p_now
   where id = p_round_id;

  return jsonb_build_object('status', 'ok', 'status_write', v_write, 'pending_reject_until', v_pending);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. r1_check_override_rate: auto-disable at >10 % over a rolling 20.
-- ---------------------------------------------------------------------
-- An R1 reject decision is RESOLVED when it was executed (`rejected`) or cancelled
-- by HR (`pending_reject_cancelled`). It counts as an OVERRIDE when HR cancelled
-- the pending reject, or when HR later moved an executed reject's candidate off
-- `rejected`. Open pending rejects are not decisions yet. With fewer than 20
-- resolved decisions the denominator is the actual count: an early override is
-- evidence too, and switching auto-status off is the safe direction.
--
-- The window is the latest 20 decisions resolved SINCE the owner last switched
-- auto-status back on (`r1_settings.override_window_reset_at`, stamped by trigger).
-- Without that bound the monitor would judge the window that tripped it again on the
-- next tick and switch auto-status straight back off, because nothing can resolve
-- while it is off. The minimum number of resolved decisions before it may trip (today
-- 1) is an owner decision, deliberately unchanged here.
create or replace function screening_v2.r1_check_override_rate(
  p_now timestamptz default now(),
  p_window integer default 20,
  p_threshold_pct numeric default 10
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_settings screening_v2.r1_settings%rowtype;
  v_n integer;
  v_over integer;
  v_disabled boolean := false;
begin
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found then return jsonb_build_object('status', 'settings_missing'); end if;

  select count(*), count(*) filter (
           where w.status_write = 'pending_reject_cancelled'
              or (w.status_write = 'rejected' and w.candidate_status is distinct from 'rejected'))
    into v_n, v_over
    from (
      select r.status_write, c.status as candidate_status
        from screening_v2.interview_rounds r
        join screening_v2.candidates c on c.id = r.candidate_id
       where r.status_write in ('rejected', 'pending_reject_cancelled')
         and coalesce(r.status_written_at, r.pending_reject_cancelled_at)
               > coalesce(v_settings.override_window_reset_at, '-infinity'::timestamptz)
       order by coalesce(r.status_written_at, r.pending_reject_cancelled_at) desc nulls last, r.id
       limit greatest(1, least(coalesce(p_window, 20), 200))
    ) w;

  if v_settings.auto_status_enabled and v_n > 0 and v_over * 100 > p_threshold_pct * v_n then
    update screening_v2.r1_settings
       set auto_status_enabled = false, updated_by = null, updated_at = p_now
     where singleton;
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'config_changed',
       'r1_settings', 'default', 'success',
       jsonb_build_object('actor', 'system:r1', 'reason', 'override_rate_exceeded',
                          'window', v_n, 'overrides', v_over,
                          'threshold_pct', p_threshold_pct));
    v_disabled := true;
  end if;

  return jsonb_build_object('status', 'ok', 'window', v_n, 'overrides', v_over, 'disabled', v_disabled);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. r1_apply_due_pending_rejects: close due 24 h windows.
-- ---------------------------------------------------------------------
-- A window that closes while auto-status is OFF (the owner or the override
-- monitor switched it off), that is overdue by more than an hour (`window_stale`:
-- the loop did not run), whose round is no longer final (a manual retake or a
-- cancel), or whose candidate was changed by a human, is DROPPED, never executed:
-- the candidate stays as HR left it.
create or replace function screening_v2.r1_apply_due_pending_rejects(
  p_now timestamptz default now(),
  p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_settings screening_v2.r1_settings%rowtype;
  v_round screening_v2.interview_rounds%rowtype;
  v_cand screening_v2.candidates%rowtype;
  v_ids uuid[];
  v_id uuid;
  v_applied integer := 0;
  v_updated integer;
  v_drop text;
  v_cand_found boolean;
  v_audit jsonb;
begin
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found then return 0; end if;

  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
    from (
      select r.id
        from screening_v2.interview_rounds r
       where r.status_write = 'pending_reject'
         and r.status_written_at is null
         and r.pending_reject_until <= p_now
       order by r.pending_reject_until, r.id
       limit greatest(1, least(coalesce(p_limit, 50), 500))
    ) x;

  foreach v_id in array v_ids loop
    select * into v_round from screening_v2.interview_rounds where id = v_id for update;
    if not found or v_round.status_write is distinct from 'pending_reject'
       or v_round.status_written_at is not null then
      continue;
    end if;
    v_drop := null;
    select * into v_cand from screening_v2.candidates where id = v_round.candidate_id for update;
    v_cand_found := found;
    -- The versions the window was opened with ride along on every audit row written here.
    v_audit := coalesce(v_round.status_write_audit, '{}'::jsonb);
    if not v_settings.auto_status_enabled then
      v_drop := 'auto_status_off';
    elsif v_round.pending_reject_until < p_now - interval '1 hour' then
      -- Overdue by more than the grace period: the status loop did not run while R1 was
      -- switched off (or the API was down). The window HR saw closed long ago, so the
      -- reject is not executed late; a human decides.
      v_drop := 'window_stale';
    elsif v_round.status not in ('completed', 'expired') then
      -- A manual retake re-opened the round (or HR cancelled it) after the window opened.
      v_drop := 'round_not_final';
    elsif not v_cand_found then
      v_drop := 'candidate_missing';
    elsif v_cand.decision_use_blocked_at is not null then
      v_drop := 'decision_blocked';
    elsif v_round.candidate_status_at_send is null or v_cand.status <> v_round.candidate_status_at_send then
      v_drop := 'status_changed_by_human';
    end if;

    if v_drop is not null then
      update screening_v2.interview_rounds
         set status_write = 'pending_reject_dropped', pending_reject_until = null, updated_at = p_now
       where id = v_id;
      insert into screening_v2.audit_events
        (actor_id, actor_type, action, target_type, target_id, result, metadata)
      values
        ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'candidate_status_changed',
         'candidate', v_round.candidate_id::text, 'failure',
         v_audit || jsonb_build_object(
           'actor', 'system:r1', 'stage', 'pending_reject_dropped',
           'reason', v_drop, 'round_id', v_id,
           'assessment_id', v_round.assessment_id));
      continue;
    end if;

    update screening_v2.candidates
       set status = 'rejected'
     where id = v_cand.id
       and status = v_round.candidate_status_at_send
       and decision_use_blocked_at is null;
    get diagnostics v_updated = row_count;
    if v_updated = 1 then
      update screening_v2.interview_rounds
         set status_write = 'rejected', status_written_at = p_now, updated_at = p_now
       where id = v_id;
      insert into screening_v2.audit_events
        (actor_id, actor_type, action, target_type, target_id, result, metadata)
      values
        ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'candidate_status_changed',
         'candidate', v_cand.id::text, 'success',
         v_audit || jsonb_build_object(
           'actor', 'system:r1', 'stage', 'applied', 'round_id', v_id,
           'assessment_id', v_round.assessment_id,
           'prior_status', v_round.candidate_status_at_send,
           'new_status', 'rejected'));
      v_applied := v_applied + 1;
    else
      -- Defence in depth: the row lock above makes this unreachable today, but a lost
      -- compare-and-set must never vanish silently.
      update screening_v2.interview_rounds
         set status_write = 'pending_reject_dropped', pending_reject_until = null, updated_at = p_now
       where id = v_id;
      insert into screening_v2.audit_events
        (actor_id, actor_type, action, target_type, target_id, result, metadata)
      values
        ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'candidate_status_changed',
         'candidate', v_cand.id::text, 'failure',
         v_audit || jsonb_build_object(
           'actor', 'system:r1', 'stage', 'pending_reject_dropped',
           'reason', 'cas_lost', 'round_id', v_id,
           'assessment_id', v_round.assessment_id));
    end if;
  end loop;

  perform screening_v2.r1_check_override_rate(p_now);
  return v_applied;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. r1_cancel_pending_reject: HR cancels the 24 h window.
-- ---------------------------------------------------------------------
create or replace function screening_v2.r1_cancel_pending_reject(
  p_round_id uuid,
  p_actor uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_settings screening_v2.r1_settings%rowtype;
  v_round screening_v2.interview_rounds%rowtype;
begin
  if p_actor is null then return jsonb_build_object('status', 'actor_required'); end if;
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found then return jsonb_build_object('status', 'settings_missing'); end if;

  select * into v_round from screening_v2.interview_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('status', 'round_not_found'); end if;
  if v_round.status_write is distinct from 'pending_reject' or v_round.status_written_at is not null then
    return jsonb_build_object('status', 'not_pending');
  end if;

  update screening_v2.interview_rounds
     set status_write = 'pending_reject_cancelled',
         pending_reject_until = null,
         pending_reject_cancelled_at = p_now,
         pending_reject_cancelled_by = p_actor,
         updated_at = p_now
   where id = p_round_id;
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor, 'recruiter', 'candidate_status_changed', 'candidate', v_round.candidate_id::text,
     'success',
     jsonb_build_object('stage', 'pending_reject_cancelled', 'round_id', p_round_id,
                        'assessment_id', v_round.assessment_id));

  return jsonb_build_object('status', 'ok', 'override',
                            screening_v2.r1_check_override_rate(p_now));
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Funnel views: R1 is excluded from "latest assessment" and its DLQ rows are
--    visible. Both are CREATE OR REPLACE with unchanged column lists.
-- ---------------------------------------------------------------------
create or replace view screening_v2.v_funnel_candidate
  with (security_invoker = true) as
  with att as (
    select e.candidate_id,
           count(a.*)                                             as attempts_total,
           count(*) filter (where a.answered_at is not null)      as connects_total,
           min(a.admitted_at)                                     as first_attempt_at,
           max(a.admitted_at)                                     as last_attempt_at,
           min(a.answered_at)                                     as first_connect_at
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
    group by e.candidate_id
  ),
  att_last as (
    select distinct on (e.candidate_id) e.candidate_id, a.outcome_class
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
    order by e.candidate_id, a.admitted_at desc, a.id desc
  ),
  eng as (
    select candidate_id,
           bool_or(state in ('opted_out','wrong_number')) as any_engagement_consent_drop
    from screening_v2.phone_engagements
    group by candidate_id
  ),
  psess as (
    select c.id as session_id, c.candidate_id, c.duration_sec, c.terminal_reason
    from screening_v2.call_sessions c
    where exists (
      select 1 from screening_v2.phone_call_attempts a where a.session_id = c.id
    )
  ),
  sess as (
    select candidate_id,
           count(*)                                                          as phone_sessions_total,
           coalesce(sum(duration_sec), 0)                                    as total_call_seconds,
           bool_or(terminal_reason in ('candidate_opt_out','wrong_number'))  as any_session_consent_drop
    from psess
    group by candidate_id
  ),
  consent as (
    select p.candidate_id, true as consent_passed
    from psess p
    join screening_v2.phone_session_plans pl on pl.session_id = p.session_id
    group by p.candidate_id
  ),
  qa as (
    select p.candidate_id,
           count(*) filter (
             where pr.disposition in ('asked_answered','volunteered_with_evidence')
           ) as answered_questions
    from psess p
    join screening_v2.phone_session_progress pr on pr.session_id = p.session_id
    group by p.candidate_id
  ),
  asmt as (
    -- 0122 (R1 PR-5): an R1 interview round's assessment is never a candidate's
    -- "latest assessment" in this phone-funnel view; R1 has its own surface.
    select distinct on (a.candidate_id)
           a.candidate_id, a.recommendation, a.scoring_status, a.overall_score,
           a.weighted_score_5, a.partial
    from screening_v2.assessments a
    where not exists (
      select 1 from screening_v2.call_sessions rs
      where rs.id = a.session_id and rs.interview_round_id is not null
    )
    order by a.candidate_id, a.created_at desc, a.id desc
  ),
  refchk as (
    select l.candidate_id,
           bool_or(
             jm.reference_check_stage_id is not null
             and l.external_stage_id = jm.reference_check_stage_id
           ) as reached_reference_check
    from screening_v2.ashby_application_links l
    join screening_v2.ashby_job_mappings jm on jm.id = l.job_mapping_id
    where l.candidate_id is not null
    group by l.candidate_id
  ),
  base as (
    select
      c.id                                              as candidate_id,
      c.role_id                                         as role_id,
      r.title                                           as role_title,
      screening_v2.funnel_role_class(
        coalesce(c.parsed->>'current_role', c.parsed->>'title', r.title)
      )                                                 as resume_role_class,
      c.created_at                                      as intake_at,
      (c.created_at)::date                              as cohort_day,
      (c.phone_valid is not true)                       as missing_phone,
      coalesce(att.attempts_total, 0)                   as attempts_total,
      coalesce(att.connects_total, 0)                   as connects_total,
      att.first_attempt_at,
      att.last_attempt_at,
      att.first_connect_at,
      case
        when att.first_attempt_at is not null and att.first_connect_at is not null
        then extract(epoch from (att.first_connect_at - att.first_attempt_at))::numeric
      end                                               as time_to_first_connect_sec,
      att_last.outcome_class                            as latest_outcome_class,
      (coalesce(att.attempts_total, 0) > 0)             as dialed,
      (coalesce(att.connects_total, 0) > 0)             as connected,
      coalesce(consent.consent_passed, false)           as consent_passed,
      (coalesce(eng.any_engagement_consent_drop, false)
        or coalesce(sess.any_session_consent_drop, false)) as consent_dropped,
      coalesce(sess.total_call_seconds, 0)              as total_call_seconds,
      coalesce(qa.answered_questions, 0)                as answered_questions,
      (coalesce(qa.answered_questions, 0) >= 1)         as answered_ge1,
      asmt.recommendation,
      asmt.scoring_status,
      asmt.overall_score,
      asmt.weighted_score_5,
      coalesce(asmt.partial, false)                     as assessment_partial,
      (asmt.candidate_id is not null)                   as scored,
      (asmt.recommendation = 'advance')                 as qualified,
      (asmt.recommendation = 'reject')                  as disqualified,
      (asmt.recommendation = 'hold')                    as on_hold,
      (asmt.candidate_id is not null and asmt.recommendation is null) as human_review,
      coalesce(refchk.reached_reference_check, false)   as reached_reference_check
    from screening_v2.candidates c
    left join screening_v2.roles r        on r.id = c.role_id
    left join att        on att.candidate_id = c.id
    left join att_last   on att_last.candidate_id = c.id
    left join eng        on eng.candidate_id = c.id
    left join sess       on sess.candidate_id = c.id
    left join consent    on consent.candidate_id = c.id
    left join qa         on qa.candidate_id = c.id
    left join asmt       on asmt.candidate_id = c.id
    left join refchk     on refchk.candidate_id = c.id
  )
  select
    base.*,
    case
      when base.reached_reference_check then 'reference_check'
      when base.qualified              then 'qualified'
      when base.scored                 then 'scored'
      when base.answered_ge1           then 'answered'
      when base.consent_passed         then 'consent_passed'
      when base.connected              then 'connected'
      when base.dialed                 then 'dialed'
      else 'parsed'
    end as furthest_stage,
    case
      when base.reached_reference_check then null
      -- Advanced/qualified is a SUCCESS terminus, not a drop. It MUST be
      -- peeled before the failure/consent branches: reached_reference_check is
      -- an unwired placeholder (always false today), so without this a
      -- qualified candidate would fall through to 'scored'/'consent_dropped'
      -- and be mislabeled as a drop. drop_reason is null for anyone who has
      -- not fallen out of the funnel.
      when base.qualified               then null
      when base.disqualified            then 'scorecard_reject'
      when base.human_review            then 'human_review'
      when base.on_hold                 then 'scorecard_hold'
      when base.consent_dropped         then 'consent_dropped'
      -- Scored but not advance/reject/hold/human_review: unreachable under the
      -- current recommendation vocabulary (advance|hold|reject|null), kept as an
      -- honest catch-all for a future recommendation value — never a false
      -- "not advanced" label for the qualified cohort.
      when base.scored                  then 'scored_other'
      when base.connected and not base.consent_passed then 'dropped_pre_consent'
      when base.connected and not base.answered_ge1    then 'no_answers'
      when base.dialed and not base.connected          then coalesce(base.latest_outcome_class, 'not_connected')
      when not base.dialed                             then 'not_dialed'
      else 'in_progress'
    end as drop_reason
  from base;

comment on view screening_v2.v_funnel_candidate is
  'One row per candidate across the whole funnel (parse -> dial -> connect -> '
  'consent -> Q&A -> scorecard -> reference check), with furthest_stage and a '
  'single consolidated drop_reason. Derived live from the operational tables — '
  'the source of truth for per-candidate drill-down. Counts/flags only, no PII.';

revoke all on screening_v2.v_funnel_candidate from anon, authenticated, public;
grant select on screening_v2.v_funnel_candidate to service_role;

-- ---------------------------------------------------------------------
-- 8b. v_funnel_hr_state: R1 is excluded from "latest assessment" here too.
-- ---------------------------------------------------------------------
-- 0098 documents that this view's `latest_assessment` agrees with v_funnel_candidate's
-- `scored`. With R1 excluded from the latter (above) an R1-only candidate would otherwise
-- still get an hr_state while not being `scored`. CREATE OR REPLACE with an unchanged
-- column list; every other line is the 0098 text.
create or replace view screening_v2.v_funnel_hr_state
with (security_invoker = true) as
with latest_assessment as (
  -- One row per candidate: the newest assessment, matching how
  -- v_funnel_candidate picks `scored`/`qualified` so the two agree.
  -- 0122 (R1 PR-5): an R1 interview round's assessment is never counted here, exactly as
  -- v_funnel_candidate's `asmt` CTE excludes it, so both views keep agreeing on "scored".
  select distinct on (a.candidate_id)
         a.candidate_id
    from screening_v2.assessments a
   where not exists (
     select 1 from screening_v2.call_sessions rs
      where rs.id = a.session_id and rs.interview_round_id is not null
   )
   order by a.candidate_id, a.created_at desc, a.id desc
),
stage as (
  -- A candidate may hold links on several jobs. Precedence is
  -- qualified > awaiting > disqualified: being at Reference Check anywhere is
  -- the strongest signal, and still sitting in the screening stage anywhere
  -- means there is still HR work outstanding.
  --
  -- `observable` is what makes `disqualified` safe to infer. It is true only
  -- when this candidate has a link whose CURRENT stage is actually known AND
  -- whose mapping has the two stage ids wired. Without it, "not at either
  -- mapped stage" is indistinguishable from "we cannot see where they are",
  -- and the difference is the whole point of this migration.
  select l.candidate_id,
         -- Each clause carries its OWN `stage_synced_at`, per link. A candidate
         -- may hold one synced link and one that has never been looked at;
         -- reading a stage off the second because the first made the candidate
         -- "observable" would be the same unproven inference in a new place.
         bool_or(l.stage_synced_at is not null
                 and jm.reference_check_stage_id is not null
                 and l.external_stage_id = jm.reference_check_stage_id) as at_reference_check,
         bool_or(l.stage_synced_at is not null
                 and jm.ai_screening_stage_id is not null
                 and l.external_stage_id = jm.ai_screening_stage_id)    as at_ai_screening,
         -- `stage_synced_at is not null` is the load-bearing clause. Without
         -- it, `external_stage_id` is the import-time constant and "not at
         -- either mapped stage" means "we have never looked", not "a human
         -- moved them". See section 0.
         bool_or(l.stage_synced_at is not null
                 and l.external_stage_id is not null
                 and jm.ai_screening_stage_id is not null
                 and jm.reference_check_stage_id is not null)           as observable
    from screening_v2.ashby_application_links l
    join screening_v2.ashby_job_mappings jm on jm.id = l.job_mapping_id
   where l.candidate_id is not null
   group by l.candidate_id
)
select c.id                     as candidate_id,
       c.role_id                as role_id,
       (c.created_at)::date     as cohort_day,
       case
         -- No assessment ⇒ the bot has not decided ⇒ HR owes nothing yet.
         when la.candidate_id is null                then null
         -- UNOBSERVABLE FIRST, and it gates all three real states — not just
         -- `disqualified`. If we have never confirmed this candidate's stage
         -- since import, then "still in AI screening" is exactly as unproven as
         -- "moved elsewhere": both are readings of a column that has not been
         -- updated. Reporting `awaiting` here would claim an HR backlog that may
         -- be an HR decision taken weeks ago.
         when not coalesce(st.observable, false)     then 'unknown'
         when coalesce(st.at_reference_check, false) then 'qualified'
         when coalesce(st.at_ai_screening, false)    then 'awaiting'
         -- Reached only when the stage IS observed and is neither mapped one,
         -- which is the single case where "somewhere else" means "a human moved
         -- them". An `else 'disqualified'` above the guard would absorb: a
         -- candidate with no Ashby link at all (every recruiter-uploaded
         -- résumé), a link whose stage has never been confirmed since import
         -- (today: all of them), and every job whose mapping still has a NULL
         -- reference_check/ai_screening stage id — reporting each as an HR
         -- rejection. That is precisely the artefact this migration exists to
         -- remove, so the inference is gated on proof, twice.
         else 'disqualified'
       end                      as hr_state
  from screening_v2.candidates c
  left join latest_assessment la on la.candidate_id = c.id
  left join stage st            on st.candidate_id = c.id;

comment on view screening_v2.v_funnel_hr_state is
  'Per-candidate HR disposition (qualified | awaiting | disqualified | unknown '
  '| null). `unknown` covers a candidate whose Ashby stage cannot be observed '
  '— no link, an unsynced stage, or a mapping missing its stage ids — so an '
  'unconfigured tenant never reads as a wall of HR rejections. '
  'derived from the CURRENT Ashby stage on the application link versus the job '
  'mapping''s reference_check/ai_screening stage ids. `awaiting` exists so an '
  'unopened candidate is never counted as an HR rejection. Null until the bot '
  'has produced an assessment. Current-stage only: no stage history exists, so '
  'a candidate promoted beyond Reference Check stops counting as qualified.';

revoke all on screening_v2.v_funnel_hr_state from anon, authenticated, public;
grant select on screening_v2.v_funnel_hr_state to service_role;

create or replace view screening_v2.v_funnel_failures
  with (security_invoker = true) as
  select 'resume_parse'::text as stage,
         case when i.failed_reason ~ '^[a-z0-9_.:-]{1,64}$' then i.failed_reason else 'other' end as code,
         i.id::text as entity_id, i.updated_at as occurred_at
  from screening_v2.ashby_resume_ingestions i
  where i.state = 'failed_review' and i.failed_reason is not null
  union all
  select 'resume_parse'::text, f.failed_reason, f.id::text, f.occurred_at
  from screening_v2.resume_intake_failures f
  union all
  select 'dial'::text, a.outcome_class, a.id::text, coalesce(a.ended_at, a.admitted_at)
  from screening_v2.phone_call_attempts a
  where a.outcome_class in ('provider_error', 'wrong_number')
  union all
  select 'recording'::text, 'egress_failed'::text, a.id::text, coalesce(a.ended_at, a.admitted_at)
  from screening_v2.phone_call_attempts a
  where a.egress_status = 'failed'
  union all
  select 'call'::text, c.terminal_reason, c.id::text, coalesce(c.ended_at, c.started_at)
  from screening_v2.call_sessions c
  where c.status = 'failed' and c.terminal_reason is not null
  union all
  -- SOFT scoring failure: a screening that produced NO usable numeric verdict —
  -- NOT ONE metric could be scored (weighted_score_5 IS NULL => human review). A
  -- PARTIAL row that renormalized to a provisional score is NOT a drop (the
  -- recruiter got a card), so it is deliberately excluded; only true voids count.
  -- Post-recovery, historical partials fall OUT of this surface — the fix shows up
  -- in the funnel as fewer scoring failures.
  select 'scoring'::text, 'incomplete_evidence'::text, a2.id::text, a2.created_at
  from screening_v2.assessments a2
  where a2.scoring_status = 'incomplete_evidence' and a2.weighted_score_5 is null
  union all
  -- HARD scoring failure: a phone-assessment job that exhausted its retries into
  -- the DLQ (the scorecard genuinely could not be produced — Modes A–D in the
  -- RCA: DeepSeek timeout/4xx-5xx, breaker open, malformed JSON, session not
  -- terminal). job_dlq.name is the queue name; error_message is a sanitized code.
  select 'scoring'::text,
         case when d.error_message ~ '^[a-z0-9_.:-]{1,64}$' then d.error_message else 'scoring_failed' end,
         d.id::text, d.failed_at
  from screening_v2.job_dlq d
  where d.name like 'phone.assessment%'
  union all
  -- 0122 (R1 PR-5): R1 queue failures that exhausted their retries into the DLQ.
  -- `r1.assessment` is a scoring failure, `r1.recording.*` a recording failure and
  -- anything else under `r1.` a call-lifecycle failure. The code keeps its own `r1:`
  -- prefix, so an R1 failure can never be mistaken for (or merged into) a phone code.
  -- Phone rows above are untouched.
  select case
           when d.name = 'r1.assessment' then 'scoring'
           when d.name like 'r1.recording.%' then 'recording'
           else 'call'
         end::text,
         case when d.error_message ~ '^[a-z0-9_.:-]{1,61}$' then 'r1:' || d.error_message else 'r1:failed' end,
         d.id::text, d.failed_at
  from screening_v2.job_dlq d
  where d.name like 'r1.%';

comment on view screening_v2.v_funnel_failures is
  'Unified failure taxonomy {stage, code, entity_id, occurred_at} across resume '
  'parse (ingestion + sync-upload), dial (provider_error/wrong_number), recording '
  '(egress_failed), call (failed-family terminal_reason), and scoring — both the '
  'soft incomplete_evidence (a row exists, provisionally scored) and the HARD '
  'DLQ failures where no assessment row was produced. The one surface to watch '
  'for any stage failing, including R1 (`r1.*`) queue failures, which carry an `r1:` '
  'code prefix. All codes are sanitized; safe to aggregate directly.';

revoke all on screening_v2.v_funnel_failures from anon, authenticated, public;
grant select on screening_v2.v_funnel_failures to service_role;

-- ---------------------------------------------------------------------
-- 9. Privileges: service_role only; no caller path can reach a status effect.
-- ---------------------------------------------------------------------
revoke all on function
  screening_v2.r1_attach_assessment(uuid, uuid, uuid, text, numeric, boolean, jsonb, timestamptz),
  screening_v2.r1_apply_status_effect(uuid, uuid, text, jsonb, timestamptz),
  screening_v2.r1_check_override_rate(timestamptz, integer, numeric),
  screening_v2.r1_apply_due_pending_rejects(timestamptz, integer),
  screening_v2.r1_cancel_pending_reject(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function
  screening_v2.r1_attach_assessment(uuid, uuid, uuid, text, numeric, boolean, jsonb, timestamptz),
  screening_v2.r1_apply_status_effect(uuid, uuid, text, jsonb, timestamptz),
  screening_v2.r1_check_override_rate(timestamptz, integer, numeric),
  screening_v2.r1_apply_due_pending_rejects(timestamptz, integer),
  screening_v2.r1_cancel_pending_reject(uuid, uuid, timestamptz)
  to service_role;

-- The trigger function is never called directly; like 0115's audit trigger it is closed to every role.
revoke all on function screening_v2.r1_settings_stamp_override_reset()
  from public, anon, authenticated;
