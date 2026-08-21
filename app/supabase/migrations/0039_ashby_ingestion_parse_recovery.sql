-- ═══════════════════════════════════════════════════════════════════════════
-- 0039 — Parse-class ingestion resilience: a guarded extracting→queued edge,
--        an audited BOUNDED operator recovery, and a parse-failure counter
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- Every resume parse failure was recorded as the single word `parse_error`,
-- collapsing nine distinct causes — a killed child, a refused pool submission,
-- a missing compiled asset, a spawn failure, an unparseable document, garbled
-- or absent child output, an exceeded output bound — into one durable value
-- that could not answer "which?". Two of those causes (a wall-clock timeout on
-- a contended CPU, and a bounded pool refusing a submission) are statements
-- about the PARSER'S AVAILABILITY, not about the document, and writing them as
-- `failed_review` is the same conflation 0037 removed from the scanner and
-- 0035/PR #66 removed from the invite budget: a WAIT recorded as a VERDICT.
--
-- The application code now emits ten stable, bounded codes (all matching the
-- existing `chk_ashby_resume_ingestions_reason` shape) and defers only the two
-- availability codes. This migration provides the three things that deferral
-- and its recovery cannot exist without, all additive and forward-only.
--
-- ── 1. WHY A NEW EDGE, AND WHY IT IS NOT AN OPEN ONE ──────────────────────
--
-- 0037 added `fetching -> queued` and `scanning -> queued`, and deliberately
-- did NOT add one for `extracting`, on the reasoning that by then the bytes
-- have been parsed and a re-run is a re-download.
--
-- That reasoning is still right for the case it was written about — a document
-- the parser rejected. It is wrong for the case where the parser never ran to
-- completion at all. And `extracting` is unavoidably the state the row is in:
-- `runResumeIngestion` transitions to `extracting` BEFORE the magic/MIME guard
-- and the parse, precisely so the step is observable, so a parse deferral has
-- to be legal from `extracting` or it cannot exist.
--
-- So the edge is added to the trigger — and then closed again everywhere
-- except one door:
--
--   * `advance_ashby_ingestion` (the GENERIC path, called unconditionally by
--     `runImport` on every redelivered webhook and every reconciliation
--     re-observation) REFUSES `extracting -> queued` outright. Without this,
--     adding the edge would silently make every redelivery re-download a
--     resume that was already mid-parse.
--   * `defer_ashby_ingestion_parse` (NEW, below) is the only function that
--     performs it, and it re-checks the state and a two-member reason
--     allowlist server-side, and charges an attempt against the UNCHANGED
--     0032 five-requeue ceiling.
--
-- The trigger cannot see who is calling, so the guard lives in the callable
-- surface; both functions are SECURITY DEFINER, `service_role`-only, and the
-- table is not writable by `anon`/`authenticated` at all.
--
-- ── 2. WHY THE RECOVERY IS NOT A COUNTER RESET ────────────────────────────
--
-- 0036 resets `attempts` to zero for a transport-class failure, because a
-- single now-fixed defect had burned five attempts recording one fault five
-- times. That is a correction of MIS-ACCOUNTING and is right for what it does.
--
-- It is the wrong shape here. A parse-class `failed_review` is not known to be
-- one fault counted five times, and an unbounded "clear the counter and try
-- again" would turn the five-attempt ceiling into a formality. So
-- `recover_ashby_ingestion_parse` does the opposite: it makes the transition
-- ITSELF, and CHARGES an attempt for it exactly as any other requeue does.
-- An exhausted row is refused with `retry_exhausted` and stays refused. The
-- global bound is not relaxed by one attempt.
--
-- ── 3. WHY LEGACY `parse_error` IS ACCEPTED, AND ONLY HERE ────────────────
--
-- 0037 put `parse_error` in the verdict-class refusal list, so a row carrying
-- it cannot be requeued by the generic path — correctly, because an unknown
-- failure must not be retried automatically on every redelivery.
--
-- But every row written before sub-classification carries exactly that value,
-- and none of them can say which of nine causes they were. They are not
-- verdicts; they are rows whose verdict was never recorded. Refusing them
-- forever means the only way to learn the answer is to throw the application
-- away and make a new one.
--
-- So `parse_error` is in the RECOVERY allowlist and stays out of the generic
-- one: an attributable, audited, admin-only, attempt-charging retry may run it
-- once more so the new classifier can NAME it. The document-verdict codes
-- (`parse_extract_failed`, `parse_bad_output`, `parse_no_output`,
-- `parse_output_exceeded`, `no_extractable_fields`, `guard_%`, `scan_infected`)
-- are excluded from BOTH: retrying a document that will fail identically burns
-- attempts on a file that needs a human, which is the mis-accounting 0036 was
-- written to correct.
--
-- No table is created, altered destructively, or dropped. No state is added:
-- the machine still has exactly eight. Additive and forward-only.

