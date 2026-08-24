-- ═══════════════════════════════════════════════════════════════════════
-- 0045_phone_runtime_liveness.sql
-- Phone screening P5 — the two obligations 0042 assigned to the runtime,
-- plus the anti-harassment guard the engagement-scoped indexes cannot see.
-- ═══════════════════════════════════════════════════════════════════════
--
-- ── WHAT THIS CLOSES ──────────────────────────────────────────────────
-- 0042's header names, in as many words, the two things it does not
-- implement and hands to P5:
--
--   "`eligible`, `awaiting_retry` and `scheduled` are SWEEPER-DRIVEN by
--    design (transitions #5/#6/#27) and carry no queue row. The sweeper
--    that re-drives them, and the heartbeat loop that keeps a concurrency
--    lease alive for the length of a conversation, are owned by P5. ...
--    The 10-slot cap's correctness depends on P5 heartbeating, and that
--    dependency is stated rather than hidden."
--                            -- 0042_phone_screening.sql:102-111
--
-- P5 (#99) shipped five loops. One CONSUMES the reclaimer. None
-- heartbeated, and none drove #27. Both absences were invisible to a test
-- suite: no mutation can produce a red for a loop that was never written.
--
--   1. NOTHING RENEWED THE ATTEMPT LEASE. `leaseOutlivesOriginate`
--      extends it to cover the originate and stops — originate 60s +
--      margin 15s, against a lease of 60s. A screening runs for minutes,
--      so the lease expired MID-CALL on every answered call. The fleet
--      slot is counted as `lease_expires_at > p_now`, so the slot was
--      released the instant the lease lapsed, before the reclaim sweep
--      even ran; an 11th call was admissible while the 10th was talking.
--      Then the sweep marked a talking `human` attempt `abandoned` and
--      moved the engagement out of `in_call`, so the agent's eventual
--      `assessment.completed` — an edge gated on `in_call` — was ignored.
--      A screening that was conducted, persisted and SCORED was silently
--      lost, and the engagement was left pointing at a dead session it
--      could never reuse.
--
--   2. NOTHING POSTED `day.rolled`. It appears nowhere outside the
--      migrations — not in the API, the worker, the agent, a script or a
--      test. `awaiting_retry` had no edge out, and `PHONE_DUE_STATES`
--      cannot see it, so the FIRST unanswered call ended the ladder. The
--      contract's "max 3 total attempts on distinct IST calendar dates"
--      was unreachable: attempt 2 never happened.
--
--   3. THE ANTI-HARASSMENT INDEXES ARE SCOPED BY ENGAGEMENT, AND A PERSON
--      IS NOT. `uq_phone_engagements_application` keys an engagement to an
--      application link and the candidate index is deliberately not
--      unique, so one person applying to two roles has two engagements —
--      two independent budgets, two independent IST-day slots, and two
--      admissions that both succeed. The advisory lock serialises them and
--      refuses neither. One phone rings twice, possibly at once. No index
--      in 0042 can see this, because every one of them is keyed by
--      engagement.
--
-- ── WHY THE HEARTBEAT IS KEYED BY (attempt, epoch) AND NOT BY TOKEN ────
-- `heartbeat_phone_attempt` (0042) is token-fenced, and that is right for
-- a caller that HOLDS the token: the API process that admitted the
-- attempt. But the conversation is conducted by a different process — the
-- LiveKit agent — and it must renew for the length of the call.
--
-- Handing the agent the lease token would put a credential on the
-- dispatch metadata, a surface readable by anything that can read room
-- state, and into every log line that ever printed a request body. So
-- 0045 adds a SECOND door with a DIFFERENT fence: the worker names an
-- attempt and an epoch, and the database looks up the token itself. The
-- epoch is not a secret — it is a small integer that is bumped whenever an
-- attempt is superseded, which is exactly the property needed to stop a
-- stale agent from a dead attempt renewing the live one's lease.
--
-- The token-fenced door is NOT removed. `leaseOutlivesOriginate` still
-- uses it, and it remains the only way to renew without naming an epoch.
--
-- ── FORWARD-ONLY ──────────────────────────────────────────────────────
-- One new table (`phone_sweep_leases`), three new functions, and one
-- REPLACED function (`admit_phone_attempt`). No column is dropped, no
-- constraint is loosened, and no existing function's signature changes.
-- `stuck_sessions` is replaced to become mode-aware; its signature and
-- return shape are unchanged, so 0011's callers are unaffected.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 1. heartbeat_phone_attempt_by_epoch — the renewal the agent can reach
-- ═══════════════════════════════════════════════════════════════════════
-- Renews the CONCURRENCY lease (phone_call_attempts.lease_expires_at),
-- not the 0028 queue lease. Different table, different token, different
-- lifetime — a distinction the P5 package's own structural test blurred
-- by calling the queue runner's renewal "the heartbeat".
--
-- The fence is (attempt, epoch) AND the attempt still being live with an
-- unexpired lease. All four losses collapse to one stable answer,
-- deliberately, exactly as the token-fenced sibling does:
--
--   * unknown attempt          -> lease_lost
--   * stale epoch              -> lease_lost
--   * attempt no longer live   -> lease_lost
--   * lease already reclaimed  -> lease_lost
--
-- The caller must STOP on lease_lost, not retry. A renewal that failed
-- because the lease was reclaimed means the fleet slot is already gone
-- and another call may hold it; continuing would put two conversations
-- against one slot, which is the failure the cap exists to prevent.
--
-- `lease_expires_at > p_now` in the predicate is what makes this safe to
-- expose to a worker: a lapsed lease can NEVER be revived through this
-- door. Reviving one would resurrect a slot the reclaimer has already
-- given away.
create or replace function screening_v2.heartbeat_phone_attempt_by_epoch(
  p_attempt_id    uuid,
  p_epoch         integer,
  p_session_id    uuid,
  p_lease_seconds integer     default 60,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_expires timestamptz;
begin
  if p_attempt_id is null or p_epoch is null or p_session_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  -- THE SESSION IS PART OF THE FENCE, not decoration. The worker route
  -- required a session id from the first draft and then discarded it, which
  -- meant a caller holding a valid attempt id and epoch could renew while
  -- naming ANY session — a field that reads like a binding check and binds
  -- nothing is worse than no field, because a reviewer stops looking.
  --
  -- The predicate is "you are not naming a DIFFERENT session", not "you are
  -- naming the right one", and the difference is forced by when the binding
  -- happens. `phone_call_attempts.session_id` is written by
  -- `start_phone_assessment` (0044), which the agent calls AFTER the opening
  -- gate — so the first beats of a conversation legitimately arrive while the
  -- column is still null. A strict equality here would answer `lease_lost` to
  -- a live call and the agent would hang up on a real person: a false
  -- positive on the one signal that means "stop".
  --
  -- So before binding the fence is (attempt, epoch) — which is exactly the
  -- window P4a's originate lease already covers — and from binding onward it
  -- is (attempt, epoch, session). What it rules out at every moment is the
  -- thing worth ruling out: a worker in one conversation holding open the
  -- fleet slot of another.
  update screening_v2.phone_call_attempts
     set lease_expires_at = p_now + (greatest(5, least(coalesce(p_lease_seconds, 60), 900))
                                     * interval '1 second')
   where id = p_attempt_id
     and epoch = p_epoch
     and (session_id is null or session_id = p_session_id)
     and state in ('admitted','ringing','answered_unclassified','human','machine')
     and lease_expires_at > p_now
  returning lease_expires_at into v_expires;

  if v_expires is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  -- The new expiry is returned for observability, NOT the lease token.
  -- The token is the credential; it never leaves this database through
  -- this door, which is the entire reason this door exists.
  return jsonb_build_object('status', 'ok', 'lease_expires_at', v_expires);
end;
$$;

revoke all on function screening_v2.heartbeat_phone_attempt_by_epoch(uuid, integer, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.heartbeat_phone_attempt_by_epoch(uuid, integer, uuid, integer, timestamptz) to service_role;

comment on function screening_v2.heartbeat_phone_attempt_by_epoch is
  'Epoch-fenced renewal of a phone_call_attempts CONCURRENCY lease, for the '
  'worker that conducts the conversation and does not hold the lease token. '
  'A stale epoch, a dead attempt or an already-lapsed lease all answer '
  'lease_lost; a lapsed lease can never be revived through this door, and the '
  'SESSION is part of the fence so a caller must prove it is in the '
  'conversation whose slot it holds open. Never '
  'returns or accepts the lease token. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. phone_sweep_leases — a bounded leader claim for the fleet sweeps
-- ═══════════════════════════════════════════════════════════════════════
-- Every replica runs every P5 loop. For the DUE pass that is harmless:
-- admission is globally serialised and now candidate-guarded, so a second
-- replica's dial is refused rather than duplicated. For the SWEEPS it is
-- not harmless in the same way, but it is wasteful in a way that scales
-- with the fleet: `runPhoneReconciliation` reads LiveKit room state for
-- every live attempt, so N replicas make N times the provider calls.
--
-- This is a CLAIM, not an election. There is no term, no fencing token
-- and no guarantee that exactly one holder exists — a claim can expire
-- while its holder is still working, and then two replicas sweep at once.
-- That is acceptable BECAUSE every sweep it guards is idempotent:
-- `day.rolled` dedups on a date-scoped event id, reconciliation dedups on
-- `provider_event_id`, and the reclaimer's predicate is self-limiting. The
-- claim exists to bound duplication, not to establish exclusivity, and
-- calling it a leader election would invite someone to depend on a
-- property it does not have.
create table if not exists screening_v2.phone_sweep_leases (
  sweep       text        primary key,
  owner       text        not null,
  claimed_at  timestamptz not null,
  expires_at  timestamptz not null,
  constraint chk_phone_sweep_leases_sweep
    check (sweep ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint chk_phone_sweep_leases_owner
    check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  constraint chk_phone_sweep_leases_window
    check (expires_at > claimed_at)
);

alter table screening_v2.phone_sweep_leases enable row level security;
revoke all on table screening_v2.phone_sweep_leases from public, anon, authenticated;

comment on table screening_v2.phone_sweep_leases is
  'Bounded leader CLAIM for the phone fleet sweeps. Not an election: a claim '
  'can expire while its holder still works, so two replicas may sweep at '
  'once. Every guarded sweep is idempotent, which is what makes that '
  'acceptable. Bounds duplication; does not establish exclusivity.';

-- Claim or renew. One statement, so two replicas racing cannot both win:
-- the primary key serialises them and the WHERE on DO UPDATE decides.
create or replace function screening_v2.claim_phone_sweep(
  p_sweep       text,
  p_owner       text,
  p_ttl_seconds integer     default 60,
  p_now         timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_expires timestamptz;
  v_ttl     integer := greatest(5, least(coalesce(p_ttl_seconds, 60), 900));
begin
  if p_sweep is null or p_owner is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  insert into screening_v2.phone_sweep_leases (sweep, owner, claimed_at, expires_at)
  values (p_sweep, p_owner, p_now, p_now + (v_ttl * interval '1 second'))
  on conflict (sweep) do update
     set owner      = excluded.owner,
         claimed_at = excluded.claimed_at,
         expires_at = excluded.expires_at
   -- Renew our own claim, or take over an EXPIRED one. Never steal a live
   -- claim from another owner: that is what bounds duplication.
   where screening_v2.phone_sweep_leases.expires_at <= p_now
      or screening_v2.phone_sweep_leases.owner = excluded.owner
  returning expires_at into v_expires;

  if v_expires is null then
    return jsonb_build_object('status', 'held_by_other');
  end if;
  return jsonb_build_object('status', 'ok', 'expires_at', v_expires);
exception
  when check_violation then
    return jsonb_build_object('status', 'invalid_input');
end;
$$;

revoke all on function screening_v2.claim_phone_sweep(text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.claim_phone_sweep(text, text, integer, timestamptz) to service_role;

comment on function screening_v2.claim_phone_sweep is
  'Claim or renew a bounded sweep lease. Renews your own claim, takes over an '
  'expired one, and refuses a live claim held by another owner with '
  'held_by_other. Single-statement upsert, so a race is decided by the '
  'primary key. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. stuck_sessions — phone-aware, without weakening the global timeout
-- ═══════════════════════════════════════════════════════════════════════
-- 0011's detector flags any `waiting` session older than 5 minutes. Before
-- P5 that was safe, because nothing minted long-lived `waiting` sessions.
-- P5 mints one per engagement and ADOPTS it across attempts, so a session
-- now sits `waiting` legitimately for the length of a no-answer ladder —
-- up to three distinct IST dates — and across every bounded reconnect.
--
-- The acceptance is explicit that the global timeout must not be weakened
-- and that the exemption must be phone-scoped. So the three existing
-- parameters are untouched and every non-phone session behaves exactly as
-- it did; only phone sessions are re-bounded, and they are re-bounded
-- rather than exempted, because a phone session CAN leak and an
-- exemption would make that leak permanently invisible.
--
-- ── WHY `external_call_id` AND NOT `mode` ─────────────────────────────
-- The obvious predicate is `mode <> 'live'`, and it is wrong:
-- `PHONE_SESSION_MODE` IS `'live'`, shared with every browser session.
-- The actual discriminator — the one `findReusableSession` and
-- `start_phone_assessment` both already rely on — is that a phone
-- session carries its own derived room name. That is a property no
-- browser session has and no phone session lacks, because
-- `createPhoneSessionPort` writes it in the same CAS that creates the
-- session.
--
-- The SIGNATURE IS UNCHANGED, deliberately. Adding a fourth defaulted
-- parameter would create a second overload and make every existing
-- three-argument call ambiguous. The phone bound is a function, like
-- `phone_max_concurrent()`, so it is tunable in one place.
create or replace function screening_v2.phone_stale_session_seconds()
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  -- Four days. The no-answer ladder spans three distinct IST dates, and a
  -- session minted just before midnight on day one is still legitimately
  -- in use late on day three. Four is that span plus a margin, not a
  -- number chosen to be large enough to never fire.
  select 345600;
$$;

revoke all on function screening_v2.phone_stale_session_seconds() from public, anon, authenticated;
grant execute on function screening_v2.phone_stale_session_seconds() to service_role;

comment on function screening_v2.phone_stale_session_seconds is
  'How long a phone `waiting` session may legitimately live: the three-IST-day '
  'no-answer ladder plus a margin. Not an exemption — a phone session past '
  'this bound is still reported, with its own reason_hint.';

create or replace function screening_v2.stuck_sessions(
  waiting_timeout_sec int default 300,    -- 5 min
  created_timeout_sec int default 1800,   -- 30 min
  progress_timeout_sec int default 7200   -- 2 hours
)
returns table (
  session_id        uuid,
  status            text,
  state_duration_sec double precision,
  candidate_id      uuid,
  reason_hint       text
)
language sql
stable
set search_path = pg_catalog
as $$
  -- Waiting sessions that have been waiting too long (no worker attached).
  -- A PHONE session is excluded here and re-tested below against its own
  -- bound; every other session behaves exactly as it did before 0045.
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.waiting_at))::double precision as state_duration_sec,
    s.candidate_id,
    'stuck_in_waiting'::text as reason_hint
  from screening_v2.call_sessions s
  where s.status = 'waiting'
    and s.waiting_at is not null
    and s.external_call_id is distinct from ('phone-' || s.id::text)
    and extract(epoch from (now() - s.waiting_at)) > waiting_timeout_sec

  union all

  -- The phone re-test. Same rows, its own bound, its own hint so an
  -- operator is never told a four-day-old phone session and a five-minute
  -- browser session are the same kind of problem.
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.waiting_at))::double precision as state_duration_sec,
    s.candidate_id,
    'stuck_phone_waiting'::text as reason_hint
  from screening_v2.call_sessions s
  where s.status = 'waiting'
    and s.waiting_at is not null
    and s.external_call_id = ('phone-' || s.id::text)
    and extract(epoch from (now() - s.waiting_at))
        > screening_v2.phone_stale_session_seconds()

  union all

  -- Created sessions that never transitioned (canonical start time is started_at).
  -- A phone session passes through `created` for the width of ONE CAS, so
  -- there is nothing phone-specific to exempt here: a phone session still
  -- in `created` after 30 minutes is a genuine half-provisioned leak and
  -- SHOULD be reported.
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.started_at))::double precision as state_duration_sec,
    s.candidate_id,
    'stuck_in_created'::text as reason_hint
  from screening_v2.call_sessions s
  where s.status = 'created'
    and extract(epoch from (now() - s.started_at)) > created_timeout_sec

  union all

  -- In-progress sessions that have been running too long. Left as-is: a
  -- phone conversation that has been `in_progress` for two hours is not a
  -- bounded reconnect, it is a stuck call, and the attempt lease has long
  -- since lapsed underneath it.
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.started_at))::double precision as state_duration_sec,
    s.candidate_id,
    'stuck_in_progress'::text as reason_hint
  from screening_v2.call_sessions s
  where s.status = 'in_progress'
    and extract(epoch from (now() - s.started_at)) > progress_timeout_sec
  order by state_duration_sec desc;
