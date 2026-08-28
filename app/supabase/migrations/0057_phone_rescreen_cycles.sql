-- 0057 — immutable phone re-screen cycles and explicit verified-number recovery.
--
-- A phone_engagements row is one immutable screening cycle. This migration
-- removes the old one-row-per-application uniqueness, adds a cycle number and
-- preserves one active cycle per application. Terminal rows are never updated
-- or reopened. Only request_phone_rescreen can create a later cycle, and it
-- records an idempotent, authorized intent before the new row becomes visible.
--
-- Numbers are accepted only by verify_candidate_phone, immediately hashed into
-- phone_number_verifications, and never returned or written to audit metadata.
-- Re-screen creation itself never creates an attempt or a queue job; all later
-- dialing remains behind the existing admit_phone_attempt gate.

-- Defaults backfill existing rows without issuing an UPDATE. The engagement
-- immutability trigger correctly rejects updates to terminal history, while an
-- additive column default is metadata/schema evolution and preserves every
-- historical value without firing the state-machine trigger.
alter table screening_v2.phone_engagements
  add column if not exists cycle_number integer not null default 1;
alter table screening_v2.phone_engagements
  add column if not exists no_answer_limit integer not null default 3;

-- TST-15 SANCTION: the legacy application-wide UNIQUE is replaced by the
-- additive (application_link_id, cycle_number) UNIQUE plus the one-active-cycle
-- partial UNIQUE below. Existing rows are backfilled as cycle 1 before this
-- constraint is removed; no row or value is discarded.
alter table screening_v2.phone_engagements
  drop constraint if exists uq_phone_engagements_application;
alter table screening_v2.phone_engagements
  add constraint uq_phone_engagements_application_cycle
  unique (application_link_id, cycle_number);
alter table screening_v2.phone_engagements
  drop constraint if exists chk_phone_engagements_cycle_number;
alter table screening_v2.phone_engagements
  add constraint chk_phone_engagements_cycle_number check (cycle_number between 1 and 3);
alter table screening_v2.phone_engagements
  drop constraint if exists chk_phone_engagements_no_answer_limit;
alter table screening_v2.phone_engagements
  add constraint chk_phone_engagements_no_answer_limit
  check (no_answer_limit between 1 and 3 and no_answer_attempts <= no_answer_limit);
create unique index if not exists uq_phone_engagements_one_active_cycle
  on screening_v2.phone_engagements(application_link_id)
  where terminal_at is null;

comment on column screening_v2.phone_engagements.cycle_number is
  'Immutable screening-cycle ordinal within an Ashby application. Existing history is cycle 1; explicit re-screen intent creates later cycles.';
comment on column screening_v2.phone_engagements.no_answer_limit is
  'Per-cycle no-answer ceiling. Initial cycles retain 3; governed re-screen cycles use 1. Candidate-level daily contact guards remain global.';

create table if not exists screening_v2.phone_rescreen_requests (
  id                         uuid primary key default gen_random_uuid(),
  application_link_id       uuid not null references screening_v2.ashby_application_links(id) on delete restrict,
  candidate_id               uuid not null references screening_v2.candidates(id) on delete restrict,
  predecessor_engagement_id  uuid not null references screening_v2.phone_engagements(id) on delete restrict,
  new_engagement_id          uuid not null references screening_v2.phone_engagements(id) on delete restrict,
  source                     text not null,
  reason                     text not null,
  request_id                 text not null,
  actor_id                   uuid,
  created_at                 timestamptz not null default now(),
  constraint uq_phone_rescreen_request_key unique (source, request_id),
  constraint uq_phone_rescreen_new_engagement unique (new_engagement_id),
  constraint chk_phone_rescreen_source check (source in ('hr_manual','automation')),
  constraint chk_phone_rescreen_reason check (reason in (
    'candidate_requested','incomplete_screening','technical_issue',
    'role_changed','quality_review')),
  constraint chk_phone_rescreen_request_id check (
    request_id ~ '^[A-Za-z0-9_.:-]{1,128}$')
);
create index if not exists idx_phone_rescreen_requests_application
  on screening_v2.phone_rescreen_requests(application_link_id, created_at desc);
create index if not exists idx_phone_rescreen_requests_candidate
  on screening_v2.phone_rescreen_requests(candidate_id, created_at desc);

alter table screening_v2.phone_rescreen_requests enable row level security;
revoke all on screening_v2.phone_rescreen_requests from anon, authenticated, public;
grant all privileges on screening_v2.phone_rescreen_requests to service_role;

