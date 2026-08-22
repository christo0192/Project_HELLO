-- =====================================================================
-- 0041 — ONE-SHOT recovery for LEGACY `parse_bad_output` rows.
--
-- FORWARD-ONLY. Adds one control table, one additive nullable column, one
-- new function, and widens `chk_audit_action` additively. It creates no
-- destructive DDL, edits no earlier migration, and changes no existing
-- function body. 0039 and 0040 stay byte-identical.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────
-- `parse_bad_output` is raised by the parser parent in EXACTLY one place:
-- when `JSON.parse` of the child's stdout throws. Everything the child can
-- legitimately SAY — including a well-formed `{ok:false,error:CODE}` and
-- any bad shape — maps to `extract_failed` instead. So the code never
-- meant "this document is bad"; it meant "the bytes on stdout were not
-- JSON", which is a PROTOCOL fault of ours.
--
-- And the protocol was being broken by our own dependency: pdf.js (bundled
-- inside pdf-parse) implements `warn()`/`info()` as `console.log(...)` —
-- i.e. to STDOUT — with verbosity defaulting to warnings. Any PDF that
-- made pdf.js warn (a stale `startxref` offset is enough, and pdf.js
-- RECOVERS from that by rebuilding the xref) prepended a `Warning: ` line
-- to the child's own valid JSON. The parent's parse threw, and the
-- ingestion recorded `parse_bad_output`: a DOCUMENT VERDICT about a
-- document that was never judged, whose real answer — sometimes a
-- SUCCESSFUL parse — was sitting on the very next line.
--
-- Because document verdicts are deliberately outside the 0039/0040
-- recovery allowlist, those rows are refused by the audited retry FOR
-- EVER. The stdout-purity fix stops new ones being created; it cannot
-- release the ones already written. This migration is that release, and
-- nothing more.
--
-- ── THE DISCRIMINATOR, AND WHY IT IS SAFE ─────────────────────────────
-- The population to release is "rows written while the channel could
-- still be polluted". That boundary must be durable, server-side, and
-- immovable — never a client-supplied timestamp and never a value a
-- caller can influence.
--
-- So the boundary is stamped BY THIS MIGRATION, at the instant it is
-- applied, into `ashby_parser_fix_markers`. Three properties make it
-- trustworthy:
--
--   1. SERVER-SIDE: `now()` inside the migration transaction. No caller,
--      route, or payload contributes to it.
--   2. IMMOVABLE: inserted `on conflict do nothing`, so re-applying the
--      migration — or applying it to a database that already has it —
--      can never move the boundary forward and re-open a closed door.
--   3. CONSERVATIVE BY CONSTRUCTION: `migrate-production` runs BEFORE
--      `deploy-api` (deploy-fly.yml: deploy-api `needs: migrate-production`),
--      so the boundary is stamped slightly EARLIER than the fixed child
--      goes live. Any row that fails inside that short window is therefore
--      classified as NEW and REFUSED. The error is always in the direction
--      of refusing a legacy row, never of admitting a genuine verdict.
--
-- This migration is deliberately STACKED ON the stdout-purity fix, so the
-- boundary cannot be established by a deployment that does not also carry
-- the fixed child. Without that ordering a "legacy" retry would re-run the
-- same polluted parse and burn its one shot for nothing.
--
-- ── WHAT IS STILL REFUSED ─────────────────────────────────────────────
-- Everything except a `parse_bad_output` row older than the boundary:
-- `parse_extract_failed`, `parse_no_output`, `parse_output_exceeded`,
-- `no_extractable_fields`, every `guard_*`, `scan_infected`, every
-- transport code, and — crucially — any `parse_bad_output` written AFTER
-- the boundary. A post-fix `parse_bad_output` can only mean a genuine
-- protocol anomaly, and widening the door to it would recreate exactly the
-- untruthfulness this repair exists to remove.
--
-- ── BOUNDS ────────────────────────────────────────────────────────────
-- ONE shot per row, recorded durably on the row itself, AND the unchanged
-- five-attempt ceiling — whichever is stricter. This cannot become a loop:
-- once the fixed child re-runs the document, a genuinely malformed file
-- rests on an HONEST code (`parse_extract_failed`), which this door has
-- never accepted.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The durable, immovable boundary
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.ashby_parser_fix_markers (
  marker       text primary key,
  effective_at timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint chk_ashby_parser_fix_marker_name check (marker ~ '^[a-z0-9_]{1,64}$')
);

