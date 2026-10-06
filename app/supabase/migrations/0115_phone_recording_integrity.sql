-- =====================================================================
-- 0115 — Phone recording and call-record integrity (M013 / S02, PR-2).
--
-- FORWARD-ONLY. ONE migration in numbered sections, each filled only by the
-- task that owns it, strictly between its own `-- ==== 0115 §N BEGIN ====` /
-- `END` markers:
--
--   §1  Leg-timing columns (T03). phone_call_attempts gains
--       observed_ended_at, recording_started_at_ms, recording_duration_ms and
--       recording_tail_flushed; call_sessions gains duration_unobserved_legs.
--       Data-only facts the API stamps from `/recording/complete` (T04). They
--       never cause a state transition.
--   §2  room_name stamp (T03). A reconnect leg is bound to the session by
--       0114 C1-d (`session_id = coalesce(session_id, ...)`) but its
--       room_name stayed NULL, so the reconciler skipped it as `no_room` and
--       the leg was only ended by the lease reclaim ~6 min later. A BEFORE
--       INSERT / BEFORE UPDATE OF session_id trigger now fills
--       room_name := 'phone-' || session_id, plus a one-off backfill.
--   §3  Truthful duration (T03). set_phone_session_duration (0076) is
--       re-declared: each answered leg ends at its OBSERVED end when one is
--       known, and a leg whose only end is the lease-reclaim time is excluded
--       and counted in call_sessions.duration_unobserved_legs. If every
--       answered leg is unobserved, duration_sec stays NULL (unknown), never
--       the reclaim span. A guarded, idempotent backfill applies the same
--       rule to completed phone sessions that already carry a reclaimed leg.
--
-- Later S02 tasks APPEND their own sections after §3 (T05: finalize guard and
-- the unobserved_disconnect label; T06: the zero-answer relabel). S01, if it
-- needs a migration, takes 0116 and must not re-declare the functions this
-- file owns.
--
-- Function ownership (checked on origin/main 6fec38a with
-- `grep -lE "function screening_v2\.<fn>\b" migrations/*.sql | tail -1`):
--   set_phone_session_duration ...................... 0076 (lifted here, §3)
--   stamp_phone_attempt_room_name, phone_session_leg_duration ... new (§2/§3)
--
-- Conventions: `$$` bodies; no machine-clock reads in any function body;
-- `set search_path = pg_catalog, screening_v2`; execute revoked from the
-- browser roles; no PII in any log, audit row or returned value.
-- =====================================================================

-- Fail fast rather than queue: §1 adds columns and CHECKs to
-- phone_call_attempts and call_sessions (ACCESS EXCLUSIVE until COMMIT,
-- because `supabase db push` runs this file in one transaction). A long wait
-- to ACQUIRE a lock should fail the deploy (it retries cleanly), not stall
-- live screening. LOCAL: scoped to the migration's transaction (0109/0112/0114
-- precedent). Deploy with the phone lane halted, outside the IST window.
set local lock_timeout = '10s';