create table if not exists screening_v2.phone_number_verifications (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id) on delete restrict,
  phone_sha256 text not null,
  verified_by  uuid not null,
  verified_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint chk_phone_verification_digest check (phone_sha256 ~ '^[a-f0-9]{64}$')
);
create index if not exists idx_phone_number_verifications_candidate
  on screening_v2.phone_number_verifications(candidate_id, verified_at desc);
alter table screening_v2.phone_number_verifications enable row level security;
revoke all on screening_v2.phone_number_verifications from anon, authenticated, public;
grant all privileges on screening_v2.phone_number_verifications to service_role;

-- Add the two action names to the existing full audit vocabulary.
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
  'phone_suppression_added', 'phone_recording_attached', 'phone_recording_purged',
  'phone_rescreen_requested', 'phone_number_reverified'
)) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;

-- ── Explicit verified-number recovery ────────────────────────────────
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
begin
  if p_phone_e164 is null or p_phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('status', 'invalid_phone');
  end if;
  select * into v_candidate from screening_v2.candidates
   where id = p_candidate_id for update;
  if not found then return jsonb_build_object('status', 'candidate_not_found'); end if;
  if p_actor_id is null then return jsonb_build_object('status', 'actor_required'); end if;

  v_digest := screening_v2.sha256_hex(p_phone_e164);
  update screening_v2.candidates
     set phone_e164 = p_phone_e164, phone_valid = true, updated_at = p_now
   where id = p_candidate_id;
  insert into screening_v2.phone_number_verifications
    (candidate_id, phone_sha256, verified_by, verified_at, created_at)
  values (p_candidate_id, v_digest, p_actor_id, p_now, p_now);
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values (p_actor_id, 'recruiter', 'phone_number_reverified', 'candidate',
          p_candidate_id::text, 'success', jsonb_build_object('verified', true));
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function screening_v2.verify_candidate_phone(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.verify_candidate_phone(uuid, text, uuid, timestamptz)
  to service_role;

-- ── Governed append-only cycle creation ───────────────────────────────
create or replace function screening_v2.request_phone_rescreen(
  p_candidate_id uuid,
  p_reason text,
  p_request_id text,
  p_source text default 'hr_manual',
  p_actor_id uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_candidate screening_v2.candidates%rowtype;
  v_link screening_v2.ashby_application_links%rowtype;
  v_prev screening_v2.phone_engagements%rowtype;
  v_consent screening_v2.consent_records%rowtype;
  v_request screening_v2.phone_rescreen_requests%rowtype;
  v_new_id uuid;
  v_cycle integer;
  v_verified_at timestamptz;
  v_prereq jsonb;
begin
  if p_source is null or p_source not in ('hr_manual','automation') then
    return jsonb_build_object('status', 'invalid_source');
  end if;
  if p_reason is null or p_reason not in (
    'candidate_requested','incomplete_screening','technical_issue',
    'role_changed','quality_review') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    return jsonb_build_object('status', 'invalid_request_id');
  end if;
  if p_source = 'hr_manual' and p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phone_rescreen'),
    hashtext(coalesce(p_candidate_id::text, ''))
  );

  select * into v_request from screening_v2.phone_rescreen_requests
   where source = p_source and request_id = p_request_id
   for update;
  if found then
    if v_request.candidate_id <> p_candidate_id then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    return jsonb_build_object('status', 'already_requested',
      'request_id', v_request.request_id,
      'engagement_id', v_request.new_engagement_id,
      'cycle_number', (select cycle_number from screening_v2.phone_engagements where id = v_request.new_engagement_id));
  end if;

  select * into v_candidate from screening_v2.candidates
   where id = p_candidate_id;
  if not found then return jsonb_build_object('status', 'candidate_not_found'); end if;

  -- One application is selected deterministically. The application link is
  -- never accepted from the browser, preventing cross-candidate/link abuse.
  select * into v_link from screening_v2.ashby_application_links
   where provider = 'ashby' and candidate_id = p_candidate_id
   order by updated_at desc, id desc limit 1 for update;
  if not found then return jsonb_build_object('status', 'application_not_found'); end if;
  if v_link.terminal_state is not null or v_link.lifecycle in ('completed','cancelled') then
    return jsonb_build_object('status', 'application_not_live');
  end if;

  select * into v_prev from screening_v2.phone_engagements
   where application_link_id = v_link.id
   order by cycle_number desc, created_at desc, id desc limit 1 for update;
  if not found then return jsonb_build_object('status', 'engagement_not_found'); end if;
  if v_prev.terminal_at is null then
    return jsonb_build_object('status', 'active_cycle',
      'engagement_id', v_prev.id, 'cycle_number', v_prev.cycle_number);
  end if;
  if v_prev.state = 'opted_out' then return jsonb_build_object('status', 'opted_out'); end if;
  if v_prev.state = 'wrong_number' then
    select max(verified_at) into v_verified_at
      from screening_v2.phone_number_verifications
     where candidate_id = p_candidate_id
       and verified_at > v_prev.terminal_at;
    if v_verified_at is null then
      return jsonb_build_object('status', 'wrong_number_unverified');
    end if;
  elsif v_prev.state not in ('completed','failed','abandoned_no_answer','cancelled') then
    return jsonb_build_object('status', 'not_eligible', 'state', v_prev.state);
  end if;

  if v_prev.cycle_number >= 3 then
    return jsonb_build_object('status', 'cycle_limit_reached');
  end if;

  select * into v_consent from screening_v2.consent_records
   where candidate_id = p_candidate_id
   order by created_at desc, id desc limit 1;
  if not found or v_consent.status <> 'granted' then
    return jsonb_build_object('status', 'consent_not_granted');
  end if;
  if v_consent.expires_at is not null and v_consent.expires_at <= p_now then
    return jsonb_build_object('status', 'consent_expired');
  end if;

  v_cycle := v_prev.cycle_number + 1;
  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, cycle_number,
     no_answer_limit, state, state_reason, consent_record_id, created_at, updated_at)
  values
    (v_link.id, p_candidate_id, v_candidate.role_id, v_cycle,
     1, 'pending_prereqs', 'rescreen_requested', v_consent.id, p_now, p_now)
  returning id into v_new_id;

  insert into screening_v2.phone_rescreen_requests
    (application_link_id, candidate_id, predecessor_engagement_id,
     new_engagement_id, source, reason, request_id, actor_id, created_at)
  values
    (v_link.id, p_candidate_id, v_prev.id, v_new_id,
     p_source, p_reason, p_request_id, p_actor_id, p_now);

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
     case when p_actor_id is null then 'system' else 'recruiter' end,
     'phone_rescreen_requested', 'phone_engagement', v_new_id::text, 'success',
     jsonb_build_object('application_link_id', v_link.id,
       'predecessor_engagement_id', v_prev.id, 'cycle_number', v_cycle,
       'source', p_source, 'reason', p_reason));

  -- Re-run the ordinary Ashby prerequisite evaluator immediately so a new
  -- cycle does not remain pending forever. It may leave the child pending
  -- with a stable reason, but it never creates an attempt or a queue job.
  v_prereq := screening_v2.ensure_ashby_phone_engagement(v_link.id, p_now);

  return jsonb_build_object('status', 'ok', 'engagement_id', v_new_id,
    'cycle_number', v_cycle, 'predecessor_engagement_id', v_prev.id,
    'prereq_status', coalesce(v_prereq->>'status', 'unknown_status'));
