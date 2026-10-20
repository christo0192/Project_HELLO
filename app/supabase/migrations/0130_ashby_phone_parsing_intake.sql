-- =====================================================================
-- 0130 — Ashby "phone parsing" intake for applicants without a resume
-- (M017, ADR-0018).
--
-- An Ashby application is screened today only when a resume file is
-- attached: with no handle the ingestion never leaves `queued`, ensure
-- answers ingestion_not_ready and admit refuses the dial. ADR-0018 names two
-- intake types. resume_parsing is that pipeline, unchanged. phone_parsing
-- takes the name, email and number from the Ashby candidate record and
-- screens on the role's template with no resume evidence.
--
-- FORWARD-ONLY and ADDITIVE. One migration in numbered sections, each
-- strictly between its own `-- ==== 0130 §N BEGIN ====` / `END` markers:
--
--   §1  Link columns. ashby_application_links.intake_type (default
--       resume_parsing), the durable profile-sweep state
--       profile_checked_at, profile_attempts, profile_outcome, and the
--       first identity mismatch identity_mismatch_attempt_id. Links come
--       before candidates, the order admit and ensure lock them in.
--   §2  Candidate column. candidates.ashby_phone_applied_at, the once-only
--       marker for an applied Ashby number.
--   §3  admit_phone_attempt, lifted in full from 0114 with ONE marked
--       hunk pair (M017-a): a phone_parsing application skips only the
--       resume/ingestion gate.
--   §4  ensure_ashby_phone_engagement, lifted in full from 0114 with M017-b
--       (the same gate skip) and M017-c (the consent proof basis).
--   §5-§7  apply_ashby_candidate_profile, claim_ashby_profile_due and
--       release_ashby_number_after_identity_mismatch (new RPCs).
--   §8  verify_candidate_phone, lifted in full from 0099 with ONE marked
--       hunk (M017-d): it locks the engagements it clears before the
--       candidate, the order every other writer of both takes.
--
-- COMPATIBILITY. Every new column is nullable or has a default, and a row
-- the pre-0130 app inserts reads resume_parsing. The admit and ensure hunks
-- key ONLY on intake_type = 'phone_parsing', which only
-- apply_ashby_candidate_profile (§5) writes, so until the new app stamps a
-- link both bodies take the 0114 path for every row.
--
-- Function ownership (newest declaration before this file):
--   admit_phone_attempt ............................. 0114 (lifted here, §3)
--   ensure_ashby_phone_engagement ................... 0114 (lifted here, §4)
--   apply_ashby_candidate_profile ................... new (§5)
--   claim_ashby_profile_due ......................... new (§6)
--   release_ashby_number_after_identity_mismatch .... new (§7)
--   verify_candidate_phone .......................... 0099 (lifted here, §8)
--
-- Conventions: `$$` bodies; no machine-clock reads in any function body;
-- `set search_path = pg_catalog, screening_v2`; execute revoked from the
-- browser roles; no PII in any log, audit row or returned value.
-- =====================================================================

-- Fail fast rather than queue: §1 and §2 add columns and CHECKs to
-- ashby_application_links and candidates (ACCESS EXCLUSIVE until COMMIT,
-- because `supabase db push` runs this file in one transaction). A long wait
-- to ACQUIRE a lock should fail the deploy (it retries cleanly), not stall
-- live screening. LOCAL: scoped to the migration's transaction (0125
-- precedent).
set local lock_timeout = '10s';


-- ==== 0130 §1 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §1 — the intake type and the profile-sweep state on the link.
--
--   intake_type         resume_parsing | phone_parsing. Only
--                       apply_ashby_candidate_profile writes phone_parsing,
--                       and only while the link has no resume handle and its
--                       ingestion row is absent or `queued`, or (B3) has a
--                       handle whose ingestion rests in `failed_review` on
--                       a verdict about the document, the unreadable
--                       resume (§5 step 9). Never flipped back.
--   profile_checked_at  when the profile sweep last claimed this link, or the
--                       profile step last recorded an outcome. NULL = never.
--   profile_attempts    claims so far. The sweep backs off exponentially
--                       and stops at its maximum, which bounds Ashby polling
--                       across machines and restarts.
--   profile_outcome     the last outcome of the profile step, from a closed
--                       vocabulary.
--   identity_mismatch_attempt_id
--                       (B2) the attempt on which the first confirmed wrong
--                       person was recorded for the Ashby number; §7
--                       releases the number only on the second. NO foreign
--                       key, so deleting an attempt or a candidate is never
--                       blocked: §7 re-checks that the attempt still exists,
--                       belongs to the engagement and postdates the number.
--
-- Every value is a code, a count, a time or an opaque id: no name, email or
-- number.
-- ─────────────────────────────────────────────────────────────────────
alter table screening_v2.ashby_application_links
  add column if not exists intake_type text not null default 'resume_parsing'
    constraint chk_ashby_application_links_intake_type check (intake_type in ('resume_parsing','phone_parsing')),
  add column if not exists profile_checked_at timestamptz,
  add column if not exists profile_attempts integer not null default 0
    constraint chk_ashby_application_links_profile_attempts check (profile_attempts between 0 and 1000),
  add column if not exists profile_outcome text
    constraint chk_ashby_application_links_profile_outcome check (profile_outcome is null or profile_outcome in (
      'applied','number_invalid','number_placeholder','number_shared','name_missing',
      'resume_found','resume_shape_unknown','stage_moved','application_inactive','mapping_inactive',
      'subject_request_hold','engagement_active','not_applicable','ashby_unavailable',
      'identity_unconfirmed','application_terminal','candidate_missing')),
  add column if not exists identity_mismatch_attempt_id uuid;

comment on column screening_v2.ashby_application_links.intake_type is
  '0130 (M017, ADR-0018): how this Ashby application is screened. '
  'resume_parsing (the default, and every row the pre-0130 app inserts) is '
  'the resume pipeline. phone_parsing means no usable resume is attached '
  '(none at all, or one whose ingestion rests in failed_review on a '
  'document verdict): the name, '
  'email and number come from the Ashby candidate record, and admit and '
  'ensure skip only the resume/ingestion gate. Written only by '
  'apply_ashby_candidate_profile, and never flipped back.';

comment on column screening_v2.ashby_application_links.identity_mismatch_attempt_id is
  '0130 (M017 B2, ADR-0018): the phone_call_attempts id on which the first '
  'confirmed identity mismatch was recorded for an unverified Ashby-applied '
  'number. release_ashby_number_after_identity_mismatch releases the number '
  'only on a second mismatch of the same engagement after the number was '
  'applied. NULL = none recorded. An opaque id only, deliberately without a '
  'foreign key so no attempt or candidate delete is ever blocked.';

comment on column screening_v2.ashby_application_links.profile_checked_at is
  '0130 (M017, ADR-0018): when the Ashby profile sweep last claimed this link, '
  'or the profile step last recorded an outcome. NULL = never checked. Drives '
  'the sweep backoff together with profile_attempts.';

comment on column screening_v2.ashby_application_links.profile_attempts is
  '0130 (M017, ADR-0018): how many times claim_ashby_profile_due has claimed '
  'this link. The sweep stops at its maximum attempt count, which bounds '
  'Ashby polling across machines and restarts.';

comment on column screening_v2.ashby_application_links.profile_outcome is
  '0130 (M017, ADR-0018): the last outcome of the Ashby profile step, from '
  'the closed vocabulary in its CHECK. NULL = no outcome recorded yet. A code '
  'only: never a name, email or number.';
-- ==== 0130 §1 END ====


-- ==== 0130 §2 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §2 — the once-only marker for an applied Ashby number. Set by
-- apply_ashby_candidate_profile in the same update that applies the number,
-- and never cleared, so an Ashby number is applied at most once per
-- candidate row, even after that number is later invalidated. A time only:
-- the number itself lives in phone_e164.
-- ─────────────────────────────────────────────────────────────────────
alter table screening_v2.candidates add column if not exists ashby_phone_applied_at timestamptz;