comment on table screening_v2.ashby_parser_fix_markers is
  'Durable, server-stamped boundaries for parser behaviour changes. A row is '
  'written ONCE, by the migration that ships the corresponding fix, and is '
  'never updated — the insert is on-conflict-do-nothing precisely so a '
  're-applied migration cannot move a boundary and re-open a closed door.';

alter table screening_v2.ashby_parser_fix_markers enable row level security;
revoke all on screening_v2.ashby_parser_fix_markers from anon, authenticated;

-- Stamped at APPLICATION time. Never a client value; never moved once set.
insert into screening_v2.ashby_parser_fix_markers (marker, effective_at)
values ('stdout_purity', now())
on conflict (marker) do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. The one-shot bound, recorded on the row itself
-- ═══════════════════════════════════════════════════════════════════════
-- Additive and nullable, so every existing row keeps its exact meaning and
-- no backfill is needed. Its presence is the whole bound: a row may pass
-- through this door once, ever.

alter table screening_v2.ashby_resume_ingestions
  add column if not exists legacy_bad_output_recovered_at timestamptz;

comment on column screening_v2.ashby_resume_ingestions.legacy_bad_output_recovered_at is
  'Set once, by recover_ashby_legacy_bad_output, when a LEGACY parse_bad_output '
  'row (written before the stdout_purity boundary) was released for one further '
  'ingestion. Non-null means that one shot is spent, for ever.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Audit action — additive widening
-- ═══════════════════════════════════════════════════════════════════════
-- Re-declared in full because a CHECK cannot be patched in place. Every
-- pre-existing action is reproduced verbatim; the assertion that nothing
-- was dropped lives in policy_tests.sql.

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
      'ashby_ingestion_legacy_bad_output_recovery'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. recover_ashby_legacy_bad_output — the one-shot door
-- ═══════════════════════════════════════════════════════════════════════
-- Deliberately a SEPARATE function from `recover_ashby_ingestion_parse`
-- rather than a widened allowlist inside it. The two doors answer
-- different questions — "is this a machine-class failure?" versus "was
-- this row written while our own channel was broken?" — and keeping them
-- apart means the ordinary recovery's allowlist is untouched and still
-- refuses every document verdict, exactly as before.
--
-- The queue contract is 0040's, reused verbatim: same queue name, same
-- camelCase payload the handler reads, same dedup key, same five job
-- attempts, same priority, claimable immediately, same fail-closed
-- verification. A recovered ingestion must be indistinguishable from an
-- imported one once it is on the queue.

