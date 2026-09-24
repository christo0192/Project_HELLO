-- 0102 — admit `resource_generate` to the closed audit vocabulary.
--
-- WHY THIS EXISTS AS ITS OWN MIGRATION.
--
-- "Ask Hello" (0101) audits every drafting request with the new `AuditEvent`
-- member `resource.generate`. `createDbAuditSink` writes `action` as the event
-- with dots replaced by underscores, so the row carries `resource_generate` —
-- and `chk_audit_action` is a CLOSED allowlist that does not contain it.
--
-- The failure was silent in every layer, which is why it is worth stating.
-- The insert violates the CHECK; the sink throws; `resource.generate` is not
-- in `FAIL_CLOSED_EVENTS`, so `recordAudit` swallows it; and the route wraps
-- the call in its own try/catch on purpose, because a drafting request writes
-- no role and must not be lost to a dead audit sink. Net effect: zero audit
-- rows, forever, plus an `audit_sink_failure` log on every press. The route's
-- stated promise — "a privileged, model-invoking action whose output is one
-- Save away from being spoken to a candidate needs a record of who asked for
-- what" — would have shipped unmet.
--
-- The unit test did not catch it because it mocks `../lib/audit.js` and
-- asserts the CALL, never the write. `audit-vocabulary.test.ts` now parses
-- this constraint out of the migrations and checks it against the `AuditEvent`
-- union, so the next new event fails CI instead of failing in production.
--
-- Widened exactly as the constraint's own comment instructs: re-created with
-- the FULL list plus the new action, never by dropping a member — every writer
-- of an existing action depends on it. `not valid` then `validate` follows
-- 0074/0084/0094/0097: the add takes ACCESS EXCLUSIVE only briefly and the
-- validation scan takes SHARE UPDATE EXCLUSIVE, which does not block INSERT on
-- an append-only table.

alter table screening_v2.audit_events drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events add constraint chk_audit_action check (
  action = any (array[
    'invite_sent','invite_revoked','invite_consumed','grant_issued','grant_revoked',
    'grant_consumed','screening_started','screening_completed','screening_failed',
    'assessment_recorded','candidate_status_changed','candidate_consent_updated',
    'session_created','session_updated','session_terminated','membership_created',
    'membership_updated','membership_deactivated','role_created','role_updated',
    'role_deactivated','export_requested','export_completed','login_success',
    'login_failure','logout','config_changed','auth_login_success','auth_login_failure',
    'auth_token_refresh','auth_logout','rbac_access_denied','rbac_ownership_denied',
    'resource_create','resource_read','resource_update','resource_delete','resource_list',
    'rate_limit_exceeded','audit_sink_failure','audit_configuration_error',
    'recording_download','recording_upload','recording_integrity_verified',
    'recording_quarantined','recording_revoked','recording_deleted',
    'admin_session_override','admin_maintenance_toggle','admin_member_update',
    'quota_override','notification_create','appeal_create','appeal_review',
    'allowlist_linked','admin_allowlist_add','admin_allowlist_update',
    'ashby_mapping_update','ashby_mapping_drift','ashby_application_cancel',
    'ashby_operation_enqueue','ashby_operation_update','ashby_operation_retry',
    'ashby_writeback_pending','ashby_invite_delivered','ashby_ingestion_attempts_reset',
    'ashby_ingestion_parse_recovery','ashby_ingestion_legacy_bad_output_recovery',
    'phone_attempt_admitted','phone_attempt_classified','phone_attempt_ended',
    'phone_appointment_scheduled','phone_appointment_cancelled','phone_appointment_missed',
    'phone_opt_out_recorded','phone_suppression_added','phone_recording_attached',
    'phone_rescreen_requested','phone_number_reverified','phone_test_gate_armed',
    'phone_test_gate_consumed','phone_callback_confirmed','phone_callback_recovery_required',
    'ashby_ingestion_model_degraded_recovery','phone_suppression_released',
    -- 0097
    'ashby_ingestion_midflight_resume',
    -- 0102
    'resource_generate'
  ])
) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;

-- `drop constraint` also drops its COMMENT, and 0074/0084/0094/0097 each
-- re-set it. Losing it silently retires the generation marker every reader
-- uses to tell which migration last widened the vocabulary.
comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed audit vocabulary through 0102. Widen ONLY by re-creating this '
  'constraint with the full list plus the new action(s), never by dropping '
  'members — every writer of an existing action depends on it.';
