-- =====================================================================
-- 0084 — Audited re-drive for a MODEL-DEGRADED (silently fallen-back)
--        resume ingestion.
--
-- FORWARD-ONLY. Re-declares two existing function bodies (the ingestion
-- transition trigger function and `advance_ashby_ingestion`, both with
-- ONE added edge/refusal), widens `chk_audit_action` additively, and adds
-- ONE new recovery function. No table, column, index or grant is
-- otherwise touched. 0040/0041 and every earlier migration stay
-- byte-identical.
--
-- ── THE DEFECT (RCA 2026-09-07) ───────────────────────────────────────
-- Three IDENTICAL résumés were ingested; two were structured by the
-- model, one silently fell back to the deterministic regex extractor
-- because the DeepSeek call failed mid-batch. The row landed in
-- `state = 'ready'` with `structurer_version = 'deterministic-fallback-1'`
-- — a SUCCESSFUL ingestion whose candidate is permanently NON-dialable
-- (the deterministic tag is off the dialable allowlist by design), with:
--
--   * no log line saying WHY the model tier surrendered (fixed in the
--     API alongside this migration: the fallback branch now emits one
--     sanitized category), and
--   * NO DOOR back into the pipeline. `ready` is terminal in the 0029
--     state machine, and both audited recoveries (0040, 0041) demand
--     `failed_review` — a degraded-but-"successful" row is refused by
--     every one of them, for ever. The only remedy was a new
--     application with the same document.
--
-- This migration is that door: an audited, attempt-BOUNDED operator
-- re-drive of a READY row whose structuring degraded, re-queuing a full
-- re-ingestion on exactly the 0040 queue contract.
--
-- ── ELIGIBILITY, STATED ONCE ──────────────────────────────────────────
--   state = 'ready'  AND  structurer_version LIKE 'deterministic-fallback%'
--
-- Nothing else. A row the MODEL structured (`resume-model-*`, with or
-- without `+fallback`) is refused: its phone provenance is already the
-- best this system produces, and re-running it would burn budget to
-- learn nothing. A `failed_review` row is refused here — 0040/0041 are
-- its doors. The recovery is self-limiting: a re-run that the model
-- answers rewrites `structurer_version` to the model tag and closes this
-- door; a re-run that degrades AGAIN leaves the tag in place and the
-- unchanged five-attempt ceiling is what stops the loop.
--
-- ── THE NEW EDGE, AND WHO MAY WALK IT ─────────────────────────────────
-- `ready -> queued` did not exist; the trigger below adds it. But
-- `runImport` (orchestration) calls `advance(link, 'queued')`
-- UNCONDITIONALLY on every webhook redelivery and reconciliation
-- re-observation — today that lands on the trigger's refusal for a ready
-- row and is ignored. If the generic path could walk the new edge, every
-- redelivered webhook against a COMPLETED application would silently
-- re-resolve a presigned URL and re-download the candidate's resume.
-- So, exactly as 0039 did for `extracting -> queued`,
-- `advance_ashby_ingestion` gains a REFUSAL: the new edge is reachable
-- ONLY through `recover_ashby_model_degraded`. Same trick, same reason,
-- same comment discipline.
--
-- ── QUEUE ADMISSION ───────────────────────────────────────────────────
-- 0040's contract, verbatim, INSIDE the RPC's transaction: same queue
-- name, same camelCase payload the handler reads, same dedup key, same
-- five job attempts, same priority, claimable immediately, same
-- fail-closed verification. A transition into a work-owing state must
-- guarantee a live job in the SAME transaction — enqueue-after-commit
-- would re-open the exact hole 0040 closed.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Transition trigger — ONE new edge: ready -> queued
-- ═══════════════════════════════════════════════════════════════════════
-- `create or replace` on the trigger FUNCTION. The trigger itself, the
-- table, and every other edge are untouched; the machine still has exactly
-- eight states. `cancelled` stays fully terminal.