create or replace function screening_v2.recover_ashby_legacy_bad_output(
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
  v_boundary   timestamptz;
  v_attempts   integer;
  v_job_id     uuid;
  v_dedup_key  text;
  v_max_attempts     constant integer := 5;
  v_queue_name       constant text    := 'ashby.ingestion';
  v_job_max_attempts constant integer := 5;
  v_job_priority     constant integer := 0;
begin
  -- The boundary must exist before this door can open at all. If the
  -- marker is missing the answer is a refusal, never an assumption.
  select effective_at into v_boundary
    from screening_v2.ashby_parser_fix_markers
   where marker = 'stdout_purity';
  if v_boundary is null then
    return jsonb_build_object('status', 'legacy_boundary_unavailable');
  end if;

  -- LINK FIRST, matching cancel_ashby_application (0031) and
  -- recover_ashby_ingestion_parse (0040). Same order in every direction,
  -- so no deadlock-prone inversion exists between service-role writers.
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

  -- Only a rested row; a live ingestion belongs to the scheduler.
  if v_ing.state <> 'failed_review' then
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

  -- THE ONLY ADMITTED REASON. Every other code — parse_extract_failed,
  -- parse_no_output, parse_output_exceeded, no_extractable_fields,
  -- guard_*, scan_infected, every transport code — remains a refusal here
  -- as well as in the ordinary recovery.
  if v_ing.failed_reason is distinct from 'parse_bad_output' then
    return jsonb_build_object('status', 'not_legacy_bad_output');
  end if;

  -- THE BOUNDARY. A `parse_bad_output` written after the stdout channel
  -- was made pure can only be a genuine protocol anomaly, and is refused
  -- with the same generic status — the caller learns "not eligible",
  -- never why, and never a timestamp.
  if v_ing.updated_at >= v_boundary then
    return jsonb_build_object('status', 'not_legacy_bad_output');
  end if;

  -- ONE SHOT, EVER. Durable on the row, so it survives restarts and
  -- cannot be reset by anything short of a new migration.
  if v_ing.legacy_bad_output_recovered_at is not null then
    return jsonb_build_object('status', 'legacy_recovery_exhausted');
  end if;

  -- ...and still inside the UNCHANGED global ceiling, whichever is
  -- stricter. This door never widens the budget.
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
         -- The row carries NO failure: what it recorded was our broken
         -- channel, not anything learned about the document.
         failed_reason = null,
         attempts = attempts + 1,
         legacy_bad_output_recovered_at = p_now,
         updated_at = p_now
   where application_link_id = p_application_link_id
  returning attempts into v_attempts;

  -- Queue admission in THIS transaction — 0040's contract, verbatim.
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
      -- Fail CLOSED: the transition, the attempt charge, the one-shot
      -- flag and the audit row roll back together, so the row rests
      -- truthfully in failed_review with its shot unspent.
      raise exception 'ashby_legacy_bad_output_enqueue_failed'
        using errcode = 'data_exception',
              detail  = 'no live ashby.ingestion job could be admitted';
    end if;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     'recruiter',
     'ashby_ingestion_legacy_bad_output_recovery', 'ashby_resume_ingestion',
     v_ing.id::text, 'success',
     -- Opaque ids and STABLE codes only. No handle, URL, token, candidate
     -- field, raw parser message — and no boundary timestamp, which is
     -- infrastructure detail rather than a fact about this application.
     jsonb_build_object('application_link_id', p_application_link_id,
                        'failed_reason', 'parse_bad_output',
                        'attempts_before', v_ing.attempts,
                        'attempts_after', v_attempts,
                        'max_attempts', v_max_attempts,
                        'legacy_one_shot', true));

  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'attempts_before', v_ing.attempts,
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.recover_ashby_legacy_bad_output(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.recover_ashby_legacy_bad_output(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.recover_ashby_legacy_bad_output is
  'ONE-SHOT, audited, admin-only release of a LEGACY parse_bad_output resume '
  'ingestion — one written before the server-stamped stdout_purity boundary, '
  'i.e. while pdf.js could still pollute the child stdout protocol channel and '
  'turn a well-formed result into a document verdict it never earned. Admits '
  'ONLY parse_bad_output strictly older than that boundary; a newer one is a '
  'genuine protocol anomaly and is refused. Charges an attempt against the '
  'unchanged five-requeue ceiling AND marks the row so the door can never open '
  'twice. Transitions state, charges the attempt, writes the audit row and '
  'admits the ashby.ingestion job in ONE transaction (0040 contract); if the '
  'enqueue cannot be made durable everything rolls back. Link locked before '
  'ingestion, matching cancel_ashby_application. Issues no invite, moves no '
  'stage, calls no provider. Service-role-only.';