end;
$$;
revoke all on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz)
  to service_role;

-- Effective declarations from prior phone migrations. The only behavior
-- changes are the per-cycle no-answer ceiling and active-cycle selection.
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

  select state into v_ing_state
    from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link.id;
  if v_ing_state is distinct from 'ready' then
    update screening_v2.phone_engagements
       set state_reason = 'ingestion_not_ready', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'ingestion_not_ready', 'engagement_id', v_eng.id);
  end if;

  if not coalesce(v_candidate.phone_valid, false)
     or v_candidate.phone_e164 is null
     or v_candidate.phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    update screening_v2.phone_engagements
       set state_reason = 'phone_invalid', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'phone_invalid', 'engagement_id', v_eng.id);
  end if;

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
  if p_kind in ('initial','no_answer_retry')
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
  -- ── AND ONLY THE SWEEP MAY DRIVE IT ────────────────────────────────
  -- `v_stranded` is a property of the ENGAGEMENT, not of the caller, and a
  -- first draft stopped there. That is not an interlock: ANY caller posting
  -- these two event types drives the same widened edges — including
  -- `POST /api/internal/phone/events`, whose worker allowlist contains
  -- `assessment.aborted`, which carries no assessment interlock of its own.
  -- A delayed or retried `assessment.aborted` landing after the engagement
  -- had moved to `reconnecting` with a bound terminal session was
  -- `unexpected_event` and harmless before 0045; after it, it was terminal
  -- `failed`.
  --
  -- So the branch is additionally gated on the SHAPE ONLY THE SWEEP
  -- PRODUCES: an `internal` post carrying NO attempt id. Every worker post
  -- names its attempt, so no worker can reach these edges however delayed
  -- or replayed it is.
  if v_eng_id is not null
     and p_source = 'internal'
     and p_attempt_id is null
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
    if v_eng.no_answer_attempts + 1 >= v_eng.no_answer_limit then
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
revoke all on function screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  to service_role;
