-- 0047 — Ashby post-parse phone-primary engagement materialization.
--
-- Application submission is the configured consent event. We persist only the
-- source-authentic Ashby submission instant; malformed/missing evidence leaves
-- the engagement pending and cannot unlock admission. The existing
-- admit_phone_attempt RPC remains the final authority for consent, suppression,
-- halt, window, budget, concurrency and dialability.

alter table screening_v2.ashby_job_mappings
  add column if not exists screening_mode text not null default 'phone_primary';

alter table screening_v2.ashby_job_mappings
  alter column screening_mode set default 'phone_primary';

alter table screening_v2.ashby_job_mappings
  drop constraint if exists chk_ashby_job_mappings_screening_mode;
alter table screening_v2.ashby_job_mappings
  add constraint chk_ashby_job_mappings_screening_mode
  check (screening_mode in ('browser_primary', 'phone_primary'));

comment on column screening_v2.ashby_job_mappings.screening_mode is
  'Paused-by-default routing choice. phone_primary suppresses automatic browser invite delivery; recruiters may still generate a link manually.';

alter table screening_v2.ashby_application_links
  add column if not exists submitted_at timestamptz;

comment on column screening_v2.ashby_application_links.submitted_at is
  'Source-authentic Ashby application submission instant. NULL means consent evidence is unavailable and outbound phone admission remains blocked.';

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

  insert into screening_v2.phone_engagements (
    application_link_id, candidate_id, role_id, state, state_reason
  ) values (
    v_link.id, v_candidate.id, v_candidate.role_id, 'pending_prereqs', 'evaluating'
  )
  on conflict (application_link_id) do nothing;

  select * into v_eng
    from screening_v2.phone_engagements
   where application_link_id = v_link.id
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

comment on function screening_v2.ensure_ashby_phone_engagement is
  'Idempotently creates the phone-primary engagement after Ashby resume readiness. Missing source submission evidence, phone validity, mapping, active consent template, or any other prerequisite leaves a visible pending row. Final dialing remains exclusively controlled by admit_phone_attempt.';