$$;

revoke all on function screening_v2.stuck_sessions(int, int, int) from anon, authenticated;
grant execute on function screening_v2.stuck_sessions(int, int, int) to service_role;

comment on function screening_v2.stuck_sessions is
  'Stale-session detector, phone-aware since 0045. Non-phone behaviour is '
  'UNCHANGED. A phone session — identified by carrying its own derived room '
  'name, since mode is `live` for browser sessions too — is re-bounded '
  'against phone_stale_session_seconds() and reported under '
  'stuck_phone_waiting, never exempted.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. sweep_phone_day_rolled — the driver transition #27 never had
-- ═══════════════════════════════════════════════════════════════════════
-- `day.rolled` appears nowhere outside these migrations. #27 is the ONLY
-- edge out of `awaiting_retry`, and `PHONE_DUE_STATES` cannot see that
-- state, so an engagement that reached it was finished: the first
-- unanswered call ended a ladder the contract says runs to three attempts
-- on three distinct IST dates.
--
-- ── THE DEDUP KEY IS DATE-SCOPED, AND THAT IS THE WHOLE DESIGN ────────
-- `apply_phone_event` mints a deterministic id for `internal` events:
--
--     'internal:' || subject || ':' || event_type || ':' || coalesce(epoch,-1)
--
-- For a day roll that is the SAME STRING EVERY DAY. Posting through the
-- internal channel would therefore succeed once and then be deduped as a
-- replay for the rest of the engagement's life — the ladder would advance
-- from attempt 1 to attempt 2 and stop there permanently. This project has
-- already paid for that lesson once: a refusal recorded under a
-- deterministic dedup key is a permanent wedge.
--
-- So the sweep supplies its OWN id, scoped by engagement AND IST date:
--
--     'dayroll:' || engagement_id || ':' || ist_date
--
-- which dedups exactly as far as it should — one roll per engagement per
-- IST day, idempotent across replicas and across retries within a day,
-- and free to fire again tomorrow. That is also what makes this sweep
-- safe to run without exclusivity.
--
-- BOUNDED, like every other sweep here: `p_limit` rows per pass, ordered
-- oldest-attempt-first so a backlog drains in the order it formed.
create or replace function screening_v2.sweep_phone_day_rolled(
  p_limit integer     default 25,
  p_now   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit    integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_row      record;
  v_result   jsonb;
  v_rolled   integer := 0;
  v_examined integer := 0;
  v_skipped  integer := 0;
begin
  for v_row in
    select e.id, screening_v2.phone_ist_date(p_now) as today
      from screening_v2.phone_engagements e
     where e.state = 'awaiting_retry'
       and e.terminal_at is null
       -- The same comparison #27 makes. Applied here too so the sweep does
       -- not post an event it knows will be refused: an engagement whose
       -- last attempt was TODAY is not eligible to roll, and posting for it
       -- would burn today's dedup id on a no-op and block the real roll.
       and screening_v2.phone_ist_date(p_now)
           > screening_v2.phone_ist_date(coalesce(e.last_attempt_at, p_now))
     order by e.last_attempt_at asc nulls last
     limit v_limit
  loop
    v_examined := v_examined + 1;

    v_result := screening_v2.apply_phone_event(
      p_source            => 'internal',
      p_event_type        => 'day.rolled',
      p_attempt_id        => null,
      p_engagement_id     => v_row.id,
      p_provider_event_id => 'dayroll:' || v_row.id::text || ':' || v_row.today::text,
      p_epoch             => null,
      p_metadata          => null,
      p_now               => p_now
    );

    -- `applied`, NOT `ok`. `apply_phone_event`'s success status is the word
    -- `applied`; `ok` is `admit_phone_attempt`'s. Checking for the wrong one
    -- would have counted every successful roll as a skip and reported a sweep
    -- that works as a sweep that does nothing.
    -- Written WITHOUT a coalesce-to-empty-string on purpose. The RPC
    -- contract drift test extracts a function's status vocabulary by
    -- scanning for the literal that follows the status key, and a
    -- coalesce default sitting in that position reads as an extra,
    -- nameless status. This form keeps the tripwire honest -- and note
    -- that the extractor does not strip comments, so prose must avoid the
    -- marker sequence too.
    if (v_result ->> 'status') is not distinct from 'applied'
       and (v_result ->> 'ignored_reason') is null then
      v_rolled := v_rolled + 1;
    else
      -- A duplicate (this replica raced another), or a transition the
      -- engagement no longer accepts because it moved underneath us.
      -- Neither is an error and neither is retried: tomorrow's id differs.
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status',   'ok',
    'examined', v_examined,
    'rolled',   v_rolled,
    'skipped',  v_skipped,
    'limit',    v_limit
  );
