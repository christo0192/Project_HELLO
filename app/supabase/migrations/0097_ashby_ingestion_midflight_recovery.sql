-- ═══════════════════════════════════════════════════════════════════════
-- 0097 — a resume interrupted mid-flight is not a resume that failed
--
-- RCA 2026-09-16. Four résumés arrived from Ashby in one bulk push. Two
-- reached `ready`. Two are still sitting in `scanning`, with `failed_reason`
-- NULL, `resume_intake_failures` EMPTY, and their queue jobs marked
-- **completed**. Nothing will ever retry them and nothing pages anyone.
--
-- The mechanism, end to end:
--
--   1. The API restarted (a `fly secrets set` rolled the machine) while both
--      ingestions were between `onState('scanning')` and the scan verdict. The
--      in-flight work died; the durable rows stayed `scanning`.
--   2. The queue re-ran each job. The handler's terminal guard is
--      `{ready, cancelled}`, so `scanning` sails through it.
--   3. The handler's first durable action is `advance_ashby_ingestion(...,
--      'fetching')`. The transition trigger allows
--      `scanning -> {extracting, failed_review, cancelled, queued}` — NOT
--      `fetching`. The RPC caught the P0001 and returned `invalid_transition`.
--   4. The handler read a non-ok status and `return`ed bare. Job: completed.
--      Row: untouched. Forever.
--
-- Every retry repeats step 2-4 identically, so the row is unreachable by
-- construction. `queued` and `fetching` are NOT affected, because
-- `queued -> fetching` is legal and `fetching -> fetching` is a same-state
-- no-op that returns ok. The two states that self-heal were the two the
-- health surface already counted (`ingestion_stuck_queued`,
-- `ingestion_stuck_fetching`) and the states that deadlock had no counter at
-- all — the monitoring was the exact complement of the bug.
--
-- Bulk upload is what turns this from rare to routine: the vulnerable window
-- is the time a row spends mid-flight, and one restart strands EVERY row then
-- inside it.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO ────────────────────
-- An earlier draft of this file also added a `structuring -> queued` edge and
-- recreated `advance_ashby_ingestion` to refuse it. Adversarial review killed
-- both, correctly:
--
--   * `structuring` is POST-PERSIST. `resume-ingestion.ts` orders
--     `onState('structuring')` -> `persist()` -> `onState('ready')`, and
--     `updateCandidateFromParse` is CAS-guarded on `.is('resume_id', null)`.
--     Re-driving a row whose persist already bound the candidate therefore
--     DISCARDS the second parse and lands `ready` carrying the second run's
--     `structurer_version` over the first run's phone columns — after which
--     `recover_ashby_model_degraded` answers `not_model_degraded` for ever.
--     That is the precise trap 0084 exists to prevent, so the edge is not
--     added and `structuring` is NOT rescued. It is COUNTED instead (§3), so
--     a strand there is visible to an operator rather than silent.
--     Its real residency is sub-second — the model structurer runs inside
--     `extracting`, not here — so the exposure being traded away is tiny.
--
--   * `scanning` and `extracting` are both strictly PRE-persist, so neither
--     carries that hazard, and BOTH edges to `queued` already exist (0037 and
--     0039 respectively). No trigger change is needed at all, and
--     `advance_ashby_ingestion` is left completely untouched — a partial
--     redefinition of a SECURITY DEFINER function is how an unnoticed
--     privilege or search_path drift ships.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. THE AUDITED MID-FLIGHT RESUME ────────────────────────────────────
-- Walks a row that a dead process left in `scanning` or `extracting` back to
-- `queued` so the ordinary pipeline re-drives it from the top.
--
-- Deliberately NOT a widening of `advance_ashby_ingestion`: that function is
-- reachable from the generic worker path, and `extracting -> queued` is
-- refused there on purpose (`parse_defer_only`). Only a caller that can
-- justify the edge may take it.
--
-- LIVENESS IS PROVEN, NOT ASSUMED. The worker calling this holds the link's
-- only queue job, but a job's LEASE is not the process: `ASHBY_LEASE_SECONDS`
-- defaults to 60, the runner observes a lost heartbeat and deliberately keeps
-- running the handler, and `reclaim_expired_jobs` requeues with no liveness
-- proof. So a second worker can be inside this function while the first is
-- still downloading. `p_min_stale_seconds` closes that: a row touched
-- recently may still belong to a live run and is refused with
-- `recently_active`, which the worker treats as "come back later", never as a
-- failure. The default (900s) exceeds the worst realistic `extracting`
-- residency — parser timeout ceiling 300s + model acquire 30s + the 42s
-- circuit-open ladder + provider timeout — with roughly 2x margin.
--
-- The 0032 attempts ceiling is unchanged and enforced here too, so a row that
-- keeps dying mid-flight rests loudly in `failed_review` instead of looping.
-- Nothing about a document is concluded by this call, so the row carries no
-- failure reason forward.
create or replace function screening_v2.resume_ashby_ingestion_midflight(
  p_application_link_id uuid,
  p_reason text,
  p_min_stale_seconds integer default 900,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_ing  screening_v2.ashby_resume_ingestions%rowtype;
  v_link screening_v2.ashby_application_links%rowtype;
  v_attempts integer;
  v_age_seconds numeric;
  v_max_attempts constant integer := 5;
  -- Bounded like every other operator-supplied interval in this schema.
  v_stale_seconds constant integer :=
    least(greatest(coalesce(p_min_stale_seconds, 900), 1), 86400);
  -- EXACTLY the states a dead run can strand that are also SAFE to re-drive.
  -- `structuring` is excluded on purpose — see the header. `queued` and
  -- `fetching` are excluded because they already self-heal, and admitting them
  -- would let a healthy in-flight row be yanked backwards mid-download.
  v_midflight_states constant text[] := array['scanning','extracting'];
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  select * into v_ing
    from screening_v2.ashby_resume_ingestions
   where application_link_id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not (v_ing.state = any(v_midflight_states)) then
    return jsonb_build_object('status', 'invalid_state', 'state', v_ing.state);
  end if;

  -- THE LIVENESS BOUND. Decided under the row lock taken above, so a live
  -- worker's own transition cannot commit inside this window.
  v_age_seconds := extract(epoch from (p_now - v_ing.updated_at));
  if v_age_seconds < v_stale_seconds then
    return jsonb_build_object('status', 'recently_active',
                              'state', v_ing.state,
                              'age_seconds', floor(v_age_seconds),
                              'min_stale_seconds', v_stale_seconds);
  end if;

  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Never requeue work for a withdrawn/deleted/cancelled application.
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  -- The UNCHANGED 0032 ceiling.
  if v_ing.attempts + 1 > v_max_attempts then
    return jsonb_build_object('status', 'retry_exhausted',
                              'state', v_ing.state,
                              'attempts', v_ing.attempts,
                              'max_attempts', v_max_attempts);
  end if;

  update screening_v2.ashby_resume_ingestions
     set state = 'queued',
         -- The row carries NO failure: the run died, which says nothing about
         -- the document.
         failed_reason = null,
         attempts = attempts + 1,
         updated_at = p_now
   where application_link_id = p_application_link_id
  returning attempts into v_attempts;

  -- ATTRIBUTABLE. This charges a candidate's requeue budget and causes their
  -- résumé to be downloaded again, so it leaves a trace like every other door
  -- that does either. Opaque ids and stable codes only — no file handle, no
  -- presigned URL, no candidate field.
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-4000-8000-000000000001',
     -- Automatic, not operator-driven: the worker observed a dead run.
     'system',
     'ashby_ingestion_midflight_resume', 'ashby_resume_ingestion',
     v_ing.id::text, 'success',
     jsonb_build_object('application_link_id', p_application_link_id,
                        'from_state', v_ing.state,
                        'reason', left(p_reason, 100),
                        'age_seconds', floor(v_age_seconds),
                        'attempts_before', v_ing.attempts,
                        'attempts_after', v_attempts,
                        'max_attempts', v_max_attempts));

  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'from_state', v_ing.state,
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.resume_ashby_ingestion_midflight(uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.resume_ashby_ingestion_midflight(uuid, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.resume_ashby_ingestion_midflight(uuid, text, integer, timestamptz) is
  'Walks a resume ingestion stranded in scanning/extracting by a dead process back '
  'to queued so the pipeline re-drives it. Refuses a row touched within '
  'p_min_stale_seconds (a live run may still own it), refuses terminal '
  'applications, honours the 0032 attempts ceiling, and writes an audit row. '
  'structuring is deliberately NOT recoverable here: it is post-persist, so a '
  're-drive would hit the 0084 CAS trap.';

-- The new audit action has to be admitted by the 0007 CHECK, or the insert
-- above aborts the whole rescue.
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
    'ashby_ingestion_midflight_resume'
  ])
);

-- ── 2. THE MID-FLIGHT REST CODES ARE RECOVERABLE ────────────────────────
-- A row that dies mid-flight five times rests `failed_review` on one of the
-- codes below. Before this change NONE of them was in any audited recovery
-- allowlist: `recover_ashby_ingestion_parse` answered
-- `not_a_parse_availability_failure`, `reset_ashby_ingestion_attempts`
-- answered `not_a_transport_failure`, and the generic requeue refused on the
-- attempts ceiling — so the row was PERMANENTLY unrecoverable by any path.
-- That is the same shape of silence this migration exists to remove, one
-- level further along.
--
-- They qualify under this allowlist's own stated criterion: they describe OUR
-- MACHINE (a process that died, a seam that was absent, a refusal from the
-- rescue itself), never the document. Byte-for-byte the 0040 body with five
-- elements appended and nothing else changed.
create or replace function screening_v2.recover_ashby_ingestion_parse(
  p_application_link_id uuid,
  p_actor_id uuid,
  p_now timestamptz default now()
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
  v_max_attempts constant integer := 5;
  v_queue_name       constant text    := 'ashby.ingestion';
  v_job_max_attempts constant integer := 5;
  v_job_priority     constant integer := 0;
  v_recoverable_reasons constant text[] := array[
    'parse_timeout',
    'parse_overload',
    'parse_spawn_error',
    'parse_child_exit',
    'parse_asset_missing',
    'parse_defer_deadline',
    'parse_defer_exhausted',
    'parse_defer_unavailable',
    'parse_defer_clock_invalid',
    'materialize_failed',
    'parse_error',
    -- 0097, machine-class every one: the process died mid-flight and either
    -- burned the budget doing so, or the rescue path itself was unavailable
    -- or refused. Nothing was ever learned about the document.
    'ingestion_midflight_exhausted',
    'ingestion_midflight_refused',
    'ingestion_midflight_unavailable',
    'ingestion_entry_refused',
    'scan_defer_requeue_refused'
  ];
begin
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

  if v_ing.state <> 'failed_review' then
    return jsonb_build_object('status', 'not_recoverable', 'state', v_ing.state);
  end if;

  if not v_link_found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  -- DOCUMENT VERDICTS ARE NOT RECOVERABLE. `parse_extract_failed`,
  -- `parse_bad_output`, `parse_no_output`, `parse_output_exceeded`,
  -- `no_extractable_fields`, `guard_*` and `scan_infected` are all statements
  -- about the file: retrying re-burns attempts on something that will fail
  -- identically. UNCHANGED by 0097 — every one of the five added codes is
  -- machine-class, and no verdict code is admitted.
  if v_ing.failed_reason is null
     or not (v_ing.failed_reason = any(v_recoverable_reasons)) then
    return jsonb_build_object('status', 'not_a_parse_availability_failure',
                              'failed_reason', coalesce(v_ing.failed_reason, 'null'));
  end if;

  if v_ing.attempts + 1 > v_max_attempts then
    return jsonb_build_object('status', 'retry_exhausted',
                              'state', v_ing.state,
                              'attempts', v_ing.attempts,
                              'max_attempts', v_max_attempts);
  end if;

  v_dedup_key := 'ashby:ingestion:' || p_application_link_id::text;

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
    select id into v_job_id
      from screening_v2.job_queue
     where name = v_queue_name
       and dedup_key = v_dedup_key
       and status in ('pending', 'delayed')
     limit 1;

    if v_job_id is null then
      raise exception 'ashby_ingestion_recovery_enqueue_failed'
        using errcode = 'data_exception',
              detail  = 'no live ashby.ingestion job could be admitted';
    end if;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     'recruiter',
     'ashby_ingestion_parse_recovery', 'ashby_resume_ingestion',
     v_ing.id::text, 'success',
     jsonb_build_object('application_link_id', p_application_link_id,
                        'failed_reason', v_ing.failed_reason,
                        'attempts_before', v_ing.attempts,
                        'attempts_after', v_attempts,
                        'max_attempts', v_max_attempts));

  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'attempts_before', v_ing.attempts,
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.recover_ashby_ingestion_parse(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.recover_ashby_ingestion_parse(uuid, uuid, timestamptz)
  to service_role;

-- ── 3. THE STATES THAT DEADLOCK NOW HAVE COUNTERS ───────────────────────
-- The pre-0097 surface counted `queued` and `fetching` — the two states that
-- recover unaided — and nothing else. A row stranded in `scanning`,
-- `extracting` or `structuring` was invisible to /health by construction, and
-- discoverable only by reading the table by hand. That is exactly how two
-- résumés sat stuck with nobody paged.
--
-- `structuring` is counted even though §1 deliberately does NOT auto-rescue
-- it: an operator seeing a non-zero count there is the ONLY signal that a row
-- hit the one strand this migration leaves to a human, and the alternative is
-- the silence we are here to remove.
--
-- Counters only; no identifier of any kind, and every existing key keeps its
-- exact meaning. Nine now instead of six.
create or replace function screening_v2.ashby_prerequisite_backlog(
  p_stuck_after_seconds integer default 900,
  p_now                 timestamptz default now()
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  select jsonb_build_object(
    'pending_blocked', (
      select count(*)
        from screening_v2.ashby_operations o
        join screening_v2.ashby_application_links l on l.id = o.application_link_id
       where o.provider = 'ashby'
         and o.operation_type = 'invite_delivery'
         and o.state = 'pending'
         and l.terminal_state is null
         and (
           not exists (
             select 1 from screening_v2.ashby_job_mappings m
              where m.id = l.job_mapping_id and m.status = 'enabled'
           )
           or (
             l.external_resume_file_handle is not null
             and not exists (
               select 1 from screening_v2.ashby_resume_ingestions i
                where i.application_link_id = l.id and i.state = 'ready'
             )
           )
         )
    ),
    -- The subset of `pending_blocked` that cannot clear without a human.
    -- Deliberately NOT subtracted from `pending_blocked`: that stays the
    -- honest total, and a consumer that wants "transiently waiting" computes
    -- the difference rather than being handed a pre-baked number whose
    -- derivation it cannot see.
    'pending_blocked_failed_ingestion', (
      select count(*)
        from screening_v2.ashby_operations o
        join screening_v2.ashby_application_links l on l.id = o.application_link_id
       where o.provider = 'ashby'
         and o.operation_type = 'invite_delivery'
         and o.state = 'pending'
         and l.terminal_state is null
         and l.external_resume_file_handle is not null
         and exists (
           select 1 from screening_v2.ashby_resume_ingestions i
            where i.application_link_id = l.id and i.state = 'failed_review'
         )
    ),
    'failed_prerequisite', (
      select count(*)
        from screening_v2.ashby_operations o
       where o.provider = 'ashby'
         and o.operation_type = 'invite_delivery'
         and o.state = 'failed'
         and o.error_code in ('ingestion_not_ready','mapping_inactive')
    ),
    'ingestion_stuck_queued', (
      select count(*)
        from screening_v2.ashby_resume_ingestions i
        join screening_v2.ashby_application_links l on l.id = i.application_link_id
       where i.provider = 'ashby'
         and i.state = 'queued'
         and l.terminal_state is null
         -- Only a RESUME-BACKED link can be stuck: a link with no handle
         -- rests at `queued` by design and is not a fault.
         and l.external_resume_file_handle is not null
         and i.updated_at < p_now - make_interval(
               secs => least(greatest(coalesce(p_stuck_after_seconds, 900), 1), 86400))
    ),
    'ingestion_stuck_fetching', (
      select count(*)
        from screening_v2.ashby_resume_ingestions i
        join screening_v2.ashby_application_links l on l.id = i.application_link_id
       where i.provider = 'ashby'
         and i.state = 'fetching'
         and l.terminal_state is null
         and i.updated_at < p_now - make_interval(
               secs => least(greatest(coalesce(p_stuck_after_seconds, 900), 1), 86400))
    ),
    -- 0097: the states a dead process strands a row in. A row cannot enter any
    -- of them without a resume handle, so no handle predicate is needed (the
    -- same reasoning `ingestion_stuck_fetching` already uses).
    'ingestion_stuck_scanning', (
      select count(*)
        from screening_v2.ashby_resume_ingestions i
        join screening_v2.ashby_application_links l on l.id = i.application_link_id
       where i.provider = 'ashby'
         and i.state = 'scanning'
         and l.terminal_state is null
         and i.updated_at < p_now - make_interval(
               secs => least(greatest(coalesce(p_stuck_after_seconds, 900), 1), 86400))
    ),
    'ingestion_stuck_extracting', (
      select count(*)
        from screening_v2.ashby_resume_ingestions i
        join screening_v2.ashby_application_links l on l.id = i.application_link_id
       where i.provider = 'ashby'
         and i.state = 'extracting'
         and l.terminal_state is null
         and i.updated_at < p_now - make_interval(
               secs => least(greatest(coalesce(p_stuck_after_seconds, 900), 1), 86400))
    ),
    -- The one strand 0097 leaves to a human (see the header): counted so it is
    -- never silent, never auto-rescued because the re-drive is unsafe here.
    'ingestion_stuck_structuring', (
      select count(*)
        from screening_v2.ashby_resume_ingestions i
        join screening_v2.ashby_application_links l on l.id = i.application_link_id
       where i.provider = 'ashby'
         and i.state = 'structuring'
         and l.terminal_state is null
         and i.updated_at < p_now - make_interval(
               secs => least(greatest(coalesce(p_stuck_after_seconds, 900), 1), 86400))
    ),
    -- 0039: parse-class rests on a live application. Matches BOTH the legacy
    -- generic `parse_error` and every sub-classified `parse_*` code, so a
    -- pre-existing row is counted by the same number as a new one.
    'ingestion_failed_parse', (
      select count(*)
        from screening_v2.ashby_resume_ingestions i
        join screening_v2.ashby_application_links l on l.id = i.application_link_id
       where i.provider = 'ashby'
         and i.state = 'failed_review'
         and l.terminal_state is null
         and i.failed_reason like 'parse\_%'
    )
  );
$$;

revoke all on function screening_v2.ashby_prerequisite_backlog(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.ashby_prerequisite_backlog(integer, timestamptz)
  to service_role;

comment on function screening_v2.ashby_prerequisite_backlog(integer, timestamptz) is
  'Nine sanitized backlog counters for the Ashby health surface. 0097 added '
  'ingestion_stuck_scanning/extracting/structuring — the states a dead process '
  'strands a row in, which had no counter and were therefore invisible to '
  '/health by construction.';
