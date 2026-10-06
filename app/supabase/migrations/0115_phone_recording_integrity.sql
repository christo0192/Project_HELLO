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
--   §4  Finalize guard and truthful disconnect label (T05).
--       finalize_phone_partial_sessions (0114) is lifted in full: it no
--       longer completes and scores a session while a reconnect is pending
--       (engagement reconnecting/dialing, or a newer live leg), for at most
--       30 minutes after the latest bound leg ended; and a reclaimed leg that
--       shows teardown evidence is labelled `unobserved_disconnect`, not
--       `worker_crash`.
--
-- Later S02 tasks APPEND their own sections after §4 (T06: the zero-answer
-- relabel). S01, if it needs a migration, takes 0116 and must not re-declare
-- the functions this file owns.
--
-- Function ownership (checked on origin/main 6fec38a with
-- `grep -lE "function screening_v2\.<fn>\b" migrations/*.sql | tail -1`):
--   set_phone_session_duration ...................... 0076 (lifted here, §3)
--   finalize_phone_partial_sessions ................. 0114 (lifted here, §4)
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


-- ==== 0115 §4 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §4 — finalize_phone_partial_sessions: the reconnect guard and the
-- truthful disconnect label (T05, S02-4). Lifted IN FULL from 0114 §3 (the
-- newest declaration: 0113's E4 callback flag and 0114's C2/C7 hunks live
-- there). Every 0114 line is kept byte-for-byte; 0115 only ADDS four marked
-- hunks (`-- ▼ 0115 <id>` … `-- ▲ 0115 <id>`), and phone-0115-finalize.test.ts
-- proves that stripping them restores the 0114 body exactly.
--
--   S02-4 declare        the named hold bound, v_reconnect_hold = 30 min;
--   S02-4 label columns  the attempt's teardown evidence, selected into v_row;
--   S02-4 reconnect guard  WHERE-clause skip while a reconnect is pending
--                        (engagement reconnecting/dialing, or a newer live
--                        unbound leg), bounded by v_reconnect_hold;
--   S02-4 label          worker_crash -> unobserved_disconnect when the leg
--                        shows teardown evidence.
--
-- The session transition, the scoring keys, the C2 suppression and the C7
-- withdrawn path are unchanged. Behaviour is proven on real Postgres by
-- app/supabase/tests/phone_0115_finalize.sql (scripts/test-phone-0115.sh)
-- and phone_partial_finalize_{setup,assert}.sql (scripts/supabase-test.sh).
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.finalize_phone_partial_sessions(
  p_limit         integer     default 25,
  p_grace_seconds integer     default 180,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit    integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_grace    integer := greatest(30, least(coalesce(p_grace_seconds, 180), 7200));
  v_row      record;
  v_att      screening_v2.phone_call_attempts%rowtype;
  v_updated  integer;
  v_examined integer := 0;
  v_finalized integer := 0;
  v_skipped  integer := 0;
  v_total    integer;
  v_reason   text;
  v_has_assessment boolean;
  v_never_started  boolean;
  v_recording_present boolean;
  -- 0113 / E4: this leg ended because the candidate booked a callback.
  v_callback_booked boolean;
  -- ▼ 0114 C2/C7 declare
  -- C7: the candidate withdrew (opted_out / wrong_number engagement, or a
  -- recorded candidate.opt_out on this leg). C2: why this leg is withheld
  -- from scoring (phone_attempt_score_suppression), or null.
  v_withdrawn         boolean;
  v_withdrawn_state   text;
  v_withdrawn_skipped integer := 0;
  v_suppress          text;
  -- ▲ 0114 C2/C7 declare
  -- ▼ 0115 S02-4 declare
  -- S02-4: how long a PENDING RECONNECT may hold a session out of this sweep,
  -- measured from the end (or lapsed lease) of the session's latest bound
  -- leg. A named bound, not an open-ended wait: see the reconnect guard.
  v_reconnect_hold constant interval := interval '30 minutes';
  -- ▲ 0115 S02-4 declare
  v_sessions jsonb := '[]'::jsonb;
begin
  for v_row in
    select s.id as session_id,
           s.current_question_index as covered,
           s.recording_object_key,
           a.id            as attempt_id,
           -- 0095: reported so an operator reading the sweep's output can tie
           -- a finalized session to its engagement without a second query.
           -- Nothing ACTS on it — the draft that posted an engagement event
           -- from the caller is gone with edge #31.
           a.engagement_id as engagement_id,
           a.state         as attempt_state,
           a.outcome_class as attempt_outcome,
           a.ended_at      as attempt_ended_at,
           a.lease_expires_at
           -- ▼ 0115 S02-4 label columns
           -- S02-4: the leg's TEARDOWN EVIDENCE, read by the disconnect label
           -- below. Each is written only by a worker or egress that saw the
           -- leg end: a verified recording upload (0107 recording_ready), a
           -- completed egress, or the worker's observed SIP leave (0115 §1,
           -- stamped from /recording/complete).
           , a.recording_ready   as attempt_recording_ready
           , a.egress_status     as attempt_egress_status
           , a.observed_ended_at as attempt_observed_ended_at
           -- ▲ 0115 S02-4 label columns
      from screening_v2.call_sessions s
      -- The LATEST attempt on this session decides whether the call is over.
      -- A session is adopted across a no-answer ladder, so join the newest by
      -- admitted_at rather than any row.
      join lateral (
        select att.*
          from screening_v2.phone_call_attempts att
         where att.session_id = s.id
         order by att.admitted_at desc
         limit 1
      ) a on true
     where s.mode = 'live'
       and s.started_at is not null
       -- Idempotency + no-re-score, in one predicate: a session that already
       -- carries a phone assessment is NEVER re-selected. This self-terminates
       -- the sweep for a scored session and makes a redundant enqueue
       -- impossible from the SQL side (belt to the dedup-key braces).
       and not exists (
         select 1 from screening_v2.assessments a2
          where a2.session_id = s.id and a2.source = 'phone'
       )
       -- The session must be ENDABLE-but-unscored. Either it is still
       -- `in_progress` (hangup / network drop / crash before 0071's reclaim),
       -- or it is the crash residue 0071 already terminalized to
       -- `expired`/`grace_timeout` (MP3 finalized, scoring never enqueued).
       and (
         s.status = 'in_progress'
         -- 0113 / E4: a callback leg is NEVER scored, so on this arm (which
         -- only an assessment row ever drains) it would be re-selected for
         -- ever and starve real partials out of the window. The in_progress
         -- arm keeps it: that transition is what promotes its MP3.
         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout'
             -- ▼ 0114 C2/C7 expired arm
             -- C2: PR-B's callback_booked NOT EXISTS is generalised to the
             -- suppression (callback_booked is still its first answer): a
             -- deferred or worker-aborted leg is never scored either, so on
             -- this arm it too would be re-selected for ever.
             and screening_v2.phone_attempt_score_suppression(a.id) is null
             -- C7: a withdrawn leg is never scored; it is not selected here
             -- (the in_progress arm cancels it in the loop below).
             and not exists (
               select 1 from screening_v2.phone_engagements we
                where we.id = a.engagement_id
                  and we.state in ('opted_out','wrong_number'))
             and not exists (
               select 1 from screening_v2.phone_call_events ev
                where ev.attempt_id = a.id
                  and ev.event_type = 'candidate.opt_out')
             -- ▲ 0114 C2/C7 expired arm
             )
       )
       -- The call is genuinely over, not merely briefly quiet: the attempt is
       -- terminal with an ended_at, OR its lease lapsed in a live state (crash
       -- before reclaim), OR it is `abandoned` (reclaim's crash terminal) with
       -- an ended_at/lease past. In EVERY case the deciding instant must be
       -- older than the grace so a live leg that touched a moment ago is never
       -- taken.
       and (
         (a.state in ('ended','human','machine')
            and a.ended_at is not null
            and a.ended_at <= p_now - (v_grace * interval '1 second'))
         or
         (a.lease_expires_at is not null
            and a.lease_expires_at <= p_now - (v_grace * interval '1 second')
            and a.state in ('admitted','ringing','answered_unclassified','human','machine'))
         or
         (a.state = 'abandoned'
            and coalesce(a.ended_at, a.lease_expires_at) is not null
            and coalesce(a.ended_at, a.lease_expires_at)
                  <= p_now - (v_grace * interval '1 second'))
       )
       -- ▼ 0115 S02-4 reconnect guard
       -- A RECONNECT IS STILL PENDING, so the call is not over. 9f60523d: the
       -- reconnect leg was reclaimed, the engagement was `dialing` the next
       -- reconnect, and this sweep completed and scored the session in the
       -- meantime ("Screened" on 0 of 5 answers). Skip the session while
       -- EITHER holds for the engagement bound to it:
       --   (a) it is `reconnecting` (a reconnect was granted) or `dialing`
       --       (one is being placed); or
       --   (b) it has a live attempt admitted AFTER the session's latest
       --       bound leg: a reconnect leg not yet bound to the session (0114
       --       C1-d binds only at consent.resumed or the drop race).
       -- Keyed on `session_id = s.id`, so an engagement that DETACHED this
       -- session (the C2-a callback deferral) never holds it.
       --
       -- WHY THE WHERE CLAUSE (0095's reasoning, 0114 above): a session this
       -- sweep selects but does not finish is re-selected on every pass, and
       -- with `limit` + `order by started_at asc` a handful of such rows
       -- starve every real partial out of the window. A held session is
       -- simply NOT SELECTED, so it costs no slot and cannot starve anyone.
       --
       -- TIME-BOUNDED, on BOTH arms (in_progress and expired/grace_timeout).
       -- The hold lapses v_reconnect_hold after the latest bound leg's end
       -- (or its lapsed lease). An engagement wedged in `reconnecting` or
       -- `dialing` therefore cannot keep a session out of scoring and the
       -- MP3 transition for ever: once the bound passes, the session is
       -- selected exactly as before 0115. The normal exit is the engagement
       -- leaving those states (a failed reconnect goes `eligible` within a
       -- minute); a consent.resumed reconnect binds its leg, which then
       -- becomes the latest bound leg and is live, so nothing is selected.
       --
       -- Known residue, NOT covered: a drop outside the IST window parks the
       -- engagement in `scheduled`/window_closed (a next-day reconnect).
       -- That is not a guarded state, so such a session still finalizes
       -- before the reconnect, as it did before 0115 (owner follow-up).
       and not (
         coalesce(a.ended_at, a.lease_expires_at) is not null
         and p_now < coalesce(a.ended_at, a.lease_expires_at) + v_reconnect_hold
         and exists (
           select 1 from screening_v2.phone_engagements re
            where re.session_id = s.id
              and (re.state in ('reconnecting','dialing')
                   or exists (
                     select 1 from screening_v2.phone_call_attempts na
                      where na.engagement_id = re.id
                        and na.id <> a.id
                        and na.admitted_at > a.admitted_at
                        and na.ended_at is null
                        and na.state in ('admitted','ringing','answered_unclassified',
                                         'human','machine'))))
       )
       -- ▲ 0115 S02-4 reconnect guard
     order by s.started_at asc
     limit v_limit
     for update of s skip locked
  loop
    v_examined := v_examined + 1;
    -- ▼ 0114 C7 withdrawn
    -- CHECKED FIRST (R9). A candidate who withdrew mid-call (or whose line
    -- was a wrong number) must never be completed and scored: the session
    -- is CANCELLED with the truthful reason, exactly as apply_phone_event's
    -- C7-b tail does, and it is not returned to the caller (no enqueue, no
    -- scorecard). Withdrawn = the engagement is opted_out / wrong_number, OR
    -- a `candidate.opt_out` was recorded on this leg (applied OR ignored:
    -- an opt-out that lost a race to the drop or the budget is still the
    -- candidate's word). Only an in_progress session moves; the expired arm
    -- never selects a withdrawn leg.
    select we.state into v_withdrawn_state
      from screening_v2.phone_engagements we
     where we.id = v_row.engagement_id;
    v_withdrawn := coalesce(v_withdrawn_state in ('opted_out','wrong_number'), false)
      or exists (
        select 1 from screening_v2.phone_call_events ev
         where ev.attempt_id = v_row.attempt_id
           and ev.event_type = 'candidate.opt_out');
    if v_withdrawn then
      update screening_v2.call_sessions s
         set status          = 'cancelled',
             terminal_reason = case when v_withdrawn_state = 'wrong_number'
                                    then 'wrong_number' else 'candidate_opt_out' end,
             ended_at        = coalesce(s.ended_at, p_now),
             updated_at      = p_now
       where s.id = v_row.session_id
         and s.status = 'in_progress';
      v_withdrawn_skipped := v_withdrawn_skipped + 1;
      v_withdrawn_state := null;
      continue;
    end if;
    v_withdrawn_state := null;
    -- ▲ 0114 C7 withdrawn

    -- Coverage: the cursor is the count of questions covered; the plan's
    -- question_count is the total. A session with no plan row yet (should not
    -- happen for a screening that started, but must not abort the sweep)
    -- reports total=null and is still scored.
    select p.question_count into v_total
      from screening_v2.phone_session_plans p
     where p.session_id = v_row.session_id;

    -- disconnect_reason (no PII, one of three fixed tokens):
    --   * 'candidate_hangup' — the attempt ended with outcome 'disconnected'
    --     (the deliberate-hangup path);
    --   * 'worker_crash' — the residue 0071's reclaim produced: the attempt is
    --     `abandoned` (reclaim nulls its outcome_class) or its lease expired in
    --     a live state without a terminal outcome. This is the mode where the
    --     session is already `expired`/`grace_timeout` (or was, before this
    --     sweep saw it) and the MP3 was finalized by reclaim, not by us;
    --   * 'disconnected' — any other genuine end (e.g. an `ended` attempt with
    --     a non-'disconnected' outcome).
    v_reason := case
      when v_row.attempt_outcome = 'disconnected' then 'candidate_hangup'
      when v_row.attempt_state = 'abandoned'
        or (v_row.lease_expires_at is not null
            and v_row.attempt_state in
                ('admitted','ringing','answered_unclassified','human','machine'))
        then 'worker_crash'
      else 'disconnected'
    end;
    -- ▼ 0115 S02-4 label
    -- A FOURTH token, 'unobserved_disconnect'. `worker_crash` claimed our
    -- side died, but the lease reclaim (or a lapsed lease) is also how a leg
    -- ends when the CANDIDATE hung up and nothing reported it (the reconnect
    -- leg's room was invisible to the reconciler before 0115 §2). When the
    -- leg shows teardown evidence (a verified recording upload, a completed
    -- egress, or an observed SIP leave), the worker was alive at the end, so
    -- the truthful label is "the line dropped and we did not observe it".
    -- It is NOT an infrastructure fault: the API grades it like any other
    -- non-crash disconnect (evidence.ts compares to worker_crash only, as
    -- does the 0114 §4 SQL grade mirror), so a 0-answer leg grades
    -- no_candidate_speech rather than infra_interrupted. worker_crash is
    -- kept only when there is no such evidence. No PII.
    if v_reason = 'worker_crash'
       and (coalesce(v_row.attempt_recording_ready, false)
            or v_row.attempt_egress_status = 'complete'
            or v_row.attempt_observed_ended_at is not null) then
      v_reason := 'unobserved_disconnect';
    end if;
    -- ▲ 0115 S02-4 label

    -- ── 0095 / issue #286: DID A SCREENING ACTUALLY HAPPEN? ───────────
    -- The sweep already knew — it selects `covered` and reads the plan's
    -- `question_count` — and used neither to decide the terminal state, so
    -- "crashed after eight answers" and "hung up before asking anything"
    -- both landed on `completed` / `conversation_complete`.
    --
    -- The test is DIRECT evidence, not a coverage threshold: did the
    -- CANDIDATE ever say anything outside the gate?
    --
    -- Gate turns (identity, consent) are excluded because they are exactly
    -- what a never-started call DOES have. And the speaker filter is
    -- load-bearing: `commit_phone_item_turn` (0071:179) writes BOTH 'bot'
    -- and 'candidate' turns with is_gate = false, so testing for any
    -- non-gate turn would count the bot ASKING question one as evidence the
    -- candidate answered it. A call that died the instant Q1 was asked would
    -- then be a completed screening — the precise defect this migration
    -- exists to remove, reintroduced one turn later.
    --
    -- Keyed on the candidate it is also the SAFE direction for scoring: if
    -- the candidate contributed no non-gate turn there is, by construction,
    -- nothing to score, so skipping the enqueue can never cost a real
    -- scorecard. Any candidate answer at all — even one — takes the
    -- `completed` branch and scores exactly as it did before 0095.
    select not exists (
      select 1 from screening_v2.transcript_turns t
       where t.session_id = v_row.session_id
         and t.is_gate = false
         and t.speaker = 'candidate'
    ) into v_never_started;

    -- Already-present signals — reported, never gating. The caller's dedup key
    -- makes a redundant enqueue a no-op; the recording flag is for the log.
    select exists (
      select 1 from screening_v2.assessments a
       where a.session_id = v_row.session_id and a.source = 'phone'
    ) into v_has_assessment;
    v_recording_present := v_row.recording_object_key is not null;

    -- 0113 / E4: did this leg end because the candidate CONFIRMED a voice
    -- callback? An EXACT match on the attempt that booked it (unique index),
    -- any appointment status, and deliberately no engagement-level fallback:
    -- an unrelated appointment on the same engagement must never suppress a
    -- real screening's scorecard. The caller skips the scoring enqueue on it.
    select exists (
      select 1 from screening_v2.phone_appointments ap
       where ap.confirmed_from_attempt_id = v_row.attempt_id
    ) into v_callback_booked;
    -- ▼ 0114 C2 suppression
    -- C2: is this leg withheld from scoring? callback_booked (the E4 fact
    -- above), callback_deferred (the in-call deferral outcome) or
    -- worker_aborted (an applied internal assessment.aborted carrying this
    -- attempt id; the stranded sweep's abort carries none, so a DLQ replay
    -- of a stranded session still scores). The session transition below is
    -- UNCHANGED for a suppressed leg, so its MP3 still finalizes; the caller
    -- skips the scoring enqueue on `score_suppressed`.
    v_suppress := screening_v2.phone_attempt_score_suppression(v_row.attempt_id);
    -- ▲ 0114 C2 suppression

    -- Drive the session terminal, RE-VERIFYING under the lock that it is still
    -- in_progress (the unlocked-ish scan may have raced a live completion).
    -- The SAME transition the worker's happy path uses: completed /
    -- conversation_complete. It fires trg_enqueue_recording_finalize (0038) in
    -- THIS transaction and makes the session eligible for scoring. A row that
    -- is no longer in_progress is left untouched — this covers BOTH the
    -- idempotent re-run (a session already completed) AND the worker-crash
    -- residue this sweep also selects (`expired`/`grace_timeout`, MP3 already
    -- finalized by 0071's reclaim): re-transitioning `expired -> completed` is
    -- not a legal 0006 edge, so we deliberately leave it terminal and report
    -- `transitioned=false`. Its scoring is still owed and still returned below.
    -- ── THE SESSION TRANSITION IS UNCHANGED BY 0095 ───────────────────
    --
    -- An earlier draft drove a never-started session to `failed` /
    -- `screening_never_started`. Three reviews and the repo's own
    -- `phone_partial_finalize_assert.sql` all rejected it, and they were
    -- right. `never_started` is now REPORTED and never acted on here.
    --
    -- Why the status must not move:
    --   * THE SWEEP STARVES ITSELF. The selection admits
    --     `expired`/`grace_timeout` as well as `in_progress`, but this UPDATE
    --     is guarded `status = 'in_progress'`, so that arm is never
    --     re-stamped. It leaves the set only once an assessment row exists.
    --     Skipping the scoring enqueue for these sessions meant no row was
    --     ever written, so they were re-selected for ever — and with
    --     `limit 25` and `order by started_at asc`, 25 of them displace every
    --     REAL partial screening from the window. Those lose both the
    --     scorecard and the terminal transition that drives the MP3.
    --   * THE MP3 LOSES A RECOVERY PATH. The 0038 trigger and the sweeper do
    --     treat `failed` like `completed`, but the download route's
    --     on-demand finalize backstop is `status = 'completed'` only.
    --   * SCORING CHANGES FOR A CLASS THAT HAD IT. The crash-partial pair
    --     (`expired` + `grace_timeout`) is admitted by the eligibility gate,
    --     so such a session was scored before; withholding the enqueue takes
    --     that away without touching the gate, which is what made the change
    --     invisible.
    --   * THE EVIDENCE IS NOT SAFE TO ACT ON. The per-item transcript writer
    --     is fire-and-forget (`agent.py`, `asyncio.create_task`, never
    --     awaited, failures swallowed) and the boundary writer SUPPRESSES its
    --     own insert when any per-item row exists (0086). If the bot's write
    --     lands and the candidate's does not, a real screening reads as
    --     never-started. Good enough to REPORT; not good enough to withhold a
    --     scorecard or redirect a call on.
    --
    -- So the transition below is byte-for-byte what 0072 shipped: the SAME
    -- transition the worker's happy path uses. MP3 and scorecard generation
    -- are therefore untouched by this migration, which is the owner's
    -- explicit constraint.
    update screening_v2.call_sessions s
       set status          = 'completed',
           terminal_reason = 'conversation_complete',
           ended_at        = coalesce(s.ended_at, p_now),
           updated_at      = p_now
     where s.id = v_row.session_id
       and s.status = 'in_progress';
    get diagnostics v_updated = row_count;
    if v_updated = 1 then
      v_finalized := v_finalized + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    -- The selection is returned WHETHER OR NOT the transition landed on this
    -- pass, so the caller enqueues scoring independently of the transition.
    v_sessions := v_sessions || jsonb_build_object(
      'session_id',         v_row.session_id,
      'attempt_id',         v_row.attempt_id,
      'engagement_id',      v_row.engagement_id,
      'covered',            v_row.covered,
      'total',              v_total,
      'disconnect_reason',  v_reason,
      -- The caller reads this to decide whether to enqueue scoring at all.
      -- A never-started session has no non-gate turns; enqueuing it would DLQ
      -- against the eligibility guard and look like a scoring failure rather
      -- than a call that never happened.
      'never_started',      v_never_started,
      'transitioned',       v_updated = 1,
      'assessment_present', v_has_assessment,
      'recording_present',  v_recording_present,
      -- ▼ 0114 C2 suppression keys
      -- true = never scored (see suppress_reason); finalized for its MP3
      -- and transcript only. callback_booked below is kept verbatim.
      'score_suppressed',   v_suppress is not null,
      'suppress_reason',    v_suppress,
      -- ▲ 0114 C2 suppression keys
      -- 0113 / E4: true = a callback leg; finalized for its MP3 and
      -- transcript, but never scored, published or used to end the engagement.
      'callback_booked',    v_callback_booked);

    v_total := null;
  end loop;

  return jsonb_build_object(
    'status',        'ok',
    'examined',      v_examined,
    'finalized',     v_finalized,
    'skipped',       v_skipped,
    'limit',         v_limit,
    'grace_seconds', v_grace,
    -- ▼ 0114 C7 withdrawn key
    'withdrawn_skipped', v_withdrawn_skipped,
    -- ▲ 0114 C7 withdrawn key
    'sessions',      v_sessions);
end;
$$;

revoke all on function screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.finalize_phone_partial_sessions is
  'Partial-finalize sweeper (0072): finds phone sessions left in_progress '
  'whose call is genuinely over (latest attempt terminal or lease-expired) '
  'past a short reconnect grace, drives each to completed/conversation_complete '
  'so the 0038 finalize trigger promotes the attempt MP3, and returns the '
  'coverage/attempt facts so the caller can enqueue PARTIAL scoring '
  'independently. Selection is on session-ended, not egress state, so the '
  'scorecard lands even when egress produced nothing. Idempotent and '
  'self-limiting; charges no budget. 0113: callback_booked per session. '
  '0114: a withdrawn leg (opted_out/wrong_number engagement, or a recorded '
  'candidate.opt_out on the leg) is cancelled, never completed or returned '
  '(withdrawn_skipped); a leg phone_attempt_score_suppression withholds is '
  'still completed for its MP3 and reported score_suppressed/suppress_reason '
  'so the caller never scores it. 0115: a session whose bound engagement is '
  'reconnecting/dialing, or has a live leg newer than the session''s latest '
  'bound leg, is not selected for up to 30 minutes after that leg ended; '
  'disconnect_reason is unobserved_disconnect (not worker_crash) when a '
  'reclaimed or lease-lapsed leg shows teardown evidence. Service-role-only.';
-- ==== 0115 §4 END ====


notify pgrst, 'reload schema';