-- ==== 0115 §1 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §1a — per-leg timing facts on phone_call_attempts.
--
--   observed_ended_at        the leg end the worker OBSERVED (the SIP
--                            participant leaving), stamped by the API from
--                            `/recording/complete` `leg_ended_at_ms`. NULL
--                            when no observation reached us. Never moved once
--                            set (the API keeps the earliest value).
--   recording_started_at_ms  epoch ms of t = 0 in the leg's recording file,
--                            so the transcript can seek into the right leg.
--   recording_duration_ms    true audio length of the uploaded file (samples
--                            encoded / rate), not a wall-clock span.
--   recording_tail_flushed   true only when the worker's fail-open tail flush
--                            ran and the recorder closed cleanly; NULL/false
--                            on a legacy or fail-open row ("the recording may
--                            end a few seconds before the call did").
--
-- Every CHECK is a sanity bound on the value ALONE or against an immutable
-- column (admitted_at is set once at admission). None relates to a column a
-- later event writes (answered_at, ended_at): a CHECK like that would make an
-- unrelated ledger UPDATE fail on a row whose timing was stamped first.
-- The API (T04) drops an out-of-range value with a log line before writing,
-- so these CHECKs are a backstop, never the place a recording is lost.
-- ─────────────────────────────────────────────────────────────────────
alter table screening_v2.phone_call_attempts
  add column if not exists observed_ended_at       timestamptz,
  add column if not exists recording_started_at_ms bigint,
  add column if not exists recording_duration_ms   integer,
  add column if not exists recording_tail_flushed  boolean;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_observed_ended_at;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_observed_ended_at check (
    observed_ended_at is null
    -- Worker/DB clock skew is tolerated generously: a leg cannot end before
    -- it was admitted, but the worker's clock may run a little behind ours.
    or observed_ended_at >= admitted_at - interval '5 minutes'
  );

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_started_at_ms;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_started_at_ms check (
    recording_started_at_ms is null
    -- 2020-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, in epoch milliseconds:
    -- rejects 0, seconds-instead-of-ms and other unit slips.
    or recording_started_at_ms between 1577836800000 and 4102444800000
  );

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_duration_ms;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_duration_ms check (
    recording_duration_ms is null
    -- Positive (an unknown length is NULL, never 0 — the worker sends None)
    -- and at most one day, the same 86400 s cap 0076 puts on duration_sec.
    or recording_duration_ms between 1 and 86400000
  );

comment on column screening_v2.phone_call_attempts.observed_ended_at is
  '0115: the leg end the worker observed (SIP participant left), from /recording/complete '
  'leg_ended_at_ms. NULL when unobserved. Data only: never causes a state transition, and '
  'the API keeps the earliest value. A reclaimed leg with this NULL has no known end.';
comment on column screening_v2.phone_call_attempts.recording_started_at_ms is
  '0115: epoch ms of t = 0 in this leg''s recording file (worker clock). Used to place '
  'transcript turns on the leg''s audio. Data only.';
comment on column screening_v2.phone_call_attempts.recording_duration_ms is
  '0115: true audio length of this leg''s uploaded recording, in ms (samples encoded / rate). '
  'NULL when unknown; never 0. Data only.';
comment on column screening_v2.phone_call_attempts.recording_tail_flushed is
  '0115: true only when the worker''s tail flush ran and the recorder closed cleanly. '
  'NULL/false means the recording may end a few seconds before the call did. Data only.';

-- ─────────────────────────────────────────────────────────────────────
-- §1b — call_sessions.duration_unobserved_legs.
--
-- How many answered legs §3 EXCLUDED from duration_sec because their only end
-- was the lease-reclaim time. NULL = never computed by the 0115 rule (a
-- session completed before 0115 and untouched by the §3 backfill, or not a
-- phone session); 0 = every answered leg's end was observed or bounded by the
-- session's own end.
-- ─────────────────────────────────────────────────────────────────────
alter table screening_v2.call_sessions
  add column if not exists duration_unobserved_legs smallint;

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_duration_unobserved_legs;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_duration_unobserved_legs check (
    duration_unobserved_legs is null or duration_unobserved_legs >= 0
  );

comment on column screening_v2.call_sessions.duration_unobserved_legs is
  '0115: answered phone legs excluded from duration_sec because their end was never '
  'observed (lease reclaim, no observed_ended_at). NULL = not computed by the 0115 rule. '
  'When > 0, duration_sec is a lower bound, or NULL if no leg end was observed.';
-- ==== 0115 §1 END ====


-- ==== 0115 §2 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §2 — room_name stamp on phone_call_attempts.
--
-- WHY. The reconciler reads `room_name` alone and skips NULL as `no_room`.
-- room_name was written only by start_phone_assessment, and only on the leg
-- that bound the session (0044/0103 `coalesce(room_name, 'phone-' ||
-- p_session_id)`). A RECONNECT leg is bound by 0114 C1-d (`session_id =
-- coalesce(session_id, v_eng.session_id)`), which never set room_name — so a
-- reconnect leg whose candidate hung up was invisible to the reconciler and
-- was ended only by the lease reclaim, ~6 minutes later (9f60523d leg 2).
--
-- The name is the deterministic room every phone dial joins:
-- `phoneRoomName(sessionId)` = `phone-<sessionId>` (API
-- livekit-phone-dial/phone-room.ts), and a reconnect dial adopts the
-- engagement's existing session, hence the same room. The value satisfies
-- chk_phone_call_attempts_room_name (`^[A-Za-z0-9_-]{1,200}$`).
--
-- coalesce semantics: an explicit room_name is never overwritten, exactly as
-- start_phone_assessment does it. A session_id set to NULL leaves room_name
-- as it was (history).
--
-- Triggers on phone_call_attempts after this section: exactly
-- trg_phone_attempt_answered_at (0055, `before insert or update of state,
-- classified_at, answered_at`) and trg_phone_attempt_room_name (here). The
-- backfill below updates room_name ONLY, so it fires neither of them; there
-- is no attempt-immutability trigger to refuse it. The scaffold test pins
-- this pair so a later immutability trigger cannot silently break the
-- backfill's premise.
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.stamp_phone_attempt_room_name()
returns trigger
language plpgsql
set search_path = pg_catalog, screening_v2
as $$
begin
  if new.session_id is not null and new.room_name is null then
    new.room_name := 'phone-' || new.session_id::text;
  end if;
  return new;
end;
$$;

revoke all on function screening_v2.stamp_phone_attempt_room_name()
  from public, anon, authenticated;

drop trigger if exists trg_phone_attempt_room_name
  on screening_v2.phone_call_attempts;
create trigger trg_phone_attempt_room_name
before insert or update of session_id
on screening_v2.phone_call_attempts
for each row execute function screening_v2.stamp_phone_attempt_room_name();

comment on function screening_v2.stamp_phone_attempt_room_name() is
  '0115: fills phone_call_attempts.room_name with the deterministic phone room '
  '(phone-<session_id>) when a leg is bound to a session and has no room name, so the '
  'reconciler can observe reconnect legs. Never overwrites an existing room_name.';

-- Backfill: every bound leg that predates the trigger. Idempotent (a second
-- run matches nothing) and room_name-only (fires no trigger, see above).
update screening_v2.phone_call_attempts
   set room_name = 'phone-' || session_id::text
 where session_id is not null
   and room_name is null;
-- ==== 0115 §2 END ====


-- ==== 0115 §3 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §3a — phone_session_leg_duration: the ONE rule for a phone session's
-- connected time, shared by the trigger (§3b) and the backfill (§3c) so the
-- two can never disagree.
--
-- Per answered leg (answered_at not null and <= the session's end):
--   end = least(coalesce(observed_ended_at, ended_at, session end),
--               session end)
-- which is 0076's `least(coalesce(a.ended_at, new.ended_at), new.ended_at)`
-- with the observed end preferred. A leg contributes greatest(0, end -
-- answered_at), so one skewed leg cannot cancel another.
--
-- A leg is UNOBSERVED, and excluded, when its end came from the lease
-- reclaim and nothing better is known. The reclaim's exact signature
-- (0112 reclaim_phone_attempt_leases, :506-512; 0042/0056/0071 identical):
--   state = 'abandoned', outcome_class NULL, ended_at = the sweep's p_now.
-- abandon_reason NULL separates it from 0083's pre-originate infra defer
-- (`abandon_reason = 'infra_deferred'`, never answered anyway). The leg is
-- unobserved only when that reclaim time is what 0076 would have used, i.e.
-- ended_at <= the session's end: a leg reclaimed AFTER its session already
-- ended is bounded by the session's own end, exactly as before.
--
-- Result: duration_sec = the capped (86400) floor of the observed sum, or
-- NULL when it is not positive — which includes "every answered leg is
-- unobserved" (unknown is NULL, never 0 and never the reclaim span); and
-- unobserved_legs = the count excluded.
--
-- p_session_ended_at is passed in, never read from the clock (policy H-3).
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.phone_session_leg_duration(
  p_session_id       uuid,
  p_session_ended_at timestamptz
)
returns table (duration_sec integer, unobserved_legs integer)
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  with legs as (
    select a.answered_at,
           least(coalesce(a.observed_ended_at, a.ended_at, p_session_ended_at),
                 p_session_ended_at) as leg_end,
           (    a.observed_ended_at is null
            and a.state = 'abandoned'
            and a.outcome_class is null
            and a.abandon_reason is null
            and a.ended_at is not null
            and a.ended_at <= p_session_ended_at) as unobserved
      from screening_v2.phone_call_attempts a
     where a.session_id = p_session_id
       and a.answered_at is not null
       and a.answered_at <= p_session_ended_at
  ),
  totals as (
    select least(
             86400,
             greatest(0, floor(coalesce(sum(
               greatest(0, extract(epoch from (l.leg_end - l.answered_at)))
             ) filter (where not l.unobserved), 0)))
           )::integer as observed_sec,
           (count(*) filter (where l.unobserved))::integer as unobserved_count
      from legs l
  )
  select case when t.observed_sec > 0 then t.observed_sec end,
         t.unobserved_count
    from totals t
$$;

revoke all on function screening_v2.phone_session_leg_duration(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_session_leg_duration(uuid, timestamptz)
  to service_role;

comment on function screening_v2.phone_session_leg_duration(uuid, timestamptz) is
  '0115: connected seconds of a phone session summed over its answered legs, each ending at '
  'its observed end when known; a leg ended only by the lease reclaim is excluded and '
  'counted. duration_sec NULL = unknown. Shared by set_phone_session_duration and the 0115 '
  'backfill. Reads no clock; service-role-only.';

-- ─────────────────────────────────────────────────────────────────────
-- §3b — set_phone_session_duration, re-declared from 0076.
--
-- Unchanged from 0076: it runs from trg_set_phone_session_duration (`before
-- update of status, ended_at ... when new.status = 'completed' and
-- old.status is distinct from new.status`, NOT re-created here), only for a
-- phone session (external_call_id = phone-<uuid>), only on FIRST completion,
-- and it keeps an existing duration_sec. So a later observed_ended_at never
-- recomputes a completed session — that is §3c's job, explicitly.
--
-- Changed: the per-leg rule is §3a's, and duration_unobserved_legs is set
-- alongside (0 when every leg's end is known).
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.set_phone_session_duration()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_duration   integer;
  v_unobserved integer;
begin
  if new.status <> 'completed'
     or old.status = 'completed'
     or new.duration_sec is not null
     or new.ended_at is null
     or new.external_call_id is null
     or new.external_call_id !~ '^phone-[0-9a-fA-F-]{36}$' then
    return new;
  end if;

  select d.duration_sec, d.unobserved_legs
    into v_duration, v_unobserved
    from screening_v2.phone_session_leg_duration(new.id, new.ended_at) d;

  if v_duration > 0 then
    new.duration_sec := v_duration;
  end if;
  new.duration_unobserved_legs := v_unobserved;
  return new;
end;
$$;

revoke all on function screening_v2.set_phone_session_duration()
  from public, anon, authenticated;
grant execute on function screening_v2.set_phone_session_duration()
  to service_role;

comment on function screening_v2.set_phone_session_duration() is
  '0115 (from 0076): on first completion of a phone session, sets duration_sec from '
  'phone_session_leg_duration (observed leg ends preferred; reclaim-only ends excluded and '
  'counted in duration_unobserved_legs; NULL when no end was observed). Preserves an '
  'existing duration_sec; service-role-only.';

-- ─────────────────────────────────────────────────────────────────────
-- §3c — guarded backfill for completed phone sessions with a reclaimed leg.
--
-- The trigger fires only on first completion and keeps an existing value, so
-- history must be corrected explicitly. Scope: completed phone sessions the
-- 0115 rule has never computed (duration_unobserved_legs IS NULL) that have
-- at least one unobserved leg. Everything else keeps its 0076 value, which is
-- what the 0115 rule gives anyway when no leg is unobserved and no
-- observed_ended_at exists yet (every row before this migration).
--
-- Idempotent: a backfilled row has duration_unobserved_legs >= 1, so a second
-- run selects nothing. A terminal call_sessions row accepts this UPDATE:
-- 0006's lifecycle trigger fires only when status changes, the terminal_reason
-- trigger only when terminal_reason changes, and duration_sec/ended_at are
-- documented as mutable metadata on terminal rows (0006 §9/§10). The 0076
-- trigger (update of status, ended_at) and the 0038 finalize trigger (status
-- change or a new egress link) are not fired. updated_at is bumped by 0004's
-- trigger, which is what lets the funnel rollup pick the change up.
--
-- Intended effect (9f60523d shape): 443 s, built from a reclaim span, becomes
-- 75 s with 1 unobserved leg. A session whose ONLY answered leg was reclaimed
-- becomes NULL (unknown). Every duration_sec consumer tolerates NULL: the
-- funnel sums (0090, NULL ignored), the DSAR export passes it through, and the
-- web pages render nothing for a null/zero duration.
-- ─────────────────────────────────────────────────────────────────────
update screening_v2.call_sessions s
   set duration_sec             = t.duration_sec,
       duration_unobserved_legs = t.unobserved_legs
  from (
    select c.id, d.duration_sec, d.unobserved_legs
      from screening_v2.call_sessions c
      cross join lateral screening_v2.phone_session_leg_duration(c.id, c.ended_at) d
     where c.status = 'completed'
       and c.ended_at is not null
       and c.external_call_id ~ '^phone-[0-9a-fA-F-]{36}$'
       and c.duration_unobserved_legs is null
       and d.unobserved_legs > 0
  ) t
 where s.id = t.id;
-- ==== 0115 §3 END ====


notify pgrst, 'reload schema';