comment on column screening_v2.candidates.ashby_phone_applied_at is
  '0130 (M017, ADR-0018): once-only marker for an applied Ashby number, never '
  'cleared. Set by apply_ashby_candidate_profile when it applies the number '
  'from the Ashby candidate record; while it is set that function never '
  'applies an Ashby number to this row again. A time only: no number.';
-- ==== 0130 §2 END ====


-- ==== 0130 §3 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §3 — admit_phone_attempt: the intake gate (M017-a). Lifted IN FULL from
-- 0114 §6, its newest declaration. Every 0114 line is kept byte-for-byte,
-- the 0114 C8-a hunks included; 0130 only ADDS one marked hunk pair
-- (`-- ▼ 0130 <id>` … `-- ▲ 0130 <id>`), and stripping both restores the
-- 0114 body exactly.
--
--   M017-a intake gate open / close  wrap the resume/ingestion gate in
--                        `if v_link.intake_type is distinct from 'phone_parsing'`,
--                        so a phone_parsing application (no resume by
--                        definition) skips ONLY that gate. Every other gate
--                        (halt, suppression, consent, budgets, the C8-a line
--                        guards) runs unchanged.
--
-- LOCK 1 is still the first statement, the hunks add no handler and no
-- status (29, as 0114), and the halt read is untouched. Signature, security
-- posture and privileges are unchanged and re-issued below.
-- ─────────────────────────────────────────────────────────────────────
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
  -- 0095: which dial of the IST day this admission would be (1 or 2).
  v_day_seq        integer;
  v_apt_id         uuid;
  v_max_concurrent constant integer := screening_v2.phone_max_concurrent();
  v_day_dials      integer;
  v_max_daily      constant integer := screening_v2.phone_max_daily_dials();
  v_queue_name     constant text    := 'phone.dial';
  v_job_max_attempts constant integer := 5;
  -- ▼ 0114 C8-a declare
  -- Every candidate row on this admission's LINE (same phone_e164), and
  -- which of them a guard refusal matched. Opaque ids only.
  v_line_candidates uuid[];
  v_hit_candidate   uuid;
  -- ▲ 0114 C8-a declare
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

  -- ▼ 0130 M017-a intake gate open
  if v_link.intake_type is distinct from 'phone_parsing' then
  -- ▲ 0130 M017-a intake gate open
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
  -- ▼ 0130 M017-a intake gate close
  end if;
  -- ▲ 0130 M017-a intake gate close

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

  -- ── 0095: WHICH DIAL OF THE IST DAY THIS WOULD BE ──────────────────
  -- This REPLACES 0083's `exists(...)` test in place. It is deliberately not
  -- a second check bolted on somewhere below: 0083's own comment above warns
  -- that a pre-check which disagrees with the index leaves "the index fix
  -- alone INERT", and an `exists` test in front of a 1..2 sequence index is
  -- exactly that disagreement — it refuses the SECOND dial before the
  -- sequence is ever consulted, making the whole same-day retry dead code.
  -- One site now decides both the refusal and the sequence number, so they
  -- cannot drift apart again.
  --
  -- Counted over exactly the rows the unique index covers, under the same
  -- advisory lock that serialises admission, so the count and the index can
  -- never disagree. 0094's `infra_deferred` exemption is honoured here too:
  -- an attempt our own infrastructure deferred never consumed the
  -- candidate's day.
  --
  -- Guarded by `p_kind` exactly as the old check was, so `reconnect` is
  -- NEITHER COUNTED NOR REFUSED. Refusing a reconnect here would strand the
  -- engagement in `reconnecting` for ever with no edge out — the failure this
  -- function warns about twice elsewhere. A reconnect keeps the column's
  -- default of 1 and sits outside the index predicate entirely.
  if p_kind in ('initial','no_answer_retry','scheduled') then
    select coalesce(max(a.ist_day_seq), 0) + 1 into v_day_seq
      from screening_v2.phone_call_attempts a
     where a.engagement_id = p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind = any (array['initial','no_answer_retry','scheduled'])
       -- NULL-SAFE: see the index predicate. Reclaim rows have
       -- abandon_reason NULL; NOT(... AND NULL) is NULL and would
       -- silently uncount them. IS DISTINCT FROM keeps them charged.
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred');

    if v_day_seq > 2 then
      -- The anti-harassment invariant, refused in the open rather than as an
      -- index violation, so the caller learns WHY. 0043 held this at one dial
      -- per IST day; 0095 moves it to two and not one more.
      return jsonb_build_object('status', 'daily_attempt_exists',
                                'ist_date', v_ist_date,
                                'dials_today', v_day_seq - 1,
                                'max_per_day', 2);
    end if;
  else
    v_day_seq := 1;
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
  -- ▼ 0114 C8-a line set
  -- 0114 (C8): BOTH per-person guards below key on the LINE, not only on this
  -- candidate row. Ashby import creates one candidate row per application
  -- and never dedups (house rule 0029/0042), so one human can sit on two rows
  -- for one role; keyed by candidate_id, each row passed its own guard and one
  -- phone was dialled twice on one IST day (prod lines ffc393 / 3247c3).
  -- The set is every row whose phone_e164 equals the number validated above,
  -- plus this row itself. The number never leaves v_phone: it is not
  -- returned, logged or audited. ATOMICITY: this read-then-decide spans
  -- sibling rows, which LOCK 1b (keyed by THIS row's candidate id) does not
  -- cover; it rests on LOCK 1, the global phone_admission serialiser, taken
  -- as the first statement. Narrowing LOCK 1 must re-key this guard first.
  -- The scheduled/reconnect exemptions and ist_day_seq are unchanged.
  select array_agg(c.id) into v_line_candidates
    from screening_v2.candidates c
   where c.phone_e164 = v_phone
      or c.id = v_eng.candidate_id;
  -- ▲ 0114 C8-a line set
  -- Guard A — nobody is on the phone with this person right now.
  -- ▼ 0114 C8-a guard A
  select e.candidate_id into v_hit_candidate
    from screening_v2.phone_call_attempts a
    join screening_v2.phone_engagements e on e.id = a.engagement_id
   where e.candidate_id = any (v_line_candidates)
     and a.engagement_id <> p_engagement_id
     and a.state in ('admitted','ringing','answered_unclassified','human','machine')
     and a.lease_expires_at > p_now
   order by (e.candidate_id = v_eng.candidate_id) desc
   limit 1;
  if found then
    -- Status string unchanged; `scope` is an additive detail key: `candidate`
    -- when this row's own person matched (the 0045 meaning), `line` when only
    -- a sibling row on the same number did. The sibling row is never named.
    return jsonb_build_object('status', 'candidate_call_in_flight',
                              'scope', case when v_hit_candidate = v_eng.candidate_id
                                            then 'candidate' else 'line' end);
  end if;
  -- ▲ 0114 C8-a guard A

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
  -- ▼ 0114 C8-a guard B
  if p_kind in ('initial','no_answer_retry') then
    select e.candidate_id into v_hit_candidate
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = any (v_line_candidates)
       and a.engagement_id <> p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind in ('initial','no_answer_retry','scheduled')
       -- NULL-SAFE: see the index predicate (reclaim rows carry NULL reason).
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred')
     order by (e.candidate_id = v_eng.candidate_id) desc
     limit 1;
    if found then
      return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                                'ist_date', v_ist_date,
                                'scope', case when v_hit_candidate = v_eng.candidate_id
                                              then 'candidate' else 'line' end);
    end if;
  end if;
  -- ▲ 0114 C8-a guard B

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

  -- `v_day_seq` was decided ABOVE, in the same place as the refusal, and is
  -- not recomputed here. An earlier draft had the count in this position,
  -- behind 0083's untouched `exists(...)` pre-check — which meant the second
  -- same-day dial was refused ~180 lines before this line could ever run, and
  -- the entire same-day retry feature was dead code. Deciding the sequence
  -- and the refusal at one site is what stops that recurring.

  v_lease_token   := gen_random_uuid();
  v_lease_expires := p_now + (greatest(5, least(coalesce(p_lease_seconds, 60), 900))
                              * interval '1 second');

  begin
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, ist_date, ist_day_seq,
       prior_engagement_state, lease_token, lease_owner, lease_expires_at,
       admitted_at, created_at)
    values
      (p_engagement_id, v_seq, v_eng.epoch, p_kind, 'admitted', v_ist_date,
       v_day_seq, v_eng.state, v_lease_token, p_lease_owner, v_lease_expires,
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
      -- BOTH names are matched. 0095 replaces
      -- `uq_phone_attempts_one_per_ist_day` with
      -- `uq_phone_attempts_per_ist_day_seq`, and this handler was written
      -- against the old name. Left unchanged, every race lost on the NEW
      -- index would fall through to `attempt_in_flight` — precisely the
      -- misreport the comment above forbids, and one that sends an operator
      -- looking for a call that is not happening. The old name is kept so
      -- the handler stays correct against a database where 0095 has not yet
      -- been applied.
      if v_constraint in ('uq_phone_attempts_one_per_ist_day',
                          'uq_phone_attempts_per_ist_day_seq') then
        return jsonb_build_object('status', 'daily_attempt_exists',
                                  'ist_date', v_ist_date,
                                  'max_per_day', 2);
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
  'engagement, and a person is not. Since 0114 (C8) both refusals key on the '
  'phone LINE (every candidate row with the same phone_e164), because one '
  'person can sit on several candidate rows; the refusal carries a `scope` '
  'detail (candidate|line) and never names the other row. Both refusals are '
  'free. 0130 (M017, ADR-0018): a phone_parsing application, which has no '
  'resume by definition, skips only the resume/ingestion gate; every other '
  'gate is unchanged. Service-role-only.';
-- ==== 0130 §3 END ====


-- ==== 0130 §4 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §4 — ensure_ashby_phone_engagement: the intake gate (M017-b) and the
-- consent basis (M017-c). Lifted IN FULL from 0114 §6, its newest
-- declaration. Every 0114 line is kept byte-for-byte; the 0114 C8-b markers
-- stay. 0130 only ADDS marked hunks, and stripping them restores the 0114
-- body exactly.
--
--   M017-b intake gate open / close  wrap the ingestion gate the same way:
--                        a phone_parsing link skips ONLY that gate. Mapping,
--                        phone_invalid, the C8-b duplicate hold and every
--                        consent check run unchanged.
--   M017-c consent basis  a pure insertion after the consent insert. For a
--                        phone_parsing link the minted record's proof gains
--                        basis ashby_ai_stage_application and intake_type.
--                        source and consent_source stay job_application, and
--                        the record is still minted from submitted_at under
--                        the unchanged 5-minute future check.
--
-- Signature, security posture and privileges are unchanged and re-issued
-- below.
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.ensure_ashby_phone_engagement(
  p_application_link_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link screening_v2.ashby_application_links%rowtype;
  v_map screening_v2.ashby_job_mappings%rowtype;
  v_candidate screening_v2.candidates%rowtype;
  v_ing_state text;
  v_eng screening_v2.phone_engagements%rowtype;
  v_template screening_v2.consent_templates%rowtype;
  v_consent screening_v2.consent_records%rowtype;
  v_next timestamptz;
begin
  perform pg_advisory_xact_lock(
    hashtext('ashby_phone_engagement'),
    hashtext(coalesce(p_application_link_id::text, ''))
  );

  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby'
   for update;
  if not found then
    return jsonb_build_object('status', 'application_not_found');
  end if;

  if v_link.candidate_id is null then
    return jsonb_build_object('status', 'candidate_missing');
  end if;

  select * into v_candidate
    from screening_v2.candidates
   where id = v_link.candidate_id;
  if not found then
    return jsonb_build_object('status', 'candidate_missing');
  end if;

  -- Automatic Ashby materialization is allowed to create only the first
  -- cycle. A terminal cycle is history, not an invitation to create an
  -- implicit re-screen; explicit re-screen intent owns every later cycle.
  if not exists (
    select 1 from screening_v2.phone_engagements
     where application_link_id = v_link.id
  ) then
    insert into screening_v2.phone_engagements (
      application_link_id, candidate_id, role_id, cycle_number,
      state, state_reason
    ) values (
      v_link.id, v_candidate.id, v_candidate.role_id, 1,
      'pending_prereqs', 'evaluating'
    );
  end if;

  select * into v_eng
    from screening_v2.phone_engagements
   where application_link_id = v_link.id
   order by cycle_number desc, created_at desc, id desc
   limit 1
   for update;

  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state not in ('pending_prereqs', 'eligible') then
    return jsonb_build_object('status', 'engagement_active', 'state', v_eng.state,
                              'engagement_id', v_eng.id);
  end if;

  if v_eng.candidate_id <> v_candidate.id
     or v_eng.role_id is distinct from v_candidate.role_id then
    update screening_v2.phone_engagements
       set state_reason = 'identity_mismatch', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'identity_mismatch', 'engagement_id', v_eng.id);
  end if;

  if v_link.terminal_state is not null or v_link.lifecycle in ('completed', 'cancelled') then
    update screening_v2.phone_engagements
       set state = 'cancelled', state_reason = 'application_terminal',
           terminal_at = p_now, updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'application_terminal', 'engagement_id', v_eng.id);
  end if;

  select * into v_map
    from screening_v2.ashby_job_mappings
   where id = v_link.job_mapping_id;
  if not found or v_map.status <> 'enabled' or v_map.role_id is distinct from v_candidate.role_id then
    update screening_v2.phone_engagements
       set state_reason = 'mapping_not_enabled', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'mapping_not_enabled', 'engagement_id', v_eng.id);
  end if;

  -- ▼ 0130 M017-b intake gate open
  if v_link.intake_type is distinct from 'phone_parsing' then
  -- ▲ 0130 M017-b intake gate open
  select state into v_ing_state
    from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link.id;
  if v_ing_state is distinct from 'ready' then
    update screening_v2.phone_engagements
       set state_reason = 'ingestion_not_ready', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'ingestion_not_ready', 'engagement_id', v_eng.id);
  end if;
  -- ▼ 0130 M017-b intake gate close
  end if;
  -- ▲ 0130 M017-b intake gate close

  if not coalesce(v_candidate.phone_valid, false)
     or v_candidate.phone_e164 is null
     or v_candidate.phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    update screening_v2.phone_engagements
       set state_reason = 'phone_invalid', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'phone_invalid', 'engagement_id', v_eng.id);
  end if;

  -- ▼ 0114 C8-b duplicate hold
  -- Same-role duplicate application (C8). ONLY a first-cycle engagement still
  -- in `pending_prereqs` that is not an HR rescreen child and was not
  -- released by an operator can be held: 0042 lets pending_prereqs reach
  -- only eligible|cancelled, an eligible row is never relabelled, and an HR
  -- rescreen cycle is never held. Placed after the phone_invalid return and
  -- BEFORE the consent checks, so no consent record is minted for a held row.
  --
  -- Lock order: the link and the engagement (locked above), THEN the
  -- `ashby_person_identity` advisory lock. It is keyed by ROLE: a hold needs
  -- the same role, so every row that could match this one serialises on the
  -- same key, and the second of two racing rows always sees the first one's
  -- committed promotion.
  --
  -- Another row blocks this one only when it is a DIFFERENT candidate row of
  -- the SAME role that matches on the phone line, the normalised email, or
  -- (external_candidate_id, job mapping) AND holds an engagement that is live
  -- past prerequisites (eligible, scheduled, dialing, in_call, reconnecting,
  -- awaiting_retry) or `completed`. A pending_prereqs row (held or not)
  -- promised no call and never blocks, so two stuck rows cannot hold each
  -- other; a withdrawn, failed, unreached or cancelled screen never blocks,
  -- so a re-application after it is screened.
  --
  -- The row stays pending_prereqs with state_reason duplicate_application.
  -- The result names only THIS engagement, never the other row; no number,
  -- email or external id is returned, logged or audited.
  if v_eng.state = 'pending_prereqs'
     and v_eng.cycle_number = 1
     and not exists (select 1 from screening_v2.phone_rescreen_requests r
                      where r.new_engagement_id = v_eng.id)
     and not exists (select 1 from screening_v2.phone_identity_hold_releases h
                      where h.engagement_id = v_eng.id) then
    perform pg_advisory_xact_lock(
      hashtext('ashby_person_identity'),
      hashtext(coalesce(v_candidate.role_id::text, ''))
    );
    if exists (
      select 1
        from screening_v2.candidates c
        join screening_v2.phone_engagements o on o.candidate_id = c.id
       where c.id <> v_candidate.id
         and c.role_id = v_candidate.role_id
         and ((o.terminal_at is null and o.state <> 'pending_prereqs')
              or o.state = 'completed')
         and (c.phone_e164 = v_candidate.phone_e164
              or (nullif(btrim(v_candidate.email), '') is not null
                  and c.email is not null
                  and lower(btrim(c.email)) = lower(btrim(v_candidate.email)))
              or (v_link.external_candidate_id is not null
                  and exists (
                    select 1 from screening_v2.ashby_application_links l2
                     where l2.candidate_id = c.id
                       and l2.external_candidate_id = v_link.external_candidate_id
                       and l2.job_mapping_id = v_link.job_mapping_id)))
    ) then
      update screening_v2.phone_engagements
         set state_reason = 'duplicate_application', updated_at = p_now, version = version + 1
       where id = v_eng.id;
      return jsonb_build_object('status', 'duplicate_application', 'engagement_id', v_eng.id);
    end if;
  end if;
  -- ▲ 0114 C8-b duplicate hold
  if v_link.submitted_at is null or v_link.submitted_at > p_now + interval '5 minutes' then
    update screening_v2.phone_engagements
       set state_reason = 'consent_evidence_missing', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_evidence_missing', 'engagement_id', v_eng.id);
  end if;

  select * into v_consent
    from screening_v2.consent_records
   where candidate_id = v_candidate.id
   order by created_at desc, id desc
   limit 1;

  if found and v_consent.status <> 'granted' then
    update screening_v2.phone_engagements
       set state_reason = 'consent_not_granted', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_not_granted', 'engagement_id', v_eng.id);
  end if;

  if not found then
    select * into v_template
      from screening_v2.consent_templates
     where is_active
     order by updated_at desc, id desc
     limit 1;
    if not found or v_template.required_consents is null then
      update screening_v2.phone_engagements
         set state_reason = 'consent_template_inactive', updated_at = p_now, version = version + 1
       where id = v_eng.id;
      return jsonb_build_object('status', 'consent_template_inactive', 'engagement_id', v_eng.id);
    end if;

    insert into screening_v2.consent_records (
      candidate_id, source, proof, created_at, updated_at, version, consents,
      status, classification_level
    ) values (
      v_candidate.id,
      'job_application',
      jsonb_build_object('basis', 'ashby_application_submission', 'application_link_id', v_link.id),
      v_link.submitted_at,
      p_now,
      v_template.version,
      v_template.required_consents,
      'granted',
      3
    ) returning * into v_consent;
    -- ▼ 0130 M017-c consent basis
    if v_link.intake_type = 'phone_parsing' then
      update screening_v2.consent_records
         set proof = proof || jsonb_build_object('basis','ashby_ai_stage_application','intake_type','phone_parsing')
       where id = v_consent.id
      returning * into v_consent;
    end if;
    -- ▲ 0130 M017-c consent basis

    update screening_v2.candidates
       set consent_source = 'job_application', consent_at = v_link.submitted_at,
           updated_at = p_now
     where id = v_candidate.id;
  end if;

  if v_consent.expires_at is not null and v_consent.expires_at <= p_now then
    update screening_v2.phone_engagements
       set state_reason = 'consent_expired', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_expired', 'engagement_id', v_eng.id);
  end if;

  select * into v_template
    from screening_v2.consent_templates
   where is_active
   order by updated_at desc, id desc
   limit 1;
  if not found or not (v_template.required_consents <@ v_consent.consents) then
    update screening_v2.phone_engagements
       set state_reason = 'consent_subset_missing', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_subset_missing', 'engagement_id', v_eng.id);
  end if;

  v_next := case
    when screening_v2.phone_ist_window_open(p_now) then p_now
    else screening_v2.phone_next_window_open(p_now)
  end;

  update screening_v2.phone_engagements
     set state = 'eligible', state_reason = null, consent_record_id = v_consent.id,
         next_eligible_at = v_next, updated_at = p_now, version = version + 1
   where id = v_eng.id;

  return jsonb_build_object(
    'status', case when v_next <= p_now then 'eligible' else 'scheduled_next_window' end,
    'engagement_id', v_eng.id,
    'next_eligible_at', v_next
  );
