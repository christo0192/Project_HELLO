-- ============================================================================
--  0094 — retire the manual dial allowlist safely
-- ============================================================================
--  `PHONE_DIAL_ALLOWLIST` is a fail-closed list of SHA-256 digests that an
--  operator maintains BY HAND. Nothing populates it, it silently truncates at
--  MAX_DIAL_ALLOWLIST_ENTRIES (64), and its refusal is a pre-claim DEFERRAL
--  that writes nothing — so a candidate who is missing from it sits `eligible`
--  for ever with no attempt row and no error anywhere. That is what happened
--  on 2026-09-10: a candidate added to the pipeline at 11:58Z was never
--  dialled because the secret had last been written at 11:12Z.
--
--  It was a bring-up canary and it has outlived its purpose. The decision it
--  approximates — "may we ring this person, now?" — is already made, far more
--  precisely, by `admit_phone_attempt`: application live, job mapping
--  `enabled`, résumé ingestion `ready`, consent granted/unexpired/complete,
--  a valid Indian mobile, not suppressed, not halted, inside the IST window,
--  within every budget, and under the concurrency cap.
--
--  Retiring a fail-closed gate on a billable outbound dialer is only safe with
--  a compensating control, so this migration ships THREE things together and
--  the API flag that retires the allowlist is inert without them:
--
--    1. `phone_max_daily_dials()` + a FLEET DAILY CAP inside
--       `admit_phone_attempt`. The allowlist's real value was bounding blast
--       radius; this bounds it by volume instead of by hand.
--    2. `suppress_candidate_phone` / `release_candidate_phone_suppression`.
--       `phone_suppressions` has been read by the grantor since 0042 and has
--       had exactly ONE writer in all that time: `apply_phone_event`, which
--       records a `candidate_opt_out` / `wrong_number` row when somebody says
--       "don't call me" DURING a call (latest body 0067:699). There has never
--       been an OPERATOR path — no route, no RPC, nothing a recruiter could
--       use, and no way to lift a row once written. While the allowlist stood
--       that hardly mattered, because an unlisted number could not be dialled
--       either way. The moment it does not, suppression is the only "never
--       call this person" mechanism there is.
--
--       Those existing candidate-authored rows are also why the RELEASE path
--       below carries an ownership predicate. A release keyed on the digest
--       alone would let an admin acting on one candidate destroy a different
--       candidate's spoken opt-out on a shared line.
--    3. `phone_suppression_state`, so an operator surface can show it.
--
--  FORWARD-ONLY. `admit_phone_attempt` is replaced wholesale (copied verbatim
--  from 0083 with two blocks added) because Postgres has no way to patch a
--  function body. The behavioural changes are the new fleet cap and the
--  candidate-scoped half of the suppression check.
--
--  NO ENV KNOB. The cap is a SQL helper exactly like `phone_max_concurrent()`,
--  and for the same reason `phone-screening/config.ts` gives: this lane has
--  already paid for a knob with no consumer. `phone-screening-config.test.ts`
--  asserts no `PHONE_MAX_DIALS_PER_IST_DAY` exists in the config, the env
--  example or the schema, and that assertion stays true.
-- ============================================================================

-- ── 1. The cap value ────────────────────────────────────────────────────────
--  50/IST-day. Deliberately well above today's volume (4 dials on the busiest
--  day so far) and well below anything that could be called a mass-dial event,
--  so it is a runaway guard and not a throttle on ordinary work. IMMUTABLE and
--  argument-free, mirroring `phone_max_concurrent()`; raising it is a
--  migration, which is the point — a blast-radius bound that any operator can
--  raise in a hurry is not a bound.
--  Declared and GRANTED exactly as `phone_max_concurrent()` is: `language sql
--  immutable`, revoked from public/anon/authenticated, granted only to
--  service_role. It is not SECURITY DEFINER, and like the six sibling constants
--  it is named in the `not_definer` exemption list in policy_tests.sql — a
--  function that reads nothing has nothing to define security over.
--
--  An earlier draft granted execute to `authenticated`, which tripped the
--  `browser_executable` posture sweep. Nothing in app/api or app/web calls this
--  function, so that grant had no consumer and was pure posture regression.
create or replace function screening_v2.phone_max_daily_dials()
returns integer
language sql
immutable
set search_path to 'pg_catalog'
as $$ select 50 $$;

