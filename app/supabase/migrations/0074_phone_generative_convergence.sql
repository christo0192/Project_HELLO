-- 0074 — Owner-call callback transaction and terminal diagnostic convergence.
--
-- 0068/0073 inserted two new audited actions without evolving the closed
-- audit_events action vocabulary. The CHECK therefore rolled the entire
-- callback-confirmation transaction back after the appointment had been
-- inserted. Evolve the latest 0063 vocabulary additively; no policy or grant
-- changes.

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
  'phone_callback_confirmed', 'phone_callback_recovery_required'
)) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed audit vocabulary through 0074, including callback confirmation and durable recovery visibility.';
