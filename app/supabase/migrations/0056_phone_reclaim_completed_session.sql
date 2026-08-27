-- 0056 — do not resurrect an already-completed phone screening on lease loss.
--
-- If the worker times out after session completion and phone assessment scoring
-- has succeeded, the attempt lease can lapse before the worker posts the final
-- event. The old reclaimer restored the engagement to its pre-dial state,
-- making a completed screening eligible for another call. This replacement
-- posts the existing audited assessment.completed event and remains idempotent.

create or replace function screening_v2.reclaim_phone_attempt_leases(
  p_limit integer     default 50,
  p_now   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row      record;
  v_att      screening_v2.phone_call_attempts%rowtype;
  v_eng_id   uuid;
  v_restored integer;
  v_jobs     integer;
  v_count    integer := 0;
  v_limit   constant integer := greatest(1, least(coalesce(p_limit, 50), 500));
begin
  -- ── LOCK ORDER ─────────────────────────────────────────────────────
  -- ENGAGEMENT FIRST, then the attempt — a strict SUFFIX of the pinned
  -- admission order (advisory -> link -> engagement -> attempt). A
  -- transaction that takes a suffix of a global order can never close a
  -- cycle with one taking the whole order, so no advisory lock is needed
  -- here and the sweeper never serialises against dialing.
  --
  -- The naive shape — `select ... from phone_call_attempts ... for
  -- update skip locked` and only THEN touch the engagement — inverts
  -- that order and IS a real cycle: a sweeper holding an expired attempt
  -- of engagement E waits for E, while an admission holding E waits on
  -- that same attempt's uq_phone_attempts_one_live index entry. It needs
  -- only an engagement sitting in `reconnecting` with a live attempt, and
  -- it would surface as a 40P01 in production rather than in a test.
  --
  -- The candidate scan below is therefore UNLOCKED, and every row it
  -- proposes is RE-VERIFIED under the locks before anything is written.
  for v_row in
    select id, engagement_id
      from screening_v2.phone_call_attempts
     where state in ('admitted','ringing','answered_unclassified','human','machine')
       and lease_expires_at is not null
       and lease_expires_at <= p_now
     order by lease_expires_at asc
     limit v_limit
  loop
    select id into v_eng_id
      from screening_v2.phone_engagements
     where id = v_row.engagement_id
     for update skip locked;
    -- Somebody else holds this engagement: leave it for the next pass
    -- rather than queueing behind it. A sweeper must never be the thing
    -- that blocks a dial.
    if not found then
      continue;
    end if;

    select * into v_att
      from screening_v2.phone_call_attempts
     where id = v_row.id
       and state in ('admitted','ringing','answered_unclassified','human','machine')
       and lease_expires_at is not null
       and lease_expires_at <= p_now
     for update skip locked;
    -- Re-verified under the lock: the unlocked scan above may have seen
    -- a row that a heartbeat has since renewed, or that a worker has
    -- since ended. Either way it is no longer ours to reclaim.
    if not found then
      continue;
    end if;

    update screening_v2.phone_call_attempts
       set state         = 'abandoned',
           outcome_class = null,
           lease_token   = null,
           lease_owner   = null,
           ended_at      = p_now
     where id = v_att.id;

    -- Resolve the dial job this attempt owned, in the SAME transaction.
    -- Leaving it claimable would hand a worker a job whose attempt is
    -- not live; the handler contract (stated in the file header) makes
    -- that a no-op completion, but a queue row that outlives its work is
    -- still noise an operator has to explain. `active` is deliberately
    -- excluded: a claimed job belongs to the worker holding it, and
    -- completing it under that worker would be the lease violation this
    -- sweeper exists to avoid.
    update screening_v2.job_queue
       set status       = 'completed',
           completed_at = p_now
     where name = 'phone.dial'
       and dedup_key = 'phone.dial:' || v_att.id::text
       and status in ('pending', 'delayed');
    get diagnostics v_jobs = row_count;

    -- A worker can lose its lease AFTER the session has already completed
    -- and scoring has already inserted the phone assessment. In that race,
    -- restoring `in_call` to the prior eligible state creates a redialable
    -- engagement for a screening that is already complete. Let the same
    -- audited terminal event used by the worker win instead.
    if exists (
      select 1
        from screening_v2.call_sessions s
       where s.id = v_att.session_id
         and s.status = 'completed'
         and exists (
           select 1 from screening_v2.assessments a
            where a.session_id = s.id and a.source = 'phone'
         )
    ) then
      perform screening_v2.apply_phone_event(
        p_source            => 'internal',
        p_event_type        => 'assessment.completed',
        p_attempt_id        => null,
        p_engagement_id     => v_att.engagement_id,
        p_provider_event_id => 'reclaim:assessment.completed:' || v_att.session_id::text,
        p_epoch             => null,
        p_metadata          => null,
        p_now               => p_now
      );
      v_restored := 0;
    else
      -- Back to the state this attempt was admitted FROM, so a reclaimed
      -- reconnect returns to `reconnecting` rather than silently becoming
      -- a fresh daily attempt. Terminal engagements are left alone: a
      -- terminal row is immutable and a reclaim is not an event that may
      -- resurrect it. The per-IST-day index still applies to the restored
      -- non-terminal state.
      update screening_v2.phone_engagements
         set state        = v_att.prior_engagement_state,
             state_reason = 'lease_reclaimed',
             version      = version + 1,
             updated_at   = p_now
       where id = v_att.engagement_id
         and terminal_at is null
         and state in ('dialing', 'in_call');
      get diagnostics v_restored = row_count;
    end if;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_attempt_ended', 'phone_call_attempt', v_att.id::text, 'success',
       -- `restored` is read from the UPDATE's own row count, not
       -- assumed: a terminal engagement is deliberately left alone, and
       -- an audit row that claimed a restoration that never happened
       -- would send an operator looking in the wrong place.
       jsonb_build_object('engagement_id', v_att.engagement_id,
                          'attempt_seq', v_att.attempt_seq,
                          'attempt_state', 'abandoned',
                          'reason', 'lease_reclaimed',
                          'budget_charged', false,
                          'restored', v_restored > 0,
                          'restored_state',
                          case when v_restored > 0
                               then v_att.prior_engagement_state else null end,
                          'dial_jobs_completed', v_jobs));

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('status', 'ok', 'reclaimed', v_count, 'limit', v_limit);
end;
$$;

revoke all on function screening_v2.reclaim_phone_attempt_leases(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reclaim_phone_attempt_leases(integer, timestamptz)
  to service_role;

comment on function screening_v2.reclaim_phone_attempt_leases is
  'Bounded sweeper for expired phone leases. A completed and phone-scored '
  'session is terminalized through assessment.completed instead of restoring '
  'the engagement to a redialable state; other expired attempts restore their '
  'prior non-terminal state. Charges no budget for the lease-loss repair.';
