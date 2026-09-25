-- ═══════════════════════════════════════════════════════════════════════
-- 0104 — give generation time to finish before the phone rings
-- ═══════════════════════════════════════════════════════════════════════
--
-- `0103` lets a candidate's own questions replace the two flexible
-- compartments, but only if they exist when the plan is SNAPSHOTTED — and the
-- snapshot happens once, behind the consent gate, with
-- `on conflict (session_id) do nothing`. An engagement binds exactly one
-- session. So a generation that finishes one second late is not late: it is
-- never used for that conversation, silently, and the recruiter sees a screen
-- that looks exactly like a working one.
--
-- THE TWO GENUINELY RACE. From `ensure_ashby_phone_engagement` setting
-- `eligible`, the dialer needs the due loop (≤15s), SIP origination and ring
-- (7s warm, ~32s cold), the opening, the identity turn and consent — call it
-- 45-105s. Generation needs a claim (≤5s), one provider call and the judge —
-- 20-65s typically, and up to 165s if an attempt is retried. Generation
-- usually wins. "Usually" is the problem: losing is invisible and permanent.
--
-- So the enqueue now pushes the engagement's `next_eligible_at` forward by a
-- grace. This is a ONE-TIME PUSH, NOT A WAIT-FOR-READY: a generation that
-- fails, dead-letters or never runs costs the candidate a delay and nothing
-- else — the call happens on the role's own template, exactly as it did
-- before any of this existed.
--
-- `greatest`, AND THAT IS THE WHOLE SAFETY ARGUMENT. `next_eligible_at` is
-- also what holds a candidate imported outside the IST calling window until
-- the window opens (`phone_next_window_open`). Writing `now + grace`
-- unconditionally would drag that candidate forward and dial them at two in
-- the morning. The value only ever moves LATER.

create or replace function screening_v2.defer_phone_dial_for_questions(
  p_engagement_id  uuid,
  p_grace_seconds  integer,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_eng  screening_v2.phone_engagements%rowtype;
  v_next timestamptz;
begin
  if p_engagement_id is null then
    return jsonb_build_object('status', 'unknown_engagement');
  end if;
  -- BOUNDED, and refused rather than clamped when it is not: a caller passing
  -- an hour has misunderstood what this is for, and silently accepting it
  -- would park a candidate nobody could find.
  if p_grace_seconds is null or p_grace_seconds < 0 or p_grace_seconds > 600 then
    return jsonb_build_object('status', 'invalid_grace');
  end if;

  select * into v_eng from screening_v2.phone_engagements
   where id = p_engagement_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_engagement');
  end if;

  -- A terminal engagement is immutable (`0045`'s transition trigger raises on
  -- ANY change), and it will never be dialled again in any case.
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal',
                              'engagement_state', v_eng.state);
  end if;

  -- ONLY EVER LATER. A candidate held for the next calling window keeps that
  -- time; one due now is pushed by the grace.
  v_next := greatest(coalesce(v_eng.next_eligible_at, p_now), p_now + make_interval(secs => p_grace_seconds));

  if v_next = v_eng.next_eligible_at then
    return jsonb_build_object('status', 'unchanged',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;

  -- `state` is untouched, so `enforce_phone_engagement_transition` takes its
  -- same-state early return and no edge is exercised.
  update screening_v2.phone_engagements
     set next_eligible_at = v_next,
         updated_at       = p_now,
         version          = version + 1
   where id = v_eng.id;

  return jsonb_build_object('status', 'deferred', 'next_eligible_at', v_next);
end;
$$;

revoke all on function screening_v2.defer_phone_dial_for_questions(uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.defer_phone_dial_for_questions(uuid, integer, timestamptz)
  to service_role;

comment on function screening_v2.defer_phone_dial_for_questions is
  'Pushes a non-terminal engagement''s next_eligible_at LATER by a bounded '
  'grace, so per-candidate question generation (0103) can finish before the '
  'plan is snapshotted. Never moves the timestamp earlier, so a candidate '
  'held for the next IST calling window keeps that time. Service-role only.';