create or replace function screening_v2.enforce_ashby_ingestion_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  allowed text[];
begin
  if old.state = new.state then
    return new;   -- idempotent no-op
  end if;
  case old.state
    when 'queued'      then allowed := array['fetching','cancelled'];
    -- 0037: 'queued' is the abandon-before-verdict retry edge.
    when 'fetching'    then allowed := array['scanning','failed_review','cancelled','queued'];
    when 'scanning'    then allowed := array['extracting','failed_review','cancelled','queued'];
    -- 0039: 'queued' is reachable ONLY through defer_ashby_ingestion_parse —
    -- the parser was unavailable, so nothing was learned about the document.
    -- `advance_ashby_ingestion` refuses this edge; see below.
    when 'extracting'  then allowed := array['structuring','failed_review','cancelled','queued'];
    when 'structuring' then allowed := array['ready','failed_review','cancelled'];
    when 'failed_review' then allowed := array['queued','cancelled'];  -- retriable
    -- 0084: 'queued' is reachable ONLY through recover_ashby_model_degraded —
    -- the audited re-drive of a row whose MODEL structuring silently degraded
    -- to the deterministic extractor. `advance_ashby_ingestion` refuses this
    -- edge on the generic path (see below), so a redelivered webhook can never
    -- re-download a completed application's resume.
    when 'ready'       then allowed := array['queued'];
    when 'cancelled'   then allowed := '{}'::text[];   -- terminal
    else allowed := '{}'::text[];
  end case;
  if not (new.state = any(allowed)) then
    raise exception 'invalid ashby resume ingestion transition % -> %', old.state, new.state
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function screening_v2.enforce_ashby_ingestion_transition is
  'Enforces the legal ashby_resume_ingestions state machine on UPDATE; '
  'same-state is a no-op. cancelled rejects all transitions. 0037: '
  'fetching/scanning may return to queued — an attempt abandoned BEFORE any '
  'verdict about the file. 0039: extracting may return to queued for the same '
  'reason (the PARSER was unavailable, not unwilling), reachable only through '
  'defer_ashby_ingestion_parse. 0084: ready may return to queued, reachable '
  'only through recover_ashby_model_degraded (the audited re-drive of a '
  'model-degraded structuring) — advance_ashby_ingestion refuses both edges '
  'on the generic path. structuring still has no such edge.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. advance_ashby_ingestion — refuse the new edge on the GENERIC path
-- ═══════════════════════════════════════════════════════════════════════
-- Identical signature and behaviour to 0039 plus ONE refusal. Without it,
-- `runImport`'s unconditional advance(link,'queued') — every webhook
-- redelivery, every reconciliation pass — would walk the new trigger edge
-- and re-download a resume the pipeline already finished with. The refusal
-- keeps the generic answer for a ready row a REFUSAL, as it has always
-- been (previously the trigger's `invalid_transition`; now a named
-- `not_requeueable`, which every caller already treats identically:
-- non-ok, not our work to do).

