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
-- `greatest`, AND THAT IS HALF THE SAFETY ARGUMENT. `next_eligible_at` is
-- also what holds a candidate imported outside the IST calling window until
-- the window opens (`phone_next_window_open`). Writing `now + grace`
-- unconditionally would drag that candidate forward and dial them at two in
-- the morning. The value only ever moves LATER.
--
-- THE OTHER HALF IS THAT "LATER" IS NOT AUTOMATICALLY SAFE, and adversarial
-- review found two ways it is not:
--
--   * ONLY AN ENGAGEMENT STILL WAITING FOR ITS FIRST DIAL. `eligible` is the
--     state BOTH success paths of `ensure_ashby_phone_engagement` produce
--     (`0057`: `eligible` and `scheduled_next_window` differ only in whether
--     `next_eligible_at` is in the future), so it covers every candidate this
--     feature exists for. Every other state is refused, because for a
--     `reconnecting` engagement the due time lives on `updated_at` and NOT on
--     `next_eligible_at` (`read.ts`: "`updated_at + backoff`, `next_eligible_at`
--     does not carry it"). This function therefore writes NO `updated_at` at
--     all: bumping it on a reconnect would push a candidate who was just cut
--     off another backoff further away, which is the opposite of the point.
--
--   * NEVER PAST THE CLOSE OF THE CALLING WINDOW. At 20:58 IST a 150s push
--     lands at 21:00:30, outside the window — and nothing anywhere
--     re-normalises a `next_eligible_at` that sits past the close, so the
--     candidate waits until 09:00 the NEXT DAY. Trading a 150-second race for
--     a twelve-hour delay is not a trade. In that band the hold is pointless
--     anyway: the plan is snapshotted at the consent gate, 45-105s after the
--     dial, so generation already has its time.

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

  -- STILL WAITING FOR ITS FIRST DIAL, or this does not apply. `dialing` and
  -- `in_call` are already past the point the grace could help; `reconnecting`
  -- is not scheduled by this column at all; a `scheduled` appointment was
  -- booked for a time nobody asked us to move.
  if v_eng.state <> 'eligible' then
    return jsonb_build_object('status', 'engagement_not_waiting',
                              'engagement_state', v_eng.state);
  end if;

  -- ONLY EVER LATER. A candidate held for the next calling window keeps that
  -- time; one due now is pushed by the grace.
  v_next := greatest(coalesce(v_eng.next_eligible_at, p_now), p_now + make_interval(secs => p_grace_seconds));

  if v_next = v_eng.next_eligible_at then
    return jsonb_build_object('status', 'unchanged',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;

  -- NEVER OUT OF THE CALLING WINDOW. Asked through the same predicate the
  -- dialer uses, so the temporary 24/7 overrides (`0064`, `0085`) are honoured
  -- automatically rather than re-derived here.
  if not screening_v2.phone_ist_window_open(v_next) then
    return jsonb_build_object('status', 'window_edge',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;

  -- `state` is untouched, so `enforce_phone_engagement_transition` takes its
  -- same-state early return and no edge is exercised. `updated_at` is
  -- DELIBERATELY NOT WRITTEN — see the header: it is the reconnect due clock,
  -- and this function has no business moving it.
  update screening_v2.phone_engagements
     set next_eligible_at = v_next,
         version          = version + 1
   where id = v_eng.id;

  return jsonb_build_object('status', 'deferred', 'next_eligible_at', v_next,
                            'engagement_state', v_eng.state);
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
