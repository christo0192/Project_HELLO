-- =====================================================================
-- 0042 — Phone screening durable substrate (P1).
--
-- FORWARD-ONLY and ADDITIVE. Creates six new tables, three triggers, two
-- IST helpers and nine service-role RPCs, and widens exactly two closed
-- CHECK allowlists using the sanctioned drop-IF-EXISTS -> re-create
-- NOT VALID -> VALIDATE pattern. It drops no table, column, index or
-- unique/foreign-key constraint, replaces no existing function body, and
-- leaves 0001-0041 byte-identical.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────
-- This is the DATABASE half of outbound phone screening: the state
-- machine, its budgets, its exactly-once admission door, its append-only
-- ingress ledger, its internal calendar and its kill switch. There is no
-- TypeScript, no provider client, no route, no flag read and no dial in
-- this migration. Nothing here can place a call.
--
-- More strongly: admission is UNREACHABLE IN PRODUCTION BY CONSTRUCTION
-- until PR-N supplies a validated Indian number. `integrations/ashby`
-- writes `candidates.phone_e164 = null, phone_valid = false` on every
-- import, and `admit_phone_attempt` refuses `phone_invalid` on exactly
-- that shape. Every fixture in the test suite therefore seeds a
-- synthetic reserved documentation number; a green concurrency test here
-- is evidence about the SUBSTRATE, never about an end-to-end feature.
--
-- ── LOCK ORDER (pinned; a static test asserts it) ─────────────────────
-- Every admission transaction takes locks in exactly this order:
--
--   1. pg_advisory_xact_lock(hashtext('phone_admission'))   -- FIRST
--   2. screening_v2.ashby_application_links      ... for update
--   3. screening_v2.phone_engagements            ... for update
--   4. screening_v2.phone_call_attempts          (insert / lock)
--
-- The advisory lock is the FIRST statement of `admit_phone_attempt`'s
-- body, before any row lock. The inverse order is a genuine cycle, not a
-- theoretical one: txn A holding the advisory lock and waiting for
-- engagement E, while txn B holds E and waits for the advisory lock,
-- deadlocks with only two concurrent admissions. Link-before-engagement
-- mirrors `cancel_ashby_application` (0031) and
-- `recover_ashby_ingestion_parse` (0040), so no inversion exists against
-- the Ashby RPCs either.
--
-- `admit_phone_attempt` reads the engagement's `application_link_id`
-- with a PLAIN SELECT (no `for update`) before locking the link. An
-- unlocked read takes no row lock, so the pinned order still holds; it
-- exists only because the link id is reachable solely through the
-- engagement row.
--
-- Appointment RPCs take engagement-then-appointment, and take no
-- advisory lock: they admit no call and consume no fleet slot.
--
-- ── TIME IS INJECTED, ALWAYS ──────────────────────────────────────────
-- Every time-dependent function takes `p_now timestamptz default now()`
-- as its FINAL parameter, and NO function body calls `now()`,
-- `current_timestamp` or `clock_timestamp()`. A boundary test that reads
-- the machine clock passes in Asia and fails in CI. A structural
-- assertion over `pg_get_functiondef` enforces this; column DEFAULTs on
-- tables are unaffected and deliberately keep `now()`.
--
-- ── THE CALLING WINDOW, AND WHAT IT DOES NOT DECIDE ───────────────────
-- The approved outbound calling window is 09:00-21:00 IST, Monday to
-- Sunday, and it lives in ONE helper —
-- `screening_v2.phone_ist_window_open`. This is the final
-- Product-approved bound, not a placeholder: an owner decision of
-- 2026-08-22 fixed it, and nothing in this substrate treats it as
-- provisional. Runtime configuration may NARROW it; nothing may widen
-- it past this helper, because every caller — admission, appointment
-- booking, and the next-legal-slot calculation — reads this one
-- function and no caller repeats the bound.
--
-- The window is an ADMISSION / START-TIME predicate. It is evaluated at
-- the moment of dialling and at the moment an appointment slot STARTS —
-- never at the moment of scheduling, because a 120-second reconnect
-- backoff decided at 20:59 lands at 21:01. How long a call already
-- admitted at 20:59:59 may then RUN is not a schema question at all: it
-- is bounded by the voice layer's own maximum call duration, which no
-- constraint here can or should express.
--
-- ── WHY THE APPOINTMENT WINDOW IS A TRIGGER, NOT A CHECK ──────────────
-- The obvious form is a CHECK constraint over
-- `(starts_at at time zone 'Asia/Kolkata')`. Postgres REJECTS it:
-- `timezone(text, timestamptz)` is STABLE, and a CHECK expression must
-- be IMMUTABLE. The invariant is therefore carried by a BEFORE
-- INSERT/UPDATE trigger, which is equally fail-closed against a direct
-- service-role write and additionally derives `ist_date` so it cannot be
-- lied about. Immutable-safe parts (ordering, duration, vocabulary) stay
-- as ordinary CHECKs.
--
-- ── WORK-OWING, SCOPED HONESTLY ───────────────────────────────────────
-- Only a transition INTO `dialing` guarantees a live `phone.dial` job in
-- the same transaction. `eligible`, `awaiting_retry` and `scheduled` are
-- SWEEPER-DRIVEN by design (transitions #5/#6/#10/#27) and carry no
-- queue row. The sweeper that re-drives them, and the heartbeat loop
-- that keeps a concurrency lease alive for the length of a conversation,
-- are owned by P5. 0042 EXPOSES `heartbeat_phone_attempt` and
-- `reclaim_phone_attempt_leases` and proves them; it does not run them.
-- The 10-slot cap's correctness depends on P5 heartbeating, and that
-- dependency is stated rather than hidden.
--
-- ── DELIBERATE NON-REUSE ──────────────────────────────────────────────
-- `screening_v2.call_queue` and `screening_v2.sms_follow_ups` (0001) stay
-- dormant; both are commented below so the next reader is not misled.
-- `chk_ashby_operations_type` is NOT widened: dialing must not live
-- inside the machinery that performs stage moves and scorecard writes.
-- `ashby.ingestion` is a queue NAME, not an operation type, and phone
-- follows that precedent with `phone.dial`.
--
-- No `create extension` is issued. A true non-overlap
-- `exclude using gist (...)` would need `btree_gist`, which no migration
-- in this repository has ever installed; the partial unique index plus
-- an in-RPC guard under the engagement row lock is the deliberate
-- substitute, recorded as a rejection rather than an oversight.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. IST helpers — the ONLY place the calling window is written down
-- ═══════════════════════════════════════════════════════════════════════
-- Both are STABLE (not IMMUTABLE): `at time zone` depends on the tz
-- database. That is why neither can appear in a CHECK constraint, and
-- why `phone_call_attempts.ist_date` is a stored column written by the
-- admission RPC rather than a generated one.

create or replace function screening_v2.phone_ist_date(p_at timestamptz)
returns date
language sql
stable
set search_path = pg_catalog
as $$
  select (p_at at time zone 'Asia/Kolkata')::date
$$;

revoke all on function screening_v2.phone_ist_date(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_ist_date(timestamptz) to service_role;

comment on function screening_v2.phone_ist_date is
  'The IST calendar date of an instant. The per-day attempt budget rolls '
  'at IST midnight, never at UTC midnight. Service-role-only.';

-- The two bounds, each written down EXACTLY ONCE. An earlier draft
-- inlined the open time in both phone_ist_window_open and
-- phone_next_window_open, which meant a change to one silently parked
-- deferred calls an hour away from the window the gate enforced — and
-- narrowing the gate would have made phone_next_window_open return an
-- instant its own appointment trigger then REJECTED, aborting a webhook
-- apply that would be retried for ever. Two literals, two callers, one
-- definition each.
create or replace function screening_v2.phone_ist_window_open_at()
returns time
language sql
immutable
set search_path = pg_catalog
as $$ select time '09:00:00' $$;

create or replace function screening_v2.phone_ist_window_close_at()
returns time
language sql
immutable
set search_path = pg_catalog
as $$ select time '21:00:00' $$;

revoke all on function screening_v2.phone_ist_window_open_at()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_ist_window_open_at() to service_role;
revoke all on function screening_v2.phone_ist_window_close_at()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_ist_window_close_at() to service_role;

comment on function screening_v2.phone_ist_window_open_at is
  'The approved outbound calling window OPENS at this IST wall-clock '
  'time (09:00). The single definition; every caller reads it.';
comment on function screening_v2.phone_ist_window_close_at is
  'The approved outbound calling window CLOSES at this IST wall-clock '
  'time (21:00), exclusive. The single definition; every caller reads it.';

-- The fleet cap, likewise written down once. phone_backlog reports the
-- same number admit_phone_attempt enforces, because it is the same
-- number and not a second copy that can drift.
create or replace function screening_v2.phone_max_concurrent()
returns integer
language sql
immutable
set search_path = pg_catalog
as $$ select 10 $$;

revoke all on function screening_v2.phone_max_concurrent()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_max_concurrent() to service_role;

comment on function screening_v2.phone_max_concurrent is
  'The fleet-wide cap on simultaneous live phone calls (10). The single '
  'definition, read by both the admission gate and the health surface.';

create or replace function screening_v2.phone_ist_window_open(p_at timestamptz)
returns boolean
language sql
stable
set search_path = pg_catalog, screening_v2
as $$
  -- 09:00 inclusive .. 21:00 exclusive, IST, all seven days.
  -- Widening this by one hour must turn the boundary tests red; that is
  -- a recorded mutation control, and it is the reason the bounds live in
  -- their own functions and are not repeated in any caller.
  select (p_at at time zone 'Asia/Kolkata')::time >= screening_v2.phone_ist_window_open_at()
     and (p_at at time zone 'Asia/Kolkata')::time <  screening_v2.phone_ist_window_close_at()
$$;

revoke all on function screening_v2.phone_ist_window_open(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_ist_window_open(timestamptz) to service_role;

comment on function screening_v2.phone_ist_window_open is
  'True when an instant falls inside the APPROVED outbound calling '
  'window: 09:00 (inclusive) to 21:00 (exclusive) IST, Monday to Sunday. '
  'This is the final Product-approved bound and the ONLY place it is '
  'written down; every caller reads this function rather than repeating '
  'the hours. It is an ADMISSION / START-TIME predicate and does not '
  'bound the duration of a call already admitted — that is the voice '
  'layer''s maximum call duration. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. phone_engagements — the aggregate; this row IS the state machine
-- ═══════════════════════════════════════════════════════════════════════
-- Identity follows the Ashby house rule: keyed on the application link,
-- NEVER deduplicated by email or phone. `pending_prereqs` is a stored
-- state rather than "no row", because a blocked row is observable and an
-- absent row is indistinguishable from a bug that never created it —
-- the invisible-candidate defect repaired in PR #83.
--
-- No phone number, no provider payload and no free text is stored here.
-- `state_reason` is an allowlist-shaped code (the `chk_job_queue_defer_reason`
-- regex), so provider text can never reach a durable column.

create table if not exists screening_v2.phone_engagements (
  id                  uuid primary key default gen_random_uuid(),
  application_link_id uuid not null references screening_v2.ashby_application_links(id) on delete restrict,
  candidate_id        uuid not null references screening_v2.candidates(id) on delete restrict,
  role_id             uuid references screening_v2.roles(id) on delete set null,
  state               text not null default 'pending_prereqs',
  state_reason        text,
  epoch               integer not null default 0,
  version             integer not null default 1,
  no_answer_attempts  integer not null default 0,
  reconnects_used     integer not null default 0,
  provider_failures   integer not null default 0,
  next_eligible_at    timestamptz,
  last_attempt_at     timestamptz,
  session_id          uuid references screening_v2.call_sessions(id) on delete set null,
  consent_record_id   uuid references screening_v2.consent_records(id) on delete restrict,
  terminal_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_phone_engagements_application unique (application_link_id),
  constraint chk_phone_engagements_state check (state in (
    'pending_prereqs','eligible','scheduled','dialing','in_call','reconnecting',
    'awaiting_retry','completed','abandoned_no_answer','opted_out','wrong_number',
    'failed','cancelled')),
  constraint chk_phone_engagements_no_answer  check (no_answer_attempts between 0 and 3),
  constraint chk_phone_engagements_reconnects check (reconnects_used between 0 and 3),
  -- The design left `provider_failures` unbounded while defining `failed`
  -- as "failure budget exhausted" — a budget with no maximum cannot be
  -- exhausted. Bounded at 5 here so the terminal state is reachable and
  -- testable; the charge path transitions to `failed` on the fifth
  -- rather than raising a CHECK violation.
  constraint chk_phone_engagements_failures   check (provider_failures between 0 and 5),
  constraint chk_phone_engagements_epoch      check (epoch >= 0),
  constraint chk_phone_engagements_version    check (version >= 1),
  constraint chk_phone_engagements_reason     check (
    state_reason is null or state_reason ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint chk_phone_engagements_terminal   check (
    (state in ('completed','abandoned_no_answer','opted_out','wrong_number','failed','cancelled'))
    = (terminal_at is not null))
);

create index if not exists idx_phone_engagements_state
  on screening_v2.phone_engagements (state, next_eligible_at);
create index if not exists idx_phone_engagements_candidate
  on screening_v2.phone_engagements (candidate_id);

comment on table screening_v2.phone_engagements is
  'One outbound phone-screening engagement per Ashby application link. '
  'This row is the state machine: 13 states, 6 of them terminal, with '
  'every legal edge enforced by trigger rather than by convention. '
  'Carries three INDEPENDENT budgets (no-answer, reconnect, provider) '
  'that are never mixed. Stores NO phone number, provider payload or '
  'free text: the number is read from screening_v2.candidates at dial '
  'time and never copied here. Service-role-only.';
comment on column screening_v2.phone_engagements.epoch is
  'Monotonic fencing token, bumped when a new conversation begins. A '
  'callback carrying a lower epoch is recorded and ignored as '
  'stale_epoch. Late callbacks are solved by fencing, never by timeouts.';
comment on column screening_v2.phone_engagements.state_reason is
  'Sanitized stable code only (^[a-z0-9_.:-]{1,64}$) — never provider '
  'text, never an error string, never anything derived from a payload.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. phone_call_attempts — the durable per-dial authority
-- ═══════════════════════════════════════════════════════════════════════
-- This row, not the queue, is what makes admission exactly-once.
-- `uq_job_queue_dedup_active` (0009) is PARTIAL over pending/active/
-- delayed, so a COMPLETED dial job releases its dedup key and an
-- identical enqueue would succeed — which is precisely the "we called
-- them twice" failure. Nothing billable may depend on an index that
-- stops applying at completion. The dedup key remains a cheap secondary
-- guard against a concurrent enqueue; the authority is
-- `uq_phone_attempts_one_live` over this table.
--
-- The concurrency lease here is NOT the 0028 queue lease. One
-- conversation spans an originate, a classification and a long
-- assessment, far beyond a single queue claim. Binding the fleet slot to
-- the queue lease would free the slot the moment a heartbeat lapsed and
-- admit an 11th call while the 10th was still talking. Different table,
-- different token, different lifetime.

create table if not exists screening_v2.phone_call_attempts (
  id                       uuid primary key default gen_random_uuid(),
  engagement_id            uuid not null references screening_v2.phone_engagements(id) on delete cascade,
  attempt_seq              integer not null,
  epoch                    integer not null,
  kind                     text not null,
  state                    text not null default 'admitted',
  outcome_class            text,
  ist_date                 date not null,
  -- The engagement state this attempt was admitted FROM. Transition #30
  -- ("lease reclaimed -> prior state") is not expressible as a trigger
  -- edge without knowing what "prior" was, and guessing `eligible` would
  -- silently convert a reconnect into a fresh daily attempt.
  prior_engagement_state   text not null,
  session_id               uuid references screening_v2.call_sessions(id) on delete set null,
  room_name                text,
  sip_call_id              text,
  participant_identity     text,
  egress_id                text,
  egress_status            text,
  lease_token              uuid,
  lease_owner              text,
  lease_expires_at         timestamptz,
  admitted_at              timestamptz not null default now(),
  answered_at              timestamptz,
  classified_at            timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz not null default now(),
  constraint uq_phone_call_attempts_seq unique (engagement_id, attempt_seq),
  constraint chk_phone_call_attempts_kind check (
    kind in ('initial','no_answer_retry','reconnect','scheduled')),
  constraint chk_phone_call_attempts_state check (state in (
    'admitted','ringing','answered_unclassified','human','machine','ended','abandoned')),
  constraint chk_phone_call_attempts_outcome check (outcome_class is null or outcome_class in (
    'completed','disconnected','no_answer','busy','voicemail','declined','wrong_number',
    'opt_out','provider_error','window_closed','cancelled')),
  -- EXACTLY the three states admission can be granted from. A wider
  -- allowlist would let a hand-written row name a state the reclaim
  -- sweeper then cannot legally restore, and one such row would abort
  -- the whole sweep for everybody.
  constraint chk_phone_call_attempts_prior_state check (prior_engagement_state in (
    'eligible','scheduled','reconnecting')),
  -- Opaque provider identifiers only. The regexes admit an id, never a
  -- phone number: '+' and ' ' are outside every character class below.
  constraint chk_phone_call_attempts_sip_call_id check (
    sip_call_id is null or sip_call_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  constraint chk_phone_call_attempts_room_name check (
    room_name is null or room_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  constraint chk_phone_call_attempts_participant check (
    participant_identity is null or participant_identity ~ '^phone-[0-9a-f-]{36}$'),
  -- Copied verbatim from 0021's call_sessions constraints so the two
  -- egress models stay legible side by side.
  constraint chk_phone_call_attempts_egress_id check (
    egress_id is null or egress_id ~ '^EG_[A-Za-z0-9_-]{4,200}$'),
  constraint chk_phone_call_attempts_egress_status check (
    egress_status is null or egress_status in ('active','complete','failed')),
  constraint chk_phone_call_attempts_lease_owner check (
    lease_owner is null or length(lease_owner) between 1 and 128),
  constraint chk_phone_call_attempts_seq_positive check (attempt_seq >= 1),
  constraint chk_phone_call_attempts_epoch check (epoch >= 0)
);

-- I2: at most one LIVE attempt per engagement. `ended` and `abandoned`
-- are excluded, so a finished attempt never blocks re-admission — the
-- mirror of the PR #70 wedge, where a live row nothing could reclaim
-- blocked every future admission forever.
create unique index if not exists uq_phone_attempts_one_live
  on screening_v2.phone_call_attempts(engagement_id)
  where state in ('admitted','ringing','answered_unclassified','human','machine');

-- I5: one no-answer-class attempt per engagement per IST calendar day.
-- `reconnect` is excluded BY CONSTRUCTION, which is exactly what makes
-- "three immediate reconnects" and "one no-answer attempt per IST day"
-- independent budgets rather than one shared counter.
create unique index if not exists uq_phone_attempts_one_per_ist_day
  on screening_v2.phone_call_attempts(engagement_id, ist_date)
  where kind in ('initial','no_answer_retry','scheduled');

create index if not exists idx_phone_attempts_live_lease
  on screening_v2.phone_call_attempts(lease_expires_at)
  where state in ('admitted','ringing','answered_unclassified','human','machine');

create index if not exists idx_phone_attempts_engagement
  on screening_v2.phone_call_attempts(engagement_id, attempt_seq desc);

comment on table screening_v2.phone_call_attempts is
  'One row per dial. The DURABLE AUTHORITY for exactly-once admission — '
  'not the queue dedup key, which is partial over pending/active/delayed '
  'and releases on completion. Holds opaque room/SIP/participant/egress '
  'identifiers and an INDEPENDENT concurrency lease that guards the '
  '10-slot fleet cap; that lease is deliberately not the 0028 queue '
  'lease. Never stores a phone number or a provider payload. '
  'Service-role-only.';
comment on column screening_v2.phone_call_attempts.lease_token is
  'CONCURRENCY-slot token, renewed by heartbeat_phone_attempt and swept '
  'by reclaim_phone_attempt_leases. Distinct from job_queue.lease_token, '
  'which guards work EXECUTION and expires on a far shorter clock.';
comment on column screening_v2.phone_call_attempts.ist_date is
  'The IST calendar date of admission. The one non-timestamptz column in '
  'the phone model; it exists solely to carry the per-day uniqueness '
  'invariant, which rolls at IST midnight rather than UTC midnight.';
comment on column screening_v2.phone_call_attempts.prior_engagement_state is
  'The engagement state this attempt was admitted from, so a reclaimed '
  'lease can restore it (transition #30) instead of guessing `eligible` '
  'and silently converting a reconnect into a fresh daily attempt.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. phone_appointments — the internal calendar
-- ═══════════════════════════════════════════════════════════════════════
-- No external calendar, ever. This table is the only scheduling
-- authority, and it is what gives HR visibility into a bot-negotiated
-- slot.

create table if not exists screening_v2.phone_appointments (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references screening_v2.phone_engagements(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  ist_date      date not null,
  status        text not null default 'scheduled',
  source        text not null,
  confirmed_at  timestamptz,
  created_by    uuid,
  cancel_reason text,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint chk_phone_appointments_order check (ends_at > starts_at),
  -- Slot length is bounded here as well as upstream: a 30-minute default
  -- inside a 15..60 minute envelope. "Starts 18:45, ends 19:15" is
  -- legal — the window governs the START, and the D-1 question of
  -- whether an admitted call may run past close is not decided here.
  -- Expressed as a difference rather than `starts_at + interval`,
  -- because timestamptz + interval is STABLE (a day-or-larger interval
  -- depends on the session TimeZone) and a CHECK expression must be
  -- IMMUTABLE. timestamptz - timestamptz is immutable, so this form is
  -- accepted where the obvious one is rejected.
  constraint chk_phone_appointments_duration check (
    extract(epoch from (ends_at - starts_at)) between 900 and 3600),
  constraint chk_phone_appointments_status check (
    status in ('scheduled','confirmed','cancelled','superseded','fulfilled','missed')),
  constraint chk_phone_appointments_source check (
    source in ('candidate_voice','hr_manual','system_deferral')),
  constraint chk_phone_appointments_cancel_reason check (
    cancel_reason is null or cancel_reason ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint chk_phone_appointments_version check (version >= 1)
);

-- I7: at most one LIVE appointment per engagement.
create unique index if not exists uq_phone_appointments_one_live
  on screening_v2.phone_appointments(engagement_id)
  where status in ('scheduled','confirmed');

create index if not exists idx_phone_appointments_due
  on screening_v2.phone_appointments(starts_at)
  where status in ('scheduled','confirmed');

create index if not exists idx_phone_appointments_engagement
  on screening_v2.phone_appointments(engagement_id, starts_at desc);

comment on table screening_v2.phone_appointments is
  'Internal Project_HELLO scheduling calendar for phone screening. No '
  'Google Calendar and no external provider is involved. At most one '
  'live (scheduled|confirmed) appointment per engagement; slots start '
  'inside the approved IST window and never straddle IST midnight, both '
  'enforced by trigger because the predicate is STABLE and a CHECK '
  'expression must be IMMUTABLE. Service-role-only.';
comment on column screening_v2.phone_appointments.ist_date is
  'Derived by the BEFORE INSERT/UPDATE trigger from starts_at and never '
  'supplied by a caller, so no writer can lie about which IST day a slot '
  'belongs to.';
comment on column screening_v2.phone_appointments.version is
  'Optimistic-concurrency token for HR edits. A stale write is refused '
  'with version_conflict rather than silently overwriting a slot a '
  'recruiter is looking at.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. phone_call_events — insert-once ingress ledger and dedup register
-- ═══════════════════════════════════════════════════════════════════════
-- `provider_event_id` is NOT NULL on purpose. A unique index over a
-- nullable column does not dedup: Postgres treats NULLs as distinct, so
-- every internal, poll and reconciliation event — exactly the channel
-- that RECOVERS a dropped webhook — would insert freely and the ledger's
-- central guarantee would be vacuous for the one source that matters
-- most. Non-provider sources therefore mint a DETERMINISTIC synthetic
-- id, and one index covers every channel.
--
-- (`unique nulls not distinct` would also work, but it is PG15+ syntax
-- and would put a Postgres-version assertion on the critical path of a
-- dedup guarantee. NOT NULL has no such dependency.)
--
-- Rows are inserted ONCE, already carrying their final applied /
-- ignored_reason outcome. A second delivery conflicts, does nothing, and
-- the caller reads back the ORIGINAL row so it receives the same answer
-- the first delivery received. UPDATE and DELETE are blocked outright:
-- "received and deliberately did nothing" must be a recorded outcome,
-- because a silently dropped late callback is indistinguishable from a
-- lost one, and that ambiguity is what makes late-callback bugs
-- unfindable.


-- The ledger's metadata is the one column an ingress handler can put
-- arbitrary bytes into, and phone_call_events is append-only — a raw
-- provider envelope written here (`{"from":"+91…","sip_uri":…}`) could
-- only be removed through the erasure hatch. A size cap alone does not
-- make a payload sanitized; this predicate does, and it backs both the
-- column CHECK and the RPC.
--
-- Every key must be a short snake_case identifier, every value must be a
-- scalar, and every string value must be drawn from a character set that
-- excludes '+' (so no E.164), '@' (so no address), '/' (so no URL) and
-- whitespace (so no prose).
create or replace function screening_v2.phone_event_metadata_sanitized(p_metadata jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_metadata is null
      or (jsonb_typeof(p_metadata) = 'object'
          and not exists (
            select 1
              from jsonb_each(p_metadata) kv
             where kv.key !~ '^[a-z][a-z0-9_]{0,31}$'
                or jsonb_typeof(kv.value) not in ('string', 'number', 'boolean')
                or (jsonb_typeof(kv.value) = 'string'
                    and (kv.value #>> '{}') !~ '^[A-Za-z0-9_.:-]{0,128}$')))
$$;

revoke all on function screening_v2.phone_event_metadata_sanitized(jsonb)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_event_metadata_sanitized(jsonb) to service_role;

comment on function screening_v2.phone_event_metadata_sanitized is
  'True when a phone_call_events.metadata payload carries only short '
  'snake_case keys and scalar values drawn from a character set that '
  'excludes +, @, / and whitespace — so no phone number, address, URL '
  'or free text can reach an append-only column. Service-role-only.';

create table if not exists screening_v2.phone_call_events (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  provider_event_id text not null,
  engagement_id     uuid references screening_v2.phone_engagements(id) on delete set null,
  attempt_id        uuid references screening_v2.phone_call_attempts(id) on delete set null,
  epoch             integer,
  event_type        text not null,
  received_at       timestamptz not null default now(),
  applied           boolean not null default false,
  ignored_reason    text,
  metadata          jsonb,
  created_at        timestamptz not null default now(),
  constraint uq_phone_call_events_provider unique (source, provider_event_id),
  constraint chk_phone_call_events_source check (source in (
    'livekit_webhook','provider_callback','provider_poll','internal','reconciliation')),
  -- event_type is deliberately a FORMAT rule and not a closed allowlist.
  -- An unrecognised event must be RECORDABLE so it can be answered with
  -- `unexpected_event`; a closed CHECK would make the unknown-event case
  -- unrepresentable, which is the opposite of observable.
  constraint chk_phone_call_events_type check (event_type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  constraint chk_phone_call_events_provider_id check (
    provider_event_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  -- Exactly the four verdicts a stored row can carry. 'duplicate' is
  -- deliberately absent: a duplicate delivery writes NO second row, so a
  -- row claiming to be one could never exist. Vocabulary with no
  -- reachable writer is how a wrong attribution gets made later.
  constraint chk_phone_call_events_ignored_reason check (
    ignored_reason is null or ignored_reason in (
      'stale_epoch','unknown_attempt','terminal','unexpected_event')),
  -- applied and ignored are mutually exclusive and jointly exhaustive: a
  -- row that is neither would be an event with no recorded verdict.
  constraint chk_phone_call_events_outcome check (applied = (ignored_reason is null)),
  constraint chk_phone_call_events_metadata_size check (
    metadata is null or octet_length(metadata::text) <= 2048),
  -- Size is not sanitation. This is the guarantee the table comment
  -- claims, enforced against every writer including a direct one.
  constraint chk_phone_call_events_metadata_sanitized check (
    screening_v2.phone_event_metadata_sanitized(metadata))
);

create index if not exists idx_phone_call_events_attempt
  on screening_v2.phone_call_events(attempt_id, received_at desc);
create index if not exists idx_phone_call_events_ignored
  on screening_v2.phone_call_events(ignored_reason, received_at desc)
  where ignored_reason is not null;

comment on table screening_v2.phone_call_events is
  'Insert-once ingress ledger and dedup register for phone call events. '
  'provider_event_id is NOT NULL — non-provider sources mint a '
  'deterministic synthetic id (internal:<attempt>:<type>:<epoch>, '
  'poll:<attempt>:<state>) — because a unique index over a nullable '
  'column does not dedup. UPDATE and DELETE are blocked by trigger, '
  'including for service_role. Metadata is bounded, sanitized and never '
  'carries a raw provider body, a phone number or a token. '
  'Service-role-only.';

create or replace function screening_v2.prevent_phone_call_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  -- The same escape hatch prevent_audit_mutation (0007) carries, and for
  -- the same two reasons: an emergency migration must be possible, and a
  -- data-subject erasure request must be satisfiable on a ledger that is
  -- otherwise immutable. It is OFF unless a session sets it with SET
  -- LOCAL, is never enabled in an application connection, and is
  -- asserted absent from every phone RPC body.
  if current_setting('app.allow_phone_event_mutation', true) = 'true' then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'phone_call_events is insert-once: % not permitted', tg_op
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_phone_call_events_prevent_update
  on screening_v2.phone_call_events;
create trigger trg_phone_call_events_prevent_update
  before update on screening_v2.phone_call_events
  for each row
  execute function screening_v2.prevent_phone_call_event_mutation();

drop trigger if exists trg_phone_call_events_prevent_delete
  on screening_v2.phone_call_events;
create trigger trg_phone_call_events_prevent_delete
  before delete on screening_v2.phone_call_events
  for each row
  execute function screening_v2.prevent_phone_call_event_mutation();

comment on function screening_v2.prevent_phone_call_event_mutation is
  'Blocks UPDATE and DELETE on phone_call_events for every role, '
  'service_role included. Each event is inserted once carrying its final '
  'applied/ignored_reason verdict; a duplicate delivery is a no-op that '
  'reads back the original row rather than rewriting it. To permit an '
  'emergency migration or a data-subject erasure, set '
  'app.allow_phone_event_mutation = ''true'' via SET LOCAL in a '
  'dedicated session, perform the operation, then RESET — exactly the '
  'prevent_audit_mutation (0007) contract. Never enable it globally or '
  'in an application connection: no phone RPC sets it, and a structural '
  'test asserts that.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. phone_suppressions — an opt-out that outlives the engagement
-- ═══════════════════════════════════════════════════════════════════════
-- Keyed on the SHA-256 DIGEST of the E.164 number, never the number.
-- Keyed on the LINE rather than the candidate, because the obligation
-- follows the phone line: a shared or reassigned household number must
-- stay suppressed regardless of which candidate record it hangs off, and
-- an opt-out modelled only on an engagement would re-dial the same
-- person on their next application.
--
-- The digest is produced by the EXISTING schema-qualified helper
-- `screening_v2.sha256_hex` (0016). A bare `digest()` is not resolvable
-- under a SECURITY DEFINER search_path of `pg_catalog, screening_v2`:
-- pgcrypto installs into `extensions` on Supabase and `public`
-- elsewhere, so it would fail at RUNTIME rather than at migration time.

create table if not exists screening_v2.phone_suppressions (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid references screening_v2.candidates(id) on delete set null,
  phone_sha256 text not null,
  reason       text not null,
  source       text not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  constraint uq_phone_suppressions_phone unique (phone_sha256),
  constraint chk_phone_suppressions_sha check (phone_sha256 ~ '^[a-f0-9]{64}$'),
  constraint chk_phone_suppressions_reason check (
    reason in ('candidate_opt_out','wrong_number','dnd_registry','operator')),
  constraint chk_phone_suppressions_source check (
    source in ('candidate','operator','system','registry'))
);

comment on table screening_v2.phone_suppressions is
  'Do-not-call register keyed on the SHA-256 digest of an E.164 number '
  'and never on the number itself, so the phone model keeps its "numbers '
  'live only on screening_v2.candidates" posture. Keyed on the LINE, not '
  'the candidate, because the obligation follows the line across '
  'applications and across reassignment. Checked fail-closed by '
  'admit_phone_attempt before every dial. Service-role-only.';
comment on column screening_v2.phone_suppressions.phone_sha256 is
  'screening_v2.sha256_hex(<E.164>) — schema-qualified because pgcrypto '
  'lives in `extensions` on Supabase and `public` elsewhere, so a bare '
  'digest() under a pinned search_path fails at runtime, not at deploy.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. phone_control — the singleton kill switch
-- ═══════════════════════════════════════════════════════════════════════
-- Modelled on `recording_finalize_control` (0038) with ONE deliberate
-- inversion: the recording halt is fail-OPEN when its state cannot be
-- read, and copying that onto a BILLABLE outbound dialer would be a
-- defect. An unreadable kill switch on a dialer is a stop, not a go, so
-- a missing singleton refuses admission with `halt_unreadable`.

create table if not exists screening_v2.phone_control (
  control_key  text primary key,
  halted_at    timestamptz,
  halt_reason  text,
  halt_actor_id uuid,
  updated_at   timestamptz not null default now(),
  constraint chk_phone_control_key check (control_key = 'default'),
  constraint chk_phone_control_reason check (
    halt_reason is null or halt_reason in (
      'operator_pause','provider_incident','cost_control','legal_hold','emergency_stop')),
  -- A halt is a reason AND a time AND an actor, or none of the three. A
  -- half-written halt would read as "not halted" to one query and
  -- "halted" to another.
  constraint chk_phone_control_coherent check (
    (halted_at is null) = (halt_reason is null)
    and (halted_at is null) = (halt_actor_id is null))
);

insert into screening_v2.phone_control (control_key)
values ('default')
on conflict (control_key) do nothing;

comment on table screening_v2.phone_control is
  'Singleton operator kill switch for outbound phone screening. Setting '
  'the halt blocks every new admission fleet-wide with no deploy, and '
  'dialing cannot resume without an explicit audited clear. Unlike the '
  'recording finalize control it FAILS CLOSED: a missing or unreadable '
  'singleton refuses admission rather than permitting it. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. Engagement transition trigger — the machine, not a convention
-- ═══════════════════════════════════════════════════════════════════════
-- A state machine whose edges live only in TypeScript is a convention.
-- These are the edges of the design's transition table (#1..#31), with
-- three resolutions the design left open, each stated rather than
-- assumed:
--
--   * #30 ("lease reclaimed -> prior state") is realised as the edges
--     dialing -> {eligible, scheduled, reconnecting}, restoring the
--     value stored in phone_call_attempts.prior_engagement_state.
--   * #21 ("reconnects_used = 3 then participant_left -> completed
--     (partial) or failed") is realised as `failed` when no assessment
--     completion has been observed; a partial that DID complete arrives
--     as assessment.completed (#22) and takes the `completed` edge.
--   * #14/#16 are self-edges on `dialing`; same-state is a no-op, as in
--     enforce_ashby_ingestion_transition.
--
-- Terminal states are immutable, including terminal-to-terminal.

create or replace function screening_v2.enforce_phone_engagement_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  allowed text[];
begin
  if old.state = new.state then
    return new;   -- idempotent no-op (#14/#16 and every retry)
  end if;
  case old.state
    when 'pending_prereqs' then allowed := array['eligible','cancelled'];
    when 'eligible'        then allowed := array['dialing','scheduled','cancelled'];
    when 'scheduled'       then allowed := array['dialing','eligible','cancelled'];
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
    when 'reconnecting'    then allowed := array['dialing','scheduled','eligible','failed','cancelled'];
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

drop trigger if exists trg_phone_engagement_transition
  on screening_v2.phone_engagements;
create trigger trg_phone_engagement_transition
  before update on screening_v2.phone_engagements
  for each row
  execute function screening_v2.enforce_phone_engagement_transition();

comment on function screening_v2.enforce_phone_engagement_transition is
  'Enforces the legal phone_engagements state machine on UPDATE; '
  'same-state is a no-op. The six terminal states (completed, '
  'abandoned_no_answer, opted_out, wrong_number, failed, cancelled) '
  'reject every transition, terminal-to-terminal included.';

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Appointment window trigger — the IST invariant a CHECK cannot hold
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.enforce_phone_appointment_window()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, screening_v2
as $$
begin
  -- Derived, never supplied: a caller cannot lie about which IST day a
  -- slot belongs to.
  new.ist_date := screening_v2.phone_ist_date(new.starts_at);

  if not screening_v2.phone_ist_window_open(new.starts_at) then
    raise exception 'phone appointment start is outside the approved IST calling window'
      using errcode = 'P0001';
  end if;
  if screening_v2.phone_ist_date(new.starts_at)
     <> screening_v2.phone_ist_date(new.ends_at) then
    raise exception 'phone appointment may not straddle IST midnight'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_phone_appointment_window
  on screening_v2.phone_appointments;
create trigger trg_phone_appointment_window
  before insert or update on screening_v2.phone_appointments
  for each row
  execute function screening_v2.enforce_phone_appointment_window();

comment on function screening_v2.enforce_phone_appointment_window is
  'Derives phone_appointments.ist_date and enforces the approved IST '
  'START window plus the no-IST-midnight-straddle rule. A trigger rather '
  'than a CHECK because `at time zone` is STABLE and a CHECK expression '
  'must be IMMUTABLE; the guarantee against a direct write is identical.';

-- ═══════════════════════════════════════════════════════════════════════
-- 10. RLS and grants — service-role-only, no browser surface at all
-- ═══════════════════════════════════════════════════════════════════════
-- No policy is created for anon or authenticated. There is nothing here
-- a browser session may read: an engagement row plus a suppression
-- digest is a re-identifiable contact record.

alter table screening_v2.phone_engagements   enable row level security;
alter table screening_v2.phone_call_attempts enable row level security;
alter table screening_v2.phone_appointments  enable row level security;
alter table screening_v2.phone_call_events   enable row level security;
alter table screening_v2.phone_suppressions  enable row level security;
alter table screening_v2.phone_control       enable row level security;

revoke all on screening_v2.phone_engagements   from anon, authenticated, public;
revoke all on screening_v2.phone_call_attempts from anon, authenticated, public;
revoke all on screening_v2.phone_appointments  from anon, authenticated, public;
revoke all on screening_v2.phone_call_events   from anon, authenticated, public;
revoke all on screening_v2.phone_suppressions  from anon, authenticated, public;
revoke all on screening_v2.phone_control       from anon, authenticated, public;

grant all privileges on screening_v2.phone_engagements   to service_role;
grant all privileges on screening_v2.phone_call_attempts to service_role;
grant all privileges on screening_v2.phone_appointments  to service_role;
grant all privileges on screening_v2.phone_call_events   to service_role;
grant all privileges on screening_v2.phone_suppressions  to service_role;
grant all privileges on screening_v2.phone_control       to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 11. The two dormant 0001 tables, labelled so nobody revives them
-- ═══════════════════════════════════════════════════════════════════════

comment on table screening_v2.call_queue is
  'DORMANT since 0001 and deliberately NOT revived by the 0042 phone '
  'substrate. It has no lease, no owner, no fencing epoch, no IST '
  'notion, no per-day uniqueness, no appointment model and no RPC '
  'surface, and its status vocabulary cannot express reconnecting, '
  'opted_out or window_closed. Reviving it would mean replacing every '
  'column and constraint, i.e. a new table wearing an old name. The live '
  'phone state machine is screening_v2.phone_engagements.';

comment on table screening_v2.sms_follow_ups is
  'DORMANT since 0001 and deliberately NOT revived by the 0042 phone '
  'substrate. Outbound phone screening performs no SMS or email '
  'automation of any kind.';

-- ═══════════════════════════════════════════════════════════════════════
-- 12. CHECK evolution 1 of 2 — audit_events.chk_audit_action
-- ═══════════════════════════════════════════════════════════════════════
-- Re-declared IN FULL because a CHECK cannot be patched in place. Every
-- pre-existing action from 0007/0014/0016/0029/0031/0032/0036/0039/0041
-- is reproduced verbatim; policy_tests.sql asserts nothing was dropped.
--
-- Only the six actions 0042's own RPCs actually write are added. The
-- other names the design sketched (phone_engagement_created,
-- phone_appointment_rescheduled, phone_suppression_added,
-- phone_recording_purged, phone_emergency_stop) belong to the PRs that
-- will write them: unused vocabulary in a re-declared CHECK is scope
-- with no caller.
--
-- The halt RPCs deliberately reuse the EXISTING `admin_session_override`
-- action with a discriminating metadata key, exactly as
-- set_recording_finalize_halt (0038) does, so a kill switch needs no new
-- vocabulary at all.

alter table screening_v2.audit_events
  drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events
  add constraint chk_audit_action check (
    action in (
      'invite_sent', 'invite_revoked', 'invite_consumed',
      'grant_issued', 'grant_revoked', 'grant_consumed',
      'screening_started', 'screening_completed', 'screening_failed',
      'assessment_recorded',
      'candidate_status_changed', 'candidate_consent_updated',
      'session_created', 'session_updated', 'session_terminated',
      'membership_created', 'membership_updated', 'membership_deactivated',
      'role_created', 'role_updated', 'role_deactivated',
      'export_requested', 'export_completed',
      'login_success', 'login_failure', 'logout',
      'config_changed',
      'auth_login_success', 'auth_login_failure', 'auth_token_refresh', 'auth_logout',
      'rbac_access_denied', 'rbac_ownership_denied',
      'resource_create', 'resource_read', 'resource_update',
      'resource_delete', 'resource_list', 'rate_limit_exceeded',
      'audit_sink_failure', 'audit_configuration_error',
      'recording_download', 'recording_upload', 'recording_integrity_verified',
      'recording_quarantined', 'recording_revoked', 'recording_deleted',
      'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update',
      'quota_override', 'notification_create', 'appeal_create', 'appeal_review',
      'allowlist_linked', 'admin_allowlist_add', 'admin_allowlist_update',
      -- Ashby Wave 2 (0029): mapping-administration audits.
      'ashby_mapping_update', 'ashby_mapping_drift',
      -- Ashby Wave 2 (0031, additive): workflow-execution audits.
      'ashby_application_cancel', 'ashby_operation_enqueue', 'ashby_operation_update',
      -- Ashby Wave 2 (0032, additive): runtime-activation audits.
      'ashby_operation_retry', 'ashby_writeback_pending',
      -- Ashby Wave 2 (0032, review repair): manual invite hand-off.
      'ashby_invite_delivered',
      -- Ashby Wave 2 (0036, additive): audited ingestion attempt-counter reset.
      'ashby_ingestion_attempts_reset',
      -- Ashby (0039, additive): audited BOUNDED parse-class ingestion retry.
      'ashby_ingestion_parse_recovery',
      -- Ashby (0041, additive): ONE-SHOT recovery of a LEGACY parse_bad_output
      -- row, i.e. one written while a library could still pollute the child's
      -- stdout protocol channel.
      'ashby_ingestion_legacy_bad_output_recovery',
      -- Phone screening (0042, additive): the six actions this migration's
      -- own RPCs write. No stage move, no email, no scorecard.
      'phone_attempt_admitted',
      'phone_attempt_classified',
      'phone_attempt_ended',
      'phone_appointment_scheduled',
      'phone_appointment_cancelled',
      'phone_opt_out_recorded'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed action allowlist, extended ADDITIVELY by 0042 with the six '
  'phone-screening actions its RPCs write. No prior member has ever been '
  'removed; policy_tests.sql asserts that directly.';

-- ═══════════════════════════════════════════════════════════════════════
-- 13. CHECK evolution 2 of 2 — call_sessions.chk_call_sessions_terminal_reason
-- ═══════════════════════════════════════════════════════════════════════
-- A phone session ended by a refused disclosure or by a wrong number has
-- no legal terminal reason today, so transitions #17/#23/#24 could not
-- commit. Exactly two pairs are added, both to the `cancelled` family:
-- ('cancelled','candidate_opt_out') and ('cancelled','wrong_number').
--
-- `voicemail_detected` is deliberately NOT added. Under the design's own
-- ordering nothing binds a call_sessions row until AFTER a human
-- classification, so a machine-answered attempt produces no session to
-- terminalise. A terminal reason with no reachable caller is vocabulary
-- that only invites a wrong attribution later.
--
-- Re-declared in full (0006 §8 wording, plus 0038's residency_timeout,
-- plus these two) because a CHECK cannot be extended in place.

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_terminal_reason;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_terminal_reason check (
    (
      status not in ('completed', 'failed', 'cancelled', 'expired')
      and terminal_reason is null
    )
    or
    (
      status = 'completed'
      and terminal_reason in ('conversation_complete', 'assessment_done')
    )
    or
    (
      status = 'failed'
      and terminal_reason in (
        'room_create_error', 'worker_crash', 'provider_error',
        'assessment_error', 'shutdown_forced', 'drain_timeout',
        -- 0038: the session outlived its bounded room residency. Not a
        -- crash: the worker was alive and the close event never fired.
        'residency_timeout'
      )
    )
    or
    (
      status = 'cancelled'
      and terminal_reason in (
        'recruiter_cancelled', 'migrated_abandoned',
        'duplicate_session', 'shutdown_drain',
        -- 0042: the two truthful ends of a phone conversation that must
        -- purge and suppress rather than score.
        'candidate_opt_out', 'wrong_number'
      )
    )
    or
    (
      status = 'expired'
      and terminal_reason in ('idle_timeout', 'grace_timeout')
    )
    or
    (
      status in ('completed', 'failed', 'cancelled', 'expired')
      and terminal_reason = 'legacy_unknown'
    )
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_terminal_reason;

comment on constraint chk_call_sessions_terminal_reason on screening_v2.call_sessions is
  'Family-structured terminal-reason allowlist, extended ADDITIVELY by '
  '0042 with exactly ("cancelled","candidate_opt_out") and '
  '("cancelled","wrong_number"). voicemail_detected is deliberately '
  'absent: no session is bound before human classification, so a '
  'machine-answered attempt has no session to terminalise.';

-- ═══════════════════════════════════════════════════════════════════════
-- 14. admit_phone_attempt — the exactly-once admission door
-- ═══════════════════════════════════════════════════════════════════════
-- Every RPC below is SECURITY DEFINER with a pinned search_path, revoked
-- from public/anon/authenticated and granted to service_role alone.
--
-- ADMISSION CHARGES NO BUDGET. Budgets move at OUTCOME CLASSIFICATION
-- (apply_phone_event), never here, and every refusal below is therefore
-- free: a wait must never cost a candidate an attempt. That is the whole
-- point of separating the no-answer budget from the window, the capacity
-- gate and the provider budget.
--
-- The refusal list is ordered so the cheapest, most durable facts are
-- answered first, but the ADVISORY LOCK is taken before all of them —
-- see the lock-order note in the file header. Taking a global lock
-- before a refusal is a few microseconds at 1,000 calls a month, and it
-- removes an entire class of count-then-insert races.
--
-- ONE-LIVE IS THE INDEX, NOT A PRE-CHECK. There is deliberately no
-- "select ... where state in (live) then refuse" branch before the
-- insert: under the advisory lock such a branch would answer every
-- concurrent case itself and `uq_phone_attempts_one_live` would become
-- decorative — a guard whose removal left the suite green. The insert is
-- attempted and a unique violation is translated into the stable
-- `attempt_in_flight` refusal, so dropping the index genuinely turns the
-- concurrency test red.

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
  v_max_concurrent constant integer := screening_v2.phone_max_concurrent();
  v_queue_name     constant text    := 'phone.dial';
  v_job_max_attempts constant integer := 5;
begin
  -- ── LOCK 1: the global admission serialiser, FIRST statement ───────
  -- Before any `select ... for update`. The inverse order deadlocks with
  -- two concurrent admissions; see the file header.
  perform pg_advisory_xact_lock(hashtext('phone_admission'));

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
    -- The ONLY handled condition, and it is handled narrowly. Either
    -- uq_phone_attempts_one_live (a concurrent admission already holds
    -- the single live slot) or uq_phone_attempts_one_per_ist_day (a
    -- same-day attempt raced past the check above). Both are refusals,
    -- both are free, and neither is a failure of this function.
    when unique_violation then
      return jsonb_build_object('status', 'attempt_in_flight');
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
                        'max_concurrent', v_max_concurrent));

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
  'The exactly-once outbound admission door. Under a global advisory '
  'lock taken FIRST, then the application link, then the engagement, it '
  're-checks every prerequisite (enabled mapping, live non-terminal '
  'application, ready resume ingestion, latest granted unexpired consent '
  'covering the active template, a valid +91 mobile, an unsuppressed '
  'digest, a present and clear halt singleton, the IST window, next '
  'eligibility, the no-answer/reconnect budgets and the per-IST-day '
  'uniqueness) and then, in ONE transaction, inserts the attempt, takes '
  'its concurrency lease and admits the phone.dial job. Returning ok '
  'therefore means live work exists. ADMISSION CHARGES NO BUDGET: every '
  'refusal is free. Moves no Ashby stage, sends no email, writes no '
  'scorecard, and stores no phone number anywhere. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 15. heartbeat_phone_attempt — token-fenced concurrency-lease renewal
-- ═══════════════════════════════════════════════════════════════════════
-- A screening conversation lasts minutes; a lease lasts a minute. With
-- nothing renewing it the lease expires MID-CALL, the fleet count drops
-- and an 11th call is admitted while the 10th is still talking. The
-- renewal loop is P5's; the renewal primitive is here, and it is fenced:
-- a wrong or stale token matches no row and is a stable refusal, never a
-- silent renew.

create or replace function screening_v2.heartbeat_phone_attempt(
  p_attempt_id    uuid,
  p_lease_token   uuid,
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
  update screening_v2.phone_call_attempts
     set lease_expires_at = p_now + (greatest(5, least(coalesce(p_lease_seconds, 60), 900))
                                     * interval '1 second')
   where id = p_attempt_id
     and lease_token = p_lease_token
     and state in ('admitted','ringing','answered_unclassified','human','machine')
     and lease_expires_at > p_now
  returning lease_expires_at into v_expires;

  if v_expires is null then
    -- Covers all four losses with one stable answer: unknown attempt,
    -- wrong token, already-reclaimed lease, non-live attempt. The caller
    -- must stop work; it no longer holds the slot.
    return jsonb_build_object('status', 'lease_lost');
  end if;

  return jsonb_build_object('status', 'ok', 'lease_expires_at', v_expires);
end;
$$;

revoke all on function screening_v2.heartbeat_phone_attempt(uuid, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.heartbeat_phone_attempt(uuid, uuid, integer, timestamptz)
  to service_role;

comment on function screening_v2.heartbeat_phone_attempt is
  'Token-fenced renewal of a phone_call_attempts CONCURRENCY lease — the '
  'fleet-slot lease, not the 0028 queue lease. A wrong, stale or expired '
  'token matches no row and is refused with lease_lost; it is never a '
  'silent renew. Returns the new expiry. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 16. reclaim_phone_attempt_leases — transition #30
-- ═══════════════════════════════════════════════════════════════════════
-- `reclaim_expired_jobs` (0028) is queue-name-agnostic and knows nothing
-- about phone_call_attempts, so it cannot perform this transition and
-- its per-pass budget is deliberately NOT shared with this one. Without
-- a phone-side reclaimer an attempt whose worker died stays live for
-- ever and `uq_phone_attempts_one_live` then blocks every future
-- admission for that engagement — the PR #70 wedge.
--
-- A reclaim CHARGES NO BUDGET. Nobody's phone rang; a dead worker is our
-- failure, not the candidate's attempt.

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

    -- Back to the state this attempt was admitted FROM, so a reclaimed
    -- reconnect returns to `reconnecting` rather than silently becoming
    -- a fresh daily attempt. Terminal engagements are left alone: a
    -- terminal row is immutable and a reclaim is not an event that may
    -- resurrect it. Note the engagement is re-admissible in the
    -- state-machine sense; the per-IST-day index still applies, so a
    -- reclaimed no-answer-class attempt is re-dialled the NEXT IST day.
    -- `dialing` is not the only state an engagement can hold a LIVE
    -- attempt in: after disclosure.delivered it is `in_call` while its
    -- attempt is still `human`. Restricting the restore to `dialing`
    -- left exactly that engagement stranded — attempt abandoned, slot
    -- freed, engagement `in_call` for ever with nothing left that could
    -- move it.
    update screening_v2.phone_engagements
       set state        = v_att.prior_engagement_state,
           state_reason = 'lease_reclaimed',
           version      = version + 1,
           updated_at   = p_now
     where id = v_att.engagement_id
       and terminal_at is null
       and state in ('dialing', 'in_call');
    get diagnostics v_restored = row_count;

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
                               then v_att.prior_engagement_state else null end));

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
  'Bounded sweeper for EXPIRED phone concurrency leases (transition '
  '#30): the attempt becomes abandoned, its fleet slot is freed and the '
  'engagement is returned to the state it was admitted from. CHARGES NO '
  'BUDGET — a dead worker is our '
  'failure, not the candidate''s attempt. Separate from '
  'reclaim_expired_jobs, which is queue-name-agnostic and cannot see '
  'this table. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 17. phone_next_window_open — the one place "the next legal dial time"
--     is computed
-- ═══════════════════════════════════════════════════════════════════════
-- Used by the window-closed deferral paths so a wait lands on a legal
-- instant rather than on a guess. Reads the same helper the admission
-- gate reads, so widening the window widens both together or neither.

create or replace function screening_v2.phone_next_window_open(p_at timestamptz)
returns timestamptz
language sql
stable
set search_path = pg_catalog, screening_v2
as $$
  select case
    -- Before today's open: today's open.
    when (p_at at time zone 'Asia/Kolkata')::time < screening_v2.phone_ist_window_open_at()
      then ((p_at at time zone 'Asia/Kolkata')::date
              + screening_v2.phone_ist_window_open_at())
             at time zone 'Asia/Kolkata'
    -- Inside the window: now is already legal.
    when screening_v2.phone_ist_window_open(p_at) then p_at
    -- At or after today's close: tomorrow's open. Every day is a calling
    -- day, so there is no weekend skip to get wrong.
    else (((p_at at time zone 'Asia/Kolkata')::date + 1)
            + screening_v2.phone_ist_window_open_at())
           at time zone 'Asia/Kolkata'
  end
$$;

revoke all on function screening_v2.phone_next_window_open(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_next_window_open(timestamptz) to service_role;

comment on function screening_v2.phone_next_window_open is
  'The next instant at or after the argument at which the approved IST '
  'calling window is open. Derived from phone_ist_window_open so the '
  'window is widened in exactly one place or not at all. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 18. apply_phone_event — the insert-once ingress apply path
-- ═══════════════════════════════════════════════════════════════════════
-- Lock order here is engagement, then attempt. It takes neither the
-- advisory lock nor the application-link lock, and therefore closes no
-- cycle with admit_phone_attempt, which takes a superset of these locks
-- in the same relative order.
--
-- A DUPLICATE WRITES NO SECOND ROW. The event is inserted once, already
-- carrying its final verdict, with an untargeted `on conflict do
-- nothing`; a second delivery reads back the ORIGINAL row and returns
-- the SAME answer the first delivery received. That is why
-- `ignored_reason` has no 'duplicate' member: a duplicate is represented
-- by the absence of a second row plus the `duplicate` flag in the
-- return, which is strictly more truthful than a second row claiming to
-- be one.
--
-- Any (state, event_type) pair absent from the mapping below is an
-- explicit no-op recorded as `unexpected_event`. The machine has no
-- implicit default that mutates state. Events that are ADMISSION
-- triggers (backoff.elapsed, appointment.due, admission.granted) are
-- answered by admit_phone_attempt, not here, and are recorded as
-- unexpected if posted to this door.

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
      when v_eng.state = 'in_call' and p_event_type = 'assessment.completed' then
        v_new_state := 'completed'; v_att_state := 'ended'; v_outcome := 'completed'; -- #22
      when v_eng.state = 'in_call' and p_event_type = 'assessment.aborted' then
        -- Every other `ended` path names an outcome; an operator
        -- filtering on outcome_class must not lose these rows.
        v_new_state := 'failed'; v_att_state := 'ended'; v_outcome := 'disconnected';
        v_reason := 'assessment_aborted';
      when v_eng.state = 'in_call' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number'; -- #23
        v_reason := 'wrong_number';
      when v_eng.state = 'in_call' and p_event_type = 'candidate.opt_out' then
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24
        v_reason := 'candidate_opt_out';

      -- ── from `awaiting_retry` ───────────────────────────────────────
      when v_eng.state = 'awaiting_retry' and p_event_type = 'budget.exhausted'
           and v_eng.no_answer_attempts >= 3 then
        v_new_state := 'abandoned_no_answer'; v_reason := 'no_answer_budget_exhausted'; -- #28
      when v_eng.state = 'awaiting_retry' and p_event_type = 'day.rolled'
           and v_eng.no_answer_attempts >= 3 then
        v_new_state := 'abandoned_no_answer'; v_reason := 'no_answer_budget_exhausted';
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
      v_new_state := 'eligible';
    end if;
  end if;

  -- #18 bumps the engagement's fencing epoch; the LIVE attempt must
  -- carry the new value, or the fallback above would fence the very
  -- conversation that just started.
  if v_bump_epoch and v_att.id is not null then
    update screening_v2.phone_call_attempts
       set epoch = v_eng.epoch + 1
     where id = v_att.id;
  end if;

  if v_att_state is not null and v_att.id is not null then
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
           next_eligible_at = case when v_defer then v_slot_start else next_eligible_at end,
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
  if v_new_state in ('opted_out','wrong_number') then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      -- The one place `candidate` is the truthful actor type: the
      -- outcome originated with the person on the line.
      ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
       'phone_opt_out_recorded', 'phone_engagement', v_eng.id::text, 'success',
       jsonb_build_object('outcome', v_new_state, 'reason', v_reason,
                          'event_type', p_event_type));
  end if;

  return jsonb_build_object('status', 'applied', 'applied', true,
                            'ignored_reason', null,
                            'event_id', v_row_id, 'duplicate', false,
                            'engagement_state', coalesce(v_new_state, v_eng.state),
                            'attempt_state', coalesce(v_att_state, v_att.state));
end;
$$;

revoke all on function screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  to service_role;

comment on function screening_v2.apply_phone_event is
  'Insert-once ingress apply path for phone call events. Mints a '
  'deterministic non-null provider_event_id for internal/poll/'
  'reconciliation sources so one unique index dedups every channel, '
  'decides the verdict BEFORE writing, and inserts ONE row already '
  'carrying its applied/ignored_reason outcome. A duplicate writes no '
  'second row and returns the ORIGINAL outcome. Stable ignored reasons: '
  'stale_epoch, unknown_attempt, terminal, unexpected_event. A duplicate '
  'is not one of them — it writes no row at all. Any (state, event) pair outside the transition '
  'table is an explicit no-op — the machine has no implicit default that '
  'mutates state. Budgets move HERE and nowhere else. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 19. schedule_phone_appointment / cancel_phone_appointment
-- ═══════════════════════════════════════════════════════════════════════
-- Lock order: engagement, then appointment. No advisory lock and no
-- application-link lock — scheduling admits no call and consumes no
-- fleet slot, so it must not serialise against dialing.
--
-- There is NO external calendar. `btree_gist` and a true
-- `exclude using gist` range constraint were rejected deliberately: no
-- migration in this repository has ever issued a `create extension`, and
-- adding one is a platform dependency and a Supabase privilege question.
-- The partial unique index plus this in-RPC guard under the engagement
-- row lock is the substitute, and it is recorded as a rejection rather
-- than left as an oversight.

create or replace function screening_v2.schedule_phone_appointment(
  p_engagement_id    uuid,
  p_starts_at        timestamptz,
  p_ends_at          timestamptz,
  p_source           text,
  p_actor_id         uuid        default null,
  p_expected_version integer     default null,
  p_now              timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_eng     screening_v2.phone_engagements%rowtype;
  v_live    screening_v2.phone_appointments%rowtype;
  v_new_id  uuid;
  v_version integer;
begin
  if p_source is null or p_source not in ('candidate_voice','hr_manual','system_deferral') then
    return jsonb_build_object('status', 'invalid_source');
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    return jsonb_build_object('status', 'invalid_slot');
  end if;
  if extract(epoch from (p_ends_at - p_starts_at)) not between 900 and 3600 then
    return jsonb_build_object('status', 'slot_duration_invalid');
  end if;
  if p_starts_at < p_now then
    return jsonb_build_object('status', 'slot_in_past');
  end if;
  -- The window governs the START. How long a slot admitted at 20:55 may
  -- then run is the voice layer's maximum call duration, not a schema
  -- rule, and no constraint here pretends otherwise.
  if not screening_v2.phone_ist_window_open(p_starts_at) then
    return jsonb_build_object('status', 'window_closed');
  end if;
  if screening_v2.phone_ist_date(p_starts_at) <> screening_v2.phone_ist_date(p_ends_at) then
    return jsonb_build_object('status', 'slot_straddles_ist_midnight');
  end if;

  select * into v_eng from screening_v2.phone_engagements
   where id = p_engagement_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state = 'dialing' then
    -- A live dial owns the engagement; rescheduling under it would put
    -- the calendar and the wire into disagreement.
    return jsonb_build_object('status', 'attempt_in_flight');
  end if;

  select * into v_live from screening_v2.phone_appointments
   where engagement_id = p_engagement_id
     and status in ('scheduled','confirmed')
   for update;

  if found then
    -- Optimistic concurrency: a stale write is refused rather than
    -- silently overwriting the slot a recruiter is looking at.
    if p_expected_version is null then
      return jsonb_build_object('status', 'appointment_exists',
                                'appointment_id', v_live.id,
                                'version', v_live.version);
    end if;
    if p_expected_version <> v_live.version then
      return jsonb_build_object('status', 'version_conflict',
                                'appointment_id', v_live.id,
                                'version', v_live.version);
    end if;
    update screening_v2.phone_appointments
       set status        = 'superseded',
           version       = version + 1,
           cancel_reason = 'superseded',
           updated_at    = p_now
     where id = v_live.id;
  end if;

  insert into screening_v2.phone_appointments
    (engagement_id, starts_at, ends_at, ist_date, status, source,
     created_by, created_at, updated_at)
  values
    (p_engagement_id, p_starts_at, p_ends_at,
     screening_v2.phone_ist_date(p_starts_at), 'scheduled', p_source,
     coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid), p_now, p_now)
  returning id, version into v_new_id, v_version;

  if v_eng.state in ('eligible','in_call','reconnecting','awaiting_retry') then
    update screening_v2.phone_engagements
       set state      = 'scheduled',
           version    = version + 1,
           updated_at = p_now
     where id = p_engagement_id;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    -- An operator/candidate-negotiated slot is attributable: `recruiter`
    -- with the admin identity in actor_id, matching 0035/0040/0041. A
    -- system deferral falls back to the system sentinel.
    (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
     case when p_actor_id is null then 'system' else 'recruiter' end,
     'phone_appointment_scheduled', 'phone_appointment', v_new_id::text, 'success',
     jsonb_build_object('engagement_id', p_engagement_id,
                        'source', p_source,
                        'ist_date', screening_v2.phone_ist_date(p_starts_at),
                        'superseded', v_live.id is not null));

  return jsonb_build_object('status', 'ok',
                            'appointment_id', v_new_id,
                            'version', v_version,
                            'superseded_appointment_id', v_live.id);
end;
$$;

revoke all on function screening_v2.schedule_phone_appointment(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.schedule_phone_appointment(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz)
  to service_role;

comment on function screening_v2.schedule_phone_appointment is
  'Books or reschedules the ONE live internal appointment for an '
  'engagement, under the engagement row lock, with optimistic-version '
  'concurrency (a stale write is refused with version_conflict). '
  'Enforces the approved IST START window, the 15-60 minute slot '
  'envelope and the no-IST-midnight-straddle rule, and refuses a slot in '
  'the past, a terminal engagement and an engagement with a dial in '
  'flight. No external calendar is contacted. Service-role-only.';

create or replace function screening_v2.cancel_phone_appointment(
  p_appointment_id   uuid,
  p_reason           text,
  p_actor_id         uuid        default null,
  p_expected_version integer     default null,
  p_now              timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_apt screening_v2.phone_appointments%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
  v_eng_id uuid;
begin
  -- A FIXED vocabulary, so a cancel reason can never carry free text or
  -- anything derived from a provider payload.
  if p_reason is null or p_reason not in (
       'candidate_request','hr_cancelled','system_deferral_expired',
       'emergency_stop','engagement_cancelled','superseded') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  -- Engagement before appointment, the same relative order every other
  -- phone RPC uses.
  select engagement_id into v_eng_id
    from screening_v2.phone_appointments where id = p_appointment_id;
  if v_eng_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_eng from screening_v2.phone_engagements
   where id = v_eng_id for update;

  select * into v_apt from screening_v2.phone_appointments
   where id = p_appointment_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_apt.status = 'cancelled' then
    -- Idempotent: cancelling a cancelled slot is not an error.
    return jsonb_build_object('status', 'already_cancelled',
                              'appointment_id', v_apt.id, 'version', v_apt.version);
  end if;
  if v_apt.status not in ('scheduled','confirmed') then
    return jsonb_build_object('status', 'not_live', 'appointment_status', v_apt.status);
  end if;
  if p_expected_version is not null and p_expected_version <> v_apt.version then
    return jsonb_build_object('status', 'version_conflict', 'version', v_apt.version);
  end if;

  update screening_v2.phone_appointments
     set status        = 'cancelled',
         cancel_reason = p_reason,
         version       = version + 1,
         updated_at    = p_now
   where id = p_appointment_id;

  -- #9: an engagement whose only reason to be `scheduled` has just gone
  -- away returns to `eligible` rather than resting in a state that
  -- claims a slot exists.
  if v_eng.id is not null and v_eng.terminal_at is null and v_eng.state = 'scheduled' then
    update screening_v2.phone_engagements
       set state            = 'eligible',
           state_reason     = null,
           next_eligible_at = p_now,
           version          = version + 1,
           updated_at       = p_now
     where id = v_eng.id;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
     case when p_actor_id is null then 'system' else 'recruiter' end,
     'phone_appointment_cancelled', 'phone_appointment', p_appointment_id::text, 'success',
     jsonb_build_object('engagement_id', v_eng_id, 'reason', p_reason,
                        'previous_status', v_apt.status));

  return jsonb_build_object('status', 'ok', 'appointment_id', p_appointment_id,
                            'version', v_apt.version + 1);
end;
$$;

revoke all on function screening_v2.cancel_phone_appointment(uuid, text, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.cancel_phone_appointment(uuid, text, uuid, integer, timestamptz)
  to service_role;

comment on function screening_v2.cancel_phone_appointment is
  'Cancels one internal phone appointment under the engagement row lock, '
  'with a FIXED cancel-reason vocabulary and optional optimistic-version '
  'concurrency. Idempotent on an already-cancelled slot. Returns the '
  'engagement to `eligible` when the slot it was waiting on disappears. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 20. set_phone_halt / clear_phone_halt — the kill switch
-- ═══════════════════════════════════════════════════════════════════════
-- Modelled on set_recording_finalize_halt (0038), including its reuse of
-- the existing `admin_session_override` audit action with a
-- discriminating metadata key, so a kill switch needs no new audit
-- vocabulary. The one inversion is stated in the table comment: a
-- missing or unreadable singleton STOPS admission rather than permitting
-- it. Resuming requires this explicit, audited, attributable clear —
-- there is no automatic restart.

create or replace function screening_v2.set_phone_halt(
  p_reason   text,
  p_actor_id uuid        default null,
  p_now      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_prev timestamptz;
begin
  if p_reason is null or p_reason not in (
       'operator_pause','provider_incident','cost_control','legal_hold','emergency_stop') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.phone_control (control_key)
  values ('default') on conflict (control_key) do nothing;

  select halted_at into v_prev
    from screening_v2.phone_control
   where control_key = 'default'
   for update;

  update screening_v2.phone_control
     -- Keep the ORIGINAL halt instant while a halt is already in force,
     -- so "how long has dialing been frozen" measures the real outage.
     set halted_at     = coalesce(halted_at, p_now),
         halt_reason   = coalesce(halt_reason, p_reason),
         halt_actor_id = coalesce(halt_actor_id,
                                  coalesce(p_actor_id,
                                           '00000000-0000-4000-8000-000000000001'::uuid)),
         updated_at    = p_now
   where control_key = 'default';

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'::uuid),
     'recruiter', 'admin_session_override', 'phone_control', 'default', 'success',
     jsonb_build_object('override', 'phone_admission_halt_set',
                        'reason', p_reason,
                        'already_halted', v_prev is not null));

  return jsonb_build_object('status', 'ok', 'already_halted', v_prev is not null);
end;
$$;

create or replace function screening_v2.clear_phone_halt(
  p_actor_id uuid        default null,
  p_now      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_prev_reason text;
  v_prev_at     timestamptz;
begin
  select halt_reason, halted_at into v_prev_reason, v_prev_at
    from screening_v2.phone_control
   where control_key = 'default'
   for update;
  if not found then
    -- Nothing to clear, and inventing a cleared singleton would turn a
    -- fail-closed stop into a go.
    return jsonb_build_object('status', 'halt_unreadable');
  end if;

  update screening_v2.phone_control
     set halted_at     = null,
         halt_reason   = null,
         halt_actor_id = null,
         updated_at    = p_now
   where control_key = 'default';

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'::uuid),
     'recruiter', 'admin_session_override', 'phone_control', 'default', 'success',
     jsonb_build_object('override', 'phone_admission_halt_cleared',
                        'previous_reason', coalesce(v_prev_reason, 'none'),
                        'was_halted', v_prev_at is not null));

  return jsonb_build_object('status', 'ok', 'was_halted', v_prev_at is not null);
end;
$$;

revoke all on function screening_v2.set_phone_halt(text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_phone_halt(text, uuid, timestamptz) to service_role;
revoke all on function screening_v2.clear_phone_halt(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.clear_phone_halt(uuid, timestamptz) to service_role;

comment on function screening_v2.set_phone_halt is
  'Freezes ALL new outbound phone admission fleet-wide with no deploy, '
  'preserving the original halt instant across repeated calls. Audited '
  'and attributable. Dialing cannot resume without clear_phone_halt: '
  'there is no automatic restart. Service-role-only.';
comment on function screening_v2.clear_phone_halt is
  'The EXPLICIT, audited clear that is the only way outbound dialing '
  'resumes after a halt. Refuses halt_unreadable when the singleton is '
  'missing rather than inventing a cleared control — an unreadable kill '
  'switch on a billable dialer is a stop, not a go. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 21. phone_backlog — sanitized aggregates for health and Mission Control
-- ═══════════════════════════════════════════════════════════════════════
-- Counts and ages ONLY. No identifiers, no candidate fields, no phone
-- numbers, no provider payloads. A reader of this output learns how the
-- fleet is behaving and nothing about any person.

create or replace function screening_v2.phone_backlog(
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_halted_at    timestamptz;
  v_halt_reason  text;
  v_ctl_found    boolean;
  v_states       jsonb;
  v_live         integer;
  v_live_leased  integer;
  v_oldest_live  integer;
  v_apts         integer;
  v_apts_overdue integer;
  v_ignored      integer;
begin
  select halted_at, halt_reason into v_halted_at, v_halt_reason
    from screening_v2.phone_control where control_key = 'default';
  v_ctl_found := found;

  select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) into v_states
    from (select state, count(*) as n
            from screening_v2.phone_engagements group by state) s;

  select count(*) filter (where state in
           ('admitted','ringing','answered_unclassified','human','machine')),
         count(*) filter (where state in
           ('admitted','ringing','answered_unclassified','human','machine')
           and lease_expires_at > p_now),
         coalesce(max(case when state in
           ('admitted','ringing','answered_unclassified','human','machine')
           then floor(extract(epoch from (p_now - admitted_at)))::integer end), 0)
    into v_live, v_live_leased, v_oldest_live
    from screening_v2.phone_call_attempts;

  select count(*) filter (where status in ('scheduled','confirmed')),
         count(*) filter (where status in ('scheduled','confirmed') and starts_at < p_now)
    into v_apts, v_apts_overdue
    from screening_v2.phone_appointments;

  select count(*) into v_ignored
    from screening_v2.phone_call_events
   where ignored_reason is not null
     and received_at > p_now - interval '24 hours';

  return jsonb_build_object(
    'status', 'ok',
    'admission', jsonb_build_object(
      -- A missing singleton reports halted TRUE. The health surface must
      -- never read an unreadable kill switch as "running normally".
      'control_present', v_ctl_found,
      'halted', (not v_ctl_found) or v_halted_at is not null,
      'halt_reason', case when v_ctl_found then v_halt_reason else 'halt_unreadable' end),
    'engagements_by_state', v_states,
    'attempts', jsonb_build_object(
      'live', v_live,
      'live_with_unexpired_lease', v_live_leased,
      'max_concurrent', screening_v2.phone_max_concurrent(),
      'oldest_live_age_seconds', v_oldest_live),
    'appointments', jsonb_build_object('live', v_apts, 'overdue', v_apts_overdue),
    'events', jsonb_build_object('ignored_last_24h', v_ignored),
    'window_open', screening_v2.phone_ist_window_open(p_now),
    'ist_date', screening_v2.phone_ist_date(p_now));
end;
$$;

revoke all on function screening_v2.phone_backlog(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_backlog(timestamptz) to service_role;

comment on function screening_v2.phone_backlog is
  'Sanitized aggregate view of the phone substrate: counts and ages '
  'only, never an identifier, a candidate field, a phone number or a '
  'provider payload. A missing control singleton is reported as halted, '
  'so an unreadable kill switch can never be read as running normally. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
