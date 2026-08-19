-- ═══════════════════════════════════════════════════════════════════════════
-- 0036 — Audited operator reset of a resume ingestion's attempt counter
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- `advance_ashby_ingestion` (0032) bounds requeues at 5 attempts and then rests
-- the row in `failed_review` with `retry_exhausted`. That ceiling is correct and
-- is NOT relaxed here.
--
-- But the ceiling assumes the five attempts measured five independent chances.
-- When a single deterministic defect burns all five — as the Node 22 pinned-DNS
-- lookup defect did, failing every resume fetch identically with
-- `fetch_http_error` before a packet left the machine — the counter is recording
-- one fault five times. Once that defect is fixed, the documented recovery
-- (requeue, then replay the DLQ job) dead-ends at `retry_exhausted` with no next
-- step, and the only remaining option is a raw UPDATE that bypasses every guard
-- and the audit trail.
--
-- This is the same MIS-ACCOUNTING correction that `reopen_ashby_invite_delivery`
-- (0035) makes for invite deliveries, and it is deliberately built to the same
-- shape: one row, an error-code allowlist, an audit row carrying the pre-reset
-- value, and no change to any global bound.
--
-- WHAT IT IS NOT. It does not transition state. After a reset the row is still
-- `failed_review`; the operator takes the ordinary audited
-- `advance_ashby_ingestion(link, 'queued', …)` exit, which charges attempt 1 of
-- 5 as usual. Keeping the reset and the transition separate means there is still
-- exactly ONE way a row leaves `failed_review`, and it is still counted.
--
-- HONEST LIMITATION, recorded rather than hidden. `resume-fetch.ts` maps both a
-- real provider error status and a status-0 transport failure to `http_error`,
-- so `fetch_http_error` alone cannot prove the cause was the transport. The
-- allowlist narrows this to transport-shaped reasons; it cannot decide the
-- question. The operator must have confirmed out-of-band that the URL fetches by
-- hand (the runbook says so explicitly). That is why this is an attributable,
-- audited, one-row RPC and not an automatic behaviour.
--
-- No table is created, altered destructively, or dropped. Additive only.

-- ── 1. Additive audit action ───────────────────────────────────────────────
-- Same drop/add/validate shape 0032 uses to widen this allowlist. Widening a
-- CHECK can never invalidate an existing row.

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
      'ashby_ingestion_attempts_reset'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

-- ── 2. reset_ashby_ingestion_attempts ──────────────────────────────────────

create or replace function screening_v2.reset_ashby_ingestion_attempts(
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
  v_ing  screening_v2.ashby_resume_ingestions%rowtype;
  v_link screening_v2.ashby_application_links%rowtype;
  -- The ONLY failure reasons a transport-layer defect can leave behind. A
  -- resume that failed to SCAN, PARSE, or a guard rejection is not in this set
  -- and is not resettable — those attempts measured real, independent faults.
  --
  -- `fetch_http_error` covers both a provider error status and a status-0
  -- connect failure (see the header): membership here is a necessary condition
  -- for the reset, never a sufficient one. The operator supplies the judgement.
  v_transport_reasons constant text[] := array[
    'fetch_http_error',
    'fetch_transport_error',
    'fetch_timeout'
  ];
begin
  select * into v_ing
    from screening_v2.ashby_resume_ingestions
   where application_link_id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Only a rested row. A live ingestion's counter is the scheduler's business.
  if v_ing.state <> 'failed_review' then
    return jsonb_build_object('status', 'not_resettable', 'state', v_ing.state);
  end if;

  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Never resurrect work for a withdrawn/deleted/cancelled application.
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  if v_ing.failed_reason is null
     or not (v_ing.failed_reason = any(v_transport_reasons)) then
    return jsonb_build_object('status', 'not_a_transport_failure',
                              'failed_reason', coalesce(v_ing.failed_reason, 'null'));
  end if;

  -- Nothing to correct. Reported distinctly so an operator can tell "already
  -- clear" from "reset just happened" without reading the counter twice.
  if v_ing.attempts = 0 then
    return jsonb_build_object('status', 'noop', 'attempts', 0);
  end if;

  update screening_v2.ashby_resume_ingestions
     set attempts = 0,
         updated_at = p_now
   where application_link_id = p_application_link_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     -- 'recruiter' is the actor_type the 0007 CHECK allows for a human
     -- operator; the ADMIN identity is carried by actor_id, which is what
     -- makes the reset attributable.
     'recruiter',
     'ashby_ingestion_attempts_reset', 'ashby_resume_ingestion',
     v_ing.id::text, 'success',
     jsonb_build_object('application_link_id', p_application_link_id,
                        'reason', 'transport_defect_burned_attempts',
                        'failed_reason', v_ing.failed_reason,
                        'attempts_before', v_ing.attempts,
                        'state', v_ing.state));

  return jsonb_build_object('status', 'ok',
                            'attempts_before', v_ing.attempts,
                            'state', v_ing.state);
end;
$$;

revoke all on function screening_v2.reset_ashby_ingestion_attempts(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reset_ashby_ingestion_attempts(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.reset_ashby_ingestion_attempts is
  'Audited operator reset of ONE resume ingestion attempt counter that was '
  'burned by a single now-fixed TRANSPORT defect. Refuses on a row that is not '
  'failed_review, a terminal application, and any failed_reason outside the '
  'transport allowlist (fetch_http_error / fetch_transport_error / '
  'fetch_timeout). Does NOT transition state — the operator still takes the '
  'ordinary audited advance_ashby_ingestion(link, queued) exit afterwards, '
  'which charges attempt 1 of 5. The 5-attempt ceiling is unchanged. '
  'Service-role-only.';