end;
$$;

revoke all on function screening_v2.sweep_phone_day_rolled(integer, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.sweep_phone_day_rolled(integer, timestamptz) to service_role;

comment on function screening_v2.sweep_phone_day_rolled is
  'Bounded driver for transition #27. Posts day.rolled for awaiting_retry '
  'engagements whose last attempt was on an earlier IST date, under a dedup '
  'id scoped by engagement AND IST date so it rolls once per day and can roll '
  'again tomorrow. Idempotent across replicas. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. admit_phone_attempt — REPLACED, for the per-candidate guards
-- ═══════════════════════════════════════════════════════════════════════
-- Byte-identical to 0042's body except for two additions, both refusals
-- and both in the refusal-only window between the per-IST-day check and
-- the fleet cap. Everything in that window charges no budget, so the new
-- guards inherit that property rather than needing it argued separately.
--
-- The signature is unchanged, so every caller and every grant is unaffected.
create or replace function screening_v2.admit_phone_attempt(
  p_engagement_id uuid,
  p_kind          text,
  p_lease_owner   text        default null,
  p_lease_seconds integer     default 60,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link_id        uuid;
  v_eng            screening_v2.phone_engagements%rowtype;
  v_link           screening_v2.ashby_application_links%rowtype;
  v_map            screening_v2.ashby_job_mappings%rowtype;
  v_ing_state      text;
  v_consent        screening_v2.consent_records%rowtype;
  v_required       screening_v2.consent_type[];
  v_phone          text;
  v_phone_valid    boolean;
  v_digest         text;
  v_ctl_found      boolean;
  v_halted_at      timestamptz;
  v_live           integer;
  v_seq            integer;
  v_attempt_id     uuid;
  v_lease_token    uuid;
  v_lease_expires  timestamptz;
  v_ist_date       date;
  v_job_id         uuid;
  v_dedup_key      text;
  v_constraint     text;
  v_apt_id         uuid;
  v_max_concurrent constant integer := screening_v2.phone_max_concurrent();
  v_queue_name     constant text    := 'phone.dial';
  v_job_max_attempts constant integer := 5;
begin
  -- ── LOCK 1: the global admission serialiser, FIRST statement ───────
  -- Before any `select ... for update`. The inverse order deadlocks with
  -- two concurrent admissions; see the file header.
  perform pg_advisory_xact_lock(hashtext('phone_admission'));

  -- ── LOCK 1b (0045): the CANDIDATE serialiser ───────────────────────
  -- Taken immediately after the global one and before any row lock, so
  -- the pinned order is preserved and the pair can never deadlock: no two
  -- admissions hold lock 1 at once, so lock 1b is never contended today.
  --
  -- It is taken anyway, and deliberately. The per-candidate guard below
  -- is a read-then-decide, and its atomicity currently rests ENTIRELY on
  -- the global serialiser. Narrowing that serialiser for throughput is an
  -- obvious future optimisation, and if it happens this guard must not
  -- silently lose the atomicity it depends on. One advisory lock is the
  -- cost of making that safe to do later.
  --
  -- Keyed by the CANDIDATE, resolved before the engagement row is read,
  -- because the whole point of the guard is that one person may hold more
  -- than one engagement.
  -- The two-int4 form. `hashtext` returns int4; `hashtextextended` returns
  -- int8 and narrowing it would risk an overflow on a value chosen by no
  -- one. The classifier half is a constant, so this lock can never collide
  -- with `hashtext('phone_admission')` on a different key space.
  --
  -- The candidate id comes from an UNLOCKED read, exactly like the
  -- `application_link_id` read a few lines below: it takes no row lock, so
  -- the pinned order still holds. An engagement that does not exist hashes
  -- the empty string and is refused by `not_found` moments later.
  perform pg_advisory_xact_lock(
    hashtext('phone_candidate'),
    hashtext(coalesce(
      (select candidate_id::text from screening_v2.phone_engagements
        where id = p_engagement_id), ''))
  );

  if p_kind is null or p_kind not in ('initial','no_answer_retry','reconnect','scheduled') then
    return jsonb_build_object('status', 'invalid_kind');
  end if;

  -- Unlocked read: takes NO row lock, so the pinned order still holds.
  -- It exists only because the link id is reachable solely through the
  -- engagement row.
  select application_link_id into v_link_id
    from screening_v2.phone_engagements
   where id = p_engagement_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- ── LOCK 2: the application link ───────────────────────────────────
  select * into v_link
    from screening_v2.ashby_application_links
   where id = v_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'application_not_found');
  end if;

  -- ── LOCK 3: the engagement ─────────────────────────────────────────
  select * into v_eng
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- ── The application must still be live and still mapped in ─────────
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'application_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;
  if v_link.lifecycle in ('completed','cancelled') then
    return jsonb_build_object('status', 'application_not_live',
                              'lifecycle', v_link.lifecycle);
  end if;

  select * into v_map
    from screening_v2.ashby_job_mappings
   where id = v_link.job_mapping_id;
  if not found or v_map.status <> 'enabled' then
    return jsonb_build_object('status', 'mapping_not_enabled',
                              'mapping_status', coalesce(v_map.status, 'missing'));
  end if;

  -- Resume-backed applications only: an application with no resume file
  -- handle has no ingestion to be ready, and is not phone-eligible here.
  if v_link.external_resume_file_handle is null then
    return jsonb_build_object('status', 'ingestion_not_ready', 'ingestion_state', 'absent');
  end if;
  select state into v_ing_state
    from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link_id;
  if v_ing_state is distinct from 'ready' then
    return jsonb_build_object('status', 'ingestion_not_ready',
                              'ingestion_state', coalesce(v_ing_state, 'absent'));
  end if;

  -- ── The engagement must be in an admissible state for this kind ────
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state not in ('eligible','scheduled','reconnecting') then
    return jsonb_build_object('status', 'state_not_admissible', 'state', v_eng.state);
  end if;
  if (v_eng.state = 'reconnecting') <> (p_kind = 'reconnect')
     or (v_eng.state = 'scheduled')  <> (p_kind = 'scheduled') then
    return jsonb_build_object('status', 'kind_not_admissible',
                              'state', v_eng.state, 'kind', p_kind);
  end if;

  -- ── Consent: the LATEST record, fail-closed on every negative ──────
  -- Layer 1 of the two-layer consent model. The in-call spoken
  -- disclosure is notice plus a right of refusal (P4); it is not this.
  select * into v_consent
    from screening_v2.consent_records
   where candidate_id = v_eng.candidate_id
   order by created_at desc, id desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'consent_missing');
  end if;
  if v_consent.status <> 'granted' then
    return jsonb_build_object('status', 'consent_not_granted',
                              'consent_status', v_consent.status);
  end if;
  if v_consent.expires_at is not null and v_consent.expires_at <= p_now then
    return jsonb_build_object('status', 'consent_expired');
  end if;
  select required_consents into v_required
    from screening_v2.consent_templates
   where is_active
   order by updated_at desc, id desc
   limit 1;
  if v_required is null then
    return jsonb_build_object('status', 'consent_template_inactive');
  end if;
  if not (v_required <@ v_consent.consents) then
    return jsonb_build_object('status', 'consent_subset_missing');
  end if;

  -- ── A dialable Indian mobile, read from the candidate model only ───
  -- The number is never copied into a phone table, a payload, an audit
  -- row or a log line. It is read here and turned straight into a digest.
  select phone_e164, phone_valid into v_phone, v_phone_valid
    from screening_v2.candidates
   where id = v_eng.candidate_id;
  if not coalesce(v_phone_valid, false) or v_phone is null
     or v_phone !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('status', 'phone_invalid');
  end if;

  v_digest := screening_v2.sha256_hex(v_phone);
  if exists (select 1 from screening_v2.phone_suppressions
              where phone_sha256 = v_digest) then
    return jsonb_build_object('status', 'suppressed');
  end if;

  -- ── The kill switch. Read OUTSIDE any exception handler ────────────
  -- No `begin ... exception` wraps this read, and none appears anywhere
  -- above it in this body — asserted structurally in policy_tests.sql.
  -- Swallowing the read is exactly how a halt becomes fail-open, and a
  -- fail-open kill switch on a billable dialer is a defect. A MISSING
  -- singleton is a STOP.
  select halted_at into v_halted_at
    from screening_v2.phone_control
   where control_key = 'default'
   for share;
  v_ctl_found := found;
  if not v_ctl_found then
    return jsonb_build_object('status', 'halt_unreadable');
  end if;
  if v_halted_at is not null then
    return jsonb_build_object('status', 'halted');
  end if;

  -- ── The window, re-evaluated at the moment of dialling ─────────────
  if not screening_v2.phone_ist_window_open(p_now) then
    return jsonb_build_object('status', 'window_closed');
  end if;

  if v_eng.next_eligible_at is not null and v_eng.next_eligible_at > p_now then
    return jsonb_build_object('status', 'not_yet_eligible',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;

  -- ── Budgets: checked, never charged, here ──────────────────────────
  if p_kind in ('initial','no_answer_retry','scheduled')
     and v_eng.no_answer_attempts >= 3 then
    return jsonb_build_object('status', 'no_answer_budget_exhausted',
                              'no_answer_attempts', v_eng.no_answer_attempts);
  end if;
  -- There is deliberately NO reconnect-budget refusal here. The budget
  -- is spent at the GRANT (apply_phone_event #19), so an engagement
  -- sitting in `reconnecting` is by construction one whose reconnect has
  -- already been charged and is now being redeemed. Refusing it at
  -- admission would strand the engagement in `reconnecting` for ever
  -- with no edge out — the budget would be enforced by wedging the row
  -- rather than by ending it. Exhaustion is terminal, decided at the
  -- fourth drop (#21), and `kind_not_admissible` above already refuses a
  -- reconnect from any other state.

  v_ist_date := screening_v2.phone_ist_date(p_now);
  if p_kind in ('initial','no_answer_retry','scheduled')
     and exists (select 1 from screening_v2.phone_call_attempts
                  where engagement_id = p_engagement_id
                    and ist_date = v_ist_date
                    and kind in ('initial','no_answer_retry','scheduled')) then
    return jsonb_build_object('status', 'daily_attempt_exists', 'ist_date', v_ist_date);
  end if;

  -- ── 0045: THE PER-CANDIDATE GUARDS ────────────────────────────────
  -- Every anti-harassment index in 0042 is keyed by ENGAGEMENT, and a
  -- person is not. `uq_phone_engagements_application` keys an engagement
  -- to an application link and `idx_phone_engagements_candidate` is
  -- deliberately not unique, so one person applying to two roles holds two
  -- engagements — two independent budgets, two independent IST-day slots,
  -- and, before this guard, two admissions that both succeeded. The
  -- advisory lock serialised them and refused neither. One phone rang
  -- twice, possibly at once.
  --
  -- This is the guard that makes the cross-replica claim true. The P5
  -- runtime's own `offeredCandidates` set bounds the hazard to one pass in
  -- one process; only a check INSIDE admission, under the lock, bounds it
  -- across passes and across replicas.
  --
  -- Guard A — nobody is on the phone with this person right now.
  if exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.state in ('admitted','ringing','answered_unclassified','human','machine')
       and a.lease_expires_at > p_now
  ) then
    return jsonb_build_object('status', 'candidate_call_in_flight');
  end if;

  -- Guard B — this person has not already been called today, on ANY
  -- engagement. Scoped to the day-consuming kinds exactly as the
  -- per-engagement index is, so `reconnect` is excluded by the same
  -- construction: a reconnect redeems a budget already charged at the
  -- grant and must not be refused by a daily counter.
  if p_kind in ('initial','no_answer_retry','scheduled')
     and exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind in ('initial','no_answer_retry','scheduled')
  ) then
    return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                              'ist_date', v_ist_date);
  end if;

  -- ── The fleet cap: a DB-derived count, never a stored counter ──────
  -- Counted under the advisory lock, over live states holding an
  -- UNEXPIRED lease. A lease that is not actively renewed by P5's
  -- heartbeat expires and frees its slot; that is a stated dependency,
  -- not a hidden one.
  select count(*) into v_live
    from screening_v2.phone_call_attempts
   where state in ('admitted','ringing','answered_unclassified','human','machine')
     and lease_expires_at > p_now;
  if v_live >= v_max_concurrent then
    return jsonb_build_object('status', 'at_capacity', 'live', v_live,
                              'max_concurrent', v_max_concurrent);
  end if;

  -- ── Everything below is one transaction: attempt + lease + job ─────
  select coalesce(max(attempt_seq), 0) + 1 into v_seq
    from screening_v2.phone_call_attempts
   where engagement_id = p_engagement_id;

  v_lease_token   := gen_random_uuid();
  v_lease_expires := p_now + (greatest(5, least(coalesce(p_lease_seconds, 60), 900))
                              * interval '1 second');

  begin
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, ist_date,
       prior_engagement_state, lease_token, lease_owner, lease_expires_at,
       admitted_at, created_at)
    values
      (p_engagement_id, v_seq, v_eng.epoch, p_kind, 'admitted', v_ist_date,
       v_eng.state, v_lease_token, p_lease_owner, v_lease_expires,
       p_now, p_now)
    returning id into v_attempt_id;
  exception
    -- The ONLY handled condition, and it is handled narrowly. Two
    -- different indexes can raise it and they mean different things, so
    -- the constraint name is read rather than guessed: reporting a
    -- same-day race as an in-flight attempt would send an operator
    -- looking for a call that is not happening.
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'uq_phone_attempts_one_per_ist_day' then
        return jsonb_build_object('status', 'daily_attempt_exists',
                                  'ist_date', v_ist_date);
      end if;
      return jsonb_build_object('status', 'attempt_in_flight',
                                'constraint', v_constraint);
  end;

  update screening_v2.phone_call_attempts
     set participant_identity = 'phone-' || v_attempt_id::text
   where id = v_attempt_id;

  update screening_v2.phone_engagements
     set state             = 'dialing',
         state_reason      = null,
         last_attempt_at   = p_now,
         -- Pin WHICH consent record authorised this dial, so the
         -- authority for a call is auditable after the fact rather than
         -- re-derived from whatever the latest record happens to be.
         consent_record_id = v_consent.id,
         version           = version + 1,
         updated_at        = p_now
   where id = p_engagement_id;

  -- ── Queue admission, in this SAME transaction ──────────────────────
  -- The 0040 shape verbatim: untargeted `on conflict do nothing` so the
  -- guard covers every unique index, a read-back of a CLAIMABLE job when
  -- the insert is skipped, and a fail-closed raise when neither exists.
  -- Returning `ok` must mean live work exists.
  --
  -- The dedup key is ATTEMPT-scoped, so it is unique by construction and
  -- `uq_job_queue_dedup_active` is only a secondary guard; a stale
  -- engagement-scoped key could otherwise wedge an engagement forever.
  -- The payload is camelCase because that is what the handler will read;
  -- snake_case dead-letters the job as a malformed payload — the
  -- documented 0040 trap. It carries an opaque attempt id and nothing
  -- else: no phone number, no name, no provider field, no token, no URL.
  v_dedup_key := 'phone.dial:' || v_attempt_id::text;

  insert into screening_v2.job_queue
    (name, payload, status, dedup_key,
     attempts, max_attempts, priority, scheduled_at, created_at)
  values
    (v_queue_name,
     jsonb_build_object('provider', 'phone', 'attemptId', v_attempt_id),
     'pending',
     v_dedup_key,
     0, v_job_max_attempts, 0, p_now, p_now)
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select id into v_job_id
      from screening_v2.job_queue
     where name = v_queue_name
       and dedup_key = v_dedup_key
       and status in ('pending', 'delayed')
     limit 1;
    if v_job_id is null then
      -- Fail CLOSED. Aborting rolls back the attempt, the lease, the
      -- engagement transition and the audit row together, so the
      -- engagement rests truthfully in its prior state with every budget
      -- intact and its future eligibility unchanged. An admission that
      -- cannot schedule work must not report that it did.
      raise exception 'phone_dial_enqueue_failed'
        using errcode = 'data_exception',
              detail  = 'no live phone.dial job could be admitted';
    end if;
  end if;

  -- The slot that authorised this dial has been spent. `fulfilled` is
  -- written HERE, at the dial, rather than at the answer: the slot's job
  -- was to authorise a call at a time the candidate agreed to, and that
  -- job is done the moment the call is admitted. What the call then does
  -- is the attempt's business, and the attempt records it. Leaving the
  -- slot live instead would keep a stale entry on HR's calendar and push
  -- every later booking down the supersede path.
  if p_kind = 'scheduled' then
    update screening_v2.phone_appointments
       set status     = 'fulfilled',
           version    = version + 1,
           updated_at = p_now
     where engagement_id = p_engagement_id
       and status in ('scheduled', 'confirmed')
    returning id into v_apt_id;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    -- A worker/domain action: the documented all-zero system sentinel
    -- with actor_type 'system' (the 0024 precedent), never a human
    -- identity. OPERATOR actions — the halt RPCs, and a calendar action
    -- with a named actor — use actor_type 'recruiter' with the admin
    -- identity in actor_id, falling back to the house recruiter sentinel
    -- 00000000-0000-4000-8000-000000000001 (the 0035/0040/0041
    -- precedent). Two sentinels because there are two actor types, and
    -- chk_audit_actor_type is what makes the distinction load-bearing.
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_attempt_admitted', 'phone_call_attempt', v_attempt_id::text, 'success',
     -- Opaque ids and stable codes only. No number, no digest, no
     -- provider field, no lease token.
     jsonb_build_object('engagement_id', p_engagement_id,
                        'attempt_seq', v_seq,
                        'kind', p_kind,
                        'epoch', v_eng.epoch,
                        'ist_date', v_ist_date,
                        'live_before', v_live,
                        'max_concurrent', v_max_concurrent,
                        'fulfilled_appointment', v_apt_id is not null));

  return jsonb_build_object('status', 'ok',
                            'attempt_id', v_attempt_id,
                            'attempt_seq', v_seq,
                            'kind', p_kind,
                            'epoch', v_eng.epoch,
                            'ist_date', v_ist_date,
                            'lease_token', v_lease_token,
                            'lease_expires_at', v_lease_expires,
                            'live_before', v_live);