create or replace function screening_v2.advance_ashby_ingestion(
  p_application_link_id uuid,
  p_next_state          text,
  p_content_sha256      text,
  p_extractor_version   text,
  p_structurer_version  text,
  p_failed_reason       text,
  p_now                 timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id       uuid;
  v_attempts integer;
  v_state    text;
  v_reason   text;
  v_max_attempts constant integer := 5;
begin
  if p_next_state not in ('queued','fetching','scanning','extracting','structuring','ready','failed_review','cancelled') then
    return jsonb_build_object('status', 'invalid_state');
  end if;
  if p_content_sha256 is not null and p_content_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_sha');
  end if;

  insert into screening_v2.ashby_resume_ingestions (application_link_id, provider, state)
  values (p_application_link_id, 'ashby', 'queued')
  on conflict (application_link_id) do nothing;

  if p_next_state = 'queued' then
    select attempts, state, failed_reason into v_attempts, v_state, v_reason
      from screening_v2.ashby_resume_ingestions
     where application_link_id = p_application_link_id
     for update;
    if v_attempts is null then
      return jsonb_build_object('status', 'not_found');
    end if;

    -- 0039: the extracting -> queued edge exists for the PARSE DEFERRAL alone.
    -- Reaching it from the generic path would mean a redelivered webhook or a
    -- reconciliation re-observation re-downloads a resume that is mid-parse.
    if v_state = 'extracting' then
      return jsonb_build_object('status', 'not_requeueable',
                                'state', v_state,
                                'reason', 'parse_defer_only');
    end if;

    -- 0084: the ready -> queued edge exists for the MODEL-DEGRADED RECOVERY
    -- alone. Reaching it from the generic path would mean a redelivered
    -- webhook re-downloads a resume the pipeline already FINISHED with — a
    -- completed application flipped back to in-flight by a retransmission.
    if v_state = 'ready' then
      return jsonb_build_object('status', 'not_requeueable',
                                'state', v_state,
                                'reason', 'model_degraded_recovery_only');
    end if;

    -- VERDICT-class refusal. A screening RESULT is permanent: re-running it
    -- can only produce the same answer, and for malware it means downloading
    -- the file again. Deterministic content faults (a rejected magic/MIME
    -- guard, an unparseable document, a document with no extractable fields)
    -- are verdicts about the file too, by the same argument. 0039 adds the
    -- document-class parse codes the sub-classifier can now distinguish, and
    -- KEEPS the legacy `parse_error` refusal.
    if v_state = 'failed_review'
       and v_reason is not null
       and (v_reason = 'scan_infected'
            or v_reason like 'guard_%'
            or v_reason = 'parse_error'
            or v_reason = 'parse_extract_failed'
            or v_reason = 'parse_bad_output'
            or v_reason = 'parse_no_output'
            or v_reason = 'parse_output_exceeded'
            or v_reason = 'no_extractable_fields') then
      return jsonb_build_object('status', 'not_requeueable',
                                'state', v_state,
                                'failed_reason', v_reason);
    end if;

    if v_state is distinct from 'queued' and v_attempts + 1 > v_max_attempts then
      return jsonb_build_object('status', 'retry_exhausted',
                                'state', v_state,
                                'attempts', v_attempts,
                                'max_attempts', v_max_attempts);
    end if;
  end if;

  begin
    update screening_v2.ashby_resume_ingestions
       set state = p_next_state,
           content_sha256 = coalesce(p_content_sha256, content_sha256),
           extractor_version = coalesce(p_extractor_version, extractor_version),
           structurer_version = coalesce(p_structurer_version, structurer_version),
           failed_reason = case
                             when p_next_state = 'failed_review'
                               then left(coalesce(p_failed_reason, 'failed'), 200)
                             -- A row returning to `queued` carries no failure:
                             -- leaving a stale reason behind would make the
                             -- verdict refusal above fire on the NEXT requeue
                             -- of a row that has since been cleared.
                             when p_next_state = 'queued' then null
                             else failed_reason
                           end,
           attempts = case when p_next_state = 'queued' and state is distinct from 'queued'
                           then attempts + 1 else attempts end,
           updated_at = p_now
     where application_link_id = p_application_link_id
    returning id, attempts into v_id, v_attempts;
  exception
    when raise_exception then
      return jsonb_build_object('status', 'invalid_transition');
  end;

  if v_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ok', 'state', p_next_state,
                            'attempts', v_attempts, 'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.advance_ashby_ingestion is
  'Generic ingestion state advance (service-role only). 0037 semantics plus '
  'the 0039 extracting->queued refusal (parse_defer_only) and the 0084 '
  'ready->queued refusal (model_degraded_recovery_only): the special edges '
  'belong to defer_ashby_ingestion_parse and recover_ashby_model_degraded '
  'respectively, never to the generic path a webhook redelivery drives.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Audit action — additive widening
-- ═══════════════════════════════════════════════════════════════════════
-- Re-declared in full because a CHECK cannot be patched in place. Every
-- pre-existing action (through 0074) is reproduced verbatim; the assertion
-- that nothing was dropped lives in policy_tests.sql.

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
  -- Ashby (0084, additive): audited BOUNDED re-drive of a ready ingestion
  -- whose model structuring silently degraded to the deterministic extractor.
  'ashby_ingestion_model_degraded_recovery'
)) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;
comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed audit vocabulary through 0084, including the model-degraded '
  'ingestion re-drive.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. recover_ashby_model_degraded — the audited door