-- ── 1. Additive audit action ───────────────────────────────────────────────
-- Same drop/add NOT VALID/validate idiom 0032 and 0036 use. Widening a CHECK
-- can never invalidate an existing row.

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
      'ashby_ingestion_parse_recovery'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Transition trigger — ONE new edge: extracting -> queued
-- ═══════════════════════════════════════════════════════════════════════
-- `create or replace` on the trigger FUNCTION. The trigger itself, the table,
-- and every other edge are untouched, and the machine still has exactly eight
-- states. `structuring` deliberately gains NO such edge: by then the document
-- HAS been parsed and any failure past that point is about its content.

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
    when 'ready'       then allowed := '{}'::text[];   -- terminal
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
  'same-state is a no-op. Terminal states (ready, cancelled) reject all '
  'transitions. 0037: fetching/scanning may return to queued — an attempt '
  'abandoned BEFORE any verdict about the file. 0039: extracting may return to '
  'queued for the same reason (the PARSER was unavailable, not unwilling), and '
  'that edge is reachable only through defer_ashby_ingestion_parse — '
  'advance_ashby_ingestion refuses it. structuring still has no such edge.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. advance_ashby_ingestion — refuse the new edge on the GENERIC path
-- ═══════════════════════════════════════════════════════════════════════
-- Identical signature and behaviour to 0037 plus ONE refusal, and a widened
-- verdict-class list covering the document-class parse codes the new
-- classifier can now emit.
--
-- The refusal is what keeps the new edge from becoming a general-purpose
-- re-download: `runImport` calls advance(link,'queued') unconditionally, so
-- without it a redelivered webhook against a row that happened to be mid-parse
-- would re-resolve a presigned URL and fetch the candidate's resume again.
--
-- The availability parse codes (`parse_timeout`, `parse_overload`,
-- `parse_spawn_error`, `parse_child_exit`, `parse_asset_missing`, and the two
-- deferral-bound codes) are NOT added to the verdict list: like the
-- `scan_scanner_*` family they describe our machine, not the document, and
-- they must stay requeueable. `parse_error` STAYS in the list — an unknown
-- failure must not be retried automatically; the audited recovery below is
-- the only thing allowed to reclassify it.

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
  'Restart-safe ingestion state transition with hash/version provenance. '
  '0032: a requeue past the bounded attempt ceiling (5) is refused with '
  'retry_exhausted. 0037: a requeue of a VERDICT-class failed_review is '
  'refused with not_requeueable, so a file already identified as malware is '
  'never re-downloaded. 0039: that verdict list additionally covers the '
  'document-class parse codes (parse_extract_failed / parse_bad_output / '
  'parse_no_output / parse_output_exceeded) and the legacy generic '
  'parse_error, and a requeue FROM extracting is refused outright — that edge '
  'belongs to defer_ashby_ingestion_parse alone. Availability-class failures '
  '(scan_scanner_*, parse_timeout, parse_overload, parse_spawn_error, '
  'parse_child_exit, parse_asset_missing) stay requeueable. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. defer_ashby_ingestion_parse — the ONLY extracting -> queued door