end;
$$;

revoke all on function screening_v2.ensure_ashby_phone_engagement(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.ensure_ashby_phone_engagement(uuid, timestamptz)
  to service_role;

comment on function screening_v2.ensure_ashby_phone_engagement is
  'Ashby prerequisite evaluator: materialises cycle 1 and promotes '
  'pending_prereqs -> eligible when every prerequisite holds. POLICY (0114, '
  'C8): a first-cycle pending_prereqs engagement is HELD (state_reason '
  'duplicate_application, status duplicate_application) when a different '
  'candidate row of the SAME role matches it on phone line, normalised email '
  'or (external_candidate_id, job mapping) and holds an engagement past '
  'prerequisites or completed. HR rescreen cycles, eligible rows, other roles '
  'and released engagements are never held; a withdrawn, failed, unreached or '
  'cancelled screen never blocks a re-application. The hold mints no consent, '
  'names only this engagement, and is lifted by release_phone_identity_hold. '
  'Never creates an attempt or a queue job. 0130 (M017, ADR-0018): a '
  'phone_parsing link skips only the ingestion gate, and the consent record '
  'it mints carries the proof basis ashby_ai_stage_application. '
  'Service-role-only.';
-- ==== 0130 §4 END ====


-- ==== 0130 §5 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §5 — apply_ashby_candidate_profile: the ONLY writer of phone_parsing and of
-- an Ashby number. The API's ashby.profile job calls it after re-reading the
-- Ashby records and deriving the number; every gate is re-checked here under
-- the locks, so the caller's view is a hint, never the decision.
--
--   p_intake       phone_parsing   stamp the link (only while it has no
--                                  resume handle and its ingestion row is
--                                  absent or `queued`, or, B3, it has a
--                                  handle whose ingestion rests in
--                                  `failed_review` on a verdict about the
--                                  document: the resume could not be read),
--                                  fill a NULL name and email, and apply
--                                  the number.
--                  resume_parsing  (D3) apply the number to a resume link
--                                  whose ingestion is `ready` and whose
--                                  candidate has a resume but no dialable
--                                  number. Name and email are never written.
--   p_skip_reason  why the caller sends no dialable number (number_invalid |
--                  number_placeholder | name_missing), else NULL.
--
-- The number is applied at most once per candidate row: only while
-- phone_valid is false and ashby_phone_applied_at is NULL, only when it is
-- strict +91, and never when a DIFFERENT candidate row already holds it as
-- valid, unless that row belongs to the same Ashby person (a link with this
-- link's external_candidate_id). A phone_parsing application without a usable
-- name gets no number (name_missing): with no name the identity check cannot
-- catch the wrong person, and HR can still verify a number by hand. Nothing
-- already set is overwritten: name and email are only filled when NULL, and a
-- valid number stays.
--
-- Answers. Every exit after the link lock records profile_outcome (and
-- profile_checked_at) on the link and returns it with number_applied,
-- identity_applied and intake_stamped. Its own statuses: invalid_request,
-- application_not_found, application_terminal, candidate_missing,
-- mapping_not_enabled, subject_request_hold, engagement_active (with
-- engagement_id), resume_bound and not_applicable. Otherwise it ends in
-- ensure_ashby_phone_engagement, in this transaction, and returns ensure's
-- answer with those four keys added.
--
-- Lock order, as ensure: the `ashby_phone_engagement` advisory lock (it is
-- re-entrant, so the nested ensure takes it again), the link, the newest
-- engagement, then the candidate. A started, mid-call or finished engagement
-- returns before the candidate is touched, so no name, email or number lands
-- behind a row that is already past its prerequisites. HR's
-- verify_candidate_phone clears phone_invalid on exactly the engagement a D3
-- profile holds here, so §8 makes it lock that engagement before the
-- candidate too; before 0130 it took them the other way round, and the pair
-- could deadlock.
--
-- PRIVACY: the answer carries codes, flags and an engagement id only. No
-- name, email or number is returned, logged or audited, and no audit row is
-- written (ADR-0018). No answer key contains a contact-data fragment.
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.apply_ashby_candidate_profile(
  p_application_link_id uuid,
  p_intake              text,
  p_name                text,
  p_email               text,
  p_phone_raw           text,
  p_phone_e164          text,
  p_skip_reason         text,
  p_now                 timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link             screening_v2.ashby_application_links%rowtype;
  v_map              screening_v2.ashby_job_mappings%rowtype;
  v_eng              screening_v2.phone_engagements%rowtype;
  v_candidate        screening_v2.candidates%rowtype;
  v_ing_state        text;
  v_ing_reason       text;
  v_unreadable       boolean;
  v_name             text;
  v_email            text;
  v_ok               boolean;
  v_outcome          text;
  v_stamped          boolean := false;
  v_identity_applied boolean := false;
  v_number_applied   boolean := false;
begin
  -- 1. Input.
  if p_now is null
     or p_intake is null
     or p_intake not in ('phone_parsing', 'resume_parsing')
     or (p_skip_reason is not null
         and p_skip_reason not in ('number_invalid', 'number_placeholder', 'name_missing')) then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  -- 2. The advisory lock ensure takes, so apply and ensure serialise per link.
  perform pg_advisory_xact_lock(
    hashtext('ashby_phone_engagement'),
    hashtext(coalesce(p_application_link_id::text, ''))
  );

  -- 3. The link.
  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby'
   for update;
  if not found then
    return jsonb_build_object('status', 'application_not_found');
  end if;

  -- 4. A withdrawn, deleted or finished application is never profiled.
  if v_link.terminal_state is not null or v_link.lifecycle in ('completed', 'cancelled') then
    v_outcome := 'application_terminal';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'application_terminal', 'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 5. No candidate row is bound to the link yet.
  if v_link.candidate_id is null then
    v_outcome := 'candidate_missing';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'candidate_missing', 'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 6. Only an enabled phone_primary mapping is profiled.
  select * into v_map
    from screening_v2.ashby_job_mappings
   where id = v_link.job_mapping_id;
  if not found or v_map.status <> 'enabled' or v_map.screening_mode <> 'phone_primary' then
    v_outcome := 'mapping_inactive';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'mapping_not_enabled', 'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 7. A correction, restriction or erasure request (0012) holds every
  --    write, so nothing is re-collected about the person while it stands.
  if exists (
    select 1 from screening_v2.data_subject_requests d
     where d.candidate_id = v_link.candidate_id
       and d.request_type in ('correct', 'restrict', 'delete')
       and d.request_status in ('pending', 'in_progress', 'fulfilled')
  ) then
    v_outcome := 'subject_request_hold';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'subject_request_hold', 'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 8. The newest engagement, as ensure selects it. Only a missing or a live
  --    pending_prereqs engagement takes a profile; any other row is left
  --    exactly as it is.
  select * into v_eng
    from screening_v2.phone_engagements
   where application_link_id = v_link.id
   order by cycle_number desc, created_at desc, id desc
   limit 1
   for update;
  if found and (v_eng.terminal_at is not null or v_eng.state <> 'pending_prereqs') then
    v_outcome := 'engagement_active';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'engagement_active', 'engagement_id', v_eng.id,
                              'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 9. The intake. phone_parsing is stamped atomically, only while no resume
  --    is bound: a handle, or an ingestion that has left `queued`, means the
  --    resume pipeline owns this application. One exception (B3): a handle
  --    whose ingestion rests in `failed_review` on a verdict about the
  --    DOCUMENT is a resume nobody can read, and it falls back to phone
  --    parsing exactly as if none were attached. The verdicts are the class
  --    advance_ashby_ingestion (0084) refuses to requeue, less parse_error
  --    (0040's operator recovery re-runs it) and parse_bad_output (a stdout
  --    fault of ours, 0041). Any other reason is about OUR MACHINE (an
  --    outage, a deadline, a failed persist): the resume may be fine, a
  --    re-import or the operator recovery re-runs it, and it stays the
  --    resume pipeline's. So a stamped link's ingestion is one no door
  --    requeues. The stamp is never flipped back; the ingestion handler then
  --    leaves the link alone, so a later repair of the file does not re-parse
  --    over the Ashby data.
  select state, failed_reason into v_ing_state, v_ing_reason
    from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link.id;
  v_unreadable := v_link.external_resume_file_handle is not null
                  and v_ing_state is not distinct from 'failed_review'
                  and coalesce(v_ing_reason in ('scan_infected', 'parse_extract_failed',
                                                'parse_no_output', 'parse_output_exceeded',
                                                'no_extractable_fields')
                               or left(v_ing_reason, 6) = 'guard_', false);
  if p_intake = 'phone_parsing' then
    if (v_link.external_resume_file_handle is not null
        or (v_ing_state is not null and v_ing_state <> 'queued'))
       and not v_unreadable then
      v_outcome := 'resume_found';
      update screening_v2.ashby_application_links
         set profile_outcome = v_outcome, profile_checked_at = p_now
       where id = v_link.id;
      return jsonb_build_object('status', 'resume_bound', 'profile_outcome', v_outcome,
                                'number_applied', v_number_applied,
                                'identity_applied', v_identity_applied,
                                'intake_stamped', v_stamped);
    end if;
    if v_link.intake_type is distinct from 'phone_parsing' then
      update screening_v2.ashby_application_links
         set intake_type = 'phone_parsing', updated_at = p_now
       where id = v_link.id;
      v_stamped := true;
    end if;
  end if;

  -- 10. The candidate row, locked last.
  select * into v_candidate
    from screening_v2.candidates
   where id = v_link.candidate_id
   for update;
  if not found then
    v_outcome := 'candidate_missing';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'candidate_missing', 'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 9 (D3). resume_parsing serves only a resume_parsing link whose resume
  --    was ingested and parsed. Checked under the candidate lock, because it
  --    reads resume_id.
  if p_intake = 'resume_parsing'
     and (v_link.intake_type <> 'resume_parsing'
          or v_ing_state is distinct from 'ready'
          or v_candidate.resume_id is null) then
    v_outcome := 'not_applicable';
    update screening_v2.ashby_application_links
       set profile_outcome = v_outcome, profile_checked_at = p_now
     where id = v_link.id;
    return jsonb_build_object('status', 'not_applicable', 'profile_outcome', v_outcome,
                              'number_applied', v_number_applied,
                              'identity_applied', v_identity_applied,
                              'intake_stamped', v_stamped);
  end if;

  -- 11. Identity: phone_parsing only, and only for a candidate with no
  --     resume. A column is filled only while it is NULL, so a parsed or
  --     HR-corrected value is never overwritten. An unreadable (B3)
  --     candidate is normally the import-time shell (no resume, name, email
  --     or number); one that kept a resume row from an earlier parse is
  --     filled too, but only where that parse left a NULL.
  if p_intake = 'phone_parsing'
     and (v_candidate.resume_id is null or v_unreadable) then
    v_name  := coalesce(v_candidate.name, left(nullif(btrim(p_name), ''), 80));
    v_email := coalesce(v_candidate.email, left(nullif(btrim(p_email), ''), 254));
    if v_name is distinct from v_candidate.name
       or v_email is distinct from v_candidate.email then
      update screening_v2.candidates
         set name = v_name, email = v_email, updated_at = p_now
       where id = v_candidate.id;
      v_candidate.name := v_name;
      v_candidate.email := v_email;
      v_identity_applied := true;
    end if;
  end if;

  -- 12. May the number be applied? Strict +91 only (the ensure regex), never
  --     to a nameless phone_parsing candidate, and never a number a DIFFERENT
  --     candidate row holds as valid unless that row is the same Ashby
  --     person.
  v_ok := p_skip_reason is null
          and coalesce(p_phone_e164 ~ '^\+91[6-9][0-9]{9}$', false);
  if p_intake = 'phone_parsing' and nullif(btrim(v_candidate.name), '') is null then
    v_ok := false;
    v_outcome := 'name_missing';
  end if;
  if v_ok and exists (
    select 1
      from screening_v2.candidates c2
     where c2.id <> v_candidate.id
       and c2.phone_valid
       and c2.phone_e164 = p_phone_e164
       and not (v_link.external_candidate_id is not null
                and exists (
                  select 1 from screening_v2.ashby_application_links l2
                   where l2.candidate_id = c2.id
                     and l2.external_candidate_id = v_link.external_candidate_id))
  ) then
    v_ok := false;
    v_outcome := 'number_shared';
  end if;

  -- 13. Apply it, once. The marker is never cleared, so an Ashby number is
  --     never applied to this row again, even after it is invalidated (§7).
  --     phone_raw takes the Ashby raw value, so the record shows the number
  --     actually dialled.
  if v_ok
     and not coalesce(v_candidate.phone_valid, false)
     and v_candidate.ashby_phone_applied_at is null then
    update screening_v2.candidates
       set phone_e164 = p_phone_e164, phone_valid = true,
           phone_raw = left(p_phone_raw, 64),
           ashby_phone_applied_at = p_now, updated_at = p_now
     where id = v_candidate.id;
    v_outcome := 'applied';
    v_number_applied := true;
  elsif v_ok then
    -- The candidate already has a valid number, or had an Ashby number.
    v_outcome := 'not_applicable';
  else
    -- No dialable number: a phone_parsing candidate with no number at all
    -- keeps the raw value, so HR can run the existing verify flow on it.
    if p_intake = 'phone_parsing'
       and not coalesce(v_candidate.phone_valid, false)
       and v_candidate.phone_raw is null
       and nullif(btrim(p_phone_raw), '') is not null then
      update screening_v2.candidates
         set phone_raw = left(p_phone_raw, 64), updated_at = p_now
       where id = v_candidate.id;
    end if;
    v_outcome := coalesce(v_outcome, p_skip_reason, 'number_invalid');
  end if;

  -- 14. Record the outcome.
  update screening_v2.ashby_application_links
     set profile_outcome = v_outcome, profile_checked_at = p_now
   where id = v_link.id;

  -- 15. Evaluate the prerequisites in this transaction. For phone_parsing,
  --     ensure skips only the ingestion gate (M017-b); every other gate runs.
  return screening_v2.ensure_ashby_phone_engagement(v_link.id, p_now)
         || jsonb_build_object('profile_outcome', v_outcome,
                               'number_applied', v_number_applied,
                               'identity_applied', v_identity_applied,
                               'intake_stamped', v_stamped);
end;
$$;

revoke all on function screening_v2.apply_ashby_candidate_profile(uuid, text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_ashby_candidate_profile(uuid, text, text, text, text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.apply_ashby_candidate_profile is
  '0130 (M017, ADR-0018): applies the Ashby candidate profile to one '
  'application link, under the ensure lock order (advisory, link, newest '
  'engagement, candidate). phone_parsing stamps intake_type (only with no '
  'resume handle and an ingestion row absent or queued, or with a handle '
  'whose ingestion rests in failed_review on a document verdict: '
  'scan_infected, guard_*, parse_extract_failed, parse_no_output, '
  'parse_output_exceeded or no_extractable_fields, never a machine-class '
  'reason) and fills a NULL name and email; '
  'both intakes apply a strict +91 Ashby number at most once '
  'per candidate row (ashby_phone_applied_at), never over a valid number, '
  'never one a different Ashby person holds, never under a DSAR hold, never '
  'behind a started engagement, and never for a nameless phone_parsing '
  'application. Records profile_outcome on the link and ends in '
  'ensure_ashby_phone_engagement, adding profile_outcome, number_applied, '
  'identity_applied and intake_stamped. Returns codes only, never a name, '
  'email or number, and writes no audit row. Service-role-only.';
-- ==== 0130 §5 END ====


-- ==== 0130 §6 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §6 — claim_ashby_profile_due: the durable profile sweep's claim. Locks the
-- due links SKIP LOCKED, stamps profile_checked_at and counts the claim in
-- profile_attempts in the same statement, so Ashby polling stays bounded
-- whatever happens to the job, across machines and restarts.
--
-- Due means all of: a live link (no terminal_state, lifecycle not completed
-- or cancelled) on an enabled phone_primary mapping; a bound candidate with
-- phone_valid false and ashby_phone_applied_at NULL (`is null`, never `<>`
-- against a nullable marker); no DSAR hold; fewer than p_max_attempts
-- claims; never checked, or last checked at least
-- p_retry_seconds * 2^(attempts - 1) ago; and one of three arms:
--
--   A (D3)         a resume_parsing link with a handle, ingestion `ready`,
--                  and a live pending_prereqs/phone_invalid engagement last
--                  updated at least p_min_age_seconds ago;
--   B (no resume)  a link with no handle, created at least p_min_age_seconds
--                  ago, with no engagement or only a live pending_prereqs
--                  one;
--   C (B3, unreadable resume)  a link with a handle whose ingestion has
--                  rested in `failed_review` on a document verdict (the
--                  §5 step 9 reasons; never a machine-class one) for at
--                  least p_min_age_seconds (its updated_at), with no
--                  engagement or only a live pending_prereqs one. The
--                  backstop for the best-effort profile job the ingestion
--                  handler enqueues on such a verdict; apply then falls
--                  back to phone parsing.
--                  It covers a link already stamped phone_parsing too, so a
--                  fallback that ended name_missing or number_invalid is
--                  retried with the same backoff as arm B.
--
-- The kill switch (ASHBY_PHONE_PARSING_ENABLED) is the caller's: the sweep
-- does not claim while it is off, so no arm reads it here. The sweep's
-- configured interval is 600 s, but the scheduler caps every poll delay at
-- 60 s (lib/queue/runner.ts nextPollDelayMs), so this runs every 30-60 s.
-- That is harmless: due-ness and the backoff are decided here, not by the
-- cadence.
--
-- Never-checked links come first, then the oldest. At most 50 per claim.
-- Returns link ids only.
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.claim_ashby_profile_due(
  p_limit           integer,
  p_min_age_seconds integer,
  p_retry_seconds   integer,
  p_max_attempts    integer,
  p_now             timestamptz
)
returns table (application_link_id uuid)
language sql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
  with due as (
    select l.id
      from screening_v2.ashby_application_links l
      join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id
           and m.status = 'enabled' and m.screening_mode = 'phone_primary'
      join screening_v2.candidates c on c.id = l.candidate_id
     where l.provider = 'ashby' and l.terminal_state is null
       and l.lifecycle not in ('completed', 'cancelled')
       and not coalesce(c.phone_valid, false) and c.ashby_phone_applied_at is null
       and l.profile_attempts < p_max_attempts
       and (l.profile_checked_at is null
            or l.profile_checked_at <= p_now - make_interval(
                 secs => p_retry_seconds * power(2, greatest(l.profile_attempts - 1, 0))))
       and not exists (select 1 from screening_v2.data_subject_requests d
                        where d.candidate_id = c.id
                          and d.request_type in ('correct', 'restrict', 'delete')
                          and d.request_status in ('pending', 'in_progress', 'fulfilled'))
       and (
         (l.intake_type = 'resume_parsing' and l.external_resume_file_handle is not null
          and exists (select 1 from screening_v2.ashby_resume_ingestions i
                       where i.application_link_id = l.id and i.state = 'ready')
          and exists (select 1 from screening_v2.phone_engagements e
                       where e.application_link_id = l.id
                         and e.terminal_at is null and e.state = 'pending_prereqs'
                         and e.state_reason = 'phone_invalid'
                         and e.updated_at <= p_now - make_interval(secs => p_min_age_seconds)))
         or
         (l.external_resume_file_handle is null
          and l.created_at <= p_now - make_interval(secs => p_min_age_seconds)
          and not exists (select 1 from screening_v2.phone_engagements e
                           where e.application_link_id = l.id
                             and (e.terminal_at is not null or e.state <> 'pending_prereqs')))
         or
         (l.intake_type in ('resume_parsing', 'phone_parsing')
          and l.external_resume_file_handle is not null
          and exists (select 1 from screening_v2.ashby_resume_ingestions i
                       where i.application_link_id = l.id and i.state = 'failed_review'
                         and (i.failed_reason in ('scan_infected', 'parse_extract_failed',
                                                  'parse_no_output', 'parse_output_exceeded',
                                                  'no_extractable_fields')
                              or left(i.failed_reason, 6) = 'guard_')
                         and i.updated_at <= p_now - make_interval(secs => p_min_age_seconds))
          and not exists (select 1 from screening_v2.phone_engagements e
                           where e.application_link_id = l.id
                             and (e.terminal_at is not null or e.state <> 'pending_prereqs')))
       )
     order by l.profile_checked_at nulls first, l.created_at
     limit least(greatest(p_limit, 1), 50)
     for update of l skip locked
  )
  update screening_v2.ashby_application_links l
     set profile_checked_at = p_now, profile_attempts = l.profile_attempts + 1
    from due
   where l.id = due.id
  returning l.id;
$$;

revoke all on function screening_v2.claim_ashby_profile_due(integer, integer, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_profile_due(integer, integer, integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.claim_ashby_profile_due is
  '0130 (M017, ADR-0018): claims up to 50 Ashby application links due for '
  'the profile step (FOR UPDATE SKIP LOCKED), stamping profile_checked_at '
  'and incrementing profile_attempts. Due: a live link on an enabled '
  'phone_primary mapping, a candidate with no valid and no applied Ashby '
  'number, no DSAR hold, under p_max_attempts claims with exponential '
  'backoff from p_retry_seconds; and either a ready resume link whose '
  'engagement has waited on phone_invalid for p_min_age_seconds (D3), a '
  'link with no resume handle at least p_min_age_seconds old, or (B3) a '
  'link with a handle whose ingestion has rested in failed_review on a '
  'document verdict (never a machine-class reason) for '
  'p_min_age_seconds, in both cases with no engagement or only a live '
  'pending_prereqs one. Returns link ids only. Service-role-only.';
-- ==== 0130 §6 END ====


-- ==== 0130 §7 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §7 — release_ashby_number_after_identity_mismatch: the SECOND confirmed
-- wrong person on an Ashby number nobody has verified ends that number's
-- use (B2: one more try). Without it, apply_phone_event returns the
-- engagement to `eligible` after a pre-disclosure deferral and the same
-- wrong person is called again every day.
--
-- The API calls it after it applied a `candidate.deferred_pre_disclosure`
-- event carrying recording_discarded. The worker sets that flag only on a
-- confirmed "not the candidate" verdict (the identity-mismatch terminal),
-- never on an ordinary "call me later" deferral, so the flag, not any
-- recording latch, is the mismatch signal; this function records the count
-- itself, whatever the recording provider. It acts only when ALL of these
-- hold, re-checked under the locks:
--   * the engagement is live, `eligible` with state_reason
--     abandoned_pre_disclosure;
--   * p_attempt_id is its LATEST attempt (admitted_at, then attempt_seq, as
--     the 0114 C7-a guard orders them) and ended abandoned_pre_disclosure;
--   * the candidate's valid number was applied from Ashby
--     (ashby_phone_applied_at is set), and no phone_number_verifications
--     row carries its digest, i.e. HR never verified it.
-- Then the link's identity_mismatch_attempt_id decides:
--   * it counts as an earlier mismatch only while it names a DIFFERENT
--     attempt of THIS engagement admitted at or after
--     ashby_phone_applied_at. NULL, an attempt of another engagement (or
--     one since deleted), or one admitted before the number was applied is
--     no earlier mismatch: p_attempt_id is recorded there and the answer is
--     first_mismatch_retry. Nothing else is written: the number, the
--     engagement and the link outcome stay, so the engagement is redialled
--     on the next IST day exactly as after any deferral;
--   * it already names p_attempt_id: a replay of the first mismatch, so
--     first_mismatch_retry again, writing nothing;
--   * otherwise this is the second mismatch: the number is invalidated
--     (phone_e164 NULL, phone_valid false; phone_raw and the marker are
--     kept, so the Ashby number is never applied again), the engagement is
--     cancelled with identity_unconfirmed (eligible -> cancelled is a legal
--     edge of the 0125 transition trigger, written in the shape ensure uses
--     for application_terminal), and the link records the outcome
--     identity_unconfirmed. HR recovers by verifying the right number
--     (verify_candidate_phone) and requesting a rescreen, which a cancelled
--     engagement allows.
--
-- Answers: released (with engagement_id), first_mismatch_retry,
-- not_applicable, not_found, invalid_request (p_now NULL). A replay after a
-- release finds the engagement cancelled and answers not_applicable.
--
-- Lock order, as ensure and §5: the attempt and engagement are first read
-- WITHOUT locks to find the link, then the `ashby_phone_engagement` advisory
-- lock, the link, the engagement, and the candidate last. Codes and opaque
-- ids only: no number is returned, logged or audited.
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.release_ashby_number_after_identity_mismatch(
  p_attempt_id uuid,
  p_now        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_eng_id         uuid;
  v_link_id        uuid;
  v_candidate_id   uuid;
  v_link           screening_v2.ashby_application_links%rowtype;
  v_eng            screening_v2.phone_engagements%rowtype;
  v_candidate      screening_v2.candidates%rowtype;
  v_latest_id      uuid;
  v_latest_outcome text;
  v_prior_counts   boolean;
begin
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  -- 1. Find the link and the candidate. These reads take no locks.
  select a.engagement_id into v_eng_id
    from screening_v2.phone_call_attempts a
   where a.id = p_attempt_id;
  if v_eng_id is not null then
    select e.application_link_id, e.candidate_id into v_link_id, v_candidate_id
      from screening_v2.phone_engagements e
     where e.id = v_eng_id;
  end if;
  if v_link_id is null or v_candidate_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 2. The ensure lock order: advisory lock, link, engagement.
  perform pg_advisory_xact_lock(
    hashtext('ashby_phone_engagement'),
    hashtext(coalesce(v_link_id::text, ''))
  );

  select * into v_link
    from screening_v2.ashby_application_links
   where id = v_link_id and provider = 'ashby'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_eng
    from screening_v2.phone_engagements
   where id = v_eng_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 3. Only the deferral this attempt just ended, and only while it still
  --    stands.
  select a.id, a.outcome_class into v_latest_id, v_latest_outcome
    from screening_v2.phone_call_attempts a
   where a.engagement_id = v_eng.id
   order by a.admitted_at desc, a.attempt_seq desc
   limit 1;
  if v_eng.terminal_at is not null
     or v_eng.state is distinct from 'eligible'
     or v_eng.state_reason is distinct from 'abandoned_pre_disclosure'
     or v_latest_id is distinct from p_attempt_id
     or v_latest_outcome is distinct from 'abandoned_pre_disclosure' then
    return jsonb_build_object('status', 'not_applicable');
  end if;

  -- 4. Only an Ashby-applied number HR never verified.
  select * into v_candidate
    from screening_v2.candidates
   where id = v_eng.candidate_id
   for update;
  if not found
     or v_candidate.ashby_phone_applied_at is null
     or not coalesce(v_candidate.phone_valid, false)
     or v_candidate.phone_e164 is null
     or exists (
       select 1 from screening_v2.phone_number_verifications v
        where v.candidate_id = v_candidate.id
          and v.phone_sha256 = screening_v2.sha256_hex(v_candidate.phone_e164)
     ) then
    return jsonb_build_object('status', 'not_applicable');
  end if;

  -- 5. B2: one more try. A replay of the recorded first mismatch writes
  --    nothing.
  if v_link.identity_mismatch_attempt_id = p_attempt_id then
    return jsonb_build_object('status', 'first_mismatch_retry');
  end if;
  --    The recorded attempt counts only while it is another attempt of this
  --    engagement, admitted on the number now applied. Anything else is
  --    stale, and this mismatch is the first.
  v_prior_counts := v_link.identity_mismatch_attempt_id is not null
    and exists (
      select 1 from screening_v2.phone_call_attempts m
       where m.id = v_link.identity_mismatch_attempt_id
         and m.engagement_id = v_eng.id
         and m.admitted_at >= v_candidate.ashby_phone_applied_at
    );
  if not v_prior_counts then
    update screening_v2.ashby_application_links
       set identity_mismatch_attempt_id = p_attempt_id
     where id = v_link.id;
    return jsonb_build_object('status', 'first_mismatch_retry');
  end if;

  -- 6. The second mismatch. Invalidate the number; phone_raw and the marker
  --    stay.
  update screening_v2.candidates
     set phone_e164 = null, phone_valid = false, updated_at = p_now
   where id = v_candidate.id;

  -- 7. End the engagement: eligible -> cancelled.
  update screening_v2.phone_engagements
     set state = 'cancelled', state_reason = 'identity_unconfirmed',
         terminal_at = p_now, updated_at = p_now, version = version + 1
   where id = v_eng.id;

  -- 8. Record the outcome on the link.
  update screening_v2.ashby_application_links
     set profile_outcome = 'identity_unconfirmed', profile_checked_at = p_now
   where id = v_link.id;

  return jsonb_build_object('status', 'released', 'engagement_id', v_eng.id);
end;
$$;

revoke all on function screening_v2.release_ashby_number_after_identity_mismatch(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.release_ashby_number_after_identity_mismatch(uuid, timestamptz)
  to service_role;

comment on function screening_v2.release_ashby_number_after_identity_mismatch is
  '0130 (M017 B2, ADR-0018): on the SECOND confirmed wrong person, after a '
  'pre-disclosure deferral, invalidates an Ashby-applied number that HR '
  'never verified and cancels the engagement with identity_unconfirmed. Acts '
  'only when the engagement is live eligible/abandoned_pre_disclosure, the '
  'attempt is its latest and ended abandoned_pre_disclosure, the candidate '
  'number carries ashby_phone_applied_at and no phone_number_verifications '
  'digest matches it. The first such mismatch is recorded on the link '
  '(identity_mismatch_attempt_id) and answers first_mismatch_retry, changing '
  'nothing else, so the engagement is redialled on the next IST day; a '
  'replay of it answers the same. A later mismatch on another attempt of the '
  'same engagement, admitted after the number was applied, releases: '
  'phone_raw and the marker are kept, so the Ashby number is never '
  're-applied; the link records identity_unconfirmed. HR recovers by '
  'verifying the right number and requesting a rescreen. Lock order: '
  'advisory, link, engagement, candidate. Returns codes and the engagement '
  'id only. Service-role-only.';
-- ==== 0130 §7 END ====


-- ==== 0130 §8 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §8 — verify_candidate_phone: the lock order (M017-d). Lifted IN FULL
-- from 0099, its newest declaration, with ONE marked hunk; stripping it
-- restores the 0099 body exactly.
--
-- 0099 locks the candidate and then clears phone_invalid on the
-- candidate's live engagements. Every other writer of both rows takes the
-- engagement first: ensure, relabel, §5 apply_ashby_candidate_profile and
-- §7. Before 0130 the inversion could not bite, because ensure answers
-- phone_invalid without touching the candidate. §5 changes that: a D3
-- profile locks a pending_prereqs/phone_invalid engagement and then the
-- candidate, which is the moment HR is most likely to verify that
-- candidate's number. M017-d locks the engagements first, so verify
-- waits behind the profile instead of deadlocking with it.
-- ─────────────────────────────────────────────────────────────────────
create or replace function screening_v2.verify_candidate_phone(
  p_candidate_id uuid,
  p_phone_e164 text,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_candidate screening_v2.candidates%rowtype;
  v_digest text;
  v_cleared integer := 0;
begin
  if p_phone_e164 is null or p_phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('status', 'invalid_phone');
  end if;
  -- ▼ 0130 M017-d engagements before the candidate
  -- The engagements the 0099 clear below rewrites are locked BEFORE the
  -- candidate. ensure, apply_ashby_candidate_profile, the identity
  -- release and relabel all lock an engagement before its candidate, and a
  -- D3 profile holds exactly such a phone_invalid engagement while it
  -- waits for this candidate: taken the other way round, the pair could
  -- deadlock. Ordered by id, so two verifies never cross either. The
  -- predicate is the one the clear uses and nothing is written here, so
  -- every answer is unchanged.
  perform 1
    from screening_v2.phone_engagements e
   where e.candidate_id = p_candidate_id
     and e.terminal_at is null
     and e.state_reason = 'phone_invalid'
   order by e.id
     for update of e;
  -- ▲ 0130 M017-d engagements before the candidate
  select * into v_candidate from screening_v2.candidates
   where id = p_candidate_id for update;
  if not found then return jsonb_build_object('status', 'candidate_not_found'); end if;
  if p_actor_id is null then return jsonb_build_object('status', 'actor_required'); end if;

  v_digest := screening_v2.sha256_hex(p_phone_e164);
  update screening_v2.candidates
     set phone_e164 = p_phone_e164, phone_valid = true, updated_at = p_now
   where id = p_candidate_id;

  -- ── 0099: the verdict this call just superseded ────────────────────
  -- See the file header for why this touches neither `state`, `version` nor
  -- `updated_at`, and why `terminal_at is null` is mandatory rather than
  -- defensive.
  update screening_v2.phone_engagements
     set state_reason = null
   where candidate_id = p_candidate_id
     and terminal_at is null
     and state_reason = 'phone_invalid';
  get diagnostics v_cleared = row_count;

  insert into screening_v2.phone_number_verifications
    (candidate_id, phone_sha256, verified_by, verified_at, created_at)
  values (p_candidate_id, v_digest, p_actor_id, p_now, p_now);
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values (p_actor_id, 'recruiter', 'phone_number_reverified', 'candidate',
          p_candidate_id::text, 'success',
          -- Counts only. The number never reaches an audit row (0057).
          jsonb_build_object('verified', true,
                             'stale_phone_invalid_cleared', v_cleared));
  return jsonb_build_object('status', 'ok',
                            'stale_phone_invalid_cleared', v_cleared);
end;
$$;

revoke all on function screening_v2.verify_candidate_phone(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.verify_candidate_phone(uuid, text, uuid, timestamptz)
  to service_role;

comment on function screening_v2.verify_candidate_phone is
  '0130 (M017, ADR-0018): the sanctioned HR number correction. Sets the '
  'candidate number valid, clears phone_invalid on its non-terminal '
  'engagements (0099; state, version and updated_at untouched), records '
  'the verification and audits counts only, never the number. Locks those '
  'engagements before the candidate (M017-d), the order every writer of '
  'both takes. Service-role-only.';
-- ==== 0130 §8 END ====


notify pgrst, 'reload schema';