-- ═══════════════════════════════════════════════════════════════════════
-- Deliberately a SEPARATE function from `recover_ashby_ingestion_parse`
-- (0040) and `recover_ashby_legacy_bad_output` (0041) rather than a
-- widened allowlist inside either. The three doors answer three different
-- questions — "is this a machine-class failure?", "was this row written
-- while our own channel was broken?", and now "did the MODEL tier degrade
-- on a row the pipeline otherwise finished?" — and keeping them apart
-- means neither existing door's contract moves by a single row.

create or replace function screening_v2.recover_ashby_model_degraded(
  p_application_link_id uuid,
  p_actor_id            uuid,
  p_now                 timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_ing        screening_v2.ashby_resume_ingestions%rowtype;
  v_link       screening_v2.ashby_application_links%rowtype;
  v_link_found boolean;
  v_attempts   integer;
  v_job_id     uuid;
  v_dedup_key  text;
  v_max_attempts     constant integer := 5;
  v_queue_name       constant text    := 'ashby.ingestion';
  v_job_max_attempts constant integer := 5;
  v_job_priority     constant integer := 0;
begin
  -- LINK FIRST, matching cancel_ashby_application (0031),
  -- recover_ashby_ingestion_parse (0040) and recover_ashby_legacy_bad_output
  -- (0041). Same order in every direction, so no deadlock-prone inversion
  -- exists between service-role writers.
  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id
   for update;
  v_link_found := found;

  select * into v_ing
    from screening_v2.ashby_resume_ingestions
   where application_link_id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Only a COMPLETED row. A live ingestion belongs to the scheduler, and a
  -- failed_review row belongs to the 0040/0041 doors — this one exists for
  -- exactly the row every other door refuses: "successful", degraded.
  if v_ing.state <> 'ready' then
    return jsonb_build_object('status', 'not_recoverable', 'state', v_ing.state);
  end if;

  if not v_link_found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Decided under the link's own row lock: a cancel cannot commit between
  -- this check and the transition.
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  -- THE ONLY ADMITTED CONDITION: the structurer of record is the
  -- deterministic fallback family. A model-structured row (with or without
  -- the '+fallback' phone-provenance suffix) is refused — re-running it
  -- burns budget to learn nothing better than what is already recorded.
  if v_ing.structurer_version is null
     or v_ing.structurer_version not like 'deterministic-fallback%' then
    return jsonb_build_object('status', 'not_model_degraded',
                              'state', v_ing.state);
  end if;

  -- The UNCHANGED ceiling. This door spends the same budget every automatic
  -- requeue spends; it is never a counter reset, and the recovery is
  -- self-limiting besides (a model answer rewrites the tag and closes it).
  if v_ing.attempts + 1 > v_max_attempts then
    return jsonb_build_object('status', 'retry_exhausted',
                              'state', v_ing.state,
                              'attempts', v_ing.attempts,
                              'max_attempts', v_max_attempts);
  end if;

  v_dedup_key := 'ashby:ingestion:' || p_application_link_id::text;

  -- An `active` job has already been claimed and may be seconds from
  -- completing; counting it as the work owed would leave `queued` with
  -- nothing runnable. Refused BEFORE anything is written, so nothing is
  -- spent and there is nothing to roll back. (0040's rule, unchanged.)
  select id into v_job_id
    from screening_v2.job_queue
   where name = v_queue_name
     and dedup_key = v_dedup_key
     and status = 'active'
   limit 1;
  if v_job_id is not null then
    return jsonb_build_object('status', 'ingestion_job_in_flight',
                              'state', v_ing.state);
  end if;

  update screening_v2.ashby_resume_ingestions
     set state = 'queued',
         failed_reason = null,
         attempts = attempts + 1,
         updated_at = p_now
   where application_link_id = p_application_link_id
  returning attempts into v_attempts;

  -- Queue admission in THIS transaction — 0040's contract, verbatim. The
  -- payload is opaque identifiers ONLY, camelCase because that is what the
  -- handler reads; a recovered ingestion must be INDISTINGUISHABLE from a
  -- freshly imported one once it is on the queue.
  insert into screening_v2.job_queue
    (name, payload, status, dedup_key,
     attempts, max_attempts, priority, scheduled_at, created_at)
  values
    (v_queue_name,
     jsonb_build_object('provider', 'ashby',
                        'applicationLinkId', p_application_link_id),
     'pending',
     v_dedup_key,
     0, v_job_max_attempts, v_job_priority, p_now, p_now)
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- Only acceptable if a CLAIMABLE job already exists. `active` is not
    -- accepted here: the in-flight refusal above is that case's door.
    select id into v_job_id
      from screening_v2.job_queue
     where name = v_queue_name
       and dedup_key = v_dedup_key
       and status in ('pending', 'delayed')
     limit 1;

    if v_job_id is null then
      -- Fail CLOSED: the transition, the attempt charge and the audit row
      -- roll back together, so the row rests truthfully in `ready` with its
      -- budget intact. A recovery that cannot schedule work must not report
      -- that it did.
      raise exception 'ashby_model_degraded_enqueue_failed'
        using errcode = 'data_exception',
              detail  = 'no live ashby.ingestion job could be admitted';
    end if;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     'recruiter',
     'ashby_ingestion_model_degraded_recovery', 'ashby_resume_ingestion',
     v_ing.id::text, 'success',
     -- Opaque ids and STABLE codes only. No file handle, no presigned URL,
     -- no invite token, no candidate field, no résumé content. The
     -- structurer_version is a version TAG about our machine, never PII.
     jsonb_build_object('application_link_id', p_application_link_id,
                        'structurer_version', v_ing.structurer_version,
                        'attempts_before', v_ing.attempts,
                        'attempts_after', v_attempts,
                        'max_attempts', v_max_attempts));

  -- The RESPONSE shape mirrors 0040/0041 so the route and store read the
  -- exact keys they already know.
  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'attempts_before', v_ing.attempts,
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.recover_ashby_model_degraded(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.recover_ashby_model_degraded(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.recover_ashby_model_degraded is
  'Audited, attempt-BOUNDED operator re-drive of ONE ready resume ingestion '
  'whose MODEL structuring silently degraded to the deterministic extractor '
  '(structurer_version LIKE deterministic-fallback%). Performs the 0084 '
  'ready -> queued transition — an edge advance_ashby_ingestion refuses on '
  'the generic path — CHARGES an attempt against the unchanged 5-requeue '
  'ceiling, and ADMITS the ashby.ingestion queue job in the SAME transaction '
  '(0040 contract): returning ok means a LIVE job exists, and if none can be '
  'admitted everything rolls back and the row rests in ready. Self-limiting: '
  'a re-run the model answers rewrites the structurer tag and closes the '
  'door. Refuses a non-ready row (failed_review belongs to 0040/0041), a '
  'model-structured row (not_model_degraded), a terminal application '
  '(decided under the link row lock, taken BEFORE the ingestion lock to '
  'match cancel_ashby_application), an ingestion job still in flight '
  '(refused before anything is written, so no attempt is spent), and an '
  'exhausted budget. Issues no invite and moves no stage. Service-role-only.';