comment on function screening_v2.phone_max_daily_dials() is
  'Fleet-wide cold-dial ceiling per IST day. Enforced ONLY inside '
  'admit_phone_attempt, under the phone_admission advisory lock. Excludes '
  'reconnect (already-charged budget) and infra-deferred abandonments. '
  'scheduled dials are COUNTED but never refused.';

revoke all on function screening_v2.phone_max_daily_dials()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_max_daily_dials() to service_role;

-- ── 2. `admit_phone_attempt`, verbatim from 0083 + the fleet daily cap ──────
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
  v_day_dials      integer;
  v_max_daily      constant integer := screening_v2.phone_max_daily_dials();
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
  -- ── 0094: SUPPRESSION IS CHECKED ON THE LINE **AND** ON THE PERSON ──
  -- The digest half is 0042's and is unchanged: it is what makes a
  -- do-not-call promise survive the person applying to a second role, and
  -- what covers a household or reassigned line.
  --
  -- The `candidate_id` half is new, and it closes a hole that the retiring
  -- allowlist was incidentally covering. `phone_suppressions` keys on the
  -- digest of the number AT THE TIME THE PROMISE WAS MADE, while
  -- `verify_candidate_phone` (0057) rewrites `candidates.phone_e164` for an
  -- arbitrary candidate with no suppression check at all. So: candidate opts
  -- out in-call, HR later corrects a typo in the number, the new digest
  -- matches nothing, and the person who said "never call me" is dialable
  -- again. Under `allowlist` that could not happen automatically, because the
  -- corrected number ALSO had to be hand-pasted into PHONE_DIAL_ALLOWLIST
  -- before anything could dial it, and a human was in that loop.
  -- `PHONE_DIAL_SCOPE=pipeline` removes the human, so the check has to be
  -- here instead.
  --
  -- The two halves are an OR, deliberately: either the line is suppressed or
  -- this person is, and both refuse. A row whose `candidate_id` was NULLed by
  -- the FK's ON DELETE SET NULL still refuses on the digest half.
  if exists (select 1 from screening_v2.phone_suppressions
              where phone_sha256 = v_digest
                 or candidate_id = v_eng.candidate_id) then
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
     and v_eng.no_answer_attempts >= v_eng.no_answer_limit then
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

  -- ── 0083 DELTA (engagement-level daily pre-check) ────────────────────
  -- Narrowed to match the 0083 per-IST-day INDEX predicate exactly: an
  -- infra-deferred abandonment (state='abandoned' AND
  -- abandon_reason='infra_deferred') is EXCLUDED here just as it is excluded
  -- from the index, so the SELECT pre-check and the INSERT-conflict path agree.
  -- Without this narrowing the pre-check would still count the infra-deferred
  -- row and fire `daily_attempt_exists`, leaving the engagement wedged until
  -- IST midnight even though the index would now let the insert through — i.e.
  -- the index fix alone would be INERT. A lease-RECLAIMED abandonment
  -- (abandon_reason NULL — the call rang/answered) is NOT excluded and still
  -- charges the day.
  v_ist_date := screening_v2.phone_ist_date(p_now);
  if p_kind in ('initial','no_answer_retry','scheduled')
     and exists (select 1 from screening_v2.phone_call_attempts
                  where engagement_id = p_engagement_id
                    and ist_date = v_ist_date
                    and kind in ('initial','no_answer_retry','scheduled')
                    -- NULL-SAFE: see the index predicate. Reclaim rows have
                    -- abandon_reason NULL; NOT(... AND NULL) is NULL and would
                    -- silently uncount them. IS DISTINCT FROM keeps them charged.
                    and (state <> 'abandoned'
                         or abandon_reason is distinct from 'infra_deferred')) then
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

  -- Guard B — this person has not already been COLD-CALLED today, on any
  -- engagement.
  --
  -- `reconnect` is excluded for the same reason the per-engagement index
  -- excludes it: it redeems a budget already charged at the grant and must
  -- not be refused by a daily counter.
  --
  -- `scheduled` is excluded too, and that exclusion is the whole difference
  -- between an anti-harassment guard and a broken promise. A scheduled dial
  -- is NOT a cold call — it is a slot the candidate or HR booked
  -- (`schedule_phone_appointment` sources `hr_manual` / `candidate_voice`),
  -- and it is booked on an engagement whose owner cannot see the person's
  -- other engagements. Refusing it means the candidate agreed to a time,
  -- nobody rang, the appointment sat `scheduled` until the expiry sweep
  -- dropped it, and the only signal was a counter on a health page. The
  -- person asked to be called; declining to call them is not protecting
  -- them.
  --
  -- What still protects them is Guard A: if the other engagement is on the
  -- phone with them right now, the scheduled dial is refused
  -- `candidate_call_in_flight` — one line, one conversation, always.
  --
  -- ── 0083 DELTA (candidate-level daily pre-check) ─────────────────────
  -- Same narrowing as the engagement-level pre-check and the index: an
  -- infra-deferred abandonment on ANOTHER engagement of this candidate is
  -- EXCLUDED, so a pool hiccup on engagement A does not wedge a same-day cold
  -- call on engagement B. A reclaim-abandoned row (abandon_reason NULL) on
  -- another engagement — a call that reached this person — still charges the
  -- candidate's day, so the anti-harassment guard holds.
  if p_kind in ('initial','no_answer_retry')
     and exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind in ('initial','no_answer_retry','scheduled')
       -- NULL-SAFE: see the index predicate (reclaim rows carry NULL reason).
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred')
  ) then
    return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                              'ist_date', v_ist_date);
  end if;

  -- ── 0094: THE FLEET DAILY CAP ──────────────────────────────────────
  -- The blast-radius control that lets `PHONE_DIAL_SCOPE=pipeline` retire
  -- the per-number allowlist. Until now the only thing bounding how many
  -- DISTINCT people the dialer could ring in a day was that an operator had
  -- to paste each number's digest into `PHONE_DIAL_ALLOWLIST` by hand.
  -- `phone_max_concurrent()` bounds SIMULTANEITY, not VOLUME: ten at a time,
  -- all day, is thousands of calls.
  --
  -- It lives HERE, inside the sole grantor, under the same advisory lock as
  -- every other guard, for the reason `phone-screening/config.ts` states
  -- about knobs generally: a cap enforced in TypeScript is decoration. Any
  -- other caller bypasses it, and two API replicas racing would each read a
  -- count below the cap and both admit. Counted under
  -- `pg_advisory_xact_lock(hashtext('phone_admission'))`, count-then-refuse
  -- is atomic by construction.
  --
  -- COUNTED, NEVER STORED. Derived from `phone_call_attempts` at decision
  -- time, so there is no counter to drift, to reset at IST midnight, or to
  -- leave wrong after a manual row change.
  --
  -- ── WHY THIS SITS BEFORE THE CONCURRENCY CAP ───────────────────────
  -- Both refusals can be true at once, and the caller is told only the first.
  -- `at_capacity` clears BY ITSELF as live calls end; `fleet_daily_cap_reached`
  -- clears at IST midnight and not before. Reporting the self-clearing one
  -- first sends an operator to wait for calls to finish that will not help —
  -- the precise misreport `rpc-contract.ts` promises this status will not
  -- make. The one that clears LAST is the one that must be reported.
  --
  -- ── `reconnect` IS EXCLUDED ────────────────────────────────────────
  -- Load-bearing rather than cosmetic. A reconnect redeems a budget already
  -- charged at the grant (apply_phone_event #19); refusing it would strand
  -- the engagement in `reconnecting` with no edge out — the cap would be
  -- enforced by wedging rows rather than by declining calls. Same reasoning
  -- the no-answer budget above states for itself.
  --
  -- ── `scheduled` IS COUNTED BUT NEVER REFUSED ───────────────────────
  -- This is the distinction Guard B above spends a paragraph on, and an
  -- earlier draft of this block got it wrong in the direction that breaks a
  -- promise. A scheduled dial is NOT a cold call: it is a slot the candidate
  -- or HR booked, and `schedule_phone_appointment` sources it `hr_manual` or
  -- `candidate_voice`. Refusing it means the candidate agreed to a time,
  -- nobody rang, and the appointment sat `scheduled` until the expiry sweep
  -- marked it `missed` — with the only signal a counter on a health page,
  -- which is the exact failure shape this whole migration exists to end.
  --
  -- It is still COUNTED, because it is a real billable call and the ceiling
  -- is about spend and blast radius. So a day full of booked slots can push
  -- the count past the ceiling and stop COLD calls, which is right: the
  -- people who asked to be called still are, and the people who did not are
  -- not rung by a runaway.
  --
  -- The infra-defer narrowing matches the per-engagement and per-candidate
  -- daily pre-checks and the 0083 index predicate exactly: a pool hiccup
  -- that placed no call must not spend the fleet's day. Reclaim rows carry
  -- a NULL `abandon_reason` and IS DISTINCT FROM keeps them counted, because
  -- those calls did reach somebody.
  --
  -- THE DAY KEY IS `p_now`, not the machine clock, exactly like every other
  -- guard in this function. That is a deliberate, structurally-enforced
  -- property (`phone-screening-rpc-contract.test.ts` asserts no RPC body
  -- reads the clock), and it means the ceiling is only as strong as the
  -- caller's clock: a caller supplying a date inside the IST window gets that
  -- date's budget. Production has exactly one caller and it passes the real
  -- instant. Anything that backfills or replays MUST pass the true `p_now`,
  -- or it will both mint a fresh budget and write a wrong `ist_date` into the
  -- per-IST-day uniqueness index.
  if p_kind in ('initial','no_answer_retry') then
    select count(*) into v_day_dials
      from screening_v2.phone_call_attempts
     where ist_date = v_ist_date
       and kind in ('initial','no_answer_retry','scheduled')
       and (state <> 'abandoned'
            or abandon_reason is distinct from 'infra_deferred');
    if v_day_dials >= v_max_daily then
      return jsonb_build_object('status', 'fleet_daily_cap_reached',
                                'ist_date', v_ist_date,
                                'dials_today', v_day_dials,
                                'max_daily', v_max_daily);
    end if;
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

-- ── 3. Audit action — additive widening ─────────────────────────────────────
--  Re-declared in full because a CHECK cannot be patched in place. Every
--  pre-existing action (through 0084) is reproduced verbatim; the assertion
--  that nothing was dropped lives in policy_tests.sql.
--
--  `phone_suppression_added` has existed since 0042 and was unreachable —
--  nothing in the API could write it. The RELEASE direction had no action at
--  all, and it is the one that can cause a call, so it gets its own name
--  rather than being folded into the generic `resource_delete`: "somebody
--  lifted a do-not-call promise" is not a fact that should need a join to
--  three other columns to read.

alter table screening_v2.audit_events drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events add constraint chk_audit_action check (action in (
  'invite_sent', 'invite_revoked', 'invite_consumed', 'grant_issued', 'grant_revoked', 'grant_consumed',
  'screening_started', 'screening_completed', 'screening_failed', 'assessment_recorded',
  'candidate_status_changed', 'candidate_consent_updated', 'session_created', 'session_updated',
  'session_terminated', 'membership_created', 'membership_updated', 'membership_deactivated',
  'role_created', 'role_updated', 'role_deactivated', 'export_requested', 'export_completed',
  'login_success', 'login_failure', 'logout', 'config_changed', 'auth_login_success',
  'auth_login_failure', 'auth_token_refresh', 'auth_logout', 'rbac_access_denied',
  'rbac_ownership_denied', 'resource_create', 'resource_read', 'resource_update',
  'resource_delete', 'resource_list', 'rate_limit_exceeded', 'audit_sink_failure',
  'audit_configuration_error', 'recording_download', 'recording_upload',
  'recording_integrity_verified', 'recording_quarantined', 'recording_revoked', 'recording_deleted',
  'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update', 'quota_override',
  'notification_create', 'appeal_create', 'appeal_review', 'allowlist_linked',
  'admin_allowlist_add', 'admin_allowlist_update', 'ashby_mapping_update', 'ashby_mapping_drift',
  'ashby_application_cancel', 'ashby_operation_enqueue', 'ashby_operation_update',
  'ashby_operation_retry', 'ashby_writeback_pending', 'ashby_invite_delivered',
  'ashby_ingestion_attempts_reset', 'ashby_ingestion_parse_recovery',
  'ashby_ingestion_legacy_bad_output_recovery', 'phone_attempt_admitted',
  'phone_attempt_classified', 'phone_attempt_ended', 'phone_appointment_scheduled',
  'phone_appointment_cancelled', 'phone_appointment_missed', 'phone_opt_out_recorded',
  'phone_suppression_added', 'phone_recording_attached', 'phone_rescreen_requested',
  'phone_number_reverified', 'phone_test_gate_armed', 'phone_test_gate_consumed',
  'phone_callback_confirmed', 'phone_callback_recovery_required',
  'ashby_ingestion_model_degraded_recovery',
  -- Phone (0094, additive): lifting a do-not-call suppression.
  'phone_suppression_released'
)) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;
comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed audit vocabulary through 0094, including suppression release.';

-- ── 4. Suppression write path ───────────────────────────────────────────────
--  THE NUMBER NEVER CROSSES THE BOUNDARY. Both RPCs take a CANDIDATE ID and
--  read `phone_e164` from the candidate row themselves, exactly as
--  `admit_phone_attempt` does, so the digest is computed server-side and no
--  caller can supply, learn or log a number. This is the invariant 0042 states
--  and it is why there is no `p_phone` parameter to be tempted by.

create or replace function screening_v2.suppress_candidate_phone(
  p_candidate_id uuid,
  p_reason       text,
  p_source       text        default 'operator',
  p_actor_id     uuid        default null,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'screening_v2'
as $$
declare
  v_phone   text;
  v_digest  text;
  v_id      uuid;
  v_existed boolean := false;
  v_stopped integer := 0;
begin
  -- Closed vocabularies, checked here so the caller gets a named refusal
  -- instead of a constraint-violation exception. These mirror
  -- chk_phone_suppressions_reason / chk_phone_suppressions_source; the CHECKs
  -- remain the authority and this is the courtesy.
  if p_reason is null or p_reason not in
     ('candidate_opt_out','wrong_number','dnd_registry','operator') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;
  if p_source is null or p_source not in
     ('candidate','operator','system','registry') then
    return jsonb_build_object('status', 'invalid_source');
  end if;

  select phone_e164 into v_phone
    from screening_v2.candidates
   where id = p_candidate_id;
  if not found then
    return jsonb_build_object('status', 'candidate_not_found');
  end if;
  -- Deliberately NOT gated on `phone_valid`. A number too malformed to dial
  -- can still be one somebody has asked us never to ring, and refusing to
  -- record that would be the wrong way round. The shape check below is only
  -- what `sha256_hex` needs to produce a well-formed digest.
  if v_phone is null or v_phone !~ '^\+[0-9]{6,15}$' then
    return jsonb_build_object('status', 'phone_absent');
  end if;

  v_digest := screening_v2.sha256_hex(v_phone);

  -- IDEMPOTENT. `uq_phone_suppressions_phone` is on the DIGEST, so two
  -- candidate rows sharing a number resolve to one suppression — which is
  -- correct: the do-not-call promise is made to a PERSON's line, not to a row.
  -- The existing row is left untouched rather than re-attributed, so the
  -- original reason, source and actor survive; re-suppressing is a no-op that
  -- reports what is already true.
  select id into v_id
    from screening_v2.phone_suppressions
   where phone_sha256 = v_digest;
  if found then
    v_existed := true;
  else
    insert into screening_v2.phone_suppressions
      (candidate_id, phone_sha256, reason, source, created_by, created_at)
    values
      (p_candidate_id, v_digest, p_reason, p_source, p_actor_id, p_now)
    on conflict (phone_sha256) do nothing
    returning id into v_id;
    if v_id is null then
      -- Lost a race with a concurrent suppression. The outcome the caller
      -- asked for is nonetheless true, so report it as already-suppressed
      -- rather than as an error — BUT ONLY IF IT REALLY IS TRUE. An earlier
      -- draft set `v_existed := true` unconditionally here, so a racer that
      -- aborted, or a release landing between the insert and this re-read,
      -- produced `{"status":"ok","already_suppressed":true}` with no row
      -- anywhere. A do-not-call write path must fail CLOSED: reporting a
      -- promise that was never recorded is the worst answer this function
      -- can give.
      select id into v_id
        from screening_v2.phone_suppressions
       where phone_sha256 = v_digest;
      if not found then
        return jsonb_build_object('status', 'suppression_lost');
      end if;
      v_existed := true;
    end if;
  end if;

  -- ── STOP ANY DIAL ALREADY IN FLIGHT FOR THIS PERSON ────────────────
  -- Recording the promise is not keeping it. `admit_phone_attempt` checks
  -- suppression at ADMISSION, and `dial.ts` deliberately does not re-check it
  -- downstream, so an attempt admitted a moment ago still has a claimable
  -- `phone.dial` job and the phone rings anyway. An operator who was told
  -- "ok" while the call connects has been failed as completely as one who
  -- was told nothing.
  --
  -- Only `pending`/`delayed` jobs are stopped — a job already `active` is
  -- being executed by a worker this transaction cannot reach, and rewriting
  -- its row would race the runner. That residue is bounded by one dial and is
  -- reported honestly in `dials_stopped` rather than papered over.
  --
  -- `failed` rather than a new `cancelled` member: `chk_job_queue_status` is a
  -- closed five-member vocabulary and widening a queue-wide CHECK to describe
  -- one caller's intent is a bigger change than this migration should make.
  -- `failed` is terminal, the runner does not claim it, and `error_message`
  -- carries the reason — so the row says truthfully that the dial did not and
  -- will not happen. `attempts` is pinned to `max_attempts` so no retry path
  -- can resurrect it.
  update screening_v2.job_queue j
     set status        = 'failed',
         failed_at     = p_now,
         attempts      = j.max_attempts,
         error_message = 'phone_suppressed'
   where j.name = 'phone.dial'
     and j.status in ('pending','delayed')
     and exists (
       select 1
         from screening_v2.phone_call_attempts a
         join screening_v2.phone_engagements e on e.id = a.engagement_id
        where e.candidate_id = p_candidate_id
          and j.dedup_key = 'phone.dial:' || a.id::text);
  get diagnostics v_stopped = row_count;

  -- No number, no digest. An audit row that carried the digest would put a
  -- per-person identifier into a table read far more widely than
  -- `phone_suppressions` itself.
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'::uuid),
     'recruiter', 'phone_suppression_added', 'candidate',
     p_candidate_id::text, 'success',
     jsonb_build_object('reason', p_reason, 'source', p_source,
                        'already_suppressed', v_existed,
                        'dials_stopped', v_stopped));

  return jsonb_build_object('status', 'ok',
                            'already_suppressed', v_existed,
                            'dials_stopped', v_stopped);
end;
$$;

revoke all on function screening_v2.suppress_candidate_phone(uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.suppress_candidate_phone(uuid, text, text, uuid, timestamptz)
  to service_role;

create or replace function screening_v2.release_candidate_phone_suppression(
  p_candidate_id uuid,
  p_actor_id     uuid        default null,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'screening_v2'
as $$
declare
  v_phone   text;
  v_digest  text;
  v_deleted integer;
  v_reason  text;
  v_source  text;
  v_created timestamptz;
begin
  select phone_e164 into v_phone
    from screening_v2.candidates
   where id = p_candidate_id;
  if not found then
    return jsonb_build_object('status', 'candidate_not_found');
  end if;
  if v_phone is null or v_phone !~ '^\+[0-9]{6,15}$' then
    return jsonb_build_object('status', 'phone_absent');
  end if;

  v_digest := screening_v2.sha256_hex(v_phone);

  -- ── THE OWNERSHIP PREDICATE IS LOAD-BEARING ────────────────────────
  -- `uq_phone_suppressions_phone` is on the DIGEST, so one row can cover
  -- several candidate records that share a line — a household phone, a
  -- reassigned number, a duplicate application. That is correct for the ADD
  -- direction and is why 0042 keys it that way.
  --
  -- It is catastrophic for the DELETE direction without this predicate. An
  -- earlier draft deleted on the digest alone, so an admin lifting candidate
  -- B's suppression destroyed candidate A's row — and A's row is very often
  -- the one that matters, because `apply_phone_event` has written
  -- `reason='candidate_opt_out', source='candidate'` there since 0042 every
  -- time somebody says "don't call me" DURING a call. The audit row named B,
  -- the deleted row's reason and owner were unreconstructable, and under
  -- `PHONE_DIAL_SCOPE=pipeline` A became dialable again.
  --
  -- So a release may only lift a promise this candidate's own record carries.
  -- Anything else is refused by name, below, rather than silently widened.
  --
  -- ── AND IT IS KEYED ON THE PERSON, NOT ON TODAY'S DIGEST ───────────
  -- A first attempt at this predicate matched `phone_sha256 = v_digest AND
  -- candidate_id = p_candidate_id`, which looks right and strands people:
  -- `verify_candidate_phone` rewrites `candidates.phone_e164`, so after a
  -- corrected typo the stored row's digest no longer matches the candidate's
  -- current number and the release answered `not_suppressed` for ever. The
  -- candidate stayed (correctly) undialable via the candidate_id half of
  -- admission's check, with no operator path to lift it — a dead end this
  -- suite caught as assertion E4.
  --
  -- `candidate_id` is therefore the key. The orphan arm covers a row whose
  -- owner was deleted (the FK is ON DELETE SET NULL): nobody owns it, so the
  -- candidate whose line it currently blocks may lift it.
  --
  -- RETURNING INTO takes the first row when several match — a candidate whose
  -- number changed twice can own two rows. That is fine for the audit's
  -- purpose (`released` carries the true count) and no STRICT is wanted here,
  -- because more than one row is a legitimate outcome rather than an error.
  delete from screening_v2.phone_suppressions
   where candidate_id = p_candidate_id
      or (phone_sha256 = v_digest and candidate_id is null)
  returning reason, source, created_at
      into v_reason, v_source, v_created;
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    -- DISTINGUISH "nothing to lift" from "somebody else's promise". Folding
    -- the second into `not_suppressed` would tell an operator the line is
    -- free when it is not, in the direction that causes calls.
    if exists (select 1 from screening_v2.phone_suppressions
                where phone_sha256 = v_digest) then
      return jsonb_build_object('status', 'suppressed_by_other_candidate');
    end if;
    return jsonb_build_object('status', 'not_suppressed');
  end if;

  -- A release is the direction that can cause a call, so it is audited even
  -- though the add already is — and it records WHAT was lifted. A hard DELETE
  -- with a bare `{"released": 1}` left no way to reconstruct whether the
  -- promise had been a candidate's own opt-out or an operator's note. Reason
  -- and source are closed vocabularies, not identifiers; the digest is still
  -- never written here. `p_now` is stamped for parity with every other
  -- operator RPC in this lane.
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'::uuid),
     'recruiter', 'phone_suppression_released', 'candidate',
     p_candidate_id::text, 'success',
     jsonb_build_object('released', v_deleted, 'at', p_now,
                        'released_reason', v_reason,
                        'released_source', v_source,
                        'suppressed_at', v_created));

  return jsonb_build_object('status', 'ok', 'released', v_deleted,
                            'released_reason', v_reason,
                            'released_source', v_source);
end;
$$;

revoke all on function screening_v2.release_candidate_phone_suppression(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.release_candidate_phone_suppression(uuid, uuid, timestamptz)
  to service_role;

-- ── 5. Suppression read ─────────────────────────────────────────────────────
--  Returns a BOOLEAN and the closed-vocabulary reason. Never the digest: the
--  routes/phone.ts boundary contract names "a suppression digest" among the
--  things that may not cross it, and a read that returned one would be the
--  hole in that promise.
create or replace function screening_v2.phone_suppression_state(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'screening_v2'
as $$
declare
  v_phone text;
  v_row   screening_v2.phone_suppressions%rowtype;
begin
  select phone_e164 into v_phone
    from screening_v2.candidates
   where id = p_candidate_id;
  if not found then
    return jsonb_build_object('status', 'candidate_not_found');
  end if;
  if v_phone is null or v_phone !~ '^\+[0-9]{6,15}$' then
    return jsonb_build_object('status', 'ok', 'suppressed', false);
  end if;

  select * into v_row
    from screening_v2.phone_suppressions
   where phone_sha256 = screening_v2.sha256_hex(v_phone);
  if not found then
    return jsonb_build_object('status', 'ok', 'suppressed', false);
  end if;

  -- `owned` says whether the promise is on THIS candidate's record or on
  -- another one sharing the line. Both mean "do not dial", so `suppressed`
  -- is true either way — but only an owned promise can be lifted here, and an
  -- operator who cannot see the difference will try to lift one that is not
  -- theirs and be refused by a status they have no way to anticipate.
  return jsonb_build_object('status', 'ok', 'suppressed', true,
                            'owned', v_row.candidate_id is not distinct from p_candidate_id,
                            'reason', v_row.reason,
                            'source', v_row.source,
                            'created_at', v_row.created_at);
end;
$$;

revoke all on function screening_v2.phone_suppression_state(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_suppression_state(uuid) to service_role;

-- ── 6. The index the fleet cap counts on ────────────────────────────────────
--  Without this the cap's `count(*)` seq-scans EVERY attempt ever recorded, on
--  every admission, while holding `pg_advisory_xact_lock('phone_admission')` —
--  the global serialiser. Measured on a rehearsal database: 4 rows → Index Only
--  Scan, 2 buffers, 0.3 ms; 96k rows → Seq Scan, 1,574 buffers, 31.8 ms, with
--  95,996 rows removed by filter. The cost is O(all attempts ever) rather than
--  O(today's), it is paid inside the lock so it throttles the whole fleet, and
--  it degrades linearly and invisibly. 0083 added an index when it added its
--  pre-checks; this migration owes one for the same reason.
--
--  The predicate mirrors the count's WHERE clause exactly, so the index answers
--  it rather than merely narrowing it. `kind` and the infra-defer narrowing are
--  IMMUTABLE expressions over the row, so the partial index is legal.
--
--  NOT `concurrently`: the migration runner wraps each file in a transaction and
--  CREATE INDEX CONCURRENTLY cannot run inside one. `phone_call_attempts` holds
--  ~150 rows in production today, so the brief ACCESS EXCLUSIVE lock is measured
--  in milliseconds. If this table is ever large at deploy time, build the index
--  out-of-band first and `if not exists` makes this statement a no-op.
create index if not exists idx_phone_attempts_ist_date_fleet
  on screening_v2.phone_call_attempts (ist_date)
  where kind in ('initial','no_answer_retry','scheduled')
    and (state <> 'abandoned' or abandon_reason is distinct from 'infra_deferred');

comment on index screening_v2.idx_phone_attempts_ist_date_fleet is
  'Serves the 0094 fleet daily-dial count inside admit_phone_attempt. Its '
  'predicate must stay identical to that count''s WHERE clause.';