end;
$$;
revoke all on function screening_v2.admit_phone_attempt(uuid, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.admit_phone_attempt(uuid, text, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.admit_phone_attempt is
  'RPC-authoritative admission. Since 0045 it also refuses a dial to a person '
  'who is already on a call through ANOTHER engagement '
  '(candidate_call_in_flight) or who has already been called today through '
  'one (candidate_daily_attempt_exists) — every 0042 index is keyed by '
  'engagement, and a person is not. Both refusals are free. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. The stranded-session resolution
-- ═══════════════════════════════════════════════════════════════════════
-- An engagement can be left non-terminal while the session it is bound to
-- has already ended. Before 0045's heartbeat the normal route was a
-- mid-call lease reclaim; the residual route is any crash between the
-- session ending and the engagement hearing about it.
--
-- The symptom is the worst kind: SILENT. The engagement sits in
-- `eligible` pointing at a `completed` session, so `ensureSession` takes
-- the `existingSessionId` branch, finds a terminal status, refuses, and
-- the row is skipped `no_session` on every pass for ever. A screening
-- that was conducted, persisted and scored never reaches the engagement
-- and never writes back.
--
-- Two edges close it, and BOTH are interlocked:
--   * a session that is terminal AND has a `source='phone'` assessment
--     row completes the engagement — the truth, and no phone rings;
--   * a session that is terminal WITHOUT one fails it truthfully. Not
--     `cancelled`, which would claim a decision nobody made.
--
-- The trigger's allowlist is widened for exactly these targets. That is
-- the safety-relevant part of this migration, so the interlocks are
-- stated at the trigger too: without them the widened allowlist would let
-- any writer terminate an engagement merely waiting its turn.
create or replace function screening_v2.enforce_phone_engagement_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  allowed text[];
begin
  -- TERMINAL MEANS TERMINAL, and it is checked before the same-state
  -- shortcut below. Guarding only `state` would leave a finished
  -- engagement's budgets, next_eligible_at and consent_record_id
  -- writable — a narrower guarantee than the word "immutable", and one
  -- a reader would not expect to have to check. No RPC in this file
  -- updates a terminal row; this makes that a property of the schema
  -- rather than a property of the current callers.
  --
  -- KNOWN CONSEQUENCE, stated where it bites: a referential SET NULL is
  -- an UPDATE, so this refusal also blocks deleting the `roles` or
  -- `call_sessions` row a TERMINAL engagement points at — its two
  -- `on delete set null` FKs behave as `restrict` once it is terminal,
  -- and the error names the engagement rather than the row being
  -- deleted. See the file header for the erasure order that satisfies
  -- this and the ledger's insert-once guard together.
  if old.terminal_at is not null and new is distinct from old then
    raise exception 'phone engagement % is terminal (%) and immutable', old.id, old.state
      using errcode = 'P0001';
  end if;

  if old.state = new.state then
    return new;   -- idempotent no-op (#14/#16 and every retry)
  end if;
  case old.state
    when 'pending_prereqs' then allowed := array['eligible','cancelled'];
    -- 0045 added `completed` and `failed` to these three. They are
    -- reachable ONLY through the stranded-session resolution in
    -- `apply_phone_event`, which requires the engagement to hold a bound
    -- session that is ALREADY TERMINAL, and — for `completed` — requires a
    -- real `source='phone'` assessment row to exist. Widening the
    -- allowlist without those interlocks would let any writer terminate an
    -- engagement that is merely waiting its turn; with them, the only
    -- thing these edges can do is tell an engagement the truth about a
    -- conversation that already happened.
    when 'eligible'        then allowed := array['dialing','scheduled','cancelled',
                                                 'completed','failed'];
    when 'scheduled'       then allowed := array['dialing','eligible','cancelled',
                                                 'completed','failed'];
    when 'dialing'         then allowed := array[
      'in_call','awaiting_retry','eligible','scheduled','reconnecting',
      -- The no-answer charge that lands on 3 goes straight to the
      -- terminal state; there is no honest `awaiting_retry` for an
      -- engagement with nothing left to retry.
      'abandoned_no_answer',
      'opted_out','wrong_number','failed','cancelled'];
    when 'in_call'         then allowed := array[
      'reconnecting','scheduled','completed','failed','opted_out','wrong_number','cancelled',
      -- A conversation whose worker died mid-call: the sweeper abandons
      -- the attempt and restores the state the attempt was admitted
      -- from. Without this edge the engagement is stranded `in_call`
      -- with no live attempt and no event that can ever move it — the
      -- PR #70 wedge wearing a different name.
      'eligible'];
    when 'reconnecting'    then allowed := array['dialing','scheduled','eligible','failed',
                                                 'cancelled','completed'];
    when 'awaiting_retry'  then allowed := array[
      'eligible','abandoned_no_answer','cancelled',
      -- Booking a callback after a missed call is the single most
      -- ordinary use of the internal calendar. Without this edge
      -- schedule_phone_appointment raised P0001 on it.
      'scheduled'];
    -- Every terminal state: no outgoing edge at all.
    else allowed := '{}'::text[];
  end case;
  if not (new.state = any(allowed)) then
    raise exception 'invalid phone engagement transition % -> %', old.state, new.state
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function screening_v2.enforce_phone_engagement_transition is
  'Enforces the legal phone_engagements state machine on UPDATE; same-state is '
  'a no-op and a terminal row admits no change at all. Widened by 0045 so '
  'eligible/scheduled/reconnecting may reach completed or failed — edges '
  'reachable only through the stranded-session resolution, which requires an '
  'already-terminal bound session and, for completed, a real phone assessment '
  'row.';
create or replace function screening_v2.apply_phone_event(
  p_source            text,
  p_event_type        text,
  p_attempt_id        uuid        default null,
  p_engagement_id     uuid        default null,
  p_provider_event_id text        default null,
  p_epoch             integer     default null,
  p_metadata          jsonb       default null,
  p_now               timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att        screening_v2.phone_call_attempts%rowtype;
  v_eng        screening_v2.phone_engagements%rowtype;
  v_eng_id     uuid;
  v_subject    text;
  v_event_id   text;
  v_ignored    text;
  v_new_state  text;        -- engagement target, null = no engagement change
  v_att_state  text;        -- attempt target, null = no attempt change
  v_outcome    text;
  v_charge     text;        -- 'no_answer' | 'reconnect' | 'provider' | null
  v_reason     text;
  v_bump_epoch boolean := false;
  v_defer      boolean := false;
  v_row_id     uuid;
  v_existing   screening_v2.phone_call_events%rowtype;
  v_slot_start timestamptz;
  v_metadata   jsonb;
  v_phone      text;
  v_digest     text;
  v_suppressed boolean := false;
  v_defer_at   timestamptz;
  -- 0044: set by the one edge whose claim must be backed by a real score.
  v_needs_assessment boolean := false;
  -- 0045: the engagement is non-terminal but its session has already ended.
  v_stranded         boolean := false;
begin
  if p_source is null or p_source not in
     ('livekit_webhook','provider_callback','provider_poll','internal','reconciliation') then
    return jsonb_build_object('status', 'invalid_source');
  end if;

  -- Unsanitized metadata is DROPPED, not stored and not fatal. Refusing
  -- the whole call would lose the event, and the ledger exists to record
  -- events; storing it would durably persist a provider envelope on an
  -- append-only table. The replacement marker says plainly that
  -- something was discarded, so this is visible rather than silent.
  v_metadata := case
    when screening_v2.phone_event_metadata_sanitized(p_metadata) then p_metadata
    else jsonb_build_object('metadata_rejected', true)
  end;
  if p_event_type is null or p_event_type !~ '^[a-z][a-z0-9_.]{1,63}$' then
    return jsonb_build_object('status', 'invalid_event_type');
  end if;

  -- ── Resolve the subject, taking locks in the pinned order ──────────
  if p_attempt_id is not null then
    select engagement_id into v_eng_id
      from screening_v2.phone_call_attempts where id = p_attempt_id;
  else
    v_eng_id := p_engagement_id;
  end if;

  if v_eng_id is not null then
    select * into v_eng from screening_v2.phone_engagements
     where id = v_eng_id for update;
    if not found then
      v_eng_id := null;
    end if;
  end if;

  -- ── 0045: IS THIS ENGAGEMENT STRANDED? ─────────────────────────────
  -- A conversation that ended while nobody was holding the engagement in
  -- `in_call`. Before 0045's heartbeat the normal way to get here was a
  -- mid-call lease reclaim: the sweep restored `prior_engagement_state`
  -- (always one of these three) while the agent talked on, and the
  -- agent's eventual `assessment.completed` then hit an `in_call` guard
  -- that no longer held and was ignored as `unexpected_event`. The
  -- screening was conducted, persisted and SCORED, and the engagement
  -- never heard about it.
  --
  -- All three conditions are load-bearing:
  --   * one of the three states the reclaimer can restore — NOT any
  --     non-terminal state, because `dialing` and `pending_prereqs` have
  --     no ended conversation behind them;
  --   * a bound session, since an engagement with no `session_id` has
  --     nothing to be stranded BY;
  --   * that session already TERMINAL. Without this a stray
  --     `assessment.aborted` could terminate an `eligible` engagement
  --     that is merely waiting its turn to be dialled.
  --
  -- The read is UNLOCKED. `call_sessions` is last in the pinned lock
  -- order, so taking no lock here cannot close a cycle, and the value is
  -- only ever used to permit a refusal-free transition that a separate
  -- interlock re-checks.
  if v_eng_id is not null
     and v_eng.terminal_at is null
     and v_eng.state in ('eligible','scheduled','reconnecting')
     and v_eng.session_id is not null then
    select exists (
      select 1 from screening_v2.call_sessions s
       where s.id = v_eng.session_id
         and s.status in ('completed','failed','cancelled','expired')
    ) into v_stranded;
  end if;
  if p_attempt_id is not null and v_eng_id is not null then
    select * into v_att from screening_v2.phone_call_attempts
     where id = p_attempt_id for update;
  end if;

  -- ── The deterministic synthetic id ─────────────────────────────────
  -- provider_event_id is NOT NULL on the table, because a unique index
  -- over a nullable column does not dedup and the non-provider channels
  -- are exactly the ones that recover a dropped webhook.
  v_subject := coalesce(p_attempt_id::text, v_eng_id::text, 'unbound');
  if p_provider_event_id is not null then
    v_event_id := p_provider_event_id;
  elsif p_source = 'internal' then
    v_event_id := 'internal:' || v_subject || ':' || p_event_type
                  || ':' || coalesce(p_epoch, -1)::text;
  elsif p_source = 'provider_poll' then
    v_event_id := 'poll:' || v_subject || ':' || p_event_type;
  elsif p_source = 'reconciliation' then
    v_event_id := 'recon:' || v_subject || ':' || p_event_type;
  else
    -- A webhook or provider callback with no provider id is not
    -- dedupable and must not be silently invented.
    return jsonb_build_object('status', 'provider_event_id_required');
  end if;
  if v_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$' then
    return jsonb_build_object('status', 'invalid_provider_event_id');
  end if;

  -- ── The verdict, decided BEFORE anything is written ────────────────
  if v_eng_id is null or (p_attempt_id is not null and v_att.id is null) then
    v_ignored := 'unknown_attempt';
  elsif v_eng.terminal_at is not null then
    v_ignored := 'terminal';
  -- Fencing must not be optional. An ingress that omits its epoch is
  -- fenced against the epoch stored ON THE ATTEMPT, which #18 keeps in
  -- step with the engagement's. Without this fallback a callback
  -- belonging to a superseded conversation and carrying no epoch applied
  -- against the NEW one — charging a reconnect on a call still up.
  elsif coalesce(p_epoch, v_att.epoch) is not null
        and coalesce(p_epoch, v_att.epoch) < v_eng.epoch then
    v_ignored := 'stale_epoch';
  else
    case
      -- ── from `dialing` ──────────────────────────────────────────────
      when v_eng.state = 'dialing' and p_event_type = 'sip.participant_joined' then
        -- #14. JOIN IS NOT ANSWER. The SIP leg being up says nothing
        -- about who, or what, is on it. No assessment, no egress, no
        -- agent speech may follow from this state.
        v_att_state := 'answered_unclassified';
      when v_eng.state = 'dialing' and p_event_type = 'classify.human' then
        v_att_state := 'human';                                        -- #16
      when v_eng.state = 'dialing' and p_event_type = 'classify.machine' then
        -- #15. A voicemail must produce NO scored session: it charges a
        -- no-answer attempt, never a reconnect, and the attempt ends.
        v_att_state := 'ended'; v_outcome := 'voicemail'; v_charge := 'no_answer';
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_rejected_busy' then
        v_att_state := 'ended'; v_outcome := 'busy'; v_charge := 'no_answer';   -- #11
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_timeout' then
        v_att_state := 'ended'; v_outcome := 'no_answer'; v_charge := 'no_answer'; -- #12
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_rejected_transport' then
        v_att_state := 'ended'; v_outcome := 'provider_error'; v_charge := 'provider'; -- #13
      when v_eng.state = 'dialing' and p_event_type = 'disclosure.refused' then
        -- #17. Terminal, and the purge/suppression that must accompany
        -- it is P4's transaction, not this one.
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';
        v_reason := 'disclosure_refused';
      when v_eng.state = 'dialing' and p_event_type = 'disclosure.delivered' then
        -- #18. The ONLY place a conversation begins: bump the fencing
        -- epoch and reset the reconnect budget for the new conversation.
        v_new_state := 'in_call'; v_bump_epoch := true;
      when v_eng.state = 'dialing' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number';
        v_reason := 'wrong_number';

      -- ── from `dialing`, ANSWERED but PRE-DISCLOSURE (0043 / P3-1) ───
      -- The gap P3 recorded and could not close: a candidate who PICKS UP
      -- and hangs up before `disclosure.delivered` left the engagement in
      -- `dialing` with the attempt in `answered_unclassified`/`human` and
      -- NO legal edge, so the drop was recorded as `unexpected_event` and
      -- the outcome was unrecorded rather than classified.
      --
      -- Three things make this branch truthful rather than convenient:
      --
      --   * IT IS GATED ON THE ATTEMPT, NOT THE ENGAGEMENT. `dialing`
      --     OUTLIVES THE ANSWER (0042 #14: join is not answer), so the
      --     engagement state alone cannot tell a leg that rang out from a
      --     leg somebody picked up. Only `answered_unclassified` and
      --     `human` reach here; `admitted`/`ringing` fall through to the
      --     §4 default exactly as before. Calling an unanswered drop
      --     "abandoned" would be the mirror of the P3 HIGH that called an
      --     answered call `no_answer`.
      --   * IT CHARGES NOTHING. No no-answer budget, no reconnect budget,
      --     no provider budget. A hangup during our own identity line is
      --     not evidence the line is bad, and a reconnect grant is exactly
      --     what `reconnects_used` records -- an "uncharged reconnect" is
      --     not a thing. The engagement returns to `eligible`, a legal
      --     edge out of `dialing`.
      --   * IT IS BOUNDED BY AN INDEX THAT ALREADY EXISTS, not by a new
      --     counter. The attempt keeps today's `ist_date` and its
      --     `initial`/`no_answer_retry`/`scheduled` kind, so
      --     `uq_phone_attempts_one_per_ist_day` refuses the next admission
      --     with `daily_attempt_exists` until the IST day rolls. A gating
      --     counter with no reset lifecycle is the one-way latch this
      --     project has already paid for twice; the per-day index needs no
      --     lifecycle because the day supplies it.
      --
      -- `next_eligible_at` is moved to the next legal instant on the next
      -- IST day for the same reason the provider path does it: the row
      -- must say out loud when it may next be tried rather than looking
      -- eligible now and being refused by an index.
      --
      -- `candidate.deferred_pre_disclosure` is the THIRD member and the one
      -- that is not a hangup: the candidate answered, said "call me later",
      -- and asked for it BEFORE the disclosure. It shares this branch because
      -- it shares every property that matters -- the attempt ends, nothing is
      -- charged, and the engagement leaves `dialing` for a legal state. It is
      -- a DISTINCT event type rather than a reused `sip.participant_left`
      -- because posting "the participant left" about somebody still holding
      -- the handset would be false, and the ledger is the place an operator
      -- goes to find out what actually happened.
      --
      -- It exists because `schedule_phone_appointment` refuses outright while
      -- the engagement is `dialing` (`attempt_in_flight`) -- a live dial owns
      -- the engagement, and rescheduling under it would put the calendar and
      -- the wire into disagreement. So a pre-disclosure "later" must FIRST
      -- end the attempt truthfully and uncharged, and only then book from a
      -- legal state. The alternative -- relaxing the guard -- would trade a
      -- real invariant for the convenience of one code path.
      --
      -- Idempotency needs no special handling. A redelivery carrying the
      -- same `provider_event_id` hits `uq_phone_call_events_provider` and
      -- is answered with the ORIGINAL verdict; a genuinely distinct second
      -- event finds the engagement in `eligible`, matches no branch and is
      -- recorded as `unexpected_event`. Neither loops.
      when v_eng.state = 'dialing'
           and p_event_type in ('sip.participant_left','sip.connection_aborted',
                                'candidate.deferred_pre_disclosure')
           and v_att.state in ('answered_unclassified','human') then
        v_att_state := 'ended'; v_outcome := 'abandoned_pre_disclosure';
        v_new_state := 'eligible'; v_reason := 'abandoned_pre_disclosure';
        v_defer_at  := screening_v2.phone_next_window_open(
                         (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                           at time zone 'Asia/Kolkata');

      -- ── from `in_call` ──────────────────────────────────────────────
      when v_eng.state = 'in_call'
           and p_event_type in ('sip.participant_left','sip.connection_aborted') then
        v_att_state := 'ended'; v_outcome := 'disconnected';
        if v_eng.reconnects_used >= 3 then
          -- #21. Three reconnects have already been GRANTED and used;
          -- this drop earns no fourth. Terminal, and no further charge —
          -- `reconnecting` with an unredeemable budget would be a state
          -- with no outgoing edge and nothing left to drive it.
          v_new_state := 'failed'; v_reason := 'reconnect_budget_exhausted';
        elsif screening_v2.phone_ist_window_open(p_now) then
          -- #19. The charge happens HERE, at the grant, not at the dial:
          -- `reconnects_used` counts drops that have been granted a
          -- reconnect, and the grant that takes it to 3 is precisely the
          -- one being redeemed by the next admission.
          v_new_state := 'reconnecting'; v_charge := 'reconnect';
        else
          -- #20. The boundary is evaluated when the reconnect would be
          -- ACTED ON, not when the disconnect happened. A wait outside
          -- the window charges NOTHING and is deferred to a real slot.
          v_new_state := 'scheduled'; v_defer := true; v_reason := 'window_closed';
        end if;
      -- ── THE STRANDED PATH SETS NO ATTEMPT EDGE ─────────────────
      -- `v_att_state := 'ended'` is right for `in_call`: there is a live
      -- attempt and this event ends it. On the STRANDED path there is no
      -- attempt at all — the sweep posts by ENGAGEMENT, because the
      -- attempt that carried the conversation was reclaimed and ended long
      -- ago. Setting an attempt edge anyway made every stranded post fail
      -- the `attempt_required` guard below, so the whole resolution was
      -- dead code that still reported a healthy sweep. A real-Postgres
      -- test is what caught it; nothing in the SQL reads wrong.
      when (v_eng.state = 'in_call' or v_stranded)
           and p_event_type = 'assessment.completed' then
        -- #22, WITH THE 0044 INTERLOCK (enforced below, before the insert).
        --
        -- 0045 widened the guard to the STRANDED states. This cannot
        -- fabricate a completion: the interlock below still refuses unless
        -- a `source='phone'` assessment row actually exists for the bound
        -- session, so the only engagements this can complete are ones that
        -- really were screened and really were scored. That is the whole
        -- point — a scored screening must reach its engagement without
        -- anybody's phone ringing a second time.
        v_new_state := 'completed';
        v_needs_assessment := true;
        if not v_stranded then
          v_att_state := 'ended'; v_outcome := 'completed';
        end if;
      when (v_eng.state = 'in_call' or v_stranded)
           and p_event_type = 'assessment.aborted' then
        -- Every other `ended` path names an outcome; an operator
        -- filtering on outcome_class must not lose these rows.
        v_new_state := 'failed';
        v_reason := 'assessment_aborted';
        if not v_stranded then
          v_att_state := 'ended'; v_outcome := 'disconnected';
        end if;
      when v_eng.state = 'in_call' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number'; -- #23
        v_reason := 'wrong_number';
      when v_eng.state = 'in_call' and p_event_type = 'candidate.opt_out' then
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24
        v_reason := 'candidate_opt_out';

      -- ── from `awaiting_retry` ───────────────────────────────────────
      -- #28 has no branch here on purpose. The no-answer charge that
      -- lands on 3 goes STRAIGHT to `abandoned_no_answer` (below), so an
      -- `awaiting_retry` engagement always has budget left and a
      -- `budget.exhausted` branch could never fire. An unreachable
      -- branch reads as a safety net and is not one.
      when v_eng.state = 'awaiting_retry' and p_event_type = 'day.rolled'
           and screening_v2.phone_ist_date(p_now)
               > screening_v2.phone_ist_date(coalesce(v_eng.last_attempt_at, p_now)) then
        v_new_state := 'eligible';                                      -- #27

      -- ── from `pending_prereqs` ──────────────────────────────────────
      when v_eng.state = 'pending_prereqs' and p_event_type = 'prereq.satisfied' then
        -- #2. Advisory only: every prerequisite is RE-CHECKED, under a
        -- lock, inside admit_phone_attempt. This edge cannot authorise a
        -- dial on its own.
        v_new_state := 'eligible';

      -- ── from any non-terminal state ─────────────────────────────────
      when p_event_type in ('hr.cancelled','emergency.stop','ashby.stage_left','prereq.lost') then
        v_new_state := 'cancelled';                                     -- #3 / #29
        v_reason    := replace(p_event_type, '.', '_');
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'cancelled';
        end if;

      else
        v_ignored := 'unexpected_event';                                -- the §4 default
    end case;
  end if;

  -- ── An engagement-scoped post cannot drive an attempt-scoped edge ──
  -- Both attempt writes below are guarded by `v_att.id is not null`, and
  -- a guard that SKIPS is not a guard: the engagement half of the
  -- transition would still be applied. `classify.machine` posted with
  -- only an engagement id would charge a no-answer attempt and move to
  -- `awaiting_retry` while leaving the attempt live and holding a fleet
  -- slot; `disclosure.delivered` would bump the engagement's epoch and
  -- not the attempt's, fencing out every later event on that attempt and
  -- leaving a conversation nothing could end.
  --
  -- So the requirement is decided WITH the verdict, before anything is
  -- written, and answered with a stable refusal. Nothing is recorded:
  -- this is a malformed call, not an event that happened.
  if v_ignored is null and v_att.id is null
     and (v_att_state is not null or v_bump_epoch) then
    return jsonb_build_object('status', 'attempt_required',
                              'event_type', p_event_type,
                              'engagement_state', v_eng.state);
  end if;

  -- ── 0044: A COMPLETION CLAIM MUST BE BACKED BY A REAL SCORE ────────
  -- `assessment.completed` takes the engagement to terminal `completed`
  -- with outcome_class = 'completed', which the engagement state, P6's
  -- health backlog and the P7 calendar queue all read as a SCORED
  -- screening. That claim is unrecoverable once committed, so it is
  -- checked here rather than trusted from the worker — the same reason
  -- 0043 put the disclosure gate in attach_phone_attempt_recording
  -- instead of in phone.py: a worker-side ordering rule survives exactly
  -- until someone reorders two awaits.
  --
  -- IT IS A PRE-INSERT REFUSAL, AND THAT IS THE WHOLE POINT. The
  -- `internal` source mints a DETERMINISTIC provider_event_id, so a
  -- recorded refusal would be read back verbatim by every later delivery
  -- of the same claim — and a worker that posted one moment too early
  -- could then never complete the call at all. Recording this would turn
  -- a retryable timing problem into a permanent wedge. So nothing is
  -- written, exactly as for `attempt_required` above, and a re-post once
  -- scoring has landed is a fresh event that applies.
  --
  -- Nothing is charged either: the engagement stays precisely where it
  -- was, with every budget untouched.
  if v_ignored is null and v_needs_assessment
     and (v_eng.session_id is null
          or not exists (
            select 1 from screening_v2.assessments a
             where a.session_id = v_eng.session_id
               and a.source = 'phone')) then
    return jsonb_build_object('status', 'assessment_missing',
                              'event_type', p_event_type,
                              'engagement_state', v_eng.state);
  end if;

  -- ── One INSERT, already carrying the final verdict ─────────────────
  insert into screening_v2.phone_call_events
    (source, provider_event_id, engagement_id, attempt_id, epoch, event_type,
     received_at, applied, ignored_reason, metadata, created_at)
  values
    (p_source, v_event_id,
     case when v_ignored = 'unknown_attempt' then null else v_eng_id end,
     case when v_ignored = 'unknown_attempt' then null else p_attempt_id end,
     p_epoch, p_event_type, p_now, v_ignored is null, v_ignored, v_metadata, p_now)
  on conflict do nothing
  returning id into v_row_id;

  if v_row_id is null then
    -- A duplicate delivery. Read back the ORIGINAL row and hand the
    -- caller exactly the answer the first delivery received, so a
    -- webhook retry storm converges instead of diverging.
    select * into v_existing from screening_v2.phone_call_events
     where source = p_source and provider_event_id = v_event_id;
    return jsonb_build_object(
      'status', case when v_existing.applied then 'applied' else 'ignored' end,
      'applied', v_existing.applied,
      'ignored_reason', v_existing.ignored_reason,
      'event_id', v_existing.id,
      'duplicate', true);
  end if;

  if v_ignored is not null then
    return jsonb_build_object('status', 'ignored', 'applied', false,
                              'ignored_reason', v_ignored,
                              'event_id', v_row_id, 'duplicate', false);
  end if;

  -- ── Apply. Budgets move HERE and nowhere else ──────────────────────
  if v_charge = 'no_answer' then
    if v_eng.no_answer_attempts + 1 >= 3 then
      v_new_state := 'abandoned_no_answer'; v_reason := 'no_answer_budget_exhausted';
    else
      v_new_state := 'awaiting_retry';
    end if;
  elsif v_charge = 'provider' then
    if v_eng.provider_failures + 1 >= 5 then
      v_new_state := 'failed'; v_reason := 'provider_budget_exhausted';
    else
      -- THE PROVIDER BUDGET IS PACED BY THE IST DAY, DELIBERATELY.
      -- The engagement returns to `eligible`, but the failed attempt
      -- keeps kind='initial'/'no_answer_retry' and today's ist_date, so
      -- uq_phone_attempts_one_per_ist_day refuses the next admission
      -- with `daily_attempt_exists` until the IST day rolls. Exhausting
      -- the five-failure budget therefore takes up to five IST days.
      --
      -- That is the choice, not an accident. The alternative — letting a
      -- provider error free the day — would mean an engagement could be
      -- dialled up to six times in one day whenever our transport was
      -- flaky, and the per-day index is an ANTI-HARASSMENT invariant.
      -- We cannot tell from a transport rejection whether the line rang;
      -- fail closed on that uncertainty, at the cost of throughput and
      -- never at the candidate's.
      --
      -- `next_eligible_at` is set to the next legal instant on the next
      -- IST day so the row says out loud when it may next be tried,
      -- rather than looking eligible now and being refused by an index.
      v_new_state := 'eligible';
      v_defer_at  := screening_v2.phone_next_window_open(
                       (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                         at time zone 'Asia/Kolkata');
    end if;
  end if;

  -- #18 bumps the engagement's fencing epoch; the LIVE attempt must
  -- carry the new value, or the fallback above would fence the very
  -- conversation that just started.
  if v_bump_epoch then
    update screening_v2.phone_call_attempts
       set epoch = v_eng.epoch + 1
     where id = v_att.id;
  end if;

  if v_att_state is not null then
    update screening_v2.phone_call_attempts
       set state         = v_att_state,
           outcome_class = coalesce(v_outcome, outcome_class),
           answered_at   = case when v_att_state = 'answered_unclassified'
                                then coalesce(answered_at, p_now) else answered_at end,
           classified_at = case when v_att_state in ('human','machine')
                                then coalesce(classified_at, p_now) else classified_at end,
           ended_at      = case when v_att_state = 'ended' then p_now else ended_at end,
           -- An ended attempt releases its fleet slot immediately; a
           -- freed slot must not wait for a lease to lapse.
           lease_token   = case when v_att_state = 'ended' then null else lease_token end,
           lease_owner   = case when v_att_state = 'ended' then null else lease_owner end
     where id = v_att.id;
  end if;

  -- #20: a window-closed reconnect is parked on a real, legal slot
  -- rather than on a state that merely claims to be scheduled.
  if v_defer then
    v_slot_start := screening_v2.phone_next_window_open(p_now);
    insert into screening_v2.phone_appointments
      (engagement_id, starts_at, ends_at, ist_date, status, source,
       created_by, created_at, updated_at)
    values
      (v_eng.id, v_slot_start, v_slot_start + interval '30 minutes',
       screening_v2.phone_ist_date(v_slot_start), 'scheduled', 'system_deferral',
       '00000000-0000-0000-0000-000000000000'::uuid, p_now, p_now)
    on conflict do nothing;
  end if;

  if v_new_state is not null then
    update screening_v2.phone_engagements
       set state           = v_new_state,
           state_reason    = coalesce(v_reason, state_reason),
           epoch           = case when v_bump_epoch then epoch + 1 else epoch end,
           -- THE reconnect budget. It is reset only when a genuinely NEW
           -- conversation begins — an `initial`, `no_answer_retry` or
           -- `scheduled` dial. Resetting it on a RECONNECT's disclosure
           -- would make "max 3 reconnects" unenforceable: every
           -- reconnect that reached in_call would zero the counter, so
           -- it could never exceed 1, the reconnect-exhaustion refusal
           -- and the #21 `failed` edge would both be dead code, and a
           -- flapping line could be re-dialled without limit. On a
           -- BILLABLE dialer that is the bound that must actually hold.
           reconnects_used = case
                               when v_bump_epoch
                                    and coalesce(v_att.kind, 'initial') <> 'reconnect'
                                 then 0
                               when v_charge = 'reconnect' then reconnects_used + 1
                               else reconnects_used end,
           no_answer_attempts = case when v_charge = 'no_answer'
                                     then no_answer_attempts + 1 else no_answer_attempts end,
           provider_failures  = case when v_charge = 'provider'
                                     then provider_failures + 1 else provider_failures end,
           terminal_at     = case
                               when v_new_state in ('completed','abandoned_no_answer',
                                                    'opted_out','wrong_number','failed','cancelled')
                               then p_now else null end,
           next_eligible_at = case
                                when v_defer then v_slot_start
                                when v_defer_at is not null then v_defer_at
                                else next_eligible_at end,
           version          = version + 1,
           updated_at       = p_now
     where id = v_eng.id;
  end if;
  -- There is deliberately no "charged but no state change" branch: every
  -- path that sets v_charge also sets v_new_state, so such a branch would
  -- be unreachable code pretending to be a safety net.

  -- ── Audit only the outcomes an operator must be able to find ───────
  if v_att_state in ('human','machine') then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_attempt_classified', 'phone_call_attempt', v_att.id::text, 'success',
       jsonb_build_object('engagement_id', v_eng.id, 'classification', v_att_state,
                          'event_type', p_event_type));
  end if;
  -- ── THE SUPPRESSION IS PART OF THE OPT-OUT, NOT A FOLLOW-UP ────────
  -- An opt-out modelled only on the engagement is enforced PER
  -- APPLICATION: the same person applying to a second role would be
  -- dialled again, because the second engagement has its own terminal
  -- state and knows nothing about the first. The obligation follows the
  -- LINE, so it is recorded against the line's digest, and it is
  -- recorded in THIS transaction — a terminal transition that commits
  -- without its suppression is the split this substrate exists to
  -- prevent, and a deferred obligation is documentation, not a control.
  if v_new_state in ('opted_out','wrong_number') then
    select phone_e164 into v_phone
      from screening_v2.candidates where id = v_eng.candidate_id;

    if v_phone is not null then
      v_digest := screening_v2.sha256_hex(v_phone);
      insert into screening_v2.phone_suppressions
        (candidate_id, phone_sha256, reason, source, created_at)
      values
        (v_eng.candidate_id, v_digest,
         case when v_new_state = 'opted_out' then 'candidate_opt_out' else 'wrong_number' end,
         'candidate', p_now)
      -- The line may already be suppressed from an earlier application.
      -- That is the mechanism working, not a conflict to resolve.
      on conflict (phone_sha256) do nothing;
      v_suppressed := true;

      insert into screening_v2.audit_events
        (actor_id, actor_type, action, target_type, target_id, result, metadata)
      values
        ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
         'phone_suppression_added', 'phone_suppression', v_digest, 'success',
         -- The DIGEST is the target id, and there is no number anywhere
         -- in this row. That is the whole point of keying on a digest.
         jsonb_build_object('engagement_id', v_eng.id,
                            'reason', case when v_new_state = 'opted_out'
                                           then 'candidate_opt_out' else 'wrong_number' end,
                            'source', 'candidate'));
    end if;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      -- The one place `candidate` is the truthful actor type: the
      -- outcome originated with the person on the line.
      ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
       'phone_opt_out_recorded', 'phone_engagement', v_eng.id::text, 'success',
       -- `suppression_written` is read from what actually happened. An
       -- engagement with no number on record CANNOT suppress a line it
       -- does not know, and saying so is better than implying a control
       -- that was not applied. Such an engagement is also undialable
       -- (admission refuses `phone_invalid`), so the two facts are
       -- coherent — but an operator must be able to see the gap.
       jsonb_build_object('outcome', v_new_state, 'reason', v_reason,
                          'event_type', p_event_type,
                          'suppression_written', v_suppressed));
  end if;

  return jsonb_build_object('status', 'applied', 'applied', true,
                            'ignored_reason', null,
                            'event_id', v_row_id, 'duplicate', false,
                            'engagement_state', coalesce(v_new_state, v_eng.state),
                            'attempt_state', coalesce(v_att_state, v_att.state));
end;
$$;
revoke all on function screening_v2.apply_phone_event(
  text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_phone_event(
  text, text, uuid, uuid, text, integer, jsonb, timestamptz) to service_role;

comment on function screening_v2.apply_phone_event is
  'The phone event ledger and state machine. 0045 widened exactly two edges — '
  'assessment.completed and assessment.aborted — to the STRANDED states '
  '(eligible/scheduled/reconnecting with a bound, already-terminal session), '
  'so a screening that was scored while the engagement had been moved out of '
  'in_call can still reach its engagement. 0044''s assessment interlock still '
  'applies and is what stops a completion being fabricated. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. sweep_phone_stranded_sessions — the driver for those two edges
-- ═══════════════════════════════════════════════════════════════════════
-- Bounded, idempotent, and it decides NOTHING itself: it reads whether a
-- phone assessment row exists and posts the corresponding event, leaving
-- `apply_phone_event` to re-check the same interlock under the row lock.
-- The sweep is a driver, not a second authority — if it ever disagreed
-- with the RPC, the RPC wins and the sweep simply counts a skip.
--
-- The dedup id is scoped by SESSION, not by date: a stranded session is
-- resolved exactly once, for ever, and a replica that races another one
-- lands on the same id and is deduped.
create or replace function screening_v2.sweep_phone_stranded_sessions(
  p_limit integer     default 25,
  p_now   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit     integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_row       record;
  v_result    jsonb;
  v_event     text;
  v_examined  integer := 0;
  v_completed integer := 0;
  v_failed    integer := 0;
  v_skipped   integer := 0;
begin
  for v_row in
    select e.id,
           e.session_id,
           exists (
             select 1 from screening_v2.assessments a
              where a.session_id = e.session_id
                and a.source = 'phone'
           ) as scored
      from screening_v2.phone_engagements e
      join screening_v2.call_sessions s on s.id = e.session_id
     where e.terminal_at is null
       and e.state in ('eligible','scheduled','reconnecting')
       and e.session_id is not null
       and s.status in ('completed','failed','cancelled','expired')
     order by e.updated_at asc
     limit v_limit
  loop
    v_examined := v_examined + 1;
    -- "Scored" here means exactly what it means everywhere else in this
    -- schema: a `source='phone'` assessment row exists. `overall_score`
    -- and `recommendation` are nullable and are deliberately NOT part of
    -- the test — introducing a second definition of scored would put this
    -- sweep and 0044's interlock into disagreement.
    v_event := case when v_row.scored then 'assessment.completed'
                    else 'assessment.aborted' end;

    v_result := screening_v2.apply_phone_event(
      p_source            => 'internal',
      p_event_type        => v_event,
      p_attempt_id        => null,
      p_engagement_id     => v_row.id,
      p_provider_event_id => 'stranded:' || v_row.session_id::text || ':' || v_event,
      p_epoch             => null,
      p_metadata          => null,
      p_now               => p_now
    );

    if (v_result ->> 'status') is not distinct from 'applied'
       and (v_result ->> 'ignored_reason') is null then
      if v_row.scored then v_completed := v_completed + 1;
      else v_failed := v_failed + 1;
      end if;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status',    'ok',
    'examined',  v_examined,
    'completed', v_completed,
    'failed',    v_failed,
    'skipped',   v_skipped,
    'limit',     v_limit
  );
end;
$$;

revoke all on function screening_v2.sweep_phone_stranded_sessions(integer, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.sweep_phone_stranded_sessions(integer, timestamptz) to service_role;

comment on function screening_v2.sweep_phone_stranded_sessions is
  'Bounded driver for the 0045 stranded-session edges. A terminal session with '
  'a phone assessment row completes its engagement without anybody being '
  'redialled; one without becomes a truthful failed. Decides nothing itself — '
  'apply_phone_event re-checks the interlock under the row lock. Idempotent '
  'per session. Service-role-only.';

notify pgrst, 'reload schema';