-- ═══════════════════════════════════════════════════════════════════════
-- Bounded three ways, all server-side and none of them optional for the
-- caller: the row must be `extracting`, the reason must be one of exactly two
-- availability codes, and the requeue charges an attempt against the same
-- unchanged five-attempt ceiling every other requeue does.
--
-- The queue job's OWN attempt is refunded separately by `defer_job` (0037) —
-- a wait must not consume a failure budget — but the ingestion row's requeue
-- counter is what bounds the number of re-downloads, and it is charged here
-- exactly as the scanner deferral charges it.
--
-- The application also bounds the wait by WALL CLOCK (derived from the queue
-- job's creation), which resets with each enqueue and needs no reset
-- lifecycle. That bound and this deferral ship together, deliberately.

create or replace function screening_v2.defer_ashby_ingestion_parse(
  p_application_link_id uuid,
  p_reason              text,
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
  v_attempts integer;
  v_max_attempts constant integer := 5;
  -- EXACTLY the two codes that describe the parser's availability. A spawn
  -- failure, a non-zero child exit and a missing compiled asset all describe a
  -- BROKEN DEPLOYMENT, and a broken deployment that quietly waits is one
  -- nobody is paged for — those rest loudly and take the audited recovery.
  v_availability_reasons constant text[] := array[
    'parse_timeout',
    'parse_overload'
  ];
begin
  if p_reason is null or not (p_reason = any(v_availability_reasons)) then
    return jsonb_build_object('status', 'not_deferrable',
                              'reason', coalesce(p_reason, 'null'));
  end if;

  select * into v_ing
    from screening_v2.ashby_resume_ingestions
   where application_link_id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The parse deferral is legal from `extracting` and from nowhere else. A row
  -- in any other state is either not mid-parse or already resolved.
  if v_ing.state <> 'extracting' then
    return jsonb_build_object('status', 'invalid_state', 'state', v_ing.state);
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

  -- The UNCHANGED 0032 ceiling. A parser that keeps being unavailable rests in
  -- failed_review like any other exhausted requeue; the deferral buys bounded
  -- patience, not unbounded patience.
  if v_ing.attempts + 1 > v_max_attempts then
    return jsonb_build_object('status', 'retry_exhausted',
                              'state', v_ing.state,
                              'attempts', v_ing.attempts,
                              'max_attempts', v_max_attempts);
  end if;

  update screening_v2.ashby_resume_ingestions
     set state = 'queued',
         -- The row carries NO failure: nothing was learned about the document.
         failed_reason = null,
         attempts = attempts + 1,
         updated_at = p_now
   where application_link_id = p_application_link_id
  returning attempts into v_attempts;

  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.defer_ashby_ingestion_parse(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.defer_ashby_ingestion_parse(uuid, text, timestamptz)
  to service_role;

comment on function screening_v2.defer_ashby_ingestion_parse is
  'The ONLY path that performs extracting -> queued. Requeues ONE resume '
  'ingestion whose parser was UNAVAILABLE (parse_timeout / parse_overload '
  'only), leaving no failure reason because nothing was learned about the '
  'document. Refuses any other reason, any other state, and a terminal '
  'application, and charges an attempt against the unchanged 5-requeue '
  'ceiling — an exhausted row is refused with retry_exhausted. The wait is '
  'additionally bounded by wall clock in the worker. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. recover_ashby_ingestion_parse — audited, BOUNDED operator retry
-- ═══════════════════════════════════════════════════════════════════════
-- Unlike 0036 this does NOT reset a counter. It performs the ordinary
-- `failed_review -> queued` transition and CHARGES an attempt for it, so the
-- five-attempt ceiling remains the real bound on how many times one document
-- may be retried. An exhausted row answers `retry_exhausted` and stays rested.
--
-- It issues no invite and moves no stage. Clearing the ingestion is what lets
-- the ordinary 0035 claim prerequisite eventually hold; nothing here touches
-- that prerequisite, `ashby_operations`, or any stage/email surface.

create or replace function screening_v2.recover_ashby_ingestion_parse(
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
  v_attempts integer;
  v_max_attempts constant integer := 5;
  -- STABLE reasons that describe our machine rather than the document, plus
  -- the legacy generic code that describes nothing at all and exists only to
  -- be reclassified. Membership is a NECESSARY condition for the retry, never
  -- a sufficient one — the operator supplies the judgement, which is why this
  -- is an attributable audited RPC and not an automatic behaviour.
  v_recoverable_reasons constant text[] := array[
    'parse_timeout',
    'parse_overload',
    'parse_spawn_error',
    'parse_child_exit',
    'parse_asset_missing',
    'parse_defer_deadline',
    'parse_defer_exhausted',
    'parse_defer_unavailable',
    -- Legacy: written before failures were sub-classified. One bounded retry
    -- is what turns an unfalsifiable row into a named one.
    'parse_error'
  ];
begin
  select * into v_ing
    from screening_v2.ashby_resume_ingestions
   where application_link_id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Only a rested row. A live ingestion's progress is the scheduler's business.
  if v_ing.state <> 'failed_review' then
    return jsonb_build_object('status', 'not_recoverable', 'state', v_ing.state);
  end if;

  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id;
  if not found then
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
  -- identically. A genuinely bad document needs a human, not a retry, and the
  -- honest recovery for one is a new application with a valid document — never
  -- a widened allowlist.
  if v_ing.failed_reason is null
     or not (v_ing.failed_reason = any(v_recoverable_reasons)) then
    return jsonb_build_object('status', 'not_a_parse_availability_failure',
                              'failed_reason', coalesce(v_ing.failed_reason, 'null'));
  end if;

  -- The UNCHANGED ceiling. This is what makes the recovery bounded: it cannot
  -- be used to retry one document indefinitely, because it spends the same
  -- budget every automatic requeue spends.
  if v_ing.attempts + 1 > v_max_attempts then
    return jsonb_build_object('status', 'retry_exhausted',
                              'state', v_ing.state,
                              'attempts', v_ing.attempts,
                              'max_attempts', v_max_attempts);
  end if;

  update screening_v2.ashby_resume_ingestions
     set state = 'queued',
         failed_reason = null,
         attempts = attempts + 1,
         updated_at = p_now
   where application_link_id = p_application_link_id
  returning attempts into v_attempts;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     -- 'recruiter' is the actor_type the 0007 CHECK allows for a human
     -- operator; the ADMIN identity is carried by actor_id, which is what
     -- makes the retry attributable.
     'recruiter',
     'ashby_ingestion_parse_recovery', 'ashby_resume_ingestion',
     v_ing.id::text, 'success',
     -- Opaque ids and STABLE codes only. No file handle, no presigned URL, no
     -- invite token, no candidate field, no raw parser message.
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

comment on function screening_v2.recover_ashby_ingestion_parse is
  'Audited, attempt-BOUNDED operator retry of ONE parse-class failed_review '
  'resume ingestion. Performs the ordinary failed_review -> queued transition '
  'and CHARGES an attempt against the unchanged 5-requeue ceiling — it is NOT '
  'a counter reset and an exhausted row is refused with retry_exhausted. '
  'Refuses a non-failed_review row, a terminal application, and every reason '
  'outside the parse-availability allowlist; document verdicts '
  '(parse_extract_failed / parse_bad_output / parse_no_output / '
  'parse_output_exceeded / no_extractable_fields / guard_* / scan_infected) '
  'are never recoverable. Legacy generic parse_error IS allowed, once per '
  'remaining attempt, so it can be RECLASSIFIED by the sub-classifier. Issues '
  'no invite and moves no stage. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. ashby_prerequisite_backlog — additive parse-failure counter
-- ═══════════════════════════════════════════════════════════════════════
-- Direct application of the PR #66 O-1 lesson: stopping something that fails
-- LOUDLY can make it fail SILENTLY. A candidate shell now makes an application
-- visible to a recruiter the moment it is imported — so an application whose
-- resume can never be parsed becomes a row that sits there forever looking
-- merely slow. It needs its own number, or the shell trades one silence for
-- another.
--
-- Reported and deliberately NOT wired into the degradation verdict: a
-- parse-class rest is not automatically a fault (a genuinely unparseable
-- document belongs here). It is a queue an operator works, not an alarm.
--
-- Counters only. Six now instead of five; no identifier of any kind, and every
-- existing key keeps its exact meaning.

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

comment on function screening_v2.ashby_prerequisite_backlog is
  'Six counters for the invite-ordering surface: invite deliveries waiting on '
  'an unmet prerequisite (total), the SUBSET of those blocked behind a '
  'failed_review ingestion and therefore unable to clear without a human, '
  'invite deliveries already failed on a prerequisite-deferral code, resume '
  'ingestions stranded in queued or fetching beyond a clamped age, and (0039) '
  'resume ingestions rested on a PARSE-class reason on a live application — '
  'the queue the audited recover_ashby_ingestion_parse retry works. Counters '
  'only; no application, job, candidate or tenant identifier is returned.';
